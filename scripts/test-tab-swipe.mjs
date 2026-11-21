import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

// 上游 29e273a 回归：tab 横向滑切。
//   真实 Chromium + 真触摸事件（CDP Input.dispatchTouchEvent），390×844 手机视口。
//   契约：左滑下一个 / 右滑上一个 / 首尾不循环 / 纵向滑动不切 / 滑完那一下不吃掉卡片点击。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "tab-swipe", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = {
  environment: "真实 Chromium + CDP 触摸事件；页面为真 FavoritesPage / HistoryPage / ChannelPage + useTabSwipe 钩子探针；Tauri IPC 被 mock",
  passed: [],
  failed: [],
};

let vite, browser, context;

const swipe = async (cdp, box, dx, dy = 0) => {
  const x = box.x + box.width - 26;
  const y = box.y + Math.min(220, box.height * 0.28);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6, id: 1 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

const step = async (name, fn) => {
  try {
    await fn();
    report.passed.push(name);
    console.log(`  ok   ${name}`);
  } catch (error) {
    report.failed.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
};

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  });
  await context.addInitScript(() => {
    localStorage.setItem("hguox_app_v1", JSON.stringify({ favs: [1, 2, 3], history: [1, 2], postHistory: [1] }));
  });

  /* ---------------- 1. 钩子级：阈值 / 轴比 / 点击抑制 ---------------- */
  {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${origin}tests/tab-swipe-hook.html`, { waitUntil: "networkidle" });
    await page.locator("#probe-root").waitFor();
    const cdp = await context.newCDPSession(page);
    const box = await page.locator("#probe-root").boundingBox();
    const state = () => page.evaluate(() => ({ tabs: window.swipeProbe.tabs.slice(), clicks: window.swipeProbe.clicks, index: window.swipeProbe.index }));

    await step("钩子：左滑 128px → 切到下一个 tab", async () => {
      await swipe(cdp, box, -128);
      await page.waitForTimeout(120);
      const s = await state();
      assert.deepEqual(s.tabs, [1], `tabs=${JSON.stringify(s.tabs)}`);
    });

    await step("钩子：位移不足 40px 不切 tab", async () => {
      await page.waitForTimeout(420);
      await swipe(cdp, box, -40);
      await page.waitForTimeout(120);
      const s = await state();
      assert.deepEqual(s.tabs, [1], `tabs=${JSON.stringify(s.tabs)}`);
    });

    await step("钩子：纵向 140px 不切 tab，且不拦纵向手势", async () => {
      await page.evaluate(() => { window.swipeProbe.prevented.length = 0; });
      await swipe(cdp, box, 6, 140);
      await page.waitForTimeout(120);
      const s = await state();
      assert.deepEqual(s.tabs, [1], `tabs=${JSON.stringify(s.tabs)}`);
      const prevented = await page.evaluate(() => window.swipeProbe.prevented.slice());
      assert.ok(prevented.length > 0, "应当收到 touchmove");
      assert.ok(prevented.every(v => v === false), `纵向手势被拦了：${JSON.stringify(prevented)}`);
    });

    await step("钩子：滑动后 360ms 内的 click 被吞掉，之后再点恢复", async () => {
      await page.waitForTimeout(420);
      const before = (await state()).clicks;
      await swipe(cdp, box, 128);
      await page.waitForTimeout(60);
      await page.locator("#probe-hit").dispatchEvent("click");
      assert.equal((await state()).clicks, before, "滑动后的余波 click 不应到达卡片");
      await page.waitForTimeout(420);
      await page.locator("#probe-hit").dispatchEvent("click");
      assert.equal((await state()).clicks, before + 1, "抑制窗口过后点击应正常");
    });

    await step("钩子：首尾不循环（已到 0，右滑不动）", async () => {
      await page.waitForTimeout(420);
      const s0 = await state();
      await swipe(cdp, box, 128);
      await page.waitForTimeout(120);
      const s1 = await state();
      assert.equal(s1.index, s0.index, `index 从 ${s0.index} 变成了 ${s1.index}`);
    });

    assert.deepEqual(errors, [], `页面报错：${errors.join(" | ")}`);
    await page.close();
  }

  /* ---------------- 2. 真页面：收藏 / 历史 / 频道 ---------------- */
  {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${origin}tests/tab-swipe.html`, { waitUntil: "networkidle" });
    await page.waitForSelector('[aria-label="收藏分类"]');
    const cdp = await context.newCDPSession(page);
    /* 短剧/吃瓜 分段用的是 aria-selected；频道筛选按钮用的是 aria-pressed——两种都认。 */
    const activeSeg = label => page.locator(
      `[aria-label="${label}"] button[aria-selected="true"], [aria-label="${label}"] button[aria-pressed="true"]`,
    ).first().innerText();
    const segWait = (label, prefix) => page.waitForFunction(([l, p]) => {
      const el = document.querySelector(`[aria-label="${l}"] button[aria-selected="true"], [aria-label="${l}"] button[aria-pressed="true"]`);
      return !!el && (el.textContent || "").startsWith(p);
    }, [label, prefix]);

    await step("收藏页：短剧 ←左滑→ 吃瓜", async () => {
      assert.equal(await activeSeg("收藏分类"), "短剧 (3)");
      const box = await page.locator('[aria-label="收藏分类"]').boundingBox();
      await swipe(cdp, { ...box, height: 600 }, -128);
      await segWait("收藏分类", "吃瓜");
      assert.ok((await activeSeg("收藏分类")).startsWith("吃瓜"));
      await page.waitForTimeout(400);
      /* 高亮药丸（indicator）必须真的挪到吃瓜那格，不能只有 aria 状态变了。 */
      const indicator = await page.locator('[aria-label="收藏分类"] .ios-segmented-indicator').boundingBox();
      const postBtn = await page.locator('[aria-label="收藏分类"] button').nth(1).boundingBox();
      assert.ok(indicator && postBtn, "取不到药丸/按钮位置");
      assert.ok(Math.abs((indicator.x + indicator.width / 2) - (postBtn.x + postBtn.width / 2)) < 6,
        `药丸没挪到吃瓜：indicator=${JSON.stringify(indicator)} button=${JSON.stringify(postBtn)}`);
      await page.screenshot({ path: join(output, "favorites-post.png") });
    });

    await step("收藏页：右滑回到短剧", async () => {
      const box = await page.locator('[aria-label="收藏分类"]').boundingBox();
      await swipe(cdp, { ...box, height: 600 }, 128);
      await segWait("收藏分类", "短剧");
      assert.ok((await activeSeg("收藏分类")).startsWith("短剧"));
    });

    await step("历史页：短剧 ←左滑→ 吃瓜，纵向滑动不切", async () => {
      await page.evaluate(() => window.tabSwipeGo("hist"));
      await page.waitForSelector('[aria-label="历史分类"]');
      assert.ok((await activeSeg("历史分类")).startsWith("短剧"));
      const box = await page.locator('[aria-label="历史分类"]').boundingBox();
      await swipe(cdp, { ...box, height: 500 }, 6, 150);
      await page.waitForTimeout(160);
      assert.ok((await activeSeg("历史分类")).startsWith("短剧"), "纵向滑动不该切 tab");
      await swipe(cdp, { ...box, height: 500 }, -128);
      await segWait("历史分类", "吃瓜");
      assert.ok((await activeSeg("历史分类")).startsWith("吃瓜"));
      await page.screenshot({ path: join(output, "history-post.png") });
    });

    await step("收藏页：批量选择进行中滑切被关闭（不会误清选择）", async () => {
      await page.evaluate(() => window.tabSwipeGo("fav"));
      await page.waitForSelector('[aria-label="收藏分类"]');
      const card = page.locator(".ios-media-grid > *").first();
      await card.waitFor();
      const box = await card.boundingBox();
      /* 长按 600ms 进入多选 */
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
      await page.waitForTimeout(620);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(() => !!document.querySelector('[aria-label="批量管理"]'));
      const segBefore = await activeSeg("收藏分类");
      const segBox = await page.locator('[aria-label="收藏分类"]').boundingBox();
      await swipe(cdp, { ...segBox, height: 600 }, -128);
      await page.waitForTimeout(220);
      assert.equal(await activeSeg("收藏分类"), segBefore, "选择态下滑切不应切换 tab");
      assert.ok(await page.locator('[aria-label="批量管理"]').isVisible(), "选择态被误清空了");
      await page.screenshot({ path: join(output, "favorites-selecting.png") });
    });

    await step("频道页：最近更新 ←左滑→ 下一筛选", async () => {
      await page.evaluate(() => window.tabSwipeGo("channel"));
      await page.waitForSelector('[aria-label="频道排序"]');
      const before = await activeSeg("频道排序");
      const box = await page.locator('[aria-label="频道排序"]').boundingBox();
      await swipe(cdp, { ...box, height: 560 }, -128);
      await page.waitForTimeout(260);
      const after = await activeSeg("频道排序");
      assert.notEqual(after, before, `频道筛选没变：${before}`);
      await page.screenshot({ path: join(output, "channel-next.png") });
    });

    assert.deepEqual(errors, [], `页面报错：${errors.join(" | ")}`);
    await page.close();
  }

  report.ok = report.failed.length === 0;
  console.log(report.ok ? `PASS: tab-swipe (${report.passed.length} checks)` : `FAIL: tab-swipe (${report.failed.length} failed)`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.log(error);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
