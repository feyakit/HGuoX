// 方向提示验收（3.0.22）：用户实测「每切换一级都弹『系统未允许锁定屏幕方向：转动手机可能会横屏』」。
//
// 真 EpisodePlayer + 真 store + 真 ToastHost；平台由 UA 决定（iOS / 安卓各开一个 context）。
// 「切换一级」用换片源 id 触发（curId 变 → 组件里 `curId:want` 去重键变化 → 重跑锁方向那条 effect），
// 与刷剧流上滑换剧是同一条代码路径。
//
// 判定口径（3.0.22 方案 B + C，取代 W113 的「iOS 不下发」临时口径）：
//   ① iOS 现在**会真下发**（B：mask + 几何更新），所以静默路径也是「每片源 1 次 portrait/unspecified」，
//      与安卓同口径 —— 但**仍然 0 条提示**（静默路径不挂 onFail）；
//   ② 切集 / 进出播放页 → 提示 0 条（本轮的核心诉求，不许回退）；
//   ③ 用户主动点「全屏观看」：
//        · Rust 回 orientation_locked_by_user（被系统竖排方向锁定拦住）→ **0 条 toast**，
//          改出 1 张说明卡（`orientation-lock-hint`）＋入口变锁状态；
//        · 其它失败 → 1 条 toast（每会话最多 1 条），走竖屏沉浸兜底；
//   ④ 安卓：静默路径不弹；全屏失败弹 1 条老文案；调用次数与 3.0.20 一致（每片源一次）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "orientation-toast");
await mkdir(output, { recursive: true });
const report = { passed: [], failed: [], data: {}, shots: [] };
const step = async (n, fn) => {
  try { const v = await fn(); report.passed.push(n); console.log("  ok   " + n); return v; }
  catch (e) { report.failed.push(`${n}: ${e.message}`); console.log("  FAIL " + n + ": " + e.message); return null; }
};

const UA = {
  android: "Mozilla/5.0 (Linux; Android 11; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
};

/* 方案 C 的说明卡文案（卡片，不是 toast）与安卓兜底 toast 文案 */
const CARD_IOS = "系统「竖排方向锁定」已开启：先在控制中心关掉它，再点「全屏观看」";
const HINT_ANDROID = "系统未允许横屏：保持竖屏全屏（打开系统「自动旋转」后可重试）";
const HINT_UNSUPPORTED = "这台设备暂不支持强制转屏：请手动横置手机观看";
const OLD_HINT = "系统未允许锁定屏幕方向：转动手机可能会横屏";

const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });

const openPage = async (platform) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: UA[platform],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { context, page, errors };
};

/** 打开验收台并等到首次方向请求落地 */
const boot = async (page, { fail = 1, src = "port", reject = "locked" } = {}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${origin}tests/orientation-toast.html?fail=${fail}&src=${src}&reject=${reject}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player-root", { timeout: 10000 });
  await page.waitForTimeout(1200);
};

/** 读数：方向调用 / 方向提示 / 方向日志 */
const snap = (page) => page.evaluate(() => {
  const f = window.orientFixture;
  const logs = f.calls.filter((c) => c.cmd === "debug_log").map((c) => String(c.args.msg || ""));
  return {
    calls: f.calls.filter((c) => c.cmd === "set_orientation").map((c) => ({
      landscape: c.args.landscape, mode: c.args.mode,
    })),
    toasts: f.toasts.map((t) => t.text),
    cards: (f.cards || []).map((t) => t.text),
    logs: logs.filter((m) => m.startsWith("[orientation]")),
  };
});

const switchDrama = async (page, times) => {
  for (let i = 0; i < times; i += 1) {
    await page.evaluate(() => window.__nextDrama());
    await page.waitForTimeout(700);
  }
};

const diff = (after, before) => ({
  calls: after.calls.length - before.calls.length,
  toasts: after.toasts.slice(before.toasts.length),
  cards: (after.cards || []).slice((before.cards || []).length),
  logs: after.logs.slice(before.logs.length),
  callArgs: after.calls.slice(before.calls.length),
});

const clickFullscreenEntry = async (page) => {
  const box = await page.evaluate(() => {
    const b = document.querySelector('[data-hg-control="fullscreen-entry"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new Error("找不到「全屏观看」入口");
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(1100);   // > 组件里 800ms 的视口判定
};

try {
  /* ───── 场景 A：iOS + set_orientation 恒 reject（用户真机的形态）───── */
  {
    const { context, page, errors } = await openPage("ios");
    await boot(page, { fail: 1, src: "port" });
    const base = await snap(page);
    await switchDrama(page, 5);
    const d = diff(await snap(page), base);
    report.data.iosFail = d;
    await page.screenshot({ path: join(output, "ios-5switch.png") });
    report.shots.push(join(output, "ios-5switch.png"));

    await step("A1 iOS 换 5 部剧：方向提示 0 条（3.0.20 这里会弹 5 条）", async () => {
      assert.equal(d.toasts.length, 0, `实际 ${JSON.stringify(d.toasts)}`);
      assert.ok(!d.toasts.some((t) => t.includes("锁定屏幕方向")), "还出现了老文案");
    });
    await step("A2 iOS：换 5 部剧 = 5 次 portrait 下发（B 之后 iOS 也真锁，与安卓同口径）", async () => {
      assert.equal(d.calls, 5, `实际 ${JSON.stringify(d.callArgs)}`);
      assert.ok(d.callArgs.every((c) => c.mode === "portrait" && c.landscape === false), JSON.stringify(d.callArgs));
    });
    await step("A3 iOS：5 条失败日志 + 0 条提示（静默路径只记日志，不打扰用户）", async () => {
      const sent = d.logs.filter((m) => m.includes("[orientation] set_orientation(portrait) 失败"));
      assert.equal(sent.length, 5, `实际 ${JSON.stringify(d.logs)}`);
      assert.ok(d.logs.every((m) => m.includes("[orientation]")), JSON.stringify(d.logs));
      assert.equal(d.toasts.length, 0, `实际 ${JSON.stringify(d.toasts)}`);
      assert.equal(d.cards.length, 0, `实际 ${JSON.stringify(d.cards)}`);
    });
    await step("A4 页面无 JS 异常", async () => assert.equal(errors.length, 0, errors.join(" | ")));
    await context.close();
  }

  /* ───── 场景 B：安卓 + reject（真拒绝）───── */
  {
    const { context, page, errors } = await openPage("android");
    await boot(page, { fail: 1, src: "port", reject: "other" });
    const base = await snap(page);
    await switchDrama(page, 5);
    const d = diff(await snap(page), base);
    report.data.androidFail = d;
    await page.screenshot({ path: join(output, "android-fail-5switch.png") });
    report.shots.push(join(output, "android-fail-5switch.png"));

    await step("B1 安卓 + reject 换 5 部剧：方向提示 0 条（静默路径不弹）", async () => {
      assert.equal(d.toasts.length, 0, `实际 ${JSON.stringify(d.toasts)}`);
    });
    await step("B2 安卓 + reject：5 次调用、5 条失败日志（失败不静默）", async () => {
      assert.equal(d.calls, 5, `调用 ${JSON.stringify(d.callArgs)}`);
      const fails = d.logs.filter((m) => m.includes("失败"));
      assert.equal(fails.length, 5, `实际 ${JSON.stringify(d.logs)}`);
      assert.ok(fails.every((m) => /set_orientation\((portrait|unspecified)\) 失败：(Error: )?系统未允许转屏/.test(m)), JSON.stringify(fails));
    });
    await step("B3 页面无 JS 异常", async () => assert.equal(errors.length, 0, errors.join(" | ")));
    await context.close();
  }

  /* ───── 场景 C：安卓 + 成功（调用次数不得增加）───── */
  {
    const { context, page, errors } = await openPage("android");
    await boot(page, { fail: 0, src: "port" });
    const base = await snap(page);
    await switchDrama(page, 5);
    const d = diff(await snap(page), base);
    report.data.androidOk = d;
    await page.screenshot({ path: join(output, "android-ok-5switch.png") });
    report.shots.push(join(output, "android-ok-5switch.png"));

    await step("C1 安卓 + 成功换 5 部剧：提示 0 条", async () => {
      assert.equal(d.toasts.length, 0, `实际 ${JSON.stringify(d.toasts)}`);
    });
    await step("C2 安卓 + 成功：5 次调用（每片源一次，与 3.0.20 一致，未增加）", async () => {
      assert.equal(d.calls, 5, `调用 ${JSON.stringify(d.callArgs)}`);
      assert.ok(d.callArgs.every((c) => c.mode === "portrait" || c.mode === "unspecified"), JSON.stringify(d.callArgs));
    });
    await step("C3 页面无 JS 异常", async () => assert.equal(errors.length, 0, errors.join(" | ")));
    await context.close();
  }

  /* ───── 场景 D：安卓 + 用户主动点「全屏观看」→ 失败 ───── */
  {
    const { context, page, errors } = await openPage("android");
    await boot(page, { fail: 1, src: "land", reject: "other" });
    const base = await snap(page);
    await clickFullscreenEntry(page);
    const once = diff(await snap(page), base);
    report.data.androidFullscreen = once;
    await page.screenshot({ path: join(output, "android-fullscreen-hint.png") });
    report.shots.push(join(output, "android-fullscreen-hint.png"));

    await step("D1 安卓点全屏观看失败：提示 1 条，文案沿用老口径", async () => {
      assert.equal(once.toasts.length, 1, `实际 ${JSON.stringify(once.toasts)}`);
      assert.equal(once.toasts[0], HINT_ANDROID, `文案「${once.toasts[0]}」`);
    });
    await step("D2 安卓：确实下发了 landscape", async () => {
      assert.ok(once.callArgs.some((c) => c.landscape === true && c.mode === "landscape"), JSON.stringify(once.callArgs));
    });

    /* 再点两次：不重复弹 */
    const after = await snap(page);
    await clickFullscreenEntry(page).catch(() => {});
    await clickFullscreenEntry(page).catch(() => {});
    const again = diff(await snap(page), after);
    await step("D3 安卓：再点两次全屏不再弹（每会话 1 条）", async () => {
      assert.equal(again.toasts.length, 0, `实际 ${JSON.stringify(again.toasts)}`);
    });
    await step("D4 页面无 JS 异常", async () => assert.equal(errors.length, 0, errors.join(" | ")));
    await context.close();
  }

  /* ───── 场景 E：iOS + invoke 成功但系统没转（= 用户真机：竖排已锁）───── */
  {
    const { context, page, errors } = await openPage("ios");
    await boot(page, { fail: 0, src: "land" });
    const base = await snap(page);
    const beforeEntry = await page.evaluate(() => !!document.querySelector('[data-hg-control="fullscreen-entry"]'));
    await step("E1 iOS 竖版视口 + 横版片源：「全屏观看」入口在", async () => {
      assert.ok(beforeEntry, "入口没渲染");
    });
    await clickFullscreenEntry(page);
    const d = diff(await snap(page), base);
    report.data.iosFullscreen = d;
    await page.screenshot({ path: join(output, "ios-fullscreen-hint.png") });
    report.shots.push(join(output, "ios-fullscreen-hint.png"));

    /* 「转没转过去」的判定已下沉到 Rust（api.rs verify_ios_orientation 读 interfaceOrientation），
       前端不再自己量视口 —— 所以 mock resolve = 成功路径：不提示、不出卡、只下发一次 landscape。 */
    await step("E2 iOS 点全屏观看成功：0 条 toast、0 张卡（判定在原生侧）", async () => {
      assert.equal(d.toasts.length, 0, `实际 ${JSON.stringify(d.toasts)}`);
      assert.equal(d.cards.length, 0, `实际 ${JSON.stringify(d.cards)}`);
      assert.ok(!d.toasts.includes(OLD_HINT), "老文案还在");
    });
    await step("E3 iOS 仍会下发一次 landscape（锁关着时能真转），但失败不弹第二条", async () => {
      assert.equal(d.callArgs.filter((c) => c.mode === "landscape").length, 1, JSON.stringify(d.callArgs));
    });

    /* 提示之后继续切剧：仍然只有这 1 条 */
    const after = await snap(page);
    await page.evaluate(() => window.__nextDrama());
    await page.waitForTimeout(700);
    await page.evaluate(() => window.__nextDrama());
    await page.waitForTimeout(700);
    const again = diff(await snap(page), after);
    await step("E4 iOS 提示过后再换 2 部剧：不再弹（全程仍 1 条）", async () => {
      assert.equal(again.toasts.length, 0, `实际 ${JSON.stringify(again.toasts)}`);
    });
    await step("E5 页面无 JS 异常", async () => assert.equal(errors.length, 0, errors.join(" | ")));
    await context.close();
  }

  /* ───── 场景 F：iOS + 「竖排方向锁定」拦住 + 全屏观看（方案 C 的主路径）───── */
  {
    const { context, page, errors } = await openPage("ios");
    await boot(page, { fail: 1, src: "land", reject: "locked" });
    const base = await snap(page);
    await clickFullscreenEntry(page);
    const d = diff(await snap(page), base);
    report.data.iosFullscreenFail = d;

    await step("F1 iOS 被方向锁拦住：0 条 toast（不报错），只出 1 张说明卡且是新文案", async () => {
      assert.equal(d.toasts.length, 0, `实际 ${JSON.stringify(d.toasts)}`);
      assert.equal(d.cards.length, 1, `实际 ${JSON.stringify(d.cards)}`);
      /* 卡片 textContent 里带按钮文字，正文用前缀比、按钮单独断言 */
      assert.ok(d.cards[0].startsWith(CARD_IOS), `文案「${d.cards[0]}」`);
      assert.ok(d.cards[0].includes("知道了"), "说明卡缺「知道了」");
      assert.ok(!d.toasts.includes(OLD_HINT), "老文案还在");
    });
    await step("F2 iOS + 方向锁：入口变成锁状态（可点=重试），文案说清原因", async () => {
      const entry = await page.evaluate(() => {
        const b = document.querySelector('[data-hg-control="fullscreen-entry"]');
        return b ? {
          locked: b.getAttribute("data-orientation-locked"),
          text: (b.textContent || "").trim(),
          h: Math.round(b.getBoundingClientRect().height),
        } : null;
      });
      assert.ok(entry, "入口不见了");
      assert.equal(entry.locked, "true", "入口没切到锁状态");
      assert.ok(entry.text.includes("需关闭系统竖排方向锁定"), `入口文案「${entry.text}」`);
      assert.equal(entry.h, 44, `入口行高应保持 44，实际 ${entry.h}`);
    });
    await step("F3 iOS + 方向锁：失败仍写日志（含 mode 与错误码）", async () => {
      const fails = d.logs.filter((m) => m.includes("失败"));
      assert.equal(fails.length, 1, JSON.stringify(d.logs));
      assert.ok(fails[0].includes("landscape") && fails[0].includes("orientation_locked_by_user"), fails[0]);
    });
    await step("F4 页面无 JS 异常", async () => assert.equal(errors.length, 0, errors.join(" | ")));
    await context.close();
  }

  /* ───── 场景 G（集成）：iOS 被锁定拦截后，切 5 集不再追加任何提示 ───── */
  {
    const { context, page, errors } = await openPage("ios");
    await boot(page, { fail: 1, src: "land", reject: "locked" });
    await clickFullscreenEntry(page);
    const once = await snap(page);
    report.data.iosIntegration = { cards: once.cards, toasts: once.toasts };
    await page.screenshot({ path: join(output, "ios-integration-card.png") });
    report.shots.push(join(output, "ios-integration-card.png"));

    await step("G1 集成：点全屏被拦 → 恰好 1 张卡、0 条 toast", async () => {
      assert.equal(once.cards.length, 1, `实际 ${JSON.stringify(once.cards)}`);
      assert.equal(once.toasts.length, 0, `实际 ${JSON.stringify(once.toasts)}`);
      assert.ok(once.cards[0].startsWith(CARD_IOS), `文案「${once.cards[0]}」`);
      assert.ok(once.cards[0].includes("知道了"), "说明卡缺「知道了」");
    });

    /* 点「知道了」收起卡片，再切 5 集 */
    const dismissed = await page.evaluate(() => {
      const btn = document.querySelector('[data-hg-control="orientation-lock-hint"] button');
      if (!btn) return false;
      btn.click();
      return true;
    });
    assert.ok(dismissed, "说明卡上没有「知道了」按钮");
    await page.waitForTimeout(300);
    const beforeSwitch = await snap(page);
    await switchDrama(page, 5);
    const after = await snap(page);
    const added = {
      toasts: after.toasts.slice(beforeSwitch.toasts.length),
      cards: after.cards.slice(beforeSwitch.cards.length),
      calls: after.calls.length - beforeSwitch.calls.length,
    };
    report.data.iosIntegrationAfter = added;
    await page.screenshot({ path: join(output, "ios-integration-5switch.png") });
    report.shots.push(join(output, "ios-integration-5switch.png"));

    await step("G2 集成：切 5 集 → 0 条 toast、0 张卡（每会话只解释一次）", async () => {
      assert.equal(added.toasts.length, 0, `实际 ${JSON.stringify(added.toasts)}`);
      assert.equal(added.cards.length, 0, `实际 ${JSON.stringify(added.cards)}`);
    });
    await step("G3 集成：切 5 集仍然每片源下发 1 次（5 次，不重试、不叠加）", async () => {
      assert.equal(added.calls, 5, `实际 ${added.calls}`);
    });
    await step("G4 集成：卡片收起后入口仍保持锁状态（不是又变回「全屏观看」）", async () => {
      const locked = await page.evaluate(() => document.querySelector('[data-hg-control="fullscreen-entry"]')?.getAttribute("data-orientation-locked"));
      assert.equal(locked, "true", `实际 ${locked}`);
    });
    await step("G5 页面无 JS 异常", async () => assert.equal(errors.length, 0, errors.join(" | ")));
    await context.close();
  }
} finally {
  await browser.close();
  await vite.close();
}

report.data.summary = { passed: report.passed.length, failed: report.failed.length };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.passed.length} passed, ${report.failed.length} failed`);
if (report.failed.length) { for (const f of report.failed) console.log("  - " + f); process.exit(1); }
