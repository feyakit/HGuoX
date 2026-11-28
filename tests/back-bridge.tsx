/* 3.0.21 F：安卓返回键最外层（backgroundOrExit）。
 *
 * 这里只跑纯逻辑：真机上「按返回没反应」的三种成因（桥不存在 / 桥返回 false / 桥抛异常）
 * 都在页面里真调一遍，看它有没有落到「退出应用」。
 */
import { backgroundOrExit, canBackground, type AndroidHost } from "../src/shared/lib/androidBack";

type Call = { command: string; args: Record<string, unknown> };
type Case = { bridge: AndroidHost; expect: "background" | "exit"; reject?: boolean };

const cases: Record<string, Case> = {
  /* 桥在、返回 true：只后台化，不许退出 */
  bridgeTrue: { bridge: { __HG_ANDROID__: { moveToBackground: () => true } }, expect: "background" },
  /* 桥不在（桌面端 / 旧包 / WebView 还没装桥）：必须退出 */
  bridgeMissing: { bridge: {}, expect: "exit" },
  /* 桥在但返回 false（activity 已经 finishing）：必须退出 */
  bridgeFalse: { bridge: { __HG_ANDROID__: { moveToBackground: () => false } }, expect: "exit" },
  /* 桥抛异常：以前这里整个回调抛出去 = 返回键没反应 */
  bridgeThrows: { bridge: { __HG_ANDROID__: { moveToBackground: () => { throw new Error("JNI gone"); } } }, expect: "exit" },
  /* 桥返回 truthy 但不是 true：按 Kotlin 的 Boolean 契约只认 true */
  bridgeTruthy: { bridge: { __HG_ANDROID__: { moveToBackground: () => "yes" } }, expect: "exit" },
  /* invoke 自己也失败（reject）：不影响「已经请求退出」这个结论 */
  exitRejects: { bridge: {}, expect: "exit", reject: true },
};

/* 3.0.20（改前）的写法照抄一份：裸调用 + 没有 try/catch。
   桥抛异常时它会把异常抛给调用方 → 整条返回键回调死掉，用户按返回**没反应**。
   留在这里当「回归判据」：新实现必须不会这样。 */
const legacyBack = (invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>, host: AndroidHost) => {
  const moved = (host as { __HG_ANDROID__?: { moveToBackground?: () => unknown } }).__HG_ANDROID__?.moveToBackground?.();
  if (!moved) invoke("plugin:app|exit", { code: 0 }).catch(() => {});
};

type Result = { outcome: string; calls: Call[]; exitRequested: boolean; backgrounded: boolean };

const run = (name: string): Result => {
  const testCase = cases[name];
  const calls: Call[] = [];
  const outcome = backgroundOrExit(
    (command, args) => {
      calls.push({ command, args });
      return testCase.reject ? Promise.reject(new Error("no host")) : Promise.resolve(undefined);
    },
    testCase.bridge,
  );
  return {
    outcome,
    calls,
    exitRequested: calls.some((call) => call.command === "plugin:app|exit"),
    backgrounded: canBackground(testCase.bridge),
  };
};

/** 改前实现遇到抛异常的桥会怎样（期望：抛出 = 返回键没反应） */
const legacyThrows = (name: string): boolean => {
  const testCase = cases[name];
  try {
    legacyBack(() => Promise.resolve(), testCase.bridge);
    return false;
  } catch {
    return true;
  }
};

Object.assign(window, { backBridgeHarness: { run, legacyThrows, names: Object.keys(cases) } });
