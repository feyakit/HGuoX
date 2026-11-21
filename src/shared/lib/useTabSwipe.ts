import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/* 上游 29e273a（#209）：tab 横向滑切。
   阈值与轴比是上游实机调出来的值，别随手改小——改小会把列表纵向滚动里的轻微斜向抖动
   误判成切 tab；改大则正常左滑切不动。 */
const SWIPE_DISTANCE = 56;
const AXIS_RATIO = 1.35;
const CLICK_SUPPRESS_MS = 360;
/* 手指移动超过这个量才算「正在滑」，用来决定要不要 preventDefault 抢走这次手势。 */
const CLAIM_DISTANCE = 10;

type TabSwipeOptions<T extends HTMLElement> = {
  rootRef: RefObject<T | null>;
  tabIndex: number;
  tabCount: number;
  onTabChange: (index: number) => void;
  ignoreSelector?: string;
  /** 关掉识别（例如收藏页正在批量选择时），不留残留手势状态。 */
  enabled?: boolean;
};

/**
 * 滚动区域上的横向 tab 切换。
 *
 * 触摸走原生 touch 事件：纵向滚动一旦开始，浏览器会把 Pointer Events 取消掉，
 * 用 pointermove 判横向就来不及了；鼠标/触控笔仍走 Pointer Events。
 *
 * 两条硬约束：
 * 1. 避让纵向滚动——只有「横向位移 ≥ 56px 且 ≥ 纵向 × 1.35」才切 tab；
 * 2. 避让卡片点击——滑动结束后 360ms 内的 click 一律吞掉，否则抬手那一下会打开卡片。
 */
export function useTabSwipe<T extends HTMLElement>({
  rootRef,
  tabIndex,
  tabCount,
  onTabChange,
  ignoreSelector = "input, textarea, select, [role=dialog], [data-tab-swipe-ignore]",
  enabled = true,
}: TabSwipeOptions<T>) {
  const current = useRef({ tabIndex, tabCount, onTabChange, ignoreSelector, enabled });
  current.current = { tabIndex, tabCount, onTabChange, ignoreSelector, enabled };
  const pointerStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const touchStart = useRef<{ x: number; y: number; lastX: number; lastY: number } | null>(null);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | undefined>(undefined);

  const armClickSuppression = () => {
    window.clearTimeout(suppressTimer.current);
    suppressClick.current = true;
    suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; }, CLICK_SUPPRESS_MS);
  };

  const commit = (startX: number, startY: number, endX: number, endY: number) => {
    if (!current.current.enabled) return;
    const dx = endX - startX;
    const dy = endY - startY;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) <= Math.abs(dy) * AXIS_RATIO) return;
    const next = dx < 0 ? current.current.tabIndex + 1 : current.current.tabIndex - 1;
    if (next < 0 || next >= current.current.tabCount) return;
    armClickSuppression();
    current.current.onTabChange(next);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const canStart = (target: EventTarget | null) => target instanceof Element &&
      !target.closest(current.current.ignoreSelector);

    const begin = (event: TouchEvent) => {
      if (!current.current.enabled || event.touches.length !== 1) { touchStart.current = null; return; }
      const touch = event.touches[0];
      if (!canStart(event.target)) { touchStart.current = null; return; }
      touchStart.current = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      const gesture = touchStart.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      /* 明确横向的手势要主动抢下来（容器是 touch-action: pan-y），否则浏览器会把它
         当成对下面卡片的一次点击；纵向手势一律不碰，滚动照旧。 */
      if (Math.abs(dx) > CLAIM_DISTANCE && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) event.preventDefault();
    };
    const finish = (event: TouchEvent) => {
      const gesture = touchStart.current;
      touchStart.current = null;
      if (!gesture) return;
      const touch = event.changedTouches[0];
      commit(gesture.x, gesture.y, touch?.clientX ?? gesture.lastX, touch?.clientY ?? gesture.lastY);
    };

    root.addEventListener("touchstart", begin, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", finish, { passive: true });
    root.addEventListener("touchcancel", finish, { passive: true });
    return () => {
      root.removeEventListener("touchstart", begin);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", finish);
      root.removeEventListener("touchcancel", finish);
    };
  }, [rootRef]);

  useEffect(() => () => window.clearTimeout(suppressTimer.current), []);

  const onPointerDown = (event: ReactPointerEvent<T>) => {
    if (event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
    if (!(event.target instanceof Element) || event.target.closest(current.current.ignoreSelector)) return;
    pointerStart.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  };
  const onPointerUp = (event: ReactPointerEvent<T>) => {
    const gesture = pointerStart.current;
    pointerStart.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    commit(gesture.x, gesture.y, event.clientX, event.clientY);
  };
  /* 滑动结束后的余波 click：capture 阶段吞掉，卡片 onClick 不会响。 */
  const onClickCapture = (event: ReactMouseEvent<T>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel: () => { pointerStart.current = null; },
    onClickCapture,
  };
}
