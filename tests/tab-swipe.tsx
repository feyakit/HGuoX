import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { FavoritesPage, HistoryPage } from "../src/features/account/Profile";
import { ChannelPage } from "../src/features/category/Category";
import "../src/index.css";

// 上游 29e273a 回归探针：tab 横向滑切。
//   契约 1：左滑 → 下一个 tab；右滑 → 上一个；首尾不循环。
//   契约 2：纵向滑动不得切 tab（列表还能滚）。
//   契约 3：滑完那一下的 click 被吞掉，卡片不会被误开。
const opened: string[] = [];
Object.assign(window, { tabSwipeOpened: opened });

function ipc(command: string, args: Record<string, unknown> = {}) {
  if (command === "app_boot") return Promise.resolve({ strict_security: true, base: "https://fixture.invalid", user: null });
  if (command === "debug_log" || command === "playback_log_write") return Promise.resolve();
  if (command === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
  if (command === "api_video") {
    const id = Number(args.id);
    return Promise.resolve({ id, title: `卡 ${id}`, cover: "", tags: [], score: 8.5, total_ep: 24 });
  }
  if (command === "api_post") {
    const id = Number(args.id);
    return Promise.resolve({ id, title: `帖 ${id}`, cover: "", tags: [], author: { name: "作者" } });
  }
  if (command === "api_category" || command === "api_original_videos") {
    return Promise.resolve({ items: [], pagination: { page: 1, pages: 1, has_more: false } });
  }
  return Promise.resolve(null);
}

Object.assign(window, {
  isTauri: true,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 0; },
    unregisterCallback() {},
    invoke: ipc,
  },
});

function Harness() {
  const [which, setWhich] = useState<"fav" | "hist" | "channel">("fav");
  Object.assign(window, { tabSwipeGo: setWhich });
  return (
    <AppProvider>
      {which === "fav" && <FavoritesPage onBack={() => opened.push("back-fav")} wide={false} initialTab="video" active />}
      {which === "hist" && <HistoryPage onBack={() => opened.push("back-hist")} wide={false} />}
      {which === "channel" && <ChannelPage cate="ai-duanju" name="短剧" onBack={() => opened.push("back-channel")} wide={false} />}
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Harness />);
