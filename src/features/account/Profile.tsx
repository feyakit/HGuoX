import { Button, SegmentedControl } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useRef, useState, useMemo } from "react";
import { api, fmtTime } from "../../shared/api/api";
import type { Detail, Post } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { Empty, Img, Modal } from "../../shared/ui/ui";
import { MediaCard } from "../../shared/ui/cards";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { detailEpisodeCount, filterFavoriteVideoIds, formatWatchProgress, unwatchedEpisodeCount, unwatchedNewEpisodes, type FavoriteFilter } from "../../shared/model/favoriteProgress";
import { IBack, IBoltF, ICheck, IChevR, IClock, IMenuFollow, IMenuHistory, IMenuLikes, IPlayF, ISettings, IStar } from "../../shared/ui/icons";
import { useVisibilityRefresh } from "../../shared/lib/dataFreshness";
import { useLongPress } from "../../shared/lib/useLongPress";
import { useTabSwipe } from "../../shared/lib/useTabSwipe";
import { useAutoLoadMore } from "./useAutoLoadMore";

function GuestCatAvatar() {
  return (
    <svg viewBox="0 0 72 72" width="100%" height="100%" aria-hidden="true">
      <defs>
        <linearGradient id="cat-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
      <circle cx="36" cy="36" r="36" fill="url(#cat-sky)" />
      {/* Black cat silhouette */}
      <path d="M20 58c0-11 7-18 16-18s16 7 16 18Z" fill="#0B0C14" />
      <path d="M21 20l4 13c3-2 7-3 11-3s8 1 11 3l4-13 6 15c1 7-4 15-17 15s-18-8-17-15Z" fill="#0B0C14" />
      <circle cx="29" cy="36" r="2.6" fill="#FDE047" />
      <circle cx="43" cy="36" r="2.6" fill="#FDE047" />
      <circle cx="29.6" cy="35.6" r="1.1" fill="#0B0C14" />
      <circle cx="43.6" cy="35.6" r="1.1" fill="#0B0C14" />
    </svg>
  );
}

/* Account changes discard cached details synchronously, before another account can paint. */
export default function Profile({ wide }: { wide: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <ProfileContent key={`${accountScope}:${lineEpoch}`} wide={wide} />;
}

function ProfileContent({ wide: _wide }: { wide: boolean }) {
  const { user, setLoginOpen, history, postHistory, favs, postFavs, follows, push, accountSync, syncAccount, guestKept, guestSnapshot } = useStore();
  const [recentDetails, setRecentDetails] = useState<Record<number, Detail>>({});
  const [recentFailed, setRecentFailed] = useState<Record<number, boolean>>({});
  const recentDetailsRef = useRef(recentDetails);
  recentDetailsRef.current = recentDetails;
  /* 选过「暂不同步」：账号里没有的本机记录也照常显示，并标「本机」来源 */
  const localRows = useMemo(() => {
    if (!guestKept) return [];
    const known = new Set(history.map((h) => h.id));
    return guestSnapshot().history.filter((h) => Number.isSafeInteger(h.id) && h.id > 0 && !known.has(h.id));
  }, [guestKept, guestSnapshot, history]);
  const recentRows = useMemo(() => {
    const rows = [...history];
    for (const row of localRows) if (!rows.some((h) => h.id === row.id)) rows.push(row);
    return rows.slice(0, 8);
  }, [history, localRows]);
  const recentIdsKey = recentRows.map((h) => h.id).join(",");
  useEffect(() => {
    const ids = recentIdsKey ? recentIdsKey.split(",").map(Number).filter(Boolean) : [];
    const missing = ids.filter((id) => !recentDetailsRef.current[id]);
    if (!missing.length) return;
    let alive = true;
    void Promise.allSettled(missing.map((id) => api.video(id))).then((res) => {
      if (!alive) return;
      const next: Record<number, Detail> = {};
      const failed: Record<number, boolean> = {};
      res.forEach((r, idx) => {
        if (r.status === "fulfilled" && r.value) next[missing[idx]] = r.value;
        else failed[missing[idx]] = true;
      });
      if (Object.keys(next).length) setRecentDetails((m) => ({ ...m, ...next }));
      if (Object.keys(failed).length) setRecentFailed((m) => ({ ...m, ...failed }));
    });
    return () => { alive = false; };
  }, [recentIdsKey]);
  const [stats, setStats] = useState<{ followers: number; post_count: number; video_count: number } | null>(null);

  useEffect(() => {
    if (!user?.id) { setStats(null); return; }
    let alive = true;
    api.userStats(user.id).then((res) => {
      if (alive && res) setStats({ followers: res.followers ?? 0, post_count: res.post_count ?? 0, video_count: res.video_count ?? 0 });
    }).catch(() => {});
    return () => { alive = false; };
  }, [user?.id]);

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <h1 className="sr-only">我的</h1>

      <div className="ios-page-body flex-1 scroll-y hg-page-x relative z-10"
        style={{ paddingBottom: "calc(110px + var(--sab, 0px))" }}>
        {/* Page 4 资料头：72px 头像 + 昵称 / ID + 右齿轮（唯一设置入口） */}
        <div className="hg-profile-head a-rise">
          {user ? (
            <Button card className="hg-profile-guest" onClick={() => push({ kind: "user", id: user.id, name: user.nickname })}>
              <span className="hg-profile-avatar">
                {user.avatar ? <Img src={user.avatar} eager /> : <GuestCatAvatar />}
              </span>
              <span className="hg-profile-meta">
                <span className="hg-profile-name">{user.nickname || user.username}</span>
                <span className="hg-profile-sub">ID:{user.id}</span>
              </span>
            </Button>
          ) : (
            <Button card className="hg-profile-guest" aria-label="未登录，点击登录"
              onClick={() => setLoginOpen(true)}>
              <span className="hg-profile-avatar is-guest"><GuestCatAvatar /></span>
              <span className="hg-profile-meta">
                <span className="hg-profile-name">未登录</span>
                <span className="hg-profile-sub">点击登录同步收藏与观看记录</span>
              </span>
            </Button>
          )}
          <Button card className="hg-sub-btn" aria-label="打开设置"
            onClick={() => push({ kind: "settings" })}><ISettings size={20} strokeWidth={1.7} /></Button>
        </div>

        {/* 3 列数据统计：仅已登录时展示，避免游客态出现无意义的 0/0/0 */}
        {user && (
          <div className="hg-profile-stats">
            <Button card className="hg-profile-stat" onClick={() => push({ kind: "following" })}>
              <span className="hg-profile-stat-num">{follows.length}</span>
              <span className="hg-profile-stat-lbl">关注</span>
            </Button>
            <Button card className="hg-profile-stat" onClick={() => push({ kind: "user", id: user.id, name: user.nickname })}>
              <span className="hg-profile-stat-num">{stats?.followers ?? user?.counts?.followers ?? user?.counts?.follower_count ?? 0}</span>
              <span className="hg-profile-stat-lbl">粉丝</span>
            </Button>
            <Button card className="hg-profile-stat" onClick={() => push({ kind: "user", id: user.id, name: user.nickname })}>
              <span className="hg-profile-stat-num">
                {stats ? (stats.post_count ?? 0) + (stats.video_count ?? 0) : ((user?.counts?.posts ?? user?.counts?.post_count ?? 0) + (user?.counts?.videos ?? 0))}
              </span>
              <span className="hg-profile-stat-lbl">作品</span>
            </Button>
          </div>
        )}

        {!user && (
          <Button card className="hg-profile-login-cta" onClick={() => setLoginOpen(true)}>
            登录 / 注册
          </Button>
        )}

        {user && accountSync.error && <div role="alert" className="mt-3 rounded-(--r-sm) bg-s3 p-3 text-[13px]">
          <p className="text-danger break-words">{accountSync.error}</p>
          <Button disabled={accountSync.busy} onClick={() => { void syncAccount().catch(() => {}); }}
            className="mt-1 min-h-11 px-3 text-on">{accountSync.busy ? "正在重试…" : "重试同步"}</Button>
        </div>}

        {/* 快捷功能双列玻璃卡片（置于最近观看上方，方便直达收藏与关注） */}
        <div className="hg-profile-quick">
          <Button card className="hg-quick-card" aria-label="我的收藏" onClick={() => push({ kind: "favorites" })}>
            <span className="hg-quick-icon is-fav"><IMenuLikes size={19} strokeWidth={1.85} /></span>
            <span className="hg-quick-copy">
              <span className="hg-quick-title">我的收藏</span>
              <span className="hg-quick-sub">{favs.length + postFavs.length} 项内容</span>
            </span>
            <IChevR size={14} className="hg-menu-chevron" />
          </Button>
          <Button card className="hg-quick-card" aria-label="我的关注" onClick={() => user ? push({ kind: "following" }) : setLoginOpen(true)}>
            <span className="hg-quick-icon is-follow"><IMenuFollow size={19} strokeWidth={1.85} /></span>
            <span className="hg-quick-copy">
              <span className="hg-quick-title">我的关注</span>
              <span className="hg-quick-sub">{user ? `${follows.length} 位创作者` : "登录后同步"}</span>
            </span>
            <IChevR size={14} className="hg-menu-chevron" />
          </Button>
        </div>

        {/* 最近观看：直接展示在个人中心，一键续播 */}
        <section className="hg-profile-recent" aria-label="最近观看">
          <div className="hg-profile-sec-head">
            <span className="hg-profile-sec-title">
              <IMenuHistory size={16} strokeWidth={1.85} />
              <span>最近观看</span>
              {guestKept && recentRows.length > 0 && (
                <span className="hg-profile-sec-src" title="用户选择暂不同步，这份记录只在本机">本机记录</span>
              )}
              {(history.length + postHistory.length) > 0 && (
                <span className="hg-profile-sec-count">{history.length + postHistory.length}</span>
              )}
            </span>
            <Button className="hg-section-more" aria-label="观看历史" onClick={() => push({ kind: "history" })}>
              全部 <IChevR size={12} />
            </Button>
          </div>

          {recentRows.length > 0 ? (
            <div className="hg-recent-rail">
              {recentRows.map((h) => {
                const detail = recentDetails[h.id];
                const pct = h.dur && h.t ? Math.min(100, Math.max(4, Math.round((h.t / h.dur) * 100))) : 0;
                return (
                  <Button
                    key={h.id}
                    card
                    className="hg-recent-card"
                    aria-label={`继续观看 ${detail?.title || `第 ${h.ep} 集`}`}
                    onClick={() => push({ kind: "feed", videoIds: [h.id], index: 0, title: detail?.title || "继续观看", startEp: h.ep, startTime: h.t })}
                  >
                    <div className="hg-recent-thumb">
                      {detail?.cover ? (
                        <Img src={detail.cover} alt="" />
                      ) : (
                        <div className="hg-recent-skeleton shimmer" />
                      )}
                      <span className="hg-recent-ep">第 {h.ep} 集</span>
                      <span className="hg-recent-play" aria-hidden="true"><IPlayF size={12} /></span>
                      {pct > 0 && (
                        <span className="hg-recent-progress" aria-hidden="true">
                          <span style={{ width: `${pct}%` }} />
                        </span>
                      )}
                    </div>
                    <div className="hg-recent-title">{detail?.title || (recentFailed[h.id] ? `短剧 #${h.id}` : "加载中…")}</div>
                    <div className="hg-recent-sub">
                      {h.t > 3 ? `续播 ${fmtTime(h.t)}` : "刚看过"}
                      {localRows.some((row) => row.id === h.id) && (
                        <span className="hg-recent-src" title="只有本机有这条记录（未同步到账号）"> · 本机</span>
                      )}
                    </div>
                  </Button>
                );
              })}
            </div>
          ) : postHistory.length > 0 ? (
            <Button card className="hg-recent-empty-card" onClick={() => push({ kind: "history" })}>
              <span>已浏览 {postHistory.length} 篇吃瓜记录</span>
              <IChevR size={14} className="text-mut" />
            </Button>
          ) : (
            <div className="hg-recent-empty">暂无观看记录 · 去首页刷剧会自动记录进度</div>
          )}
        </section>

        {/* 退出登录已搬到「设置 → 账号」，版本号只在「设置 → 关于」显示一次 */}
      </div>

    </div>
  );
}

/* ================= 二级栈页：观看历史 ================= */
export function HistoryPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <HistoryContent key={`${accountScope}:${lineEpoch}`} onBack={onBack} wide={wide} />;
}

function HistoryContent({ onBack, wide: _wide }: { onBack: () => void; wide: boolean }) {
  const { blockReason } = useContentPreferences();
  const { user, history, postHistory, clearHistory, push, setTab, syncAccount, toast } = useStore();
  const [histTab, setHistTab] = useState<"video" | "post">(() => (history.length === 0 && postHistory.length > 0 ? "post" : "video"));
  const [cache, setCache] = useState<Record<number, Detail>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const [postCache, setPostCache] = useState<Record<number, Post>>({});
  const postCacheRef = useRef(postCache);
  postCacheRef.current = postCache;
  const [limits, setLimits] = useState({ video: 12, post: 12 });
  const [failedIds, setFailedIds] = useState<number[]>([]);
  const [postFailedIds, setPostFailedIds] = useState<number[]>([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [postLoading, setPostLoading] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState("");
  const clearing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const ids = history.map((h) => h.id);
  const visibleIds = ids.slice(0, limits.video);
  const cards = visibleIds.map(id => cache[id]).filter((card): card is Detail => !!card);
  const failed = failedIds.filter(id => visibleIds.includes(id));
  const idsKey = visibleIds.join(",");
  const progressOf = (id: number) => history.find((h) => h.id === id);

  const visiblePostIds = postHistory.slice(0, limits.post);
  const postCards = visiblePostIds.map(id => postCache[id]).filter((p): p is Post => !!p);
  const postFailed = postFailedIds.filter(id => visiblePostIds.includes(id));
  const postIdsKey = visiblePostIds.join(",");

  /* 上游 #169（46e2936）：滚到底自动加批，不再点「加载更多」。
     历史页两个 tab 共用同一个滚动容器，批次键跟着当前 tab 走。 */
  const historyHasMore = histTab === "post" ? visiblePostIds.length < postHistory.length : visibleIds.length < ids.length;
  const { scrollerRef: historyScrollRef, sentinelRef: historySentinelRef, supported: autoLoadSupported } = useAutoLoadMore({
    hasMore: historyHasMore,
    busy: histTab === "post" ? postLoading : loading,
    count: histTab === "post" ? postCards.length : cards.length,
    resetKey: histTab,
    onMore: () => setLimits(prev => ({ ...prev, [histTab]: prev[histTab] + 12 })),
  });

  useEffect(() => {
    if (histTab !== "video") return;
    let alive = true;
    const missing = visibleIds.filter(id => !cacheRef.current[id]);
    setFailedIds([]);
    if (!missing.length) { setLoading(false); return; }
    setLoading(true);
    Promise.allSettled(missing.map(id => api.video(id)))
      .then(results => {
        if (!alive) return;
        const loaded: Record<number, Detail> = {};
        const nextFailed: number[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") loaded[missing[index]] = result.value;
          else nextFailed.push(missing[index]);
        });
        setCache(previous => ({ ...previous, ...loaded }));
        setFailedIds(nextFailed);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [idsKey, histTab, reload]);

  useEffect(() => {
    if (histTab !== "post") return;
    let alive = true;
    const missing = visiblePostIds.filter(id => !postCacheRef.current[id]);
    setPostFailedIds([]);
    if (!missing.length) { setPostLoading(false); return; }
    setPostLoading(true);
    Promise.allSettled(missing.map(id => api.post(id)))
      .then(results => {
        if (!alive) return;
        const loaded: Record<number, Post> = {};
        const nextFailed: number[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") loaded[missing[index]] = result.value;
          else nextFailed.push(missing[index]);
        });
        setPostCache(previous => ({ ...previous, ...loaded }));
        setPostFailedIds(nextFailed);
        setPostLoading(false);
      });
    return () => { alive = false; };
  }, [postIdsKey, histTab, reload]);

  const clearWatchHistory = async () => {
    if (clearing.current) return;
    clearing.current = true;
    setClearBusy(true); setClearError("");
    try {
      await clearHistory();
      if (mounted.current) setClearOpen(false);
    } catch (error) {
      if (mounted.current) setClearError(error instanceof Error ? error.message : "清空失败，观看记录已保留，请重试");
    } finally {
      clearing.current = false;
      if (mounted.current) setClearBusy(false);
    }
  };

  /* 观看历史不做下拉（规格：改静默刷新）。
     · 回到前台 → 静默同步账号侧记录（本地记录本身是实时的，不用等）；
     · 同步后把已上屏的卡片按 force 重拉一次（绕过 api 读缓存），失败的单条保留旧卡；
     · 清空按钮 / 弹层状态一律不动（clearOpen、clearBusy 不参与刷新）。 */
  const syncing = useRef(false);
  const lastSync = useRef(0);
  const refreshHistory = async () => {
      if (syncing.current) return;
      syncing.current = true;
      await syncAccount().catch(() => { /* 未登录 / 离线：只用本地数据 */ });
      const videoIds = visibleIds;
      const postIds = visiblePostIds;
      if (!videoIds.length && !postIds.length) return;
      const [vres, pres] = await Promise.all([
        Promise.allSettled(videoIds.map(id => api.video(id, true))),
        Promise.allSettled(postIds.map(id => api.post(id, true))),
      ]);
      const nextCache: Record<number, Detail> = {};
      const nextPostCache: Record<number, Post> = {};
      let okCount = 0;
      vres.forEach((r, i) => { if (r.status === "fulfilled" && r.value) { nextCache[videoIds[i]] = r.value; okCount += 1; } });
      pres.forEach((r, i) => { if (r.status === "fulfilled" && r.value) { nextPostCache[postIds[i]] = r.value; okCount += 1; } });
      if (mounted.current && Object.keys(nextCache).length) setCache(prev => ({ ...prev, ...nextCache }));
      if (mounted.current && Object.keys(nextPostCache).length) setPostCache(prev => ({ ...prev, ...nextPostCache }));
      lastSync.current = Date.now();
      if (!okCount) throw new Error("历史同步失败");
  };
  useVisibilityRefresh(() => { void refreshHistory().catch(() => { /* 静默 */ }).finally(() => { syncing.current = false; }); }, {
    enabled: true,
    lastAt: () => lastSync.current,
  });

  const totalCount = history.length + postHistory.length;

  /* 上游 29e273a：历史页「短剧 / 吃瓜」支持左右滑切；首尾不循环，纵向滚动不拦截。 */
  const historySwipe = useTabSwipe<HTMLDivElement>({
    rootRef: historyScrollRef,
    tabIndex: histTab === "video" ? 0 : 1,
    tabCount: 2,
    onTabChange: index => setHistTab(index === 0 ? "video" : "post"),
  });

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar relative z-10">
        <Button card className="hg-sub-btn" aria-label="返回" onClick={onBack}>
          <IBack size={19} />
        </Button>
        <div className="hg-sub-titles">
          <h1 className="hg-sub-title">观看历史</h1>
          <div className="hg-sub-meta">
            {totalCount > 0 ? `短剧 ${history.length} 部 · 吃瓜 ${postHistory.length} 篇` : "自动记忆上次观看集数与吃瓜足迹"}
          </div>
        </div>
        {totalCount > 0 && (
          <Button card aria-label="清空观看历史" disabled={clearBusy} onClick={() => { setClearError(""); setClearOpen(true); }}
            className="hg-tag-pill" style={{ minHeight: 32, padding: "0 12px" }}>
            {clearBusy ? "正在清空…" : "清空"}
          </Button>
        )}
      </header>

      <div className="shrink-0 hg-page-x pt-2.5 pb-3 relative z-10">
        <SegmentedControl className="hg-seg-track" role="tablist" aria-label="历史分类" activeIndex={histTab === "video" ? 0 : 1}>
          <Button role="tab" aria-selected={histTab === "video"} className="ios-segmented-item"
            onClick={() => setHistTab("video")}>短剧 ({history.length})</Button>
          <Button role="tab" aria-selected={histTab === "post"} className="ios-segmented-item"
            onClick={() => setHistTab("post")}>吃瓜 ({postHistory.length})</Button>
        </SegmentedControl>
      </div>

      <div ref={historyScrollRef} {...historySwipe} style={{ touchAction: "pan-y", paddingBottom: "calc(32px + var(--sab, 0px))" }}
        className="flex-1 scroll-y hg-page-x relative z-10"
        aria-busy={histTab === "post" ? postLoading : loading}>
        {histTab === "post" ? (
          <>
            {postLoading && !postCards.length ? (
              <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
            ) : postCards.length ? (
              <div className="hg-post-feed a-rise">
                {postCards.map((p) => {
                  const blocked = blockReason(p.tags);
                  if (blocked) {
                    return (
                      <Button key={p.id} card className="hg-post-card text-left" onClick={() => push({ kind: "post", id: p.id })}
                        aria-label="该内容命中屏蔽标签，查看提示">
                        <div className="text-[14px] font-semibold text-mut">已屏蔽内容</div>
                        <div className="mt-1 text-[12px] text-dim truncate">{blocked}</div>
                      </Button>
                    );
                  }
                  return (
                    <div key={p.id} className="hg-post-card" onClick={() => push({ kind: "post", id: p.id })}>
                      <div className="hg-post-head">
                        <span className="hg-post-who">
                          <span className="hg-post-name">{p.author?.name || "吃瓜帖"}</span>
                          <span className="hg-post-time">{p.publish_time || p.created_at}</span>
                        </span>
                      </div>
                      <div className="hg-post-title">{p.title}</div>
                      {p.cover && (
                        <div className="hg-post-art">
                          <Img src={p.cover} alt="" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : postFailed.length ? (
              <Empty icon={<IClock size={24} />} title="吃瓜浏览记录加载失败"
                sub="记录仍在，重试后继续浏览。" action="重试" onAction={() => setReload(n => n + 1)} />
            ) : (
              <Empty icon={<IClock size={24} />} title="还没有吃瓜浏览记录"
                sub="看过的吃瓜帖会出现在这里"
                action="去吃瓜看看" onAction={() => { onBack(); setTab("posts"); }} />
            )}
            {postCards.length > 0 && postFailed.length > 0 && (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mut">
                <span>{postFailed.length} 篇帖子加载失败，已加载内容仍可浏览。</span>
                <Button disabled={postLoading} onClick={() => setReload(n => n + 1)} className="px-3 text-primary">重试失败内容</Button>
              </div>
            )}
            {postCards.length > 0 && postLoading && <div className="flex justify-center py-3"><Loader label="加载更多内容" /></div>}
          </>
        ) : (
          <>
            {loading && !cards.length ? (
              <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
            ) : cards.length ? (
              <div className="hg-hist-list a-rise">
                {cards.map((c) => {
                  const progress = progressOf(c.id);
                  const blocked = blockReason(c.tags);
                  const pct = progress && progress.dur > 0
                    ? Math.max(4, Math.min(100, Math.round((progress.t / progress.dur) * 100)))
                    : 0;
                  const unblockedIds = cards.filter(x => !blockReason(x.tags)).map(x => x.id);
                  const unblockedIdx = Math.max(0, unblockedIds.indexOf(c.id));
                  const openResume = () => push({
                    kind: "feed", videoIds: unblockedIds.length ? unblockedIds : [c.id], index: unblockedIds.length ? unblockedIdx : 0,
                    title: "观看历史", startEp: progress?.ep, startTime: progress?.t,
                  });

                  if (blocked) {
                    return (
                      <Button key={c.id} card className="hg-hist-card" onClick={() => push({ kind: "series", id: c.id })}
                        aria-label="该内容命中屏蔽标签，查看提示">
                        <span className="flex-1 min-w-0 py-1">
                          <span className="block text-[14px] font-semibold text-mut">已屏蔽内容</span>
                          <span className="block mt-1 text-[12px] text-dim truncate">{blocked}</span>
                        </span>
                        <span className="text-[12px] text-primary shrink-0">查看</span>
                      </Button>
                    );
                  }

                  return (
                    <Button key={c.id} card className="hg-hist-card" onClick={openResume}>
                      <span className="hg-hist-thumb">
                        <Img src={c.cover} alt="" />
                        {pct > 0 && (
                          <span className="hg-hist-prog" aria-hidden="true">
                            <span style={{ width: `${pct}%` }} />
                          </span>
                        )}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[14px] font-bold text-on truncate">{c.title}</span>
                        <span className="block mt-1 text-[12px] font-semibold" style={{ color: "#FFB347" }}>
                          {progress
                            ? `看到第 ${progress.ep} 集${progress.t > 0 ? ` · ${fmtTime(progress.t)}` : ""}`
                            : "点击继续播放"}
                        </span>
                        <span className="block mt-1 text-[11px] text-mut truncate">
                          {c.is_finished ? `全 ${c.episode_count || c.total_episodes || "?"} 集` : `更新至 ${c.episode_count || "?"} 集`}
                          {c.tags?.length ? ` · ${c.tags.slice(0, 2).join(" / ")}` : ""}
                        </span>
                      </span>
                      <span className="hg-hist-play-pill" aria-hidden="true">
                        <IPlayF size={14} />
                      </span>
                    </Button>
                  );
                })}
              </div>
            ) : failed.length ? (
              <Empty icon={<IClock size={24} />} title="观看记录加载失败"
                sub="记录仍在，重试后继续浏览。" action="重试" onAction={() => setReload(n => n + 1)} />
            ) : (
              <Empty icon={<IClock size={24} />} title="还没有观看记录"
                sub="看过的剧集会出现在这里"
                action="去逛逛" onAction={() => { onBack(); setTab("home"); }} />
            )}
            {cards.length > 0 && failed.length > 0 && (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mut">
                <span>{failed.length} 项内容加载失败，已加载内容仍可浏览。</span>
                <Button disabled={loading} onClick={() => setReload(n => n + 1)} className="px-3 text-primary">重试失败内容</Button>
              </div>
            )}
            {cards.length > 0 && loading && <div className="flex justify-center py-3"><Loader label="加载更多内容" /></div>}
          </>
        )}
        {historyHasMore && (autoLoadSupported
          ? <div ref={historySentinelRef} className="h-4" aria-hidden="true" />
          : <Button card disabled={histTab === "post" ? postLoading : loading}
              onClick={() => setLimits(prev => ({ ...prev, [histTab]: prev[histTab] + 12 }))}
              className="hg-loadmore">加载更多</Button>)}
        {clearError && !clearOpen && <p role="alert" className="mt-2 text-[13px] text-danger">{clearError}</p>}
      </div>

      <Modal open={clearOpen} onClose={() => { if (!clearing.current) setClearOpen(false); }} label="清空观看历史">
        <div className="p-5">
          <h2 className="text-[18px] font-bold">清空观看历史</h2>
          <p className="mt-2 text-[14px] text-mut">确认清空全部观看历史？{user ? "当前账号的云端观看历史与本机缓存都会被清除。" : "本机游客观看历史会被清除。"}此操作无法撤销，收藏不会受影响。</p>
          {clearError && <p role="alert" className="mt-3 text-[13px] text-danger">{clearError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={clearBusy} onClick={() => setClearOpen(false)} className="flex-1">取消</Button>
            <Button variant="danger" disabled={clearBusy} aria-busy={clearBusy} onClick={() => void clearWatchHistory()} className="flex-1 rounded-(--r-ctl) px-3">
              {clearBusy ? "正在清空…" : "确认清空"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ================= 二级栈页：我的收藏 ================= */
export function FavoritesPage({ onBack, wide, initialTab = "video", active = true }: { onBack: () => void; wide: boolean; initialTab?: "video" | "post"; active?: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <FavoritesContent key={`${accountScope}:${lineEpoch}`} onBack={onBack} wide={wide} initialTab={initialTab} active={active} />;
}

function FavoritesContent({ onBack, wide, initialTab, active }: { onBack: () => void; wide: boolean; initialTab: "video" | "post"; active: boolean }) {
  const { blockReason } = useContentPreferences();
  const { user, favs, postFavs, history, favEpCounts, seedFavoriteEpisodes, ackFavoriteEpisodes, push, setTab, accountSync, syncAccount, setCollected, toast } = useStore();
  const [favTab, setFavTab] = useState<"video" | "post">(initialTab);
  const [favFilter, setFavFilter] = useState<FavoriteFilter>("all");
  const [cache, setCache] = useState<Record<number, Detail>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const [postCache, setPostCache] = useState<Record<number, Post>>({});
  const postCacheRef = useRef(postCache);
  postCacheRef.current = postCache;
  const [limits, setLimits] = useState({ video: 12, post: 12 });
  const [failedIds, setFailedIds] = useState<number[]>([]);
  const [postFailedIds, setPostFailedIds] = useState<number[]>([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [postLoading, setPostLoading] = useState(false);
  /* 上游 3622227：从详情页返回收藏列表要重新校验可见卡片（点赞数、封面、是否还在架），
     但每「回到列表一次」每张卡只重拉一次——否则翻页/重渲染会把同一批 id 反复打服务器。
     离场（!active，被详情页盖住）时清空标记，返回时整屏静默重拉。 */
  const refreshedFavorites = useRef(new Set<number>());
  /* 多选移除（上游 #168）：只做收藏页，历史页不动。 */
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const removalPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const progressById = useMemo(() => new Map(history.map(item => [item.id, item])), [history]);
  const filteredFavIds = useMemo(() => filterFavoriteVideoIds(
    favs,
    cache,
    favFilter,
    (id, detail) => unwatchedEpisodeCount(detail, progressById.get(id)) > 0,
  ), [favs, cache, favFilter, progressById]);

  const fetchTargetIds = favFilter === "all" ? favs.slice(0, limits.video) : favs;
  const visibleIds = filteredFavIds.slice(0, limits.video);
  const cards = visibleIds.map(id => cache[id]).filter((card): card is Detail => !!card);
  const failed = failedIds.filter(id => fetchTargetIds.includes(id));
  const idsKey = fetchTargetIds.join(",");

  const visiblePostIds = postFavs.slice(0, limits.post);
  const postCards = visiblePostIds.map(id => postCache[id]).filter((p): p is Post => !!p);
  const postFailed = postFailedIds.filter(id => visiblePostIds.includes(id));
  const postIdsKey = visiblePostIds.join(",");

  /* 上游 #169（46e2936）：滚到底自动加批，不再点「加载更多」。 */
  const favoriteHasMore = favTab === "post" ? visiblePostIds.length < postFavs.length : visibleIds.length < filteredFavIds.length;
  const { scrollerRef: favoriteScrollRef, sentinelRef: favoriteSentinelRef, supported: autoLoadSupported } = useAutoLoadMore({
    hasMore: favoriteHasMore,
    busy: favTab === "post" ? postLoading : loading,
    count: favTab === "post" ? postCards.length : cards.length,
    resetKey: `${favTab}:${favFilter}`,
    onMore: () => setLimits(prev => ({ ...prev, [favTab]: prev[favTab] + 12 })),
  });

  const selectionMode = selectedIds.length > 0;
  const toggleSelected = (id: number) => setSelectedIds(cur => cur.includes(id) ? cur.filter(item => item !== id) : [...cur, id]);
  const beginSelection = (id: number) => setSelectedIds(cur => cur.includes(id) ? cur : [...cur, id]);
  const clearSelection = () => { setSelectedIds([]); setRemoveError(""); };
  /* 上游 22399f8：全选覆盖当前 Tab 的全量记录（含尚未滚动加载的分页），移除时逐 id 处理，
     不依赖卡片是否已上屏。 */
  const allFavIds = favTab === "post" ? postFavs : filteredFavIds;
  const allSelected = allFavIds.length > 0 && allFavIds.every(id => selectedIds.includes(id));
  const selectAll = () => setSelectedIds([...allFavIds]);
  /* 上游 29e273a：收藏页「短剧 / 吃瓜」左右滑切，切 tab 沿用原有的「清空选择」行为。
     批量选择进行中关闭滑切：误滑一下就把选好的项丢了，代价比少一个手势大。 */
  const favoriteSwipe = useTabSwipe<HTMLDivElement>({
    rootRef: favoriteScrollRef,
    tabIndex: favTab === "video" ? 0 : 1,
    tabCount: 2,
    enabled: !selectionMode,
    onTabChange: index => { setFavTab(index === 0 ? "video" : "post"); clearSelection(); },
  });
  const confirmRemoveSelected = async () => {
    if (removalPending.current || !selectedIds.length) return;
    removalPending.current = true;
    setRemoving(true); setRemoveError("");
    const targets = [...selectedIds];
    const kind = favTab === "post" ? "post" : "video";
    try {
      /* 逐项取消：单条失败不影响其他条，失败项留在选择里可直接重试。 */
      const failed: number[] = [];
      for (const id of targets) {
        try { await setCollected(kind, id, false); } catch { failed.push(id); }
      }
      if (failed.length) {
        setSelectedIds(failed);
        throw new Error(failed.length === targets.length
          ? "取消收藏失败，请重试"
          : `已取消 ${targets.length - failed.length} 项，${failed.length} 项失败，请重试`);
      }
      if (mounted.current) {
        setSelectedIds([]);
        setRemoveOpen(false);
        toast(`已取消收藏 ${targets.length} 项`, "info");
      }
    } catch (error) {
      if (mounted.current) setRemoveError(error instanceof Error ? error.message : "取消收藏失败，请重试");
    } finally {
      removalPending.current = false;
      if (mounted.current) setRemoving(false);
    }
  };

  /* 首次拿到收藏详情时补基线（上游 #153）：只补「还没基线」的项，已有的不覆盖。 */
  useEffect(() => {
    if (!favs.length) return;
    const toSeed: Record<number, number> = {};
    for (const id of favs) {
      if (favEpCounts[id] !== undefined) continue;
      const detail = cache[id];
      if (!detail) continue;
      const latest = detailEpisodeCount(detail);
      if (latest <= 0) continue;
      const unwatched = unwatchedNewEpisodes(detail, history.find(h => h.id === id), undefined);
      toSeed[id] = Math.max(1, latest - unwatched);
    }
    if (Object.keys(toSeed).length > 0) seedFavoriteEpisodes(toSeed);
  }, [favs, cache, history, favEpCounts, seedFavoriteEpisodes]);

  const favoriteStateUnknown = !!user && !accountSync.favoritesKnown && favs.length === 0 && postFavs.length === 0;
  const favoriteSyncFailed = favoriteStateUnknown && !accountSync.busy;
  const syncingFavorites = favoriteStateUnknown && !favoriteSyncFailed;

  useEffect(() => {
    if (favTab !== "video") return;
    if (!active) { refreshedFavorites.current.clear(); return; }
    let alive = true;
    const missing = fetchTargetIds.filter(id => !cacheRef.current[id] || !refreshedFavorites.current.has(id));
    setFailedIds([]);
    if (!missing.length) { setLoading(false); return; }
    /* 已有卡片时不要整屏转圈：保留旧卡，后台换新。 */
    setLoading(!visibleIds.some(id => cacheRef.current[id]));
    void (async () => {
      const loaded: Record<number, Detail> = {};
      const nextFailed: number[] = [];
      // 回到列表可能有十几张卡要校验：分批串行，别一次打十几个请求。
      for (let offset = 0; offset < missing.length; offset += 6) {
        const batch = missing.slice(offset, offset + 6);
        /* 已缓存的卡片用 force 跳过读缓存：api.video 的 5min TTL + SWR 在「刚返回列表」
           这个时间尺度上不会补请求（3s 内命中不重拉），不 force 就等于没刷新。 */
        const results = await Promise.allSettled(batch.map(id => api.video(id, !!cacheRef.current[id])));
        if (!alive) return;
        results.forEach((result, index) => {
          const id = batch[index];
          if (result.status === "fulfilled") {
            loaded[id] = result.value;
            refreshedFavorites.current.add(id);
          } else if (!cacheRef.current[id]) nextFailed.push(id);
        });
        setCache(previous => ({ ...previous, ...loaded }));
      }
      if (!alive) return;
      setFailedIds(nextFailed);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [idsKey, favTab, reload, active]);

  useEffect(() => {
    if (favTab !== "post") return;
    let alive = true;
    const missing = visiblePostIds.filter(id => !postCacheRef.current[id]);
    setPostFailedIds([]);
    if (!missing.length) { setPostLoading(false); return; }
    setPostLoading(true);
    Promise.allSettled(missing.map(id => api.post(id)))
      .then(results => {
        if (!alive) return;
        const loaded: Record<number, Post> = {};
        const nextFailed: number[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") loaded[missing[index]] = result.value;
          else nextFailed.push(missing[index]);
        });
        setPostCache(previous => ({ ...previous, ...loaded }));
        setPostFailedIds(nextFailed);
        setPostLoading(false);
      });
    return () => { alive = false; };
  }, [postIdsKey, favTab, reload]);

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar relative z-10">
        <Button card className="hg-sub-btn" aria-label="返回" onClick={onBack}>
          <IBack size={19} />
        </Button>
        <div className="hg-sub-titles">
          <h1 className="hg-sub-title">我的收藏</h1>
          <p className="hg-sub-meta">短剧 {favs.length} 部 · 吃瓜 {postFavs.length} 篇</p>
        </div>
        {favTab === "video" && filteredFavIds.length > 0 && (
          <Button card className="hg-quick-action"
            onClick={() => {
              const bingeIds = filteredFavIds.filter(id => !cache[id] || !blockReason(cache[id].tags));
              if (bingeIds.length) push({ kind: "feed", videoIds: bingeIds, index: 0, title: "我的收藏" });
            }}>
            <IBoltF size={13} /><span>连刷收藏</span>
          </Button>
        )}
      </header>

      <div className="shrink-0 hg-page-x pt-2.5 pb-3 relative z-10">
        <SegmentedControl className="hg-seg-track" role="tablist" aria-label="收藏分类" activeIndex={favTab === "video" ? 0 : 1}>
          <Button role="tab" aria-selected={favTab === "video"} className="ios-segmented-item"
            onClick={() => { setFavTab("video"); clearSelection(); }}>短剧 ({favs.length})</Button>
          <Button role="tab" aria-selected={favTab === "post"} className="ios-segmented-item"
            onClick={() => { setFavTab("post"); clearSelection(); }}>吃瓜 ({postFavs.length})</Button>
        </SegmentedControl>
        {favTab === "video" && favs.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="收藏状态筛选">
            {([
              ["all", "全部"],
              ["unwatched", "未看完"],
              ["ongoing", "连载中"],
              ["finished", "已完结"],
            ] as const).map(([key, label]) => (
              <Button key={key} card aria-pressed={favFilter === key}
                className={`hg-tag-pill ${favFilter === key ? "is-active" : ""}`}
                onClick={() => { setFavFilter(key); clearSelection(); }}>
                {label}
              </Button>
            ))}
          </div>
        )}
      </div>

      {selectionMode && (
        <div role="region" aria-label="批量管理"
          className="shrink-0 hg-page-x pb-2 relative z-20 flex items-center gap-2 text-[13px]">
          <span className="font-semibold text-on">已选 {selectedIds.length} 项</span>
          <Button disabled={allSelected} className="ml-auto px-2 text-primary disabled:opacity-40" onClick={selectAll}>全选</Button>
          <Button className="px-2 text-primary" onClick={clearSelection}>取消</Button>
          <Button variant="danger" className="rounded-(--r-ctl) px-3"
            onClick={() => { setRemoveError(""); setRemoveOpen(true); }}>取消收藏</Button>
        </div>
      )}

      <div ref={favoriteScrollRef} {...favoriteSwipe} style={{ touchAction: "pan-y", paddingBottom: "calc(32px + var(--sab, 0px))" }}
        className="flex-1 scroll-y hg-page-x relative z-10"
        aria-busy={(favTab === "post" ? postLoading : loading) || syncingFavorites}>
        {favoriteSyncFailed ? (
          <Empty icon={<IStar size={24} />} title="收藏状态未知"
            sub="账号同步未完成，暂时无法确认收藏内容。" action="重试"
            onAction={() => { void syncAccount().catch(() => {}); }} />
        ) : syncingFavorites ? (
          <FavoriteSyncState wide={wide} />
        ) : favTab === "post" ? (
          <>
            {postLoading && !postCards.length ? (
              <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
            ) : postCards.length ? (
              <div className="hg-post-feed">
                {postCards.map((p) => (
                  <FavoritePostCard key={p.id} post={p} blocked={blockReason(p.tags)}
                    selectionMode={selectionMode} selected={selectedIds.includes(p.id)}
                    onBegin={() => beginSelection(p.id)}
                    onToggle={() => toggleSelected(p.id)}
                    onOpen={() => push({ kind: "post", id: p.id })} />
                ))}
              </div>
            ) : postFailed.length ? (
              <Empty icon={<IStar size={24} />} title="收藏帖子加载失败"
                sub="记录仍在，重试后继续浏览。" action="重试" onAction={() => setReload(n => n + 1)} />
            ) : (
              <Empty icon={<IStar size={24} />} title="还没有收藏的吃瓜帖"
                sub="在吃瓜详情页点收藏，之后就能在这里找到"
                action="去吃瓜看看" onAction={() => { onBack(); setTab("posts"); }} />
            )}
            {postCards.length > 0 && postFailed.length > 0 && (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mut">
                <span>{postFailed.length} 篇帖子加载失败，已加载内容仍可浏览。</span>
                <Button disabled={postLoading} onClick={() => setReload(n => n + 1)} className="px-3 text-primary">重试失败内容</Button>
              </div>
            )}
            {postCards.length > 0 && postLoading && <div className="flex justify-center py-3"><Loader label="加载更多内容" /></div>}
          </>
        ) : (
          <>
            {loading && !cards.length ? (
              <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
            ) : cards.length ? (
              <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                {cards.map((c) => {
                  const progress = history.find(h => h.id === c.id);
                  const latestCount = detailEpisodeCount(c);
                  const unwatched = unwatchedNewEpisodes(c, progress, favEpCounts[c.id]);
                  return (
                    <MediaCard key={c.id} blockedReason={blockReason(c.tags)} title={c.title} cover={c.cover} score={c.score}
                      badge={unwatched > 0 ? `新更 ${unwatched} 集` : (c.is_finished ? "已完结" : `${latestCount || c.episode_count} 集`)}
                      badgeTone={unwatched > 0 ? "update" : "default"}
                      subtitle={c.tags?.slice(0, 2).join(" · ")}
                      progress={formatWatchProgress(progress, latestCount, c.is_finished)}
                      selectionMode={selectionMode} selected={selectedIds.includes(c.id)}
                      onLongPress={() => beginSelection(c.id)}
                      onOpen={() => {
                        if (selectionMode) { toggleSelected(c.id); return; }
                        /* 点开就认账：把基线抬到最新，徽标随即消失（不然会一直挂着）。
                           以前这里还要求「progress.ep < 基线」才认账 —— 而徽标恰恰会在
                           progress.ep === 基线（追上了旧基线、但剧又更了）时还挂着，
                           于是点了没反应。认账条件直接对齐徽标本身：有未看新集就抬基线。 */
                        if (unwatched > 0 && latestCount > 0) {
                          ackFavoriteEpisodes(c.id, latestCount);
                        }
                        push({ kind: "series", id: c.id });
                      }} />
                  );
                })}
              </div>
            ) : failed.length ? (
              <Empty icon={<IStar size={24} />} title="收藏加载失败"
                sub="记录仍在，重试后继续浏览。" action="重试" onAction={() => setReload(n => n + 1)} />
            ) : favs.length > 0 && favFilter !== "all" ? (
              <Empty icon={<IStar size={24} />} title="当前筛选下暂无短剧"
                sub="切换其他状态或查看全部收藏"
                action="查看全部" onAction={() => setFavFilter("all")} />
            ) : (
              <Empty icon={<IStar size={24} />} title="还没有喜欢的内容"
                sub="在剧集详情页点收藏，之后就能在这里找到"
                action="去逛逛" onAction={() => { onBack(); setTab("category"); }} />
            )}
            {cards.length > 0 && failed.length > 0 && (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mut">
                <span>{failed.length} 项内容加载失败，已加载内容仍可浏览。</span>
                <Button disabled={loading} onClick={() => setReload(n => n + 1)} className="px-3 text-primary">重试失败内容</Button>
              </div>
            )}
            {cards.length > 0 && loading && <div className="flex justify-center py-3"><Loader label="加载更多内容" /></div>}
          </>
        )}
        {favoriteHasMore && (autoLoadSupported
          ? <div ref={favoriteSentinelRef} className="h-4" aria-hidden="true" />
          : <Button card disabled={favTab === "post" ? postLoading : loading}
              onClick={() => setLimits(prev => ({ ...prev, [favTab]: prev[favTab] + 12 }))}
              className="hg-loadmore">加载更多</Button>)}
      </div>

      <Modal open={removeOpen} onClose={() => { if (!removalPending.current) setRemoveOpen(false); }} label="批量取消收藏">
        <div className="p-5">
          <h2 className="text-[18px] font-bold">取消收藏所选内容</h2>
          <p className="mt-2 text-[14px] text-mut">
            确认取消收藏选中的 {selectedIds.length} 项内容？观看历史不会受影响。
            {user ? "当前账号的云端收藏与本机缓存都会更新。" : "此操作只会修改本机记录。"}
          </p>
          {removeError && <p role="alert" className="mt-3 text-[13px] text-danger">{removeError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={removing} onClick={() => setRemoveOpen(false)} className="flex-1">取消</Button>
            <Button variant="danger" disabled={removing || !selectedIds.length} aria-busy={removing}
              onClick={() => void confirmRemoveSelected()} className="flex-1 rounded-(--r-ctl) px-3">
              {removing ? "正在取消…" : "确认取消收藏"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * 收藏页的吃瓜卡：从内联 div 提成组件，才能让每张卡各自持有长按计时器（共享一个 hook 实例
 * 就分不清长按的是哪一张）。
 */
function FavoritePostCard({ post, blocked, selectionMode, selected, onOpen, onToggle, onBegin }: {
  post: Post; blocked?: string | null; selectionMode: boolean; selected: boolean;
  onOpen: () => void; onToggle: () => void; onBegin: () => void;
}) {
  const { longPressProps, consumeSuppressedClick } = useLongPress(onBegin);
  const press = () => {
    if (consumeSuppressedClick()) return;
    if (selectionMode) onToggle();
    else onOpen();
  };
  const className = `hg-post-card is-selectable${selected ? " is-selected" : ""}`;
  const mark = selectionMode
    ? <span className="ios-poster-select" aria-hidden="true">{selected && <ICheck size={16} strokeWidth={2.4} />}</span>
    : null;
  const label = selectionMode ? `${selected ? "取消选择" : "选择"}${post.title || "该内容"}` : undefined;

  if (blocked) return (
    <Button card className={className} aria-label={label ?? "该内容命中屏蔽标签，查看提示"}
      aria-pressed={selectionMode ? selected : undefined} onClick={press} {...longPressProps}>
      <div className="text-[14px] font-semibold text-mut">已屏蔽内容</div>
      <div className="mt-1 text-[12px] text-dim truncate">{blocked}</div>
      {mark}
    </Button>
  );
  return (
    <div className={className} role="button" tabIndex={0} aria-label={label ?? post.title}
      aria-pressed={selectionMode ? selected : undefined} onClick={press}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); press(); } }}
      {...longPressProps}>
      <div className="hg-post-head">
        <span className="hg-post-who">
          <span className="hg-post-name">{post.author?.name || "吃瓜帖"}</span>
          <span className="hg-post-time">{post.publish_time || post.created_at}</span>
        </span>
      </div>
      <div className="hg-post-title">{post.title}</div>
      {post.cover && (
        <div className="hg-post-art">
          <Img src={post.cover} alt="" />
        </div>
      )}
      {mark}
    </div>
  );
}

function FavoriteSyncState({ wide }: { wide: boolean }) {
  return <>
    <div role="status" aria-live="polite" aria-label="正在同步收藏"
      className="mb-4 flex items-center justify-center gap-2.5 text-[13px] text-mut">
      <span aria-hidden="true" className="ios-loader spinner w-5 h-5" />
      <span>正在同步收藏…</span>
    </div>
    <div aria-hidden="true" className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
      {[0, 1, 2, 3].map(index => (
        <div key={index} className="min-w-0">
          <div className="hg-skel-poster w-full rounded-[22px] bg-s3 animate-pulse" />
          <div className="mt-2.5 h-3.5 w-4/5 rounded-full bg-s3 animate-pulse" />
          <div className="mt-2 h-3 w-1/2 rounded-full bg-s2 animate-pulse" />
        </div>
      ))}
    </div>
  </>;
}
