/* 3.0.21 E：评论总数回传（onTotalChange）验收。
 *
 * 用法：node scripts/test-comments-total.mjs
 * 改前：onTotalChange 全仓没有调用方 = 死代码，画面上的评论数永远是打开前的旧值。
 * 改后：面板加载完回传 pagination.total，父组件覆盖旧值；顺带核对四个调用点都接上了。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "comments-total", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { passed: [], values: {} };
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

  await page.goto(`${origin}tests/comments-total.html`);
  await page.waitForFunction(() => window.commentsTotalFixture?.totals?.length > 0);
  await page.waitForFunction(() => (document.querySelector("#badge")?.textContent || "").includes("37"));

  const first = await page.evaluate(() => ({
    badge: document.querySelector("#badge")?.textContent,
    header: document.querySelector("[aria-busy]")?.closest("div")?.textContent?.slice(0, 24),
    totals: window.commentsTotalFixture.totals.slice(),
  }));
  report.values.first = first;
  assert.deepEqual(first.totals, [37], "面板必须回传服务端给的 37（不是打开前的旧值 3）");
  assert.match(first.badge || "", /评论 37 条/, `父组件角标要跟着变成 37，实际「${first.badge}」`);
  report.passed.push("面板回传 37 → 播放页角标从旧值 3 变成 37（onTotalChange 不再是死代码）");

  /* 0 条评论也是真结果：不能被 `?? ` 或 falsy 判断吞回旧值 */
  await page.evaluate(() => { window.commentsTotalFixture.totalOverride = 0; });
  await page.evaluate(() => window.commentsRemount());
  await page.waitForFunction(() => window.commentsTotalFixture.totals.slice(-1)[0] === 0, undefined, { timeout: 3000 });
  await page.waitForFunction(() => (document.querySelector("#badge")?.textContent || "").includes("评论 0 条"), undefined, { timeout: 3000 });
  report.values.zero = await page.evaluate(() => document.querySelector("#badge")?.textContent);
  report.passed.push("0 条评论：回传 0 也认（角标显示「评论 0 条」，不回落旧值）");

  /* 四个调用点都传了 onTotalChange（静态核对调用面，避免只接了一半） */
  const sites = [
    ["src/features/playback/EpisodePlayer.tsx", 2],
    ["src/features/posts/Posts.tsx", 2],
  ];
  for (const [file, expected] of sites) {
    const text = await readFile(join(root, file), "utf8");
    const passed = (text.match(/onTotalChange=/g) || []).length;
    assert.equal(passed, expected, `${file} 应有 ${expected} 处 onTotalChange，实际 ${passed}`);
  }
  const player = await readFile(join(root, "src/features/playback/EpisodePlayer.tsx"), "utf8");
  assert.match(player, /const commentCount = commentLive \?\? meta\.comment/, "播放页必须用回传值覆盖 meta.comment");
  const posts = await readFile(join(root, "src/features/posts/Posts.tsx"), "utf8");
  assert.match(posts, /commentTotals\[p\.id\] \?\? info\?\.comment/, "吃瓜列表卡片的评论数要用回传值");
  report.passed.push("EpisodePlayer ×2 + Posts ×2 的 onTotalChange 都接上了，且渲染读的是回传值");

  assert.equal(errors.length, 0, `页面报错：${errors.join(" | ")}`);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n✓ 评论总数回传（E）通过，取证目录 ${output}`);
} finally {
  await browser?.close();
  await vite?.close();
}
