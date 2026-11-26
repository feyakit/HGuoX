import type { VideoCard } from "../api/types";

export type VideoSortMetric = "default" | "likes" | "favorites" | "hot" | "score";
export type VideoSortDirection = "desc" | "asc";
export type SerializationStatusFilter = "all" | "ongoing" | "finished";

export const VIDEO_SORT_OPTIONS: readonly { key: VideoSortMetric; label: string }[] = [
  { key: "default", label: "默认" },
  { key: "hot", label: "播放量" },
  { key: "score", label: "评分" },
  { key: "likes", label: "点赞数" },
  { key: "favorites", label: "收藏数" },
];

export const SERIALIZATION_FILTER_OPTIONS: readonly { key: SerializationStatusFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "ongoing", label: "连载中" },
  { key: "finished", label: "已完结" },
];

function metricValue(v: VideoCard, metric: VideoSortMetric): number {
  switch (metric) {
    case "likes": return Number(v.like_count) || 0;
    case "favorites": return Number(v.collect_count) || 0;
    case "hot": return Number(v.hot) || 0;
    case "score": return Number(v.score) || 0;
    default: return 0;
  }
}

export function filterVideosByStatus(videos: VideoCard[], status: SerializationStatusFilter): VideoCard[] {
  if (status === "all") return videos;
  return videos.filter((v) => (status === "finished" ? !!v.is_finished : !v.is_finished));
}

export function sortVideosByMetric(
  videos: VideoCard[],
  metric: VideoSortMetric,
  direction: VideoSortDirection = "desc",
): VideoCard[] {
  if (metric === "default" || videos.length <= 1) return videos;
  const sign = direction === "asc" ? 1 : -1;
  return videos
    .map((video, index) => ({ video, index, value: metricValue(video, metric) }))
    .sort((a, b) => (a.value - b.value) * sign || a.index - b.index)
    .map((entry) => entry.video);
}
