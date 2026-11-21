import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

// 上游 40acd51 回归：海报角标。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "cards-badges", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "真实 Chromium 390×844；真 Masonry / MediaCard / RowCard", passed: [], failed: [] };
let vite, browser;

const step = async (name, fn) => {
  try { await fn(); report.passed.push(name); console.log(`  ok   ${name}`); }
  catch (error) { report.failed.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`); }
};

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(`${origin}tests/cards-badges.html`, { waitUntil: "networkidle" });
  await page.waitForSelector(".ios-media-grid .ios-poster");
  const card = i => page.locator(".ios-media-grid .ios-poster").nth(i);

  await step("满标卡：原创 → 热播 → 新片，顺序固定", async () => {
    const flags = await card(0).locator(".ios-poster-flag").allInnerTexts();
    assert.deepEqual(flags, ["原创", "热播", "新片"], `实际 ${JSON.stringify(flags)}`);
  });

  await step("只热播卡：只有一个「热播」", async () => {
    const flags = await card(1).locator(".ios-poster-flag").allInnerTexts();
    assert.deepEqual(flags, ["热播"], `实际 ${JSON.stringify(flags)}`);
  });

  await step("无真数据卡：一个角标都不出（不造假）", async () => {
    assert.equal(await card(2).locator(".ios-poster-flag").count(), 0);
  });

  await step("超过 72 小时的 new_at 不出「新片」", async () => {
    const flags = await card(1).locator(".ios-poster-flag").allInnerTexts();
    assert.ok(!flags.includes("新片"), `不该有新片：${JSON.stringify(flags)}`);
  });

  await step("老数据只有 created_at 且在两小时内 → 出「新片」", async () => {
    const flags = await card(3).locator(".ios-poster-flag").allInnerTexts();
    assert.deepEqual(flags, ["新片"], `实际 ${JSON.stringify(flags)}`);
  });

  await step("角标几何：右上内角 9px、高 22px；集数药丸仍在左上 9px", async () => {
    const art = await card(0).locator(".ios-poster-art").boundingBox();
    const badges = await card(0).locator(".ios-poster-badges").boundingBox();
    const flag = await card(0).locator(".ios-poster-flag").first().boundingBox();
    const pill = await card(0).locator(".ios-poster-badge").boundingBox();
    assert.ok(art && badges && flag && pill);
    assert.ok(Math.abs((art.x + art.width) - (badges.x + badges.width) - 9) < 1.5, `右边距 ${art.x + art.width - (badges.x + badges.width)}`);
    assert.ok(Math.abs(badges.y - (art.y + 9)) < 1.5, `上边距 ${badges.y - art.y}`);
    assert.ok(Math.abs(flag.height - 22) < 1.5, `角标高 ${flag.height}`);
    assert.ok(Math.abs(pill.x - (art.x + 9)) < 1.5, `集数药丸左边距 ${pill.x - art.x}`);
    assert.ok(Math.abs(pill.y - (art.y + 9)) < 1.5, `集数药丸上边距 ${pill.y - art.y}`);
  });

  await step("角标与集数药丸、底部播放量行三互不重叠", async () => {
    const boxes = await card(0).evaluate(el => {
      const rect = s => { const n = el.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      return { badges: rect(".ios-poster-badges"), pill: rect(".ios-poster-badge"), progress: rect(".ios-poster-progress") };
    });
    const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert.ok(boxes.badges && boxes.pill && boxes.progress);
    assert.ok(!hits(boxes.badges, boxes.pill), "角标压住了集数药丸");
    assert.ok(!hits(boxes.badges, boxes.progress), "角标压住了播放量行");
    assert.ok(!hits(boxes.pill, boxes.progress), "集数药丸压住了播放量行");
  });

  await step("底部播放量一行仍是原样「▶ N 次播放」，集数仍在左上药丸", async () => {
    assert.equal(await card(0).locator(".ios-poster-badge").innerText(), "更新至 12 集");
    const progress = await card(0).locator(".ios-poster-progress").innerText();
    assert.ok(progress.includes("次播放"), `播放量行文本：${progress}`);
    assert.equal(await card(0).locator(".ios-poster-progress .ios-poster-ep").count(), 0);
  });

  await step("收藏页路径未变：badge 仍在左上，且不渲染角标容器", async () => {
    const legacy = page.locator("#legacy-pill .ios-poster");
    assert.equal(await legacy.locator(".ios-poster-flag").count(), 0);
    const art = await legacy.locator(".ios-poster-art").boundingBox();
    const pill = await legacy.locator(".ios-poster-badge").boundingBox();
    assert.ok(art && pill);
    assert.ok(Math.abs(pill.x - (art.x + 9)) < 1.5, `badge 左边距 ${pill.x - art.x}`);
    assert.ok(Math.abs(pill.y - (art.y + 9)) < 1.5, `badge 上边距 ${pill.y - art.y}`);
  });

  await step("RowCard 也带角标", async () => {
    const flags = await page.locator("#row-card .ios-poster-flag").allInnerTexts();
    assert.deepEqual(flags, ["原创", "热播", "新片"], `实际 ${JSON.stringify(flags)}`);
  });

  assert.deepEqual(errors, [], `页面报错：${errors.join(" | ")}`);
  await page.screenshot({ path: join(output, "cards-badges.png"), fullPage: true });
  report.ok = report.failed.length === 0;
  console.log(report.ok ? `PASS: cards-badges (${report.passed.length} checks)` : `FAIL: cards-badges (${report.failed.length} failed)`);
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
