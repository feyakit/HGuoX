/* 3.0.21 B：榜单切 tab 回顶部 —— 对照取证。
 *
 * 用法：node scripts/test-rank-tab-scroll.mjs
 * 判据：切 tab 后 scrollTop=0（以前保留上一个榜的位置）；重新挂载（=从详情返回）不重置。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "rank-tab-scroll", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { passed: [], order: {} };
let vite, browser, page;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 480, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).host === new URL(origin).host) return route.continue();
    return route.abort();
  });

  const scrollTo = (top) => page.evaluate((value) => window.rankScrollFixture.scrollTo(value), top);
  const scrollNow = () => page.evaluate(() => window.rankScrollFixture.scroller());
  /* 必须用 JS 直接 click：Playwright 的 locator.click() 会先把目标滚进视口
     （scrollIntoView），滚动位会被它自己清零 —— 那样测的就不是被测代码了。 */
  const tapTab = (label) => page.evaluate((text) => {
    const button = Array.from(document.querySelectorAll("button")).find((node) => (node.textContent || "").trim() === text);
    if (!button) throw new Error(`找不到 tab：${text}`);
    button.click();
  }, label);

  await page.goto(`${origin}tests/rank-tab-scroll.html`);
  await page.waitForFunction(() => window.rankScrollFixture.requested.length >= 1);
  await page.getByText("热播榜").first().waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll(".hg-rank-row-v2").length >= 5);

  /* 1) 滚到中间，切到「推荐榜」 */
  assert.equal(await scrollTo(240), 240, "容器要真的能滚起来（否则这条用例没意义）");
  await tapTab("推荐榜");
  await page.waitForFunction(() => window.rankScrollFixture.requested.includes("recommend"));
  await page.waitForTimeout(60);
  const afterSwitch = await scrollNow();
  report.order.afterSwitch = afterSwitch;
  assert.equal(afterSwitch, 0, `切 tab 后应回到顶部，实际 scrollTop=${afterSwitch}`);
  report.passed.push("切「推荐榜」：scrollTop 240 → 0");

  /* 2) 再滚下去，切「潜力榜」 */
  await scrollTo(300);
  await tapTab("潜力榜");
  await page.waitForTimeout(80);
  const afterSecond = await scrollNow();
  report.order.afterSecond = afterSecond;
  assert.equal(afterSecond, 0, `第二次切 tab 后也应回到顶部，实际 scrollTop=${afterSecond}`);
  report.passed.push("切「潜力榜」：scrollTop 300 → 0");

  /* 3) 手势切榜走的是同一个 setTab → 同一个 effect（不重复取证，见报告 B 节说明） */

  /* 4) 重新挂载（= 从详情页返回，页面栈会把位子还回来）：不许重置 */
  const before = await scrollTo(260);
  assert.equal(before, 260);
  await page.evaluate(() => window.rankScrollFixture.remount());
  await page.waitForFunction(() => document.querySelectorAll(".hg-rank-row-v2").length >= 5);
  await page.waitForTimeout(80);
  const afterRemount = await scrollNow();
  report.order.afterRemount = afterRemount;
  assert.equal(afterRemount, 260, `重新挂载不许把滚动位清零（从详情返回会丢位），实际 ${afterRemount}`);
  report.passed.push("重新挂载（从详情返回）：scrollTop 260 保持不变");

  assert.equal(errors.length, 0, `页面报错：${errors.join(" | ")}`);
  await page.screenshot({ path: join(output, "rank-tab-scroll.png") });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n✓ 榜单切 tab 回顶部（B）通过，取证目录 ${output}`);
} finally {
  await browser?.close();
  await vite?.close();
}
