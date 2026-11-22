// 结束态卡片「关不掉」的验收（用户报：本剧看完弹窗没法关闭）。
//
// 真 EndCard + 真 index.css（vite 直接编 tsx/css），只 mock Tauri IPC。
// 断言：
//   1) 卡片右上角有可点中的 ×（视觉 32×32，热区 44×44），elementFromPoint 命中按钮本身；
//   2) 点 ×            → onClose 触发；
//   3) 点卡片外空白    → onClose 触发；
//   4) 点卡片内标题    → 不触发（按钮区不被遮罩抢走）；
//   5) 上滑 60px / 下滑 60px → onClose 触发；
//   6) 横向拖 60px 不关（不误伤左右滑）；
//   7) 卡片里既有元素的 bbox 与 v3.0.10 基线一致（另跑一支基线脚本对账，见 report）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.env.SHOT_TAG || "after";
const output = join(root, "test-results", "end-card-close", tag);
await mkdir(output, { recursive: true });
const report = { tag, passed: [], failed: [], geometry: {}, shots: [] };

let vite, browser, context, page;
const closed = () => page.evaluate(() => window.endClosed || 0);
const reset = () => page.evaluate(() => { window.endClosed = 0; });

const step = async (name, fn) => {
  try { await fn(); report.passed.push(name); console.log(`  ok   ${name}`); }
  catch (e) { report.failed.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); }
};

const center = async (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left };
}, sel);

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 11; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
  });
  await context.addInitScript(() => { localStorage.setItem("hguox_app_v1", JSON.stringify({ favs: [], history: [], postHistory: [] })); });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${origin}tests/end-pool.html`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hg-endcard");
  await page.waitForFunction(() => !document.querySelector(".hg-endcard .spinner"), null, { timeout: 8000 });

  const card = await center(".hg-endcard");
  const xBtn = await center(".hg-endcard-x");
  const main = await center(".hg-endcard-main");
  const body = await center(".hg-endcard p:nth-of-type(2)");
  report.geometry = { card, xBtn, main, titleBlock: body, viewport: { w: 360, h: 640 } };

  await page.screenshot({ path: join(output, "endcard.png") });
  report.shots.push(join(output, "endcard.png"));

  await step("× 存在且视觉 32×32", async () => {
    assert.ok(xBtn, "没有 .hg-endcard-x（右上关闭按钮缺失）");
    assert.ok(Math.round(xBtn.w) === 32 && Math.round(xBtn.h) === 32, `× 视觉 ${xBtn.w}×${xBtn.h}`);
  });

  await step("× 热区 44×44：中心与 +20px 处都命中按钮本身", async () => {
    const hits = await page.evaluate(() => {
      const b = document.querySelector(".hg-endcard-x");
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const probe = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return { hit: !!el && (el === b || b.contains(el)), tag: el ? el.tagName + "." + (el.className || "") : "null" };
      };
      return { c: probe(cx, cy), right: probe(cx + 20, cy), up: probe(cx, cy - 20), out: probe(cx + 30, cy) };
    });
    assert.ok(hits.c.hit, `中心没命中 ×：${hits.c.tag}`);
    assert.ok(hits.right.hit && hits.up.hit, `热区不足 44px：右 ${hits.right.tag} / 上 ${hits.up.tag}`);
  });

  await step("点 × → 关闭", async () => {
    await reset();
    await page.touchscreen.tap(xBtn.x, xBtn.y);
    await page.waitForTimeout(150);
    assert.equal(await closed(), 1, `onClose ${await closed()} 次`);
  });

  await step("点卡片外空白 → 关闭", async () => {
    await reset();
    await page.touchscreen.tap(180, 60);           // 卡片上方的遮罩空白区
    await page.waitForTimeout(150);
    assert.equal(await closed(), 1, `onClose ${await closed()} 次`);
  });

  await step("点卡片内标题 → 不关闭（遮罩不抢按钮）", async () => {
    await reset();
    await page.touchscreen.tap(body.x, body.y);
    await page.waitForTimeout(150);
    assert.equal(await closed(), 0, `误触发 onClose ${await closed()} 次`);
  });

  await step("上滑 60px → 关闭", async () => {
    await reset();
    await page.touchscreen.tap(card.x, card.y - 40);
    const cdp = await context.newCDPSession(page);
    const cx = card.x, cy = card.y;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    for (const dy of [-15, -30, -45, -60]) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: cy + dy }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(180);
    assert.equal(await closed(), 1, `onClose ${await closed()} 次`);
  });

  await step("下滑 60px → 关闭", async () => {
    await reset();
    const cdp = await context.newCDPSession(page);
    const cx = card.x, cy = card.y;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    for (const dy of [15, 30, 45, 60]) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: cy + dy }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(180);
    assert.equal(await closed(), 1, `onClose ${await closed()} 次`);
  });

  await step("横向拖 60px → 不关闭", async () => {
    await reset();
    const cdp = await context.newCDPSession(page);
    const cx = card.x, cy = card.y;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    for (const dx of [15, 30, 45, 60]) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + dx, y: cy }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(180);
    assert.equal(await closed(), 0, `横向拖误触发 ${await closed()} 次`);
  });

  report.pageErrors = errors;
  if (errors.length) report.failed.push(`pageerror: ${errors.join(" | ")}`);
} finally {
  report.summary = `${report.passed.length} passed / ${report.failed.length} failed`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n[${tag}] ${report.summary}`);
  if (report.failed.length) for (const f of report.failed) console.log("  ! " + f);
  await browser?.close();
  await vite?.close();
}
process.exit(report.failed.length ? 1 : 0);
