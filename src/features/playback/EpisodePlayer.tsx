import { Button, Image, SegmentedControl } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, cover, fmt, fmtTime, hostOf, isMobile, logLine, platform, playlist } from "../../shared/api/api";
import type { Detail, Episode, PlayInfo, Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { Img, Sheet } from "../../shared/ui/ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import { PlaybackProgress, PlaybackTime } from "./PlaybackProgress";
import PlaybackLock from "./PlaybackLock";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "../feed/Panels";
import { registerOverlayBack } from "../../shared/lib/back";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import { createPlaybackClock } from "./playbackClock";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { TagBlockMenu } from "../../shared/ui/TagBlockMenu";
import { markDisliked } from "../feed/feedPrefs";
import VideoDetailsPanel from "../feed/VideoDetailsPanel";
import { PanelSwipeArea } from "../feed/PanelSwipeArea";
import { PreferenceStorageNotice } from "../../shared/ui/PreferenceStorageNotice";
import LineQuickSwitch from "./LineQuickSwitch";
import { getHoldZone, HOLD_DELAY_MS, type HoldZone } from "../feed/mobileHold";
import { playEnter, playExit, originFromPoint } from "./fsTransition";
import { useFadeMount } from "../../shared/lib/useFadeMount";
import {
  GESTURE, PLAYER_TIMING, EPISODE_EASE, canSeek, doubleTapAction, episodeDrag, episodeIntent,
  episodePageProgress, isDoubleTap, isEdgeBackStart,
  lockAxis, relativeSeek, rotationLocked, seekDeltaSeconds, snapSeek, tapVerdict, type Axis,
} from "./playerGestures";
import {
  IBack, IBoltF, IChevR, IChevronDown, IChevronUp, IClose, ICommentF, ICompress, IExpand, IFileText, IGlobe, IHeart, IHeartF, IMore,
  IList, ILockF, IPauseF, IPlayF, ISearch, IStar, IStarF, IVertSwap, IVol, IVolMute } from "../../shared/ui/icons";
import { EndCard } from "./EndCard";
import { useEndPool } from "./useEndPool";
import { ambientStyle } from "../../shared/ui/useAccent";
import type { AccentScheme } from "../../shared/ui/accent";

/* 播放器页固定纯黑：**不跟随封面取色**（用户：只有播放页去掉取色，其他页保留）。
   data-ambient 会是 fallback，氛围层与雾面都不渲染；控件强调色仍是品牌紫。 */
const PLAYER_SCHEME: AccentScheme = {
  accent: "#7C5CFF", second: "#3B82F6", deep: "#000000", tag: "#26263A", source: "fallback", luma: 0,
};

/* 系统方向请求的**唯一出口**（进全屏转横屏、退全屏回竖屏都走它）。
   安卓：Rust 把请求转给 Kotlin 插件 OrientationPlugin（activity.requestedOrientation）；
   iOS：调 objc 锁方向。
   失败**不再退回 CSS 伪横屏**（那条路已整条删除）：只记日志 + 交给调用方弹一条 playback-hint，
   画面停在竖屏沉浸全屏 —— 宁可黑边多一点，也不要「转了 90° 但坐标没转」的半横屏。
   调用一律带日志，真机用「播放诊断」/logcat 分流「JS 没发」还是「发了没成」。 */
function requestOrientation(landscape: boolean, onFail?: (error: unknown) => void) {
  const fail = (error: unknown) => {
    logLine(`[orientation] set_orientation(landscape=${landscape}) 失败：${String(error)}`);
    try { onFail?.(error); } catch { /* ignore */ }
  };
  try {
    void invoke("set_orientation", { landscape })
      .then(() => logLine(`[orientation] set_orientation(landscape=${landscape}) 已下发${platform === "android" ? "（安卓走 Kotlin 插件）" : ""}`))
      .catch(fail);
  } catch (error) { fail(error); }
}

/* 单击判定窗口：首次轻点先等这么久再落「暂停/继续」，
   这样双击（净屏）不会先闪一下暂停。人眼对这个量级不敏感，真机上等的是「有没有反应」。 */
const TAP_DELAY_MS = 180;
/* 移动端控件自动隐藏：显示后这么久没操作才收起来；暂停中、面板打开时不收。
   **全屏与竖屏统一 3s**（原来全屏单独 1.2s，见 PLAYER_TIMING 的注释）。 */
const AUTOHIDE_MS = PLAYER_TIMING.autohideMs;

export type EpisodePlayerProps = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
  /** 刷剧流里点「不感兴趣」：先本地记账并跳下一条，再通知外壳（可选） */
  onDislike?: (id: number) => void;
  /** 当前条目变化时回调（「抖音模式」外壳用它判断是否已在尾部） */
  onActiveIndex?: (index: number) => void;
  /** 无限流：允许 onNearEnd 在 context 模式下也触发，并在右上角显示 ⚡ 序位 */
  endless?: boolean;
  onBlocked?: (id: number) => void;
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

/** 详情 / 选集的左右页签顺序：左滑去下一页，右滑回上一页。 */
const DRAWER_PAGES = ["detail", "episodes"] as const;

export default function EpisodePlayer({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd, onActiveIndex, endless = false, onBlocked, startEp, startTime, onDislike }: EpisodePlayerProps) {
  const store = useStore();
  const { isLiked, isFav, setLiked, setCollected, setFollowing, actionPending, accountScope, muted, setMuted, volume, setVolume, toast, addHistory, user, setLoginOpen, swipeEp, setSwipeEp, preferHevc, setPreferHevc, ambientGlow, balanceVolume } = store;
  const isDesktop = !isMobile;
  const contentPreferences = useContentPreferences();
  const { preferences, revision, blockReason } = contentPreferences;
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [tagMenu, setTagMenu] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [tagErrors, setTagErrors] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const [posts, setPosts] = useState<Record<number, Post>>({});
  const detailRequests = useRef(new Map<string, Promise<Detail>>());
  const playRequests = useRef(new Map<string, Promise<PlayInfo>>());
  const requestDetail = useCallback((id: number) => {
    const key = `${accountScope}:${store.lineEpoch}:${id}`;
    let request = detailRequests.current.get(key);
    if (!request) {
      request = api.video(id).finally(() => {
        if (detailRequests.current.get(key) === request) detailRequests.current.delete(key);
      });
      detailRequests.current.set(key, request);
      if (detailRequests.current.size > 12) detailRequests.current.delete(detailRequests.current.keys().next().value!);
    }
    return request;
  }, [accountScope, store.lineEpoch]);
  /* 播放地址永不缓存：force=true 时先丢掉在途/已完成的那条，重新问服务器。
     CDN token 会过期，"复用上次的地址"就是用户看到 403 / 卡首帧的原因。 */
  const requestPlay = useCallback((id: number, episode: number, force = false) => {
    const key = `${accountScope}:${store.lineEpoch}:${id}:${episode}`;
    if (force) playRequests.current.delete(key);
    let request = playRequests.current.get(key);
    if (!request) {
      request = api.play(id, episode).finally(() => {
        if (playRequests.current.get(key) === request) playRequests.current.delete(key);
      });
      playRequests.current.set(key, request);
      if (playRequests.current.size > 12) playRequests.current.delete(playRequests.current.keys().next().value!);
    }
    return request;
  }, [accountScope, store.lineEpoch]);
  const effectiveVideoIds = useMemo(
    () => mode === "context" && filtering ? videoIds.filter(id => {
      const key = `${accountScope}:${store.lineEpoch}:${kind}:${id}`;
      if (!checked[key]) return true;
      if (tagErrors[key]) return true;
      return !blockReason(kind === "post" ? posts[id]?.tags : details[id]?.tags);
    }) : videoIds,
    [mode, filtering, revision, videoIds, accountScope, store.lineEpoch, kind, checked, tagErrors, posts, details, blockReason],
  );

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const holdTargetRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => ({ id: videoIds[startIndex], index: startIndex }));
  const index = useMemo(() => {
    if (!effectiveVideoIds.length) return -1;
    const anchored = effectiveVideoIds.indexOf(position.id);
    if (anchored >= 0) return anchored;
    // Only find a replacement after removal, not on every playback/UI update.
    const source = videoIds.indexOf(position.id);
    if (source >= 0) {
      const visible = new Set(effectiveVideoIds);
      for (let i = source + 1; i < videoIds.length; i++) {
        if (visible.has(videoIds[i])) return effectiveVideoIds.indexOf(videoIds[i]);
      }
      for (let i = source - 1; i >= 0; i--) {
        if (visible.has(videoIds[i])) return effectiveVideoIds.indexOf(videoIds[i]);
      }
    }
    return Math.max(0, Math.min(position.index, effectiveVideoIds.length - 1));
  }, [effectiveVideoIds, videoIds, position.id, position.index]);
  const idsRef = useRef(effectiveVideoIds); idsRef.current = effectiveVideoIds;
  const setIndex = useCallback((next: number) => {
    const id = idsRef.current[next];
    if (id !== undefined) setPosition({ id, index: next });
  }, []);
  const [renderIndex, setRenderIndex] = useState(startIndex);
  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp ? { [videoIds[startIndex]]: startEp } : {}));
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [hevcUrls, setHevcUrls] = useState<Record<string, string>>({});
  const [playingKey, setPlayingKey] = useState("");
  const [proxyRetry, setProxyRetry] = useState(0);
  /* 播放地址重取：每个 playKey 只自动重试一次，避免坏源无限循环 */
  const [playBust, setPlayBust] = useState(0);
  const playRetried = useRef<Record<string, boolean>>({});
  const [relatedByVideo, setRelatedByVideo] = useState<Record<string, VideoCard[]>>({});

  const playbackClock = useMemo(() => createPlaybackClock(), []);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ key: "", w: 0, h: 0 });
  const [paused, setPaused] = useState(false);
  const [controlsLocked, setControlsLocked] = useState(false);
  const [rate, setRate] = useState(1);
  const [nextEpPrompt, setNextEpPrompt] = useState(false);
  const [nextEpDismissedKey, setNextEpDismissedKey] = useState("");
  const [waiting, setWaiting] = useState(false);
  /* 缓冲超过 4s 就补一句「线路较慢」：抖音模式首帧能等 5s 还是纯 spinner + 0:00/0:00，
     用户不知道是在缓冲还是卡死（报告 v3.0.5 P2-2）。 */
  const [slowBuffer, setSlowBuffer] = useState(false);
  useEffect(() => {
    if (!waiting) { setSlowBuffer(false); return undefined; }
    const timer = window.setTimeout(() => setSlowBuffer(true), 4000);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | "detail" | null>(null);
  /* 续播：拿到时长后再 seek 一次（只对进入时那一条生效） */
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
  );
  /* 观看进度：onTime 里节流写回 store，卸载时再兜一次 */
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0, permissionKey: "", accountScope: "" });
  const historyWriter = useRef(addHistory);
  const lastSaveRef = useRef(0);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const clean = store.clean;
  const setClean = store.setClean;
  const setFs = store.setFs;

  /* 桌面：鼠标闲置 2.8s 自动隐藏播放器 UI（沉浸） */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      // Keyboard users must keep seeing the focused control/menu.
      if (!boxRef.current?.parentElement?.contains(document.activeElement) || !document.activeElement?.closest(".desktop-controls")) setIdle(true);
    }, 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  const [seriesEnded, setSeriesEnded] = useState(false);
  /* 播放页线路：就地小胶囊 + 面板，只有一条线路时不渲染入口 */
  const [lineOpen, setLineOpen] = useState(false);
  const [lineInfo, setLineInfo] = useState<{ label: string; multi: boolean }>({ label: "线路", multi: false });
  /* —— 移动端手势 —— */
  const [holdSpeed, setHoldSpeed] = useState(false);
  /* 只保留「长按临时加速 / 松手恢复」：拖动/上滑锁定 2x 的持久锁定交互已按上游 PR #193 移除，
     持久倍速走全屏倍速按钮与「更多 → 播放设置」。 */
  const holdRef = useRef(false);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* 进度条拖动 */
  const barRef = useRef<HTMLDivElement>(null);
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  /* 横拖画面（scrub）与直拖底栏（barPct）统一喂同一条底栏进度条：拖动中底栏加粗高亮，
     不再往屏幕正中压一层遮罩（上游 dbbef9a 的机制；配色仍走我们的品牌紫）。 */
  const scrubbing = barPct !== null || scrub !== null;
  const activePct = barPct ?? (scrub ? scrub.pct / 100 : null);
  const [epSlide, setEpSlide] = useState<{ y: number; animate: boolean; ms?: number }>({ y: 0, animate: false });
  /* 回弹时的轻微缩放：1 → .98 → 1，跟 transform 一起走（不额外叠一层 DOM） */
  const [epScale, setEpScale] = useState(1);
  /* 翻页时"下一页"的占位页：整页 pager 需要下一屏从 ±100% 进来（不带第二路视频解码，
     只用深底 + 集数文案，避免换集时多开一路流）。 */
  const [epGhost, setEpGhost] = useState<{ dir: 1 | -1; label: string } | null>(null);
  /* 换源期间保留旧帧（poster），等新集首帧就绪再淡出 —— 原来这段会黑闪 */
  const [holdFrame, setHoldFrame] = useState(false);
  /* 无障碍：prefers-reduced-motion 下翻页退化成 150ms 淡入，不做整页滑动 */
  const reducedMotion = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.current = mq.matches;
    const onChange = (event: MediaQueryListEvent) => { reducedMotion.current = event.matches; };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  /* 这次触摸是不是从舞台（视频区）起手的：只有这种才拦 touchmove */
  const stageTouch = useRef(false);
  const epSlideTimer = useRef<number | undefined>(undefined);
  const gesture = useRef<{
    x: number; y: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan" | "enterSeries" | "edgeBack";
    base: number; width: number; playing: boolean;
    zone: HoldZone; hiddenAtDown: boolean;
    /* 方向锁：定下方向后同一次手势内不再改判（见 playerGestures.lockAxis） */
    axis: Axis;
    /* 从舞台左缘 24px 内起手 = 边缘返回优先 */
    edge: boolean;
    /* 舞台高度（换集门槛按屏高百分比算） */
    stageH: number;
  } | null>(null);
  /* 单击 / 双击判定：
     单击 = 两态（控件收起→唤出；可见→暂停/播放）；
     双击 = 三分法：左 1/3 −5s / 中 1/3 播放暂停 / 右 1/3 +5s（窗口 280ms，见 playerGestures.tapZone）。 */
  const tapRef = useRef<{ lastAt: number; timer: number | null }>({ lastAt: 0, timer: null });
  /* 瞬时的 seek 提示（双击/松手后 800ms 消失）：不新增常驻控件，样式沿用现有胶囊类 */
  const [seekHint, setSeekHint] = useState<{ delta: number; target: number; side: "left" | "right" } | null>(null);
  const seekHintTimer = useRef<number | undefined>(undefined);
  /* 上滑换集预览（拖过 60% 屏高才出）：只显示现有集数，不造数据 */
  const [epPreview, setEpPreview] = useState<{ dir: 1 | -1; label: string } | null>(null);
  /* 方向切换后的冷却时间戳（系统真转屏 / 物理旋转后 300ms 内禁手势） */
  const rotatedAtRef = useRef(0);
  /* 视口是不是横的（只用于「画面该 cover 还是 contain」与物理横置自动进出全屏，
     **不再参与「要不要转屏」的决策** —— fs 一旦为真就直接请求系统横屏） */
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );
  /* 进出全屏过渡期多次续播，防止 iOS 把播放打断 */
  const keepAliveTimers = useRef<number[]>([]);
  /* 双指缩放：scale 1~4，平移跟手指 */
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0, g: false });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ d0: number; mx0: number; my0: number; s0: number; x0: number; y0: number } | null>(null);

  const curId = effectiveVideoIds[index];
  /* 结束态：本剧看完 → 不自动滑进下一部，给「看完 + 推荐 3 部」让用户选。
     推荐来自轮换池（related 全量 + feed 若干页，见 endPool.ts / useEndPool.ts）。 */
  const end = useEndPool(curId);
  const { recs: endRecs, busy: endBusy, hint: endHint } = end;
  /* 结束卡推荐的请求序号（审计 #10）：只接受最新一次响应，换剧前在途的旧响应直接丢掉。 */
  const endSeq = useRef(0);
  const nextVideoId = effectiveVideoIds[index + 1];
  const relatedKey = `${store.lineEpoch}:${curId}`;
  const related = relatedByVideo[relatedKey] || [];
  const detail = details[curId];
  const tagKey = `${accountScope}:${store.lineEpoch}:${kind}:${curId}`;
  const permissionKey = `${tagKey}:${revision}`;
  const currentTags = kind === "post" ? posts[curId]?.tags : detail?.tags;
  const tagsReady = !!checked[tagKey];
  const blocked = filtering && tagsReady ? blockReason(currentTags) : null;
  const allowed = !filtering || (tagsReady && !blocked);
  const closePanels = () => { setPanel(null); setTagMenu(false); };
  const [tagMenuSeed, setTagMenuSeed] = useState<string[]>([]);
  const openTagMenu = (seed: string[] = []) => { setTagMenuSeed(seed); setPanel(null); setTagMenu(true); };
  const openTag = (tag: string) => { closePanels(); store.push({ kind: "tag", tag, name: tag }); };
  useEffect(() => { setTagMenu(false); }, [curId, store.lineEpoch, accountScope]);
  useEffect(() => { if (blocked && mode === "home" && active) onBlocked?.(curId); }, [blocked, mode, active, curId, onBlocked]);
  useEffect(() => { if (!allowed) { setPanel(null); setTagMenu(false); } }, [allowed]);
  const curEp = epMap[curId] || 1;
  const liked = isLiked(curId, curEp, kind);
  const collected = isFav(curId, kind);
  const likeActionKey = `like:${kind}:${curId}:${curEp}`;
  const collectActionKey = `collect:${kind}:${curId}`;
  const followActionKey = `follow:${kind === "video" ? detail?.author?.id || 0 : 0}`;
  const likePending = actionPending(likeActionKey);
  const collectPending = actionPending(collectActionKey);
  const followPending = actionPending(followActionKey);
  const actionContext = useRef({ accountScope, lineEpoch: store.lineEpoch, id: curId, ep: curEp, kind });
  actionContext.current = { accountScope, lineEpoch: store.lineEpoch, id: curId, ep: curEp, kind };
  const progressScope = useRef(accountScope);
  useLayoutEffect(() => {
    if (progressScope.current === accountScope) return;
    progressScope.current = accountScope;
    resumeRef.current = null;
    lastSaveRef.current = 0;
    liveRef.current = { id: 0, ep: 1, dur: 0, t: 0, permissionKey: "", accountScope };
  }, [accountScope]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pendingActions = useRef(new Set<string>());
  const playKey = `${curId}:${curEp}`;
  const playGuard = useRef({ allowed, id: curId, permissionKey, playKey });
  playGuard.current = { allowed, id: curId, permissionKey, playKey };
  const isCurrentPlayback = () => playGuard.current.allowed && playGuard.current.id === curId
    && playGuard.current.permissionKey === permissionKey && playGuard.current.playKey === playKey;

  /* —— 控件显隐（报告：进播放器控件没出来、轻点唤不回）——
     clean 是 store 里的状态，可能留着上一轮的 true；所以进播放器/切集时强制显示。
     显示后 AUTOHIDE_MS（3s，全屏与竖屏一致）无操作才自动收起；暂停中、面板打开时不收。 */
  const uiRef = useRef<{ paused: boolean; panel: string | null; fs: boolean }>({ paused: false, panel: null, fs: false });
  uiRef.current = { paused, panel: panel as string | null, fs };
  const hideTimer = useRef<number | undefined>(undefined);
  const armAutoHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    if (isDesktop) return;
    /* 全屏与竖屏都是 3s（唯一一处时长来源）。任何交互都会重新计时
       （showControls / armAutoHide 都走这里）。 */
    hideTimer.current = window.setTimeout(() => {
      if (uiRef.current.paused || uiRef.current.panel) return;
      /* 全屏层用 idle 收控件，普通播放页用 clean 收 */
      if (uiRef.current.fs) setIdle(true); else setClean(true);
    }, AUTOHIDE_MS) as unknown as number;
  }, [isDesktop, setClean]);
  const showControls = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    setClean(false);
    setIdle(false);
    armAutoHide();
  }, [armAutoHide, setClean]);
  /* 未达门槛的回弹：180ms 回到 0，同时 1 → .98 → 1 的轻微缩放（不抖、不硬跳） */
  const reboundSlide = useCallback(() => {
    setEpScale(0.98);
    setEpSlide({ y: 0, animate: true, ms: GESTURE.episodeReboundMs });
    window.setTimeout(() => setEpScale(1), 90);
  }, []);
  const hideControls = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(idleTimer.current);
    if (!isDesktop && fs) setIdle(true); else setClean(true);
  }, [isDesktop, fs, setClean]);
  /* seek 提示气泡：显示 800ms 后自动消失（双击 ±5s / 松手吸附后各用一次；中区双击不出气泡） */
  const flashSeek = useCallback((delta: number, target: number) => {
    window.clearTimeout(seekHintTimer.current);
    /* 气泡跟随点击侧：快退在左 1/3 中心、快进在右 1/3 中心，垂直放屏高 25%，
       不再居中压在中央播放/暂停按钮上（连续双击只刷新内容，不叠出多个）。 */
    setSeekHint({ delta, target, side: delta < 0 ? "left" : "right" });
    seekHintTimer.current = window.setTimeout(() => setSeekHint(null), GESTURE.seekBubbleMs) as unknown as number;
  }, []);
  /* 相对当前位置跳 seconds 秒（双击用；松手用 scrubTarget，走另一条） */
  /* 相对 seek（双击 ±5s / 上一下一集按钮都用它）：
     **不做整 5s 吸附** —— 原来 snapSeek 会把 12.4−5=7.4 吸到 5，实际退了 7.4s，
     用户量到的就是 4s/6s 这种怪值。吸附只保留给横滑拖动（那里要整 5s 好对齐）。 */
  const seekBy = useCallback((seconds: number) => {
    const el = videoRef.current?.el();
    const total = duration || liveRef.current.dur || 0;
    const base = el && Number.isFinite(el.currentTime) ? el.currentTime : playbackClock.getSnapshot();
    const target = relativeSeek(base, seconds, total);
    videoRef.current?.seek(target, "double_tap");
    flashSeek(target - base, target);
  }, [duration, flashSeek]);

  useEffect(() => {
    showControls();
    return () => window.clearTimeout(hideTimer.current);
  }, [playKey, showControls]);
  useEffect(() => () => window.clearTimeout(seekHintTimer.current), []);
  /* 离场复位：clean 是**全局**状态（App 里 `!clean` 才渲染底栏），
     播放器收起控件时置 true，不还原的话退出播放页后首页底栏会一直不出现。 */
  useEffect(() => () => setClean(false), [setClean]);
  /* 进全屏：立刻重新起 1.2s 计时（控件先显示，到点收起）；退全屏：回到 3s 常规计时 */
  useEffect(() => {
    if (isDesktop) return;
    showControls();
  }, [fs, isDesktop, showControls]);
  useEffect(() => {
    if (paused) window.clearTimeout(hideTimer.current);
    else armAutoHide();
  }, [paused, armAutoHide]);
  useEffect(() => {
    if (panel) window.clearTimeout(hideTimer.current);
    else armAutoHide();
  }, [panel, armAutoHide]);

  /* 线路名与「有没有多条」：读取固定线路 + 镜像列表，任一侧多于一条即可就地切换 */
  useEffect(() => {
    if (isDesktop || !active) return undefined;
    let alive = true;
    const read = () => {
      Promise.all([
        api.lineState(),
        api.lineMirrors().catch(() => ({ items: [] as { url: string; name?: string }[] })),
      ])
        .then(([s, m]) => {
          if (!alive) return;
          const all = [...(s.fixed || []), ...(m?.items || [])];
          const urls = new Set<string>();
          for (const item of all) {
            if (item?.url) urls.add(item.url);
          }
          const cur = all.find(i => i.url === s.base);
          setLineInfo({ label: cur?.name?.trim() || hostOf(s.base) || "线路", multi: urls.size > 1 });
        })
        .catch(() => { /* 读不到就不显示入口 */ });
    };
    read();
    window.addEventListener("hg:line-changed", read);
    return () => { alive = false; window.removeEventListener("hg:line-changed", read); };
  }, [isDesktop, active]);
  const [hevcFallback, setHevcFallback] = useState<Record<string, boolean>>({});
  const blackRecoveredRef = useRef<Record<string, boolean>>({});
  const mainUrl = playUrls[playKey] || "";
  const hevcUrl = hevcUrls[playKey] || "";
  const useHevc = preferHevc && !!hevcUrl && !hevcFallback[playKey];
  const playUrl = useHevc ? hevcUrl : mainUrl;
  /* 画质胶囊只在「本集真有第二条流」时才可切：API 给的是 streams.hevc / streams.main 两条
     真实地址（见下方 requestPlay 的解析），preferHevc 直接决定 <video src> 用哪条，
     所以切了是真的换源，不是只换标签。HEVC 解不出来时 hevcFallback 会把它标掉，
     这时候胶囊就只有「标准」一档并置灰，不假装还能切。 */
  const qualitySwitchable = !!hevcUrl && !hevcFallback[playKey];
  /* 切画质会换 <video> 的 src（VideoSurface 的 effect 依赖 src），等于重新挂载，
     进度会归零 —— 所以切完把当前时间 seek 回去；源还没 ready 时下一次 timeout 重试。 */
  const switchQuality = useCallback(() => {
    const at = videoRef.current?.el()?.currentTime ?? 0;
    setPreferHevc(!preferHevc);
    toast(preferHevc ? "画质：标准（已换源）" : "画质：高清优先（已换源）", "info");
    if (!(at > 1)) return;
    const restore = (tries: number) => {
      try {
        videoRef.current?.seek(at, "quality-switch");
      } catch {
        if (tries < 4) window.setTimeout(() => restore(tries + 1), 400);
      }
    };
    window.setTimeout(() => restore(0), 450);
  }, [preferHevc, setPreferHevc, toast]);

  /* 切线换源保留播放位置（审计 #3）：lineEpoch 一变，下面的取址 effect 就用新地址覆盖
     playUrls[playKey]，<video> 换源即从 0 开始 —— 和「切画质」是同一个坑，所以走同一套恢复点：
     ① 换线前记下 currentTime；② 新地址就绪后再 seek 回去；③ 旧线路预取到的其他集地址全部作废。
     playKey 本来不含线路（改它会让地址表/续播/历史全部错位），所以位置补偿放在这里。 */
  const lineResumeRef = useRef<{ key: string; t: number } | null>(null);
  const lineWatch = useRef({ epoch: store.lineEpoch, playKey });
  useLayoutEffect(() => {
    const prev = lineWatch.current;
    lineWatch.current = { epoch: store.lineEpoch, playKey };
    /* 只认「同一条目、线路变了」：同时换剧/换集时上一次的位置没有意义 */
    if (prev.epoch === store.lineEpoch || prev.playKey !== playKey) return;
    /* 旧线路预取的地址（下一集等）不能再用：只留当前这一条，画面不黑等新地址回来替换。 */
    setPlayUrls((previous) => (previous[playKey] ? { [playKey]: previous[playKey] } : {}));
    setHevcUrls((previous) => (previous[playKey] ? { [playKey]: previous[playKey] } : {}));
    setHevcFallback({});
    if (!active) return;
    const v = videoRef.current?.el();
    const t = v && Number.isFinite(v.currentTime) ? v.currentTime : liveRef.current.t;
    if (t > 1) lineResumeRef.current = { key: playKey, t };
  }, [store.lineEpoch, playKey, active]);

  /* 新线路的地址就绪后把位置 seek 回去（元数据没好就退到下一拍，最多约 2.4s） */
  useEffect(() => {
    const r = lineResumeRef.current;
    if (!r) return undefined;
    if (r.key !== playKey) { lineResumeRef.current = null; return undefined; }
    if (!playUrl) return undefined;
    let tries = 0;
    let timer = 0;
    const tick = () => {
      const v = videoRef.current?.el();
      if (!v || v.readyState < 1) {
        if (tries++ < 12) timer = window.setTimeout(tick, 200) as unknown as number;
        return;
      }
      lineResumeRef.current = null;
      if (r.t > 1 && (!v.duration || r.t < v.duration - 3)) {
        videoRef.current?.seek(r.t, "line-switch");
        playbackClock.publish(r.t);
      }
    };
    timer = window.setTimeout(tick, 120) as unknown as number;
    return () => window.clearTimeout(timer);
  }, [playUrl, playKey, playbackClock]);

  const openFullSeries = useCallback(() => {
    if (kind !== "video" || !curId) {
      logLine(`[full-series] 没有剧集 id（kind=${kind} curId=${String(curId)}），改为打开详情面板`);
      setPanel("detail");
      return;
    }
    /* 先收掉会盖住宿主页的状态：全屏层 z-index 比栈页高，不收的话新页被压在下面，
      用户看到的就是「点了没反应」。 */
    setPanel(null);
    setFs(false);
    setClean(false);
    showControls();
    /* 退出全屏的另一条路径（不是 exitFs）：必须同样把系统方向还回竖屏，
       否则剧集详情页会横着出现。 */
    if (!isDesktop) requestOrientation(false);
    logLine(`[full-series] 打开剧集详情 id=${curId} 第${curEp}集`);
    const v = videoRef.current?.el();
    const curT = v && Number.isFinite(v.currentTime) ? v.currentTime : liveRef.current.t;
    addHistory(curId, curEp, Math.max(0, curT), duration || liveRef.current.dur || 0);
    /* 「看全集」走首页进详情那条路（series 栈页），不再压一个 feed 页：
       以前 push 的是 {kind:"feed"}，从刷剧流里再开一屏播放器，真机上表现成
       「点了直接回首页」（v3.0.6 #6）。改成剧集详情后，返回时刷剧流还在原位。 */
    store.push({ kind: "series", id: curId });
    /* 刷剧流那一页不会被卸载（App 保留整条栈），所以返回时 index / 播放位置都还在原位。 */
  }, [kind, curId, curEp, duration, addHistory, store, setClean, setFs, setPanel, showControls, isDesktop]);
  useEffect(() => {
    setSeriesEnded(false);
    /* 换剧/换集：结束卡推荐一并清掉，池游标随剧重置（useEndPool 按 curId 重建池）；
       序号 +1 让换剧前发出的那一次推荐响应作废，不能把旧剧的卡盖回来。 */
    endSeq.current += 1;
    end.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playKey]);
  useEffect(() => {
    window.clearTimeout(epSlideTimer.current);
    setEpSlide({ y: 0, animate: false });
    return () => window.clearTimeout(epSlideTimer.current);
  }, [curId]);
  const measurementKey = JSON.stringify([accountScope, store.lineEpoch, permissionKey, playKey, playUrl]);
  const videoSize = vsize.key === measurementKey ? vsize : { key: measurementKey, w: 0, h: 0 };
  const showHoldGuide = false;
  useEffect(() => {
    const retry = () => {
      setErr("");
      setWaiting(true);
      // Resolved media is retried in VideoSurface. Only an unresolved API call
      // needs another lookup, so a working stream keeps its episode and position.
      if (!playUrl) setProxyRetry(value => value + 1);
    };
    window.addEventListener("hg:proxy-changed", retry);
    return () => window.removeEventListener("hg:proxy-changed", retry);
  }, [playUrl]);
  useEffect(() => { setZoom({ s: 1, x: 0, y: 0, g: false }); pinchRef.current = null; pointersRef.current.clear(); }, [playUrl]);
  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp }); }, [active, mode, curId, curEp]);
  const episodes = detail?.episodes || [];
  /* 上滑换集的预览文案：只用现有集数，不造数据 */
  /* 上一/下一部剧（按当前刷剧列表边界判）；没有就返回 null */
  const dramaNeighbor = useCallback((dir: 1 | -1): { id: number; title: string } | null => {
    const nextIdx = index + dir;
    if (nextIdx < 0 || nextIdx >= effectiveVideoIds.length) return null;
    const id = effectiveVideoIds[nextIdx];
    const title = (details[id]?.title || "").trim();
    return { id, title };
  }, [index, effectiveVideoIds, details]);

  const episodeLabel = useCallback((dir: 1 | -1) => {
    const ep = epMap[curId] || 1;
    const want = dir === 1 ? ep + 1 : ep - 1;
    if (!episodes.some((row) => row.ep_num === want)) {
      /* 没有下一/上一集：先看有没有下一/上一部剧，有就写剧名（松手真的会切过去） */
      const nb = dramaNeighbor(dir);
      if (nb) return `${dir === 1 ? "下一部" : "上一部"} · ${nb.title ? `《${nb.title}》` : "换一部"}`;
      return dir === 1 ? "已经是最后一集" : "已经是第一集";
    }
    return `${
      dir === 1 ? "下一集" : "上一集"
    } · 第${want}集${episodes.length ? ` / 共 ${episodes.length} 集` : ""}`;
  }, [curId, epMap, episodes, dramaNeighbor]);
  /* 底栏分段胶囊：倍速 / 上一集 / 下一集（全屏是 倍速 / 选集 / 下集）共用这一个组件，
     不各写一套；每段没有自己的底与边框，只有一个外容器 + 1px 分隔线。 */
  const SegPill = ({ items }: { items: { key: string; label: ReactNode; ariaLabel?: string; onPress?: () => void; off?: boolean }[] }) => (
    <div className="hg-seg-pill">
      {items.map((it, i) => (
        <Fragment key={it.key}>
          {i > 0 && <span className="hg-seg-div" aria-hidden="true" />}
          <Button type="button" aria-label={it.ariaLabel} aria-disabled={it.off} onClick={it.onPress}
            className={`hg-seg${it.off ? " is-off" : ""}`}>{it.label}</Button>
        </Fragment>
      ))}
    </div>
  );

  const post = posts[curId];

  /* 观看进度：onTime 里每 5 秒落一次；退出播放页时再用 liveRef 兜一次 */
  const onTimeTick = (t: number) => {
    if (!isCurrentPlayback()) return;
    // Keep the writer from this observation; a later clear must invalidate old cleanup data.
    if (active) historyWriter.current = addHistory;
    liveRef.current = { id: curId, ep: curEp, dur: duration, t, permissionKey, accountScope };
    playbackClock.publish(t);
    const hasNextEp = !endless && kind === "video" && episodes.some((e) => e.ep_num === curEp + 1);
    if (hasNextEp && duration > 15 && duration - t <= 5 && duration - t > 0.2 && nextEpDismissedKey !== playKey) {
      if (!nextEpPrompt) setNextEpPrompt(true);
    } else if (nextEpPrompt) {
      setNextEpPrompt(false);
    }
    const now = Date.now();
    if (duration > 0 && now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      if (kind === "video" && active) addHistory(curId, curEp, t, duration);
    }
  };

  /* 拿到时长后再续播：只对进入时那一条生效，且不跳到片尾 */
  const onDurationTick = (d: number) => {
    if (!isCurrentPlayback()) return;
    setDuration(d);
    liveRef.current = { id: curId, ep: curEp, dur: d, t: historyWriter.current === addHistory && liveRef.current.id === curId && liveRef.current.ep === curEp && liveRef.current.accountScope === accountScope ? liveRef.current.t : 0, permissionKey, accountScope };
    const r = resumeRef.current;
    if (r && r.key === playKey && r.t > 1 && (!d || r.t < d - 3)) {
      resumeRef.current = null;
      videoRef.current?.seek(r.t, "history_resume");
      playbackClock.publish(r.t);
    }
  };

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: "吃瓜",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: post?.counts?.comment ?? 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || "",
        cover: detail?.cover?.trim() || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "HGuoX",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? 0,
        comment: detail?.counts?.comment ?? 0,
        collect: detail?.counts?.collect ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  /* 封面色链路：这一屏的主视觉决定了全站强调色（换剧才换色） */
  const accentScheme = PLAYER_SCHEME;
  const setAccent = useStore().setAccent;
  useEffect(() => { setAccent(accentScheme); }, [accentScheme, setAccent]);
  const articleHtml = kind === "post" && !post?.video_url ? (post?.content || "") : "";

  /* 倍速：中心小方块打开偏好，两侧长按 2.0x。 */
  const effRate = holdSpeed ? 2 : rate;
  /* 全屏只剩一条路：请求系统真转屏（.fs-immersive 铺满视口）。
     **伪横屏整条删除**：原来还有一套 `rotate(90deg)` 的 CSS 舞台（rotated / .fs-landscape），
     两套并存时 viewport 仍是竖的（AVD 上 innerWidth 412×915）→ 手势/按钮按两套坐标各算一次。
     这里只留旋转冷却：视口横竖翻转后 300ms 内禁一切手势，
     避免系统旋转动画期间手指还按在屏幕上被误判成 seek / 换集。 */
  useEffect(() => { rotatedAtRef.current = Date.now(); }, [vpLandscape]);

  /* 控件层显隐动画（淡出 120ms 后才卸载） */
  /* scrub 期间即使处于净屏/收起态也要把底栏挂出来，否则删掉中央浮层后横拖没有反馈 */
  const cinemaBar = useFadeMount(!isDesktop && !fs && (scrubbing || !clean));
  const actionRail = useFadeMount(!fs && !clean && !isDesktop);
  const portraitVideo = videoSize.w > 0 && videoSize.h > 0 && videoSize.w <= videoSize.h;
  /* 横屏全屏切集时新一段还没有解码帧、横屏舞台尚未旋转；旧逻辑会立刻按竖屏锚点弹一次，
     等舞台旋转后 ToastHost 又弹一次，看着像弹了两遍（上游 PR #191）。全屏下先把集数提示
     暂存，等新片真正播起来（尺寸已测到 + playingKey 跟上）再弹一次；竖屏/桌面即时弹。
     用 ref 暂存而不是闭包里判 fs：手势回调创建时的 fs 可能是旧值。 */
  const pendingEpisodeToast = useRef<string | null>(null);
  const queueEpisodeToast = (msg: string) => { pendingEpisodeToast.current = msg; };
  useEffect(() => {
    const pending = pendingEpisodeToast.current;
    if (!pending) return;
    if (err) { pendingEpisodeToast.current = null; return; }
    if (!fs || isDesktop) { pendingEpisodeToast.current = null; toast(pending, "info", "playback-hint"); return; }
    /* 等的是「这一段的画面」，不是上一段的：舞台要等自己的尺寸和首帧播放就绪才转。 */
    if (playingKey !== playKey || videoSize.key !== measurementKey || videoSize.h <= 0) return;
    pendingEpisodeToast.current = null;
    toast(pending, "info", "playback-hint");
  }, [err, fs, isDesktop, measurementKey, playKey, playingKey, toast, videoSize]);
  /* 舞台实测尺寸（用于判断是否真的有 letterbox：容器比画面更"方"才会出现上下黑边） */
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  /* 整页 pager 的进度（位移 / 舞台高，0..1）：高度还没量到时退回视频高，再退回 800 */
  const pageStageH = stageBox.h || videoSize.h || 800;
  const pageProgress = episodePageProgress(epSlide.y, pageStageH);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setStageBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /* 竖屏快捷胶囊：仅双指放大后显示「还原」按钮，横屏视频不再在竖屏下弹「铺满」裁切提示 */
  const capsuleOn = !fs && !clean && !isDesktop && zoom.s > 1.05;

  /* ── 上下划切集 ──────────────────────────────────────────
   * 「上下划切集」开启时，播放区 overlay 的 touch-action 是 none，
   * 原生滚动不参与：上/下划手势在抬手时一次性判定——
   * 有上一/下一集就切集；没有就切上一/下一部剧。
   * 关闭时保持原生滚动，停稳 150ms 后按所在屏切剧。
   */
  const idxRef = useRef(index);
  idxRef.current = index;
  const anchoredScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    const id = effectiveVideoIds[index];
    if (id !== undefined && (position.id !== id || position.index !== index)) {
      setPosition({ id, index }); setRenderIndex(index);
    }
    // The scroll container is recreated after the tag gate/one-time prompt.
    // Anchor by content ID before paint, including a nonzero starting position.
    if (boxRef.current) {
      const top = index * pageStep(boxRef.current);
      if (Math.abs(boxRef.current.scrollTop - top) > 1) {
        anchoredScroll.current = top;
        boxRef.current.scrollTop = top;
      }
    }
  }, [effectiveVideoIds, index, position.id, position.index, allowed]);
  const swipeTimer = useRef(0);

  const resolveSwipe = useCallback((target: number) => {
    const prev = idxRef.current;
    if (target === prev) return;
    idxRef.current = target;
    setIndex(target);
  }, []);

  /* 一页多高：优先量 section 的真实高度（CSS 百分比如若塌成 0，clientHeight 会是 0/1，
     用它会算出错误的「当前第几条」，表现为「上滑不动、内容不换」）。 */
  const pageStep = useCallback((el: HTMLElement): number => {
    const first = el.querySelector("section");
    const measured = first ? first.getBoundingClientRect().height : 0;
    if (measured >= 10) return measured;
    const box = el.clientHeight;
    if (box >= 10) return box;
    return window.innerHeight || 1;
  }, []);

  /* 滚动定位 */
  const onScroll = useCallback(() => {
    if (fs || pinchRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    if (anchoredScroll.current !== null) {
      const top = anchoredScroll.current;
      anchoredScroll.current = null;
      if (Math.abs(el.scrollTop - top) <= 1) return;
    }
    const h = pageStep(el);
    const i = Math.max(0, Math.min(effectiveVideoIds.length - 1, Math.round(el.scrollTop / h)));
    if (renderIndex !== i) setRenderIndex(i);
    if (onNearEnd && (mode === "home" || endless) && i >= effectiveVideoIds.length - 3) onNearEnd();
    window.clearTimeout(swipeTimer.current);
    swipeTimer.current = window.setTimeout(() => resolveSwipe(i), 150);
  }, [effectiveVideoIds.length, onNearEnd, resolveSwipe, fs, mode, endless, renderIndex, pageStep]);

  /* 无限流外壳要知道当前在哪一条：换条时回报一次（换剧/滑到尾部都在这里同步） */
  useEffect(() => { onActiveIndex?.(index); }, [index, onActiveIndex]);

  /** 结束态：从推荐池里取一批（related 全量 + feed 若干页，一轮 3 部）。
   *  上游 related 对同一个 id 返回固定列表，所以「换一批」**不重新问接口**，只在池子里往后移；
   *  池子到底回到开头并给一句提示。池子不足 3 部就少显示，拿不到内容就如实空着（不补假卡）。 */
  const openEndCard = useCallback(async (regen = false) => {
    const seq = ++endSeq.current;
    setSeriesEnded(true);
    showControls();
    const rotation = await end.next(regen);
    /* 等池子的时候换了剧/换了集：这份推荐已经不属于这一屏，直接丢（否则卡片会盖回来）。 */
    if (!rotation || seq !== endSeq.current) return;
    logLine(`[endcard] 本剧看完 id=${curId} 池子=${end.poolSize()} 游标=${rotation.cursor}${rotation.wrapped ? " (回到开头)" : ""} 推荐=${rotation.batch.map((v) => `${v.id}:${v.title}`).join(",") || "无"}`);
  }, [curId, showControls, end]);

  const go = useCallback((delta: number) => {
    const el = boxRef.current;
    if (!el) return;
    const step = pageStep(el);
    const next = Math.max(0, Math.min(effectiveVideoIds.length - 1, index + delta));
    const target = next * step;
    el.scrollTo({ top: target, behavior: "smooth" });
    /* scroll-snap:mandatory 会打断程序化的 smooth 滚动（真机表现就是「上滑不动」）：
       400ms 后还没过半页就直接赋值兜底。 */
    window.setTimeout(() => {
      const box = boxRef.current;
      if (!box) return;
      if (Math.abs(box.scrollTop - target) > step * 0.5) box.scrollTop = target;
    }, 420);
  }, [index, effectiveVideoIds.length, pageStep]);

  /** 点推荐剧：在列表里就滚过去，不在就压一层新的播放页从第 1 集开始 */
  const openRecommended = useCallback((id: number) => {
    setSeriesEnded(false);
    end.close();
    const at = effectiveVideoIds.indexOf(id);
    if (at >= 0) { go(at - index); return; }
    store.push({ kind: "feed", videoIds: [id], index: 0, title: "", startEp: 1 });
  }, [effectiveVideoIds, index, go, store, end]);

  /* 结束态遮罩的上下滑（只关卡片、不切剧）已随卡片一起搬到 EndCard.tsx，
     这里只提供关闭动作。 */
  const closeEndCard = useCallback(() => {
    setSeriesEnded(false);
    end.close();
    setEpPreview(null);
    showControls();
  }, [end, showControls]);


  /* 「不感兴趣」（v3.0.6 #5）：刷剧流里点了必须立刻换片，不能只是弹个标签面板。
     三件事——① 本地黑名单记账（30 天 / 200 条，见 feedPrefs.ts，下次取数不再给）
     ② 立刻跳到下一条 ③ 给一句明确反馈。剧场模式仍走标签偏好面板。 */
  const dislikeCurrent = useCallback(() => {
    if (!endless || !onDislike || !curId) { openTagMenu(); return; }
    markDisliked(curId);
    onDislike(curId);
    go(1);
    toast("已跳过，这类内容会变少", "info");
  }, [endless, onDislike, curId, go, openTagMenu, toast]);

  /* 统一的上下切换：swipeEp 开启且为多集视频时优先切集，否则切剧。
     桌面端键盘 ↑↓ 与右侧按钮都走这里，和移动端上下划手势保持一致。 */
  const stepDir = useCallback((dir: number) => {
    if (swipeEp && kind === "video") {
      const ep = epMap[curId] || 1;
      const total = episodes.length;
      const want = dir === 1 ? (total === 0 || ep < total ? ep + 1 : 0) : (ep > 1 ? ep - 1 : 0);
      if (want) {
        setEpMap((m) => ({ ...m, [curId]: want }));
        setPanel(null);
        return;
      }
    }
    go(dir);
  }, [swipeEp, kind, epMap, curId, episodes.length, go]);

  const canStep = (dir: number) => {
    if (swipeEp && kind === "video") {
      const ep = epMap[curId] || 1;
      const total = episodes.length;
      if (dir === 1 ? (total === 0 || ep < total) : ep > 1) return true;
    }
    const next = index + dir;
    return next >= 0 && next < effectiveVideoIds.length;
  };

  /* With filtering enabled, details are the gate: no media is requested before tags settle. */
  useEffect(() => {
    if (!active) return;
    const epoch = store.lineEpoch;
    const candidates = filtering
      ? [effectiveVideoIds[index], effectiveVideoIds[index + 1], effectiveVideoIds[index - 1]]
      : [effectiveVideoIds[index]];
    const need = candidates.filter((id): id is number => id !== undefined);
    need.forEach(id => {
      const key = `${accountScope}:${epoch}:${kind}:${id}`;
      if (checked[key] || tagErrors[key]) return;
      const request = kind === "post" ? api.post(id) : requestDetail(id);
      request.then(value => {
        if (!mounted.current || actionContext.current.accountScope !== accountScope || actionContext.current.lineEpoch !== epoch) return;
        if (!value) {
          setTagErrors(previous => ({ ...previous, [key]: "标签暂不可用，请重试" }));
          return;
        }
        if (kind === "post") setPosts(previous => ({ ...previous, [id]: value as Post }));
        else setDetails(previous => ({ ...previous, [id]: value as Detail }));
        setTagErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
        setChecked(previous => ({ ...previous, [key]: true }));
      }).catch(error => {
        if (mounted.current && actionContext.current.accountScope === accountScope && actionContext.current.lineEpoch === epoch) {
          setTagErrors(previous => ({ ...previous, [key]: error instanceof Error ? error.message : "标签暂不可用，请重试" }));
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, kind, index, effectiveVideoIds, proxyRetry, store.lineEpoch, accountScope, checked, tagErrors, requestDetail, filtering]);

  /* 相关推荐只在用户打开详情时拉取，避免和首播抢占网络。 */
  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || panel !== "detail" || relatedByVideo[relatedKey]) return;
    const id = curId;
    api.related(id).then((r) => {
      if (mounted.current) setRelatedByVideo(previous => ({ ...previous, [relatedKey]: r?.items || [] }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, kind, allowed, panel, relatedKey, relatedByVideo]);

  /* 拉播放地址：每次进集/回到前台播放都重新问一次（api_play 不缓存，见 api.ts 的 CACHE_TTL）。
     playBust 由「403/404 自动重取一次」推进。 */
  useEffect(() => {
    if (!active || !curId || !allowed) return;
    let alive = true;
    requestPlay(curId, curEp, true)
      .then((info) => {
        if (!alive || !isCurrentPlayback()) return;
        const streamUrl = info?.streams?.main || info?.video_url;
        const hevcStream = info?.streams?.hevc || info?.video_url_hevc || "";
        // 接口本身成功但业务失败（status=0 / streams 为空）时不会进 call() 的 catch，
        // 这里把原始 status/msg 落进 debug.log ——「暂无播放地址」的唯一现场证据。
        // src 才是真正喂给播放器的值；video_url 是新接口不再返回的旧字段，别拿它判断成败。
        const raw = info as unknown as Record<string, unknown>;
        const streams = (raw.streams ?? {}) as Record<string, unknown>;
        const streamKind = streams.main ? "main" : info?.video_url ? "video_url" : streams.hevc ? "hevc" : "-";
        let host = "?";
        try { host = new URL(streamUrl || "").host || "?"; } catch { /* 空地址或非 URL */ }
        logLine(
          `[play] id=${curId} ep=${curEp} src=${streamUrl ? "y" : "n"} kind=${streamKind} host=${host}` +
          (streamUrl ? "" : ` status=${String(raw.status ?? "?")} msg=${String(raw.msg ?? "")}`),
        );
        // 「暂无播放地址」的现场：接口成功但没给地址时，status/msg 是唯一证据。
        tracePlayback("play.resolve", {
          video_id: curId, episode: curEp, resolved: !!streamUrl, kind: streamKind, host,
          status: raw.status ?? null, msg: String(raw.msg ?? "") || null,
        });
        if (!streamUrl) throw new Error("暂无播放地址");
        setPlayUrls((m) => ({ ...m, [playKey]: streamUrl }));
        if (hevcStream) setHevcUrls((m) => ({ ...m, [playKey]: hevcStream }));
        if (kind === "video") addHistory(curId, curEp);
      })
      .catch((e) => { if (alive) setErr((e as Error).message || "取播放地址失败"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, curEp, proxyRetry, allowed, permissionKey, playBust, requestPlay]);

  /* 黑屏取证与自愈（用户报「某一集黑屏但控件正常」）：拿到 playUrl 起播 2.5s 后看 videoWidth 与 currentTime。
     videoWidth===0 且时间在走 → 只有音轨或硬解失败（如 HEVC），自动切回标准流或重取一次地址。 */
  useEffect(() => {
    if (!active || !playUrl) return undefined;
    const timer = window.setTimeout(() => {
      const v = videoRef.current?.el();
      if (!v) return;
      if (v.videoWidth === 0 || v.currentTime === 0) {
        const src = v.currentSrc || v.src || "";
        logLine(`[play] blackframe id=${curId} ep=${curEp} vw=${v.videoWidth} t=${v.currentTime.toFixed(2)} err=${v.error?.code ?? 0} proto=${src.split(":")[0]} len=${src.length}`);
        if (!v.paused && v.currentTime > 0.2 && v.videoWidth === 0 && !blackRecoveredRef.current[playKey]) {
          blackRecoveredRef.current[playKey] = true;
          resumeRef.current = { key: playKey, t: v.currentTime };
          if (useHevc) {
            setHevcFallback((prev) => ({ ...prev, [playKey]: true }));
            toast("画面未解码，已切回标准", "info");
          } else {
            setPlayBust((b) => b + 1);
          }
        }
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [active, playKey, playUrl, useHevc, curId, curEp, toast]);

  /* 当前集拿到地址后再预取下一集，避免首帧加载期间争抢网络。 */
  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || playingKey !== playKey || episodes.length === 0) return;
    let alive = true;
    const ep = epMap[curId] || 1;
    const nextEpisode = ep + 1;
    if (nextEpisode > episodes.length) return;
    const key = `${curId}:${nextEpisode}`;
    if (playUrls[key]) return;
    requestPlay(curId, nextEpisode)
      .then((info) => {
        if (!alive || !playGuard.current.allowed || playGuard.current.permissionKey !== permissionKey) return;
        const u = info?.streams?.main || info?.video_url;
        const h = info?.streams?.hevc || info?.video_url_hevc || "";
        if (u) {
          setPlayUrls((m) => ({ ...m, [key]: u }));
          if ("__TAURI_INTERNALS__" in window) void fetch(playlist(u)).catch(() => {});
        }
        if (h) setHevcUrls((m) => ({ ...m, [key]: h }));
      })
      .catch(() => { /* 预热失败不影响当前播放 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, curEp, episodes.length, allowed, permissionKey, playingKey, playKey, requestPlay]);

  /* 当前视频首帧请求完成后，再验证并预取下一部，屏蔽规则始终先于播放地址。 */
  useEffect(() => {
    const nextId = nextVideoId;
    if (!active || !curId || !nextId || kind !== "video" || !allowed || playingKey !== playKey) return;
    let alive = true;
    const currentId = curId;
    const currentPermission = permissionKey;
    const nextKey = `${nextId}:1`;
    if (playUrls[nextKey]) return;
    const stillRelevant = () => alive && mounted.current && playGuard.current.id === currentId
      && playGuard.current.permissionKey === currentPermission && idsRef.current[index + 1] === nextId;
    void (async () => {
      try {
        const nextDetail = detailsRef.current[nextId] || await requestDetail(nextId);
        if (!stillRelevant()) return;
        if (!detailsRef.current[nextId]) {
          setDetails(previous => ({ ...previous, [nextId]: nextDetail }));
          setChecked(previous => ({ ...previous, [`${accountScope}:${store.lineEpoch}:${kind}:${nextId}`]: true }));
        }
        if (filtering && blockReason(nextDetail.tags)) {
          if (mode === "home") onBlocked?.(nextId);
          return;
        }
        const info = await requestPlay(nextId, 1);
        if (!stillRelevant()) return;
        const url = info?.streams?.main || info?.video_url;
        const hevc = info?.streams?.hevc || info?.video_url_hevc || "";
        if (url) {
          setPlayUrls(previous => ({ ...previous, [nextKey]: url }));
          if ("__TAURI_INTERNALS__" in window) void fetch(playlist(url)).catch(() => {});
        }
        if (hevc) setHevcUrls(previous => ({ ...previous, [nextKey]: hevc }));
      } catch {
        // The next item resolves normally when selected.
      }
    })();
    return () => { alive = false; };
  }, [active, curId, index, nextVideoId, kind, mode, allowed, playingKey, playKey, playUrls[`${nextVideoId}:1`], permissionKey, accountScope, store.lineEpoch, filtering, blockReason, onBlocked, requestDetail, requestPlay]);

  /* 切换条目/集数时重置播放状态 */
  useEffect(() => {
    setDuration(0); setErr(""); setWaiting(true); setPaused(false);
    setPlayingKey("");
    setNextEpPrompt(false);
    playbackClock.publish(0);
  }, [playKey]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步（长按 2x / 锁定 2x / 基准倍速） */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* 离开播放页时把最后位置落盘 */
  useEffect(() => () => {
    const s = liveRef.current;
    if (kind === "video" && s.id && s.dur && playGuard.current.allowed && playGuard.current.id === s.id
      && actionContext.current.accountScope === s.accountScope
      && playGuard.current.playKey === `${s.id}:${s.ep}` && playGuard.current.permissionKey === s.permissionKey) historyWriter.current(s.id, s.ep, s.t, s.dur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 键盘 */
  useEffect(() => {
    if (!active || !allowed || controlsLocked || showHoldGuide) return;
    const seekRelative = (delta: number) => {
      const current = videoRef.current?.el()?.currentTime ?? 0;
      videoRef.current?.seek(Math.max(0, current + delta), "keyboard_shortcut");
    };
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (panel) { if (e.key === "Escape") setPanel(null); return; }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); stepDir(1); break;
        case "ArrowUp": e.preventDefault(); stepDir(-1); break;
        case " ": e.preventDefault(); videoRef.current?.toggle(); break;
        case "ArrowLeft": e.preventDefault(); seekRelative(-5); break;
        case "ArrowRight": e.preventDefault(); seekRelative(5); break;
        case "f": case "F": toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": setMuted((v) => !v); break;
        case "l": case "L": onLike(); break;
        case "s": case "S": onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": setPanel("episodes"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, allowed, controlsLocked, showHoldGuide, panel, index, stepDir, accountScope, curEp, kind, liked, collected, likePending, collectPending]);

  /* 安卓返回键：面板打开时先关面板 */
  /* 返回键：先收播放器面板，再退页面。用弹层栈登记（不是全局单槽，
     单槽会被别处的 cleanup 清掉，「按返回直接退出播放器」就是这么来的）。 */
  useEffect(() => {
    if (!panel) return undefined;
    return registerOverlayBack(() => { setPanel(null); return true; });
  }, [panel]);

  useEffect(() => {
    const onFs = () => {
      const activeFs = !!document.fullscreenElement;
      setFullscreen(activeFs);
      if (!isDesktop && !activeFs && uiRef.current.fs) {
        setFs(false);
        showControls();
      }
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [isDesktop, setFs, showControls]);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) videoRef.current?.pause();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const toggleFull = () => {
    /* 移动端（安卓/iOS WebView）一律不走 Fullscreen API：会重建视图、可能丢进度。
       移动端的全屏入口统一是 enterFs/exitFs（纯 CSS + set_orientation）。 */
    if (!isDesktop) return;
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  /* —— 长按 2x（上滑锁定） / 横拖定位 / 单击暂停 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked || !active || showHoldGuide) return;
    /* 落在控制条/面板上的按下完全不参与舞台手势。
       以前它会冒泡到舞台，松手被判定成「点了一下视频」→ 控件收起：
       真机上点画质胶囊会看起来像「胶囊自己消失了」，点「看全集」也会被这一下干扰
       （bar 在 pointerup 与 click 之间被卸载，click 直接丢失）。 */
    const pressed = e.target instanceof Element ? e.target.closest("[data-hg-control]") : null;
    if (pressed) return;
    /* 方向刚变过（rotation 动画期间）不接受新手势 */
    if (rotationLocked(rotatedAtRef.current, Date.now())) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      pinchRef.current = {
        d0: d,
        mx0: (pts[0].x + pts[1].x) / 2,
        my0: (pts[0].y + pts[1].y) / 2,
        s0: zoom.s,
        x0: zoom.x,
        y0: zoom.y,
      };
      if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
      gesture.current = null;
      if (holdRef.current) { holdRef.current = false; setHoldSpeed(false); }
      setZoom((z) => ({ ...z, g: true }));
      return;
    }
    if (gesture.current || e.button !== 0) return;
    stageTouch.current = true;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    /* 舞台坐标 = 屏幕坐标（不再有 CSS 旋转舞台，横屏是系统真转出来的） */
    const width = el.clientWidth || 1;
    const stageH = el.clientHeight || 1;
    const sx = e.clientX;
    const sy = e.clientY;
    // 按视觉矩形求真正的正方形（长按菜单热区）
    const zone = getHoldZone(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    armAutoHide();
    /* 左缘返回：只在**非全屏的竖屏播放页**启用。
       全屏（fs）与物理横屏（vpLandscape）里左缘右滑必须留给 seek，
       否则从左侧起手想快退会直接退出全屏。 */
    const edgeStart = !fs && !vpLandscape && isEdgeBackStart(e.clientX - rect.left);
    /* 残留缩放会把竖滑换集直接关掉（zoom.s > 1.05 的门槛）：非捏合态下起手先归位 */
    if (!zoom.g && zoom.s > 1.05) setZoom({ s: 1, x: 0, y: 0, g: false });
    const g = {
      x: sx, y: sy, startY: sy, t: Date.now(), base: videoRef.current?.el()?.currentTime ?? playbackClock.getSnapshot(), width,
      stageH,
      axis: "none" as Axis,
      edge: edgeStart,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan",
      zone,
      /* 按下这一刻控件是不是收起的：全屏态的 pointerdown 会先 wake() 把 idle 清掉，
         所以不能在 onUp 里读当前值，否则「点一下唤回」会被当成「点一下暂停」（P1-1）。 */
      hiddenAtDown: clean || (!isDesktop && fs && idle),
      playing: videoRef.current?.el()?.paused === false,
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle") return;
        cur.mode = "hold";
        if (cur.zone === "menu") {
          holdRef.current = false;
          openTagMenu();
        } else {
          holdRef.current = true;
          setHoldSpeed(true);
        }
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, HOLD_DELAY_MS) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const p = pinchRef.current;
    if (p && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const s = Math.min(4, Math.max(1, p.s0 * (d / p.d0)));
      setZoom({ s, x: p.x0 + (mx - p.mx0), y: p.y0 + (my - p.my0), g: true });
      return;
    }
    const g = gesture.current;
    if (!g || isDesktop) return;
    const msx = e.clientX;
    const msy = e.clientY;
    const dx = msx - g.x;
    const dy = msy - g.y;

    /* 长按中：只换挡/加速，不再有「上滑锁定」态（上游 PR #193） */
    if (g.mode === "hold") return;

    /* 方向锁：过死区后按 1.4 倍比例定轴，定下即锁死（lockAxis 内部保证不再改判） */
    g.axis = lockAxis(g.axis, dx, dy);
    if (g.axis === "none") return;

    if (g.mode === "idle") {
      if (g.timer) window.clearTimeout(g.timer);
      if (g.axis === "x") {
        if (g.edge && dx > 0) {
          /* 边缘返回优先：左缘 24px 内右滑=退一层，不参与 seek */
          g.mode = "edgeBack";
        } else if (endless && g.hiddenAtDown && dx < 0) {
          g.mode = "enterSeries";
        } else {
          g.mode = "scrub";
          showControls();
          videoRef.current?.pause();
        }
      } else {
        g.mode = "pan";
        /* 真机取证：竖滑换集不生效时，看这一行就知道被哪个条件挡了 */
        logLine(`[gesture] pan start fs=${fs} endless=${endless} swipeEp=${swipeEp} eps=${episodes.length} zoom=${zoom.s.toFixed(2)}`);
      }
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      /* 量纲按片长自适应（<=60s 15s/100px，60–600s 30s/100px，>600s 60s/100px），
         不再拿「屏宽的百分比」当秒数 —— 否则短视频一滑就跨半集。 */
      const target = Math.max(0, Math.min(total, g.base + seekDeltaSeconds(dx, total)));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    } else if (g.mode === "pan" && !fs && !endless && swipeEp && episodes.length > 1 && zoom.s <= 1.05) {
      const pdy = msy - g.startY;
      /* 速度辅助：短促一划也能切（普通上滑往往只有 20–30% 屏高） */
      const dt = Math.max(1, Date.now() - g.t);
      const intent = episodeIntent(pdy, g.stageH, (pdy / dt) * 1000);
      /* 跟手：内容直接跟着手指走（transform，不重排），上下限各半屏。
         到了列表头尾按 dy×0.35 衰减 —— 拉得动一点但拉不走，比硬停更像手感。 */
      const dragDir: 1 | -1 = pdy <= 0 ? 1 : -1;
      const atEdge = !dramaNeighbor(dragDir) && !episodes.some((row) => row.ep_num === (epMap[curId] || 1) + dragDir);
      const limit = g.stageH * 0.62;
      /* 跟手：0.85 阻尼直接把手指位移变成 translateY（只动 transform，不重排） */
      const visual = episodeDrag(pdy, atEdge);
      setEpSlide({ y: Math.max(-limit, Math.min(limit, visual)), animate: false });
      if (intent.preview) {
        const label = episodeLabel(intent.dir);
        setEpPreview({ dir: intent.dir, label });
        setEpGhost({ dir: intent.dir, label });
      } else {
        setEpPreview(null);
        setEpGhost(null);
      }
    }
  };

  const onUp = (cancelled = false, e?: React.PointerEvent<HTMLDivElement>) => {
    stageTouch.current = false;
    if (e) pointersRef.current.delete(e.pointerId);
    armAutoHide();
    if (pointersRef.current.size < 2 && pinchRef.current) {
      pinchRef.current = null;
      // 松手后小于 1.05x 就归位，避免残留"歪着"的画面
      setZoom((z) => (z.s < 1.05 ? { s: 1, x: 0, y: 0, g: false } : { s: z.s, x: z.x, y: z.y, g: false }));
    }
    const g = gesture.current;
    gesture.current = null;
    /* 长按状态必须无条件复位：切集 / 组件重建会把手势对象清掉，
       但 holdRef 若留在 true，下面的 touchmove 会一直 preventDefault，
       整个列表就再也滑不动（表现为「播放后不能上滑」）。 */
    if (holdRef.current) { holdRef.current = false; setHoldSpeed(false); }
    if (!g) { setEpSlide({ y: 0, animate: true }); return; }
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      setEpSlide({ y: 0, animate: true });
      holdRef.current = false;
      setHoldSpeed(false);
      return;
    }
    if (g.mode === "enterSeries") {
      setEpSlide({ y: 0, animate: true });
      const [ux, uy] = e ? [e.clientX, e.clientY] : [g.x, g.startY];
      const tdx = ux - g.x;
      const tdy = uy - g.startY;
      if (!cancelled && tdx < -80 && Math.abs(tdx) > Math.abs(tdy) * 2) {
        openFullSeries();
      }
      return;
    }
    if (g.mode === "edgeBack") {
      /* 边缘返回：位移够才退，不够就当没发生（不产生任何跳转） */
      const dxEdge = e ? e.clientX - g.x : 0;
      if (!cancelled && dxEdge >= GESTURE.edgeBackCommit) store.pop();
      return;
    }
    if (g.mode === "scrub") {
      setEpSlide({ y: 0, animate: true });
      const target = scrubTarget.current;
      const dxScrub = e ? e.clientX - g.x : 0;
      /* 短滑 <20px 不 seek（只当误触）；够长就吸附到整 5 秒并给一次提示 */
      if (!cancelled && target != null && canSeek(dxScrub)) {
        const snapped = snapSeek(target, duration || liveRef.current.dur || 0);
        videoRef.current?.seek(snapped, "mobile_gesture");
        /* 先发布目标时间再清预览（审计 #18）：底栏显示「预览 ?? 时钟」，
           清 scrub 那一刻时钟还停在旧位置，0.25s 宽度过渡会先把条拉回去再跳过来。 */
        playbackClock.publish(snapped);
        flashSeek(snapped - g.base, snapped);
      }
      setScrub(null);
      scrubTarget.current = null;
      if (g.playing && active) videoRef.current?.play();
      return;
    }
    /* 上下划手势（全屏态屏蔽上下滑切集防误触） */
    if (!cancelled && !fs && e && g.mode === "pan") {
      const [ux2, uy2] = [e.clientX, e.clientY];
      const dy = uy2 - g.startY;
      const dtUp = Math.max(1, Date.now() - g.t);
      const intent = episodeIntent(dy, g.stageH, (dy / dtUp) * 1000);
      if (intent.commit) {
        const dir = intent.dir;
        logLine(`[gesture] episode commit dir=${dir} dy=${Math.round(dy)} dt=${Date.now() - g.t}ms`);
        /* 提交即收掉「下一集 · 第N集 / 共 X 集」预览。
           它和换集后的 toast「第 N 集 / X」是两条独立提示，同屏出现就是用户报的
           「切集时两个下一集提示」；而下面每个分支都 return，以前没人清这条预览，
           于是它一直挂在 z-30 上不消失（停在 y≈715，只有下一次拖动才会被覆盖）。 */
        setEpPreview(null);
        const ep = epMap[curId] || 1;
        const total = episodes.length;
        const want = dir === 1 ? (total === 0 || ep < total ? ep + 1 : 0) : (ep > 1 ? ep - 1 : 0);
        /* 抖音模式：竖滑固定「下一部」，不按集切（用户在这个模式里要的是换剧） */
        if (endless) { setEpSlide({ y: 0, animate: false }); go(dir); return; }
        if (swipeEp && episodes.length > 1 && want) {
          window.clearTimeout(epSlideTimer.current);
          /* 跟手收尾：先按手指方向把画面整屏滑出（220ms，ease-out-quint），
             换集后从对侧 35% 位置滑回中间 —— 不是原来 ±72px 的硬移。 */
          if (reducedMotion.current) {
            /* 无障碍：不整页滑，直接 150ms 淡入到新集 */
            setEpMap((m) => ({ ...m, [curId]: want }));
            setHoldFrame(true);
            setEpSlide({ y: 0, animate: true, ms: GESTURE.episodeReducedMotionMs });
            setEpGhost(null);
            queueEpisodeToast(`第 ${want} 集${total ? ` / ${total}` : ""}`);
            try { navigator.vibrate?.(12); } catch { /* ignore */ }
            return;
          }
          const out = dir > 0 ? -g.stageH : g.stageH;
          setEpSlide({ y: out, animate: true, ms: GESTURE.episodeCommitMs });
          epSlideTimer.current = window.setTimeout(() => {
            setEpMap((m) => ({ ...m, [curId]: want }));
            setHoldFrame(true);
            setEpSlide({ y: 0, animate: true, ms: GESTURE.episodeCommitMs });
            window.setTimeout(() => setEpGhost(null), GESTURE.episodeCommitMs);
          }, GESTURE.episodeCommitMs);
          queueEpisodeToast(`第 ${want} 集${total ? ` / ${total}` : ""}`);
          try { navigator.vibrate?.(12); } catch { /* ignore */ }
          return;
        }
        if (swipeEp) {
          /* 结束态下上下滑：只关掉结束态回到控件态，不切剧 */
          if (seriesEnded) {
            setSeriesEnded(false);
            end.close();
            reboundSlide();
            setEpPreview(null);
            showControls();
            return;
          }
          /* 播到最后一集后继续上滑：**不再自动滑进下一部剧**（用户要的是选择权），
             直接给结束态；下滑同理。 */
          reboundSlide();
          setEpPreview(null);
          try { navigator.vibrate?.(8); } catch { /* ignore */ }
          void openEndCard();
          return;
        }
      }
    }
    reboundSlide();
    setEpPreview(null);
    setEpGhost(null);
    /*
      单击 / 双击语义（重写）：
        · 双击（280ms 内第二下）：三分法 —— 左 1/3 退 −5s、中 1/3 播放/暂停（不出气泡）、
          右 1/3 进 +5s，左右区给 800ms 时间气泡；
        · 单击两态：控件收起 → 唤出；控件可见 → 播放/暂停。
      以前双击被拆成两次单击（唤出 + 收起）互相抵消，用户根本感受不到双击。
    */
    /* 单击判定必须同时看位移和时长：以前只看「模式还是 idle」，于是在死区内滑 6–8px
       也被当成单击，一抖就把视频暂停了。6px ≤ 位移 < 10px 现在是无动作。 */
    const tapDx = e ? e.clientX - g.x : 0;
    const tapDy = e ? e.clientY - g.startY : 0;
    if (!cancelled && g.mode === "idle" && tapVerdict(tapDx, tapDy, Date.now() - g.t) === "tap") {
      const now = Date.now();
      if (isDoubleTap(tapRef.current.lastAt, now)) {
        window.clearTimeout(tapRef.current.timer ?? undefined);
        tapRef.current = { lastAt: 0, timer: null };
        const action = doubleTapAction(g.x, g.width);
        if (action.kind === "toggle") {
          /* 中区双击：播放/暂停，不出 seek 气泡（避免中间误触跳进度） */
          videoRef.current?.toggle();
          showControls();
          armAutoHide();
          return;
        }
        seekBy(action.seconds);
        showControls();
        return;
      }
      const hidden = g.hiddenAtDown || clean || (!isDesktop && fs && idle);
      tapRef.current.lastAt = now;
      window.clearTimeout(tapRef.current.timer ?? undefined);
      if (hidden) {
        /* 收起态的第一下也进双击判定窗口（审计 #17）：原来这里立刻 showControls()，
           第二下正好落在刚冒出来的暂停/选集按钮上 —— 双击变成一次误触。
           现在 280ms 内先不铺控件：第二下仍落在视频层上、走上面的双击分支，
           没等到第二下才唤出控件。 */
        tapRef.current.timer = window.setTimeout(() => {
          tapRef.current = { lastAt: 0, timer: null };
          showControls();
        }, GESTURE.doubleTapMs) as unknown as number;
        return;
      }
      /* 可见状态：等过双击窗口再切换播放/暂停，避免双击被当成两次暂停 */
      tapRef.current.timer = window.setTimeout(() => {
        tapRef.current = { lastAt: 0, timer: null };
        videoRef.current?.toggle();
        armAutoHide();
      }, GESTURE.doubleTapMs) as unknown as number;
    }
  };

  useEffect(() => {
    if (!active || controlsLocked || showHoldGuide) {
      if (!active) { setPanel(null); setTagMenu(false); }
      onUp(true);
      pointersRef.current.clear();
      pinchRef.current = null;
    }
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked, showHoldGuide]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    gesture.current = null;
    holdRef.current = false;
  }, [playKey]);

  /* 进出全屏：iOS 的 WKWebView 会在这时把播放打断，需要补几次 play()。
     安卓没有这个问题——补播反而会无视用户刚按下的暂停（P1-2），所以这里只在 iOS 走，
     并且每次补播前都确认「用户没有暂停」（uiRef.paused）。 */
  const keepAlive = useCallback(() => {
    for (const t of keepAliveTimers.current) window.clearTimeout(t);
    keepAliveTimers.current = [];
    if (platform !== "ios") return;
    for (const delay of [50, 150, 300, 500, 800, 1200]) {
      keepAliveTimers.current.push(window.setTimeout(() => {
        if (uiRef.current.paused) return;
        const v = videoRef.current?.el();
        if (v && v.paused) videoRef.current?.play();
      }, delay) as unknown as number);
    }
  }, []);

  /* 进全屏（报告 17 撤回：这个入口不能删）。
     **只有一条路**：fs 沉浸层（.fs-immersive）+ 请求系统真转屏（安卓 Kotlin 插件 / iOS objc）。
     CSS 旋转兜底已整条删除：插件失败时停在竖屏沉浸全屏并弹一条 playback-hint ——
     至少还能看、还能退，不会出现「转了 90° 但 innerWidth 还是竖的」那种半横屏。 */
  const enterFs = useCallback(() => {
    /* FLIP：切换前记下播放器当前几何，切换后用 WAAPI 从旧几何补间到满屏。
       会请求系统转屏时（移动端）只淡入 —— 旋转由系统做，再叠缩放会打架。 */
    const root = (boxRef.current?.closest(".hg-player-ui") as HTMLElement | null) ?? null;
    const fromRect = root ? root.getBoundingClientRect() : null;
    const willRotate = !isDesktop;
    /* 先把当前可见项锁定下来，再收起滚动容器：否则进入全屏后 scrollTop 归零，
       还在 150ms 防抖里的 index 会被 resolveSwipe(0) 改回第一屏（「全屏后变成另一个视频」）。 */
    const el = boxRef.current;
    if (el && !isDesktop) {
      window.clearTimeout(swipeTimer.current);
      const h = pageStep(el);
      const i = Math.max(0, Math.min(effectiveVideoIds.length - 1, Math.round(el.scrollTop / h)));
      if (i !== idxRef.current) resolveSwipe(i);
    }
    setClean(false);
    setFs(true);
    showControls();
    keepAlive();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (root) root.style.transformOrigin = originFromPoint(root);
      playEnter(root, fromRect ? { left: fromRect.left, top: fromRect.top, width: fromRect.width, height: fromRect.height } : null, !willRotate);
    }));
    if (!isDesktop) {
      /* 只做一件事：系统转屏（安卓 Kotlin setRequestedOrientation / iOS objc）。
         这里**不能再调 requestFullscreen / orientation.lock** —— 安卓 WebView 收到全屏请求会走
         WebChromeClient.onShowCustomView 把 WebView 挪进全屏容器，等于重建一次视图：
         真机实测点全屏时 CDP 连续 RemoteDisconnected，播放进度有丢失风险。 */
      try { logLine("[orientation] 全屏 → 请求系统横屏"); } catch { /* ignore */ }
      requestOrientation(true, () => toast("系统未允许横屏：保持竖屏全屏（打开系统「自动旋转」后可重试）", "info", "playback-hint"));
      /* 800ms 后量一次视口，真机取证用：真转成功的判据是 innerWidth > innerHeight。
         只记日志不弹提示 —— 慢设备旋转可能超过 1s，误报比不报更烦。 */
      window.setTimeout(() => {
        try { logLine(`[orientation] 全屏后视口 ${window.innerWidth}x${window.innerHeight} landscape=${window.innerWidth > window.innerHeight}`); } catch { /* ignore */ }
      }, 800);
    }
  }, [isDesktop, keepAlive, resolveSwipe, effectiveVideoIds.length, setClean, setFs, showControls, toast]);

  /* 退出全屏：再点一次回到竖屏（并解除系统方向锁/全屏） */
  const exitFs = useCallback(() => {
    const root = (boxRef.current?.closest(".hg-player-ui") as HTMLElement | null) ?? null;
    const fromRect = root ? root.getBoundingClientRect() : null;
    const wasFs = fs;
    setClean(false);
    setFs(false);
    showControls();
    keepAlive();
    if (wasFs) requestAnimationFrame(() => requestAnimationFrame(() => {
      playExit(root, fromRect ? { left: fromRect.left, top: fromRect.top, width: fromRect.width, height: fromRect.height } : null, true);
    }));
    if (!isDesktop) {
      requestOrientation(false);
      try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
      try { if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => {}); } catch { /* ignore */ }
    }
  }, [isDesktop, keepAlive, setClean, setFs, showControls, fs]);

  useEffect(() => {
    if (isDesktop || !fs) return undefined;
    return registerOverlayBack(() => { exitFs(); return true; });
  }, [isDesktop, fs, exitFs]);

  /* 系统方向一旦被改过就必须还回去，所以「退出播放器」和「切后台」这两条路径也照发一遍还原请求：
       · 组件卸载（返回上一页 / 换片）→ 还原竖屏；
       · 切后台（visibilitychange hidden）→ 还原竖屏，回来时若还在全屏再转回横屏。
     fs 用 ref 取最新值，避免每次开关全屏都重挂监听（cleanup 里会误还原）。 */
  const orientationRef = useRef({ fs: false });
  orientationRef.current = { fs };
  useEffect(() => {
    if (isDesktop) return undefined;
    const setOrientation = (landscape: boolean) => {
      requestOrientation(landscape);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") setOrientation(false);
      else if (orientationRef.current.fs) setOrientation(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      setOrientation(false);
    };
  }, [isDesktop]);

  /* 物理横置手机时自动进入全屏，竖回时自动退出全屏（对齐 LNPANDY 版）。
     只同步 fs 这**一个**状态：要不要转屏由 fs 单方面决定，不看设备上报。 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const isLand = window.innerWidth > window.innerHeight;
      setVpLandscape((prev) => {
        if (prev !== isLand && active) {
          setFs(isLand);
          keepAlive();
        }
        return isLand;
      });
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, setFs, keepAlive]);

  /* 全屏切换或视口旋转后校准滚动容器 scrollTop：
     - 进入全屏时非当前项已隐藏，当前项位于顶部 scrollTop = 0；
     - 退出全屏回到竖屏列表时，立即把 scrollTop 对齐到 index * clientHeight，
       防止错位到其它视频封面（「横屏播放变成别的剧集」的根因）。 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    if (fs) {
      el.scrollTop = 0;
      return undefined;
    }
    const syncScroll = () => {
      const box = boxRef.current;
      if (!box || fs) return;
      box.scrollTop = index * pageStep(box);
    };
    syncScroll();
    const raf = requestAnimationFrame(syncScroll);
    const t1 = window.setTimeout(syncScroll, 120);
    const t2 = window.setTimeout(syncScroll, 350);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [fs, vpLandscape, index]);

  useEffect(() => () => {
    for (const t of keepAliveTimers.current) window.clearTimeout(t);
    keepAliveTimers.current = [];
  }, []);

  const lockControls = () => { setPanel(null); setControlsLocked(true); };

  /* 长按倍速期间禁止原生滚动，否则上滑会被列表吃掉、锁不住倍速 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => { if (holdRef.current && gesture.current?.mode === "hold") e.preventDefault(); };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, effectiveVideoIds.length]);

  /* —— 进度条拖动（舞台不旋转，进度条恒为水平方向） —— */
  const barPctAt = (clientX: number, _clientY: number) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return null;
    const span = r.width;
    if (!span) return null;
    const raw = (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (clientX: number, clientY: number) => {
    const pct = barPctAt(clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.clientX, e.clientY);
    if (pct != null && duration) {
      const target = pct * duration;
      videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
      videoRef.current?.seek(target, "mobile_bar");
      playbackClock.publish(target);
    }
    setBarPct(null);
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  const actionIsCurrent = () => mounted.current && actionContext.current.accountScope === accountScope && actionContext.current.lineEpoch === store.lineEpoch
    && actionContext.current.id === curId && actionContext.current.ep === curEp && actionContext.current.kind === kind;

  const onLike = async () => {
    const pendingKey = `${accountScope}:${likeActionKey}`;
    if (!curId || likePending || pendingActions.current.has(pendingKey)) return;
    pendingActions.current.add(pendingKey);
    const on = !liked;
    const step = on ? 1 : -1;
    /* 立刻给反馈：计数 ±1 + 按钮 180ms 缩放。服务端失败再撤回，不造假。 */
    setLikeDelta((d) => d + step);
    setLikeBump((n) => n + 1);
    try {
      await setLiked(kind, curId, curEp, on);
      /* 成功：liked 已经翻转会自带 ±1，把本地增量收掉，避免双计 */
      setLikeDelta((d) => d - step);
      if (!actionIsCurrent()) return;
      if (on) setHeartBurst((n) => n + 1);
      toast(on ? "已加入喜欢" : "已取消喜欢", on ? "heart" : "info");
    } catch (error) {
      setLikeDelta((d) => d - step);
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "点赞失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const onFav = async () => {
    const pendingKey = `${accountScope}:${collectActionKey}`;
    if (!curId || collectPending || pendingActions.current.has(pendingKey)) return;
    pendingActions.current.add(pendingKey);
    const on = !collected;
    try {
      await setCollected(kind, curId, on, kind === "video" && episodes.length > 0 ? episodes.length : undefined);
      if (actionIsCurrent()) toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    } catch (error) {
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "收藏失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const onFollow = async () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    const pendingKey = `${accountScope}:${followActionKey}`;
    if (!uid || followPending || pendingActions.current.has(pendingKey)) return;
    if (!user) { setLoginOpen(true); return; }
    pendingActions.current.add(pendingKey);
    const on = !store.follows.includes(uid);
    try {
      await setFollowing(uid, on);
      if (actionIsCurrent()) toast(on ? `已关注 ${meta.author}` : "已取消关注", on ? "ok" : "info");
    } catch (error) {
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "关注失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const pickEp = (ep: number) => {
    setEpMap((m) => ({ ...m, [curId]: ep }));
    setPanel(null);
  };

  /* 点赞乐观增量：服务端回包前先本地 ±1，回包成功后由 liked 态接管（增量归零），
     失败则撤回。计数全是「33.3万」这种格式化值，±1 看不出来，所以还要配一个 180ms 动效。 */
  const [likeDelta, setLikeDelta] = useState(0);
  const [likeBump, setLikeBump] = useState(0);
  const likeCount = useMemo(() => {
    const base = meta.like;
    const loadedLiked = kind === "video" && detail?.interaction?.liked
      && (detail.interaction.liked_ep === undefined || detail.interaction.liked_ep === curEp);
    return Math.max(0, base + likeDelta + Number(liked) - Number(!!loadedLiked));
  }, [meta.like, likeDelta, liked, kind, detail?.interaction, curEp]);
  const collectCount = useMemo(() => {
    const loadedCollected = kind === "video" && detail?.interaction?.collected;
    return Math.max(0, meta.collect + Number(collected) - Number(!!loadedCollected));
  }, [meta.collect, collected, kind, detail?.interaction]);

  const detailBody = (onClose?: () => void) => <VideoDetailsPanel meta={meta} videoId={curId} episodeCount={episodes.length}
    related={related} following={store.follows.includes(meta.authorId)} followPending={followPending}
    onFollow={() => void onFollow()} onTag={openTag} onClose={onClose} onPreferences={() => openTagMenu()}
    onBlockTag={tag => openTagMenu([tag])}
    onAuthor={() => { if (meta.authorId > 0) { closePanels(); store.push({ kind: "user", id: meta.authorId, name: meta.author }); } }}
    onRelated={video => { closePanels(); store.push({ kind: "feed", videoIds: related.map(item => item.id), index: related.findIndex(item => item.id === video.id), title: "相关推荐" }); }} />;

  if (curId && mode === "home" && blocked) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center" inert={!active || undefined} aria-hidden={!active || undefined}>
      <Loader className="w-9 h-9 spinner" label="正在跳过内容" />
    </div>;
  }

  if (curId && filtering && !tagsReady && !tagErrors[tagKey]) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center" inert={!active || undefined} aria-hidden={!active || undefined}>
      <Loader className="w-9 h-9 spinner" label="正在加载内容" />
    </div>;
  }

  if (curId && filtering && !tagsReady && tagErrors[tagKey]) {
    return <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-3" inert={!active || undefined} aria-hidden={!active || undefined}>
      <span className="text-[13px] text-white/70">暂时无法加载内容</span>
      <Button onClick={() => {
        setTagErrors(previous => { const next = { ...previous }; delete next[tagKey]; return next; });
        setProxyRetry(value => value + 1);
      }} className="min-h-11 rounded-full bg-white/10 px-4 text-white">重试</Button>
    </div>;
  }

  if (!effectiveVideoIds.length) {
    return <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-3" inert={!active || undefined} aria-hidden={!active || undefined}>
      <span className="text-[14px] text-white/70">当前列表没有可播放内容</span>
      <PreferenceStorageNotice className="mx-4 max-w-sm" />
      {onBack && <Button onClick={onBack} className="min-h-11 rounded-full bg-white/10 px-5 text-white">返回</Button>}
    </div>;
  }

  return (
    <div
      className={`hg-player-ui hg-player-ambient ${!isDesktop && fs ? "fs-immersive" : "absolute inset-0"} overflow-hidden bg-black player-root ${controlsLocked ? "is-locked" : ""} ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      /* 播放页固定纯黑：不挂取色（用户：只有播放页去取色）。"none" 只为样式兜底，不再有渐变层。 */
      data-ambient="none"
      data-player-mode={endless ? "feed" : "cinema"}
      data-clean={clean}
      /* W20 对账用：当前第几条 / 当前剧 id / 已装载条数（滚动与追加是否错位一眼可见） */
      data-binge={endless ? "true" : undefined}
      data-index={index}
      data-visible-id={curId}
      data-ids={effectiveVideoIds.length}
      inert={!active || undefined}
      aria-hidden={!active || undefined}
      onFocusCapture={() => { if (active && isDesktop) wake(); }}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      <div className="absolute inset-0" inert={controlsLocked}>
      {/* 播放页固定纯黑：原来的三层上色（取色径向层 / 毛玻璃封面底 / 视频流光 canvas）
          全部移除。它们只在信箱区与上下条可见 —— 正是"上边不黑、下边黑"的来源。
          白字可读性由控件自身那两条压光负责（顶部 96px / 底部 116px）。 */}
      <div ref={boxRef} onScroll={onScroll}
        className={`absolute inset-y-0 left-0 no-bar ${fs ? "overflow-hidden" : "overflow-y-scroll snap-y snap-mandatory overscroll-y-contain"}`}
        onTouchMove={(e) => {
          /* 只拦从舞台起手的手势（stageTouch 为真）。以前只判 gesture.current，
             它可能残留着上一次的 pan → 底栏按钮的 touchmove 被 preventDefault，
             浏览器就不再合成 click，表现就是「点选集/详情毫无反应」。 */
          if (stageTouch.current) e.preventDefault();
        }}
        style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)", overscrollBehavior: "contain" }}>
        {effectiveVideoIds.map((vid, i) => {
          const isActive = i === index;
          const sectionClass = `${fs && !isActive ? "hidden" : "relative w-full h-full"} snap-start snap-always overflow-hidden`;
          // Preserve snap geometry while keeping only the active item and its
          // neighbours mounted; distant cards otherwise create many idle controls.
          if (Math.abs(i - index) > 1 && Math.abs(i - renderIndex) > 1) {
            return <section key={vid} className={sectionClass} aria-hidden="true" />;
          }
          if (filtering && !isActive && (!checked[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`] || tagErrors[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`] || blockReason(kind === "post" ? posts[vid]?.tags : details[vid]?.tags))) {
            return <section key={vid} className={sectionClass} aria-hidden="true" />;
          }
          return (
            <section key={vid} className={sectionClass} inert={!isActive || undefined} aria-hidden={!isActive || undefined}>
              {/* 整页 pager 的"下一屏"：从 ±100% 随手指一起进入（深底 + 集数，不额外开流） */}
              {isActive && !isDesktop && epGhost && (
                <div aria-hidden="true" className="hg-ep-ghost" style={{
                  position: "absolute", inset: 0, zIndex: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "#05060a",
                  transform: `translate3d(0, ${(epGhost.dir > 0 ? 1 : -1) * (pageStageH || 800) + epSlide.y}px, 0) scale(.98)`,
                  transition: epSlide.animate
                    ? `transform ${epSlide.ms ?? GESTURE.episodeCommitMs}ms ${EPISODE_EASE}`
                    : "none",
                }}>
                  <span className="text-[15px] font-semibold text-white/70">{epGhost.label}</span>
                </div>
              )}
              {isActive && playUrl ? (
                <div ref={holdTargetRef} data-mobile-hold-target={!isDesktop || undefined}
                  data-ep-moving={!isDesktop && Math.abs(epSlide.y) > 8 ? "true" : undefined}
                  className="absolute inset-0"
                  style={{
                    touchAction: "none",
                    /* 整页 pager：位移/缩放/淡出都作用在"视频画面 + 标题 + 进度 + 控件"这一层，
                       所以翻页是整页一起走，不再只有视频轻推。 */
                    transform: isDesktop
                      ? undefined
                      : `translate3d(0, ${epSlide.y}px, 0) scale(${1 - 0.04 * pageProgress})`,
                    opacity: isDesktop ? 1 : 1 - 0.45 * pageProgress,
                    transition: isDesktop || zoom.g || !epSlide.animate
                      ? "none"
                      : `transform ${epSlide.ms ?? GESTURE.episodeReboundMs}ms ${EPISODE_EASE}, opacity ${epSlide.ms ?? GESTURE.episodeReboundMs}ms ${EPISODE_EASE}`,
                    willChange: !isDesktop && Math.abs(epSlide.y) > 0 ? "transform, opacity" : undefined,
                  }}
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={(e) => onUp(false, e)}
                  onPointerCancel={(e) => {
                    /* 真机浏览器接管手势时会发 pointercancel：如果这时已经滑出方向且位移够，
                       按正常抬手结算（否则表现为「滑了等于点了一下」→ 隐藏控件/全屏） */
                    const g = gesture.current;
                    const moved = g?.mode === "pan" || g?.mode === "scrub" || g?.mode === "edgeBack";
                    logLine(`[gesture] cancel mode=${g?.mode ?? "-"} moved=${moved}`);
                    onUp(!moved, e);
                  }} onLostPointerCapture={(e) => onUp(true, e)}>
                <div style={{
                  position: "absolute",
                  inset: 0,
                  /* 视频显式压在虚化之上（虚化 z-index:0 / 视频层 z-index:1），
                     不用负值 —— 负 z-index 在带背景的父级里会被吃掉。 */
                  isolation: "isolate",
                  zIndex: 1,
                  transform: isDesktop ? undefined : `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s * epScale})`,
                  opacity: 1,
                  transformOrigin: "center center",
                  transition: isDesktop || zoom.g || !epSlide.animate
                    ? "none"
                    : `transform ${(epSlide.ms ?? GESTURE.episodeReboundMs)}ms ${EPISODE_EASE}`,
                }}>
                <VideoSurface ref={videoRef} src={playUrl} poster={posterUrl} autoPlay active={active && !tagMenu && !showHoldGuide} muted={muted}
                  diagnosticContext={{ active: active && !tagMenu && !showHoldGuide, view: mode, kind, video_id: curId, episode: curEp }}
                  volume={volume} rate={effRate}
                  measurementKey={measurementKey}
                  /* 竖屏 9:16 片源只在**竖屏非全屏**时铺满消黑边；全屏（系统已横过来）一律 contain 不裁切 */
                  fit={isDesktop ? "contain" : (portraitVideo && !fs && !vpLandscape) ? "cover" : "contain"}
                  /* 黑边里的观感交给微光效果（上游 PR #192 移植）：从当前画面采样色晕铺在黑边，
                     我们原来那套「封面虚化 hg-lb-blur」已删除，避免两套并存。 */
                  ambientGlow={ambientGlow} balanceVolume={!isDesktop && balanceVolume}
                  onClick={() => { if (isDesktop) videoRef.current?.toggle(); }}
                  onTime={onTimeTick}
                  onDuration={onDurationTick}
                  onSize={(w, h, key) => {
                    if (key !== measurementKey || !isCurrentPlayback()) return false;
                    setVsize((prev) => (prev.key === key && prev.w === w && prev.h === h ? prev : { key, w, h }));
                    /* 真机取证：片源真实宽高（用户报"画面被压成窄横条"时，先看这里是不是 3.5:1） */
                    logLine(`[play] size id=${curId} ep=${curEp} ${w}x${h} fit=${portraitVideo ? "cover" : "contain"}`);
                    return true;
                  }}
                  onPlaying={() => { if (isCurrentPlayback()) { setPaused(false); setWaiting(false); setErr(""); setSeriesEnded(false); setPlayingKey(playKey); setHoldFrame(false); } }}
                  onPause={() => { if (isCurrentPlayback()) setPaused(true); }}
                  onWaiting={() => { if (isCurrentPlayback()) setWaiting(true); }}
                  onEnded={() => {
                    if (!isCurrentPlayback()) return;
                    const next = episodes.find((e) => e.ep_num === curEp + 1);
                    if (next) { pickEp(next.ep_num); return; }
                    if (!endless) void openEndCard();
                  }}
                  onError={(m) => {
                    if (!isCurrentPlayback()) return;
                    /* CDN token 过期会表现为 403/404/410 或 hls 的 networkError：
                       自动重取一次播放地址再重试，不把这条错误丢给用户。 */
                    if ((/\b(403|404|410)\b/.test(m) || /networkError/i.test(m)) && !playRetried.current[playKey]) {
                      playRetried.current[playKey] = true;
                      setPlayUrls((prev) => { const next = { ...prev }; delete next[playKey]; return next; });
                      setHevcUrls((prev) => { const next = { ...prev }; delete next[playKey]; return next; });
                      setErr(""); setWaiting(true);
                      setPlayBust((n) => n + 1);
                      toast("播放地址已刷新，正在重试", "info");
                      return;
                    }
                    setErr(m); setWaiting(false);
                    if (useHevc) {
                      const v = videoRef.current?.el();
                      const curT = v && Number.isFinite(v.currentTime) ? v.currentTime : liveRef.current.t;
                      if (curT > 0.5) resumeRef.current = { key: playKey, t: curT };
                      setHevcFallback((prev) => ({ ...prev, [playKey]: true }));
                      toast("高清播不了，已切回标准", "info");
                    }
                  }} />
                </div>
                </div>
              ) : (
                <div className="absolute inset-0">
                  {(!filtering || checked[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`]) &&
                    <Img src={details[vid]?.cover || posts[vid]?.cover || ""} eager={Math.abs(i - index) <= 1} />}
                  <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                </div>
              )}

              {/* 换源期间保留旧帧：poster 垫住画布，等新集首帧就绪（onPlaying）再淡出 */}
              {isActive && !isDesktop && holdFrame && posterUrl && (
                <div aria-hidden="true" className="hg-ep-holdframe" style={{ backgroundImage: `url("${posterUrl}")` }} />
              )}

              {/* 图文帖：没有视频就给个正文入口 */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <Button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full text-[14px] font-semibold pressable elev-3"
                    style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
                    <IFileText size={17} />查看图文详情
                  </Button>
                </div>
              )}

              {/* 顶部 */}
              {!fs && !clean && mode === "context" ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <Button onClick={onBack} aria-label="返回"><IBack size={17} /></Button>
                    <span>{title}</span>
                    <small>{index + 1} / {effectiveVideoIds.length}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 8px)", paddingRight: endless ? 180 : 132 }}>
                    <Button onClick={onBack} aria-label="返回" className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><IBack size={20} /></Button>
                    {!endless && <span className="text-[15px] font-semibold hg-ink hg-ov-shadow truncate">{title}</span>}
                  </div>
                )
              ) : null}
              {/* 竖屏下的快捷操作（#19）：
                  横版视频 → 保持原样，居中横排一条（画面上下有黑边，居中不压主体）；
                  竖版视频 → 只剩「切集」图标，贴右边缘，避免压住画面正中。
                  显隐用 opacity + 轻微位移过渡（不卸载），净屏/全屏时慢慢淡出。 */}
              {!isDesktop && (
                <div
                  className="absolute z-20"
                  aria-hidden={!(isActive && capsuleOn)}
                  style={{
                    right: 8,
                    bottom: `min(calc(var(--sab, 0px) + ${bottomInset + 460}px), calc(100% - var(--sat, 0px) - 120px))`,
                    transform: `translateY(${isActive && capsuleOn ? 0 : 10}px)`,
                    opacity: isActive && capsuleOn ? 1 : 0,
                    pointerEvents: isActive && capsuleOn ? "auto" : "none",
                    transition: "opacity .38s cubic-bezier(.4,0,.2,1), transform .38s cubic-bezier(.4,0,.2,1)",
                  }}>
                  <div className="flex flex-col items-stretch gap-1 p-1 rounded-[18px] backdrop-blur-xl elev-2"
                    style={{ background: "rgba(12,15,22,.58)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.09)" }}>
                    {zoom.s > 1.05 && (
                      <Button type="button" onClick={() => setZoom({ s: 1, x: 0, y: 0, g: false })}
                        className="whitespace-nowrap flex items-center justify-center gap-1 h-[26px] px-3 rounded-full text-[12px] font-semibold pressable transition-colors duration-150"
                        style={{ color: "rgba(255,255,255,.9)" }}>
                        还原 {zoom.s.toFixed(1)}x
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {/* 右侧操作栏（移动端）：点赞 / 收藏 / 评论 / 全屏
                  颜色写死不跟主题走：浅色主题下这些字必须仍是白色 */}
              {actionRail.mounted && (
                <div className={`mobile-video-action-rail absolute right-3 z-20 flex flex-col items-center ${actionRail.cls} ${vpLandscape ? "gap-1.5" : "gap-3"}`}
                  style={{ bottom: vpLandscape ? "calc(var(--sab, 0px) + 12px)" : `calc(var(--sab, 0px) + ${bottomInset + 178}px)` }}>
                  {kind === "video" && (
                    <Button key={`like-${likeBump}`} onClick={() => void onLike()} disabled={likePending} aria-busy={likePending}
                      className={`min-w-11 min-h-11 flex flex-col items-center justify-center gap-1 pressable${likeBump ? " hg-like-bump" : ""}`}
                      aria-pressed={liked} aria-label="点赞">
                      {liked ? <IHeartF size={26} className="text-neon" /> : <IHeart size={26} className="hg-ink hg-ov-shadow" />}
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </Button>
                  )}
                  <Button onClick={() => void onFav()} disabled={collectPending} aria-busy={collectPending} className="min-w-11 min-h-11 flex flex-col items-center justify-center gap-1 pressable" aria-pressed={collected} aria-label="收藏">
                    {collected ? <IStarF size={26} className="hg-gold" /> : <IStar size={26} className="hg-ink hg-ov-shadow" />}
                    <span className="text-[12px] text-white/90 tabular-nums">{fmt(collectCount)}</span>
                  </Button>
                  <Button onClick={() => setPanel("comments")} className="min-w-11 min-h-11 flex flex-col items-center justify-center gap-1 pressable" aria-label={`评论 ${fmt(meta.comment)} 条`}>
                    <ICommentF size={26} className="hg-ink hg-ov-shadow" />
                    <span className="text-[12px] hg-ink-2 hg-ov-shadow tabular-nums">{fmt(meta.comment)}</span>
                  </Button>
                  <Button type="button" onClick={() => enterFs()} className="min-w-11 min-h-11 flex flex-col items-center justify-center gap-1 pressable" aria-label="全屏横屏播放">
                    <IExpand size={22} className="hg-ink hg-ov-shadow" />
                    <span className="text-[12px] hg-ink-2 hg-ov-shadow">全屏</span>
                  </Button>
                </div>
              )}

              {/* 右侧操作栏（桌面） */}
              {!fs && !clean && isDesktop && (
              <div className="absolute z-20 flex flex-col items-center desktop-social">
                <div className="desktop-browse-inline">
                  <Button onClick={() => stepDir(-1)} disabled={!canStep(-1)} aria-label="上一个" title="上一个 ↑">
                    <IChevronUp size={19} strokeWidth={1.8} />
                  </Button>
                  <Button onClick={() => stepDir(1)} disabled={!canStep(1)} aria-label="下一个" title="下一个 ↓">
                    <IChevronDown size={19} strokeWidth={1.8} />
                  </Button>
                    <small>{String(index + 1).padStart(2, "0")} / {String(effectiveVideoIds.length).padStart(2, "0")}</small>
                </div>

                {kind === "video" && (
                  <>
                    <Button onClick={() => void onLike()} disabled={likePending} aria-busy={likePending} aria-label="点赞" className="flex flex-col items-center gap-1 pressable" aria-pressed={liked}>
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {liked ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
                      </span>
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </Button>

                    <Button onClick={() => setPanel("comments")} aria-label={`评论 ${fmt(meta.comment)} 条`} className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
                    </Button>

                    <Button onClick={() => void onFav()} disabled={collectPending} aria-busy={collectPending} aria-label="收藏" className="flex flex-col items-center gap-1 pressable" aria-pressed={collected}>
                      {collected ? <IStarF size={26} className="hg-gold" /> : <IStar size={26} className="hg-ink hg-ov-shadow" />}
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(meta.collect)}</span>
                    </Button>

                    <Button onClick={() => setPanel("episodes")} aria-label="选集" className="flex flex-col items-center gap-1 pressable">
                      <IList size={26} className="text-white tsh" />
                      <span className="text-[12px] text-white/90">选集</span>
                    </Button>
                  </>
                )}

              </div>
              )}

              {/* 桌面：左下信息 */}
              {!fs && !clean && isDesktop && (
              <div className="desktop-video-meta">
                <div className="flex items-center gap-2">
                  <span className="text-[16px] font-bold text-white tsh truncate">@{meta.author}</span>
                  {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md text-[12px] font-bold text-white"
                      style={{ background: "rgba(255,255,255,.16)" }}>
                      第 {curEp}/{episodes.length} 集
                    </span>
                  )}
                   {!!meta.score && (
                  <span className="shrink-0 text-[12px] font-bold hg-gold hg-ov-shadow">{meta.score.toFixed(1)} 分</span>
                  )}
                </div>

                <p className="mt-1 text-[14px] leading-snug hg-ink-2 hg-ov-shadow clamp-2">{meta.title}</p>

                <p className="mt-1 text-[12px] leading-relaxed hg-ink-4 clamp-1">{meta.desc || "暂无简介"}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button aria-label="详情与标签" onClick={() => setPanel("detail")} className="min-h-11 px-4 rounded-full hg-chip text-[12px] inline-flex items-center gap-1">
                    详情与标签<IChevR size={13} />
                  </Button>
                  {isActive && <Button aria-label={endless ? "不感兴趣，跳过这条" : "不感兴趣"} title={endless ? "不感兴趣 · 立即跳过" : "不感兴趣 / 内容偏好"} onClick={dislikeCurrent}
                    className="video-preference-trigger"><IMore size={19} aria-hidden="true" /></Button>}
                </div>
              </div>
              )}

              {/* 移动端：统一以剧场模式为基准的底部控台（抖音模式同步支持线路/全屏/倍速/进度条，且「看全集」直达剧场续播）
                  显隐走 useFadeMount：淡入 160ms / 淡出 120ms + 6px 位移，不再整块硬闪。 */}
              {cinemaBar.mounted && (
                <div className={`hg-cinema-bottom absolute inset-x-0 z-20 ${cinemaBar.cls}`} data-hg-control="bar"
                  style={{
                    bottom: `calc(var(--sab, 0px) + ${bottomInset + 14}px)`,
                    paddingRight: vpLandscape ? 64 : undefined,
                  }}>
                  {!endless && isActive && nextEpPrompt && curEp < episodes.length && (
                    <div className="mx-4 mb-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full hg-chip-strong backdrop-blur-md text-[12px] elev-2">
                      <span className="text-sky-300 font-semibold">即将连播第 {curEp + 1} 集</span>
                      <Button type="button" onClick={() => { setNextEpPrompt(false); pickEp(curEp + 1); }}
                        className="px-2 py-0.5 rounded-full bg-white/20 text-white font-semibold pressable">
                        立即播放
                      </Button>
                      <Button type="button" aria-label="取消连播提示"
                        onClick={() => { setNextEpPrompt(false); setNextEpDismissedKey(playKey); }}
                        className="w-5 h-5 rounded-full flex items-center justify-center text-white/70">
                        <IClose size={12} />
                      </Button>
                    </div>
                  )}
                  {/* 旧的「已播完全剧 / 重播 / ×」浮层已删除：结束态统一由结束卡片表达
                      （重播 → 重新看第 1 集），不再左右各报一次同一个状态。 */}
                  {/* 剧名只在没有顶部标题时才显示（顶部已有时这里重复，用户实测截图里两处同名）。
                      抖音模式保留 @作者 · 剧名，因为那里没有顶部标题。 */}
                  {(endless || !(mode === "context" && !fs)) && (
                    <div className="mobile-video-meta-copy relative pb-2 flex items-center gap-2" data-hg-control="meta-bar" style={{ paddingRight: 76 }}>
                      <p className="flex-1 min-w-0 text-[15px] font-semibold leading-snug hg-ink-2 hg-ov-shadow-strong clamp-2">
                        {endless && meta.author ? `@${meta.author} · ` : ""}{meta.title}
                      </p>
                    </div>
                  )}
                  <div className="relative pt-1.5 pb-0">
                    <div className="mobile-video-meta-copy relative z-30 flex flex-wrap items-center gap-2"
                        data-hg-control="meta-bar"
                        style={{ paddingRight: 76, pointerEvents: "auto" }}>
                      {endless ? (
                        <Button
                          type="button"
                          aria-label={kind === "video" && episodes.length > 1 ? `看全集，共 ${episodes.length} 集` : "剧集详情"}
                          onClick={openFullSeries}
                          className="min-h-11 flex items-center gap-1 text-[12px] font-semibold hg-ink hg-ov-shadow-strong pressable">
                          <IList size={13} />
                          {kind === "video" && episodes.length > 1 ? `看全集 · 共 ${episodes.length} 集` : "剧集详情"}
                          <IChevR size={11} />
                        </Button>
                      ) : (
                        <>
                          {/* 入口永远在：集数没拿到时也给「选集」，进面板能看到原因并重试，
                              不再出现"某些剧连入口都没有"（那是 detail 没回来，不是不需要入口）。 */}
                          {kind === "video" && (
                            <Button
                              aria-label={episodes.length > 1
                                ? `打开选集，当前第 ${curEp} 集，共 ${episodes.length} 集`
                                : "打开选集（集数暂未取到，点击重试）"}
                              data-hg-control="episodes-entry"
                              onPointerDown={(e) => { e.stopPropagation(); }}
                              onClick={(e) => {
                                e.stopPropagation();
                                logLine(`[panel] open episodes at ${Math.round(e.clientX)},${Math.round(e.clientY)} eps=${episodes.length} detail=${detail ? "y" : "n"}`);
                                if (episodes.length <= 1) setProxyRetry(v => v + 1); // 集数缺就顺手重拉一次详情
                                setPanel("episodes");
                              }}
                              className="min-h-11 flex items-center gap-1 text-[12px] font-medium hg-ink-2 hg-ov-shadow-strong pressable">
                              <IList size={13} />
                              {episodes.length > 1
                                ? (seriesEnded ? "选集" : `选集 · 第 ${curEp}/${episodes.length} 集`)
                                : "选集"}
                            </Button>
                          )}
                          <Button aria-label="视频详情"
                            data-hg-control="detail-entry"
                            onPointerDown={(e) => { e.stopPropagation(); }}
                            onClick={(e) => { e.stopPropagation(); logLine(`[panel] open detail at ${Math.round(e.clientX)},${Math.round(e.clientY)}`); setPanel("detail"); }}
                            className="min-h-11 flex items-center gap-0.5 text-[12px] font-medium hg-ink-3 hg-ov-shadow-strong pressable">
                            详情<IChevR size={11} />
                          </Button>
                        </>
                      )}
                      {isActive && <Button aria-label={endless ? "不感兴趣，跳过这条" : "不感兴趣"} title={endless ? "不感兴趣 · 立即跳过" : "不感兴趣 / 内容偏好"} onClick={dislikeCurrent}
                        className="video-preference-trigger"><IMore size={19} aria-hidden="true" /></Button>}
                      {/* 线路就地切换：一个小胶囊 + 播放页内的底部面板，不再跳设置页 */}
                      {lineInfo.multi && (
                        <Button aria-label={`切换线路，当前 ${lineInfo.label}`} onClick={() => setLineOpen(true)}
                          className="min-h-11 flex items-center gap-1 text-[12px] font-medium hg-ink-3 hg-ov-shadow-strong pressable">
                          <IGlobe size={13} />{lineInfo.label}
                        </Button>
                      )}
                    </div>
                    {/* 压光已上移到播放器根节点：底栏内部这一条止于底栏下沿，
                        屏幕最底部（14px + 安全区）反而没暗化，就是用户看到的分界线。 */}
                    {/* 剧场控制行：时间 + 快捷倍速 + 下一集 */}
                    <div className="mx-4 mt-2 flex items-center gap-2.5 relative z-10">
                      <span className="hg-video-time" style={{ color: "rgba(255,255,255,.72)", textShadow: "0 1px 2px rgba(0,0,0,.65), 0 0 8px rgba(0,0,0,.45)" }}>
                        <PlaybackTime clock={playbackClock} /> <span className="opacity-60">/ {fmtTime(duration || 0)}</span>
                      </span>
                      {/* 右下角控制组：统一 13/600、行高 18、水平 padding 10、间距 8（gap），
                          热区统一 44 高（::after 撑，视觉高 26）；画质不可切时整块不渲染，
                          靠 gap 而不是 margin，所以不会留空隙。 */}
                      <div className="ml-auto flex items-center" style={{ gap: 8 }}>
                        {qualitySwitchable && (
                          <Button
                            type="button"
                            aria-label={`画质：${preferHevc ? "高清优先" : "标准画质"}，点击切换`}
                            title="在高清流 / 标准流之间切换"
                            onClick={switchQuality}
                            className="hg-ctrl hg-quality-chip pressable">
                            {preferHevc ? "高清" : "标准"}
                          </Button>
                        )}
                        <SegPill items={[
                          {
                            key: "speed",
                            ariaLabel: `倍速 ${effRate}x`,
                            onPress: () => {
                              const seq = [1, 1.25, 1.5, 2];
                              const idx = seq.indexOf(rate);
                              setRate(seq[(idx + 1) % seq.length]);
                            },
                            label: <span className="hg-num relative">{effRate}x</span>,
                          },
                          ...(!endless ? [{
                            key: "prev",
                            ariaLabel: "上一集",
                            off: curEp <= 1,
                            onPress: () => { if (curEp <= 1) { toast("已经是第一集", "info", "playback-hint"); return; } pickEp(curEp - 1); },
                            label: "上一集",
                          }] : []),
                          ...(!endless ? [{
                            key: "next",
                            ariaLabel: curEp < episodes.length ? `下一集 第${curEp + 1}集` : "下一集",
                            off: curEp >= episodes.length,
                            onPress: () => { if (curEp >= episodes.length) { toast("已经是最后一集", "info", "playback-hint"); return; } pickEp(curEp + 1); },
                            label: "下一集",
                          }] : []),
                        ]} />
                      </div>
                    </div>
                    <div ref={barRef} className="mx-4 mt-1 relative z-10" style={{ height: 28, touchAction: "none" }}
                      onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                      {/* 轨道：静止 3px，拖动中 6px（上游 dbbef9a） */}
                      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full"
                        style={{
                          height: scrubbing ? 6 : 3,
                          background: scrubbing ? "rgba(255,255,255,.3)" : "rgba(255,255,255,.24)",
                          boxShadow: scrubbing ? "0 2px 10px rgba(0,0,0,.48)" : "none",
                          transition: "height .16s cubic-bezier(.2,0,0,1), background-color .16s ease, box-shadow .16s ease",
                        }}>
                        <PlaybackProgress clock={playbackClock} duration={duration} preview={activePct} className="h-full rounded-full"
                          style={{
                            background: "var(--p-primary, #7C5CFF)",
                            boxShadow: scrubbing ? "0 0 12px rgba(124,92,255,.85)" : "0 0 8px rgba(124,92,255,.45)",
                            transition: scrubbing ? "none" : "width .25s linear, box-shadow .16s ease",
                          }} />
                      </div>
                      {/* 进度点：拖动中 10→14px，保留品牌色描边再加一圈白晕 */}
                      <PlaybackProgress clock={playbackClock} duration={duration} preview={activePct} position
                        className="absolute top-1/2 rounded-full bg-white pointer-events-none"
                        style={{
                          width: scrubbing ? 14 : 10,
                          height: scrubbing ? 14 : 10,
                          transform: "translate(-50%, -50%)",
                          boxShadow: scrubbing
                            ? "0 0 0 2px var(--p-primary, #7C5CFF), 0 0 0 6px rgba(255,255,255,.22), 0 2px 8px rgba(0,0,0,.6)"
                            : "0 0 0 2px var(--p-primary, #7C5CFF), 0 0 8px rgba(124,92,255,.65)",
                          transition: scrubbing
                            ? "width .14s ease, height .14s ease, box-shadow .14s ease"
                            : "left .25s linear, width .14s ease, height .14s ease, box-shadow .14s ease",
                        }} />
                      {scrubbing && activePct !== null && (
                        <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-3 py-1 rounded-full hg-chip-strong backdrop-blur-md text-[13px] font-bold tabular-nums whitespace-nowrap pointer-events-none elev-2"
                          style={{ boxShadow: "0 4px 16px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.14)" }}>
                          <span className="text-white">{fmtTime(activePct * (duration || 0))}</span>
                          <span className="hg-ink-4 font-medium"> / {fmtTime(duration || 0)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}


              {/* 双击 / 松手 seek 的瞬时提示（800ms 自动消失） */}
              {!isDesktop && seekHint && (
                <div
                  className="absolute z-30 flex pointer-events-none"
                  style={{
                    top: "25%",
                    transform: "translateY(-50%)",
                    /* 左右各留 16px 安全边；右侧有快捷栏时再向内让 56px（栏宽 + 间距） */
                    ...(seekHint.side === "left"
                      ? { left: 16, width: "calc(33.333% - 32px)", justifyContent: "center" }
                      : { right: actionRail.mounted && !fs ? 72 : 16, width: "calc(33.333% - 32px)", justifyContent: "center" }),
                  }}
                >
                  <div className="hg-chip hg-ink px-3 py-2 rounded-full flex items-center gap-2 backdrop-blur-md elev-2 max-w-full">
                    <span className="text-[15px] font-bold tabular-nums whitespace-nowrap">
                      {seekHint.delta >= 0 ? "+" : "−"}{Math.abs(Math.round(seekHint.delta))}s
                    </span>
                    <span className="text-[12px] hg-ink-4 tabular-nums whitespace-nowrap">{fmtTime(seekHint.target)}</span>
                  </div>
                </div>
              )}

              {/* 上滑换集预览：拖过 12% 屏高就出，内容只用现有集数 */}
              {!isDesktop && epPreview && (
                <div className="absolute inset-x-0 z-30 flex justify-center pointer-events-none" style={{ bottom: "18%" }}>
                  <div className="hg-chip hg-ink px-4 py-2 rounded-full text-[13px] font-semibold backdrop-blur-md elev-2">
                    {epPreview.label}
                  </div>
                </div>
              )}

              {/* 暂停 / 缓冲 / 错误 */}
              {isActive && paused && !err && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                  <button type="button" aria-label="继续播放"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); videoRef.current?.play(); }}
                    className="hg-player-center-btn pointer-events-auto w-[66px] h-[66px] rounded-full flex items-center justify-center border-0 cursor-pointer">
                    <IPlayF size={28} className="hg-ink ml-0.5" />
                  </button>
                </div>
              )}
              {isActive && waiting && !err && !paused && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 pointer-events-none">
                  <Loader className="w-9 h-9 spinner" />
                  {/* 出画面即随 waiting 一起卸载，不留残影 */}
                  <span className="text-[12px] hg-ink-2 hg-ov-shadow-strong">
                    {slowBuffer ? "缓冲中…（线路较慢，请稍候）" : "缓冲中…"}
                  </span>
                </div>
              )}
              {isActive && err && (
                <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                  <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[14px] hg-ink-2 pointer-events-auto" style={{ background: "rgba(0,0,0,.7)" }}>
                    <span>视频暂时无法加载</span>
                    <span className="text-[12px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
                    <Button className="hg-link text-[14px]" onClick={() => {
                      setErr(""); setWaiting(true);
                      if (playUrl && videoRef.current) videoRef.current.retry();
                      else setProxyRetry(value => value + 1);
                    }}>重试</Button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} duration={duration} rate={rate}
          clock={playbackClock}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active && !controlsLocked}
          seekKey={playKey}
          nextDisabled={!episodes.some((e) => e.ep_num === curEp + 1) && index >= effectiveVideoIds.length - 1}
          nextTitle={episodes.some((e) => e.ep_num === curEp + 1) ? "下一集 E" : "下一部 ↓"}
          swipeEp={swipeEp}
          onToggleSwipe={() => { setSwipeEp(!swipeEp); toast(swipeEp ? "上下划切集已关闭" : "上下划切集已开启", "info", "playback-hint"); }}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { videoRef.current?.seek(t, source); playbackClock.publish(t); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onLock={lockControls}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={() => {
            const nx = episodes.find((e) => e.ep_num === curEp + 1);
            if (nx) pickEp(nx.ep_num);
            else go(1);
          }}
        />
      )}

      {/* 结束态（本剧看完）：不自动滑进下一部，给「看完 + 推荐 3 部」让用户选。
          推荐来自轮换池（related 全量 + feed 若干页，见 endPool.ts），「换一批」往后移 3 部。 */}
      {!isDesktop && !endless && seriesEnded && (
        <EndCard
          title={details[curId]?.title || meta.title}
          totalEpisodes={episodes.length || 1}
          recs={endRecs}
          busy={endBusy}
          hint={endHint}
          onRegen={() => void openEndCard(true)}
          onOpen={openRecommended}
          onReplay={() => {
            setSeriesEnded(false); end.close(); setEpPreview(null);
            playbackClock.publish(0);
            if (curEp === 1) videoRef.current?.rewind();
            else { setHoldFrame(true); pickEp(1); }
          }}
          onSwipeClose={closeEndCard}
        />
      )}

      {/* 移动端倍速提示条：必须跟控件一起隐藏；只反映「长按中的临时倍速」，
          持久锁定交互与「上滑到此锁定倍速」目标已移除（上游 PR #193）。 */}
      {!isDesktop && (holdSpeed || rate !== 1) && (!clean || holdSpeed) && (!fs || !idle) && (
        <Button
          onClick={() => { if (rate !== 1 && !holdSpeed) setRate(1); }}
          className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md text-[13px] font-bold elev-2 pressable hg-chip hg-gold"
          style={{ top: "calc(var(--sat, 0px) + 54px)" }}>
          <IBoltF size={13} />
          {effRate}x {holdSpeed ? "倍速中 · 松开恢复" : "倍速"}
        </Button>
      )}

      {/* 移动端全屏进度条：闲置收起时横拖画面也要在底部冒出来（上游 dbbef9a） */}
      {!isDesktop && fs && (!idle || scrubbing) && (
        <div
          className="absolute inset-x-0 z-40 px-4"
          style={{
            bottom: "calc(var(--sab, 0px) + 52px)",
            height: 28,
          }}>
          <div ref={barRef} className="relative h-full" style={{ touchAction: "none" }}
            onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full"
              style={{
                height: scrubbing ? 7 : 3,
                background: scrubbing ? "rgba(255,255,255,.32)" : "rgba(255,255,255,.24)",
                boxShadow: scrubbing ? "0 2px 12px rgba(0,0,0,.5)" : "none",
                transition: "height .16s cubic-bezier(.2,0,0,1), background-color .16s ease, box-shadow .16s ease",
              }}>
              <PlaybackProgress clock={playbackClock} duration={duration} preview={activePct} className="h-full rounded-full"
                style={{
                  background: "var(--p-primary, #7C5CFF)",
                  boxShadow: scrubbing ? "0 0 12px rgba(124,92,255,.85)" : "0 0 8px rgba(124,92,255,.45)",
                  transition: scrubbing ? "none" : "width .25s linear, box-shadow .16s ease",
                }} />
            </div>
            <PlaybackProgress clock={playbackClock} duration={duration} preview={activePct} position
              className="absolute top-1/2 rounded-full bg-white pointer-events-none"
              style={{
                width: scrubbing ? 15 : 10,
                height: scrubbing ? 15 : 10,
                transform: "translate(-50%, -50%)",
                boxShadow: scrubbing
                  ? "0 0 0 2px var(--p-primary, #7C5CFF), 0 0 0 7px rgba(255,255,255,.24), 0 2px 8px rgba(0,0,0,.6)"
                  : "0 0 0 2px var(--p-primary, #7C5CFF), 0 0 8px rgba(124,92,255,.65)",
                transition: scrubbing
                  ? "width .14s ease, height .14s ease, box-shadow .14s ease"
                  : "left .25s linear, width .14s ease, height .14s ease, box-shadow .14s ease",
              }} />
            {scrubbing && activePct !== null && (
              <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-3 py-1 rounded-full hg-chip-strong backdrop-blur-md text-[13px] font-bold tabular-nums whitespace-nowrap pointer-events-none elev-2"
                style={{ boxShadow: "0 4px 16px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.14)" }}>
                <span className="text-white">{fmtTime(activePct * (duration || 0))}</span>
                <span className="hg-ink-4 font-medium"> / {fmtTime(duration || 0)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 移动端：沉浸全屏顶栏 / 底栏 */}
      {!isDesktop && fs && !idle && (
        <>
          <div className="hg-scrim-top z-30">
            <span className="hg-scrim-dither" aria-hidden="true" />
          </div>
          <div className="hg-scrim-bottom z-30">
            <span className="hg-scrim-dither" aria-hidden="true" />
          </div>

          {/* 全屏顶部：返回退出全屏 + 剧名 + 集数 */}
          <div className="absolute inset-x-0 z-40 flex items-center gap-2.5 px-4"
            style={{
              top: "calc(var(--sat, 0px) + 6px)",
              paddingRight: 108,
            }}>
            <Button onClick={exitFs} aria-label="退出全屏"
              className="hg-chip-strong shrink-0 w-9 h-9 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
              <IBack size={18} />
            </Button>
            <div className="min-w-0 flex items-center">
              <span className="text-[14px] font-semibold hg-ink hg-ov-shadow truncate">{meta.title || title || "正在播放"}</span>
            </div>
          </div>

          {/* 右上角的「退出全屏」已并进下面那块右上控件组（占竖屏「静音」的格子）：
              以前它单独定在 right:12，竖屏那块在 right:56 —— 一进全屏锁就被挤左 44px，
              用户看到的就是「右上两个按钮位置会变」。现在两个格子固定，锁永远在最右。 */}

          {/* 全屏底栏：当前/总时长 + 缩放还原/倍速/选集/下集 */}
          <div className="absolute inset-x-0 z-40 flex items-center gap-2.5 px-4"
            style={{
              bottom: "calc(var(--sab, 0px) + 12px)",
            }}>
            <span className="shrink-0 text-[13px] font-semibold hg-ink-2 tabular-nums">
              <PlaybackTime clock={playbackClock} /> <span className="hg-ink-4 font-normal">/ {fmtTime(duration)}</span>
            </span>
            <div className="ml-auto flex items-center gap-2">
              {zoom.s > 1.05 && (
                <Button onClick={() => setZoom({ s: 1, x: 0, y: 0, g: false })}
                  className="shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[12px] font-semibold hg-chip hg-ink-2 pressable"
                  aria-label="还原画面">
                  还原 {zoom.s.toFixed(1)}x
                </Button>
              )}
              <SegPill items={[
                {
                  key: "speed",
                  ariaLabel: `倍速 ${effRate}x`,
                  onPress: () => {
                    const seq = [1, 1.25, 1.5, 2];
                    const idx = seq.indexOf(rate);
                    setRate(seq[(idx + 1) % seq.length]);
                  },
                  label: <span className="hg-num relative">{effRate}x</span>,
                },
                ...(episodes.length > 1 ? [{
                  key: "eps",
                  ariaLabel: `选集，当前第 ${curEp} 集，共 ${episodes.length} 集`,
                  onPress: () => setPanel("episodes"),
                  label: `第 ${curEp}/${episodes.length} 集`,
                }] : []),
                ...(episodes.length > 1 ? [{
                  key: "next",
                  ariaLabel: curEp < episodes.length ? `下一集 第${curEp + 1}集` : "下一集",
                  off: curEp >= episodes.length,
                  onPress: () => { if (curEp >= episodes.length) { toast("已经是最后一集", "info", "playback-hint"); return; } pickEp(curEp + 1); },
                  label: "下集",
                }] : []),
              ]} />
            </div>
          </div>
        </>
      )}

      {/* 选集 / 评论：桌面停靠在右侧（画面让位），移动端底部弹层 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "detail" ? detailBody(() => setPanel(null)) : panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)}
                onRetry={() => setProxyRetry(v => v + 1)} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {/* 评论：移动端底部弹层（右侧操作栏「评论」入口） */}
          <Sheet open={active && panel === "comments"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72dvh" }}>
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          {/* 吃瓜图文正文 */}
          <Sheet open={active && panel === "article"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "78dvh" }}>
              <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          {/* 面板 label 不能和按钮同名：DialogFrame 会把它写成 role=dialog 的 aria-label，
              于是「视频详情」在同页出现两份，自动化/读屏可能命中离屏的那个（真机 x=-169 那次）。 */}
          <Sheet open={active && (panel === "detail" || panel === "episodes")} label={panel === "detail" ? "视频详情面板" : "选集面板"} onClose={() => setPanel(null)}>
            <div className="video-details-sheet">
              {/* 双栏抽屉：详情 / 选集 */}
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <SegmentedControl className="flex-1" aria-label="剧集面板" activeIndex={panel === "detail" ? 0 : 1}>
                  {([["detail", "详情"], ["episodes", "选集"]] as const).map(([k, l]) => (
                    <Button aria-pressed={panel === k} key={k} onClick={() => setPanel(k)}>{l}</Button>
                  ))}
                </SegmentedControl>
                <Button onClick={() => setPanel(null)} aria-label="关闭"
                  className="ios-icon-button">
                  <IClose size={14} />
                </Button>
              </div>

              <PanelSwipeArea panel={panel === "episodes" ? "episodes" : "detail"} pages={DRAWER_PAGES}
                onChange={setPanel} onClose={() => setPanel(null)} className="flex-1 min-h-0">
                {panel === "episodes" ? (
                  /* 点集后显式收面板（不依赖 pickEp 内部）：面板还开着时视频会在后面起播，用户看不见（P2-2） */
                  <EpisodesPanel bare videoId={curId} episodes={episodes} current={curEp}
                    onPick={(n) => { pickEp(n); setPanel(null); }} onClose={() => setPanel(null)} />
                ) : (
                  detailBody()
                )}
              </PanelSwipeArea>
            </div>
          </Sheet>
        </>
      )}
      </div>
      {!isDesktop && !controlsLocked && active && (!fs || !idle) && (
        <div className={`absolute z-40 flex items-center gap-2`}
          style={{
            /* 竖向：竖屏吃顶部安全区（Android 49 → 55、iPhone 47 → 53）。状态栏在横屏/全屏会消失，
               env(safe-area-inset-top) 掉到 0（--sat 的下限 24）→ 这一块会自己上移 23px。
               用户要的是「位置不能变」，所以用 53px 兜底：竖屏仍是原值，横屏不再上移。 */
            top: "max(calc(var(--sat, 0px) + 6px), 53px)",
            /* 横向只吃**左右**安全区（刘海 / 圆角）。以前竖屏写死 right-3、没有算 --sar，
               iPhone 横过来（--sar: 48）按钮会压进圆角。 */
            right: "calc(var(--sar, 0px) + 0.75rem)",
          }}>
          {/* 两个格子固定：[左] = 静音 / 退出全屏，[右] = 锁。
              全屏把「退出全屏」放进左格子，锁就不会被挤走（进/退全屏坐标不变）。 */}
          {fs ? (
            <Button onClick={exitFs} aria-label="退出全屏" title="退出全屏"
              className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ICompress size={17} /></Button>
          ) : (!clean && <Button onClick={() => setMuted(m => !m)} aria-label={muted ? "取消静音" : "静音"}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
            {muted ? <IVolMute size={17} /> : <IVol size={17} />}
          </Button>)}
          <Button onClick={lockControls} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false}
            className={`hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1${clean ? " hidden" : ""}`}><ILockF size={17} /></Button>
        </div>
      )}
      {/* 控件收起（idle）时的「一步退出全屏」热区：48×48，与上面那个可见的退出钮同一个角，
          但**不画任何东西**（透明无边框、无子元素）—— 收起态下用户点屏幕只想要回控件，
          全屏想退却要「点一下唤出 → 再点退出」两步，这里补上直接可点的位置。
          放在舞台之外，不参与视频区的手势判定。 */}
      {!isDesktop && fs && idle && !controlsLocked && active && (
        <button type="button" onClick={exitFs} aria-label="退出全屏" title="退出全屏"
          style={{
            position: "absolute",
            top: "max(calc(var(--sat, 0px) + 6px), 53px)",
            right: "calc(var(--sar, 0px) + 0.75rem)",
            width: 48, height: 48,
            padding: 0, border: 0, background: "transparent",
            WebkitTapHighlightColor: "transparent", zIndex: 40,
          }} />
      )}
      <TagBlockMenu open={active && tagMenu} tags={meta.tags} initialSelected={tagMenuSeed} onClose={() => setTagMenu(false)} />
      {/* 线路面板：播放页内就地弹，不跳设置页 */}
      {!isDesktop && <LineQuickSwitch open={active && lineOpen} onClose={() => setLineOpen(false)} />}
      {/* 控件收起（clean）时**不再铺拦截层**。
          它当初是为了「点信息栏的坐标落到下层内容」加的，但代价是所有指针事件都被它吃掉：
          控件收起态（看剧时的常态）长按 2x、双击 ±5s 全部失效 —— 真机日志里 pointerdown 的
          target 是 DIV[clean-catcher]，舞台手势一次都收不到，380ms 的长按计时器都没机会生效。
          舞台层自己已经处理了这三种语义（onUp：hidden → showControls；双击 → 三分 seek；
          onDown 的 380ms → 2x），所以直接交给舞台，不再多一层。
          验收（AVD，本提交前用 CSS 等价隐藏了该层）：clean 态长按出「2x 倍速中」、双击出
          ±5s 气泡、单击只唤出控件（stacks/title 不变，没有点穿到别的页）。 */}
      {controlsLocked && <PlaybackLock active={active} hideUnlockUntilTapped={!isDesktop} onUnlock={() => { setControlsLocked(false); if (isDesktop) wake(); else showControls(); }} />}
    </div>
  );
}
