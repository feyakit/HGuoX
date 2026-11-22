import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { Img } from "../../shared/ui/ui";
import { IClose, IRefresh } from "../../shared/ui/icons";
import type { VideoCard } from "../../shared/api/types";

/** 结束态（本剧看完）卡片：文案/排版与抽出来之前逐字一致，只是把数据与回调交给调用方。
 *  推荐池的轮换在 endPool.ts，这里只管显示。 */
export function EndCard({ title, totalEpisodes, recs, busy, hint, onRegen, onOpen, onReplay, onClose }: {
  title: string;
  totalEpisodes: number;
  recs: VideoCard[] | null;
  busy: boolean;
  /** 「已看完推荐池，从头再看」这类轻提示；空串不占位 */
  hint: string;
  onRegen: () => void;
  onOpen: (id: number) => void;
  onReplay: () => void;
  /** 关掉卡片回到当前画面：右上 × / 点卡片外空白 / 上下滑，三条路都走这一个回调 */
  onClose: () => void;
}) {
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /* 遮罩上的三条退路（v3.0.11 补热区）：
       · 上下滑：≥48px 且明显竖于横 → 关闭（语义与舞台上那条 seriesEnded 分支一致，只关卡片不切剧）；
       · 点空白：位移 <10px 且落点在卡片之外 → 关闭；
       · 右上 ×：显式按钮。
     不复用完整的指针手势机是有意的：遮罩里的「换一批 / 推荐卡 / 重新看第 1 集」都是按钮，
     手势机里的单击兜底会顺手 toggle 播放，反而破坏按钮。所以点按只认「不在卡片里」这一种。 */
  const down = (e: ReactPointerEvent<HTMLDivElement>) => { swipe.current = { x: e.clientX, y: e.clientY }; };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dy = e.clientY - start.y, dx = e.clientX - start.x;
    if (Math.abs(dy) >= 48 && Math.abs(dy) > Math.abs(dx)) { onClose(); return; }
    if (Math.abs(dy) < 10 && Math.abs(dx) < 10) {
      const card = cardRef.current;
      if (!card || !card.contains(e.target as Node)) onClose();
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center px-5" data-hg-control="endcard"
      /* touch-action: none 必须显式给：遮罩不在舞台层里，没有继承舞台的 touchAction，
         默认行为会把纵向滑动当成浏览器滚动 → 指针流被 pointercancel 掐断，
         下面的 onPointerUp 根本收不到（真机上就是「上滑关不掉卡片」）。 */
      style={{ touchAction: "none" }}
      onPointerDown={down} onPointerUp={up} onPointerCancel={() => { swipe.current = null; }}>
      <div ref={cardRef} className="hg-endcard relative w-full max-w-[340px] p-[18px] text-center">
        {/* 右上角显式关闭：视觉 32×32、热区 44×44（::after 撑，见 index.css）。
            绝对定位，卡片内既有元素一个都不挪位置；没有它时这张卡只有「上下滑」一条退路，
            用户找不到出口（真机反馈「关不掉」）。 */}
        <button type="button" className="hg-endcard-x" aria-label="关闭" title="关闭" onClick={onClose}>
          <IClose size={14} />
        </button>
        <p className="flex items-center justify-center gap-2 text-[15px] font-bold text-white">
          <span className="hg-endcard-bar" aria-hidden="true" />本剧已看完
        </p>
        <p className="mt-1 text-[13px] font-semibold text-white/85 clamp-1">{title}</p>
        <p className="mt-0.5 text-[12px] text-white/45">共 {totalEpisodes || 1} 集</p>

        {/* 推荐区：标题行右侧是「换一批」文字链（次行动不再占一整条按钮） */}
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[12px] font-medium text-white/45">你可能还想看</span>
          <Button onClick={onRegen} disabled={busy}
            className="hg-endcard-more flex items-center gap-1 pressable">
            <IRefresh size={12} />换一批
          </Button>
        </div>

        {busy ? (
          <div className="mt-3 flex items-center justify-center py-5"><Loader label="正在找同类剧" /></div>
        ) : (recs && recs.length > 0) ? (
          /* 不足 3 部时左对齐换行，不留空位；卡片宽 = 1/3 - gap */
          <div className="mt-2 flex flex-wrap items-start" style={{ gap: 8 }}>
            {recs.slice(0, 3).map((v) => (
              <Button key={v.id} card aria-label={`看《${v.title}》`} onClick={() => onOpen(v.id)}
                className="hg-reccard text-left min-w-0"
                style={{ width: "calc((100% - 16px) / 3)" }}>
                <span className="relative block w-full overflow-hidden rounded-lg" style={{ paddingTop: "133.3333%" }}>
                  <span className="hg-reccard-fallback" aria-hidden="true">{(v.title || "").trim().slice(0, 1)}</span>
                  <Img src={v.cover} alt="" />
                </span>
                <span className="mt-1 block text-[12px] leading-[1.35] text-white/90 clamp-2">{v.title}</span>
                <span className="block text-[11px] text-white/45">
                  {(v.total_episodes || v.episode_count) ? `共 ${v.total_episodes || v.episode_count} 集` : ""}
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[12px] text-white/45">暂无更多推荐</p>
        )}

        {/* 池子到底、回到开头时的一句话，避免用户以为「换一批」又给了同一批 */}
        {hint ? <p className="mt-2 text-[11px] text-white/45" role="status">{hint}</p> : null}

        {/* 主行动单独一行：全宽 44 高、r12、品牌渐变 + 1px 白内描边。
            「重新看第 1 集」必须真的回到第 1 集第 0 秒并起播：
            单集剧 pickEp(1) 是空操作（playKey 不变 → 不重载），所以走 VideoSurface 的
            rewind()（倒回 0 + 重新武装片尾兜底 + 起播），与进度条手动 seek 完全分开；
            多集剧照旧换集重载，换源期间先用封面垫住上一集尾帧。 */}
        <Button onClick={onReplay} className="hg-endcard-main mt-4 w-full pressable">重新看第 1 集</Button>

        {/* 次行动：与右上 × 同义的显式出口（复用 3.0.6 就有的 hg-endcard-ghost 样式，
            不给「只想关掉卡片」的人留一条找不到的退路）。 */}
        <Button onClick={onClose} className="hg-endcard-ghost mt-2 w-full pressable">返回继续看</Button>
      </div>
    </div>
  );
}
