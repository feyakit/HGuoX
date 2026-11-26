import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { IClose } from "../../shared/ui/icons";

const HOLD_MS = 500;
const MOVE_SLOP = 10;

/** 搜索历史（上游 #184）：默认单击搜索；长按约 0.5 秒进入批量删除态，可连续单项删除。 */
export function SearchHistory({
  items,
  onPick,
  onRemove,
  onClear,
  className = "mb-4 a-rise",
}: {
  items: string[];
  onPick: (term: string) => void;
  onRemove: (term: string) => void;
  onClear: () => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const holdTimer = useRef<number | null>(null);
  const holdOrigin = useRef<{ x: number; y: number } | null>(null);
  const holdFired = useRef(false);

  const cancelHold = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdOrigin.current = null;
  }, []);

  useEffect(() => () => cancelHold(), [cancelHold]);

  useEffect(() => {
    if (!editing) return;
    const dismiss = (event: PointerEvent) => {
      if (!sectionRef.current?.contains(event.target as Node)) setEditing(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [editing]);

  if (!items.length) return null;

  const clearAll = () => {
    onClear();
    setEditing(false);
  };

  const startHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    cancelHold();
    holdOrigin.current = { x: event.clientX, y: event.clientY };
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      holdFired.current = true;
      setEditing(true);
    }, HOLD_MS);
  };

  const moveHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = holdOrigin.current;
    if (!origin) return;
    if (Math.abs(event.clientX - origin.x) > MOVE_SLOP || Math.abs(event.clientY - origin.y) > MOVE_SLOP) {
      cancelHold();
    }
  };

  const finishHold = () => { cancelHold(); };

  const clearHold = () => {
    holdFired.current = false;
    cancelHold();
  };

  const clickTerm = (term: string) => {
    if (holdFired.current) {
      holdFired.current = false;
      return;
    }
    if (editing) onRemove(term);
    else onPick(term);
  };

  return (
    <section ref={sectionRef} role="region" aria-label="最近搜索" className={className}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[13px] font-bold text-on">最近搜索</span>
        {editing ? (
          <div className="ios-history-actions">
            <Button onClick={clearAll} className="ios-history-action">清空</Button>
            <span aria-hidden="true" className="ios-history-separator">|</span>
            <Button onClick={() => setEditing(false)} className="ios-history-action ios-history-done">完成</Button>
          </div>
        ) : (
          <Button onClick={clearAll} className="ios-history-action -mr-2">清空</Button>
        )}
      </div>
      <div className={editing ? "flex flex-wrap gap-3" : "flex flex-wrap gap-2"}>
        {items.map((term) => (
          <Button
            key={term}
            card={!editing}
            aria-label={editing ? `删除搜索历史 ${term}` : undefined}
            onClick={() => clickTerm(term)}
            onPointerDown={editing ? clearHold : startHold}
            onPointerMove={editing ? undefined : moveHold}
            onPointerUp={finishHold}
            onPointerCancel={finishHold}
            onPointerLeave={cancelHold}
            onContextMenu={(event) => { event.preventDefault(); setEditing(true); }}
            aria-description={editing ? undefined : "长按可删除"}
            title={editing ? "点击删除" : "长按可删除"}
            className={editing ? "ios-history-chip" : "hg-tag-pill"}
          >
            <span className={editing ? "ios-history-chip-label" : undefined}>{term}</span>
            {editing && <span aria-hidden="true" className="ios-history-chip-remove"><IClose size={11} /></span>}
          </Button>
        ))}
      </div>
    </section>
  );
}
