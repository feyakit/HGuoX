// 「全屏观看」入口 + 横屏返回 的验收（用户定稿口径）。
//
// 用真 EpisodePlayer + 真 CSS；片源用两段真能解码的 VP8 webm（1280×720 / 720×1280），
// 让 videoWidth/Height 真的到达 —— 「横版才显示入口」这条分支不能靠打桩。
// 转屏在 harness 里用「换视口 + 派发 resize/orientationchange」模拟：这正是真机上
// requestOrientation → 系统转屏 → WebView resize 的那一半。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "fs-entry");
await mkdir(output, { recursive: true });
const report = { passed: [], failed: [], shots: [], data: {} };
const step = async (n, fn) => {
  try { await fn(); report.passed.push(n); console.log("  ok   " + n); }
  catch (e) { report.failed.push(`${n}: ${e.message}`); console.log("  FAIL " + n + ": " + e.message); }
};

const ENTRY = '[data-hg-control="fullscreen-entry"]';
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

const boot = async (src) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}tests/player-modes.html?src=${src}&fs=0&eps=5`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player-root");
  await page.waitForTimeout(900);
};
/** 模拟系统转屏：换视口 + 派发 resize/orientationchange（真机上由系统旋转触发） */
const rotate = async (landscape) => {
  await page.setViewportSize(landscape ? { width: 640, height: 360 } : { width: 360, height: 640 });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
  });
  await page.waitForTimeout(450);
};
const orientationCalls = () => page.evaluate(() =>
  window.playerModeFixture.calls.filter((c) => c.cmd === "set_orientation").map((c) => c.args.landscape));

try {
  /* ───── 竖版片源：不该有入口 ───── */
  await boot("port");
  await step("竖版片源（720×1280）：竖屏没有「全屏观看」入口", async () => {
    const n = await page.evaluate((sel) => document.querySelectorAll(sel).length, ENTRY);
    assert.equal(n, 0, `入口数量 ${n}`);
  });
  await page.screenshot({ path: join(output, "portrait-src-no-entry.png") });
  report.shots.push(join(output, "portrait-src-no-entry.png"));

  /* ───── 横版片源：有入口，几何按口径 ───── */
  await boot("land");
  await page.waitForSelector(ENTRY, { timeout: 5000 });
  const geo = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const svg = el.querySelector("svg").getBoundingClientRect();
    const span = el.querySelector("span");
    const cs = getComputedStyle(span);
    const v = document.querySelector("video");
    const vr = v.getBoundingClientRect();
    const vh = v.videoHeight, vw = v.videoWidth;
    const paintedH = Math.min(vr.height, vr.width * (vh / vw));
    const videoBottom = vr.top + (vr.height + paintedH) / 2;
    return {
      rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10),
      gapBelowVideo: Math.round((r.top - videoBottom) * 10) / 10,
      icon: Math.round(svg.width), fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      text: (el.textContent || "").trim(), src: [vw, vh],
    };
  }, ENTRY);
  report.data.entry = geo;
  await page.screenshot({ path: join(output, "landscape-src-entry.png") });
  report.shots.push(join(output, "landscape-src-entry.png"));

  await step("横版片源（1280×720）：竖屏出现入口，行高 44 / 整行可点 / 图标 16 / 文字 13", async () => {
    assert.equal(Math.round(geo.rect[3]), 44, `行高 ${geo.rect[3]}`);
    assert.equal(Math.round(geo.rect[0]), 0, `左缘 ${geo.rect[0]}`);
    assert.equal(Math.round(geo.rect[2]), 360, `行宽 ${geo.rect[2]}`);
    assert.equal(geo.icon, 16, `图标 ${geo.icon}`);
    assert.equal(geo.fontSize, "13px", `字号 ${geo.fontSize}`);
    assert.equal(geo.text, "全屏观看", `文案 ${geo.text}`);
    assert.deepEqual(geo.src, [1280, 720], `片源 ${geo.src}`);
  });
  await step("入口距视频画面底边 8px（contain 后的真实画面底边）", async () => {
    assert.ok(Math.abs(geo.gapBelowVideo - 8) <= 1, `实际 ${geo.gapBelowVideo}px`);
  });

  /* ───── 点击 → 请求横屏；系统转过来后进全屏 ───── */
  const r = await page.evaluate((sel) => {
    const b = document.querySelector(sel); const x = b.getBoundingClientRect();
    return { x: x.x + x.width / 2, y: x.y + x.height / 2 };
  }, ENTRY);
  await page.touchscreen.tap(r.x, r.y);
  await page.waitForTimeout(250);
  await step("点入口 → 下发 set_orientation(landscape=true)", async () => {
    const calls = await orientationCalls();
    assert.ok(calls.includes(true), `set_orientation 调用=${JSON.stringify(calls)}`);
  });

  await rotate(true);
  const afterFs = await page.evaluate((sel) => ({
    immersive: !!document.querySelector(".player-root.fs-immersive"),
    entry: document.querySelectorAll(sel).length,
    back: !!document.querySelector('.player-root [aria-label="返回"]'),
    exitBtn: document.querySelectorAll('.player-root [aria-label="退出全屏"]').length,
    inner: [innerWidth, innerHeight],
    orient: (screen.orientation && screen.orientation.type) || "",
  }), ENTRY);
  report.data.afterRotate = afterFs;
  await page.screenshot({ path: join(output, "fullscreen-landscape.png") });
  report.shots.push(join(output, "fullscreen-landscape.png"));

  await step("转横后：innerWidth>innerHeight 且进沉浸层，入口消失", async () => {
    assert.ok(afterFs.inner[0] > afterFs.inner[1], `视口 ${afterFs.inner}`);
    assert.ok(afterFs.immersive, "没有 .fs-immersive");
    assert.equal(afterFs.entry, 0, `入口还在 ${afterFs.entry} 个`);
  });
  await step("横屏只留左上角「返回」，页面上没有任何「退出全屏」", async () => {
    assert.ok(afterFs.back, "找不到 aria-label=返回");
    assert.equal(afterFs.exitBtn, 0, `仍有 ${afterFs.exitBtn} 个退出全屏`);
  });
  await step("左上角返回：热区 48×48，吃左侧安全区", async () => {
    const m = await page.evaluate(() => {
      const b = document.querySelector('.player-root [aria-label="返回"]');
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2 - 20, r.y + r.height / 2);
      const hit2 = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2 + 20);
      return { x: r.x, y: r.y, w: r.width, h: r.height,
        hitLeft: !!hit && (hit === b || b.contains(hit)),
        hitDown: !!hit2 && (hit2 === b || b.contains(hit2)) };
    });
    assert.ok(m.x >= 16, `左偏移 ${m.x}（应 ≥ 16 + 安全区）`);
    assert.ok(m.hitLeft && m.hitDown, `热区不足：左 ${m.hitLeft} / 下 ${m.hitDown}`);
  });

  /* ───── 收起态也能退：点一下唤出，返回钮在 ───── */
  await page.waitForTimeout(3600);
  const hidden = await page.evaluate(() => document.querySelectorAll('.player-root [aria-label="返回"]').length);
  await page.touchscreen.tap(180, 200);   // 画面中部（控件已收起，此处没有任何控件）
  await page.waitForTimeout(800);
  const woken = await page.evaluate(() => !!document.querySelector('.player-root [aria-label="返回"]'));
  await step("横屏控件自动收起后，点一下唤出，左上角返回仍可用", async () => {
    assert.equal(hidden, 0, `收起后仍有 ${hidden} 个返回钮`);
    assert.ok(woken, "唤出后仍找不到返回钮");
  });

  /* ───── 返回 → 回竖屏，入口原位恢复 ───── */
  const back = await page.evaluate(() => {
    const b = document.querySelector('.player-root [aria-label="返回"]');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.touchscreen.tap(back.x, back.y);
  await page.waitForTimeout(250);
  await step("点左上角返回 → 下发 set_orientation(landscape=false)", async () => {
    const calls = await orientationCalls();
    assert.equal(calls.filter((v) => v === false).length >= 1, true, `调用=${JSON.stringify(calls)}`);
  });
  await rotate(false);
  const backPortrait = await page.evaluate((sel) => ({
    immersive: !!document.querySelector(".player-root.fs-immersive"),
    entry: document.querySelectorAll(sel).length,
    inner: [innerWidth, innerHeight],
  }), ENTRY);
  report.data.backPortrait = backPortrait;
  await page.screenshot({ path: join(output, "back-to-portrait.png") });
  report.shots.push(join(output, "back-to-portrait.png"));

  await step("回竖屏：退出沉浸层，视频下方那行入口原位恢复", async () => {
    assert.ok(!backPortrait.immersive, "仍在 fs-immersive");
    assert.equal(backPortrait.entry, 1, `入口 ${backPortrait.entry} 个`);
    assert.deepEqual(backPortrait.inner, [360, 640], `视口 ${backPortrait.inner}`);
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
