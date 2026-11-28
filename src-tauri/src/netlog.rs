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

/// 被墙 origin 写进拒绝表（3.0.21 A 节）。
pub fn deny_origin(origin: &str, reason: &str) {
    net(&deny_line(origin, reason));
}

/// 自动探活预算用尽（3.0.22）：`[net] probe budget exhausted n=10/10`。
///
/// 真机复测就看这一行：出现它说明这一轮冷启动的探测配额已经用光，后面的候选
/// **一条都不会再发**（不再有 22–39 条 probe 风暴）。3.0.22-b 起带上总数，
/// 一眼能看出上限是多少（旧日志里只有 `n=8`，改过上限之后就没法回溯了）。
pub fn probe_budget_exhausted(used: usize, total: usize) {
    net(&format!("[net] probe budget exhausted n={used}/{total}"));
}

/// 拒绝表命中、**这次根本没发请求**（真机复测就看这行：有它 = 这次没白等）。
pub fn skip_origin(origin: &str, reason: &str, age_s: u64) {
    net(&skip_line(origin, reason, age_s));
}

/// 首屏「首次连接」预算的实际生效值（3.0.22-b）：`[net] first budget=3000ms rtt=1462ms`。
///
/// 真机复测直接读这一行，不用再猜预算是多少：`rtt=0` 表示这一轮还没有成功样本
/// （此时取下限 3s）。
pub fn first_budget(ms: u64, rtt_ms: u64) {
    net(&format!("[net] first budget={ms}ms rtt={rtt_ms}ms"));
}

/// 这一轮探测真正发出去了几条：`[net] probe used=6/10`（3.0.22-b）。
pub fn probe_used(used: usize, total: usize) {
    net(&format!("[net] probe used={used}/{total}"));
}

/// 探测候选被「每族上限」砍掉时的汇总行：`[net] probe family=qxeylvrkf.cc keep=2 drop=6`。
///
/// 3.0.22 的 8 条预算曾被单一死族（8 个随机子域）一次吃光，可用族一条都没探测到；
/// 这行就是那次事故的直接指纹。
pub fn probe_family_capped(family: &str, keep: usize, drop: usize) {
    net(&format!(
        "[net] probe family={} keep={keep} drop={drop}",
        clean(family, "-")
    ));
}

fn host_of(origin: &str) -> String {
    origin
        .split("://")
        .nth(1)
        .unwrap_or(origin)
        .split('/')
        .next()
        .unwrap_or(origin)
        .to_string()
}

/// 主机名部分（`https://thu.x.cc/api/videos` → `thu.x.cc`）。
///
/// 线路的「域名族」判定要用它（`lines::family_of`），所以单独开放一个只读入口。
pub fn host_of_str(origin: &str) -> String {
    host_of(origin)
}

pub fn deny_line(origin: &str, reason: &str) -> String {
    format!("[net] deny origin={} reason={} ttl=24h", clean(&host_of(origin), "-"), clean(reason, "-"))
}

pub fn skip_line(origin: &str, reason: &str, age_s: u64) -> String {
    format!(
        "[net] skip origin={} reason={} age={age_s}s",
        clean(&host_of(origin), "-"),
        clean(reason, "-")
    )
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
