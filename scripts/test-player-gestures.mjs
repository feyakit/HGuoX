/**
 * 播放器手势判定层的单测（纯函数，不需要真机/浏览器）。
 * 跑：node scripts/test-player-gestures.mjs
 *
 * 用 vite 的 ssrLoadModule 直接加载 TS 源码，跟仓库其它测试的启动方式一致。
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log("  ✓ " + name);
};

try {
  const G = await vite.ssrLoadModule("/src/features/playback/playerGestures.ts");
  const {
    GESTURE, lockAxis, seekSecondsPer100px, seekDeltaSeconds, canSeek, snapSeek,
    doubleTapSeek, doubleTapAction, tapZone, relativeSeek, isEdgeBackStart, isDoubleTap, rotationLocked, episodeIntent, judgeGesture,
    tapVerdict, episodeDrag, PLAYER_TIMING, EPISODE_EASE, episodePageProgress,
  } = G;

  console.log("[常量]");
  check("阈值常数与设计一致", () => {
    assert.equal(GESTURE.deadZone, 8);
    assert.equal(GESTURE.axisRatio, 1.4);
    assert.equal(GESTURE.edgeBack, 24);
    assert.equal(GESTURE.doubleTapMs, 280);
    assert.equal(GESTURE.doubleTapSeek, 5);
    assert.equal(GESTURE.minSeekPx, 20);
    assert.equal(GESTURE.tapSlop, 6);
    assert.equal(GESTURE.tapMs, 300);
    assert.equal(GESTURE.episodeSwitch, 0.24);
    assert.equal(GESTURE.episodeVelocity, 500);
    assert.equal(GESTURE.episodeVelocityMinPx, 40);
    assert.equal(GESTURE.episodeDamp, 1);
    assert.equal(GESTURE.episodeEdgeDamp, 0.35);
    assert.equal(GESTURE.episodeReboundMs, 200);
    assert.equal(GESTURE.episodePreview, 0.12);
    assert.equal(GESTURE.snapSeconds, 5);
    assert.equal(GESTURE.rotateLockMs, 300);
    assert.equal(GESTURE.seekBubbleMs, 800);
  });

  console.log("[死区 + 方向锁]");
  check("8px 内不算任何方向（3.0.13 起手 8px 定主方向）", () => {
    assert.equal(lockAxis("none", 7, 7), "none");
    assert.equal(lockAxis("none", -8, 3), "none");
    assert.equal(lockAxis("none", 0, 8), "none");
  });
  check("超过死区、横向占优 → x", () => {
    assert.equal(lockAxis("none", 14, 8), "x");
    assert.equal(lockAxis("none", -12, 1), "x");
  });
  check("超过死区、纵向占优 → y", () => {
    assert.equal(lockAxis("none", 8, 14), "y");
  });
  check("斜着（1:1）继续等，不判方向", () => {
    assert.equal(lockAxis("none", 30, 30), "none");
    assert.equal(lockAxis("none", 100, 80), "none");
  });
  check("1.4 倍边界：刚好 1.4 判横/竖", () => {
    assert.equal(lockAxis("none", 14, 10), "x");
    assert.equal(lockAxis("none", 10, 14), "y");
  });
  check("定下方向后锁死，反向移动也不改判", () => {
    const locked = lockAxis("none", 40, 5);
    assert.equal(locked, "x");
    assert.equal(lockAxis(locked, 0, 90), "x");
    assert.equal(lockAxis(locked, -80, 120), "x");
  });

  console.log("[seek 量纲三档]");
  check("<=60s：15s/100px", () => {
    assert.equal(seekSecondsPer100px(30), 15);
    assert.equal(seekSecondsPer100px(60), 15);
    assert.equal(seekDeltaSeconds(100, 30), 15);
  });
  check("60–600s：30s/100px", () => {
    assert.equal(seekSecondsPer100px(120), 30);
    assert.equal(seekSecondsPer100px(600), 30);
    assert.equal(seekDeltaSeconds(100, 300), 30);
  });
  check(">600s：60s/100px", () => {
    assert.equal(seekSecondsPer100px(601), 60);
    assert.equal(seekSecondsPer100px(3600), 60);
    assert.equal(seekDeltaSeconds(100, 1800), 60);
  });
  check("未知片长按 30s/100px 兜底", () => {
    assert.equal(seekSecondsPer100px(0), 30);
    assert.equal(seekSecondsPer100px(Number.NaN), 30);
  });
  check("长片不再一滑几百秒：1800s 片子滑 100px 从 458s 降到 60s", () => {
    const oldStyle = (100 / 393) * 1800; // 旧实现：按屏宽百分比换秒
    assert.ok(oldStyle > 400);
    assert.equal(seekDeltaSeconds(100, 1800), 60);
  });
  check("30s 短片滑 100px 恰好半集（15s），不超过半集", () => {
    assert.ok(seekDeltaSeconds(100, 30) <= 30 / 2);
  });
  check("短滑 <20px 不 seek", () => {
    assert.equal(canSeek(19), false);
    assert.equal(canSeek(-19), false);
    assert.equal(canSeek(20), true);
    assert.equal(canSeek(-21), true);
  });
  check("松手吸附到整 5s 并夹在 [0,total]", () => {
    assert.equal(snapSeek(63.2, 300), 65);
    assert.equal(snapSeek(62.4, 300), 60);
    assert.equal(snapSeek(-8, 300), 0);
    assert.equal(snapSeek(999, 300), 300);
  });

  console.log("[单击容差 tapSlop]");
  check("位移 3px 且 200ms 内 → tap", () => {
    assert.equal(tapVerdict(3, 0, 200), "tap");
    assert.equal(tapVerdict(0, 3, 120), "tap");
    assert.equal(tapVerdict(2, 2, 299), "tap");
  });
  check("位移 6/8/9px 的微动 → none（不 tap、不 seek、不换集）", () => {
    assert.equal(tapVerdict(6, 0, 120), "none");
    assert.equal(tapVerdict(8, 0, 120), "none");
    assert.equal(tapVerdict(9, 0, 120), "none");
    assert.equal(tapVerdict(5, 5, 120), "none"); // 欧氏距离 ≈7.07
  });
  check("超过 300ms 的长按 → 不是 tap", () => {
    assert.equal(tapVerdict(2, 2, 301), "none");
    assert.equal(tapVerdict(0, 0, 800), "none");
  });

  console.log("[双击]");
  check("三分法 + 5s：左 −5s / 中 不 seek / 右 +5s", () => {
    assert.equal(doubleTapSeek(10, 393), -5);
    assert.equal(doubleTapSeek(392, 393), 5);
    /* 正中（原先是 +10s）现在是中区：不 seek，走播放/暂停 */
    assert.equal(doubleTapSeek(197, 393), 0);
    assert.equal(doubleTapAction(197, 393).kind, "toggle");
  });
  check("窗口 280ms：280 内成立，281 不成立", () => {
    assert.equal(isDoubleTap(1000, 1280), true);
    assert.equal(isDoubleTap(1000, 1281), false);
    assert.equal(isDoubleTap(0, 100), false);
  });

  console.log("[边缘返回]");
  check("左缘 24px 内起手才算边缘", () => {
    assert.equal(isEdgeBackStart(0), true);
    assert.equal(isEdgeBackStart(24), true);
    assert.equal(isEdgeBackStart(25), false);
  });
  check("边缘右滑到 72px 才真的退一层", () => {
    const a = judgeGesture({ dx: 40, dy: 2, dt: 200, startX: 10, stageWidth: 393, stageHeight: 851, total: 300 });
    assert.equal(a.action.kind, "none");
    const b = judgeGesture({ dx: 80, dy: 2, dt: 200, startX: 10, stageWidth: 393, stageHeight: 851, total: 300 });
    assert.equal(b.action.kind, "edge-back");
  });
  check("非边缘起手的右滑仍是 seek", () => {
    const r = judgeGesture({ dx: 120, dy: 3, dt: 300, startX: 200, stageWidth: 393, stageHeight: 851, total: 300 });
    assert.equal(r.action.kind, "seek");
    assert.equal(Math.round(r.action.seconds), 36);
  });
  check("边缘左滑（反方向）不返回，走 seek", () => {
    const r = judgeGesture({ dx: -120, dy: 3, dt: 300, startX: 5, stageWidth: 393, stageHeight: 851, total: 300 });
    assert.equal(r.action.kind, "seek");
  });

  console.log("[上下滑换集]");
  check("24% 舞台高才提交，12% 出预览（边界）", () => {
    const h = 800;
    assert.equal(episodeIntent(-191, h).commit, false);   // 23.9%：差 1px 不提交
    assert.equal(episodeIntent(-192, h).commit, true);    // 24% 整：达到门槛
    assert.equal(episodeIntent(-300, h).commit, true);    // 37.5% 已过门槛
    assert.equal(episodeIntent(-95, h).preview, false);   // 11.9%：还不出预览
    assert.equal(episodeIntent(-96, h).preview, true);    // 12% 整：出预览
    assert.equal(episodeIntent(-560, h).commit, true);
    /* 速度辅助（3.0.13：≥500px/s + 位移 ≥40px，快速短滑也能切） */
    assert.equal(episodeIntent(-180, h, 900).commit, true);
    assert.equal(episodeIntent(-120, h, 900).commit, true);
    assert.equal(episodeIntent(-60, h, 900).commit, true);
    assert.equal(episodeIntent(-41, h, 500).commit, true);
    /* 抖一下（位移 8px / 39px）即使速度很快也不切 */
    assert.equal(episodeIntent(-8, h, 2000).commit, false);
    assert.equal(episodeIntent(-39, h, 4000).commit, false);
    /* 速度不够（<500px/s）时只看位移门槛 */
    assert.equal(episodeIntent(-120, h, 300).commit, false);
    assert.equal(episodeIntent(-120, h, 499).commit, false);
  });
  check("跟手 1:1，到边界 0.35（translateY 直接用它）", () => {
    assert.equal(episodeDrag(-120, false), -120);
    assert.equal(episodeDrag(120, false), 120);
    assert.equal(episodeDrag(-120, true), -42);
    assert.equal(episodeDrag(120, true), 42);
  });
  check("上滑=下一集(1)，下滑=上一集(-1)", () => {
    assert.equal(episodeIntent(-300, 800).dir, 1);
    assert.equal(episodeIntent(300, 800).dir, -1);
  });

  check("控件收起时长：全屏与竖屏统一 3s（全屏专属 1.2s 已删）", () => {
    assert.equal(PLAYER_TIMING.autohideMs, 3000);
    assert.equal("autohideFullscreenMs" in PLAYER_TIMING, false);
    assert.equal("autohideDelayMs" in G, false);
  });

  console.log("[旋转冷却]");
  check("方向变化后 300ms 内禁手势", () => {
    assert.equal(rotationLocked(1000, 1100), true);
    assert.equal(rotationLocked(1000, 1300), false);
    assert.equal(rotationLocked(0, 5000), false);
  });

  console.log("[整条链路 judgeGesture]");
  check("死区内不产生动作", () => {
    const r = judgeGesture({ dx: 6, dy: 5, dt: 100, startX: 100, stageWidth: 393, stageHeight: 851, total: 300 });
    assert.equal(r.axis, "none");
    assert.equal(r.action.kind, "none");
  });
  check("横向锁死后纵向大位移也不改判（仍是 seek）", () => {
    const r = judgeGesture({ dx: 90, dy: 300, dt: 400, startX: 200, axis: "x", stageWidth: 393, stageHeight: 851, total: 300 });
    assert.equal(r.action.kind, "seek");
  });
  check("全屏态左缘右滑 = seek（不是 edge-back）", () => {
    const r = judgeGesture({ dx: 100, dy: 2, dt: 200, startX: 10, stageWidth: 393, stageHeight: 851, total: 300, fullscreen: true });
    assert.equal(r.action.kind, "seek");
    /* 全屏里从左边起手想快退，绝不能退全屏 */
    assert.notEqual(r.action.kind, "edge-back");
  });
  check("非全屏态同样参数仍是 edge-back", () => {
    const r = judgeGesture({ dx: 100, dy: 2, dt: 200, startX: 10, stageWidth: 393, stageHeight: 851, total: 300 });
    assert.equal(r.action.kind, "edge-back");
  });
  check("竖向 → episode 且未过门槛不给 commit", () => {
    const r = judgeGesture({ dx: 4, dy: -100, dt: 300, startX: 200, stageWidth: 393, stageHeight: 851, total: 300 });
    assert.equal(r.action.kind, "episode");
    assert.equal(r.action.commit, false);
    assert.equal(r.action.dir, 1);
  });

  console.log("[双击三分区]");
  const W = 393;
  check("zoneSplit 常量 = 1/3", () => {
    assert.equal(GESTURE.zoneSplit, 1 / 3);
  });
  check("x = W/3 - 1 → 左区，双击 −5s", () => {
    const x = W / 3 - 1;
    assert.equal(tapZone(x, W), "left");
    assert.equal(doubleTapAction(x, W).kind, "seek");
    assert.equal(doubleTapAction(x, W).seconds, -5);
  });
  check("x = W/3 → 中区（边界归中），双击 = 播放/暂停", () => {
    const x = W / 3;
    assert.equal(tapZone(x, W), "mid");
    assert.equal(doubleTapAction(x, W).kind, "toggle");
  });
  check("x = 2W/3 - 1 → 中区，仍是播放/暂停", () => {
    const x = (2 * W) / 3 - 1;
    assert.equal(tapZone(x, W), "mid");
    assert.equal(doubleTapAction(x, W).kind, "toggle");
  });
  check("x = 2W/3 → 右区，双击 +5s", () => {
    const x = (2 * W) / 3;
    assert.equal(tapZone(x, W), "right");
    assert.equal(doubleTapAction(x, W).kind, "seek");
    assert.equal(doubleTapAction(x, W).seconds, 5);
  });
  check("中区双击不出 seek（旧 doubleTapSeek 返回 0）", () => {
    assert.equal(doubleTapSeek(W / 2, W), 0);
    assert.equal(doubleTapSeek(10, W), -5);
    assert.equal(doubleTapSeek(W - 10, W), 5);
  });

  console.log("[双击 seek 相对位移，不吸附]");
  check("t=12.4 双击左 −5s → 7.4（原来被吸附成 5）", () => {
    assert.equal(relativeSeek(12.4, -5, 300), 7.4);
  });
  check("t=12.4 双击右 +5s → 17.4", () => {
    assert.equal(relativeSeek(12.4, 5, 300), 17.4);
  });
  check("t=3 双击左 −5s → 夹到 0", () => {
    assert.equal(relativeSeek(3, -5, 300), 0);
  });
  check("t=duration-2 双击右 +5s → 夹到 duration", () => {
    assert.equal(relativeSeek(298, 5, 300), 300);
  });
  check("保留 0.1s 精度：7.35 → 2.35", () => {
    assert.equal(relativeSeek(7.35, -5, 300), 2.4);
  });

  

/* ===== 3.0.9：上下滑跟手换集的门槛与阻尼 ===== */
  console.log("[跟手换集·3.0.9]");
  check("速度门槛 499 不提交 / 500 提交（3.0.13：0.5px/ms）", () => {
    const h = 800;
    assert.equal(episodeIntent(-160, h, 499).commit, false);
    assert.equal(episodeIntent(-160, h, 500).commit, true);
  });
  check("跟手阻尼：普通 1:1，边界 0.35（3.0.13）", () => {
    assert.equal(episodeDrag(100, false), 100);
    assert.equal(episodeDrag(100, true), 35);
    assert.equal(episodeDrag(-100, false), -100);
    assert.equal(episodeDrag(-100, true), -35);
  });
  check("整页 pager：300ms 吸附 / 200ms 回弹 / 160ms 文字淡出 / 150ms 无障碍", () => {
    assert.equal(GESTURE.episodeCommitMs, 300);
    assert.equal(GESTURE.episodeReboundMs, 200);
    assert.equal(GESTURE.episodeTitleFadeMs, 160);
    assert.equal(GESTURE.episodeReducedMotionMs, 150);
    assert.equal(EPISODE_EASE, "cubic-bezier(.16,1,.3,1)");
  });
  check("翻页进度 0..1（位移/舞台高，夹住不溢出）", () => {
    assert.equal(episodePageProgress(0, 800), 0);
    assert.equal(episodePageProgress(-200, 800), 0.25);
    assert.equal(episodePageProgress(400, 800), 0.5);
    assert.equal(episodePageProgress(-1600, 800), 1);
    assert.equal(episodePageProgress(-100, 0), 0);
  });
  check("提交/回弹时长常量", () => {
    assert.equal(GESTURE.episodeCommitMs, 300);
    assert.equal(GESTURE.episodeReboundMs, 200);
    assert.equal(GESTURE.episodePreview, 0.12);
    assert.equal(GESTURE.episodeSwitch, 0.24);
  });

console.log(`\nPassed: ${passed} 项手势判定单测`);
} finally {
  await vite.close();
}
