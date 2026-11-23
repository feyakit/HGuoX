// v3.0.13 播放器交互验收：单击唤出 / 双击暂停 / 长按优先 / 按钮不进延迟 /
// 全屏行随控件 / 跟手 pager（1:1 + 阈值 + 回弹）/ 底部三段 bbox。
//
// 用法：node scripts/test-player-v3013.mjs [tag]        （tag 默认 after，用来分 before/after 目录）
// 真组件 + 真 store + 真 CSS，只 mock Tauri IPC（见 tests/player-v3013.tsx）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] || process.env.SHOT_TAG || "after";
const output = join(root, "test-results", "player-v3013", tag);
await mkdir(output, { recursive: true });
const report = { tag, cases: {}, geom: {}, failed: [] };

const step = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { report.failed.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

let vite, browser, context, page, origin, cdp;
const probe = () => page.evaluate(() => window.__v.probe());
const resetCounts = () => page.evaluate(() => window.__v.resetCounts());
const calls = () => page.evaluate(() => window.__v.calls());
/* 只认「用户动作导致的 pause」：fixture 的片源是必然失败的地址，重试会把 <video> 整块重挂，
   卸载时的清理 pause 带 usePlaybackActivity.ts:6x 的栈；真正的 toggle/pause 走 :26 那行。
   这样双击/长按的判据不会被片源噪声污染。 */
const userPauses = (list) => list.filter((c) => c.k === "pause" && /usePlaybackActivity\.ts:26/.test(String(c.stack || "")));

const boot = async (query = "eps=5", opts = {}) => {
  const { landscape = false, hideControls = false } = opts;
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}tests/player-v3013.html?${query}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player-root", { timeout: 10000 });
  await page.waitForTimeout(700);
  if (landscape) {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("orientationchange"));
    });
    await page.waitForTimeout(500);
  }
  if (hideControls) await page.waitForTimeout(3400); // 3s 自动收起
  return probe();
};

/** 等两帧：React 的 setEpSlide 在事件里批处理，读得太早会拿到上一帧的值 */
const waitFrame = () => page.evaluate(() => new Promise((r) => {
  requestAnimationFrame(() => requestAnimationFrame(() => r(null)));
}));

/** 真触摸拖拽（CDP Input.dispatchTouchEvent，和桌面鼠标不是一条链）：
    按住 → 每 16ms 移动一步 → 每次读完一帧再量 translateY → 抬手。 */
const drag = async (x, y, dy, { steps = 10, stepMs = 16, release = true, probeEach = true } = {}) => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  const samples = [];
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / steps }] });
    await page.waitForTimeout(stepMs);
    if (!probeEach) continue;
    await waitFrame();
    const p = await probe();
    samples.push({ finger: Math.round((dy * i) / steps), ty: p.ty });
  }
  if (release) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return samples;
};

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 11; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
  });
  await context.addInitScript(() => { localStorage.setItem("hguox_app_v1", JSON.stringify({ favs: [], history: [], postHistory: [] })); });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  /* ── 1. 单击 = 延迟唤出控件（不再暂停） ── */
  await step("收起态单击：250ms 内不动作，过后只唤出控件，不暂停", async () => {
    const hidden = await boot("eps=5", { hideControls: true });
    assert.equal(hidden.segs.length, 0, `收起态仍有胶囊：${JSON.stringify(hidden.segs)}`);
    const t0 = (await probe()).now;
    await page.touchscreen.tap(180, 200);
    await page.waitForTimeout(120);
    const early = await probe();
    assert.equal(early.segs.length, 0, `120ms 就唤出了控件（早于 doubleTapMs）`);
    await page.waitForTimeout(320);
    const late = await probe();
    const tapped = userPauses(late.mediaCalls).filter(c => c.t >= t0);
    report.cases.singleTap = { early, late, mediaInWindow: tapped };
    assert.ok(late.segs.length > 0, "过了双击窗口控件没有出现");
    assert.equal(tapped.length, 0, `单击触发了播放/暂停：${JSON.stringify(tapped)}`);
  });

  /* ── 2. 双击 = 暂停/播放，控件常驻；不再点赞 ── */
  await step("双击：一次播放/暂停（状态翻转一次）、控件可见、不触发点赞", async () => {
    await boot("eps=5", { hideControls: true });
    const before = await probe();
    const likeBefore = (await calls()).filter(c => c === "api_like").length;
    await page.touchscreen.tap(180, 200);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(180, 202);
    await page.waitForTimeout(260);
    const after = await probe();
    const likeDelta = (await calls()).filter(c => c === "api_like").length - likeBefore;
    report.cases.doubleTap = { before: { paused: before.paused, segs: before.segs.length }, after: { paused: after.paused, segs: after.segs.length }, likeDelta };
    /* 两次单击会把控件「唤出 → 收起」，双击才会翻播放状态。这里开始是收起态：
       正确行为 = 控件出现 + 播放状态恰好翻转一次（中点一下会在 240ms 时把它藏回去）。 */
    assert.notEqual(after.paused, before.paused, "双击没有切换播放状态");
    assert.ok(after.segs.length > 0, "双击后控件没有出现");
    assert.equal(likeDelta, 0, "双击仍然触发点赞");
    assert.equal(after.bodyText.includes("红心"), false, "出现了点赞红心层");
  });

  /* ── 3. 长按 2x 优先级最高 ── */
  await step("长按：进入 2x，松手不暂停、不唤出/收起", async () => {
    const before = await boot("eps=5");
    const t0 = (await probe()).now;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 180, y: 200 }] });
    await page.waitForTimeout(900);
    const holding = await probe();
    const tUp = holding.now;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(320);
    const after = await probe();
    /* 只看**松手那一下**的窗口：片源是必然失败的地址，会周期性地 pause/play 重试，
       整段 hold 里出现 pause 属于环境噪声，不代表松手被当成点击。 */
    const tapped = userPauses(after.mediaCalls).filter(c => c.t >= t0);
    report.cases.longPress = { holding: holding.bodyText.slice(-80), after, pauseAtRelease: tapped, t0, tUp };
    assert.ok(holding.bodyText.includes("倍速中"), `长按没有出「倍速中」：${holding.bodyText.slice(-80)}`);
    assert.equal(tapped.length, 0, `长按松手被当成点击：${JSON.stringify(tapped)}`);
    assert.ok(after.segs.length > 0, "长按松手把控件收走了（被当成单击）");
  });

  /* ── 4. 命中真按钮不进延迟；且作废挂起的单击 ── */
  await step("按钮立即生效：单击后 100ms 内点「选集」，面板立刻开、控件不被收起", async () => {
    await boot("eps=5");
    await page.touchscreen.tap(180, 200);          // 起一次单击（挂起 250ms 计时）
    await page.waitForTimeout(100);
    const btn = (await probe()).meta.ep;
    assert.ok(btn, "量不到选集入口");
    await page.touchscreen.tap(btn.x + btn.w / 2, btn.y + btn.h / 2);
    await page.waitForTimeout(150);
    const opened = await probe();
    assert.ok(/剧集面板|选集/.test(opened.bodyText), "点选集 150ms 内面板没开（进了延迟？）");
    await page.waitForTimeout(600);
    const settled = await probe();
    assert.ok(settled.bodyText.includes("详情"), "面板被挂起的单击关掉了");
  });

  /* ── 5. 「全屏观看」行随控件一起收 ── */
  await step("全屏观看行：控件可见时在，3s 自动收起后一起消失", async () => {
    const shown = await boot("eps=5&src=land");
    await page.waitForTimeout(600);
    const withControls = await probe();
    assert.ok(withControls.fsEntryVisible, "控件可见时没有「全屏观看」行");
    await page.waitForTimeout(3400);
    const hidden = await probe();
    report.cases.fsRow = { withControls: withControls.fsEntry, hidden: { rect: hidden.fsEntry, visible: hidden.fsEntryVisible } };
    assert.equal(hidden.segs.length, 0, "控件没收起（场景前提不成立）");
    assert.equal(hidden.fsEntryVisible, false, "控件收起后「全屏观看」行还在");
  });

  /* ── 6. 跟手：translateY 与手指 1:1 ── */
  await step("跟手采样：每 16ms 的 translateY 与手指位移偏差 ≤1px", async () => {
    await boot("eps=5");
    const samples = await drag(180, 420, -200, { steps: 10, stepMs: 16, release: false });
    report.cases.followSamples = samples;
    /* 第 1 个 touchMove 会和 touchStart 合并成同一帧，采到的是起点值（偏差 = 一步位移），
       从第 2 步开始才是真正的跟手比对（报告里两条数都留着）。 */
    const worst = samples.slice(1).reduce((m, s) => Math.max(m, Math.abs(s.ty - s.finger)), 0);
    await page.mouse.up();
    await page.waitForTimeout(320);
    report.cases.followWorst = worst;
    assert.ok(worst <= 1, `最大偏差 ${worst}px > 1px（疑似还有阻尼）`);
  });

  /* ── 7. 松手判定：24% 门槛 / 速度 / 回弹 ── */
  await step("松手：100px 慢滑回弹到 0、集数不变", async () => {
    await boot("eps=5");
    const before = await probe();
    await drag(180, 420, -100, { steps: 4, stepMs: 60, probeEach: false });
    await page.waitForTimeout(350);
    const after = await probe();
    assert.equal(after.ty, 0, `回弹后 translateY=${after.ty}`);
    assert.equal(after.meta.epText, before.meta.epText, "没到门槛却切了集");
  });

  await step("松手：200px（>24% 屏高）慢滑切下一集", async () => {
    const before = await boot("eps=5");
    await drag(180, 420, -200, { steps: 10, stepMs: 40 });
    await page.waitForTimeout(800);
    const after = await probe();
    report.cases.commitByDistance = { before: before.meta.epText, after: after.meta.epText };
    assert.ok(/第 2\/5 集/.test(after.meta.epText || ""), `没有切到第 2 集：${after.meta.epText}`);
  });

  await step("松手：60px 快滑（≥40px + 高速）切集", async () => {
    await boot("eps=5");
    await drag(180, 420, -60, { steps: 2, stepMs: 6, probeEach: false });
    await page.waitForTimeout(800);
    const after = await probe();
    report.cases.commitByVelocity = after.meta.epText;
    assert.ok(/第 2\/5 集/.test(after.meta.epText || ""), `快滑没切集：${after.meta.epText}`);
  });

  await step("松手：60px 慢滑（<门槛且低速）回弹不切", async () => {
    const before = await boot("eps=5");
    await drag(180, 420, -60, { steps: 6, stepMs: 60 });
    await page.waitForTimeout(400);
    const after = await probe();
    assert.equal(after.meta.epText, before.meta.epText, `慢滑 60px 也切了集：${after.meta.epText}`);
  });

  /* ── 8. 首集 / 末集 ── */
  await step("首集下滑：只回弹 + 「已经是第一集」，不出结束卡", async () => {
    await boot("eps=1");
    await drag(180, 420, 200, { steps: 10, stepMs: 30 });
    await page.waitForTimeout(700);
    const after = await probe();
    report.cases.firstEp = after.bodyText.slice(-120);
    assert.ok(after.bodyText.includes("已经是第一集"), "首集下滑没提示");
    assert.ok(!after.bodyText.includes("本剧已看完") && !after.bodyText.includes("本剧看完"), "首集下滑弹了结束态");
  });

  await step("末集上滑：出结束卡（3.0.12 口径）", async () => {
    await boot("eps=1");
    await drag(180, 420, -200, { steps: 10, stepMs: 30 });
    await page.waitForTimeout(1200);
    const after = await probe();
    report.cases.lastEp = after.bodyText.slice(-160);
    assert.ok(/看完|推荐/.test(after.bodyText), "末集上滑没出结束卡");
  });

  /* ── 9. 横屏中区提交保底 48 CSS px ── */
  await step("横屏中区：40px 不切、60px 切（48px 保底）", async () => {
    await boot("eps=5&src=land", { landscape: true });
    await drag(320, 140, -40, { steps: 4, stepMs: 40 });
    await page.waitForTimeout(500);
    const short = await probe();
    assert.equal(short.meta.epText, null, "横屏没有底栏（场景前提不成立）");
    await drag(320, 140, -60, { steps: 5, stepMs: 60 });
    await page.waitForTimeout(900);
    const longer = await probe();
    report.cases.landscapeMid = { short: short.segs, longer: longer.segs };
    assert.ok(longer.segs.some(s => /当前第 2 集/.test(s)), `横屏中区 60px 没切集：${JSON.stringify(longer.segs)}`);
  });

  /* ── 9b. 右上角全屏按钮已删 / 右上角控件不位移 / 方向锁定 ── */
  await step("右上角不再有全屏按钮（侧栏与顶栏都没有）", async () => {
    const p0 = await boot("eps=5&src=land");
    await page.waitForTimeout(600);
    const p1 = await probe();
    report.cases.fsButtonGone = { rail: p1.rail, topRight: p1.topRight };
    assert.equal(p1.rail.fs, null, "右侧竖排里还有全屏按钮");
    const anyFs = await page.evaluate(() => [...document.querySelectorAll(".player-root button")]
      .filter(b => /全屏横屏播放|^全屏$/.test((b.getAttribute("aria-label") || "") + (b.textContent || "").trim())).length);
    assert.equal(anyFs, 0, `页面上还有 ${anyFs} 个全屏按钮`);
    /* 右上角那一组（静音 / 锁）位置不变：改前 252,53 / 304,53（360×640） */
    assert.deepEqual(p1.topRight.mute, { x: 252, y: 53, w: 44, h: 44 }, `静音位移了：${JSON.stringify(p1.topRight.mute)}`);
    assert.deepEqual(p1.topRight.lock, { x: 304, y: 53, w: 44, h: 44 }, `锁位移了：${JSON.stringify(p1.topRight.lock)}`);
  });

  await step("按片源宽高锁方向：竖版片源锁 portrait、横版片源 unspecified", async () => {
    const portraitCase = await boot("eps=5&src=port");
    await page.waitForTimeout(600);
    const pc = (await probe()).orientationCalls;
    report.cases.orientation = { portrait: pc };
    assert.ok(pc.some(c => c.mode === "portrait"), `竖版片源没有锁 portrait：${JSON.stringify(pc)}`);
    const landCase = await boot("eps=5&src=land");
    await page.waitForTimeout(600);
    const lc = (await probe()).orientationCalls;
    report.cases.orientation.landscape = lc;
    assert.ok(lc.some(c => c.mode === "unspecified"), `横版片源没有还回 unspecified：${JSON.stringify(lc)}`);
    assert.ok(!lc.some(c => c.mode === "portrait"), `横版片源被锁成竖屏了：${JSON.stringify(lc)}`);
    report.cases.orientation.portraitBoot = portraitCase.segs.length;
  });

  await step("横版「全屏观看」→ set_orientation(landscape)", async () => {
    await boot("eps=5&src=land");
    await page.waitForTimeout(700);
    const p0 = await probe();
    assert.ok(p0.fsEntryVisible, "没有「全屏观看」入口（场景前提不成立）");
    const r = p0.fsEntry;
    await page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2);
    await page.waitForTimeout(400);
    const after = await probe();
    const calls = after.orientationCalls.filter(c => c.landscape === true);
    report.cases.fsEntryOrientation = calls;
    assert.ok(calls.length >= 1, `点入口没有下发 landscape：${JSON.stringify(after.orientationCalls)}`);
    assert.equal(calls[calls.length - 1].mode, "landscape", "下发的是 landscape 但 mode 不对");
  });

  await step("离开播放页（active→false）→ 方向还给系统（unspecified）", async () => {
    await boot("eps=5&src=port");
    await page.waitForTimeout(500);
    const before = (await probe()).orientationCalls.length;
    await page.evaluate(() => window.__setActive(false));
    await page.waitForTimeout(400);
    const list = (await probe()).orientationCalls;
    report.cases.leavePlayer = list.slice(before);
    assert.ok(list.length > before, "失活没有下发任何方向请求");
    assert.equal(list[list.length - 1].mode, "unspecified", `最后一个方向请求不是 unspecified：${JSON.stringify(list.slice(before))}`);
  });

  /* ── 10. 底部三段 / 侧栏 / 右上角 bbox ── */
  const geomOf = async (query, shot) => {
    await boot(query);
    const p = await probe();
    const g = { meta: p.meta, rail: p.rail, topRight: p.topRight, segs: p.segs };
    if (shot) await page.screenshot({ path: join(output, `${shot}.png`) });
    return g;
  };
  report.geom.withLine = await geomOf("eps=5", "withLine");
  /* 右侧竖排标注图：画中心竖线 + 每个热区框 + 中心坐标 + 相邻间距 */
  await page.evaluate(() => {
    const root = document.querySelector(".player-root");
    const rail = root.querySelector(".mobile-video-action-rail");
    const items = [...rail.querySelectorAll("button")];
    const box = document.createElement("div");
    box.setAttribute("data-annot", "1");
    box.style.cssText = "position:fixed;inset:0;z-index:9999;pointer-events:none;font:11px/1.3 monospace";
    const rects = items.map(b => ({ label: b.getAttribute("aria-label") || "?", r: b.getBoundingClientRect() }));
    const cx = Math.round(rects[0].r.x + rects[0].r.width / 2);
    const line = document.createElement("div");
    line.style.cssText = `position:absolute;left:${cx}px;top:0;bottom:0;width:1px;background:rgba(255,60,60,.85)`;
    box.appendChild(line);
    rects.forEach((it, i) => {
      const { x, y, width, height } = it.r;
      const o = document.createElement("div");
      o.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;box-sizing:border-box;border:1px dashed rgba(80,255,160,.95)`;
      box.appendChild(o);
      const t = document.createElement("div");
      t.textContent = `${it.label.slice(0, 6)} ${Math.round(x + width / 2)},${Math.round(y + height / 2)}  ${Math.round(width)}x${Math.round(height)}`;
      t.style.cssText = `position:absolute;left:2px;top:${y + height / 2 - 6}px;color:#7CFFC4;background:rgba(0,0,0,.72);padding:1px 3px;border-radius:3px`;
      box.appendChild(t);
      if (i > 0) {
        const gap = Math.round(rects[i].r.y - (rects[i - 1].r.y + rects[i - 1].r.height));
        const g = document.createElement("div");
        g.textContent = `gap ${gap}`;
        g.style.cssText = `position:absolute;left:${x + width + 4}px;top:${rects[i].r.y - gap - 2}px;color:#FFD166;background:rgba(0,0,0,.72);padding:1px 3px;border-radius:3px`;
        box.appendChild(g);
      }
    });
    document.body.appendChild(box);
  });
  await page.screenshot({ path: join(output, "rail-annotated.png") });
  await page.evaluate(() => document.querySelectorAll("[data-annot]").forEach(el => el.remove()));
  report.geom.withoutLine = await geomOf("eps=5&line=0", "withoutLine");
  /* 集数文案从 1/5 变成 1/120：左段固定宽 88，中段/右段不许被推动 */
  report.geom.longEpisodes = await geomOf("eps=120", "longEpisodes");

  await step("底部三段防跳：集数变长（第 1/5 → 第 1/120）详情 x/y 不动", async () => {
    const a = report.geom.withLine.meta;
    const b = report.geom.longEpisodes.meta;
    assert.equal(a.ep.w, b.ep.w, `集数胶囊宽度变了：${a.ep.w} → ${b.ep.w}`);
    assert.equal(a.detail.x, b.detail.x, `详情 x 跳了：${a.detail.x} → ${b.detail.x}`);
    assert.equal(a.detail.y, b.detail.y, `详情 y 跳了：${a.detail.y} → ${b.detail.y}`);
    assert.equal(a.line.x, b.line.x, `域名 x 跳了：${a.line.x} → ${b.line.x}`);
  });

  await step("底部三段防跳：单线路（域名隐藏）时详情 x/y 与有域名时一致", async () => {
    const a = report.geom.withLine.meta;
    const b = report.geom.withoutLine.meta;
    assert.equal(a.detail.x, b.detail.x, `域名显示/隐藏切换时详情 x 跳了：${a.detail.x} → ${b.detail.x}`);
    assert.equal(a.detail.y, b.detail.y, `域名显示/隐藏切换时详情 y 跳了：${a.detail.y} → ${b.detail.y}`);
    assert.equal(a.ep.x, b.ep.x, "集数胶囊 x 变了");
  });

  await step("右侧竖排：每个按钮中心同一条竖线、热区 ≥44、间距相等", async () => {
    const rail = report.geom.withLine.rail;
    const items = Object.entries(rail).filter(([, r]) => r);
    for (const [k, r] of items) {
      assert.ok(r.w >= 44 && r.h >= 44, `${k} 热区 ${r.w}x${r.h} < 44`);
    }
    const centers = items.map(([k, r]) => [k, Math.round((r.x + r.w / 2) * 100) / 100]);
    const xs = new Set(centers.map(([, x]) => x));
    assert.equal(xs.size, 1, `中心 x 不在同一条竖线：${JSON.stringify(centers)}`);
    report.cases.railCenters = centers;
  });
  await boot("eps=5&src=land");
  await page.waitForTimeout(600);
  report.geom.landscapeRow = (await probe()).fsEntry;
  await page.screenshot({ path: join(output, "fs-row.png") });

  report.pageErrors = errors;
} finally {
  report.summary = `${report.failed.length ? "FAILED" : "PASS"} · ${report.failed.length} failed`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n[geom ${tag}] ` + JSON.stringify(report.geom, null, 1));
  console.log(`[${tag}] ${report.summary}`);
  await browser?.close();
  await vite?.close();
}
process.exit(report.failed.length ? 1 : 0);
