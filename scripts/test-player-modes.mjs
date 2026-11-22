// 抖音模式 vs 剧场模式：全屏/非全屏的「切集控件」现状对账（真 EpisodePlayer）。
//
// 用户报「抖音模式进全屏还有下一集」。这里逐项数控件，两个模式各跑一遍：
//   非全屏（竖屏）底栏 SegPill：倍速 / 上一集 / 下一集
//   全屏底栏 SegPill：倍速 / 选集 / 下集
//   以及其他「集」相关文案（即将连播、上滑换集预览等）
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.env.SHOT_TAG || "after";
const output = join(root, "test-results", "player-modes", tag);
await mkdir(output, { recursive: true });
const report = { tag, cases: {}, failed: [] };

/** 收集当前可见的控件集合（限定在 player-root 里，避免命中别处的同名按钮） */
const controls = (page) => page.evaluate(() => {
  const rootEl = document.querySelector(".player-root");
  if (!rootEl) return { error: "no .player-root" };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.05) return false;
    return el.offsetParent !== null || cs.position === "fixed";
  };
  const segs = [...rootEl.querySelectorAll(".hg-seg")].filter(visible)
    .map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim());
  const names = [...rootEl.querySelectorAll("button[aria-label]")].filter(visible)
    .map((b) => b.getAttribute("aria-label"));
  const text = (rootEl.textContent || "");
  return {
    segs,
    epLike: names.filter((n) => /上一集|下一集|选集|下集/.test(n)),
    hasNextEpPrompt: text.includes("即将连播"),
    hasEpEntry: names.some((n) => /选集/.test(n)),
  };
});

const step = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { report.failed.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); }
};

let vite, browser, context, page;
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

  /* v3.0.11 起「全屏」= 屏幕实际是横的（状态源唯一），所以全屏场景要真的换视口 +
     派发 resize/orientationchange，而不是靠一个 store 开关。 */
  const boot = async (endless, fs) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`${origin}tests/player-modes.html?endless=${endless ? 1 : 0}&fs=0`, { waitUntil: "networkidle" });
    await page.waitForSelector(".player-root", { timeout: 10000 });
    await page.waitForTimeout(700);
    if (fs) {
      await page.setViewportSize({ width: 640, height: 360 });
      await page.evaluate(() => {
        window.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("orientationchange"));
      });
      await page.waitForTimeout(450);
    }
    /* 唤出控件：点画面中部（收起态点一下会唤出） */
    const cx = fs ? 320 : 180, cy = fs ? 200 : 300;
    await page.touchscreen.tap(cx, cy);
    await page.waitForTimeout(400);
  };

  for (const [key, endless, fs] of [["douyin-portrait", true, false], ["douyin-fullscreen", true, true],
                                    ["cinema-portrait", false, false], ["cinema-fullscreen", false, true]]) {
    await boot(endless, fs);
    report.cases[key] = await controls(page);
    await page.screenshot({ path: join(output, `${key}.png`) });
  }

  const c = report.cases;
  await step("抖音·竖屏：没有「上一集/下一集」", async () => {
    assert.ok(!c["douyin-portrait"].segs.some((s) => /集/.test(s)), `竖屏胶囊=${JSON.stringify(c["douyin-portrait"].segs)}`);
    assert.equal(c["douyin-portrait"].epLike.length, 0, `集相关 aria=${JSON.stringify(c["douyin-portrait"].epLike)}`);
    assert.ok(c["douyin-portrait"].segs.some((s) => /倍速/.test(s)), "倍速控件不该消失");
  });
  await step("抖音·全屏：没有「选集 / 下集」", async () => {
    assert.ok(!c["douyin-fullscreen"].segs.some((s) => /集/.test(s)), `全屏胶囊=${JSON.stringify(c["douyin-fullscreen"].segs)}`);
    assert.equal(c["douyin-fullscreen"].epLike.length, 0, `集相关 aria=${JSON.stringify(c["douyin-fullscreen"].epLike)}`);
  });
  await step("抖音：没有「即将连播」提示", async () => {
    assert.ok(!c["douyin-portrait"].hasNextEpPrompt && !c["douyin-fullscreen"].hasNextEpPrompt, "出现了连播提示");
  });
  await step("剧场·竖屏：仍有 上一集/下一集（口径不变）", async () => {
    assert.ok(c["cinema-portrait"].segs.some((s) => /^上一集/.test(s)), `胶囊=${JSON.stringify(c["cinema-portrait"].segs)}`);
    assert.ok(c["cinema-portrait"].segs.some((s) => /^下一集/.test(s)), `胶囊=${JSON.stringify(c["cinema-portrait"].segs)}`);
  });
  await step("剧场·全屏：仍有 选集 + 下集（口径不变）", async () => {
    assert.ok(c["cinema-fullscreen"].segs.some((s) => /选集/.test(s)), `胶囊=${JSON.stringify(c["cinema-fullscreen"].segs)}`);
    assert.ok(c["cinema-fullscreen"].segs.some((s) => /下一集|下集/.test(s)), `胶囊=${JSON.stringify(c["cinema-fullscreen"].segs)}`);
  });


  /* ───────── v3.0.11 手势重分工：收起态单击 = 暂停/播放（不再「只唤出」） ───────── */
  await step("收起态单击画面 → 播放/暂停一次，并把控件亮出来", async () => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`${origin}tests/player-modes.html?endless=0&fs=0&eps=5`, { waitUntil: "networkidle" });
    await page.waitForSelector(".player-root");
    await page.waitForTimeout(3600);                 // 等控件自动收起
    const hidden = await page.evaluate(() => document.querySelectorAll(".player-root .hg-seg").length);
    await page.evaluate(() => { window.gestureProbe.play = 0; window.gestureProbe.pause = 0; });
    await page.touchscreen.tap(180, 200);
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => ({
      toggles: window.gestureProbe.play + window.gestureProbe.pause,
      segs: document.querySelectorAll(".player-root .hg-seg").length,
    }));
    assert.equal(hidden, 0, `收起前仍有 ${hidden} 个胶囊`);
    assert.equal(r.toggles, 1, `播放/暂停调用 ${r.toggles} 次`);
    assert.ok(r.segs > 0, "单击后控件没有亮出来");
  });

  /* ───────── 审计 #8：片尾双触发只取一批推荐 ───────── */
  await step("审计 #8 护栏：片尾 ended 连发两次 → 池子只建 1 次（旧版同值，本项无判别力，真机看 [endcard] 行数）", async () => {
    await page.goto(`${origin}tests/player-modes.html?endless=0&fs=0&eps=1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".player-root");
    await page.waitForFunction(() => !!document.querySelector("video"), null, { timeout: 8000 });
    const before = await page.evaluate(() => window.playerModeFixture.calls.filter(c => c.cmd === "api_related").length);
    await page.evaluate(() => {
      /* 同一 tick 连发两次 = 片尾那一刻「ended 回调 + 手势/计时器」同时触发的形态。
         分两次 setTimeout 反而测不出来：mock 接口在微任务里就返回了，第二次调用时池子已建好。 */
      const v = document.querySelector("video");
      v.dispatchEvent(new Event("ended"));
      v.dispatchEvent(new Event("ended"));
    });
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => window.playerModeFixture.calls.filter(c => c.cmd === "api_related").length);
    assert.equal(after - before, 1, `api_related 增量 ${after - before} 次`);
  });

  report.pageErrors = errors;
} finally {
  report.summary = `${report.failed.length ? "FAILED" : "PASS"} · ${report.failed.length} failed`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log("\n" + JSON.stringify(report.cases, null, 1));
  console.log(`[${tag}] ${report.summary}`);
  await browser?.close();
  await vite?.close();
}
process.exit(report.failed.length ? 1 : 0);
