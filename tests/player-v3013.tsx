/**
 * 播放器 v3.0.13 验收台：单击唤出 / 双击暂停 / 跟手 pager / 全屏行随控件 / 底部三段不跳。
 *
 * 与 player-modes 台子的差别：这里多了
 *   · 线路 mock（line_state / line_mirrors 两条），否则底栏「站点域名」那颗不渲染，
 *     量不到「隐藏时要保留占位」；
 *   · window.__v 探针：底栏 / 侧栏 / 右上角 bbox、pager 的 translateY、提示文案、播放计数；
 *   · ?ep 起播集数（跟手提交后要断言落到了第几集）。
 *
 * 仍然只 mock Tauri IPC：真组件、真 store、真 CSS。视频源是必然失败的地址 ——
 * 只验交互与几何，不解码（解码仍要真机）。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import EpisodePlayer from "../src/features/playback/EpisodePlayer";
import { runBack } from "../src/shared/lib/back";
import { AppProvider, useStore } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const q = new URLSearchParams(location.search);
const ENDLESS = q.get("endless") === "1";
const START_FS = q.get("fs") === "1";
const SRC_KIND = q.get("src") === "land" ? "land" : q.get("src") === "port" ? "port" : "";
const PLAY_SRC = "http://127.0.0.1:9/never.m3u8";
const CUR_ID = 991;
const EPS = Math.max(1, Number(q.get("eps") || 5));
const VIDS = Math.max(1, Number(q.get("vids") || 1));
const IDS = Array.from({ length: VIDS }, (_, i) => 991 + i);
const NO_LINE = q.get("line") === "0";

const video = (id: number, title: string) => ({
  id, title, cover: "", tags: [], score: 0, episode_count: EPS, total_episodes: EPS,
  is_finished: 1, is_original: 0, is_hot: 0, like_count: 0, comment_count: 0, collect_count: 0, description: "",
});
const DETAIL = {
  ...video(CUR_ID, "验收剧集"),
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
  if (cmd === "api_video") return Promise.resolve({ ...DETAIL, id: Number(args.id ?? CUR_ID), title: `验收剧集${args.id ?? CUR_ID}` });
  if (cmd === "api_play") return Promise.resolve({
    id: CUR_ID, ep_num: Number(args.ep ?? 1), duration: 90, title: "验收剧集",
    video_url: "", streams: { main: PLAY_SRC },
  });
  if (cmd === "api_like") return Promise.resolve({ ok: true });
  if (cmd === "api_related") return Promise.resolve({ items: [] });
  if (cmd === "api_feed") return Promise.resolve({ items: [], pagination: { page: 1, pages: 0 } });
  /* 线路：两条 → 底栏渲染「站点域名」那颗胶囊（隐藏/显示正是要验的对象） */
  if (cmd === "line_state") return Promise.resolve(NO_LINE
    ? { base: "https://hg.localhost", fixed: [{ url: "https://hg.localhost" }] }
    : { base: "https://hg.localhost", fixed: [{ url: "https://hg.localhost" }, { url: "https://mirror-b.aabbcc.cc" }] });
  if (cmd === "line_mirrors") return Promise.resolve({ items: [] });
  if (cmd === "set_orientation") return Promise.resolve();
  return Promise.resolve(null);
};

Object.assign(window, { __TAURI_INTERNALS__: { invoke }, playerModeFixture: { calls }, __runBack: runBack });

/* 媒体打桩：无解码环境 paused 恒 true，「暂停/播放」验不出来。只换暂停态与计数。 */
const media = { play: 0, pause: 0, paused: false, toggle: 0, calls: [] as { t: number; k: string }[] };
Object.assign(window, { gestureProbe: media });
(() => {
  try {
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() { return media.paused; },
    });
    const play = HTMLMediaElement.prototype.play;
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function (...a) {
      media.play += 1; media.paused = false;
      media.calls.push({ t: Math.round(performance.now()), k: "play" });
      if (media.calls.length > 40) media.calls.shift();
      return (play && play.apply(this, a)) || Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function (...a) {
      media.pause += 1; media.paused = true;
      media.calls.push({ t: Math.round(performance.now()), k: "pause", stack: String(new Error().stack || "").split("\n").slice(1, 5).join(" | ") } as never);
      if (media.calls.length > 40) media.calls.shift();
      return pause && pause.apply(this, a);
    };
  } catch { /* ignore */ }
})();

let holdMetadataUntil = 0;
Object.assign(window, { __holdMetadata: (ms: number) => { holdMetadataUntil = Date.now() + ms; } });

function SourceStub() {
  React.useEffect(() => {
    if (!SRC_KIND) return undefined;
    const size = SRC_KIND === "land" ? [1280, 720] : [720, 1280];
    let tries = 0;
    const timer = window.setInterval(() => {
      if (Date.now() < holdMetadataUntil) return;
      const v = document.querySelector("video") as HTMLVideoElement | null;
      tries += 1;
      if (!v) { if (tries > 60) window.clearInterval(timer); return; }
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

/* 播放页「失活」开关：用来验「离开播放页 → set_orientation(unspecified)」这条清理路径。 */
const activeState = { value: true, set: (_v: boolean) => { /* 由 React 填充 */ } };
Object.assign(window, { __setActive: (v: boolean) => activeState.set(v) });

function FsDriver() {
  const store = useStore();
  React.useEffect(() => { if (START_FS) store.setFs(true); /* eslint-disable-next-line */ }, []);
  (window as unknown as { __fsNow: () => boolean }).__fsNow = () => store.fs;
  return null;
}

/* ── 探针：一次 evaluate 量完所有几何，避免「各自截图再手工叠」的口径错误 ── */
const r2 = (n: number) => Math.round(n * 100) / 100;
const rectOf = (el: Element | null) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r2(r.x), y: r2(r.y), w: r2(r.width), h: r2(r.height) };
};

Object.assign(window, {
  __v: {
    probe: () => {
      const root = document.querySelector(".player-root");
      if (!root) return { error: "no player-root" };
      const ctrl = (name: string) => root.querySelector(`[data-hg-control="${name}"]`);
      const byLabel = (label: string) => [...root.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") || "") === label) || null;
      const byLabelPrefix = (p: string) => [...root.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") || "").startsWith(p)) || null;
      const stage = root.querySelector("[data-mobile-hold-target]") as HTMLElement | null;
      let ty = 0;
      let scale = 1;
      if (stage) {
        const t = getComputedStyle(stage).transform;
        if (t && t !== "none") { const m = new DOMMatrixReadOnly(t); ty = r2(m.f); scale = r2(m.a); }
      }
      const epBtn = ctrl("episodes-entry") as HTMLElement | null;
      return {
        ty, scale,
        visibleId: root.getAttribute("data-visible-id"),
        clean: root.getAttribute("data-clean"),
        paused: media.paused,
        counts: { play: media.play, pause: media.pause },
        now: Math.round(performance.now()),
        mediaCalls: media.calls.slice(-12),
        segs: [...root.querySelectorAll(".hg-seg")].map(b => (b.getAttribute("aria-label") || b.textContent || "").trim()),
        meta: {
          ep: rectOf(epBtn),
          epText: epBtn ? (epBtn.textContent || "").trim() : null,
          detail: rectOf(ctrl("detail-entry")),
          line: rectOf(byLabelPrefix("切换线路")),
          bar: rectOf(ctrl("bar")),
        },
        rail: {
          like: rectOf(byLabel("点赞")),
          fav: rectOf(byLabel("收藏")),
          comment: rectOf(byLabelPrefix("评论 ")),
          fs: rectOf(byLabel("全屏横屏播放")),
          more: rectOf(byLabel("不感兴趣")) || rectOf(byLabel("不感兴趣，跳过这条")),
        },
        topRight: {
          mute: rectOf(byLabel("静音")) || rectOf(byLabel("取消静音")),
          lock: rectOf(byLabel("锁定播放控制")),
        },
        fsEntry: rectOf(ctrl("fullscreen-entry")),
        fsEntryVisible: (() => {
          const el = ctrl("fullscreen-entry") as HTMLElement | null;
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.05;
        })(),
        bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(-400),
        orientationCalls: calls.filter(c => c.cmd === "set_orientation").map(c => c.args),
      };
    },
    resetCounts: () => { media.play = 0; media.pause = 0; },
    calls: () => calls.map(c => c.cmd),
  },
});

function Page() {
  const [active, setActive] = React.useState(true);
  activeState.set = setActive;
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
        <EpisodePlayer
          videoIds={IDS} startIndex={0} title="验收剧集" mode="context"
          endless={ENDLESS} kind="video" active={active} bottomInset={0}
          onBack={() => { (window as any).__back = ((window as any).__back || 0) + 1; }}
        />
      </div>
      <FsDriver />
      <SourceStub />
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Page />);
