/**
 * 回归测试：「根路径不支持 WebDAV（405）」时的 DAV 入口探测
 * （与 SiYuan test/dav-entry.test.mjs 同构，2026-10-24）
 *
 * 背景（雄哥 2026-10-24 实测）：自建 Baïkal 前面套 nginx，根路径 `/` 只放行
 * GET/HEAD（网页管理界面），对根路径发 PROPFIND/OPTIONS 直接 405。真正的 DAV 入口
 * 是 `http://<host>:<port>/dav.php`（`WWW-Authenticate: Basic realm="sabre/dav"`）。
 *
 * 修法：testConnection 遇 405/501 时主动探测常见 DAV 入口，给用户一个能直接粘的地址；
 * .well-known 的 302 目标若丢了端口，用原 origin 重建再验。
 *
 * 用法：node test/dav-entry.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const outDir = path.join(ROOT, ".test-daventry");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts src/i18n/index.ts ` +
    `--outDir .test-daventry --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "pipe" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
{
  const stubDir = path.join(outDir, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" })
  );
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `"use strict";\nfunction Notice() {}\nexports.Notice = Notice;\n` +
      `exports.normalizePath = function normalizePath(p) { return String(p).replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/"); };\n`
  );
}
global.window = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };

const http = require(path.join(outDir, "core", "http.js"));
const caldav = require(path.join(outDir, "core", "caldav.js"));
const { initLocale } = require(path.join(outDir, "i18n", "index.js"));
initLocale("zh");

let pass = 0;
// ⚠️ 必须**顺序 await**：各用例共用 http.setTransport，并发/不等待会让后一个用例
// 换掉 transport，前一个用例的候选探测请求打到别的 mock 上（2026-10-24 实测）。
const check = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  [FAIL]", name, "\n    ", e.message);
    process.exitCode = 1;
  }
};

const AUTH = { username: "xiongfei", password: "secret" };
const HOST = "http://nas.bonebear.cn:5808";

const withTransport = (router) => {
  const seen = [];
  http.setTransport(async (url, opts) => {
    seen.push({ url: String(url), method: opts.method });
    return router({ url: String(url), method: opts.method });
  });
  return { seen };
};

async function main() {
await check("根路径 405 → 探测到 Baïkal 的 /dav.php/ 入口", () => {
  const { seen } = withTransport((req) => {
    if (req.url === HOST + "/") return { status: 405, headers: {}, body: "405 Not Allowed" };
    if (req.url === HOST + "/dav.php/") return { status: 401, headers: {}, body: "Unauthorized" };
    return { status: 404, headers: {}, body: "404" };
  });
  return caldav.probeDavEntry(HOST, "direct", AUTH).then((entry) => {
    assert.strictEqual(entry, HOST + "/dav.php/", "应命中 Baïkal 的 DAV 入口，实际 " + entry);
    assert.ok(
      seen.some((s) => s.url === HOST + "/.well-known/caldav"),
      "应先试标准入口 .well-known/caldav"
    );
  });
});

await check(".well-known/caldav 的 302 丢了端口 → 用原 origin 重建后再验证", () => {
  withTransport((req) => {
    if (req.url === HOST + "/.well-known/caldav") {
      return { status: 302, headers: { location: "http://nas.bonebear.cn/dav.php" }, body: "" };
    }
    if (req.url === HOST + "/dav.php") return { status: 401, headers: {}, body: "Unauthorized" };
    return { status: 404, headers: {}, body: "404" };
  });
  return caldav.probeDavEntry(HOST, "direct", AUTH).then((entry) => {
    assert.strictEqual(entry, HOST + "/dav.php", "重建后应保留 5808 端口，实际 " + entry);
  });
});

await check("候选全不通 → 返回空串", () => {
  withTransport(() => ({ status: 404, headers: {}, body: "404" }));
  return caldav.probeDavEntry(HOST, "direct", AUTH).then((entry) => {
    assert.strictEqual(entry, "", "探测不到时应返回空串，实际 " + entry);
  });
});

await check("testConnection 遇 405：提示里要带已探测到的入口地址", () => {
  withTransport((req) => {
    if (req.url === HOST + "/") return { status: 405, headers: {}, body: "405 Not Allowed" };
    if (req.url === HOST + "/dav.php/") return { status: 401, headers: {}, body: "Unauthorized" };
    return { status: 404, headers: {}, body: "404" };
  });
  return caldav.testConnection(HOST, "direct", AUTH).then((r) => {
    assert.strictEqual(r.ok, false, "根路径 405 不算连接成功");
    assert.ok(/dav\.php/.test(r.message), "提示里应给出探测到的入口，实际：" + r.message);
    assert.ok(/5808/.test(r.message), "提示里应带完整地址（含端口），实际：" + r.message);
  });
});

await check("testConnection 遇 405 且探测不到：提示要教用户填哪种地址", () => {
  withTransport(() => ({ status: 405, headers: {}, body: "405 Not Allowed" }));
  return caldav.testConnection(HOST, "direct", AUTH).then((r) => {
    assert.strictEqual(r.ok, false);
    assert.ok(/dav\.php|well-known/.test(r.message), "提示里应给出常见入口示例，实际：" + r.message);
  });
});

console.log(`\n[dav-entry] ${pass} 项通过`);
}


main();
