/* 取证脚本（一次性）：把「同一 URL 的两遍分别是谁发的」连调用栈一起打出来。
 * 用法：node scripts/capture-firstscreen-dup.mjs > /tmp/dup.json
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA =
  "Mozilla/5.0 (Linux; Android 11; MI 9 Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36";

const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 412, height: 900 }, userAgent: UA, hasTouch: true });
await page.route("**/*", (route) => (new URL(route.request().url()).host === new URL(origin).host ? route.continue() : route.abort()));
await page.goto(`${origin}tests/firstscreen-dup.html`);
await page.waitForFunction(() => window.dupFixture?.ready);
if (process.argv.includes("--switch-line")) await page.evaluate(() => window.dupFixture.switchLine(700));
if (process.argv.includes("--focus")) await page.evaluate(() => window.dupFixture.focusApp(300));
await page.waitForTimeout(4200);
const out = await page.evaluate(() => {
  const f = window.dupFixture;
  const counts = f.counts();
  return {
    counts: {
      perCmd: counts.perCmd,
      totalHttp: counts.totalHttp,
      distinctHttp: counts.distinctHttp,
      firstContent: counts.firstContent,
    },
    mounts: f.mounts,
    feed: f.feedStacks(),
    homeDetails: f.homeDetailsCalls(),
    dupStacks: f.dupStacks("/api/videos/13781"),
    detailPaths: Object.entries(counts.perPath).filter(([p]) => p.startsWith("/api/videos/")),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await vite.close();
