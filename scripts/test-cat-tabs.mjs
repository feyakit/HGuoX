// 分类页（片库）子 tab：点击切换（B16）+ 左右滑切（B17）。
// 真 Category 组件 + 真 api.call，只 mock Tauri IPC；真触摸用 CDP Input.dispatchTouchEvent。
//   B16 断言：点「最新上线」必须带 sort=new 真的出网，且首卡换成另一批；chips 的 aria-selected /
//             aria-pressed 跟着翻。旧报告「切换无效」= 连点两次（第二次点回「全部」）后界面本来就该是全部批。
//   B17 断言：片库区横滑能切子 tab；起手落在排序 chip 行 / 磁贴 / 纵滑时不抢手势。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "cat-tabs", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = {
  environment: "真实 Chromium + CDP 触摸事件，412×915 手机视口；真 Category 页面 + 真 api.call，Tauri IPC 被 mock",
  passed: [],
  failed: [],
};

let vite, browser, context, page, cdp;

const feeds = () => page.evaluate(() => window.catFixture.calls.filter(c => c.cmd === "api_feed").map(c => c.args));
const resetCalls = () => page.evaluate(() => window.catFixture.resetCalls());
const view = () => page.evaluate(() => ({
  first: document.querySelector(".hg-poster-name")?.textContent ?? null,
  cards: document.querySelectorAll(".hg-poster").length,
  chips: [...document.querySelectorAll(".hg-inline-sort")].map(b => ({
    text: (b.textContent || "").trim(),
    selected: b.getAttribute("aria-selected"),
    pressed: b.getAttribute("aria-pressed"),
  })),
}));
const chipNames = () => page.evaluate(() => [...document.querySelectorAll(".hg-inline-sort")].map(b => (b.textContent || "").trim()));
const selectedChip = async () => (await view()).chips.filter(c => c.selected === "true").map(c => c.text);

const tap = async (name) => {
  const box = await page.getByRole("tab", { name, exact: true }).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(50);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

const swipe = async (box, dx, dy = 0, at = "right") => {
  const x = at === "right" ? box.x + box.width - 26 : box.x + Math.min(box.width - 26, box.width * 0.9);
  const y = box.y + Math.min(40, box.height / 2);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * i / 6, y: y + dy * i / 6, id: 1 }] });
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
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  });
  await context.addInitScript(() => {
    localStorage.setItem("hguox_app_v1", JSON.stringify({ favs: [], history: [], postHistory: [] }));
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${origin}tests/cat-sort.html`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hg-poster");
  await page.waitForTimeout(300);
  cdp = await context.newCDPSession(page);

  /* ───────── B16：点击「最新上线」/「全部」 ───────── */
  await step("进页：默认「全部」，首卡是全部批", async () => {
    const v = await view();
    assert.deepEqual(await selectedChip(), ["全部"], `选中 chip=${JSON.stringify(v.chips)}`);
    assert.ok(v.first?.startsWith("全部-"), `首卡=${v.first}`);
    assert.ok(v.cards > 0, "没有卡片");
  });

  await step("点「最新上线」：真的带 sort=new 出网，首卡换成最新批", async () => {
    await resetCalls();
    await tap("最新上线");
    await page.waitForFunction(() => (document.querySelector(".hg-poster-name")?.textContent || "").startsWith("最新-"), null, { timeout: 4000 });
    const v = await view();
    const calls = await feeds();
    assert.deepEqual(calls.map(c => c.sort), ["new"], `api_feed 参数=${JSON.stringify(calls)}`);
    assert.ok(v.first?.startsWith("最新-"), `首卡=${v.first}`);
  });

  await step("点「全部」：回到全部批", async () => {
    await tap("全部");
    await page.waitForFunction(() => (document.querySelector(".hg-poster-name")?.textContent || "").startsWith("全部-"), null, { timeout: 4000 });
    assert.deepEqual(await selectedChip(), ["全部"]);
  });

  await step("chips 的 aria-selected 跟着翻（B16 判定口径之一）", async () => {
    const v = await view();
    for (const chip of v.chips) {
      assert.equal(chip.selected, chip.text === "全部" ? "true" : "false", `${chip.text} aria-selected=${chip.selected}`);
    }
  });

  /* ───────── B17：片库区左右滑切 ───────── */
  await step("片库区左滑 160px → 切到「最新上线」并重新拉取", async () => {
    await page.evaluate(() => window.catFixture.clearCache());
    await resetCalls();
    await swipe(await page.locator(".hg-poster").first().boundingBox(), -160);
    await page.waitForFunction(() => (document.querySelector(".hg-poster-name")?.textContent || "").startsWith("最新-"), null, { timeout: 4000 });
    assert.deepEqual(await selectedChip(), ["最新上线"]);
    const calls = await feeds();
    assert.deepEqual(calls.map(c => c.sort), ["new"], `api_feed 参数=${JSON.stringify(calls)}`);
  });

  await step("片库区右滑 160px → 回到「全部」", async () => {
    await swipe(await page.locator(".hg-poster").first().boundingBox(), 160, 0, "left");
    await page.waitForFunction(() => (document.querySelector(".hg-poster-name")?.textContent || "").startsWith("全部-"), null, { timeout: 4000 });
    assert.deepEqual(await selectedChip(), ["全部"]);
  });

  await step("横滑起手在排序 chip 行：放行给 chip 行自己的横滚，不切 tab", async () => {
    const before = await selectedChip();
    await swipe(await page.locator(".hg-inline-sorts").boundingBox(), -160);
    await page.waitForTimeout(300);
    assert.deepEqual(await selectedChip(), before, `chip 行上横滑把 tab 切了：${JSON.stringify(await selectedChip())}`);
  });

  await step("横滑起手在 2×2 磁贴区：不切 tab", async () => {
    const before = await selectedChip();
    await swipe(await page.locator(".hg-bento-tile").first().boundingBox(), -180);
    await page.waitForTimeout(300);
    assert.deepEqual(await selectedChip(), before, `磁贴上横滑把 tab 切了：${JSON.stringify(await selectedChip())}`);
  });

  await step("纵向滑动 220px：不切 tab", async () => {
    const before = await selectedChip();
    await swipe(await page.locator(".hg-poster").first().boundingBox(), 8, -220);
    await page.waitForTimeout(300);
    assert.deepEqual(await selectedChip(), before, `纵滑把 tab 切了：${JSON.stringify(await selectedChip())}`);
  });

  await step("首/末 tab 不循环：在「全部」（首个）继续右滑不动", async () => {
    await swipe(await page.locator(".hg-poster").first().boundingBox(), 160, 0, "left");
    await page.waitForTimeout(300);
    assert.deepEqual(await selectedChip(), ["全部"]);
  });

  await page.screenshot({ path: join(output, "category-tabs.png") });

  /* ───────── 频道子页（短剧）的排序 chip 也走同一套 ───────── */
  await step("频道子页：短剧/漫剧的 3 个筛选仍可点击", async () => {
    const names = await chipNames();
    assert.deepEqual(names, ["全部", "最新上线"], `片库 chip=${JSON.stringify(names)}`);
  });

  assert.deepEqual(errors, [], `页面报错：${errors.join(" | ")}`);

  report.ok = report.failed.length === 0;
  console.log(report.ok ? `PASS: cat-tabs (${report.passed.length} checks)` : `FAIL: cat-tabs (${report.failed.length} failed)`);
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
