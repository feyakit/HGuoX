import { LiquidIndicator, Loader } from "../shared/ui/ios/effects";
import { Button } from "../shared/ui/ios/controls";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import SeriesDetail from "../features/feed/SeriesDetail";
import { useStore, type Page, type Tab } from "../shared/model/store";
import { PageCoveredContext } from "../shared/model/pageVisibility";
import { accentTokens, FALLBACK_SCHEME } from "../shared/ui/accent";
import { isMobile, selfTest } from "../shared/api/api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "../shared/lib/back";
import { backgroundOrExit } from "../shared/lib/androidBack";
import Home from "../features/feed/Home";
import LoginModal from "../features/account/LoginModal";
import GuestMergePrompt from "../features/account/GuestMergePrompt";
import { ToastHost } from "../shared/ui/ui";
import { DesktopRail, DesktopTitleBar } from "./shell/DesktopChrome";
import ResizeHandles from "./shell/ResizeHandles";
import { tracePlayback } from "../shared/diagnostics/playbackDiagnostics";
import { INavCategory, INavCommunity, INavHome, INavProfile } from "../shared/ui/icons";

// Local chunks load on first visit; visited tabs stay mounted as before.
/* 播放器整条链（Feed → EpisodePlayer → VideoSurface → hls.js）单独成 chunk：
   它是入口包里最重的一块（hls.js + 2300 行播放器），首屏一个字都用不到。
   点播时才拉本地协议里的这个 chunk，几毫秒的事。 */
const Feed = lazy(() => import("../features/feed/Feed"));
const EndlessFeed = lazy(() => import("../features/feed/EndlessFeed"));
const Search = lazy(() => import("../features/search/Search"));
const RankPage = lazy(() => import("../features/search/Search").then(module => ({ default: module.RankPage })));
const Category = lazy(() => import("../features/category/Category"));
const ChannelPage = lazy(() => import("../features/category/Category").then(module => ({ default: module.ChannelPage })));
const Profile = lazy(() => import("../features/account/Profile"));
const HistoryPage = lazy(() => import("../features/account/Profile").then(module => ({ default: module.HistoryPage })));
const FavoritesPage = lazy(() => import("../features/account/Profile").then(module => ({ default: module.FavoritesPage })));
const SettingsPage = lazy(() => import("../features/settings/Settings"));
const SettingsTagsPage = lazy(() => import("../features/settings/SettingsTags"));
const PostsPage = lazy(() => import("../features/posts/Posts").then(module => ({ default: module.PostsPage })));
const PostDetail = lazy(() => import("../features/posts/Posts").then(module => ({ default: module.PostDetail })));
const TopicsPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TopicsPage })));
const TopicPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TopicPage })));
const TagsPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TagsPage })));
const TagPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TagPage })));
const FollowingPage = lazy(() => import("../features/account/User").then(module => ({ default: module.FollowingPage })));
const UserPage = lazy(() => import("../features/account/User").then(module => ({ default: module.UserPage })));

function PageLoading() {
  return <div className="absolute inset-0 grid place-items-center bg-bg"><Loader label="页面加载中" /></div>;
}

const SELECTABLE_TEXT = 'input, textarea, [contenteditable="true"], .select-text, .article-body';
const isSelectableText = (target: EventTarget | null) => target instanceof Element && !!target.closest(SELECTABLE_TEXT);

function TabBar({ onSelect }: { onSelect?: () => void }) {
  const { tab, setTab } = useStore();
  const items = [
    { key: "home", label: "首页", Icon: INavHome },
    { key: "posts", label: "吃瓜", Icon: INavCommunity },
    { key: "category", label: "分类", Icon: INavCategory },
    { key: "profile", label: "我的", Icon: INavProfile },
  ] as const;
  const index = items.findIndex(item => item.key === tab);
  return <nav className="hg-tabbar ios-mobile-nav" aria-label="主导航" data-over-video={tab === "home"}>
      <div className="hg-glass">
      <div className="hg-drop" aria-hidden="true" style={{ transform: `translateX(${Math.max(0, index) * 100}%)` }}><LiquidIndicator /></div>
      <div className="ios-mobile-nav-items">
        {items.map(({ key, label, Icon }) => (
          <Button key={key} className="ios-mobile-nav-item" onClick={() => { onSelect?.(); setTab(key); }}
            aria-current={tab === key ? "page" : undefined}>
            <Icon solid={tab === key} /><span>{label}</span>
          </Button>
        ))}
      </div>
    </div>
  </nav>;
}

/* ============ 堆栈页面（统一二级页：隐藏底栏，左上角返回原页面） ============ */
function StackPage(props: Parameters<typeof StackPageContent>[0]) {
  return <Suspense fallback={<PageLoading />}><StackPageContent {...props} /></Suspense>;
}

function StackPageContent({ page, onBack, wide, top, bottomInset, loginOpen }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number; loginOpen: boolean;
}) {
  /* 登录框是浮在最上面的模态：它开着的时候播放页不能再算 active，
     否则底下的视频还在抢音频焦点/字幕层（上游 496b6ff）。 */
  const pageActive = top && !loginOpen;
  if (page.kind === "feed") {
    if (page.endless) {
      return (
        <EndlessFeed title={page.title} active={pageActive} bottomInset={bottomInset} onBack={onBack} />
      );
    }
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime}
        mode="context" active={pageActive} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "search") return <Search active={pageActive} wide={wide} initialTab={page.initialTab} onBack={onBack} />;
  if (page.kind === "history") return <HistoryPage onBack={onBack} wide={wide} />;
  if (page.kind === "favorites") return <FavoritesPage onBack={onBack} wide={wide} initialTab={page.initialTab} active={pageActive} />;
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings-tags") return <SettingsTagsPage onBack={onBack} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} active={pageActive} />;
  if (page.kind === "topics") return <TopicsPage onBack={onBack} wide={wide} />;
  if (page.kind === "topic") return <TopicPage slug={page.slug} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "series") return <SeriesDetail id={page.id} onBack={onBack} />;
  if (page.kind === "tags") return <TagsPage onBack={onBack} wide={wide} />;
  if (page.kind === "tag") return <TagPage tag={page.tag} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "following") return <FollowingPage onBack={onBack} wide={wide} />;
  if (page.kind === "user") return <UserPage id={page.id} name={page.name} onBack={onBack} wide={wide} />;
  return null;
}

/** Hide covered pages from the compositor while keeping React state and scroll offsets intact. */
function LayerBox({
  hidden, inert, ariaHidden, className, enterClass, style, children,
}: {
  hidden: boolean;
  inert: boolean;
  ariaHidden: boolean;
  className: string;
  enterClass?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollOffsetsRef = useRef<Map<HTMLElement, number>>(new Map());
  const hadHiddenRef = useRef(hidden);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  if (hidden) hadHiddenRef.current = true;
  const [hasPip, setHasPip] = useState(false);
  const [entering, setEntering] = useState(Boolean(enterClass && !hidden));

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onScroll = (e: Event) => {
      if (hiddenRef.current) return;
      const target = e.target;
      if (target instanceof HTMLElement && root.contains(target)) {
        scrollOffsetsRef.current.set(target, target.scrollTop);
      }
    };
    const syncPip = () => {
      const pip = document.pictureInPictureElement;
      setHasPip(!!pip && root.contains(pip));
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    root.addEventListener("enterpictureinpicture", syncPip, true);
    root.addEventListener("leavepictureinpicture", syncPip, true);
    syncPip();
    return () => {
      root.removeEventListener("scroll", onScroll, true);
      root.removeEventListener("enterpictureinpicture", syncPip, true);
      root.removeEventListener("leavepictureinpicture", syncPip, true);
    };
  }, []);

  useEffect(() => {
    if (!entering || hidden) return;
    // Ensure the enter animation class is stripped even when reduced-motion disables animations.
    const timer = window.setTimeout(() => setEntering(false), 450);
    return () => window.clearTimeout(timer);
  }, [entering, hidden]);

  useLayoutEffect(() => {
    if (hidden) return;
    const saved = scrollOffsetsRef.current;
    if (!saved.size) return;
    for (const [el, top] of Array.from(saved.entries())) {
      if (!el.isConnected) {
        saved.delete(el);
        continue;
      }
      if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
    }
  }, [hidden]);

  const boxStyle: CSSProperties | undefined = hidden && hasPip
    ? { ...style, visibility: "hidden", pointerEvents: "none" }
    : style;
  const boxClass = hidden
    ? (hasPip ? `${className} pointer-events-none` : `${className} hidden pointer-events-none`)
    : `${className}${entering && enterClass && !hadHiddenRef.current ? ` ${enterClass}` : ""}`;

  return (
    <PageCoveredContext.Provider value={hidden}>
      <div
        ref={ref}
        inert={inert}
        aria-hidden={ariaHidden}
        className={boxClass}
        style={boxStyle}
        onAnimationEnd={(e) => { if (e.target === ref.current) setEntering(false); }}
      >
        {children}
      </div>
    </PageCoveredContext.Provider>
  );
}

/* ============ 一级常驻底栏模块（仅挂载 4 个真实主模块） ============ */
function MainTabs({ wide, pageActive, covered, bottomInset }: { wide: boolean; pageActive: boolean; covered: boolean; bottomInset: number }) {
  const { tab } = useStore();
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set());
  useEffect(() => {
    if (pageActive) setVisited(previous => previous.has(tab) ? previous : new Set([...previous, tab]));
  }, [tab, pageActive]);
  const mounted = (key: Tab) => visited.has(key) || (pageActive && tab === key);
  const visible = (key: Tab) => tab === key ? `absolute inset-0 ${key === "home" ? "" : "ios-tab-active"}` : "absolute inset-0 hidden pointer-events-none";
  // First visits mount on demand; subsequent switches preserve queries, scroll and playback state.
  return (
    <LayerBox hidden={covered} inert={covered} ariaHidden={covered} className="absolute inset-0">
      <div className={visible("home")} inert={!pageActive || tab !== "home"} aria-hidden={!pageActive || tab !== "home"}>{mounted("home") && <Home active={pageActive && tab === "home"} bottomInset={bottomInset} />}</div>
      <div className={visible("posts")} inert={!pageActive || tab !== "posts"} aria-hidden={!pageActive || tab !== "posts"}>{mounted("posts") && <Suspense fallback={<PageLoading />}><PostsPage wide={wide} embedded active={pageActive && tab === "posts"} /></Suspense>}</div>
      <div className={visible("category")} inert={!pageActive || tab !== "category"} aria-hidden={!pageActive || tab !== "category"}>{mounted("category") && <Suspense fallback={<PageLoading />}><Category wide={wide} active={pageActive && tab === "category"} /></Suspense>}</div>
      <div className={visible("profile")} inert={!pageActive || tab !== "profile"} aria-hidden={!pageActive || tab !== "profile"}>{mounted("profile") && <Suspense fallback={<PageLoading />}><Profile wide={wide} /></Suspense>}</div>
    </LayerBox>
  );
}

function AppBody() {
  const { platform, setTab, stack, pop, push, loginOpen, setLoginOpen, fs, setFs, clean } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!isMobile);
  const [collapsed] = useState(false);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  /* 全局键盘 */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      /* Esc 与安卓返回键同序：先退沉浸全屏（并把方向还原交给播放器），再退栈。 */
      if (e.key === "Escape") {
        if (fs) { setFs(false); return; }
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
        if (stack.length) pop();
        return;
      }
      if (e.key === "/") { e.preventDefault(); push({ kind: "search" }); return; }
      if (stack.length === 0 && ["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "posts", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, push, setTab, loginOpen, setLoginOpen]);

  const pageActive = stack.length === 0 && !loginOpen;
  const bottomInset = isMobile ? (fs || clean ? 0 : 74) : 14;
  const stackInset = isMobile ? 0 : 14;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!isMobile && <DesktopRail collapsed={collapsed} />}
      {/* data-stack=1 表示正在看栈页（详情/播放器）：横屏的 440 限宽不能套在播放器上，
          否则全屏层会被压成手机宽度、右边留黑（真机 iOS 横屏只占左半边）。 */}
      <div ref={mainRef} data-stack={stack.length ? "1" : "0"} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <MainTabs wide={wide} pageActive={pageActive} covered={stack.length > 0} bottomInset={bottomInset} />

        {stack.map((p, i) => {
          const top = i === stack.length - 1;
          return (
            <LayerBox
              key={p.key}
              hidden={!top}
              inert={!top || loginOpen}
              ariaHidden={!top || loginOpen}
              className="absolute inset-0 bg-bg isolate"
              enterClass={platform === "android" && p.kind === "feed" ? undefined : "a-page-in"}
              style={{ zIndex: 30 + i }}
            >
              <StackPage page={p} onBack={pop} wide={wide} top={top} bottomInset={stackInset} loginOpen={loginOpen} />
            </LayerBox>
          );
        })}

        {isMobile && !fs && !clean && stack.length === 0 && <TabBar />}
      </div>
    </div>
  );
}

/* ============ 桌面窗口壳（Windows / macOS / Linux）============ */
function DesktopShell() {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1100);
  useEffect(() => {
    const query = matchMedia("(max-width: 1099px)");
    const update = () => setCollapsed(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const { theater, platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      <DesktopTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={collapsed || theater} theater={theater} />
      </div>
      {/* 边缘缩放热区只对无边框窗口（Windows / Linux）有效，macOS 走原生窗口边框 */}
      {(platform === "windows" || platform === "linux") && <ResizeHandles />}
    </div>
  );
}

function ShellInner({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { stack, pop, push, loginOpen, setLoginOpen, setTab, platform, fs, setFs } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      /* Esc 与安卓返回键同序：先退沉浸全屏（并把方向还原交给播放器），再退栈。 */
      if (e.key === "Escape") {
        if (fs) { setFs(false); return; }
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
        if (stack.length) pop();
        return;
      }
      if (e.key === "/") { e.preventDefault(); push({ kind: "search" }); return; }
      if (stack.length === 0 && ["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "posts", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, push, setTab, loginOpen, setLoginOpen]);

  const pageActive = stack.length === 0 && !loginOpen;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!theater && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${theater ? "is-theater-main" : ""}`}>
        <MainTabs wide={wide} pageActive={pageActive} covered={stack.length > 0} bottomInset={14} />
        {stack.map((p, i) => {
          const top = i === stack.length - 1;
          return (
            <LayerBox
              key={p.key}
              hidden={!top}
              inert={!top || loginOpen}
              ariaHidden={!top || loginOpen}
              className="absolute inset-0 bg-bg isolate"
              enterClass="win-page-in"
              style={{ zIndex: 30 + i }}
            >
              <StackPage page={p} onBack={pop} wide={wide} top={top} bottomInset={14} loginOpen={loginOpen} />
            </LayerBox>
          );
        })}
      </div>
    </div>
  );
}

/* ============ 移动端（无壳） ============ */
function MobileShell() {
  const { platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={{
        "--sat": "max(env(safe-area-inset-top), 24px)",
        /* --sab 不在这里写死：iOS/桌面由 CSS 的 env(safe-area-inset-bottom) 给，
           安卓由 Kotlin（src-tauri/android/.../SafeArea.kt）运行时把真实 WindowInsets
           写进 :root 的 --sab。历史上的 max(env,24px) 兜底会把底栏顶高 8px（小米9 实测 16）。 */
        /* 横向安全区只在横屏/刘海屏才有值；竖屏恒为 0，所以不给下限，
           给下限会把竖屏两侧各推出几像素（上游 7ab0a51 的做法）。 */
        "--sar": "env(safe-area-inset-right, 0px)",
        "--sal": "env(safe-area-inset-left, 0px)",
      } as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ 入口 ============ */
export default function App() {
  const { platform, accent, loginOpen, setLoginOpen, tab, setTab, stack, pop, push, fs, setFs } = useStore();

  /* 深链：?series=<id> 直接进剧集详情页（也方便截图脚本与外部跳转） */
  const __hguoxDeepLink = useRef(false);
  useEffect(() => {
    if (__hguoxDeepLink.current) return;
    __hguoxDeepLink.current = true;
    try {
      const id = Number(new URLSearchParams(location.search).get("series"));
      if (id > 0) push({ kind: "series", id });
    } catch { /* ignore */ }
  }, [push]);

  /* 全站强调色固定为设计紫 #7C5CFF（避免封面取色导致紫/鲑红来回跳变）。
     配色只有深色一套（浅色主题已整体删除），所以 accentTokens 的 light 恒为 false。 */
  useEffect(() => {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(accentTokens(FALLBACK_SCHEME, false))) {
      root.style.setProperty(key, value);
    }
  }, [accent]);
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

  /* iOS keeps player gestures free of selection handles while inputs and reading text
     retain native selection/copy. Pointer targeting also handles non-focusable articles. */
  useEffect(() => {
    if (platform !== "ios") return;
    let last: boolean | null = null;
    const setTI = (enabled: boolean) => {
      if (last === enabled) return;
      last = enabled;
      invoke("set_text_interaction", { enabled }).catch(() => { last = null; });
    };
    const onDown = (e: Event) => setTI(isSelectableText(e.target));
    const onFocusOut = (e: FocusEvent) => {
      // A touch on an article can blur an input with relatedTarget=null after pointerdown.
      // Keep that pointer decision; the next control interaction explicitly disables selection.
      if (e.relatedTarget) setTI(isSelectableText(e.relatedTarget));
    };
    document.addEventListener("touchstart", onDown, { capture: true, passive: true });
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    document.addEventListener("focusin", onDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, [platform]);

  /* —— 安卓硬件返回键 ——
     层级：面板/弹层 → 全屏 → 登录框 → 页面栈 → 回首页 → 退出应用。
     不注册这个监听，Tauri 会直接 webView.goBack() 或退出，表现就是「任意页面返回都回桌面」。 */
  const backRef = useRef<() => void>(() => {});
  const lastBackAt = useRef(0);
  backRef.current = () => {
    const now = Date.now();
    if (now - lastBackAt.current < 250) return;
    lastBackAt.current = now;
    if (runBack()) return;                                  // 最上层弹窗/播放器面板
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    /* 3.0.21 F：桥「不存在 / 返回 false / 抛异常」三种情况都必须真的退出应用
       （实现在 shared/lib/androidBack.ts，harness 三种情况都跑过）。
       以前这里是裸调用：Kotlin 侧一抛异常整个回调就抛出去，返回键**完全没反应**。 */
    backgroundOrExit(invoke);
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => { if (!isSelectableText(e.target)) e.preventDefault(); };
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    const warm = () => {
      void import("../features/posts/Posts");
      void import("../features/category/Category");
      void import("../features/account/Profile");
      void import("../features/settings/Settings");
      void import("../features/search/Search");
      /* 播放器链（EpisodePlayer + hls.js，~600KB）现在按需 chunk：
         点「播放」时再拉会多等一次下载+解析（实测 +400~600ms 首帧）。
         首屏稳定后空闲时先把它拉到内存里，点播瞬间起播。 */
      void import("../features/feed/Feed");
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) {
      const id = ric(warm, { timeout: 2200 });
      return () => (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(warm, 900);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <LoginModal />
      <GuestMergePrompt />
      <ToastHost />
    </>
  );
}
