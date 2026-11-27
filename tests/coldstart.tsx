/* 3.0.20 冷启动首屏验收台（fixture）。
 *
 * 三件事在这一页里钉死：
 *   ① 首屏只发两个请求（feed 第 1 页 + api_home），并且**这两个是并行的**；
 *      货架 / 榜位 / 专题 / hero 补全必须等到内容出现之后才发（分阶段）。
 *   ② 单次请求失败 → 换线 → 同一次加载里重试一次（不是把失败往上抛）。
 *   ③ 首屏全失败时按 1s / 3s / 7s 自动重试，每次换一条候选线路；只有三次都失败才出错误页。
 *
 * 真实的 api.call / request() / Home / AppProvider 全部在位，只替换 Tauri IPC。
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Home from "../src/features/feed/Home";
import { AppProvider } from "../src/shared/model/store";
import {
  FIRST_SCREEN_RETRY_DELAYS,
  faultKindOf,
  withLineRetries,
  type RetryDeps,
} from "../src/shared/network/firstScreen";
import "../src/index.css";

type Args = Record<string, unknown>;
type Pending = { cmd: string; args: Args; resolve: (value: unknown) => void; reject: (error: string) => void };
type Call = { cmd: string; args: Args; at: number };

const pending: Pending[] = [];
const history: Call[] = [];
const nets: string[] = [];
const marks: { name: string; at: number }[] = [];

const take = (cmd: string, match?: (args: Args) => boolean): Pending | undefined => {
  const index = pending.findIndex((row) => row.cmd === cmd && (!match || match(row.args)));
  if (index < 0) return undefined;
  return pending.splice(index, 1)[0];
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

const fixture = {
  history,
  nets,
  marks,
  ready: false,
  setActive: (_active: boolean) => {},
  mark(name: string) { marks.push({ name, at: performance.now() }); },
  pendingCount(cmd: string, match?: (args: Args) => boolean) {
    return pending.filter((row) => row.cmd === cmd && (!match || match(row.args))).length;
  },
  /** 首屏（api_feed / api_home）之外，阶段二的命令都必须在「内容出现」之后才发 */
  stagedCommands() {
    return ["api_rank", "api_original_videos", "api_topics", "api_home_details"] as const;
  },
  resolveAll(cmd: string, value: unknown, match?: (args: Args) => boolean) {
    let count = 0;
    for (;;) {
      const row = take(cmd, match);
      if (!row) break;
      row.resolve(value);
      count += 1;
    }
    return count;
  },
  rejectAll(cmd: string, error: string, match?: (args: Args) => boolean) {
    let count = 0;
    for (;;) {
      const row = take(cmd, match);
      if (!row) break;
      row.reject(error);
      count += 1;
    }
    return count;
  },
  resolveFeed(count = 3, tag = "首屏") {
    return fixture.resolveAll("api_feed", cards(count, tag));
  },
  rejectFeed(error = "NET:tls · tls handshake eof") {
    return fixture.rejectAll("api_feed", error);
  },
  bannerResolved: false,
  banners(count = 2) {
    fixture.bannerResolved = true;
    return {
      source: "api/home",
      banners: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        video_id: 500 + index,
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
    };
  },
  bannerDetails() {
    return {
      items: [
        { video_id: 500, title: "补全剧 A", tags: ["悬疑"], episode_count: 24, total_episodes: 24, is_finished: true, cover: null },
        { video_id: 501, title: "补全剧 B", tags: ["甜宠"], episode_count: 8, total_episodes: 8, is_finished: true, cover: null },
      ],
    };
  },
  /* 换线：`mode` 控制 `line_failover`（api.request 内部那次）与 `line_failover_next`（首屏重试） */
  failoverMode: { request: "all-down", retry: "switch" } as { request: string; retry: string },
  failoverNextCalls: [] as { reason?: string; exclude?: string[] }[],
  retryPolicy: {
    withLineRetries,
    FIRST_SCREEN_RETRY_DELAYS,
    faultKindOf,
    /* 假时钟：只记录被要求的等待时长，不真的等 */
    run<T>(run: () => Promise<T>, deps: RetryDeps & { sleeps?: number[] }) {
      const sleeps: number[] = [];
      return withLineRetries(run, {
        ...deps,
        sleep: async (ms: number) => { sleeps.push(ms); },
      }).then(
        (value) => ({ ok: true as const, value, sleeps }),
        (error) => ({ ok: false as const, error: String((error as Error)?.message ?? error), sleeps }),
      );
    },
  },
};

Object.assign(window, {
  coldstartFixture: fixture,
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Args = {}) {
      history.push({ cmd, args, at: performance.now() });
      switch (cmd) {
        case "app_boot":
          return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
        case "debug_log":
          return Promise.resolve();
        case "net_log":
          nets.push(String(args.msg));
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
          /* api.request() 内部那次换线：默认「全都不通」，让失败继续往上走 */
          return Promise.resolve({ switched: false, base: "", reason: fixture.failoverMode.request });
        case "line_failover_next": {
          fixture.failoverNextCalls.push({
            reason: typeof args.reason === "string" ? args.reason : undefined,
            /* 拷一份：这一轮 `tried` 还会继续 push，存引用会让历史记录被后面的轮次改写 */
            exclude: Array.isArray(args.exclude) ? [...(args.exclude as string[])] : undefined,
          });
          if (fixture.failoverMode.retry === "switch") {
            return Promise.resolve({ switched: true, base: "https://mirror.example", reason: "failover-ok" });
          }
          return Promise.resolve({ switched: false, base: "", reason: fixture.failoverMode.retry });
        }
        default:
          break;
      }
      if (["api_feed", "api_home", "api_home_details", "api_rank", "api_original_videos", "api_topics"].includes(cmd)) {
        return new Promise((resolve, reject) => pending.push({ cmd, args, resolve, reject }));
      }
      return Promise.reject(`Unexpected IPC: ${cmd}`);
    },
  },
});

function Fixture() {
  const [active, setActive] = useState(true);
  fixture.setActive = setActive;
  fixture.ready = true;
  return (
    <AppProvider>
      <div style={{ position: "relative", width: 900, height: 1000 }}>
        <Home active={active} bottomInset={0} />
      </div>
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
