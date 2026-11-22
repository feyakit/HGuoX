import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

// 上游 66e02b4 回归：排行榜「热播榜 / 推荐榜 / 潜力榜」左右滑切。
//   真实 Chromium + CDP 触摸事件，390×844；页面是真 RankPage（Tauri IPC 被 mock）。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "rank-swipe", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "真实 Chromium + CDP 触摸事件；真 RankPage；Tauri IPC mock", passed: [], failed: [] };
let vite, browser;

const step = async (name, fn) => {
  try { await fn(); report.passed.push(name); console.log(`  ok   ${name}`); }
  catch (error) { report.failed.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`); }
};

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(`${origin}tests/rank-swipe.html`, { waitUntil: "networkidle" });
  await page.waitForSelector('[aria-label="榜单类型"]');
  const cdp = await context.newCDPSession(page);
  const activeTab = () => page.locator('[aria-label="榜单类型"] button[aria-pressed="true"]').innerText();
  const waitTab = name => page.waitForFunction(n =>
    document.querySelector('[aria-label="榜单类型"] button[aria-pressed="true"]')?.textContent === n, name);

  const swipe = async (dx, dy = 0) => {
    const box = await page.locator(".ios-page > div.flex-1").first().boundingBox();
    assert.ok(box);
    const x = box.x + box.width - 26;
    const y = box.y + Math.min(260, box.height * 0.3);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * i / 6, y: y + dy * i / 6, id: 1 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(160);
  };

  await step("左滑 热播榜 → 推荐榜", async () => {
    assert.equal(await activeTab(), "热播榜");
    await swipe(-128);
    await waitTab("推荐榜");
    assert.equal(await activeTab(), "推荐榜");
  });

  await step("左滑 推荐榜 → 潜力榜", async () => {
    await swipe(-128);
    await waitTab("潜力榜");
    assert.equal(await activeTab(), "潜力榜");
    await page.screenshot({ path: join(output, "rank-potential.png") });
  });

  await step("末位继续左滑不循环（仍停在潜力榜）", async () => {
    await swipe(-128);
    assert.equal(await activeTab(), "潜力榜");
  });

  await step("右滑 潜力榜 → 推荐榜（回到上一榜）", async () => {
    await swipe(128);
    await waitTab("推荐榜");
    assert.equal(await activeTab(), "推荐榜");
  });

  await step("纵向滑动不切榜", async () => {
    await swipe(6, 150);
    assert.equal(await activeTab(), "推荐榜");
  });

  await step("切榜沿用了加载逻辑（每个榜都真的请求过）", async () => {
    const calls = await page.evaluate(() => window.rankFixture.calls.slice());
    for (const kind of ["hot", "recommend", "potential"]) {
      assert.ok(calls.includes(kind), `没请求过 ${kind}：${JSON.stringify(calls)}`);
    }
  });

  assert.deepEqual(errors, [], `页面报错：${errors.join(" | ")}`);
  report.ok = report.failed.length === 0;
  console.log(report.ok ? `PASS: rank-swipe (${report.passed.length} checks)` : `FAIL: rank-swipe (${report.failed.length} failed)`);
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
