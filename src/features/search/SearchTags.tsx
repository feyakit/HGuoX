import { useCallback, useEffect, useRef, useState } from "react";
import { api, logLine } from "../../shared/api/api";
import type { TagItem } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { IFireF, IRefresh } from "../../shared/ui/icons";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";

const BATCH_SIZE = 12;
const heat = (tag: TagItem) => Number.isFinite(tag.hot_score) ? tag.hot_score! : 0;
/** 官网首页 SSR 的题材只有名字（slug 是官网路由，标签页按中文名取，用不上）。 */
type HotTagChip = { name: string; is_hot?: boolean; hot_score?: number };

/** Use the catalog's actual tag names: keyword search is a different endpoint. */
export function SearchTags({ active }: { active: boolean }) {
  const { push } = useStore();
  const [tags, setTags] = useState<HotTagChip[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [batch, setBatch] = useState(0);
  const busy = useRef(false);
  const sequence = useRef(0);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const token = ++sequence.current;
    setLoading(true); setError("");
    try {
      /* 优先官网首页 SSR 的热门题材（上游 25d69b8 行为）：集合与顺序跟官网一致。
         首页结构变了 / 被墙 / 解析不到，才回退 /api/tags 的 is_hot + hot_score 排序。 */
      try {
        const hot = await api.hotTags();
        const names = (hot?.items ?? [])
          .map(item => (item?.name ?? "").trim())
          .filter(name => name.length > 0);
        if (names.length) {
          if (sequence.current !== token) return;
          loaded.current = true;
          setTags([...new Set(names)].map(name => ({ name, is_hot: true })));
          return;
        }
      } catch (error) {
        logLine(`[tags] 官网热门题材拉取失败，回退 /api/tags：${(error as Error)?.message ?? error}`);
      }
      const response = await api.tags();
      if (!Array.isArray(response?.categories)) throw new Error("标签数据格式异常，请重试");
      const sorted = response.categories.flatMap(group => Array.isArray(group.tags) ? group.tags : [])
        .filter(tag => typeof tag?.name === "string" && tag.name.trim().length > 0)
        .sort((a, b) => Number(!!b.is_hot) - Number(!!a.is_hot) || heat(b) - heat(a));
      const seen = new Set<string>();
      const unique = sorted.filter(tag => {
        if (seen.has(tag.name)) return false;
        seen.add(tag.name);
        return true;
      });
      if (sequence.current !== token) return;
      loaded.current = true;
      setTags(unique); setBatch(0);
    } catch (cause) {
      if (sequence.current === token) setError(cause instanceof Error ? cause.message : "标签加载失败，请重试");
    } finally {
      if (sequence.current === token) { busy.current = false; setLoading(false); }
    }
  }, []);

  useEffect(() => () => { sequence.current++; busy.current = false; }, []);
  useEffect(() => { if (active && !loaded.current) void load(); }, [active, load]);
  const count = tags?.length ?? 0;
  const visible = tags?.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE) ?? [];

  return <Surface role="region" aria-label="热门题材" aria-busy={loading}
    className="mt-5 rounded-(--r-md) p-3.5 a-rise"
    style={{ background: "rgba(255,255,255,0.038)", border: "1px solid rgba(255,255,255,0.075)" }}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-[14px] font-bold text-on"><IFireF size={15} className="text-primary" />热门题材</h2>
      <Button card onClick={() => push({ kind: "tags" })} className="hg-section-more">全部标签 ›</Button>
    </div>
    {error && <p role="status" className="mt-2 text-[12px] text-mut break-words">
      {count > 0 ? "刷新失败，保留已加载标签。" : "标签暂未加载成功。"}{error}
    </p>}
    {count > 0 ? <div className="flex flex-wrap gap-2 mt-3">
      {visible.map(tag => <Button card key={tag.name}
        onClick={() => push({ kind: "tag", tag: tag.name, name: tag.name })}
        className={`hg-tag-pill max-w-full whitespace-normal break-words text-left${tag.is_hot ? " is-hot" : ""}`}>
        <span className="hg-tag-hash">#</span><span>{tag.name}</span>
      </Button>)}
    </div> : !error && <p role="status" className="mt-3 text-[13px] text-mut">
      {loading || tags === null ? "正在加载题材…" : "暂无可用标签"}
    </p>}
    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
      <Button card onClick={() => void load()} disabled={loading} aria-label={error ? "重试加载题材" : "刷新题材"}
        className="hg-section-more flex items-center gap-1">
        {loading ? <Loader className="w-3 h-3" /> : <IRefresh size={13} />}{loading ? "加载中…" : error ? "重试" : "刷新"}
      </Button>
      {count > BATCH_SIZE && <Button card onClick={() => setBatch(value => (value + 1) % Math.ceil(count / BATCH_SIZE))}
        className="hg-section-more">换一批</Button>}
    </div>
  </Surface>;
}
