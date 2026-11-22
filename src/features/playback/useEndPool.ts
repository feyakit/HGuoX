/**
 * 结束态推荐的状态与轮换：池子（related 全量 + feed 若干页）+ 游标 + 已展示记账。
 *
 * 组件只负责渲染，判定与轮换全在 endPool.ts；这里只把 api 与 React 状态接起来，
 * 这样播放页和验收 harness 跑的是同一段胶水代码（不是各写一份）。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import type { VideoCard } from "../../shared/api/types";
import { buildEndPool, takeBatch, type EndPool, type EndPoolRotation } from "./endPool";

/** 池子轮到底、回到开头时给用户的一句话（不要静默重复同一批） */
export const END_POOL_WRAPPED_HINT = "已看完推荐池，从头再看";

export function useEndPool(curId: number) {
  const [recs, setRecs] = useState<VideoCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const pool = useRef<EndPool<VideoCard> | null>(null);
  const cursor = useRef(0);
  const shown = useRef<Set<number>>(new Set());

  /** 取下一批（首调用建池）。`regen` 只在建池那一次用来绕过读缓存。 */
  const next = useCallback(async (regen = false): Promise<EndPoolRotation<VideoCard> | null> => {
    setBusy(true);
    try {
      if (!pool.current || pool.current.forId !== curId) {
        pool.current = await buildEndPool(curId, {
          related: () => api.related(curId, regen),
          feed: (page) => api.feed(page, 24, undefined, regen),
        });
        cursor.current = 0;
        shown.current = new Set();
      }
      const rotation = takeBatch(pool.current.items, cursor.current, shown.current);
      cursor.current = rotation.cursor;
      setHint(rotation.wrapped ? END_POOL_WRAPPED_HINT : "");
      setRecs(rotation.batch);
      return rotation;
    } catch {
      setRecs([]);
      setHint("");
      return null;
    } finally {
      setBusy(false);
    }
  }, [curId]);

  const close = useCallback(() => { setRecs(null); setHint(""); }, []);
  const poolSize = useCallback(() => pool.current?.items.length ?? 0, []);

  /* 返回稳定的对象：调用方（播放页、验收 harness）会把它放进 useCallback 依赖 */
  return useMemo(() => ({ recs, busy, hint, next, close, poolSize }), [recs, busy, hint, next, close, poolSize]);
}
