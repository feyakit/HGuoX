/** 收藏数展示口径（审计 #7）。
 *
 *  服务端计数与本地乐观增量**各自都可能领先**：
 *   · 刚点收藏、详情还没刷新 → 服务端还差 1，界面「回落 1」，看着像没点上；
 *   · 静默刷新拿到已经包含本次操作的计数 → 再叠加就多 1（那是 SeriesDetail 里
 *     `favSettledAt` 把增量归零来管的，不是这里）。
 *
 *  口径：**本地收藏态为真时取「服务端 / 乐观值 / 高水位」三者最大**；本地已取消收藏时
 *  直接用服务端值（服务端明确未收藏，以服务端为准）。
 *
 *  为什么要高水位（prevShown）：只做 `max(server, server+delta)` 是不够的 —— 增量从 +1
 *  归零的那一刻（favSettledAt 生效、服务端计数还没涨）会从 37 掉回 36，用户看到的就是
 *  「刚点上又掉了一个」。所以只要服务端还没追平上次显示的数（server < prevShown），
 *  就保持上次那个数；服务端一旦 ≥ 它就交还给服务端，之后别人收藏/取消都能正常反映。
 *  代价：若服务端永远不把这次收藏算进去，会长期多显示 1 —— 已写进报告，属可接受取舍。
 */
export function collectCountShown(
  server: number,
  optimisticDelta: number,
  faved: boolean,
  prevShown = 0,
): number {
  const base = Number.isFinite(server) ? Math.max(0, server) : 0;
  if (!faved) return base;
  const delta = Number.isFinite(optimisticDelta) ? optimisticDelta : 0;
  const optimistic = Math.max(0, base + delta);
  const candidate = Math.max(base, optimistic);
  const floor = Number.isFinite(prevShown) ? Math.max(0, prevShown) : 0;
  return base >= floor ? candidate : Math.max(candidate, floor);
}
