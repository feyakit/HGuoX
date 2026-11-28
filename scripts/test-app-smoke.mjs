/**
 * 深色单主题下的应用冒烟：视口矩阵 + 底栏结构 + 触摸热区 + 搜索。
 *
 * 背景：旧的 `test:ios-ui`（scripts/test-ios-ui.mjs，已删除）测的是 3.0.13 之前那套
 * 浅色/深色双主题与 `ios-*` 视觉语言：`data-theme` 驱动、外观模式三档选择器、
 * `theme-transitioning` 换色洗、`.feed-position-pill` 播放计数、`.ios-profile-links` 我的快捷入口、
 * 首页/分类用 `.ios-media-grid` 网格（现在这两屏走 shelf.css 的 `.hg-poster` 货架卡，
 * `.ios-media-grid` 只剩搜索/发现结果页在用）。那套脚本 8/8 场景在启动阶段（等 `data-theme`）就红。
 *
 * 这里只保留「仍然存在、且别处没有覆盖」的断言（口径见 docs/已知问题.md 第 5 条）：
 *   ① 结构：深色是唯一主题（没有 data-theme、没有外观模式选择器）、底栏项按壳分表；
 *   ② 布局：每个视口不许横向溢出（翻遍四个底栏页），搜索结果的 `.ios-media-grid` 也不许溢出；
 *   ③ 交互：设置页每个开关的触摸热区 ≥44×44（别处只验状态，不验热区）；
 *   ④ 数据：搜索入口 → 热搜榜六条原名次原格式 → 搜索出六张卡。
 * 像素级材质（玻璃模糊半径、胶囊圆角、角标偏移）不在本用例范围内。
 *
 * Run: BROWSER_EXECUTABLE=/path/to/chrome node scripts/test-app-smoke.mjs
 * 报告与截图写入 test-results/app-smoke/<时间戳>/。
 */
import assert from "node:assert/strict";
import { installFixture } from "./fixtures/app-ui.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL(`../test-results/app-smoke/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url);
await mkdir(output, { recursive: true });

const report = {
  environment: "Real App in Chromium; Tauri IPC and poster images mocked. Covers structure/touch-target/search only — native WebView and media playback are not covered.",
  cases: [], errors: [], external: [],
};

const titles = ["城市与晚风", "重逢在夏日以后", "星河旅人", "无声的答案", "我的奇妙假期", "晴天来信"];
const titlePattern = new RegExp(`^(${titles.join("|")})$`);
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

/* 视口矩阵沿用旧套件里仍然有意义的几档：窄屏 320、主流 390、横屏 844×390、桌面 900/1440。 */
const cases = [
  { width: 320, height: 694, mobile: true, reduced: true },
  { width: 390, height: 844, mobile: true, android: true },
  { width: 844, height: 390, mobile: true },
  { width: 900, height: 740, mobile: false },
  { width: 1440, height: 960, mobile: false },
];
const caseName = test => `${test.width}x${test.height}${test.mobile ? "" : "-desktop"}${test.android ? "-android" : ""}${test.reduced ? "-reduced" : ""}`;

/* 移动端底栏四项；桌面侧栏另外挂着 排行榜 / 设置（旧注释说桌面没有「吃瓜」，重设计后有了）。 */
const mobileNav = ["首页", "吃瓜", "分类", "我的"];
const desktopNav = ["首页", "吃瓜", "分类", "我的", "排行榜", "设置"];

let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  const browserOptions = { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined };
  browser = await chromium.launch(browserOptions);

  for (const test of cases) {
    const name = caseName(test);
    const result = { ...test, name, checks: [], screenshots: [], passed: false };
    report.cases.push(result);
    const context = await browser.newContext({
      viewport: { width: test.width, height: test.height },
      colorScheme: "dark",
      reducedMotion: test.reduced ? "reduce" : "no-preference",
      ...(test.mobile ? { userAgent: test.android ? android : iphone, isMobile: true, hasTouch: true } : {}),
    });
    await context.addInitScript(installFixture, { theme: "dark", titles });
    /* 使用协议闸门：不种这条，首屏弹协议页、底栏不渲染。 */
    await context.addInitScript(() => localStorage.setItem("hguox_usage_agreement", JSON.stringify({
      version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z",
    })));
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => report.errors.push({ case: name, message: error.message }));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(origin).origin) return route.continue();
      if (url.pathname === "/img") return route.fulfill({
        contentType: "image/svg+xml", headers: { "Access-Control-Allow-Origin": "*" },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><rect width="360" height="480" fill="#263f50"/></svg>',
      });
      report.external.push({ case: name, url: url.href });
      return route.abort();
    });
    const check = label => result.checks.push(label);
    const shot = async label => {
      const filename = `${name}-${label}.png`;
      await page.screenshot({ path: fileURLToPath(new URL(filename, output)), animations: "disabled" });
      result.screenshots.push(filename);
    };

    try {
      await page.goto(origin);
      const nav = page.getByRole("navigation", { name: "主导航" });
      await nav.waitFor();
      const navLabels = test.mobile ? mobileNav : desktopNav;
      for (const label of navLabels) await nav.getByRole("button", { name: label, exact: true }).waitFor();

      /* ① 深色是唯一主题：没有 data-theme 开关，页面底色就是深色 token。 */
      const shell = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme ?? null,
        background: getComputedStyle(document.body).backgroundColor,
        tokenBg: getComputedStyle(document.documentElement).getPropertyValue("--p-bg").trim(),
      }));
      assert.equal(shell.theme, null, "No data-theme switch: the app ships a single (dark) theme");
      assert.equal(shell.background, "rgb(10, 11, 20)", "App background is the dark token #0A0B14");
      assert.equal(shell.tokenBg.toUpperCase(), "#0A0B14", "--p-bg still resolves to the dark surface");
      result.shell = shell;
      check("single dark theme, no appearance switch");

      /* ② 结构 + 布局：四个底栏页挨个进，页面不许横向溢出。 */
      const overflow = {};
      for (const tab of mobileNav) {
        await nav.getByRole("button", { name: tab, exact: true }).click();
        await page.waitForTimeout(400);
        overflow[tab] = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert(overflow[tab] <= 1, `${tab}: page must not overflow horizontally (${overflow[tab]}px)`);
      }
      result.overflow = overflow;
      await shot("tabs");
      check("four tabs render without horizontal overflow");

      /* ③ 设置页开关的触摸热区：44 是移动端下限，别处只验状态不验热区。 */
      if (test.mobile) {
        await nav.getByRole("button", { name: "我的", exact: true }).click();
        await page.getByRole("button", { name: "打开设置", exact: true }).click();
        const switches = page.getByRole("switch");
        await switches.first().waitFor();
        const boxes = await switches.evaluateAll(elements => elements.map(el => ({
          label: el.getAttribute("aria-label"),
          checked: el.getAttribute("aria-checked"),
          width: el.offsetWidth, height: el.offsetHeight,
          trackRadius: el.querySelector(".ios-switch-track") ? getComputedStyle(el.querySelector(".ios-switch-track")).borderRadius : null,
        })));
        result.switches = boxes;
        assert(boxes.length >= 5, `Settings exposes its switches (found ${boxes.length})`);
        for (const box of boxes) {
          assert(box.width >= 44 && box.height >= 44, `${box.label}: touch target is at least 44×44 (${box.width}×${box.height})`);
          assert(["true", "false"].includes(box.checked), `${box.label}: exposes its state on aria-checked`);
          assert.equal(box.trackRadius, "999px", `${box.label}: keeps the capsule track`);
        }
        /* 外观模式已经删除：不许悄悄长回来。 */
        assert.equal(await page.getByText("外观模式").count(), 0, "No appearance picker: the light theme is gone for good");
        assert.equal(await page.getByRole("button", { name: "浅色", exact: true }).count(), 0, "No light-theme option in settings");
        await shot("settings");
        check(`${boxes.length} switches keep a 44×44 touch target; no appearance picker`);
      }

      /* ④ 搜索：热搜榜名次/格式 + 搜索结果张数。 */
      await page.goto(origin);
      await nav.waitFor();
      if (test.mobile) {
        await page.getByRole("button", { name: "搜索", exact: true }).first().click();
        const hotSearch = page.getByRole("region", { name: "热搜榜", exact: true });
        await hotSearch.waitFor();
        assert.equal(await hotSearch.locator("ol > li").count(), titles.length, "Hot searches list every fixture entry");
        assert.equal(await hotSearch.locator("ol > li").first().innerText(), "01\n城市与晚风\n550.1w播放量",
          "Hot searches keep rank order and the play-count format");
        const query = page.getByRole("textbox", { name: "搜索短剧、帖子、题材…", exact: true });
        await query.fill("都市");
        await query.press("Enter");
        await page.getByRole("button", { name: titles[0], exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: titlePattern }).count(), titles.length, "Search returns every fixture title");
        /* 搜索结果用的还是 `.ios-media-grid`：网格自己不许溢出，也不许把页撑宽。 */
        const grids = await page.evaluate(() => [...document.querySelectorAll(".ios-media-grid")]
          .filter(el => !el.closest("[inert], [aria-hidden=true]") && el.getClientRects().length)
          .map(el => ({ overflow: el.scrollWidth - el.clientWidth, right: Math.round(el.getBoundingClientRect().right - innerWidth) })));
        result.searchGrids = grids;
        assert(grids.length > 0, "Search results render inside a media grid");
        for (const grid of grids) assert(grid.overflow <= 1 && grid.right <= 1,
          `Search grid must not overflow (scroll ${grid.overflow}px, right edge +${grid.right}px)`);
        await shot("search");
        check("hot-search rank order, search results, and grid fit");
      }

      result.passed = true;
      console.log(`PASS ${name}`);
    } catch (error) {
      result.error = String(error.stack || error);
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-failure.png`, output)), animations: "disabled" }).catch(() => {});
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      await context.close();
    }
  }

  assert.equal(report.cases.filter(test => !test.passed).length, 0, "All viewport scenarios pass");
  assert.deepEqual(report.errors, [], "No uncaught browser errors");
  assert.deepEqual(report.external, [], "No unexpected requests to live services");
} catch (error) {
  report.error = String(error.stack || error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${fileURLToPath(output)}`);
}
