/**
 * B11 探针：吃瓜列表在「线路事件」后不得重建已渲染节点。
 *
 * 真 PostsPage + 真 api.call，只 mock Tauri IPC。fixture 每 bump 一次版本，
 * 返回的帖子 id 不变、标题变——这样「数据换新」与「节点被替换」能分开看：
 *   - 打标记的 DOM 节点在事件后仍 connected ⇒ 没重建；
 *   - 同 id 的标题变成 v2 ⇒ 数据确实静默刷新了。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { PostsPage } from "../src/features/posts/Posts";
import { AppProvider } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

type Call = { cmd: string; args: Record<string, unknown>; at: number };
const calls: Call[] = [];
let version = 1;
const state = { delay: Number(new URLSearchParams(location.search).get("delay") || 0) };

const post = (id: number, title: string) => ({
  id, title, cover: "https://fixture.invalid/post.jpg", desc: `摘要 v${version}`, tags: ["黑料吃瓜"],
  author: { id: 7, name: "作者", avatar: "" }, counts: { like: 1, comment: 2, collect: 3 },
  hot: 10, publish_time: "2026-11-21 09:00:00",
});
const pageOf = (items: unknown[]) => ({ items, pagination: { page: 1, pages: 3, size: 20, total: 60 } });

const invoke = (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
  if (cmd === "debug_log" || cmd === "playback_log_write") return Promise.resolve();
  if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
  calls.push({ cmd, args, at: Date.now() });
  const v = version;
  const run = (): unknown => {
    switch (cmd) {
      case "api_blog_posts":
      case "api_posts":
      case "api_post_category":
        return pageOf([1, 2, 3, 4, 5].map(id => post(9000 + id, `帖 ${id} v${v}`)));
      case "api_post":
        return { ...post(Number(args.id), `帖详情 v${v}`), content: "正文" };
      case "api_post_playback":
        return { items: [] };
      default:
        return null;
    }
  };
  return state.delay ? new Promise(resolve => setTimeout(() => resolve(run()), state.delay)) : Promise.resolve(run());
};

const fixture = {
  calls,
  ready: false,
  version: () => version,
  bump() { version += 1; return version; },
  setDelay(ms: number) { state.delay = ms; },
  resetCalls() { calls.length = 0; },
};

Object.assign(window, { postsLineFixture: fixture, __TAURI_INTERNALS__: { invoke } });

function Harness() {
  fixture.ready = true;
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <PostsPage embedded active />
      </div>
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Harness />);
