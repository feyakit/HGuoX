import { useEffect, useRef } from "react";

/**
 * 滚到底自动加批（上游 #169 / `46e2936` 的做法）：列表接近底部 300px 时再加一批，
 * 不再显示「加载更多」按钮。
 *
 * 两个必须点：
 * 1. `root` 必须是真正的滚动容器——我们的列表都嵌在 `flex-1 scroll-y` 里，
 *    拿 viewport 当 root 在这个结构里永远不触发；
 * 2. `count` 参与去重——某批加载失败时条数不会增长，此时必须停手，否则会空转成死循环。
 */
export function useAutoLoadMore({ hasMore, busy = false, count, resetKey, onMore }: {
  hasMore: boolean;
  busy?: boolean;
  /** 当前已渲染条数：用来判断上一批是否真的长出了新内容 */
  count: number;
  /** 切换列表（收藏/历史、短剧/吃瓜）时必须换一个值，否则「切过去正好条数一样」会被去重挡住 */
  resetKey?: string;
  onMore: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const latest = useRef(onMore);
  latest.current = onMore;
  const firedAt = useRef(-1);
  const firedKey = useRef<string | undefined>(undefined);
  const supported = typeof IntersectionObserver !== "undefined";

  useEffect(() => {
    const scroller = scrollerRef.current;
    const sentinel = sentinelRef.current;
    /* 换列表就作废「这批已触发过」的记录，否则新列表 12 条会被旧的 12 挡死。 */
    if (resetKey !== firedKey.current) { firedKey.current = resetKey; firedAt.current = -1; }
    if (!supported || !hasMore || busy || !scroller || !sentinel) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      if (count === firedAt.current) return;
      firedAt.current = count;
      latest.current();
    }, { root: scroller, rootMargin: "300px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
    /* resetKey 必须进依赖：换列表（收藏/历史、短剧/吃瓜）时若条数、hasMore、busy 都没变，
       effect 不会重跑，上面那句「作废触发记录」就永远执行不到，新列表的第一批被旧列表挡住。 */
  }, [supported, hasMore, busy, count, resetKey]);

  return { scrollerRef, sentinelRef, supported };
}
