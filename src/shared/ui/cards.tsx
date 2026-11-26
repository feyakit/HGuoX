import { fmt } from "../api/api";
import type { VideoCard } from "../api/types";
import { ICheck, IHeartF, IPlayF } from "./icons";
import { Img } from "./ui";
import { Button } from "./ios/controls";
import { FilteredContent } from "./FilteredContent";
import { useLongPress } from "../lib/useLongPress";

/* 上游 40acd51：海报角标。真数据来源只有三个——`is_original`、`is_hot`、`new_at`
   （官网 SSR 的「新片」标记带 data-new-at；老 JSON 接口没有这个字段时退到 created_at）。
   取不到时间就不显示「新片」，宁可少一个角标也不编一个。 */
const NEW_BADGE_WINDOW_SECONDS = 72 * 3600;
const NEW_BADGE_CLOCK_SKEW_SECONDS = 600;

export type CornerBadge = { label: string; tone: "original" | "hot" | "new" };

/** `created_at` 在本项目里既有 "2025-11-20 08:30:00" 也有 ISO 串，两种都吃。 */
function createdAtEpoch(raw?: string): number {
  const text = (raw ?? "").trim();
  if (!text) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
    ? `${text.slice(0, 10)}T${text.slice(11)}${text.length === 16 ? ":00" : ""}`
    : text;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function isNewRelease(v: VideoCard): boolean {
  const at = typeof v.new_at === "number" && Number.isFinite(v.new_at) && v.new_at > 0
    ? v.new_at
    : createdAtEpoch(v.created_at);
  if (!at) return false;
  /* 官网只给了「新片」标记、没给时间戳时用 1 当哨兵：标记本身是官网数据，照显。 */
  if (at === 1) return true;
  const age = Math.floor(Date.now() / 1000) - at;
  return age >= -NEW_BADGE_CLOCK_SKEW_SECONDS && age < NEW_BADGE_WINDOW_SECONDS;
}

function videoCornerBadges(v: VideoCard): CornerBadge[] {
  const badges: CornerBadge[] = [];
  if (Number(v.is_original) === 1) badges.push({ label: "原创", tone: "original" });
  if (Number(v.is_hot) === 1) badges.push({ label: "热播", tone: "hot" });
  if (isNewRelease(v)) badges.push({ label: "新片", tone: "new" });
  return badges;
}

export function MediaCard({ title, cover, subtitle, badge, badgeTone = "default", cornerBadges, progress, priority = false, onOpen, blockedReason, onLongPress, selectionMode = false, selected = false }: {
  title: string; cover: string; subtitle?: string; badge?: string; progress?: string; score?: number; priority?: boolean; onOpen: () => void; blockedReason?: string | null;
  badgeTone?: "default" | "update"; onLongPress?: () => void; selectionMode?: boolean; selected?: boolean;
  /* 上游 40acd51：封面角标（原创 / 热播 / 新片）。放在右上内角，不动任何既有元素。 */
  cornerBadges?: CornerBadge[];
}) {
  /* 多选入口（上游 #168）：长按或电脑右键进入，长按余波的那次 click 要吞掉。 */
  const { longPressProps, consumeSuppressedClick } = useLongPress(onLongPress);
  const open = () => {
    if (consumeSuppressedClick()) return;
    onOpen();
  };
  const selection = selectionMode
    ? <span className="ios-poster-select" aria-hidden="true">{selected && <ICheck size={16} strokeWidth={2.4} />}</span>
    : null;
  const className = `ios-poster${onLongPress ? " has-long-press" : ""}${selected ? " is-selected" : ""}`;
  const ariaLabel = selectionMode ? `${selected ? "取消选择" : "选择"}${title}` : title;
  const pressed = selectionMode ? selected : undefined;

  if (blockedReason) return <Button onClick={open} className={className}
    aria-label={selectionMode ? ariaLabel : "该内容命中屏蔽标签，查看提示"} aria-pressed={pressed} {...longPressProps}>
    <span className="ios-poster-art flex flex-col items-center justify-center gap-3 px-3 text-center text-mut">
      <span className="text-[14px] font-semibold">该内容命中屏蔽标签</span>
      <span className="text-[12px] break-words">{blockedReason}</span>
      <span className="text-[13px] text-primary">查看提示</span>
      {selection}
    </span>
    <span className="ios-poster-title">已屏蔽内容</span>
    {progress && <span className="ios-poster-subtitle">{progress}</span>}
  </Button>;
  const flags = cornerBadges && cornerBadges.length && !selectionMode
    ? <span className="ios-poster-badges">
        {cornerBadges.map(item => (
          <span key={item.tone} className={`ios-poster-flag is-${item.tone}`}>{item.label}</span>
        ))}
      </span>
    : null;
  return <Button onClick={open} className={className} aria-label={ariaLabel} aria-pressed={pressed} {...longPressProps}>
    <span className={`ios-poster-art ${badge ? "has-poster-badge" : ""}`}>
      <Img src={cover} alt="" eager={priority} />
      {badge && <span className={`ios-poster-badge${badgeTone === "update" ? " is-update" : ""}`}>{badge}</span>}
      {flags}
      {progress && <span className="ios-poster-progress"><IPlayF size={12} />{progress}</span>}
      <span className="ios-poster-play" aria-hidden="true"><IPlayF size={23} /></span>
      {selection}
    </span>
    <span className="ios-poster-title">{title}</span>
    {subtitle && <span className="ios-poster-subtitle">{subtitle}</span>}
  </Button>;
}

function completedEpisodeLabel(v: { total_episodes?: number; episode_count?: number }): string {
  const total = Number(v.total_episodes) > 0 ? Number(v.total_episodes) : Number(v.episode_count);
  return total > 0 ? `全 ${total} 集` : "已完结";
}

export function WaterfallCard({ v, onOpen, priority = false }: { v: VideoCard; onOpen: () => void; priority?: boolean }) {
  return <MediaCard title={v.title} cover={v.cover} onOpen={onOpen} priority={priority} score={v.score}
    cornerBadges={videoCornerBadges(v)}
    badge={v.is_finished ? completedEpisodeLabel(v) : `更新至 ${v.episode_count} 集`}
    subtitle={v.tags?.slice(0, 2).join(" · ") || v.author?.name || "HGuoX"}
    progress={`${fmt(v.hot)} 次播放`} />;
}

export function Masonry({ videos, onOpen, wide = false, scopeKey }: {
  videos: VideoCard[]; onOpen: (v: VideoCard) => void; wide?: boolean; gap?: string; scopeKey?: string | number;
}) {
  return <FilteredContent items={videos} scopeKey={scopeKey}>{visible => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`} data-ui="media-grid">
    {visible.map((v, index) => <WaterfallCard key={v.id} v={v} priority={index < 2} onOpen={() => onOpen(v)} />)}
  </div>}</FilteredContent>;
}

export function RowCard({ v, onOpen }: { v: VideoCard; onOpen: () => void }) {
  return <div className="ios-row-card"><MediaCard title={v.title} cover={v.cover} score={v.score} onOpen={onOpen}
    cornerBadges={videoCornerBadges(v)}
    badge={v.is_finished ? completedEpisodeLabel(v) : `${v.episode_count} 集`}
    subtitle={v.score ? `${v.score.toFixed(1)} 分 · ${v.tags?.[0] || "短剧"}` : v.tags?.slice(0, 2).join(" · ")} />
  </div>;
}

export function RankRow({ item, onOpen }: {
  item: { rank: number; video_id: number; title: string; cover: string; tags: string[]; score: number; cate_name?: string; episode_count?: number; total_episodes?: number; is_finished?: boolean; metric_value: number; metric_label: string };
  onOpen: () => void; metricMax?: number;
}) {
  const rankTier = item.rank === 1 ? "is-first" : item.rank === 2 ? "is-second" : item.rank === 3 ? "is-third" : "";
  const summary = [
    item.cate_name,
    item.is_finished ? completedEpisodeLabel(item) : item.episode_count ? `更新至 ${item.episode_count} 集` : "",
    item.metric_label,
  ].filter(Boolean).join(" · ");
  return <Button card className="hg-rank-row" onClick={onOpen}>
    <span className={`hg-rank-no ${rankTier}`}>{item.rank}</span>
    <span className="hg-rank-cover"><Img src={item.cover} /></span>
    <span className="hg-rank-copy">
      <span className="hg-rank-title">{item.title}</span>
      {!!item.tags?.length && (
        <span className="hg-rank-tags">
          {item.tags.slice(0, 3).map(t => <span key={t} className="hg-rank-tag">{t}</span>)}
        </span>
      )}
      <span className="hg-rank-desc">{summary}</span>
    </span>
  </Button>;
}
