import { Button, SegmentedControl, Surface, TextArea } from "../../shared/ui/ios/controls";
import { useEffect, useRef, useState } from "react";
import { api, APP_VERSION, hostOf, isMobile, logLine, type UpdateInfo } from "../../shared/api/api";
import { isBalanceVolumeSupported } from "../playback/balanceVolume";
import { useStore, type Tab } from "../../shared/model/store";
import { middleEllipsis } from "../../shared/lib/textFit";
import { Modal } from "../../shared/ui/ui";
import { clearDetailCache } from "../../shared/api/detailFast";
import LinePicker from "./LinePicker";
import ProxySettings from "./ProxySettings";
import { ContentPreferenceToggles } from "./ContentPreferencesSettings";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { autoLineEnabled, setAutoLine } from "../../shared/network/autoLine";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { copyPlaybackLog, initPlaybackLog, setPlaybackLog, tracePlayback, usePlaybackLog } from "../../shared/diagnostics/playbackDiagnostics";
import { formatNetDiag, shortVerdict } from "../../shared/diagnostics/netDiagReport";
import { copyText } from "../../shared/lib/clipboard";
import { IBack, IBoltF, IBroom, IClapper, IFileText, IHome, IInfo, ILockF, IList, ILink, ILogout, IRefresh, ISparkF, ISun, IVolMute, IVol } from "../../shared/ui/icons";

/* 设置页：7 组平铺（播放 / 内容偏好 / 网络 / 本地数据 / 播放诊断 / 账号 / 关于）
 *
 * 原来是六张可折叠卡 + 顶部概览卡：概览里的线路 chip 与「网络」卡重复，三个圆形
 * 快捷按钮又与下面同名卡重复，卡的摘要和徽标还常跟行内的值说同一句话。现在每组
 * 一张卡，行只有三种右侧形态（开关 / 值 + › / 仅 ›），同一个值全页只出现一次。
 *
 * 入口：Windows 侧栏「设置」、Android / iOS「我的」右上角齿轮 */
export default function Settings({ onBack }: { onBack: () => void; wide: boolean }) {
  const { user, logout, muteOnStartup, setMuteOnStartup, ambientGlow, setAmbientGlow, balanceVolume, setBalanceVolume, startupTab, setStartupTab, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity, toast, push } = useStore();
  const { preferences: contentPrefs } = useContentPreferences();
  const [about, setAbout] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [lineBase, setLineBase] = useState("");
  const [autoLineOn, setAutoLineOn] = useState(autoLineEnabled);
  const [autoLineBusy, setAutoLineBusy] = useState(false);
  const clearBusy = useRef(false);
  const [clearError, setClearError] = useState("");
  const [lineError, setLineError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  /** 应用内更新进行到哪一步（空串=没在更新） */
  const [updating, setUpdating] = useState("");
  const playbackLog = usePlaybackLog();
  const [copyingLog, setCopyingLog] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagReport, setDiagReport] = useState<string | null>(null);
  const [copyingReport, setCopyingReport] = useState(false);
  /* 退出登录：这一段壳（防连点 + 确认弹窗 + 失败红字）整块从「我的」页搬来，
     store 里的 logout 一份没动——这里不写第二份实现。 */
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutPending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { void initPlaybackLog(); }, []);

  const readLine = () => { api.lineState().then((state) => { setLineBase(state.base); setLineError(""); }).catch(() => setLineError("线路读取失败，点「播放源」重新选择")); };
  useEffect(() => {
    const sync = () => { readLine(); setAutoLineOn(autoLineEnabled()); };
    sync();
    window.addEventListener("hg:line-changed", sync);
    window.addEventListener("hg:auto-line-changed", sync);
    return () => {
      window.removeEventListener("hg:line-changed", sync);
      window.removeEventListener("hg:auto-line-changed", sync);
    };
  }, []);

  const confirmLogout = async () => {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLogoutBusy(true);
    setLogoutError("");
    try {
      await logout();
      if (mounted.current) setLogoutOpen(false);
    } catch (error) {
      if (mounted.current) setLogoutError(error instanceof Error ? error.message : "退出失败，请重试");
    } finally {
      logoutPending.current = false;
      if (mounted.current) setLogoutBusy(false);
    }
  };

  const checkUpdate = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const info = await api.checkUpdate();
      if (info.has_update) setUpdate(info);
      else toast(`已是最新版本 v${info.current}`, "ok");
    } catch (e) {
      toast((e as Error).message || "检查更新失败", "info");
    } finally {
      setChecking(false);
    }
  };
  /** 更新：用系统浏览器打开下载页，由系统/浏览器完成下载与安装。
   *
   * 不再自己下载 APK 并调安装器 —— 那条路在安卓上要额外过 FileProvider
   * 与「安装未知应用」授权，失败点多，体验并不比浏览器好。
   */
  const doUpdate = async () => {
    if (!update) return;
    setUpdating("打开中…");
    try {
      await api.openUrl(update.url);
    } catch (e) {
      await copyText(update.url)
        .then(() => toast("下载地址已复制，可在浏览器粘贴打开", "ok"))
        .catch(() => toast((e as Error).message || "打开失败", "info"));
    } finally {
      setUpdating("");
    }
  };

  const lineHost = lineBase ? hostOf(lineBase) : "";

  return (
    <div className="ios-page ios-settings-page hg-canvas absolute inset-0 flex flex-col">
      <span className="hg-aura" aria-hidden="true" />
      <div className="hg-set-header shrink-0 relative z-10">
        <Button onClick={onBack} aria-label="返回" className="ios-icon-button"><IBack size={20} /></Button>
      </div>
      <div className="ios-page-body flex-1 min-h-0 scroll-y">
        <div className="hg-set-column">
          <h1 className="ios-page-title">设置</h1>
          <p className="hg-set-status" title={lineHost || undefined}>
            {lineError || `${lineHost ? `当前线路 ${middleEllipsis(lineHost, 22)}` : "线路读取中…"} · ${autoLineOn ? "自动选线已开" : "手动选线"}`}
          </p>

          <SettingsGroup title="播放">
            <div className="ios-settings-row flex-wrap">
              <span className="ios-setting-icon"><IHome size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">启动时打开的页面</div>
                <div className="text-[12px] text-mut">下次启动生效；可设为直接进吃瓜、分类或我的</div>
              </div>
              <SegmentedControl className="w-full" aria-label="启动时打开的页面" activeIndex={(["home", "posts", "category", "profile"] as Tab[]).indexOf(startupTab)}>
                {([["home", "首页"], ["posts", "吃瓜"], ["category", "分类"], ["profile", "我的"]] as const).map(([value, label]) => (
                  <Button key={value} type="button" aria-pressed={startupTab === value} onClick={() => setStartupTab(value)}>{label}</Button>
                ))}
              </SegmentedControl>
            </div>
            <SettingsRow icon={<IVolMute size={16} />} title="启动时静音" sub="关闭后沿用上次音量"
              right={{ kind: "switch", on: muteOnStartup, onChange: setMuteOnStartup, label: "启动时静音" }} />
            <SettingsRow icon={<IBoltF size={16} />} title="播放源" sub="手动选线只作优先"
              right={{ kind: "nav" }} onClick={() => setLineOpen(true)} />
            <SettingsRow icon={<IRefresh size={16} />} title="自动选择线路" sub="关闭后只用手动线路"
              right={{
                kind: "switch", on: autoLineOn, disabled: autoLineBusy, label: "自动选择线路",
                onChange: (on) => {
                  if (autoLineBusy) return;
                  const previous = autoLineOn;
                  setAutoLineBusy(true);
                  setAutoLineOn(on);
                  void setAutoLine(on)
                    .then(() => {
                      toast(on ? "已开启自动选择线路" : "已关闭自动选线，可手动选择播放源", "info");
                    })
                    .catch(() => {
                      setAutoLineOn(previous);
                      toast(on ? "开启自动选线失败，请重试" : "关闭自动选线失败，请重试", "info");
                    })
                    .finally(() => setAutoLineBusy(false));
                },
              }} />
            <SettingsRow icon={<ISun size={16} />} title="微光效果" sub="画面颜色会轻微扩散到黑边，关闭可省电"
              right={{ kind: "switch", on: ambientGlow, onChange: setAmbientGlow, label: "微光效果" }} />
            {/* 平衡音量（POC，默认关）：只在移动端且内核支持 MSE + Web Audio 时出现 */}
            {isMobile && isBalanceVolumeSupported() && (
              <SettingsRow icon={<IVol size={16} />} title="平衡音量" sub="自动压低突然变大的音效，让台词更稳；音乐和现场内容可能被轻微压缩"
                right={{ kind: "switch", on: balanceVolume, onChange: setBalanceVolume, label: "平衡音量" }} />
            )}
          </SettingsGroup>

          <SettingsGroup title="内容偏好">
            <ContentPreferenceToggles />
            <SettingsRow icon={<IList size={16} />} title="屏蔽标签" sub="只影响本机展示"
              right={{ kind: "value", value: `${contentPrefs.blockedTags.length} 个` }}
              onClick={() => push({ kind: "settings-tags" })} />
          </SettingsGroup>

          <SettingsGroup title="网络">
            <ProxySettings />
            <SettingsRow icon={<ILockF size={16} />} title="严格安全模式"
              sub={cliRelaxed ? "已由 --no-strict 切到兼容模式" : "防投毒与内网探测"}
              right={{
                kind: "switch", on: strictSecurity, disabled: !strictSecurityReady || securityPending, label: "严格安全模式",
                onChange: (on) => {
                  void setStrictSecurity(on).then(() => {
                    toast(on ? "已开启严格安全模式" : "已切换为兼容模式（关闭激进清洗与守卫）", "info");
                  }).catch(() => toast("安全设置保存失败，已保持原模式", "info"));
                },
              }} />
            {/* 打不开时先点这里：把 DNS / 代理 / HTTP 结果复制给维护者 */}
            <SettingsRow icon={<ILink size={16} />} title={diagnosing ? "正在诊断…" : "网络诊断"}
              sub="DNS / 代理 / 连通性"
              disabled={diagnosing}
              right={{ kind: "nav" }}
              onClick={async () => {
                setDiagnosing(true);
                try {
                  const diag = await api.netDiag();
                  // 落盘走原始 JSON（便于脚本统计），复制给对方的是分段可读报告。
                  logLine(`[net_diag] ${JSON.stringify(diag)}`);
                  const http = (diag.http ?? {}) as { ms?: number; status?: number };
                  const dns = (diag.dns ?? {}) as { count?: number; has_fake_ip?: boolean };
                  const doh = (diag.doh ?? {}) as { addrs?: string[]; system_addrs?: string[]; source?: string; mismatch?: boolean };
                  const connect = (diag.connect ?? {}) as { addrs?: string[]; source?: string };
                  const env = (diag.env ?? {}) as Record<string, unknown>;
                  /* 3.0.14：把「系统解析 / DoH 解析 / 实际连接」三行地址写进播放诊断 ——
                     被污染的网络里，这三行是判定「到底卡在哪一层」的唯一证据。 */
                  tracePlayback("net.diag", {
                    verdict: String(diag.verdict ?? ""),
                    host: hostOf(String(diag.host ?? "")), http_status: http.status ?? null, http_ms: http.ms ?? null,
                    dns_count: dns.count ?? null, fake_ip: dns.has_fake_ip ?? null,
                    proxy: Object.values(env).some(Boolean), strict: strictSecurity,
                    system_ip: (doh.system_addrs ?? []).join(",") || null,
                    doh_ip: (doh.addrs ?? []).join(",") || null,
                    doh_source: doh.source ?? null, doh_mismatch: doh.mismatch ?? null,
                    connect_ip: (connect.addrs ?? []).join(",") || null, connect_source: connect.source ?? null,
                  });
                  const report = formatNetDiag(diag);
                  /* 3.0.14：报告永远显示出来（不只是复制）。
                     被污染的网络里「系统解析 / DoH 解析 / 实际连接」必须能当场看见，
                     否则用户只知道「已复制」，看不到到底卡在哪一层。 */
                  setDiagReport(report);
                  try {
                    await copyText(report);
                    toast(`诊断已复制 · ${shortVerdict(diag)}`, "ok");
                  } catch {
                    toast("诊断已完成，可在报告里手动复制", "info");
                  }
                } catch (e) {
                  const detail = e instanceof Error ? e.message : typeof e === "string" ? e : "请稍后重试";
                  toast(`网络诊断失败：${detail}`, "info");
                } finally {
                  setDiagnosing(false);
                }
              }} />
          </SettingsGroup>

          <SettingsGroup title="本地数据">
            <SettingsRow icon={<IBroom size={16} />} title="清理缓存" sub="封面与分片缓存；收藏保留"
              right={{ kind: "nav" }} onClick={() => { setClearError(""); setClearOpen(true); }} />
          </SettingsGroup>

          <SettingsGroup title="播放诊断">
            <SettingsRow icon={<IClapper size={16} />} title="播放诊断日志"
              sub={playbackLog.error || "额外记录缓冲与拖动"}
              right={{
                kind: "switch", on: playbackLog.enabled, disabled: !playbackLog.ready || playbackLog.pending, label: "播放诊断日志",
                onChange: (on) => {
                  void setPlaybackLog(on)
                    .then(() => toast(on ? "已开启播放诊断，请复现问题" : "已关闭播放诊断，已有日志保留", "ok"))
                    .catch(() => toast("日志设置保存失败，请重试", "info"));
                },
              }} />
            <SettingsRow icon={<IFileText size={16} />} title={copyingLog ? "正在复制…" : "复制播放日志"}
              sub="含版本、平台与失败原因"
              disabled={!playbackLog.ready || playbackLog.pending || copyingLog}
              right={{ kind: "nav" }}
              onClick={async () => {
                setCopyingLog(true);
                try { await copyPlaybackLog(); toast("播放诊断日志已复制", "ok"); }
                catch (e) { toast((e as Error).message || "复制日志失败", "info"); }
                finally { setCopyingLog(false); }
              }} />
            {playbackLog.path && (
              <details className="hg-set-log-path">
                <summary>查看日志保存位置</summary>
                <p>{playbackLog.path}</p>
              </details>
            )}
          </SettingsGroup>

          {user && (
            <SettingsGroup title="账号">
              <SettingsRow icon={<ILogout size={16} />} title="退出登录" danger
                sub={`${user.nickname || user.username} · 本机进度保留`}
                right={{ kind: "nav" }}
                onClick={() => { setLogoutError(""); setLogoutOpen(true); }} />
            </SettingsGroup>
          )}

          <SettingsGroup title="关于">
            <SettingsRow icon={<ISparkF size={16} />} title={checking ? "正在检查更新…" : "检查更新"}
              sub={update?.has_update ? "有新版本可下载" : "对比 GitHub Release"}
              disabled={checking}
              right={{ kind: "value", value: update?.has_update ? `v${update.latest}` : undefined }}
              onClick={checkUpdate} />
            <SettingsRow icon={<IInfo size={16} />} title="关于 HGuoX" sub="版本、许可与项目地址"
              right={{ kind: "value", value: `v${APP_VERSION}` }} onClick={() => setAbout(true)} />
          </SettingsGroup>
        </div>
      </div>

      <LinePicker open={lineOpen} onClose={() => { setLineOpen(false); readLine(); }} />

      <Modal label="网络诊断报告" open={diagReport !== null} onClose={() => setDiagReport(null)} width={520}>
        <div className="p-5">
          <h2 className="text-[15px] font-bold text-on">网络诊断报告</h2>
          <p className="text-[13px] text-mut mt-2">诊断已完成，自动复制未成功。可以重试复制，或在下方选择报告文字。</p>
          <TextArea readOnly aria-label="网络诊断报告" value={diagReport ?? ""}
            className="w-full h-64 mt-3 p-3 rounded-(--r-sm) bg-s3 text-[12px] text-on resize-none" />
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setDiagReport(null)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on pressable">关闭</Button>
            <Button disabled={copyingReport} onClick={async () => {
              if (diagReport === null) return;
              setCopyingReport(true);
              try { await copyText(diagReport); toast("网络诊断报告已复制", "ok"); setDiagReport(null); }
              catch { toast("复制失败，请选择报告文字手动复制", "info"); }
              finally { setCopyingReport(false); }
            }} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[14px] pressable disabled:opacity-60">{copyingReport ? "正在复制…" : "复制报告"}</Button>
          </div>
        </div>
      </Modal>

      <Modal label="关于 HGuoX" open={about} onClose={() => setAbout(false)} width={392}>
        <div className="p-5">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">H</span>
            <div>
              <div className="text-[16px] font-bold text-on leading-tight">HGuoX</div>
              <div className="text-[12px] text-mut mt-0.5">HGuoX 客户端 v{APP_VERSION}</div>
            </div>
          </div>

          <p className="text-[13px] text-on/70 leading-relaxed mt-4">
            基于 Rust + Tauri 2 构建的跨平台客户端，支持 Windows、macOS、Linux、Android 与 iOS。
            界面采用 iOS 圆角与玻璃材质风格，播放器采用沉浸式竖屏信息流。
          </p>

          <Surface className="mt-4 rounded-(--r-sm) bg-s3/60 p-3 text-[12px] text-mut leading-relaxed">
            仅限符合使用条款的成年人使用；禁止在中国大陆地区下载和传播本软件及相关资源。
            第三方内容的权利属于各自权利人，访问内容不代表获得下载或传播授权。
          </Surface>

          <div className="mt-4 divide-y divide-s3">
            <Button aria-label="打开项目仓库" onClick={() => { api.openUrl("https://github.com/feyakit/HGuoX").catch(() => { copyText("https://github.com/feyakit/HGuoX").then(() => toast("仓库地址已复制", "ok")).catch(() => {}); }); }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable">
              <ILink size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">github.com/feyakit/HGuoX</span>
              <span className="ml-auto text-[12px] text-primary">打开</span>
            </Button>
            <Button onClick={() => { copyText("https://huangguoai.com").then(() => toast("站点地址已复制", "ok")).catch(() => {}); }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable">
              <ILink size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">huangguoai.com</span>
              <span className="ml-auto text-[12px] text-primary">复制</span>
            </Button>
            <div className="flex items-center gap-2 py-2.5">
              <IInfo size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">PolyForm Noncommercial 1.0.0</span>
              <span className="ml-auto text-[12px] text-mut">仅限非商业</span>
            </div>
          </div>

          <Button onClick={() => setAbout(false)} className="mt-4 w-full h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on pressable">知道了</Button>
        </div>
      </Modal>

      <Modal label="清理缓存" open={clearOpen} onClose={() => { if (!clearBusy.current) setClearOpen(false); }} width={330}>
        <div className="p-5">
          <div className="text-[15px] font-bold text-on">清理缓存</div>
          <p className="text-[13px] text-mut leading-relaxed mt-2">
            清除封面、播放列表、Key/分片缓存；Linux 桌面版还会选择性清理 WebKit HTTP/媒体磁盘缓存。登录、收藏、观看记录与本地设置都会保留。
          </p>
          {clearError && <p role="alert" className="text-[13px] text-danger mt-3">{clearError}</p>}
          <div className="flex gap-2 mt-5">
            <Button disabled={clearing} onClick={() => setClearOpen(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on/80 pressable">取消</Button>
            <Button disabled={clearing} onClick={async () => {
              if (clearBusy.current) return;
              clearBusy.current = true;
              setClearing(true); setClearError("");
              try {
                const cleared = await api.clearCache();
                /* 详情磁盘缓存（SWR）也一起清，否则"清理缓存"名不副实 */
                clearDetailCache();
                setClearOpen(false);
                toast(cleared.webCache ? "缓存已清理（含 WebKit 媒体缓存）" : "应用内缓存已清理", "ok");
              } catch (error) {
                setClearError(error instanceof Error ? error.message : String(error || "清理失败，请重试"));
              } finally { clearBusy.current = false; setClearing(false); }
            }} className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[14px] font-semibold text-on-primary pressable disabled:opacity-60">
              {clearing ? "清理中…" : "确定清理"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal label="发现新版本" open={!!update?.has_update} onClose={() => setUpdate(null)} width={392}>
        <div className="p-5">
          <div className="text-[16px] font-bold text-on">发现新版本</div>
          <p className="text-[12px] text-mut mt-1.5">
            v{update?.current} → <b className="text-on">v{update?.latest}</b>
            {update?.published_at ? ` · ${update.published_at.slice(0, 10)}` : ""}
          </p>
          {!!update?.notes && (
            <Surface className="mt-3 max-h-[180px] scroll-y rounded-(--r-sm) bg-s2 p-3 text-[12px] text-mut whitespace-pre-wrap leading-relaxed">{update.notes}</Surface>
          )}
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setUpdate(null)} disabled={!!updating}
              className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on/80 pressable disabled:opacity-60">稍后</Button>
            <Button onClick={() => void doUpdate()} disabled={!!updating}
              className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[14px] font-semibold text-on-primary pressable disabled:opacity-60">
              {updating || "前往下载"}
            </Button>
          </div>
          <details className="text-[12px] text-mut mt-2.5"><summary className="py-3 cursor-pointer">下载地址</summary><p className="break-all select-text">{update?.url}</p></details>
        </div>
      </Modal>

      <Modal open={logoutOpen} onClose={() => { if (!logoutPending.current) setLogoutOpen(false); }} label="退出登录">
        <div className="p-5">
          <h2 className="text-[18px] font-bold">退出登录</h2>
          <p className="mt-2 text-[14px] text-mut">退出当前账户？账号数据和本机进度会保留，退出后显示游客的本机记录。</p>
          {logoutError && <p role="alert" className="mt-3 text-[13px] text-danger">{logoutError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={logoutBusy} onClick={() => setLogoutOpen(false)} className="flex-1">取消</Button>
            <Button variant="danger" disabled={logoutBusy} onClick={() => void confirmLogout()} className="flex-1 rounded-(--r-ctl) px-3">
              {logoutBusy ? "正在退出…" : "确认退出"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
