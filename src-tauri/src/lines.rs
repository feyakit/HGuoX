//! Upstream lines and mirrors published by the upstream address pages.
//! Publisher scripts are parsed as data; remote JavaScript is never executed.

use dom_query::Document;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant};

pub const FIXED: [(&str, &str); 1] = [
    ("固定线路 1", "https://huangguoai.com"),
];
const PUBLISH_PAGES: [&str; 2] = [
    "https://huangguoai.pages.dev/",
    "https://huang-guo.pages.dev/",
];
/// 发布页域名本身，绝不能再拼子域当镜像用。
const PUBLISHER_HOSTS: [&str; 4] = [
    "huangguoai.pages.dev",
    "huang-guo.pages.dev",
    "huangguoai.com",
    "huangguoai.ai",
];
const MIRROR_MAX: usize = 60;
const PUBLISH_ARRAY_MAX: usize = 256;
const RECOMMENDED_MAX: usize = 20;
/// 国内实测：唯一可用的发布页 page+publish.js 耗时 2.1–7.2s（10 轮里 1 轮 >6s），
/// 6 秒预算会周期性把整份镜像列表判死，所以放到 12 秒。
const PAGE_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_PUBLISH_BYTES: usize = 512 * 1024;
const AUTO_PROBE_PATH: &str = "/api/videos?page=1&size=1";
/// 国内实测镜像探活 1.13–2.75s；3.0.14 真机再加一条：TLS 握手可能被概率性 RST，
/// 一次成功要 1.5–3s，所以预算放宽到 8 秒（内含最多 3 次尝试）。
const AUTO_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const AUTO_MIRROR_MAX: usize = 10;
const MIRROR_CACHE_TTL: Duration = Duration::from_secs(300);
const MAIN_HEAD_START: Duration = Duration::from_millis(1000);
const SETTLE_GRACE: Duration = Duration::from_millis(350);
/// 第一个发布页成功后，再给另一页这么久补齐列表（另一页常常是被污染的，别等它）。
const MIRROR_GRACE: Duration = Duration::from_millis(2000);
/// 发布页候选少于这个数就用内置种子补位（种子同样要真探活，不通不入选中）。
const SEED_MIN: usize = 3;
/// 内置兜底：已知可用族的前缀。上游换族会失效，所以只当「发布页拉不到」时的最后一道兜底，
/// 且**不授予凭据信任**（不进 `TRUSTED_MIRRORS`）。
/// 3.0.14：`huang-guo.pages.dev/publish.js` 现在给的是 `aqkmowihz.cc` / `xxslfswu.cc`
/// 两族（子域是 19 所高校前缀随机拼）。旧族 dvygahpw/zuxszoix 已经探不通，
/// 保留两条旧族当「上游又换回来」的兜底，但新族排在前面。
const SEED_MIRRORS: [&str; 8] = [
    "https://thu.aqkmowihz.cc",
    "https://pku.aqkmowihz.cc",
    "https://zju.aqkmowihz.cc",
    "https://thu.xxslfswu.cc",
    "https://pku.xxslfswu.cc",
    "https://thu.dvygahpw.cc",
    "https://pku.dvygahpw.cc",
    "https://thu.zuxszoix.cc",
];
const MIRROR_CACHE_FILE: &str = "lines-cache.json";

/// Only origins actually parsed from a trusted publisher can enter this set.
/// Loading line.json, displaying the current line and probing a host never add trust.
static TRUSTED_MIRRORS: RwLock<Vec<String>> = RwLock::new(Vec::new());
/// 落盘缓存里的 origin：只允许「自动切线切过去（游客浏览）」，**不授予**登录凭据信任。
static CACHED_MIRRORS: RwLock<Vec<String>> = RwLock::new(Vec::new());
static MIRRORS_CACHE: RwLock<Option<(Instant, Value)>> = RwLock::new(None);
/// 应用数据目录，由 [`bind`] 在启动时绑定；落盘列表写这里。
static CACHE_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn bind(dir: &Path) {
    if let Ok(mut slot) = CACHE_DIR.write() {
        *slot = Some(dir.to_path_buf());
    }
}

fn cache_path() -> Option<PathBuf> {
    CACHE_DIR
        .read()
        .ok()
        .and_then(|dir| dir.as_ref().map(|dir| dir.join(MIRROR_CACHE_FILE)))
}

/// 把发布页解析出的列表落盘：下次发布页整晚拉不到时，仍有候选可探活。
fn save_mirrors_cache(items: &[Value]) {
    let Some(path) = cache_path() else { return };
    let saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    if let Ok(text) = serde_json::to_string(&json!({ "saved_at": saved_at, "items": items })) {
        let _ = std::fs::write(path, text);
    }
}

/// 读回上一次成功的列表，标记 `stale`。**不调用 [`remember_published`]**：
/// 磁盘上的东西不是发布页说的，不能给登录凭据信任。
fn load_mirrors_cache() -> Option<Value> {
    let text = std::fs::read_to_string(cache_path()?).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let items: Vec<Value> = value
        .get("items")?
        .as_array()?
        .iter()
        .filter(|item| {
            item.get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| crate::net::normalize_base(url).is_some())
        })
        .take(MIRROR_MAX)
        .cloned()
        .collect();
    if items.is_empty() {
        return None;
    }
    let recommended = items.iter().take(RECOMMENDED_MAX).cloned().collect::<Vec<_>>();
    remember_cached(&items);
    Some(json!({
        "source": "cache",
        "script": "",
        "items": items,
        "recommended_source": "cache",
        "recommended": recommended,
        "errors": [],
        "stale": true,
        "saved_at": value.get("saved_at").and_then(Value::as_u64).unwrap_or(0),
    }))
}

fn remember_published(items: &[Value]) {
    let mut known = TRUSTED_MIRRORS
        .write()
        .unwrap_or_else(|error| error.into_inner());
    for origin in items
        .iter()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
    {
        if !known.iter().any(|value| value == origin) {
            if known.len() >= 256 {
                known.remove(0);
            }
            known.push(origin.to_owned());
        }
    }
}

pub fn is_trusted_mirror(origin: &str) -> bool {
    TRUSTED_MIRRORS
        .read()
        .map(|known| known.iter().any(|value| value == origin))
        .unwrap_or(false)
}

/// 落盘缓存里的 origin：可以自动切过去（游客浏览），但登录凭据信任仍只看
/// [`is_trusted_mirror`] / 固定线路 / 用户自定义线路。
pub fn is_cached_mirror(origin: &str) -> bool {
    CACHED_MIRRORS
        .read()
        .map(|known| known.iter().any(|value| value == origin))
        .unwrap_or(false)
}

fn remember_cached(items: &[Value]) {
    let mut known = CACHED_MIRRORS
        .write()
        .unwrap_or_else(|error| error.into_inner());
    known.clear();
    for origin in items
        .iter()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
    {
        if known.len() >= 256 {
            break;
        }
        if !known.iter().any(|value| value == origin) {
            known.push(origin.to_owned());
        }
    }
}

pub fn fixed() -> Value {
    json!(FIXED
        .iter()
        .map(|(name, url)| json!({ "name": name, "url": url }))
        .collect::<Vec<_>>())
}

pub fn is_fixed(url: &str) -> bool {
    FIXED.iter().any(|(_, known)| *known == url)
}

struct PublishedPage {
    source: String,
    script: String,
    items: Vec<Value>,
}

/// Independent concurrent deadlines preserve either publisher's successful list.
///
/// 先到先用：任一页成功即可出列表，另一页只再等 [`MIRROR_GRACE`]。
/// 国内实测 `huangguoai.pages.dev` 被 DNS 污染（解析到 Facebook 段）会一直挂到超时，
/// 旧实现 `join` 死等两页，成功也要白等一整份 `PAGE_TIMEOUT`。
/// 两页都失败时退回磁盘上最后一次成功的列表（标 `stale`），不让自动选线变成零候选。
pub async fn mirrors() -> Result<Value, String> {
    let mut result = match publish_lists().await {
        Ok(value) => value,
        Err(error) => match load_mirrors_cache() {
            Some(mut cached) => {
                cached["errors"] = json!([error]);
                cached
            }
            None => return Err(error),
        },
    };
    let stale = result.get("stale").and_then(Value::as_bool) == Some(true);
    if let Some(items) = result.get("items").and_then(Value::as_array) {
        if !stale {
            // 只有真从发布页解析出来的 origin 才进信任集合。
            remember_published(items);
            save_mirrors_cache(items);
        }
    }
    result["stale"] = json!(stale);
    // 落盘兜底的结果不进内存缓存：发布页一恢复就立刻重试，别被 5 分钟 TTL 拖住。
    if !stale {
        if let Ok(mut cache) = MIRRORS_CACHE.write() {
            *cache = Some((Instant::now(), result.clone()));
        }
    }
    Ok(result)
}

/// 两个发布页并发拉取，第一个成功后再给另一页 `MIRROR_GRACE` 补齐。
async fn publish_lists() -> Result<Value, String> {
    let first = mirrors_from_page(PUBLISH_PAGES[0]);
    let second = mirrors_from_page(PUBLISH_PAGES[1]);
    tokio::pin!(first, second);
    let mut done: [Option<Result<PublishedPage, String>>; 2] = [None, None];
    let mut grace: Option<tokio::time::Instant> = None;
    while done[0].is_none() || done[1].is_none() {
        let deadline =
            grace.unwrap_or_else(|| tokio::time::Instant::now() + PAGE_TIMEOUT + Duration::from_secs(1));
        tokio::select! {
            result = &mut first, if done[0].is_none() => done[0] = Some(result),
            result = &mut second, if done[1].is_none() => done[1] = Some(result),
            _ = tokio::time::sleep_until(deadline) => break,
        }
        if grace.is_none() && done.iter().flatten().any(|result| result.is_ok()) {
            grace = Some(tokio::time::Instant::now() + MIRROR_GRACE);
        }
    }
    fn missing() -> Result<PublishedPage, String> {
        Err("地址发布页未返回".to_owned())
    }
    let [first, second] = done;
    merge_publishers(
        [first.unwrap_or_else(missing), second.unwrap_or_else(missing)],
        &crate::net::base(),
    )
}

/// Auto-pick uses a short-lived in-memory cache so repeated failovers avoid
/// re-fetching the publish pages every time.
async fn mirrors_cached() -> Result<Value, String> {
    if let Ok(cache) = MIRRORS_CACHE.read() {
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < MIRROR_CACHE_TTL {
                return Ok(value.clone());
            }
        }
    }
    mirrors().await
}

fn merge_publishers(
    results: [Result<PublishedPage, String>; 2],
    current: &str,
) -> Result<Value, String> {
    let mut pages = Vec::new();
    let mut errors = Vec::new();
    for (index, result) in results.into_iter().enumerate() {
        match result {
            Ok(page) => pages.push(page),
            Err(error) => errors.push(format!("{}: {error}", PUBLISH_PAGES[index])),
        }
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    // Interleave lists so a full first page cannot hide the second publisher.
    for index in 0..MIRROR_MAX {
        for page in &pages {
            if let Some(item) = page.items.get(index) {
                if let Some(origin) = item.get("url").and_then(Value::as_str) {
                    if items.len() < MIRROR_MAX && seen.insert(origin.to_owned()) {
                        items.push(item.clone());
                    }
                }
            }
        }
    }
    if items.is_empty() {
        return Err(if errors.is_empty() {
            "地址发布页里没有可用的镜像地址".into()
        } else {
            errors.join("；")
        });
    }
    let mut recommended = Vec::new();
    let mut recommended_seen = HashSet::new();
    // The restored/rotated current line is display-only unless actually published.
    if let Some(origin) = crate::net::normalize_base(current) {
        if let Some(host) = url::Url::parse(&origin)
            .ok()
            .and_then(|value| value.host_str().map(str::to_owned))
        {
            recommended_seen.insert(origin.clone());
            recommended.push(json!({ "url": origin, "host": host }));
        }
    }
    for item in &items {
        if recommended.len() >= RECOMMENDED_MAX {
            break;
        }
        if let Some(origin) = item.get("url").and_then(Value::as_str) {
            if recommended_seen.insert(origin.to_owned()) {
                recommended.push(item.clone());
            }
        }
    }
    let sources: Vec<_> = pages.iter().map(|page| page.source.as_str()).collect();
    let scripts: Vec<_> = pages.iter().map(|page| page.script.as_str()).collect();
    Ok(
        json!({ "source": sources.join(", "), "script": scripts.join(", "), "items": items, "recommended_source": sources.join(", "), "recommended": recommended, "errors": errors }),
    )
}

async fn mirrors_from_page(page: &str) -> Result<PublishedPage, String> {
    // One deadline includes DNS, redirects, both bodies and parsing.
    tokio::time::timeout(PAGE_TIMEOUT, async {
        let html = get_text(page).await?;
        let script = script_src(page, &html)?;
        let js = get_text(&script).await?;
        let items = parse_mirrors(&js)?;
        Ok(PublishedPage {
            source: page.to_owned(),
            script,
            items,
        })
    })
    .await
    .map_err(|_| "获取地址发布页超时（12 秒）".to_owned())?
}

fn parse_mirrors(js: &str) -> Result<Vec<Value>, String> {
    let mut domains = js_array(js, "urls")?.unwrap_or_default();
    if domains.is_empty() {
        /* 发布脚本换写法（只给 `newestUrls` 里的完整 https://host，或整段没有 `urls` 数组）时，
           退回到「扫描所有字符串字面量里的域名」，别只认一种格式就把整份列表判死。
           仍然只做静态扫描，从不执行远端 JS。 */
        domains = scan_published_hosts(js)?;
    }
    let subs = js_array(js, "subdomains")?.unwrap_or_default();
    if domains.is_empty() {
        return Err("发布脚本中没有找到镜像域名".into());
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    'domains: for domain in domains {
        let domain = domain.trim().trim_end_matches('/').to_ascii_lowercase();
        if !valid_dns_name(&domain) || PUBLISHER_HOSTS.contains(&domain.as_str()) {
            continue;
        }
        // 已经是三级以上主机名时不再拼子域，避免 thu.thu.xxx.cc 这种废候选。
        let hosts: Vec<_> = if subs.is_empty() || domain.split('.').count() >= 3 {
            vec![domain]
        } else {
            subs.iter()
                .filter_map(|sub| {
                    let sub = sub.trim().to_ascii_lowercase();
                    valid_dns_label(&sub).then(|| format!("{sub}.{domain}"))
                })
                .collect()
        };
        for host in hosts {
            if !valid_dns_name(&host) || PUBLISHER_HOSTS.contains(&host.as_str()) || !seen.insert(host.clone()) {
                continue;
            }
            let Some(origin) = crate::net::normalize_base(&format!("https://{host}")) else {
                continue;
            };
            items.push(json!({ "url": origin, "host": host }));
            if items.len() >= MIRROR_MAX {
                break 'domains;
            }
        }
    }
    if items.is_empty() {
        Err("发布脚本中没有合法镜像地址".into())
    } else {
        Ok(items)
    }
}

/// 静态扫描发布脚本里的字符串字面量，挑出「裸域名」或「完整 https://host」。
/// 发布页域名本身（pages.dev / huangguoai.com / .ai）会被剔除，免得拼出子域垃圾。
fn scan_published_hosts(js: &str) -> Result<Vec<String>, String> {
    let mut hosts = Vec::new();
    let mut seen = HashSet::new();
    for token in js_tokens(js)? {
        let JsToken::Quoted(raw) = token else { continue };
        let Ok(value) = js_string(raw) else { continue };
        let value = value.trim();
        if value.is_empty() || value.contains('@') || value.chars().any(char::is_control) {
            continue;
        }
        // 只认两种写法：完整 `https?://host`，或发布页那种带尾斜杠的站根 `xxx.cc/`。
        // 裸 `bad.example` 这种太含糊（注释/字符串/函数体里到处都是），一律不认。
        let rest = if let Some(rest) = value
            .strip_prefix("https://")
            .or_else(|| value.strip_prefix("http://"))
        {
            rest.trim_end_matches('/')
        } else if let Some(rest) = value.strip_suffix('/') {
            rest
        } else {
            continue;
        };
        // 带路径、端口、查询的一律不要：只接受裸 origin。
        if rest.contains('/') || rest.contains(':') || rest.contains('?') || rest.contains('#') {
            continue;
        }
        let host = rest.to_ascii_lowercase();
        if !valid_dns_name(&host) || PUBLISHER_HOSTS.contains(&host.as_str()) {
            continue;
        }
        if seen.insert(host.clone()) {
            hosts.push(host);
        }
        if hosts.len() >= PUBLISH_ARRAY_MAX {
            break;
        }
    }
    Ok(hosts)
}

fn valid_dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
}

fn valid_dns_name(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(valid_dns_label)
        && !["localhost", "local", "internal", "home.arpa"]
            .iter()
            .any(|suffix| value == *suffix || value.ends_with(&format!(".{suffix}")))
        && url::Url::parse(&format!("https://{value}"))
            .ok()
            .is_some_and(|parsed| matches!(parsed.host(), Some(url::Host::Domain(_))))
}

/// Bounded decoded body; the publisher's outer deadline also covers a slow body.
async fn get_text(raw: &str) -> Result<String, String> {
    let target = url::Url::parse(raw).map_err(|_| "发布地址无效")?;
    // 发布页域名在国内会被 DNS 污染成公网 Facebook 段（不是 127.0.0.1，所以旧的
    // 「私网才回退 DoH」逻辑救不到），这里直接走加密 DoH 解析。
    let mut response = crate::net::get_public_dns(
        raw,
        PAGE_TIMEOUT,
        Some("text/html,application/javascript"),
        None,
    )
    .await?;
    // net::get checks DNS and redirects; publisher authority cannot cross origins.
    let final_url = response.url();
    if final_url.scheme() != "https"
        || final_url.origin() != target.origin()
        || (target.path().ends_with("/publish.js") && final_url.path() != target.path())
    {
        return Err("发布页或发布脚本跳转到了非可信地址".into());
    }
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PUBLISH_BYTES as u64)
    {
        return Err("地址发布页或脚本超过 512 KiB 限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| crate::net::err_text(&error))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_PUBLISH_BYTES {
            return Err("地址发布页或脚本超过 512 KiB 限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "地址发布页或脚本不是有效 UTF-8".into())
}

fn script_src(page: &str, html: &str) -> Result<String, String> {
    let document = Document::from(html);
    for script in document.select("script[src]").iter() {
        if let Some(src) = script.attr("src") {
            if let Ok(url) = absolute(page, &src) {
                return Ok(url);
            }
        }
    }
    Err("地址发布页没有同源 publish.js 脚本".into())
}

fn absolute(base: &str, relative: &str) -> Result<String, String> {
    if relative.chars().any(char::is_control) {
        return Err("发布脚本地址含控制字符".into());
    }
    let base = url::Url::parse(base).map_err(|_| "发布页地址无效")?;
    let target = base.join(relative.trim()).map_err(|_| "发布脚本地址无效")?;
    if base.scheme() != "https"
        || target.scheme() != "https"
        || target.origin() != base.origin()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
        || target.path().rsplit('/').next() != Some("publish.js")
    {
        return Err("只接受发布页同源的 HTTPS publish.js".into());
    }
    Ok(target.to_string())
}

/// Persisted lines gain credential trust only after a publisher confirms them.
/// Anonymous probes must not call this function.
pub async fn verify_published_origin(origin: &str) -> Result<(), String> {
    let origin = crate::net::normalize_base(origin).ok_or("线路必须是安全 HTTPS origin")?;
    if is_fixed(&origin) || is_trusted_mirror(&origin) {
        return Ok(());
    }
    // Concurrent startup requests share a refresh and briefly cache misses.
    type Refresh = Option<(Instant, Result<(), String>)>;
    static REFRESH: std::sync::OnceLock<tokio::sync::Mutex<Refresh>> = std::sync::OnceLock::new();
    tokio::time::timeout(PAGE_TIMEOUT + Duration::from_secs(1), async {
        let mut refresh = REFRESH
            .get_or_init(|| tokio::sync::Mutex::new(None))
            .lock()
            .await;
        if is_trusted_mirror(&origin) {
            return Ok(());
        }
        if let Some((_, result)) = refresh
            .as_ref()
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(30))
        {
            result.clone()?;
        } else {
            let result = mirrors().await.map(|_| ());
            *refresh = Some((Instant::now(), result.clone()));
            result?;
        }
        if is_trusted_mirror(&origin) {
            Ok(())
        } else {
            Err("当前镜像未被可信地址发布页收录；请重新选择线路后登录".into())
        }
    })
    .await
    .map_err(|_| "验证镜像发布来源超时".to_owned())?
}

#[derive(Debug, PartialEq)]
enum JsToken<'a> {
    Ident(&'a str),
    Quoted(&'a str),
    Symbol(u8),
    Other,
}

/// A conservative lexer: comments, strings, templates and regular expressions
/// cannot introduce declarations. No remote JavaScript is ever evaluated.
fn js_tokens(source: &str) -> Result<Vec<JsToken<'_>>, String> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte.is_ascii_whitespace() {
            at += 1;
            continue;
        }
        if bytes[at..].starts_with(b"//") {
            at += 2;
            while at < bytes.len() && bytes[at] != 10 {
                at += 1;
            }
            continue;
        }
        if bytes[at..].starts_with(b"/*") {
            at += 2;
            let Some(end) = source[at..].find("*/") else {
                return Err("发布脚本注释未闭合".into());
            };
            at += end + 2;
            continue;
        }
        if matches!(byte, 39 | 34 | 96) {
            let start = at;
            at += 1;
            while at < bytes.len() && bytes[at] != byte {
                if bytes[at] == 92 {
                    at += 1;
                }
                at += 1;
            }
            if at >= bytes.len() {
                return Err("发布脚本字符串未闭合".into());
            }
            at += 1;
            out.push(if byte == 96 {
                JsToken::Other
            } else {
                JsToken::Quoted(&source[start..at])
            });
            continue;
        }
        // Division is deliberately treated as a regex as well. Publisher data
        // requires no arithmetic; ambiguous input therefore fails closed.
        if byte == b'/' {
            at += 1;
            let mut in_class = false;
            while at < bytes.len() {
                match bytes[at] {
                    92 => {
                        at += 2;
                        continue;
                    }
                    b'[' => in_class = true,
                    b']' => in_class = false,
                    b'/' if !in_class => break,
                    10 | 13 => return Err("发布脚本包含不支持的表达式".into()),
                    _ => {}
                }
                at += 1;
            }
            if at >= bytes.len() {
                return Err("发布脚本表达式未闭合".into());
            }
            at += 1;
            while at < bytes.len() && bytes[at].is_ascii_alphabetic() {
                at += 1;
            }
            out.push(JsToken::Other);
            continue;
        }
        if byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$') {
            let start = at;
            at += 1;
            while at < bytes.len()
                && (bytes[at].is_ascii_alphanumeric() || matches!(bytes[at], b'_' | b'$'))
            {
                at += 1;
            }
            out.push(JsToken::Ident(&source[start..at]));
        } else {
            out.push(JsToken::Symbol(byte));
            at += 1;
        }
    }
    Ok(out)
}

fn js_string(raw: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut chars = raw[1..raw.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch != char::from(92) {
            if ch.is_control() {
                return Err("镜像字符串含控制字符".into());
            }
            result.push(ch);
            continue;
        }
        match chars.next() {
            Some(ch) if matches!(ch as u32, 92 | 39 | 34 | 47) => result.push(ch),
            Some('x') => {
                let code: String = chars.by_ref().take(2).collect();
                let byte = u8::from_str_radix(&code, 16)
                    .ok()
                    .filter(|_| code.len() == 2)
                    .ok_or("镜像字符串转义无效")?;
                result.push(char::from(byte));
            }
            Some('u') => {
                let code: String = chars.by_ref().take(4).collect();
                let number = u32::from_str_radix(&code, 16)
                    .ok()
                    .filter(|_| code.len() == 4)
                    .ok_or("镜像字符串转义无效")?;
                result.push(char::from_u32(number).ok_or("镜像字符串转义无效")?);
            }
            _ => return Err("镜像字符串含不支持的转义".into()),
        }
    }
    Ok(result)
}

/// Only literal top-level var/let/const arrays are accepted. Malformed
/// subdomains must not fall back to trusting the bare domains.
fn js_array(source: &str, name: &str) -> Result<Option<Vec<String>>, String> {
    let tokens = js_tokens(source)?;
    let mut depth = 0usize;
    let mut result = None;
    for (at, token) in tokens.iter().enumerate() {
        let declaration = matches!(token, JsToken::Ident("var" | "let" | "const"));
        if depth == 0 && declaration && tokens.get(at + 1) == Some(&JsToken::Ident(name)) {
            if result.is_some() {
                return Err(format!("发布脚本重复声明 {name}"));
            }
            if tokens.get(at + 2) != Some(&JsToken::Symbol(b'='))
                || tokens.get(at + 3) != Some(&JsToken::Symbol(b'['))
            {
                return Err(format!("发布脚本的 {name} 必须是字符串数组"));
            }
            let mut cursor = at + 4;
            let mut values = Vec::new();
            while tokens.get(cursor) != Some(&JsToken::Symbol(b']')) {
                let Some(JsToken::Quoted(raw)) = tokens.get(cursor) else {
                    return Err(format!("发布脚本的 {name} 含非字符串值"));
                };
                if values.len() >= PUBLISH_ARRAY_MAX {
                    return Err(format!("{name} exceeds the publisher array size limit"));
                }
                values.push(js_string(raw)?);
                cursor += 1;
                match tokens.get(cursor) {
                    Some(JsToken::Symbol(b',')) => cursor += 1,
                    Some(JsToken::Symbol(b']')) => {}
                    _ => return Err(format!("发布脚本的 {name} 数组格式无效")),
                }
            }
            if !matches!(tokens.get(cursor + 1), None | Some(JsToken::Symbol(b';'))) {
                return Err(format!("发布脚本的 {name} 不能使用动态表达式"));
            }
            result = Some(values);
        }
        match token {
            JsToken::Symbol(b'{' | b'(' | b'[') => depth += 1,
            JsToken::Symbol(b'}' | b')' | b']') => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(result)
}

/// Validate the unwrapped /api/videos data, rather than HTML or status alone.
pub(crate) fn healthy_video_data(data: &Value) -> bool {
    let Some(items) = data.get("items").and_then(Value::as_array) else {
        return false;
    };
    let Some(pagination) = data.get("pagination").and_then(Value::as_object) else {
        return false;
    };
    let integer = |key: &str| pagination.get(key).and_then(Value::as_u64);
    if integer("page").is_none_or(|n| n == 0)
        || integer("size").is_none_or(|n| n == 0)
        || integer("pages").is_none()
        || integer("total").is_none()
    {
        return false;
    }
    // These two fields are stable feed identity, unlike optional cover/score.
    items.iter().all(|item| {
        item.get("id")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0)
            && item
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|title| !title.trim().is_empty())
    })
}

#[derive(Clone)]
pub struct Hit {
    pub tier: &'static str,
    pub url: String,
    pub ok: bool,
    pub reachable: bool,
    pub ms: u64,
    pub status: Option<u16>,
    error: Option<String>,
}

impl Hit {
    fn json(&self) -> Value {
        let mut value = json!({ "tier": self.tier, "url": self.url, "ok": self.ok,
            "reachable": self.reachable, "ms": self.ms, "status": self.status });
        if let Some(error) = &self.error {
            value["error"] = json!(error);
        }
        value
    }
}

async fn probe_hit(tier: &'static str, raw: &str) -> Hit {
    probe_hit_with(tier, raw, AUTO_PROBE_TIMEOUT).await
}

/// 同 [`probe_hit`]，超时可调：硬错误后的紧急换线只给 4 秒，
/// 不能让一条被墙的镜像把首屏拖到 5 秒以上。
async fn probe_hit_with(tier: &'static str, raw: &str, timeout: Duration) -> Hit {
    let mut hit = Hit {
        tier,
        url: raw.to_owned(),
        ok: false,
        reachable: false,
        ms: 0,
        status: None,
        error: None,
    };
    let Some(origin) = crate::net::normalize_base(raw) else {
        hit.error = Some("线路必须是安全 HTTPS origin".into());
        return hit;
    };
    hit.url = origin.clone();
    let started = Instant::now();
    /* 3.0.14 真机结论：这类网络对 TLS 握手是**概率性**阻断 —— 同一域名同一条线路
       一次 curl 三分之一的尝试 TLS 能过（实测 3 次里 1 次 200）。探活只打一枪的话，
       一条其实能用的镜像会被判死，用户看到的就是「线路全部不可用」。
       所以探活在总预算内重试到成功（或预算用尽），不再单发一次定生死。 */
    let deadline = started + timeout;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            hit.error.get_or_insert_with(|| format!("视频接口探测超时（{} 秒）", timeout.as_secs()));
            break;
        }
        match tokio::time::timeout(
            remaining,
            crate::net::edge_once(&origin, "GET", AUTO_PROBE_PATH, None, None),
        )
        .await
        {
            Ok(Ok(data)) => {
                hit.reachable = true;
                hit.status = Some(200);
                hit.ok = healthy_video_data(&data);
                if !hit.ok {
                    hit.error = Some("接口未返回有效视频列表数据".into());
                }
                break;
            }
            Ok(Err(error)) => {
                hit.error = Some(error);
                /* 只有链路层失败值得再试；403/401/业务错误重试没意义 */
                if crate::line_health::fault_kind(hit.error.as_deref().unwrap_or("")).is_none() {
                    break;
                }
            }
            Err(_) => {
                hit.error = Some(format!("视频接口探测超时（{} 秒）", timeout.as_secs()));
            }
        }
        if attempt >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    hit.ms = started.elapsed().as_millis() as u64;
    hit
}

/// Manual checks retain their JSON API and never change trust or active line.
pub async fn probe(urls: Vec<String>) -> Value {
    let mut out = Vec::new();
    for chunk in urls[..urls.len().min(MIRROR_MAX)].chunks(6) {
        let mut handles = Vec::new();
        for origin in chunk {
            let origin = origin.clone();
            handles.push(tokio::spawn(
                async move { probe_hit("mirror", &origin).await },
            ));
        }
        for handle in handles {
            if let Ok(hit) = handle.await {
                out.push(hit.json());
            }
        }
    }
    json!(out)
}

/// A display recommendation is not proof of publication. Candidates are built
/// exclusively from the published items; the .ai landing page is never automatic.
fn auto_candidates(items: &[Value], current: &str, trusted: impl Fn(&str) -> bool) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let current = crate::net::normalize_base(current);
    let published: Vec<_> = items
        .iter()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
        .filter_map(crate::net::normalize_base)
        .filter(|origin| !is_fixed(origin) && trusted(origin))
        .collect();
    // Preserve an actually published current line as a candidate, even with a
    // large published list. A line restored only from disk never qualifies.
    if let Some(origin) = current.filter(|origin| published.contains(origin)) {
        seen.insert(origin.clone());
        candidates.push(origin);
    }
    for origin in published {
        if candidates.len() >= AUTO_MIRROR_MAX {
            break;
        }
        if seen.insert(origin.clone()) {
            candidates.push(origin);
        }
    }
    candidates
}

fn pick_from_hits(hits: &[Hit]) -> Value {
    /* 自定义线路只在「别的线路都不通」时才算赢家：它可能有自己的登录体系，
       自动切过去会清会话（见 api::line_auto 的 rebase 规则），交给用户手动选更稳。
       内置种子排在有发布页背书的镜像之后、自定义线路之前。
       `(tier=="custom", tier=="seed", ms)` 让非自定义线路永远排在前面，同 tier 内仍按延迟取最快。 */
    let winner = hits
        .iter()
        .filter(|hit| hit.ok)
        .min_by_key(|hit| (hit.tier == "custom", hit.tier == "seed", hit.ms));
    let candidates: Vec<_> = hits.iter().map(Hit::json).collect();
    match winner {
        Some(hit) => json!({ "base": hit.url, "tier": hit.tier, "ms": hit.ms,
            "reason": match hit.tier { "main" => "main-ok", "custom" => "custom-ok", "seed" => "seed-ok", _ => "mirror-ok" }, "candidates": candidates }),
        None => {
            json!({ "base": "", "tier": "none", "ms": 0, "reason": "all-down", "candidates": candidates })
        }
    }
}

/// 用户显式保存的自定义线路（设置页「自定义线路」→ `line_custom_set`）。
///
/// 它不是发布页出来的，`is_trusted_mirror` 永远为 false，所以以前**压根不参与探活**：
/// 主站和发布页镜像同时不通时，哪怕自定义镜像明明可用，也会被判成 all-down、
/// 弹「线路全部不可用」（v3.0.5 报告第五节）。这里只把它加进**探活候选**
/// （tier = "custom"），不授予任何凭据信任 —— 凭据信任仍只看
/// `net::trusted_auth_origin`。
fn custom_candidate(current: &str) -> Option<String> {
    if !crate::net::is_custom_line() {
        return None;
    }
    let origin = crate::net::normalize_base(current)?;
    if is_fixed(&origin) {
        return None;
    }
    Some(origin)
}

/// Prefer the real main API when it responds promptly; otherwise fetch cached
/// mirrors concurrently and settle shortly after the first healthy mirror.
pub async fn auto_pick() -> Value {
    /* A4：上次真正连通过的线路优先试一次，和主站并行、只给 3.5 秒。
       被墙的网络里主站必挂，而发布页经常一起挂——旧流程会先白等 12 秒发布页
       才轮到镜像，用户看到的就是「首页一直转圈」。这条快路只要有一条通就直接用，
       两条都不通才回到下面完整流程（发布页 + 种子 + 自定义线路）。 */
    if let Some(good) = crate::line_health::last_good()
        .filter(|origin| !is_fixed(origin) && !crate::line_health::blacklisted(origin))
        .filter(|origin| origin != &crate::net::base())
    {
        let main = FIXED[0].1.to_string();
        let good_for_probe = good.clone();
        let mut set = tokio::task::JoinSet::new();
        set.spawn(async move { probe_hit_with("main", &main, Duration::from_secs(3)).await });
        set.spawn(async move {
            probe_hit_with("mirror", &good_for_probe, Duration::from_secs(3)).await
        });
        let mut hits = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(3500);
        loop {
            let next = tokio::select! {
                joined = set.join_next() => joined,
                _ = tokio::time::sleep_until(deadline) => None,
            };
            let Some(joined) = next else { break };
            let Ok(hit) = joined else { continue };
            let ok = hit.ok;
            let is_main = hit.tier == "main";
            hits.push(hit);
            if ok {
                /* 主站通了优先用主站；镜像先通就先回镜像（速度优先，之后 try_main 会回切） */
                set.abort_all();
                let mut result = pick_from_hits(&hits);
                result["reason"] = json!(if is_main { "main-ok-fast" } else { "last-good-fast" });
                return result;
            }
        }
        set.abort_all();
        /* 两条都快挂：保留失败样本给 pick_from_hits / 日志，继续完整流程 */
        let main_handle = tokio::spawn(probe_hit("main", FIXED[0].1));
        let mirrors_handle = tokio::spawn(mirrors_cached());
        return auto_pick_full(main_handle, mirrors_handle, hits).await;
    }
    let main_handle = tokio::spawn(probe_hit("main", FIXED[0].1));
    let mirrors_handle = tokio::spawn(mirrors_cached());
    auto_pick_full(main_handle, mirrors_handle, Vec::new()).await
}

async fn auto_pick_full(
    main_handle: tokio::task::JoinHandle<Hit>,
    mirrors_handle: tokio::task::JoinHandle<Result<Value, String>>,
    mut hits: Vec<Hit>,
) -> Value {
    let mut main_handle = main_handle;
    let mut main_pending = true;

    tokio::select! {
        res = &mut main_handle => {
            main_pending = false;
            if let Ok(hit) = res {
                let ok = hit.ok;
                hits.push(hit);
                if ok {
                    mirrors_handle.abort();
                    return pick_from_hits(&hits);
                }
            }
        }
        _ = tokio::time::sleep(MAIN_HEAD_START) => {}
    }

    let listing = match mirrors_handle.await {
        Ok(res) => res,
        Err(err) => Err(format!("获取镜像列表失败: {err}")),
    };

    let mut set = tokio::task::JoinSet::new();
    if main_pending {
        set.spawn(async move { main_handle.await.ok() });
    }
    /* 自定义线路永远先探：发布页列表拿不到（`listing` 是 Err）时它照样要参与，
       否则「镜像列表抓不到 + 主站不通」会直接把用户的可用自定义线路判死。 */
    if let Some(origin) = custom_candidate(&crate::net::base()) {
        set.spawn(async move { Some(probe_hit("custom", &origin).await) });
    }
    let mut published = 0usize;
    if let Ok(listing) = &listing {
        let items = listing
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        // 落盘兜底的列表不是发布页说的：只当探活候选，不授予凭据信任。
        let stale = listing.get("stale").and_then(Value::as_bool) == Some(true);
        let cached: HashSet<String> = if stale {
            items
                .iter()
                .filter_map(|item| item.get("url").and_then(Value::as_str).map(str::to_owned))
                .collect()
        } else {
            HashSet::new()
        };
        let candidates = auto_candidates(items, &crate::net::base(), |origin| {
            is_trusted_mirror(origin) || cached.contains(origin)
        });
        published = candidates.len();
        for origin in candidates {
            set.spawn(async move { Some(probe_hit("mirror", &origin).await) });
        }
    }
    /* 发布页拿不到（`listing` 是 Err）或候选太少时，用内置种子兜底。
       种子同样逐条真探活，不通就不会被选中；也绝不进信任集合。 */
    if published < SEED_MIN {
        for origin in SEED_MIRRORS {
            set.spawn(async move { Some(probe_hit("seed", origin).await) });
        }
    }

    let mut settle_deadline: Option<tokio::time::Instant> = None;
    loop {
        let next = if let Some(deadline) = settle_deadline {
            tokio::select! {
                res = set.join_next() => res,
                _ = tokio::time::sleep_until(deadline) => None,
            }
        } else {
            set.join_next().await
        };
        let Some(joined) = next else {
            break;
        };
        if let Ok(Some(hit)) = joined {
            let ok = hit.ok;
            hits.push(hit);
            if ok && settle_deadline.is_none() {
                settle_deadline = Some(tokio::time::Instant::now() + SETTLE_GRACE);
            }
        }
    }
    set.abort_all();

    let mut result = pick_from_hits(&hits);
    if let Err(error) = listing {
        result["mirror_error"] = json!(error);
    }
    result
}

/// 紧急换线：网络层硬错误（TLS 被阻断 / 连接重置 / DNS 污染）时，立刻在
/// 「磁盘缓存的镜像 + 内置种子」里找一条真能用的，第一个成功的就算数。
///
/// 故意**不抓发布页**：发布页一次要 2–12 秒（还可能同样被墙），首屏等不起。
/// 候选顺序：上次可用（磁盘 line-health.json）→ 发布页缓存 → 内置种子；
/// 黑名单里的（刚失败过）与 `exclude` 本身直接跳过。
pub async fn failover(exclude: &str) -> Value {
    /* 4s → 7s：概率性 TLS 阻断下，4 秒常常连一次成功握手都赶不上 */
    const FAILOVER_PROBE: Duration = Duration::from_secs(7);
    const FAILOVER_MAX: usize = 8;

    let excluded = crate::net::normalize_base(exclude).unwrap_or_default();
    let mut seen = HashSet::new();
    seen.insert(excluded);
    let mut candidates: Vec<(String, &'static str)> = Vec::new();

    let mut push = |raw: String, tier: &'static str, candidates: &mut Vec<(String, &'static str)>| {
        if candidates.len() >= FAILOVER_MAX {
            return;
        }
        let Some(origin) = crate::net::normalize_base(&raw) else { return };
        if is_fixed(&origin) || crate::line_health::blacklisted(&origin) || !seen.insert(origin.clone()) {
            return;
        }
        candidates.push((origin, tier));
    };

    if let Some(good) = crate::line_health::last_good() {
        push(good, "last-good", &mut candidates);
    }
    if let Some(listing) = load_mirrors_cache() {
        for item in listing.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            if let Some(url) = item.get("url").and_then(Value::as_str) {
                push(url.to_string(), "mirror", &mut candidates);
            }
        }
    }
    for origin in SEED_MIRRORS {
        push(origin.to_string(), "seed", &mut candidates);
    }

    let mut set = tokio::task::JoinSet::new();
    for (origin, tier) in candidates {
        let origin = origin.clone();
        set.spawn(async move { probe_hit_with(tier, &origin, FAILOVER_PROBE).await });
    }
    let mut hits: Vec<Hit> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(hit) = joined {
            let ok = hit.ok;
            let url = hit.url.clone();
            hits.push(hit);
            if ok {
                set.abort_all();
                return json!({
                    "base": url, "tier": "failover", "ms": hits.last().map(|hit| hit.ms).unwrap_or(0),
                    "reason": "failover-ok", "candidates": hits.iter().map(Hit::json).collect::<Vec<_>>(),
                });
            }
        }
    }
    json!({
        "base": "", "tier": "none", "ms": 0, "reason": "all-down",
        "candidates": hits.iter().map(Hit::json).collect::<Vec<_>>(),
    })
}

pub async fn try_main() -> Value {
    let hit = probe_hit("main", FIXED[0].1).await;
    let mut result = hit.json();
    result["base"] = json!(hit.url);
    result
}

pub async fn health() -> Value {
    let hit = probe_hit("current", &crate::net::base()).await;
    let mut result = hit.json();
    result["base"] = json!(hit.url);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origins(items: &[Value]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| item["url"].as_str())
            .collect()
    }

    #[test]
    fn literal_arrays_support_comments_quotes_and_trailing_commas() {
        let js = r#"/* before */ var urls = ['EXAMPLE.COM/', "two.example",];
          const subdomains = [ 'one', // line comment
          'two', ]; var untouched = 'https://example.com/';"#;
        let items = parse_mirrors(js).unwrap();
        assert_eq!(
            origins(&items),
            [
                "https://one.example.com",
                "https://two.example.com",
                "https://one.two.example",
                "https://two.two.example"
            ]
        );
        assert_eq!(
            js_array("let urls = ['https://host/'];", "urls")
                .unwrap()
                .unwrap(),
            ["https://host/"]
        );
    }

    #[test]
    fn fake_declarations_in_comments_strings_templates_and_regex_are_ignored() {
        for js in [
            r#"// var urls=['bad.example'];"#,
            r#"/* var urls=['bad.example']; */"#,
            r#"const text = "var urls=['bad.example'];";"#,
            r#"const text = `var urls=['bad.example'];`;"#,
            r#"const regex = /var urls=['bad.example'];/;"#,
            r#"var urlsExtra=['bad.example'];"#,
            r#"function notRun() { var urls=['bad.example']; }"#,
        ] {
            assert!(parse_mirrors(js).is_err(), "{js}");
        }
    }

    #[test]
    fn dynamic_or_malformed_arrays_fail_closed_including_subdomains() {
        for js in [
            r#"var urls=['one.example', getHost()];"#,
            r#"var urls=['one.example' + '.evil'];"#,
            r#"var urls=['one.example'].concat(other);"#,
            r#"var urls=['one.example']; var urls=['two.example'];"#,
            r#"var urls=['one.example']; var subdomains=getSubs();"#,
            r#"var urls=['one.example']; var subdomains=['one', 2];"#,
            r#"var urls=['one.example']; /* unfinished"#,
        ] {
            assert!(parse_mirrors(js).is_err(), "{js}");
        }
    }

    #[test]
    fn hostnames_are_canonical_bounded_and_not_paths_or_literal_ips() {
        let items = parse_mirrors(r#"var urls=['Example.COM', 'example.com/', '127.0.0.1', 'localhost', 'x.local', 'x.internal', 'x.home.arpa', 'https://evil.example', 'evil.example/path', 'a.example:443', '-a.example', 'valid.example'];"#).unwrap();
        assert_eq!(
            origins(&items),
            ["https://example.com", "https://valid.example"]
        );
        let js = format!(
            "var urls=[{}];",
            (0..100)
                .map(|n| format!("'host{n}.example'"))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_eq!(parse_mirrors(&js).unwrap().len(), MIRROR_MAX);
    }

    #[test]
    fn publish_script_is_same_origin_and_exact_filename() {
        let page = PUBLISH_PAGES[0];
        for html in [
            "<script src='publish.js?v=2'></script>",
            "<script src=publish.js></script>",
            r#"<script src='/analytics.js'></script><script src="/publish.js"></script>"#,
        ] {
            let script = script_src(page, html).unwrap();
            assert!(script.starts_with("https://huangguoai.pages.dev/publish.js"));
        }
        for target in [
            "http://huangguoai.pages.dev/publish.js",
            "https://other.example/publish.js",
            "//other.example/publish.js",
            "javascript:publish.js",
            "https://user@huangguoai.pages.dev/publish.js",
            "/publish.js#fragment",
            "/publish.js/extra",
            "/publish.js.evil",
        ] {
            assert!(absolute(page, target).is_err(), "{target}");
        }
        assert!(script_src(page, "<script src='analytics.js'></script>").is_err());
    }

    fn page(source: &str, hosts: &[&str]) -> Result<PublishedPage, String> {
        Ok(PublishedPage {
            source: source.into(),
            script: format!("{source}publish.js"),
            items: hosts
                .iter()
                .map(|host| json!({"host": host, "url": format!("https://{host}")}))
                .collect(),
        })
    }

    #[test]
    fn publisher_failure_retains_other_success_and_current_is_display_only() {
        let value = merge_publishers(
            [
                Err("timeout".into()),
                page(PUBLISH_PAGES[1], &["a.example"]),
            ],
            "https://restored.example",
        )
        .unwrap();
        assert_eq!(
            origins(value["items"].as_array().unwrap()),
            ["https://a.example"]
        );
        assert_eq!(value["recommended"][0]["url"], "https://restored.example");
        assert_eq!(value["errors"].as_array().unwrap().len(), 1);
        assert!(merge_publishers([Err("first".into()), Err("second".into())], FIXED[0].1).is_err());
    }

    #[test]
    fn publisher_lists_interleave_and_deduplicate() {
        let value = merge_publishers(
            [
                page(PUBLISH_PAGES[0], &["a.example", "c.example"]),
                page(PUBLISH_PAGES[1], &["b.example", "a.example"]),
            ],
            "https://a.example",
        )
        .unwrap();
        assert_eq!(
            origins(value["items"].as_array().unwrap()),
            [
                "https://a.example",
                "https://b.example",
                "https://c.example"
            ]
        );
        assert_eq!(value["recommended"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn health_requires_real_unwrapped_feed_data() {
        let valid = json!({"items": [{"id": 12, "title": "video"}], "pagination": {"page": 1, "pages": 2, "size": 1, "total": 2}});
        assert!(healthy_video_data(&valid));
        assert!(healthy_video_data(
            &json!({"items": [], "pagination": {"page": 1, "pages": 0, "size": 1, "total": 0}})
        ));
        for invalid in [
            Value::Null,
            json!("<html>200 OK</html>"),
            json!({}),
            json!({"status": 0, "msg": "denied"}),
            json!({"status": 1, "data": valid}),
            json!({"items": []}),
            json!({"items": [{}], "pagination": {"page": 1, "pages": 1, "size": 1, "total": 1}}),
        ] {
            assert!(!healthy_video_data(&invalid), "{invalid}");
        }
    }

    fn hit(url: &str, ok: bool, ms: u64) -> Hit {
        Hit {
            tier: "mirror",
            url: url.into(),
            ok,
            reachable: true,
            ms,
            status: Some(200),
            error: None,
        }
    }

    #[test]
    fn all_down_never_returns_a_line_to_switch_to() {
        for hits in [vec![], vec![hit("https://bad.example", false, 1)]] {
            let selected = pick_from_hits(&hits);
            assert_eq!(selected["reason"], "all-down");
            assert_eq!(selected["base"], "");
            assert_eq!(selected["tier"], "none");
        }
        let selected = pick_from_hits(&[
            hit("https://html.example", false, 1),
            hit("https://slow.example", true, 20),
            hit("https://fast.example", true, 8),
        ]);
        assert_eq!(selected["base"], "https://fast.example");
    }

    #[test]
    fn auto_candidates_require_publication_and_exclude_ai_landing_page() {
        let items = [
            json!({"url": "https://huangguoai.ai"}),
            json!({"url": "https://published.example"}),
            json!({"url": "https://untrusted.example"}),
            json!({"url": "https://published.example"}),
        ];
        let candidates = auto_candidates(&items, "https://restored.example", |origin| {
            origin == "https://published.example"
        });
        assert_eq!(candidates, ["https://published.example"]);
        assert!(auto_candidates(&[], "https://restored.example", |_| true).is_empty());
    }

    /// 上游 2026-11-20 换了域名族（dvygahpw.cc / zuxszoix.cc），格式仍是 urls+subdomains。
    #[test]
    fn current_publisher_format_yields_one_host_per_subdomain() {
        let js = r#"
var subdomains = ['thu','pku','fdu'];
var urls=[
	'dvygahpw.cc/',
	'zuxszoix.cc/',
];
var otherUrls = ['https://huangguoai.pages.dev','https://huang-guo.pages.dev'];
var foreverUrls = ['https://huangguoai.com','https://huangguoai.ai'];
"#;
        let items = parse_mirrors(js).unwrap();
        assert_eq!(
            origins(&items),
            [
                "https://thu.dvygahpw.cc",
                "https://pku.dvygahpw.cc",
                "https://fdu.dvygahpw.cc",
                "https://thu.zuxszoix.cc",
                "https://pku.zuxszoix.cc",
                "https://fdu.zuxszoix.cc",
            ]
        );
    }

    /// 换写法（只有完整 https://host，没有 urls 数组）也要能解析；发布页域名不能变成镜像。
    #[test]
    fn script_without_urls_array_falls_back_to_static_host_scan() {
        let js = r#"
var newestUrls = ['https://thu.dvygahpw.cc','https://pku.zuxszoix.cc','newfamily.cc/'];
var otherUrls = ['https://huangguoai.pages.dev','https://huangguoai.com','https://huangguoai.ai'];
var emails = ['huangguoaiai@gmail.com'];
"#;
        let items = parse_mirrors(js).unwrap();
        assert_eq!(
            origins(&items),
            [
                "https://thu.dvygahpw.cc",
                "https://pku.zuxszoix.cc",
                "https://newfamily.cc"
            ]
        );
    }

    /// 落盘兜底：读回来标 stale，且**不**授予凭据信任。
    #[test]
    fn persisted_mirror_cache_is_stale_and_never_trusted() {
        let dir = std::env::temp_dir().join(format!("hguox-lines-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        bind(&dir);
        let items = [json!({"url": "https://cached.example", "host": "cached.example"})];
        save_mirrors_cache(&items);
        let cached = load_mirrors_cache().unwrap();
        assert_eq!(cached["stale"], json!(true));
        assert_eq!(origins(cached["items"].as_array().unwrap()), ["https://cached.example"]);
        // 落盘缓存可以「切过去」，但绝不进登录凭据信任集合。
        assert!(is_cached_mirror("https://cached.example"));
        assert!(!is_trusted_mirror("https://cached.example"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
