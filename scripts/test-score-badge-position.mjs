#!/usr/bin/env node
/* 封面评分角标的回归口径。
 *
 *  历史：b5a9e77 把评分钉在封面右上角，之后 8cbdf9c「修复横屏全屏适应铺满、
 *  移除封面评分角标、对齐封面顶部并保留首页滚动位置」明确把角标去掉了 ——
 *  这是产品决定，不是回归。于是这条用例改成守当前契约：
 *    ① 封面层（.ios-poster-art）里不许再出现评分角标（防止它悄悄长回来盖住封面）；
 *    ② 评分数据不许被静默丢弃：横滑/行卡片仍要把评分写成副标题里的「N.N 分」。
 *  另外提醒：css 里 .ios-score-badge 已经没有任何组件在用（死规则），清理不在这条用例范围内。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || new URL("..", import.meta.url).pathname);
const cards = readFileSync(join(root, "src", "shared", "ui", "cards.tsx"), "utf8");

assert.doesNotMatch(cards, /ios-score-badge/,
  "Cover scores were removed in 8cbdf9c: MediaCard must not render a score badge over the poster art");
assert.doesNotMatch(cards, /function ScoreBadge/,
  "The removed cover score badge must not come back as a component");

const mediaCard = cards.slice(cards.indexOf("function MediaCard"), cards.indexOf("function completedEpisodeLabel"));
assert.match(mediaCard, /ios-poster-art/,
  "MediaCard still owns the cover layer (the guard below only makes sense while it does)");
assert.doesNotMatch(mediaCard, /score\s*&&\s*<span/,
  "A numeric score must not be re-introduced as a cover overlay inside MediaCard");

assert.match(cards, /score\s*\?\s*`\$\{score\.toFixed\(1\)\}|v\.score\s*\?\s*`\$\{v\.score\.toFixed\(1\)\}/,
  "Row cards must keep surfacing the score as text in the subtitle instead of dropping the value");
console.log("PASS: cover scores stay removed (8cbdf9c) while the score value is still surfaced as subtitle text");
