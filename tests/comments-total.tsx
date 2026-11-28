/* 3.0.21 E：评论总数 onTotalChange 真的接上了。
 *
 * 三层都要真跑：
 *   ① CommentsPanel 加载完第一页后回传 pagination.total（不再是死代码）；
 *   ② 父组件用回传值覆盖「打开前那个旧数字」（播放页角标 / 吃瓜头部的写法）；
 *   ③ 回传值为 0 时不被 `?? ` 吞掉（0 条评论也是真结果）。
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { CommentsPanel } from "../src/features/feed/Panels";
import "../src/index.css";

const TOTAL = 37;
const fixture = { totals: [] as number[], calls: 0, totalOverride: null as number | null };

Object.assign(window, {
  isTauri: true,
  commentsTotalFixture: fixture,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 0; },
    unregisterCallback() {},
    invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === "app_boot") return Promise.resolve({ strict_security: true, base: "https://fixture.invalid", user: null });
      if (command === "debug_log" || command === "playback_log_write" || command === "net_log") return Promise.resolve();
      if (command === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
      if (command === "api_comments") {
        fixture.calls += 1;
        const page = Number(args.page) || 1;
        const total = fixture.totalOverride ?? TOTAL;
        return Promise.resolve({
          /* total=0 时服务端没有评论，items 也为空（面板按「0 是真结果」处理） */
          items: page === 1 && total > 0
            ? [
                { id: 1, user_id: 11, nickname: "甲", time: "1 分钟前", text: "好看", like_count: 1, reply_count: 0 },
                { id: 2, user_id: 12, nickname: "乙", time: "2 分钟前", text: "追到停不下来", like_count: 0, reply_count: 0 },
              ]
            : [],
          pagination: { page, pages: 2, size: 20, total },
        });
      }
      return Promise.resolve(null);
    },
  },
});

/* 模拟播放页的写法：meta.comment（打开前的旧值）→ commentLive（面板回传）覆盖 */
function Harness() {
  const [live, setLive] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const before = 3; // 详情接口给的旧值（已过期）
  const badge = live ?? before;
  Object.assign(window, {
    commentsSetTotal: (value: number) => setLive(value),
    /* 换一条评论流（模拟换剧/换集）：live 必须被清掉，回到 before */
    commentsRemount: () => { setLive(null); setGeneration((value) => value + 1); },
  });
  return (
    <div>
      <div id="badge">评论 {badge} 条</div>
      <div style={{ height: 480 }}>
        <CommentsPanel key={generation} videoId={9} ep={3} total={before} kind="video"
          onTotalChange={(total) => { fixture.totals.push(total); setLive(total); }}
          onClose={() => {}} />
      </div>
    </div>
  );
}

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Harness />
  </AppProvider>,
);
