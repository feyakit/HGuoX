/* 3.0.21 B：榜单切 tab 必须回到顶部（与官网/主流短剧 App 一致），
 * 但「从详情返回」的滚动位不能被抢走（首次挂载不重置）。
 *
 * 真实的 RankView + 真实的滚动容器；只有 Tauri IPC 是假的。
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { RankView } from "../src/features/search/Search";
import "../src/index.css";

const rows = (kind: string) => Array.from({ length: 12 }, (_, index) => ({
  rank: index + 1,
  video_id: index + 1,
  title: `${kind} 第 ${index + 1} 名`,
  cover: "",
  tags: ["都市"],
  score: 8,
  cate_name: "都市",
  episode_count: 24,
  total_episodes: 24,
  is_finished: 1,
  metric_value: 1000 - index * 10,
  metric_label: "热度",
}));

const fixture = {
  requested: [] as string[],
  /** 重新挂载 RankView（模拟「从详情页返回」后组件重建） */
  remount: () => {},
  scroller(): number {
    const el = document.querySelector("#scroller") as HTMLElement | null;
    return el ? Math.round(el.scrollTop) : -1;
  },
  scrollTo(top: number) {
    const el = document.querySelector("#scroller") as HTMLElement | null;
    if (el) el.scrollTop = top;
    return fixture.scroller();
  },
};

Object.assign(window, {
  isTauri: true,
  rankScrollFixture: fixture,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 0; },
    unregisterCallback() {},
    invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === "app_boot") return Promise.resolve({ strict_security: true, base: "https://fixture.invalid", user: null });
      if (command === "debug_log" || command === "playback_log_write" || command === "net_log") return Promise.resolve();
      if (command === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
      if (command === "api_rank") {
        const kind = String(args.kind || "hot");
        fixture.requested.push(kind);
        return Promise.resolve({ items: rows(kind) });
      }
      return Promise.resolve(null);
    },
  },
});

function Harness() {
  const [generation, setGeneration] = useState(0);
  fixture.remount = () => setGeneration((value) => value + 1);
  return (
    <div id="scroller" className="scroll-y" style={{ height: 360, overflowY: "auto", width: 420 }}>
      <div style={{ height: 40 }} />
      {/* 固定最小高度：榜单加载中/加载完的内容高度一致，滚动位不会被浏览器夹掉，
          这样「重新挂载后 scrollTop 还是原值」就是硬断言 */}
      <div style={{ minHeight: 1400 }}>
        <RankView key={generation} wide={false} active />
      </div>
      <div style={{ height: 900 }} />
    </div>
  );
}

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Harness />
  </AppProvider>,
);
