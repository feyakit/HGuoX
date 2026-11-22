import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTabSwipe } from "../src/shared/lib/useTabSwipe";
import "../src/index.css";

// useTabSwipe 的钩子级探针：不接业务页，只量三件事——
//   切 tab 是否只切一次、纵向滑动是否不切、滑动后余波 click 是否被吞掉。
const probe = { tabs: [] as number[], clicks: 0, index: 0, prevented: [] as boolean[] };
Object.assign(window, { swipeProbe: probe });

function Probe() {
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const swipe = useTabSwipe<HTMLDivElement>({
    rootRef,
    tabIndex: index,
    tabCount: 3,
    onTabChange: next => { probe.tabs.push(next); setIndex(next); },
  });
  probe.index = index;
  /* 挂在最外层（冒泡末尾）：这里读到的 defaultPrevented 就是「这次纵向手势有没有被我们拦掉」
     的最终答案，比 scrollTop 更直接——合成触摸在无头 Chromium 里不一定真的滚动。 */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const record = (event: TouchEvent) => { probe.prevented.push(event.defaultPrevented); };
    el.addEventListener("touchmove", record);
    return () => el.removeEventListener("touchmove", record);
  }, []);

  return (
    <div id="probe-root" ref={rootRef} {...swipe}
      style={{ position: "absolute", inset: 0, touchAction: "pan-y", overflowY: "auto" }}>
      <div style={{ height: 1600 }}>
        <button id="probe-hit" style={{ width: 300, height: 120 }}
          onClick={() => { probe.clicks += 1; }}>点我</button>
      </div>
    </div>
  );
}

createRoot(document.querySelector("#root")!).render(<Probe />);
