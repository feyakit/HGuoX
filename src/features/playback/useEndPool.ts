/**
 * 结束态推荐的状态与轮换：池子（related 全量 + feed 若干页）+ 游标 + 已展示记账。
 *
 * 组件只负责渲染，判定与轮换全在 endPool.ts；这里只把 api 与 React 状态接起来，
 * 这样播放页和验收 harness 跑的是同一段胶水代码（不是各写一份）。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import { useStore } from "../../shared/model/store";
import type { VideoCard } from "../../shared/api/types";
import { buildEndPool, takeBatch, type EndPool, type EndPoolRotation } from "./endPool";

/** 池子轮到底、回到开头时给用户的一句话（不要静默重复同一批） */
export const END_POOL_WRAPPED_HINT = "推荐已轮完一遍，从头开始";
/** 这句提示要收得快一点：它只是解释「为什么又看到第一批」，不占屏 */
const END_POOL_TOAST_MS = 1800;

export function useEndPool(curId: number) {
  const { toast } = useStore();
  const [recs, setRecs] = useState<VideoCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  /* 代次：每次 next() 递增；换剧时也递增。
     慢响应返回时若代次已变、或剧已不是发起那一刻的剧，就**不得写状态**——
     否则上一部剧的 related 迟回来会把新剧的结束卡整块换掉（审计 #10，8s 时序可复现）。 */
  const runSeq = useRef(0);
  const curIdRef = useRef(curId);
  curIdRef.current = curId;
  const pool = useRef<EndPool<VideoCard> | null>(null);
  const cursor = useRef(0);
  const shown = useRef<Set<number>>(new Set());

  /** 取下一批（首调用建池）。`regen` 只在建池那一次用来绕过读缓存。 */
  const next = useCallback(async (regen = false): Promise<EndPoolRotation<VideoCard> | null> => {
    const my = ++runSeq.current;
    const idAtStart = curId;
    /* 过期判据：本调用已被更新的调用取代，或剧已换 */
    const stale = () => my !== runSeq.current || curIdRef.current !== idAtStart;
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
      if (stale()) return null;
      const rotation = takeBatch(pool.current.items, cursor.current, shown.current);
      cursor.current = rotation.cursor;
      /* 轮到底回到开头：卡片里那行小字容易被忽略，单槽 toast 再明确说一次「这是第二轮」 */
      if (rotation.wrapped) toast(END_POOL_WRAPPED_HINT, "info", "playback-hint", END_POOL_TOAST_MS);
      setHint(rotation.wrapped ? END_POOL_WRAPPED_HINT : "");
      setRecs(rotation.batch);
      return rotation;
    } catch {
      if (!stale()) { setRecs([]); setHint(""); }
      return null;
    } finally {
      /* busy 也可能属于新一次调用：只有本代次才允许复位，避免把新调用的 loading 清掉 */
      if (!stale()) setBusy(false);
    }
  }, [curId, toast]);

  const close = useCallback(() => {
    /* 关卡片即作废在途请求：它的结果不该再写进下一次结束卡 */
    runSeq.current += 1;
    setRecs(null); setHint("");
  }, []);
  const poolSize = useCallback(() => pool.current?.items.length ?? 0, []);

  /* 返回稳定的对象：调用方（播放页、验收 harness）会把它放进 useCallback 依赖 */
  return useMemo(() => ({ recs, busy, hint, next, close, poolSize }), [recs, busy, hint, next, close, poolSize]);
}
