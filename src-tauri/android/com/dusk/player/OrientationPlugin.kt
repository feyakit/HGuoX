package com.dusk.player

import android.app.Activity
import android.content.pm.ActivityInfo
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * 系统转屏：唯一的实现处。
 *
 * 为什么放在 Kotlin（而不是 Rust 里的裸 JNI）：
 * 上一版在 Rust 用 ndk_context 拿 Context 直接调 setRequestedOrientation，抛出来的 Java
 * 异常没人 check/clear，ART 就带着整个进程 SIGABRT 了 —— 云机实测点全屏必崩。
 * 走 Tauri 的移动端插件通道后，Kotlin 这边是普通 Java 调用（有 try/catch），失败只会
 * reject 回 Rust 的 Err，不会污染 JNI 异常状态，最坏情况也只是转不过去、退回 CSS 伪横屏。
 *
 * 本文件在仓库里的被跟踪位置：src-tauri/android/com/dusk/player/OrientationPlugin.kt
 * src-tauri/gen/ 是 gitignore 的生成目录（CI 每次 tauri android init --ci 重建），
 * 所以构建前要用 scripts/inject-android-plugin.mjs 复制进
 * src-tauri/gen/android/app/src/main/java/com/dusk/player/。
 */
@InvokeArg
class SetOrientationArgs {
    var landscape: Boolean = false
    /** 3.0.13：portrait / landscape / unspecified（null = 按 landscape 布尔走，兼容旧调用） */
    var mode: String? = null
}

@TauriPlugin
class OrientationPlugin(private val activity: Activity) : Plugin(activity) {
    init {
        /* 顺带把「底部安全区 → CSS --sab」的桥装起来（同一个已注册插件，
           不再加一个 Rust 端注册点）。失败不抛，见 SafeArea 里的注释。 */
        try {
            SafeArea.install(activity)
        } catch (error: Throwable) {
            System.err.println("[safe-area] 安装失败：" + (error.message ?: ""))
        }
    }

    /**
     * 从 Rust 侧调用：invoke('setOrientation', { landscape: true })，走
     * PluginHandle::run_mobile_plugin。
     */
    @Command
    fun setOrientation(invoke: Invoke) {
        /* requestedOrientation 会改 Window 属性，必须在 UI 线程；runOnUiThread 在已处于
           UI 线程时是同步执行的（不会把 invoke.resolve 推后到命令返回之后）。 */
        activity.runOnUiThread {
            try {
                val args = invoke.parseArgs(SetOrientationArgs::class.java)
                /* unspecified = 把方向还给系统（离开播放页 / 横版片源竖屏时）。
                   写回 UNSPECIFIED 而不是 PORTRAIT：后者会一直把 App 钉在竖屏。 */
                activity.requestedOrientation = when (args.mode) {
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    "unspecified" -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    else -> if (args.landscape) {
                        ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    } else {
                        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    }
                }
                invoke.resolve()
            } catch (error: Throwable) {
                /* 任何异常都只 reject 回去，绝不抛出：抛出去会让 WebView 那条链也跟着崩。 */
                invoke.reject(error.message ?: "setOrientation failed")
            }
        }
    }
}
