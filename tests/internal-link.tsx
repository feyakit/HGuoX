/**
 * 正文里的同源站内短剧链接（`/video/{id}/`）要在 App 内进播放（上游 6cff406）。
 *
 * 真 ArticlePanel（吃瓜图文正文）+ 真 sanitizeHtml + 真 store：
 *  - 点 `/video/123/` → store 里压进一页 `{kind:"feed", videoIds:[123]}`，不再甩给系统浏览器；
 *  - 点外链 → 仍然走 api.openUrl（本台 mock 记录），不压页。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { ArticlePanel } from "../src/features/feed/Panels";
import { AppProvider, useStore } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const opened: string[] = [];
const invoke = (cmd: string, args: Record<string, unknown> = {}) => {
  if (cmd === "app_boot") return Promise.resolve({ user: { id: 7, nickname: "验收" }, logged_in: true, base: "https://fixture.invalid" });
  if (cmd === "open_url" || cmd === "api_open_url") { opened.push(String(args.url || args.u || "")); return Promise.resolve(null); }
  if (cmd === "copy_text" || cmd === "clipboard_write") return Promise.resolve(null);
  return Promise.resolve(null);
};
Object.assign(window, { __TAURI_INTERNALS__: { invoke }, linkFixture: { opened } });

function Probe() {
  const store = useStore();
  (window as unknown as { __stack: () => unknown[] }).__stack = () =>
    store.stack.map((p) => ({ kind: (p as { kind: string }).kind, videoIds: (p as { videoIds?: number[] }).videoIds }));
  return null;
}

const HTML = `<p>正文里提到 <a href="/video/123/">这部剧</a>，还有 <a href="https://example.com/x">外链</a>。</p>`;

function Page() {
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
        <ArticlePanel title="吃瓜标题" html={HTML} onClose={() => { /* noop */ }} />
      </div>
      <Probe />
      <ToastHost />
    </AppProvider>
  );
}

createRoot(document.querySelector("#root")!).render(<Page />);
