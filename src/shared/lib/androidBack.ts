/* 安卓硬件返回键的最外层动作（3.0.21 F）。
 *
 * 语义：先请 Activity 移到后台；**只有**桥明确返回 `true` 才算成功。
 * 桥不存在（桌面端 / 旧包 / WebView 还没装桥）、返回 false、抛异常 —— 三种情况
 * 一律退到「退出应用」，绝不能什么都不做：以前这里是裸调用，Kotlin 侧一抛异常
 * （activity 已经 finishing、WebView 被回收）整个回调就抛出去，用户按返回**没反应**。
 *
 * 桥名与 Kotlin 侧一一对应：
 *   OrientationPlugin.kt → webView.addJavascriptInterface(AppBridge(), "__HG_ANDROID__")
 *   AppBridge.moveToBackground(): Boolean
 *
 * 抽成独立函数是为了能在 harness 里把「桥存在 / 不存在 / 抛异常」三种情况都真跑一遍。
 */

export type AndroidBackBridge = { moveToBackground?: () => unknown };
export type AndroidHost = { __HG_ANDROID__?: AndroidBackBridge };
export type BackOutcome = "background" | "exit";

type Invoker = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** 桥能不能把 Activity 移到后台。任何异常都当「不能」。 */
export function canBackground(host: AndroidHost): boolean {
  try {
    const bridge = host.__HG_ANDROID__;
    if (!bridge || typeof bridge.moveToBackground !== "function") return false;
    return bridge.moveToBackground.call(bridge) === true;
  } catch {
    return false;
  }
}

/** 返回键最外层：后台化失败就退出应用。返回实际走了哪条路（便于单测/取证）。 */
export function backgroundOrExit(
  invoke: Invoker,
  host: AndroidHost = globalThis as unknown as AndroidHost,
): BackOutcome {
  if (canBackground(host)) return "background";
  try {
    void invoke("plugin:app|exit", { code: 0 }).catch(() => {});
  } catch {
    /* invoke 自己同步抛异常也不能让返回键变成「没反应」：这条路已经没有别的动作了 */
  }
  return "exit";
}
