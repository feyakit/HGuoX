/**
 * 方向提示验收台（3.0.22：用户「每切换一级都弹『系统未允许锁定屏幕方向』」）。
 *
 * 真 EpisodePlayer + 真 store + 真 ToastHost + 真 CSS，只 mock Tauri IPC。
 * 平台由 UA 决定（`platform` 在模块加载时算出来），所以脚本要给 iOS / 安卓各开一个 context。
 *
 *   ?fail=1|0   set_orientation 恒 reject / 恒 resolve（默认 1）
 *   ?src=port|land  片源宽高（port=720×1280 竖版，land=1280×720 横版）
 *   ?eps=N      集数
 *
 * 触发「切换一级」的方式与刷剧流一致：换片源 id（curId 变）→ 组件里 `curId:want` 的去重键变化
 * → 重跑「按片源锁方向」那条 effect。window.__nextDrama() 模拟上滑换一部剧。
 *
 * 数提示不用组件内部状态：用 MutationObserver 数 [role=status] 槽里**真的插进来过**的提示条，
 * 只保留与方向相关的文案（播放失败等其它提示不算）。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import EpisodePlayer from "../src/features/playback/EpisodePlayer";
import { AppProvider } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const q = new URLSearchParams(location.search);
const FAIL = q.get("fail") !== "0";
/* 3.0.22 方案 B：iOS 现在会真下发；失败原因由 Rust 返回错误码前缀。
   ?reject=locked → 「被系统竖排方向锁定拦住」（orientation_locked_by_user，走方案 C）
   ?reject=other  → 其它失败（老口径兜底） */
const REJECT = q.get("reject") === "other" ? "other" : "locked";
const SRC_KIND = q.get("src") === "land" ? "land" : "port";
const EPS = Math.max(2, Number(q.get("eps") || 6));
const PLAY_SRC = "http://127.0.0.1:9/never.m3u8";
const IDS_BASE = 991;

type Call = { cmd: string; args: Record<string, unknown> };
const calls: Call[] = [];
const invoke = (cmd: string, args: Record<string, unknown> = {}) => {
  calls.push({ cmd, args });
  if (cmd === "set_orientation") {
    if (!FAIL) return Promise.resolve(null);
    return REJECT === "locked"
      ? Promise.reject(new Error("orientation_locked_by_user: 系统方向锁拦下了转屏（UISceneError code=101: orientation locked）"))
      : Promise.reject(new Error("系统未允许转屏：orientation is locked"));
  }
  if (cmd === "app_boot") return Promise.resolve({ user: { id: 7, nickname: "验收" }, logged_in: true, base: "https://fixture.invalid" });
  if (cmd === "debug_log" || cmd === "playback_log_write") return Promise.resolve();
  if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
  if (cmd === "api_video") return Promise.resolve({ ...DETAIL, id: Number(args.id ?? IDS_BASE), title: `验收剧集${args.id ?? IDS_BASE}` });
  if (cmd === "api_play") return Promise.resolve({
    id: IDS_BASE, ep_num: Number(args.ep ?? 1), duration: 90, title: "验收剧集",
    video_url: "", streams: { main: PLAY_SRC },
  });
  if (cmd === "api_like") return Promise.resolve({ ok: true });
  if (cmd === "api_related") return Promise.resolve({ items: [] });
  if (cmd === "api_feed") return Promise.resolve({ items: [], pagination: { page: 1, pages: 0 } });
  return Promise.resolve(null);
};

const DETAIL = {
  id: IDS_BASE, title: "验收剧集", cover: "", tags: [], score: 0,
  episode_count: EPS, total_episodes: EPS, is_finished: 1, is_original: 0, is_hot: 0,
  like_count: 0, comment_count: 0, collect_count: 0, description: "",
  episodes: Array.from({ length: EPS }, (_, i) => ({ ep_num: i + 1, title: `第${i + 1}集`, duration: 90, status: 1 })),
  author: { id: 1, name: "验收作者" },
  counts: { like: 0, collect: 0, comment: 0, hot: 0 },
};

/* 提示计数（3.0.22 方案 C 之后分两类，不能混在一起数）：
     · toast：真的弹在 .ios-toast-host 里的临时提示；
     · card：播放页里那张可操作的「方向锁」说明卡（data-hg-control="orientation-lock-hint"，
       它自己是 role=status，但**不是** toast，不能算进 toast 条数）。
   只保留与方向相关的文案，播放失败等其它提示不算。 */
const HINT_RE = /锁定|横屏|竖屏|转屏|方向/;
const toasts: { text: string }[] = [];
const cards: { text: string }[] = [];
const observeToasts = () => {
  const seen = new Set<Element>();
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of Array.from(r.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (seen.has(node)) continue;
        const toastHost = node.closest(".ios-toast-host");
        /* 说明卡是「条件渲染的外层容器」插进来的，data 属性在内层节点上：
           所以既看 node 自己（closest），也看它子树（querySelector）。 */
        const card = node.closest('[data-hg-control="orientation-lock-hint"]')
          || node.querySelector('[data-hg-control="orientation-lock-hint"]');
        if (!toastHost && !card) continue;
        seen.add(node);
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || !HINT_RE.test(text)) continue;
        (card ? cards : toasts).push({ text });
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
};

Object.assign(window, { __TAURI_INTERNALS__: { invoke }, orientFixture: { calls, toasts, cards } });

/* 媒体打桩：无解码环境里 paused 恒 true，否则画面正中会渲染「继续播放」按钮挡点按。 */
const media = { paused: false };
(() => {
  try {
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return media.paused; } });
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) { media.paused = false; return (play && play.apply(this, a)) || Promise.resolve(); };
  } catch { /* ignore */ }
})();

/** 片源宽高打桩：每 120ms 给当前 <video> 盖一次元数据并派发 loadedmetadata。 */
function SourceStub() {
  React.useEffect(() => {
    const size = SRC_KIND === "land" ? [1280, 720] : [720, 1280];
    const timer = window.setInterval(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      if (!v) return;
      Object.defineProperty(v, "videoWidth", { configurable: true, get: () => size[0] });
      Object.defineProperty(v, "videoHeight", { configurable: true, get: () => size[1] });
      Object.defineProperty(v, "readyState", { configurable: true, get: () => 4 });
      v.dispatchEvent(new Event("loadedmetadata"));
      v.dispatchEvent(new Event("loadeddata"));
    }, 120);
    return () => window.clearInterval(timer);
  }, []);
  return null;
}

/* 换一部剧：外面只能通过这个入口（模拟刷剧流上滑）。 */
let nextDrama: (() => void) | null = null;
Object.assign(window, { __nextDrama: () => { nextDrama?.(); } });

function Page() {
  const [base, setBase] = React.useState(IDS_BASE);
  React.useEffect(() => { nextDrama = () => setBase((b) => b + 1); return () => { nextDrama = null; }; }, []);
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
        <EpisodePlayer videoIds={[base]} startIndex={0} title={`验收剧集${base}`} mode="context" kind="video" active bottomInset={0} />
      </div>
      <SourceStub />
      <ToastHost />
    </AppProvider>
  );
}

observeToasts();
createRoot(document.querySelector("#root")!).render(<Page />);
