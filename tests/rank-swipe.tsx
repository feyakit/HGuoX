import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { RankPage } from "../src/features/search/Search";
import "../src/index.css";

// 上游 66e02b4 回归探针：排行榜三个 tab 左右滑切。
const rankCalls: string[] = [];
Object.assign(window, { rankFixture: { calls: rankCalls } });

Object.assign(window, {
  isTauri: true,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 0; },
    unregisterCallback() {},
    invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === "app_boot") return Promise.resolve({ strict_security: true, base: "https://fixture.invalid", user: null });
      if (command === "debug_log" || command === "playback_log_write") return Promise.resolve();
      if (command === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
      if (command === "api_rank") {
        const kind = String(args.kind);
        rankCalls.push(kind);
        return Promise.resolve({
          type: kind,
          items: [
            { video_id: 1, title: `剧一 ${kind}`, cover: "", metric_value: 9000, metric_label: "热度", rank: 1 },
            { video_id: 2, title: `剧二 ${kind}`, cover: "", metric_value: 5000, metric_label: "热度", rank: 2 },
            { video_id: 3, title: `剧三 ${kind}`, cover: "", metric_value: 3000, metric_label: "热度", rank: 3 },
            { video_id: 4, title: `剧四 ${kind}`, cover: "", metric_value: 1000, metric_label: "热度", rank: 4 },
          ],
        });
      }
      return Promise.resolve(null);
    },
  },
});

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <RankPage onBack={() => {}} wide={false} />
  </AppProvider>,
);
