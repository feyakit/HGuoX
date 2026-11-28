/* 3.0.21 D：作者主页排序 / 连载筛选对分页新页同样生效（两页数据取证）。
 *
 * 用法：node scripts/test-author-sort.mjs
 * 环境：真实 React 页面（UserPage）+ 真实 api 封装，只有 Tauri IPC 是假的。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "author-sort", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { passed: [], notes: [], order: {} };
let vite, browser, page;

/* 期望顺序（热度降序，跨两页重排）：
   A100 E90 C80 F70 H60 B30 D10 G5 —— 第 2 页的 E/F/H 必须插进第 1 页中间。 */
const BY_HOT_DESC = ["A", "E", "C", "F", "H", "B", "D", "G"];
/* 只看已完结（is_finished=1）：A C F H */
const FINISHED = ["A", "C", "F", "H"];

const order = () => page.evaluate(() => window.authorSortFixture.order());

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 480, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).host === new URL(origin).host) return route.continue();
    return route.abort();
  });

  /* 第 2 页的响应在 fixture 里被扣住：可以在「只加载了第 1 页」的时候切排序 */
  await page.goto(`${origin}tests/author-sort.html`);
  await page.waitForFunction(() => window.authorSortFixture?.requested?.includes(2), undefined, { timeout: 8000 });
  await page.locator("[data-ui='media-grid']").first().waitFor({ timeout: 5000 });
  assert.deepEqual(await order(), ["A", "B", "C", "D"], "第 1 页按服务端顺序上屏");
  report.order.pageOne = await order();
  report.passed.push("第 1 页 4 部上屏；第 2 页的响应被扣住（模拟「先切排序、新页后到」）");

  /* 切到「播放量」：此时只有第 1 页，排序只在 4 部里生效 */
  await page.getByRole("button", { name: /播放量/ }).click();
  await page.waitForFunction(() => JSON.stringify(window.authorSortFixture.order()) === JSON.stringify(["A", "C", "B", "D"]), undefined, { timeout: 3000 });
  report.order.afterSortPageOne = await order();

  /* 放行第 2 页：新页必须插进已有的排序里，而不是接在末尾 */
  await page.evaluate(() => window.authorSortFixture.release());
  await page.waitForFunction(() => window.authorSortFixture.order().length === 8, undefined, { timeout: 5000 });
  const loaded = await order();
  await page.waitForFunction(
    (expected) => JSON.stringify(window.authorSortFixture.order()) === JSON.stringify(expected),
    BY_HOT_DESC,
    { timeout: 3000 },
  ).catch(async () => {
    const actual = await order();
    report.order.afterSort = actual;
    assert.fail(`按播放量排序后顺序应为 ${BY_HOT_DESC.join("")}，实际 ${actual.join("")}`);
  });
  report.order.afterSort = await order();
  assert.notDeepEqual(report.order.afterSort, ["A", "C", "B", "D", "E", "F", "G", "H"], "新页不能只是接在后面");
  report.passed.push(`按播放量排序：两页合并后重排为 ${report.order.afterSort.join("")}（第 2 页的 E/F/H 插进第 1 页中间）`);

  /* 连载状态筛选：第 2 页的已完结作品同样要留下 */
  await page.getByRole("button", { name: "已完结" }).click();
  await page.waitForFunction(
    (expected) => JSON.stringify(window.authorSortFixture.order()) === JSON.stringify(expected),
    FINISHED,
    { timeout: 3000 },
  ).catch(async () => {
    const actual = await order();
    report.order.afterFilter = actual;
    assert.fail(`只看已完结后应剩 ${FINISHED.join("")}，实际 ${actual.join("")}`);
  });
  report.order.afterFilter = await order();
  report.passed.push(`连载筛选：跨两页只剩 ${report.order.afterFilter.join("")}（第 2 页的 F/H 没有被漏掉）`);

  /* 再切回「全部」，顺序回到重排后的全量 */
  await page.getByRole("button", { name: "全部" }).first().click();
  await page.waitForFunction(
    (expected) => JSON.stringify(window.authorSortFixture.order()) === JSON.stringify(expected),
    BY_HOT_DESC,
    { timeout: 3000 },
  );
  report.passed.push("切回「全部」：顺序与重排结果一致（筛选不改变排序）");

  assert.equal(errors.length, 0, `页面报错：${errors.join(" | ")}`);

  await page.screenshot({ path: join(output, "author-sort.png"), fullPage: false });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n✓ 作者页分页重排（D）通过，取证目录 ${output}`);
} finally {
  await browser?.close();
  await vite?.close();
}
