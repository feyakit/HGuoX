import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { prefetchDetails } from "../../shared/api/detailFast";
import { useTabSwipe } from "./useTabSwipe";
import { ApiError, api, fmt, hostOf, isMobile, logLine, netLog, releaseBootBudget, switchLineForRetry } from "../../shared/api/api";
import type { Detail, RankItem, TopicCard, VideoCard } from "../../shared/api/types";
import type { HomeBanner } from "../../shared/api/api";
import { FIRST_SCREEN_RETRY_DELAYS, firstScreenBudget, withLineRetries } from "../../shared/network/firstScreen";
import { useStore } from "../../shared/model/store";
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { Empty, Img } from "../../shared/ui/ui";
import { IBoltF, IChevR, IClose, IFireF, IPlayF, IRefresh, ISearch, Logo } from "../../shared/ui/icons";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { PreferenceStorageNotice } from "../../shared/ui/PreferenceStorageNotice";
import { FRESH_GAP_MS, useApiRefresh, useForegroundRefresh, useFreshness, useVisibilityRefresh } from "../../shared/lib/dataFreshness";
import { PullIndicator, usePullToRefresh } from "../../shared/lib/usePullToRefresh";
import LinePicker from "../settings/LinePicker";

const RankView = lazy(() => import("../search/Search").then(m => ({ default: m.RankView })));

/* 首页 v5 差异化架构 + 真实品质编排：
   顶栏 = 大字重流光排版顶栏（推荐 / 上新 / 热榜 + 搜索，彻底告别独立胶囊行）
   ① 推荐 = 官方口碑推荐榜主推展台（错峰避重）→ 热播风向标 TOP 10 真榜单 → 独家原创 16:10 宽画幅双列（跨模块去重）→ 精选专题企划 → 为你推荐海报流（支持一键「换一批」轮换淘片）
   ② 上新 = 零轮播！严格按真实上架时间倒序的首发杂志流（首发 6 部大卡 + 近期新片速览）
   ③ 热榜 = 一体式玻璃滑块 + 金银铜 3D 错落三联领奖台 + 真实比例流光热度条 */

const TABS = [
  { key: "all", label: "推荐" },
  { key: "new", label: "上新" },
  { key: "rank", label: "热榜" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
type FeedTab = Exclude<TabKey, "rank">;

type HeroSpot = {
  id: number;
  title: string;
  cover: string;
  tags: string[];
  score: number;
  episode_count: number;
  total_episodes?: number;
  is_finished: boolean;
  kicker: string;
};

/** `mergeBannerText` 的输入：feed 卡片（`id`）与 hero 补全（`video_id`）共用的字段子集。 */
type BannerTextSource = {
  id?: number;
  video_id?: number;
  title?: string | null;
  tags?: string[] | null;
  episode_count?: number | null;
  total_episodes?: number | null;
  is_finished?: boolean | null;
  cover?: string | null;
};

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
/* 主推展台自动轮换间隔：2.1.2 有、3.0.0 重构时丢了（报告 7「三分钟内无自动轮换」） */
const HERO_ROTATE_MS = 6000;

/** 空闲时再跑（有 requestIdleCallback 就用，超时兜底到 900ms；返回取消函数）。
 *  首屏之后的预取/次要货架都走这里：不跟首帧抢主线程和带宽。 */
const scheduleIdle = (fn: () => void, timeout: number): (() => void) => {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) {
    const id = ric(fn, { timeout });
    return () => (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
  }
  const timer = window.setTimeout(fn, Math.min(timeout, 900));
  return () => window.clearTimeout(timer);
};

const parseTime = (raw?: string | number) => {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number") return raw > 1e12 ? raw : raw * 1000;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n > 1e12 ? n : n * 1000;
  }
  return Date.parse(trimmed.replace(" ", "T"));
};

const latestTimestamp = (v: VideoCard) => {
  const candidates = [parseTime(v.last_ep_at), parseTime(v.new_at), parseTime(v.created_at)].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : NaN;
};

const isNew = (v: VideoCard) => {
  const t = latestTimestamp(v);
  return Number.isFinite(t) && Date.now() - t < WEEK;
};

const releaseLabel = (v: VideoCard) => {
  const t = latestTimestamp(v);
  if (Number.isFinite(t)) {
    const diff = Date.now() - t;
    if (diff >= 0 && diff < DAY) return "今日首发";
    if (diff >= 0 && diff < 3 * DAY) return "近3日上新";
    const d = new Date(t);
    return `${d.getMonth() + 1}月${d.getDate()}日 上新`;
  }
  const raw = (v.created_at || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return m ? `${Number(m[2])}月${Number(m[3])}日 上新` : "新片上架";
};

/** 加载失败卡片（3.0.14 G 节）。
 *
 *  三个硬要求：① 说人话，不再把 `tls handshake eof` 直接怼给用户；
 *  ② 两个出口：「重试」原地再拉一次，「换个线路」打开播放源面板；
 *  ③ 原始错误折叠进「详情」，默认不展示。 */
function FeedError({ error, raw, networkish, onRetry, onSwitch }: {
  error: string; raw: string; networkish: boolean; onRetry: () => void; onSwitch: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ios-empty flex flex-col items-center justify-center py-14 px-8 text-center a-rise" role="alert">
      <div className="w-16 h-16 rounded-(--r-md) tonal flex items-center justify-center mb-4">
        <IRefresh size={26} />
      </div>
      <div className="text-[16px] font-semibold text-on/90">{networkish ? "当前线路连不上" : "加载失败"}</div>
      <p className="text-xs text-mut mt-1.5 leading-relaxed max-w-[34em]">{error}</p>
      <div className="flex items-center gap-2.5 mt-5">
        <Button onClick={onRetry} className="px-5 h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[14px] font-bold pressable">重试</Button>
        <Button onClick={onSwitch} className="px-5 h-10 rounded-(--r-ctl) tonal text-on text-[14px] font-semibold pressable">换个线路</Button>
      </div>
      {raw && (
        <div className="mt-4 w-full max-w-[34em]">
          <button type="button" onClick={() => setOpen(v => !v)}
            className="text-[12px] text-mut underline underline-offset-2 pressable"
            aria-expanded={open}>
            {open ? "收起详情" : "详情"}
          </button>
          {open && <pre className="mt-2 text-left text-[11px] leading-relaxed text-mut whitespace-pre-wrap break-words select-text">{raw}</pre>}
        </div>
      )}
    </div>
  );
}

export default function Home({ active }: { active: boolean; bottomInset?: number }) {
  const { push, lineEpoch, user, history, toast, stack, loginOpen } = useStore();
  const { preferences, storageError, blockReason } = useContentPreferences();
  const [tab, setFeedTab] = useState<TabKey>("all");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [recommendRanks, setRecommendRanks] = useState<RankItem[]>([]);
  const [topRanks, setTopRanks] = useState<RankItem[]>([]);
  const [originals, setOriginals] = useState<VideoCard[]>([]);
  const [topics, setTopics] = useState<TopicCard[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [seedPage, setSeedPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [shuffling, setShuffling] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  /* 错误页要「人话 + 可折叠原文」（G 节）：原文只在这里留着，折叠后才给用户看 */
  const [errorRaw, setErrorRaw] = useState("");
  const [errorNetworkish, setErrorNetworkish] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  /* 当前线路（左上角胶囊只在不是主站时出现） */
  const [lineHost, setLineHost] = useState("");
  /* 官网首页 banners（C 节）：非空时 hero 只按它来，空则回落到原来的口碑榜规则 */
  const [banners, setBanners] = useState<HomeBanner[]>([]);
  const bannersAt = useRef(0);
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroDragX, setHeroDragX] = useState(0);
  const [heroRatios, setHeroRatios] = useState<Record<number, number>>({});
  const heroTouch = useRef<{ x: number; y: number } | null>(null);
  const [continueCard, setContinueCard] = useState<{ detail: Detail; ep: number; t: number; dur: number; at: number } | null>(null);
  const [dismissedContinue, setDismissedContinue] = useState(0);
  const loadingRef = useRef(false);
  const seq = useRef(0);
  const shelvesAt = useRef(0);
  const topicsAt = useRef(0);
  /* 货架 / 专题的请求代次：只让最新那一次写回（换线时旧响应不许盖新、不许刷新时间戳） */
  const shelfSeq = useRef(0);
  const topicSeq = useRef(0);
  const loadedKey = useRef("");
  /* 上一次加载的 feed tab：用来区分「换 tab」（必须重拉）与「只换了线路」（首屏不重跑） */
  const loadedTab = useRef<FeedTab | "">("");
  /* 当前 tab 的首屏（第 1 页、非静默）已经出过内容：换线不再重跑首屏，否则 api_feed 会变成两条 */
  const firstScreenDone = useRef<FeedTab | "">("");
  /* 骨架 → 真实内容的时间点（3.0.20 取证：一行 `[net] first content ms=…` 进 logcat） */
  const firstContentAt = useRef(0);
  /* hero 文字补全只跑一次（阶段二） */
  const detailsAt = useRef(0);
  const aliveRef = useRef(true);
  /* 3.0.22 错误页后台自救：`load` 里只能「触发」，真正的链条在它下面定义（要复用 load） */
  const rescueRef = useRef<(tabKey: FeedTab) => void>(() => {});
  const rescueSeq = useRef(0);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const fresh = useFreshness();
  const [rankSignal, setRankSignal] = useState(0);
  const rankDone = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /* 左右手势切页：只在移动端、首页 feed tab、没有栈页/登录面板时接管 */
  const swipe = useTabSwipe({
    order: TABS.map(t => t.key),
    current: tab,
    onSelect: key => setFeedTab(key as TabKey),
    enabled: isMobile && stack.length === 0 && !loginOpen,
    containerRef: scrollRef,
  });

  /* 把已知的剧名/标签/集数并回 banner：阶段一用首屏 feed 里同 id 的卡片顶，
     阶段二用 `api_home_details` 的补全结果。**只填空缺**，已有值不覆盖 ——
     否则每次下拉刷新 hero 的文字都会先空一下再回来。 */
  const mergeBannerText = useCallback((rows: BannerTextSource[]) => {
    if (!rows.length) return;
    const byId = new Map<number, BannerTextSource>();
    for (const row of rows) {
      const id = row.video_id ?? row.id ?? 0;
      if (id > 0) byId.set(id, row);
    }
    if (!byId.size) return;
    setBanners(prev => {
      let touched = false;
      const next = prev.map(banner => {
        const known = byId.get(banner.video_id);
        if (!known) return banner;
        const title = (banner.title || "").trim() || (known.title || "").trim();
        if (!title) return banner;
        if (title === banner.title && banner.tags?.length && banner.episode_count) return banner;
        touched = true;
        return {
          ...banner,
          title,
          tags: banner.tags?.length ? banner.tags : (known.tags ?? null),
          episode_count: banner.episode_count ?? known.episode_count ?? null,
          total_episodes: banner.total_episodes ?? known.total_episodes ?? null,
          is_finished: banner.is_finished ?? known.is_finished ?? null,
          image_url: banner.image_url || known.cover || "",
        };
      });
      return touched ? next : prev;
    });
  }, []);

  /* `opts.force` = 绕过 api 读缓存打真实请求；`opts.silent` = 不闪骨架/不报错（回前台、切回 tab 用）。
     两个都给 = "后台静默换新"：用户看到的列表不动，数据悄悄变成最新的。 */
  const load = useCallback(async (p: number, key: FeedTab, replaceBatch = false, opts?: { force?: boolean; silent?: boolean }) => {
    const silent = opts?.silent === true;
    const force = opts?.force === true;
    if (loadingRef.current && !force) return;
    /* 3.0.22：用户自己发起的首屏加载（点重试 / 下拉 / 换 tab）要立刻作废后台自救链，
       否则两条链会互相抢「谁能写回界面」。静默加载（自救自己发的）不算。 */
    if (!silent && p === 1) rescueSeq.current += 1;
    loadingRef.current = true;
    if (!silent) setLoading(true);
    if (replaceBatch) setShuffling(true);
    if (!silent) setError("");
    const my = ++seq.current;
    loadedTab.current = key;
    const fetchFeed = (attempt?: { attempt: number; switched: boolean; lastKind: string }) => {
      /* 3.0.22 首枪预算：第一次尝试只给 1.5 秒（被墙线路一秒半露馅），后续按
         `firstScreenBudget` 的规则给；静默刷新 / 第 2 页不带（照常 12 秒）。 */
      const opts = attempt ? { budgetMs: firstScreenBudget(attempt) } : undefined;
      return key === "new" ? api.feed(p, 21, "new", force, opts) : api.feed(p, 21, undefined, force, opts);
    };
    /* 首屏（第 1 页、非静默）失败不再直接停在错误页：换线 + 1s / 3s / 7s 各重试一次，
       三次都失败才让错误页出现（文案与按钮沿用原样）。
       HTTP 4xx/5xx 是站点在回答 —— 换线没用，仍按旧行为直接上错误页。 */
    const firstScreen = p === 1 && !silent;
    try {
      const res = firstScreen
        ? await withLineRetries(fetchFeed, {
            switchLine: (tried, kind) => switchLineForRetry(kind, tried),
            shouldRetry: (error) => {
              const failure = error as ApiError;
              return !!failure?.networkish || !!failure?.failoverTried;
            },
            onRetry: ({ n, delay }) => {
              netLog(`[net] retry n=${n} delay=${delay}`);
              logLine(`[feed] 首屏第 ${n}/3 次重试（${delay}ms 后）`);
            },
          })
        : await fetchFeed();
      if (my !== seq.current) return;
      const rows = (res?.items ?? []).filter(v => v && v.cover);
      const pages = Math.max(1, res?.pagination?.pages || 1);
      setTotalPages(pages);
      setItems(prev => (p === 1 || replaceBatch) ? rows : [...prev, ...rows.filter(r => !prev.some(x => x.id === r.id))]);
      /* 骨架 → 真实内容：一条 logcat 行 + 立刻放开冷启动的 4.5s 请求预算 */
      if (firstScreen && !firstContentAt.current) {
        firstContentAt.current = Math.max(1, Math.round(performance.now()));
        netLog(`[net] first content ms=${firstContentAt.current}`);
        releaseBootBudget();
      }
      if (firstScreen) firstScreenDone.current = key;
      /* hero 的剧名先用首屏 feed 里已有的同名 id 顶上，不等补全（少一次首屏空窗） */
      mergeBannerText(rows);
      /* 首屏预取详情（并发 2、失败静默）：点进去时详情页能直接出内容，不用等镜像 RTT */
      if (p === 1 || replaceBatch) prefetchDetails(rows.slice(0, 4).map(v => v.id));
      setPage(p);
      if (replaceBatch) setSeedPage(p);
      setDone(!rows.length || p >= pages);
      fresh.mark();
      if (silent) setError("");
      if (my === seq.current) { setErrorRaw(""); setErrorNetworkish(false); }
      /* 空闲时预取下一页（滚动到底时命中读缓存，省掉一个来回）：
         首屏 → 第 2 页；每次追加完 → 再下一页。失败无所谓，滚到底还会正常请求。 */
      if (key === "all" && !replaceBatch && p + 1 <= pages) {
        const next = p + 1;
        scheduleIdle(() => { void api.feed(next, 21).catch(() => { /* 预取失败无所谓 */ }); }, 1400);
      }
    } catch (e) {
      if (my === seq.current && !silent) {
        const failure = e as ApiError;
        setError((e as Error)?.message || "加载失败");
        /* G 节：原始错误（tls handshake eof / connection reset…）只进「详情」，默认不展示 */
        setErrorRaw(typeof failure?.raw === "string" ? failure.raw : ((e as Error)?.message || ""));
        setErrorNetworkish(!!failure?.networkish);
        /* 3.0.22 自救：错误页已经出现，但不等用户点「重试」——后台按 1s / 3s / 7s
           再各试一次，每次换一条**还没试过**的候选；成功就把首屏自动换上
           （错误页文案与两个按钮一个都不动，用户随时可以自己点）。 */
        if (firstScreen) rescueRef.current(key);
      }
      if (silent) throw e;
    } finally {
      if (my === seq.current) {
        setLoading(false);
        setShuffling(false);
        loadingRef.current = false;
      }
    }
  }, [fresh, mergeBannerText]);

  /* 3.0.22：错误页出现之后的后台自救（四条根因里的第 4 条）。
     *
     * 真机事实（小米九 / 2026-11-28，清数据冷启 5 次）：4 次全程停在「当前线路连不上」，
     * 60 秒内一次都没自己再试 —— 而同一台机、同一条 WiFi 上 curl 是有镜像能通的。
     * 用户只能自己点「重试」，点了才出内容。
     *
     * 现在的形态：错误页照常出现（文案/按钮不变），后台继续按 1s / 3s / 7s 各试一次，
     * 每次换一条**还没试过**的候选；某一次成功就把首屏自动换上，错误页自己消失。
     * 任何新的首屏加载（用户点重试、下拉刷新、换 tab）都会让这条链立刻作废。 */
  const rescue = useCallback(async (tabKey: FeedTab) => {
    if (!aliveRef.current || firstContentAt.current) return;
    const id = ++rescueSeq.current;
    const tried: string[] = [];
    for (let index = 0; index < FIRST_SCREEN_RETRY_DELAYS.length; index += 1) {
      const delay = FIRST_SCREEN_RETRY_DELAYS[index];
      await new Promise<void>((resolve) => { window.setTimeout(resolve, delay); });
      if (!aliveRef.current || rescueSeq.current !== id) return;
      if (firstContentAt.current) return;
      let host = "";
      try {
        host = await switchLineForRetry("rescue", tried);
      } catch {
        host = "";
      }
      if (host) tried.push(host);
      netLog(`[net] rescue n=${index + 1} delay=${delay} host=${host || "-"}`);
      logLine(`[feed] 错误页后台自救第 ${index + 1}/${FIRST_SCREEN_RETRY_DELAYS.length} 次（${delay}ms 后，换到 ${host || "原线路"}）`);
      try {
        /* 静默加载：不闪骨架、不报错，成功就 item/error 一起被替换 */
        await load(1, tabKey, false, { silent: true });
        if (aliveRef.current && !firstContentAt.current) {
          firstContentAt.current = Math.max(1, Math.round(performance.now()));
          netLog(`[net] first content ms=${firstContentAt.current}`);
          releaseBootBudget();
        }
        return;
      } catch { /* 这一轮也失败：等下一个退避间隔 */ }
    }
    netLog(`[net] rescue exhausted n=${FIRST_SCREEN_RETRY_DELAYS.length}`);
  }, [load]);
  useEffect(() => {
    rescueRef.current = (tabKey) => { void rescue(tabKey); };
  }, [rescue]);

  /* 推荐页专属异构货架数据（官方口碑推荐榜 + 热播榜 TOP10 + 独家原创宽画幅）。
     每次进页/回前台超过 30s 就重拉（force 绕过缓存），不再是"一个线路只拉一次"。
     精选专题不在这里 —— 它在首屏出来之后再取（见下面那个 effect）。 */
  const loadShelves = useCallback(async (force: boolean) => {
    /* 代次：换线 / 连点刷新时可能有两次拉取在飞，旧那次回来不许盖新的，也不许把
       shelvesAt 写成「刚刚」——否则界面上是旧线路的货架，却被当成新鲜数据。 */
    const my = ++shelfSeq.current;
    const [recRanks, hotRanks, origs] = await Promise.all([
      api.rank("recommend", force).then(r => (r?.items ?? []).filter(x => x && x.cover && x.video_id > 0).slice(0, 12)).catch(() => null),
      api.rank("hot", force).then(r => (r?.items ?? []).filter(x => x && x.cover && x.video_id > 0).slice(0, 10)).catch(() => null),
      api.originalVideos("all", 1, 10, "new", force).then(r => (r?.items ?? []).filter(x => x && x.cover && x.id > 0)).catch(() => null),
    ]);
    if (!aliveRef.current || my !== shelfSeq.current) return;
    if (recRanks) setRecommendRanks(recRanks);
    if (hotRanks) setTopRanks(hotRanks);
    if (origs) setOriginals(origs);
    if (recRanks || hotRanks || origs) shelvesAt.current = Date.now();
  }, []);

  /* 官网首页 banners（C 节）：和货架同一档 30s，force 由下拉刷新传入。
     失败就保持空数组 —— hero 会自动回落到原来的口碑榜规则，不额外弹错。 */
  const loadBanners = useCallback(async (force: boolean) => {
    try {
      const res = await api.home(force);
      const rows = (res?.banners ?? []).filter(b => b && b.video_id > 0 && !!b.image_url);
      if (!aliveRef.current) return;
      /* 新列表只有封面和分数（详情补全是阶段二的事）：把已经补到的文字按 video_id 带过来，
         否则每次下拉刷新 hero 都会先掉成无剧名再补回来。 */
      setBanners(prev => {
        const known = new Map(prev.filter(b => (b.title || "").trim()).map(b => [b.video_id, b]));
        return rows.map(banner => {
          const old = known.get(banner.video_id);
          if (!old) return banner;
          return {
            ...banner,
            title: banner.title ?? old.title,
            tags: banner.tags ?? old.tags,
            episode_count: banner.episode_count ?? old.episode_count,
            total_episodes: banner.total_episodes ?? old.total_episodes,
            is_finished: banner.is_finished ?? old.is_finished,
            image_url: banner.image_url || old.image_url,
          };
        });
      });
      bannersAt.current = Date.now();
      if (rows.length) logLine(`[home] banners=${rows.length} order=${rows.map(b => b.video_id).join(",")}`);
    } catch (e) {
      logLine(`[home] banners 拉取失败，回落口碑榜：${(e as Error)?.message ?? e}`);
    }
  }, []);

  /* 精选专题：最底部的一个横滑货架，既不参与主推/热榜的错峰去重，也不参与"为你推荐"的过滤，
     所以晚到不会引起任何重排。放到首屏卡片出来之后再空闲时取，首屏少一个并发请求。 */
  const loadTopics = useCallback(async (force: boolean) => {
    const my = ++topicSeq.current;
    try {
      const r = await api.topics(force);
      if (!aliveRef.current || my !== topicSeq.current) return;
      setTopics((r?.items ?? []).filter(x => x && x.cover).slice(0, 8));
      topicsAt.current = Date.now();
    } catch { /* 专题拉不到就不显示这一栏，不影响其他内容 */ }
  }, []);

  /* 切线路：货架/专题的时间戳与在途请求全部作废，下一次进页强制重拉。
     **不清空 banners**：那只是一份 JSON（封面 + 分数 + 已补到的剧名），换条线路内容一样；
     清空会让 hero 先掉回口碑榜、再重发一遍 api_home + 8 条详情（真机日志里的「详情各 2 条」），
     新线路的 banners 回来后也是原地覆盖，不需要中间那一下空窗。 */
  useEffect(() => {
    shelvesAt.current = 0; topicsAt.current = 0; bannersAt.current = 0; detailsAt.current = 0;
    shelfSeq.current++; topicSeq.current++;
  }, [lineEpoch]);

  /* 阶段一（首屏只等两个请求）：feed 第 1 页（下面那个 effect）＋ 官网 banners（hero 数据源）。
     货架 / 榜位 / 专题都挪到「内容已经出现」之后的阶段二，别和首屏抢带宽和超时预算。 */
  useEffect(() => {
    if (!active || tab !== "all") return;
    if (bannersAt.current && Date.now() - bannersAt.current < FRESH_GAP_MS) return;
    void loadBanners(bannersAt.current > 0);
  }, [active, tab, lineEpoch, loadBanners]);

  /* 阶段二：内容（items）出现之后才补货架 —— 口碑推荐榜 / 热播 TOP10 / 独家原创。
     旧实现和 feed 同时发，首屏一共 4 个请求抢同一条被墙的线路，谁先超时谁决定首屏时间。 */
  useEffect(() => {
    if (!active || tab !== "all" || !items.length) return;
    if (shelvesAt.current && Date.now() - shelvesAt.current < FRESH_GAP_MS) return;
    void loadShelves(shelvesAt.current > 0);
  }, [active, tab, items.length, lineEpoch, loadShelves]);

  /* 阶段二：hero 文字补全（banner 只给封面和分数，剧名 / 标签 / 集数要逐条补）。 */
  useEffect(() => {
    if (!active || tab !== "all" || !items.length) return;
    const missing = banners.filter(b => !(b.title || "").trim()).map(b => b.video_id).slice(0, 10);
    if (!missing.length) return;
    if (detailsAt.current && Date.now() - detailsAt.current < FRESH_GAP_MS) return;
    detailsAt.current = Date.now();
    let alive = true;
    void api.homeDetails(missing)
      .then(res => { if (alive && res?.items?.length) mergeBannerText(res.items); })
      .catch(() => { /* 补不到就保持无剧名：banner 仍有封面和分数，照样可点 */ });
    return () => { alive = false; };
  }, [active, tab, items.length, banners, lineEpoch, mergeBannerText]);

  useEffect(() => {
    if (!active || tab !== "all" || !items.length) return;
    if (topicsAt.current && Date.now() - topicsAt.current < FRESH_GAP_MS) return;
    void loadTopics(topicsAt.current > 0);
  }, [active, tab, items.length, lineEpoch, loadTopics]);

  /* 后台刷新（api 层命中缓存后补的那一次）回来时，货架原地换新，不用等用户重进 */
  useApiRefresh<{ items: RankItem[] }>("api_rank", { kind: "recommend" }, res => {
    if (!res) return;
    setRecommendRanks((res.items ?? []).filter(x => x && x.cover && x.video_id > 0).slice(0, 12));
  });
  useApiRefresh<{ items: RankItem[] }>("api_rank", { kind: "hot" }, res => {
    if (!res) return;
    setTopRanks((res.items ?? []).filter(x => x && x.cover && x.video_id > 0).slice(0, 10));
  });
  useApiRefresh<{ items: TopicCard[] }>("api_topics", undefined, res => {
    if (!res) return;
    setTopics((res.items ?? []).filter(x => x && x.cover).slice(0, 8));
  });

  useEffect(() => {
    if (!active || tab === "rank") return;
    const key = `${tab}|${lineEpoch}`;
    const same = loadedKey.current === key;
    /* 30s 内切回同一个 tab 不重拉（省流量）；超过 30s 或者换了 tab/线路就重新取，
       并且是 force（绕过读缓存）+ silent（不闪骨架）——旧代码这里是"一个 key 只拉一次"，
       所以重进永远是旧列表。lastAt=0 表示还没成功拉过（StrictMode 二次挂载会走到这里），
       此时不做静默重拉，交给下面正常加载，否则会盖掉首屏的错误提示。 */
    if (same && (fresh.lastAt() === 0 || !fresh.olderThan(FRESH_GAP_MS))) return;
    /* 只换了线路（tab 没变）：首屏已经跑过就不跑第二遍。
       - 在途那一条自己会换线重试（api.request 的 failover + 首屏 1s/3s/7s 退避），
         再补一条 api_feed 只会让「首屏」跑两遍（真机日志里 api_feed 2 条就是这么来的）；
       - 已经出内容的那一屏也不清空重拉：数据就在屏幕上，下拉刷新 / 回前台照旧 force 重拉。
       首屏没成功过（没内容、也不在飞）时才允许在这里重来一次 —— 换线后重试是必须的。 */
    const lineOnly = loadedTab.current === tab;
    if (!same && lineOnly && (loadingRef.current || firstScreenDone.current === tab)) return;
    loadedKey.current = key;
    seq.current++;
    loadingRef.current = false;
    if (!same) {
      setShuffling(false);
      setItems([]);
      setSeedPage(1);
      setTotalPages(1);
      setDone(false);
      setHeroIndex(0);
      scrollRef.current?.scrollTo(0, 0);
      void load(1, tab);
    } else {
      void load(1, tab, false, { force: true, silent: true }).catch(() => { /* 静默失败：保留旧列表 */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab, lineEpoch]);

  /* 下拉刷新 / 回前台静默刷新 的统一入口：一律 force 绕过缓存 */
  const refreshAll = useCallback(async () => {
    const jobs: Promise<unknown>[] = [];
    if (tab === "rank") {
      /* 热榜分栏的数据在 RankView 里：发信号让它 force 重拉，等它回话（6s 兜底） */
      jobs.push(new Promise<void>(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        rankDone.current = finish;
        setRankSignal(n => n + 1);
        window.setTimeout(finish, 6000);
      }));
    } else {
      jobs.push(load(1, tab, false, { force: true, silent: true }));
      if (tab === "all") jobs.push(loadShelves(true), loadTopics(true), loadBanners(true));
    }
    await Promise.all(jobs);
    fresh.mark();
  }, [tab, load, loadShelves, loadTopics, loadBanners, fresh]);

  const pull = usePullToRefresh({
    ref: scrollRef,
    onRefresh: refreshAll,
    enabled: isMobile,
    onDone: ok => toast(ok ? "已同步官网" : "同步失败，稍后再试", ok ? "ok" : "info"),
  });

  /* 前台每 5 分钟静默刷新当前 tab（播放页不刷；不可见时跳过） */
  useForegroundRefresh(() => { if (!pull.refreshing) void refreshAll().catch(() => { /* 静默 */ }); }, { enabled: active });

  /* 回前台：距上次拉取 > 30s 就静默重拉当前页（不闪骨架、失败不提示） */
  useVisibilityRefresh(() => { void refreshAll().catch(() => { /* 静默 */ }); }, {
    enabled: active,
    lastAt: fresh.lastAt,
    busy: pull.refreshing,
  });

  /* 继续观看：登录且有最近进度时浮现 */
  useEffect(() => {
    if (!active || !user) { setContinueCard(null); return; }
    const latest = history[0];
    if (!latest || !latest.id) { setContinueCard(null); return; }
    let alive = true;
    api.video(latest.id)
      .then(d => {
        if (!alive) return;
        setContinueCard(d ? { detail: d, ep: latest.ep, t: latest.t, dur: latest.dur, at: latest.at } : null);
      })
      .catch(() => { if (alive) setContinueCard(null); });
    return () => { alive = false; };
  }, [active, user, history]);

  const filterAllowed = useCallback(
    <T extends { tags?: string[] }>(list: T[]) =>
      preferences.paused ? list : list.filter(v => !blockReason(v.tags)),
    [preferences.paused, blockReason],
  );

  const visible = useMemo(() => filterAllowed(items), [items, filterAllowed]);
  const visibleRecRanks = useMemo(() => filterAllowed(recommendRanks), [recommendRanks, filterAllowed]);
  /* 热播风向标 TOP 10 严格保持 100% 原始榜单真实名次，不做任何人为抽调 */
  const visibleRanks = useMemo(() => filterAllowed(topRanks), [topRanks, filterAllowed]);
  const visibleOriginals = useMemo(() => filterAllowed(originals), [originals, filterAllowed]);

  /* 0. 官网主推横幅（C 节，口径已定）：只要有 banners 就用它，**顺序即官网顺序**，
        几条算几条，不和热播榜做任何排重；单条缺标题（详情补全失败）就跳过那一条。
        banners 为空/失败时才回落到下面第 1 段原来的口碑榜规则。 */
  const bannerHeroes = useMemo<HeroSpot[]>(() => banners
    .filter(b => (b.title || "").trim().length > 0)
    .map(b => ({
      id: b.video_id,
      title: (b.title || "").trim(),
      cover: b.image_url,
      tags: Array.isArray(b.tags) ? b.tags.filter(t => typeof t === "string" && t.trim()) : [],
      score: Number(b.score) || 0,
      episode_count: Number(b.episode_count) || 0,
      total_episodes: Number(b.total_episodes) || undefined,
      is_finished: !!b.is_finished,
      kicker: Number(b.score) > 0 ? `官网主推 · ${Number(b.score).toFixed(1)}分` : "官网主推",
    })), [banners]);

  /* 1. 顶部主推优选：优先从源站真实「口碑推荐榜」挑选高分剧，并主动错峰避开下方热播榜前 10 */
  const heroes = useMemo<HeroSpot[]>(() => {
    if (bannerHeroes.length) return bannerHeroes;
    const hotTop10 = new Set(visibleRanks.map(r => r.video_id));
    const hotTop3 = new Set(visibleRanks.slice(0, 3).map(r => r.video_id));
    const picked: HeroSpot[] = [];
    const seen = new Set<number>();

    const toHeroFromRank = (r: RankItem): HeroSpot => ({
      id: r.video_id,
      title: r.title,
      cover: r.cover,
      tags: r.tags || [],
      score: r.score,
      episode_count: r.episode_count,
      is_finished: r.is_finished,
      kicker: `口碑主推${r.score > 0 ? ` · ${r.score.toFixed(1)}分` : r.metric_label ? ` · ${r.metric_label}` : ""}`,
    });

    const toHeroFromVideo = (v: VideoCard): HeroSpot => ({
      id: v.id,
      title: v.title,
      cover: v.cover,
      tags: v.tags || [],
      score: v.score,
      episode_count: v.episode_count,
      total_episodes: v.total_episodes,
      is_finished: v.is_finished,
      kicker: `殿堂主推${v.score > 0 ? ` · ${v.score.toFixed(1)}分` : ""}`,
    });

    for (const r of visibleRecRanks) {
      if (picked.length >= 3) break;
      if (!hotTop10.has(r.video_id) && !seen.has(r.video_id)) {
        seen.add(r.video_id);
        picked.push(toHeroFromRank(r));
      }
    }
    for (const r of visibleRecRanks) {
      if (picked.length >= 3) break;
      if (!hotTop3.has(r.video_id) && !seen.has(r.video_id)) {
        seen.add(r.video_id);
        picked.push(toHeroFromRank(r));
      }
    }
    for (const r of visibleRecRanks) {
      if (picked.length >= 3) break;
      if (!seen.has(r.video_id)) {
        seen.add(r.video_id);
        picked.push(toHeroFromRank(r));
      }
    }
    /* 网络波动兜底：推荐榜为空时从默认流优先选高分/热门且不撞热播前三的剧集 */
    if (picked.length < 3) {
      const highQuality = [...visible].sort((a, b) => (Number(b.is_hot === 1) - Number(a.is_hot === 1)) || ((b.score || 0) - (a.score || 0)));
      for (const v of highQuality) {
        if (picked.length >= 3) break;
        if (!hotTop10.has(v.id) && !seen.has(v.id)) {
          seen.add(v.id);
          picked.push(toHeroFromVideo(v));
        }
      }
      for (const v of visible) {
        if (picked.length >= 3) break;
        if (!seen.has(v.id)) {
          seen.add(v.id);
          picked.push(toHeroFromVideo(v));
        }
      }
    }
    return picked;
  }, [bannerHeroes, visibleRecRanks, visibleRanks, visible]);

  /* 左上角线路胶囊（G 节）：只有当前不在主站时才出现，告诉用户「你现在走的是备用线路」。
     lineEpoch 每次换线都 +1，所以这里顺便在换线后重新读一次。 */
  const backupLine = !!lineHost && !/(^|\.)huangguoai\.com$/i.test(lineHost);
  useEffect(() => {
    let live = true;
    const read = () => {
      api.lineState()
        .then(state => { if (live) setLineHost(hostOf(state.base)); })
        .catch(() => { /* 读不到就不显示胶囊，不影响首屏 */ });
    };
    read();
    window.addEventListener("hg:line-changed", read);
    return () => { live = false; window.removeEventListener("hg:line-changed", read); };
  }, [lineEpoch]);

  const safeHeroIdx = Math.min(heroIndex, Math.max(heroes.length - 1, 0));
  const hero = heroes[safeHeroIdx];

  /* 主推展台自动轮换：只在「推荐」分栏可见、页面在前台时走；手动点圆点/横滑后重新计时
     （依赖里带 safeHeroIdx，任何一次切换都会把定时器重置，不会刚点完就被自动换走）。 */
  useEffect(() => {
    if (!active || tab !== "all" || heroes.length < 2) return undefined;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return undefined;
    const timer = window.setInterval(() => {
      setHeroIndex(prev => (prev + 1) % heroes.length);
    }, HERO_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [active, tab, heroes.length, safeHeroIdx]);

  /* 2. 跨模块级联去重：主推、热播 TOP 10、独家原创展示过的剧集不再重复出现在「为你推荐」 */
  const dedupedOriginals = useMemo(() => {
    const heroIds = new Set(heroes.map(h => h.id));
    const filtered = visibleOriginals.filter(v => !heroIds.has(v.id));
    if (filtered.length >= 4) return filtered.slice(0, 4);
    const ids = new Set(filtered.map(v => v.id));
    const backfill = visibleOriginals.filter(v => !ids.has(v.id)).slice(0, 4 - filtered.length);
    return [...filtered, ...backfill];
  }, [visibleOriginals, heroes]);

  const recommendGrid = useMemo(() => {
    const shownAbove = new Set<number>([
      ...heroes.map(h => h.id),
      ...visibleRanks.map(r => r.video_id),
      ...dedupedOriginals.map(v => v.id),
    ]);
    const filtered = visible.filter(v => !shownAbove.has(v.id));
    if (filtered.length > 0 || visible.length <= heroes.length) return filtered;
    const heroIds = new Set(heroes.map(h => h.id));
    return visible.filter(v => !heroIds.has(v.id));
  }, [visible, heroes, visibleRanks, dedupedOriginals]);

  /* 3. 为你推荐「换一批」：按真实分页池轮换下一批片单，原地平滑替换不跳滚 */
  const rotateRecommend = useCallback(() => {
    if (loadingRef.current) return;
    const cap = Math.max(1, Math.min(totalPages, 15));
    const nextSeed = cap > 1 ? (seedPage % cap) + 1 : 1;
    void load(nextSeed, "all", true);
  }, [load, seedPage, totalPages]);

  /* 上新分栏数据切片：按真实上架时间倒序，前 6 部用杂志横排首发看点卡，其余进入速览网格 */
  const premiereFeatured = useMemo(() => visible.slice(0, 6), [visible]);
  const premiereRest = useMemo(() => visible.slice(6), [visible]);
  const finishedInNew = useMemo(() => visible.filter(v => v.is_finished).length, [visible]);

  const continueShown = !!(user && continueCard && continueCard.at !== dismissedContinue);
  const continuePct = continueShown && continueCard && continueCard.dur > 0
    ? Math.max(1, Math.min(100, Math.round((continueCard.t / continueCard.dur) * 100))) : 0;

  const openSeries = (id: number) => push({ kind: "series", id });
  const play = (id: number, ep = 1, startTime?: number) => push({
    kind: "feed", videoIds: [id], index: 0, title: "", startEp: ep,
    startTime: startTime && startTime > 0 ? startTime : undefined,
  });
  const startSwipeIds = (ids: number[], startIdx = 0, title = "推荐连刷", endless = false) => {
    const unique: number[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (id > 0 && !seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    if (!unique.length) {
      toast(loading ? "内容加载中，请稍候" : "暂无可连刷内容", "info");
      return;
    }
    push({
      kind: "feed",
      videoIds: unique,
      index: Math.max(0, Math.min(startIdx, unique.length - 1)),
      title,
      endless,
    });
  };
  const startSwipeFeed = (list: VideoCard[], startIdx = 0, title = "推荐连刷") =>
    startSwipeIds(list.map(v => v.id), startIdx, title);

  return (
    <div className="ios-page hg-home-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />

      {/* 一级大字重流光顶栏：品牌徽标 + 推荐/上新/热榜 大字排版 + 全局搜索（省掉整排胶囊栏） */}
      <header className="shrink-0 hg-page-x hg-editorial-bar relative z-10">
        <Logo size={23} className="shrink-0 mr-1" />
        {backupLine && (
          <Button card className="hg-line-chip" onClick={() => setLineOpen(true)}
            aria-label={`当前走备用线路 ${lineHost}，点按切换`} title={lineHost}>
            <span className="hg-line-chip-dot" aria-hidden="true" />
            <span className="hg-line-chip-text">{lineHost}</span>
          </Button>
        )}
        <div className="hg-ed-tabs" role="tablist" aria-label="首页分栏">
          {TABS.map(t => (
            <Button key={t.key} card role="tab" aria-selected={t.key === tab}
              className="hg-ed-tab"
              onClick={() => setFeedTab(t.key)}>
              {t.label}
            </Button>
          ))}
        </div>
        <Button card className="hg-binge-pill" aria-label="打开抖音模式" role="button"
          onClick={() => {
            /* 入口自证：真机取证时按「我的 · 播放诊断」看这条日志，确认点击真的进来了 */
            logLine("[binge] 首页入口点击 → push 刷剧流");
            push({ kind: "feed", videoIds: [], index: 0, title: "抖音模式", endless: true });
          }}>
          {/* 不用 emoji：字体差异会让⚡在各机型渲染成不同宽度。内联 14×14 描边闪电，纯白 1.8。 */}
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff"
            strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M13.2 2.2 4.4 13.1h5.1l-1.4 8.7 8.8-10.9h-5.1z" />
          </svg>
          <span>抖音模式</span>
        </Button>
        <Button card className="hg-sub-btn" aria-label="搜索" onClick={() => push({ kind: "search", initialTab: "video" })}>
          <ISearch size={18} />
        </Button>
      </header>

      <div ref={scrollRef} className="flex-1 scroll-y hg-page-x relative z-10"
        style={{ paddingBottom: `calc(${continueShown ? 162 : 72}px + var(--sab, 0px))`, touchAction: swipe.touchAction }}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}
        onScroll={(e) => {
          if (tab === "rank" || loading || done || error) return;
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 360) void load(page + 1, tab);
        }}>
        <PullIndicator pull={pull.pull} refreshing={pull.refreshing} progress={pull.progress} />
        {storageError && <PreferenceStorageNotice />}

        {/* ==================== 分栏 ③：热榜（三联领奖台 + 热度条榜单） ==================== */}
        {tab === "rank" ? (
          <div className="pt-1.5">
            <Suspense fallback={<div className="flex justify-center py-10"><Loader className="w-7 h-7 spinner" /></div>}>
              <RankView wide={false} active={active} refreshSignal={rankSignal}
                onRefreshed={() => { rankDone.current?.(); rankDone.current = null; }} />
            </Suspense>
          </div>
        ) : tab === "new" ? (
          /* ==================== 分栏 ②：上新（零轮播！时间轴杂志首发流） ==================== */
          <div className="pt-1">
            {!items.length && loading && <div className="flex justify-center py-12"><Loader className="w-7 h-7 spinner" /></div>}
            {!items.length && !loading && error && (
              <FeedError error={error} raw={errorRaw} networkish={errorNetworkish}
                onRetry={() => void load(1, "new")} onSwitch={() => setLineOpen(true)} />
            )}
            {!items.length && !loading && !error && done && (
              <Empty icon={<ISearch size={26} />} title="暂无新片" sub="稍后刷新试试" action="刷新" onAction={() => void load(1, "new")} />
            )}

            {visible.length > 0 && (
              <>
                {/* 首发统计横幅 + 一键连刷上新 */}
                <div className="hg-drop-banner a-rise">
                  <div className="min-w-0">
                    <div className="hg-drop-title">新片速递 · 每日鲜看</div>
                    <div className="hg-drop-sub">
                      已加载 {visible.length} 部新上架剧集{finishedInNew > 0 ? ` · ${finishedInNew} 部已完结可一口气追完` : ""}
                    </div>
                  </div>
                  <Button card className="hg-quick-action" onClick={() => startSwipeFeed(visible, 0, "新片连刷")}>
                    <IBoltF size={13} /><span>连刷上新</span>
                  </Button>
                </div>

                {/* 时间轴第一段：重点新剧杂志横排看点卡（按真实上架时间倒序，避免与热度 TOP 榜混淆） */}
                <div className="hg-timeline-head">
                  <span className="hg-timeline-dot" aria-hidden="true" />
                  <h2 className="hg-timeline-label">首发看点 · 刚上架新剧</h2>
                  <span className="hg-timeline-line" aria-hidden="true" />
                  <span className="hg-timeline-count">首发 {premiereFeatured.length} 部</span>
                </div>

                <div className="hg-premiere-list">
                  {premiereFeatured.map((v, idx) => (
                    <article key={v.id} className="hg-premiere-card pressable a-rise" onClick={() => openSeries(v.id)}>
                      <div className="hg-premiere-art">
                        <Img src={v.cover} eager={idx < 2} alt="" />
                        <span className="hg-premiere-ep">
                          {v.is_finished ? `全 ${v.episode_count || v.total_episodes || "?"} 集` : `更至 ${v.episode_count || "?"} 集`}
                        </span>
                      </div>
                      <div className="hg-premiere-body">
                        <div>
                          <div className="hg-premiere-meta-top">
                            <span>{releaseLabel(v)}</span>
                            {v.score > 0 && <span>· ★ {v.score.toFixed(1)}</span>}
                            {v.is_hot === 1 && <span>· 热门</span>}
                            {v.is_original === 1 && <span>· 原创</span>}
                            {v.hot > 0 && <span>· ▶ {fmt(v.hot)}</span>}
                          </div>
                          <h3 className="hg-premiere-title">{v.title}</h3>
                          <p className="hg-premiere-desc">
                            {v.description?.trim()
                              || (v.tags?.length
                                ? `主打${v.tags.slice(0, 3).join("、")}题材，${v.is_finished ? "全集已完结，适合一口气追完。" : `高能连载中，已更新 ${v.episode_count || 1} 集。`}`
                                : `${v.is_finished ? "全集已完结" : `更新至 ${v.episode_count || 1} 集`} · 热度 ${fmt(v.hot)}`)}
                          </p>
                        </div>
                        <div className="hg-premiere-foot">
                          <div className="hg-premiere-tags">
                            {(v.tags || []).slice(0, 3).map(tag => (
                              <span key={tag} role="button" tabIndex={0}
                                onClick={e => { e.stopPropagation(); push({ kind: "tag", tag, name: tag }); }}
                                onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); push({ kind: "tag", tag, name: tag }); } }}>
                                #{tag}
                              </span>
                            ))}
                          </div>
                          <button type="button" className="hg-premiere-play"
                            aria-label={`播放 ${v.title}`}
                            onClick={e => { e.stopPropagation(); play(v.id); }}>
                            <IPlayF size={11} />追剧
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>

                {/* 时间轴第二段：近期新片速览网格 */}
                {premiereRest.length > 0 && (
                  <section className="hg-section">
                    <div className="hg-timeline-head">
                      <span className="hg-timeline-dot" style={{ background: "#7C5CFF", boxShadow: "0 0 10px rgba(124,92,255,.7)" }} aria-hidden="true" />
                      <h2 className="hg-timeline-label" style={{ color: "#E2E8F0" }}>近期新片速览</h2>
                      <span className="hg-timeline-line" aria-hidden="true" />
                      <span className="hg-timeline-count">{premiereRest.length} 部</span>
                    </div>
                    <div className="hg-grid-c3">
                      {premiereRest.map(v => (
                        <Button key={v.id} className="hg-poster is-c3" onClick={() => openSeries(v.id)}>
                          <span className="hg-poster-art">
                            <Img src={v.cover} alt="" />
                            <span className="hg-poster-veil" aria-hidden="true" />
                            <span className="hg-poster-badge">上新</span>
                            <span className="hg-poster-views">{releaseLabel(v).replace(" 上新", "")}</span>
                          </span>
                          <span className="hg-poster-name">{v.title}</span>
                          <span className="hg-poster-meta">{v.is_finished ? "全集完结" : `更至 ${v.episode_count ?? "?"} 集`}</span>
                        </Button>
                      ))}
                    </div>
                  </section>
                )}

                {!done && visible.length > 0 && (
                  <p className="hg-list-end">{loading ? "正在加载更多新片…" : "上滑自动加载更多"}</p>
                )}
                {done && visible.length > 0 && (
                  <p className="hg-list-end">已经到底了 · 共 {visible.length} 部</p>
                )}
              </>
            )}
          </div>
        ) : (
          /* ==================== 分栏 ①：推荐（影院主推 + 异构策展货架） ==================== */
          <>
            {!items.length && loading && <div className="flex justify-center py-12"><Loader className="w-7 h-7 spinner" /></div>}
            {!items.length && !loading && error && (
              <FeedError error={error} raw={errorRaw} networkish={errorNetworkish}
                onRetry={() => void load(1, "all")} onSwitch={() => setLineOpen(true)} />
            )}
            {!items.length && !loading && !error && done && (
              <Empty icon={<ISearch size={26} />} title="暂无视频" sub="稍后刷新试试" action="刷新" onAction={() => void load(1, "all")} />
            )}

            {/* 1. 影院级单主推展台（平滑横滑轮播 + 错峰避重 + 一键直达播放） */}
            {hero && (
              <div
                className="hg-spotlight-shell a-rise"
                onTouchStart={e => {
                  const t = e.touches[0];
                  if (t) {
                    heroTouch.current = { x: t.clientX, y: t.clientY };
                    setHeroDragX(0);
                  }
                }}
                onTouchMove={e => {
                  const start = heroTouch.current;
                  const t = e.touches[0];
                  if (!start || !t || heroes.length < 2) return;
                  const dx = t.clientX - start.x;
                  const dy = t.clientY - start.y;
                  if (Math.abs(dy) > Math.abs(dx) * 1.35 && Math.abs(dy) > 10) {
                    heroTouch.current = null;
                    setHeroDragX(0);
                    return;
                  }
                  if (Math.abs(dx) > Math.abs(dy) * 1.15 && Math.abs(dx) > 8) {
                    setHeroDragX(Math.max(-120, Math.min(120, dx * 0.48)));
                  }
                }}
                onTouchEnd={e => {
                  const start = heroTouch.current;
                  const t = e.changedTouches[0];
                  heroTouch.current = null;
                  setHeroDragX(0);
                  if (!start || !t || heroes.length < 2) return;
                  const dx = t.clientX - start.x;
                  const dy = t.clientY - start.y;
                  if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
                  setHeroIndex(() => (safeHeroIdx + (dx < 0 ? 1 : heroes.length - 1)) % heroes.length);
                }}
                onTouchCancel={() => { heroTouch.current = null; setHeroDragX(0); }}
              >
                <div className="hg-spotlight-viewport" style={(() => {
                  const usingBanners = bannerHeroes.length > 0;
                  const measured = hero ? heroRatios[hero.id] : undefined;
                  /* 官网宽幅 banner 允许 40%–64%（约 2.5:1 到 16:10），默认 56.25%（16:9）；
                     回落竖版封面固定 64% 并偏上对齐，防止人物头部被裁切。 */
                  const ratio = usingBanners
                    ? (measured ? Math.max(0.4, Math.min(0.64, measured)) : 0.5625)
                    : 0.64;
                  const ratioLg = usingBanners
                    ? (measured ? Math.max(0.34, Math.min(0.48, measured)) : 0.42)
                    : 0.38;
                  return {
                    "--hg-hero-ratio": `${(ratio * 100).toFixed(2)}%`,
                    "--hg-hero-ratio-lg": `${(ratioLg * 100).toFixed(2)}%`,
                  } as CSSProperties;
                })()}>
                  <div
                    className={`hg-spotlight-track${heroDragX !== 0 ? " is-dragging" : ""}`}
                    style={{ transform: `translate3d(calc(${-safeHeroIdx * 100}% + ${heroDragX}px), 0, 0)` }}
                  >
                    {heroes.map((h, i) => {
                      const measured = heroRatios[h.id];
                      const isPortrait = measured !== undefined ? measured > 0.85 : bannerHeroes.length === 0;
                      return (
                      <div key={h.id} className="hg-spotlight-slide" data-active={String(i === safeHeroIdx)}>
                        <Button card className={`hg-spotlight${isPortrait ? " is-portrait" : ""}`} aria-label={`${h.title} 详情`}
                          tabIndex={i === safeHeroIdx ? 0 : -1}
                          onClick={() => openSeries(h.id)}>
                          <Img src={h.cover} eager alt="" onDimensions={(w, ht) => {
                            const r = ht / w;
                            setHeroRatios(prev => (prev[h.id] && Math.abs(prev[h.id] - r) < 0.01 ? prev : { ...prev, [h.id]: r }));
                          }} />
                          <span className="hg-spotlight-veil" aria-hidden="true" />
                          <span className="hg-spotlight-top">
                            <span className="hg-spotlight-kicker">
                              <IFireF size={12} />
                              <span>{h.kicker}</span>
                            </span>
                          </span>
                          <span className="hg-spotlight-body">
                            <span className="hg-spotlight-info">
                              <span className="hg-spotlight-title">{h.title}</span>
                              <span className="hg-spotlight-sub">
                                {h.tags?.length ? h.tags.slice(0, 3).join(" · ") : "精选剧集"}
                                {" · "}
                                {h.is_finished ? `全 ${h.episode_count || h.total_episodes || "?"} 集` : `更新至 ${h.episode_count ?? "?"} 集`}
                              </span>
                            </span>
                          </span>
                        </Button>
                        <Button card className="hg-spotlight-cta" tabIndex={i === safeHeroIdx ? 0 : -1}
                          onClick={() => play(h.id)}>
                          <IPlayF size={12} />播放
                        </Button>
                      </div>
                      );
                    })}
                  </div>
                </div>
                {heroes.length > 1 && (
                  <div className="hg-spotlight-bars" role="tablist" aria-label="精选焦点切换">
                    {heroes.map((h, i) => (
                      <button key={h.id} type="button" role="tab"
                        className="hg-spotlight-bar"
                        data-on={String(i === safeHeroIdx)}
                        aria-selected={i === safeHeroIdx}
                        aria-label={`焦点推荐 ${i + 1}: ${h.title}`}
                        onClick={() => setHeroIndex(i)} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 2. 热播风向标 TOP 10（空心大号描边数字横滑榜：100% 原始热播榜真名次） */}
            {visibleRanks.length > 0 && (
              <section className="hg-section">
                <div className="hg-section-head">
                  <h2 className="hg-section-title">热播风向标</h2>
                  <Button className="hg-section-more" onClick={() => setFeedTab("rank")}>完整榜单<IChevR size={11} /></Button>
                </div>
                <div className="hg-top10-rail">
                  {visibleRanks.map((r, idx) => {
                    const rankNum = r.rank || idx + 1;
                    return (
                      <Button key={`${r.video_id}-${rankNum}`} card className="hg-top10-card"
                        onClick={() => openSeries(r.video_id)}>
                        <span className="hg-top10-art">
                          {/* 首屏第一屏能看到的就前三张：给高优先级，其余仍 lazy */}
                          <Img src={r.cover} alt="" eager={idx < 3} />
                          {r.metric_value > 0 && (
                            <span className="hg-top10-heat">{r.metric_label || "热度"} {fmt(r.metric_value)}</span>
                          )}
                        </span>
                        <span className={`hg-top10-num${rankNum <= 3 ? " is-top3" : ""}`} aria-hidden="true">
                          {String(rankNum).padStart(2, "0")}
                        </span>
                        <span className="hg-top10-title">{r.title}</span>
                      </Button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* 3. 独家原创 · 16:10 宽画幅双列剧照（跨模块去重，打破满屏竖版疲劳） */}
            {dedupedOriginals.length > 0 && (
              <section className="hg-section">
                <div className="hg-section-head">
                  <h2 className="hg-section-title">独家原创 · 宽画幅精选</h2>
                  <Button className="hg-section-more" onClick={() => push({ kind: "channel", cate: "original", name: "独家原创" })}>
                    全部原创<IChevR size={11} />
                  </Button>
                </div>
                <div className="hg-wide-grid">
                  {dedupedOriginals.map(v => (
                    <Button key={v.id} card className="hg-wide-card" onClick={() => openSeries(v.id)}>
                      <span className="hg-wide-art">
                        <Img src={v.cover} alt="" />
                        <span className="hg-wide-badge">原创</span>
                        <span className="hg-wide-ep">{v.is_finished ? "已完结" : `更至 ${v.episode_count ?? "?"} 集`}</span>
                      </span>
                      <span className="hg-wide-copy">
                        <span className="hg-wide-title">{v.title}</span>
                        <span className="hg-wide-sub">
                          {v.tags?.length ? v.tags.slice(0, 2).join(" · ") : "官方自制精品"} · ▶ {fmt(v.hot)}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              </section>
            )}

            {/* 4. 精选专题企划横滑 */}
            {topics.length > 0 && (
              <section className="hg-section">
                <div className="hg-section-head">
                  <h2 className="hg-section-title">策展专题</h2>
                  <Button className="hg-section-more" onClick={() => push({ kind: "topics" })}>全部专题<IChevR size={11} /></Button>
                </div>
                <div className="hg-topic-rail">
                  {topics.map(t => (
                    <Button key={t.id} card className="hg-topic-mini"
                      onClick={() => push({ kind: "topic", slug: t.slug, name: t.title })}>
                      <span className="hg-topic-mini-art">
                        <Img src={t.cover} alt="" />
                        <span className="hg-topic-mini-veil" aria-hidden="true" />
                        <span className="hg-topic-mini-copy">
                          <span className="hg-topic-mini-cnt">{t.video_count ?? 0} 部片单</span>
                          <span className="hg-topic-mini-title">{t.title}</span>
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              </section>
            )}

            {/* 5. 为你推荐海报流（已剔除上方主推与原创重复剧集，支持一键「换一批」淘片） */}
            <section className="hg-section">
              <div className="hg-section-head">
                <h2 className="hg-section-title">为你推荐</h2>
                <div className="hg-section-actions">
                  {visible.length > 0 && (
                    <Button card className="hg-shuffle-btn" aria-label="换一批推荐" aria-busy={shuffling}
                      disabled={loading} onClick={rotateRecommend}>
                      <IRefresh size={12} /><span>{shuffling ? "换片中" : "换一批"}</span>
                    </Button>
                  )}
                </div>
              </div>
              <div className="hg-grid-c3">
                {recommendGrid.map(v => (
                  <Button key={v.id} className="hg-poster is-c3" onClick={() => openSeries(v.id)}>
                    <span className="hg-poster-art">
                      <Img src={v.cover} alt="" />
                      <span className="hg-poster-veil" aria-hidden="true" />
                      {v.is_hot === 1
                        ? <span className="hg-poster-badge is-hot">热门</span>
                        : isNew(v) ? <span className="hg-poster-badge">上新</span>
                        : v.is_original === 1 ? <span className="hg-poster-badge is-orig">原创</span> : null}
                      <span className="hg-poster-views">▶ {fmt(v.hot)}</span>
                    </span>
                    <span className="hg-poster-name">{v.title}</span>
                    <span className="hg-poster-meta">
                      {v.tags?.[0] ? `${v.tags[0]} · ` : ""}{v.is_finished ? "全集" : `${v.episode_count ?? "?"} 集`}
                    </span>
                  </Button>
                ))}
              </div>
              {!done && recommendGrid.length > 0 && (
                <p className="hg-list-end">{loading ? "正在加载更多…" : "上滑自动加载更多"}</p>
              )}
              {done && recommendGrid.length > 0 && (
                <p className="hg-list-end">已经到底了 · 共 {recommendGrid.length} 部</p>
              )}
            </section>
          </>
        )}
      </div>

      {/* 继续观看悬浮卡 */}
      {continueShown && continueCard && (
        <div className="hg-continue">
          <span className="hg-continue-art"><Img src={continueCard.detail.cover} alt="" /></span>
          <span className="hg-continue-copy">
            <span className="hg-continue-title">{continueCard.detail.title}</span>
            <span className="hg-continue-sub">
              看到第 {continueCard.ep} 集
              {continueCard.detail.episode_count ? ` / 共 ${continueCard.detail.episode_count} 集` : ""}
              {continuePct ? ` · ${continuePct}%` : ""}
            </span>
          </span>
          <Button card className="hg-continue-play" aria-label={`继续播放第 ${continueCard.ep} 集`}
            onClick={() => play(continueCard.detail.id, continueCard.ep, continueCard.t)}><IPlayF size={16} /></Button>
          <Button card className="hg-continue-close" aria-label="隐藏继续观看"
            onClick={() => setDismissedContinue(continueCard.at)}><IClose size={10} /></Button>
          {continuePct > 0 && <span className="hg-continue-fill" style={{ width: `${continuePct}%` }} aria-hidden="true" />}
        </div>
      )}

      {/* 播放源面板：首页线路胶囊与错误页的「换个线路」都走这里，切完 reload 由 lineEpoch 驱动 */}
      <LinePicker open={lineOpen} onClose={() => setLineOpen(false)} />
    </div>
  );
}
