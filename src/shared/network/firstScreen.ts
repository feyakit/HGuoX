/* 首屏「失败 → 换线 → 退避重试」的编排（3.0.20）。
 *
 * 真机事实（小米九 / 被墙网络，W95 实测）：5 次冷启动里 1 次根本拿不到内容，
 * 那次到 42 秒还停在错误页 —— 因为旧流程里一次失败就直接把错误页交给用户，
 * 只能靠他自己点「重试」。这里补上的就是这一段：失败后**自动**换一条候选线路、
 * 按 1s / 3s / 7s 退避各重试一次，三次都失败才让错误页出现（错误页文案与按钮不改）。
 *
 * 为什么单独一个纯函数模块：时序要能被测试钉死（假时钟 / 短延迟），
 * 页面里只负责把 `run` 和 `switchLine` 接进来。
 */
import { ApiError } from "../api/api";

/** 三次重试的退避间隔（毫秒），与需求 1s / 3s / 7s 一一对应。 */
export const FIRST_SCREEN_RETRY_DELAYS: readonly number[] = [1000, 3000, 7000];

/** 首屏每次尝试该用多短的预算（毫秒）；`undefined` = 由后端决定。
 *
 *  3.0.22 这里写死过 1500ms，理由是「被墙的线路一秒半就露馅」。真机（小米九 / 2026-11-28 /
 *  W115）推翻了它：红线是**唯一能用**的线路在 CloudFront LAX 边缘上，单请求实测
 *  0.78 / 2.10 / 3.05 秒，同一 origin 连出 `ms=1501 err=timeout` → `ms=1501 err=timeout`
 *  → `ms=1340 ok` —— 1.5s 杀掉的恰恰是能用的那条。
 *
 *  现在预算归后端：`net::first_connect_ms()` = `clamp(2 × 实测 RTT, 3s, 6s)`，
 *  生效值写进 logcat（`[net] first budget=3000ms rtt=1462ms`）。前端不再传数字，
 *  否则前端的小值会把后端的自适应值 `min()` 掉，等于白改。
 */
export function firstScreenBudget(_ctx: { attempt: number; switched: boolean; lastKind: string }): number | undefined {
  return undefined;
}

export type RetryDeps = {
  /** 覆盖退避间隔（测试用短延迟） */
  delays?: readonly number[];
  /** 换一条「还没试过」的候选线路；返回换到的 host，空串表示没换成（手动线路 / 全部不可用） */
  switchLine?: (tried: string[], kind: string) => Promise<string>;
  /** 每次重试前的埋点（写 logcat / debug.log） */
  onRetry?: (info: { n: number; delay: number; err: unknown; host: string }) => void;
  /** 等待实现（测试注入假时钟；默认真实 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 已经试过并失败的线路（调用方传入，之后每换一次往里追加） */
  tried?: string[];
  /** 这个错误值不值得再试（默认都试）；HTTP 4xx 这类「站点已经在回答」的失败不该换线重试 */
  shouldRetry?: (error: unknown) => boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/** 从错误对象里认出链路层原因（dns / tls / reset / timeout / connect），只用于日志与换线原因。 */
export function faultKindOf(error: unknown): string {
  const api = error instanceof ApiError ? error : null;
  const raw = `${api?.raw ?? ""} ${(error as Error)?.message ?? ""}`.toLowerCase();
  if (/dns|解析失败|no such host/.test(raw)) return "dns";
  if (/tls|ssl|handshake|证书|certificate/.test(raw)) return "tls";
  if (/reset|eof|broken pipe|closed before/.test(raw)) return "reset";
  if (/timeout|timed out|deadline|超时/.test(raw)) return "timeout";
  if (/connect|refused|unreachable/.test(raw)) return "connect";
  return "http";
}

/**
 * 跑一次首屏请求；失败就换线 + 退避重试，最多 `delays.length` 次。
 * 全部失败后把**最后一次**的错误原样抛出去（错误页还是拿同一份文案）。
 *
 * 3.0.22：`run` 收到这次尝试的上下文（第几次 / 刚换过线没 / 上一次失败类型），
 * 调用方据此给每次尝试不同的请求预算（见 [`firstScreenBudget`]）。
 */
export async function withLineRetries<T>(
  run: (ctx: { attempt: number; switched: boolean; lastKind: string }) => Promise<T>,
  deps: RetryDeps = {},
): Promise<T> {
  const delays = deps.delays ?? FIRST_SCREEN_RETRY_DELAYS;
  const sleep = deps.sleep ?? defaultSleep;
  const shouldRetry = deps.shouldRetry ?? (() => true);
  const tried = [...(deps.tried ?? [])];

  let last: unknown;
  let switched = false;
  try {
    return await run({ attempt: 1, switched: false, lastKind: "" });
  } catch (error) {
    last = error;
  }

  for (let index = 0; index < delays.length; index += 1) {
    if (!shouldRetry(last)) throw last;
    const n = index + 1;
    const delay = delays[index];
    let host = "";
    if (deps.switchLine) {
      try {
        host = await deps.switchLine(tried, faultKindOf(last));
      } catch {
        host = "";
      }
    }
    if (host) tried.push(host);
    switched = !!host;
    deps.onRetry?.({ n, delay, err: last, host });
    await sleep(delay);
    try {
      return await run({ attempt: n + 1, switched, lastKind: faultKindOf(last) });
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
