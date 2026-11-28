/* 3.0.21 F：安卓返回键语义验收。
 *
 * 用法：node scripts/test-back-bridge.mjs
 * 三件事：
 *   ① 桥存在/不存在/抛异常/返回 false/返回 truthy —— 五种情况下到底后台化还是退出；
 *   ② 前端调用的桥名与方法名，与 Kotlin 侧 `__HG_ANDROID__` / `moveToBackground` 一致（静态读源文件）；
 *   ③ App.tsx 真的走这个函数（不再有裸调用），避免「改了工具函数但没接上」。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "back-bridge", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { passed: [], cases: {} };
let vite, browser, page;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 480, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).host === new URL(origin).host) return route.continue();
    return route.abort();
  });

  await page.goto(`${origin}tests/back-bridge.html`);
  await page.waitForFunction(() => window.backBridgeHarness?.names?.length);

  const names = await page.evaluate(() => window.backBridgeHarness.names);
  for (const name of names) {
    const result = await page.evaluate((key) => window.backBridgeHarness.run(key), name);
    report.cases[name] = result;
    const expectExit = name !== "bridgeTrue";
    if (expectExit) {
      assert.equal(result.outcome, "exit", `${name}: 应当退出应用，实际 ${result.outcome}`);
      assert.equal(result.exitRequested, true, `${name}: 必须真的发 plugin:app|exit`);
      assert.deepEqual(result.calls[0], { command: "plugin:app|exit", args: { code: 0 } }, `${name}: 退出命令参数`);
      assert.equal(result.calls.length, 1, `${name}: 只发一次退出命令`);
    } else {
      assert.equal(result.outcome, "background", `${name}: 桥返回 true 时不许退出`);
      assert.equal(result.exitRequested, false, `${name}: 桥成功时不能退出应用`);
      assert.equal(result.calls.length, 0, `${name}: 桥成功时不该有任何 invoke`);
    }
  }
  report.passed.push("桥返回 true → 只后台化（0 次 invoke）；桥缺失 / 返回 false / 抛异常 / 返回 truthy / 退出命令 reject → 都发 plugin:app|exit");

  /* 改前实现（裸调用）在「桥抛异常」时会直接把异常抛出去 = 返回键没反应；
     新实现在同一输入下必须正常落到退出。这一条就是这次 bug 的回归判据。 */
  const legacyBlewUp = await page.evaluate(() => window.backBridgeHarness.legacyThrows("bridgeThrows"));
  report.cases.legacyThrowsBlewUp = legacyBlewUp;
  assert.equal(legacyBlewUp, true, "改前写法应当在桥抛异常时抛出（说明这条用例真的能抓住那个 bug）");
  assert.equal(report.cases.bridgeThrows.outcome, "exit", "新写法在桥抛异常时必须退出应用");
  report.passed.push("回归判据：改前裸调用在桥抛异常时抛出（返回键没反应）→ 新实现照常退出");

  /* ② Kotlin 侧契约（静态核对，防止桥名被单边改名） */
  const kt = await readFile(join(root, "src-tauri/android/com/dusk/player/OrientationPlugin.kt"), "utf8");
  assert.match(kt, /addJavascriptInterface\(AppBridge\(\),\s*"__HG_ANDROID__"\)/, "Kotlin 侧桥名必须是 __HG_ANDROID__");
  assert.match(kt, /fun moveToBackground\(\):\s*Boolean/, "Kotlin 侧方法名必须是 moveToBackground(): Boolean");
  const helper = await readFile(join(root, "src/shared/lib/androidBack.ts"), "utf8");
  assert.match(helper, /__HG_ANDROID__/, "前端必须用同一个桥名 __HG_ANDROID__");
  assert.match(helper, /moveToBackground/, "前端必须用同一个方法名 moveToBackground");
  report.passed.push("桥名/方法名与 Kotlin `__HG_ANDROID__.moveToBackground(): Boolean` 一致");

  /* ③ App.tsx 真的接上了（没有残留的裸调用） */
  const app = await readFile(join(root, "src/app/App.tsx"), "utf8");
  assert.match(app, /backgroundOrExit\(invoke\)/, "App.tsx 的返回键最外层必须走 backgroundOrExit");
  assert.doesNotMatch(app, /__HG_ANDROID__\?\.moveToBackground/, "不许再留裸的桥调用");
  report.passed.push("App.tsx 的返回键最外层已改为 backgroundOrExit(invoke)，无裸调用残留");

  assert.equal(errors.length, 0, `页面报错：${errors.join(" | ")}`);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n✓ 返回键语义（F）通过，取证目录 ${output}`);
} finally {
  await browser?.close();
  await vite?.close();
}
