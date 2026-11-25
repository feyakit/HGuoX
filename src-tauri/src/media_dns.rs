use crate::network_policy;
use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const HOST: &str = "dns.alidns.com";
pub(crate) const BOOTSTRAP: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 5, 5, 5)), 443),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 6, 6, 6)), 443),
];
/// 腾讯 DoH：阿里解析失败时的第二选择（国内可达，和阿里/CF 走的是不同网络）。
pub(crate) const PUB_HOST: &str = "doh.pub";
pub(crate) const PUB_BOOTSTRAP: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(120, 53, 53, 53)), 443),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 12, 12, 12)), 443),
];
pub(crate) const CF_HOST: &str = "cloudflare-dns.com";
pub(crate) const CF_BOOTSTRAP: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)), 443),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 0, 0, 1)), 443),
];
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
/// DoH 结果缓存：5 分钟（报告 B 节）。DNS 污染是「每次解析都被带偏」，
/// 缓存住正确结果才能让首页连续几个请求都走同一条正路，而不是每请求再赌一次。
const RESOLVE_CACHE_TTL: Duration = Duration::from_secs(300);

static RESOLVED: Lazy<Mutex<HashMap<String, (Instant, Vec<SocketAddr>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// 取 5 分钟内的 DoH 结果（含端口，A 记录）。
pub(crate) fn cache_get(host: &str, port: u16) -> Option<Vec<SocketAddr>> {
    let now = Instant::now();
    let cache = RESOLVED.lock().ok()?;
    let (at, addrs) = cache.get(&cache_key(host, port))?;
    (now.duration_since(*at) < RESOLVE_CACHE_TTL).then(|| addrs.clone())
}

pub(crate) fn cache_put(host: &str, port: u16, addrs: &[SocketAddr]) {
    if addrs.is_empty() {
        return;
    }
    let Ok(mut cache) = RESOLVED.lock() else { return };
    let now = Instant::now();
    cache.retain(|_, (at, _)| now.duration_since(*at) < RESOLVE_CACHE_TTL);
    if cache.len() >= 64 {
        cache.clear();
    }
    cache.insert(cache_key(host, port), (now, addrs.to_vec()));
}

pub(crate) fn cache_clear() {
    if let Ok(mut cache) = RESOLVED.lock() {
        cache.clear();
    }
}

#[derive(Default)]
pub(crate) struct Routes(HashMap<String, Instant>);

impl Routes {
    pub(crate) fn prefers_public(&self, host: &str, now: Instant) -> bool {
        self.0.get(host).is_some_and(|expires| now < *expires)
    }

    pub(crate) fn remember(&mut self, host: &str, now: Instant) {
        self.0.retain(|_, expires| now < *expires);
        if self.0.len() >= 64 {
            self.0.clear();
        }
        self.0
            .insert(host.to_string(), now + Duration::from_secs(30));
    }

    pub(crate) fn forget(&mut self, host: &str) {
        self.0.remove(host);
    }
}

pub(crate) fn eligible(target: &url::Url, error: &str) -> bool {
    target.scheme() == "https"
        && matches!(target.host(), Some(url::Host::Domain(_)))
        && matches!(
            crate::playback_log::error_kind(error),
            "dns_error" | "timeout" | "transport_error" | "private_address_denied"
        )
}

pub(crate) struct Resolution {
    pub(crate) addresses: Vec<SocketAddr>,
    pub(crate) ttl: Duration,
}

fn answers(value: &Value, port: u16) -> Result<Resolution, String> {
    if value["Status"].as_u64() != Some(0) {
        return Err("备用 DNS 解析失败".into());
    }
    let records = value["Answer"].as_array().ok_or("备用 DNS 没有可用地址")?;
    let mut addresses = Vec::new();
    let mut ttl = 30;
    for record in records {
        ttl = ttl.min(record["TTL"].as_u64().unwrap_or(0));
        if record["type"].as_u64() != Some(1) {
            continue;
        }
        let ip: Ipv4Addr = record["data"]
            .as_str()
            .ok_or("备用 DNS 地址无效")?
            .parse()
            .map_err(|_| "备用 DNS 地址无效")?;
        if !network_policy::allowed_ip(ip.into()) || network_policy::is_fake_ip(ip.into()) {
            return Err("备用 DNS 返回内网或保留地址".into());
        }
        addresses.push(SocketAddr::new(ip.into(), port));
    }
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() || addresses.len() > 32 {
        return Err("备用 DNS 没有可用地址".into());
    }
    Ok(Resolution {
        addresses,
        ttl: Duration::from_secs(ttl),
    })
}

async fn resolve_json_endpoint(
    http: &reqwest::Client,
    endpoint: &str,
    host: &str,
    port: u16,
) -> Result<Resolution, String> {
    let mut response = http
        .get(endpoint)
        .header("Accept", "application/dns-json")
        .query(&[("name", host), ("type", "A")])
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|_| "备用 DNS 请求失败")?
        .error_for_status()
        .map_err(|_| "备用 DNS 服务不可用")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "备用 DNS 响应失败")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("备用 DNS 响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "备用 DNS 响应无效")?;
    answers(&value, port)
}

pub(crate) async fn resolve(
    http: &reqwest::Client,
    host: &str,
    port: u16,
) -> Result<Resolution, String> {
    resolve_json_endpoint(http, &format!("https://{HOST}/resolve"), host, port).await
}

pub(crate) async fn resolve_cloudflare(
    http: &reqwest::Client,
    host: &str,
    port: u16,
) -> Result<Resolution, String> {
    resolve_json_endpoint(http, &format!("https://{CF_HOST}/dns-query"), host, port).await
}

/// 腾讯 DoH（`doh.pub`）：同样支持 JSON 形式的 `/dns-query`。
pub(crate) async fn resolve_pub(
    http: &reqwest::Client,
    host: &str,
    port: u16,
) -> Result<Resolution, String> {
    resolve_json_endpoint(http, &format!("https://{PUB_HOST}/dns-query"), host, port).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_answers_keep_the_target_port_and_shortest_dns_ttl() {
        let result = answers(
            &json!({"Status":0,"Answer":[
                {"type":5,"data":"edge.example.","TTL":5},
                {"type":1,"data":"1.1.1.1","TTL":60},
                {"type":1,"data":"1.1.1.1","TTL":60}
            ]}),
            8443,
        )
        .unwrap();
        assert_eq!(result.addresses, vec!["1.1.1.1:8443".parse().unwrap()]);
        assert_eq!(result.ttl, Duration::from_secs(5));
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "198.18.0.1",
            "198.19.0.1",
            "240.0.0.1",
            "not-an-ip",
        ] {
            assert!(
                answers(
                    &json!({"Status":0,"Answer":[
                        {"type":1,"data":"1.1.1.1","TTL":60},
                        {"type":1,"data":ip,"TTL":60}
                    ]}),
                    443
                )
                .is_err(),
                "{ip}"
            );
        }
        for response in [json!({"Status":3}), json!({"Status":0,"Answer":[]})] {
            assert!(answers(&response, 443).is_err());
        }
    }

    #[test]
    fn recovery_only_applies_to_https_domains_and_connection_failures() {
        let url = url::Url::parse("https://media.example/list.m3u8?auth_key=secret").unwrap();
        for error in [
            "DNS 解析失败",
            "请求超时",
            "client error (Connect) ← operation timed out",
            "tls handshake eof",
            "禁止访问普通内网",
        ] {
            assert!(eligible(&url, error));
        }
        for error in [
            "HTTP 403 Forbidden",
            "HTTP 404 Not Found",
            "HTTP 503 Service Unavailable",
            "禁止访问应用内部协议主机名",
            "禁止 HTTPS 降级重定向",
        ] {
            assert!(!eligible(&url, error), "{error}");
        }
        for raw in [
            "http://media.example/video",
            "https://127.0.0.1/video",
            "https://[::1]/video",
        ] {
            assert!(!eligible(&url::Url::parse(raw).unwrap(), "请求超时"));
        }
    }

    #[test]
    fn recovered_hosts_expire_and_do_not_change_other_hosts() {
        let now = Instant::now();
        let mut routes = Routes::default();
        assert!(!routes.prefers_public("media.example", now));
        routes.remember("media.example", now);
        assert!(routes.prefers_public("media.example", now + Duration::from_secs(29)));
        assert!(!routes.prefers_public("other.example", now));
        assert!(!routes.prefers_public("media.example", now + Duration::from_secs(30)));
    }
}
