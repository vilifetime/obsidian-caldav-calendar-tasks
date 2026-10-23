/**
 * 删除 412 分叉回归（2026-10-20 雄哥实测：「新增日程1 from Thunderbird」删除报
 * HTTP 412，条目卡住删不掉）。
 *
 * 背景：服务端那份在本地记录之后被改过（别的客户端改的、或服务端重建导致 etag
 * 变化）时，DELETE 带 If-Match 会 412。思源侧 2026-10-15 修过（雄哥实测
 * 「任务测试Z」同症状），Obsidian 侧一直漏搬：删除分支的 catch 什么都不做，
 * 条目卡在 deleted+dirty，每轮同步重发 DELETE 再 412，同一个「删除失败」
 * 永远报不完。
 *
 * 修复（与思源同构）：
 *   - 冲突策略=本地优先：用户明确要删 → 去掉 If-Match 强删
 *   - 冲突策略=服务端优先：撤销本地删除（deleted/dirty/etag 三清），
 *     下一轮拉取把服务端当前版本带回来，并给出可操作的说明
 *
 * 行为层用真 CalStore + 假 transport（412 可控），源码层钉住 sync.ts 结构与
 * i18n 键。用法：node test/delete-412.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readLF = (rel) => read(rel).replace(/\r\n/g, "\n");

const outDir = path.join(ROOT, ".test-delete412");
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts src/core/sync.ts src/i18n/index.ts ` +
    `--outDir .test-delete412 --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "pipe" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
{
  // store.ts 牵出 config-backup.ts → require("obsidian")，最小 stub
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
global.window = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};
const { CalStore, keyOf } = require(path.join(outDir, "core", "store.js"));
const http = require(path.join(outDir, "core", "http.js"));
const { SyncEngine } = require(path.join(outDir, "core", "sync.js"));
const { initLocale } = require(path.join(outDir, "i18n", "index.js"));
initLocale("zh");

let pass = 0;
const fail = [];
const asyncChecks = [];
function check(name, fn) {
  // ⚠️ 异步用例**不能立即启动**：本文件的用例靠 setTransport 注入假 transport，
  // 多个异步 fn 在同一同步段启动会互相覆盖 stub（后装的生效，先发的请求落到
  // 别人的 stub 上）。一律收进 asyncChecks，由末尾按顺序 await。
  if (fn.constructor.name === "AsyncFunction") {
    asyncChecks.push({ name, fn });
    return;
  }
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
}

const CAL = "http://127.0.0.1:5232/testuser/work/";
const EMPTY = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>';
const mkItem = (over = {}) => ({
  uid: "u1@test",
  kind: "event",
  calendarUrl: CAL,
  href: CAL + "u1.ics",
  etag: '"old-etag"',
  summary: "新增日程1 from Thunderbird",
  allDay: false,
  start: "2026-10-20T09:00:00",
  end: "2026-10-20T10:00:00",
  dirty: false,
  deleted: false,
  ...over
});

const newStore = (conflict = "server") =>
  new CalStore({
    loadData: async () => undefined,
    saveData: async () => undefined,
  });

// ── 行为层：删除 412 的两条分叉 ──────────────────────────────

/** 装假 transport：第一次 DELETE 返 412，第二次看强删（无 If-Match）返 204 */
function stubDelete412Then204(seen) {
  let calls = 0;
  http.setTransport(async (url, opts) => {
    seen.push({ url, method: opts.method, headers: opts.headers });
    calls++;
    if (opts.method === "DELETE") {
      if (calls === 1) return { status: 412, headers: {}, body: "" };
      return { status: 204, headers: {}, body: "" };
    }
    // PROPFIND 等其它请求一律空清单
    return { status: 207, headers: {}, body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>' };
  });
}

check("删除 412 + 本地优先 → 去 If-Match 强删成功，条目移除", async () => {
  const seen = [];
  stubDelete412Then204(seen);
  const store = newStore("local");
  store.settings.conflict = "local";
  const it = mkItem({ deleted: true, dirty: true });
  store.put(it);
  const engine = new SyncEngine(store, () => "direct");
  await engine.pushAndPersist();
  const delCalls = seen.filter((s) => s.method === "DELETE");
  assert.strictEqual(delCalls.length, 2, "应当重发一次 DELETE（强删）");
  assert.ok(delCalls[0].headers["If-Match"], "第一次 DELETE 必须带 If-Match");
  assert.ok(!delCalls[1].headers["If-Match"], "强删不能带 If-Match（旧 etag 就是 412 的根因）");
  assert.strictEqual(store.get(keyOf(it)), undefined, "删除成功后条目必须从本地移除");
});

check("删除 412 + 本地优先但强删仍败 → 报删除失败，不静默", async () => {
  http.setTransport(async (url, opts) => {
    if (opts.method === "DELETE") return { status: 500, headers: {}, body: "" };
    return { status: 207, headers: {}, body: EMPTY };
  });
  const store = newStore("local");
  store.settings.conflict = "local";
  const it = mkItem({ deleted: true, dirty: true });
  store.put(it);
  const engine = new SyncEngine(store, () => "direct");
  await engine.pushAndPersist();
  assert.ok(store.lastError && store.lastError.includes("删除"), `强删失败必须报错，lastError=${store.lastError}`);
});

check("删除 412 + 服务端优先 → 撤销删除三件套，条目留在本地", async () => {
  http.setTransport(async (url, opts) => {
    if (opts.method === "DELETE") return { status: 412, headers: {}, body: "" };
    return { status: 207, headers: {}, body: EMPTY };
  });
  const store = newStore("server");
  store.settings.conflict = "server";
  const it = mkItem({ deleted: true, dirty: true });
  store.put(it);
  const engine = new SyncEngine(store, () => "direct");
  await engine.pushAndPersist();
  const cur = store.get(keyOf(it));
  assert.ok(cur, "服务端优先不得移除本地条目");
  assert.strictEqual(cur.deleted, false, "必须撤销删除标记");
  assert.strictEqual(cur.dirty, false, "必须清 dirty（否则每轮同步重发）");
  assert.strictEqual(cur.etag, undefined, "必须清 etag（否则下一轮拉取写不回服务端版本）");
  assert.ok(
    store.lastNote && store.lastNote.includes("服务端已变更") && store.lastNote.includes("本地优先"),
    `冲突说明要走中性 lastNote（非 lastError），含改冲突策略提示，lastNote=${store.lastNote}`
  );
});

check("删除 412 + 服务端优先 → 不再每轮重发同一条 DELETE", async () => {
  let deleteCalls = 0;
  http.setTransport(async (url, opts) => {
    if (opts.method === "DELETE") { deleteCalls++; return { status: 412, headers: {}, body: "" }; }
    return { status: 207, headers: {}, body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>' };
  });
  const store = newStore("server");
  store.settings.conflict = "server";
  const it = mkItem({ deleted: true, dirty: true });
  store.put(it);
  const engine = new SyncEngine(store, () => "direct");
  await engine.pushAndPersist();
  const after = store.get(keyOf(it));
  assert.ok(after && !after.deleted && !after.dirty, "条目应回到非脏状态");
  // 第二发前先装「拉取能写回」的桩：证明 dirty 清掉后不会再发 DELETE
  http.setTransport(async (url, opts) => {
    if (opts.method === "DELETE") { deleteCalls++; return { status: 412, headers: {}, body: "" }; }
    return { status: 207, headers: {}, body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>' };
  });
  await engine.pushAndPersist();
  assert.strictEqual(deleteCalls, 1, `两轮同步只应发一次 DELETE，实际 ${deleteCalls} 次（412 无限循环未修）`);
});

check("删除正常（204）→ 老路径不受影响", async () => {
  const seen = [];
  http.setTransport(async (url, opts) => {
    seen.push(opts.method);
    if (opts.method === "DELETE") return { status: 204, headers: {}, body: "" };
    return { status: 207, headers: {}, body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>' };
  });
  const store = newStore("server");
  const it = mkItem({ deleted: true, dirty: true });
  store.put(it);
  const engine = new SyncEngine(store, () => "direct");
  await engine.pushAndPersist();
  assert.strictEqual(store.get(keyOf(it)), undefined, "204 删除后条目应移除");
  assert.strictEqual(seen.filter((m) => m === "DELETE").length, 1, "不应重发 DELETE");
});

check("删除 404（服务端已不在）→ 视为成功，不报错", async () => {
  http.setTransport(async (url, opts) => {
    if (opts.method === "DELETE") return { status: 404, headers: {}, body: "" };
    return { status: 207, headers: {}, body: EMPTY };
  });
  const store = newStore("server");
  const it = mkItem({ deleted: true, dirty: true });
  store.put(it);
  const engine = new SyncEngine(store, () => "direct");
  await engine.pushAndPersist();
  assert.strictEqual(store.get(keyOf(it)), undefined, "404 也要移除本地条目");
  assert.ok(store.lastNote && store.lastNote.includes("删除"), `404 应给出成功反馈，lastNote=${store.lastNote}`);
});

// ── 源码断言：钉住结构与 i18n ──────────────────────────────

check("sync.ts 删除分支有 412 分叉（两端同构）", () => {
  const src = readLF("src/core/sync.ts");
  const seg = src.slice(src.indexOf("for (const item of this.store.deletedItems())"));
  assert.ok(/errStatus\(e\) === 412/.test(seg), "删除分支没判 412");
  assert.ok(/conflict === "local"/.test(seg), "缺本地优先强删分支");
  assert.ok(/deleteItem\(\{ \.\.\.item, etag: undefined \}/.test(seg), "强删没去 If-Match");
  assert.ok(/item\.deleted = false;/.test(seg), "服务端优先分支没撤销删除");
  assert.ok(/sync\.deleteConflictServer/.test(seg), "缺可操作说明的 i18n 键");
});

check("i18n 双语言 deleteConflictServer 键齐全", () => {
  for (const f of ["src/i18n/zh_CN.json", "src/i18n/en_US.json"]) {
    const j = JSON.parse(read(f));
    assert.ok(j["sync.deleteConflictServer"], `${f} 缺 sync.deleteConflictServer`);
    assert.ok(j["sync.deleteConflictServer"].includes("{title}"), `${f} 的键缺 {title} 占位`);
  }
});

(async () => {
  // 顺序执行：异步用例之间共享 setTransport，必须一个个来（见 check 的注释）
  for (const c of asyncChecks) {
    try {
      await c.fn();
      pass++;
    } catch (e) {
      fail.push(`${c.name}: ${e.message}`);
    }
  }
  for (const f of fail) console.log("  [FAIL]", f);
  console.log(`\n[delete-412] ${pass} 项通过${fail.length ? `，${fail.length} 项失败` : ""}`);
  if (fail.length > 0) process.exitCode = 1;
})();
