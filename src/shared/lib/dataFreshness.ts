/**
 * 数据新鲜度：三个小钩子，专门解决「看着是旧的，重进也不变」。
 *
 * 1. useApiRefresh —— 订阅 api.ts 的 `hg:api-data` 广播。命中旧缓存后 api 层会后台
 *    重拉，拿到新数据时页面原地换新（旧代码把刷新结果丢掉了，所以要等用户重进）。
 * 2. useVisibilityRefresh —— 应用从后台回到前台（visibilitychange / focus）时，
 *    距上次拉取超过 minGap 就静默重拉当前页：不闪骨架、失败不提示。
 * 3. useFreshness —— 记录"这一屏最后一次真实拉取的时间"，给上面两个用，也给
 *    「重进超过 N 秒才刷新」这类判断用（避免每次切 tab 都打服务器）。
 */
import { useCallback, useEffect, useRef } from "react";
import { API_DATA_EVENT, apiCacheKey, type ApiDataEvent } from "../api/api";

/** 距上次拉取超过这个时间才允许静默刷新（回前台 / 重进 tab 共用） */
export const FRESH_GAP_MS = 30_000;

/** 订阅某个只读接口的"真实请求结果"。args 必须和调用 api.* 时传的一致。 */
export function useApiRefresh<T>(cmd: string, args: Record<string, unknown> | undefined, onValue: (value: T) => void) {
  const cb = useRef(onValue);
  cb.current = onValue;
  const key = apiCacheKey(cmd, args);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ApiDataEvent>).detail;
      if (!detail || detail.key !== key) return;
      cb.current(detail.value as T);
    };
    window.addEventListener(API_DATA_EVENT, handler);
    return () => window.removeEventListener(API_DATA_EVENT, handler);
  }, [key]);
}

/**
 * 回前台静默刷新。
 * - 只在可见时触发，且距 `lastAt()`（页面自己记的最后一次拉取时间）超过 minGap 才跑；
 * - 同一时刻只跑一次（页面在跑刷新时把 refreshing 传进来即可跳过）。
 */
export function useVisibilityRefresh(run: () => void, opts: {
  enabled?: boolean;
  minGap?: number;
  lastAt?: () => number;
  busy?: boolean;
} = {}) {
  const { enabled = true, minGap = FRESH_GAP_MS, busy = false } = opts;
  const runRef = useRef(run);
  runRef.current = run;
  const lastRef = useRef(opts.lastAt);
  lastRef.current = opts.lastAt;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState !== "visible") return;
      if (busyRef.current) return;
      const last = Math.max(lastRef.current?.() ?? 0, 0);
      /* 0 = 这一屏还从没成功拉过。冷启动时 WebView 一拿到焦点就会走到这里，
         而首屏那条请求本来就在飞 —— 再 force 一遍就是「同一页两条 api_feed」。
         首屏出内容之后 fresh.mark() 会把 lastAt 写正，之后的回前台刷新照旧。 */
      if (last === 0) return;
      if (Date.now() - last < minGap) return;
      runRef.current();
    };
    document.addEventListener("visibilitychange", handler);
    window.addEventListener("focus", handler);
    return () => {
      document.removeEventListener("visibilitychange", handler);
      window.removeEventListener("focus", handler);
    };
  }, [enabled, minGap]);
}

/** 记录"最后一次真实拉取完成的时间"，返回稳定引用的 [lastAt, mark, olderThan]。 */
export function useFreshness(initial = 0) {
  const at = useRef(initial);
  const lastAt = useCallback(() => at.current, []);
  const mark = useCallback(() => { at.current = Date.now(); }, []);
  const olderThan = useCallback((ms: number) => Date.now() - at.current > ms, []);
  const reset = useCallback(() => { at.current = 0; }, []);
  return { lastAt, mark, olderThan, reset };
}

/** 前台每 `everyMs`（默认 5 分钟）静默刷新一次；页面不可见时跳过，不刷播放页。 */
export function useForegroundRefresh(run: () => void, opts: { enabled?: boolean; everyMs?: number } = {}) {
  const { enabled = true, everyMs = 5 * 60_000 } = opts;
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      runRef.current();
    }, everyMs);
    return () => window.clearInterval(timer);
  }, [enabled, everyMs]);
}
