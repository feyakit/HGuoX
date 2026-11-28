/**
 * 「切下一集时接口被请求两次」取证台（W97）。
 *
 * 只有一条目标：**给 api_play 计数**。所以这里是真 EpisodePlayer + 真 store + 真 CSS，
 * 只 mock Tauri IPC；api_play 每条都记账（时间 / id / ep / 第几次），
 * 并且按真实 CDN 的行为返回**每次都不同的地址**（token 每请求一变），
 * 这样「同一个 key 被请求两次 → <video> 的 src 被换两次 → 用户看到转两次圈」
 * 能在浏览器里被量化，而不用猜。
 *
 * 参数：
 *   ?eps=8        总集数
 *   ?stable=1     地址固定（用来把「请求次数」和「src 变化次数」分开）
 *   ?delay=300    api_play 的人工时延（ms），让「在途合并」有机会生效
 *   ?start=1      起播集数
 *   ?autoplay=0   不自动 dispatch playing（不触发预取）
 */
import React from "react";
import { createRoot } from "react-dom/client";
import EpisodePlayer from "../src/features/playback/EpisodePlayer";
import { AppProvider } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const q = new URLSearchParams(location.search);
const EPS = Math.max(2, Number(q.get("eps") || 8));
const STABLE = q.get("stable") === "1";
const DELAY = Math.max(0, Number(q.get("delay") || 300));
const START = Math.max(1, Number(q.get("start") || 1));
const AUTOPLAY = q.get("autoplay") !== "0";
const CUR_ID = 991;
const IDS = [CUR_ID];

type PlayCall = { t: number; id: number; ep: number; seq: number; url: string };
const playCalls: PlayCall[] = [];
const logs: string[] = [];
let playSeq = 0;
const callLog: string[] = [];

const detail = () => ({
  id: CUR_ID, title: "取证剧集", cover: "", tags: [], score: 0,
  episode_count: EPS, total_episodes: EPS, is_finished: 1, is_original: 0, is_hot: 0,
  like_count: 0, comment_count: 0, collect_count: 0, description: "",
  episodes: Array.from({ length: EPS }, (_, i) => ({ ep_num: i + 1, title: `第${i + 1}集`, duration: 90, status: 1 })),
  author: { id: 1, name: "取证作者" },
  counts: { like: 0, collect: 0, comment: 0, hot: 0 },
});

const invoke = (cmd: string, args: Record<string, unknown> = {}) => {
  callLog.push(cmd);
  if (cmd === "debug_log") {
    const msg = String(args.msg ?? "");
    if (msg) logs.push(msg);
    if (logs.length > 400) logs.shift();
    return Promise.resolve();
  }
  if (cmd === "app_boot") return Promise.resolve({ user: { id: 7, nickname: "取证" }, logged_in: true, base: "https://hg.localhost" });
  if (cmd === "playback_log_write") return Promise.resolve();
  if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
  if (cmd === "api_video") return Promise.resolve({ ...detail(), id: Number(args.id ?? CUR_ID) });
  if (cmd === "api_play") {
    const id = Number(args.id ?? CUR_ID);
    const ep = Number(args.ep ?? 1);
    const seq = ++playSeq;
    /* 真实 CDN：同一条流每次请求给的 token 不同 → 地址字符串不同 → <video> 会被重挂。
       用 /seg（本地直连媒体路由）而不是 /hls：这条走原生 <video>，
       不会被 hls.js 的 manifest 重试/错误兜底干扰「请求次数」的计量。 */
    const url = STABLE
      ? `http://hg.localhost/seg?u=${encodeURIComponent("http://127.0.0.1:9/ep" + ep)}`
      : `http://hg.localhost/seg?u=${encodeURIComponent("http://127.0.0.1:9/ep" + ep)}&n=${seq}`;
    const rec: PlayCall = { t: Math.round(performance.now()), id, ep, seq, url };
    playCalls.push(rec);
    return new Promise((resolve) => setTimeout(() => resolve({
      id, ep_num: ep, duration: 90, title: "取证剧集", video_url: "", streams: { main: url },
    }), DELAY));
  }
  if (cmd === "api_like" || cmd === "api_follow" || cmd === "api_collect") return Promise.resolve({ ok: true });
  if (cmd === "api_related") return Promise.resolve({ items: [] });
  if (cmd === "api_feed") return Promise.resolve({ items: [], pagination: { page: 1, pages: 0 } });
  if (cmd === "line_state") return Promise.resolve({ base: "https://hg.localhost", fixed: [{ url: "https://hg.localhost" }] });
  if (cmd === "line_mirrors") return Promise.resolve({ items: [] });
  if (cmd === "set_orientation") return Promise.resolve();
  return Promise.resolve(null);
};

Object.assign(window, { __TAURI_INTERNALS__: { invoke } });

/* ── 媒体打桩：无解码环境 paused 恒 true，只换状态与计数 ── */
const media = { play: 0, pause: 0, paused: false };
const srcLog: { t: number; src: string }[] = [];
/* autoplay=0 时**不真的调 play()**：原生 <video>.play() 会同步抛一个 "play" 事件，
   VideoSurface 拿它当 onPlaying → playingKey 跟上 → 预取照样触发。
   要单独量「播放这一路」，就得让 playing 永远不出现。 */
const callThrough = AUTOPLAY;
(() => {
  try {
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return media.paused; } });
    const play = HTMLMediaElement.prototype.play;
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function (...a) {
      media.play += 1; media.paused = false;
      if (!callThrough) return Promise.resolve();
      return (play && play.apply(this, a)) || Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function (...a) { media.pause += 1; media.paused = true; return pause && pause.apply(this, a); };
  } catch { /* ignore */ }
})();

/* src 变化 = <video> 被重挂 = 用户眼里的「又转一次圈」。
   轮询而不是 MutationObserver：React 有时直接写 property 不改 attribute。 */
let srcTimer = 0;
const watchSrc = () => {
  window.clearInterval(srcTimer);
  srcTimer = window.setInterval(() => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    if (!v) return;
    const src = v.currentSrc || v.src || v.getAttribute("src") || "";
    const last = srcLog[srcLog.length - 1];
    if (src && (!last || last.src !== src)) srcLog.push({ t: Math.round(performance.now()), src });
  }, 30);
};

/* 起播：无解码环境不会自己进 playing，这里替它把「首帧/元数据」补齐，
   好让 playingKey 真的跟上 playKey（预取那条 effect 的前置条件）。 */
function SourceStub() {
  React.useEffect(() => {
    if (!AUTOPLAY) return undefined;
    let tries = 0;
    const timer = window.setInterval(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      tries += 1;
      if (!v) { if (tries > 100) window.clearInterval(timer); return; }
      try {
        Object.defineProperty(v, "videoWidth", { configurable: true, get: () => 720 });
        Object.defineProperty(v, "videoHeight", { configurable: true, get: () => 1280 });
        Object.defineProperty(v, "readyState", { configurable: true, get: () => 4 });
        Object.defineProperty(v, "duration", { configurable: true, get: () => 90 });
      } catch { /* ignore */ }
      v.dispatchEvent(new Event("loadedmetadata"));
      v.dispatchEvent(new Event("loadeddata"));
      v.dispatchEvent(new Event("playing"));
    }, 120);
    return () => window.clearInterval(timer);
  }, []);
  return null;
}

/* ── 探针 ── */
const epNow = () => {
  const btn = document.querySelector("[data-hg-control=\"episodes-entry\"]") as HTMLElement | null;
  return btn ? (btn.textContent || "").trim() : null;
};
const byLabelPrefix = (p: string) => [...document.querySelectorAll(".player-root button")]
  .find(b => (b.getAttribute("aria-label") || "").startsWith(p)) as HTMLButtonElement | undefined;

Object.assign(window, {
  __v: {
    /** 全部 api_play 记账 */
    plays: () => playCalls.map(c => ({ t: c.t, id: c.id, ep: c.ep, seq: c.seq, url: c.url })),
    /** 每个 ep 被请求了几次 */
    perEp: () => {
      const out: Record<string, number> = {};
      for (const c of playCalls) out[String(c.ep)] = (out[String(c.ep)] || 0) + 1;
      return out;
    },
    /** <video> 的 src 变化序列（= 重挂次数） */
    srcs: () => srcLog.map(s => ({ t: s.t, src: s.src })),
    srcChangeCount: () => srcLog.length,
    ep: () => epNow(),
    calls: () => callLog.slice(),
    count: (cmd: string) => callLog.filter(c => c === cmd).length,
    media: () => ({ ...media }),
    bodyText: () => (document.body.innerText || "").replace(/\s+/g, " ").slice(-300),
    /* debug.log 里的取证行：[play] reuse prefetch / [play] merge in-flight 等 */
    logs: () => logs.slice(),
    reset: () => { playCalls.length = 0; srcLog.length = 0; playSeq = 0; callLog.length = 0; logs.length = 0; },
    /* 代理切换：走 useProxyPlaybackRecovery 的同一事件，验「重取」这条路没被吃掉 */
    proxyChanged: () => window.dispatchEvent(new Event("hg:proxy-changed")),
    /** 下一集：先按真实按钮走一遍（控件可能已自动收起，先把控件唤出来） */
    clickNext: () => {
      const btn = byLabelPrefix("下一集") || byLabelPrefix("下集");
      if (!btn) return { ok: false, reason: "no next button", labels: [...document.querySelectorAll(".player-root button")].map(b => b.getAttribute("aria-label")) };
      btn.click();
      return { ok: true, label: btn.getAttribute("aria-label") };
    },
    showControls: () => {
      const stage = document.querySelector("[data-mobile-hold-target]") as HTMLElement | null;
      stage?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 180, clientY: 300, pointerId: 1, isPrimary: true }));
      stage?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 180, clientY: 300, pointerId: 1, isPrimary: true }));
    },
    epText: () => epNow(),
  },
});

watchSrc();

function Page() {
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
        <EpisodePlayer
          videoIds={IDS} startIndex={0} title="取证剧集" mode="context"
          kind="video" active bottomInset={0} startEp={START}
          onBack={() => { /* noop */ }}
        />
      </div>
      <SourceStub />
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Page />);
