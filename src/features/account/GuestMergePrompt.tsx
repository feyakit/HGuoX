import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { Modal } from "../../shared/ui/ui";
import { useStore } from "../../shared/model/store";
import { logLine } from "../../shared/api/api";

/**
 * 游客本机数据 → 登录后的合并提示（非阻断）。
 *
 * 为什么要它：游客态在本机攒了收藏与观看记录，登录后「我的」显示的是账号的数据，
 * 那份本机记录看上去像"没了"（其实还在本地，切回游客才看得见）。
 * 这里做的是**问一句**：同步 = 逐条调用现有收藏/进度接口（串行、间隔 150ms、
 * 失败继续并如实汇总失败数）；暂不同步 = 本地原样保留，并在「我的」标"本机记录"。
 */
export default function GuestMergePrompt() {
  const { mergeOffer, acceptMerge, declineMerge } = useStore();
  /* 面板自己持有开合与计数：store 的 mergeOffer 在点「同步」后会立刻清空，
     但结果（成功/失败数）必须还看得见，所以不能直接拿它当 open。 */
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState({ favs: 0, history: 0 });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{ ok: number; fail: number } | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  /* 有新提示时打开并复位：上一次的进度/结果不能留在下一次 */
  useEffect(() => {
    if (!mergeOffer) return;
    setOpen(true);
    setOffer(mergeOffer);
    setBusy(false);
    setResult(null);
    setProgress({ done: 0, total: mergeOffer.favs + mergeOffer.history });
  }, [mergeOffer]);

  const total = offer.favs + offer.history;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    logLine(`[merge] 开始同步本机数据：收藏 ${offer.favs} 项 / 观看 ${offer.history} 条`);
    try {
      const r = await acceptMerge((done, all) => {
        if (mounted.current) setProgress({ done, total: all });
      });
      if (!mounted.current) return;
      const ok = r.okFavs + r.okHistory;
      const fail = r.failFavs + r.failHistory;
      setResult({ ok, fail });
      logLine(`[merge] 完成：成功 ${ok} / 失败 ${fail}`);
      /* 全部成功就收起面板；有失败留下结果，让用户看到真实失败数并可以重试 */
      if (!fail) window.setTimeout(() => { if (mounted.current) { setResult(null); setOpen(false); } }, 1200);
    } catch (error) {
      if (!mounted.current) return;
      setResult({ ok: 0, fail: total });
      logLine(`[merge] 失败：${(error as Error)?.message || String(error)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    /* 有失败过：数据仍在本地，关掉也要标「本机记录」；从未同步过：走 decline（保留本地） */
    if (result) { setResult(null); setOpen(false); return; }
    setResult(null);
    setOpen(false);
    declineMerge();
  };

  return (
    <Modal label="同步本机数据" open={open} onClose={close} width={360}>
      <div className="p-5">
        <div className="text-[16px] font-bold text-on">发现本机有数据</div>
        <p className="mt-2 text-[13px] leading-[1.6] text-on/70">
          本机有 <span className="font-semibold text-on">{offer.favs}</span> 项收藏、
          <span className="font-semibold text-on">{offer.history}</span> 条观看记录。
          要同步到当前账号吗？
        </p>
        <p className="mt-1 text-[12px] text-on/45">账号里已有的不会重复添加；同步失败的条目仍留在本机。</p>

        {busy && (
          <div className="mt-3 text-[13px] text-on/70" role="status">
            正在同步 {progress.done} / {progress.total}…
          </div>
        )}
        {result && (
          <div className="mt-3 text-[13px] text-on/80" role="status">
            {result.fail > 0
              ? `已同步 ${result.ok} 项，失败 ${result.fail} 项（失败的仍留在本机）`
              : `已同步 ${result.ok} 项到账号`}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <Button
            disabled={busy}
            onClick={close}
            className="pressable h-9 flex-1 rounded-(--r-ctl) bg-s3 text-[14px] text-on/80 disabled:opacity-60"
          >
            暂不同步
          </Button>
          <Button
            disabled={busy || (!!result && result.fail === 0)}
            onClick={run}
            className="pressable h-9 flex-1 rounded-(--r-ctl) bg-primary text-[14px] font-semibold text-on-primary disabled:opacity-60"
          >
            {busy ? "同步中…" : result && result.fail > 0 ? "重试剩余" : "同步"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
