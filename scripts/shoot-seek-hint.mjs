// 双击快进/快退提示：现状(v3.0.10) vs 案 A 的成对截图 + 几何量测 + 动效时序。
// 同一支脚本、同一份底图、同一份 CSS，只切 ?v=before|after；两档视口各拍一次（竖屏 360×640 / 全屏 640×360）。
//
// 坑（本轮踩过）：气泡的 CSS 动画是「120ms 淡入 → 停留 600ms → 200ms 淡出 forwards」，
// 页面 networkidle 再等 260ms 就已经淡到 opacity 0 了，截图会拍到一片空白（几何还在、什么都看不见）。
// 所以：① 动效时序在页面内用 rAF 逐帧采 computed opacity 单独验；② 截静帧前先
// `animation:none !important` 把动画停掉，拿到的就是停留期那一帧（opacity 1）。
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "seek-hint");
await mkdir(output, { recursive: true });

const geoOf = (sel) => (s) => {
  const bubble = document.querySelector(s);
  const r = bubble.getBoundingClientRect();
  const cs = getComputedStyle(bubble);
  return {
    inner: [innerWidth, innerHeight],
    rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10),
    centerX: Math.round((r.x + r.width / 2) * 10) / 10,
    centerY: Math.round((r.y + r.height / 2) * 10) / 10,
    radius: cs.borderRadius, bg: cs.backgroundColor, fontSize: cs.fontSize,
    fontWeight: cs.fontWeight, pad: `${cs.paddingTop} ${cs.paddingRight}`,
    backdrop: cs.backdropFilter || cs.webkitBackdropFilter || "none",
    text: (bubble.textContent || "").trim(),
  };
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
const url = (v, side) => `${origin}tests/seek-hint.html?v=${v}&side=${side}`;

/* ① 动效时序：页面内 rAF 逐帧采 opacity（这是真 CSS 动画，不是桩） */
await page.setViewportSize({ width: 360, height: 640 });
await page.goto(url("after", "right"), { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hg-seekhint");
const timeline = await page.evaluate(() => new Promise((res) => {
  const el = document.querySelector(".hg-seekhint");
  const t0 = performance.now();
  const out = [];
  const tick = () => {
    const t = performance.now() - t0;
    out.push([Math.round(t), Math.round(parseFloat(getComputedStyle(el).opacity) * 100) / 100]);
    if (t < 950) requestAnimationFrame(tick); else res(out);
  };
  requestAnimationFrame(tick);
}));
const opacityAt = (ms) => {
  const near = timeline.filter(([t]) => Math.abs(t - ms) < 25);
  return near.length ? near[0][1] : null;
};
const anim = {
  samples: timeline.length,
  at100: opacityAt(100), at300: opacityAt(300), at500: opacityAt(500), at750: opacityAt(750), at900: opacityAt(900),
};

/* ② 静帧对照：停掉入场动画，取停留期那一帧 */
const shot = async (v, side, viewport, name) => {
  await page.setViewportSize(viewport);
  await page.goto(url(v, side), { waitUntil: "networkidle" });
  if (v === "after") await page.addStyleTag({ content: ".hg-seekhint{animation:none !important}" });
  await page.waitForTimeout(120);
  const geo = await page.evaluate(geoOf(), v === "after" ? ".hg-seekhint" : ".hg-chip");
  const file = join(output, name);
  await page.screenshot({ path: file });
  return { v, side, viewport, file, geo };
};

const rows = [];
for (const [label, viewport] of [["portrait", { width: 360, height: 640 }], ["full", { width: 640, height: 360 }]]) {
  for (const side of ["left", "right"]) {
    for (const v of ["before", "after"]) rows.push(await shot(v, side, viewport, `${label}-${side}-${v}.png`));
  }
}

await writeFile(join(output, "report.json"), JSON.stringify({ rows, anim, errors }, null, 2));
console.log("动画 opacity 采样：", JSON.stringify(anim));
for (const r of rows) console.log(r.file.split("/").pop(), JSON.stringify(r.geo));
console.log("errors:", errors.length ? errors : "none");
await browser.close();
await vite.close();
