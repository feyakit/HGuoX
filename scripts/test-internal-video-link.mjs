// 正文里的站内短剧链接在 App 内打开（上游 6cff406 / #229）。
//
// 真 ArticlePanel + 真 sanitizeHtml + 真 store；判据是「点链接之后 store 里多了一页 feed」
// 以及「外链仍然交给系统浏览器」。基线分支上没有 parseInternalVideoId，这类链接一律走外链，
// 所以这条在基线上必红。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "internal-video-link");
await mkdir(output, { recursive: true });
const report = { passed: [], failed: [], shots: [], data: {} };
const step = async (n, fn) => {
  try { await fn(); report.passed.push(n); console.log("  ok   " + n); }
  catch (e) { report.failed.push(`${n}: ${e.message}`); console.log("  FAIL " + n + ": " + e.message); }
};

const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 11; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const tapLink = async (text) => {
  const box = await page.evaluate((label) => {
    const a = Array.from(document.querySelectorAll(".article-body a")).find((n) => (n.textContent || "").includes(label));
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  assert.ok(box, `找不到链接：${text}`);
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(300);
};
const stack = () => page.evaluate(() => window.__stack());
const opened = () => page.evaluate(() => window.linkFixture.opened.slice());

try {
  await page.goto(`${origin}tests/internal-link.html`, { waitUntil: "networkidle" });
  await page.waitForSelector(".article-body a");

  await step("正文里的站内链接被保留（清洗后仍是 <a href=/video/123/>）", async () => {
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll(".article-body a")).map((a) => a.getAttribute("href")));
    assert.ok(hrefs.some((h) => h && h.includes("/video/123/")), JSON.stringify(hrefs));
  });

  await tapLink("这部剧");
  const afterInternal = await stack();
  const openedInternal = await opened();
  report.data.internal = { stack: afterInternal, opened: openedInternal };
  await page.screenshot({ path: join(output, "click-internal-link.png") });
  report.shots.push(join(output, "click-internal-link.png"));
  await step("点 `/video/123/` → 压入一页 feed，videoIds=[123]", async () => {
    assert.equal(afterInternal.length, 1, `stack=${JSON.stringify(afterInternal)}`);
    assert.equal(afterInternal[0].kind, "feed");
    assert.deepEqual(afterInternal[0].videoIds, [123]);
  });
  await step("点站内链接不再甩给系统浏览器", async () => {
    assert.equal(openedInternal.filter((u) => u.includes("/video/123/")).length, 0, `openUrl=${JSON.stringify(openedInternal)}`);
  });

  await tapLink("外链");
  const afterExternal = await stack();
  const openedExternal = await opened();
  report.data.external = { stack: afterExternal, opened: openedExternal };
  await step("点外链仍走系统浏览器、不压页", async () => {
    assert.equal(afterExternal.length, 1, `stack 被改了：${JSON.stringify(afterExternal)}`);
    assert.ok(openedExternal.some((u) => u.includes("example.com")), `openUrl=${JSON.stringify(openedExternal)}`);
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
