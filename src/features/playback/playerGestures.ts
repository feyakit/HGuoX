/**
 * 播放器手势判定的**纯函数层**。
 *
 * 为什么单独抽出来：真机手势没法在 CI 里跑，所以把「死区 / 方向锁 / seek 量纲 /
 * 边缘返回 / 双击窗口 / 换集门槛 / 旋转冷却」这些纯算术拿出来单测
 * （见 scripts/test-player-gestures.mjs），组件里只负责把输入喂进来、把动作画出来。
 *
 * 坐标约定：所有函数吃掉的都是**舞台坐标**。全屏只走系统真转屏（伪横屏的 CSS 旋转舞台已删），
 * 所以舞台坐标恒等于屏幕坐标，组件里任何地方都不许再自己按宽高做换算。
 */

export const GESTURE = {
  /** 起手死区：位移没超过这个值之前不定方向（px） */
  deadZone: 10,
  /** 点击容差：总位移 < 6px 且时长 < 300ms 才算「单击」；
      6px ≤ 位移 < deadZone 的微动属于**无动作**（不 tap、不 seek、不换集） */
  tapSlop: 6,
  /** 单击的最长按压时长（ms） */
  tapMs: 300,
  /** 定方向比例：|dx| >= |dy|*1.4 判横，|dy| >= |dx|*1.4 判竖 */
  axisRatio: 1.4,
  /** 左缘返回区宽度（px，从舞台左边缘算） */
  edgeBack: 24,
  /** 左缘右滑生效距离（px）——超过才真的退一层，避免误触 */
  edgeBackCommit: 72,
  /** 双击窗口（ms） */
  doubleTapMs: 280,
  /** 双击 seek 步长（秒）：用户定 5s（原 10s 太跳） */
  doubleTapSeek: 5,
  /** 双击分区比例：左 1/3 快退、中 1/3 播放/暂停、右 1/3 快进 */
  zoneSplit: 1 / 3,
  /** 短滑不 seek 的最小位移（px） */
  minSeekPx: 20,
  /** 换集提交门槛：拖过屏高的 25% 就切（原来 40%，普通上滑只有 20–30% → 全部回弹） */
  episodeSwitch: 0.25,
  /** 换集辅助判定：手势速度超过这个值（px/s）也算提交（短促一划即可，和首页切 tab 一致） */
  episodeVelocity: 600,
  /** 速度辅助的最小位移（px）：低于它即使很快也不切，避免 120px 轻甩误切 */
  episodeVelocityMinPx: 160,
  /** 跟手阻尼：普通 / 到边界 */
  episodeDamp: 0.85,
  episodeEdgeDamp: 0.35,
  /** 松手后的动画时长 */
  /* 整页 pager：松手吸附 300ms，先快后缓（.16,1,.3,1），不要 ease-out 那种"一上来就慢"的手感 */
  episodeCommitMs: 300,
  episodeReboundMs: 180,
  /** 标题/进度条在翻页中的淡出淡入 */
  episodeTitleFadeMs: 160,
  /** prefers-reduced-motion 下退化成的淡入时长 */
  episodeReducedMotionMs: 150,
  /** 换集预览门槛：拖过屏高的 70% 才露预览 */
  episodePreview: 0.12,
  /** 松手吸附到整 5 秒 */
  snapSeconds: 5,
  /** 方向切换动画期间禁手势（ms） */
  rotateLockMs: 300,
  /** seek 提示气泡停留（ms） */
  seekBubbleMs: 800,
} as const;

export type Axis = "none" | "x" | "y";

export type GestureAction =
  | { kind: "none" }
  | { kind: "tap"; x: number }
  | { kind: "double-tap"; seconds: number }
  | { kind: "edge-back" }
  | { kind: "seek"; seconds: number }
  | { kind: "episode"; dir: 1 | -1; commit: boolean; preview: boolean };

/**
 * 方向锁：超过死区后按 1.4 倍比例定轴，**定下即锁死**（同一手势内不再改判）。
 * 两个比例都不满足（斜着 45°）时继续等，返回 "none"。
 */
export function lockAxis(prev: Axis, dx: number, dy: number): Axis {
  if (prev !== "none") return prev;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax <= GESTURE.deadZone && ay <= GESTURE.deadZone) return "none";
  if (ax >= ay * GESTURE.axisRatio) return "x";
  if (ay >= ax * GESTURE.axisRatio) return "y";
  return "none";
}

/**
 * 横向拖动 100px 对应多少秒：按片长自适应。
 * <=60s → 15s，60–600s → 30s，>600s → 60s。未知片长按 30s 处理。
 */
export function seekSecondsPer100px(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 30;
  if (total <= 60) return 15;
  if (total <= 600) return 30;
  return 60;
}

/** 横向位移换算成秒（带方向：右为正） */
export function seekDeltaSeconds(dx: number, total: number): number {
  return (dx / 100) * seekSecondsPer100px(total);
}

/** 短滑（<20px）不触发 seek */
export function canSeek(dx: number): boolean {
  return Math.abs(dx) >= GESTURE.minSeekPx;
}

/** 松手吸附到整 5 秒，并夹在 [0, total] */
export function snapSeek(seconds: number, total: number): number {
  const step = GESTURE.snapSeconds;
  const snapped = Math.round(seconds / step) * step;
  const upper = Number.isFinite(total) && total > 0 ? total : snapped;
  return Math.max(0, Math.min(upper, snapped));
}

/** 双击：左半屏 −10s，右半屏 +10s */
export type TapZone = "left" | "mid" | "right";

/**
 * 双击三分区：左 1/3 快退、中 1/3 播放/暂停、右 1/3 快进。
 * 中区留白是为了让「中间点两下」不会莫名跳进度（原来左右对半分，半屏都能 seek，区域太大）。
 */
export function tapZone(x: number, stageWidth: number): TapZone {
  const width = Number.isFinite(stageWidth) && stageWidth > 0 ? stageWidth : 0;
  if (!width) return "mid";
  const split = width * GESTURE.zoneSplit;
  if (x < split) return "left";
  if (x >= width - split) return "right";
  return "mid";
}

/** 双击动作：左右区返回 seek 秒数（负=快退），中区返回 null 表示「切换播放/暂停」 */
export function doubleTapAction(x: number, stageWidth: number): { kind: "seek"; seconds: number } | { kind: "toggle" } {
  const zone = tapZone(x, stageWidth);
  if (zone === "mid") return { kind: "toggle" };
  return { kind: "seek", seconds: zone === "left" ? -GESTURE.doubleTapSeek : GESTURE.doubleTapSeek };
}

/** 兼容旧调用：中区返回 0（调用方据此不出 seek） */
export function doubleTapSeek(x: number, stageWidth: number): number {
  const action = doubleTapAction(x, stageWidth);
  return action.kind === "seek" ? action.seconds : 0;
}

/**
 * 双击/按钮的**相对 seek**：base ± delta，夹在 [0, total]，保留 0.1s 精度。
 * **不吸附**整 5s —— 吸附会让「退 5s」实际退 7.4s（12.4 → 7.4 → 吸附到 5）。
 * 吸附只留给横滑拖动（那里要整 5s 好对齐）。
 */
export function relativeSeek(base: number, delta: number, total = 0): number {
  const from = Number.isFinite(base) ? base : 0;
  const upper = total > 0 ? total : from + delta;
  const raw = Math.max(0, Math.min(upper, from + delta));
  /* +1e-6 抵消 7.35−5=2.3499999 这类浮点误差，保证「保留 0.1s」是四舍五入而不是被抹掉 */
  return Math.round(raw * 10 + 1e-6) / 10;
}

/** 是否从左缘返回区起手（按舞台内坐标，非屏幕坐标） */
export function isEdgeBackStart(localX: number): boolean {
  return localX <= GESTURE.edgeBack;
}

/**
 * 单击判定。总位移（欧氏距离）与时长一起看：
 *   · 位移 < tapSlop(6px) 且时长 < tapMs(300ms) → "tap"
 *   · 其余一律 "none" —— 特别是 6–10px 的微动：过不了死区（不会 seek/换集），
 *     但也不该被当成单击（以前 6–8px 的抖动会把视频暂停，手感很怪）。
 */
export function tapVerdict(dx: number, dy: number, dt: number): "tap" | "none" {
  if (dt > GESTURE.tapMs) return "none";
  return Math.hypot(dx, dy) < GESTURE.tapSlop ? "tap" : "none";
}

/** 双击是否成立：与上次点击间隔在窗口内 */
export function isDoubleTap(lastTapAt: number, now: number): boolean {
  return lastTapAt > 0 && now - lastTapAt <= GESTURE.doubleTapMs;
}

/** 方向切换动画期间（orientationchange 后 300ms）禁一切手势 */
export function rotationLocked(changedAt: number, now: number): boolean {
  if (!changedAt) return false;
  return now - changedAt < GESTURE.rotateLockMs;
}

/**
 * 上下滑换集：dy<0（上滑）= 下一集，dy>0（下滑）= 上一集。
 * commit 门槛 25% 屏高或速度 ≥600px/s，preview 门槛 12% 屏高（过了才出预览文案）。
 */
/**
 * 拖动时的跟手位移（带阻尼，直接拿来当 translateY）：
 * 正常 0.85（手指走 100，画面走 85，跟手但不过冲）；到第一/最后一集 0.35（拉得动但拉不走）。
 */
export function episodeDrag(dy: number, atEdge: boolean): number {
  return dy * (atEdge ? GESTURE.episodeEdgeDamp : GESTURE.episodeDamp);
}

export function episodeIntent(
  dy: number,
  stageHeight: number,
  velocity = 0,
): { dir: 1 | -1; commit: boolean; preview: boolean } {
  const dir: 1 | -1 = dy <= 0 ? 1 : -1;
  const height = Number.isFinite(stageHeight) && stageHeight > 0 ? stageHeight : 0;
  const ratio = height ? Math.abs(dy) / height : 0;
  /* 两种提交方式：拖过 25% 屏高，或者速度够快（≥600px/s）且确实动了（>12px，避免抖一下就切） */
  const fast = Math.abs(velocity) >= GESTURE.episodeVelocity && Math.abs(dy) >= GESTURE.episodeVelocityMinPx;
  return {
    dir,
    commit: ratio >= GESTURE.episodeSwitch || fast,
    preview: ratio >= GESTURE.episodePreview,
  };
}

/**
 * 一次手势的总判定（给组件用，也方便单测整条链路）。
 * 输入都是舞台坐标；previousAxis 用于锁方向。
 */
export function judgeGesture(input: {
  dx: number;
  dy: number;
  dt: number;
  startX: number;
  stageWidth: number;
  stageHeight: number;
  total: number;
  axis?: Axis;
  held?: boolean;
  /** 全屏/沉浸态：左缘返回不启用（否则从左侧起手 seek 会直接退全屏）。缺省 false，向后兼容。 */
  fullscreen?: boolean;
}): { axis: Axis; action: GestureAction } {
  const axis = input.axis && input.axis !== "none"
    ? input.axis
    : input.held
      ? "none"
      : lockAxis("none", input.dx, input.dy);
  if (axis === "none") return { axis, action: { kind: "none" } };

  if (axis === "x") {
    if (!input.fullscreen && isEdgeBackStart(input.startX) && input.dx > 0) {
      return {
        axis,
        action: input.dx >= GESTURE.edgeBackCommit ? { kind: "edge-back" } : { kind: "none" },
      };
    }
    if (!canSeek(input.dx)) return { axis, action: { kind: "none" } };
    return { axis, action: { kind: "seek", seconds: seekDeltaSeconds(input.dx, input.total) } };
  }

  const ep = episodeIntent(input.dy, input.stageHeight);
  return { axis, action: { kind: "episode", dir: ep.dir, commit: ep.commit, preview: ep.preview } };
}

/**
 * 控件自动收起的时长（ms）。**全屏与竖屏统一 3s**：原来全屏单独给 1.2s，
 * 结果同一个「轻点唤出」在两种状态下手感不一样，真机上表现为「刚点出来就没了」。
 * 任何交互都会重新起算（组件里 showControls/armAutoHide 都读这个常量）。
 */
export const PLAYER_TIMING = { autohideMs: 3000 } as const;

/** 翻页吸附曲线：先快后缓的减速感（对标抖音/红果的上下翻页） */
export const EPISODE_EASE = "cubic-bezier(.16,1,.3,1)";

/**
 * 翻页过程中当前页的形变：位移越大越缩小、越淡（1 → .96 / 1 → .55）。
 * 返回 0..1 的进度，组件自己乘系数，保持与常量解耦。
 */
export function episodePageProgress(dy: number, stageHeight: number): number {
  if (!stageHeight || !Number.isFinite(stageHeight)) return 0;
  return Math.min(1, Math.abs(dy) / stageHeight);
}

