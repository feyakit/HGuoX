//! 业务命令：登录 / 列表 / 详情 / 播放 / 互动。

use crate::net::{base, edge};
use crate::session::{Session, SessionStore};
use serde_json::{json, Value};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

pub struct Api {
    pub session: SessionStore,
}

impl Api {
    pub fn new() -> Self {
        Self {
            session: SessionStore::new(),
        }
    }

    /// POST 信封：新播放接口 /api/videos/{id}/episodes/{ep}/playback 需要。
    async fn post(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        let token = self.session.token(&origin).filter(|_| {
            !crate::network_policy::strict_security() || crate::net::trusted_auth_origin(&origin)
        });
        edge(&origin, "POST", path, body, token.as_deref()).await
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let origin = base();
        let token = self.session.token(&origin).filter(|_| {
            !crate::network_policy::strict_security() || crate::net::trusted_auth_origin(&origin)
        });
        edge(&origin, "GET", path, None, token.as_deref()).await
    }

    async fn authed(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        let token = self
            .session
            .token(&origin)
            .ok_or_else(|| "请先登录".to_string())?;
        edge(&origin, method, path, body, Some(&token)).await
    }

    fn account_session(&self, expected_user_id: Option<i64>, expected_origin: Option<&str>) -> Result<Session, String> {
        let origin = base();
        let session = self.session.snapshot(&origin).ok_or_else(|| "请先登录".to_string())?;
        if expected_origin.is_some_and(|value| value != origin)
            || expected_user_id.is_some_and(|value| session.user.get("id").and_then(Value::as_i64) != Some(value)) {
            return Err("账号或线路已变化，请重试".into());
        }
        Ok(session)
    }

    async fn account_request(&self, method: &str, path: &str, body: Option<Value>, expected_user_id: Option<i64>, expected_origin: Option<&str>) -> Result<Value, String> {
        let session = self.account_session(expected_user_id, expected_origin)?;
        let result = edge(&session.origin, method, path, body, Some(&session.token)).await?;
        if base() != session.origin || !self.session.is_current(&session) {
            return Err("账号或线路已变化，请重试".into());
        }
        Ok(result)
    }
}

/// Older mirrors wrap `user`; current account/me returns the User directly.
fn normalize_account(value: Value, origin: &str) -> Result<Value, String> {
    let source = value.get("user").filter(|v| v.is_object()).unwrap_or(&value);
    let mut user = json!({});
    // Only profile fields cross IPC; a legacy direct login response can also contain a token.
    for key in ["id", "username", "nickname", "avatar", "avatar_color", "sign", "desc", "user_type", "counts", "interactions"] {
        if let Some(field) = source.get(key) { user[key] = field.clone(); }
    }
    if !user.get("id").and_then(Value::as_i64).is_some_and(|id| id > 0) {
        return Err("账号资料响应无效，请重新登录".into());
    }
    let interactions = value.get("interactions").or_else(|| user.get("interactions")).cloned();
    if let Some(ref interactions) = interactions { user["interactions"] = interactions.clone(); }
    let mut result = json!({"user": user, "origin": origin});
    if let Some(interactions) = interactions { result["interactions"] = interactions; }
    Ok(result)
}

fn normalize_account_history(value: Value) -> Result<Value, String> {
    let items = value.get("items").and_then(Value::as_array).ok_or("观看历史响应无效")?;
    let pagination = value.get("pagination").filter(|v| v.is_object()).ok_or("观看历史分页信息无效")?;
    let items: Vec<Value> = items.iter().filter_map(|item| {
        if item.get("target_type").and_then(Value::as_str) != Some("video") { return None; }
        let id = item.get("id")?.as_i64()?;
        let video_id = item.get("video_id")?.as_i64()?;
        if id <= 0 || video_id <= 0 { return None; }
        Some(json!({"id": id, "video_id": video_id, "target_type": "video",
            "last_ep": item.get("last_ep").and_then(Value::as_u64).unwrap_or(1).max(1),
            "updated_at": item.get("updated_at").and_then(Value::as_str).unwrap_or("")}))
    }).collect();
    for field in ["page", "pages", "size", "total"] {
        if pagination.get(field).and_then(Value::as_u64).is_none() { return Err("观看历史分页信息无效".into()); }
    }
    Ok(json!({"items": items, "pagination": pagination}))
}

/// API/运行错误与自检统一写入 debug.log，每行附 RFC 3339 UTC 时间和进程编号。
#[tauri::command]
pub async fn debug_log(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::logging::append_debug(&dir, &msg)
}

/// 网络自检：系统代理 / DNS / 连通性快照，用于远程定位「打不开」。
#[tauri::command]
pub async fn net_diag() -> Result<Value, String> {
    Ok(crate::net::diagnose().await)
}

/* ───────────────────────── 线路（数据源） ───────────────────────── */
// Network probes run without holding this lock. Manual selection/cancellation
// invalidates older probes; applying a result is serialized with manual writes.
static LINE_SELECTION: std::sync::Mutex<u64> = std::sync::Mutex::new(0);

fn begin_line_selection() -> Result<u64, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    Ok(*generation)
}

#[tauri::command]
pub async fn line_cancel() -> Result<(), String> {
    begin_line_selection().map(|_| ())
}

/// 当前线路 + 固定线路清单（镜像线路另外按需拉取）。
#[tauri::command]
pub async fn line_state() -> Result<Value, String> {
    Ok(json!({
        "base": base(),
        "default": crate::net::DEFAULT_BASE,
        "custom": crate::net::is_custom_line(),
        "fixed": crate::lines::fixed(),
    }))
}

/// 凭据可信的线路：固定主站，或本进程内被发布页确认过的镜像。
///
/// 手动保存的自定义线路**不算**：它可能有自己的登录，但 token 绝不跟着切过去，
/// 也绝不从它搬回来。
fn trusted_line_origin(origin: &str) -> bool {
    crate::session::rebase_trust(origin)
}

/// 手动切换线路：只允许固定线路或刚从可信发布页读取的镜像。
///
/// 可信↔可信之间保留登录（同一账号体系）；任一端不可信则清空会话。
#[tauri::command]
pub async fn line_set(state: State<'_, Api>, url: String) -> Result<String, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    let previous = base();
    let applied = crate::net::set_base(&url)?;
    crate::net::refresh_client();
    if previous != applied && !state.session.rebase_if_trusted(&applied, trusted_line_origin) {
        state.session.clear();
    }
    Ok(applied)
}

#[tauri::command]
pub async fn line_custom_set(state: State<'_, Api>, url: String) -> Result<Value, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    let previous = base();
    let applied = crate::net::set_custom_base(&url)?;
    crate::net::refresh_client();
    if previous != applied { state.session.clear(); }
    Ok(json!({ "base": applied, "custom": crate::net::is_custom_line() }))
}

#[tauri::command]
pub async fn line_reset(state: State<'_, Api>) -> Result<Value, String> {
    let base = line_set(state, crate::net::DEFAULT_BASE.to_string()).await?;
    Ok(json!({ "base": base, "custom": false }))
}

#[tauri::command]
pub async fn proxy_state() -> Result<Value, String> {
    Ok(crate::net::proxy_state())
}

#[tauri::command]
pub async fn proxy_set(mode: String, url: String) -> Result<Value, String> {
    // Serialize with line application: probes using the previous proxy must
    // never switch the line after the new proxy has been saved.
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    crate::proxy::set(&mode, &url)?;
    *generation = generation.wrapping_add(1);
    crate::net::refresh_client();
    let state = crate::net::proxy_state();
    crate::playback_log::record("proxy.changed", json!({
        "mode": state.get("mode"), "proxy": state.get("effective"),
    }));
    Ok(state)
}

#[tauri::command]
pub async fn proxy_test(mode: String, url: String) -> Result<Value, String> {
    Ok(crate::net::test_proxy(&mode, &url).await)
}

/// 从地址发布页抓镜像线路（只在用户点开「线路」时调用）。
#[tauri::command]
pub async fn line_mirrors() -> Result<Value, String> {
    // 用户手动点「刷新 / 打开线路」时重新读一次系统代理：代理软件开关过之后旧客户端会卡死
    crate::net::refresh_client();
    crate::lines::mirrors().await
}

/// 可达性探测：只报结果，不做自动检查 / 自动切换。
#[tauri::command]
pub async fn line_probe(urls: Vec<String>) -> Result<Value, String> {
    crate::net::refresh_client();
    Ok(crate::lines::probe(urls).await)
}

/// 自动选线：探测主站与可信发布页镜像，全部失败时保持当前线路。
///
/// 新旧两端都可信（固定线路 / 本进程发布页确认的镜像）时保留会话并搬 origin；
/// 旧 origin 不可信（如自定义线路）则清空，绝不把 token 带给新站点。
#[tauri::command]
pub async fn line_auto(state: State<'_, Api>) -> Result<Value, String> {
    let selection = begin_line_selection()?;
    crate::net::refresh_client();
    let pick = crate::lines::auto_pick().await;
    let chosen = pick
        .get("base")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut switched = false;
    let generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    let previous = base();
    if *generation == selection
        && pick.get("reason").and_then(Value::as_str) != Some("all-down")
        && !chosen.is_empty() && chosen != previous {
        let next = crate::net::set_base(&chosen)?;
        crate::net::refresh_client();
        switched = next != previous;
        if switched && !state.session.rebase_if_trusted(&next, trusted_line_origin) {
            state.session.clear();
        }
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "cancelled": *generation != selection,
        "pick": pick,
    }))
}

/// 当前走的是镜像时，敲一次主站：通了就切回（不清会话）。
///
/// 和 [`line_auto`] 的分工：[`line_auto`] 是「整体比一次」，要抓发布页；
/// 这个只问一句「主站现在通不通」，代价一个请求，可以频繁调用。
#[tauri::command]
pub async fn line_try_main(state: State<'_, Api>) -> Result<Value, String> {
    let selection = begin_line_selection()?;
    crate::net::refresh_client();
    let probe = crate::lines::try_main().await;
    let mut switched = false;
    let generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    let previous = base();
    if *generation == selection && probe.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let chosen = probe.get("base").and_then(Value::as_str).unwrap_or_default();
        if !chosen.is_empty() && chosen != previous {
            let next = crate::net::set_base(chosen)?;
            crate::net::refresh_client();
            switched = next != previous;
            if switched && !state.session.rebase_if_trusted(&next, trusted_line_origin) {
                state.session.clear();
            }
        }
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "probe": probe,
        "cancelled": *generation != selection,
    }))
}

/* ───────────────────────── 更新检查 ───────────────────────── */

const REPO: &str = "feyakit/HGuoX";

fn ver_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .map(|s| s.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// 只比较数字段：`v1.2.0` > `1.1.9`；解析不出的段按 0 处理。
fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (ver_parts(latest), ver_parts(current));
    for i in 0..a.len().max(b.len()) {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 从 tag / name 里取出 `x.y.z`。
///
/// 我们的 tag 是 `hgfix-1.2.1-r5`，上游是 `v1.2.0`，release name 是 `HGuoX 1.2.1+hg.1`。
/// 直接拿去比会从第一位就判负（`hgfix-1` 解析成 0），所以先抠出版本号。
fn version_in(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut dots = 0;
        let mut j = i;
        while j < chars.len() && (chars[j].is_ascii_digit() || (chars[j] == '.' && dots < 2)) {
            if chars[j] == '.' {
                dots += 1;
            }
            j += 1;
        }
        if dots == 2 {
            return chars[start..j].iter().collect();
        }
        i = j.max(i + 1);
    }
    String::new()
}

/// 线路体检：探一次 `/api/videos`，和自动选线用同一个判据。
#[tauri::command]
pub async fn line_health() -> Result<Value, String> {
    Ok(crate::lines::health().await)
}
/// 对比 GitHub Release 的 tag 与当前版本（未认证 60 次/小时/IP，够用）。
#[tauri::command]
pub async fn check_update() -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = crate::net::get(
        &url,
        std::time::Duration::from_secs(12),
        Some("application/vnd.github+json"),
        None,
    )
    .await?;

    let status = resp.status();
    if status.as_u16() == 404 {
        // 还没发过 release
        return Ok(json!({
            "current": current, "latest": "", "has_update": false,
            "url": format!("https://github.com/{REPO}/releases"),
        }));
    }
    if !status.is_success() {
        return Err(format!("GitHub 返回 HTTP {status}"));
    }

    let v: Value = resp.json().await.map_err(|e| crate::net::err_text(&e))?;
    let tag = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let html = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases"));
    let notes = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
    // tag 是 `hgfix-1.2.1-r5`，不能直接拿整串比大小
    let latest = {
        let found = version_in(&tag);
        if found.is_empty() {
            tag.trim_start_matches(['v', 'V']).to_string()
        } else {
            found
        }
    };

    // 顺手把「这个平台该下哪个包」挑出来，前端好直接应用内更新
    let assets = v.get("assets").and_then(Value::as_array).cloned().unwrap_or_default();
    let asset = assets
        .iter()
        .filter_map(|a| {
            let name = a.get("name").and_then(Value::as_str)?;
            let url = a.get("browser_download_url").and_then(Value::as_str)?;
            Some((name.to_string(), url.to_string()))
        })
        .filter(|(n, _)| asset_rank(n) > 0)
        .max_by_key(|(n, _)| asset_rank(n));
    Ok(json!({
        "current": current,
        "latest": latest,
        "tag": tag,
        "has_update": !latest.is_empty() && is_newer(&latest, &current),
        "asset": asset.map(|(name, url)| json!({ "name": name, "url": url })),
        "url": html,
        "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(""),
        "published_at": v.get("published_at").and_then(|x| x.as_str()).unwrap_or(""),
        "notes": notes.chars().take(800).collect::<String>(),
    }))
}

/// 用系统默认浏览器打开链接（只允许 http/https）。
/// 这个平台该更新哪个包，数字越大越优先。
///
/// 安卓的 release 里同时有 arm64 / arm(v7) / x86_64 三个 apk，光看「是不是 apk」
/// 会先撞上 armv7 那个，64 位机器就降到 32 位跑了。所以按架构给分，取最高。
fn asset_rank(name: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    if cfg!(target_os = "android") {
        if !n.ends_with(".apk") {
            0
        } else if cfg!(target_arch = "aarch64") {
            if n.contains("arm64") || n.contains("aarch64") {
                3
            } else {
                1
            }
        } else if cfg!(target_arch = "x86_64") {
            if n.contains("x86_64") {
                3
            } else {
                1
            }
        } else if n.contains("x86") || n.contains("arm64") {
            1
        } else {
            2
        }
    } else if cfg!(target_os = "windows") {
        if n.ends_with(".exe") { 3 } else { 0 }
    } else if cfg!(target_os = "macos") {
        if n.ends_with(".dmg") { 3 } else { 0 }
    } else if n.ends_with(".deb") {
        3
    } else if n.ends_with(".appimage") {
        2
    } else {
        0
    }
}

#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = crate::network_policy::parse_target(&url)?;
    // 固定使用默认处理器；不向前端暴露可指定程序的 opener 命令。
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 切换移动端屏幕方向：iOS 走 objc；Android 走 Kotlin 插件（orientation.rs）。
///
/// 3.0.5 之前 Android 分支是空实现，点「横屏全屏」只走 `.fs-landscape` 的 CSS 旋转（伪横屏），
/// 系统仍是竖屏。现在两端都真转；前端 `EpisodePlayer` 在退全屏 / 退出播放器 / 切后台
/// 三条路径都会回调 `landscape: false`，不会把用户锁在横屏里。
/// gen/android 是 gitignore 的生成目录（每次 `tauri android init` 重建），所以实现放在 Rust，
/// 不放在那里改 Kotlin。
///
/// 审计 #8：失败**必须回到前端**。原来两端拿到失败都只 `eprintln` 再 `Ok(())`，
/// 前端只在 invoke reject 时提示 —— 于是「点了全屏没转」永远是静默的。
/// 现在失败一律 `Err(原因)`，`requestOrientation.onFail` 会弹一条 playback-hint（UI 不动）。
#[tauri::command]
pub async fn set_orientation(app: tauri::AppHandle, landscape: bool) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        /* run_on_main_thread 的闭包没有返回值，用 channel 把结果带回来才算真的知道成没成。 */
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(request_ios_orientation(landscape));
        })
        .map_err(|error| format!("转屏请求没能派发到主线程：{error}"))?;
        match rx.recv_timeout(std::time::Duration::from_millis(1500)) {
            Ok(Ok(())) => eprintln!("[orientation] iOS 已下发几何更新(landscape={landscape})"),
            Ok(Err(reason)) => {
                eprintln!("[orientation] iOS 下发失败：{reason}");
                return Err(reason);
            }
            Err(_) => return Err("系统转屏无响应（主线程 1.5s 未回应）".to_string()),
        }
    }
    #[cfg(target_os = "android")]
    {
        /* 安卓：走 Kotlin 插件（orientation.rs），Rust 里**不再有任何裸 JNI** ——
           上一版那条 JNI 路径没清 Java 异常，点全屏直接 SIGABRT 把进程带走。
           插件 reject / 未注册时返回 Err 给前端（审计 #8），画面停在竖屏沉浸全屏。 */
        match crate::orientation::request(&app, landscape).await {
            Ok(()) => eprintln!("[orientation] 已下发 Kotlin setOrientation(landscape={landscape})"),
            Err(error) => {
                eprintln!("[orientation] 下发失败：{error}");
                return Err(format!("系统未允许转屏：{error}"));
            }
        }
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (&app, landscape);
    }
    Ok(())
}


/// iOS 专用：切换 WKWebView 文本交互。
/// 主界面默认关闭以消除长按快进时的系统放大镜；输入框聚焦时前端调用此命令重新打开，
/// 失焦后再关闭，避免影响搜索/评论/登录等文本输入。
#[tauri::command]
pub fn set_text_interaction(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            crate::ios_layout::set_text_interaction_on_webview(window.as_ref(), enabled);
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&app, enabled);
    }
    Ok(())
}

#[cfg(target_os = "ios")]
fn request_ios_orientation(landscape: bool) -> Result<(), String> {
    /* iOS 16+ 的正确转屏姿势：拿前台活跃的 UIWindowScene，调
       -[UIWindowScene requestGeometryUpdateWithPreferences:errorHandler:]。
       参数用 +[UIWindowSceneGeometryPreferencesIOS preferencesWithInterfaceOrientations:]。

       ⚠️ 这里**故意不做**旧系统的 KVC 兜底（`UIDevice setValue:forKey:@"orientation"` +
       `attemptRotationToDeviceOrientation`）：
         · 那条路在 iOS 16+ 会抛 NSInternalInconsistencyException
           （"Supported orientations has gone out of sync..."）；
         · Rust 侧接不住 ObjC 异常，异常会直接把进程带走（和安卓 SIGABRT 同类事故）。
       旧系统拿不到 UIWindowSceneGeometryPreferencesIOS 时返回 Err（前端弹一条
       playback-hint 并停在竖屏沉浸全屏）—— 宁可转不过去，也不能崩。

       另外：Info.plist 的 UISupportedInterfaceOrientations 必须包含横屏，
       否则系统会拒绝几何更新（控制台报 "Supported orientations has gone out of sync"）。
       见 `src-tauri/Info.ios.plist`（被 Tauri 合并进工程，CI 也生效）。 */
    use std::ffi::{c_char, c_void};
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    /* UIInterfaceOrientationMask：Portrait = 1<<1 = 2；LandscapeLeft = 1<<3 = 8；
       LandscapeRight = 1<<4 = 16；UIInterfaceOrientationMaskLandscape = 8|16 = 24。
       这里横屏用 24（两个方向都允许），避免只因某个方向在 plist 里被允许而请求落空。 */
    const MASK_PORTRAIT: usize = 2;
    const MASK_LANDSCAPE: usize = 24;
    const ACTIVE_FOREGROUND: usize = 0; // UIApplicationStateActive / UIScene.ActivationState.foregroundActive

    unsafe {
        let msg0: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let msg0_usize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        let msg1_usize: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let msg1_bool: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool =
            std::mem::transmute(objc_msgSend as *const ());
        let msg2_void: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());

        let prefs_cls = objc_getClass(b"UIWindowSceneGeometryPreferencesIOS\0".as_ptr() as *const c_char);
        let app_cls = objc_getClass(b"UIApplication\0".as_ptr() as *const c_char);
        /* iOS < 16 没有这个类：直接返回 Err（不调会抛异常的旧 API） */
        if prefs_cls.is_null() || app_cls.is_null() {
            return Err("系统没有 UIWindowSceneGeometryPreferencesIOS（iOS 16 以下不支持几何更新）".to_string());
        }

        let sel_prefs = sel_registerName(b"preferencesWithInterfaceOrientations:\0".as_ptr() as *const c_char);
        let responds = sel_registerName(b"respondsToSelector:\0".as_ptr() as *const c_char);
        if !msg1_bool(prefs_cls, responds, sel_prefs) {
            return Err("系统不响应 preferencesWithInterfaceOrientations:".to_string());
        }
        let mask = if landscape { MASK_LANDSCAPE } else { MASK_PORTRAIT };
        let prefs = msg1_usize(prefs_cls, sel_prefs, mask);
        if prefs.is_null() {
            return Err("几何偏好对象创建失败".to_string());
        }

        let app = msg0(app_cls, sel_registerName(b"sharedApplication\0".as_ptr() as *const c_char));
        if app.is_null() {
            return Err("取不到 UIApplication".to_string());
        }
        let scenes_set = msg0(app, sel_registerName(b"connectedScenes\0".as_ptr() as *const c_char));
        if scenes_set.is_null() {
            return Err("取不到 connectedScenes".to_string());
        }
        let arr = msg0(scenes_set, sel_registerName(b"allObjects\0".as_ptr() as *const c_char));
        if arr.is_null() {
            return Err("取不到场景列表".to_string());
        }

        let sel_count = sel_registerName(b"count\0".as_ptr() as *const c_char);
        let sel_at = sel_registerName(b"objectAtIndex:\0".as_ptr() as *const c_char);
        let sel_state = sel_registerName(b"activationState\0".as_ptr() as *const c_char);
        let sel_req =
            sel_registerName(b"requestGeometryUpdateWithPreferences:errorHandler:\0".as_ptr() as *const c_char);
        let count = msg0_usize(arr, sel_count);

        /* 优先前台活跃的那个 scene（多窗口/iPad 场景下不一定只有一个） */
        let mut target: *mut c_void = std::ptr::null_mut();
        for i in 0..count {
            let scene = msg1_usize(arr, sel_at, i);
            if scene.is_null() || !msg1_bool(scene, responds, sel_req) {
                continue;
            }
            if msg0_usize(scene, sel_state) == ACTIVE_FOREGROUND {
                target = scene;
                break;
            }
            if target.is_null() {
                target = scene;
            }
        }
        if target.is_null() {
            return Err("没有可请求几何更新的前台场景".to_string());
        }
        /* errorHandler 传 NULL：这里只代表「请求已交给系统」，真正被系统拒绝只会在
           系统日志里留一行，不会抛异常、不会崩（前端仍是竖屏沉浸全屏，可再次点全屏重试）。 */
        msg2_void(target, sel_req, prefs, std::ptr::null_mut());
        Ok(())
    }
}

/* ───────────────────────── 会话 ───────────────────────── */

#[tauri::command]
pub async fn app_boot(state: State<'_, Api>) -> Result<Value, String> {
    // 冷启动对账：会话可能还停在上一轮的线路（例如 App 没开时自动选线换了地址）。
    // 两端都可信就把登录态搬到当前线路；不可信就不搬——绝不把 token 带给另一个站点。
    //
    // 与 12f1968 那版的差别（上游 5ecfaee）：这里**不再失败即 clear**。
    // 搬不动只说明"当前这条线路暂时没登录"，会话原样留在旧 origin，等发布页恢复或用户切回去
    // 还能用；清空等于把一次临时的发布页故障变成"重新登录"。boot 照实报 logged_in=false。
    let current = base();
    state.session.reconcile_on_boot(&current).await;
    let origin = base();
    let credentials_allowed = !crate::network_policy::strict_security()
        || crate::net::trusted_auth_origin(&origin);
    Ok(json!({
        "user": if credentials_allowed { state.session.user(&origin) } else { Value::Null },
        "logged_in": credentials_allowed && state.session.token(&origin).is_some(),
        "base": origin,
        "strict_security": crate::network_policy::strict_security(),
        "cli_relaxed": crate::network_policy::cli_strict_override() == Some(false),
    }))
}

/// 切换严格安全模式（关闭后回退到兼容清洗与网络守卫模式，立即生效并落盘）。
#[tauri::command]
pub async fn security_set(strict: bool) -> Result<bool, String> {
    crate::network_policy::set_strict_security(strict)?;
    crate::net::refresh_client();
    crate::playback_log::record(
        "security.mode_changed",
        json!({"strict": crate::network_policy::strict_security()}),
    );
    Ok(crate::network_policy::strict_security())
}

#[tauri::command]
pub async fn api_login(
    state: State<'_, Api>,
    username: String,
    password: String,
) -> Result<Value, String> {
    let origin = base();
    let revision = state.session.revision();
    let data = edge(
        &origin,
        "POST",
        "/api/account/loginByPassword",
        Some(json!({ "username": username, "password": password })),
        None,
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "登录返回缺少 token".to_string())?
        .to_string();
    let account = normalize_account(data, &origin)?;
    let user = account["user"].clone();
    if base() != origin {
        return Err("登录期间线路已变化，请重新登录".into());
    }
    if !state.session.set_if_revision(revision, &origin, token, user) {
        return Err("登录期间账号状态已变化，请重试".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_register(
    state: State<'_, Api>,
    username: String,
    password: String,
    email: String,
) -> Result<Value, String> {
    let origin = base();
    let revision = state.session.revision();
    let mut body = json!({
        "username": username,
        "password": password,
        "confirm_password": password,
    });
    if !email.trim().is_empty() {
        body["email"] = json!(email);
    }
    let data = edge(
        &origin,
        "POST",
        "/api/account/registerByPassword",
        Some(body),
        None,
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "注册返回缺少 token".to_string())?
        .to_string();
    let account = normalize_account(data, &origin)?;
    let user = account["user"].clone();
    if base() != origin {
        return Err("注册期间线路已变化，请重新登录".into());
    }
    if !state.session.set_if_revision(revision, &origin, token, user) {
        return Err("注册期间账号状态已变化，请重试".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_logout(state: State<'_, Api>, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let session = state.account_session(expected_user_id, expected_origin.as_deref())?;
    let _ = edge(
        &session.origin,
        "POST",
        "/api/account/logout",
        None,
        Some(&session.token),
    )
    .await;
    if !state.session.clear_if_current(&session) {
        return Err("账号已变化，请重试".into());
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn api_me(state: State<'_, Api>, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let session = state.account_session(expected_user_id, expected_origin.as_deref())?;
    let me = edge(&session.origin, "GET", "/api/account/me", None, Some(&session.token)).await?;
    let account = normalize_account(me, &session.origin)?;
    if base() != session.origin {
        return Err("读取账号期间线路已变化".into());
    }
    if !state.session.update_user_if_current(&session, account["user"].clone()) {
        return Err("读取账号期间登录状态已变化".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_account_history(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, page: u32, size: u32) -> Result<Value, String> {
    let page = page.max(1);
    let size = size.clamp(1, 100);
    let value = state.account_request("GET", &format!("/api/users/me/history?page={page}&size={size}"), None,
        Some(expected_user_id), Some(&expected_origin)).await?;
    normalize_account_history(value)
}

#[tauri::command]
pub async fn api_account_history_record(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, video_id: i64, ep: u32) -> Result<Value, String> {
    if video_id <= 0 || ep == 0 { return Err("观看记录参数无效".into()); }
    state.account_request("POST", "/api/users/me/history", Some(json!({"video_id": video_id, "ep": ep})),
        Some(expected_user_id), Some(&expected_origin)).await
}

#[tauri::command]
pub async fn api_account_history_delete(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, ids: Vec<i64>) -> Result<Value, String> {
    if ids.is_empty() || ids.len() > 200 || ids.iter().any(|id| *id <= 0) { return Err("观看记录参数无效".into()); }
    state.account_request("POST", "/api/users/me/history/delete", Some(json!({"ids": ids})),
        Some(expected_user_id), Some(&expected_origin)).await
}

/* ───────────────────────── 列表 ───────────────────────── */

#[tauri::command]
pub async fn api_feed(
    state: State<'_, Api>,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    // sort=new 是站点支持的「最新上架」，首页「最新」胶囊与最新上架横滑都用它
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    state
        .get(&format!("/api/videos?page={page}&size={size}{sort}"))
        .await
}

/// 原创频道，返回分页视频卡（结构同 api_feed）。
/// 优先解析官网服务端渲染频道页，与网站排序保持一致；抓取/解析失败或非预设分类
/// 自动回退下面的 JSON 接口，`Paged<VideoCard>` 契约不变。
#[tauri::command]
pub async fn api_original_videos(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    if let Ok(value) = crate::channel_page::fetch_original(&cate, page, size).await {
        return Ok(value);
    }
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    let path = if cate == "all" {
        format!("/api/videos?is_original=1&page={page}&size={size}{sort}")
    } else {
        format!("/api/videos/category/{cate}?is_original=1&page={page}&size={size}{sort}")
    };
    state.get(&path).await
}

/* ───────────────────────── 专题 / 标签 ───────────────────────── */

/// 专题列表：`/api/topics` 返回 data.items（标题/封面/简介/收录数）。
#[tauri::command]
pub async fn api_topics(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/topics?size=100").await
}

/// 专题详情：`/api/topics/{slug}` 返回 data = { topic, videos, related }。
/// `videos` 是分页对象；专题可能有上百部，不能只读第一页。
#[tauri::command]
pub async fn api_topic(state: State<'_, Api>, slug: String, page: u32, size: u32) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(slug.as_bytes()).collect();
    let page = page.max(1);
    let size = size.clamp(1, 100);
    state.get(&format!("/api/topics/{encoded}?page={page}&size={size}")).await
}

/// 标签分组：`/api/tags` 返回 data.categories[]，每个含 tags[]（name/slug/hot_score）。
#[tauri::command]
pub async fn api_tags(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/tags").await
}

/// 按标签取短剧：后端按中文标签名匹配；社区标签需使用 api_post_tag。
#[tauri::command]
pub async fn api_tag_videos(
    state: State<'_, Api>,
    tag: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
    /* 默认排序对齐官网标签页（上游 42d7d71）：`/tag/{slug}/` 默认 `data-active-tab="latest"`，
       而 `/api/videos/tag/{tag}` 省略 sort 时按 hot 出，两边顺序对不上。
       只有显式要 hot 才切 hot。 */
    let sort = match sort.as_deref() {
        Some("hot") => "hot",
        _ => "latest",
    };
    state
        .get(&format!(
            "/api/videos/tag/{encoded}?page={page}&size={size}&sort={sort}"
        ))
        .await
}

/// 按标签取吃瓜帖：`/api/posts/tag/{name}` 按标签名称匹配，不接受网页 slug。
#[tauri::command]
pub async fn api_post_tag(
    state: State<'_, Api>,
    tag: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
    let page = page.max(1);
    let size = size.clamp(1, 100);
    state
        .get(&format!("/api/posts/tag/{encoded}?page={page}&size={size}"))
        .await
}

#[tauri::command]
pub async fn api_category(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    if let Ok(value) =
        crate::channel_page::fetch_category(&cate, page, size, sort.as_deref()).await
    {
        return Ok(value);
    }
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    state
        .get(&format!(
            "/api/videos/category/{cate}?page={page}&size={size}{sort}"
        ))
        .await
}

#[tauri::command]
pub async fn api_rank(state: State<'_, Api>, kind: String) -> Result<Value, String> {
    /* 热播榜以官网 SSR 页为准（上游 7b98b78）：JSON `/api/ranks/hot` 是历史累计热力，
       和官网「实时热度」既不同序也不同值；解析失败再回退 JSON，契约不变。 */
    if !matches!(kind.as_str(), "recommend" | "potential") {
        if let Ok(rank) = crate::channel_page::fetch_hot_rank().await {
            return Ok(rank);
        }
        return state.get("/api/ranks/hot").await;
    }
    state.get(&format!("/api/ranks/{kind}")).await
}

/// 全站搜索：`/api/search?q=...&type=video|post`。
///
/// `type` 省略时后端默认只搜短剧；吃瓜帖必须显式传 `type=post`，
/// 否则搜「吃瓜频道关键词」永远是空结果（issue #34）。
#[tauri::command]
pub async fn api_search(
    state: State<'_, Api>,
    q: String,
    page: u32,
    size: u32,
    kind: Option<String>,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
    let scope = match kind.as_deref() {
        Some("post") => "&type=post",
        Some("video") => "&type=video",
        _ => "",
    };
    state
        .get(&format!("/api/search?q={encoded}&page={page}&size={size}{scope}"))
        .await
}

/// 热搜榜：解析官网搜索页服务端渲染的热搜影片列表。
#[tauri::command]
pub async fn api_search_hot(_state: State<'_, Api>) -> Result<Value, String> {
    crate::search_hot::fetch().await
}

#[tauri::command]
pub async fn api_posts(
    state: State<'_, Api>,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    state
        .get(&format!("/api/posts?page={page}&size={size}{sort}"))
        .await
}

/// 官网博客 SSR 列表（/blog/、/blog/gossip/、/blog/reviews/），包含「短剧剧评」与最新时间线。
#[tauri::command]
pub async fn api_blog_posts(cate: Option<String>, page: u32) -> Result<Value, String> {
    crate::blog::fetch(cate, page).await
}

#[tauri::command]
pub async fn api_post(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/posts/{id}")).await
}

/// 吃瓜帖视频：`POST /api/posts/{id}/playback` → `data.videos[].url`（mode=1 为明文 m3u8）。
///
/// 帖详情里的 `video_url` / `video_api` 恒为空，视频地址只由这个接口下发；
/// 不调它的话吃瓜页永远只有图文（issue #11）。无视频时接口返回 status=0
/// 「视频不存在或不可播放」，经 `edge()` 转换后就是 Err，前端按「无视频」处理。
#[tauri::command]
pub async fn api_post_playback(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state
        .post(&format!("/api/posts/{id}/playback"), Some(json!({})))
        .await
}

/* ───────────────────────── 详情 / 播放 ───────────────────────── */

#[tauri::command]
pub async fn api_video(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/videos/{id}")).await
}

fn non_empty(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null() && x.as_str().is_some_and(|s| !s.trim().is_empty()))
}

/// 把新接口返回的 streams.main / streams.hevc 回填到 video_url / video_url_hevc，
/// 前端只认 video_url，旧字段缺失时也兼容。
fn normalize_play_info(info: &mut Value) {
    let Some(obj) = info.as_object_mut() else { return };
    for (field, key) in [("video_url", "main"), ("video_url_hevc", "hevc")] {
        let url = obj
            .get("streams")
            .and_then(|st| st.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned);
        if let Some(url) = url {
            if non_empty(obj.get(field)).is_none() {
                obj.insert(field.into(), json!(url));
            }
        }
    }
    // 上游有些源只给 HEVC：前端只认 video_url，缺了就被判「无播放地址」。
    // 主地址为空时用 HEVC 兜底，播放能走多远是解码器的事，不要卡在这一层。
    if non_empty(obj.get("video_url")).is_none() {
        if let Some(hevc) = non_empty(obj.get("video_url_hevc")).cloned() {
            obj.insert("video_url".into(), hevc);
        }
    }
}

fn has_play_url(info: &Value) -> bool {
    non_empty(info.get("video_url")).is_some() || non_empty(info.get("video_url_hevc")).is_some()
}

#[tauri::command]
pub async fn api_play(state: State<'_, Api>, id: i64, ep: u32) -> Result<Value, String> {
    // 优先走新接口；失败或没有可用地址时退回旧接口，两者都不行就返回新接口的结果/错误。
    let primary = state
        .post(
            &format!("/api/videos/{id}/episodes/{ep}/playback"),
            Some(json!({})),
        )
        .await
        .map(|mut info| {
            normalize_play_info(&mut info);
            info
        });
    if let Ok(info) = &primary {
        if has_play_url(info) {
            return primary;
        }
    }
    match state
        .get(&format!("/api/videos/{id}/play?ep={ep}&page_texts=0"))
        .await
    {
        Ok(mut legacy) => {
            normalize_play_info(&mut legacy);
            if has_play_url(&legacy) || primary.is_err() {
                Ok(legacy)
            } else {
                primary
            }
        }
        Err(_) => primary,
    }
}

/* ───────────────────────── 评论 / 互动 ───────────────────────── */

#[tauri::command]
pub async fn api_comments(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!(
            "/api/videos/{id}/comments?ep={ep}&page={page}&size={size}"
        ))
        .await
}

#[tauri::command]
pub async fn api_comment_send(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    text: String,
    reply_id: Option<i64>,
) -> Result<Value, String> {
    let mut body = json!({ "text": text });
    let path = match reply_id {
        Some(rid) if rid > 0 => {
            body["reply_id"] = json!(rid);
            format!("/api/videos/{id}/comments")
        }
        _ => format!("/api/videos/{id}/comments?ep={ep}"),
    };
    state.authed("POST", &path, Some(body)).await
}

#[tauri::command]
pub async fn api_like(state: State<'_, Api>, id: i64, ep: u32, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/videos/{id}/like?ep={ep}"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_collect(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/videos/{id}/collect"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_follow(state: State<'_, Api>, uid: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/users/{uid}/follow"), None, expected_user_id, expected_origin.as_deref())
        .await
}

/* ───────────────────────── 本地缓存 ───────────────────────── */

#[tauri::command]
pub async fn cache_clear(
    webview: tauri::Webview,
) -> Result<crate::cache::CacheClearReport, String> {
    crate::media::clear_caches();
    crate::cache::clear_web_cache(&webview).await
}

/* ───────────────────────── 吃瓜帖子互动 ───────────────────────── */

#[tauri::command]
pub async fn api_post_like(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/posts/{id}/like"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_post_collect(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/posts/{id}/collect"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_post_comments(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!("/api/posts/{id}/comments?page={page}&size={size}"))
        .await
}

/// 吃瓜分类：`/api/site/categories/post` 返回 data.items（name/route）。
#[tauri::command]
pub async fn api_post_categories(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/site/categories/post").await
}

/// 按分类取吃瓜帖：`/api/posts/category/{route}`；`sort=latest` 走最新排序。
#[tauri::command]
pub async fn api_post_category(
    state: State<'_, Api>,
    route: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(route.as_bytes()).collect();
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    state
        .get(&format!(
            "/api/posts/category/{encoded}?page={page}&size={size}{sort}"
        ))
        .await
}

/// 相关推荐：`/api/videos/{id}/related` 返回 data.items。
#[tauri::command]
pub async fn api_related(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/videos/{id}/related")).await
}

/// 关注流：`/api/videos/following`（需登录）。
#[tauri::command]
pub async fn api_following(
    state: State<'_, Api>,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .authed("GET", &format!("/api/videos/following?page={page}&size={size}"), None)
        .await
}

/// 用户主页：`/api/users/{id}`。
#[tauri::command]
pub async fn api_user(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/users/{id}")).await
}

/// 用户统计：`/api/users/{id}/stats`。
#[tauri::command]
pub async fn api_user_stats(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/users/{id}/stats")).await
}

/// 用户作品：`/api/videos/user/{id}`。
#[tauri::command]
pub async fn api_user_videos(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!("/api/videos/user/{id}?page={page}&size={size}"))
        .await
}
#[cfg(test)]
mod tests {
    use super::{is_newer, normalize_account, normalize_account_history, version_in};
    use serde_json::{json, Value};

    #[test]
    fn account_snapshot_accepts_direct_and_wrapped_profiles_without_credentials() {
        for value in [json!({"id": 7, "nickname": "fixture", "token": "not-for-ipc", "interactions": {"favorite_video_ids": [9]}}),
            json!({"user": {"id": 7, "nickname": "fixture"}, "token": "not-for-ipc", "interactions": {"favorite_video_ids": [9]}})] {
            let result = normalize_account(value, "https://example.com").unwrap();
            assert_eq!(result["user"]["id"], 7);
            assert_eq!(result["interactions"]["favorite_video_ids"], json!([9]));
            assert_eq!(result["origin"], "https://example.com");
            assert!(result.get("token").is_none());
            assert!(result["user"].get("token").is_none());
        }
        assert!(normalize_account(json!({"user": {"nickname": "invalid"}}), "https://example.com").is_err());
        assert!(normalize_account(json!({"id": 0}), "https://example.com").is_err());
    }

    #[test]
    fn account_history_preserves_row_identity_and_pagination_without_media_metadata() {
        let result = normalize_account_history(json!({"items": [
            {"id": 18, "video_id": 9, "last_ep": 3, "target_type": "video", "updated_at": "2026-11-15 10:00:00", "title": "fixture", "cover": "unused"},
            {"id": 19, "video_id": 10, "last_ep": 1, "target_type": "post"},
            {"id": 20, "last_ep": 1, "target_type": "video"}
        ], "pagination": {"page": 2, "pages": 3, "size": 2, "total": 5}})).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["id"], 18);
        assert_eq!(result["items"][0]["video_id"], 9);
        assert_eq!(result["items"][0]["last_ep"], 3);
        assert!(result["items"][0].get("cover").is_none());
        assert!(result["items"][0].get("title").is_none());
        assert_eq!(result["pagination"]["pages"], 3);
        assert!(normalize_account_history(json!({"items": []})).is_err());
    }

    #[test]
    fn frontend_cannot_bypass_url_policy_with_opener_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for permission in capability["permissions"].as_array().unwrap() {
            let name = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .unwrap();
            assert!(
                !name.starts_with("opener:"),
                "frontend opener command exposed: {name}"
            );
        }
    }

    #[test]
    fn external_links_are_urls_not_shell_commands() {
        for raw in [
            "https://example.com/|calc.exe",
            "https://example.com/?a=1&b=2",
            "https://example.com/%25PATH%25",
            "https://example.com/%VAR%",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_ok());
        }
        for raw in [
            "file:///etc/passwd",
            "mailto:user@example.com",
            "tel:123",
            "data:text/html,test",
            "javascript:alert(1)",
            "https://example.com/\0cmd",
            "https://user:password@example.com/",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_err());
        }
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("v1.0.2", "1.0.1"));
        assert!(is_newer("v1.1", "1.0.9"));
        assert!(is_newer("1.0.10", "1.0.9"));
        assert!(!is_newer("v1.0.1", "1.0.1"));
        assert!(!is_newer("v0.9.9", "1.0.1"));
        assert!(!is_newer("", "1.0.1"));
    }
    /// tag 不是纯版本号：`hgfix-1.2.1-r5` 整串拿去比会从第一位判负（`hgfix-1` 解析成 0），
    /// 结果就是「永远没有新版本」。所以先抠出 `x.y.z` 再比。
    #[test]
    fn reads_version_out_of_tag() {
        assert_eq!(version_in("hgfix-1.2.1-r5"), "1.2.1");
        assert_eq!(version_in("v1.2.0"), "1.2.0");
        assert_eq!(version_in("HGuoX 1.2.1+hg.1"), "1.2.1");
        assert_eq!(version_in("release-notes"), "");
        assert!(is_newer(&version_in("hgfix-1.2.2-r6"), "1.2.1+hg.1"));
        assert!(is_newer(&version_in("hgfix-1.10.0-r9"), "1.9.9+hg.1"));
        assert!(!is_newer(&version_in("hgfix-1.2.1-r5"), "1.2.1+hg.1"));
    }
}

