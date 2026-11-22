# 开发与构建指南

本文档说明 `HGuoX` 的技术架构、目录结构、本地开发调试、构建校验以及环境变量约定。

## 技术栈

| 层级 | 技术选型 |
| :--- | :--- |
| 原生壳与网络核心 | Rust · Tauri 2 · Tokio · Reqwest |
| 前端界面与状态 | React 19 · TypeScript 5 · Vite 7 · Tailwind CSS 4 |
| 视频播放内核 | `hls.js` + 原生 `<video>` 媒体传输封装 |
| 质量与兼容性检查 | `tsc` · `scripts/check-legacy-css.mjs` · Playwright 自动化校验 |

## 目录结构

```text
HGuoX/
├── src/                    # React 19 前端源码（3.0.9 起对齐上游 app / features / shared）
│   ├── app/                # App 壳：App.tsx、shell/（底栏、导航栈、页面转场）、startup/（启动动画与启动锁）
│   ├── features/           # 业务域：feed（首页/剧集流）、category、discover、posts（吃瓜）、
│   │                       #   playback（播放器与手势）、search、account、settings
│   ├── shared/             # 跨域共享：
│   │   ├── api/            #   命令封装、数据拉取与内存缓存
│   │   ├── model/          #   store.tsx（全局状态、导航栈与持久化）
│   │   ├── network/        #   autoLine.ts / linePolicy.ts（自动选线与偏好线路策略）
│   │   ├── storage/        #   hguox_* 键与 hghub_* 迁移
│   │   ├── ui/             #   cards / ui / ios 控件与图标
│   │   ├── lib/            #   usePullToRefresh、useTabSwipe 等通用钩子
│   │   └── diagnostics/    #   布局与播放诊断
│   └── styles/             # 莫比乌斯极光玻璃样式（ios.css / shelf.css / launch.css / ambient-glow.css）
├── src-tauri/              # Rust / Tauri 2 原生工程
│   ├── src/                # api / media（封面与分片代理）/ lines（并发选线）/ net（信封、DoH、fake-ip）/
│   │                       #   session（登录态与可信线路）/ playback_log / channel_page
│   └── tauri.conf.json     # Tauri 应用配置（identifier = com.dusk.player）与版本信息
├── scripts/                # 版本号对齐、图标生成、CSS 兼容性检查与 test-*.mjs 回归脚本
├── docs/                   # 控件清单、已知问题、遗留问题、上游同步评估、线路策略、release-notes
└── .github/workflows/      # CI 检查与五端（Android/iOS/Windows/macOS/Linux）Release 流水线
```

## 环境准备

- **Node.js**：22+
- **包管理器**：`pnpm` 10+（项目通过 `package.json` 中的 `pnpm` 锁定依赖）
- **Rust**：`stable` 工具链（构建原生端时需配置对应平台 target，如 Android NDK / Xcode）

## 常用命令

```bash
# 安装前端依赖
pnpm install --frozen-lockfile

# 启动纯前端开发服务器
pnpm dev

# 启动 Tauri 桌面端开发调试
pnpm app:dev

# 启动 Android 调试（需先初始化或连接设备）
pnpm android:dev

# 类型检查 + 生产构建 + 老内核 CSS 兼容性检查
pnpm build

# 打包桌面端 / Android 安装包
pnpm app:build
pnpm android:build
```

## 自动化校验脚本

`package.json` 中内置了多项回归校验脚本：

```bash
pnpm test:playback          # 播放器与播放链路检查
pnpm test:player-gestures   # 播放器手势纯函数（死区/方向锁/双击/换集门槛/整页 pager）
pnpm test:line-selection    # 自动选线策略校验
pnpm test:line-session-keep # 切可信线路后仍保持登录
pnpm test:storage-migration # hghub_* -> hguox_* 存储迁移校验
pnpm test:network-settings  # 网络设置与诊断脱敏校验
pnpm test:mobile-layout     # 移动端布局校验
pnpm test:safe-area         # 移动端安全区按视口尺寸生效
pnpm test:keyboard-sheet    # 键盘弹出时表单不被遮挡
pnpm test:post-flicker      # 吃瓜详情：正文图片不被重建、缓冲转圈 300ms 去抖
pnpm test:tab-swipe         # 「我的」/频道页左右滑切 tab
pnpm test:rank-swipe        # 榜单三 tab 左右滑切
pnpm test:balance-volume    # 平衡音量（默认关）
pnpm test:glow-crossorigin  # 播放器微光在安卓取不到画面（crossOrigin + CORS）
pnpm test:startup-lock      # 启动锁与两阶段挂载
pnpm test:ui-performance    # UI 性能基线校验
```

`pnpm build` 已经串了 `tsc --noEmit`、`tsc -p tsconfig.tests.json`、`vite build` 与 `node scripts/check-legacy-css.mjs`，提交前跑这一条就够；需要单独查老内核 CSS 兼容问题时直接跑 `node scripts/check-legacy-css.mjs`。

## 环境变量与存储兼容

- **环境变量**：统一使用 `HGUOX_PROXY`、`HGUOX_STRICT`、`HGUOX_TEST_COVER_URL`、`HGUOX_TEST_MEDIA_URL`、`HGUOX_TEST_MEDIA_OUTPUT`。旧 `HGHUB_*` 名称仅在对应 `HGUOX_*` 未设置时作为回退兼容；显式设置的新值（包括空值）优先。命令行安全模式参数优先级高于环境变量。
- **本地存储**：本地收藏、观看记录、偏好、切集迁移标记与主题使用 `hguox_*` 存储键。首次启动时会自动将同 WebView 存储空间内的旧 `hghub_*` 数据迁移到新键，确认写入成功后清理旧键。

## 版本发布

正式发版通过推送 `v*` 标签自动触发 [release.yml](.github/workflows/release.yml) 完成五端构建与 GitHub Release 发布：

```bash
node scripts/set-version.mjs <新版本号>     # 例：3.0.9
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "chore(release): 版本号 <新版本号>"
git tag v<新版本号>
git push origin main v<新版本号>
```

版本号由 `scripts/set-version.mjs` 一处改四处（`package.json`、`src-tauri/Cargo.toml`、`Cargo.lock`、`tauri.conf.json`），不要手改。
