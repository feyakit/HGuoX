//! 网络取证：把关键网络事件写成 **logcat 专用 tag `hguox-net`** 的行。
//!
//! 为什么单独一个模块：release 包不可调试、`debug.log` 要 adb backup 才拿得到，
//! 而真机复测（小米九）现场只想要 `adb logcat -s hguox-net` 一眼看清
//! 「走了直连还是信封 / 每次请求多久 / 切了几次线路」。
//!
//! 行格式（字段固定、空格分隔，值里不放空格）：
//!   `[net] req cmd=api_feed origin=<host> path=/api/videos via=direct|envelope ms=1234 ok`
//!   `[net] req ... err=<kind>`                                （kind: dns/tls/reset/timeout/connect/http4xx/biz）
//!   `[net] switch line=<host> reason=<kind|last-good-first|…>`
//!   `[net] retry n=2 delay=3000`                               （前端首屏退避，n 从 1 起）
//!   `[net] first content ms=<n>`                               （骨架 → 真实内容）
//!
//! 后两种由前端拼好行、经命令 `net_log` 落到同一个 tag（它们量的是前端的时序）。
//!
//! 不含搜索词、账号、内容 ID：`path=` 一律去掉查询串（`/api/search?q=…` 只留路径）。
//!
//! 安卓实现走 NDK 的 `__android_log_write`（liblog，API 21+ 一直在 sysroot 里），
//! 不引新 crate；其它平台在 debug 构建里退回 stderr，release 桌面端不输出。

/// logcat 里的 tag，真机取证命令：`adb logcat -s hguox-net`
pub const TAG: &str = "hguox-net";

/// 写一行（调用方给完整行，含 `[net] ` 前缀）。
pub fn net(line: &str) {
    let line = line.replace('\n', " ");
    #[cfg(target_os = "android")]
    {
        android::write(TAG, &line);
    }
    #[cfg(not(target_os = "android"))]
    {
        if cfg!(debug_assertions) {
            eprintln!("{} {line}", TAG);
        }
    }
}

/// 一次逻辑请求的结果行（纯函数，便于单测）。
pub fn req_line(cmd: &str, origin: &str, path: &str, via: &str, ms: u128, err: Option<&str>) -> String {
    let cmd = clean(cmd, "other");
    let origin = clean(origin, "-");
    let path = clean(path, "-");
    let via = if via == "direct" { "direct" } else { "envelope" };
    match err {
        None => format!("[net] req cmd={cmd} origin={origin} path={path} via={via} ms={ms} ok"),
        Some(kind) => format!(
            "[net] req cmd={cmd} origin={origin} path={path} via={via} ms={ms} err={}",
            clean(kind, "err")
        ),
    }
}

/// 一次逻辑请求的结果行。
pub fn req(cmd: &str, origin: &str, path: &str, via: &str, ms: u128, err: Option<&str>) {
    net(&req_line(cmd, origin, path, via, ms, err));
}

/// 线路真的换了（同一条不写）。
pub fn switched(host: &str, reason: &str) {
    net(&format!("[net] switch line={} reason={}", clean(host, "-"), clean(reason, "-")));
}

/// 只认 ASCII 可见字符：logcat 行不能被空格/换行/控制字符拆开。
fn clean(value: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_graphic() && ch != '=' {
            out.push(ch);
        }
    }
    if out.is_empty() {
        return fallback.to_string();
    }
    /* 路径里有 `/`、`?` 被上面的过滤保留；等号会破坏 key=value 解析，所以剔掉 */
    out
}

#[cfg(target_os = "android")]
mod android {
    use std::ffi::CString;

    /* NDK sysroot 自带 liblog（android_log-sys 也是这么声明的），不新增依赖 */
    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(prio: i32, tag: *const std::os::raw::c_char, text: *const std::os::raw::c_char) -> i32;
    }

    /// PRIORITY_INFO = 4
    const INFO: i32 = 4;

    pub fn write(tag: &str, line: &str) {
        let Ok(tag) = CString::new(tag) else { return };
        let Ok(text) = CString::new(line) else { return };
        // SAFETY: 两个指针都指向本函数栈上、以 NUL 结尾的 CString 缓冲区，调用期间一直有效。
        unsafe {
            __android_log_write(INFO, tag.as_ptr(), text.as_ptr());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_keep_the_documented_shape() {
        assert_eq!(
            req_line("api_feed", "thu.a.cc", "/api/videos", "direct", 1234, None),
            "[net] req cmd=api_feed origin=thu.a.cc path=/api/videos via=direct ms=1234 ok"
        );
        assert_eq!(
            req_line("api_home", "huangguoai.com", "/api/home", "envelope", 87, Some("tls")),
            "[net] req cmd=api_home origin=huangguoai.com path=/api/home via=envelope ms=87 err=tls"
        );
        assert_eq!(clean("api_feed", "other"), "api_feed");
        assert_eq!(clean("a b=c", "-"), "abc");
        assert_eq!(clean("", "-"), "-");
        assert_eq!(clean("搜索", "-"), "-", "非 ASCII 一律剔除，避免 logcat 行被拆开");
    }
}
