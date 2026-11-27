import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import StartupGate from "./app/startup/LaunchAnimation";
import { AppProvider } from "./shared/model/store";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { initPlaybackLog, installPlaybackPageEvents, tracePlayback } from "./shared/diagnostics/playbackDiagnostics";
import { initAutoLine } from "./shared/network/autoLine";
import { APP_VERSION, LOCAL, logLine, platform, webviewVersion } from "./shared/api/api";
import { mseHlsSupported } from "./features/playback/mediaProbe";
import { installLayoutDiagnostics } from "./shared/diagnostics/layoutDiagnostics";
import { installViewportVars } from "./shared/lib/viewport";
import { installFxLevel } from "./shared/lib/fx";
installFxLevel();
installViewportVars();
installPlaybackPageEvents();
void initPlaybackLog();
/* 安卓安全区桥（src-tauri/android/.../SafeArea.kt）写 --sab 时顺带打点：
   真机核验在 debug.log 里搜 `[safearea]`，应看到 inset_px=44 css=16 mode=gesture。
   这里只是接收方 —— 值由 Kotlin 写入 :root，前端不再自己算 --sab。 */
(window as unknown as { __hgSafeAreaLog?: (px: number, css: number, mode: string) => void }).__hgSafeAreaLog =
  (px, css, mode) => {
    const applied = getComputedStyle(document.documentElement).getPropertyValue("--sab").trim();
    logLine(`[safearea] inset_px=${px} css=${css} mode=${mode} applied=${applied || "(空)"}`);
  };
/* 环境指纹：写进始终记录的 debug.log。用户复制诊断时不用再自报版本、平台、内核版本 */
const hlsOk = mseHlsSupported();
logLine(
  `[env] ver=${APP_VERSION} platform=${platform} webview=${webviewVersion} ` +
    `engine=${hlsOk ? "hls.js" : "native"} ` +
    `mss=${"MediaSource" in window ? "y" : "n"} media=${LOCAL} ` +
    `screen=${screen.width}x${screen.height} dpr=${devicePixelRatio} lang=${navigator.language}`,
);

/* 环境指纹也进结构化日志（开诊断后不会只有一行空跑） */
tracePlayback("app.env", {
  ver: APP_VERSION, platform, webview: webviewVersion,
  engine: hlsOk ? "hls.js" : "native",
  media_source: "MediaSource" in window, managed_media_source: "ManagedMediaSource" in window,
  media_scheme: LOCAL.split(":")[0], screen: `${screen.width}x${screen.height}`,
  dpr: devicePixelRatio, lang: navigator.language,
});
/* 运行期错误统一落到 debug.log，便于自查 */
function report(kind: string, msg: string) {
  invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
  tracePlayback(`app.${kind}`, { detail: msg });
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

/* iOS 底部留白：改用 CSS 100dvh（见 index.css）动态跟踪可视高度。
   不再用 JS 在启动时钉死 html 高度——启动瞬间 visualViewport.height 尚未
   完成布局，抓到错误值会把 html 高度锁死，正是「底部留白、旋转一次才恢复」的根因。 */

/** 3.0.0 起删掉首启「使用条款」闸门；把旧安装留下的确认记录一并清掉，不留死键。 */
try {
  localStorage.removeItem("hguox_usage_agreement");
  localStorage.removeItem("usage_agreement");
} catch { /* 隐私模式/配额异常时忽略 */ }

/** 启动后立刻开始账号恢复与线路探测（不再等任何确认动作）。 */
function AcceptedApplication() {
  React.useEffect(() => { initAutoLine(); }, []);
  return <AppProvider><App /></AppProvider>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StartupGate><AcceptedApplication /></StartupGate>
  </React.StrictMode>,
);
installLayoutDiagnostics();
