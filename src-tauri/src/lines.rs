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
/// 3.0.21：一次选线/换线的**探测总预算**（按「探测请求条数」算，不是按 origin 算）。
///
/// 真机证据（小米九，被墙网络）：一次冷启动里有 **47–108 条 `cmd=probe`** ——
/// 10 条候选 × 最多 3 次重试 + 9 条种子 + 主域，全都在白撞。目标是 ≤ 8 条：
/// 主域 2 + 镜像 4 + 兜底种子 2 就够判断「这一轮谁能用」了，因为 SETTLE_GRACE
/// 拿到第一个成功就收工。
const PROBE_BUDGET: usize = 8;
/// 3.0.22：**整个进程**（一次冷启动）允许多少条自动探活。
///
/// 3.0.21 把 8 条当成「一次选线的预算」，但一次冷启动里会自动选线好几次
/// （boot 的 `line_auto` + 每次硬错误的 `line_failover` + 首屏 1s/3s/7s 重试），
/// 每建一次 gate 就又拿满 8 条 —— 真机 5 秒内发出 24 条 probe（17 个 origin）。
/// 现在这条预算挂在全进程上，用尽即停，并且打一行 `[net] probe budget exhausted n=8`。
const PROCESS_PROBE_BUDGET: usize = PROBE_BUDGET;
/// 探测并发上限（个位数）。被墙网络里 4 条并发足够在 2–4 秒内出结果，
/// 又不会像以前那样一次把 40+ 条请求塞进连接池排队。
const PROBE_CONCURRENCY: usize = 4;
const MIRROR_CACHE_TTL: Duration = Duration::from_secs(300);
const MAIN_HEAD_START: Duration = Duration::from_millis(1000);
const SETTLE_GRACE: Duration = Duration::from_millis(350);
/// 冷启动「上次成功线路」单独探活的时间预算（3.0.20）。只有 2.5 秒：
/// 它 24 小时内刚成功过，正常一次握手 1–2 秒；超时就当它挂了走完整流程。
const LAST_GOOD_PROBE: Duration = Duration::from_millis(2500);
/// 第一个发布页成功后，再给另一页这么久补齐列表（另一页常常是被污染的，别等它）。
const MIRROR_GRACE: Duration = Duration::from_millis(2000);
/// 发布页候选少于这个数就用内置种子补位（种子同样要真探活，不通不入选中）。
const SEED_MIN: usize = 3;
/// 内置兜底：已知可用族的前缀。上游换族会失效，所以只当「发布页拉不到」时的最后一道兜底，
/// 且**不授予凭据信任**（不进 `TRUSTED_MIRRORS`）。
/// 3.0.14：`huang-guo.pages.dev/publish.js` 现在给的是 `aqkmowihz.cc` / `xxslfswu.cc`
/// 两族（子域是 19 所高校前缀随机拼）。旧族 dvygahpw/zuxszoix 已经探不通，
/// 保留两条旧族当「上游又换回来」的兜底，但新族排在前面。
const SEED_MIRRORS: [&str; 9] = [
    "https://thu.wsaditmwl.cc",
    "https://pku.wsaditmwl.cc",
    "https://zju.wsaditmwl.cc",
    "https://thu.aqkmowihz.cc",
    "https://pku.aqkmowihz.cc",
    "https://thu.xxslfswu.cc",
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

/// 本次进程里**真探活通过**的 origin（3.0.22 A5）。
///
/// 为什么需要第三档：内置种子（`SEED_MIRRORS`）刻意不进 `TRUSTED_MIRRORS`（凭据信任），
/// 也不在落盘缓存里，于是 `net::apply_base` 的允许清单把它们全挡了 —— 真机上就成了
/// 「探活明明返回 ok（thu.wsaditmwl.cc 连续 7 次 1.0–1.9s ok），换线却一次都没成，
/// `[net] switch` 一行都没有，最后停在错误页」。
///
/// 这一档只是「**我们亲手从自己的候选表里探通过的地址**」，可以当线路用（游客浏览），
/// 但**不授予凭据信任**：`trusted_auth_origin` 不看它，切过去之后
/// `session.rebase_if_trusted` 仍为假 → 会话照样清掉，token 不会带过去。
static VERIFIED: RwLock<Vec<String>> = RwLock::new(Vec::new());
const VERIFIED_MAX: usize = 32;

/// 探活通过（拿到健康视频列表）时登记。只在内存里，进程重启即清空。
pub fn remember_verified(origin: &str) {
    let Some(origin) = crate::net::normalize_base(origin) else { return };
    let mut known = VERIFIED.write().unwrap_or_else(|error| error.into_inner());
    if known.iter().any(|value| value == &origin) {
        return;
    }
    if known.len() >= VERIFIED_MAX {
        known.remove(0);
    }
    known.push(origin);
}

/// 这条 origin 是不是本次进程里探活通过的候选（可以自动切过去，但**不带凭据**）。
pub fn is_verified_candidate(origin: &str) -> bool {
    VERIFIED
        .read()
        .map(|known| known.iter().any(|value| value == origin))
        .unwrap_or(false)
}

#[cfg(test)]
fn clear_verified() {
    VERIFIED.write().unwrap_or_else(|error| error.into_inner()).clear();
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
    probe_hit_with(tier, raw, AUTO_PROBE_TIMEOUT, &ProbeGate::process()).await
}

/// 探测预算 + 并发闸门（3.0.21 A 节，3.0.22 改成**按进程**计）。
///
/// 以前每条候选自己重试 3 次，一次冷启动能刷出 47–108 条 `cmd=probe`；被墙网络里
/// 这些请求全是白撞，还把首屏挤在后面。
///
/// 3.0.21 的「一次选线共用一张预算（8 条）」**不够**：真机（小米九 / 2026-11-28）
/// 一次冷启动里 `line_auto` + `line_failover` + 首屏 1s/3s/7s 重试会各建一张 gate，
/// 5 秒内就发出 24 条探测（17 个不同 origin）。所以现在自动选线一律用
/// [`ProbeGate::process`]：**整个进程共享 8 条预算、共享 4 个并发槽**，用尽就停，
/// 并打一行 `[net] probe budget exhausted n=8`。
/// 手动测速（设置页「测速」）是用户显式点的，仍用 [`ProbeGate::new`] 自带预算。
#[derive(Clone)]
struct ProbeGate {
    /// `None` = 用全进程共享的那一份（自动选线）；`Some` = 自己一份（手动测速 / 单测）。
    left: Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
    sem: Option<std::sync::Arc<tokio::sync::Semaphore>>,
}

/// 全进程共用的探测预算（3.0.22）：一次冷启动最多 8 条自动探活。
static PROCESS_PROBES_LEFT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(PROCESS_PROBE_BUDGET);
/// `[net] probe budget exhausted` 只打一次（否则每条被放弃的候选都刷一行）。
static PROBE_EXHAUSTED_LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn process_sem() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static SEM: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    SEM.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(PROBE_CONCURRENCY)))
}

impl ProbeGate {
    /// 自带预算的闸门（手动测速 / 单测）：预算与并发都只属于这一次调用。
    fn new(budget: usize) -> Self {
        Self {
            left: Some(std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(
                budget.min(MIRROR_MAX + 4),
            ))),
            sem: None,
        }
    }

    /// 全进程共享的闸门（所有自动选线路径都用它）。
    fn process() -> Self {
        Self { left: None, sem: None }
    }

    fn left_of(&self) -> usize {
        match &self.left {
            Some(left) => left.load(std::sync::atomic::Ordering::Relaxed),
            None => PROCESS_PROBES_LEFT.load(std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// 用掉一个名额；用光了返回 false（并保证日志只打一次）。
    fn take_one(&self) -> bool {
        let shared = self.left.is_none();
        let taken = match &self.left {
            Some(left) => try_take(left),
            None => try_take(&PROCESS_PROBES_LEFT),
        };
        if !taken {
            note_probe_exhausted(shared);
        }
        taken
    }

    /// 拿一个探测名额（同时占一个并发槽）。预算用尽返回 None。
    async fn slot(&self) -> Option<tokio::sync::OwnedSemaphorePermit> {
        if self.left_of() == 0 {
            note_probe_exhausted(self.left.is_none());
            return None;
        }
        let sem = match &self.sem {
            Some(sem) => sem.clone(),
            None => process_sem().clone(),
        };
        let permit = sem.acquire_owned().await.ok()?;
        /* 抢到槽之后再扣预算：并发下不能先扣后排队，否则排队的一进来就把预算吃光 */
        self.take_one().then_some(permit)
    }

    /// 剩余预算（单测用：验证「20 个并发只放行 8 个」）。
    #[cfg(test)]
    fn left(&self) -> usize {
        self.left_of()
    }
}

/// 原子地扣一个名额（用光返回 false）。
fn try_take(counter: &std::sync::atomic::AtomicUsize) -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    counter.fetch_update(Relaxed, Relaxed, |left| left.checked_sub(1)).is_ok()
}

/// 预算用尽时打一行（全进程只打一次）：`[net] probe budget exhausted n=8`。
fn note_probe_exhausted(shared: bool) {
    if !shared {
        return;
    }
    if !PROBE_EXHAUSTED_LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        let used = PROCESS_PROBE_BUDGET.saturating_sub(
            PROCESS_PROBES_LEFT.load(std::sync::atomic::Ordering::Relaxed),
        );
        crate::netlog::probe_budget_exhausted(used);
    }
}

/// 单测用：把全进程预算恢复成满额（`cargo test` 同进程跑多个用例）。
#[cfg(test)]
fn reset_process_probe_budget() {
    use std::sync::atomic::Ordering;
    PROCESS_PROBES_LEFT.store(PROCESS_PROBE_BUDGET, Ordering::Relaxed);
    PROBE_EXHAUSTED_LOGGED.store(false, Ordering::Relaxed);
    if let Some(sem) = process_sem().try_acquire_many(PROBE_CONCURRENCY as u32).ok() {
        sem.forget();
        process_sem().add_permits(PROBE_CONCURRENCY);
    }
}

/// 这次探测没发出去（预算用尽 / 已经成功过不需要再问）时的占位结果。
fn exhausted_hit(tier: &'static str, origin: &str) -> Hit {
    Hit {
        tier,
        url: origin.to_owned(),
        ok: false,
        reachable: false,
        ms: 0,
        status: None,
        error: Some("探测预算已用尽（3.0.22：一次冷启动全进程 ≤8 条探活）".into()),
    }
}

/// 同 [`probe_hit`]，超时可调：硬错误后的紧急换线只给 4 秒，
/// 不能让一条被墙的镜像把首屏拖到 5 秒以上。
async fn probe_hit_with(tier: &'static str, raw: &str, timeout: Duration, gate: &ProbeGate) -> Hit {
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
    /* 拒绝表命中：连探活都不发（真机复测看 `[net] skip …` 这行）。 */
    if let Some(age) = crate::line_health::blocked_age(&origin) {
        crate::netlog::skip_origin(&origin, "blocked", age);
        hit.error = Some("本地拒绝表：这条线路的 TLS 握手被断过，本轮跳过".into());
        return hit;
    }
    /* 3.0.14 真机结论：这类网络对 TLS 握手是**概率性**阻断 —— 同一域名同一条线路
       一次 curl 三分之一的尝试 TLS 能过（实测 3 次里 1 次 200）。探活只打一枪的话，
       一条其实能用的镜像会被判死，用户看到的就是「线路全部不可用」。
       所以探活在总预算内重试到成功（或预算用尽），不再单发一次定生死。
       3.0.21：重试次数受共用预算约束（见 [`ProbeGate`]），不再是无上限地 ×3。 */
    let attempts = if crate::line_health::ever_succeeded(&origin) { 3 } else { 2 };
    let deadline = started + timeout;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            hit.error.get_or_insert_with(|| format!("视频接口探测超时（{} 秒）", timeout.as_secs()));
            break;
        }
        let Some(_permit) = gate.slot().await else {
            hit.error.get_or_insert_with(|| "探测预算已用尽（3.0.22：一次冷启动全进程 ≤8 条探活）".into());
            break;
        };
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
                    /* 上游停了边缘信封时，信封这条路会返回「接口已停用」；
                       虽然 net.rs 里已有自动直连兜底，探活这里再兜一层，避免因为
                       envelope/缓存状态差异把一条真能用的镜像判死。 */
                    match crate::net::probe_direct(&origin).await {
                        Ok(true) => {
                            hit.ok = true;
                        }
                        Ok(false) => hit.error = Some("接口未返回有效视频列表数据".into()),
                        Err(error) => hit.error = Some(error),
                    }
                }
                break;
            }
            Ok(Err(error)) => {
                hit.error = Some(error);
                /* 只有链路层失败值得再试；403/401/业务错误重试没意义 */
                if crate::line_health::fault_kind(hit.error.as_deref().unwrap_or("")).is_none() {
                    break;
                }
                /* 刚被判死（写进拒绝表）的 origin 不必再试：这一轮它已经不可能通了，
                   再试只是多刷一条 cmd=probe。 */
                if crate::line_health::blocked(&origin) {
                    break;
                }
            }
            Err(_) => {
                hit.error = Some(format!("视频接口探测超时（{} 秒）", timeout.as_secs()));
            }
        }
        if attempt >= attempts {
            break;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    hit.ms = started.elapsed().as_millis() as u64;
    if hit.ok {
        /* 3.0.22 A5：探活通过的地址登记成「可用候选」——内置种子不在发布页清单里，
           以前会被 `net::apply_base` 的允许清单挡掉（探通了也用不上）。 */
        remember_verified(&origin);
    }
    hit
}

/// Manual checks retain their JSON API and never change trust or active line.
///
/// 手动测速是用户显式点的，不受 `PROBE_BUDGET` 限制；但并发仍走同一个闸门
/// （个位数），免得一次手动测速把连接池塞满、把首屏挤在后面。
pub async fn probe(urls: Vec<String>) -> Value {
    let mut out = Vec::new();
    let gate = ProbeGate::new(MIRROR_MAX);
    for chunk in urls[..urls.len().min(MIRROR_MAX)].chunks(PROBE_CONCURRENCY) {
        let mut handles = Vec::new();
        for origin in chunk {
            let origin = origin.clone();
            let gate = gate.clone();
            handles.push(tokio::spawn(async move {
                probe_hit_with("mirror", &origin, AUTO_PROBE_TIMEOUT, &gate).await
            }));
        }
        for handle in handles {
            if let Ok(hit) = handle.await {
                out.push(hit.json());
            }
        }
    }
    json!(out)
}

/// 拒绝表命中的 origin 不再先撞（3.0.21 A 节）。
///
/// 但**全被判死时退回原列表**：本地拒绝表是「别白等」的优化，不是「什么都不能试」的
/// 判决。全部候选都在表里时仍然探一轮，总比直接告诉用户「线路全部不可用」好。
fn probe_list(candidates: Vec<String>) -> Vec<String> {
    let skipped: Vec<(String, u64)> = candidates
        .iter()
        .filter_map(|origin| crate::line_health::blocked_age(origin).map(|age| (origin.clone(), age)))
        .collect();
    if skipped.len() >= candidates.len() {
        return candidates;
    }
    for (origin, age) in skipped {
        crate::netlog::skip_origin(&origin, "blocked", age);
    }
    candidates
        .into_iter()
        .filter(|origin| crate::line_health::blocked_age(origin).is_none())
        .collect()
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
        .min_by_key(|hit| (hit.tier == "custom", hit.tier == "seed", hit.tier == "last-good-stale", hit.ms));
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
    /* 3.0.20 冷启动：**上次成功过的线路就是首选**，不再「先撞主域再比一轮」。
       被墙网络里 5 次冷启动有 4 次靠后面换线才有内容，原因就是这个顺序 ——
       主域每次都要白等 3~12 秒。现在的顺序：
         ① base 本来就是 24h 内成功过的那条 → 直接认，零探活；
         ② 上次成功的不是当前这条 → 只探它（2.5 秒），通了就用，**完全不碰主域**；
         ③ 它也不通，才进入原来的完整流程（主域 + 发布页镜像 + 种子 + 自定义）。
       超过 24h 的 last_good 不进 ①②（只在这一轮候选里降级参与），见 load 逻辑。
       3.0.21：①② 都要先过一遍本地拒绝表 —— 上次成功过但现在被墙的线路，
       不该因为「它是 last_good」再白等一次。 */
    let current = crate::net::base();
    let usable = |origin: &str| {
        !is_fixed(origin)
            && !crate::line_health::blacklisted(origin)
            && !crate::line_health::blocked(origin)
    };
    if let Some(last) = crate::line_health::last_good_info().filter(|last| last.fresh()) {
        if usable(&last.origin) && last.origin == current {
            return json!({
                "base": last.origin, "tier": "last-good", "ms": 0,
                "reason": "last-good-keep", "candidates": [],
            });
        }
    }
    let gate = ProbeGate::process();
    let mut carried: Vec<Hit> = Vec::new();
    if let Some(last) = crate::line_health::last_good_info().filter(|last| last.fresh()) {
        if last.origin != current && usable(&last.origin) {
            let hit = probe_hit_with("last-good", &last.origin, LAST_GOOD_PROBE, &gate).await;
            if hit.ok {
                let mut result = pick_from_hits(std::slice::from_ref(&hit));
                result["reason"] = json!("last-good-first");
                return result;
            }
            /* 探不通：把这次失败样本带进完整流程（候选明细里能看见它为什么没被选） */
            carried.push(hit);
        }
    }
    /* 主域在拒绝表里就**一个请求都不发**：以前这里要白等 4.5 秒再灌几十条探活。 */
    let main_handle = match crate::line_health::blocked_age(FIXED[0].1) {
        Some(age) => {
            crate::netlog::skip_origin(FIXED[0].1, "blocked", age);
            tokio::spawn(async move { exhausted_hit("main", FIXED[0].1) })
        }
        None => {
            let gate = gate.clone();
            tokio::spawn(async move { probe_hit_with("main", FIXED[0].1, AUTO_PROBE_TIMEOUT, &gate).await })
        }
    };
    let mirrors_handle = tokio::spawn(mirrors_cached());
    auto_pick_full(main_handle, mirrors_handle, carried, gate).await
}

async fn auto_pick_full(
    main_handle: tokio::task::JoinHandle<Hit>,
    mirrors_handle: tokio::task::JoinHandle<Result<Value, String>>,
    mut hits: Vec<Hit>,
    gate: ProbeGate,
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
        let gate = gate.clone();
        set.spawn(async move { Some(probe_hit_with("custom", &origin, AUTO_PROBE_TIMEOUT, &gate).await) });
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
        /* 3.0.21：拒绝表里的镜像不再先撞（全都命中时退回原列表，见 probe_list）。 */
        let candidates = probe_list(candidates);
        published = candidates.len();
        for origin in candidates {
            let gate = gate.clone();
            set.spawn(async move {
                Some(probe_hit_with("mirror", &origin, AUTO_PROBE_TIMEOUT, &gate).await)
            });
        }
    }
    /* 发布页拿不到（`listing` 是 Err）或候选太少时，用内置种子兜底。
       种子同样逐条真探活，不通就不会被选中；也绝不进信任集合。 */
    if published < SEED_MIN {
        let seeds = probe_list(SEED_MIRRORS.iter().map(|origin| origin.to_string()).collect());
        for origin in seeds {
            let gate = gate.clone();
            set.spawn(async move {
                Some(probe_hit_with("seed", &origin, AUTO_PROBE_TIMEOUT, &gate).await)
            });
        }
    }
    /* 3.0.20：上次成功过但已经超过 24h 的线路 —— 只当普通候选，优先级降到
       发布页镜像之后（网络环境可能早就变了），但比内置种子可信：它至少真通过一次。 */
    if let Some(last) = crate::line_health::last_good_info().filter(|last| !last.fresh()) {
        let known = hits.iter().any(|hit| hit.url == last.origin);
        if !known
            && !is_fixed(&last.origin)
            && !crate::line_health::blacklisted(&last.origin)
            && !crate::line_health::blocked(&last.origin)
            && last.origin != crate::net::base()
        {
            let gate = gate.clone();
            set.spawn(async move {
                Some(probe_hit_with("last-good-stale", &last.origin, AUTO_PROBE_TIMEOUT, &gate).await)
            });
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
/// 并发探一批候选，第一个真的能用的就返回（其余立刻取消）。
async fn race_candidates(
    candidates: Vec<(String, &'static str)>,
    budget: Duration,
    gate: &ProbeGate,
) -> (Option<Hit>, Vec<Hit>) {
    let mut set = tokio::task::JoinSet::new();
    for (origin, tier) in candidates {
        let gate = gate.clone();
        set.spawn(async move { probe_hit_with(tier, &origin, budget, &gate).await });
    }
    let mut hits: Vec<Hit> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(hit) = joined {
            let ok = hit.ok;
            hits.push(hit);
            if ok {
                set.abort_all();
                let winner = hits.last().cloned();
                return (winner, hits);
            }
        }
    }
    (None, hits)
}

/// 多排除版本：首屏自动重试时每次要换到「还没试过的」那一条（3.0.20），
/// 单靠 exclude 当前线路不够 —— 上一轮换到 A 失败了，这一轮得把 A 也排除。
pub async fn failover_excluding(excludes: &[String]) -> Value {
    /* 4s → 7s：概率性 TLS 阻断下，4 秒常常连一次成功握手都赶不上 */
    const FAILOVER_PROBE: Duration = Duration::from_secs(7);
    const FAILOVER_MAX: usize = 8;

    /* 发布页在后台先抓起来 —— 真机上它常常是唯一还能拿到「当前族」的来源，
       和第一阶段的探活并行，省掉 5~10 秒。 */
    let published = tokio::spawn(async { mirrors().await });
    let gate = ProbeGate::process();
    let mut excluded: HashSet<String> = HashSet::new();
    for raw in excludes {
        /* 3.0.22：前端传的是 `hostOf()` 出来的**裸主机名**（`thu.x.cc`），
           `normalize_base` 只认带 https:// 的完整 origin —— 以前这里对裸主机名一律
           返回 None，于是「每次换一条没试过的候选」其实从没生效过：换线还是会
           挑回刚失败的那条，白白多烧探测预算。这里补一次补全。 */
        let candidate = raw.trim();
        let normalized = crate::net::normalize_base(candidate)
            .or_else(|| crate::net::normalize_base(&format!("https://{candidate}")));
        if let Some(origin) = normalized {
            excluded.insert(origin);
        }
    }
    let mut seen = excluded.clone();
    let mut candidates: Vec<(String, &'static str)> = Vec::new();
    let mut hits: Vec<Hit> = Vec::new();

    /* 3.0.20：24h 内成功过的线路先单独敲一次（2.5 秒）。被墙网络里换线最理想的结果
       就是「回到上次那条通的」，而它通常一次握手就有答复；打不通再并发探一批，
       免得一条死线路先把首屏的 7 秒预算吃掉。 */
    if let Some(last) = crate::line_health::last_good_info().filter(|last| last.fresh()) {
        if !excluded.contains(&last.origin)
            && !is_fixed(&last.origin)
            && !crate::line_health::blacklisted(&last.origin)
            && !crate::line_health::blocked(&last.origin)
        {
            let hit = probe_hit_with("last-good", &last.origin, LAST_GOOD_PROBE, &gate).await;
            if hit.ok {
                hits.push(hit);
                crate::line_health::record_probe(hits.iter().map(Hit::json).collect());
                let hit = hits.last().cloned().unwrap_or_else(|| unreachable!());
                return json!({
                    "base": hit.url, "tier": "failover", "ms": hit.ms,
                    "reason": "failover-last-good", "candidates": hits.iter().map(Hit::json).collect::<Vec<_>>(),
                });
            }
            hits.push(hit);
        }
    }

    let push = |raw: String, tier: &'static str, candidates: &mut Vec<(String, &'static str)>, seen: &mut HashSet<String>| {
        let Some(origin) = crate::net::normalize_base(&raw) else { return };
        if is_fixed(&origin) || crate::line_health::blacklisted(&origin) || !seen.insert(origin.clone()) {
            return;
        }
        candidates.push((origin, tier));
    };

    if let Some(good) = crate::line_health::last_good() {
        push(good, "last-good", &mut candidates, &mut seen);
    }
    if let Some(listing) = load_mirrors_cache() {
        for item in listing.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            if candidates.len() >= FAILOVER_MAX { break; }
            if let Some(url) = item.get("url").and_then(Value::as_str) {
                push(url.to_string(), "mirror", &mut candidates, &mut seen);
            }
        }
    }
    for origin in SEED_MIRRORS {
        if candidates.len() >= FAILOVER_MAX { break; }
        push(origin.to_string(), "seed", &mut candidates, &mut seen);
    }

    let (winner, raced) = race_candidates(candidates, FAILOVER_PROBE, &gate).await;
    hits.extend(raced);
    if let Some(hit) = winner {
        crate::line_health::record_probe(hits.iter().map(Hit::json).collect());
        return json!({
            "base": hit.url, "tier": "failover", "ms": hit.ms,
            "reason": "failover-ok", "candidates": hits.iter().map(Hit::json).collect::<Vec<_>>(),
        });
    }

    /* 第二阶段：磁盘缓存 + 内置种子全挂 → 抓一次发布页再试。
       真机教训：上游换族很勤（这次实测发布页已经给出 wsaditmwl.cc，而种子还是上一族），
       只靠内置种子必然追不上。这里多花几秒，但换来「被墙网络里还有路可走」。 */
    /* 这里必须强制重抓发布页：mirrors_cached() 在 TTL 内会直接回旧列表，
       而旧列表正是「上一个族」，全都被墙 —— 真机上就是这个原因导致
       failover 明明有可用镜像却报「全部不可用」。 */
    if let Ok(Ok(listing)) = published.await {
        let items = listing.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let mut fresh: Vec<(String, &'static str)> = Vec::new();
        for item in items {
            if fresh.len() >= FAILOVER_MAX { break; }
            if let Some(url) = item.get("url").and_then(Value::as_str) {
                push(url.to_string(), "published", &mut fresh, &mut seen);
            }
        }
        let (winner, more) = race_candidates(fresh, FAILOVER_PROBE, &gate).await;
        hits.extend(more);
        if let Some(hit) = winner {
            crate::line_health::record_probe(hits.iter().map(Hit::json).collect());
            return json!({
                "base": hit.url, "tier": "failover", "ms": hit.ms,
                "reason": "failover-published", "candidates": hits.iter().map(Hit::json).collect::<Vec<_>>(),
            });
        }
    }

    crate::line_health::record_probe(hits.iter().map(Hit::json).collect());
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


    /// 3.0.21 A3（3.0.22 扩到**按进程**）：探测**条数**有上限（目标 ≤8），
    /// 并发不超过 4 —— 以前 10 条候选 × 3 次重试 + 9 条种子能刷出 47–108 条。
    #[tokio::test]
    async fn probe_gate_caps_the_batch_at_eight_requests_and_four_at_a_time() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let gate = ProbeGate::new(PROBE_BUDGET);
        let inflight = std::sync::Arc::new(AtomicUsize::new(0));
        let peak = std::sync::Arc::new(AtomicUsize::new(0));
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..20 {
            let gate = gate.clone();
            let inflight = inflight.clone();
            let peak = peak.clone();
            set.spawn(async move {
                let Some(_permit) = gate.slot().await else { return false };
                let now = inflight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
                inflight.fetch_sub(1, Ordering::SeqCst);
                true
            });
        }
        let mut granted = 0;
        while let Some(joined) = set.join_next().await {
            if joined.ok() == Some(true) {
                granted += 1;
            }
        }
        assert_eq!(granted, PROBE_BUDGET, "20 个候选并发抢，只应放行 8 条探活");
        assert_eq!(gate.left(), 0, "预算应当被扣干净");
        assert!(peak.load(Ordering::SeqCst) <= PROBE_CONCURRENCY, "并发峰值 {} 超过 {}", peak.load(Ordering::SeqCst), PROBE_CONCURRENCY);
    }

    /// 3.0.22 A4：探测预算挂在**全进程**上 —— 一次冷启动里「多次选线」共用 8 条。
    ///
    /// 真机证据（小米九 / 2026-11-28）：18:55:09–18:55:15 的 5 秒内 24 条 `cmd=probe`
    /// （17 个不同 origin），因为 boot 的 line_auto、每次硬错误的 line_failover、
    /// 首屏 1s/3s/7s 重试各自建了一张 gate，每张都拿满 8 条。
    #[tokio::test]
    async fn process_probe_budget_is_shared_across_batches() {
        let _guard = crate::line_health::test_state_lock();
        reset_process_probe_budget();
        let first = ProbeGate::process();
        let mut granted = 0;
        for _ in 0..6 {
            if first.slot().await.is_some() {
                granted += 1;
            }
        }
        assert_eq!(granted, 6, "第一轮选线先花掉 6 条");

        /* 第二次选线（新的 gate，但同一次冷启动）：只剩 2 条 */
        let second = ProbeGate::process();
        let mut more = 0;
        for _ in 0..6 {
            if second.slot().await.is_some() {
                more += 1;
            }
        }
        assert_eq!(more, 2, "全进程总共只放行 8 条探活，第二次选线只剩 2 条");
        assert_eq!(second.left(), 0, "预算扣干净");
        assert!(ProbeGate::process().slot().await.is_none(), "用尽之后一条都不再发");
        reset_process_probe_budget();
        assert_eq!(ProbeGate::process().left(), PROBE_BUDGET, "复位后预算回到满额");
    }

    /// 3.0.22 A5：探活通过的内置种子可以被切成线路，但**不带凭据**。
    ///
    /// 真机证据（小米九 / 2026-11-28，net2–net5.log）：`thu.wsaditmwl.cc` 探活连续
    /// 7 次 ok（1.0–1.9s），但 `[net] switch` 一行都没有 —— 它不在发布页清单/落盘缓存里，
    /// `apply_base` 直接拒绝，于是「有可用线路却停在错误页」。
    #[test]
    fn verified_candidate_can_become_the_base_without_credential_trust() {
        let _guard = crate::line_health::test_state_lock();
        let dir = std::env::temp_dir().join(format!("hguox-verified-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::net::bind_base(&dir);
        clear_verified();
        let seed = "https://thu.seed.example";
        assert!(crate::net::set_base(seed).is_err(), "没探活通过的地址不能当线路（挡住伪造 origin）");
        remember_verified(seed);
        assert!(crate::lines::is_verified_candidate(seed));
        let applied = crate::net::set_base(seed).expect("探活通过的候选必须能切过去");
        assert_eq!(applied, seed);
        assert!(!crate::net::trusted_auth_origin(seed), "探活通过 ≠ 凭据信任：token 不会带到这条线路上");
        /* 收尾：把 base 还回主站，别影响别的用例 */
        let _ = crate::net::set_base(crate::net::DEFAULT_BASE);
        clear_verified();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 「换一条没试过的候选」以前对裸主机名无效（`hostName` 不是合法 origin）。
    #[test]
    fn bare_hosts_in_the_exclude_list_are_understood() {
        assert_eq!(crate::net::normalize_base("thu.example.cc"), None, "裸主机名本身不是合法 origin");
        assert_eq!(
            crate::net::normalize_base(&format!("https://{}", "thu.example.cc")).as_deref(),
            Some("https://thu.example.cc"),
            "补上 https:// 之后就能进排除集合（failover_excluding 现在这么补）"
        );
    }

    /// 3.0.21 A1：拒绝表命中的镜像不再先撞；但**全被拒绝时退回原列表**，
    /// 不能因为一张「别白等」的表把候选清空、直接判 all-down。
    #[test]
    fn blocked_mirrors_are_skipped_unless_every_candidate_is_blocked() {
        let _guard = crate::line_health::test_state_lock();
        let blocked = "https://denied-mirror.example";
        let open = "https://open-mirror.example";
        crate::line_health::deny(blocked, "tls");
        assert_eq!(
            probe_list(vec![blocked.to_string(), open.to_string()]),
            vec![open.to_string()],
            "被墙镜像不该再进探测列表"
        );
        assert_eq!(
            probe_list(vec![blocked.to_string()]),
            vec![blocked.to_string()],
            "全都命中拒绝表时仍然探一轮（总比直接说「线路全部不可用」好）"
        );
    }

    /// 拒绝表命中时探测立即返回、**一个请求都不发**（`cmd=probe` 不再灌水）。
    #[tokio::test]
    async fn denied_origin_is_not_probed_at_all() {
        let _guard = crate::line_health::test_state_lock();
        let origin = "https://denied-probe.example";
        crate::line_health::deny(origin, "tls");
        let gate = ProbeGate::new(PROBE_BUDGET);
        let hit = probe_hit_with("mirror", origin, AUTO_PROBE_TIMEOUT, &gate).await;
        assert!(!hit.ok);
        assert_eq!(hit.error.as_deref(), Some("本地拒绝表：这条线路的 TLS 握手被断过，本轮跳过"));
        assert_eq!(gate.left(), PROBE_BUDGET, "跳过的 origin 不消耗探测预算");
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

    /// 3.0.20：超过 24h 的 last_good 只当普通候选 —— 排在发布页镜像之后（网络可能早变了），
    /// 但仍比内置种子优先（它至少真通过一次）。
    #[test]
    fn stale_last_good_ranks_after_published_mirrors() {
        let mut stale = hit("https://stale.example", true, 40);
        stale.tier = "last-good-stale";
        let picked = pick_from_hits(&[stale.clone(), hit("https://pub.example", true, 900)]);
        assert_eq!(picked["base"], "https://pub.example");
        let mut seed = hit("https://seed.example", true, 10);
        seed.tier = "seed";
        let picked = pick_from_hits(&[stale, seed]);
        assert_eq!(picked["base"], "https://stale.example", "过期的 last_good 仍比内置种子优先");
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
