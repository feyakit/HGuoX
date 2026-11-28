import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
/* index.html 里已经没有首帧主题脚本（浅色主题已整体删除），这里直接用测试页本身。 */
const fixtureHtml = await readFile(new URL("../tests/storage-migration.html", import.meta.url), "utf8");
const state = {
  likes: [11], favs: [22], follows: [33],
  history: [{ id: 44, ep: 3, t: 12.5, dur: 80, at: 123456 }],
  searchHist: ["保留搜索记录"], volume: 0.42, muted: false,
  muteOnStartup: false, swipeEp: false, preferHevc: true,
};
const oldData = {
  hghub_app_v1: JSON.stringify(state), hghub_swipe_ep_v2: "1",
};
/* 旧数据里没有这三项，但 store 的 DEFAULTS（src/shared/model/store.tsx:108-109）会在落盘时补齐，
   所以「迁移后的完整形状」必须带上它们。仍然是整体 deepEqual，断言强度不变。 */
const MIGRATED_DEFAULTS = { ambientGlow: true, balanceVolume: false, startupTab: "home" };
let vite, browser;
const errors = [];
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  const html = await vite.transformIndexHtml("/tests/storage-migration.html", fixtureHtml);
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });

  async function open(seed, failure = "") {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      assert.equal(new URL(route.request().url()).origin, new URL(origin).origin);
      if (new URL(route.request().url()).pathname === "/tests/storage-migration.html") {
        return route.fulfill({ contentType: "text/html", body: html });
      }
      return route.continue();
    });
    await page.addInitScript(({ seed, failure }) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.clear();
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
        sessionStorage.setItem("seeded", "1");
      }
      Object.assign(window, { __TAURI_INTERNALS__: { async invoke(command) {
        if (command === "app_boot") return { strict_security: true };
        if (command === "debug_log" || command === "playback_log_write") return;
        throw new Error(`Unexpected IPC: ${command}`);
      } } });
      if (failure === "write") {
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (this === localStorage) throw new DOMException("fixture: quota", "QuotaExceededError");
          return Reflect.apply(originalSet, this, [key, value]);
        };
      }
      if (failure === "read") {
        Storage.prototype.getItem = () => { throw new DOMException("fixture: blocked", "SecurityError"); };
      }
      if (failure === "remove") {
        Storage.prototype.removeItem = () => { throw new DOMException("fixture: blocked", "SecurityError"); };
      }
    }, { seed, failure });
    await page.goto(`${origin}tests/storage-migration.html`);
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady, null, { timeout: 10000 });
    return { context, page };
  }
  const snapshot = page => page.locator("pre").textContent().then(JSON.parse);
  const storage = page => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));

  {
    const { context, page } = await open(oldData);
    assert.deepEqual(await snapshot(page), { ...state });
    const saved = await storage(page);
    assert.deepEqual(Object.keys(saved).sort(), ["hguox_app_v1", "hguox_swipe_ep_v2"]);
    assert.deepEqual(JSON.parse(saved.hguox_app_v1), { ...state, ...MIGRATED_DEFAULTS, postFavs: [] });
    await page.evaluate(() => window.storageMigrationFixture.clearHistory());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("hguox_app_v1")).history.length === 0);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual(await snapshot(page), { ...state, history: [] });
    await context.close();
    console.log("PASS: legacy data and swipe opt-out survive migration and restart");
  }
  {
    const newer = { ...state, favs: [99], history: [] };
    const { context, page } = await open({ ...oldData, hguox_app_v1: JSON.stringify(newer), hguox_swipe_ep_v2: "1" });
    assert.deepEqual(await snapshot(page), { ...newer });
    assert(Object.keys(await storage(page)).every(key => key.startsWith("hguox_")));
    await context.close();
    console.log("PASS: new values win over stale old data and old keys are cleaned");
  }
  {
    const prev = ["hg", "hubx_"].join("");
    const { context, page } = await open({
      [`${prev}app_v1`]: JSON.stringify(state),
      [`${prev}swipe_ep_v2`]: "1",
    });
    assert.deepEqual(await snapshot(page), { ...state });
    const saved = await storage(page);
    assert.deepEqual(Object.keys(saved).sort(), ["hguox_app_v1", "hguox_swipe_ep_v2"]);
    await context.close();
    console.log("PASS: previous-brand keys migrate to hguox_* and the old keys are removed");
  }
  {
    const { context, page } = await open({ hghub_app_v1: JSON.stringify({ ...state, history: [44] }) });
    const value = await snapshot(page);
    assert.equal(value.swipeEp, true);
    assert.equal(value.history[0].id, 44);
    assert.equal(value.history[0].ep, 1);
    assert.equal(value.history[0].t, 0);
    await context.close();
    console.log("PASS: historical history format and the original one-time swipe upgrade still work");
  }
  for (const failure of ["write", "remove"]) {
    const { context, page } = await open(oldData, failure);
    assert.deepEqual(await snapshot(page), { ...state });
    const saved = await storage(page);
    for (const [key, value] of Object.entries(oldData)) assert.equal(saved[key], value);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual(await snapshot(page), { ...state });
    await context.close();
    console.log(`PASS: ${failure} failure retains legacy data and preferences across restarts`);
  }
  for (const seed of [{}, { hghub_app_v1: "invalid json" }]) {
    const { context, page } = await open(seed);
    assert.deepEqual((await snapshot(page)).history, []);
    await context.close();
  }
  {
    const { context, page } = await open({}, "read");
    assert.deepEqual((await snapshot(page)).favs, []);
    await context.close();
  }
  {
    const { context, page } = await open({ hghub_swipe_ep_v2: "1" });
    const saved = await storage(page);
    assert.equal(saved.hguox_swipe_ep_v2, "1");
    assert.equal(saved.hghub_swipe_ep_v2, undefined);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: fresh installs, malformed data and unavailable storage do not crash");
} finally {
  await browser?.close();
  await vite?.close();
}
