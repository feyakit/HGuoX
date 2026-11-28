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

/** 首屏首枪的单次请求预算（毫秒，3.0.22）。
 *
 *  真机（小米九 / 2026-11-28）`[net] req cmd=api_feed origin=huangguoai.com ms=12001 err=timeout`：
 *  首屏第一个请求在主域黑洞上等满 12 秒才失败，而这段时间里候选线路一条都没被试过。
 *  首枪只给 1.5 秒 —— 被墙的线路一秒半就露馅，立刻换候选。 */
export const FIRST_SCREEN_BUDGET_MS = 1500;

/** 这一次首屏尝试该用多短的预算（毫秒）；`undefined` = 用后端常规 12 秒。
 *
 *  规则（少而可解释）：
 *   * 第一次尝试（首枪）：1.5 秒；
 *   * 之后的尝试：只要「上一次是快速失败形态（refused/reset/tls/dns）」或者「刚换过线路」，
 *     仍然 1.5 秒 —— 换了一条线路还等满 12 秒，等于把整条重试链拖到分钟级；
 *   * 上一次是**纯超时**且没换过线路：`undefined`。那可能只是弱网 / 镜像本身慢，
 *     1.5 秒会把一条其实能用的线路误杀（这是短预算唯一真正的风险）。 */
export function firstScreenBudget(ctx: { attempt: number; switched: boolean; lastKind: string }): number | undefined {
  if (ctx.attempt <= 1) return FIRST_SCREEN_BUDGET_MS;
  if (ctx.lastKind === "timeout" && !ctx.switched) return undefined;
  return FIRST_SCREEN_BUDGET_MS;
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
