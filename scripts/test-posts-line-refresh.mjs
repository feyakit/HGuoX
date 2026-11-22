// B11 验收：吃瓜列表在「线路事件」后不得重建已渲染节点。
//
// 契约（报告 B11 + 上游 issue #165 的详情页口径）：
//   1) hg:line-changed → lineEpoch 变化：已渲染卡片节点必须存活（contains=true），列表不得闪空；
//   2) 数据仍要静默刷新（同 id 标题从 v1 变 v2）；
//   3) 用户主动换排序 / 分类时的正常重置不能被弄丢（仍清空 + force 重拉）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "posts-line-refresh", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = {
  environment: "真实 Chromium 412×915；真 PostsPage + 真 api.call，Tauri IPC 被 mock；api_blog_posts 延迟 400ms 放大重建窗口",
  passed: [],
  failed: [],
};

let vite, browser, page;

const snapshot = () => page.evaluate(() => ({
  tagged: !!window.__tagged && document.contains(window.__tagged),
  cards: document.querySelectorAll(".hg-tl-card").length,
  minCards: window.__minCards,
  emptySeen: window.__emptySeen,
  first: document.querySelector(".hg-tl-title")?.textContent ?? null,
  scrollTop: document.querySelector(".scroll-y")?.scrollTop ?? 0,
  calls: window.postsLineFixture.calls.map(c => c.cmd),
}));

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
    viewport: { width: 412, height: 915 },
    isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  });
  await context.addInitScript(() => {
    localStorage.setItem("hguox_app_v1", JSON.stringify({ favs: [], history: [], postHistory: [] }));
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${origin}tests/posts-line.html?delay=400`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hg-tl-card");
  await page.waitForTimeout(500);

  await step("进页：列表已渲染且首卡是 v1", async () => {
    const s = await snapshot();
    assert.ok(s.cards > 0, "没有卡片");
    assert.equal(s.first, "帖 5 v1", `首卡=${s.first}`);
  });

  await step("线路事件后 0–5s：打标记的卡片节点一直存活、列表不闪空", async () => {
    await page.evaluate(() => {
      window.__tagged = document.querySelector(".hg-tl-card");
      window.__emptySeen = false;
      window.__minCards = 99;
      window.__poll = setInterval(() => {
        if (!document.querySelector(".hg-tl-card")) window.__emptySeen = true;
        window.__minCards = Math.min(window.__minCards, document.querySelectorAll(".hg-tl-card").length);
      }, 25);
      window.postsLineFixture.bump();
      window.dispatchEvent(new Event("hg:line-changed"));
    });
    for (const wait of [700, 1800, 2500]) {
      await page.waitForTimeout(wait === 700 ? 700 : wait === 1800 ? 1100 : 700);
      const s = await snapshot();
      assert.ok(s.tagged, `+${wait}ms 打标记的卡片被替换了`);
      assert.equal(s.emptySeen, false, `+${wait}ms 列表出现过空帧（整批卸载重建）`);
      assert.ok(s.minCards > 0, `+${wait}ms 卡片数曾掉到 ${s.minCards}`);
    }
    const s = await page.evaluate(() => { clearInterval(window.__poll); return { minCards: window.__minCards, emptySeen: window.__emptySeen }; });
    assert.equal(s.emptySeen, false);
    assert.equal(s.minCards, 5, `最少卡片数=${s.minCards}`);
  });

  await step("数据确实静默刷新（v1 → v2），且真的 force 出网", async () => {
    const s = await snapshot();
    assert.equal(s.first, "帖 5 v2", `首卡=${s.first}`);
    const forced = await page.evaluate(() => window.postsLineFixture.calls.filter(c => c.cmd === "api_blog_posts").length);
    assert.ok(forced >= 2, `api_blog_posts 只发了 ${forced} 次`);
  });

  await step("用户主动换排序仍正常重置（清空 + 重拉最新一批）", async () => {
    await page.evaluate(() => window.postsLineFixture.resetCalls());
    await page.locator('[aria-label="排序方式"] button', { hasText: "最热" }).click();
    await page.waitForTimeout(900);
    const s = await snapshot();
    /* 最热按接口返回顺序（最新按发布时间倒序），fixture 里第一张是「帖 1」 */
    assert.equal(s.first, "帖 1 v2", `最热首卡=${s.first}`);
    assert.ok(s.cards > 0, "换排序后没有卡片");
    assert.ok(s.calls.some(c => c === "api_posts" || c === "api_post_category"), `换排序没重拉：${JSON.stringify(s.calls)}`);
  });

  assert.deepEqual(errors, [], `页面报错：${errors.join(" | ")}`);
  await page.screenshot({ path: join(output, "posts-line.png") });

  report.ok = report.failed.length === 0;
  console.log(report.ok ? `PASS: posts-line-refresh (${report.passed.length} checks)` : `FAIL: posts-line-refresh (${report.failed.length} failed)`);
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
