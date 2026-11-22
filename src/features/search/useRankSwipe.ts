import { useRef } from "react";
import { useTabSwipe } from "../../shared/lib/useTabSwipe";

type RankSwipeOptions = {
  tabIndex: number;
  tabCount: number;
  onTabChange: (index: number) => void;
};

/**
 * 上游 66e02b4（#208）：排行榜「热播榜 / 推荐榜 / 潜力榜」左右滑切。
 *
 * 手势实现与 useTabSwipe 完全一致（阈值 56px、轴比 1.35、滑后吞 click 360ms），
 * 所以这里只是把它包一层、自己拿一个 rootRef，不复制第二份手势代码——两份阈值
 * 迟早会漂移，而「哪个 tab 在滑」这种差异本来就不存在。
 */
export function useRankSwipe({ tabIndex, tabCount, onTabChange }: RankSwipeOptions) {
  const rootRef = useRef<HTMLDivElement>(null);
  const handlers = useTabSwipe<HTMLDivElement>({ rootRef, tabIndex, tabCount, onTabChange });
  return { rootRef, handlers };
}
