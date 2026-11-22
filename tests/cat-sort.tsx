/**
 * B16 / B17 探针：分类页（片库）「全部 ↔ 最新上线」切换 + tab 左右滑切。
 *
 * 真 Category 组件 + 真 api.call，只 mock Tauri IPC。
 *   ?live=1   IPC 改成经 vite 代理打真站（/hh/* → https://huangguoai.com/*），验证真数据下切换是否换批；
 *   ?delay=…  给 api_feed 加网络延迟，复现「两次点击间隔小于一次请求 RTT」。
 * 这样「点击没触发拉取」和「拉取了但数据相同」在 calls / DOM 上能分开看：
 *   - calls 里没有新的 api_feed(sort=new) ⇒ 点击没走到 state / effect；
 *   - calls 里有但首卡不变 ⇒ 数据相同或被缓存。
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Category from "../src/features/category/Category";
import { clearApiReadCache } from "../src/shared/api/api";
import { AppProvider } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const params = new URLSearchParams(location.search);
const LIVE = params.get("live") === "1";

type Call = { cmd: string; args: Record<string, unknown>; at: number };
const calls: Call[] = [];
let version = 1;
const state = { delay: Number(params.get("delay") || 0) };

const video = (id: number, title: string) => ({
  id, title, cover: "https://fixture.invalid/poster.jpg", tags: ["都市"], score: 8.2, hot: 1200,
  episode_count: 10, total_episodes: 10, is_finished: 1, is_original: 0, is_hot: 0,
  like_count: 0, comment_count: 0, collect_count: 0, description: "",
});
const page = (items: unknown[], size: number) => ({ items, pagination: { page: 1, pages: 2, size, total: 40 } });

const liveFeed = async (args: Record<string, unknown>) => {
  const qs = new URLSearchParams({ page: String(args.page ?? 1), size: String(args.size ?? 24) });
  if (args.sort != null && args.sort !== "") qs.set("sort", String(args.sort));
  const res = await fetch(`/hh/api/videos?${qs.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body?.data ?? body;
};

const invoke = (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
  if (cmd === "debug_log") return Promise.resolve();
  calls.push({ cmd, args, at: Date.now() });
  const v = version;
  switch (cmd) {
    case "api_feed": {
      const run = (): Promise<unknown> => {
        if (LIVE) return liveFeed(args);
        const sort = args.sort == null ? "all" : String(args.sort);
        /* 排序不同 → 不同批次，标题里带 sort 前缀，肉眼和断言都能分辨 */
        const head = sort === "new" ? `最新-${v}` : `全部-${v}`;
        return Promise.resolve(page([video(sort === "new" ? 4000 + v : 3000 + v, `${head} 首卡`), video(1, `${head} 次卡`)], 24));
      };
      return state.delay ? new Promise((resolve, reject) => setTimeout(() => run().then(resolve, reject), state.delay)) : run();
    }
    case "api_video": {
      const id = Number(args.id);
      return Promise.resolve({ ...video(id, `卡 ${id}`), episodes: [{ ep_num: 1, title: "第1集" }] });
    }
    case "api_category":
      return Promise.resolve(page([video(5000 + v, `频道 v${v}`)], 24));
    case "api_original_videos":
      return Promise.resolve(page([video(6000 + v, `原创 v${v}`)], 24));
    case "api_topics":
    case "api_tags":
      return Promise.resolve({ items: [], categories: [] });
    default:
      return Promise.resolve(null);
  }
};

const fixture = {
  calls,
  ready: false,
  version: () => version,
  bump() { version += 1; return version; },
  resetCalls() { calls.length = 0; },
  setDelay(ms: number) { state.delay = ms; },
  clearCache() { clearApiReadCache(); },
  live: LIVE,
};

Object.assign(window, { catFixture: fixture, __TAURI_INTERNALS__: { invoke } });

function Harness() {
  const [active, setActive] = useState(true);
  fixture.ready = true;
  Object.assign(window, { catSetActive: setActive });
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <Category wide={false} active={active} />
      </div>
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Harness />);
