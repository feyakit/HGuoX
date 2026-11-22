// 快进 / 快退提示的左右对称性验收（用户指出「两个高度不一样」）。
//
// 同一屏同时挂左右两个 SeekHint（?both=1），同一份 CSS，两次量测在同一次 evaluate 里取，
// 逐项断言：top 相等、height / width / border-radius / font-size / padding 完全相等、
// 到各自屏幕边缘的水平距离相等、各自落在 1/4 区中心。
// 另外在截图里画一条贯穿两侧中心的红色基线（画在像素上，不靠肉眼）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "seek-hint-symmetry");
await mkdir(output, { recursive: true });
const report = { passed: [], failed: [], views: {} };
const step = async (n, fn) => {
  try { await fn(); report.passed.push(n); console.log("  ok   " + n); }
  catch (e) { report.failed.push(`${n}: ${e.message}`); console.log("  FAIL " + n + ": " + e.message); }
};

const measure = (page) => page.evaluate(() => {
  const pick = (side) => {
    const el = [...document.querySelectorAll(".hg-seekhint-anchor, [data-hg-control='seekhint']")]
      .find((n) => (n.textContent || "").trim().startsWith(side === "left" ? "−" : "+"));
    const bubble = el.querySelector(".hg-seekhint");
    const r = bubble.getBoundingClientRect();
    const cs = getComputedStyle(bubble);
    const num = (v) => Math.round(parseFloat(v) * 100) / 100;
    return {
      top: num(r.top), height: num(r.height), width: num(r.width),
      left: num(r.left), right: num(r.right),
      centerX: num(r.left + r.width / 2), centerY: num(r.top + r.height / 2),
      radius: cs.borderTopLeftRadius + "/" + cs.borderBottomRightRadius,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
      gapToLeftEdge: num(r.left), gapToRightEdge: num(innerWidth - r.right),
      bg: cs.backgroundColor, backdrop: cs.backdropFilter || cs.webkitBackdropFilter || "none",
      text: (bubble.textContent || "").trim(),
    };
  };
  return { inner: [innerWidth, innerHeight], left: pick("left"), right: pick("right") };
});

/** 画一条贯穿两侧中心的红色基线（DOM 元素，进截图；dpr 由浏览器处理） */
const drawBaseline = (page, cssY) => page.evaluate((y) => {
  const d = document.createElement("div");
  d.id = "__baseline";
  d.style.cssText = `position:fixed;left:0;top:${y}px;width:100%;height:2px;background:#ff2828;z-index:9999;pointer-events:none`;
  document.body.appendChild(d);
  return y;
}, cssY);

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

try {
  for (const [label, viewport] of [["portrait", { width: 360, height: 640 }], ["full", { width: 640, height: 360 }]]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}tests/seek-hint.html?v=after&both=1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hg-seekhint");
    await page.addStyleTag({ content: ".hg-seekhint{animation:none !important}" });
    await page.waitForTimeout(120);
    const m = await measure(page);
    report.views[label] = m;
    const file = join(output, `${label}-both.png`);
    await drawBaseline(page, m.left.centerY);
    await page.waitForTimeout(60);
    await page.screenshot({ path: file });

    await step(`${label}: 两侧 top 相等`, async () => {
      assert.equal(m.left.top, m.right.top, `left.top=${m.left.top} right.top=${m.right.top}`);
      assert.equal(m.left.centerY, m.right.centerY, `centerY ${m.left.centerY} vs ${m.right.centerY}`);
    });
    await step(`${label}: 高度/宽/圆角/字号/字重/内边距 完全相等`, async () => {
      for (const k of ["height", "width", "radius", "fontSize", "fontWeight", "padding"]) {
        assert.equal(m.left[k], m.right[k], `${k}: ${m.left[k]} vs ${m.right[k]}`);
      }
      assert.ok(Math.abs(m.left.width - m.right.width) < 0.05, `width ${m.left.width} vs ${m.right.width}`);
    });
    await step(`${label}: 到边距 ≥16，且两侧互为镜像`, async () => {
      assert.ok(m.left.gapToLeftEdge >= 16 - 0.01, `左到左缘 ${m.left.gapToLeftEdge}`);
      assert.ok(m.right.gapToRightEdge >= 16 - 0.01, `右到右缘 ${m.right.gapToRightEdge}`);
      assert.ok(Math.abs(m.left.centerX + m.right.centerX - m.inner[0]) < 0.5,
        `镜像：${m.left.centerX} + ${m.right.centerX} vs ${m.inner[0]}`);
    });
    await step(`${label}: 不越过画面中心（两个气泡不会撞到一起）`, async () => {
      assert.ok(m.left.right < m.inner[0] / 2, `左气泡右缘 ${m.left.right} ≥ 屏心 ${m.inner[0] / 2}`);
      assert.ok(m.right.left > m.inner[0] / 2, `右气泡左缘 ${m.right.left} ≤ 屏心 ${m.inner[0] / 2}`);
    });
    await step(`${label}: 到各自边缘的距离相等`, async () => {
      assert.ok(Math.abs(m.left.gapToLeftEdge - m.right.gapToRightEdge) < 0.5,
        `左到左缘 ${m.left.gapToLeftEdge} vs 右到右缘 ${m.right.gapToRightEdge}`);
    });
  }
} finally {
  report.errors = errors;
  report.summary = `${report.passed.length} passed / ${report.failed.length} failed`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log("\n" + JSON.stringify(report.views, null, 1));
  console.log(report.summary);
  await browser.close();
  await vite.close();
}
process.exit(report.failed.length ? 1 : 0);
