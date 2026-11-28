import { Button, SegmentedControl } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Post, TagGroup, TopicCard, TopicDetail, VideoCard } from "../../shared/api/types";
import { ACTION_TOAST_SLOT, useStore } from "../../shared/model/store";
import { MAX_BLOCKED_TAGS, MAX_PINNED_TAGS, MAX_TAG_LENGTH, useContentPreferences } from "../../shared/model/contentPreferences";
import {
  SERIALIZATION_FILTER_OPTIONS,
  VIDEO_SORT_OPTIONS,
  filterVideosByStatus,
  sortVideosByMetric,
  type SerializationStatusFilter,
  type VideoSortDirection,
  type VideoSortMetric,
} from "../../shared/model/videoSort";
import { Masonry, MediaCard } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { InplaceSearch } from "../search/InplaceSearch";
import { Empty, Img } from "../../shared/ui/ui";
import { IBack, IBoltF, IGrid, IGlobe, IPin, IPinF, IPlayF, IRefresh, ISearch } from "../../shared/ui/icons";

const TopicIcon = IGrid;
const TagIcon = IGlobe;

/** Retain the last good result on refresh, but never expose a previous route's data. */
function useDiscoveryData<T>(key: string, request: () => Promise<T>) {
  const [state, setState] = useState<{ key: string; data: T | null; loading: boolean; error: string }>({ key, data: null, loading: true, error: "" });
  const sequence = useRef(0);
  const busy = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const token = ++sequence.current;
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: "" }));
    try {
      const data = await requestRef.current();
      if (token === sequence.current) setState({ key, data, loading: false, error: "" });
    } catch (error) {
      if (token === sequence.current) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "加载失败，请重试" }));
    } finally {
      if (token === sequence.current) busy.current = false;
    }
  }, [key]);
  useEffect(() => {
    busy.current = false;
    void load();
    return () => { sequence.current++; busy.current = false; };
  }, [load]);
  return { data: state.key === key ? state.data : null, loading: state.key !== key || state.loading, err: state.key === key ? state.error : "", load };
}

function RefreshStatus({ loading, error, onRetry }: { loading: boolean; error: string; onRetry: () => void }) {
  if (!loading && !error) return null;
  return <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut">
    {loading ? <><Loader className="w-4 h-4" />正在刷新，保留当前内容…</>
      : <><span className="min-w-0 break-words">刷新失败，保留当前内容。{error}</span><Button onClick={onRetry} className="px-3 text-primary">重试</Button></>}
  </div>;
}

/* ================= 专题列表模块（支持在分类页内嵌，也支持独立二级页） ================= */
export function TopicsSection({ wide }: { wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const { data, loading, err, load } = useDiscoveryData(`topics:${lineEpoch}`, api.topics);
  const items = data?.items ?? [];

  return (
    <div aria-busy={loading} className="pt-1">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[12px] text-mut">{loading && !items.length ? "加载专题中…" : `共 ${items.length} 个精选专题`}</span>
        <Button card className="hg-icon-plain" aria-label="刷新专题" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader className="w-4 h-4" /> : <IRefresh size={15} />}
        </Button>
      </div>
      {items.length > 0 && <RefreshStatus loading={loading} error={err} onRetry={() => void load()} />}
      {loading && !items.length ? (
        <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
      ) : err && !items.length ? (
        <Empty icon={<TopicIcon size={26} />} title="专题加载失败" sub={err} action="重试" onAction={load} />
      ) : items.length ? (
        <div className={`grid gap-3 ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"}`}>
          {items.map((t) => (
            <Button card key={t.id} onClick={() => push({ kind: "topic", slug: t.slug, name: t.title })}
              title={t.title} className="hg-topic-card-v2 min-w-0 pressable a-rise">
              <span className="hg-topic-card-v2-art">
                <Img src={t.cover} />
                <span className="hg-topic-card-v2-badge">{t.video_count ?? 0} 部</span>
              </span>
              <div className="p-2.5">
                <div className="text-[14px] font-bold text-on clamp-1 leading-tight">{t.title}</div>
                {t.intro && <div className="text-[12px] text-mut clamp-2 mt-1 leading-relaxed">{t.intro}</div>}
              </div>
            </Button>
          ))}
        </div>
      ) : (
        <Empty icon={<TopicIcon size={26} />} title="暂无专题" />
      )}
    </div>
  );
}

export function TopicsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const [searching, setSearching] = useState(false);
  /* 目录也必须跟着换线重拉：key 里带 lineEpoch，换线即视为另一个数据集 */
  const { data, loading, err, load } = useDiscoveryData(`topics:${lineEpoch}`, api.topics);
  const items = data?.items ?? [];

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar">
        <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
        <div className="hg-sub-titles">
          <h1 className="hg-sub-title">专题</h1>
          <p className="hg-sub-meta">{items.length} 个策展专辑</p>
        </div>
        <Button card onClick={() => setSearching(true)} aria-label="搜索短剧" className="hg-sub-btn"><ISearch size={17} /></Button>
        <Button card aria-label="刷新" disabled={loading} aria-busy={loading} onClick={() => void load()} className="hg-sub-btn">
          {loading ? <Loader className="w-4 h-4" /> : <IRefresh size={16} />}
        </Button>
      </header>

      <div className="flex-1 scroll-y hg-page-x pt-3 pb-8 relative" aria-busy={loading}>
        {items.length > 0 && <RefreshStatus loading={loading} error={err} onRetry={() => void load()} />}
        {loading && !items.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<TopicIcon size={26} />} title="专题加载失败" sub={err} action="重试" onAction={load} />
        ) : items.length ? (
          <div className={`grid gap-3 ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"}`}>
            {items.map((t) => (
              <Button card key={t.id} onClick={() => push({ kind: "topic", slug: t.slug, name: t.title })}
                title={t.title} className="hg-topic-card-v2 min-w-0 pressable a-rise">
                <span className="hg-topic-card-v2-art">
                  <Img src={t.cover} />
                  <span className="hg-topic-card-v2-badge">{t.video_count ?? 0} 部</span>
                </span>
                <div className="p-2.5">
                  <div className="text-[14px] font-bold text-on clamp-1 leading-tight">{t.title}</div>
                  {t.intro && <div className="text-[12px] text-mut clamp-2 mt-1 leading-relaxed">{t.intro}</div>}
                </div>
              </Button>
            ))}
          </div>
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="暂无专题" />
        )}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v) => push({ kind: "series", id: v.id })} />}
    </div>
  );
}

/* ================= 专题详情页 ================= */
/* 专题标题在顶栏只剩 ~170–230px（还要给「连刷 / 搜索」两个按钮让位），大字体下会折两行。
 * 裸 CJK 折行是「先把第一行填满」，于是出现「精品高分AI短剧专」/「辑」这种孤儿。
 * 这里在**语义边界**插 <wbr>（类型词、后缀词之前），配合 CSS 的 word-break:keep-all：
 * 只在这些位置能断，浏览器按可用宽度挑最靠后的那个能放下的断点，于是
 *   394dp@1.4 → 「精品高分AI短剧」/「专辑」
 *   360dp@1.4 → 「精品高分AI」/「短剧专辑」（最靠后的断点放不下时的降级）
 *   一行放得下 → <wbr> 不产生任何效果，不会硬凑成两行。
 * 没有命中词表的标题原样返回（行为与以前一致，靠 overflow-wrap 兜底）。
 */
const BREAK_TOKEN = /(专辑|合集|系列|榜单|精选|专区|特辑|片单|专题|短剧|漫剧|长剧)$/;
function splitForBreak(title: string): string[] {
  const parts: string[] = [];
  let rest = title.trim();
  while (parts.length < 2) {
    const match = BREAK_TOKEN.exec(rest);
    if (!match || match.index === 0) break;
    parts.unshift(match[1]);
    rest = rest.slice(0, match.index);
  }
  return parts.length ? [rest, ...parts] : [title];
}
function titleWithBreak(title: string) {
  const parts = splitForBreak(title);
  if (parts.length < 2) return title;
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>
      ))}
    </>
  );
}

export function TopicPage({ slug, name, onBack, wide }: { slug: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const [searching, setSearching] = useState(false);
  const [introExpanded, setIntroExpanded] = useState(false);
  const introId = useId();
  const [state, setState] = useState<{
    topic: TopicDetail["topic"] | null;
    related: TopicCard[];
    videos: VideoCard[];
    page: number;
    pages: number;
    total: number;
    loading: boolean;
    loadingMore: boolean;
    error: string;
  }>({ topic: null, related: [], videos: [], page: 0, pages: 1, total: 0, loading: true, loadingMore: false, error: "" });
  const sequence = useRef(0);
  const busy = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async (page = 1, reset = false) => {
    if (busy.current) return;
    busy.current = true;
    const token = reset ? ++sequence.current : sequence.current;
    setState(previous => reset
      ? { ...previous, topic: null, related: [], videos: [], page: 0, pages: 1, total: 0, loading: true, loadingMore: false, error: "" }
      : { ...previous, loading: false, loadingMore: true, error: "" });
    try {
      const data = await api.topic(slug, page, 20);
      if (token !== sequence.current) return;
      const incoming = data?.videos?.items ?? [];
      setState(previous => {
        const seen = new Set(reset ? [] : previous.videos.map(video => video.id));
        const videos = [...(reset ? [] : previous.videos), ...incoming.filter(video => !seen.has(video.id))];
        return {
          topic: data?.topic ?? previous.topic,
          related: data?.related ?? previous.related,
          videos,
          page: data?.videos?.pagination?.page ?? page,
          pages: Math.max(1, data?.videos?.pagination?.pages ?? page),
          total: Math.max(videos.length, data?.videos?.pagination?.total ?? videos.length),
          loading: false,
          loadingMore: false,
          error: "",
        };
      });
    } catch (error) {
      if (token === sequence.current) {
        setState(previous => ({
          ...previous,
          loading: false,
          loadingMore: false,
          error: error instanceof Error ? error.message : "加载失败，请重试",
        }));
      }
    } finally {
      if (token === sequence.current) busy.current = false;
    }
    /* 线路也是一份数据源：换线必须重拉专题第 1 页（旧代码只按 slug 依赖，换了线还是上一批） */
  }, [slug, lineEpoch]);

  const loadMore = () => {
    const current = stateRef.current;
    if (current.loading || current.loadingMore || current.page >= current.pages) return;
    void load(current.page + 1);
  };

  useEffect(() => {
    busy.current = false;
    setIntroExpanded(false);
    setSearching(false);
    void load(1, true);
    return () => { sequence.current++; busy.current = false; };
  }, [load]);

  const { topic, related, videos, page, pages, total, loading, loadingMore, error } = state;
  const hasMore = page < pages;
  const heroCover = topic?.cover || videos[0]?.cover || "";

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar">
        <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
        <div className="hg-sub-titles">
          {/* 顶栏标题：一行放得下就一行；放不下时断在语义边界（「精品高分AI短剧」/「专辑」），
              而不是把「辑」单独甩到第二行。见 titleWithBreak()。 */}
          <h1 className="hg-sub-title is-2line" title={topic?.title || name}>
            {titleWithBreak(topic?.title || name)}
          </h1>
          <div className="hg-sub-meta">{loading ? "加载中…" : `已加载 ${videos.length} / ${total} 部`}</div>
        </div>
        {videos.length > 0 && (
          <Button card className="hg-quick-action"
            onClick={() => push({ kind: "feed", videoIds: videos.map(v => v.id), index: 0, title: topic?.title || name })}>
            <IPlayF size={12} /><span>连刷</span>
          </Button>
        )}
        <Button card onClick={() => setSearching(true)} aria-label="搜索短剧" className="hg-sub-btn"><ISearch size={17} /></Button>
      </header>

      <div className="flex-1 scroll-y hg-page-x pt-3 pb-8 relative" aria-busy={loading}
        onScroll={(e) => {
          if (loading || loadingMore || !hasMore || error) return;
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 360) loadMore();
        }}>
        {(topic?.intro || topic?.cover) && (
          <section className="hg-topic-hero" aria-label="专题简介">
            {heroCover && <span className="hg-topic-hero-bg" aria-hidden="true"><Img src={heroCover} alt="" /></span>}
            <div className="hg-topic-hero-inner">
              <div className="flex items-center gap-3">
                {topic?.cover && <span className="hg-topic-hero-thumb"><Img src={topic.cover} alt="" /></span>}
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-bold" style={{ color: "#FFD19A" }}>精选策展专辑 · 共 {total || topic?.video_count || videos.length} 部</div>
                  <div className="mt-1 text-[15px] font-extrabold text-on truncate">{topic?.title || name}</div>
                </div>
              </div>
              {topic?.intro && (
                <div className="mt-2.5">
                  <p id={introId} className={`text-[13px] text-mut leading-relaxed break-words ${introExpanded ? "" : "clamp-3"}`}>{topic.intro}</p>
                  <Button aria-expanded={introExpanded} aria-controls={introId} onClick={() => setIntroExpanded(value => !value)} className="mt-1 px-2 text-[12px] text-primary">{introExpanded ? "收起简介" : "展开简介"}</Button>
                </div>
              )}
            </div>
          </section>
        )}

        {related.length > 0 && (
          <div className="mb-4">
            <h2 className="text-[13px] font-bold text-on mb-2">相关专题</h2>
            <div className="hg-topic-rail">
              {related.map((r) => (
                <Button card key={r.id} onClick={() => push({ kind: "topic", slug: r.slug, name: r.title })}
                  className="hg-topic-mini">
                  <span className="hg-topic-mini-art">
                    <Img src={r.cover} alt="" />
                    <span className="hg-topic-mini-veil" aria-hidden="true" />
                    <span className="hg-topic-mini-copy">
                      <span className="hg-topic-mini-cnt">{r.video_count ?? 0} 部</span>
                      <span className="hg-topic-mini-title">{r.title}</span>
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {loading && !videos.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : error && !videos.length ? (
          <Empty icon={<TopicIcon size={26} />} title="加载失败" sub={error} action="重试" onAction={() => void load(1, true)} />
        ) : videos.length ? (
          <Masonry videos={videos} scopeKey={slug} wide={wide} onOpen={(v) => push({ kind: "series", id: v.id })} />
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="暂无内容" />
        )}
        {error && videos.length > 0 && <div role="alert" className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[13px] text-danger">
          <span className="min-w-0 break-words">加载更多失败：{error}</span>
          <Button disabled={loadingMore} onClick={loadMore} className="px-3 text-primary">重试</Button>
        </div>}
        {loadingMore && <div className="flex justify-center py-3"><Loader label="正在加载更多专题影片" className="w-6 h-6" /></div>}
        {!loading && !loadingMore && hasMore && <Button card onClick={loadMore} className="hg-loadmore">
          加载更多（{videos.length}/{total}）
        </Button>}
        {!loading && !loadingMore && !hasMore && videos.length > 0 && <div className="py-3 text-center text-[12px] text-dim">已加载全部 {total} 部</div>}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v) => push({ kind: "series", id: v.id })} />}
    </div>
  );
}

/* ================= 标签聚合模块（支持在分类页内嵌，也支持独立二级页） ================= */
export function TagsSection({ wide }: { wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const { data, loading, err, load } = useDiscoveryData(`tags:${lineEpoch}`, api.tags);
  const groups = data?.categories ?? [];

  return (
    <div aria-busy={loading} className="pt-1">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[12px] text-mut">{loading && !groups.length ? "加载标签中…" : `共 ${groups.reduce((sum, g) => sum + (g.tags?.length || 0), 0)} 个细分标签`}</span>
        <Button card className="hg-icon-plain" aria-label="刷新标签" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader className="w-4 h-4" /> : <IRefresh size={15} />}
        </Button>
      </div>
      {groups.length > 0 && <RefreshStatus loading={loading} error={err} onRetry={() => void load()} />}
      {loading && !groups.length ? (
        <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
      ) : err && !groups.length ? (
        <Empty icon={<TagIcon size={26} />} title="标签加载失败" sub={err} action="重试" onAction={load} />
      ) : groups.length ? (
        <div className={wide ? "grid grid-cols-2 gap-x-6 items-start" : ""}>{groups.map((g) => (
          <section key={g.name} className="mb-5 a-rise">
            <div className="flex items-center gap-2 mb-2.5">
              <h2 className="text-[14px] font-bold text-on">{g.name}</h2>
              <span className="text-[12px] text-dim">{g.tags?.length || 0} 个</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {g.tags.map((t) => (
                <Button card key={t.id} onClick={() => push({ kind: "tag", tag: t.name, name: t.name })}
                  className={`hg-tag-pill max-w-full min-w-0 text-left${t.is_hot ? " is-hot" : ""}`}>
                  <span className="hg-tag-hash">#</span>
                  <span className="min-w-0 whitespace-normal break-all">{t.name}</span>
                  {!!t.hot_score && <span aria-label={`热度 ${fmt(t.hot_score)}`} className="shrink-0 text-[11px] text-dim">{fmt(t.hot_score)}</span>}
                </Button>
              ))}
            </div>
          </section>
        ))}</div>
      ) : (
        <Empty icon={<TagIcon size={26} />} title="暂无标签" />
      )}
    </div>
  );
}

const TAG_PIN_HOLD_MS = 600;
const TAG_PIN_MOVE_SLOP = 10;

function TagPinChip({ name, hotScore, isHot, pinned, board = false, onOpen, onTogglePin }: {
  name: string;
  hotScore?: number;
  isHot?: boolean;
  pinned: boolean;
  board?: boolean;
  onOpen: () => void;
  onTogglePin: (name: string) => void;
}) {
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    originRef.current = null;
    setPressing(false);
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    cancel();
    originRef.current = { x: event.clientX, y: event.clientY };
    setPressing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      setPressing(false);
      onTogglePin(name);
    }, TAG_PIN_HOLD_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = originRef.current;
    if (!origin) return;
    if (Math.abs(event.clientX - origin.x) > TAG_PIN_MOVE_SLOP || Math.abs(event.clientY - origin.y) > TAG_PIN_MOVE_SLOP) {
      cancel();
    }
  };

  const onClick = () => {
    if (firedRef.current) {
      firedRef.current = false;
      return;
    }
    onOpen();
  };

  return (
    <Button
      card
      data-tag-pin-chip
      data-pinned={pinned ? "true" : "false"}
      data-pin-surface={board ? "board" : "group"}
      data-pressing={pressing ? "true" : "false"}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={(event) => { event.preventDefault(); cancel(); onTogglePin(name); }}
      title={pinned ? "长按或右键取消置顶" : "长按或右键置顶标签"}
      className={`hg-tag-pill tag-pin-pill max-w-full min-w-0 text-left${isHot ? " is-hot" : ""}`}
    >
      <span className="hg-tag-hash">#</span>
      <span className="min-w-0 whitespace-normal break-all">{name}</span>
      {!!hotScore && <span aria-label={`热度 ${fmt(hotScore)}`} className="shrink-0 text-[11px] text-dim">{fmt(hotScore)}</span>}
    </Button>
  );
}

const TAG_DIR_CACHE = new Map<number, TagGroup[]>();

function filterNonEmptyTagGroups(raw: TagGroup[]): TagGroup[] {
  return raw
    .map((g) => ({
      ...g,
      tags: (g.tags ?? []).filter((t) => !(typeof t.video_count === "number" && Number.isFinite(t.video_count) && t.video_count <= 0)),
    }))
    .filter((g) => g.tags.length > 0);
}

export function TagsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, lineEpoch, toast } = useStore();
  const { preferences, isTagPinned, togglePinnedTag } = useContentPreferences();
  const [searching, setSearching] = useState(false);
  const cached = TAG_DIR_CACHE.get(lineEpoch);
  const [groups, setGroups] = useState(() => cached ?? []);
  const [loading, setLoading] = useState(() => !cached);
  const [err, setErr] = useState("");
  const seqRef = useRef(0);

  const load = useCallback(async (force = false) => {
    const token = ++seqRef.current;
    const hit = !force ? TAG_DIR_CACHE.get(lineEpoch) : undefined;
    if (hit) {
      setGroups(hit);
      setLoading(false);
      setErr("");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const res = await api.tags(force);
      if (token !== seqRef.current) return;
      const next = filterNonEmptyTagGroups(res?.categories ?? []);
      TAG_DIR_CACHE.set(lineEpoch, next);
      setGroups(next);
    } catch (error) {
      if (token !== seqRef.current) return;
      setErr(error instanceof Error ? error.message : "标签加载失败，请重试");
    } finally {
      if (token === seqRef.current) setLoading(false);
    }
  }, [lineEpoch]);

  useEffect(() => {
    void load(false);
    return () => { seqRef.current++; };
  }, [load]);

  const pinnedTags = preferences.pinnedTags;

  const togglePin = useCallback((name: string) => {
    const currentlyPinned = isTagPinned(name);
    if (!currentlyPinned && pinnedTags.length >= MAX_PINNED_TAGS) {
      toast(`最多置顶 ${MAX_PINNED_TAGS} 个标签`, "info", ACTION_TOAST_SLOT);
      return;
    }
    togglePinnedTag(name);
    toast(currentlyPinned ? `已取消置顶：${name}` : `已置顶标签：${name}`, currentlyPinned ? "info" : "ok", ACTION_TOAST_SLOT);
  }, [isTagPinned, pinnedTags.length, toast, togglePinnedTag]);

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar">
        <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
        <div className="hg-sub-titles">
          <h1 className="hg-sub-title">标签</h1>
          <p className="hg-sub-meta">按题材与话题检索内容</p>
        </div>
        <Button card onClick={() => setSearching(true)} aria-label="搜索短剧" className="hg-sub-btn"><ISearch size={17} /></Button>
        <Button card aria-label="刷新" disabled={loading} aria-busy={loading} onClick={() => void load(true)} className="hg-sub-btn">
          {loading ? <Loader className="w-4 h-4" /> : <IRefresh size={16} />}
        </Button>
      </header>

      <div className="flex-1 scroll-y hg-page-x pt-3 pb-8 relative" aria-busy={loading}>
        {groups.length > 0 && <RefreshStatus loading={loading} error={err} onRetry={() => void load(true)} />}
        {groups.length > 0 && (
          <section data-pin-board className="mb-4 rounded-[16px] p-3.5 a-rise" aria-label="置顶标签"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-[14px] font-bold text-on"><IPin size={14} className="text-primary" />置顶标签</h2>
              <span className="text-[12px] text-dim tabular-nums" aria-live="polite">{pinnedTags.length} 个</span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-mut">{pinnedTags.length ? "长按标签置顶，再长按取消" : "长按下方标签可置顶"}</p>
            {pinnedTags.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {pinnedTags.map(name => (
                  <TagPinChip key={name} name={name} pinned board onOpen={() => push({ kind: "tag", tag: name, name })} onTogglePin={togglePin} />
                ))}
              </div>
            )}
          </section>
        )}
        {loading && !groups.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !groups.length ? (
          <Empty icon={<TagIcon size={26} />} title="标签加载失败" sub={err} action="重试" onAction={() => void load(true)} />
        ) : groups.length ? (
          <div className={wide ? "grid grid-cols-2 gap-x-6 items-start" : ""}>{groups.map((g) => (
            <section key={g.name} className="mb-5 a-rise">
              <div className="flex items-center gap-2 mb-2.5">
                <h2 className="text-[14px] font-bold text-on">{g.name}</h2>
                <span className="text-[12px] text-dim">{g.tags?.length || 0} 个</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {g.tags.map((t) => (
                  <TagPinChip key={`${g.name}:${t.id}`} name={t.name} hotScore={t.hot_score} isHot={!!t.is_hot}
                    pinned={isTagPinned(t.name)} onOpen={() => push({ kind: "tag", tag: t.name, name: t.name })} onTogglePin={togglePin} />
                ))}
              </div>
            </section>
          ))}</div>
        ) : (
          <Empty icon={<TagIcon size={26} />} title="暂无标签" />
        )}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v) => push({ kind: "series", id: v.id })} />}
    </div>
  );
}

/* ================= 标签详情页（#标签铭牌 + 短剧/吃瓜一体玻璃滑块） ================= */
export function TagPage({ tag, name, onBack, wide }: { tag: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, lineEpoch, toast } = useStore();
  const { preferences, storageError, isTagBlocked, blockTags, unblockTag, isTagPinned, togglePinnedTag } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const tagBlocked = isTagBlocked(name);
  const tagPinned = isTagPinned(name);
  const togglePin = useCallback(() => {
    if (!tagPinned && preferences.pinnedTags.length >= MAX_PINNED_TAGS) {
      toast(`最多置顶 ${MAX_PINNED_TAGS} 个标签`, "info", ACTION_TOAST_SLOT);
      return;
    }
    togglePinnedTag(name);
    toast(tagPinned ? `已取消置顶：${name}` : `已置顶标签：${name}`, tagPinned ? "info" : "ok", ACTION_TOAST_SLOT);
  }, [name, preferences.pinnedTags.length, tagPinned, toast, togglePinnedTag]);
  const [statusFilter, setStatusFilter] = useState<SerializationStatusFilter>("all");
  const [metricSort, setMetricSort] = useState<VideoSortMetric>("default");
  const [metricDir, setMetricDir] = useState<VideoSortDirection>("desc");
  const toggleMetricSort = (key: VideoSortMetric) => {
    if (key === metricSort && key !== "default") setMetricDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setMetricSort(key); setMetricDir("desc"); }
  };
  const cannotAdd = !name.trim() || name.trim().length > MAX_TAG_LENGTH || preferences.blockedTags.length >= MAX_BLOCKED_TAGS;
  const [searching, setSearching] = useState(false);
  const [tabChoice, setTabChoice] = useState<"auto" | "video" | "post">("auto");
  const [videos, setVideos] = useState<VideoCard[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [videoPage, setVideoPage] = useState(0);
  const [postPage, setPostPage] = useState(0);
  const [videoPages, setVideoPages] = useState(1);
  const [postPages, setPostPages] = useState(1);
  const [videoTotal, setVideoTotal] = useState(0);
  const [postTotal, setPostTotal] = useState(0);
  const [videoLoading, setVideoLoading] = useState(true);
  const [postLoading, setPostLoading] = useState(true);
  const [videoErr, setVideoErr] = useState("");
  const [postErr, setPostErr] = useState("");
  const [loadedVideoTag, setLoadedVideoTag] = useState("");
  const [loadedPostTag, setLoadedPostTag] = useState("");
  const busy = useRef({ video: false, post: false });
  const sequence = useRef({ video: 0, post: 0 });
  const videoSentinel = useRef<HTMLDivElement>(null);
  const postSentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const currentVideos = loadedVideoTag === tag;
  const currentPosts = loadedPostTag === tag;
  const visibleVideos = currentVideos ? videos : [];
  const visiblePosts = currentPosts ? posts : [];
  const activeTab: "video" | "post" = tabChoice !== "auto"
    ? tabChoice
    : (currentVideos && currentPosts && !visibleVideos.length && visiblePosts.length > 0 ? "post" : "video");

  const load = useCallback(async (kind: "video" | "post", next: number, reset = false) => {
    if (busy.current[kind] && !reset) return;
    busy.current[kind] = true;
    const token = ++sequence.current[kind];
    if (kind === "video") { setVideoLoading(true); setVideoErr(""); }
    else { setPostLoading(true); setPostErr(""); }
    try {
      if (kind === "video") {
        const result = await api.tagVideos(tag, next, 20);
        if (sequence.current.video !== token) return;
        setVideos(previous => {
          const base = reset ? [] : previous;
          const seen = new Set(base.map(item => item.id));
          return [...base, ...(result?.items ?? []).filter(item => !seen.has(item.id))];
        });
        setLoadedVideoTag(tag); setVideoPage(next); setVideoPages(result?.pagination?.pages || next); setVideoTotal(result?.pagination?.total || 0);
      } else {
        const result = await api.postTag(name, next, 20);
        if (sequence.current.post !== token) return;
        setPosts(previous => {
          const base = reset ? [] : previous;
          const seen = new Set(base.map(item => item.id));
          return [...base, ...(result?.items ?? []).filter(item => !seen.has(item.id))];
        });
        setLoadedPostTag(tag); setPostPage(next); setPostPages(result?.pagination?.pages || next); setPostTotal(result?.pagination?.total || 0);
      }
    } catch (error) {
      if (sequence.current[kind] === token) {
        const message = error instanceof Error ? error.message : "加载失败，请重试";
        if (kind === "video") setVideoErr(message); else setPostErr(message);
      }
    } finally {
      if (sequence.current[kind] === token) {
        busy.current[kind] = false;
        if (kind === "video") setVideoLoading(false); else setPostLoading(false);
      }
    }
    /* 换线要重拉：标签下的短剧/吃瓜同样是线路数据（旧代码只按 tag/name 依赖） */
  }, [tag, name, lineEpoch]);
  useEffect(() => {
    sequence.current.video++; sequence.current.post++;
    busy.current.video = false; busy.current.post = false;
    setTabChoice("auto");
    setVideos([]); setPosts([]); setLoadedVideoTag(""); setLoadedPostTag("");
    setVideoPage(0); setPostPage(0); setVideoPages(1); setPostPages(1); setVideoTotal(0); setPostTotal(0);
    setVideoLoading(true); setPostLoading(true); setVideoErr(""); setPostErr(""); setSearching(false);
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    void load("video", 1, true);
    void load("post", 1, true);
    return () => { sequence.current.video++; sequence.current.post++; busy.current.video = false; busy.current.post = false; };
  }, [load, tag]);
  useEffect(() => {
    const el = videoSentinel.current;
    if (activeTab !== "video" || !el || filtering || videoErr || videoLoading || videoPage >= videoPages) return;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) void load("video", videoPage + 1);
    }, { root: scrollContainer.current, rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [activeTab, load, videoPage, videoPages, videoErr, videoLoading, filtering]);
  useEffect(() => {
    const el = postSentinel.current;
    if (activeTab !== "post" || !el || filtering || postErr || postLoading || postPage >= postPages) return;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) void load("post", postPage + 1);
    }, { root: scrollContainer.current, rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [activeTab, load, postPage, postPages, postErr, postLoading, filtering]);

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar relative">
        <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
        <div className="hg-sub-titles">
          <h1 className="hg-sub-title" title={name}>#{name}</h1>
          <div role="status" className="hg-sub-meta">短剧 {currentVideos ? videoTotal : 0} · 吃瓜 {currentPosts ? postTotal : 0}</div>
        </div>
        {visibleVideos.length > 0 && (
          <Button card className="hg-quick-action"
            onClick={() => push({ kind: "feed", videoIds: visibleVideos.map(v => v.id), index: 0, title: `#${name}` })}>
            <IBoltF size={13} /><span>连刷</span>
          </Button>
        )}
        <Button card onClick={togglePin} aria-pressed={tagPinned}
          aria-label={tagPinned ? "取消置顶此标签" : "置顶此标签"}
          title={tagPinned ? "取消置顶此标签" : "置顶此标签"}
          className="hg-sub-btn tag-page-pin">
          <IPinF size={17} className="tag-page-pin-icon" />
        </Button>
        <Button card onClick={() => setSearching(true)} aria-label="搜索短剧" className="hg-sub-btn"><ISearch size={17} /></Button>
      </header>

      <div ref={scrollContainer} className="flex-1 scroll-y hg-page-x pt-3 pb-8 relative" aria-busy={videoLoading || postLoading || !currentVideos || !currentPosts}>
        <section className="hg-tag-emblem" aria-label="标签偏好">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[14px] font-extrabold text-on"><span className="hg-tag-hash mr-0.5">#</span>{name}</div>
              <p className="mt-0.5 text-[12px] text-mut">{tagBlocked ? "此标签已加入屏蔽列表" : "不喜欢这类内容？可一键屏蔽整个标签"}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button card disabled={!tagBlocked && cannotAdd} aria-pressed={tagBlocked}
                onClick={() => tagBlocked ? unblockTag(name) : blockTags([name])}
                className={`hg-tag-pill${tagBlocked ? " is-on" : ""}`}>
                {tagBlocked ? "取消屏蔽此标签" : "屏蔽此标签"}
              </Button>
              <Button card className="hg-tag-pill" onClick={() => push({ kind: "settings-tags" })}>管理屏蔽标签</Button>
            </div>
          </div>
          {preferences.paused && <p role="status" className="mt-2 text-[12px] text-mut">屏蔽已暂停，新增标签会保存，恢复后生效。</p>}
          {!tagBlocked && cannotAdd && <p role="status" className="mt-2 text-[12px] text-mut">{name.trim().length > MAX_TAG_LENGTH ? "标签过长，请在内容偏好中管理。" : `已达到 ${MAX_BLOCKED_TAGS} 个标签上限。`}</p>}
          {storageError && <p role="alert" className="mt-2 text-[13px] text-danger">{storageError}</p>}
        </section>

        <SegmentedControl className="hg-seg-track mb-3.5" role="tablist" aria-label="标签内容分类" activeIndex={activeTab === "video" ? 0 : 1}>
          <Button role="tab" aria-selected={activeTab === "video"} className="ios-segmented-item"
            onClick={() => setTabChoice("video")}>短剧 ({currentVideos ? videoTotal : 0})</Button>
          <Button role="tab" aria-selected={activeTab === "post"} className="ios-segmented-item"
            onClick={() => setTabChoice("post")}>吃瓜 ({currentPosts ? postTotal : 0})</Button>
        </SegmentedControl>

        {activeTab === "video" ? (
          <>
            {visibleVideos.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="筛选与排序">
                {SERIALIZATION_FILTER_OPTIONS.map((opt) => (
                  <Button key={opt.key} card aria-pressed={statusFilter === opt.key}
                    onClick={() => setStatusFilter(opt.key)}
                    className={`hg-tag-pill${statusFilter === opt.key ? " is-on" : ""}`}>
                    {opt.label}
                  </Button>
                ))}
                <span aria-hidden="true" className="mx-0.5 text-dim text-[12px]">|</span>
                {VIDEO_SORT_OPTIONS.map((opt) => {
                  const active = metricSort === opt.key;
                  return (
                    <Button key={opt.key} card aria-pressed={active}
                      onClick={() => toggleMetricSort(opt.key)}
                      className={`hg-tag-pill${active ? " is-on" : ""}`}>
                      {opt.label}{active && opt.key !== "default" ? (metricDir === "desc" ? " ↓" : " ↑") : ""}
                    </Button>
                  );
                })}
              </div>
            )}
            {videoLoading && !visibleVideos.length && <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>}
            {videoErr && !visibleVideos.length && <Empty icon={<TagIcon size={26} />} title="短剧加载失败" sub={videoErr} action="重试" onAction={() => void load("video", 1, true)} />}
            {(() => {
              const displayVideos = sortVideosByMetric(filterVideosByStatus(visibleVideos, statusFilter), metricSort, metricDir);
              if (displayVideos.length > 0) {
                return <Masonry videos={displayVideos} scopeKey={`tag-video:${tag}:${statusFilter}:${metricSort}:${metricDir}`} wide={wide} onOpen={(v) => push({ kind: "series", id: v.id })} />;
              }
              if (visibleVideos.length > 0) {
                return <Empty icon={<TagIcon size={26} />} title="当前连载状态下暂无短剧" sub="可切换为「全部」查看全部结果" action="查看全部" onAction={() => setStatusFilter("all")} />;
              }
              return null;
            })()}
            <div ref={videoSentinel} className="h-2" />
            {videoErr && visibleVideos.length > 0 && <div role="status" className="flex flex-wrap items-center justify-center gap-2 py-2 text-[12px] text-mut"><span>短剧加载失败：{videoErr}</span><Button onClick={() => void load("video", videoPage + 1)} className="px-3 text-primary">重试</Button></div>}
            {videoLoading && visibleVideos.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
            {!videoLoading && !videoErr && videoPage < videoPages && <Button card onClick={() => void load("video", videoPage + 1)} className="hg-loadmore">加载更多短剧</Button>}
            {!videoLoading && !videoErr && !visibleVideos.length && (
              <Empty icon={<TagIcon size={26} />} title="该标签下暂无短剧"
                sub={visiblePosts.length > 0 ? `该标签下有 ${postTotal} 篇吃瓜帖子` : undefined}
                action={visiblePosts.length > 0 ? "查看吃瓜帖" : undefined}
                onAction={visiblePosts.length > 0 ? () => setTabChoice("post") : undefined} />
            )}
          </>
        ) : (
          <>
            {postLoading && !visiblePosts.length && <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>}
            {postErr && !visiblePosts.length && <Empty icon={<TagIcon size={26} />} title="吃瓜帖子加载失败" sub={postErr} action="重试" onAction={() => void load("post", 1, true)} />}
            {visiblePosts.length > 0 && (
              <FilteredContent items={visiblePosts} scopeKey={`tag-post:${tag}`}>{shownPosts => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                {shownPosts.map(post => <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={post.tags?.slice(0, 2).join(" · ")} onOpen={() => push({ kind: "post", id: post.id })} />)}
              </div>}</FilteredContent>
            )}
            <div ref={postSentinel} className="h-2" />
            {postErr && visiblePosts.length > 0 && <div role="status" className="flex flex-wrap items-center justify-center gap-2 py-2 text-[12px] text-mut"><span>吃瓜加载失败：{postErr}</span><Button onClick={() => void load("post", postPage + 1)} className="px-3 text-primary">重试</Button></div>}
            {postLoading && visiblePosts.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
            {!postLoading && !postErr && postPage < postPages && <Button card onClick={() => void load("post", postPage + 1)} className="hg-loadmore">加载更多吃瓜</Button>}
            {!postLoading && !postErr && !visiblePosts.length && (
              <Empty icon={<TagIcon size={26} />} title="该标签下暂无吃瓜帖子"
                sub={visibleVideos.length > 0 ? `该标签下有 ${videoTotal} 部短剧` : undefined}
                action={visibleVideos.length > 0 ? "查看短剧" : undefined}
                onAction={visibleVideos.length > 0 ? () => setTabChoice("video") : undefined} />
            )}
          </>
        )}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v) => push({ kind: "series", id: v.id })} />}
    </div>
  );
}
