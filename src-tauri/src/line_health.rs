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
//!
//! 3.0.21 补第 4 条（内存黑名单**救不了冷启动**：它随进程重启清零，所以每次开机
//! 都先撞一遍被墙的 origin）：
//!   4. 「经过完整协议」的失败（TCP 已接通、TLS 握手被断 —— 真机在
//!      huangguoai.com:443 上是 ClientHello 后 0.18–0.23s 的 RST）写进**本地拒绝表**
//!      并落盘，24 小时过期；下次启动**直接跳过**，不再先撞。纯 DNS 污染不写
//!      （那可能只是临时），成功一次立刻把该 origin 从拒绝表删掉。

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
/// 本地拒绝表（3.0.21）：**落盘**、24 小时过期。和上面 10 分钟的内存黑名单是两件事：
/// 黑名单管「这一轮别优先选它」，拒绝表管「重启后别再白等它」。
const DENY_FILE: &str = "line-deny.json";
const DENY_TTL_SECS: u64 = 24 * 60 * 60;

#[derive(Clone, Debug)]
struct Entry {
    fails: u32,
    /// 黑名单到期时间；None = 还没判死。
    until: Option<Instant>,
}

static STATE: RwLock<Option<HashMap<String, Entry>>> = RwLock::new(None);

/// 最近一次换线尝试的候选明细（诊断报告里读，只在内存里留一份）。
static PROBE_LOG: RwLock<Vec<serde_json::Value>> = RwLock::new(Vec::new());

pub fn record_probe(rows: Vec<serde_json::Value>) {
    if let Ok(mut log) = PROBE_LOG.write() {
        *log = rows;
    }
}

pub fn probe_log() -> Vec<serde_json::Value> {
    PROBE_LOG.read().map(|log| log.clone()).unwrap_or_default()
}
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
    /* 换数据目录（测试/切账号）后，拒绝表与成功记录必须重新从盘里读，
       否则会把上一个目录的记忆带过来。 */
    if let Ok(mut slot) = DENY.write() {
        *slot = None;
    }
    if let Ok(mut slot) = SUCCEEDED.write() {
        *slot = None;
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
    } else if has(&["reset", "eof", "broken pipe", "connection aborted", "connection closed", "连接被重置"]) {
        Some("reset")
    } else if has(&["refused", "拒绝连接"]) {
        Some("refused")
    } else if has(&["unreachable", "no route to host", "network is down", "网络不可达"]) {
        Some("unreachable")
    } else if has(&["timeout", "timed out", "deadline", "超时"]) {
        Some("timeout")
    } else if has(&["connect error", "connection error", "sendrequest", "send request"]) {
        /* reqwest 在系统级 RST 上给的原文就是 `client error (Connect) ← tcp connect error
           ← deadline has elapsed`：既没有 "timeout" 也没有 "reset" 字样。
           真机首轮就是因为漏了这条，明明被拦却当成普通业务失败（不换线、甩英文）。 */
        Some("connect")
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
    /* 成功一次就从拒绝表删掉 + 记进「成功过」集合（冷启动超时压缩要用）。 */
    clear_deny(origin);
    if let Ok(mut slot) = SUCCEEDED.write() {
        if let Some(set) = slot.as_mut() {
            set.insert(origin.to_string());
        } else {
            *slot = Some(std::collections::HashSet::from([origin.to_string()]));
        }
    }
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

/* ── 本地拒绝表（3.0.21 A 节） ───────────────────────────────
 *
 * 真机事实（小米九 / Xiaomi_501_5G，2026-11-25）：huangguoai.com:443 是 **TLS 级 RST**
 * —— TCP 能连上，ClientHello 之后 0.18–0.23s 被断。每次冷启动都要先吞一个超时、
 * 再灌几十条探活才切到 .cc 镜像，7 次冷启动里 2 次 35 秒没内容。
 *
 * 内存黑名单救不了这件事：它随进程重启清零。所以这里单开一张**落盘**的表，
 * 只记「TCP 通了、TLS 握手被断」这种经过完整协议的失败（纯 DNS 污染可能是临时的，
 * 不写表），24 小时过期，命中就直接跳过、连探活都不发。
 */

/// origin → 判死时刻（unix 秒）。懒加载自 [`DENY_FILE`]。
static DENY: RwLock<Option<HashMap<String, u64>>> = RwLock::new(None);
/// 本次进程里真的成功过的 origin。「已经成功过的 origin 不降超时」要用它：
/// 磁盘上的 last_good 只有一条，而一次冷启动里可能有两条线路先后成功过。
static SUCCEEDED: RwLock<Option<std::collections::HashSet<String>>> = RwLock::new(None);
/// 拒绝表文件路径。
fn deny_path() -> Option<PathBuf> {
    DIR.read()
        .ok()
        .and_then(|dir| dir.as_ref().map(|dir| dir.join(DENY_FILE)))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// 读拒绝表（丢掉过期条目）。文件坏了就当空的：拒绝表是优化，不该拖垮启动。
fn read_deny_file() -> HashMap<String, u64> {
    let Some(path) = deny_path() else { return HashMap::new() };
    let Ok(text) = std::fs::read_to_string(&path) else { return HashMap::new() };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return HashMap::new() };
    let now = now_secs();
    value
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let origin = crate::net::normalize_base(item.get("origin").and_then(Value::as_str)?)?;
                    let at = item.get("at").and_then(Value::as_u64)?;
                    /* 时钟回拨（at 比现在还晚）也当成刚判死，别永久钉死一条线路 */
                    (now.saturating_sub(at) < DENY_TTL_SECS).then_some((origin, at))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn with_deny<R>(f: impl FnOnce(&mut HashMap<String, u64>) -> R) -> R {
    let mut slot = match DENY.write() {
        Ok(slot) => slot,
        Err(poisoned) => poisoned.into_inner(),
    };
    if slot.is_none() {
        *slot = Some(read_deny_file());
    }
    f(slot.get_or_insert_with(HashMap::new))
}

fn save_deny() {
    let Some(path) = deny_path() else { return };
    let items: Vec<Value> = with_deny(|table| {
        let now = now_secs();
        table.retain(|_, at| now.saturating_sub(*at) < DENY_TTL_SECS);
        table
            .iter()
            .map(|(origin, at)| json!({ "origin": origin, "at": at }))
            .collect()
    });
    let body = json!({ "items": items }).to_string();
    let temp = path.with_extension("json.tmp");
    let _ = std::fs::write(&temp, body).and_then(|_| std::fs::rename(&temp, path));
}

/// 拒绝表命中时返回「判死了多久」（秒）；没命中返回 None。
pub fn blocked_age(origin: &str) -> Option<u64> {
    let origin = crate::net::normalize_base(origin)?;
    with_deny(|table| {
        table.get(&origin).and_then(|at| {
            let age = now_secs().saturating_sub(*at);
            (age < DENY_TTL_SECS).then_some(age)
        })
    })
}

pub fn blocked(origin: &str) -> bool {
    blocked_age(origin).is_some()
}

/// 写拒绝表 + 落盘 + 打一行 logcat（真机复测就是用这行确认「这次没白等」）。
pub fn deny(origin: &str, reason: &str) {
    let Some(origin) = crate::net::normalize_base(origin) else { return };
    let at = now_secs();
    let already = with_deny(|table| {
        let previous = table.insert(origin.clone(), at);
        previous.is_some()
    });
    save_deny();
    /* 第一次写才打日志：同一条线路每次失败都打会刷屏 */
    if !already {
        crate::netlog::deny_origin(&origin, reason);
    }
}

/// 成功一次就把该 origin 从拒绝表删掉：拒绝表只是「别先撞」的优化，
/// 一旦证明它是通的，必须立刻恢复它（否则会白丢一条可用线路整整 24 小时）。
fn clear_deny(origin: &str) {
    let Some(origin) = crate::net::normalize_base(origin) else { return };
    let removed = with_deny(|table| table.remove(&origin).is_some());
    if removed {
        save_deny();
    }
}

/// 这个 origin 有没有成功过（本次进程 / 磁盘上的 last_good）。
/// 冷启动把首枪预算压到 1.5s 时，**只压没成功过的**（成功过的不降超时）。
pub fn ever_succeeded(origin: &str) -> bool {
    let Some(origin) = crate::net::normalize_base(origin) else { return false };
    let session = SUCCEEDED
        .read()
        .ok()
        .and_then(|set| set.as_ref().map(|set| set.contains(&origin)))
        .unwrap_or(false);
    session || last_good().as_deref().is_some_and(|last| last == origin)
}

/// 「经过完整协议」的失败：TCP 已接通、TLS 握手被断。
///
/// 纯 DNS 污染、连接超时、连接被拒都**不算** —— 它们可能只是临时抖动（尤其 DNS
/// 在移动网络里一分钟能变三次），拿它们写 24 小时的拒绝表会把线路白丢一天。
pub fn complete_protocol_failure(message: &str) -> bool {
    match fault_kind(message) {
        Some("tls") => true,
        /* SendRequest 阶段的 reset 说明 TCP 已经通了（握手之后才断）；
           Connect 阶段的 reset / 纯 timeout 不算 */
        Some("reset") => {
            let lower = message.to_ascii_lowercase();
            lower.contains("sendrequest")
                || lower.contains("before message completed")
                || lower.contains("handshake")
        }
        _ => false,
    }
}

/// 失败样本收口：内存黑名单 + 拒绝表，一处判定。
///
/// 调用方（`net.rs` 的 `edge_inner`）已经拿到 `fault_kind` 的结论；这里再加一层
/// 「是不是完整协议失败」的判断，决定要不要写拒绝表。
pub fn note_transport_failure(origin: &str, message: &str) -> Option<&'static str> {
    let kind = note_failure(origin, message)?;
    if complete_protocol_failure(message) {
        deny(origin, kind);
    }
    Some(kind)
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

/// 上次成功线路的「新鲜期」（3.0.20）：24 小时内成功过，冷启动就直接用它当头号候选，
/// 连主域都不探（被墙网络里每次先撞主域是最贵的浪费）。超过 24 小时只当普通候选，
/// 优先级降到发布页镜像之后 —— 网络环境可能早就变了。
pub const LAST_GOOD_FRESH: Duration = Duration::from_secs(24 * 60 * 60);

/// 上次成功线路 + 距那次成功过了多久（磁盘记录，可能为空）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastGood {
    pub origin: String,
    pub age: Duration,
}

impl LastGood {
    /// 24 小时内成功过：可以跳过探活直接沿用。
    pub fn fresh(&self) -> bool {
        self.age < LAST_GOOD_FRESH
    }
}

pub fn last_good_info() -> Option<LastGood> {
    let text = std::fs::read_to_string(health_path()?).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let origin = crate::net::normalize_base(value.get("last_good").and_then(Value::as_str)?)?;
    let saved_at = value.get("saved_at").and_then(Value::as_u64).unwrap_or(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    Some(LastGood {
        origin,
        age: Duration::from_secs(now.saturating_sub(saved_at)),
    })
}

/// 上次真正连通过、且仍然可信的 origin（磁盘记录，可能为空）。
pub fn last_good() -> Option<String> {
    last_good_info().map(|last| last.origin)
}

/// 测试用全局互斥：`bind()` 改的是进程级状态，多线程跑用例时必须串行。
#[cfg(test)]
pub fn test_state_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 诊断/日志快照：黑名单 + 本地拒绝表与失败计数（不含任何凭据或请求内容）。
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
    let denied = with_deny(|table| {
        table
            .iter()
            .map(|(origin, at)| json!({ "origin": origin, "age_s": now_secs().saturating_sub(*at) }))
            .collect::<Vec<_>>()
    });
    json!({ "blacklist": blocked, "deny": denied, "last_good": last_good(), "last_good_age_s": last_good_info().map(|last| last.age.as_secs()) })
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
            /* 小米九真机原文（2026-11-25）：系统 DNS 指到死地址时就是这个链条 */
            ("error sending request for url (https://pku.zekpkeusp.cc/api/edge/request) ← client error (Connect) ← tcp connect error ← deadline has elapsed", "timeout"),
            ("error sending request for url (https://x/api/edge/request) ← client error (Connect) ← tcp connect error", "connect"),
            ("error sending request for url (https://x/) ← client error (SendRequest) ← connection closed before message completed", "reset"),
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
        /* note_success 会落盘 last_good，必须和别的「用临时目录」的用例串行 */
        let _guard = disk_guard();
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
        let _guard = disk_guard();
        let origin = "https://pen.example";
        penalize(origin);
        assert!(blacklisted(origin));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hguox-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `bind()` 改的是进程级全局目录，而 cargo test 默认多线程跑 ——
    /// 所有碰线路健康状态的用例必须串行，否则会互相把对方的数据目录换掉。
    fn disk_guard() -> std::sync::MutexGuard<'static, ()> {
        super::test_state_lock()
    }

    /// 3.0.21 A1：只有「TCP 通了、TLS 握手被断」才写拒绝表；
    /// 纯 DNS 污染 / 连接超时 / 连接被拒都不写（那可能只是临时）。
    #[test]
    fn only_complete_protocol_failures_enter_the_deny_table() {
        for message in [
            "error sending request ← client error (SendRequest) ← tls handshake eof",
            "tls handshake eof",
            "error sending request for url (https://x/) ← client error (SendRequest) ← connection closed before message completed",
        ] {
            assert!(complete_protocol_failure(message), "应当写拒绝表：{message}");
        }
        for message in [
            "error sending request ← client error (Connect) ← dns error",
            "DNS 解析失败",
            "error sending request ← client error (Connect) ← tcp connect error ← deadline has elapsed",
            "connection refused",
            "请求超时",
            "HTTP 403: forbidden",
            "connection reset by peer (os error 104)",
            "",
        ] {
            assert!(!complete_protocol_failure(message), "不该写拒绝表：{message}");
        }
    }

    #[test]
    fn deny_table_persists_for_24h_and_is_cleared_by_a_success() {
        let _guard = disk_guard();
        let dir = temp_dir("deny");
        bind(&dir);
        let origin = "https://huangguoai.com";

        assert!(!blocked(origin), "空表：不该命中");
        note_transport_failure(origin, "error sending request ← client error (SendRequest) ← tls handshake eof");
        assert!(blocked(origin), "TLS 被断一次就该写进拒绝表");
        assert_eq!(blocked_age(origin), Some(0), "刚判死，年龄 0 秒");

        /* 落盘：换目录再 bind 回来，等于「重启进程」 */
        let text = std::fs::read_to_string(dir.join(DENY_FILE)).expect("拒绝表要落盘");
        assert!(text.contains("huangguoai.com"), "{text}");
        bind(&dir);
        assert!(blocked(origin), "重启后仍然命中（这一条就是 3.0.21 要的「下次启动直接跳过」）");

        /* 超过 24h 的条目读回来就丢掉 */
        let stale_at = now_secs().saturating_sub(DENY_TTL_SECS + 60);
        std::fs::write(
            dir.join(DENY_FILE),
            json!({ "items": [{ "origin": origin, "at": stale_at }] }).to_string(),
        )
        .unwrap();
        bind(&dir);
        assert!(!blocked(origin), "过了 24 小时就不再跳过（网络可能已经变了）");

        /* 成功一次立刻解除：拒绝表只是「别先撞」，不是永久判决 */
        note_transport_failure(origin, "tls handshake eof");
        assert!(blocked(origin));
        note_success(origin);
        assert!(!blocked(origin), "成功一次必须把拒绝表里的这条删掉");
        assert!(ever_succeeded(origin), "成功过的 origin 进「成功过」集合（不降超时）");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// DNS 污染只进内存黑名单，不写 24 小时的拒绝表。
    #[test]
    fn dns_pollution_never_enters_the_deny_table() {
        let _guard = disk_guard();
        let dir = temp_dir("deny-dns");
        bind(&dir);
        let origin = "https://pku.example.cc";
        note_transport_failure(origin, "error sending request ← client error (Connect) ← dns error");
        assert!(!blocked(origin), "DNS 污染可能只是临时，不能写 24 小时拒绝表");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 3.0.20：冷启动只在 last_good「24h 内成功过」时才跳过探活；
    /// 超过一天就只当普通候选（`fresh()` 为假）。
    #[test]
    fn last_good_recency_decides_the_boot_fast_path() {
        let _guard = disk_guard();
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hguox-last-good-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        bind(&dir);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

        let write = |saved_at: u64| {
            std::fs::write(
                dir.join(HEALTH_FILE),
                json!({ "last_good": "https://huangguoai.com", "saved_at": saved_at }).to_string(),
            )
            .unwrap();
        };

        write(now - 60);
        let last = last_good_info().expect("刚成功过的一分钟前要能读回来");
        assert_eq!(last.origin, "https://huangguoai.com");
        assert!(last.fresh(), "1 分钟前成功过：冷启动直接沿用");

        write(now - 23 * 3600);
        assert!(last_good_info().expect("23 小时前").fresh(), "23 小时仍在新鲜期内");

        write(now - 25 * 3600);
        assert!(!last_good_info().expect("25 小时前").fresh(), "超过 24 小时降级为普通候选");

        std::fs::remove_dir_all(&dir).ok();
    }
}
