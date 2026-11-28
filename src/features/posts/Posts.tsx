import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, cover, fmt, isMobile } from "../../shared/api/api";
import type { Post } from "../../shared/api/types";
import { ACTION_TOAST_SLOT, useStore } from "../../shared/model/store";
import { markScrolling } from "../../shared/lib/scrollFx";
import { copyText } from "../../shared/lib/clipboard";
import { Empty, Img, Sheet } from "../../shared/ui/ui";
import { CommentsPanel } from "../feed/Panels";
import Player from "../playback/Player";
import { IBack, IComment, IFireF, IHeart, IHeartF, IPlayF, ISearch, IStar, IStarF } from "../../shared/ui/icons";
import { handleArticleClick, parseInternalVideoId, sanitizeHtml } from "../../shared/lib/html";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { TagBlockMenu } from "../../shared/ui/TagBlockMenu";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { postHot } from "./postData";
import { useForegroundRefresh, useVisibilityRefresh } from "../../shared/lib/dataFreshness";
import { PullIndicator, usePullToRefresh } from "../../shared/lib/usePullToRefresh";

/* ================= 吃瓜列表 ================= */
/** 列表接口（/api/posts）只给标题/封面/热度；作者与点赞/评论数只在详情接口里。
 *  卡片要画头像/昵称/互动数，就按 id 补一次详情；结果进模块级缓存，切 tab 回来不再重复请求。 */
type PostExtra = { author?: Post["author"]; like?: number; comment?: number; collect?: number; hot?: number; created_at?: string; publish_time?: string };
const postExtra = new Map<number, PostExtra>();
const extraOf = (p: Post): PostExtra | undefined => postExtra.get(p.id);

const SORTS = [
  { key: "latest", label: "最新" },
  { key: "trending", label: "最热" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];

const BLOG_CATEGORIES = [
  { route: "gossip", name: "黑料吃瓜", fallbackRoute: "remen-chigua" },
  { route: "reviews", name: "短剧剧评", fallbackRoute: "ai-yuanchuang" },
] as const;
type BlogCateKey = "" | (typeof BLOG_CATEGORIES)[number]["route"];

const parsePostDate = (p: Post): Date | null => {
  const raw = (p.publish_time || p.created_at || "").trim();
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

const postDateKey = (p: Post): string => {
  const raw = (p.publish_time || p.created_at || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = parsePostDate(p);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const formatDateGroup = (key: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const y = new Date(now.getTime() - 86400000);
  const yesterdayKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  if (key === todayKey) return "今天";
  if (key === yesterdayKey) return "昨天";
  const [, , mm, dd] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) || [];
  return mm && dd ? `${+mm}月${+dd}日` : key;
};

export function PostsPage({ onBack, embedded = false, active = true }: { onBack?: () => void; wide?: boolean; embedded?: boolean; active?: boolean }) {
  const { push, toast, isLiked, setLiked, actionPending, user, setLoginOpen, lineEpoch } = useStore();
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [sort, setSort] = useState<SortKey>("latest");
  const [cate, setCate] = useState<BlogCateKey>("");
  const [commentTarget, setCommentTarget] = useState<{ id: number; total: number } | null>(null);
  const [likeDelta, setLikeDelta] = useState<Record<number, number>>({});
  const [items, setItems] = useState<Post[]>([]);
  const [extra, setExtra] = useState<Record<number, PostExtra>>({});
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  /* 请求代次：只有当前代次的响应能写回列表。
     吃瓜列表可以同时有「旧第 2 页」和「换线/换筛选后的第 1 页」在飞，旧代码靠 busy
     挡住并发，force 刷新时免不了重叠 —— 回来的旧页会直接接在新列表后面。 */
  const seq = useRef(0);
  const lastEpoch = useRef(lineEpoch);
  const lastAt = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* `opts.force` 绕过 api 读缓存；`opts.silent` 不闪骨架、不弹错（回前台 / 重进 tab 用） */
  const loadMore = async (reset = false, opts?: { force?: boolean; silent?: boolean }) => {
    const force = opts?.force === true;
    const silent = opts?.silent === true;
    if (busy.current && !force) return;
    const next = reset ? 1 : page + 1;
    if (!reset && next > pages) return;
    /* reset 开新代次（换筛选/换线/下拉刷新），追加沿用当前代次 */
    const my = reset ? ++seq.current : seq.current;
    busy.current = true;
    if (!silent) setLoading(true);
    if (!silent) setErr("");
    try {
      const fallbackRoute = BLOG_CATEGORIES.find((c) => c.route === cate)?.fallbackRoute;
      let res;
      if (sort === "latest") {
        try {
          res = await api.blogPosts(cate, next, force);
        } catch {
          res = fallbackRoute
            ? await api.postCategory(fallbackRoute, next, 20, sort, force)
            : await api.posts(next, 20, sort, force);
        }
      } else {
        res = fallbackRoute
          ? await api.postCategory(fallbackRoute, next, 20, sort, force)
          : await api.posts(next, 20, sort, force);
      }
      /* 旧代次的页不写回：换线/换筛选之后它属于上一批数据 */
      if (my !== seq.current) return;
      setItems((prev) => {
        const base = reset ? [] : prev;
        /* 只按 id 去重：旧代码还按标题去重，站点上同题不同帖（或标题带空白差异）会被整条滤掉，
           分页时看着像"新内容没进来"（要求 D）。 */
        const seen = new Set(base.map((x) => x.id));
        const added = (res?.items || []).filter((x) => {
          if (seen.has(x.id)) return false;
          seen.add(x.id);
          return true;
        });
        return [...base, ...added];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
      lastAt.current = Date.now();
    } catch (e) {
      if (my === seq.current) {
        if (!silent) setErr((e as Error).message || "吃瓜内容加载失败");
        if (silent) throw e;
      }
    } finally {
      if (my === seq.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  /* 换排序 / 换分类：用户主动换筛选，清空重拉（这一屏的卡片本来就该换成另一批）。 */
  useEffect(() => {
    setItems([]);
    /* 点赞增量是「相对旧列表服务端计数」的差，换一批数据就没意义了（否则越滚越多 ±1） */
    setLikeDelta({});
    setPage(0);
    setPages(1);
    scrollRef.current?.scrollTo(0, 0);
    void loadMore(true, { force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, cate]);

  /* 线路 / 代理事件（hg:line-changed → lineEpoch）：只静默换数据，不清列表、不回到顶部。
     旧写法把 lineEpoch 并进上面那个 effect，先 setItems([]) 再拉：已渲染的卡片会被整批卸载重建
     （报告 B11——事件后 2.5s 打标记的卡片 contains=false），详情页已是这个口径（上游 issue #165）。
     loadMore(reset) 是**一次** setItems，React 按 id 复用节点，所以静默刷新后已渲染卡片不重建。 */
  useEffect(() => {
    if (lastEpoch.current === lineEpoch) return;
    lastEpoch.current = lineEpoch;
    postExtra.clear();
    setExtra({});
    /* 换线后服务端计数整批换新，旧的本地增量必须撤销（失败回滚那条只管单次点击） */
    setLikeDelta({});
    void loadMore(true, { force: true, silent: true }).catch(() => { /* 静默失败：保留旧列表 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineEpoch]);

  /* 返回再进 / 切回吃瓜 tab：5s 内复用现成列表，超过就静默重拉（不闪骨架，失败保留旧列表） */
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (!active) return;
    if (Date.now() - lastAt.current < 5_000) return;
    void loadMore(true, { force: true, silent: true }).catch(() => { /* 静默失败 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const pull = usePullToRefresh({
    ref: scrollRef,
    onRefresh: () => loadMore(true, { force: true, silent: true }),
    enabled: isMobile,
    onDone: ok => toast(ok ? "已同步官网" : "同步失败，稍后再试", ok ? "ok" : "info"),
  });

  /* 前台每 5 分钟静默刷新当前参数（全部/黑料/剧评 × 最新/最热） */
  useForegroundRefresh(() => { void loadMore(true, { force: true, silent: true }).catch(() => { /* 静默 */ }); },
    { enabled: active });

  /* 回前台：距上次拉取 > 30s 静默重拉当前参数 */
  useVisibilityRefresh(() => { void loadMore(true, { force: true, silent: true }).catch(() => { /* 静默 */ }); }, {
    enabled: active,
    lastAt: () => lastAt.current,
    busy: loading || pull.refreshing,
  });

  /* 补详情：3 路并发，顺序按列表顺序；失败就只显示列表字段，不阻塞也不重试打扰 */
  useEffect(() => {
    const missing = items.map((x) => x.id).filter((id) => !postExtra.has(id));
    if (!missing.length) return;
    let alive = true;
    const queue = missing.slice();
    const worker = async () => {
      while (alive) {
        const id = queue.shift();
        if (id == null) return;
        try {
          const detail = await api.post(id);
          if (!alive) return;
          const got: PostExtra = {
            author: detail.author,
            like: detail.counts?.like,
            comment: detail.counts?.comment,
            collect: detail.counts?.collect,
            hot: postHot(detail),
            created_at: detail.created_at,
            publish_time: detail.publish_time,
          };
          postExtra.set(id, got);
          setExtra((prev) => ({ ...prev, [id]: got }));
        } catch { /* 详情拿不到：卡片退回列表字段 */ }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => { alive = false; };
  }, [items]);

  const checkScrollBottom = () => {
    const el = scrollRef.current;
    if (!el || loading || err || filtering || page >= pages) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 360) void loadMore();
  };

  useEffect(() => {
    const el = sentinel.current;
    if (!el || loading || err || filtering || page >= pages) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) void loadMore(); }, { root: scrollRef.current, rootMargin: "320px" });
    io.observe(el);
    checkScrollBottom();
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, loading, err, filtering]);

  const renderFooter = (p: Post) => {
    const info = extra[p.id] ?? extraOf(p);
    const author = info?.author ?? p.author;
    const pic = author?.avatar;
    const initial = (author?.name || "").trim().charAt(0);
    const authorId = author?.id;
    const dateKey = postDateKey(p);
    const dateLabel = dateKey ? formatDateGroup(dateKey) : "";
    const liked = isLiked(p.id, undefined, "post");
    const likeBusy = actionPending(`like:post:${p.id}:0`);
    const likeCount = Math.max(0, (info?.like ?? 0) + (likeDelta[p.id] ?? 0));
    return (
      <div className="hg-tl-foot">
        <button type="button" className="hg-tl-author"
          onClick={authorId ? (e) => { e.stopPropagation(); push({ kind: "user", id: authorId, name: author?.name }); } : undefined}>
          <span className="hg-tl-avatar" aria-hidden="true">
            {pic ? <Img src={pic} w={96} h={96} /> : (initial || "吃")}
          </span>
          <span className="hg-tl-author-name">
            {author?.name || "吃瓜快讯"}{dateLabel ? ` · ${dateLabel}` : ""}
          </span>
        </button>
        <div className="hg-tl-actions">
          <button type="button" className={`hg-post-stat${liked ? " is-liked" : ""}`} disabled={likeBusy}
            aria-label={liked ? "取消点赞" : "点赞"}
            onClick={(e) => {
              e.stopPropagation();
              if (!user) { setLoginOpen(true); return; }
              if (likeBusy) return;
              const next = !liked;
              setLikeDelta((prev) => ({ ...prev, [p.id]: (prev[p.id] ?? 0) + (next ? 1 : -1) }));
              void setLiked("post", p.id, 0, next).catch((err) => {
                setLikeDelta((prev) => ({ ...prev, [p.id]: (prev[p.id] ?? 0) + (next ? -1 : 1) }));
                toast((err as Error)?.message || "点赞失败", "info");
              });
            }}>
            <span className="hg-post-heart">{liked ? "♥" : "♡"}</span>{fmt(likeCount)}
          </button>
          <button type="button" className="hg-post-stat" aria-label="查看评论"
            onClick={(e) => { e.stopPropagation(); setCommentTarget({ id: p.id, total: info?.comment ?? 0 }); }}>
            <IComment size={14} />{fmt(info?.comment ?? 0)}
          </button>
          <button type="button" className="hg-post-stat" aria-label="分享帖子"
            onClick={(e) => {
              e.stopPropagation();
              copyText(`https://huangguoai.com/post/${p.id}`)
                .then(() => toast("链接已复制", "ok"))
                .catch(() => toast("复制失败", "info"));
            }}>
            <IFireF size={13} />{fmt(info?.hot ?? p.hot)}
          </button>
        </div>
      </div>
    );
  };

  /* 整卡可点（v3.0.6 #8）：封面 / 标题 / 摘要都算命中区，卡内的点赞、评论、分享、作者
     各自 stopPropagation（见 renderFooter），不会连带打开详情。
     div 上没有 role/tabIndex 时读书器与键盘都视它为死块，这里补齐，顺带让
     真机上「点标题」和「点封面」走完全相同的路径。 */
  const cardHit = (p: Post) => ({
    role: "link" as const,
    tabIndex: 0,
    "aria-label": `打开帖子：${p.title}`,
    onClick: () => push({ kind: "post", id: p.id }),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); push({ kind: "post", id: p.id }); }
    },
  });

  const renderCardBody = (p: Post, featured: boolean, rank?: number) => {
    const rawTag = (p.tags || []).find((t) => t && t !== HIDDEN_POST_TAG);
    const cateLabel = rawTag === "黑料吃瓜" || rawTag === "短剧剧评" ? rawTag : (rawTag || "");
    const showCate = cate === "" && Boolean(cateLabel);
    const hasVideo = Boolean(p.video_url || p.video_id);
    const desc = (p.desc || "").trim();
    if (featured && p.cover) {
      return (
        <div className="hg-tl-card is-hero" {...cardHit(p)}>
          <div className="hg-tl-hero">
            <Img src={p.cover} alt="" w={1080} h={1440} />
            {rank != null ? (
              <span className={`hg-tl-cate-badge hg-rank-badge ${rank <= 3 ? `top-${rank}` : ""}`}>TOP {rank}</span>
            ) : showCate ? (
              <span className="hg-tl-cate-badge">{cateLabel}</span>
            ) : null}
            {hasVideo && (
              <span className="hg-tl-media-badge"><IPlayF size={9} />视频</span>
            )}
          </div>
          <div className="hg-tl-hero-body">
            <div className="hg-tl-title">{p.title}</div>
            {desc && <p className="hg-tl-desc">{desc}</p>}
            {renderFooter(p)}
          </div>
        </div>
      );
    }
    return (
      <div className="hg-tl-card" {...cardHit(p)}>
        <div className="hg-tl-compact-row">
          <div className="hg-tl-compact-copy">
            {(rank != null || showCate) && (
              <div className="flex items-center gap-1.5 mb-1">
                {rank != null && (
                  <span className={`hg-rank-badge ${rank <= 3 ? `top-${rank}` : ""}`}>#{rank}</span>
                )}
                {showCate && (
                  <span className={`hg-tl-cate-chip${cateLabel === "黑料吃瓜" ? " is-gossip" : ""}`} style={{ marginBottom: 0 }}>
                    {cateLabel}
                  </span>
                )}
              </div>
            )}
            <div className="hg-tl-title">{p.title}</div>
            {desc && <p className="hg-tl-desc">{desc}</p>}
          </div>
          {p.cover && (
            <div className="hg-tl-thumb">
              <Img src={p.cover} alt="" w={270} h={360} />
              {hasVideo && (
                <span className="hg-tl-media-badge"><IPlayF size={8} /></span>
              )}
            </div>
          )}
        </div>
        {renderFooter(p)}
      </div>
    );
  };

  const renderFeed = (visible: Post[]) => {
    const ordered = sort === "trending"
      ? visible
      : visible.slice().sort((a, b) => {
          const ta = parsePostDate(a)?.getTime() ?? 0;
          const tb = parsePostDate(b)?.getTime() ?? 0;
          return tb - ta || b.id - a.id;
        });
    return (
      <div className="hg-tl-wrap">
        {ordered.map((p, idx) => (
          <div key={p.id}>
            {renderCardBody(p, idx === 0 && Boolean(p.cover), sort === "trending" ? idx + 1 : undefined)}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-page-x hg-editorial-bar relative z-10">
        {!embedded && onBack && (
          <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
        )}
        <h1 className="sr-only">吃瓜</h1>
        <div className="hg-ed-tabs" role="tablist" aria-label="博客分类">
          <Button card role="tab" aria-selected={cate === ""}
            className="hg-ed-tab"
            onClick={() => setCate("")}>
            全部
          </Button>
          {BLOG_CATEGORIES.map((c) => (
            <Button key={c.route} card role="tab" aria-selected={cate === c.route}
              className="hg-ed-tab"
              onClick={() => setCate(c.route)}>
              {c.name}
            </Button>
          ))}
        </div>
        <Button card className="hg-sub-btn" aria-label="搜索社区" onClick={() => push({ kind: "search", initialTab: "post" })}>
          <ISearch size={18} />
        </Button>
      </header>

      <div className="shrink-0 hg-page-x relative z-10">
        <div className="hg-posts-subbar">
          <span className="hg-posts-hint">
            {sort === "latest" ? "与官网博客实时同步" : "全站累计热度排行"}
          </span>
          <div className="hg-sort-seg" role="tablist" aria-label="排序方式">
            {SORTS.map((s) => (
              <Button key={s.key} card role="tab" aria-selected={sort === s.key}
                className="hg-sort-pill"
                onClick={() => setSort(s.key)}>
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div ref={scrollRef} aria-busy={loading} className="flex-1 scroll-y hg-page-x relative z-10"
        style={{ paddingBottom: "calc(110px + var(--sab, 0px))" }}
        onScroll={() => { markScrolling(); checkScrollBottom(); }}
        onTouchMove={markScrolling}>
        <PullIndicator pull={pull.pull} refreshing={pull.refreshing} progress={pull.progress} />
        {items.length ? (
          <FilteredContent items={items} scopeKey={`posts-${sort}-${cate}`}>
            {renderFeed}
          </FilteredContent>
        ) : loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err ? (
          <Empty icon={<IFireF size={26} />} title="吃瓜内容加载失败" sub={err} action="重试" onAction={() => loadMore(true)} />
        ) : (
          <Empty icon={<IFireF size={26} />} title="暂无吃瓜内容" sub="稍后再来看看" />
        )}
        <div ref={sentinel} className="h-10" />
        {err && items.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-3 py-2 text-[13px] text-danger" role="alert">
            <span>加载更多失败：{err}</span>
            <Button disabled={loading} onClick={() => loadMore()} className="text-primary pressable">重试</Button>
          </div>
        )}
        {!loading && !err && items.length > 0 && page < pages && <Button onClick={() => loadMore()} className="w-full mt-3">加载更多</Button>}
        {loading && items.length > 0 && <div className="flex justify-center py-2"><Loader className="w-6 h-6 spinner" /></div>}
      </div>
      <Sheet open={!!commentTarget} onClose={() => setCommentTarget(null)}>
        {commentTarget && (
          <div className="flex flex-col" style={{ height: "72dvh" }}>
            <CommentsPanel videoId={commentTarget.id} ep={0} total={commentTarget.total} kind="post" onClose={() => setCommentTarget(null)} />
          </div>
        )}
      </Sheet>
    </div>
  );
}

const isHtml = (s: string) => /<(p|div|br|img|h[1-6]|ul|ol|li|blockquote|span|strong|em)\b/i.test(s);
/* 过滤上游旧品牌标签，避免显示到界面。 */
const HIDDEN_POST_TAG = "\u9ec4\u679c";

/* ================= 吃瓜详情（网页式浏览） ================= */
export function PostDetail({ id, onBack, active = true }: { id: number; onBack: () => void; active?: boolean }) {
  const { toast, strictSecurity, muted, setMuted, push, user, setLoginOpen, isLiked, isFav, setLiked, setCollected, actionPending, addPostHistory, lineEpoch, accountScope, ambientGlow } = useStore();
  const { preferences, blockReason } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [post, setPost] = useState<(Post & { content?: string; video_url?: string }) | null>(null);
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const autoBackKey = useRef("");
  const [tagMenu, setTagMenu] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [likeDelta, setLikeDelta] = useState(0);
  useEffect(() => { if (!active) { setTagMenu(false); setCommentOpen(false); } }, [active]);
  const currentPost = loadedId === id ? post : null;
  const blocked = filtering && currentPost ? blockReason(currentPost.tags) : null;
  const allowed = !filtering || (!!currentPost && !blocked);
  useEffect(() => {
    if (active && currentPost && allowed) addPostHistory(id);
  }, [active, currentPost, allowed, id, addPostHistory]);
  useEffect(() => {
    if (!active || !filtering || !currentPost || !blocked) {
      if (!blocked) autoBackKey.current = "";
      return;
    }
    const key = String(id);
    if (autoBackKey.current === key) return;
    autoBackKey.current = key;
    onBack();
  }, [active, filtering, currentPost, blocked, id, onBack]);
  useEffect(() => { if (!allowed) setTagMenu(false); }, [allowed]);
  const [err, setErr] = useState<string | null>(null);
  const [play, setPlay] = useState(false);
  /* 吃瓜帖详情里的 video_url 恒为空，视频地址只在 playback 接口里；
     不解析就整页只有图文（issue #11）。segs 是分段地址，多数帖只有 1 段。 */
  const [segs, setSegs] = useState<string[]>([]);
  const [seg, setSeg] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [reload, setReload] = useState(0);
  const [mediaRetry, setMediaRetry] = useState(0);
  const [mediaError, setMediaError] = useState("");
  const [readProgress, setReadProgress] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const content = post?.content || "";
  const src = segs[seg] || "";
  /* 正文 HTML 属性对象在正文/安全模式不变时复用（上游 PR #166）：React 每次渲染都拿到同一个
     prop 对象，避免重新赋值 innerHTML。 */
  const articleHtml = useMemo(() => ({ __html: sanitizeHtml(content) }), [content, strictSecurity]);
  /* 线路/代理事件只推进 lineEpoch，不换帖子：已显示内容必须保留，后台刷新（上游 issue #165）。
     清空重置只属于「换帖子 / 换账号 / 手动重试」，否则自动选线一切线整页就闪回加载态。 */
  const shownKeyRef = useRef("");
  /* effect 里读最新值，避免把 loadedId/segs 加进依赖造成重复请求。 */
  const latestView = useRef({ loadedId: null as number | null, segs: [] as string[] });
  latestView.current = { loadedId, segs };
  const openSafeLink = (url: string) => {
    /* 同源站内短剧链接在 App 内打开（上游 6cff406），外链仍走系统浏览器 + 复制兜底 */
    const videoId = parseInternalVideoId(url);
    if (videoId !== null) {
      push({ kind: "feed", videoIds: [videoId], index: 0, title: currentPost?.title || "吃瓜" });
      return;
    }
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };

  useEffect(() => {
    let alive = true;
    const key = `${accountScope}:${id}`;
    /* 手动重试也要清空：reload 计数进 key，而不是只看「大于 0」。 */
    const reset = shownKeyRef.current !== `${key}:${reload}`;
    shownKeyRef.current = `${key}:${reload}`;
    if (reset) {
      setReadProgress(0);
      setLikeDelta(0);
      setCommentOpen(false);
      scrollRef.current?.scrollTo(0, 0);
      setPost(null);
      setLoadedId(null);
      setTagMenu(false);
      setErr(null);
      setPlay(false);
      setSegs([]);
      setSeg(0);
    }
    api.post(id)
      .then((p) => {
        if (!alive) return;
        setPost(p);
        setLoadedId(id);
        setErr(null);
        /* 旧接口返回直链时提供回退，不覆盖已经解析出的分段。 */
        if (p.video_url) { setSegs(previous => previous.length ? previous : [p.video_url!]); setPlay(true); }
      })
      .catch((e) => {
        if (!alive) return;
        /* 后台刷新失败不打断正在阅读的内容；首次加载失败才显示整页错误。 */
        if (latestView.current.loadedId !== id) setErr((e as Error).message || "加载失败");
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reload, lineEpoch, accountScope]);

  useEffect(() => {
    if (!allowed) { setResolving(false); return; }
    let alive = true;
    /* 已有可播地址时静默刷新：遮罩与错误条只在没有画面时出现。 */
    const silent = latestView.current.segs.length > 0;
    setResolving(!silent); setMediaError("");
    api.postPlayback(id)
      .then((r) => {
        if (!alive) return;
        const list = (r?.videos || []).map((v) => v?.url || "").filter(Boolean);
        if (list.length) { setSegs(list); setPlay(true); }
      })
      .catch(e => { if (alive && !silent) setMediaError(e instanceof Error ? e.message : "视频解析失败"); })
      .finally(() => { if (alive) setResolving(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reload, mediaRetry, allowed, lineEpoch, accountScope]);

  // Keep blocked content out of the surface while the host navigates back.
  if (currentPost && blocked) return <div className="absolute inset-0 flex items-center justify-center bg-bg" aria-label="正在返回">
    <Loader className="w-8 h-8 spinner" />
  </div>;

  return (
    <div className="ios-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <header className="shrink-0 hg-subpage-bar relative z-10">
        <Button card aria-label="返回" onClick={onBack} className="hg-sub-btn"><IBack size={19} /></Button>
        <div className="hg-sub-titles">
          <span className="hg-sub-title">吃瓜详情</span>
        </div>
        <Button card disabled={!currentPost} onClick={() => { if (active && allowed) setTagMenu(true); }}
          className="hg-tag-pill" style={{ minHeight: 30, padding: "0 11px" }}>
          不感兴趣
        </Button>
      </header>

      <div role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readProgress} className="hg-aurora-progress shrink-0 relative z-10"><div style={{ width: `${readProgress}%` }} /></div>
      {/* 详情页原来没接 markScrolling()（只有列表页接了），所以 html.is-scrolling 这个
          动效闸门在详情页从来没生效过 —— 滚动中任何无限动画都照跑。这里补上。 */}
      <div ref={scrollRef} data-post-scroll className="flex-1 scroll-y"
        style={{ paddingBottom: "calc(84px + var(--sab, 0px))" }}
        onScroll={event => {
          markScrolling();
          const el = event.currentTarget;
          const range = el.scrollHeight - el.clientHeight;
          setReadProgress(range > 0 ? Math.round(el.scrollTop / range * 100) : 100);
        }}
        onTouchMove={markScrolling}>
        {err ? (
          <Empty icon={<IFireF size={26} />} title="加载失败" sub={err} action="重试" onAction={() => setReload(n => n + 1)} />
        ) : !currentPost ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : (
          <>
            <div data-post-media className="relative w-full bg-black mx-auto" style={{ height: isMobile ? "min(48vh, 420px)" : "min(60vh, 640px)" }}>
              {play && src ? (
                <Player src={src} poster={cover(currentPost.cover)} autoPlay active={active && !tagMenu && !commentOpen} controls muted={muted} ambientGlow={ambientGlow}
                  onToggleMute={() => setMuted((m) => !m)} diagnosticContext={{ video_id: id, active: active && !tagMenu && !commentOpen }} className="w-full h-full"
                  onEnded={() => {
                    /* 多段吃瓜视频：播完自动接下一段 */
                    if (seg < segs.length - 1) setSeg(seg + 1); else setPlay(false);
                  }} />
              ) : src ? (
                <Button aria-label="播放视频" onClick={() => setPlay(true)} className="absolute inset-0">
                  <Img src={currentPost.cover} eager w={1080} h={1600} />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="w-14 h-14 rounded-full bg-black/70 flex items-center justify-center elev-2">
                        <IPlayF size={24} className="text-white ml-0.5" />
                      </span>
                    </span>
                </Button>
              ) : (
                <div className="absolute inset-0"><Img src={currentPost.cover} eager w={1080} h={1600} /></div>
              )}
              {resolving && !src && <div className="absolute inset-0 flex items-center justify-center gap-3 pointer-events-none bg-black/40 text-white"><Loader label="正在解析视频" /><span>正在解析视频…</span></div>}
            </div>
            {mediaError && !src && <div role="alert" className="flex flex-wrap items-center justify-center gap-3 px-4 py-3 text-[13px] text-danger"><span>{mediaError}</span><Button disabled={resolving} onClick={() => setMediaRetry(n => n + 1)}>重新解析</Button></div>}
              {segs.length > 1 && (
                <div role="group" aria-label="视频分段" className="flex items-center gap-2 px-4 py-3 overflow-x-auto">
                  <span className="text-[12px] text-mut shrink-0">视频分段</span>
                  {segs.map((_, i) => (
                    <Button card aria-label={`第 ${i + 1} 段`} aria-pressed={i === seg} key={i} onClick={() => { setSeg(i); setPlay(true); }}
                      className={`hg-ep-cell shrink-0${i === seg ? " is-on" : ""}`}
                      aria-current={i === seg ? "true" : undefined}
                      style={{ width: 42, height: 34 }}>
                      P{i + 1}
                    </Button>
                  ))}
                </div>
              )}
            <div className="px-4 pt-3.5 mx-auto max-w-[800px] select-text">
              <h1 className="text-[17px] font-bold text-on leading-snug">{currentPost.title}</h1>
              <div className="flex flex-wrap items-center gap-2 mt-2 text-[12px] text-mut">
                {currentPost.author?.id && (
                  <button type="button" className="text-primary font-medium hover:underline"
                    onClick={() => push({ kind: "user", id: currentPost.author!.id, name: currentPost.author!.name })}>
                    @{currentPost.author.name || "作者"}
                  </button>
                )}
                <span>{currentPost.publish_time || currentPost.created_at}</span>
                <span className="flex items-center gap-1"><IFireF size={10} />{fmt(postHot(currentPost))}</span>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {(currentPost.tags || []).filter((t) => !t.includes(HIDDEN_POST_TAG)).slice(0, 8).map((t) => (
                  <Button card key={t} onClick={() => push({ kind: "tag", tag: t, name: t })} className="hg-tag-pill">
                    <span className="hg-tag-hash">#</span><span>{t}</span>
                  </Button>
                ))}
              </div>
              {currentPost.content && (
                (isHtml(currentPost.content) || (!strictSecurity && /<[a-z][\s\S]*>/i.test(currentPost.content)))
                  ? <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={articleHtml} />
                  : <Surface className="mt-3.5 rounded-(--r-md) bg-s2 p-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{currentPost.content}</Surface>
              )}
            </div>
          </>
        )}
      </div>

      {currentPost && (() => {
        const liked = isLiked(id, undefined, "post");
        const faved = isFav(id, "post");
        const likeBusy = actionPending(`like:post:${id}:0`);
        const favBusy = actionPending(`collect:post:${id}`);
        const likeTotal = Math.max(0, (currentPost.counts?.like ?? 0) + likeDelta);
        return (
          <div className="hg-post-detail-bar" role="toolbar" aria-label="帖子互动">
            <Button card disabled={likeBusy} className={`hg-post-detail-btn${liked ? " is-liked" : ""}`}
              aria-label={liked ? "取消点赞" : "点赞"}
              onClick={() => {
                if (!user) { setLoginOpen(true); return; }
                if (likeBusy) return;
                const next = !liked;
                setLikeDelta((d) => d + (next ? 1 : -1));
                void setLiked("post", id, 0, next).catch((e) => {
                  setLikeDelta((d) => d + (next ? -1 : 1));
                  toast((e as Error)?.message || "点赞失败", "info");
                });
              }}>
              {liked ? <IHeartF size={16} /> : <IHeart size={16} />}
              <span>点赞{likeTotal > 0 ? ` ${fmt(likeTotal)}` : ""}</span>
            </Button>
            <Button card disabled={favBusy} className={`hg-post-detail-btn${faved ? " is-fav" : ""}`}
              aria-label={faved ? "取消收藏" : "收藏"}
              onClick={() => {
                if (!user) { setLoginOpen(true); return; }
                if (favBusy) return;
                const next = !faved;
                void setCollected("post", id, next).then(() => {
                  toast(next ? "已收藏帖子" : "已取消收藏", next ? "star" : "info", ACTION_TOAST_SLOT);
                }).catch((e) => toast((e as Error)?.message || "收藏失败", "info"));
              }}>
              {faved ? <IStarF size={16} /> : <IStar size={16} />}
              <span>{faved ? "已收藏" : "收藏"}</span>
            </Button>
            <Button card className="hg-post-detail-btn" aria-label="查看评论"
              onClick={() => setCommentOpen(true)}>
              <IComment size={16} />
              <span>评论{(() => {
                const n = Number(currentPost.counts?.comment) || Number(currentPost.comment_count) || 0;
                return n > 0 ? ` ${fmt(n)}` : "";
              })()}</span>
            </Button>
          </div>
        );
      })()}

      <Sheet open={active && commentOpen} onClose={() => setCommentOpen(false)}>
        <div className="flex flex-col" style={{ height: "72dvh" }}>
          <CommentsPanel videoId={id} ep={0}
            total={Number(currentPost?.counts?.comment) || Number(currentPost?.comment_count) || 0}
            kind="post" onClose={() => setCommentOpen(false)} />
        </div>
      </Sheet>
      <TagBlockMenu open={tagMenu && active} tags={currentPost?.tags || []} onClose={() => setTagMenu(false)} />
    </div>
  );
}
