import { startTransition, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { addPluginListener } from "@tauri-apps/api/core";
import { platform } from "../../shared/api/api";
import { holdBackForStartup } from "../../shared/lib/back";
import "../../styles/launch.css";

// One reveal per WebView lifetime, including StrictMode and subsequent App remounts.
let launchCompleted = false;

/** 动画收尾时摘掉 index.html 的启动锁：底色不再被 !important 钉住，主题色交回应用。
 *  （上游 0a66791 的 releaseLaunchSurface；我们从 HTML 起步就是品牌深色，所以只需解锁，不用改色。） */
function releaseLaunchSurface() {
  document.documentElement.removeAttribute("data-hg-launching");
}
export const LAUNCH_DURATION = 2200;

/** Exact public/logo.svg geometry, split into independent spring-animated strokes. */
export function LaunchAnimation({ onFinish }: { onFinish: () => void }) {
  const gradient = useId();
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const complete = useRef(false);
  const finish = useCallback(() => {
    if (complete.current) return;
    complete.current = true;
    finishRef.current();
  }, []);

  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const timer = window.setTimeout(finish, motion.matches ? 200 : LAUNCH_DURATION + 120);
    const onMotion = () => { if (motion.matches) finish(); };
    const onHidden = () => { if (document.visibilityState === "hidden") finish(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(); }
    };
    motion.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("keydown", onKey, true);
    onHidden();
    return () => {
      window.clearTimeout(timer);
      motion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [finish]);

  useEffect(() => {
    if (platform !== "android") return;
    let disposed = false;
    let listener: { unregister: () => Promise<void> } | undefined;
    void addPluginListener("app", "back-button", finish).then(handle => {
      if (disposed) void handle.unregister().catch(() => {});
      else listener = handle;
    }).catch(() => {});
    return () => { disposed = true; void listener?.unregister().catch(() => {}); };
  }, [finish]);

  return <div className="hg-launch" role="dialog" aria-modal="true" aria-label="HGuoX 启动动画"
    onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === "launch-exit") finish(); }}>
    <div className="hg-launch-stage" aria-hidden="true">
      <div className="hg-launch-orbit" />
      <div className="hg-launch-mark">
        <svg className="hg-launch-svg" viewBox="0 0 256 256" fill="none">
          <defs>
            <radialGradient id={`${gradient}-a1`} cx="20%" cy="0%" r="75%">
              <stop offset="0%" stopColor="#E87648" stopOpacity=".36" />
              <stop offset="100%" stopColor="#0A0B14" stopOpacity="0" />
            </radialGradient>
            <radialGradient id={`${gradient}-a2`} cx="85%" cy="5%" r="75%">
              <stop offset="0%" stopColor="#7C5CFF" stopOpacity=".42" />
              <stop offset="100%" stopColor="#0A0B14" stopOpacity="0" />
            </radialGradient>
            <linearGradient id={`${gradient}-flow`} x1="0" y1="0.2" x2="1" y2="0.8">
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="42%" stopColor="#FFB347" />
              <stop offset="72%" stopColor="#FF6B57" />
              <stop offset="100%" stopColor="#7C5CFF" />
            </linearGradient>
            <linearGradient id={`${gradient}-glass`} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity=".88" />
              <stop offset="50%" stopColor="#C4B5FD" stopOpacity=".45" />
              <stop offset="100%" stopColor="#9B7BFF" stopOpacity=".88" />
            </linearGradient>
            <clipPath id={`${gradient}-clip`}>
              <rect width="256" height="256" rx="58" />
            </clipPath>
          </defs>
          <g className="hg-launch-tile" clipPath={`url(#${gradient}-clip)`}>
            <rect width="256" height="256" fill="#0A0B14" />
            <rect width="256" height="256" fill={`url(#${gradient}-a1)`} />
            <rect width="256" height="256" fill={`url(#${gradient}-a2)`} />
            <rect x="2" y="2" width="252" height="252" rx="56" stroke="#FFFFFF" strokeOpacity=".14" strokeWidth="2.5" />
          </g>
          <line className="hg-launch-stroke hg-launch-left" x1="60" y1="72" x2="60" y2="184" stroke="#FFFFFF" strokeWidth="24" strokeLinecap="round" />
          <path className="hg-launch-stroke hg-launch-right" d="M 118 72 L 118 184 M 118 176 C 118 148, 152 114, 198 72"
            stroke={`url(#${gradient}-glass)`} strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
          <path className="hg-launch-stroke hg-launch-bridge" d="M 60 128 L 98 128 C 114 128, 118 116, 118 96 C 118 74, 138 74, 152 96 L 198 184"
            stroke={`url(#${gradient}-flow)`} strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="hg-launch-wordmark"><span>HGuoX</span></div>
    </div>
    <span className="hg-launch-footnote" aria-hidden="true">好剧与吃瓜 · 尽在掌握</span>
  </div>;
}

/** Children mount once the reveal finishes. 3.0.0 起不再有首启「条款闸门」：动画演完直接进主界面。
 *
 * 3.0.7 性能：孩子**在动画期间就开始挂载**（动画是不透明全屏层，z-index 10000，看不到下面），
 * 于是「拉首页数据 + React 首次渲染」和 2.2s 的品牌动画并行跑；动画一收尾内容已经在，
 * 不再出现「动画结束 → 空白 500ms → 才出第一张卡」。动画时长、样式、节奏一个像素没动。 */
export default function StartupGate({ children }: { children: ReactNode }) {
  const [finished, setFinished] = useState(() => launchCompleted);
  /* 两阶段挂载（上游 0a66791）：首帧只提交动画本身，让它先独占合成线程；
     下一帧再把 App 挂上来（startTransition 让这次大渲染可被打断）。
     以前是同一帧里既挂动画又挂整棵树，首帧要等首页首次渲染跑完才开始动。 */
  const [mountChildren, setMountChildren] = useState(() => launchCompleted);
  const finish = useCallback(() => {
    launchCompleted = true;
    releaseLaunchSurface();
    setMountChildren(true);
    setFinished(true);
  }, []);
  /* 动画期间 App 已经挂在下面（3.0.7 起就是这结构），返回键必须先归动画：
     遮罩卸载时自动释放；StrictMode 下靠幂等释放保证计数正确。 */
  useEffect(() => (!finished ? holdBackForStartup() : undefined), [finished]);

  /* 第二帧才挂 App：requestAnimationFrame 保证动画这一帧已经提交。 */
  useEffect(() => {
    if (finished || mountChildren) return;
    const frame = window.requestAnimationFrame(() => {
      startTransition(() => setMountChildren(true));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [finished, mountChildren]);

  /* 已经播过的会话（launchCompleted）直接是完成态，但 HTML 上的启动锁要顺手摘掉。 */
  useEffect(() => { if (finished) releaseLaunchSurface(); }, [finished]);
  /* 两边都返回**同一个 Fragment**，children 永远在第 2 位上。
     3.0.20 的写法是「未完成 → <><动画/>{children}</>，完成 → children」：
     根节点类型一变（Fragment → App），React 会把 AppProvider + App + Home 整棵子树
     卸载再重挂 —— 首屏因此跑两遍（api_feed 两条、8 个 banner 详情各两条、
     `[net] first content` 两条），在途请求也跨了两个 React 实例。
     动画只该卸载它自己。 */
  return (
    <>
      {finished ? null : <LaunchAnimation onFinish={finish} />}
      {mountChildren && children}
    </>
  );
}
