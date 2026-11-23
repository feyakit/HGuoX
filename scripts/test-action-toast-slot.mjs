// 点赞/收藏/关注的提示共用「播放提示」单槽（上游 9896092 / #219）。
//
// 真 EpisodePlayer + 真 store + 真 ToastHost：连点两个动作按钮，看提示是「原地替换」
// 还是「堆两张卡」。带 tag 的 toast 在 store 里按 tag 原地替换，所以这里只数
// .ios-toast-host 里的条数并核对文案 —— 不碰 UI 尺寸。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "action-toast-slot");
await mkdir(output, { recursive: true });
const report = { passed: [], failed: [], shots: [], data: {} };
const step = async (n, fn) => {
  try { await fn(); report.passed.push(n); console.log("  ok   " + n); }
  catch (e) { report.failed.push(`${n}: ${e.message}`); console.log("  FAIL " + n + ": " + e.message); }
};

const LIKE = '.player-root [aria-label="点赞"]';
const FAV = '.player-root [aria-label="收藏"]';

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

/* 只数「动作提示」：「播放地址已刷新，正在重试」这类无 tag 的线路提示是另一个槽，
   会正常叠加，不能算进来（真机上也是两条并存）。 */
const ACTION = /喜欢|收藏|关注/;
const toasts = () => page.evaluate((pattern) => {
  const re = new RegExp(pattern);
  const all = Array.from(document.querySelectorAll(".ios-toast-host > div"));
  const nodes = all.filter((n) => re.test(n.textContent || ""));
  return { count: nodes.length, texts: nodes.map((n) => (n.textContent || "").trim()),
    otherTexts: all.filter((n) => !re.test(n.textContent || "")).map((n) => (n.textContent || "").trim()) };
}, ACTION.source);
const center = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, sel);

try {
  await page.goto(`${origin}tests/player-modes.html?src=land&fs=0&eps=5`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player-root");
  await page.waitForTimeout(900);

  await step("播放页竖屏能看到点赞与收藏按钮", async () => {
    assert.ok(await center(LIKE), "找不到点赞按钮");
    assert.ok(await center(FAV), "找不到收藏按钮");
  });

  /* 连点：先点赞，120ms 内再收藏 —— 真机上「随手连点」就是这个节奏 */
  const like = await center(LIKE);
  await page.touchscreen.tap(like.x, like.y);
  await page.waitForTimeout(120);
  const fav = await center(FAV);
  await page.touchscreen.tap(fav.x, fav.y);
  await page.waitForTimeout(500);
  const after = await toasts();
  report.data.afterTwoActions = after;
  await page.screenshot({ path: join(output, "two-actions-one-toast.png") });
  report.shots.push(join(output, "two-actions-one-toast.png"));

  await step("点赞 + 收藏连点：提示只有 1 条（同槽原地替换，不堆卡）", async () => {
    assert.equal(after.count, 1, `提示 ${after.count} 条：${JSON.stringify(after.texts)}`);
  });
  await step("留下的是最后那个动作的文案（收藏）", async () => {
    assert.ok(after.texts[0].includes("收藏"), `文案：${JSON.stringify(after.texts)}`);
  });

  /* 再点一次点赞：仍然只占一条，且文案换成点赞 */
  const like2 = await center(LIKE);
  await page.touchscreen.tap(like2.x, like2.y);
  await page.waitForTimeout(500);
  const third = await toasts();
  report.data.afterThird = third;
  await page.screenshot({ path: join(output, "third-action-still-one.png") });
  report.shots.push(join(output, "third-action-still-one.png"));
  await step("第三次动作仍然只占一条，文案换成点赞", async () => {
    assert.equal(third.count, 1, `提示 ${third.count} 条：${JSON.stringify(third.texts)}`);
    assert.ok(/喜欢/.test(third.texts[0]), `文案：${JSON.stringify(third.texts)}`);
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
