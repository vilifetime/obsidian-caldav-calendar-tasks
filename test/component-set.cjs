/**
 * 回归测试：日历能力（supported-calendar-component-set）+ 互转 403 的非破坏性降级
 * （与 SiYuan test/reconcile.test.mjs 同批用例同构，2026-10-24）。
 *
 * 背景（雄哥 2026-10-24 实测）：iCloud 待办转日程后同步报「无权限（403）」，且
 * **服务端那条待办被删没了**。两层根因：
 *   ① 发现日历的 PROPFIND 从没请求过 supported-calendar-component-set（它是
 *      protected 属性，allprop 不带），于是 iCloud 的「提醒事项」集合被当成
 *      「既收 VEVENT 又收 VTODO」，往里 PUT VEVENT 必然 403（RFC 4791 §5.2.3
 *      规定必须拒绝）。
 *   ② 403 降级是「先 DELETE 旧资源、再 PUT 重建」——DELETE 成功、重建仍被 403，
 *      服务端那条就彻底没了。
 *
 * 修法：① PROPFIND 点名请求该属性 + 老配置同步前补探测；② 降级改成「先 PUT 同
 * 集合的新地址，成功后再删旧的」；③ 目标类型不被支持时直接给可操作提示，一个字节
 * 都不删。另：换日历/互转搬家（movedFrom）同样遵循先建后删。
 *
 * 用法：node test/component-set.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const outDir = path.join(ROOT, ".test-componentset");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts src/core/sync.ts src/i18n/index.ts ` +
    `--outDir .test-componentset --module commonjs --target es2020 --moduleResolution node ` +
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

const { CalStore, keyOf } = require(path.join(outDir, "core", "store.js"));
const http = require(path.join(outDir, "core", "http.js"));
const { SyncEngine } = require(path.join(outDir, "core", "sync.js"));
const caldav = require(path.join(outDir, "core", "caldav.js"));
const { initLocale } = require(path.join(outDir, "i18n", "index.js"));
initLocale("zh");

let pass = 0;
const fail = [];
const asyncChecks = [];
function check(name, fn) {
  // 异步用例排队串行执行：共用 setTransport，并发会互相覆盖 stub
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
const OTHER = "http://127.0.0.1:5232/testuser/home/";
const EMPTY = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>';
const EVENT_ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
  "BEGIN:VEVENT", "UID:u1@test", "SUMMARY:测试任务",
  "DTSTART:20261023T070000Z", "DTEND:20261023T080000Z",
  "END:VEVENT", "END:VCALENDAR"
].join("\r\n");

const mkItem = (over = {}) => ({
  uid: "u1@test",
  kind: "todo",
  calendarUrl: CAL,
  href: CAL + "u1.ics",
  etag: '"old-etag"',
  summary: "测试任务",
  allDay: false,
  start: "2026-10-23T15:00:00",
  end: "2026-10-23T16:00:00",
  dirty: true,
  deleted: false,
  ...over
});

const { seedAccounts } = require("./accfx.cjs");

// 账户化（2026-10-26）：日历 / 凭据 / 冲突策略都挂在账户上，
// 直接写 st.settings.calendars 等于没配 —— syncAll 会报「没有启用的账户」。
const newStore = (calendars, conflict = "server") => {
  const st = new CalStore({ loadData: async () => undefined, saveData: async () => undefined });
  st.settings.syncIntervalMin = 0;
  seedAccounts(st, [{ calendars, conflict }]);
  return st;
};
const calBoth = { url: CAL, displayName: "工作", enabled: true, supportsEvent: true, supportsTodo: true, componentSetProbed: true };
const calTodoOnly = { url: CAL, displayName: "提醒事项", enabled: true, supportsEvent: false, supportsTodo: true, componentSetProbed: true };

// ── 1. parseComponentSet：四种形态 ─────────────────────────────
check("parseComponentSet：VEVENT-only / VTODO-only / 两者 / 缺失 / 空", () => {
  const wrap = (inner) =>
    `<D:propstat><D:prop><C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav">${inner}</C:supported-calendar-component-set></D:prop></D:propstat>`;
  const ev = caldav.parseComponentSet(wrap(`<C:comp name="VEVENT"/>`));
  assert.deepStrictEqual([ev.supportsEvent, ev.supportsTodo], [true, false], "iCloud 日历：只收事件");
  const td = caldav.parseComponentSet(wrap(`<C:comp name="VTODO"/>`));
  assert.deepStrictEqual([td.supportsEvent, td.supportsTodo], [false, true], "iCloud 提醒事项：只收待办");
  const both = caldav.parseComponentSet(wrap(`<C:comp name="VEVENT"/><C:comp name="VTODO"/>`));
  assert.deepStrictEqual([both.supportsEvent, both.supportsTodo], [true, true], "Radicale/Baikal：两者都收");
  // 属性缺失 = 服务端不限制（RFC 原文），绝不能反过来全判 false 把日历全废掉
  const none = caldav.parseComponentSet(`<D:propstat><D:prop><D:displayname>x</D:displayname></D:prop></D:propstat>`);
  assert.deepStrictEqual([none.supportsEvent, none.supportsTodo], [true, true], "属性缺失应视为不限制");
  assert.deepStrictEqual(
    [caldav.parseComponentSet(wrap("")).supportsEvent, caldav.parseComponentSet(wrap("")).supportsTodo],
    [true, true],
    "空集合同样视为不限制"
  );
});

// ── 2. 403 降级：非破坏性（先建新地址，成功再删旧）─────────────
check("互转遇 403：先 PUT 新地址、成功后才删旧地址", async () => {
  const seen = [];
  let puts = 0;
  http.setTransport(async (url, opts) => {
    seen.push({ url, method: opts.method, headers: opts.headers || {} });
    if (opts.method === "PUT") {
      puts++;
      return puts === 1
        ? { status: 403, headers: {}, body: "" }
        : { status: 201, headers: { etag: '"new-etag"' }, body: "" };
    }
    if (opts.method === "DELETE") return { status: 204, headers: {}, body: "" };
    return { status: 207, headers: {}, body: EMPTY };
  });
  const st = newStore([{ ...calBoth }]);
  const it = mkItem({ raw: EVENT_ICS, kind: "event" });
  st.put(it);
  const engine = new SyncEngine(st, () => "direct");
  await engine.pushAndPersist();
  const putCalls = seen.filter((s) => s.method === "PUT");
  const delCalls = seen.filter((s) => s.method === "DELETE");
  assert.strictEqual(putCalls.length, 2, "应 PUT 两次（403 后换地址重试），实际 " + putCalls.length);
  assert.strictEqual(delCalls.length, 1, "只删旧地址一次，实际 " + delCalls.length);
  assert.notStrictEqual(putCalls[1].url, putCalls[0].url, "重试必须换地址，同 href 再 PUT 仍被拒");
  assert.ok(putCalls[0].headers["If-Match"], "第一次 PUT 带 If-Match（改写既有资源）");
  assert.ok(!putCalls[1].headers["If-Match"], "换地址新建不该带 If-Match");
  assert.ok(
    seen.indexOf(delCalls[0]) > seen.indexOf(putCalls[1]),
    "DELETE 必须排在换地址 PUT 成功之后——先删后建一旦新建失败就丢数据"
  );
  const left = st.get(keyOf(it));
  assert.strictEqual(left.dirty, false, "换地址上传成功后不该继续脏");
  assert.strictEqual(left.etag, "new-etag", "etag 应取新响应的值");
  assert.notStrictEqual(left.href, CAL + "u1.ics", "条目应落在新地址上");
});

// ── 3. 目标类型不被支持：只给可操作提示，绝不删服务端资源 ──────
check("日历不支持目标类型：给「不支持日程」提示，且一次 DELETE 都不发", async () => {
  const seen = [];
  http.setTransport(async (url, opts) => {
    seen.push({ url, method: opts.method });
    if (opts.method === "PUT") return { status: 403, headers: {}, body: "" };
    return { status: 204, headers: {}, body: "" };
  });
  const st = newStore([{ ...calTodoOnly }]);
  const it = mkItem({ raw: EVENT_ICS, kind: "event" }); // 往只收 VTODO 的集合 PUT VEVENT
  st.put(it);
  const engine = new SyncEngine(st, () => "direct");
  await engine.pushAndPersist();
  assert.strictEqual(
    seen.filter((s) => s.method === "DELETE").length,
    0,
    "明知不支持就一个字节都不该删——删了再也建不回来"
  );
  assert.strictEqual(seen.filter((s) => s.method === "PUT").length, 1, "不支持时别换地址白重试");
  assert.ok(st.lastError && /不支持日程/.test(st.lastError), "错误要直说「不支持日程」，实际：" + st.lastError);
});

// ── 3.5 无 etag 的 403 也要换地址重试（URL 归档污染）───────────
// 2026-10-24 雄哥实测：iCloud 对同一地址留归档记录，换组件类型 PUT 永远 403
// （invalid attempt to update record from type …），而搬家后的条目 etag 本来就是空的。
check("403 + 无 etag（URL 归档污染）：也要换新地址重试，成功后清掉 movedFrom", async () => {
  const seen = [];
  http.setTransport(async (url, opts) => {
    seen.push({ url, method: opts.method, headers: opts.headers || {} });
    if (opts.method === "PUT") {
      return /u1\.ics$/.test(url)
        ? { status: 403, headers: {}, body: "invalid attempt to update record from type 'EventArchiveV1' to 'ReminderArchiveV1'" }
        : { status: 201, headers: { etag: '"fresh-etag"' }, body: "" };
    }
    return { status: 204, headers: {}, body: "" };
  });
  const st = newStore([{ ...calTodoOnly }]); // 提醒集合：收 VTODO，类型没问题
  const TODO_ICS = EVENT_ICS.replace("BEGIN:VEVENT", "BEGIN:VTODO").replace("END:VEVENT", "END:VTODO").replace("DTEND:", "DUE:");
  const it = mkItem({
    raw: TODO_ICS,
    kind: "todo",
    etag: undefined,
    movedFrom: { href: CAL + "old-u1.ics", calendarUrl: CAL, etag: '"mv-etag"' }
  });
  st.put(it);
  const engine = new SyncEngine(st, () => "direct");
  await engine.pushAndPersist();
  const putCalls = seen.filter((s) => s.method === "PUT");
  assert.strictEqual(putCalls.length, 2, "应 PUT 两次（污染地址 403 + 新地址成功），实际 " + putCalls.length);
  const left = st.get(keyOf(it));
  assert.notStrictEqual(left.href, CAL + "u1.ics", "必须换到新地址");
  assert.strictEqual(left.dirty, false, "重试成功后不该再脏");
  assert.strictEqual(left.etag, "fresh-etag", "etag 应取新地址响应的值");
  assert.strictEqual(left.movedFrom, undefined, "成功后要清掉搬家残留");
  assert.ok(
    seen.some((s) => s.method === "DELETE" && /old-u1\.ics$/.test(s.url)),
    "movedFrom 指向的原日历那份要被删掉"
  );
  assert.strictEqual(st.lastError || "", "", "重试成功就不该有错误，实际：" + (st.lastError || ""));
});

// ── 4. 搬家（movedFrom）：先建后删 + 清理标记 ─────────────────
check("换日历搬家：PUT 新地址成功后删掉原日历那份，并清空 movedFrom", async () => {
  const seen = [];
  http.setTransport(async (url, opts) => {
    seen.push({ url, method: opts.method });
    if (opts.method === "PUT") return { status: 201, headers: { etag: '"moved-etag"' }, body: "" };
    return { status: 204, headers: {}, body: "" };
  });
  const st = newStore([{ ...calBoth }, { ...calBoth, url: OTHER, displayName: "home" }]);
  const it = mkItem({
    calendarUrl: OTHER,
    href: OTHER + "u1.ics",
    movedFrom: { href: CAL + "u1.ics", calendarUrl: CAL, etag: '"old-etag"' }
  });
  st.put(it);
  const engine = new SyncEngine(st, () => "direct");
  await engine.pushAndPersist();
  const put0 = seen.find((s) => s.method === "PUT");
  const dels = seen.filter((s) => s.method === "DELETE");
  assert.strictEqual(put0.url, OTHER + "u1.ics", "先 PUT 到新日历");
  assert.strictEqual(dels.length, 1, "随后删旧日历那份，实际 " + dels.length);
  assert.strictEqual(dels[0].url, CAL + "u1.ics", "删的是原地址");
  assert.ok(seen.indexOf(dels[0]) > seen.indexOf(put0), "顺序必须是先建后删");
  assert.strictEqual(st.get(keyOf(it)).movedFrom, undefined, "处理完要清 movedFrom，否则每轮重复删");
});

check("搬家后旧资源删不掉：只记中性提示，不把同步报成失败", async () => {
  http.setTransport(async (url, opts) => {
    if (opts.method === "PUT") return { status: 201, headers: { etag: '"moved-etag"' }, body: "" };
    if (opts.method === "DELETE") return { status: 403, headers: {}, body: "" }; // 旧日历只读
    return { status: 207, headers: {}, body: EMPTY };
  });
  const st = newStore([{ ...calBoth }, { ...calBoth, url: OTHER, displayName: "home" }]);
  const it = mkItem({
    calendarUrl: OTHER,
    href: OTHER + "u1.ics",
    movedFrom: { href: CAL + "u1.ics", calendarUrl: CAL }
  });
  st.put(it);
  const engine = new SyncEngine(st, () => "direct");
  const rep = await engine.syncAll();
  assert.strictEqual(rep.errors.length, 0, "旧资源删不掉不该算错误，实际：" + rep.errors.join("; "));
  assert.ok((rep.notes || []).some((n) => /未能删除/.test(n)), "应有中性提示，实际 notes=" + JSON.stringify(rep.notes));
  assert.strictEqual(st.get(keyOf(it)).dirty, false, "新地址已落地，不该继续脏");
});

// ── 5. 源码级防漂移 ──────────────────────────────────────────
check("发现日历的 PROPFIND 必须点名请求 supported-calendar-component-set", () => {
  assert.ok(
    /supported-calendar-component-set\/>/.test(read("src/core/caldav.ts")),
    "不点名请求就拿不到（protected 属性，allprop 不带）→ 能力永远取缺省值"
  );
});
check("sync.ts 的 403 分支先 PUT 后 DELETE（顺序铁律）", () => {
  const src = read("src/core/sync.ts");
  const i403 = src.indexOf("=== 403) {");
  assert.ok(i403 > 0, "未找到 403 分支（注意：条件已从 `403 && item.etag` 放宽为 `403`，别按旧串找）");
  const seg = src.slice(i403, i403 + 2600);
  const iPut = seg.indexOf("const r = await putItem(");
  const iDel = seg.indexOf("await deleteItem(");
  assert.ok(iPut > 0 && iDel > 0, "403 分支里 PUT/DELETE 都要在");
  assert.ok(iPut < iDel, "必须先 PUT 新地址再 DELETE 旧地址，反过来就是 2026-10-24 事故");
});
check("CalItem 有 movedFrom 且 CalCalendar 有 componentSetProbed", () => {
  assert.ok(/movedFrom\?:/.test(read("src/core/types.ts")), "CalItem 缺 movedFrom");
  assert.ok(/componentSetProbed\?:/.test(read("src/core/types.ts")), "CalCalendar 缺 componentSetProbed");
});

(async () => {
  for (const c of asyncChecks) {
    try {
      await c.fn();
      pass++;
    } catch (e) {
      fail.push(`${c.name}: ${e.message}`);
    }
  }
  for (const f of fail) console.log("  [FAIL]", f);
  console.log(`\n[component-set] ${pass} 项通过${fail.length ? `，${fail.length} 项失败` : ""}`);
  if (fail.length > 0) process.exitCode = 1;
})();
