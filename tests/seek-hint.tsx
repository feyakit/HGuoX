/**
 * 双击快进/快退提示的对照台（v3.0.11 提方案用）。
 *
 * ?v=after   → 挂**真组件** SeekHint（本次改动后的样子）；
 * ?v=before  → 逐字复刻 v3.0.10 被删掉的那段内联 JSX（同样的 class、同样的内联样式），
 *              用的是同一份 index.css 与同一张真机画面当底，所以差别只在「提示本身」。
 * ?side=left|right 选左快退/右快进；
 * 底图是 720×1280 的播放页实拍（tests/assets/seekbg.jpg），按设备 CSS 尺寸 360×640/640×360 摆放。
 *
 * 说明：before 不是「运行时回滚」，而是把被删代码原样搬回来渲染 —— 旧代码的几何全是常量
 * （top 25% / left 16 / width calc(33.333% - 32px)），复刻结果与 v3.0.10 逐像素一致。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { SeekHint } from "../src/features/playback/SeekHint";
import "../src/index.css";

const q = new URLSearchParams(location.search);
const V = q.get("v") === "before" ? "before" : "after";
const SIDE = q.get("side") === "left" ? "left" : "right";

/** v3.0.10 原样（src/features/playback/EpisodePlayer.tsx@6558fcf 第 2363-2383 行） */
function Before() {
  return (
    <div
      className="absolute z-30 flex pointer-events-none"
      style={{
        top: "25%",
        transform: "translateY(-50%)",
        ...(SIDE === "left"
          ? { left: 16, width: "calc(33.333% - 32px)", justifyContent: "center" }
          : { right: 16, width: "calc(33.333% - 32px)", justifyContent: "center" }),
      }}
    >
      <div className="hg-chip hg-ink px-3 py-2 rounded-full flex items-center gap-2 backdrop-blur-md elev-2 max-w-full">
        <span className="text-[15px] font-bold tabular-nums whitespace-nowrap">
          {SIDE === "left" ? "−" : "+"}5s
        </span>
        <span className="text-[12px] hg-ink-4 tabular-nums whitespace-nowrap">1:23</span>
      </div>
    </div>
  );
}

/** ?both=1：同一屏同时挂左右两个提示 —— 用来证明两侧同高、左右对称（一张图一条基线就能看出来） */
const BOTH = q.get("both") === "1";

function Root() {
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "#000" }}>
      <div style={{ position: "absolute", inset: 0, background: "url(/tests/assets/seekbg.jpg) center/cover no-repeat" }} />
      {V === "before"
        ? <Before />
        : BOTH
          ? <><SeekHint delta={-5} side="left" /><SeekHint delta={5} side="right" /></>
          : <SeekHint delta={SIDE === "left" ? -5 : 5} side={SIDE} />}
    </div>
  );
}

createRoot(document.querySelector("#root")!).render(<Root />);
