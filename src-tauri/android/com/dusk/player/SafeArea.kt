package com.dusk.player

import android.app.Activity
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.WebView
import java.lang.ref.WeakReference
import java.util.Locale
import kotlin.math.abs

/**
 * 系统安全区（底部）桥：把真实 WindowInsets 写进 WebView 的 CSS 变量 `--sab`。
 *
 * 为什么需要它：安卓 WebView 里 `env(safe-area-inset-bottom)` 在边到边的全屏 WebView 上
 * 拿不到系统手势/导航条高度（返回 0），于是 CSS 只能靠硬编码兜底（历史上写了 24px，
 * 而小米9 实测只有 44 物理 px = 16 CSS px，凭空多留 8px，用户读作「底栏悬空」）。
 * 这里改成运行时读 [WindowInsets]，换算成 CSS px（=dp）后写进 `--sab`：
 *
 *   bottom 取 max(navigationBars, mandatorySystemGestures, systemGestures)
 *   —— 三键导航看 navigationBars，手势导航看两个 gestures，谁大听谁的。
 *
 * 变化监听用 `View.setOnApplyWindowInsetsListener`：手势↔三键切换、横竖屏切换、
 * 系统设置变更、软键盘弹收都会重新派发 insets，回调里重算重写即可，不需要重启 App。
 * 回调里照常调用 `view.onApplyWindowInsets(insets)` 把默认行为透传下去，不吞事件。
 *
 * 本文件被跟踪在 src-tauri/android/com/dusk/player/，构建前由
 * scripts/inject-android-plugin.mjs 复制进生成的安卓工程（src-tauri/gen 是 gitignore 的）。
 * 由 [OrientationPlugin] 的 init 调 [install] 安装，避免再加一个 Tauri 插件注册点。
 */
object SafeArea {
    /** 上一次写进 CSS 的值（CSS px）；-1 = 还没写过。 */
    private var lastCss = -1f
    private var webRef: WeakReference<WebView>? = null

    fun install(activity: Activity) {
        val decor = activity.window?.decorView ?: return
        decor.setOnApplyWindowInsetsListener { view, insets ->
            push(activity, insets)
            /* 透传默认处理：只观察，不改布局行为。 */
            view.onApplyWindowInsets(insets)
        }
        decor.requestApplyInsets()
        /* 第一帧时 WebView 可能还没挂上（evaluateJavascript 无处可发），补两次重试。 */
        decor.postDelayed({ decor.rootWindowInsets?.let { push(activity, it) } }, 300L)
        decor.postDelayed({ decor.rootWindowInsets?.let { push(activity, it) } }, 1200L)
    }

    private fun push(activity: Activity, insets: WindowInsets) {
        val px = bottomInsetPx(insets)
        val density = activity.resources?.displayMetrics?.density ?: 0f
        val css = if (density > 0f) px / density else 0f
        if (lastCss >= 0f && abs(css - lastCss) < 0.5f) return
        val wv = webView(activity.window?.decorView) ?: return
        lastCss = css
        val value = String.format(Locale.US, "%.2f", css)
        val js = "document.documentElement.style.setProperty('--sab','" + value + "px')"
        activity.runOnUiThread {
            try {
                wv.evaluateJavascript(js, null)
            } catch (_: Throwable) {
                /* 桥只是锦上添花：失败就让 CSS 落回 env()/0，绝不让异常冒到 UI 线程。 */
            }
        }
    }

    private fun bottomInsetPx(insets: WindowInsets): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bars = insets.getInsets(WindowInsets.Type.navigationBars()).bottom
            val mandatory = insets.getInsets(WindowInsets.Type.mandatorySystemGestures()).bottom
            val gestures = insets.getInsets(WindowInsets.Type.systemGestures()).bottom
            maxOf(bars, mandatory, gestures)
        } else {
            @Suppress("DEPRECATION")
            insets.systemWindowInsetBottom
        }
    }

    private fun webView(root: View?): WebView? {
        webRef?.get()?.let { if (it.isAttachedToWindow) return it }
        val found = findWebView(root) ?: return null
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
