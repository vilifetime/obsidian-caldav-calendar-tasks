/**
 * 上传链路第二批回归（2026-10-20 从思源侧同构移植）
 *
 * 覆盖范围（Obsidian 侧第二批的三件事）：
 *  1. putItem 超大预检 —— ICS 真实字节数超过「单个ICS文件限制」时请求都不发，
 *     直接抛 413，文案带上实际大小与上限（设置值，不说成「服务器默认」）。
 *  2. 413 专门文案 —— 服务端（或其反代）拒大 body 时说明真实上限各不相同
 *     （nginx 反代常见 1MB / Radicale 10MB / PHP 8MB），而不是含糊的「HTTP 413」。
 *  3. uploadTimeoutMs —— 上传超时按 body 字节数放宽（基线 60s + 32KB/s 折算 +
 *     10 分钟封顶）。Obsidian 原先写死 30s，7MB 附件在家用 NAS 上必然超时。
 *
 * 与思源侧的对账：思源这些行为散在 caldav.ts / http.ts 与 digest.test.mjs 里，
 * 本文件集中钉 Observable 行为（抛错文案 / 传给 transport 的 timeoutMs / 请求发没发）。
 *
 * 用法：node test/upload-limits.cjs
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 与 attach-ics.cjs 同一套路：tsc 编译到临时目录再引
const outDir = path.join(ROOT, ".test-upload");
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts ` +
    `--outDir .test-upload --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "inherit" }
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
    `"use strict";\n` +
      `exports.normalizePath = function normalizePath(p) {\n` +
      `  return String(p).replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");\n` +
      `};\n`
  );
}
global.window = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};
const caldav = require(path.join(outDir, "core", "caldav.js"));
const http = require(path.join(outDir, "core", "http.js"));
const i18n = require(path.join(outDir, "i18n", "index.js"));
// Node 下无 moment / localStorage，detectHostLang 兜底返回 "en"。
// 本测试断言中文文案，显式切到 zh（切回 en 的用例在末尾）。
i18n.initLocale("zh");

let failed = 0;
function check(name, cond, hint) {
  if (cond) console.log("  [PASS] " + name);
  else {
    console.log("  [FAIL] " + name + (hint ? " —— " + hint : ""));
    failed++;
  }
}

/** 假 transport：记录调用与收到的 opts，按 respondStatus 返回 */
let lastOpts = null;
let calls = 0;
let respondStatus = 201;
http.setTransport(async (_url, opts) => {
  calls++;
  lastOpts = opts;
  return { status: respondStatus, headers: { etag: '"new-etag"' }, body: "", elapsedMs: 1, via: "direct" };
});

const MB = 1024 * 1024;
const item = { uid: "u@t", kind: "todo", calendarUrl: "http://cal/", href: "http://cal/u.ics", summary: "t" };
const put = (ics, maxMB) => caldav.putItem(item, ics, "direct", { username: "u", password: "p" }, maxMB);
const reset = (status = 201) => {
  calls = 0;
  lastOpts = null;
  respondStatus = status;
};

(async () => {
  console.log("putItem 超大预检：请求都不发");

  {
    reset();
    let err = null;
    try {
      await put("x".repeat(10 * MB + 1024));
    } catch (e) {
      err = e;
    }
    check("超过默认 10MB：抛 413", err && err.status === 413, err && String(err.message).slice(0, 80));
    check("文案带实际大小", err && /10\.\dMB/.test(err.message), err && err.message);
    check("文案带上限（默认 10）", err && /限制.{0,4}10MB/.test(err.message), err && err.message);
    check("请求根本没发（calls === 0）", calls === 0, "calls=" + calls + " —— 超限还发请求，413 回来也是含糊错误");
  }

  {
    reset();
    let err = null;
    try {
      await put("x".repeat(Math.floor(1.5 * MB)), 1);
    } catch (e) {
      err = e;
    }
    check("设置值 1MB 生效：1.5MB 被拒", err && err.status === 413);
    check("文案里的上限取设置值（1）", err && /限制.{0,4}1MB/.test(err.message), err && err.message);
    check("被拒时请求还是没发", calls === 0);
  }

  {
    reset();
    // 恰好等于上限：判据是 > 才拒，等于必须放行（否则用户卡在「怎么都传不上去」）
    const r = await put("x".repeat(2 * MB), 2);
    check("恰好等于上限：放行", calls === 1, "calls=" + calls);
    check("放行时返回服务端 etag", r && r.etag === "new-etag", JSON.stringify(r));
  }

  {
    reset();
    const r = await put("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
    check("普通小 ICS：放行", calls === 1 && lastOpts.method === "PUT");
    check("普通小 ICS：返回 etag", r && r.etag === "new-etag");
  }

  console.log("\n413 专文：说清真实上限各不相同");

  {
    reset(413);
    let err = null;
    try {
      await put("small");
    } catch (e) {
      err = e;
    }
    check("服务端 413 → 抛 413", err && err.status === 413);
    check("文案提 nginx 反代常见 1MB", err && /nginx 反代常见默认仅 1MB/.test(err.message), err && err.message);
    check("文案提 Radicale 默认 10MB", err && /Radicale 默认 10MB/.test(err.message));
    check("文案给出 actionable 建议（删附件/改外链）", err && /删除该待办的大附件或改用外链/.test(err.message));
    check("不是含糊的「HTTP 413」一句话", err && err.message.length > 60, err && err.message);
  }

  console.log("\nuploadTimeoutMs：按 body 字节数放宽");

  {
    const t = http.uploadTimeoutMs;
    check("0 / 负数 / NaN → 基线 60s", t(0) === 60000 && t(-1) === 60000 && t(NaN) === 60000);
    // 非零小 body 也要按 32KB/s 折算，只是绝对量极小：ceil(100/32768*1000)=4ms
    check("100 字节 → 基线 +4ms", t(100) === 60004, String(t(100)));
    check("1MB → 60s + 32s = 92s", t(1 * MB) === 92000, String(t(1 * MB)));
    check("3MB → 60s + 96s = 156s", t(3 * MB) === 156000, String(t(3 * MB)));
    check("7MB → 60s + 224s = 284s", t(7 * MB) === 284000, String(t(7 * MB)));
    check("30MB 封顶 10 分钟", t(30 * MB) === 600000, String(t(30 * MB)));

    // 行为层：putItem 把换算后的 timeoutMs 传给 transport
    reset();
    await put("x".repeat(3 * MB), 10);
    check("3MB ICS：transport 收到 156s 预算", lastOpts && lastOpts.timeoutMs === 156000, lastOpts && String(lastOpts.timeoutMs));
    reset();
    await put("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
    // 30 字节 → ceil(30/32768*1000)=1ms
    check("小 ICS：transport 收到基线+1ms", lastOpts && lastOpts.timeoutMs === 60001, lastOpts && String(lastOpts.timeoutMs));
  }

  console.log("\ni18n 与源码防漂移");

  {
    const zh = JSON.parse(read("src/i18n/zh_CN.json"));
    const en = JSON.parse(read("src/i18n/en_US.json"));
    check("zh 有 net.icsTooLarge", typeof zh["net.icsTooLarge"] === "string" && /\{size\}/.test(zh["net.icsTooLarge"]) && /\{max\}/.test(zh["net.icsTooLarge"]));
    check("zh 有 net.tooLarge413", typeof zh["net.tooLarge413"] === "string" && /nginx/.test(zh["net.tooLarge413"]));
    check("en 两侧键集一致（icsTooLarge / tooLarge413）", typeof en["net.icsTooLarge"] === "string" && typeof en["net.tooLarge413"] === "string");
    check("en 文案同样带占位符", /\{size\}/.test(en["net.icsTooLarge"]) && /\{max\}/.test(en["net.icsTooLarge"]));

    // 英文语言下的行为抽查：占位符插值与中文同机制，切 locale 后文案应换血
    i18n.initLocale("en");
    reset();
    let enErr = null;
    try {
      await put("x".repeat(Math.floor(1.5 * MB)), 1);
    } catch (e) {
      enErr = e;
    }
    check("en locale：预检文案是英文且插值正确", enErr && /ICS 1\.5MB/.test(enErr.message) && /limit" of 1MB/.test(enErr.message), enErr && enErr.message);
    i18n.initLocale("zh");

    const src = read("src/core/caldav.ts");
    // ⚠️ 顺序断言必须圈在 putItem 函数体里：文件里更早的函数（PROPFIND 等）
    //    也有 await httpRequest(，裸 indexOf 会撞上它们、永远判错。
    const putFn = /export async function putItem\([\s\S]*?\n\}/.exec(src);
    check("能定位 putItem 函数体", !!putFn);
    check("预检在 httpRequest 之前", !!putFn && putFn[0].indexOf("icsBytes > maxBytes") < putFn[0].indexOf("await httpRequest("), "预检挪到请求之后就等于没挡");
    check("timeoutMs 走 uploadTimeoutMs(icsBytes)", src.includes("timeoutMs: uploadTimeoutMs(icsBytes)"), "写死 30000 会让 7MB 附件在家用 NAS 上必然超时");
    check("413 分支存在", !!putFn && /res\.status === 413/.test(putFn[0]) && /net\.tooLarge413/.test(putFn[0]));
    const syncSrc = read("src/core/sync.ts");
    // 上限 2026-10-26 下沉为**账户级**（不同服务器各配各的：Radicale 10MB / PHP 8MB）：
    // 每处 putItem 都要把所属账户的 icsSizeMaxMB 传下去，漏传就走默认 10MB，
    // 账户里配的上限形同虚设。判据用「调用处个数」而非写死的字符串形态，
    // 免得传参写法一变（settings.icsSizeMaxMB → acc?.icsSizeMaxMB）就误报。
    const putCalls = (syncSrc.match(/putItem\(/g) || []).length;
    const icsMaxPasses = (syncSrc.match(/putItem\([^;]*?icsSizeMaxMB/g) || []).length;
    // 4 处：pushDirty 正常 + 412 覆盖 + iCloud 预上传建资源 + 403 降级的重传（2026-10-24
    // 「日程↔待办互转」新增：服务端拒收同 href 换组件类型时，删旧资源后重传也要受同一上限约束）
    check(
      "sync.ts 四处 putItem 都带账户级 icsSizeMaxMB（pushDirty 正常 + 412 覆盖 + iCloud 预上传建资源 + 403 降级重传）",
      putCalls === 4 && icsMaxPasses === 4,
      `putItem ${putCalls} 处 / 带上限 ${icsMaxPasses} 处 —— 漏传的调用走默认 10MB，账户里配的上限不生效`
    );
    const httpSrc = read("src/core/http.ts");
    check("http.ts 导出 uploadTimeoutMs", /export function uploadTimeoutMs/.test(httpSrc));
    check("预算参数是 10-16 放宽后的值（60s / 32KB/s / 10min）", /BASE_MS = 60000/.test(httpSrc) && /32 \* 1024/.test(httpSrc) && /CAP_MS = 600000/.test(httpSrc));
  }

  console.log(failed === 0 ? "\n✓ 上传链路第二批回归测试通过" : `\n✗ ${failed} 个用例失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
