/* 3.0.20 首屏「重复请求」验收台。
 *
 * 用法：node scripts/test-firstscreen-dup.mjs
 * 夹具：tests/firstscreen-dup.tsx（真实 main.tsx 挂载方式 + 真实 api/detailFast，只假 Tauri IPC）
 *
 * 钉死的四条指标（W99 小米九真机 7 次冷启动的取证）：
 *   ① cmd=api_feed 只有 1 条；
 *   ② 每个详情 id 只有 1 条（GET /api/videos/{id}）；
 *   ③ `[net] first content` 只有 1 条；
 *   ④ 总请求数 == 不同 URL 数（没有任何 URL 被发两遍）。
 * 外加两条不回归：首屏两个请求仍然并行；换线期间也不会把首屏再跑一遍。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "firstscreen-dup", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { passed: [], metrics: {}, notes: [] };

const UA =
  "Mozilla/5.0 (Linux; Android 11; MI 9 Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36";

let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 412, height: 900 }, userAgent: UA, hasTouch: true, deviceScaleFactor: 2.75 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).host === new URL(origin).host) return route.continue();
    return route.abort();
  });

  const boot = async ({ switchLine = 0, focus = 0 } = {}) => {
    await page.goto(`${origin}tests/firstscreen-dup.html`);
    await page.waitForFunction(() => window.dupFixture?.ready);
    if (focus) await page.evaluate((ms) => window.dupFixture.focusApp(ms), focus);
    if (switchLine) await page.evaluate((ms) => window.dupFixture.switchLine(ms), switchLine);
    /* 冷启动 + 启动动画 2.2s 之后再看：真机上重复请求就发生在这段窗口里 */
    await page.waitForTimeout(4200);
    return page.evaluate(() => {
      const f = window.dupFixture;
      const counts = f.counts();
      const detailHits = Object.entries(counts.perPath).filter(([p]) => p.startsWith("/api/videos/"));
      const timeline = f.history.map((row) => ({ at: row.at, cmd: row.cmd }));
      return {
        counts,
        detailIds: detailHits.length,
        detailPerId: detailHits.map(([p, n]) => [p.replace("/api/videos/", ""), n]),
        feed: counts.perCmd.api_feed ?? 0,
        firstContent: counts.firstContent,
        mounts: f.mounts.map((row) => [row.what, row.at]),
        feedAt: timeline.filter((row) => row.cmd === "api_feed").map((row) => row.at),
        homeAt: timeline.filter((row) => row.cmd === "api_home").map((row) => row.at),
      };
    });
  };

  /* ── A. 冷启动：四条指标 ── */
  const cold = await boot();
  report.metrics.coldStart = {
    api_feed: cold.feed,
    detailIds: cold.detailIds,
    detailPerId: cold.detailPerId,
    firstContent: cold.firstContent,
    totalHttp: cold.counts.totalHttp,
    distinctHttp: cold.counts.distinctHttp,
    mounts: cold.mounts,
  };
  assert.equal(cold.feed, 1, `冷启动 api_feed 必须只有 1 条，实际 ${cold.feed}（${JSON.stringify(cold.feedAt)}ms）`);
  assert(cold.detailIds > 0, "冷启动应该预取/补全若干详情（否则夹具没跑起来）");
  for (const [id, hits] of cold.detailPerId) {
    assert.equal(hits, 1, `详情 id=${id} 只该请求 1 条，实际 ${hits}`);
  }
  assert.equal(cold.firstContent.length, 1, `[net] first content 只该 1 条，实际 ${JSON.stringify(cold.firstContent)}`);
  assert.equal(cold.counts.totalHttp, cold.counts.distinctHttp,
    `总请求数 ${cold.counts.totalHttp} 应等于不同 URL 数 ${cold.counts.distinctHttp}（重复：${JSON.stringify(cold.counts.dupPaths)}）`);
  /* 根因守卫：整棵树在启动动画收尾时不许被卸载重挂 */
  assert.deepEqual(cold.mounts, [["App mount", cold.mounts[0]?.[1]]],
    `启动动画收尾不该重挂 App（否则首屏会跑两遍），实际 ${JSON.stringify(cold.mounts)}`);
  report.passed.push("冷启动：api_feed 1 条、每个详情 id 1 条、[net] first content 1 条、总请求数 == 不同 URL 数");

  /* 首屏仍然并行：feed 与 home 同时发出（不因修重复而串行化） */
  const feedAt = cold.feedAt[0];
  const homeAt = cold.homeAt[0];
  assert(Math.abs(feedAt - homeAt) < 120, `首屏两个请求应并行发出，实际 feed=${feedAt}ms home=${homeAt}ms`);
  report.passed.push(`首屏并行未回退：feed ${Math.round(feedAt)}ms 与 home ${Math.round(homeAt)}ms 同批发出`);

  /* ── B. 冷启动期间换线：不许把首屏再跑一遍 ── */
  const switched = await boot({ switchLine: 700 });
  report.metrics.withLineSwitch = {
    api_feed: switched.feed,
    detailPerId: switched.detailPerId,
    firstContent: switched.firstContent,
    totalHttp: switched.counts.totalHttp,
    distinctHttp: switched.counts.distinctHttp,
    shelves: { api_rank: switched.counts.perCmd.api_rank ?? 0, api_topics: switched.counts.perCmd.api_topics ?? 0 },
  };
  assert.equal(switched.feed, 1, `换线后 api_feed 仍然只该 1 条，实际 ${switched.feed}`);
  for (const [id, hits] of switched.detailPerId) {
    assert.equal(hits, 1, `换线后详情 id=${id} 只该 1 条，实际 ${hits}`);
  }
  assert.equal(switched.firstContent.length, 1, `换线后 [net] first content 只该 1 条，实际 ${JSON.stringify(switched.firstContent)}`);
  assert.equal(switched.counts.totalHttp, switched.counts.distinctHttp, "换线后也不该有重复 URL");
  assert((switched.counts.perCmd.api_rank ?? 0) >= 2, "换线后货架仍要重拉（不是把整页冻住）");
  report.passed.push("换线撞上冷启动：首屏不重跑（feed/详情/first content 各 1），货架/专题照旧按新线路重拉");

  /* ── B2. 冷启动期间 WebView 拿到焦点（回前台刷新的入口）：不许 force 出第二条首屏 ── */
  const focused = await boot({ focus: 300 });
  report.metrics.withFocus = {
    api_feed: focused.feed,
    firstContent: focused.firstContent,
    detailPerId: focused.detailPerId,
  };
  assert.equal(focused.feed, 1, `冷启动拿到焦点不该 force 第二条 api_feed，实际 ${focused.feed}`);
  assert.equal(focused.firstContent.length, 1, `焦点事件不该多出 [net] first content，实际 ${JSON.stringify(focused.firstContent)}`);
  report.passed.push("冷启动拿到焦点（visibilitychange/focus）：首屏从没成功拉过时不做 force 刷新，api_feed 仍 1 条");

  /* ── C. 预取登记在途：两次预取 + 用户点进去，同一个 id 只出一次网 ── */
  await page.evaluate(() => window.dupFixture.reset());
  const prefetch = await page.evaluate(async () => {
    const { prefetchDetails, loadDetail } = window.dupFixture.modules;
    prefetchDetails([7001, 7002]);
    prefetchDetails([7001, 7002, 7003]);       // 同一批 id 又来一次（首屏跑两遍时的真实形态）
    const detail = loadDetail(7001);            // 用户此刻点进第一部剧
    await detail.catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    const f = window.dupFixture;
    const perPath = {};
    for (const row of f.http) perPath[row.path] = (perPath[row.path] ?? 0) + 1;
    return { perPath, invokes: f.history.filter((row) => row.cmd === "api_video").length };
  });
  report.metrics.prefetchInflight = prefetch;
  assert.equal(prefetch.perPath["/api/videos/7001"], 1, `预取 + 点进去应复用同一条在途请求，实际 ${JSON.stringify(prefetch)}`);
  assert.equal(prefetch.perPath["/api/videos/7002"], 1, `重复预取不该再发一条，实际 ${JSON.stringify(prefetch)}`);
  assert.equal(prefetch.perPath["/api/videos/7003"], 1, `第二次预取的新 id 只该发 1 条，实际 ${JSON.stringify(prefetch)}`);
  report.passed.push("预取登记在途：两次预取 + 用户点进去，同一个详情 id 只出网 1 次（loadDetail 复用在途）");

  /* ── D. api_home_details 的 key/args 归一化 ── */
  const normalized = await page.evaluate(async () => {
    window.dupFixture.reset();
    const { api } = window.dupFixture.modules;
    const a = api.homeDetails([3, 1, 2, 1]);
    const b = api.homeDetails([1, 2, 3]);       // 顺序不同、有重复：同一个 key
    await Promise.allSettled([a, b]);
    await new Promise((r) => setTimeout(r, 300));
    const f = window.dupFixture;
    return {
      invokes: f.history.filter((row) => row.cmd === "api_home_details").map((row) => row.args.ids),
      perPath: f.http.map((row) => row.path),
    };
  });
  report.metrics.homeDetailsKey = normalized;
  assert.equal(normalized.invokes.length, 1,
    `同一批 banner id（顺序/重复不同）应命中同一个在途 key，实际发了 ${normalized.invokes.length} 次：${JSON.stringify(normalized.invokes)}`);
  assert.deepEqual(normalized.invokes[0], [1, 2, 3], "ids 归一化要 去重 + 升序");
  assert.deepEqual([...normalized.perPath].sort(), ["/api/videos/1", "/api/videos/2", "/api/videos/3"], "补全只该打 3 条详情");
  report.passed.push("api_home_details 走 call() 的在途合并 + ids 归一化：同一批 id 只发 1 次、只打 3 条详情");

  assert.deepEqual(pageErrors, [], `页面不该有未捕获异常：${pageErrors.join(" | ")}`);

  await page.screenshot({ path: join(output, "firstscreen.png") });
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error);
  if (page) {
    try { await page.screenshot({ path: join(output, "failure.png") }); } catch { /* ignore */ }
  }
} finally {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  for (const line of report.passed) console.log(`PASS  ${line}`);
  if (!report.ok) {
    console.error(`FAIL  ${report.error}`);
    console.error(`报告：${join(output, "report.json")}`);
    process.exit(1);
  }
  console.log(`\n全部通过。报告：${join(output, "report.json")}`);
}
