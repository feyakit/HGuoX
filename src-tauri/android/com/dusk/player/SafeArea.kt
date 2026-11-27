package com.dusk.player

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.WebView
import java.lang.ref.WeakReference
import java.util.Locale

/**
 * 系统安全区（底部）桥：把真实 WindowInsets 写进 WebView 的 CSS 变量 `--sab`。
 *
 * 为什么需要它：安卓 WebView 在边到边布局下 `env(safe-area-inset-bottom)` 常常是 0，
 * CSS 只能靠硬编码兜底（历史值 24px，而小米9 实测只有 44 物理 px = 16 CSS px，凭空多留 8px）。
 * 这里改成运行时读 [WindowInsets]，换算成 CSS px（=dp）后写进 `:root` 的 `--sab`：
 *
 *   bottom = max(navigationBars, mandatorySystemGestures, systemGestures)
 *
 * 三道保险（上一版只有第一道，真机 `--sab` 一直是 0 就栽在这里）：
 *   1) `View.setOnApplyWindowInsetsListener`：手势↔三键、横竖屏、键盘弹收都会重新派发；
 *   2) 启动时主动读 `decorView.rootWindowInsets`，并在 300ms 间隔上重试
 *      —— 插件 init 时 WebView/DOM 往往还没就绪，`evaluateJavascript` 会被丢掉；
 *   3) `ActivityLifecycleCallbacks.onActivityResumed` 再补一次（回前台、改完系统设置回来）。
 *
 * 写入是否真的生效由 JS 回调确认：JS 里读完 `getComputedStyle(...--sab)` 回传 `ok:<值>`，
 * 拿不到就继续排队重试 —— **绝不因为写过一次就当成已生效**（上一版用 lastCss 去重，
 * 第一次写到空文档上就再也不写了，表现就是「--sab 永远 0」）。
 *
 * 本文件被跟踪在 src-tauri/android/com/dusk/player/，构建前由
 * scripts/inject-android-plugin.mjs 复制进生成的安卓工程（src-tauri/gen 是 gitignore 的）。
 * 由 [OrientationPlugin] 的 init 调 [install] 安装，避免再加一个 Tauri 插件注册点。
 */
object SafeArea {
    private const val TAG = "hguox-safearea"
    private const val RETRY_MS = 300L
    private const val MAX_TRIES = 20

    /** 已经确认落地的 CSS 值（px）；-1 = 还没有。 */
    private var appliedCss = -1f
    private var tries = 0
    private var webRef: WeakReference<WebView>? = null
    private var hooked = false
    private var installed = false

    /**
     * 幂等：`Plugin.load(webView)` 和插件构造都会调它。
     * 第一次挂监听/重试；后续调用只更新 WebView 引用。
     */
    fun install(activity: Activity, webView: WebView?) {
        if (webView != null) webRef = WeakReference(webView)
        if (installed) {
            tries = 0
            handle(activity, activity.window?.decorView?.rootWindowInsets, force = true)
            return
        }
        installed = true
        val decor = activity.window?.decorView ?: return
        Log.i(TAG, "[safearea] install on " + activity.javaClass.simpleName + " webView=" + (webView != null))
        decor.setOnApplyWindowInsetsListener { view, insets ->
            handle(activity, insets, force = false)
            /* 透传默认处理：只观察，不改布局行为。 */
            view.onApplyWindowInsets(insets)
        }
        decor.requestApplyInsets()
        /* 首帧主动读一次，之后靠重试把「WebView 还没挂 / 文档还没就绪」这一段兜住。 */
        tries = 0
        handle(activity, decor.rootWindowInsets, force = true)
        if (!hooked) {
            hooked = true
            try {
                activity.application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
                    override fun onActivityCreated(a: Activity, state: Bundle?) {}
                    override fun onActivityStarted(a: Activity) {}
                    override fun onActivityResumed(a: Activity) {
                        val d = a.window?.decorView ?: return
                        tries = 0
                        handle(a, d.rootWindowInsets, force = true)
                    }
                    override fun onActivityPaused(a: Activity) {}
                    override fun onActivityStopped(a: Activity) {}
                    override fun onActivitySaveInstanceState(a: Activity, state: Bundle) {}
                    override fun onActivityDestroyed(a: Activity) {}
                })
            } catch (error: Throwable) {
                Log.w(TAG, "[safearea] 注册 lifecycle 失败：" + (error.message ?: ""))
            }
        }
    }

    private fun handle(activity: Activity, insets: WindowInsets?, force: Boolean) {
        if (insets == null) {
            retry(activity)
            return
        }
        val bars = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            insets.getInsets(WindowInsets.Type.navigationBars()).bottom
        } else {
            @Suppress("DEPRECATION")
            insets.systemWindowInsetBottom
        }
        var gestures = 0
        var mandatory = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            gestures = insets.getInsets(WindowInsets.Type.systemGestures()).bottom
            mandatory = insets.getInsets(WindowInsets.Type.mandatorySystemGestures()).bottom
        }
        val px = maxOf(bars, gestures, mandatory)
        val density = activity.resources?.displayMetrics?.density ?: 0f
        val css = if (density > 0f) px / density else 0f
        /* 三键时 navigationBars 通常大于手势区；两者相等（MIUI 实测都是 44）按手势算。 */
        val mode = if (bars > gestures) "3button" else "gesture"
        if (!force && appliedCss >= 0f && Math.abs(css - appliedCss) < 0.01f) return
        write(activity, px, css, mode, "nav=" + bars + " gest=" + gestures + " mand=" + mandatory)
    }

    private fun write(activity: Activity, px: Int, css: Float, mode: String, detail: String) {
        val wv = webView(activity)
        if (wv == null) {
            retry(activity)
            return
        }
        val value = String.format(Locale.US, "%.2f", css)
        val js = "(function(){try{" +
            "document.documentElement.style.setProperty('--sab','" + value + "px');" +
            "if(window.__hgSafeAreaLog){window.__hgSafeAreaLog(" + px + "," + css + ",'" + mode + "');}" +
            "var v=getComputedStyle(document.documentElement).getPropertyValue('--sab');" +
            "return 'ok:'+v}catch(e){return 'err:'+(e&&e.message)}})()"
        activity.runOnUiThread {
            try {
                wv.evaluateJavascript(js) { result ->
                    if (result != null && result.contains("ok:")) {
                        appliedCss = css
                        tries = 0
                        Log.i(TAG, "[safearea] inset_px=" + px + " css=" + value + " mode=" + mode + " " + detail + " -> " + result)
                    } else {
                        Log.w(TAG, "[safearea] inset_px=" + px + " css=" + value + " 未确认（" + result + "）")
                        retry(activity)
                    }
                }
            } catch (error: Throwable) {
                Log.w(TAG, "[safearea] evaluateJavascript 失败：" + (error.message ?: ""))
                retry(activity)
            }
        }
    }

    private fun retry(activity: Activity) {
        if (tries >= MAX_TRIES) return
        tries++
        val decor = activity.window?.decorView ?: return
        decor.postDelayed({
            val d = activity.window?.decorView
            if (d != null) handle(activity, d.rootWindowInsets, force = true)
        }, RETRY_MS)
    }

    private fun webView(activity: Activity): WebView? {
        webRef?.get()?.let { if (it.isAttachedToWindow) return it }
        val found = findWebView(activity.window?.decorView) ?: return null
        webRef = WeakReference(found)
        return found
    }

    private fun findWebView(view: View?): WebView? {
        if (view == null) return null
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                findWebView(view.getChildAt(i))?.let { return it }
            }
        }
        return null
    }
}
