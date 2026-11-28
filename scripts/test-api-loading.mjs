// Fault injection is local only; real React pages + api.call, mocked Tauri IPC.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "api-loading", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { transport: "local browser fixture; Tauri IPC mocked", passed: [], external: [] };
let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    /* 封面走同源代理 /img?u=…（相对路径），按 host 判同源；
       之前按 origin 比会把这类相对请求也算成「上游流量」。 */
    if (new URL(url).host === new URL(origin).host) return route.continue();
    report.external.push(url); return route.abort();
  });
  const complete = (cmd, key, result) => page.evaluate(args => window.apiLoadingFixture.complete(...args), [cmd, key, result]);
  /* 首页会并发发两条 api_feed（信息流 + 最新上架横滑），所以「第几条」这种写死计数不再成立；
     改成按挂起队列把同一命令全部结掉，行为断言（错误态/空态/无 spinner）一条没动。 */
  const completeAll = async (cmd, key, result) => {
    const n = await page.evaluate(args => window.apiLoadingFixture.pendingCount(...args), [cmd, key]);
    for (let i = 0; i < n; i++) await complete(cmd, key, result);
    return n;
  };
  const calls = () => page.evaluate(() => window.apiLoadingFixture.history);
  const visible = async locator => { await locator.waitFor({ state: "visible" }); };

  await page.goto(`${origin}tests/api-loading.html?page=home`);
  await page.waitForFunction(() => window.apiLoadingFixture.pendingCount("api_feed") >= 1);
  assert((await completeAll("api_feed", "", "404")) >= 1, "home must issue at least one feed request");
  /* 3.0.14 G 节把首屏错误卡改成「说人话」两档标题（Home.tsx:125）：
     能拿到 HTTP 状态码（服务端有回答）→ 「加载失败」；纯网络类失败 → 「当前线路连不上」。
     这里注入的是 HTTP 404（status 有值、networkish=false），所以标题必须是「加载失败」。 */
  await visible(page.getByText("加载失败", { exact: true }));
  await visible(page.getByText(/服务器请求失败（HTTP 404）/));
  assert.equal(await page.locator(".spinner").count(), 0, "Failed home must stop spinning");
  assert(!await page.locator("body").innerText().then(s => s.includes("<html>")), "Hide gateway HTML from UI");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => window.apiLoadingFixture.pendingCount("api_feed") >= 1);
  await completeAll("api_feed", "", "empty");
  await visible(page.getByText("暂无视频", { exact: true }));
  assert.equal(await page.locator(".spinner").count(), 0);
  report.passed.push("Home: 404 ends loading, readable error, explicit retry, empty result");

  await page.goto(`${origin}tests/api-loading.html`);
  await page.waitForFunction(() => window.apiLoadingFixture.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await calls()).length, 0, "Hidden categories must not prefetch");

  /* 分类页重建为 2×2 Bento 磁贴后，激活时只发 1 个 api_feed(size=24) 拉网格首页，不再发 3 个 size=30 统计 chips。
     断言口径不变：隐藏不发请求、失败给可读错误、重试只重发这一次、拿到数据后正常渲染。 */
  await page.evaluate(() => window.apiLoadingFixture.setActive(true));
  await page.waitForFunction(() => window.apiLoadingFixture.pendingCountBySize("api_feed", 24) >= 1);
  await page.evaluate(() => window.apiLoadingFixture.completeBySize("api_feed", 24, "503"));
  await visible(page.getByText(/服务器请求失败（HTTP 503）/));
  assert(!await page.locator("body").innerText().then(text => text.includes("<html>")), "Hide gateway HTML from UI");

  const beforeRetry = (await calls()).filter(row => row.args.size === 24).length;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => window.apiLoadingFixture.pendingCountBySize("api_feed", 24) >= 1);
  assert.equal((await calls()).filter(row => row.args.size === 24).length, beforeRetry + 1, "Retry re-issues only the grid request");
  await page.evaluate(() => window.apiLoadingFixture.completeBySize("api_feed", 24, "item"));
  await page.locator(".hg-poster").first().waitFor();
  assert.equal(await page.locator(".hg-poster").count(), 1, "Retried grid renders the returned card");
  assert.equal(await page.locator(".spinner").count(), 0);

  const beforeRevisit = (await calls()).length;
  await page.evaluate(() => window.apiLoadingFixture.setActive(false));
  await page.evaluate(() => window.apiLoadingFixture.setActive(true));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal((await calls()).length, beforeRevisit, "Revisiting must not reload what is already loaded");
  report.passed.push("Category: no prefetch while hidden, readable error, retry reloads only the grid, items render, revisit keeps data");

  assert.deepEqual(errors, [], "No page errors");
  /* 「No upstream traffic」的本意是「没有打到外面去」：dev server 可能以 localhost 或
     127.0.0.1 两种写法出现，封面又走同源代理 /img?u=…，所以按 hostname 放行回环地址，
     其余（fixture.invalid 之类）仍然必须为空。 */
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const upstream = report.external.filter(url => { try { return !loopback.has(new URL(url).hostname); } catch { return true; } });
  assert.deepEqual(upstream, [], "No upstream traffic");
  await page.screenshot({ path: join(output, "final.png"), fullPage: true });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}
