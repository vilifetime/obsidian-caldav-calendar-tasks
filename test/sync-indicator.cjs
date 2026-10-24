/**
 * 「同步中」可见状态回归测试（2026-10-25 雄哥要求，与思源端同构）
 *
 * 背景：雄哥要求「日程、待办新建或编辑变动后立即向服务器提交时，刷新按钮
 * 也要转一下，示意该条目已同步到服务器；同步完停止转动，规矩跟手动点同步一样」。
 *
 * 此前的行为：只有手动点「立即同步」（syncAll）才可能置同步中状态，
 * 「保存即推」（createItem/updateItem/removeItem → pushAndPersist）不置位
 * → 按钮不转，用户以为改动还没提交。
 *
 * 行为层用真 SyncEngine + 假 fetch；源码层钉住 panel.ts 的响应式接线。
 *
 * 用法：node test/sync-indicator.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const outDir = path.join(ROOT, ".test-syncindicator");
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/sync.ts src/core/secret.ts src/core/errors.ts src/core/digest.ts ` +
    `src/constants.ts ` +
    `--outDir .test-syncindicator --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "pipe" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
{
  // sync.ts → caldav.ts → store.ts 都会 require("obsidian")（Notice 等）
  const stubDir = path.join(outDir, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" })
  );
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `"use strict";\n` +
      `function Notice() {}\n` +
      `exports.Notice = Notice;\n` +
      `exports.normalizePath = function normalizePath(p) {\n` +
      `  return String(p).replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");\n` +
      `};\n`
  );
  // i18n 与本测试无关（只要 t() 返回字符串），给个桩，免得多编译两个 json
  fs.writeFileSync(
    path.join(outDir, "i18n-stub.js"),
    `"use strict";\nexports.t = function (k) { return String(k); };\n`
  );
}
global.window = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args)
};

// 编译产物里 sync/ics/caldav/store 都 require("../i18n") → 映射到桩
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "../i18n" || request === "@/i18n" || /\/i18n$/.test(request)) {
    return path.join(outDir, "i18n-stub.js");
  }
  return origResolve.call(this, request, ...rest);
};

const { CalStore } = require(path.join(outDir, "core", "store.js"));
const { SyncEngine } = require(path.join(outDir, "core", "sync.js"));
// ⚠️ Obsidian 端的 http.ts 与思源不同：`viaTransport` 在 transport 未注入时
// **直接抛错**（net.transportUninit），没有 global fetch 回退 —— 测试必须
// 显式 setTransport 注入，stub globalThis.fetch 是无效的（请求根本发不出去，
// 症状是「syncing 一闪即逝、fetch 零调用」）。
const { setTransport } = require(path.join(outDir, "core", "http.js"));

let pass = 0;
let fail = 0;
// CJS 没有顶层 await：用例统一注册后**串行**跑（不能并发 —— 多个用例共享
// setTransport 这份全局状态，并发会互相覆盖 transport / 把对方的置成 null，
// 症状是「请求莫名走空 transport 抛错、断言莫名其妙失败」）。
const cases = [];
function t(name, fn) {
  cases.push({ name, fn });
}
/** 分组标题（作为空用例插入，保证输出顺序与注册顺序一致） */
function section(title) {
  cases.push({ name: title, fn: null });
}

// ---- 假传输层（setTransport 注入，见上方说明） ----
function withFetch(router) {
  const calls = [];
  setTransport(async (url, opts) => {
    const req = { url: String(url), method: opts?.method || "GET", body: String(opts?.body || "") };
    calls.push(req);
    const r = router(req);
    return { status: r.status, headers: r.headers || {}, body: r.body ?? "", elapsedMs: 0, via: "direct" };
  });
  return { calls, restore: () => setTransport(null) };
}
/** 让出事件循环：确保已启动的推送真的把请求发出去了 */
const tick = () => new Promise((r) => setTimeout(r, 0));

const CAL = "http://dav.test/cal/";
const cal = { url: CAL, displayName: "工作", enabled: true, supportsEvent: true, supportsTodo: true };

async function mkStore(items = [], settings = {}) {
  const st = new CalStore({ loadData: async () => undefined, saveData: async () => undefined });
  await st.load();
  st.settings = {
    ...st.settings,
    serverUrl: "http://dav.test/",
    username: "u",
    password: "p",
    calendars: [{ ...cal }],
    conflict: "server",
    syncIntervalMin: 0,
    ...settings
  };
  items.forEach((it) => st.put(it));
  return st;
}

const mkItem = (over = {}) => ({
  uid: "u1@test",
  kind: "todo",
  calendarUrl: CAL,
  href: CAL + "u1.ics",
  summary: "待办",
  allDay: false,
  start: "",
  end: "",
  dirty: true, // 默认造脏条目 → 会走推送
  ...over
});

const okRouter = () => (req) => (req.method === "PUT" ? { status: 204, body: "" } : { status: 200, body: "" });

// ⚠️ 断言必须**事后**做，不能在 transport 回调里当场 assert：
// 回调里抛出的错误会被 pushDirty 的 catch 吞掉（记进 report.errors），
// 用例表面「通过」—— 变异验证时四条行为用例全绿就是这么来的（假阴性）。
// 所以这里只**记录** PUT/DELETE 发出时的 syncing 快照，事后再断言。
function recordSyncing(st, base) {
  const seen = [];
  return {
    seen,
    router: (req) => {
      const syncing = st.syncing; // 先快照，再放行请求
      const r = base(req);
      if (req.method === "PUT" || req.method === "DELETE") seen.push({ method: req.method, syncing });
      return r;
    }
  };
}

section("[sync-indicator] 保存即推也要置「同步中」");

t("新建条目推送期间 store.syncing === true，结束后 false", async () => {
  const st = await mkStore();
  const rec = recordSyncing(st, okRouter());
  const { restore } = withFetch(rec.router);
  try {
    const eng = new SyncEngine(st, () => "direct");
    await eng.createItem(mkItem({ uid: "new@test" }));
    assert.ok(rec.seen.length > 0, "应发生过 PUT");
    assert.strictEqual(rec.seen[0].syncing, true, "推送期间 syncing 应为 true");
    assert.strictEqual(st.syncing, false, "推送结束后应复位");
  } finally {
    restore();
  }
});

t("编辑条目推送期间置位、结束复位", async () => {
  const st = await mkStore([mkItem({ uid: "e@test", etag: '"e1"' })]);
  const rec = recordSyncing(st, okRouter());
  const { restore } = withFetch(rec.router);
  try {
    const eng = new SyncEngine(st, () => "direct");
    const it = st.get("e@test");
    it.summary = "改过的标题";
    await eng.updateItem(it);
    assert.ok(rec.seen.length > 0, "应发生过 PUT");
    assert.strictEqual(rec.seen[0].syncing, true, "推送期间应置位");
    assert.strictEqual(st.syncing, false, "推送结束后应复位");
    assert.strictEqual(it.summary, "改过的标题");
  } finally {
    restore();
  }
});

t("删除条目推送期间置位、结束复位", async () => {
  const st = await mkStore([mkItem({ uid: "d@test", etag: '"e1"' })]);
  const rec = recordSyncing(st, okRouter());
  const { restore } = withFetch(rec.router);
  try {
    const eng = new SyncEngine(st, () => "direct");
    await eng.removeItem(st.get("d@test"));
    assert.ok(rec.seen.length > 0, "应发生过 DELETE");
    assert.strictEqual(rec.seen[0].syncing, true, "推送期间应置位");
    assert.strictEqual(st.syncing, false, "推送结束后应复位");
  } finally {
    restore();
  }
});

t("推送失败（PUT 500）也要复位 —— 按钮不能永远转下去", async () => {
  const st = await mkStore();
  const { restore } = withFetch((req) => (req.method === "PUT" ? { status: 500, body: "boom" } : { status: 200, body: "" }));
  try {
    const eng = new SyncEngine(st, () => "direct");
    await eng.createItem(mkItem({ uid: "fail@test" }));
    assert.strictEqual(st.syncing, false, "失败也必须复位");
    assert.ok(st.lastError, "失败应留下错误提示");
  } finally {
    restore();
  }
});

section("[sync-indicator] 手动 syncAll 的置位/复位");

t("syncAll 期间置位、结束复位", async () => {
  const st = await mkStore();
  // 同上：快照而非当场断言（syncAll 的 PROPFIND/REPORT 冒泡同样会被吞）
  const seen = [];
  const { restore } = withFetch((req) => {
    const syncing = st.syncing;
    if (req.method !== "PUT") seen.push(syncing);
    return { status: 200, body: "" };
  });
  try {
    const eng = new SyncEngine(st, () => "direct");
    await eng.syncAll();
    assert.ok(seen.length > 0, "应发过非 PUT 请求");
    assert.strictEqual(seen[0], true, "同步期间 syncing 应为 true");
    assert.strictEqual(st.syncing, false, "同步结束后应复位");
  } finally {
    restore();
  }
});

section("[sync-indicator] 引用计数：并发的两条路径互不抹掉");

t("syncAll 与保存即推并存：先结束的那条不抹掉另一条的转动", async () => {
  const st = await mkStore([mkItem({ uid: "c@test", etag: '"e1"' })]);
  // 闸门：PUT 先挂起，等两条路径都启动后再放行
  let releasePut = () => {};
  const putGate = new Promise((r) => (releasePut = r));
  setTransport(async (url, opts) => {
    const method = opts?.method || "GET";
    if (method === "PUT") await putGate; // 挂住，直到外部放行
    return { status: method === "PUT" ? 204 : 200, headers: {}, body: "", elapsedMs: 0, via: "direct" };
  });
  try {
    const eng = new SyncEngine(st, () => "direct");
    const it = st.get("c@test");
    it.summary = "并存测试";

    // 路径 ①：保存即推（PUT 会被闸门挂住）
    const p1 = eng.updateItem(it);
    await tick();
    assert.strictEqual(st.syncing, true, "保存即推已启动 ⇒ 应置位");

    // 路径 ②：手动全量同步（Obsidian 端不经串行队列，两步会各发各的请求；
    // 但 beginSyncing 立即生效，计数此时应为 2）
    const p2 = eng.syncAll();
    assert.strictEqual(st.syncing, true, "两条路径并存 ⇒ 仍应置位");

    // 放行 ①：它的 endSyncing 只把计数从 2 减到 1，**不能**复位
    releasePut();
    await p1;
    assert.strictEqual(st.syncing, true, "① 已结束但 ② 还在跑 ⇒ 必须继续转（这条是本次改动的核心）");

    // ② 收尾后才能真正复位
    await p2;
    assert.strictEqual(st.syncing, false, "两条都结束 ⇒ 复位");
  } finally {
    setTransport(null);
  }
});

t("syncing 不落盘（瞬时状态不该写进 data.json）", async () => {
  const st = await mkStore();
  const saved = [];
  st.env = { loadData: async () => undefined, saveData: async (d) => { saved.push(d); } };
  const { restore } = withFetch(okRouter());
  try {
    const eng = new SyncEngine(st, () => "direct");
    await eng.createItem(mkItem({ uid: "p@test" }));
    assert.ok(saved.length > 0, "应发生过落盘");
    for (const d of saved) {
      assert.ok(!("syncing" in d), "顶层不该有 syncing");
      assert.ok(!(d.sync && "syncing" in d.sync), "sync 段不该有 syncing");
    }
  } finally {
    restore();
  }
});

section("[sync-indicator] 源码级断言：按钮由 store.syncing 单一来源驱动");

t("panel.ts：onChange 里按 store.syncing 切 is-syncing，且不受 suppress 抑制", async () => {
  const src = read("src/ui/panel.ts");
  assert.ok(
    /syncBtn\.classList\.toggle\("is-syncing", !!ctx\.store\.syncing\)/.test(src),
    "onChange 应响应式切 is-syncing"
  );
  // 手动加/减 class 的旧写法必须去掉（否则两条路径并存时会互相抹掉）
  assert.ok(!/syncBtn\.classList\.add\("is-syncing"\)/.test(src), "不应再手动加 class");
  assert.ok(!/syncBtn\.classList\.remove\("is-syncing"\)/.test(src), "不应再手动减 class");
  // 必须挂在 suppressRerender 判断**之前**（快速勾选那条路径也要转）
  // ⚠️ 仓库是 CRLF，行尾禁写死 \n（用 \s* 兼容）；且注释里也出现
  // "suppressRerender" 字样，必须锚定到真正的判断语句 `if (!suppressRerender)`。
  const m = /const unsub = ctx\.store\.onChange\(\(\) => \{([\s\S]*?)\}\);\s*renderAll\(\);/.exec(src);
  assert.ok(m, "应能找到 onChange 订阅块");
  const body = m[1];
  assert.ok(
    body.indexOf('classList.toggle("is-syncing"') < body.indexOf("if (!suppressRerender)"),
    "is-syncing 的同步必须在 suppressRerender 判断之前（勾选路径不被抑制）"
  );
});

t("sync.ts：保存即推入口置位（beginSyncing）", async () => {
  const src = read("src/core/sync.ts");
  assert.ok(/private syncDepth = 0;/.test(src), "应有引用计数");
  assert.ok(/private beginSyncing\(\)/.test(src), "应有 beginSyncing");
  assert.ok(/private endSyncing\(\)/.test(src), "应有 endSyncing");
  // pushAndPersist（保存即推）里必须调 beginSyncing / endSyncing
  const m = /private async pushAndPersist\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(m, "应能找到 pushAndPersist");
  assert.ok(/this\.beginSyncing\(\)/.test(m[1]), "保存即推必须置位 syncing");
  assert.ok(/this\.endSyncing\(\)/.test(m[1]), "保存即推必须复位 syncing");
});

t("store.ts：有 syncing 字段（Obsidian 端本轮新建）", async () => {
  const src = read("src/core/store.ts");
  assert.ok(/syncing = false;/.test(src), "CalStore 应声明 syncing 字段");
});

/* ── 结果（串行跑，见 t() 上方注释） ───────────────────────── */
(async () => {
  for (const c of cases) {
    if (!c.fn) {
      console.log("\n" + c.name);
      continue;
    }
    try {
      await c.fn();
      pass++;
      console.log("  ✓", c.name);
    } catch (e) {
      fail++;
      console.error("  ✗", c.name, "\n    ", e.message);
      process.exitCode = 1;
    }
  }
  console.log(`\n[sync-indicator] 通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ""}`);
  process.exit(fail === 0 ? 0 : 1);
})();
