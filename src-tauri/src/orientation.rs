//! 安卓系统转屏：Kotlin 侧插件（OrientationPlugin）干活，Rust 只通过 Tauri 的移动端
//! 插件通道 `run_mobile_plugin_async` 下发一条消息。
//!
//! 为什么不用裸 JNI：上一版在 Rust 里用 ndk_context 拿 Context 直接调
//! `setRequestedOrientation`，抛出的 Java 异常没人 check/clear，ART 直接 SIGABRT
//! 把进程带走（云机实测：点全屏 → pidof 变空）。插件通道下所有失败都是 Rust 的
//! `Err`，Kotlin 侧有 try/catch 并 reject，不会污染 JNI 异常状态；最坏情况只是
//! 转不过去，画面退回 CSS 伪横屏。
//!
//! Kotlin 源在 `src-tauri/android/com/dusk/player/OrientationPlugin.kt`（被跟踪），
//! 由 `scripts/inject-android-plugin.mjs` 在构建前注入 `src-tauri/gen/android`。

#[cfg(target_os = "android")]
use tauri::Manager;

pub const PLUGIN_NAME: &str = "orientation";

#[cfg(target_os = "android")]
const ANDROID_PACKAGE: &str = "com.dusk.player";
#[cfg(target_os = "android")]
const ANDROID_CLASS: &str = "OrientationPlugin";

/// 注册插件：安卓上把 Kotlin 类挂到 Tauri 插件通道，并把拿到的 handle 交给应用状态
/// （desktop / iOS 上什么都不做）。
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R, ()>::new(PLUGIN_NAME)
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                /* 失败也不 panic：注册不上就等于没有系统转屏，画面继续走 CSS 伪横屏。 */
                match api.register_android_plugin(ANDROID_PACKAGE, ANDROID_CLASS) {
                    Ok(handle) => {
                        app.manage(handle);
                        eprintln!("[orientation] Kotlin 插件注册成功");
                    }
                    Err(error) => {
                        eprintln!("[orientation] Kotlin 插件注册失败（降级 CSS 伪横屏）：{error}");
                    }
                }
            }
            #[cfg(not(target_os = "android"))]
            let _ = (&app, &api);
            Ok(())
        })
        .build()
}

/// 安卓：把方向请求交给 Kotlin。任何失败都只返回 Err（调用方打日志，画面继续走
/// CSS 伪横屏），**不会** panic、也不会让进程挂掉。
#[cfg(target_os = "android")]
pub async fn request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    landscape: bool,
    mode: Option<&str>,
) -> Result<(), String> {
    /* try_state 而不是 state：没注册成功时 state() 会 panic，这里必须走 Option。 */
    let handle = app
        .try_state::<tauri::plugin::PluginHandle<R>>()
        .ok_or_else(|| "orientation 插件未注册".to_string())?;
    handle
        .run_mobile_plugin_async::<serde_json::Value>(
            "setOrientation",
            serde_json::json!({ "landscape": landscape, "mode": mode }),
        )
        .await
        .map(|_| ())
        .map_err(|error| format!("Kotlin setOrientation 失败：{error}"))
}
