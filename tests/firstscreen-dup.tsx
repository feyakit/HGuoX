/* 首屏重复请求取证台（W100）。
 *
 * 按 `src/main.tsx` 的真实挂载方式把整棵树挂起来（StartupGate → AppProvider → App），
 * 只把 Tauri IPC 换成夹具：每条 invoke 都记 {cmd, args, at, stack}，用来回答
 * 「同一个 URL 为什么发了两遍、是哪两处代码路径发的」。
 *
 * 与 tests/coldstart.tsx 的区别：**不加 StrictMode**（生产包 React 不双调 effect），
 * 并且把 Rust 侧 `api_home_details` 的真实行为补上 —— 它对每个 id 各发一条
 * `GET /api/videos/{id}`，在 net.rs 里算 `cmd=api_video`，所以这里也按 id 记一笔。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/app/App";
import StartupGate from "../src/app/startup/LaunchAnimation";
import { AppProvider } from "../src/shared/model/store";
import { armBootBudget } from "../src/shared/api/api";
import { api } from "../src/shared/api/api";
import { cachedDetail, clearDetailCache, loadDetail, prefetchDetails } from "../src/shared/api/detailFast";
import "../src/index.css";

type Args = Record<string, unknown>;
type Call = { cmd: string; args: Args; at: number; stack: string };

const history: Call[] = [];
const nets: string[] = [];
/** 模拟 Rust 侧真实发出的 HTTP 请求（cmd 名取自 src-tauri/src/net.rs 的 path_cmd） */
const http: { cmd: string; path: string; at: number; via: string; stack: string }[] = [];
const errors: string[] = [];

const at = () => Math.round(performance.now());
const stackOf = () => {
  const raw = new Error().stack || "";
  const frames = raw
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/^at\s+/, ""))
    /* 只留业务帧：夹具、src/、@tauri-apps/api —— react-dom 的 commit 帧对定位没意义 */
    .filter((frame) => /firstscreen-dup|src\/|@tauri-apps\/api/.test(frame))
    .map((frame) => frame.split("?")[0].replace(/^.*\/HGuoX\//, ""));
  return frames.slice(0, 6).join(" ← ");
};
const push = (cmd: string, args: Args) => {
  const row: Call = { cmd, args, at: at(), stack: stackOf() };
  history.push(row);
  return row;
};

const cards = (count: number, tag = "首屏") => ({
  items: Array.from({ length: count }, (_, index) => ({
    id: 900 + index,
    title: `${tag}剧 ${index + 1}`,
    cover: `https://fixture.invalid/poster/${900 + index}.jpg`,
    tags: ["都市"],
    score: 8.5,
    hot: 1200,
    episode_count: 12,
    total_episodes: 12,
    is_finished: true,
    is_original: 0,
    is_hot: 1,
    like_count: 10,
    comment_count: 2,
    collect_count: 3,
  })),
  pagination: { page: 1, pages: 1, size: 21, total: count },
});

/* banner 8 条缺标题 —— 与 W99 真机日志里「8 个详情 id 各 2 条」同形 */
const banners = (count = 8) => ({
  source: "api/home",
  banners: Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    video_id: 13781 + index,
    image: `/upload_01/banner-${index}.jpg`,
    image_url: `https://pic.invalid/banner-${index}.jpg`,
    score: 9.1,
    desc: `官网主推 ${index + 1}`,
    title: null,
    tags: null,
    episode_count: null,
    total_episodes: null,
    is_finished: null,
  })),
});

const detail = (id: number) => ({
  id,
  title: `详情 ${id}`,
  cover: `https://fixture.invalid/poster/${id}.jpg`,
  tags: ["都市"],
  episode_count: 12,
  total_episodes: 12,
  is_finished: true,
  description: "",
  category: "短剧",
  episodes: [],
});

/* ── 网络延迟模型：每条 IPC 都异步回来，模拟真机 RTT ── */
const LATENCY = { feed: 260, home: 200, homeDetails: 220, other: 120 };

function handle(cmd: string, args: Args): Promise<unknown> {
  switch (cmd) {
    case "app_boot":
      return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
    case "debug_log":
    case "net_log":
      if (cmd === "net_log") nets.push(String(args.msg));
      return Promise.resolve();
    case "net_boot_budget":
      return Promise.resolve(args.ms ?? 0);
    case "line_state":
      return Promise.resolve({
        base: "https://fixture.invalid",
        default: "https://huangguoai.com",
        fixed: [],
        custom: false,
        manual: false,
      });
    case "line_failover":
      return Promise.resolve({ switched: false, base: "", reason: "all-down" });
    case "line_failover_next":
      return Promise.resolve({ switched: false, base: "", reason: "all-down" });
    case "net_diag":
      return Promise.resolve({});
    case "app_self_test":
      return Promise.resolve({ ok: true });
    case "plugin:event|listen":
    case "plugin:event|unlisten":
      return Promise.resolve(1);
    default:
      break;
  }
  if (cmd === "api_feed") {
    return new Promise((resolve) => setTimeout(() => resolve(cards(6)), LATENCY.feed));
  }
  if (cmd === "api_home") {
    return new Promise((resolve) => setTimeout(() => resolve(banners(8)), LATENCY.home));
  }
  if (cmd === "api_home_details") {
    const ids = (args.ids as number[]) ?? [];
    return new Promise((resolve) => setTimeout(() => {
      /* Rust 侧真实行为：每个 id 各发一条 GET /api/videos/{id} */
      const via = `api_home_details@${at()}`;
      for (const id of ids) {
        http.push({ cmd: "api_video", path: `/api/videos/${id}`, at: at(), via, stack: stackOf() });
      }
      resolve({ items: ids.map((id) => ({ video_id: id, title: `补全 ${id}`, tags: ["悬疑"], episode_count: 12, total_episodes: 12, is_finished: true, cover: null })) });
    }, LATENCY.homeDetails));
  }
  if (cmd === "api_video") {
    const id = Number(args.id);
    http.push({ cmd: "api_video", path: `/api/videos/${id}`, at: at(), via: "invoke api_video", stack: stackOf() });
    return new Promise((resolve) => setTimeout(() => resolve(detail(id)), LATENCY.other));
  }
  if (cmd === "api_rank") {
    return new Promise((resolve) => setTimeout(() => resolve({ type: String(args.kind ?? ""), items: [] }), LATENCY.other));
  }
  if (cmd === "api_original_videos") {
    return new Promise((resolve) => setTimeout(() => resolve(cards(2, "独家")), LATENCY.other));
  }
  if (cmd === "api_topics") {
    return new Promise((resolve) => setTimeout(() => resolve({ items: [] }), LATENCY.other));
  }
  if (cmd === "api_tags") {
    return new Promise((resolve) => setTimeout(() => resolve({ categories: [] }), LATENCY.other));
  }
  if (cmd === "api_hot_tags") {
    return new Promise((resolve) => setTimeout(() => resolve({ items: [] }), LATENCY.other));
  }
  if (cmd === "api_me") {
    return new Promise((resolve) => setTimeout(() => resolve({ user: null }), LATENCY.other));
  }
  errors.push(`未预期的 IPC：${cmd} ${JSON.stringify(args)}`);
  return Promise.reject(`Unexpected IPC: ${cmd}`);
}

const fixture = {
  history,
  nets,
  http,
  errors,
  ready: false,
  mounts: [] as { what: string; at: number; stack: string }[],
  at,
  /** 冷启动期间模拟「自动选线真的换了一条线」：store 收到后会 bump lineEpoch */
  switchLine(ms = 600) {
    window.setTimeout(() => window.dispatchEvent(new Event("hg:line-changed")), ms);
  },
  /** 冷启动期间模拟真机：WebView 拿到焦点（回前台刷新钩子的入口） */
  focusApp(ms = 300) {
    window.setTimeout(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    }, ms);
  },
  counts() {
    const perCmd: Record<string, number> = {};
    for (const row of history) perCmd[row.cmd] = (perCmd[row.cmd] ?? 0) + 1;
    const perPath: Record<string, number> = {};
    for (const row of http) perPath[row.path] = (perPath[row.path] ?? 0) + 1;
    const firstContent = nets.filter((line) => line.startsWith("[net] first content"));
    return {
      perCmd,
      perPath,
      firstContent,
      totalHttp: http.length,
      distinctHttp: Object.keys(perPath).length,
      dupPaths: Object.entries(perPath).filter(([, n]) => n > 1),
    };
  },
  /** 同一 path 的两遍分别是谁发的（调用栈对比） */
  dupStacks(path?: string) {
    const rows = path ? http.filter((row) => row.path === path) : http;
    const byPath = new Map<string, typeof http>();
    for (const row of rows) {
      const list = byPath.get(row.path) ?? [];
      list.push(row);
      byPath.set(row.path, list);
    }
    return [...byPath.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => ({ path: key, hits: list.map((row) => ({ at: row.at, via: row.via, stack: row.stack })) }));
  },
  feedStacks() {
    return history.filter((row) => row.cmd === "api_feed").map((row) => ({ at: row.at, args: row.args, stack: row.stack }));
  },
  homeDetailsCalls() {
    return history.filter((row) => row.cmd === "api_home_details").map((row) => ({ at: row.at, ids: row.args.ids, stack: row.stack }));
  },
  /** 前后的计数清零（子用例用：预取去重 / args 归一化） */
  reset() {
    history.length = 0;
    http.length = 0;
    nets.length = 0;
  },
  modules: {} as Record<string, unknown>,
};

Object.assign(fixture.modules, { api, prefetchDetails, loadDetail, cachedDetail, clearDetailCache });

Object.assign(window, {
  dupFixture: fixture,
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Args = {}) {
      push(cmd, args);
      return handle(cmd, args);
    },
    transformCallback: () => 0,
  },
});

function Boot() {
  fixture.ready = true;
  React.useEffect(() => {
    fixture.mounts.push({ what: "App mount", at: at(), stack: stackOf() });
    return () => { fixture.mounts.push({ what: "App unmount", at: at(), stack: stackOf() }); };
  }, []);
  return <App />;
}

createRoot(document.querySelector("#root")!).render(
  <StartupGate>
    <AppProvider>
      <Boot />
    </AppProvider>
  </StartupGate>,
);

armBootBudget();
