/**
 * 方向契约验收台（3.0.22 方案 B/C）：真组件 + 真 store + 真 CSS，只 mock Tauri IPC。
 *
 * 验四件事：
 *   ① 竖版片源 → set_orientation(portrait)；横版片源 → set_orientation(unspecified)；
 *   ② 这两条**静默路径**一律不弹提示（用户：「每切一级都弹」）；
 *   ③ 点「全屏观看」被系统方向锁拦下（Rust 返回 orientation_locked_by_user）→
 *      不弹错误 toast，入口改成锁状态 + 一张带「知道了」的说明卡（每会话一次）；
 *   ④ 离开播放页（active=false）→ set_orientation(unspecified)。
 *
 * 平台由 UA 决定（src/shared/api/api.ts），所以 runner 用两套 UA 各跑一遍：
 * iPhone UA → platform=ios；MI 9 UA → platform=android。
 *
 * 片源地址故意是必然失败的本地地址：只验方向/提示，不解码。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import EpisodePlayer from "../src/features/playback/EpisodePlayer";
import { runBack } from "../src/shared/lib/back";
import { AppProvider } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const q = new URLSearchParams(location.search);
const SRC_KIND = q.get("src") === "land" ? "land" : q.get("src") === "port" ? "port" : "";
const ORIENT = q.get("orient") || "ok";      // ok | fail_locked | fail_other
const EPS = Math.max(1, Number(q.get("eps") || 5));
const CUR_ID = 991;

const video = (id: number, title: string) => ({
  id, title, cover: "", tags: [], score: 0, episode_count: EPS, total_episodes: EPS,
  is_finished: 1, is_original: 0, is_hot: 0, like_count: 0, comment_count: 0, collect_count: 0, description: "",
});
const DETAIL = {
  ...video(CUR_ID, "方向验收剧集"),
  episodes: Array.from({ length: EPS }, (_, i) => ({ ep_num: i + 1, title: `第${i + 1}集`, duration: 90, status: 1 })),
  author: { id: 1, name: "验收作者" },
  counts: { like: 0, collect: 0, comment: 0, hot: 0 },
};

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const invoke = (cmd: string, args: Record<string, unknown> = {}) => {
  calls.push({ cmd, args });
  if (cmd === "app_boot") return Promise.resolve({ user: { id: 7, nickname: "验收" }, logged_in: true, base: "https://hg.localhost" });
  if (cmd === "debug_log" || cmd === "playback_log_write") return Promise.resolve();
  if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
  if (cmd === "api_video") return Promise.resolve({ ...DETAIL, id: Number(args.id ?? CUR_ID) });
  if (cmd === "api_play") return Promise.resolve({
    id: CUR_ID, ep_num: Number(args.ep ?? 1), duration: 90, title: "方向验收剧集",
    video_url: "", streams: { main: "http://127.0.0.1:9/never.m3u8" },
  });
  if (cmd === "api_related") return Promise.resolve({ items: [] });
  if (cmd === "api_like") return Promise.resolve({ ok: true });
  if (cmd === "api_feed") return Promise.resolve({ items: [], pagination: { page: 1, pages: 0 } });
  if (cmd === "line_state") return Promise.resolve({ base: "https://hg.localhost", fixed: [{ url: "https://hg.localhost" }] });
  if (cmd === "line_mirrors") return Promise.resolve({ items: [] });
  if (cmd === "set_orientation") {
    if (ORIENT === "fail_locked") {
      /* Rust 侧 iOS 的真实回法：前缀 + 一行原因（前端只认前缀） */
      return Promise.reject("orientation_locked_by_user: 系统方向锁拦下了转屏（UISceneError code=101: orientation locked）");
    }
    if (ORIENT === "fail_other") return Promise.reject("系统未允许转屏：fixture");
    return Promise.resolve();
  }
  return Promise.resolve(null);
};

Object.assign(window, { __TAURI_INTERNALS__: { invoke }, orientationFixture: { calls }, __runBack: runBack });

/* 媒体打桩：无解码环境 paused 恒 true —— 只换暂停态，不碰方向逻辑。 */
(() => {
  try {
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return true; } });
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { /* noop */ };
  } catch { /* ignore */ }
})();

function SourceStub() {
  React.useEffect(() => {
    if (!SRC_KIND) return undefined;
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

const activeState = { set: (_v: boolean) => { /* 由 React 填充 */ } };
Object.assign(window, { __setActive: (v: boolean) => activeState.set(v) });

const probe = () => {
  const entry = document.querySelector('[data-hg-control="fullscreen-entry"]') as HTMLElement | null;
  const card = document.querySelector('[data-hg-control="orientation-lock-hint"]') as HTMLElement | null;
  const toastHost = document.querySelector(".ios-toast-host") as HTMLElement | null;
  const toasts = toastHost ? [...toastHost.children].map((el) => (el.textContent || "").trim()) : [];
  return {
    orientationCalls: calls.filter((c) => c.cmd === "set_orientation").map((c) => c.args),
    toasts,
    entry: entry ? {
      text: (entry.textContent || "").trim(),
      ariaLabel: entry.getAttribute("aria-label"),
      locked: entry.getAttribute("data-orientation-locked"),
      h: entry.getBoundingClientRect().height,
      visible: entry.getBoundingClientRect().width > 0,
    } : null,
    hintCard: card ? { text: (card.textContent || "").trim(), h: card.getBoundingClientRect().height } : null,
    fs: !!document.querySelector(".player-root.fs-immersive"),
    clean: document.querySelector(".player-root")?.getAttribute("data-clean") ?? null,
    body: (document.body.innerText || "").replace(/\s+/g, " ").slice(-300),
  };
};
Object.assign(window, { __probe: probe });

function Page() {
  const [active, setActive] = React.useState(true);
  activeState.set = setActive;
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
        <EpisodePlayer
          videoIds={[CUR_ID]} startIndex={0} title="方向验收剧集" mode="context"
          kind="video" active={active} bottomInset={0}
          onBack={() => { (window as unknown as { __back?: number }).__back = ((window as unknown as { __back?: number }).__back || 0) + 1; }}
        />
      </div>
      <SourceStub />
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Page />);
