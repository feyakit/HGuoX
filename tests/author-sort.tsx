/* 3.0.21 D：作者主页「指标排序 / 连载筛选」必须对**分页新页**一起生效。
 *
 * 数据两页（每页 4 部，pagination.pages=2）。第 2 页的热度故意夹在第 1 页中间，
 * 所以「只对已加载的那一页排序、新页直接接在后面」和「全量重排」得到的是两个完全
 * 不同的顺序 —— 断言 DOM 顺序就是判据，不靠肉眼。
 */
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { UserPage } from "../src/features/account/User";
import "../src/index.css";

type Row = { id: number; title: string; hot: number; like_count: number; collect_count: number; score: number; is_finished: number; episode_count: number; total_episodes: number };

const PAGES: Record<number, Row[]> = {
  1: [
    { id: 1, title: "A 一百", hot: 100, like_count: 10, collect_count: 1, score: 6, is_finished: 1, episode_count: 24, total_episodes: 24 },
    { id: 2, title: "B 三十", hot: 30, like_count: 40, collect_count: 2, score: 7, is_finished: 0, episode_count: 12, total_episodes: 24 },
    { id: 3, title: "C 八十", hot: 80, like_count: 20, collect_count: 3, score: 8, is_finished: 1, episode_count: 24, total_episodes: 24 },
    { id: 4, title: "D 十", hot: 10, like_count: 50, collect_count: 4, score: 9, is_finished: 0, episode_count: 12, total_episodes: 24 },
  ],
  2: [
    { id: 5, title: "E 九十", hot: 90, like_count: 15, collect_count: 5, score: 8.5, is_finished: 0, episode_count: 12, total_episodes: 24 },
    { id: 6, title: "F 七十", hot: 70, like_count: 25, collect_count: 6, score: 7.5, is_finished: 1, episode_count: 24, total_episodes: 24 },
    { id: 7, title: "G 五", hot: 5, like_count: 60, collect_count: 7, score: 5, is_finished: 0, episode_count: 12, total_episodes: 24 },
    { id: 8, title: "H 六十", hot: 60, like_count: 35, collect_count: 8, score: 6.5, is_finished: 1, episode_count: 24, total_episodes: 24 },
  ],
};

/* 第 2 页的响应先扣住：复现「先切排序、新页后到」这条路径（报告的 D 就是这个时序） */
let openGate: (() => void) | null = null;
const pageTwoGate = new Promise<void>((resolve) => { openGate = resolve; });

const fixture = {
  requested: [] as number[],
  gateOpen: false,
  release() { fixture.gateOpen = true; openGate?.(); },
  /** 目前 DOM 里 .ios-media-grid 的卡片顺序（卡片 aria-label = 标题，首字母即 A/B/C…） */
  order(): string[] {
    return Array.from(document.querySelectorAll("[data-ui='media-grid'] > *"))
      .map((node) => (node.getAttribute("aria-label") || "").trim().charAt(0))
      .filter((letter) => /[A-H]/.test(letter));
  },
};

Object.assign(window, {
  isTauri: true,
  authorSortFixture: fixture,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 0; },
    unregisterCallback() {},
    invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === "app_boot") {
        return Promise.resolve({ strict_security: true, base: "https://fixture.invalid", user: null });
      }
      if (command === "debug_log" || command === "playback_log_write" || command === "net_log") return Promise.resolve();
      if (command === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
      if (command === "api_user") return Promise.resolve({ id: 7, nickname: "作者七", username: "seven", sign: "" });
      if (command === "api_user_stats") return Promise.resolve({ user_id: 7, like_count: 1, following: 0, followers: 2, video_count: 8, post_count: 0 });
      if (command === "api_user_videos") {
        const page = Number(args.page) || 1;
        fixture.requested.push(page);
        const body = { items: PAGES[page] || [], pagination: { page, pages: 2, size: 4, total: 8 } };
        /* 第 2 页扣住，直到测试调 release() */
        if (page === 2 && !fixture.gateOpen) return pageTwoGate.then(() => body);
        return Promise.resolve(body);
      }
      return Promise.resolve(null);
    },
  },
});

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <UserPage id={7} name="作者七" onBack={() => {}} wide={false} />
  </AppProvider>,
);
