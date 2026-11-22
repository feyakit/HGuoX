import { createRoot } from "react-dom/client";
import { MediaCard, Masonry, RowCard } from "../src/shared/ui/cards";
import type { VideoCard } from "../src/shared/api/types";
import "../src/index.css";

// 上游 40acd51 回归：海报角标（原创 / 热播 / 新片）。
//   契约 1：只有 is_original / is_hot / new_at(或 created_at) 为真才出角标，顺序固定。
//   契约 2：new_at 超过 72 小时不出「新片」；没有时间戳的老数据也不编。
//   契约 3：角标几何 = 左上 9px、高 22px，且不压住底部「集数 | 播放量」一行。
//   契约 4：「我的」收藏页那种单一 badge（新更 N 集）路径不受影响。
const now = Math.floor(Date.now() / 1000);

const base = { tags: ["都市"], author: { name: "作者" }, hot: 187000, like_count: 0, collect_count: 0, comment_count: 0, total_episodes: 0, episode_count: 12 } as unknown as VideoCard;

const videos: VideoCard[] = [
  { ...base, id: 1, title: "全角标", cover: "", score: 8.7, is_finished: false, is_original: 1, is_hot: 1, new_at: now - 3600 } as VideoCard,
  { ...base, id: 2, title: "只热播", cover: "", score: 9.1, is_finished: true, is_original: 0, is_hot: 1, new_at: now - 100 * 3600 } as VideoCard,
  { ...base, id: 3, title: "无角标", cover: "", score: 0, is_finished: false, is_original: 0, is_hot: 0 } as VideoCard,
  { ...base, id: 4, title: "刚创建", cover: "", score: 0, is_finished: false, is_original: 0, is_hot: 0, created_at: new Date((now - 7200) * 1000).toISOString() } as VideoCard,
];

function Harness() {
  return (
    <div>
      <Masonry videos={videos} onOpen={() => {}} wide={false} />
      <div id="legacy-pill">
        <MediaCard title="收藏页卡片" cover="" badge="新更 3 集" badgeTone="update" onOpen={() => {}} />
      </div>
      <div id="row-card"><RowCard v={videos[0]} onOpen={() => {}} /></div>
    </div>
  );
}

createRoot(document.querySelector("#root")!).render(<Harness />);
