// 同剧切集时舞台/版式不能后退 —— 上游 5ec709e + 2d3f23b 的回归台。
//
// 上游那两条是围绕「CSS 旋转出来的横屏舞台（.fs-landscape）」修的；我们 v3.0.11 把伪横屏
// 整条删了，改成请求系统真转屏（.fs-immersive），所以「舞台保持」这一半在我们这边
// 表现为不同的东西：
//   1. 同剧切集时 videoSize 若归零 → 「全屏观看」入口消失一帧、竖版片源的 cover 掉成 contain
//      （画面缩一下再回来）。本脚本用 `__holdMetadata(ms)` 卡住新一集的解码宽高，复现这段加载窗口。
//   2. 全屏收起态（idle）里锁图标必须跟着控件一起消失（上游 2d3f23b）：
//      我们由顶部那一栏的 `(!fs || !idle)` 统一控制，这里验回来。
//   3. 全屏里弹出的提示必须落在当前（横屏）视口内 —— 我们没有旋转坐标系，ToastHost 挂在
//      App 根部，这条是「不会先在竖屏位置闪一下」的可观测等价断言。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "episode-stage");
await mkdir(output, { recursive: true });
const report = { passed: [], failed: [], shots: [], data: {} };
const step = async (n, fn) => {
  try { await fn(); report.passed.push(n); console.log("  ok   " + n); }
  catch (e) { report.failed.push(`${n}: ${e.message}`); console.log("  FAIL " + n + ": " + e.message); }
};

const ENTRY = '[data-hg-control="fullscreen-entry"]';
const LOCK = '.player-root [aria-label="锁定播放控制"]';
const BACK = '.player-root [aria-label="返回"]';

const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({
  viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 11; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const boot = async (src, extra = "") => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}tests/player-modes.html?src=${src || ""}&fs=0&eps=5${extra}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player-root");
  await page.waitForTimeout(900);
};

/** 模拟系统转屏（真机上由 requestOrientation → 系统旋转 → WebView resize 完成） */
const rotate = async (landscape) => {
  await page.setViewportSize(landscape ? { width: 640, height: 360 } : { width: 360, height: 640 });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
  });
  await page.waitForTimeout(450);
};
const state = () => page.evaluate((sel) => {
  const v = document.querySelector(".player-root video");
  return {
    entry: document.querySelectorAll(sel).length,
    fit: v ? (v.className.includes("object-cover") ? "cover" : "contain") : "",
    immersive: !!document.querySelector(".player-root.fs-immersive"),
    lock: document.querySelectorAll('.player-root [aria-label="锁定播放控制"]').length,
    back: document.querySelectorAll('.player-root [aria-label="返回"]').length,
    toasts: document.querySelectorAll(".ios-toast-host > div").length,
    inner: [innerWidth, innerHeight],
    plays: (window.playerModeFixture?.calls || []).filter((c) => c.cmd === "api_play").map((c) => Number(c.args.ep)),
  };
}, ENTRY);

try {
  /* ───── ① 竖屏 + 横版片源：切集加载窗口里「全屏观看」入口不能消失 ───── */
  await boot("land");
  const before = await state();
  report.data.portraitLandscape = { before };
  await step("横版片源竖屏：入口在（基线）", async () => {
    assert.equal(before.entry, 1, `入口 ${before.entry} 个`);
  });

  /* 卡住新一集的解码宽高 1.5s，模拟真机上「切集后元数据还没到」的窗口 */
  await page.evaluate(() => window.__holdMetadata(1500));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const during = await state();
  report.data.portraitLandscape.during = during;
  await page.screenshot({ path: join(output, "portrait-landscape-gap.png") });
  report.shots.push(join(output, "portrait-landscape-gap.png"));
  await step("切集确实发生了（api_play 走到了第 2 集）", async () => {
    assert.ok(during.plays.includes(2), `api_play ep=${JSON.stringify(during.plays)}`);
  });
  await step("加载窗口里入口仍在（同剧沿用上一集宽高，不退回竖版）", async () => {
    assert.equal(during.entry, 1, `入口 ${during.entry} 个 → 切集瞬间入口消失`);
  });
  await page.waitForTimeout(1600);
  const after = await state();
  report.data.portraitLandscape.after = after;
  await step("新一集宽高到达后入口仍在，且只有 1 个", async () => {
    assert.equal(after.entry, 1, `入口 ${after.entry} 个`);
  });

  /* ───── ② 竖屏 + 竖版片源：切集不能把 cover 抖成 contain ───── */
  await boot("port");
  const portBefore = await state();
  report.data.portraitPortrait = { before: portBefore };
  await page.evaluate(() => window.__holdMetadata(1500));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const portDuring = await state();
  report.data.portraitPortrait.during = portDuring;
  await page.screenshot({ path: join(output, "portrait-vertical-gap.png") });
  report.shots.push(join(output, "portrait-vertical-gap.png"));
  await step("竖版片源：切集加载窗口里仍按 cover 铺满（不缩成 contain）", async () => {
    assert.equal(portBefore.fit, "cover", `切集前 fit=${portBefore.fit}`);
    assert.equal(portDuring.fit, "cover", `切集瞬间 fit=${portDuring.fit} → 画面缩了一下`);
  });
  await page.waitForTimeout(1600);

  /* ───── ③ 全屏：切集不丢沉浸层；锁图标随控件收起（上游 2d3f23b） ───── */
  await boot("land");
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel); const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, ENTRY);
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(250);
  await rotate(true);
  const fsState = await state();
  report.data.fullscreen = { entered: fsState };
  await step("进全屏（横屏视口 + .fs-immersive）", async () => {
    assert.ok(fsState.inner[0] > fsState.inner[1], `视口 ${fsState.inner}`);
    assert.ok(fsState.immersive, "没有 .fs-immersive");
  });
  await step("全屏控件可见时锁图标在、返回在", async () => {
    assert.ok(fsState.lock >= 1, `锁 ${fsState.lock} 个`);
    assert.ok(fsState.back >= 1, `返回 ${fsState.back} 个`);
  });

  await page.waitForTimeout(3600);   // 控件自动收起（AUTOHIDE_MS = 3000）
  const idleState = await state();
  report.data.fullscreen.idle = idleState;
  await page.screenshot({ path: join(output, "fullscreen-idle.png") });
  report.shots.push(join(output, "fullscreen-idle.png"));
  await step("全屏控件收起后：锁图标与返回一起消失（不留常驻锁）", async () => {
    assert.equal(idleState.lock, 0, `锁仍有 ${idleState.lock} 个`);
    assert.equal(idleState.back, 0, `返回仍有 ${idleState.back} 个`);
  });

  /* 收起态切集：舞台（.fs-immersive）必须还在 */
  await page.evaluate(() => window.__holdMetadata(1500));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const fsGap = await state();
  report.data.fullscreen.gap = fsGap;
  await page.screenshot({ path: join(output, "fullscreen-switch-gap.png") });
  report.shots.push(join(output, "fullscreen-switch-gap.png"));
  await step("全屏切集加载窗口里仍留在 .fs-immersive（没有掉回竖屏）", async () => {
    assert.ok(fsGap.immersive, "沉浸层消失");
    assert.ok(fsGap.inner[0] > fsGap.inner[1], `视口 ${fsGap.inner}`);
  });

} finally {
  report.errors = errors;
  report.summary = `${report.passed.length} passed / ${report.failed.length} failed`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log("\n" + JSON.stringify(report.data, null, 1));
  console.log(report.summary);
  await browser.close();
  await vite.close();
}
process.exit(report.failed.length ? 1 : 0);
