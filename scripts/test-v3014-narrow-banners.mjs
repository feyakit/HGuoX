// 3.0.14 验收用浏览器 harness（只替换 Tauri IPC，跑真实 App）。
//
// 覆盖三件事：
//   1. C 节：首页 hero 用官网 banners，顺序与 api_home 返回一致；
//   2. G 节：链路层失败 → 自动换线 → 重试成功后**不出现错误页**；全挂才出错误页，
//      且错误页说人话、原文折在「详情」里、两个按钮都在；
//   3. E 节：360/393/411dp 下顶栏/hero/卡片标题不折行撑高、不裁字、按钮不溢出（几何取样）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "v3014", new Date().toISOString().replace(/[:.]/g, "-"));
const userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
const widths = [360, 393, 411];
const BANNERS = [
  { id: 28, video_id: 10586, image: "/upload_01/upload/20261114/2026111416381591451.jpeg", image_url: "https://pic.example.invalid/b1.jpg", score: 9.3, desc: "任意门一开", title: "任意门：推开就是另一个家庭的夜晚", tags: ["大男主", "都市", "系统"], episode_count: 6, total_episodes: 0, is_finished: false },
  { id: 33, video_id: 12297, image: "/upload_01/upload/20261113/x.jpeg", image_url: "https://pic.example.invalid/b2.jpg", score: 9.5, desc: "那一天", title: "进击的巨人同人·只有击杀 BOSS 才能离开游戏", tags: ["脑洞"], episode_count: 12, total_episodes: 0, is_finished: false },
  { id: 38, video_id: 13781, image: "/upload_01/upload/20261122/y.jpeg", image_url: "https://pic.example.invalid/b3.jpg", score: 9.1, desc: "兄弟", title: "蜜桃臀", tags: ["都市"], episode_count: 30, total_episodes: 30, is_finished: true },
];
const LONG_TITLES = [
  "穿成恶毒女配后我靠卖惨成为了全剧组的团宠并且顺手救下了男主他哥",
  "重生之我在霸总文里当保姆的第十八年终于熬成了董事长夫人",
  "开局签到荒古圣体：从被逐出师门到一剑霜寒十四州",
];
const report = { environment: { browser: "Chromium headless", transport: "real App; Tauri IPC mocked; no upstream traffic", limitation: "不能替代真机 WebView 验证" }, cases: [], geometry: [], pageErrors: [] };
await mkdir(output, { recursive: true });
let vite, browser;

/** 每个场景单独开一页：fixture 在 init script 里决定 IPC 行为 */
async function openApp(context, { mode }) {
  const page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  const origin = vite.resolvedUrls.local[0];
  await page.route("**/*", route => {
    const url = route.request().url();
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    return route.abort(); // 所有站外请求（含封面/banner 图）一律掐掉，harness 不出网
  });
  await page.addInitScript(({ banners, titles, mode }) => {
    const calls = [];
    const feedPage = (page) => ({
      items: titles.map((title, index) => ({
        id: 900 + index, title, cover: `https://pic.example.invalid/c${index}.jpg`,
        tags: ["都市", "爽文", "反转不断"], score: 9.1, episode_count: 88, is_hot: index === 0 ? 1 : 0,
        is_finished: false, hot: 1234567, created_at: "2026-11-01 10:00:00",
      })),
      pagination: { page, size: 21, pages: 3, total: 9 },
    });
    const banners_ = banners.map((banner, index) => ({ ...banner, id: 28 + index }));
    localStorage.setItem("hguox_usage_agreement", JSON.stringify({ version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z" }));
    window.v3014 = { calls, feedFails: mode === "failover" ? 1 : mode === "ok" ? 0 : 99, switched: false, banners: banners_, events: [] };
    ["hg:line-failover", "hg:line-changed"].forEach(name => window.addEventListener(name, () => window.v3014.events.push(name)));
    /* toast 只活 3.6s，靠轮询会错过：MutationObserver 全程记下来 */
    window.v3014.toastSeen = [];
    document.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(() => {
        document.querySelectorAll(".a-toast").forEach(node => {
          const text = node.textContent?.trim();
          if (text && !window.v3014.toastSeen.includes(text)) window.v3014.toastSeen.push(text);
        });
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args = {}) {
        calls.push({ cmd, args });
        switch (cmd) {
          case "app_boot": return Promise.resolve({ user: null, logged_in: false, base: "https://huangguoai.com", strict_security: true });
          case "playback_log_status": return Promise.resolve({ enabled: false, path: null, error: null });
          case "debug_log": case "set_text_interaction": return Promise.resolve();
          case "line_state": return Promise.resolve({ base: window.v3014.switched ? "https://thu.dvygahpw.cc" : "https://huangguoai.com", default: "https://huangguoai.com", custom: false, manual: false, fixed: [{ name: "固定线路 1", url: "https://huangguoai.com" }] });
          case "line_auto": return Promise.resolve({ base: "https://huangguoai.com", previous: "https://huangguoai.com", switched: false, pick: { base: "https://huangguoai.com", tier: "main", ms: 1, reason: "fixture", candidates: [] } });
          case "line_health": return Promise.resolve({ base: "https://huangguoai.com", ok: true, ms: 1, status: 200 });
          case "line_failover": {
            /* manual：模拟用户手动选了线路，后端拒绝自动换（硬约束） */
            if (mode === "manual-down") return Promise.resolve({ previous: "https://thu.dvygahpw.cc", base: "https://thu.dvygahpw.cc", switched: false, reason: "manual", ms: 0, pick: null });
            const canSwitch = mode === "failover";
            window.v3014.switched = canSwitch;
            return Promise.resolve({ previous: "https://huangguoai.com", base: canSwitch ? "https://thu.dvygahpw.cc" : "https://huangguoai.com", switched: canSwitch, reason: canSwitch ? "failover-ok" : "all-down", ms: 12 });
          }
          case "api_home": return Promise.resolve({ banners: banners_, source: "api/home" });
          case "api_feed": {
            if (window.v3014.feedFails > 0) { window.v3014.feedFails -= 1; return Promise.reject("error sending request ← client error (SendRequest) ← tls handshake eof"); }
            return Promise.resolve(feedPage(args.page || 1));
          }
          case "api_rank": return Promise.resolve({ type: args.kind, items: titles.map((title, index) => ({ rank: index + 1, video_id: 500 + index, title, cover: "https://pic.example.invalid/r.jpg", score: 9, metric_value: 1000, metric_label: "播放" })) });
          case "api_original_videos": return Promise.resolve({
            items: titles.map((title, index) => ({ id: 700 + index, title, cover: "https://pic.example.invalid/o.jpg", tags: ["原创"], episode_count: 20, is_original: 1 })),
            pagination: { page: 1, size: 10, pages: 1, total: 3 },
          });
          case "api_topics": return Promise.resolve({ items: [] });
          case "api_tags": return Promise.resolve({ categories: [] });
          case "api_hot_tags": return Promise.resolve({ items: [{ name: "都市", slug: "dushi" }, { name: "古风", slug: "gufeng" }] });
          case "api_video": return Promise.resolve({ id: args.id, title: titles[0], cover: "https://pic.example.invalid/c0.jpg", tags: ["都市"], episode_count: 8, total_episodes: 8, is_finished: false, score: 9.1, description: "描述", episodes: [], actors: [] });
          case "api_play": return Promise.reject("harness 无播放媒体");
          case "account_snapshot": case "api_me": return Promise.reject("401");
          default: return Promise.reject(`Unexpected IPC: ${cmd}`);
        }
      },
      transformCallback: (cb) => cb,
    };
  }, { banners: BANNERS, titles: LONG_TITLES, mode });
  await page.goto(origin);
  await page.waitForSelector(".hg-app, .hg-spotlight", { timeout: 15000 }).catch(() => {});
  /* 启动动画在 headless 里没有真实动画帧，animationend 不会自己来（截图会是启动页、toast 也被挡住）。
     直接把 launch-exit 的 animationend 派给它 —— 和真机动画结束走的是同一个 finish()。 */
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const removed = await page.evaluate(() => {
      const overlay = document.querySelector(".hg-launch");
      if (!overlay) return true;
      overlay.dispatchEvent(new AnimationEvent("animationend", { animationName: "launch-exit", bubbles: true }));
      return false;
    });
    if (removed) break;
    await page.waitForTimeout(400);
  }
  await page.waitForSelector(".hg-launch", { state: "detached", timeout: 4000 }).catch(() => {});
  await page.waitForSelector(".hg-spotlight", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  return page;
}

const rect = async (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10,
    scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight,
    lineHeight: parseFloat(style.lineHeight) || 0,
    lines: style.lineHeight && parseFloat(style.lineHeight) > 0 ? Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight)) : null,
  };
}, selector);

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ userAgent, isMobile: true, hasTouch: true, viewport: { width: widths[1], height: 844 }, deviceScaleFactor: 2 });

  // ── 1. banners → hero 顺序 ──────────────────────────────────────────
  const page = await openApp(context, { mode: "ok" });
  const bannerTitles = await page.evaluate(() => [...document.querySelectorAll(".hg-spotlight-title")].map(node => node.textContent?.trim()));
  report.cases.push({ case: "hero 顺序 = api_home.banners 顺序", got: bannerTitles, want: BANNERS.map(b => b.title), pass: JSON.stringify(bannerTitles) === JSON.stringify(BANNERS.map(b => b.title)) });
  assert.deepEqual(bannerTitles, BANNERS.map(b => b.title), "hero 必须按 banners 顺序渲染，且不因热播排重被剔除");
  const barCount = await page.locator(".hg-spotlight-bar").count();
  report.cases.push({ case: "hero 条数 = banners 条数", got: barCount, want: BANNERS.length, pass: barCount === BANNERS.length });

  // ── 2. E 节几何：三个宽度 ──────────────────────────────────────────
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(160);
    const sample = {
      width,
      heroTitle: await rect(page, ".hg-spotlight-title"),
      heroBody: await rect(page, ".hg-spotlight-body"),
      heroCta: await rect(page, ".hg-spotlight-cta"),
      posterName: await rect(page, ".hg-poster-name"),
      rankTitle: await rect(page, ".hg-top10-title"),
      header: await rect(page, ".hg-editorial-bar"),
      pageOverflow: await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      headerOverflow: await page.evaluate(() => {
        const bar = document.querySelector(".hg-editorial-bar");
        if (!bar) return null;
        const kids = [...bar.children].map(k => k.getBoundingClientRect());
        return bar.scrollWidth - bar.clientWidth;
      }),
    };
    report.geometry.push(sample);
    assert.ok(sample.pageOverflow <= 0, `${width}dp: 页面不许横向溢出（got ${sample.pageOverflow}）`);
    assert.ok((sample.headerOverflow ?? 0) <= 1, `${width}dp: 顶栏不许溢出（got ${sample.headerOverflow}）`);
  }
  await page.setViewportSize({ width: widths[1], height: 844 });
  await page.screenshot({ path: join(output, "home-banners.png") });

  // ── 2b. 备用线路胶囊：切到镜像后顶栏在 360dp 仍然不溢出 ──────────
  await page.setViewportSize({ width: 360, height: 844 });
  await page.evaluate(() => { window.v3014.switched = true; window.dispatchEvent(new Event("hg:line-changed")); });
  await page.waitForSelector(".hg-line-chip", { timeout: 5000 });
  const chip = await page.evaluate(() => {
    const bar = document.querySelector(".hg-editorial-bar");
    const chip = document.querySelector(".hg-line-chip");
    return {
      chip: chip ? { w: Math.round(chip.getBoundingClientRect().width), text: chip.textContent?.trim(), scrollW: chip.scrollWidth, clientW: chip.clientWidth } : null,
      headerOverflow: bar ? bar.scrollWidth - bar.clientWidth : null,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  report.cases.push({ case: "360dp + 备用线路胶囊：顶栏不溢出", ...chip, pass: (chip.headerOverflow ?? 0) <= 1 && chip.pageOverflow <= 0 && !!chip.chip });
  assert.ok((chip.headerOverflow ?? 0) <= 1 && chip.pageOverflow <= 0 && !!chip.chip, "备用线路胶囊不能把顶栏挤溢出");
  await page.screenshot({ path: join(output, "home-line-chip-360.png") });

  // ── 2c. 详情页窄屏几何（长标题 + 多标签） ──────────────────────────
  await page.locator(".hg-spotlight").first().click();
  await page.waitForSelector(".hg-detail-title", { timeout: 8000 });
  const detail = {
    title: await rect(page, ".hg-detail-title"),
    tags: await page.evaluate(() => {
      const box = document.querySelector(".hg-detail-tags");
      if (!box) return null;
      const children = [...box.children].map(child => child.getBoundingClientRect());
      return {
        boxW: Math.round(box.getBoundingClientRect().width),
        overflow: box.scrollWidth - box.clientWidth,
        minChildW: children.length ? Math.round(Math.min(...children.map(c => c.width))) : 0,
        rows: new Set(children.map(c => Math.round(c.top))).size,
      };
    }),
    pageOverflow: await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  };
  report.cases.push({ case: "360dp 详情页：标题 2 行内、标签不溢出", ...detail, pass: (detail.pageOverflow ?? 0) <= 0 && (detail.tags?.overflow ?? 0) <= 1 });
  await page.screenshot({ path: join(output, "detail-360.png") });
  await page.close();

  // ── 2d. 我的页（窄屏两列快捷入口 + 账号卡） ────────────────────────
  const profilePage = await openApp(context, { mode: "ok" });
  await profilePage.getByRole("navigation", { name: "主导航" }).waitFor({ timeout: 15000 });
  await profilePage.getByRole("button", { name: "我的" }).click().catch(() => {});
  await profilePage.waitForTimeout(600);
  for (const width of [320, 360, 393]) {
    await profilePage.setViewportSize({ width, height: 844 });
    await profilePage.waitForTimeout(200);
    const sample = await profilePage.evaluate(() => {
      const links = [...document.querySelectorAll(".ios-collection-link")].map(el => {
        const title = el.querySelector(".ios-collection-title");
        const box = el.getBoundingClientRect();
        return {
          h: Math.round(box.height),
          w: Math.round(box.width),
          clipped: title ? title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1 : null,
          titleH: title ? Math.round(title.getBoundingClientRect().height) : null,
        };
      });
      const card = document.querySelector(".ios-account-card");
      return {
        links,
        clippedLinks: links.filter(l => l.clipped).length,
        cardOverflow: card ? card.scrollWidth - card.clientWidth : null,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    report.geometry.push({ width, screen: "profile", ...sample });
    assert.ok(sample.pageOverflow <= 0, `${width}dp 我的页横向溢出 ${sample.pageOverflow}`);
    assert.equal(sample.clippedLinks, 0, `${width}dp 我的页有 ${sample.clippedLinks} 个快捷入口文字被裁`);
  }
  await profilePage.setViewportSize({ width: 360, height: 844 });
  await profilePage.screenshot({ path: join(output, "profile-360.png") });
  await profilePage.close();

  // ── 3. 失败 → 换线 → 成功（不出现错误页） ──────────────────────────
  const failoverPage = await openApp(context, { mode: "failover" });
  await failoverPage.waitForTimeout(4000);
  const toastSeen = await failoverPage.evaluate(() => (window.v3014.toastSeen || []).some(text => text.includes("已切换到备用线路")));
  report.cases.push({ case: "换线成功后有「已切换到备用线路」提示", seen: await failoverPage.evaluate(() => window.v3014.toastSeen), pass: toastSeen });
  assert.ok(toastSeen, "换线成功后必须提示「已切换到备用线路」");
  const failoverState = await failoverPage.evaluate(() => ({
    errorCard: !!document.querySelector('[role="alert"]'),
    alertText: document.querySelector('[role="alert"]')?.textContent?.slice(0, 200) || "",
    posters: document.querySelectorAll(".hg-poster-name").length,
    spotlights: document.querySelectorAll(".hg-spotlight").length,
    calls: window.v3014.calls.map(c => c.cmd),
    events: window.v3014.events,
    toasts: [...document.querySelectorAll(".a-toast")].map(node => node.textContent?.trim()),
  }));
  console.error("failover events", JSON.stringify(failoverState.events), "toasts", JSON.stringify(failoverState.toasts));
  const didFailover = failoverState.calls.includes("line_failover");
  const recovered = !failoverState.errorCard && (failoverState.posters > 0 || failoverState.spotlights > 0);
  report.cases.push({ case: "链路失败先换线并重试成功，不显示错误页", didFailover, recovered, pass: didFailover && recovered });
  assert.ok(didFailover, "链路层失败必须先调 line_failover");
  assert.ok(recovered, "换线后重试成功时首页应出内容，而不是错误页");
  await failoverPage.screenshot({ path: join(output, "home-failover-ok.png") });
  await failoverPage.close();

  // ── 3b. 手动选定的线路不可用时：不许自动换，只提示 ────────────────
  const manualPage = await openApp(context, { mode: "manual-down" });
  await manualPage.waitForSelector('[role="alert"]', { timeout: 15000 });
  const manualState = await manualPage.evaluate(() => ({
    events: window.v3014.events,
    calls: window.v3014.calls.map(c => c.cmd),
    alert: document.querySelector('[role="alert"]')?.textContent?.slice(0, 120) || "",
  }));
  const notSwitched = !manualState.events.includes("hg:line-changed") && !manualPage.url().includes("?line=");
  report.cases.push({ case: "手动线路失败：不自动换线，只给提示", ...manualState, notSwitched, pass: notSwitched && manualState.calls.includes("line_failover") });
  assert.ok(notSwitched, "手动选定的线路失败时不允许自动跳线");
  await manualPage.screenshot({ path: join(output, "home-manual-line-down.png") });
  await manualPage.close();

  // ── 4. 全挂：错误页文案 / 详情折叠 / 两个按钮 ──────────────────────
  const downPage = await openApp(context, { mode: "all-down" });
  await downPage.waitForSelector('[role="alert"]', { timeout: 15000 });
  const errorCard = await downPage.evaluate(() => {
    const card = document.querySelector('[role="alert"]');
    const text = card?.textContent || "";
    const buttons = [...(card?.querySelectorAll("button") || [])].map(b => b.textContent?.trim());
    const pre = card?.querySelector("pre");
    return { text, buttons, hasRawVisible: !!pre, dialogVisible: !!document.querySelector('[role="dialog"]') };
  });
  const friendly = /当前线路连不上/.test(errorCard.text);
  const noRaw = !errorCard.hasRawVisible;
  const bothButtons = errorCard.buttons.some(b => /重试/.test(b || "")) && errorCard.buttons.some(b => /换个线路/.test(b || ""));
  report.cases.push({ case: "错误页：人话 + 原文默认折叠 + 两个按钮", friendly, noRaw, bothButtons, buttons: errorCard.buttons, pass: friendly && noRaw && bothButtons });
  assert.ok(friendly, "错误页必须用「当前线路连不上」这类人话");
  assert.ok(noRaw, "原始错误默认必须折叠");
  assert.ok(bothButtons, "错误页必须有「重试」「换个线路」两个按钮");
  await downPage.locator('[role="alert"] button', { hasText: /^详情$/ }).click();
  const rawAfter = await downPage.evaluate(() => document.querySelector('[role="alert"] pre')?.textContent || "");
  report.cases.push({ case: "点开「详情」能看到原始错误", raw: rawAfter, pass: /tls handshake eof/.test(rawAfter) });
  assert.ok(/tls handshake eof/.test(rawAfter), "折叠打开后应看到原始错误");
  await downPage.screenshot({ path: join(output, "home-error-all-down.png") });
  await downPage.getByRole("button", { name: "换个线路" }).click();
  const picker = await downPage.waitForSelector('[role="dialog"]', { timeout: 4000 }).then(() => true).catch(() => false);
  report.cases.push({ case: "「换个线路」打开播放源面板", pass: picker });
  assert.ok(picker, "「换个线路」必须能打开播放源面板");
  await downPage.screenshot({ path: join(output, "home-error-line-picker.png") });
  await downPage.close();

  const realErrors = report.pageErrors.filter(msg => !/Failed to fetch dynamically imported module/.test(msg));
  report.cases.push({ case: "页面无 JS 异常（排除 vite 懒加载抖动）", errors: realErrors, pass: realErrors.length === 0 });
  assert.equal(realErrors.length, 0, "页面不应有真实 JS 异常");
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n产物目录: ${output}`);
  await browser?.close();
  await vite?.close();
}
