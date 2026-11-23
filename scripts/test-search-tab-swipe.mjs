// 搜索页：结果区横滑切 tab + 清空搜索复位（上游 36f9058 / 5df811a）。
//
// 真 Search 页面 + 真 useTabSwipe + CDP 触摸事件。判据只有三条：
//   左滑 → 「吃瓜帖子」被选中且真的按 post 重搜；右滑 → 回到「短剧剧集」；
//   清空 → tab/输入/结果一起复位到初始态。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "search-tab-swipe");
await mkdir(output, { recursive: true });
const report = { passed: [], failed: [], shots: [], data: {} };
const step = async (n, fn) => {
  try { await fn(); report.passed.push(n); console.log("  ok   " + n); }
  catch (e) { report.failed.push(`${n}: ${e.message}`); console.log("  FAIL " + n + ": " + e.message); }
};

const TABS = '.hg-seg-track button';
const INPUT = '.hg-subpage-bar input';
const CLEAR = '[aria-label="清空搜索"]';
/* state() 里已经把 api_search 调用投影成 { kind, q }，这里只比 kind */
const SEARCH_CMD = (kind) => (c) => c.kind === kind;

const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 11; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const swipe = async (box, dx, dy = 0) => {
  const x = box.x + box.width - 30;
  const y = box.y + Math.min(200, box.height * 0.3);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  for (let i = 1; i <= 6; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * i / 6, y: y + dy * i / 6, id: 1 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
};

const state = () => page.evaluate((sel) => {
  const tabs = Array.from(document.querySelectorAll(sel.buttons)).map((b) => ({
    text: (b.textContent || "").trim(), pressed: b.getAttribute("aria-pressed") === "true",
  }));
  const input = document.querySelector(sel.input);
  return {
    tabs,
    value: input ? input.value : null,
    cards: document.querySelectorAll(".ios-media-grid a, .ios-media-grid > *").length,
    text: (document.querySelector(".ios-media-grid")?.textContent || "").slice(0, 400),
    clear: document.querySelectorAll(sel.clear).length,
    calls: window.searchFixture.calls.filter((c) => c.cmd === "api_search").map((c) => ({ kind: c.args.kind || "video", q: c.args.q })),
  };
}, { buttons: TABS, input: INPUT, clear: CLEAR });

try {
  await page.goto(`${origin}tests/search-tab.html`, { waitUntil: "networkidle" });
  await page.waitForSelector(TABS);

  /* ───── 没出结果：只有一个 tab，横滑不该动 ───── */
  const idle = await state();
  const area = await page.evaluate(() => {
    const el = document.querySelector(".hg-page-x.flex-1");
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await swipe(area, -128);
  const idleAfter = await state();
  report.data.idle = { before: idle, after: idleAfter };
  await step("未搜索时左滑不切 tab（tabCount=1）", async () => {
    assert.equal(idleAfter.tabs[0].pressed, true, JSON.stringify(idleAfter.tabs));
    assert.equal(idleAfter.calls.length, 0, `不该发起搜索：${JSON.stringify(idleAfter.calls)}`);
  });

  /* ───── 搜索后：左滑切到吃瓜帖子 ───── */
  await page.fill(INPUT, "荒岛");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ios-media-grid");
  const searched = await state();
  report.data.searched = searched;
  await step("搜索后默认「短剧剧集」选中，且走了 video 搜索", async () => {
    assert.equal(searched.tabs[0].pressed, true, JSON.stringify(searched.tabs));
    assert.ok(searched.calls.some(SEARCH_CMD("video")), JSON.stringify(searched.calls));
  });

  await swipe(area, -128);
  const afterLeft = await state();
  report.data.afterLeft = afterLeft;
  await page.screenshot({ path: join(output, "after-swipe-left.png") });
  report.shots.push(join(output, "after-swipe-left.png"));
  await step("左滑 → 「吃瓜帖子」被选中", async () => {
    assert.equal(afterLeft.tabs[1].pressed, true, JSON.stringify(afterLeft.tabs));
  });
  await step("左滑 → 真的按 post 重新搜索（不是只换高亮）", async () => {
    assert.ok(afterLeft.calls.some(SEARCH_CMD("post")), JSON.stringify(afterLeft.calls));
  });

  /* ───── 右滑切回短剧 ───── */
  await swipe(area, 128);
  const afterRight = await state();
  report.data.afterRight = afterRight;
  await page.screenshot({ path: join(output, "after-swipe-right.png") });
  report.shots.push(join(output, "after-swipe-right.png"));
  await step("右滑 → 回到「短剧剧集」，列表换回短剧结果", async () => {
    assert.equal(afterRight.tabs[0].pressed, true, JSON.stringify(afterRight.tabs));
    /* 5s 内同词回切走缓存，不重复请求 —— 所以判据是「列表换回了短剧结果」，不是调用次数 */
    assert.ok(afterRight.text.includes("短剧结果"), `列表内容：${afterRight.text.slice(0, 120)}`);
    assert.ok(!afterRight.text.includes("吃瓜结果"), `列表仍是吃瓜结果：${afterRight.text.slice(0, 120)}`);
  });

  /* ───── 清空搜索：tab 复位到短剧 ───── */
  await swipe(area, -128);      // 先切到吃瓜，验证清空会把 tab 拉回来
  await page.waitForTimeout(200);
  const onPost = await state();
  await page.click(CLEAR);
  await page.waitForTimeout(400);
  const cleared = await state();
  report.data.cleared = { onPost, cleared };
  await page.screenshot({ path: join(output, "after-clear.png") });
  report.shots.push(join(output, "after-clear.png"));
  await step("清空搜索：tab 复位到「短剧剧集」、输入清空、清空按钮消失", async () => {
    assert.equal(onPost.tabs[1].pressed, true, `清空前应在吃瓜 tab：${JSON.stringify(onPost.tabs)}`);
    assert.equal(cleared.tabs[0].pressed, true, `清空后 tab：${JSON.stringify(cleared.tabs)}`);
    assert.equal(cleared.value, "", `输入框：${cleared.value}`);
    assert.equal(cleared.clear, 0, `清空按钮仍有 ${cleared.clear} 个`);
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
