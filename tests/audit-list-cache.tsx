/**
 * 审计 #14 / #15 的回归探针（真 React 组件 + 真 store，只 mock Tauri IPC）。
 *
 * #15 useAutoLoadMore 的 resetKey 必须是 effect 依赖：
 *   换列表时条数 / hasMore / busy 往往都没变，依赖里没有 resetKey 的话 effect 不重跑，
 *   「新列表第一批已被触发过」的记录不会作废 → 新列表 12 条被旧的 12 挡死、永远不再加批。
 *   探针用可控的 IntersectionObserver 把「进到底部」变成确定事件，只看回调次数。
 *
 * #14 收藏「新更 N 集」徽标点开必须消失：
 *   徽标在 progress.ep === 基线（追上了旧基线、但剧又更了）时仍然会显示，旧代码的认账条件
 *   还要求 progress.ep < 基线 —— 相等就跳过 ack，点了白点。这里直接驱动真的 FavoritesPage：
 *   点卡片前后读徽标文案。
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { FavoritesPage } from "../src/features/account/Profile";
import { useAutoLoadMore } from "../src/features/account/useAutoLoadMore";
import "../src/index.css";

type DetailFixture = { id: number; title: string; cover: string; episode_count: number; total_episodes: number };
const DETAILS: Record<number, DetailFixture> = {
  7: { id: 7, title: "收藏卡 7", cover: "", episode_count: 24, total_episodes: 24 },
};

Object.assign(window, {
  isTauri: true,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 0; },
    unregisterCallback() {},
    invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === "app_boot") return Promise.resolve({ strict_security: true, base: "https://fixture.invalid", user: null, logged_in: false });
      if (command === "debug_log" || command === "playback_log_write") return Promise.resolve();
      if (command === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
      if (command === "api_video") {
        const id = Number(args.id);
        return Promise.resolve(DETAILS[id] ?? null);
      }
      return Promise.resolve(null);
    },
  },
});

/* ---- 确定性的 IntersectionObserver：observe 后立刻报「看见 sentinel」 ---- */
const autoLoadCalls: string[] = [];
class ImmediateObserver {
  private cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) { this.cb = cb; }
  observe() { window.setTimeout(() => this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver), 0); }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
Object.assign(window, { IntersectionObserver: ImmediateObserver, autoLoadCalls });

function AutoLoadProbe() {
  const [resetKey, setResetKey] = useState("video");
  const [count, setCount] = useState(12);
  Object.assign(window, {
    autoLoadSetResetKey: (key: string) => setResetKey(key),
    autoLoadSetCount: (next: number) => setCount(next),
  });
  const { scrollerRef, sentinelRef } = useAutoLoadMore({
    hasMore: true,
    count,
    resetKey,
    onMore: () => { autoLoadCalls.push(`${resetKey}:${count}`); },
  });
  return (
    <div ref={scrollerRef} style={{ height: 120, overflow: "auto" }} data-testid="scroller">
      <div style={{ height: 60 }} />
      <div ref={sentinelRef} style={{ height: 1 }} data-testid="sentinel" />
    </div>
  );
}

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <FavoritesPage onBack={() => {}} wide={false} initialTab="video" active />
    <AutoLoadProbe />
  </AppProvider>,
);
