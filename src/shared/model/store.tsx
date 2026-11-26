import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, platform as envPlatform, takeFailoverNotice } from "../api/api";
import { isStrictSecurity, setSiteOrigin, setStrictSecurity as setHtmlStrictSecurity } from "../lib/html";
import type { User } from "../api/types";
import { readStorage, STORAGE_KEYS } from "../storage/storage";
import type { AccentScheme } from "../ui/accent";
import { FALLBACK_SCHEME } from "../ui/accent";
import { readAmbient } from "../ui/useAccent";
import { pickGuestData, useAccountData, type GuestData } from "./accountData";
import { popWithTransition } from "../../app/pageTransition";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Tab = "home" | "posts" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 「抖音模式」：滑到尾部自动追加下一页，刷完给结束卡 */
  endless?: boolean;
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "search"; key: string; initialTab?: "video" | "post" }
  | { kind: "history"; key: string }
  | { kind: "favorites"; key: string; initialTab?: "video" | "post" }
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string }
  | { kind: "settings-tags"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number }
  | { kind: "topics"; key: string }
  | { kind: "topic"; key: string; slug: string; name: string }
  | { kind: "series"; key: string; id: number }
  | { kind: "tags"; key: string }
  | { kind: "tag"; key: string; tag: string; name: string }
  | { kind: "following"; key: string }
  | { kind: "user"; key: string; id: number; name?: string };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; endless?: boolean; startEp?: number; startTime?: number }
  | { kind: "search"; initialTab?: "video" | "post" }
  | { kind: "history" }
  | { kind: "favorites"; initialTab?: "video" | "post" }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "settings-tags" }
  | { kind: "posts" }
  | { kind: "post"; id: number }
  | { kind: "topics" }
  | { kind: "topic"; slug: string; name: string }
  | { kind: "series"; id: number }
  | { kind: "tags" }
  | { kind: "tag"; tag: string; name: string }
  | { kind: "following" }
  | { kind: "user"; id: number; name?: string };

export type Toast = {
  id: number;
  msg: string;
  icon?: "ok" | "heart" | "star" | "info";
  /** 线路切换专用的结构化内容，有这个就不看 msg */
  line?: { region: "cn" | "intl"; host: string; ms: number };
  /** 同 tag 的 toast 原地替换（如 playback-hint 统一承载播放状态提示），快速触发不堆叠；无 tag 正常堆叠。 */
  tag?: string;
};

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = GuestData & {
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
  /** 上下划切集：多集短剧上下滑就换集，而不是换下一部 */
  swipeEp: boolean;
  /** 优先高清：有 HEVC 就用 HEVC，播不了自动回退标准 */
  preferHevc: boolean;
  /** 微光效果：从当前画面采样色晕铺到视频黑边（上游 PR #192），默认开 */
  ambientGlow: boolean;
  /** 平衡音量（POC）：默认关闭，只在移动端出现设置项 */
  balanceVolume: boolean;
};

const LS = STORAGE_KEYS.app;
/* 「我的」里给本机游客数据标来源用 */
const GUEST_KEPT_KEY = "hguox_guest_kept_v1";
const DEFAULTS: Persist = {
  likes: [], favs: [], postFavs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [], swipeEp: true, preferHevc: true, ambientGlow: true, balanceVolume: false,
};

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

function loadPersist(): Persist {
  try {
    const raw = readStorage(LS);
    const swipeMigration = readStorage(STORAGE_KEYS.swipeEp);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    /* 1.2.9 起上下划默认就是切集。老配置里 swipeEp 存的 false 是当年的默认值，
       不是用户主动关的，所以这里做一次性迁移；用户之后自己关掉不会再被改回来。 */
    let swipeEp = p.swipeEp !== false;
    try {
      if (swipeMigration !== "1") {
        swipeEp = true;
        localStorage.setItem(STORAGE_KEYS.swipeEp, "1");
      }
    } catch { /* ignore */ }
    /* 旧配置没有这个概念，按「默认开」处理（只有显式 false 才关） */
    const ambientGlow = p.ambientGlow !== false;
    const balanceVolume = p.balanceVolume === true;
    return { ...p, swipeEp, muteOnStartup, muted: muteOnStartup || p.muted === true, ambientGlow, balanceVolume, history: normalizeHistory(p.history) };
  } catch {
    return DEFAULTS;
  }
}

type Store = {
  platform: Platform;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null, origin?: string) => void;
  accountScope: string; accountSync: { busy: boolean; error: string; lastSynced: number; favoritesKnown: boolean };
  syncAccount: () => Promise<void>;
  setCollected: (kind: "video" | "post", id: number, on: boolean, knownEpisodes?: number) => Promise<void>;
  setLiked: (kind: "video" | "post", id: number, ep: number, on: boolean) => Promise<void>;
  setFollowing: (id: number, on: boolean) => Promise<void>;
  actionPending: (key: string) => boolean;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; postFavs: number[]; history: WatchProgress[]; postHistory: number[]; follows: number[];
  /** 收藏时的集数基线：算「还有几集是新的」，只存本地（见 favoriteProgress.ts） */
  favEpCounts: Record<number, number>;
  seedFavoriteEpisodes: (entries: Record<number, number>) => void;
  ackFavoriteEpisodes: (id: number, knownEpisodes: number) => void;
  isLiked: (id: number, ep?: number, kind?: "video" | "post") => boolean; isFav: (id: number, kind?: "video" | "post") => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  addPostHistory: (id: number) => void;
  clearHistory: () => Promise<void>;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 移动端「净屏」：只留画面，UI 全隐 */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  swipeEp: boolean; setSwipeEp: (on: boolean) => void;
  preferHevc: boolean; setPreferHevc: (on: boolean) => void;
  ambientGlow: boolean; setAmbientGlow: (on: boolean) => void;
  balanceVolume: boolean; setBalanceVolume: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; removeSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"], tag?: string, ms?: number) => void;
  /** 线路切换计数：变了就让列表页重挂载，重新拉一遍数据 */
  lineEpoch: number;
  /** 当前封面取色（全站 accent 的唯一来源） */
  accent: AccentScheme; setAccent: (a: AccentScheme) => void;
  /** 游客本机数据合并提示：非空表示要问用户 */
  mergeOffer: { favs: number; history: number } | null;
  beginGuestMerge: () => void;
  /** 本机（游客）数据快照：用于「我的」里显示未同步的本地记录 */
  guestSnapshot: () => GuestData;
  acceptMerge: (onProgress?: (done: number, total: number) => void) => Promise<{ okFavs: number; failFavs: number; okHistory: number; failHistory: number }>;
  declineMerge: () => void;
  /** 用户选了「暂不同步」：本机数据保留，「我的」里标注来源 */
  guestKept: boolean;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;
/** 换线提示的投递器：由 AppProvider 在挂载时注入最新的 `show`。
 *  等待启动动画退场的间隔放在模块作用域 —— 组件重挂载不会把它清掉。 */
let failoverNotifier: ((host: string) => void) | null = null;
let splashWait: number | undefined;
let queuedFailoverHost = "";

function announceFailover(host: string) {
  if (!host) return;
  queuedFailoverHost = host;
  if (!document.querySelector(".hg-launch")) {
    flushFailoverToast();
    return;
  }
  window.clearInterval(splashWait);
  splashWait = window.setInterval(flushFailoverToast, 250);
}

function flushFailoverToast() {
  if (!queuedFailoverHost || !failoverNotifier) return;
  if (document.querySelector(".hg-launch")) return;
  const host = queuedFailoverHost;
  queuedFailoverHost = "";
  window.clearInterval(splashWait);
  splashWait = undefined;
  failoverNotifier(host);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const stackRef = useRef<Page[]>(stack);
  stackRef.current = stack;
  // Guest library writes must not roll back sound, quality, gestures or search preferences.
  const account = useAccountData(
    pickGuestData(p),
    data => setP(previous => ({ ...previous, ...pickGuestData(data) })),
  );
  const { user, setUser } = account;
  const accountRef = useRef(account); accountRef.current = account;
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lineEpoch, setLineEpoch] = useState(0);
  const [accent, setAccentState] = useState<AccentScheme>(() => readAmbient());
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  /* 游客本机数据 → 登录后合并提示（非阻断；选「暂不同步」后本地原样保留） */
  const [mergeOffer, setMergeOffer] = useState<{ favs: number; history: number } | null>(null);
  const [guestKept, setGuestKeptState] = useState<boolean>(() => {
    try { return localStorage.getItem(GUEST_KEPT_KEY) === "1"; } catch { return false; }
  });
  const setGuestKept = useCallback((kept: boolean) => {
    setGuestKeptState(kept);
    try { kept ? localStorage.setItem(GUEST_KEPT_KEY, "1") : localStorage.removeItem(GUEST_KEPT_KEY); } catch { /* ignore */ }
  }, []);
  const toastSeq = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  /** 登录成功后调用：本机（游客）有收藏/观看就发一条合并提示（非阻断） */
  const beginGuestMerge = useCallback(() => {
    const snap = accountRef.current.guestSnapshot();
    const favs = snap.favs.filter((id) => Number.isSafeInteger(id) && id > 0).length;
    const history = snap.history.filter((row) => Number.isSafeInteger(row.id) && row.id > 0).length;
    if (!favs && !history) { setMergeOffer(null); return; }
    setMergeOffer({ favs, history });
  }, []);
  const declineMerge = useCallback(() => {
    setMergeOffer(null);
    /* 本地数据原样保留，并在「我的」标注来源 */
    setGuestKept(true);
  }, [setGuestKept]);

  useEffect(() => {
    let request = 0;
    let active = true;
    const readBoot = () => {
      const current = ++request;
      const generation = accountRef.current.generation();
      void api.boot().then((r) => {
        if (!active || current !== request) return;
        /* 正文里的站内链接要按当前线路的域名认（上游 6cff406）：
           boot 回来的 base 就是这一轮实际生效的线路，换线路后重建 App 也会重算。 */
        setSiteOrigin(r.base || "");
        accountRef.current.restoreSession(r.user && (r.user as User).id ? r.user as User : null, r.base || "", generation);
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      }).catch(() => { /* 离线也能用 */ });
    };
    readBoot();
    // 切线/代理变化后由 boot 决定会话：可信线路间后端会 rebase 登录态，先 setUser(null)
    // 会闪一下登出；不可信/自定义切线后端已清会话，boot 返回 null 就是正常登出。
    const changed = () => { readBoot(); };
    window.addEventListener("hg:line-changed", changed);
    window.addEventListener("hg:proxy-changed", changed);
    return () => {
      active = false;
      window.removeEventListener("hg:line-changed", changed);
      window.removeEventListener("hg:proxy-changed", changed);
    };
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  /* 带 tag 的提示共用同一个槽位：原地替换内容并重置计时，不堆叠、不重放入场动画
     （上游 PR #200）。无 tag 的普通提示仍是「最多 3 张」的堆叠行为。
     `ms` 可选：个别提示（如「推荐已轮完一遍」）要求更快收掉，默认仍是 2200ms。 */
  const toast = useCallback((msg: string, icon?: Toast["icon"], tag?: string, ms = 2200) => {
    const id = ++toastSeq.current;
    setToasts((t) => {
      if (tag) {
        const idx = t.findIndex((x) => x.tag === tag);
        const next: Toast = { id, msg, icon, tag };
        if (idx >= 0) { const copy = t.slice(); copy[idx] = next; return copy; }
        return [...t.slice(-2), next];
      }
      return [...t.slice(-2), { id, msg, icon }];
    });
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);
  const acceptMerge = useCallback(async (onProgress?: (done: number, total: number) => void) => {
    const snap = accountRef.current.guestSnapshot();
    setMergeOffer(null);
    const result = await accountRef.current.mergeGuest(
      { favs: snap.favs.filter((id) => Number.isSafeInteger(id) && id > 0), history: snap.history.filter((row) => Number.isSafeInteger(row.id) && row.id > 0) },
      onProgress,
    );
    const ok = result.okFavs + result.okHistory;
    const fail = result.failFavs + result.failHistory;
    setGuestKept(fail > 0);
    toast(fail > 0 ? `已同步 ${ok} 项，失败 ${fail} 项（失败的仍留在本机）` : `已同步 ${ok} 项到账号`, fail > 0 ? "info" : "ok");
    return result;
  }, [setGuestKept, toast]);
  /** 自动选线切换成功后由 `autoLine.ts` 派发，这里只负责显示 */
  useEffect(() => {
    const onLine = (e: Event) => {
      const d = (e as CustomEvent<{ region: "cn" | "intl"; host: string; ms: number }>).detail;
      if (!d) return;
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: "", line: d }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
    };
    window.addEventListener("hg:line", onLine);
    return () => window.removeEventListener("hg:line", onLine);
  }, []);
  /** 自动选线：主站和发布页上的镜像全都不通。
   *
   * 只说一次（60s 节流）——巡检本身 10s 一轮，不节流会一直弹。
   * 以前这种情况会悄悄切到 `.ai`（接口全 404），用户只看到「加载失败」，
   * 根本不知道是网络的事。
   */
  useEffect(() => {
    let last = 0;
    const onDown = () => {
      const now = Date.now();
      if (now - last < 60_000) return;
      last = now;
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: "线路全部不可用，请检查网络或代理", icon: "info" }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
    };
    window.addEventListener("hg:line-down", onDown);
    return () => window.removeEventListener("hg:line-down", onDown);
  }, []);
  /** 偏好线路连续失败、被迫换到别的线路：轻提示一次（回切偏好的时候不提示）。 */
  useEffect(() => {
    let last = 0;
    const onSwitched = () => {
      const now = Date.now();
      if (now - last < 30_000) return;
      last = now;
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: "当前线路不可用，已自动切换", icon: "info" }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
    };
    window.addEventListener("hg:line-auto-switched", onSwitched);
    return () => window.removeEventListener("hg:line-auto-switched", onSwitched);
  }, []);
  /** 主域被网络层拦住、紧急换到备用线路（3.0.14 G 节）：
   *  用户必须知道「刚才那一下不卡是因为替你换了条路」，否则下次换不了会以为坏了。
   *
   *  这里踩过两个坑：
   *   ① 冷启动时请求比本 effect 先跑完 → 事件发在空处。所以除了监听，挂载时再向
   *      api 层「补拿」一次最近一次换线结果；
   *   ② 启动动画（.hg-launch 全屏遮罩）盖着时弹 toast 等于没弹。等待遮罩退场的定时器
   *      放在模块作用域（announceFailover），**不**归 effect 清理 —— 否则 provider 一
   *      重挂载/重跑就把定时器清掉，提示永远不出来。
   */
  useEffect(() => {
    const show = (host: string) => {
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: `已切换到备用线路：${host}`, icon: "info" }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
    };
    failoverNotifier = show;
    const onFailover = (e: Event) => {
      takeFailoverNotice(); /* 事件已经送到，别让「补拿」那条再来一次 */
      announceFailover((e as CustomEvent<{ host?: string }>).detail?.host ?? "");
    };
    window.addEventListener("hg:line-failover", onFailover);
    const pending = takeFailoverNotice();
    if (pending) announceFailover(pending);
    return () => {
      window.removeEventListener("hg:line-failover", onFailover);
      if (failoverNotifier === show) failoverNotifier = null;
    };
  }, []);
  /** 线路真的换了（自动、手切都算）：
   *
   * 旧数据全是在上一个域名上拉的，留着等于对着一条死链路。但各列表页只在
   * 挂载时拉一次，所以这里给一个递增的 key，让它们重挂载、重新请求。
   */
  useEffect(() => {
    const bump = () => setLineEpoch((n) => n + 1);
    window.addEventListener("hg:line-changed", bump);
    window.addEventListener("hg:proxy-changed", bump);
    return () => {
      window.removeEventListener("hg:line-changed", bump);
      window.removeEventListener("hg:proxy-changed", bump);
    };
  }, []);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack(s => s.length ? [] : s); }, []);
  useEffect(() => { if (tab === "profile") void accountRef.current.syncAccount().catch(() => {}); }, [tab]);
  const push = useCallback((pg: PageInput) => {
    setStack((s) => {
      const top = s[s.length - 1];
      if (pg.kind === "search" && top?.kind === "search") {
        if (pg.initialTab && top.initialTab !== pg.initialTab) {
          return [...s.slice(0, -1), { ...top, initialTab: pg.initialTab }];
        }
        return s;
      }
      if (top && top.kind === pg.kind) {
        if (pg.kind === "series" && top.kind === "series" && top.id === pg.id) return s;
        if (pg.kind === "post" && top.kind === "post" && top.id === pg.id) return s;
        if (pg.kind === "topic" && top.kind === "topic" && top.slug === pg.slug) return s;
        if (pg.kind === "tag" && top.kind === "tag" && top.tag === pg.tag) return s;
        if (pg.kind === "channel" && top.kind === "channel" && top.cate === pg.cate) return s;
        if (pg.kind === "tags" || pg.kind === "ranks" || pg.kind === "history" || pg.kind === "favorites" || pg.kind === "settings" || pg.kind === "settings-tags") return s;
      }
      const next = [...s, { ...pg, key: `p${++seq}` } as Page];
      return next.length > 8 ? next.slice(next.length - 8) : next;
    });
  }, []);
  /* 返回/退出动画：真正出栈由 pageTransition 在动画结束后执行（减少动效/低端机直接切） */
  const popping = useRef(false);
  const pop = useCallback(() => {
    if (popping.current) return;
    const top = stackRef.current[stackRef.current.length - 1];
    if (!top) return;
    popping.current = true;
    void popWithTransition(() => setStack((s) => s.slice(0, -1)), top.kind === "feed")
      .finally(() => { popping.current = false; });
  }, []);

  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const removeSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: s.searchHist.filter((x) => x !== t) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    await accountRef.current.logout();
    toast("已退出登录", "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
    // 进出全屏/净屏时把「净屏」收掉，避免退出后 UI 还藏着
    setCleanState(false);
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setSwipeEp = useCallback((on: boolean) => {
    setP((s) => ({ ...s, swipeEp: on }));
  }, []);
  const setPreferHevc = useCallback((on: boolean) => {
    setP((s) => ({ ...s, preferHevc: on }));
  }, []);
  const setAmbientGlow = useCallback((on: boolean) => {
    setP((s) => ({ ...s, ambientGlow: on }));
  }, []);
  const setBalanceVolume = useCallback((on: boolean) => {
    setP((s) => ({ ...s, balanceVolume: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    accountScope: account.accountScope, accountSync: account.accountSync, syncAccount: account.syncAccount,
    likes: account.likes, favs: account.favs, postFavs: account.postFavs, history: account.history, postHistory: account.postHistory, follows: account.follows,
    favEpCounts: account.favEpCounts, seedFavoriteEpisodes: account.seedFavoriteEpisodes, ackFavoriteEpisodes: account.ackFavoriteEpisodes,
    isLiked: account.isLiked, isFav: account.isFav,
    setCollected: account.setCollected, setLiked: account.setLiked, setFollowing: account.setFollowing, actionPending: account.actionPending,
    toggleLikeLocal: account.toggleLikeLocal, toggleFavLocal: account.toggleFavLocal, toggleFollowLocal: account.toggleFollowLocal,
    addHistory: account.addHistory, addPostHistory: account.addPostHistory, clearHistory: account.clearHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs, clean, setClean,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    swipeEp: p.swipeEp, setSwipeEp,
    preferHevc: p.preferHevc, setPreferHevc,
    ambientGlow: p.ambientGlow, setAmbientGlow,
    balanceVolume: p.balanceVolume, setBalanceVolume,
    searchHist: p.searchHist, addSearch, removeSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    accent, setAccent: setAccentState,
    toasts, toast, lineEpoch,
    mergeOffer, beginGuestMerge, acceptMerge, declineMerge, guestKept,
    guestSnapshot: () => accountRef.current.guestSnapshot(),
  }), [tab, setTab, stack, push, pop, user, loginOpen, logout,
    mergeOffer, beginGuestMerge, acceptMerge, declineMerge, guestKept,
    p, account,
    setMuted, setMuteOnStartup, setSwipeEp, setPreferHevc, setAmbientGlow, setVolume, addSearch, removeSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    accent, setAccentState,
    toasts, toast, lineEpoch, theater, setTheater, fs, setFs, clean, setClean]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
