//! 线路健康：网络层「硬错误」的归因、失败计数、黑名单与可用线路记忆。
//!
//! 为什么单独一个模块：`lines.rs` 负责「有哪些候选」，`net.rs` 负责「怎么发请求」，
//! 而「这条线路是不是刚被网络层打断、要不要暂时别再选它」这件事两边都要读，
//! 放在任一边都会形成环依赖。这里只做状态，不发请求。
//!
//! 三条规则（对应 3.0.14 报告 A 节）：
//!   1. 只有**链路层**失败才算 origin 不可用：DNS 污染 / TLS 阻断 / 连接重置 /
//!      连接被拒 / 超时。HTTP 4xx/5xx 是站点在说话，不是线路断了，绝不能据此换线；
//!   2. 同一 origin 会话内失败 2 次后进黑名单，10 分钟 TTL，期间不再优先选它；
//!   3. 最近一次真正成功的 origin 落盘（下次启动优先用它），黑名单只在内存里 ——
//!      重启后网络环境可能已经变了，不该带着旧的坏印象启动。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 黑名单有效期（报告要求 10 分钟）。
const BLACKLIST_TTL: Duration = Duration::from_secs(10 * 60);
/// 同一 origin 连续失败多少次判死。
const FAIL_THRESHOLD: u32 = 2;
const HEALTH_FILE: &str = "line-health.json";

#[derive(Clone, Debug)]
struct Entry {
    fails: u32,
    /// 黑名单到期时间；None = 还没判死。
    until: Option<Instant>,
}

static STATE: RwLock<Option<HashMap<String, Entry>>> = RwLock::new(None);
static DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

fn with_state<R>(f: impl FnOnce(&mut HashMap<String, Entry>) -> R) -> R {
    let mut slot = match STATE.write() {
        Ok(slot) => slot,
        Err(poisoned) => poisoned.into_inner(),
    };
    f(slot.get_or_insert_with(HashMap::new))
}

fn health_path() -> Option<PathBuf> {
    DIR.read()
        .ok()
        .and_then(|dir| dir.as_ref().map(|dir| dir.join(HEALTH_FILE)))
}

pub fn bind(dir: &Path) {
    if let Ok(mut slot) = DIR.write() {
        *slot = Some(dir.to_path_buf());
    }
}

/// 链路层失败分类。返回 None 表示这是「站点在回答/我们自己的安全策略」，
/// 不是线路不可用。
///
/// 这里刻意不认 `HTTP xxx`、业务错误文案和策略拒绝：把 403 当成线路挂了会
/// 在账号没权限时满世界换线路，那是比「打不开」更难查的 bug。
pub fn fault_kind(message: &str) -> Option<&'static str> {
    let msg = message.trim();
    if msg.is_empty() || msg.starts_with("HTTP ") || msg == "401" || msg == "403" {
        return None;
    }
    // 我们自己的安全策略拒绝（内网地址、降级重定向、跨域凭据…）不是线路问题。
    if msg.contains("禁止") || msg.contains("只允许") || msg.contains("仅供游客") {
        return None;
    }
    let lower = msg.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle) || msg.contains(needle));
    if has(&["dns", "解析失败", "name or service not known", "no such host"]) {
        Some("dns")
    } else if has(&["tls", "ssl", "handshake", "certificate", "证书"]) {
        Some("tls")
    } else if has(&["reset", "eof", "broken pipe", "connection aborted", "连接被重置"]) {
        Some("reset")
    } else if has(&["refused", "拒绝连接"]) {
        Some("refused")
    } else if has(&["unreachable", "network is down", "网络不可达"]) {
        Some("unreachable")
    } else if has(&["timeout", "timed out", "超时"]) {
        Some("timeout")
    } else {
        None
    }
}

static SAVED: RwLock<Option<(String, Instant)>> = RwLock::new(None);

/// 记一次成功：清掉失败计数与黑名单，并把「上次可用线路」落盘。
pub fn note_success(origin: &str) {
    if origin.is_empty() {
        return;
    }
    with_state(|state| {
        state.remove(origin);
    });
    /* 每次成功都写盘没必要（首页一屏十几个请求）：同一 origin 一分钟内只写一次。 */
    let skip = SAVED
        .read()
        .ok()
        .and_then(|saved| saved.clone())
        .is_some_and(|(saved, at)| saved == origin && at.elapsed() < Duration::from_secs(60));
    if skip {
        return;
    }
    save_last_good(origin);
    if let Ok(mut slot) = SAVED.write() {
        *slot = Some((origin.to_string(), Instant::now()));
    }
}

/// 记一次失败；达到阈值进黑名单，返回本次判定出的错误类型。
pub fn note_failure(origin: &str, message: &str) -> Option<&'static str> {
    let kind = fault_kind(message)?;
    if origin.is_empty() {
        return Some(kind);
    }
    let now = Instant::now();
    with_state(|state| {
        let entry = state.entry(origin.to_string()).or_insert(Entry { fails: 0, until: None });
        entry.fails = entry.fails.saturating_add(1);
        if entry.fails >= FAIL_THRESHOLD {
            entry.until = Some(now + BLACKLIST_TTL);
        }
    });
    Some(kind)
}

/// 立即判死（自动换线时对「刚刚失败的那条」用）：不用等第二次。
pub fn penalize(origin: &str) {
    if origin.is_empty() {
        return;
    }
    let until = Instant::now() + BLACKLIST_TTL;
    with_state(|state| {
        let entry = state.entry(origin.to_string()).or_insert(Entry { fails: FAIL_THRESHOLD, until: Some(until) });
        entry.fails = entry.fails.max(FAIL_THRESHOLD);
        entry.until = Some(until);
    });
}

pub fn blacklisted(origin: &str) -> bool {
    let now = Instant::now();
    with_state(|state| match state.get(origin) {
        Some(entry) => entry.until.is_some_and(|until| now < until),
        None => false,
    })
}

fn save_last_good(origin: &str) {
    let Some(path) = health_path() else { return };
    let saved_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let body = json!({ "last_good": origin, "saved_at": saved_at }).to_string();
    let temp = path.with_extension("json.tmp");
    let _ = std::fs::write(&temp, body).and_then(|_| std::fs::rename(&temp, path));
}

/// 上次真正连通过、且仍然可信的 origin（磁盘记录，可能为空）。
pub fn last_good() -> Option<String> {
    let text = std::fs::read_to_string(health_path()?).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let origin = value.get("last_good").and_then(Value::as_str)?;
    crate::net::normalize_base(origin)
}

/// 诊断/日志快照：黑名单与失败计数（不含任何凭据或请求内容）。
pub fn snapshot() -> Value {
    let now = Instant::now();
    let blocked = with_state(|state| {
        state
            .iter()
            .filter(|(_, entry)| entry.until.is_some_and(|until| now < until))
            .map(|(origin, entry)| {
                json!({
                    "origin": origin,
                    "fails": entry.fails,
                    "ttl_left_s": entry.until.map(|until| until.saturating_duration_since(now).as_secs()).unwrap_or(0),
                })
            })
            .collect::<Vec<_>>()
    });
    json!({ "blacklist": blocked, "last_good": last_good() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_only_transport_level_failures() {
        for (message, kind) in [
            ("error sending request ← client error (Connect) ← dns error", "dns"),
            ("DNS 解析失败", "dns"),
            ("error sending request ← client error (SendRequest) ← tls handshake eof", "tls"),
            ("connection reset by peer (os error 104)", "reset"),
            ("tls handshake eof", "tls"),
            ("error sending request ← connection refused", "refused"),
            ("请求超时", "timeout"),
            ("operation timed out", "timeout"),
        ] {
            assert_eq!(fault_kind(message), Some(kind), "{message}");
        }
        for message in [
            "HTTP 403: forbidden",
            "HTTP 500: server error",
            "401",
            "403",
            "镜像线路仅供游客浏览；登录/注册请切换到固定线路",
            "禁止访问普通内网",
            "接口返回失败",
            "",
        ] {
            assert_eq!(fault_kind(message), None, "{message}");
        }
    }

    #[test]
    fn two_failures_blacklist_and_success_clears() {
        let origin = "https://bl.example";
        assert!(!blacklisted(origin));
        note_failure(origin, "tls handshake eof");
        assert!(!blacklisted(origin), "一次失败不该判死");
        note_failure(origin, "connection reset by peer");
        assert!(blacklisted(origin), "两次失败后进黑名单");

        note_success(origin);
        assert!(!blacklisted(origin), "成功一次就该解除");

        /* HTTP 错误不计数：四次 403 之后仍然可选 */
        for _ in 0..4 {
            note_failure(origin, "HTTP 403: forbidden");
        }
        assert!(!blacklisted(origin));
    }

    #[test]
    fn penalize_blocks_immediately() {
        let origin = "https://pen.example";
        penalize(origin);
        assert!(blacklisted(origin));
    }
}
