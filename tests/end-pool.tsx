/**
 * 结束态「换一批」验收台：真 EndCard + 真 useEndPool（含 buildEndPool/takeBatch）+ 真 api.call，
 * 只 mock Tauri IPC。播放页那 15 行胶水就是这里的 useEndPool，所以点按钮走的是产品同一条路径。
 *
 * fixture 的口径：
 *   - api_related 返回 **8 条固定列表**（上游就是「同一个 id 永远这批」），id 9001..9008；
 *   - api_feed 每页 6 条不同内容，page1 9101..9106、page2 9201..9206 …，用来把池子补到 12；
 *   - ?fail=1 时两个接口都返回空，验「如实退回暂无更多推荐」。
 * 每次请求都记进 calls，断言「换一批不该再打接口」时直接看条数。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { EndCard } from "../src/features/playback/EndCard";
import { useEndPool } from "../src/features/playback/useEndPool";
import { AppProvider } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const params = new URLSearchParams(location.search);
const FAIL = params.get("fail") === "1";
/* ?only=N：related 只给 N 条且 feed 全空 —— 验「池子不足 3 部就少显示」 */
const ONLY = Number(params.get("only") || 0);
const CUR_ID = 12;

type Call = { cmd: string; args: Record<string, unknown>; at: number };
const calls: Call[] = [];

const video = (id: number, title: string) => ({
  id, title, cover: "https://fixture.invalid/poster.jpg", tags: ["都市"], score: 8.2, hot: 1000,
  episode_count: 10, total_episodes: 10, is_finished: 1, is_original: 0, is_hot: 0,
  like_count: 0, comment_count: 0, collect_count: 0, description: "",
});

/* 上游 related：同一个 id 恒返回这 8 条（这正是旧代码「换一批永远一样」的原因） */
const RELATED = [9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008].map((id) => video(id, `关联剧 ${id}`));
const FEED_PAGES: Record<number, ReturnType<typeof video>[]> = {
  1: [9101, 9102, 9103, 9104, 9105, 9106].map((id) => video(id, `推荐流 ${id}`)),
  2: [9201, 9202, 9203, 9204].map((id) => video(id, `推荐流 ${id}`)),
};
const paged = (items: unknown[], page: number) => ({ items, pagination: { page, pages: 3, size: 24, total: 60 } });

const invoke = (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
  if (cmd === "debug_log" || cmd === "playback_log_write") return Promise.resolve();
  if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
  calls.push({ cmd, args, at: Date.now() });
  if (FAIL) {
    if (cmd === "api_related") return Promise.resolve({ items: [] });
    if (cmd === "api_feed") return Promise.resolve(paged([], Number(args.page ?? 1)));
    return Promise.resolve(null);
  }
  if (cmd === "api_related") return Promise.resolve({ items: ONLY ? RELATED.slice(0, ONLY) : RELATED });
  if (cmd === "api_feed") return Promise.resolve(paged(ONLY ? [] : FEED_PAGES[Number(args.page ?? 1)] ?? [], Number(args.page ?? 1)));
  return Promise.resolve(null);
};

const fixture = {
  calls,
  ready: false,
  curId: CUR_ID,
  resetCalls() { calls.length = 0; },
  relatedCalls() { return calls.filter(c => c.cmd === "api_related").length; },
  feedCalls() { return calls.filter(c => c.cmd === "api_feed").length; },
};

Object.assign(window, { endPoolFixture: fixture, __TAURI_INTERNALS__: { invoke } });

function Harness() {
  const end = useEndPool(CUR_ID);
  fixture.ready = true;
  /* 与播放页一致：打开结束态先取一批 */
  React.useEffect(() => { void end.next(); /* eslint-disable-next-line */ }, []);
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#101014" }}>
        <EndCard
          title="测试剧集"
          totalEpisodes={24}
          recs={end.recs}
          busy={end.busy}
          hint={end.hint}
          onRegen={() => void end.next(true)}
          onOpen={(id) => { (window as unknown as { endOpened?: number[] }).endOpened = [...((window as unknown as { endOpened?: number[] }).endOpened ?? []), id]; }}
          onReplay={() => { (window as unknown as { endReplay?: number }).endReplay = ((window as unknown as { endReplay?: number }).endReplay ?? 0) + 1; }}
          onSwipeClose={() => { (window as unknown as { endClosed?: number }).endClosed = ((window as unknown as { endClosed?: number }).endClosed ?? 0) + 1; }}
        />
      </div>
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Harness />);
