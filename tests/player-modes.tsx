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
import { AppProvider, useStore } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const q = new URLSearchParams(location.search);
const ENDLESS = q.get("endless") === "1";
const START_FS = q.get("fs") === "1";
const CUR_ID = 991;

const video = (id: number, title: string) => ({
  id, title, cover: "", tags: [], score: 0, episode_count: 5, total_episodes: 5,
  is_finished: 1, is_original: 0, is_hot: 0, like_count: 0, comment_count: 0, collect_count: 0, description: "",
});
const DETAIL = {
  ...video(CUR_ID, "验收剧集"),
  episodes: [1, 2, 3, 4, 5].map((n) => ({ ep_num: n, title: `第${n}集`, duration: 90, status: 1 })),
  author: { id: 1, name: "验收作者" },
  counts: { like: 0, collect: 0, comment: 0, hot: 0 },
};

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const invoke = (cmd: string, args: Record<string, unknown> = {}) => {
  calls.push({ cmd, args });
  if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
  if (cmd === "debug_log" || cmd === "playback_log_write") return Promise.resolve();
  if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
  if (cmd === "api_video") return Promise.resolve(DETAIL);
  /* 地址必然失败：只关心控件，不关心解码 */
  if (cmd === "api_play") return Promise.resolve({
    id: CUR_ID, ep_num: Number(args.ep ?? 1), duration: 90, title: "验收剧集",
    video_url: "", streams: { main: "http://127.0.0.1:9/never.m3u8" },
  });
  if (cmd === "api_related") return Promise.resolve({ items: [] });
  if (cmd === "api_feed") return Promise.resolve({ items: [], pagination: { page: 1, pages: 0 } });
  return Promise.resolve(null);
};

Object.assign(window, { __TAURI_INTERNALS__: { invoke }, playerModeFixture: { calls } });

function FsDriver() {
  const store = useStore();
  React.useEffect(() => { if (START_FS) store.setFs(true); /* eslint-disable-next-line */ }, []);
  return null;
}

function Page() {
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
        <EpisodePlayer
          videoIds={[CUR_ID]} startIndex={0} title="验收剧集" mode={ENDLESS ? "context" : "context"}
          endless={ENDLESS} kind="video" active bottomInset={0} onBack={() => { (window as any).__back = ((window as any).__back || 0) + 1; }}
        />
      </div>
      <FsDriver />
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Page />);
