/**
 * 结束态「你可能还想看」的推荐池：轮换游标，不再按次重拉同一批。
 *
 * 为什么要有池子：上游 `api_related` 对同一个 id **返回固定列表**，`regen` 只是让前端
 * 绕过 5 分钟读缓存（api.ts 的 force），所以旧写法「每次点换一批 = 重新问一次 related」
 * 拿回永远是同一批（用户报「看完后换一批一直是一样的」）。旧代码还只用前 3 部，
 * related 第 4 部以后从来没被用过。
 *
 * 池子的构成：related 全量（过滤本剧/无封面/重复）+ feed 若干页补齐；一次会话内只建一次，
 * 之后「换一批」只是往后移 3 部。到底了回到开头并让调用方给一句轻提示，
 * 池子不足 3 部就少显示，拿不到任何内容就如实空着（不补假卡）。
 */

/** 一批显示几部 / 池子至少凑多少部 / feed 最多补几页 */
export const END_POOL = { batch: 3, target: 12, feedPages: 4 } as const;

export type EndPoolItem = { id: number; cover?: string };

export type EndPool<T extends EndPoolItem = EndPoolItem> = { forId: number; items: T[] };

export type EndPoolFetchers<T extends EndPoolItem> = {
  related: () => Promise<{ items?: T[] } | null | undefined>;
  feed: (page: number) => Promise<{ items?: T[] } | null | undefined>;
};

/** 建池：related 优先（保序），不够再按页补 feed；某一页没有新内容就不再往后问。 */
export async function buildEndPool<T extends EndPoolItem>(curId: number, fetchers: EndPoolFetchers<T>): Promise<EndPool<T>> {
  const items: T[] = [];
  const seen = new Set<number>([curId]);
  const add = (list?: T[] | null) => {
    let added = 0;
    for (const v of list ?? []) {
      if (!v || !v.id || !v.cover || seen.has(v.id)) continue;
      seen.add(v.id);
      items.push(v);
      added += 1;
    }
    return added;
  };
  try {
    add((await fetchers.related())?.items);
  } catch { /* related 失败不阻塞，下面用 feed 兜 */ }
  for (let page = 1; page <= END_POOL.feedPages && items.length < END_POOL.target; page += 1) {
    try {
      if (add((await fetchers.feed(page))?.items) === 0) break;
    } catch { break; }
  }
  return { forId: curId, items };
}

export type EndPoolRotation<T extends EndPoolItem = EndPoolItem> = { batch: T[]; cursor: number; wrapped: boolean };

/**
 * 从 `cursor` 往后取最多 `size` 部「没展示过」的；取了就在 `shown` 里记账。
 * 后面已经没有未展示过的项时回到开头重来（`shown` 清账），并把 `wrapped` 置真，
 * 让调用方给「已看完推荐池」之类的提示 —— 不静默重复同一批。
 */
export function takeBatch<T extends EndPoolItem>(
  pool: readonly T[],
  cursor: number,
  shown: Set<number>,
  size: number = END_POOL.batch,
): EndPoolRotation<T> {
  const from = Math.min(Math.max(Math.trunc(cursor) || 0, 0), pool.length);
  let at = from;
  const batch: T[] = [];
  while (at < pool.length && batch.length < size) {
    const item = pool[at];
    at += 1;
    if (shown.has(item.id)) continue;
    batch.push(item);
  }
  if (batch.length > 0) {
    for (const item of batch) shown.add(item.id);
    return { batch, cursor: at, wrapped: false };
  }
  if (!pool.length) return { batch, cursor: 0, wrapped: false };
  /* 到底了：清账，从池子开头重新给一批 */
  shown.clear();
  at = 0;
  while (at < pool.length && batch.length < size) {
    const item = pool[at];
    at += 1;
    batch.push(item);
    shown.add(item.id);
  }
  return { batch, cursor: at, wrapped: true };
}
