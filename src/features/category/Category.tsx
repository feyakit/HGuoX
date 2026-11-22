import { Button, SegmentedControl } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { prefetchDetails } from "../../shared/api/detailFast";
import { api, fmt, isMobile } from "../../shared/api/api";
import type { VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { Masonry } from "../../shared/ui/cards";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { InplaceSearch } from "../search/InplaceSearch";
import { Empty, Img } from "../../shared/ui/ui";
import { useTabSwipe } from "../../shared/lib/useTabSwipe";
import { IBack, IClapper, IClose, IGrid, IRefresh, ISearch, ISparkF, IStarsF } from "../../shared/ui/icons";
import { TagsSection, TopicsSection } from "../discover/Discover";
import { FRESH_GAP_MS, useApiRefresh, useForegroundRefresh, useFreshness, useVisibilityRefresh } from "../../shared/lib/dataFreshness";
import { PullIndicator, usePullToRefresh } from "../../shared/lib/usePullToRefresh";

export const CHANNELS = [
  { cate: "ai-duanju", name: "AI成人短剧", desc: "高能反转 · 一口气看完" },
  { cate: "ai-manju", name: "AI成人漫剧", desc: "国创漫剧 · 每周更新" },
  { cate: "original", name: "原创", desc: "原创 · 独家好剧" },
] as const;

type CategoryView = "" | "ai-duanju" | "ai-manju" | "original" | "topics" | "tags";

const BENTO_TILES = [
  { key: "ai-duanju" as const, label: "AI 短剧", desc: "高能反转连看", cls: "is-duanju", Icon: IClapper },
  { key: "ai-manju" as const, label: "AI 漫剧", desc: "国创漫改热更", cls: "is-manju", Icon: IStarsF },
  { key: "original" as const, label: "独家原创", desc: "自制精品出品", cls: "is-orig", Icon: ISparkF },
  { key: "topics" as const, label: "精选专题", desc: "策展主题片单", cls: "is-topic", Icon: IGrid },
];

const SCOPE_LABELS: Record<CategoryView, string> = {
  "": "全部片库",
  "ai-duanju": "AI 短剧",
  "ai-manju": "AI 漫剧",
  original: "独家原创",
  topics: "精选专题",
  tags: "细分标签库",
};

const ALL_SORTS = [
  { key: "all", label: "全部" },
  { key: "new", label: "最新上线" },
] as const;

const CHANNEL_SORTS = [
  { value: "latest", label: "最近更新" },
  { value: "hot_window", label: "当前热播" },
  { value: "random", label: "精选推荐" },
] as const;

const ORIGINAL_CATES = [
  { value: "all", label: "全部原创" },
  { value: "ai-duanju", label: "短剧" },
  { value: "ai-manju", label: "漫剧" },
] as const;

const CHANNEL_ORIGINAL_CATES = [
  { value: "all", label: "全部原创" },
  { value: "ai-duanju", label: "原创短剧" },
  { value: "ai-manju", label: "原创漫剧" },
] as const;

const originalSort = (cate: "all" | "ai-duanju" | "ai-manju") =>
  cate === "all" ? "new" : "latest";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const parseTs = (raw?: string | number) => {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number") return raw > 1e12 ? raw : raw * 1000;
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  return Date.parse(s.replace(" ", "T"));
};
const isNew = (v: VideoCard) => {
  const ts = [parseTs(v.last_ep_at), parseTs(v.new_at), parseTs(v.created_at)].filter(Number.isFinite);
  if (!ts.length) return false;
  return Date.now() - Math.max(...ts) < WEEK_MS;
};

/* ================= 分类（片库：2×2 Bento 玻璃磁贴 + 紧凑内联筛选） ================= */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, toast, lineEpoch } = useStore();
  const fresh = useFreshness();
  const [view, setView] = useState<CategoryView>("");
  /* 频道筛选行右缘可见性：只剩 3 个 chip，通常放得下；一旦放不下（大字体/窄屏）
     就在右缘做渐隐提示，而不是把最后一个 chip 硬裁成「精选推…」（报告 v3.0.5-02）。 */
  const sortsRef = useRef<HTMLDivElement>(null);
  const [sortsFade, setSortsFade] = useState(false);
  const [allSort, setAllSort] = useState<(typeof ALL_SORTS)[number]["key"]>("all");
  const [chanSort, setChanSort] = useState<(typeof CHANNEL_SORTS)[number]["value"]>("latest");
  const [origCate, setOrigCate] = useState<(typeof ORIGINAL_CATES)[number]["value"]>("all");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const loadingRef = useRef(false);
  const seq = useRef(0);
  const loadedKey = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const isCollectionView = view === "topics" || view === "tags";
  const subKey = view === "" ? allSort : view === "original" ? origCate : chanSort;

  const load = useCallback(async (p: number, opts?: { force?: boolean; silent?: boolean }) => {
    const force = opts?.force === true;
    const silent = opts?.silent === true;
    if (isCollectionView || (loadingRef.current && !force)) return;
    loadingRef.current = true;
    if (!silent) setLoading(true);
    if (!silent) setErr("");
    const my = ++seq.current;
    try {
      const res = view === "original"
        ? await api.originalVideos(origCate, p, 24, originalSort(origCate), force)
        : view === "ai-duanju" || view === "ai-manju"
          ? await api.category(view, p, 24, chanSort, force)
          : await api.feed(p, 24, allSort === "new" ? "new" : undefined, force);
      if (my !== seq.current) return;
      const rows = (res?.items ?? []).filter(v => v && v.cover);
      const pages = Math.max(1, res?.pagination?.pages || 1);
      setItems(prev => p === 1 ? rows : [...prev, ...rows.filter(r => !prev.some(x => x.id === r.id))]);
      if (p === 1) prefetchDetails(rows.slice(0, 4).map(v => v.id));
      setPage(p);
      setDone(!rows.length || p >= pages);
      fresh.mark();
    } catch (e) {
      if (my === seq.current && !silent) setErr((e as Error)?.message || "加载失败");
      if (silent) throw e;
    } finally {
      if (my === seq.current) {
        setLoading(false);
        loadingRef.current = false;
      }
    }
  }, [view, allSort, chanSort, origCate, isCollectionView, fresh]);

  useEffect(() => {
    if (!active || isCollectionView) return;
    const key = `${view}|${subKey}|${lineEpoch}`;
    const same = loadedKey.current === key;
    /* 30s 内切回同一个筛选不重拉；超过 30s / 换筛选 / 换线路 → force 重拉（旧代码一个 key 只拉一次） */
    if (same && (fresh.lastAt() === 0 || !fresh.olderThan(FRESH_GAP_MS))) return;
    loadedKey.current = key;
    seq.current++;
    loadingRef.current = false;
    if (!same) {
      setItems([]);
      setDone(false);
      scrollRef.current?.scrollTo(0, 0);
      void load(1);
    } else {
      void load(1, { force: true, silent: true }).catch(() => { /* 静默失败：保留旧列表 */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, view, subKey, lineEpoch, isCollectionView]);

  const pull = usePullToRefresh({
    ref: scrollRef,
    onRefresh: async () => { await load(1, { force: true, silent: true }); },
    enabled: isMobile && !isCollectionView,
    onDone: ok => toast(ok ? "已同步官网" : "同步失败，稍后再试", ok ? "ok" : "info"),
  });

  /* 前台每 5 分钟静默刷新当前筛选 */
  useForegroundRefresh(() => { void load(1, { force: true, silent: true }).catch(() => { /* 静默 */ }); },
    { enabled: active && !isCollectionView });

  useVisibilityRefresh(() => { void load(1, { force: true, silent: true }).catch(() => { /* 静默 */ }); }, {
    enabled: active && !isCollectionView,
    lastAt: fresh.lastAt,
    busy: pull.refreshing,
  });

  /* 命中缓存后 api 层补的那次真实请求回来时，列表原地换新 */
  useApiRefresh<{ items: VideoCard[] }>(
    view === "original" ? "api_original_videos" : view === "" ? "api_feed" : "api_category",
    view === "original"
      ? { cate: origCate, page: 1, size: 24, sort: originalSort(origCate) }
      : view === ""
        ? { page: 1, size: 24, sort: allSort === "new" ? "new" : null }
        : { cate: view, page: 1, size: 24, sort: chanSort },
    res => {
      const rows = (res?.items ?? []).filter(v => v && v.cover);
      if (rows.length) setItems(rows);
    },
  );

  useEffect(() => {
    const el = sortsRef.current;
    if (!el) return;
    const update = () => setSortsFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 2);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [view]);

  const toggleTile = (target: CategoryView) => {
    setView(current => (current === target ? "" : target));
  };

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <h1 className="sr-only">分类</h1>

      {/* 顶部栏：全局搜索入口 + 右侧真正的 #标签库 开关 */}
      <header className="shrink-0 hg-page-x pb-2 flex items-center gap-2 relative z-10"
        style={{ paddingTop: "calc(var(--sat, 0px) + 8px)" }}>
        <Button className="hg-searchbar flex-1 min-w-0" aria-label="搜索" onClick={() => push({ kind: "search", initialTab: "video" })}>
          {/* 真因是系统字体被放大（font_scale≈1.4 ⇒ 文本宽 ×1.4），不是屏幕窄：
              13 字版在 393dp@1.4 要 260px、只有 205px；换成半角分隔符的 8 个有效字
              （全角「、」每个占 1em，换成「/」能省 ~28px）后 393dp@1.4 还有 32px 余量
              （报告 v3.0.5-04，实测见 v306-fix-report.md 第四节）。 */}
          <ISearch size={16} /><span className="truncate">搜索短剧/漫剧/演员</span>
        </Button>
        <Button card aria-label="打开细分标签库"
          className="hg-tag-pill"
          style={{ minHeight: 44, borderRadius: 12, padding: "0 12px" }}
          onClick={() => push({ kind: "tags" })}>
          <span className="hg-tag-hash">#</span><span>标签库</span>
        </Button>
      </header>

      <div ref={scrollRef} className="flex-1 scroll-y hg-page-x relative z-10"
        style={{ paddingBottom: "calc(110px + var(--sab, 0px))" }}
        onScroll={(e) => {
          if (isCollectionView || loading || done || err) return;
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 360) void load(page + 1);
        }}>

        <PullIndicator pull={pull.pull} refreshing={pull.refreshing} progress={pull.progress} />

        {/* 2×2 Bento 玻璃色彩磁贴阵：替代旧版 6 连胶囊墙，再次点击即可回到全部片库 */}
        <div className="hg-bento-grid" role="tablist" aria-label="频道板块">
          {BENTO_TILES.map(({ key, label, desc, cls, Icon }) => {
            const selected = view === key;
            return (
              <Button key={key} card role="tab" aria-selected={selected}
                className={`hg-bento-tile ${cls}`}
                onClick={() => toggleTile(key)}>
                <span className="hg-bento-icon"><Icon size={18} /></span>
                <span className="hg-bento-copy">
                  <span className="hg-bento-name">{label}</span>
                  <span className="hg-bento-desc">{desc}</span>
                </span>
              </Button>
            );
          })}
        </div>

        {/* 单行标题与紧凑排序栏 */}
        <div className="hg-cat-toolbar mt-1">
          <div className="hg-cat-scope">
            <span>{SCOPE_LABELS[view]}</span>
            {view !== "" && (
              <Button card className="hg-tag-pill" style={{ minHeight: 24, padding: "2px 8px", fontSize: 11 }}
                aria-label="返回全部片库"
                onClick={() => setView("")}>
                <span>全部</span><IClose size={11} />
              </Button>
            )}
          </div>

          {!isCollectionView && (
            <div ref={sortsRef} className="hg-inline-sorts" data-fade={sortsFade ? "1" : undefined} role="tablist" aria-label="频道排序">
              {view === "" && ALL_SORTS.map(s => (
                <Button key={s.key} card role="tab" aria-selected={allSort === s.key}
                  className="hg-inline-sort"
                  onClick={() => setAllSort(s.key)}>
                  {s.label}
                </Button>
              ))}
              {(view === "ai-duanju" || view === "ai-manju") && CHANNEL_SORTS.map(s => (
                <Button key={s.value} card role="tab" aria-selected={chanSort === s.value}
                  className="hg-inline-sort"
                  onClick={() => setChanSort(s.value)}>
                  {s.label}
                </Button>
              ))}
              {view === "original" && ORIGINAL_CATES.map(s => (
                <Button key={s.value} card role="tab" aria-selected={origCate === s.value}
                  className="hg-inline-sort"
                  onClick={() => setOrigCate(s.value)}>{s.label}</Button>
              ))}
            </div>
          )}
        </div>

        {view === "topics" ? (
          <div className="pt-2"><TopicsSection wide={wide} /></div>
        ) : view === "tags" ? (
          <div className="pt-2"><TagsSection wide={wide} /></div>
        ) : (
          <>
            {err && (
              <div role="alert" className="py-4 flex flex-col items-center gap-2 text-[12px] text-danger">
                <span>{err}</span>
                <Button className="px-3 text-primary" onClick={() => void load(1)}>重试</Button>
              </div>
            )}
            {!items.length && loading && <div className="flex justify-center py-10"><Loader className="w-7 h-7 spinner" /></div>}
            {!items.length && !loading && !err && done && (
              <Empty icon={<IGrid size={26} />} title="暂无相关内容" sub="换个板块或排序试试" />
            )}

            {/* hg-stagger：追加/换批时新卡片淡入 + 上移，前 6 个错位 30ms（CSS 控制，不挂 JS） */}
            <div className="hg-grid-c3 mt-3 hg-stagger">
              {items.map(v => (
                <Button key={v.id} className="hg-poster is-c3" onClick={() => push({ kind: "series", id: v.id })}>
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
                    {v.tags?.[0] || "精选"} · {v.is_finished ? "全集" : `${v.episode_count ?? "?"}集`}
                  </span>
                </Button>
              ))}
            </div>

            {items.length > 0 && !done && (
              <Button className="hg-loadmore" onClick={() => void load(page + 1)} disabled={loading}>
                {loading ? "加载中…" : "加载更多"}
              </Button>
            )}
            {items.length > 0 && done && (
              /* 报告 16：3.0.0 一路无限加载、没有收尾，用户判断不了「到底了没有」 */
              <p className="hg-list-end">已经到底了 · 共 {items.length} 部</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 频道详情页（次级栈页：统一极光顶栏 + 玻璃轨道滑块） ================= */
export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [searching, setSearching] = useState(false);
  const [serverSort, setServerSort] = useState<(typeof CHANNEL_SORTS)[number]["value"]>("latest");
  const [originalCate, setOriginalCate] = useState<(typeof CHANNEL_ORIGINAL_CATES)[number]["value"]>("all");
  const [pageItems, setPageItems] = useState<VideoCard[][]>([]);
  const items = pageItems.flat();
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const filterKey = (sort: string, original: string) => `${cate}:${cate === "original" ? original : sort}`;
  const [displayedFilter, setDisplayedFilter] = useState(() => filterKey("latest", "all"));
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const requestSeq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);

  const loadMore = async (reset = false, sortOverride: string = serverSort, originalCateOverride = originalCate) => {
    const seq = reset ? ++requestSeq.current : requestSeq.current;
    if (!reset && (busy.current || page >= pages)) return;
    busy.current = true;
    setLoading(true);
    setErr(null);
    if (reset) setRefreshing(true);
    try {
      const next = reset ? 1 : page + 1;
      const res = cate === "original"
        ? await api.originalVideos(originalCateOverride, next, 20, originalSort(originalCateOverride))
        : await api.category(cate, next, 20, sortOverride);
      if (seq !== requestSeq.current) return;
      setPageItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.flat().map((x) => x.id));
        return [...base, (res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setDisplayedFilter(filterKey(sortOverride, originalCateOverride));
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr(null);
    } catch (e) {
      if (seq === requestSeq.current) setErr((e as Error).message || "加载失败");
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const changeServerSort = (value: (typeof CHANNEL_SORTS)[number]["value"]) => {
    if (value === serverSort) {
      if (value === "random" && !busy.current) {
        if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
        void loadMore(true, "random");
      }
      return;
    }
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setServerSort(value);
    setErr(null);
    void loadMore(true, value);
  };

  const changeOriginalCate = (value: (typeof CHANNEL_ORIGINAL_CATES)[number]["value"]) => {
    if (value === originalCate) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setOriginalCate(value);
    setErr(null);
    void loadMore(true, originalSort(value), value);
  };

  useEffect(() => {
    setPageItems([]); setPage(0); setPages(1);
    setServerSort("latest"); setOriginalCate("all"); setSearching(false);
    void loadMore(true, "latest", "all");
    return () => { requestSeq.current++; busy.current = false; };
    /* eslint-disable-next-line */
  }, [cate]);

  const filterPending = displayedFilter !== filterKey(serverSort, originalCate);
  const replacing = refreshing || filterPending;

  const checkScrollBottom = () => {
    const el = scrollContainer.current;
    if (!el || filtering || loading || err || replacing || page >= pages) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 360) void loadMore();
  };

  useEffect(() => {
    const el = sentinel.current;
    if (!el || filtering || loading || err || replacing || page >= pages) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) void loadMore(); }, { root: scrollContainer.current, rootMargin: "320px" });
    io.observe(el);
    checkScrollBottom();
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, loading, err, replacing, filtering]);

  const sortIdx = cate === "original"
    ? Math.max(0, CHANNEL_ORIGINAL_CATES.findIndex(x => x.value === originalCate))
    : Math.max(0, CHANNEL_SORTS.findIndex(x => x.value === serverSort));

  /* 上游 29e273a：频道筛选项左右滑切。短剧/漫剧走 CHANNEL_SORTS，原创走
     CHANNEL_ORIGINAL_CATES；切换沿用按钮那条路径（回顶部 + 重新拉第一页）。 */
  const channelSwipe = useTabSwipe<HTMLDivElement>({
    rootRef: scrollContainer,
    tabIndex: sortIdx,
    tabCount: cate === "original" ? CHANNEL_ORIGINAL_CATES.length : CHANNEL_SORTS.length,
    onTabChange: index => {
      if (cate === "original") {
        const next = CHANNEL_ORIGINAL_CATES[index];
        if (next) changeOriginalCate(next.value);
      } else {
        const next = CHANNEL_SORTS[index];
        if (next) changeServerSort(next.value);
      }
    },
  });

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar relative">
        <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
        <div className="hg-sub-titles">
          <h1 className="hg-sub-title">{name}</h1>
          <div role="status" className="hg-sub-meta">
            {replacing ? (loading ? "正在更新筛选结果…" : "筛选更新失败") : `已加载 ${items.length} 部 · ${page}/${Math.max(pages, 1)} 页`}
          </div>
        </div>
        <Button card onClick={() => setSearching(true)} aria-label={cate === "original" ? "搜索原创" : "搜索短剧"} className="hg-sub-btn">
          <ISearch size={18} />
        </Button>
      </header>

      <div className="shrink-0 hg-page-x pt-2.5 pb-2 relative flex items-center gap-2">
        {cate === "original" ? (
          <SegmentedControl className="hg-seg-track flex-1 min-w-0" aria-label="原创筛选" activeIndex={sortIdx}>
            {CHANNEL_ORIGINAL_CATES.map((s) => (
              <Button aria-pressed={originalCate === s.value} key={s.value} onClick={() => changeOriginalCate(s.value)}>
                {s.label}
              </Button>
            ))}
          </SegmentedControl>
        ) : (
          <>
            <SegmentedControl className="hg-seg-track flex-1 min-w-0" aria-label="频道排序" activeIndex={sortIdx}>
              {CHANNEL_SORTS.map((s) => (
                <Button aria-pressed={serverSort === s.value} key={s.value} onClick={() => changeServerSort(s.value)}>
                  {s.label}
                </Button>
              ))}
            </SegmentedControl>
            {serverSort === "random" && (
              <Button card className="hg-shuffle-btn shrink-0" style={{ height: 38, padding: "0 11px" }}
                aria-label="换一批随机推荐" aria-busy={refreshing}
                disabled={loading}
                onClick={() => {
                  if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
                  void loadMore(true, "random");
                }}>
                <IRefresh size={13} /><span>换一批</span>
              </Button>
            )}
          </>
        )}
      </div>

      <div ref={scrollContainer} {...channelSwipe} style={{ touchAction: "pan-y" }} className="flex-1 scroll-y hg-page-x pt-2 pb-8 relative" aria-busy={loading} onScroll={checkScrollBottom}>
        {items.length > 0 && replacing && <p role="status" className="mb-3 text-[12px] text-mut">{loading ? "正在更新，暂时保留上次结果…" : "当前显示上次结果，请重试以更新筛选。"}</p>}
        {items.length > 0 && err && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut"><span>{err}</span><Button className="px-3 text-primary" onClick={() => void loadMore(replacing)}>重试</Button></div>}
        {items.length ? (
          <div inert={replacing || undefined} className={replacing ? "opacity-60" : undefined}>
            <Masonry videos={items} scopeKey={filterKey(serverSort, originalCate)} wide={wide} onOpen={(v) => { if (!replacing) push({ kind: "series", id: v.id }); }} />
          </div>
        ) : err ? (
          <Empty icon={<IGrid size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void loadMore(true)} />
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        ) : <Empty icon={<IGrid size={26} />} title="该筛选下暂无内容" sub="换个筛选试试" />}
        <div ref={sentinel} className="h-10" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && !err && !replacing && page < pages && <Button onClick={() => void loadMore()} className="hg-loadmore">加载更多</Button>}
        {!loading && !replacing && !err && page >= pages && items.length > 0 && (
          <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
      {searching && <InplaceSearch kind="video" scope={cate === "original" ? "original" : undefined} wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v) => push({ kind: "series", id: v.id })} />}
    </div>
  );
}
