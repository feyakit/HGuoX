/**
 * 详情首屏加速（低风险包装层，不动数据层）：
 *
 * 1. **预取**：列表页拿到首屏卡片后，对前几张并发预取详情（并发 2，只取 JSON，失败静默）。
 * 2. **慢线路并行**：详情请求超过 3s 没回，就走 autoLine 的同一入口（`repickForSlowRequest`，
 *    尊重「自动选线」开关与偏好线路）换一条更快线路，再发一次同样的详情请求，谁先成功用谁。
 *    **不改**用户保存的线路偏好（判定在 linePolicy，不需要换线时不换）。
 *
 * 两件事都只包在 `api.video` 外面，Rust 侧与接口形状不变。
 */
import { api, logLine } from "./api";
import { repickForSlowRequest } from "../network/autoLine";
import type { Detail } from "./types";

const CACHE_TTL_MS = 5 * 60_000;
/* 磁盘缓存（SWR）：最近 50 部详情，带时间戳，整包控制在 ~1MB 内 */
const DISK_KEY = "hguox_detail_cache_v1";
const DISK_MAX_ITEMS = 50;
const DISK_MAX_BYTES = 1_000_000;
const DISK_WRITE_DEBOUNCE_MS = 400;
const SLOW_MS = 3_000;
/** 换线最多等这么久：详情已经慢了，等探活不该把「快路」拖得更慢 */
const REPICK_WAIT_MS = 1_200;
const PREFETCH_LIMIT = 4;
const PREFETCH_CONCURRENCY = 2;

type Entry = { at: number; data: Detail };
const cache = new Map<number, Entry>();
const inflight = new Map<number, Promise<Detail>>();
let diskTimer = 0;
let diskDirty = false;

/** 读磁盘缓存（坏数据/超限一律当没有，不抛） */
function hydrateFromDisk() {
  try {
    const raw = localStorage.getItem(DISK_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { v?: number; order?: number[]; items?: Record<string, Entry> };
    if (parsed?.v !== 1 || !parsed.items) return;
    for (const id of parsed.order || []) {
      const entry = parsed.items[String(id)];
      if (entry?.data && Number.isFinite(entry.at)) cache.set(Number(id), entry);
    }
  } catch {
    /* 解析失败：忽略这份缓存（下次写入会覆盖） */
  }
}

/** 落盘：按写入时间排序，超 50 条或超 1MB 从最旧的开始丢 */
function flushDisk() {
  diskTimer = 0;
  if (!diskDirty) return;
  diskDirty = false;
  try {
    const ids = [...cache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, DISK_MAX_ITEMS);
    let order: number[] = [];
    let items: Record<string, Entry> = {};
    /* 从新到旧塞，塞到超预算就停（保证 JSON 不超过 ~1MB） */
    for (const [id, entry] of ids) {
      const next = { ...items, [String(id)]: entry };
      const nextOrder = [...order, id];
      const size = JSON.stringify({ v: 1, order: nextOrder, items: next }).length;
      if (size > DISK_MAX_BYTES && order.length) break;
      items = next;
      order = nextOrder;
    }
    localStorage.setItem(DISK_KEY, JSON.stringify({ v: 1, order, items }));
  } catch {
    /* 配额满/隐私模式：静默放弃磁盘缓存，内存缓存照常工作 */
  }
}

function scheduleDiskWrite() {
  diskDirty = true;
  if (diskTimer) return;
  diskTimer = window.setTimeout(flushDisk, DISK_WRITE_DEBOUNCE_MS);
}

/** 清空详情磁盘缓存（设置里「清理缓存」会调用） */
export function clearDetailCache(): void {
  cache.clear();
  try { localStorage.removeItem(DISK_KEY); } catch { /* 忽略 */ }
}

hydrateFromDisk();

const fresh = (entry: Entry | undefined): entry is Entry =>
  !!entry && Date.now() - entry.at < CACHE_TTL_MS;

/** 已经预取到的详情（同步读，用来让详情页首帧直接出内容） */
export function cachedDetail(id: number): Detail | null {
  const entry = cache.get(id);
  return fresh(entry) ? entry.data : null;
}

/**
 * SWR：同步读到任何一份缓存（含过期的与上次启动落盘的），先上屏再静默刷新。
 * 过期不影响先上屏 —— 内容过期一两分钟不算错，用户先看到东西更重要。
 */
export function cachedDetailStale(id: number): { data: Detail; at: number } | null {
  const entry = cache.get(id);
  return entry ? { data: entry.data, at: entry.at } : null;
}

function remember(id: number, data: Detail): Detail {
  cache.set(id, { at: Date.now(), data });
  scheduleDiskWrite();
  return data;
}

/**
 * 一次详情请求：3s 内回来就直接用；超过 3s 就并行换一次线路再发一条，谁先成功用谁。
 * 失败仍然抛出，交给调用方显示错误（不吞错）。
 */
async function slowLaneRace(id: number, first: Promise<Detail>): Promise<Detail> {
  let timer = 0;
  const timeout = new Promise<"slow">((resolve) => {
    timer = window.setTimeout(() => resolve("slow"), SLOW_MS);
  });
  const settled = first.then(
    (data) => ({ kind: "ok" as const, data }),
    (error) => ({ kind: "err" as const, error }),
  );
  const winner = await Promise.race([settled, timeout]);
  window.clearTimeout(timer);
  if (winner !== "slow" && winner.kind === "ok") return winner.data;

  /* 慢（或第一条已经失败）：让自动选线用现有候选换一条更快线路，再发一次。
     两条并存，谁先成功算谁的；都失败时抛第一条的错误。
     审计 #9：换线不能再直接调 api.lineAuto（绕过开关/偏好、不派 hg:line-changed），
     走 repickForSlowRequest —— 判定与健康检查同一套，不需要换线时它不会换。 */
  logLine(`[detail] ${id} 超过 ${SLOW_MS}ms 未返回，并行换线重试`);
  const repick = repickForSlowRequest("detail-slow");
  const second = (async () => {
    /* 最多等 REPICK_WAIT_MS：换线完成（或判定不用换）之后才发第二条，避免又打回同一条线。 */
    await Promise.race([
      repick.catch(() => false),
      new Promise<void>((resolve) => window.setTimeout(resolve, REPICK_WAIT_MS)),
    ]);
    return api.video(id);
  })();
  try {
    return await Promise.any([first, second]);
  } catch {
    if (winner !== "slow" && winner.kind === "err") throw winner.error;
    throw new Error("详情加载失败（快慢线路都没返回）");
  }
}

/** 详情请求的唯一入口（带缓存 + 去重 + 慢线路并行重试） */
export function loadDetail(id: number): Promise<Detail> {
  const hit = cachedDetail(id);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(id);
  if (running) return running;
  const task = slowLaneRace(id, api.video(id))
    .then((data) => remember(id, data))
    .finally(() => { inflight.delete(id); });
  inflight.set(id, task);
  return task;
}

/**
 * 预取详情：只取 JSON、不走慢线路重试、失败静默。
 * 并发固定 2，避免把首屏的数据请求挤掉。
 */
export function prefetchDetails(ids: number[], limit = PREFETCH_LIMIT): void {
  const queue = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))]
    .filter((id) => !cachedDetail(id) && !inflight.has(id))
    .slice(0, limit);
  if (!queue.length) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      try {
        const data = await api.video(id);
        if (data) remember(id, data);
      } catch {
        /* 预取失败一律静默：用户点进去时还会再正常请求一次 */
      }
    }
  };
  for (let i = 0; i < Math.min(PREFETCH_CONCURRENCY, queue.length); i += 1) void worker();
}
