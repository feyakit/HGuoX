import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Paged, UserProfile, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import {
  filterVideosByStatus, SERIALIZATION_FILTER_OPTIONS, sortVideosByMetric, VIDEO_SORT_OPTIONS,
  type SerializationStatusFilter, type VideoSortDirection, type VideoSortMetric,
} from "../../shared/model/videoSort";
import { Masonry } from "../../shared/ui/cards";
import { InplaceSearch } from "../search/InplaceSearch";
import { Avatar, Empty } from "../../shared/ui/ui";
import { IBack, IBoltF, IChevronDown, IGrid, IPlayF, ISearch, IUser } from "../../shared/ui/icons";

/** Keep pagination local to the scrolling page and reject responses from an old account/author. */
function useUserVideos(enabled: boolean, request: (page: number) => Promise<Paged<VideoCard>>) {
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const cursor = useRef({ page: 0, pages: 1, busy: false });
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useCallback(async () => {
    const state = cursor.current;
    if (!enabled || state.busy || state.page >= state.pages) return;
    const version = generation.current;
    const next = state.page + 1;
    state.busy = true;
    setLoading(true); setErr("");
    try {
      const response = await request(next);
      if (version !== generation.current) return;
      const incoming = response?.items || [];
      setItems(previous => {
        const seen = new Set(previous.map(item => item.id));
        const unique = incoming.filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
        return [...previous, ...unique];
      });
      state.page = next;
      state.pages = response?.pagination?.pages || next;
      setTotal(Number.isFinite(response?.pagination?.total) ? response.pagination.total : null);
      setHasMore(next < state.pages && incoming.length > 0);
      if (!incoming.length) state.pages = next;
    } catch (error) {
      if (version === generation.current) setErr(error instanceof Error ? error.message : "加载失败，请重试");
    } finally {
      if (version === generation.current) { state.busy = false; setLoading(false); }
    }
  }, [enabled, request]);
  useEffect(() => {
    generation.current++;
    cursor.current = { page: 0, pages: 1, busy: false };
    setItems([]); setErr(""); setTotal(null); setHasMore(false); setLoading(false);
    if (scroller.current) scroller.current.scrollTop = 0;
    if (enabled) void loadMore();
    return () => { generation.current++; };
  }, [enabled, loadMore]);
  useEffect(() => {
    if (!enabled || filtering || loading || err || !hasMore || !sentinel.current || !scroller.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) void loadMore();
    }, { root: scroller.current, rootMargin: "200px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [enabled, loading, err, hasMore, loadMore, filtering]);
  return { items, loading, err, total, hasMore, loadMore, scroller, sentinel };
}

type VideoState = ReturnType<typeof useUserVideos>;
function PaginationFeedback({ state }: { state: VideoState }) {
  if (!state.items.length) return null;
  return <>
    {state.err && <div role="status" className="mt-3 rounded-(--r-md) bg-s2 p-3 text-[13px]">
      <p className="font-semibold">加载更多失败</p><p className="mt-1 break-words text-mut">{state.err}</p>
      <Button onClick={() => void state.loadMore()} className="mt-2 px-4 text-primary">重试</Button>
    </div>}
    {state.loading ? <div className="flex justify-center py-3"><Loader label="加载更多作品" /></div>
      : !state.err && state.hasMore ? <Button card onClick={() => void state.loadMore()} className="hg-loadmore">加载更多</Button>
      : !state.err && <p className="py-3 text-center text-[12px] text-mut">— 已展示全部作品 —</p>}
    <div ref={state.sentinel} className="h-8" aria-hidden="true" />
  </>;
}
const countLabel = ({ items, total }: VideoState) => `已加载 ${items.length}${total === null ? "" : ` / ${total}`} 部`;

export function FollowingPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <FollowingContent key={`${accountScope}:${lineEpoch}`} onBack={onBack} wide={wide} />;
}

function FollowingContent({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, user, follows, accountSync, setLoginOpen, setTab, accountScope } = useStore();
  const [searching, setSearching] = useState(false);
  const [creators, setCreators] = useState<Record<number, UserProfile>>({});
  const followSlice = useMemo(() => follows.slice(0, 24), [follows]);
  const followSet = useMemo(() => new Set(follows), [follows]);
  const followsKey = followSlice.join(",");
  const confirmedEmptyFollows = !!user && accountSync.favoritesKnown && follows.length === 0;

  useEffect(() => {
    if (!user || !followSlice.length) return;
    let alive = true;
    const missing = followSlice.filter(uid => !creators[uid]);
    if (!missing.length) return;
    void Promise.allSettled(missing.map(uid => api.user(uid).then(profile => ({ uid, profile })))).then(results => {
      if (!alive) return;
      const next: Record<number, UserProfile> = {};
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.profile) {
          next[result.value.uid] = result.value.profile;
        }
      }
      if (Object.keys(next).length) setCreators(prev => ({ ...prev, ...next }));
    });
    return () => { alive = false; };
  }, [user, followsKey]);

  // Identity belongs in the dependency list: switching accounts discards the previous feed.
  const request = useCallback((page: number) => api.following(page, 20), [accountScope]);
  const state = useUserVideos(!!user && !confirmedEmptyFollows, request);
  /* 兜底校验：若接口返回了非已关注作者的视频（如站点回落全站流），前端按 follows 过滤。 */
  const visibleItems = useMemo(() => {
    if (!follows.length) return confirmedEmptyFollows ? [] : state.items;
    return state.items.filter(item => !item.author?.id || followSet.has(item.author.id));
  }, [state.items, follows.length, confirmedEmptyFollows, followSet]);

  return <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
    <span className="hg-aura" aria-hidden="true" />
    <header className="shrink-0 hg-subpage-bar relative z-10">
      <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
      <div className="hg-sub-titles">
        <h1 className="hg-sub-title">关注</h1>
        {user && <p className="hg-sub-meta" role="status">{follows.length > 0 ? `已关注 ${follows.length} 人 · ` : ""}{countLabel({ ...state, items: visibleItems, total: visibleItems.length === state.items.length ? state.total : null })}</p>}
      </div>
      {user && visibleItems.length > 0 && (
        <Button card className="hg-quick-action"
          onClick={() => push({ kind: "feed", videoIds: visibleItems.map(item => item.id), index: 0, title: "关注" })}>
          <IBoltF size={13} /><span>连刷关注</span>
        </Button>
      )}
      <Button card onClick={() => setSearching(true)} aria-label="搜索短剧" className="hg-sub-btn"><ISearch size={17} /></Button>
    </header>
    <div ref={state.scroller} className="flex-1 scroll-y hg-page-x pt-3 pb-8 relative z-10">
      {!user ? <Empty icon={<IUser size={26} />} title="登录后查看关注流" sub="关注喜欢的作者，第一时间看到他们的新作品" action="去登录" onAction={() => setLoginOpen(true)} /> : <>
        {followSlice.length > 0 && (
          <Surface role="region" aria-label="已关注创作者" className="mb-4 rounded-(--r-md) bg-s1 p-3.5">
            <div className="flex items-center justify-between mb-2.5">
              <h2 className="text-[13px] font-semibold text-on/90">已关注创作者</h2>
              <span className="text-[12px] text-mut">共 {follows.length} 位</span>
            </div>
            <div className="scroll-x flex gap-3 snap-x">
              {followSlice.map(uid => {
                const info = creators[uid];
                const label = info?.nickname || `用户 ${uid}`;
                return (
                  <Button key={uid} onClick={() => push({ kind: "user", id: uid, name: info?.nickname })}
                    className="w-[68px] shrink-0 flex flex-col items-center gap-1.5 snap-start pressable"
                    aria-label={`进入 ${label} 主页`}>
                    <Avatar size={48} name={label} hue={(uid * 47) % 360} ring />
                    <span className="w-full text-[12px] text-on/85 text-center truncate">{label}</span>
                  </Button>
                );
              })}
            </div>
          </Surface>
        )}
        {state.loading && !visibleItems.length ? <div className="flex justify-center py-12"><Loader /></div>
          : state.err && !visibleItems.length ? <Empty icon={<IGrid size={26} />} title="关注流加载失败" sub={state.err} action="重试" onAction={() => void state.loadMore()} />
          : visibleItems.length ? <>
            {followSlice.length > 0 && <h2 className="mb-2.5 text-[14px] font-bold text-on">最新动态</h2>}
            <Masonry videos={visibleItems} scopeKey={`following:${accountScope}`} wide={wide} onOpen={video => push({ kind: "series", id: video.id })} />
          </>
          : follows.length > 0 ? <Empty icon={<IGrid size={26} />} title="关注的创作者暂未发布新剧" sub="可点击上方头像进入创作者主页查看，或去分类发现更多作品。" action="去分类看看" onAction={() => { onBack(); setTab("category"); }} />
          : <Empty icon={<IGrid size={26} />} title="还没有关注内容" sub="在首页、分类或吃瓜中发现内容，关注喜欢的作者。" action="去分类看看" onAction={() => { onBack(); setTab("category"); }} />}
        {!confirmedEmptyFollows && <PaginationFeedback state={state} />}
      </>}
    </div>
    {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v) => push({ kind: "series", id: v.id })} />}
  </div>;
}

export function UserPage({ id, name, onBack, wide }: { id: number; name?: string; onBack: () => void; wide: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <UserContent key={`${accountScope}:${lineEpoch}:${id}`} id={id} name={name} onBack={onBack} wide={wide} />;
}

function UserContent({ id, name, onBack, wide }: { id: number; name?: string; onBack: () => void; wide: boolean }) {
  const { push, toast, follows, setFollowing, actionPending, accountScope, user, setLoginOpen } = useStore();
  const [searching, setSearching] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.userStats>> | null>(null);
  const [infoError, setInfoError] = useState("");
  const [infoLoading, setInfoLoading] = useState(true);
  const [infoReload, setInfoReload] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState("");
  const followPending = useRef(false);
  const context = useRef({ id, accountScope });
  context.current = { id, accountScope };
  const mounted = useRef(false);
  const followVersion = useRef(0);
  const request = useCallback((page: number) => api.userVideos(id, page, 20), [id]);
  const state = useUserVideos(true, request);
  const [sortMetric, setSortMetric] = useState<VideoSortMetric>("default");
  const [sortDir, setSortDir] = useState<VideoSortDirection>("desc");
  const [statusFilter, setStatusFilter] = useState<SerializationStatusFilter>("all");
  const displayItems = useMemo(
    () => sortVideosByMetric(filterVideosByStatus(state.items, statusFilter), sortMetric, sortDir),
    [state.items, statusFilter, sortMetric, sortDir],
  );
  const pickMetric = (metric: VideoSortMetric) => {
    if (metric === "default") { setSortMetric("default"); setSortDir("desc"); return; }
    if (sortMetric === metric) { setSortDir(d => d === "desc" ? "asc" : "desc"); return; }
    setSortMetric(metric);
    setSortDir("desc");
  };

  useEffect(() => {
    mounted.current = true;
    followVersion.current++; followPending.current = false;
    setFollowBusy(false); setFollowError("");
    return () => { mounted.current = false; followVersion.current++; };
  }, [id, accountScope]);
  useEffect(() => { setProfile(null); setStats(null); setSortMetric("default"); setSortDir("desc"); setStatusFilter("all"); }, [id]);
  useEffect(() => {
    let alive = true;
    setInfoLoading(true); setInfoError("");
    Promise.allSettled([api.user(id), api.userStats(id)]).then(([profileResult, statsResult]) => {
      if (!alive) return;
      if (profileResult.status === "fulfilled") setProfile(profileResult.value);
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      const failures = [profileResult, statsResult].filter(result => result.status === "rejected") as PromiseRejectedResult[];
      if (failures.length) setInfoError(failures.map(result => result.reason instanceof Error ? result.reason.message : "资料加载失败").filter((value, index, all) => all.indexOf(value) === index).join("；"));
      setInfoLoading(false);
    });
    return () => { alive = false; };
  }, [id, infoReload]);

  const following = follows.includes(id);
  const onFollow = async () => {
    if (followPending.current || actionPending(`follow:${id}`)) return;
    if (!user) { setLoginOpen(true); return; }
    const version = ++followVersion.current;
    const on = !following;
    followPending.current = true; setFollowBusy(true); setFollowError("");
    const current = () => mounted.current && followVersion.current === version && context.current.id === id && context.current.accountScope === accountScope;
    try {
      await setFollowing(id, on);
      if (!current()) return;
      toast(on ? `已关注 ${profile?.nickname || name || ""}` : "已取消关注", on ? "ok" : "info");
    } catch (error) {
      if (current()) setFollowError(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      if (current()) { followPending.current = false; setFollowBusy(false); }
    }
  };
  const stat = (value: number | undefined) => value === undefined ? "—" : fmt(value);

  return <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
    <span className="hg-aura" aria-hidden="true" />
    <header className="shrink-0 hg-subpage-bar relative z-10">
      <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
      <div className="hg-sub-titles">
        <h1 className="hg-sub-title">{profile?.nickname || name || "用户主页"}</h1>
        <p className="hg-sub-meta">创作者空间 · ID {id}</p>
      </div>
      <Button card onClick={() => setSearching(true)} aria-label="搜索短剧" className="hg-sub-btn"><ISearch size={17} /></Button>
    </header>
    <div ref={state.scroller} className="flex-1 scroll-y hg-page-x pt-3 pb-8 relative z-10">
      <section className="hg-creator-card a-rise" aria-label="创作者资料">
        <div className="flex items-center gap-3.5">
          <Avatar size={58} name={profile?.nickname || name || "U"} hue={220} ring />
          <div className="flex-1 min-w-0">
            <p className="text-[17px] font-extrabold text-on break-words">{profile?.nickname || name || (infoLoading ? "正在读取资料…" : "用户资料暂不可用")}</p>
            {profile?.username && <p className="text-[12px] text-mut mt-0.5 break-words">@{profile.username} · ID {id}</p>}
          </div>
          <Button card onClick={() => void onFollow()} disabled={followBusy || actionPending(`follow:${id}`)} aria-busy={followBusy || actionPending(`follow:${id}`)} aria-pressed={following}
            className="shrink-0 px-4 text-[13px] font-bold"
            style={{
              height: 36,
              borderRadius: 11,
              background: following ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg, #FF7A59 0%, #7C5CFF 100%)",
              border: following ? "1px solid rgba(255,255,255,0.12)" : "none",
              color: following ? "#A5AAC4" : "#fff",
            }}>
            {followBusy || actionPending(`follow:${id}`) ? "处理中…" : following ? "已关注" : "+ 关注"}
          </Button>
        </div>

        <div className="mt-3.5 pt-3 flex flex-wrap items-center justify-between gap-3" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-mut" aria-busy={infoLoading}>
            <span className="whitespace-nowrap">作品 <b className="text-on text-[14px]">{stat(stats?.video_count)}</b></span>
            <span className="whitespace-nowrap">粉丝 <b className="text-on text-[14px]">{stat(stats?.followers)}</b></span>
            <span className="whitespace-nowrap">获赞 <b className="text-on text-[14px]">{stat(stats?.like_count)}</b></span>
          </div>
          {displayItems.length > 0 && (
            <Button card className="hg-quick-action"
              onClick={() => push({ kind: "feed", videoIds: displayItems.map(x => x.id), index: 0, title: profile?.nickname || name || "用户作品" })}>
              <IPlayF size={12} /><span>连刷TA的作品</span>
            </Button>
          )}
        </div>

        {profile?.sign && (
          <details className="group mt-3 text-[12px] text-mut">
            <summary className="cursor-pointer py-1 flex items-center gap-1.5 text-on font-semibold">
              作者简介<IChevronDown size={15} className="group-open:rotate-180" />
            </summary>
            <p className="mt-1 leading-relaxed whitespace-pre-wrap break-words">{profile.sign}</p>
          </details>
        )}
        {followError && <p role="alert" className="mt-3 text-[13px] text-danger break-words">{followError}。关注状态未更改，请重试。</p>}
      </section>

      {infoError && <div role="status" className="mt-3 rounded-(--r-md) bg-s2 p-3 text-[13px]">
        <p className="font-semibold">资料信息未完整加载</p><p className="mt-1 text-mut break-words">{infoError}</p>
        <Button disabled={infoLoading} onClick={() => setInfoReload(value => value + 1)} className="mt-2 px-3 text-primary">重试资料</Button>
      </div>}

      <div className="mt-4 mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-extrabold text-on">TA 的作品</h2>
        <p role="status" className="text-[12px] text-mut">{countLabel({ ...state, items: displayItems, total: statusFilter === "all" ? state.total : null })}</p>
      </div>
      {state.items.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="作品指标排序">
            {VIDEO_SORT_OPTIONS.map(opt => {
              const activeOpt = sortMetric === opt.key;
              return (
                <Button key={opt.key} card aria-pressed={activeOpt}
                  className={`hg-tag-pill ${activeOpt ? "is-on" : ""}`}
                  onClick={() => pickMetric(opt.key)}>
                  {opt.label}{activeOpt && opt.key !== "default" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                </Button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="连载状态筛选">
            {SERIALIZATION_FILTER_OPTIONS.map(opt => (
              <Button key={opt.key} card aria-pressed={statusFilter === opt.key}
                className={`hg-tag-pill ${statusFilter === opt.key ? "is-on" : ""}`}
                onClick={() => setStatusFilter(opt.key)}>
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      {state.loading && !state.items.length ? <div className="flex justify-center py-12"><Loader /></div>
        : state.err && !state.items.length ? <Empty icon={<IGrid size={26} />} title="作品加载失败" sub={state.err} action="重试" onAction={() => void state.loadMore()} />
        : displayItems.length ? <Masonry videos={displayItems} scopeKey={`${id}:${sortMetric}:${sortDir}:${statusFilter}`} wide={wide} onOpen={v => push({ kind: "series", id: v.id })} />
        : state.items.length > 0 && statusFilter !== "all" ? <Empty icon={<IGrid size={26} />} title="当前筛选下暂无作品" sub="切换其他状态或查看全部作品" action="查看全部" onAction={() => setStatusFilter("all")} />
        : <Empty icon={<IGrid size={26} />} title="暂无作品" />}
      <PaginationFeedback state={state} />
    </div>
    {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v) => push({ kind: "series", id: v.id })} />}
  </div>;
}
