// 收藏数展示口径的单测（审计 #7）：服务端值 vs 本地乐观增量。
//
// 直接 import 真模块（不是抄一份），用例覆盖：
//   1) 刚点收藏、服务端还没涨 → 显示 服务端+1（不回落）；
//   2) 服务端已含本次操作（favDelta 归零） → 与服务端一致，不多 1；
//   3) 本地已取消收藏 → 一律用服务端值（服务端明确未收藏以服务端为准）；
//   4) 服务端计数比本地还高（别人也收藏了） → 取服务端；
//   5) 脏输入（NaN / 负数）不产生负数或 NaN。
import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
let failed = 0;
const cases = [
  ["刚收藏、服务端滞后：36 + 1", 36, +1, true, 37],
  ["服务端已包含本次操作：37 + 0", 37, 0, true, 37],
  ["本地已取消收藏：服务端 36 说了算", 36, -1, false, 36],
  ["服务端更高（别人也收藏了）：40 + 0", 40, 0, true, 40],
  ["服务端 0、刚收藏：不能显示负数", 0, +1, true, 1],
  ["脏输入 NaN / NaN", NaN, NaN, true, 0],
  ["高水位：服务端还停在 36、增量归零 → 仍显示 37", 36, 0, true, 37, 37],
  ["服务端追平 37 → 交还服务端，仍是 37", 37, 0, true, 37, 37],
  ["服务端涨到 41（别人也收藏）→ 跟上 41", 41, 0, true, 41, 37],
  ["负服务端值夹到 0", -5, +1, true, 1],
];
try {
  const { collectCountShown } = await vite.ssrLoadModule("/src/shared/model/favCount.ts");
  for (const [name, server, delta, faved, expect, prev] of cases) {
    const got = collectCountShown(server, delta, faved, prev);
    try {
      assert.equal(got, expect);
      console.log(`  ok   ${name} → ${got}`);
    } catch {
      failed += 1;
      console.log(`  FAIL ${name}: 期望 ${expect}，实际 ${got}`);
    }
  }
  /* 「不回落」的判定：同一份服务端值，增量从 +1 掉到 0 时显示值不能变小 */
  const a = collectCountShown(36, +1, true);
  const b = collectCountShown(36, 0, true, a);
  if (a >= b) console.log(`  ok   增量归零不回落：${a} → ${b}`);
  else { failed += 1; console.log(`  FAIL 增量归零后回落：${a} → ${b}`); }
} finally {
  await vite.close();
}
console.log(failed ? `FAILED ${failed}` : "PASS fav-count");
process.exit(failed ? 1 : 0);
