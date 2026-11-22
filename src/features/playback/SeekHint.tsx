import { IChevR } from "../../shared/ui/icons";

/** 双击快进/快退的瞬时提示（v3.0.11 方案 A：黑胶囊 + 单箭头）。
 *
 *  为什么单独成组件：这段提示原来内联在 EpisodePlayer 里（3.0.9 起的旧位置是「屏高 25%、
 *  左/右 1/3 区居中」，圆角胶囊样式也很薄），用户报「位置不对、样式也丑」。抽出来以后
 *  tests/seek-hint.tsx 能用真组件量几何，播放页只留一行挂载。
 *
 *  几何（全部来自既定口径，不在这里再做设计判断）：
 *   · 垂直：画面 38% 处居中（中线偏上，避开中央播放键与底部控制条）；
 *   · 水平：左提示在左 1/4 区居中、右提示在右 1/4 区居中（锚点容器各占 25% 宽）；
 *   · 胶囊：高 28、圆角 999、rgba(0,0,0,.62) + 8px 模糊、字号 15、内边距 12×6；
 *   · 动效：120ms 淡入 → 停留 600ms → 200ms 淡出（父级 800ms 卸载，与 GESTURE.seekBubbleMs 对齐）。
 *  文案用真实跳转秒数（双击 ±5s），不写死 10s —— 气泡上的数必须和实际跳一致。 */
export function SeekHint({ delta, side }: { delta: number; side: "left" | "right" }) {
  const secs = Math.max(1, Math.round(Math.abs(delta)));
  const right = side === "right";
  return (
    <div
      data-hg-control="seekhint"
      className="absolute z-30 flex"
      style={{
        top: "38%",
        left: right ? "75%" : "0%",
        width: "25%",
        transform: "translateY(-50%)",
        /* 到边距夹逼：<=16px 就贴 16（原「1/4 区居中」在 86 宽气泡上只剩 1.88px，贴死了）。
           规则 left/right = max(16, 四分之一区居中值)；当前宽度按居中算只有 1.88，所以取 16。
           气泡比 1/4 区减去 16 后还宽，这里显式不收缩（flexShrink:0）让它向画面中心溢出，
           宁可越过 1/4 区边界，也不压字号、不裁字。 */
        justifyContent: right ? "flex-end" : "flex-start",
        paddingLeft: right ? 0 : 16,
        paddingRight: right ? 16 : 0,
        pointerEvents: "none",
      }}
    >
      <div className="hg-seekhint" style={{ flexShrink: 0 }}>
        <span className={right ? "hg-seekhint-arrow" : "hg-seekhint-arrow hg-seekhint-flip"} aria-hidden="true">
          <IChevR size={13} />
        </span>
        <span className="hg-num whitespace-nowrap">{right ? "+" : "−"}{secs} 秒</span>
      </div>
    </div>
  );
}
