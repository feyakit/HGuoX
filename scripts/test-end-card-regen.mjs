// 结束态「换一批」验收（用户报：看完后换一批一直是一样的）。
//
// 真 EndCard + 真 useEndPool（buildEndPool / takeBatch）+ 真 api.call，只 mock Tauri IPC。
// 上游 related 被造成「同一个 id 恒返回 8 条」——这正是旧实现每次换一批都拿同一批的原因。
// 断言：
//   1) 打开结束态给第 1 批 3 部；
//   2) 连点 4 次「换一批」，每批内容都不同，且全程不再打 related 接口（rotating，不是 refetch）；
//   3) 池子轮到底（related 8 + feed 补齐到 12 ⇒ 第 5 批）回到开头：内容 = 第 1 批，并出现「已看完推荐池」提示；
//   4) related 与 feed 都拿不到内容时，如实显示「暂无更多推荐」，不重复同一批；
//   5) 池子不足 3 部就少显示（另起一页：related 只给 2 条、feed 也空）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "end-card-regen", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = {
  environment: "真实 Chromium 412×915；真 EndCard + 真 useEndPool + 真 api.call，Tauri IPC 被 mock（related 固定 8 条 / feed 多页）",
  passed: [],
  failed: [],
  batches: [],
};

let vite, browser, context, page;

const waitIdle = () => page.waitForFunction(() => !document.querySelector('.hg-endcard .spinner'), null, { timeout: 5000 });
const batch = () => page.evaluate(() => [...document.querySelectorAll(".hg-reccard")].map(b => b.getAttribute("aria-label")));
const hintText = () => page.evaluate(() => {
  const el = document.querySelector('.hg-endcard [role="status"]');
  return el ? (el.textContent || "").trim() : "";
});
const toastText = () => page.evaluate(() => {
  const host = document.querySelector(".ios-toast-host");
  return host ? (host.textContent || "").trim() : "";
});
const emptyText = () => page.evaluate(() => {
  const cards = document.querySelectorAll(".hg-reccard").length;
  if (cards) return "";
  return (document.querySelector(".hg-endcard")?.textContent || "").trim();
});
const clickRegen = async () => {
  await page.getByRole("button", { name: /换一批/ }).click();
  await page.waitForTimeout(120);
  await waitIdle();
};

const step = async (name, fn) => {
  try { await fn(); report.passed.push(name); console.log(`  ok   ${name}`); }
  catch (error) { report.failed.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`); }
};

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  context = await browser.newContext({
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

  /* ───────── 主场景：related 8 条 + feed 补齐到 12 ───────── */
  await page.goto(`${origin}tests/end-pool.html`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hg-endcard");
  await waitIdle();

  const batches = [];
  await step("打开结束态：给第 1 批 3 部（related 前 3 条）", async () => {
    const first = await batch();
    batches.push(first);
    assert.equal(first.length, 3, `第 1 批=${JSON.stringify(first)}`);
    assert.ok(first.every(t => t.includes("关联剧")), `第 1 批=${JSON.stringify(first)}`);
  });

  await step("结束态打开时的池子：related 8 条 + feed 补齐（共 12），feed 只问必要的页", async () => {
    const s = await page.evaluate(() => ({ related: window.endPoolFixture.relatedCalls(), feed: window.endPoolFixture.feedCalls() }));
    report.data = { ...(report.data || {}), build: s };
    assert.equal(s.related, 1, `api_related 调用 ${s.related} 次`);
    assert.ok(s.feed >= 1, "没有用 feed 补池子");
  });

  for (let i = 1; i <= 4; i += 1) {
    await step(`第 ${i} 次「换一批」：内容与之前每一批都不同，且不再打接口`, async () => {
      const before = await page.evaluate(() => window.endPoolFixture.relatedCalls());
      await clickRegen();
      const now = await batch();
      batches.push(now);
      for (const prev of batches.slice(0, -1)) {
        const overlap = now.filter(t => prev.includes(t));
        assert.equal(overlap.length, 0, `第 ${i} 批与前面重复：${JSON.stringify(overlap)}`);
      }
      const after = await page.evaluate(() => window.endPoolFixture.relatedCalls());
      assert.equal(after, before, "「换一批」不该再请求 api_related（上游恒返回同一批）");
      assert.equal(await hintText(), "", `第 ${i} 批不该有池子到底的提示`);
    });
  }

  await step("第 5 次「换一批」：池子到底回到开头，内容 = 第 1 批，卡片内有提示", async () => {
    await clickRegen();
    const now = await batch();
    assert.deepEqual(now, batches[0], `回到开头应是第 1 批：${JSON.stringify(now)} vs ${JSON.stringify(batches[0])}`);
    assert.equal(await hintText(), "推荐已轮完一遍，从头开始");
    report.batches = batches.map((b, i) => ({ batch: i + 1, items: b }));
    report.data = { ...(report.data || {}), wrapped: now };
  });

  await step("回卷时弹一条 toast（单槽 playback-hint），文案说明是第二轮", async () => {
    /* 再转一圈回到池首，这一次量 toast 的出现与消失 */
    for (let i = 0; i < 4; i += 1) await clickRegen();
    await clickRegen();
    const text = await toastText();
    report.data = { ...(report.data || {}), toast: text };
    assert.ok(text.includes("推荐已轮完一遍"), `toast=${JSON.stringify(text)}`);
    assert.ok(text.includes("从头开始"), `toast=${JSON.stringify(text)}`);
  });

  await step("toast 在 2s 内自动消失（不留残影）", async () => {
    const started = Date.now();
    await page.waitForFunction(() => !(document.querySelector(".ios-toast-host")?.textContent || "").includes("推荐已轮完一遍"), null, { timeout: 2600 });
    const ms = Date.now() - started;
    report.data = { ...(report.data || {}), toastGoneMs: ms };
    assert.ok(ms <= 2000, `toast 停留 ${ms}ms，超过 2s`);
  });

  await step("非回卷的「换一批」不弹这条 toast", async () => {
    await clickRegen();
    assert.equal((await toastText()).includes("推荐已轮完一遍"), false, `不该在非回卷时提示：${JSON.stringify(await toastText())}`);
  });

  await page.screenshot({ path: join(output, "end-card-wrapped.png") });
  await page.close();

  /* ───────── 空池：related 与 feed 都拿不到 → 如实空着 ───────── */
  const emptyPage = await context.newPage();
  emptyPage.on("pageerror", e => errors.push(e.message));
  await emptyPage.goto(`${origin}tests/end-pool.html?fail=1`, { waitUntil: "networkidle" });
  await emptyPage.waitForSelector(".hg-endcard");
  await emptyPage.waitForTimeout(300);
  page = emptyPage;

  await step("两路都拿不到内容：显示「暂无更多推荐」，不拿同一批充数", async () => {
    const cards = await page.locator(".hg-reccard").count();
    assert.equal(cards, 0, `空池却有 ${cards} 张推荐卡`);
    const text = await emptyText();
    assert.ok(text.includes("暂无更多推荐"), `空态文案=${text}`);
  });

  await step("空池下点「换一批」仍然空着（不会突然冒出一批）", async () => {
    await clickRegen();
    assert.equal(await page.locator(".hg-reccard").count(), 0);
    assert.ok((await emptyText()).includes("暂无更多推荐"));
  });

  /* ───────── 池子只有 2 部：少显示，不补齐 ───────── */
  const thinPage = await context.newPage();
  thinPage.on("pageerror", e => errors.push(e.message));
  await thinPage.goto(`${origin}tests/end-pool.html?only=2`, { waitUntil: "networkidle" });
  await thinPage.waitForSelector(".hg-endcard");
  await thinPage.waitForTimeout(300);
  page = thinPage;

  await step("池子只有 2 部：就显示 2 部，不补第 3 张、不造假卡", async () => {
    const cards = await page.locator(".hg-reccard").count();
    assert.equal(cards, 2, `显示 ${cards} 张`);
  });

  await step("池子只有 2 部：点一次「换一批」→ 回到开头并提示，之后仍只有 2 部", async () => {
    await clickRegen();
    assert.equal(await page.locator(".hg-reccard").count(), 2);
    assert.equal(await hintText(), "推荐已轮完一遍，从头开始");
  });

  assert.deepEqual(errors, [], `页面报错：${errors.join(" | ")}`);

  report.ok = report.failed.length === 0;
  console.log(report.ok ? `PASS: end-card-regen (${report.passed.length} checks)` : `FAIL: end-card-regen (${report.failed.length} failed)`);
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
