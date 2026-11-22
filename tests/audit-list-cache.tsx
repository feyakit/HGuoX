/**
 * 审计 #14 的回归探针（真 React 组件 + 真 store，只 mock Tauri IPC）。
 *
 * #14 收藏「新更 N 集」徽标点开必须消失：
 *   徽标在 progress.ep === 基线（追上了旧基线、但剧又更了）时仍然会显示，旧代码的认账条件
 *   还要求 progress.ep < 基线 —— 相等就跳过 ack，点了白点。这里直接驱动真的 FavoritesPage：
 *   点卡片前后读徽标文案。
 */
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { FavoritesPage } from "../src/features/account/Profile";
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

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <FavoritesPage onBack={() => {}} wide={false} initialTab="video" active />
  </AppProvider>,
);
