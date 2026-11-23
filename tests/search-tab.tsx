/**
 * 搜索页横滑切 tab 的验收台（上游 36f9058）：真 Search 页面 + 真 store + 真 CSS，只 mock Tauri IPC。
 *
 * 目的：
 *  1. 结果区左滑 → 切到「吃瓜帖子」并真的按 post 重新搜；右滑 → 切回「短剧剧集」；
 *  2. 没出结果时只有一个 tab，滑了也不动；
 *  3. 「清空搜索」把 tab、输入、结果一起复位（上游 5df811a 的 resetSearch）。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import Search from "../src/features/search/Search";
import { AppProvider } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const card = (id: number, title: string) => ({
  id, title, cover: "", tags: [], score: 8.5, episode_count: 10, total_episodes: 10,
  is_finished: 1, is_original: 0, is_hot: 0, like_count: 0, comment_count: 0, collect_count: 0, description: "",
});
const post = (id: number, title: string) => ({
  id, title, desc: "验收帖子", cover: "", tags: [], hot: 8600, created_at: "2026-11-22", publish_time: "2026-11-22",
});

const invoke = (cmd: string, args: Record<string, unknown> = {}) => {
  calls.push({ cmd, args });
  if (cmd === "app_boot") return Promise.resolve({ user: { id: 7, nickname: "验收" }, logged_in: true, base: "https://fixture.invalid" });
  if (cmd === "api_search") {
    const kind = args.kind === "post" ? "post" : "video";
    const items = kind === "post"
      ? [post(501, "吃瓜结果一"), post(502, "吃瓜结果二")]
      : [card(101, "短剧结果一"), card(102, "短剧结果二"), card(103, "短剧结果三")];
    return Promise.resolve({ items, pagination: { page: 1, pages: 1, size: 20, total: items.length }, keyword: String(args.q || "") });
  }
  if (cmd === "api_search_hot") return Promise.resolve({ items: [] });
  if (cmd === "api_tags") return Promise.resolve({ categories: [] });
  if (cmd === "api_posts" || cmd === "api_feed") return Promise.resolve({ items: [], pagination: { page: 1, pages: 0, size: 20, total: 0 } });
  return Promise.resolve(null);
};
Object.assign(window, { __TAURI_INTERNALS__: { invoke }, searchFixture: { calls } });

function Page() {
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
        <Search active wide={false} onBack={() => { /* 验收台不关心返回 */ }} />
      </div>
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Page />);
