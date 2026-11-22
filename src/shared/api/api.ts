import { invoke } from "@tauri-apps/api/core";
import { tracePlayback } from "../diagnostics/playbackDiagnostics";
import type {
  AccountHistoryPage, AccountIdentity, AccountSnapshot, CommentPage, Detail, HotSearchVideo, Paged, PlayInfo, Post, PostCategory, RankItem, TagGroup, TopicCard, TopicDetail, User, UserProfile, VideoCard,
} from "./types";

/* ── 运行环境 ───────────────────────────────────────────── */

/** 应用版本（构建时由 vite.config.ts 从 package.json 注入） */
export const APP_VERSION = __APP_VERSION__;

const ua = navigator.userAgent;
export const isAndroid = /Android/i.test(ua);
/** iPhone 的 UA 也带「like Mac OS X」，必须先于 macOS 判断；iPadOS 默认伪装成 Mac，用触点数区分。 */
export const isIos =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
  // iPadOS 13+ 默认把自己报成 MacIntel，只能靠触点数认
  (typeof navigator.platform === "string" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isMacos = !isIos && /Macintosh|Mac OS X/i.test(ua);
/** Linux 桌面：webkit2gtk 的 UA 是「X11; Linux x86_64」。必须排在 Windows 之前判断，
 *  否则会被当成 Windows；而 Android 的 UA 里同样带「Linux」，所以必须先排除安卓。 */
export const isLinux = !isAndroid && !isIos && !isMacos && /Linux|X11/i.test(ua);
export const platform: "android" | "ios" | "windows" | "macos" | "linux" =
  isAndroid ? "android" : isIos ? "ios" : isMacos ? "macos" : isLinux ? "linux" : "windows";
/** WebView 内核版本：能不能走 MSE、能解哪些封装，是「无法播放」的首要判据。
 *  安卓取 Chrome/xxx（System WebView），Linux/macOS 取 WebKit 的 Version/xxx。 */
export const webviewVersion =
  /Chrome\/([\d.]+)/.exec(ua)?.[1] || /Version\/([\d.]+)/.exec(ua)?.[1] || "?";
/** 移动端（安卓 / iOS）共用触屏界面 */
export const isMobile = isAndroid || isIos;

/** 媒体基址随平台不同（Rust 侧对应 `media::LOCAL_ORIGIN`，两边必须一致）：
 *  Windows / Android → `http://<scheme>.localhost`（自定义协议，WebView 自己加载）
 *  macOS / iOS → `hg://localhost`（WebKit 的 scheme handler）
 *  Linux → `http://127.0.0.1:17650`：WebKitGTK 的 <video> 由 GStreamer 播放，
 *          它拿不到自定义 scheme，所以由 Rust 侧在 loopback 上起 HTTP 代理
 *          （`src-tauri/src/linux_http.rs`，端口必须与此一致）。 */
export const LOCAL =
  isMacos || isIos ? "hg://localhost" : isLinux ? "http://127.0.0.1:17650" : "http://hg.localhost";

/** src 是否已是本地协议地址（避免在详情页把代理地址再包一层） */
export const isLocalMedia = (src: string) => src.startsWith(`${LOCAL}/`);

/** 封面：经本地协议解密（站点封面是 AES 密文）。
 *  `w` / `h` 是**输出像素**上限（调用方按 cssWidth × dpr 传），Rust 侧解码后等比缩到界限内；
 *  不传就原样透传 —— 但长图原尺寸解码是滚动掉帧/隔帧亮度的根源，页面里请尽量带上。 */
export const cover = (url?: string, w?: number, h?: number) => {
  if (!url) return "";
  let out = `${LOCAL}/img?u=${encodeURIComponent(url)}`;
  if (w && w > 0) out += `&w=${Math.round(w)}`;
  if (h && h > 0) out += `&h=${Math.round(h)}`;
  return out;
};

/** 播放列表：经本地协议改写分片地址，规避 CORS 与防盗链。 */
export const playlist = (url: string) => `${LOCAL}/hls?u=${encodeURIComponent(url)}`;

/* ── 调用封装 ───────────────────────────────────────────── */

/** 写一行到应用数据目录 debug.log（用户反馈「打不开」时要的就是它） */
export const logLine = (msg: string) => invoke("debug_log", { msg }).catch(() => {});

/** 网络类失败的样子：没有 HTTP 状态码，纯链路层（DNS / 连接 / 超时 / TLS） */
const NET_FAIL = /dns|timed? ?out|timeout|connection|refused|reset|unreachable|broken pipe|tls|ssl|handshake|证书|网络|连接/i;
/** 只读命令：链路抖动时可以安全重试一次；写操作绝不重试（避免重复提交） */
const READ_ONLY = new Set([
  "api_me", "api_feed", "api_original_videos", "api_category", "api_rank", "api_search",
  "api_posts", "api_blog_posts", "api_post", "api_post_comments", "api_video", "api_play", "api_comments",
  "api_topics", "api_topic", "api_tags", "api_tag_videos", "api_search_hot",
  "api_post_playback", "api_post_categories", "api_post_category", "api_post_tag", "api_related", "api_following", "api_user", "api_user_stats", "api_user_videos",
]);
/** 给自动选线用的观察点。api.ts 不反向依赖 autoLine，避免循环 import。 */
export type NetObserver = (r: { ok: boolean; cmd: string; msg?: string; networkish?: boolean }) => void;
let netObserver: NetObserver | null = null;
export const setNetObserver = (fn: NetObserver | null) => { netObserver = fn; };
const notifyNet = (r: Parameters<NetObserver>[0]) => {
  try { netObserver?.(r); } catch { /* 观察者不能影响请求本身 */ }
};
const failMessage = (msg: string, status?: string) =>
  status
    ? `服务器请求失败（HTTP ${status}），请稍后重试或在设置中切换线路`
    : msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;

/** 读缓存 TTL（毫秒）。口径按"用户感知的新鲜度"定：
 *  - 首页 feed：15s（短剧站一天更新几十次，30s 会让人看到"昨天那批"）；
 *  - 分类 / 榜单 / 专题 / 吃瓜列表：30s（目录页，但用户滑动+下拉刷新时不能给他旧页）；
 *  - 详情：5min（剧本信息、集数几乎不变；收藏/点赞数由本地乐观值维护）；
 *  - 播放地址：**永不缓存**（CDN token 会过期；每次进集都必须重新请求 api_play）。
 *  没过期直接给；过期但还在 STALE_WINDOW 内先给旧值再后台刷新，刷新结果通过
 *  `hg:api-data` 事件广播回页面（SWR 真生效，见 call() / publishData()）。
 *  任何"刷新"入口（下拉、回前台、切 tab）都必须传 force=true 绕过这一层。
 *
 *  为什么不在 URL 上拼 cache-buster：实测上游 `cache-control: private, no-store`，
 *  本来就不允许任何中间层缓存；而给 /api/videos 加任何未知查询参数（_t/t/r/v 都试过）
 *  会直接 400「请求参数无效」。所以"绕过缓存"只能是应用层语义（force），不能改 URL。
 */
const CACHE_TTL: Record<string, number> = {
  api_feed: 15_000,
  api_category: 30_000,
  api_original_videos: 30_000,
  api_tag_videos: 30_000,
  api_posts: 30_000,
  api_post_category: 30_000,
  api_blog_posts: 30_000,
  api_topic: 30_000,
  api_topics: 30_000,
  api_rank: 30_000,
  api_video: 300_000,
  api_post: 180_000,
  api_related: 300_000,
  api_tags: 300_000,
  api_post_categories: 300_000,
  api_search_hot: 120_000,
};
/** 过了 TTL 还能当"垫底数据"用的窗口：先给旧内容，后台静默刷新。
 *  10min 太长——用户看到的是十分钟前的内容，且旧代码刷新完也不回填界面，
 *  这就是"重进也不变"的主因。收到 3min 内，且刷新结果会广播回页面。 */
const STALE_WINDOW = 3 * 60_000;
/** 缓存条目上限（首页分页 + 详情 + 榜单，200 条足够，超出按插入顺序淘汰最旧的） */
const CACHE_MAX = 200;
const READ_CACHE = new Map<string, { value: unknown; expires: number; at: number }>();
const INFLIGHT = new Map<string, Promise<unknown>>();
export const clearApiReadCache = () => {
  READ_CACHE.clear();
  INFLIGHT.clear();
};
/** 账号变了（登录 / 退出 / 换账号）时由 store 派发；全库只在这里监听。 */
export const ACCOUNT_CHANGED_EVENT = "hg:account-changed";
/* 读缓存的作用域：线路 + 账号。
 *  - 键里带上作用域，换线 / 换账号之后旧缓存自然打不中（只清 Map 不够：清完那一刻
 *    还在途的旧请求回来会把上一位用户的数据重新写进去）；
 *  - 同时保留「换线 / 换账号 → 整体清」的语义，避免不同作用域的历史条目堆在 Map 里。 */
let lineScope = 0;
let accountScope = "guest";
/** `guest` 或 `origin:id`（与 accountData 的桶键一致）。换值即清缓存。 */
export const setApiAccountScope = (scope: string) => {
  const next = scope || "guest";
  if (next === accountScope) return;
  accountScope = next;
  clearApiReadCache();
};
if (typeof window !== "undefined") {
  window.addEventListener("hg:line-changed", () => { lineScope++; clearApiReadCache(); });
  window.addEventListener(ACCOUNT_CHANGED_EVENT, clearApiReadCache);
}
const cacheKey = (cmd: string, args?: Record<string, unknown>) =>
  `L${lineScope}|@${accountScope}|${cmd}:${args ? JSON.stringify(args) : ""}`;
/** 页面订阅 `hg:api-data` 时要自己算同一个 key，所以把它导出去（别各写一份）。 */
export const apiCacheKey = (cmd: string, args?: Record<string, unknown>) => cacheKey(cmd, args);

/** 数据新鲜度广播：任何一次真实请求成功后发出，带上缓存 key 与结果。
 *  页面用 useApiRefresh(cmd, args, cb) 订阅——命中旧缓存后后台刷新拿回来的新数据
 *  会原地替换界面，而不是等用户"重进一次"才看到（旧代码刷新完结果直接丢掉）。 */
export const API_DATA_EVENT = "hg:api-data";
export type ApiDataEvent = { cmd: string; key: string; value: unknown };
function publishData(cmd: string, key: string, value: unknown) {
  if (!key || typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent<ApiDataEvent>(API_DATA_EVENT, { detail: { cmd, key, value } }));
  } catch { /* 广播失败不影响请求本身 */ }
}

function remember(key: string, ttl: number, value: unknown) {
  if (!key || !ttl) return;
  if (READ_CACHE.size >= CACHE_MAX) {
    const oldest = READ_CACHE.keys().next().value;
    if (oldest !== undefined) READ_CACHE.delete(oldest);
  }
  READ_CACHE.set(key, { value, expires: Date.now() + ttl, at: Date.now() });
}

/** 一次真正的请求（含链路异常重试一次），成功后写缓存并广播。 */
async function request<T>(cmd: string, args: Record<string, unknown> | undefined, key: string, ttl: number): Promise<T> {
  const once = () => invoke(cmd, args) as Promise<T>;
  try {
    const r = await once();
    notifyNet({ ok: true, cmd });
    remember(key, ttl, r);
    publishData(cmd, key, r);
    return r;
  } catch (e) {
    const msg = typeof e === "string" ? e : "请求失败，请检查网络";
    const status = /^HTTP (\d{3})\b/.exec(msg)?.[1];
    const networkish = !status && NET_FAIL.test(msg);
    // 落盘完整错误链（dns error / connection refused / 证书错误…），toast 只显示截断版
    logLine(`[api] ${cmd} → ${msg}`);
    tracePlayback("api.fail", { cmd, err: msg, status: status ?? null, networkish });
    notifyNet({ ok: false, cmd, msg, networkish });
    // 线路可能正被自动切走：给切换留一点时间，只读请求重试一次，用户就不用看见这条错误
    if (networkish && READ_ONLY.has(cmd)) {
      logLine(`[api] ${cmd} 链路异常，1.2s 后重试一次`);
      tracePlayback("api.retry", { cmd, err: msg });
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const r = await once();
        logLine(`[api] ${cmd} 重试成功`);
        tracePlayback("api.retry_ok", { cmd });
        notifyNet({ ok: true, cmd });
        remember(key, ttl, r);
        publishData(cmd, key, r);
        return r;
      } catch (e2) {
        const again = typeof e2 === "string" ? e2 : msg;
        const againStatus = /^HTTP (\d{3})\b/.exec(again)?.[1];
        logLine(`[api] ${cmd} 重试仍失败 → ${again}`);
        tracePlayback("api.retry_failed", { cmd, err: again, status: againStatus ?? null });
        throw new Error(failMessage(again, againStatus));
      }
    }
    throw new Error(failMessage(msg, status));
  }
}

/** 后台静默刷新：同一个 key 只跑一次，失败不弹任何东西（下次进来还是旧值兜底）。 */
function revalidate(cmd: string, args: Record<string, unknown> | undefined, key: string, ttl: number) {
  if (!key || INFLIGHT.has(key)) return;
  const task = request(cmd, args, key, ttl);
  INFLIGHT.set(key, task);
  const done = () => { if (INFLIGHT.get(key) === task) INFLIGHT.delete(key); };
  // 两个分支都接住，避免后台刷新失败变成未处理的 rejection
  void task.then(done, done);
}

/** `force=true` = 刷新语义：跳过内存缓存与在途合并，直接打一次真实请求并覆盖缓存。
 *  下拉刷新 / 回前台 / 切 tab 都用它，否则用户"明明刷新了"却还是旧列表。 */
async function call<T>(cmd: string, args?: Record<string, unknown>, force = false): Promise<T> {
  if (cmd === "line_set" || cmd === "line_custom_set" || cmd === "line_reset" || cmd === "cache_clear") {
    clearApiReadCache();
  }
  const ttl = CACHE_TTL[cmd] ?? 0;
  const key = ttl ? cacheKey(cmd, args) : "";
  /* 1) 缓存命中：没过期直接给；过期但还在 STALE_WINDOW 内 —— 先给旧内容、后台悄悄刷新。
        这就是"先给缓存后静默刷新"：返回首页/详情不再空屏等网络，刷新结果由
        publishData 广播回页面，界面自己换新（旧代码刷新完把结果丢了）。 */
  if (!force && ttl && key) {
    const hit = READ_CACHE.get(key);
    if (hit) {
      if (hit.expires > Date.now()) {
        /* 命中缓存也要补一次真实请求（要求 C）：结果通过 hg:api-data 广播回页面，
           界面原地换新。3s 内的重复命中不再补，避免同一屏多次渲染打一串请求。 */
        if (Date.now() - hit.at > 3_000) revalidate(cmd, args, key, ttl);
        return hit.value as T;
      }
      if (hit.expires + STALE_WINDOW > Date.now()) {
        revalidate(cmd, args, key, ttl);
        return hit.value as T;
      }
      READ_CACHE.delete(key);
    }
  }
  if (force && key) READ_CACHE.delete(key);
  /* 2) 并发去重：只读命令按 cmd+参数 合并"在途"请求。
        以前只有配了 TTL 的命令才去重，同一次渲染里两处同时拉同一页会发两遍。
        force 不参与合并：用户主动刷新必须真的出网。 */
  const dedupeKey = !force && READ_ONLY.has(cmd) ? key || cacheKey(cmd, args) : "";
  if (dedupeKey) {
    const pending = INFLIGHT.get(dedupeKey);
    if (pending) return pending as Promise<T>;
  }
  const task = request<T>(cmd, args, key, ttl);
  if (dedupeKey) {
    INFLIGHT.set(dedupeKey, task);
    try {
      return await task;
    } finally {
      if (INFLIGHT.get(dedupeKey) === task) INFLIGHT.delete(dedupeKey);
    }
  }
  return task;
}

/* ── 接口 ───────────────────────────────────────────────── */

export const api = {
  boot: () =>
    call<{
      user: User | null;
      logged_in: boolean;
      base: string;
      strict_security?: boolean;
      cli_relaxed?: boolean;
    }>("app_boot"),
  securitySet: (strict: boolean) => call<boolean>("security_set", { strict }),
  login: (username: string, password: string) =>
    call<AccountSnapshot>("api_login", { username, password }),
  register: (username: string, password: string, email = "") =>
    call<AccountSnapshot>("api_register", { username, password, email }),
  logout: (identity?: AccountIdentity) => call<{ ok: boolean }>("api_logout", identity ? { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin } : {}),
  me: (identity?: AccountIdentity) => call<AccountSnapshot>("api_me", identity ? { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin } : {}),
  accountHistory: (identity: AccountIdentity, page = 1, size = 50) => call<AccountHistoryPage>("api_account_history", { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin, page, size }),
  accountHistoryRecord: (identity: AccountIdentity, videoId: number, ep: number) => call<unknown>("api_account_history_record", { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin, videoId, ep }),
  accountHistoryDelete: (identity: AccountIdentity, ids: number[]) => call<unknown>("api_account_history_delete", { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin, ids }),

  /** `sort="new"` = 站点「最新上架」（/api/videos?sort=new，实测有效）。
   *  最后一个参数 `force=true` 表示刷新语义（绕过读缓存），下拉刷新/回前台/切 tab 用。 */
  feed: (page = 1, size = 20, sort?: "new", force = false) => call<Paged<VideoCard>>("api_feed", { page, size, sort: sort ?? null }, force),
  topics: (force = false) => call<{ items: TopicCard[] }>("api_topics", undefined, force),
  topic: (slug: string, page = 1, size = 20, force = false) => call<TopicDetail>("api_topic", { slug, page, size }, force),
  tags: () => call<{ categories: TagGroup[] }>("api_tags"),
  tagVideos: (tag: string, page = 1, size = 20, force = false) =>
    call<Paged<VideoCard>>("api_tag_videos", { tag, page, size }, force),
  postTag: (tag: string, page = 1, size = 20) =>
    call<Paged<Post>>("api_post_tag", { tag, page, size }),
  category: (cate: string, page = 1, size = 20, sort?: string, force = false) =>
    call<Paged<VideoCard>>("api_category", { cate, page, size, sort: sort ?? null }, force),
  originalVideos: (cate: string, page = 1, size = 20, sort?: string, force = false) =>
    call<Paged<VideoCard>>("api_original_videos", { cate, page, size, sort: sort ?? null }, force),
  rank: (kind: "hot" | "recommend" | "potential", force = false) =>
    call<{ type: string; items: RankItem[] }>("api_rank", { kind }, force),
  /** 全站搜索。`kind` 省略时后端只搜短剧；吃瓜帖要显式传 "post"（issue #34）。 */
  search: (q: string, page = 1, size = 20, kind?: "video" | "post") =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      "api_search", { q, page, size, kind: kind ?? null },
    ),
  /** 只搜吃瓜帖：返回结构是 Post 而不是 VideoCard。 */
  searchPosts: (q: string, page = 1, size = 20) =>
    call<{ items: Post[]; pagination: Paged<Post>["pagination"]; keyword: string }>(
      "api_search", { q, page, size, kind: "post" },
    ),
  searchHot: (force = false) => call<{ items: HotSearchVideo[] }>("api_search_hot", undefined, force),
  posts: (page = 1, size = 20, sort?: string, force = false) =>
    call<Paged<Post>>("api_posts", { page, size, sort: sort ?? null }, force),
  blogPosts: (cate: "" | "gossip" | "reviews" = "", page = 1, force = false) =>
    call<Paged<Post>>("api_blog_posts", { cate: cate || null, page }, force),
  post: (id: number, force = false) => call<Post & { content?: string; video_url?: string }>("api_post", { id }, force),
  /** 吃瓜帖视频：详情里 video_url 恒为空，地址由 playback 接口下发（可能多段）。 */
  postPlayback: (id: number) => call<{ mode?: number; videos?: { index: number; url: string }[] }>("api_post_playback", { id }),

  video: (id: number, force = false) => call<Detail>("api_video", { id }, force),
  play: (id: number, ep: number) => call<PlayInfo>("api_play", { id, ep }),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>("api_comments", { id, ep, page, size }),
  commentSend: (id: number, ep: number, text: string, replyId?: number) => {
    READ_CACHE.delete(cacheKey("api_video", { id }));
    return call<unknown>("api_comment_send", { id, ep, text, replyId: replyId ?? null });
  },

  clearCache: () => invoke<{ webCache: boolean; platform: string }>("cache_clear").finally(clearApiReadCache),
  netDiag: () => invoke<Record<string, unknown>>("net_diag"),
  postLike: (id: number, on: boolean, identity?: AccountIdentity) => {
    READ_CACHE.delete(cacheKey("api_post", { id }));
    return invoke<unknown>("api_post_like", { id, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin });
  },
  postCollect: (id: number, on: boolean, identity?: AccountIdentity) => {
    READ_CACHE.delete(cacheKey("api_post", { id }));
    return invoke<unknown>("api_post_collect", { id, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin });
  },
  postComments: (id: number, page: number, size: number) => call<CommentPage>("api_post_comments", { id, page, size }),
  postCategories: () => call<{ items: PostCategory[] }>("api_post_categories"),
  postCategory: (route: string, page = 1, size = 20, sort?: string, force = false) =>
    call<Paged<Post>>("api_post_category", { route, page, size, sort: sort ?? null }, force),
  related: (id: number, force = false) => call<{ items: VideoCard[] }>("api_related", { id }, force),
  following: (page = 1, size = 20) => call<Paged<VideoCard>>("api_following", { page, size }),
  user: (id: number) => call<UserProfile>("api_user", { id }),
  userStats: (id: number) => call<{ user_id: number; like_count: number; following: number; followers: number; video_count: number; post_count: number }>("api_user_stats", { id }),
  userVideos: (id: number, page = 1, size = 20) => call<Paged<VideoCard>>("api_user_videos", { id, page, size }),
  like: (id: number, ep: number, on: boolean, identity?: AccountIdentity) => {
    READ_CACHE.delete(cacheKey("api_video", { id }));
    return call<unknown>("api_like", { id, ep, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin });
  },
  collect: (id: number, on: boolean, identity?: AccountIdentity) => {
    READ_CACHE.delete(cacheKey("api_video", { id }));
    return call<unknown>("api_collect", { id, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin });
  },
  follow: (uid: number, on: boolean, identity?: AccountIdentity) => call<unknown>("api_follow", { uid, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin }),

  /* 线路（数据源）：固定线路写死在 Rust 侧，镜像线路从地址发布页拉、推荐镜像从发布入口页拉 */
  lineState: () => call<LineState>("line_state"),
  lineSet: (url: string) => call<string>("line_set", { url }),
  lineCustomSet: (url: string) => call<LineApply>("line_custom_set", { url }),
  lineReset: () => call<LineApply>("line_reset"),
  lineCancel: () => call<void>("line_cancel"),
  lineMirrors: () => call<LineMirrors>("line_mirrors"),
  lineProbe: (urls: string[]) => call<LineProbe[]>("line_probe", { urls }),
  lineAuto: () => call<LineAuto>("line_auto"),
  /* 当前是镜像时敲一次主站，通了就切回（不清会话） */
  lineTryMain: () => call<LineTryMain>("line_try_main"),
  /* 线路体检：探一次 /api/videos，和自动选线同一判据 */
  lineHealth: () => call<LineHealth>("line_health"),

  /* 应用内代理：只影响本应用的上游网络请求。 */
  proxyState: () => call<ProxyState>("proxy_state"),
  proxySet: (mode: ProxyMode, url: string) => call<ProxyState>("proxy_set", { mode, url }),
  proxyTest: (mode: ProxyMode, url: string) => call<ProxyProbe>("proxy_test", { mode, url }),

  /* 更新检查：对比 GitHub Release 的 tag */
  checkUpdate: () => call<UpdateInfo>("check_update"),
  openUrl: (url: string) => call<void>("open_url", { url }),
};

/* ── 更新检查 ───────────────────────────────────────────── */

export type UpdateInfo = {
  /** 当前平台对应的安装包；没有就是这次 release 没给本平台出包 */
  asset?: { name: string; url: string } | null;
  current: string;
  latest: string;
  tag?: string;
  has_update: boolean;
  url: string;
  name?: string;
  published_at?: string;
  notes?: string;
};

/* ── 线路（数据源） ─────────────────────────────────────── */

export type LineItem = { name?: string; url: string; host?: string };
export type LineState = { base: string; default: string; fixed: LineItem[]; custom?: boolean };
export type LineApply = { base: string; custom: boolean };
export type LineMirrors = { source: string; script?: string; items: LineItem[]; recommended_source?: string; recommended: LineItem[] };
export type LineProbe = { url: string; ok: boolean; status?: number; ms: number; error?: string };
export type LineHealth = { base: string; ok: boolean; ms: number; status: number | null };

export type ProxyMode = "system" | "custom" | "off";
export type ProxyState = {
  mode: ProxyMode;
  /** 保存过的自定义地址，仅用于设置表单回填，不写入日志。 */
  url: string;
  /** 不含认证信息的实际出口。 */
  effective?: string | null;
  system_proxy?: boolean;
  env_proxy?: boolean;
};
export type ProxyProbe = { ok: boolean; status?: number | null; ms: number; error?: string; via?: string };

/** 自动选线：主站可用时优先，否则检测可信发布页中的镜像。 */
export type LineAutoCandidate = {
  /** main=固定线路；mirror=发布页镜像；seed=内置兜底；custom=用户自定义线路 */
  tier: "main" | "cn" | "mirror" | "seed" | "custom";
  url: string;
  ok: boolean;
  reachable: boolean;
  ms: number;
  status: number | null;
};
export type LineAuto = {
  cancelled?: boolean;
  previous: string;
  base: string;
  switched: boolean;
  pick: {
    base: string;
    tier: "main" | "cn" | "mirror" | "seed" | "custom" | "none";
    ms: number;
    reason: string;
    candidates: LineAutoCandidate[];
  };
};

/** 回切主站的探测结果：`probe.ok` 为主站到底通不通 */
export type LineTryMain = {
  cancelled?: boolean;
  previous: string;
  base: string;
  switched: boolean;
  probe: { ok: boolean; base: string; tier: string; ms: number; status: number | null };
};

/** `https://a.b/c` → `a.b`（线路展示用） */
export const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
};

/* ── 自检：验证 webview → 本地协议 → 上游 的取流链路 ───────── */
export async function selfTest(): Promise<string> {
  const steps: string[] = [];
  try {
    const info = await api.play(117, 3);
    steps.push(`play:${info?.video_url ? "ok" : "empty"}`);
    const hlsUrl = `${LOCAL}/hls?u=${encodeURIComponent(info.video_url)}`;
    const r1 = await fetch(hlsUrl);
    const txt = await r1.text();
    steps.push(`hls:${r1.status}/${txt.length}/${txt.startsWith("#EXTM3U") ? "m3u8" : "bad"}`);
    const keyLine = txt.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    if (keyLine) {
      const m = keyLine.match(/URI="([^"]+)"/);
      if (m) {
        const rustUrl = m[1];
        steps.push(`rustUrl:${rustUrl.slice(0, 60)}`);
        // A/B：用 JS 重新编码同一条上游地址
        const inner = decodeURIComponent(rustUrl.split("?u=")[1] || "");
        steps.push(`inner:${inner.slice(0, 50)}`);
        try {
          const rk = await fetch(rustUrl);
          const bk = await rk.arrayBuffer();
          steps.push(`keyRust:${rk.status}/${bk.byteLength}`);
        } catch (e) { steps.push(`keyRust:throw:${(e as Error).message.slice(0, 30)}`); }
        try {
          const rk2 = await fetch(`${LOCAL}/seg?u=${encodeURIComponent(inner)}`);
          const bk2 = await rk2.arrayBuffer();
          steps.push(`keyJs:${rk2.status}/${bk2.byteLength}`);
        } catch (e) { steps.push(`keyJs:throw:${(e as Error).message.slice(0, 30)}`); }
      }
    }
    const segLine = txt.split("\n").find((l) => l && !l.startsWith("#") && l.includes("/seg?u="));
    if (segLine) {
      try {
        const r2 = await fetch(segLine.trim());
        const buf = await r2.arrayBuffer();
        steps.push(`seg:${r2.status}/${buf.byteLength}`);
      } catch (e) { steps.push(`seg:throw:${(e as Error).message.slice(0, 40)}`); }
    } else steps.push("seg:no-line");
  } catch (e) {
    steps.push(`err:${(e as Error).message.slice(0, 60)}`);
  }
  return steps.join(" | ");
}

/* ── 格式化 ─────────────────────────────────────────────── */

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const dur = (s?: number | string) => {
  const n = Number(s) || 0;
  if (n <= 0) return "";
  const m = Math.floor(n / 60);
  const ss = n % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

/** 非 m3u8 媒体（mp4 等）走 /seg 原样透传 */
export function directMedia(url: string): string {
  return `${LOCAL}/seg?u=${encodeURIComponent(url)}`;
}

/** 按扩展名选择代理方式：m3u8 → 播放列表改写；其它 → 原样透传 */
export function mediaUrl(url: string): string {
  return /\.m3u8(\?|$)/i.test(url) ? playlist(url) : directMedia(url);
}
