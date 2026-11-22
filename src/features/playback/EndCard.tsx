import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { Img } from "../../shared/ui/ui";
import { IRefresh } from "../../shared/ui/icons";
import type { VideoCard } from "../../shared/api/types";

/** 结束态（本剧看完）卡片：文案/排版与抽出来之前逐字一致，只是把数据与回调交给调用方。
 *  推荐池的轮换在 endPool.ts，这里只管显示。 */
export function EndCard({ title, totalEpisodes, recs, busy, hint, onRegen, onOpen, onReplay, onSwipeClose }: {
  title: string;
  totalEpisodes: number;
  recs: VideoCard[] | null;
  busy: boolean;
  /** 「已看完推荐池，从头再看」这类轻提示；空串不占位 */
  hint: string;
  onRegen: () => void;
  onOpen: (id: number) => void;
  onReplay: () => void;
  onSwipeClose: () => void;
}) {
  const swipe = useRef<{ x: number; y: number } | null>(null);
  /* 遮罩上的上下滑：语义与舞台上那条 seriesEnded 分支一致 —— **只关卡片、不切剧**。
     不复用完整的指针手势机是有意的：遮罩里的「换一批 / 推荐卡 / 重新看第 1 集」都是按钮，
     手势机里的单击兜底会顺手 toggle 播放，反而破坏按钮。所以这里只认纵向位移：
     ≥48px 且明显竖于横才关卡片，点按（位移≈0）一律放行给按钮的 click。 */
  const down = (e: ReactPointerEvent<HTMLDivElement>) => { swipe.current = { x: e.clientX, y: e.clientY }; };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dy = e.clientY - start.y, dx = e.clientX - start.x;
    if (Math.abs(dy) < 48 || Math.abs(dy) <= Math.abs(dx)) return;
    onSwipeClose();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center px-5" data-hg-control="endcard"
      /* touch-action: none 必须显式给：遮罩不在舞台层里，没有继承舞台的 touchAction，
         默认行为会把纵向滑动当成浏览器滚动 → 指针流被 pointercancel 掐断，
         下面的 onPointerUp 根本收不到（真机上就是「上滑关不掉卡片」）。 */
      style={{ touchAction: "none" }}
      onPointerDown={down} onPointerUp={up} onPointerCancel={() => { swipe.current = null; }}>
      <div className="hg-endcard w-full max-w-[340px] p-[18px] text-center">
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

        {/* 池子到底、回到开头时的一句话，避免用户以为「换一批」又给了同一批 */
        hint ? <p className="mt-2 text-[11px] text-white/45" role="status">{hint}</p> : null}

        {/* 主行动单独一行：全宽 44 高、r12、品牌渐变 + 1px 白内描边。
            「重新看第 1 集」必须真的回到第 1 集第 0 秒并起播：
            单集剧 pickEp(1) 是空操作（playKey 不变 → 不重载），所以走 VideoSurface 的
            rewind()（倒回 0 + 重新武装片尾兜底 + 起播），与进度条手动 seek 完全分开；
            多集剧照旧换集重载，换源期间先用封面垫住上一集尾帧。 */}
        <Button onClick={onReplay} className="hg-endcard-main mt-4 w-full pressable">重新看第 1 集</Button>
      </div>
    </div>
  );
}
