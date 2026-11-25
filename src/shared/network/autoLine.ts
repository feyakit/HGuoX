/* Automatic line selection uses the real content API and keeps the current line
 * when every candidate is unavailable.
 *
 * 手动选线 = 「本次优先」，不再永久关闭自动选线：偏好存在 hguox_line_preferred，
 * 自动选线只在偏好线路连续失败后才让位，恢复后自己回切且不提示。
 * 判定逻辑在 linePolicy.ts（纯函数），这里只负责取数、落库和派事件。 */
import { api, hostOf, logLine, setNetObserver } from "../api/api";
import { tracePlayback } from "../diagnostics/playbackDiagnostics";
import { readStorage, STORAGE_KEYS } from "../storage/storage";
import { decideLine } from "./linePolicy";
import { migrateLegacyAutoLine, normalizeBase, readPreferredLine } from "./linePreference";
import { recordProbes } from "./lineProbeCache";

const HEALTH_STEPS = [60_000, 120_000, 300_000];
const RECHECK_MS = 1_500;
const DOWN_RETRY_MS = 10_000;
const PICK_COOLDOWN_MS = 15_000;
/** 让位给别的线路后，这段时间内不再试图回切偏好（避免两条都抖的时候来回跳） */
const PREFER_RETRY_MS = 5 * 60_000;
let enabledOverride: boolean | null = null;

export const autoLineEnabled = (): boolean => {
  return enabledOverride ?? readStorage(STORAGE_KEYS.autoLine) !== "off";
};

let started = false;
let attached = false;
let picking = false;
let checking = false;
let timer = 0;
let step = 0;
let downStreak = 0;
let failStreak = 0;
let lastPickAt: number | null = null;
let cancellation: Promise<void> = Promise.resolve();
/** 当前生效线路（用于判断「失败的这一条是不是用户的偏好」） */
let currentBase = "";
/** 让位窗口：>now 表示暂时不回切偏好线路 */
let preferAvoidUntil = 0;

export let lastPick: { base: string; tier: string; ms: number } | null = null;

const sameBase = (a: string, b: string) => !!a && !!b && normalizeBase(a) === normalizeBase(b);

function stopTimer() {
  window.clearTimeout(timer);
  timer = 0;
}

function schedule(delay: number) {
  stopTimer();
  if (!autoLineEnabled()) return;
  timer = window.setTimeout(() => {
    if (navigator.onLine === false) {
      schedule(30_000);
    } else if (document.visibilityState === "visible") {
      void check("timer");
    } else {
      schedule(HEALTH_STEPS[0]);
    }
  }, delay);
}

/** 手动选线时用：取消在途的自动选线，但**不**改动「自动选择线路」开关与用户偏好。
 *  3.0.0 之前这里会顺手写 auto_line=off，导致手动选过一次线就永久失去自动选线。 */
export function pauseAutoPick(): Promise<void> {
  stopTimer();
  const pending = cancellation.then(() => api.lineCancel());
  cancellation = pending.catch((error) => {
    logLine(`[line] cancel failed: ${(error as Error).message}`);
  });
  if (started) schedule(HEALTH_STEPS[0]);
  return pending;
}

export const setAutoLine = (on: boolean): Promise<void> => {
  enabledOverride = on;
  try { localStorage.setItem(STORAGE_KEYS.autoLine, on ? "on" : "off"); } catch { /* storage can be unavailable */ }
  if (!on) {
    const pending = pauseAutoPick();
    window.dispatchEvent(new Event("hg:auto-line-changed"));
    return pending;
  }
  if (started && !attached) attach();
  if (started) void pickLine("manual", true);
  window.dispatchEvent(new Event("hg:auto-line-changed"));
  return Promise.resolve();
};

export async function pickLine(reason: string, force = false, preferredDown = false): Promise<void> {
  if (!autoLineEnabled() || picking || (!force && document.visibilityState !== "visible")) return;
  if (!force && lastPickAt !== null && Date.now() - lastPickAt < PICK_COOLDOWN_MS) return;
  picking = true;
  let down = false;
  try {
    await cancellation;
    if (!autoLineEnabled()) return;
    const result = await api.lineAuto();
    if (result.cancelled || !autoLineEnabled()) return;
    /* 线路面板要用这批探活结果显示延迟（不额外发请求；没探过的显示「未测」） */
    recordProbes(result.pick.candidates);
    lastPickAt = Date.now();
    downStreak = 0;
    failStreak = 0;
    step = 0;
    const candidates = result.pick.candidates
      .map((candidate) => `${candidate.tier}:${candidate.ok ? "ok" : candidate.reachable ? "reachable" : "down"}/${candidate.ms}ms`)
      .join(",");
    if (result.pick.reason === "all-down") {
      down = true;
      logLine(`[line] auto(${reason}) all-down, keep ${hostOf(result.base)} | ${candidates}`);
      tracePlayback("line.allDown", { reason, line: hostOf(result.base), candidates });
      window.dispatchEvent(new Event("hg:line-down"));
      return;
    }
    /* 偏好优先：后端选出的未必是用户想要的（见 docs/线路策略.md） */
    const preferred = readPreferredLine();
    const plan = decideLine({
      current: result.previous,
      backendPick: result.base,
      preferred,
      candidates: result.pick.candidates,
      preferredFailing: preferredDown || (!!preferred && Date.now() < preferAvoidUntil && !sameBase(result.base, preferred)),
    });
    let base = result.base;
    if (plan.target && plan.target !== result.base) {
      /* 偏好线路（用户手动选的）用 line_set 落成「手动线路」——它以后不许被自动换掉；
         让位给别的线路时用 line_set_auto，否则一次让位就把自动选线永久锁死在临时线路上了。 */
      const keepingPreferred = !!preferred && sameBase(plan.target, preferred);
      base = keepingPreferred ? await api.lineSet(plan.target) : await api.lineSetAuto(plan.target);
      logLine(`[line] auto(${reason}) prefer ${hostOf(base)} over ${hostOf(result.base)}`);
    }
    const switched = plan.changed || base !== result.previous;
    if (preferred && !sameBase(base, preferred)) {
      /* 已经让位：进入避让窗口，别立刻又切回去抖 */
      if (!preferAvoidUntil) preferAvoidUntil = Date.now() + PREFER_RETRY_MS;
    } else if (preferred) {
      preferAvoidUntil = 0;
    }
    currentBase = base;
    lastPick = { base, tier: result.pick.tier, ms: result.pick.ms };
    logLine(`[line] auto(${reason}) ${hostOf(base)} tier=${result.pick.tier} ms=${result.pick.ms} switched=${switched} pref=${preferred ? hostOf(preferred) : "-"} notify=${plan.notify || "-"} | ${candidates}`);
    tracePlayback("line.pick", {
      reason, line: hostOf(base), tier: result.pick.tier, ms: result.pick.ms, switched,
      preferred: preferred ? hostOf(preferred) : null, notify: plan.notify, candidates,
    });
    if (switched || result.switched) {
      window.dispatchEvent(new CustomEvent("hg:line", {
        detail: { region: result.pick.tier === "main" ? "intl" : "cn", host: hostOf(base), ms: result.pick.ms },
      }));
      window.dispatchEvent(new Event("hg:line-changed"));
    }
    /* 偏好线路挂了，被迫换到别的线路：面板只说一次，回切不提示 */
    if (plan.notify === "preferred-down" && switched) window.dispatchEvent(new Event("hg:line-auto-switched"));
  } catch (error) {
    logLine(`[line] auto(${reason}) failed: ${(error as Error).message}`);
    tracePlayback("line.fail", { where: "auto", reason, err: (error as Error).message });
  } finally {
    picking = false;
    if (started) schedule(down ? DOWN_RETRY_MS : HEALTH_STEPS[0]);
  }
}

/**
 * 「这次请求很慢」的换线入口（详情首屏的慢线路并行重试用，审计 #9）。
 *
 * 以前 detailFast 直接 `api.lineAuto()`：绕过了 `autoLine` 开关与偏好线路，也不派
 * `hg:line-changed` —— 播放器与首页都不知道线路已经换了。这里改走 pickLine，
 * 判定与健康检查完全同一套（尊重开关、偏好优先、不需要换就不换），
 * 真的换过线时 pickLine 自己会派事件。
 *
 * 返回是否真的换了线路（调用方据此决定要不要真的再发一次请求）。
 */
export async function repickForSlowRequest(reason: string): Promise<boolean> {
  if (!autoLineEnabled()) return false;
  const before = currentBase || (await api.lineState().then((s) => s.base).catch(() => ""));
  if (!before) return false;
  await pickLine(reason, true);
  const after = currentBase || (await api.lineState().then((s) => s.base).catch(() => ""));
  return !!after && !sameBase(before, after);
}

async function tryMain(reason: string): Promise<void> {
  if (!autoLineEnabled() || picking) return;
  /* 有偏好线路时不允许自动回切主站：用户选的线只要通就不能被换走 */
  if (readPreferredLine()) return;
  picking = true;
  try {
    await cancellation;
    if (!autoLineEnabled()) return;
    const result = await api.lineTryMain();
    if (result.cancelled || !autoLineEnabled()) return;
    currentBase = result.base;
    logLine(`[line] main(${reason}) ok=${result.probe.ok} ms=${result.probe.ms} switched=${result.switched}`);
    if (result.switched) {
      window.dispatchEvent(new CustomEvent("hg:line", {
        detail: { region: "intl", host: hostOf(result.base), ms: result.probe.ms },
      }));
      window.dispatchEvent(new Event("hg:line-changed"));
    }
  } catch (error) {
    logLine(`[line] main(${reason}) failed: ${(error as Error).message}`);
  } finally {
    picking = false;
  }
}

async function check(reason: string): Promise<void> {
  if (!autoLineEnabled() || checking) return;
  if (picking) {
    schedule(HEALTH_STEPS[step]);
    return;
  }
  checking = true;
  try {
    const health = await api.lineHealth();
    currentBase = health.base;
    if (health.ok) {
      downStreak = 0;
      step = Math.min(step + 1, HEALTH_STEPS.length - 1);
      const preferred = readPreferredLine();
      if (!preferred) {
        if (hostOf(health.base) !== "huangguoai.com") await tryMain(reason);
      } else if (!sameBase(health.base, preferred) && Date.now() >= preferAvoidUntil) {
        /* 偏好线路可能回来了：复检一次，通了就静默切回（无提示） */
        void pickLine("prefer-recover");
      }
      schedule(HEALTH_STEPS[step]);
      return;
    }
    downStreak += 1;
    logLine(`[line] health(${reason}) down=${downStreak} base=${hostOf(health.base)} ms=${health.ms}`);
    tracePlayback("line.health", { reason, line: hostOf(health.base), down: downStreak, ms: health.ms, status: health.status });
    if (reason !== "api-fail" && downStreak < 2) {
      schedule(RECHECK_MS);
      return;
    }
    downStreak = 0;
    step = 0;
    /* 连续失败：如果失败的就是偏好线路，这次让位并允许提示 */
    const preferred = readPreferredLine();
    await pickLine(reason, true, !!preferred && sameBase(health.base, preferred));
  } catch (error) {
    logLine(`[line] health(${reason}) failed: ${(error as Error).message}`);
    schedule(HEALTH_STEPS[step]);
  } finally {
    checking = false;
  }
}

function attach() {
  if (attached) return;
  attached = true;
  setNetObserver((result) => {
    if (!autoLineEnabled()) return;
    if (!result.cmd.startsWith("api_")) return;
    if (result.ok) { failStreak = 0; return; }
    if (!result.networkish || ++failStreak < 2) return;
    failStreak = 0;
    void check("api-fail");
  });
  window.addEventListener("online", () => { step = 0; void pickLine("online"); });
  window.addEventListener("offline", () => schedule(30_000));
  window.addEventListener("hg:proxy-changed", () => {
    // Backend invalidates outstanding selections on save. Keep the selected
    // line and let a fresh health check evaluate the new route after settling.
    failStreak = 0;
    downStreak = 0;
    step = 0;
    lastPickAt = null;
    schedule(RECHECK_MS);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopTimer();
    else { downStreak = 0; step = 0; void check("visible"); }
  });
  schedule(HEALTH_STEPS[0]);
}
export function initAutoLine(): void {
  if (started) return;
  started = true;
  /* 旧版本「手动选线 → auto_line=off」不是用户意图，升级后一次性恢复自动选线 */
  migrateLegacyAutoLine();
  if (!autoLineEnabled()) return;
  attach();
  void pickLine("boot");
}
