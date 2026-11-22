import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

// 审计 #14 / #15 回归（真 FavoritesPage + 真 useAutoLoadMore，只 mock Tauri IPC）。
//   契约 A：resetKey 变化（条数/hasMore 都不变）必须让自动加批重新触发 —— 依赖里漏了 resetKey 时这里红。
//   契约 B：收藏卡「新更 N 集」徽标，点开就要消失（基线抬到最新），包括 progress.ep === 旧基线的情形。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "audit-list-cache", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Real FavoritesPage + real useAutoLoadMore in Chromium; mocked Tauri IPC; not native verification", passed: [], external: [] };
const NOW = Date.now();
/* 收藏 7：已看到第 20 集，收藏时的基线也是 20（徽标正是在「相等」时卡住不消失），详情共 24 集。 */
const guest = {
  favs: [7],
  history: [{ id: 7, ep: 20, t: 0, dur: 0, at: NOW }],
  favEpCounts: { 7: 20 },
  likes: [], follows: [], postLikes: [], postFavs: [], postHistory: [], localHistory: [],
};
let vite, browser, page;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(data => {
    localStorage.setItem("hguox_app_v1", JSON.stringify(data));
  }, guest);
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    report.external.push(route.request().url());
    return route.abort();
  });
  await page.goto(`${origin}tests/audit-list-cache.html`);
  await page.getByText("收藏卡 7", { exact: true }).waitFor();
  const autoCalls = () => page.evaluate(() => window.autoLoadCalls.slice());

  // ---- 契约 A：换列表（resetKey 变、条数不变）→ 必须重新允许加批 ----
  await page.waitForFunction(() => window.autoLoadCalls.length >= 1);
  assert.deepEqual(await autoCalls(), ["video:12"], "首屏应触发一次加批");
  report.passed.push("autoload-fires-for-first-page");
  await page.evaluate(() => window.autoLoadSetCount(12)); // 同值，确保条数不变
  await page.evaluate(() => window.autoLoadSetResetKey("post"));
  await page.waitForFunction(() => window.autoLoadCalls.length >= 2, null, { timeout: 5000 });
  assert.deepEqual(await autoCalls(), ["video:12", "post:12"], "换列表后同一批条数必须能再加一批");
  report.passed.push("autoload-resets-on-resetKey-change");
  // ---- 契约 A2：条数增长照旧能再触发（确认没有被新依赖弄坏） ----
  await page.evaluate(() => window.autoLoadSetCount(24));
  await page.waitForFunction(() => window.autoLoadCalls.length >= 3, null, { timeout: 5000 });
  assert.deepEqual(await autoCalls(), ["video:12", "post:12", "post:24"], "条数增长后应再触发一次");
  report.passed.push("autoload-still-fires-on-count-growth");

  // ---- 契约 B：新更徽标点开即消失 ----
  const badge = page.locator(".ios-media-grid").getByText("新更 4 集").first();
  await badge.waitFor();
  report.passed.push("badge-shows-when-ep-equals-baseline");
  await page.getByText("收藏卡 7", { exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("新更"), null, { timeout: 5000 });
  assert.equal(await page.locator(".ios-media-grid").getByText("新更 4 集").count(), 0, "点开后徽标必须消失");
  assert.match(await page.locator(".ios-media-grid").innerText(), /24 集/, "徽标应回到普通集数");
  report.passed.push("badge-clears-after-open");

  assert.deepEqual(errors, [], `页面不得有运行时错误：${errors.join(" | ")}`);
  report.passed.push("no-page-errors");
} catch (error) {
  report.failure = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  report.externalForbidden = report.external;
} finally {
  if (page) await page.screenshot({ path: join(output, "audit-list-cache.png") }).catch(() => {});
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  if (report.failure) {
    console.error(`FAILED\n${report.failure}`);
    console.error(`passed=${report.passed.join(",")}`);
    process.exitCode = 1;
  } else {
    console.log(`OK ${report.passed.length} checks → ${output}`);
    for (const name of report.passed) console.log(`  ✓ ${name}`);
  }
}
