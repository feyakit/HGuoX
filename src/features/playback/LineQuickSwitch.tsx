import { useEffect, useState } from "react";
import { api, hostOf, type LineItem } from "../../shared/api/api";
import { useStore } from "../../shared/model/store";
import { pauseAutoPick } from "../../shared/network/autoLine";
import { setPreferredLine } from "../../shared/network/linePreference";
import { Button } from "../../shared/ui/ios/controls";
import { Sheet } from "../../shared/ui/ui";
import { ICheck, IChevR, IClose } from "../../shared/ui/icons";
import { domainFamily, readProbe } from "../../shared/network/lineProbeCache";

/**
 * 播放页就地切线路：只列线路、点一下即切换、切完自动收面板。
 * 不跳设置页、不暴露自定义地址与检测（那些留给「我的 · 网络与线路」）。
 * 入口由调用方自己决定渲不渲染（只有一条线路时不渲染）。
 */
/**
 * 线路判等（审计 #3）：同一行在线路数据里会出现 `https://x.cc` / `https://x.cc/` /
 * 大小写不同的写法。按原始字符串比较时「当前这一行」认不出来 —— 点下去会重复
 * lineSet + 重复派 hg:line-changed（播放器白换一次源）。这里按 host 小写 + 去尾斜杠比。
 */
const lineKey = (url: string) => {
  const raw = (url || "").trim().replace(/\/+$/, "");
  try {
    const u = new URL(raw);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.toLowerCase();
  }
};
const sameLine = (a: string, b: string) => !!a && !!b && lineKey(a) === lineKey(b);

export default function LineQuickSwitch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useStore();
  const [base, setBase] = useState("");
  const [fixed, setFixed] = useState<LineItem[]>([]);
  const [mirrors, setMirrors] = useState<LineItem[]>([]);
  const [busy, setBusy] = useState("");
  /* 分组折叠：默认只展开当前线路所在的域名族（39 行一次列完根本没法挑）。
     只记"用户手动改过的那几个"，没记过的按「是不是当前族」决定，省得等异步数据回来还要同步状态。 */
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    api.lineState()
      .then(s => { if (alive) { setBase(s.base); setFixed(s.fixed || []); } })
      .catch(() => { /* 读不到就只显示镜像 */ });
    api.lineMirrors()
      .then(r => { if (alive) setMirrors(r?.items || []); })
      .catch(() => { if (alive) setMirrors([]); });
    return () => { alive = false; };
  }, [open]);

  const pick = async (url: string) => {
    if (busy) return;
    if (!url || sameLine(url, base)) { onClose(); return; }
    setBusy(url);
    try {
      /* 手动选线 = 本次优先：取消在途的自动选线，但保持自动选线开着（见 docs/线路策略.md） */
      await pauseAutoPick();
      const next = await api.lineSet(url);
      setPreferredLine(next);
      /* 登录态交给 boot 裁决：可信线路间后端 rebase 保留登录，自定义站点后端已清会话 */
      setBase(next);
      toast(`线路已切换到 ${hostOf(next)}，已设为优先线路；不可用时会自动切走`, "ok");
      window.dispatchEvent(new Event("hg:line-changed"));
      onClose();
    } catch (e) {
      toast((e as Error).message || "切换失败", "info");
    } finally {
      setBusy("");
    }
  };

  /* 按 host 去重，不按原始 url：线上数据里同一台镜像会出现
     「https://ruc.zuxszoix.cc」和带尾斜杠/大小写不同的写法，按 url 去重会把
     8 个 host 渲染成 16 行（v3.0.6 #7 真机现象）。 */
  const seen = new Set<string>();
  const rows: { url: string; label: string; host: string; family: string }[] = [];
  for (const i of [...fixed, ...mirrors]) {
    if (!i?.url) continue;
    const key = (hostOf(i.url) || i.url).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ url: i.url, label: i.name?.trim() || hostOf(i.url), host: hostOf(i.url), family: domainFamily(i.url) });
  }

  /* 分组：同一域名族一组；组内按探活结果排序 —— 可用（延迟小的在前）→ 未测 → 不可用。
     延迟只用自动选线缓存的探活结果，没探过就显示「未测」，不编数字。 */
  const probeOf = (url: string) => readProbe(url);
  const rank = (url: string) => {
    const probe = probeOf(url);
    if (!probe) return 1;
    return probe.ok ? 0 : 2;
  };
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = groups.get(row.family) ?? [];
    list.push(row);
    groups.set(row.family, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const diff = rank(a.url) - rank(b.url);
      if (diff) return diff;
      return (probeOf(a.url)?.ms ?? 0) - (probeOf(b.url)?.ms ?? 0);
    });
  }
  const currentFamily = base ? domainFamily(base) : "";
  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === currentFamily) return -1;
    if (b[0] === currentFamily) return 1;
    return b[1].length - a[1].length;
  });
  const isOpen = (family: string) => openOverride[family] ?? (family === currentFamily);
  const toggle = (family: string) => setOpenOverride((prev) => ({ ...prev, [family]: !isOpen(family) }));
  const latency = (url: string) => {
    const probe = probeOf(url);
    if (!probe) return { text: "未测", cls: "text-dim" };
    if (!probe.ok) return { text: "不可用", cls: "text-rose-300/80" };
    return { text: `${probe.ms}ms`, cls: probe.ms <= 400 ? "text-mint" : "text-mut" };
  };

  return (
    <Sheet open={open} onClose={onClose} label="切换线路">
      <div className="flex flex-col" style={{ maxHeight: "60dvh" }}>
        <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-bold text-on leading-tight">切换线路</div>
            <div className="text-[12px] text-mut mt-0.5 truncate">当前：{base ? hostOf(base) : "读取中…"}</div>
          </div>
          <Button onClick={onClose} aria-label="关闭" className="w-9 h-9 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable">
            <IClose size={16} />
          </Button>
        </div>
        <div className="flex-1 scroll-y px-3 pb-4">
          {!rows.length && <div className="text-center text-[12px] text-dim py-8">正在读取线路…</div>}
          {ordered.map(([family, list]) => {
            const open = isOpen(family);
            const okCount = list.filter((row) => probeOf(row.url)?.ok).length;
            return (
              <div key={family} className="mb-1.5">
                {/* 域名族分组头：点击折叠/展开，默认只展开当前线路所在族 */}
                <Button card aria-expanded={open} aria-label={`${family} 分组，${list.length} 条${family === currentFamily ? "，当前线路" : ""}`}
                  onClick={() => toggle(family)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-(--r-md) bg-s3/40 pressable">
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block text-[13px] font-semibold text-on truncate">
                      {family}{family === currentFamily ? " · 当前" : ""}
                    </span>
                    <span className="block text-[11px] text-mut mt-0.5">
                      {list.length} 条{okCount ? ` · ${okCount} 条可用` : ""}
                    </span>
                  </span>
                  <span className={`shrink-0 text-mut transition-transform ${open ? "rotate-90" : ""}`}>
                    <IChevR size={14} />
                  </span>
                </Button>
                {open && list.map((item) => {
                  const current = sameLine(item.url, base);
                  const lat = latency(item.url);
                  return (
                    <Button key={item.url} card onClick={() => void pick(item.url)} disabled={!!busy}
                      className={`w-full flex items-center gap-2 px-3.5 py-3 rounded-(--r-md) mt-1 mb-1 text-left pressable ${current ? "bg-s3/70" : "bg-s2"}`}>
                      {/* 没有自定义名称时 label 就是域名，再渲染一行 host 会出现两行完全相同的字
                          （v3.0.6 真机：「nku.zuxszoix.cc」上下重复）。只有真有名称时才补第二行。 */}
                      <span className="flex-1 min-w-0">
                        <span className="block text-[14px] text-on truncate">{item.label}</span>
                        {item.host && item.host !== item.label ? (
                          <span className="block text-[12px] text-mut truncate mt-0.5">{item.host}</span>
                        ) : null}
                      </span>
                      <span className={`shrink-0 text-[11px] tabular-nums ${lat.cls}`}>{lat.text}</span>
                      {busy === item.url ? <span className="text-[12px] text-mut shrink-0">切换中…</span>
                        : current ? <ICheck size={15} className="text-mint shrink-0" /> : null}
                    </Button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
