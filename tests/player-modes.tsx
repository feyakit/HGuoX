/**
 * 播放器「控件集」验收台：真 EpisodePlayer + 真 store + 真 CSS，只 mock Tauri IPC。
 *
 * 目的：证明「抖音模式（endless）全屏不再出现选集/下一集」，而剧场模式（endless=false）保持原样。
 * 视频源是一条必然加载失败的地址 —— 我们只量控件集合，不需要解码；playUrl 存在，控件就会渲染。
 *
 * ?endless=1 → 抖音模式（真实入口是 EndlessFeed：mode="context" + endless）
 * ?fs=1      → 进页面就直接全屏（store.setFs(true)），用来量全屏底栏的分段胶囊
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
/* ?src=land|400|720|1280：片源宽高。harness 里没有真实可解码的媒体流（应用把所有地址包进
   HLS/代理层，headless 里 readyState 恒 0），所以「横版/竖版片源」这一档用**打桩元数据**：
   覆盖 videoWidth/videoHeight/readyState 后派发 loadedmetadata，走组件自己的 reportSize 链路。
   这只能证明「宽高判定 → 入口显隐 → 版式」，画面解码仍要真机。 */
const SRC_KIND = q.get("src") === "land" ? "land" : q.get("src") === "port" ? "port" : "";
const PLAY_SRC = "http://127.0.0.1:9/never.m3u8";
const CUR_ID = 991;
/* ?eps=N：详情里的集数（#8 验片尾要用单集，否则 onEnded 会先自动进第 2 集） */
const EPS = Math.max(1, Number(new URLSearchParams(location.search).get("eps") || 5));
/* ?vids=N：播放列表长度（验「全屏抖音上滑换作品」需要 ≥2 条） */
const VIDS = Math.max(1, Number(new URLSearchParams(location.search).get("vids") || 1));
const IDS = Array.from({ length: VIDS }, (_, i) => 991 + i);

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
  if (cmd === "app_boot") return Promise.resolve({ user: { id: 7, nickname: "验收" }, logged_in: true, base: "https://fixture.invalid" });
  if (cmd === "debug_log" || cmd === "playback_log_write") return Promise.resolve();
  if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
  if (cmd === "api_video") return Promise.resolve({ ...DETAIL, id: Number(args.id ?? CUR_ID), title: `验收剧集${args.id ?? CUR_ID}` });
  /* 地址必然失败：只关心控件，不关心解码 */
  if (cmd === "api_play") return Promise.resolve({
    id: CUR_ID, ep_num: Number(args.ep ?? 1), duration: 90, title: "验收剧集",
    video_url: "", streams: { main: PLAY_SRC },
  });
  if (cmd === "api_like") return Promise.resolve({ ok: true });
  if (cmd === "api_related") return Promise.resolve({ items: [] });
  if (cmd === "api_feed") return Promise.resolve({ items: [], pagination: { page: 1, pages: 0 } });
  return Promise.resolve(null);
};

Object.assign(window, { __TAURI_INTERNALS__: { invoke }, playerModeFixture: { calls }, __runBack: runBack });

/* ── 媒体打桩：无解码环境里 paused 恒 true，「单击暂停/播放」验不出来。
      只替换暂停态与 play/pause 计数，事件链与组件逻辑都走真的。 ── */
/* 初始按「正在播放」：暂停态会在画面正中渲染一颗「继续播放」按钮，合成点按会落在它上面，
   污染手势用例。播放态下中区是空的，点按才真正落到舞台。 */
const media = { play: 0, pause: 0, paused: false, likes: 0 };
Object.assign(window, { gestureProbe: media });
(() => {
  try {
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() { return media.paused; },
    });
    const play = HTMLMediaElement.prototype.play;
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function (...a) { media.play += 1; media.paused = false; return (play && play.apply(this, a)) || Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function (...a) { media.pause += 1; media.paused = true; return pause && pause.apply(this, a); };
  } catch { /* ignore */ }
})();

/** 片源宽高打桩（?src=land|port）。真机由解码器给，这里只验版式与显隐链路。
 *  `window.__holdMetadata(ms)` 让打桩在 ms 内不再派发 loadedmetadata —— 用来模拟「切集后
 *  新一集的解码宽高还没到」这段加载窗口（验收同剧切集是否保住舞台）。 */
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

function FsDriver() {
  const store = useStore();
  React.useEffect(() => { if (START_FS) store.setFs(true); /* eslint-disable-next-line */ }, []);
  /* 给验收脚本读全屏态（收起态点控件要验「唤出 + 一并执行」后会真的进退全屏） */
  (window as unknown as { __fsNow: () => boolean }).__fsNow = () => store.fs;
  return null;
}

function Page() {
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
        <EpisodePlayer
          videoIds={IDS} startIndex={0} title="验收剧集" mode={ENDLESS ? "context" : "context"}
          endless={ENDLESS} kind="video" active bottomInset={0}
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
