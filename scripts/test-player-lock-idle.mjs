// 全屏里「锁定屏幕」要跟控件一起收起来（上游 2d3f23b / #220）。
//
// 我们的锁不是独立常驻图标，而是顶部那一栏的一个格子；那一栏的显隐条件是
//   !isDesktop && !controlsLocked && active && (!fs || !idle)
// 所以「全屏收起后锁消失、点一下唤出又回来」就是这条修复的可观测等价断言。
// 基线 v3.0.11 上的行为已经满足（本脚本用于防回退），锁的判定标准与上游一致：随控件走。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "player-lock-idle");
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

/* 数「真的看得见」的锁：竖屏净屏态是用 .hidden 类隐藏的（DOM 里还在），
   只看 querySelectorAll 会误报。 */
const counts = () => page.evaluate((sel) => {
  const visible = (s) => Array.from(document.querySelectorAll(s)).filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
  }).length;
  return {
    lock: visible(sel.lock),
    back: visible(sel.back),
    lockInDom: document.querySelectorAll(sel.lock).length,
    immersive: !!document.querySelector(".player-root.fs-immersive"),
    inner: [innerWidth, innerHeight],
  };
}, { lock: LOCK, back: BACK });

try {
  await page.goto(`${origin}tests/player-modes.html?src=land&fs=0&eps=5`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player-root");
  await page.waitForTimeout(900);

  const t = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, ENTRY);
  await page.touchscreen.tap(t.x, t.y);
  await page.waitForTimeout(250);
  await page.setViewportSize({ width: 640, height: 360 });
  await page.evaluate(() => { window.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("orientationchange")); });
  await page.waitForTimeout(450);

  const shown = await counts();
  report.data.shown = shown;
  await page.screenshot({ path: join(output, "fullscreen-controls-shown.png") });
  report.shots.push(join(output, "fullscreen-controls-shown.png"));
  await step("全屏、控件可见：锁图标在（与返回同一栏）", async () => {
    assert.ok(shown.immersive, "不在全屏层");
    assert.equal(shown.lock, 1, `锁 ${shown.lock} 个`);
    assert.equal(shown.back, 1, `返回 ${shown.back} 个`);
  });

  await page.waitForTimeout(3600);
  const idle = await counts();
  report.data.idle = idle;
  await page.screenshot({ path: join(output, "fullscreen-idle.png") });
  report.shots.push(join(output, "fullscreen-idle.png"));
  await step("全屏、控件收起：锁图标和返回一起消失（不留常驻锁）", async () => {
    assert.equal(idle.lock, 0, `锁仍有 ${idle.lock} 个`);
    assert.equal(idle.back, 0, `返回仍有 ${idle.back} 个`);
    assert.ok(idle.immersive, "收起态不该退出全屏");
  });

  /* 收起态里点一下画面唤出控件。刻意避开正中：夹具的片源必然加载失败，
     错误提示卡就在正中，会把这个点按吃掉（真机上片源正常时点哪都行）。 */
  await page.touchscreen.tap(60, 300);
  await page.waitForTimeout(700);
  const woke = await counts();
  report.data.woke = woke;
  await step("点一下唤出控件：锁图标回来（收起 ≠ 禁用）", async () => {
    assert.equal(woke.lock, 1, `锁 ${woke.lock} 个`);
  });

  /* 竖屏净屏态：锁同样跟着控件走，不会单独挂在画面上 */
  await page.setViewportSize({ width: 360, height: 640 });
  await page.evaluate(() => { window.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("orientationchange")); });
  await page.waitForTimeout(400);
  await page.waitForTimeout(3600);
  const portraitIdle = await counts();
  report.data.portraitIdle = portraitIdle;
  await page.screenshot({ path: join(output, "portrait-cleaned.png") });
  report.shots.push(join(output, "portrait-cleaned.png"));
  await step("竖屏净屏态：锁同样收起（不单独常驻）", async () => {
    assert.equal(portraitIdle.lock, 0, `锁仍有 ${portraitIdle.lock} 个`);
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
