import { Button, Form, Input, SegmentedControl, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useRef, useState } from "react";
import { api, fmt, isMobile } from "../../shared/api/api";
import type { HotSearchVideo, Post, RankItem, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { MediaCard, Masonry } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { Empty, Img } from "../../shared/ui/ui";
import { useSearchResults } from "./useSearchResults";
import { useRankSwipe } from "./useRankSwipe";
import { SearchHistory } from "./SearchHistory";
import { useTabSwipe } from "../../shared/lib/useTabSwipe";
import { useApiRefresh, useForegroundRefresh, useVisibilityRefresh } from "../../shared/lib/dataFreshness";
import { PullIndicator, usePullToRefresh } from "../../shared/lib/usePullToRefresh";
import { SearchTags } from "./SearchTags";
import { IBack, IChevR, IClose, IFireF, IPlayF, IRefresh, ISearch, ITrophy } from "../../shared/ui/icons";

export default function Search({
  active,
  wide,
  initialTab = "video",
  onBack,
}: {
  active: boolean;
  wide: boolean;
  initialTab?: "video" | "post";
  onBack?: () => void;
}) {
  const { push, toast, searchHist, addSearch, removeSearch, clearSearchHist, lineEpoch, accountScope } = useStore();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tab, setTab] = useState<"video" | "post">(initialTab);
  const results = useSearchResults();
  const { result, request, loading, error: err } = results;
  const items = result?.kind === "video" ? result.items as VideoCard[] : [];
  const posts = result?.kind === "post" ? result.items as Post[] : [];
  const count = result?.items.length ?? 0;
  const inputRef = useRef<HTMLInputElement>(null);
  const [hotVideos, setHotVideos] = useState<HotSearchVideo[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState<string | null>(null);
  const hotBusy = useRef(false);
  const hotLoadedAt = useRef(0);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  /* 移动端进入搜索页不自动聚焦：iOS 会立刻弹键盘遮住内容（#20）。 */
  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const refreshHot = async (force = false) => {
    if (hotBusy.current) return;
    hotBusy.current = true;
    setHotLoading(true);
    setHotError(null);
    try {
      const res = await api.searchHot(force);
      setHotVideos(res.items);
      hotLoadedAt.current = Date.now();
    } catch (e) {
      setHotError(e instanceof Error ? e.message : "热搜榜加载失败，请重试");
    } finally {
      hotBusy.current = false;
      setHotLoading(false);
    }
  };
  useEffect(() => {
    if (active && Date.now() - hotLoadedAt.current > 30_000) void refreshHot(true);
  }, [active]);

  /* 搜索结果页不做下拉（规格：改静默刷新）。两个触发点：
     · 结果超过 60s 后重新聚焦搜索框 → 自动重搜当前关键词（保留输入内容与焦点）；
     · 回前台 / 前台每 5 分钟 → 静默重搜。 */
  const lastAtRef = useRef(Date.now());
  useEffect(() => { if (!loading && !hotLoading) lastAtRef.current = Date.now(); }, [loading, hotLoading]);
  const pullRefresh = async () => {
    if (submitted) await results.refresh();
    else await refreshHot(true);
  };
  const refocusRefresh = () => {
    if (!submitted) return;
    if (Date.now() - lastAtRef.current < 60_000) return;
    void results.refresh();
  };
  /* 前台每 5 分钟静默刷新当前结果（保留输入框内容与焦点，不重放搜索动画） */
  useForegroundRefresh(() => { void pullRefresh().catch(() => { /* 静默 */ }); }, { enabled: active });
  useVisibilityRefresh(() => { void pullRefresh().catch(() => { /* 静默 */ }); }, {
    enabled: active,
    lastAt: () => Math.max(hotLoadedAt.current, lastAtRef.current),
    busy: loading,
  });

  const querying = submitted.length > 0;

  const changeTab = (next: "video" | "post") => {
    if (next === tab) return;
    setTab(next);
    if (submitted) results.search(submitted, next, true);
  };

  /* 结果区左右横滑切 tab（上游 36f9058）：阈值/轴比沿用 useTabSwipe（与分类页同一套），
     只在已经出结果时生效；没搜索词时只有一个 tab，滑了也不该动。 */
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabSwipe = useTabSwipe<HTMLDivElement>({
    rootRef: scrollRef,
    tabIndex: querying && tab === "post" ? 1 : 0,
    tabCount: querying ? 2 : 1,
    onTabChange: index => changeTab(index === 0 ? "video" : "post"),
  });

  /* 清空搜索的唯一出口（上游 5df811a）：结果、输入、已提交词、tab、滚动位置一起回位。
     以前只清结果和输入，切到「吃瓜帖子」再清空会停在一个空的结果 tab 上。 */
  const resetSearch = () => {
    results.clear();
    setQ("");
    setSubmitted("");
    setTab("video");
    inputRef.current?.focus();
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const submit = (keyword: string) => {
    const k = keyword.trim();
    if (!k) return;
    setQ(k);
    setSubmitted(k);
    addSearch(k);
    results.search(k, tab);
  };

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <h1 className="sr-only">搜索</h1>
      {/* 统一次级极光磨砂顶栏：返回键 + 搜索输入框 + 榜单快捷入口 */}
      <header className="shrink-0 hg-subpage-bar relative z-10">
        {onBack && (
          <Button card className="hg-sub-btn" aria-label="返回" onClick={onBack}>
            <IBack size={19} />
          </Button>
        )}
        <Form className="ios-search-form flex-1 min-w-0 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <Input aria-label="搜索短剧、帖子、题材…" ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onFocus={refocusRefresh}
            placeholder={tab === "post" ? "搜索吃瓜帖子、话题…" : "搜索短剧、帖子、题材…"}
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {q && <Button aria-label="清空搜索" type="button" onClick={resetSearch} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
        </Form>
        <Button card onClick={() => push({ kind: "ranks" })} aria-label="排行榜"
          className="hg-sub-btn" style={{ color: "#FFD19A", borderColor: "rgba(255, 179, 71, 0.35)" }}>
          <ITrophy size={18} />
        </Button>
      </header>

      {/* 一体式极光玻璃轨道滑块（短剧 / 吃瓜帖子） */}
      <div className="shrink-0 hg-page-x pt-2.5 pb-2 relative z-10">
        <SegmentedControl className="hg-seg-track" aria-label="搜索结果类型" activeIndex={tab === "video" ? 0 : 1}>
          {([["video", "短剧剧集"], ["post", "吃瓜帖子"]] as const).map(([k, label]) => (
            <Button aria-pressed={tab === k} key={k} onClick={() => changeTab(k)}>{label}</Button>
          ))}
        </SegmentedControl>
      </div>

      <div ref={scrollRef} {...tabSwipe} style={{ touchAction: "pan-y", paddingBottom: "calc(32px + var(--sab, 0px))" }} className="flex-1 scroll-y hg-page-x pt-1 relative z-10">
        {!querying ? (
          <>
            <SearchHistory
              items={searchHist}
              onPick={(h) => { setQ(h); submit(h); }}
              onRemove={removeSearch}
              onClear={clearSearchHist}
            />

            <Surface role="region" aria-label="热搜榜" className="mt-1 rounded-[16px] p-3.5 a-rise"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-[14px] font-bold text-on">
                  <IFireF size={15} style={{ color: "#FF6B57" }} />全站热搜风向
                </h2>
                <Button onClick={() => void refreshHot()} disabled={hotLoading} aria-label="刷新热搜榜"
                  className="flex items-center gap-1 px-2 text-[12px] text-mut pressable">
                  {hotLoading ? <Loader className="w-3 h-3" /> : <IRefresh size={12} />}{hotLoading ? "刷新中" : "刷新"}
                </Button>
              </div>
              {hotError && <p role="status" className="mt-2 text-[12px] text-mut leading-relaxed">
                {hotVideos.length > 0 ? "刷新失败，保留上次榜单。" : "热搜榜暂不可用。"}{hotError}
              </p>}
              {hotVideos.length > 0 ? (() => {
                const sortedHot = [...hotVideos].sort((a, b) => playsValue(b.plays) - playsValue(a.plays));
                return (
                  <ol className="ios-search-hot-grid mt-3" aria-busy={hotLoading}>
                    {sortedHot.map((video, i) => {
                      const rankColor = i === 0 ? "#FCD34D" : i === 1 ? "#E2E8F0" : i === 2 ? "#FDBA74" : undefined;
                      return (
                        <li key={video.video_id} className="min-w-0">
                          <Button aria-label={`查看 ${video.title}`} title={video.title} className="ios-search-hot-item"
                            onClick={() => push({ kind: "series", id: video.video_id })}>
                            <span aria-hidden="true" className="ios-search-hot-rank text-mut"
                              style={rankColor ? { color: rankColor, fontWeight: 800 } : undefined}>
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <span className="ios-search-hot-content">
                              <span className="ios-search-hot-title">{video.title}</span>
                              {video.plays && <span className="ios-search-hot-plays"><IPlayF size={10} />{video.plays}</span>}
                            </span>
                            <IChevR size={15} className="text-mut" />
                          </Button>
                        </li>
                      );
                    })}
                  </ol>
                );
              })() : !hotError && <p role="status" className="mt-3 text-[12px] text-mut">{hotLoading ? "加载中…" : "暂无热搜影片"}</p>}
            </Surface>

            <SearchTags key={JSON.stringify([lineEpoch, accountScope])} active={active} />
            <p className="mt-3 text-[12px] text-dim leading-relaxed">
              输入关键词后按回车搜索，或点击上方 #题材标签 直达片单。
            </p>
          </>
        ) : (
          <>
            <div role="status" className="text-[12px] text-mut mb-2.5" aria-live="polite">
              {loading && <span className="block">{request?.page === 1 ? `正在搜索「${submitted}」…` : "正在加载更多…"}</span>}
              {result && <>「{result.keyword}」已加载 <span className="text-primary font-bold">{count}{result.total !== null ? ` / ${result.total}` : ""}</span> 条{result.kind === "post" ? "帖子" : "短剧"}</>}
            </div>
            {err && <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-danger">
              <span>「{submitted}」{request?.page && request.page > 1 ? "加载更多失败" : "搜索失败"}：{err}</span>
              <Button onClick={results.retry} disabled={loading} className="px-3 text-primary">重试</Button>
            </div>}
            <section aria-label="搜索结果" aria-busy={loading}>
              {result && count > 0 ? <>
                {result.kind === "video" ? (
                  <Masonry videos={items} scopeKey={JSON.stringify([submitted, tab, result.keyword, result.kind])} wide={wide}
                    onOpen={(v) => push({ kind: "series", id: v.id })} />
                ) : (
                  <FilteredContent items={posts} scopeKey={JSON.stringify([submitted, tab, result.keyword, result.kind])}>{visible => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                    {visible.map((post) => (
                      <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: post.id })} />
                    ))}
                  </div>}</FilteredContent>
                )}
                <div className="flex justify-center py-4">
                  {loading ? <Loader label="搜索结果更新中" className="w-6 h-6 spinner" />
                    : !err && result.keyword === submitted && (result.page < result.pages ? (
                      <Button onClick={results.loadMore} className="hg-loadmore">加载更多</Button>
                    ) : <span className="text-[12px] text-dim">— 已经到底啦 —</span>)}
                </div>
              </> : loading ? (
                <div className="flex justify-center py-12"><Loader label="正在搜索" className="w-8 h-8 spinner" /></div>
              ) : !err && (
                <Empty icon={<ISearch size={26} />} title="没有找到相关内容" sub="换个关键词试试，比如「都市」「逆袭」"
                  action="看看热榜" onAction={() => push({ kind: "ranks" })} />
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 排行榜（金银铜 3D 错落三联领奖台 + 流光热度条列表） ================= */
const RANK_TABS = [
  { k: "hot", label: "热播榜" },
  { k: "recommend", label: "推荐榜" },
  { k: "potential", label: "潜力榜" },
] as const;

function playsValue(v: string): number {
  const m = /([\d.]+)\s*([wW万亿]?)/.exec(v || "");
  if (!m) return 0;
  const n = parseFloat(m[1]) || 0;
  const unit = m[2];
  return unit === "亿" ? n * 1e8 : unit === "w" || unit === "W" ? n * 1e4 : n;
}

export function RankView({ wide, active = true, refreshSignal = 0, onRefreshed }: {
  wide: boolean; active?: boolean; refreshSignal?: number; onRefreshed?: () => void;
}) {
  const { push, lineEpoch } = useStore();
  type RankKind = typeof RANK_TABS[number]["k"];
  type RankState = { items: RankItem[]; loadedAt: number; loading: boolean; error: string };
  const [tab, setTab] = useState<RankKind>("hot");
  const [states, setStates] = useState<Partial<Record<RankKind, RankState>>>({});
  const cache = useRef<Partial<Record<RankKind, RankState>>>({});
  const pending = useRef(new Set<RankKind>());
  /* 每个榜单一个请求代次：换线 / 刷新会开新代次，旧代次的响应一律丢弃。
     旧代码用 pending 直接 return —— 换线那一刻的新请求被丢掉，旧响应回来还把
     loadedAt 写成「现在」，界面看着是新的、其实是旧线路的数据。 */
  const seq = useRef<Partial<Record<RankKind, number>>>({});
  const alive = useRef(true);
  const signal = useRef(refreshSignal);
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    cache.current = {};
    /* 换线路：把在途请求全部作废（旧响应不许写 loadedAt / 不许盖新榜） */
    for (const kind of Object.keys(seq.current) as RankKind[]) seq.current[kind] = (seq.current[kind] ?? 0) + 1;
    pending.current.clear();
  }, [lineEpoch]);

  /* force=true：绕过 api 读缓存，用户点刷新 / 下拉时必须真的出网（旧代码刷新按钮也吃缓存） */
  const load = async (kind: RankKind, force = false) => {
    /* 同代次里不重复发；forced（换线 / 用户刷新）必须能越过在途请求，否则新线路的数据永远等不到 */
    if (pending.current.has(kind) && !force) return;
    pending.current.add(kind);
    const my = (seq.current[kind] ?? 0) + 1;
    seq.current[kind] = my;
    const current = () => seq.current[kind] === my;
    const previous = cache.current[kind];
    const update = (state: RankState) => {
      if (!current()) return;   /* 旧代次：不写缓存、不写 loadedAt、不碰界面 */
      cache.current[kind] = state;
      if (alive.current) setStates((states: Partial<Record<RankKind, RankState>>) => ({ ...states, [kind]: state }));
    };
    update({ items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: true, error: "" });
    try {
      const res = await api.rank(kind, force);
      update({ items: res?.items || [], loadedAt: Date.now(), loading: false, error: "" });
    } catch (error) {
      update({
        items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: false,
        error: error instanceof Error ? error.message : "榜单加载失败，请重试",
      });
    } finally {
      if (current()) pending.current.delete(kind);
    }
  };

  /* 后台刷新（命中缓存后 api 层补的那一次）回来时原地换新 */
  useApiRefresh<{ items: RankItem[] }>("api_rank", { kind: tab }, res => {
    if (!res || !alive.current) return;
    const next: RankState = { items: res.items || [], loadedAt: Date.now(), loading: false, error: "" };
    cache.current[tab] = next;
    setStates(current => ({ ...current, [tab]: next }));
  });

  useEffect(() => {
    if (!active) return;
    /* 外面下拉刷新（首页热榜 tab / 排行榜页）→ 强制重拉当前榜单 */
    if (signal.current !== refreshSignal) {
      signal.current = refreshSignal;
      void load(tab, true).then(() => onRefreshedRef.current?.());
      return;
    }
    /* 回前台 / 重进：30s 内用现成数据，超过就补一次真实请求（不闪骨架） */
    if (!cache.current[tab]?.loadedAt || Date.now() - cache.current[tab]!.loadedAt > 30_000) void load(tab, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, active, lineEpoch, refreshSignal]);

  useForegroundRefresh(() => { void load(tab, true); }, { enabled: active });
  useVisibilityRefresh(() => { void load(tab, true); }, {
    enabled: active,
    lastAt: () => cache.current[tab]?.loadedAt ?? 0,
    busy: states[tab]?.loading ?? false,
  });

  const state = states[tab];
  const items = state?.items ?? [];
  const loading = state?.loading ?? true;
  const err = state?.error ?? "";
  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));
  /* 报告 N-3.0-03：只写「热力指数」不写数字等于没有指标——有值时拼上数值，没值就不渲染这个标签 */
  const heatLabel = (it: RankItem) => (it.metric_value > 0 ? `${it.metric_label || "热度"} ${fmt(it.metric_value)}` : "");
  const activeIdx = Math.max(0, RANK_TABS.findIndex(t => t.k === tab));
  const meta = RANK_TABS[activeIdx];
  /* 上游 66e02b4：榜单三个 tab 左右滑切；点选照旧，切榜沿用现有加载/缓存逻辑。 */
  const rankSwipe = useRankSwipe({
    tabIndex: activeIdx,
    tabCount: RANK_TABS.length,
    onTabChange: index => { const next = RANK_TABS[index]; if (next) setTab(next.k); },
  });

  return (
    <div ref={rankSwipe.rootRef} {...rankSwipe.handlers} style={{ touchAction: "pan-y" }}>
      {/* 一体式极光玻璃轨道滑块（替代旧下划线/胶囊） */}
      <div className="flex items-center gap-2.5 pb-1">
        <SegmentedControl className="hg-seg-track flex-1" aria-label="榜单类型" activeIndex={activeIdx}>
          {RANK_TABS.map((t) => (
            <Button key={t.k} aria-pressed={tab === t.k} onClick={() => setTab(t.k)}>{t.label}</Button>
          ))}
        </SegmentedControl>
        <Button card className="hg-sub-btn" aria-label="刷新榜单" disabled={loading} onClick={() => void load(tab, true)}>
          {loading ? <Loader label="正在更新榜单" className="w-4 h-4" /> : <IRefresh size={15} />}
        </Button>
      </div>

      {err && <div role="alert" className="flex flex-wrap items-center gap-2 my-2.5 text-[13px] text-danger">
        <span>榜单加载失败：{err}{items.length > 0 ? "；已保留上次榜单" : ""}</span>
        <Button onClick={() => void load(tab, true)} disabled={loading} className="px-3 text-primary">重试</Button>
      </div>}

      <section aria-label={meta.label} aria-busy={loading}>
        {items.length > 0 ? <>
          {loading && <p role="status" className="text-[12px] text-mut mt-2">正在刷新，当前显示上次榜单…</p>}
          <FilteredContent items={items} scopeKey={tab}>{visible => {
            const hasPodium = visible.length >= 3;
            const podiumOrder = hasPodium ? [
              { item: visible[1], tier: "is-silver", badge: "TOP 2", rankNo: 2 },
              { item: visible[0], tier: "is-gold", badge: "👑 TOP 1", rankNo: 1 },
              { item: visible[2], tier: "is-bronze", badge: "TOP 3", rankNo: 3 },
            ] : [];
            const listItems = hasPodium ? visible.slice(3) : visible;

            return (
              <>
                {hasPodium && (
                  <div className="hg-podium a-rise" role="list" aria-label="榜单前三名">
                    {podiumOrder.map(({ item, tier, badge, rankNo }) => (
                      <Button key={`podium-${item.video_id}-${rankNo}`} card role="listitem"
                        className={`hg-podium-card ${tier}`}
                        onClick={() => push({ kind: "series", id: item.video_id })}>
                        <span className="hg-podium-crown">{badge}</span>
                        <span className="hg-podium-art">
                          <Img src={item.cover} eager alt="" />
                        </span>
                        <span className="hg-podium-title">{item.title}</span>
                        <span className="hg-podium-metric">
                          {heatLabel(item) || (item.is_finished ? "全集完结" : `更至 ${item.episode_count} 集`)}
                        </span>
                      </Button>
                    ))}
                  </div>
                )}

                <div className="flex flex-col gap-2.5">
                  {listItems.map((it, idx) => {
                    const displayRank = it.rank || (hasPodium ? idx + 4 : idx + 1);
                    const pct = Math.max(12, Math.min(100, Math.round(((it.metric_value || 0) / max) * 100)));
                    return (
                      <Button key={`${it.video_id}-${displayRank}`} card className="hg-rank-row-v2"
                        onClick={() => push({ kind: "series", id: it.video_id })}>
                        <span className="hg-rank-idx">{String(displayRank).padStart(2, "0")}</span>
                        <span className="hg-rank-thumb"><Img src={it.cover} alt="" /></span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center justify-between gap-2">
                            <span className="text-[14px] font-bold text-on truncate">{it.title}</span>
                            {heatLabel(it) && <span className="shrink-0 text-[11px] font-semibold" style={{ color: "#FFB347" }}>{heatLabel(it)}</span>}
                          </span>
                          <span className="block mt-1 text-[11px] text-mut truncate">
                            {[
                              it.cate_name,
                              it.tags?.slice(0, 2).join(" · "),
                              it.is_finished ? "已完结" : it.episode_count ? `更至 ${it.episode_count} 集` : "",
                            ].filter(Boolean).join(" · ")}
                          </span>
                          <span className="hg-rank-bar" aria-hidden="true">
                            <span className="hg-rank-bar-fill" style={{ width: `${pct}%` }} />
                          </span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
                <p className="hg-list-end">已经到底了 · 共 {(hasPodium ? podiumOrder.length : 0) + listItems.length} 部</p>
              </>
            );
          }}</FilteredContent>
        </> : loading ? (
          <div className="flex justify-center py-12"><Loader label="正在加载榜单" className="w-8 h-8 spinner" /></div>
        ) : !err && (
          <Empty icon={<ITrophy size={26} />} title="榜单暂时为空" sub="稍后再来看看，或者去首页刷刷推荐" />
        )}
      </section>
      {wide && <div className="h-2" />}
    </div>
  );
}

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [signal, setSignal] = useState(0);
  const rankDone = useRef<(() => void) | null>(null);
  const pull = usePullToRefresh({
    ref: scrollRef,
    onRefresh: () => new Promise<void>(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      rankDone.current = finish;
      setSignal(n => n + 1);
      /* 兜底：榜单请求卡住时也要在 6s 内收指示器，不能一直转 */
      window.setTimeout(finish, 6000);
    }),
    enabled: isMobile,
    onDone: ok => toast(ok ? "已同步官网" : "同步失败，稍后再试", ok ? "ok" : "info"),
  });
  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar relative z-10">
        <Button card className="hg-sub-btn" aria-label="返回" onClick={onBack}><IBack size={19} /></Button>
        <div className="hg-sub-titles">
          <h1 className="hg-sub-title">巅峰排行榜</h1>
          <div className="hg-sub-meta">实时热播 · 口碑精选 · 飙升潜力</div>
        </div>
        <Button card className="hg-sub-btn" aria-label="搜索" onClick={() => push({ kind: "search", initialTab: "video" })}>
          <ISearch size={18} />
        </Button>
      </header>
      <div ref={scrollRef} className="flex-1 scroll-y hg-page-x pt-3 relative z-10" style={{ paddingBottom: "calc(32px + var(--sab, 0px))" }}>
        <PullIndicator pull={pull.pull} refreshing={pull.refreshing} progress={pull.progress} />
        <RankView wide={wide} refreshSignal={signal} onRefreshed={() => { rankDone.current?.(); rankDone.current = null; }} />
      </div>
    </div>
  );
}
