/* 3.0.20 冷启动首屏：并行 / 分阶段 / 换线重试 / 退避时序。
 *
 * 用法：node scripts/test-coldstart.mjs
 * 环境：真实 React 页面 + 真实 api.call / request()，只有 Tauri IPC 是假的（tests/coldstart.tsx）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "coldstart", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { passed: [], external: [], notes: [] };
let vite, browser, page;

const wait = (ms) => page.waitForTimeout(ms);

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).host === new URL(origin).host) return route.continue();
    report.external.push(url);
    return route.abort();
  });

  const fx = (fn, arg) => page.evaluate(fn, arg);

  /* ── A. 首屏只等两个请求，而且这两个是并行的；其余等到内容出现 ── */
  await page.goto(`${origin}tests/coldstart.html`);
  await page.waitForFunction(() => window.coldstartFixture?.ready);

  await page.waitForFunction(() =>
    window.coldstartFixture.pendingCount("api_feed") >= 1 && window.coldstartFixture.pendingCount("api_home") >= 1);
  const stagedAtMount = await fx(() => window.coldstartFixture.stagedCommands()
    .map((cmd) => [cmd, window.coldstartFixture.pendingCount(cmd), window.coldstartFixture.history.filter((row) => row.cmd === cmd).length]));
  for (const [cmd, pendingCount, issued] of stagedAtMount) {
    assert.equal(pendingCount, 0, `${cmd} 不应在首屏发出（挂起 ${pendingCount}）`);
    assert.equal(issued, 0, `${cmd} 不应在首屏发出（已发 ${issued} 次）`);
  }
  report.passed.push("阶段一：首屏只发 api_feed + api_home，两个同时在途（并行），货架/榜位/专题/补全一个没发");

  /* hero 数据先到（banners）也不能提前把阶段二拉起来 */
  await fx(() => window.coldstartFixture.resolveAll("api_home", window.coldstartFixture.banners(2)));
  await wait(80);
  const stagedAfterHome = await fx(() => window.coldstartFixture.stagedCommands()
    .reduce((sum, cmd) => sum + window.coldstartFixture.history.filter((row) => row.cmd === cmd).length, 0));
  assert.equal(stagedAfterHome, 0, "banners 先回来时阶段二也不该启动（首屏只依赖 feed）");
  assert.equal(await page.locator(".spinner").count() > 0, true, "feed 未到时仍是骨架");

  /* feed 到了：内容出现、骨架消失、阶段二才开始 */
  await fx(() => window.coldstartFixture.resolveFeed(3));
  await page.locator(".hg-spotlight").first().waitFor({ timeout: 3000 });
  assert.equal(await page.locator(".spinner").count(), 0, "内容出现后不该还有骨架");
  /* 内容出现的时刻以页面自己打的那行取证为准（`[net] first content ms=`），
     阶段二的请求必须晚于它 —— 这就是「分阶段」的可证伪判据。 */
  const contentAt = await page.evaluate(() => {
    const line = window.coldstartFixture.nets.find((row) => row.startsWith("[net] first content ms="));
    return line ? Number(line.split("ms=")[1]) : -1;
  });
  assert(contentAt > 0, "内容出现时页面要打 [net] first content ms=…");

  await page.waitForFunction(() => window.coldstartFixture.pendingCount("api_rank") >= 1
    || window.coldstartFixture.history.some((row) => row.cmd === "api_rank"));
  await page.waitForFunction(() => window.coldstartFixture.history.some((row) => row.cmd === "api_home_details"));
  const stagedAfter = await fx((markAt) => {
    const rows = [];
    for (const cmd of window.coldstartFixture.stagedCommands()) {
      const first = window.coldstartFixture.history.find((row) => row.cmd === cmd);
      rows.push([cmd, first ? first.at : null, first ? first.at > markAt : true]);
    }
    return rows;
  }, contentAt);
  for (const [cmd, at, afterContent] of stagedAfter) {
    assert(afterContent, `${cmd} 必须在内容出现之后才发（内容 ${Math.round(contentAt)}ms，首调 ${at === null ? "没发" : Math.round(at) + "ms"}）`);
  }
  report.passed.push("分阶段：api_rank / api_original_videos / api_home_details 全部在内容出现之后才发");

  const budgetReleased = await fx(() => window.coldstartFixture.history
    .filter((row) => row.cmd === "net_boot_budget").map((row) => row.args.ms));
  assert(budgetReleased.includes(0), "内容出现后必须把冷启动预算放开（net_boot_budget 0）");
  report.passed.push("取证：内容出现时写 [net] first content ms=…，并放开 4.5s 冷启动请求预算");

  /* hero 文字补全回来之后，banner 才有剧名 */
  await fx(() => window.coldstartFixture.resolveAll("api_home_details", window.coldstartFixture.bannerDetails()));
  await page.getByText("补全剧 A", { exact: false }).first().waitFor({ timeout: 3000 });
  report.passed.push("阶段二：api_home_details 回来后 hero 用补全的剧名（banner 先出封面，文字后到）");

  /* ── B. 单次请求失败 → 换线重试一次（要求 4） ── */
  await page.goto(`${origin}tests/coldstart.html`);
  await page.waitForFunction(() => window.coldstartFixture?.ready);
  await page.waitForFunction(() => window.coldstartFixture.pendingCount("api_feed") >= 1);
  const attemptsBefore = await fx(() => window.coldstartFixture.history.filter((row) => row.cmd === "api_feed").length);
  await fx(() => window.coldstartFixture.rejectAll("api_feed", "NET:tls · tls handshake eof"));
  /* request() 内部：先换线（这里故意返回 all-down）再原地重试一次 */
  await page.waitForFunction((before) => window.coldstartFixture.history.filter((row) => row.cmd === "api_feed").length > before, attemptsBefore, { timeout: 5000 });
  await fx(() => window.coldstartFixture.resolveFeed(2));
  await page.locator(".hg-spotlight").first().waitFor({ timeout: 3000 });
  assert.equal(await page.getByText("加载失败", { exact: false }).count(), 0, "换线重试成功后不该出现错误页");
  const retryLines = await fx(() => window.coldstartFixture.nets.filter((line) => line.startsWith("[net] retry")));
  assert(retryLines.includes("[net] retry n=1 delay=1200"), `TLS 失败后要原地重试一次并留下取证行，实际 ${JSON.stringify(retryLines)}`);
  report.passed.push("要求 4：单次 TLS 失败 → 换线 → 同一次加载内重试一次，成功即出内容（不留错误页）");

  /* ── C. 首屏全失败：1s / 3s / 7s 退避、每次换一条线（要求 3） ── */
  const policy = await fx(() => {
    const { FIRST_SCREEN_RETRY_DELAYS, faultKindOf } = window.coldstartFixture.retryPolicy;
    return {
      delays: FIRST_SCREEN_RETRY_DELAYS,
      tls: faultKindOf(new Error("NET:tls · tls handshake eof")),
      dns: faultKindOf(new Error("NET:dns · 解析失败")),
      timeout: faultKindOf(new Error("NET:timeout · deadline has elapsed（请求总时长超过 4 秒）")),
      http: faultKindOf(new Error("HTTP 404: not found")),
    };
  });
  assert.deepEqual(policy.delays, [1000, 3000, 7000], "退避必须是 1s / 3s / 7s");
  assert.equal(policy.tls, "tls");
  assert.equal(policy.dns, "dns");
  assert.equal(policy.timeout, "timeout");
  assert.equal(policy.http, "http", "站点自己在回答的失败不算链路层");

  /* 两次失败后成功：只应该退避两次，把前两条线累进 tried */
  const recovered = await page.evaluate(async () => {
    const { run } = window.coldstartFixture.retryPolicy;
    let attempt = 0;
    const switched = [];
    const result = await run(async () => {
      attempt += 1;
      if (attempt <= 2) throw new Error("NET:tls · tls handshake eof");
      return "ok";
    }, {
      switchLine: async (tried, kind) => { switched.push([tried.slice(), kind]); return `mirror-${switched.length}.example`; },
    });
    return { ...result, attempts: attempt, switched };
  });
  assert.equal(recovered.ok, true, "第二次重试后就该成功");
  assert.equal(recovered.attempts, 3, "总共 3 次尝试（首发 + 2 次重试）");
  assert.deepEqual(recovered.sleeps, [1000, 3000], "成功即停，不该等第三次 7s");
  assert.deepEqual(recovered.switched.map((row) => row[1]), ["tls", "tls"], "换线原因取自错误类型");
  assert.deepEqual(recovered.switched[0][0], [], "第一次换线时还没试过任何线路");
  assert.deepEqual(recovered.switched[1][0], ["mirror-1.example"], "第二次换线要排除刚失败的那条");

  /* 三次都失败：抛最后一次的错误，退避正好 1s / 3s / 7s */
  const exhausted = await page.evaluate(async () => {
    const { run } = window.coldstartFixture.retryPolicy;
    let attempt = 0;
    const result = await run(async () => {
      attempt += 1;
      throw new Error(`NET:timeout · 第 ${attempt} 次也挂了`);
    }, { switchLine: async () => `mirror-${attempt}.example` });
    return { ...result, attempts: attempt };
  });
  assert.equal(exhausted.ok, false, "三次都失败就要把错误抛给错误页");
  assert.equal(exhausted.attempts, 4, "首发 + 3 次重试");
  assert.deepEqual(exhausted.sleeps, [1000, 3000, 7000], "退避时序必须是 1s / 3s / 7s");
  assert.match(exhausted.error, /第 4 次也挂了/, "错误页拿到的是最后一次的错误");
  report.passed.push("要求 3（策略层）：失败后退避 1s / 3s / 7s，每次换一条未试过的线路，第三次仍失败才把错误抛给页面");

  /* 页面层：首屏全失败时先自动重试，重试期间不许提前出错误页，并且每次重试都留 logcat 行 */
  await page.goto(`${origin}tests/coldstart.html`);
  await page.waitForFunction(() => window.coldstartFixture?.ready);
  await page.waitForFunction(() => window.coldstartFixture.pendingCount("api_feed") >= 1);
  const nextCallsPre = await fx(() => window.coldstartFixture.failoverNextCalls.length);
  await fx(() => window.coldstartFixture.rejectAll("api_feed", "NET:tls · tls handshake eof"));
  /* request() 的原地重试：1.2s 后再挂一次，才轮到 Home 的自动重试 */
  await page.waitForFunction(() => window.coldstartFixture.nets.includes("[net] retry n=1 delay=1200"), null, { timeout: 6000 });
  await page.waitForFunction(() => window.coldstartFixture.pendingCount("api_feed") >= 1, null, { timeout: 6000 });
  await fx(() => window.coldstartFixture.rejectAll("api_feed", "NET:tls · tls handshake eof"));
  await page.waitForFunction(() => window.coldstartFixture.nets.some((line) => line.startsWith("[net] retry n=1 delay=1000")), null, { timeout: 8000 });
  assert.equal(await page.getByText("当前线路连不上", { exact: false }).count(), 0, "第一次自动重试前不许出错误页");
  const nextCallsPost = await fx((from) => window.coldstartFixture.failoverNextCalls.slice(from), nextCallsPre);
  assert(nextCallsPost.length >= 1, "自动重试前要先换一条线路");
  /* StrictMode 会把首屏再挂一次，两条重试链各自累积 tried；判据取「存在一次不带排除的换线」，
     意思是第一轮换线时还没试过任何线路（后续轮次才把失败的线路排除掉）。 */
  assert(nextCallsPost.every((row) => row.reason === "tls"), `换线原因取自错误类型（tls），实际 ${JSON.stringify(nextCallsPost)}`);
  assert(nextCallsPost.some((row) => Array.isArray(row.exclude) && row.exclude.length === 0), "第一轮换线还没有排除任何线路");
  report.passed.push("要求 3（页面层）：首屏失败 → 先换线 → 1s 后自动重试，错误页不会在第一轮就出现");

  /* HTTP 4xx 是站点在回答：不换线、不重试，直接错误页（与旧行为一致） */
  await page.goto(`${origin}tests/coldstart.html`);
  await page.waitForFunction(() => window.coldstartFixture?.ready);
  await page.waitForFunction(() => window.coldstartFixture.pendingCount("api_feed") >= 1);
  const nextCallsBefore = await fx(() => window.coldstartFixture.failoverNextCalls.length);
  await fx(() => window.coldstartFixture.rejectAll("api_feed", "HTTP 404: not found"));
  await page.getByText("加载失败", { exact: false }).first().waitFor({ timeout: 5000 });
  const nextCallsAfter = await fx(() => window.coldstartFixture.failoverNextCalls.length);
  assert.equal(nextCallsAfter, nextCallsBefore, "HTTP 404 不该触发换线重试");
  report.passed.push("边界：HTTP 4xx 不换线、不重试，直接按原文案出错误页");

  /* ── D. 首枪预算（3.0.22 A2）：首屏第一个请求自带 1.5s，后续请求不带 ── */
  await page.goto(`${origin}tests/coldstart.html`);
  await page.waitForFunction(() => window.coldstartFixture?.ready);
  await page.waitForFunction(() => window.coldstartFixture.pendingCount("api_feed") >= 1);
  const firstArgs = await fx(() => window.coldstartFixture.history
    .filter((row) => row.cmd === "api_feed").map((row) => row.args));
  assert.equal(firstArgs.length, 1, `首屏只该发一条 api_feed（实际 ${firstArgs.length} 条：${JSON.stringify(firstArgs)}）`);
  assert.equal(firstArgs[0].budgetMs, 1500, `首屏第一个请求必须自带 1.5s 预算，实际 ${JSON.stringify(firstArgs[0])}`);

  const budgetPolicy = await fx(() => {
    const { firstScreenBudget, FIRST_SCREEN_BUDGET_MS } = window.coldstartFixture.retryPolicy;
    return {
      constant: FIRST_SCREEN_BUDGET_MS,
      first: firstScreenBudget({ attempt: 1, switched: false, lastKind: "" }),
      afterSwitch: firstScreenBudget({ attempt: 2, switched: true, lastKind: "timeout" }),
      slowNoSwitch: firstScreenBudget({ attempt: 2, switched: false, lastKind: "timeout" }) ?? null,
      refused: firstScreenBudget({ attempt: 2, switched: false, lastKind: "refused" }),
    };
  });
  assert.equal(budgetPolicy.constant, 1500, "首枪预算常量必须是 1.5s");
  assert.equal(budgetPolicy.first, 1500, "第一次尝试（首枪）用 1.5s");
  assert.equal(budgetPolicy.afterSwitch, 1500, "换过线路之后的尝试仍然 1.5s（换条线还等 12s 等于白等）");
  assert.equal(budgetPolicy.slowNoSwitch, null, "纯超时且没换过线：退回常规预算（保护慢网，别误杀能用的线路）");
  assert.equal(budgetPolicy.refused, 1500, "快速失败形态（refused）继续用 1.5s");
  report.passed.push("A2：首屏第一个请求自带 1.5s 预算；换过线仍短预算，纯超时且没换线时退回常规预算（慢网保护）");

  /* 内容出现之后：第 2 页预取不带首屏预算（照常 12s） */
  await fx(() => window.coldstartFixture.resolveFeed(3));
  await page.locator(".hg-spotlight").first().waitFor({ timeout: 3000 });
  await fx(() => window.coldstartFixture.resolveAll("api_home", window.coldstartFixture.banners(2)));
  await wait(1600);
  const laterBudgets = await fx(() => window.coldstartFixture.history
    .filter((row) => row.cmd === "api_feed" && row.args && row.args.page === 2)
    .map((row) => row.args.budgetMs ?? null));
  for (const value of laterBudgets) {
    assert.equal(value, null, `第 2 页请求不该带首屏预算（实际 ${value}）`);
  }
  const firstPageCalls = await fx(() => window.coldstartFixture.history
    .filter((row) => row.cmd === "api_feed" && row.args && row.args.page === 1).length);
  assert.equal(firstPageCalls, 1, `首屏 api_feed 不许翻倍（实际 ${firstPageCalls} 条）`);

  /* ── E. 错误页后台自救（3.0.22 A4）：错误页出现后仍自动换线重试 3 次 ── */
  await page.goto(`${origin}tests/coldstart.html`);
  await page.waitForFunction(() => window.coldstartFixture?.ready);
  let rounds = 0;
  while (rounds < 8 && (await page.getByText("当前线路连不上", { exact: false }).count()) === 0) {
    await page.waitForFunction(() => window.coldstartFixture.pendingCount("api_feed") >= 1, null, { timeout: 12000 });
    rounds += await fx(() => window.coldstartFixture.rejectAll("api_feed", "NET:tls · tls handshake eof"));
    await wait(120);
  }
  await page.getByText("当前线路连不上", { exact: false }).first().waitFor({ timeout: 8000 });
  report.passed.push(`A4：首屏 ${rounds} 次尝试全失败后错误页照旧出现（文案不变）`);

  /* 自救第 1 轮：1s 后自动换线 + 重试；这一轮仍然失败 */
  await page.waitForFunction(() => window.coldstartFixture.nets.some((line) => line.startsWith("[net] rescue n=1")), null, { timeout: 6000 });
  const rescueOne = await fx(() => window.coldstartFixture.nets.filter((line) => line.startsWith("[net] rescue")));
  assert(rescueOne.some((line) => line.includes("delay=1000")), `自救第 1 轮必须 1s 后开始：${JSON.stringify(rescueOne)}`);
  assert.equal(await page.getByText("当前线路连不上", { exact: false }).count() > 0, true, "自救进行中错误页仍在（用户仍可自己点重试）");

  /* 自救第 2 轮：3s 后开始，这次成功 → 首屏自动换上、错误页自己消失。
     第 1 轮的自救请求什么时候发出取决于上一轮 reject 的时刻，所以这里一边把在途的
     api_feed 都打掉（让自救链一路往下走），一边等 `[net] rescue n=2` 这行取证。 */
  let sawSecond = false;
  const secondDeadline = Date.now() + 30000;
  while (Date.now() < secondDeadline && !sawSecond) {
    sawSecond = await fx(() => window.coldstartFixture.nets.some((line) => line.startsWith("[net] rescue n=2")));
    if (sawSecond) break;
    if (await fx(() => window.coldstartFixture.pendingCount("api_feed") >= 1)) {
      await fx(() => window.coldstartFixture.rejectAll("api_feed", "NET:tls · tls handshake eof"));
    }
    await wait(200);
  }
  assert(sawSecond, `自救必须走到第 2 轮（nets=${JSON.stringify(await fx(() => window.coldstartFixture.nets.filter((line) => line.startsWith("[net] rescue"))))}）`);
  await page.waitForFunction(() => window.coldstartFixture.pendingCount("api_feed") >= 1, null, { timeout: 10000 });
  await fx(() => window.coldstartFixture.resolveFeed(4, "自救"));
  await page.locator(".hg-spotlight").first().waitFor({ timeout: 5000 });
  await page.getByText("当前线路连不上", { exact: false }).first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  assert.equal(await page.getByText("当前线路连不上", { exact: false }).count(), 0, "自救成功后错误页必须自己消失");
  const rescueAll = await fx(() => window.coldstartFixture.nets.filter((line) => line.startsWith("[net] rescue")));
  assert(rescueAll.some((line) => line.includes("delay=3000")), `自救第 2 轮必须 3s 后开始：${JSON.stringify(rescueAll)}`);
  const rescuedAt = await fx(() => window.coldstartFixture.nets.filter((line) => line.startsWith("[net] first content ms=")));
  assert(rescuedAt.length >= 1, "自救出内容也要留 [net] first content ms= 取证行");
  report.passed.push("A4：错误页出现后按 1s / 3s 自动换线重试，成功即自动刷新首屏（错误页自己消失）");

  assert.deepEqual(errors, [], `页面不该有未捕获异常：${errors.join(" | ")}`);

  await page.screenshot({ path: join(output, "coldstart.png"), fullPage: false });
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error);
  if (page) {
    try { await page.screenshot({ path: join(output, "failure.png"), fullPage: false }); } catch { /* ignore */ }
  }
} finally {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  for (const line of report.passed) console.log(`PASS  ${line}`);
  if (report.external.length) console.log(`NOTE  外部请求被拦下（夹具不联网）：${report.external.length} 条`);
  if (!report.ok) {
    console.error(`FAIL  ${report.error}`);
    console.error(`报告：${join(output, "report.json")}`);
    process.exit(1);
  }
  console.log(`\n全部通过。报告：${join(output, "report.json")}`);
}
