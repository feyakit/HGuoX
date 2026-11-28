// 3.0.22 方向契约验收（方案 B/C）：跑 tests/player-orientation.tsx。
// 真组件 + 真 store + 真 CSS，只 mock Tauri IPC；平台由 UA 决定。
//
// 用法：node scripts/test-player-orientation.mjs
// 产物：test-results/player-orientation/{report.json,screens/*.png}
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "player-orientation");
const shots = join(output, "screens");
await mkdir(shots, { recursive: true });

const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 11; MI 9 Build/RKQ1.200826.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36";

const report = { started: new Date().toISOString(), cases: [], failed: [] };
const record = (name, detail) => { report.cases.push({ name, ...detail }); console.log(`  ok   ${name}`); };
const fail = (name, message) => { report.failed.push(`${name}: ${message}`); console.log(`  FAIL ${name}: ${message}`); };
const step = async (name, fn) => { try { await fn(); } catch (e) { fail(name, e.message); } };

let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "warn" });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });

  for (const [name, ua] of [["ios", UA_IPHONE], ["android", UA_ANDROID]]) {
    const context = await browser.newContext({
      userAgent: ua, viewport: { width: 393, height: 852 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const boot = async (query) => {
      await page.goto(`${origin}tests/player-orientation.html?${query}`, { waitUntil: "networkidle" });
      await page.waitForSelector(".player-root", { timeout: 15000 });
      await page.waitForTimeout(900);
      return page.evaluate(() => window.__probe());
    };
    const probe = () => page.evaluate(() => window.__probe());
    /* 控件 3s 自动收起 + 片源桩每 120ms 触发一次重渲染，Playwright 的稳定性/可见性判定会一直重试。
       这里直接派发一次 click（等价于手指点在按钮上），只在元素不存在时等。 */
    const clickEntry = async () => {
      for (let i = 0; i < 40; i += 1) {
        const clicked = await page.evaluate(() => {
          const el = document.querySelector('[data-hg-control="fullscreen-entry"]');
          if (!el) return false;
          el.click();
          return true;
        });
        if (clicked) return;
        await page.waitForTimeout(100);
      }
      throw new Error("「全屏观看」入口点不到（可能已被控件自动收起）");
    };

    /* ① 竖版片源 → 锁 portrait，且不弹任何提示 */
    await step(`${name} 竖版片源 → portrait / 0 提示`, async () => {
      const p = await boot("src=port&orient=ok");
      const calls = p.orientationCalls;
      assert(calls.length >= 1, "没有下发 set_orientation");
      assert.equal(calls[calls.length - 1].mode, "portrait");
      assert.equal(p.toasts.length, 0, `不该有提示，实际：${JSON.stringify(p.toasts)}`);
      record(`${name} 竖版片源`, { calls, toasts: p.toasts });
    });

    /* ② 横版片源（竖屏下） → unspecified，同样静默 */
    await step(`${name} 横版片源 → unspecified / 0 提示`, async () => {
      const p = await boot("src=land&orient=ok");
      const calls = p.orientationCalls;
      assert(calls.length >= 1, "没有下发 set_orientation");
      const last = calls[calls.length - 1];
      assert.equal(last.mode, "unspecified", `期望 unspecified，实际 ${last.mode}`);
      assert.equal(last.landscape, false);
      assert.equal(p.toasts.length, 0, `静默路径不该弹提示，实际：${JSON.stringify(p.toasts)}`);
      assert(p.entry && p.entry.visible, "横版片源在竖屏下应出现「全屏观看」入口");
      record(`${name} 横版片源`, { calls, toasts: p.toasts, entry: p.entry });
    });

    /* ③ 点全屏观看被系统方向锁拦下：不弹 toast，入口变锁状态 + 一次性说明卡 */
    if (name === "ios") {
      await step(`${name} 方向锁 → 入口锁状态 + 一次说明卡`, async () => {
        await boot("src=land&orient=fail_locked");
        /* 先点再截图：控件 3s 自动收起，截图会把这 3s 用掉（收起后入口整块卸载，就点不到了） */
        await clickEntry();
        await page.waitForTimeout(450);
        const a = await probe();
        assert(a.entry && a.entry.locked === "true", "入口没有切到锁状态");
        assert(a.entry.text.includes("需关闭系统竖排方向锁定"), `入口文案不对：${a.entry.text}`);
        assert(a.hintCard, "没有出说明卡");
        assert(a.hintCard.text.includes("知道了"), `说明卡缺「知道了」：${a.hintCard.text}`);
        assert(a.hintCard.text.includes("竖排方向锁定"), `说明卡文案不对：${a.hintCard.text}`);
        /* 片源是必然失败的地址，「播放地址已刷新」这类与方向无关的提示不计入 */
        const orientToasts = (list) => list.filter((t) => /竖排方向锁定|系统未允许|不支持强制转屏/.test(t));
        assert.equal(orientToasts(a.toasts).length, 0, `不该弹方向提示，实际：${JSON.stringify(a.toasts)}`);
        assert.equal(a.fs, false, "被方向锁拦下时不能伪造全屏（fs 应为 false）");
        await page.screenshot({ path: join(shots, "ios-locked-entry.png") });

        /* 知道了 → 卡片收起 */
        await page.click('[data-hg-control="orientation-lock-hint"] button');
        await page.waitForTimeout(250);
        const b = await probe();
        assert.equal(b.hintCard, null, "点「知道了」后卡片没有收起");
        assert.equal(b.entry.locked, "true", "入口的锁状态应保留（告诉用户为什么）");

        /* 再点一次：重试调用会发，但说明卡不再出现（每会话一次）。
           控件 3s 自动收起，先点一下画面唤出控件再点入口。 */
        await page.mouse.click(196, 700);
        await page.waitForTimeout(260);
        await clickEntry();
        await page.waitForTimeout(450);
        const c = await probe();
        const landscapeCalls = c.orientationCalls.filter((x) => x.mode === "landscape");
        assert.equal(landscapeCalls.length, 2, `每次点击都应重试下发，实际 landscape 调用 ${landscapeCalls.length} 次`);
        assert.equal(c.hintCard, null, "同一会话里不应重复出说明卡");
        assert.equal(orientToasts(c.toasts).length, 0, `重复点击也不该弹方向提示，实际：${JSON.stringify(c.toasts)}`);
        record(`${name} 方向锁拦截`, { lockedText: a.entry.text, card: a.hintCard.text, retries: landscapeCalls.length });
      });
    }

    /* ④ 安卓：其它原因的失败 → 维持旧口径（竖屏沉浸兜底 + 一条提示，不重复弹） */
    if (name === "android") {
      await step(`${name} 其它失败 → 竖屏沉浸兜底 + 一次提示`, async () => {
        await boot("src=land&orient=fail_other");
        await clickEntry();
        await page.waitForTimeout(450);
        const p = await probe();
        assert.equal(p.fs, true, "失败后应停在竖屏沉浸全屏（fs=true）");
        assert.equal(p.toasts.length, 1, `应只有一条提示，实际：${JSON.stringify(p.toasts)}`);
        await page.screenshot({ path: join(shots, "android-denied.png") });
        record(`${name} 其它失败`, { fs: p.fs, toasts: p.toasts });
      });
    }

    /* ⑤ 离开播放页 → unspecified（把方向还给系统） */
    await step(`${name} 离开播放页 → unspecified`, async () => {
      const before = (await probe()).orientationCalls.length;
      await page.evaluate(() => window.__setActive(false));
      await page.waitForTimeout(400);
      const calls = (await probe()).orientationCalls;
      assert(calls.length > before, "离开播放页没有补发 set_orientation");
      assert.equal(calls[calls.length - 1].mode, "unspecified", `期望 unspecified，实际 ${calls[calls.length - 1].mode}`);
      record(`${name} 离开播放页`, { last: calls[calls.length - 1] });
    });

    if (errors.length) fail(`${name} 页面异常`, errors.slice(0, 3).join(" | "));
    await context.close();
  }
} catch (error) {
  fail("fatal", String(error?.stack || error));
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  console.log(`\ncases=${report.cases.length} failed=${report.failed.length}`);
  if (report.failed.length) { for (const f of report.failed) console.log(" -", f); process.exitCode = 1; }
}
