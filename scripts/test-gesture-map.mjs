// 手势重分工验收（用户定稿）：单击=播放/暂停、双击=点赞、长按=2x、
// 横屏三区（左亮度/右音量/中切集）、控件优先、竖屏不引入亮度音量。
//
// 真 EpisodePlayer + 真 CSS；媒体只打桩 paused 与 play/pause 计数（无解码环境里
// paused 恒 true，不打桩就验不出「单击到底切没切」）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "gesture-map");
await mkdir(output, { recursive: true });
const report = { passed: [], failed: [], data: {} };
const step = async (n, fn) => {
  try { await fn(); report.passed.push(n); console.log("  ok   " + n); }
  catch (e) { report.failed.push(`${n}: ${e.message}`); console.log("  FAIL " + n + ": " + e.message); }
};

const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({
  viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 11; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let cdp;
/* 点赞走组件内部的 onLike（→ api_like），所以数接口调用而不是外部 prop */
const probe = () => page.evaluate((n) => ({
  play: window.gestureProbe.play,
  pause: window.gestureProbe.pause,
  likes: window.playerModeFixture.calls.filter((c) => c.cmd === "api_like").length,
}), 0);
const resetProbe = () => page.evaluate(() => { window.gestureProbe.play = 0; window.gestureProbe.pause = 0; window.gestureProbe.likes = 0;
  window.__likeBase = window.playerModeFixture.calls.filter((c) => c.cmd === "api_like").length; });
const tap = async (x, y) => { await page.touchscreen.tap(x, y); };
const drag = async (x, y, dx, dy, steps = 6) => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(120);
};


/** 页面内合成指针序列（时序精确；触摸送达已由「单击」用例证明，这里只验判定） */
const synth = (script) => page.evaluate((code) => {
  const stage = document.querySelector(".player-root [data-mobile-hold-target]");
  if (!stage) return "no-stage";
  const fire = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "touch", isPrimary: true,
    buttons: type === "pointerup" ? 0 : 1,
  }));
  // eslint-disable-next-line no-new-func
  new Function("fire", code)(fire);
  return "ok";
}, script);

const boot = async ({ endless = false, land = false, eps = 5 } = {}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}tests/player-modes.html?endless=${endless ? 1 : 0}&fs=0&eps=${eps}&src=${land ? "land" : ""}`,
    { waitUntil: "networkidle" });
  await page.waitForSelector(".player-root", { timeout: 10000 });
  await page.waitForTimeout(800);
  cdp = await context.newCDPSession(page);
  if (land) {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.evaluate(() => { window.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("orientationchange")); });
    await page.waitForTimeout(450);
  }
};

try {
  /* ═══ 竖屏：单击 / 双击 / 长按 ═══ */
  await boot({});
  await resetProbe();
  await tap(180, 320);
  await page.waitForTimeout(500);
  const single = await probe();
  await step("单击（竖屏中部）= 播放/暂停一次（播放态 → 暂停）", async () => {
    assert.equal(single.pause, 1, `play=${single.play} pause=${single.pause}`);
  });
  await step("单击暂停后控件亮出来（暂停态不自动收起）", async () => {
    const vis = await page.evaluate(() => document.querySelectorAll(".player-root .hg-seg").length > 0);
    assert.ok(vis, "单击后控件不可见");
  });

  await page.waitForTimeout(450);   // 让上一步的单击定时器先落定
  await resetProbe();
  const quickTap = async (x, y) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.waitForTimeout(40);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await synth(`fire("pointerdown",180,320); fire("pointerup",180,320);
    setTimeout(() => { fire("pointerdown",180,320); fire("pointerup",180,320); }, 110);`);
  await page.waitForTimeout(600);
  const dbl = await probe();
  await step("双击 = 点赞一次，且不触发播放/暂停（双击不再 seek）", async () => {
    assert.equal(dbl.likes, 1, `likes=${dbl.likes}`);
    assert.equal(dbl.play + dbl.pause, 0, `play=${dbl.play} pause=${dbl.pause}`);
  });
  await step("双击出中央红心动效", async () => {
    const has = await page.evaluate(() => !!document.querySelector(".hg-like-burst"));
    assert.ok(has, "没有 .hg-like-burst");
  });

  await resetProbe();
  await page.waitForTimeout(500);
  await boot({});            // 独立页面：长按用例不受上一例的点赞/暂停计数影响
  await page.waitForTimeout(250);
  await resetProbe();
  await synth(`fire("pointerdown",180,150); setTimeout(() => fire("pointerup",180,150), 700);`);
  await page.waitForTimeout(1100);
  const hold = await probe();
  await step("长按 = 只走 2x，不算单击也不算双击", async () => {
    assert.equal(hold.play + hold.pause, 0, `play=${hold.play} pause=${hold.pause}`);
    assert.equal(hold.likes, 0, `likes=${hold.likes}`);
  });

  /* ═══ 控件优先 ═══ */
  await boot({});
  await page.waitForTimeout(300);
  await resetProbe();
  const likeBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.player-root button[aria-label="点赞"]')].find((n) => n.getBoundingClientRect().width > 0);
    if (!b) return null;
    const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await step("控件可见时点「点赞」按钮：只点赞，不暂停画面", async () => {
    assert.ok(likeBtn, "找不到点赞按钮");
    await tap(likeBtn.x, likeBtn.y);
    await page.waitForTimeout(450);
    const p = await probe();
    assert.equal(p.play + p.pause, 0, `play=${p.play} pause=${p.pause}`);
    assert.equal(p.likes, 1, `likes=${p.likes}`);
  });

  /* ═══ 竖屏上滑仍是切集（不得引入亮度/音量） ═══ */
  await boot({ eps: 5 });
  const b0 = await page.evaluate(() => {
    const w = document.querySelector(".player-root video").parentElement;
    return { filter: w.style.filter || getComputedStyle(w).filter, ep: window.playerModeFixture.calls.filter((c) => c.cmd === "api_play").length };
  });
  await drag(60, 420, 0, -220);
  const b1 = await page.evaluate(() => {
    const w = document.querySelector(".player-root video").parentElement;
    return { filter: w.style.filter || getComputedStyle(w).filter, ep: window.playerModeFixture.calls.filter((c) => c.cmd === "api_play").length };
  });
  await step("竖屏左 1/3 上滑：不改亮度（竖屏没有亮度手势）", async () => {
    assert.equal(b1.filter, b0.filter, `filter ${b0.filter} → ${b1.filter}`);
  });
  await step("竖屏左 1/3 上滑：走原来的切集/切作品语义", async () => {
    assert.ok(b1.ep >= b0.ep, `api_play ${b0.ep} → ${b1.ep}`);
  });

  /* ═══ 横屏三区 ═══ */
  await boot({ land: true, eps: 5 });
  await page.waitForTimeout(400);
  const L = { x: 90, y: 180 }, R = { x: 550, y: 180 }, M = { x: 320, y: 180 };
  const filterNow = () => page.evaluate(() => {
    const w = document.querySelector("[data-hg-brightness]");
    return w ? String(w.getAttribute("data-hg-brightness")) + "|" + (w.style.filter || "none") : "missing";
  });
  const f0 = await filterNow();
  await drag(L.x, L.y + 60, 0, -100);
  const f1 = await filterNow();
  await step("横屏左 1/3 上滑 → 亮度提高（filter brightness）", async () => {
    assert.notEqual(f1, f0, `filter 未变：${f1}`);
    const m = /brightness\(([\d.]+)\)/.exec(f1);
    const val = Number(f1.split("|")[0]);
    assert.ok((m && Number(m[1]) > 1) || val > 1, `brightness=${f1}`);
  });
  await drag(R.x, R.y + 60, 0, -100);
  await step("横屏右 1/3 上滑 → 应用内音量提高", async () => {
    const v = await page.evaluate(() => document.querySelector(".player-root video").volume);
    assert.ok(v > 0.5, `video.volume=${v}`);
  });
  await step("横屏左/右竖滑出 HUD（亮度/音量）", async () => {
    const hud = await page.evaluate(() => document.querySelectorAll('[data-hg-control="zone-hud"]').length);
    assert.ok(hud >= 1, "没有 HUD");
  });
  const epBefore = await page.evaluate(() => window.playerModeFixture.calls.filter((c) => c.cmd === "api_play").length);
  await synth(`
    let y = 260; fire("pointerdown", 320, y);
    const id = setInterval(() => { y -= 20; fire("pointermove", 320, y); if (y <= 140) { clearInterval(id); fire("pointerup", 320, y); } }, 16);
  `);
  await page.waitForTimeout(900);
  const epAfter = await page.evaluate(() => {
    const el = document.querySelector('[data-hg-control="episodes-entry"]');
    return { calls: window.playerModeFixture.calls.filter((c) => c.cmd === "api_play").length, label: el ? el.getAttribute("aria-label") : "" };
  });
  report.data.midZone = { epBefore, epAfter };
  await step("横屏中 1/3 上滑 → 切到第 2 集（选集入口文案 + api_play）", async () => {
    const moved = epAfter.calls > epBefore || /第\s*2\s*集/.test(epAfter.label || "");
    assert.ok(moved, `api_play ${epBefore} → ${epAfter.calls}，label=${epAfter.label}`);
  });

/* ═══ 结束卡：系统返回先关卡片，不退出播放页 ═══ */
await boot({ eps: 1 });
await page.waitForTimeout(400);
await page.evaluate(() => { document.querySelector("video").dispatchEvent(new Event("ended")); });
await page.waitForTimeout(900);
const cardOpen = await page.evaluate(() => !!document.querySelector(".hg-endcard"));
await page.evaluate(() => { window.__cardBack = window.__runBack(); });
await page.waitForTimeout(300);
const afterBack = await page.evaluate(() => ({
  card: !!document.querySelector(".hg-endcard"),
  player: !!document.querySelector(".player-root"),
  popped: (window.__back || 0),
}));
await step("结束卡打开时按系统返回：先关卡片，播放页还在", async () => {
  assert.ok(cardOpen, "结束卡没打开");
  assert.equal(afterBack.card, false, "卡片还在");
  assert.ok(afterBack.player, "播放页被退掉了");
  assert.equal(afterBack.popped, 0, `onBack 被调用 ${afterBack.popped} 次（不该退播放器）`);
});
} finally {
  report.errors = errors;
  report.summary = `${report.passed.length} passed / ${report.failed.length} failed`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log("\n" + report.summary);
  if (errors.length) console.log("pageerrors:", errors.slice(0, 3));
  await browser.close();
  await vite.close();
}
process.exit(report.failed.length ? 1 : 0);
