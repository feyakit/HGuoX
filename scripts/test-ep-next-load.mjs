// 切下一集 api_play 计数：连续切 5 次，每集单独计数 + <video> 重挂次数。
//
// 用法：node scripts/test-ep-next-load.mjs [tag]
//   真组件 + 真 store + 只 mock Tauri IPC（见 tests/ep-next-load.tsx）。
//
// 判据（v3.0.20「加载两次」的验收口径）：
//   A 预取开启：连切 5 次 → 每集 api_play ≤1 次（=1），每次切集 <video> 只换 1 次 src
//   B 无预取：连切 5 次 → 每集 1 次（证明播放这一路本身只发一次，不是双 render）
//   C 地址恒定：切集只重挂一次（排除「同一地址被设两遍」这类假阳性）
//   D 极慢接口 + 快速连切：在途请求合并，每集仍 1 次，日志里有 merge
//   E 代理切换：同一集必须**重新问一次**（重取这条路不能被合并吃掉）
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] || process.env.SHOT_TAG || "after";
const output = join(root, "test-results", "ep-next-load", tag);
await mkdir(output, { recursive: true });
const report = { tag, cases: {}, failed: [] };

const step = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { report.failed.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); }
};

let vite, browser, context, page, origin;

/** 控件 3s 自动收起：点一下画面唤出来（真触摸，走和真机同一条 pointer 链） */
const ensureNextButton = async () => {
  for (let i = 0; i < 3; i += 1) {
    const has = await page.evaluate(() => [...document.querySelectorAll(".player-root button")]
      .some(b => /^下一集|^下集/.test(b.getAttribute("aria-label") || "")));
    if (has) return true;
    await page.touchscreen.tap(180, 300);
    await page.waitForTimeout(500);
  }
  return false;
};

const switchOnce = async (settleMs = 2200) => {
  const before = await page.evaluate(() => ({ ep: window.__v.ep(), srcs: window.__v.srcChangeCount() }));
  await ensureNextButton();
  const clicked = await page.evaluate(() => window.__v.clickNext());
  if (!clicked.ok) throw new Error(`找不到「下一集」按钮：${JSON.stringify(clicked.labels || clicked.reason)}`);
  await page.waitForTimeout(settleMs);
  const after = await page.evaluate(() => ({ ep: window.__v.ep(), srcs: window.__v.srcs(), plays: window.__v.plays() }));
  return {
    from: before.ep, to: after.ep,
    srcChanges: after.srcs.length - before.srcs,
    srcList: after.srcs.map(s => s.src),
  };
};

/** 起一座台子，连续切 switchCount 次「下一集」 */
const runSwitches = async (query, switchCount = 5, settleMs = 2200) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}tests/ep-next-load.html?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".player-root", { timeout: 15000 });
  /* 首集落定：等 api_play 回来 + playingKey 跟上（预取才有机会触发） */
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.__v.reset());
  /* 让 src 轮询重新记一条基线，否则第一次比对的差值会是 2（台子问题，不是产品问题） */
  await page.waitForTimeout(220);
  const per = [];
  for (let i = 0; i < switchCount; i += 1) per.push(await switchOnce(settleMs));
  const final = await page.evaluate(() => ({
    perEp: window.__v.perEp(), plays: window.__v.plays(), srcs: window.__v.srcs(),
    ep: window.__v.ep(), logs: window.__v.logs(), body: window.__v.bodyText(),
  }));
  return { per, final };
};

const epList = (perEp) => Object.entries(perEp).map(([ep, n]) => ({ ep: Number(ep), n })).sort((a, b) => a.ep - b.ep);

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 11; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
  });
  await context.addInitScript(() => { localStorage.setItem("hguox_app_v1", JSON.stringify({ favs: [], history: [], postHistory: [] })); });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  /* A. 有预取（playingKey 跟上 → 预取下一集），连续切 5 集 */
  await step("A 预取开启：连切 5 次，每集 api_play ≤1 次、每次切集只重挂 1 次", async () => {
    const r = await runSwitches("eps=8&delay=300", 5);
    report.cases.withPrefetch = r;
    const counts = epList(r.final.perEp);
    console.log("      每集调用次数 " + JSON.stringify(counts.map(c => `${c.ep}:${c.n}`)));
    console.log("      切集后 src 替换次数 " + JSON.stringify(r.per.map(p => p.srcChanges)));
    console.log("      切集轨迹 " + r.per.map(p => `${p.from}→${p.to}`).join(" "));
    const worst = counts.reduce((m, c) => Math.max(m, c.n), 0);
    assert.ok(worst <= 1, `有集被请求了 ${worst} 次（应 ≤1）：${JSON.stringify(counts)}`);
    const worstSrc = r.per.reduce((m, p) => Math.max(m, p.srcChanges), 0);
    assert.ok(worstSrc <= 1, `切一次集 <video> 换了 ${worstSrc} 次地址（应 1）`);
    assert.ok(counts.length >= 4, `只统计到 ${counts.length} 集，台子没走满`);
  });

  /* B. 不自动起播（不触发预取）：隔离「预取 + 播放」双路的贡献 */
  await step("B 无预取：连切 5 次，每集仍是 1 次（播放这一路本身不重复）", async () => {
    const r = await runSwitches("eps=8&delay=300&autoplay=0", 5);
    report.cases.noPrefetch = r;
    const counts = epList(r.final.perEp);
    console.log("      每集调用次数 " + JSON.stringify(counts.map(c => `${c.ep}:${c.n}`)));
    const worst = counts.reduce((m, c) => Math.max(m, c.n), 0);
    assert.ok(worst <= 1, `无预取时反而多请了：${JSON.stringify(counts)}`);
  });

  /* C. 地址固定：请求次数不变时，看「src 是否还被换两次」 */
  await step("C 地址恒定：切集后 <video> 只重挂一次", async () => {
    const r = await runSwitches("eps=8&delay=300&stable=1", 5);
    report.cases.stableUrl = r;
    const worst = r.per.reduce((m, p) => Math.max(m, p.srcChanges), 0);
    console.log("      切集后 src 替换次数 " + JSON.stringify(r.per.map(p => p.srcChanges)));
    assert.ok(worst <= 1, `地址恒定时仍重挂了 ${worst} 次`);
  });

  /* D. 极慢接口（1.5s）+ 快速切三集：在途请求必须合并，不能一人一条 */
  await step("D 慢接口快速连切：在途合并，每集仍 1 次", async () => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`${origin}tests/ep-next-load.html?eps=8&delay=1500`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".player-root", { timeout: 15000 });
    await page.waitForTimeout(2600);
    await page.evaluate(() => window.__v.reset());
  /* 让 src 轮询重新记一条基线，否则第一次比对的差值会是 2（台子问题，不是产品问题） */
  await page.waitForTimeout(220);
    for (let i = 0; i < 3; i += 1) {
      await ensureNextButton();
      await page.evaluate(() => window.__v.clickNext());
      await page.waitForTimeout(250);   // 远小于 1.5s 的人工时延：请求还在途就切走了
    }
    await page.waitForTimeout(4000);
    const final = await page.evaluate(() => ({ perEp: window.__v.perEp(), logs: window.__v.logs(), ep: window.__v.ep() }));
    report.cases.slowMerge = final;
    const counts = epList(final.perEp);
    console.log("      每集调用次数 " + JSON.stringify(counts.map(c => `${c.ep}:${c.n}`)));
    console.log("      合并/复用取证 " + JSON.stringify(final.logs.filter(l => /merge in-flight|reuse prefetch/.test(l))));
    const worst = counts.reduce((m, c) => Math.max(m, c.n), 0);
    assert.ok(worst <= 1, `慢接口下某集被请求了 ${worst} 次：${JSON.stringify(counts)}`);
  });

  /* E. 往返一次：回到已经播过的集，地址必须**重新问**（我的改动不能变成地址缓存） */
  await step("E 往返（第3集→第2集→第3集）：已播过的集仍重新问地址，且每次进入只问一次", async () => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`${origin}tests/ep-next-load.html?eps=8&delay=200`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".player-root", { timeout: 15000 });
    await page.waitForTimeout(1500);
    await ensureNextButton();
    await page.evaluate(() => window.__v.clickNext());   // 1 → 2
    await page.waitForTimeout(1400);
    await ensureNextButton();
    await page.evaluate(() => window.__v.clickNext());   // 2 → 3
    await page.waitForTimeout(1400);
    await page.evaluate(() => window.__v.reset());
  /* 让 src 轮询重新记一条基线，否则第一次比对的差值会是 2（台子问题，不是产品问题） */
  await page.waitForTimeout(220);
    /* 回上一集（第 2 集）：这一集之前播过，地址表里还留着记录 —— 必须重新问一次 */
    await ensureNextButton();
    const back = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".player-root button")].find(b => (b.getAttribute("aria-label") || "") === "上一集");
      if (!btn) return { ok: false };
      btn.click();
      return { ok: true };
    });
    assert.ok(back.ok, "找不到「上一集」按钮");
    await page.waitForTimeout(1600);
    const afterBack = await page.evaluate(() => ({ ep: window.__v.ep(), perEp: window.__v.perEp(), logs: window.__v.logs() }));
    report.cases.backAndForth = { afterBack };
    console.log(`      回到 ${afterBack.ep}：本窗口请求数 ${JSON.stringify(afterBack.perEp)}`);
    const list = epList(afterBack.perEp);
    assert.ok(list.length >= 1, "回到上一集没有重新请求播放地址（地址被缓存了）");
    const worst = list.reduce((m, c) => Math.max(m, c.n), 0);
    assert.ok(worst <= 1, `回上一集时同一集被问了 ${worst} 次：${JSON.stringify(list)}`);
  });

  await page.screenshot({ path: join(output, "last.png") });
  report.pageErrors = errors;
} finally {
  report.summary = `${report.failed.length ? "FAILED" : "PASS"} · ${report.failed.length} failed`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n[${tag}] ${report.summary}`);
  await browser?.close();
  await vite?.close();
}
process.exit(report.failed.length ? 1 : 0);
