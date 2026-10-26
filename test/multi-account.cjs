/**
 * 回归测试：多日历账户（Obsidian 端，2026-10-26 同构自思源端三次提交）
 *
 * 覆盖：
 *   ① migrateToAccounts：平铺老数据→账户、幂等、零丢失、护栏（不覆盖现有账户）
 *   ② 启用集合口径：enabledAccounts / enabledCalendars / 三个反查函数
 *   ③ 默认日历两级解析（defaultAccountId → defaultCalendarUrl → 回退）
 *   ④ syncAll 单账户失败不阻塞其他账户（带账户名的错误 + continue）
 *   ⑤ 设置页源码防漂移（账户键前缀 / 手风琴只渲染展开项 / 两级下拉）
 *
 * 用法：node test/multi-account.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const outDir = path.join(ROOT, ".test-multiacc");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts src/core/server-id.ts src/core/sync.ts src/i18n/index.ts ` +
    `--outDir .test-multiacc --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "pipe" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
{
  const stubDir = path.join(outDir, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" }));
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `"use strict";\nfunction Notice() {}\nexports.Notice = Notice;\n` +
      `exports.normalizePath = function normalizePath(p) { return String(p).replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/"); };\n`
  );
}
global.window = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };

const T = require(path.join(outDir, "core", "types.js"));
const { CalStore } = require(path.join(outDir, "core", "store.js"));
const http = require(path.join(outDir, "core", "http.js"));
const { SyncEngine } = require(path.join(outDir, "core", "sync.js"));
const { initLocale } = require(path.join(outDir, "i18n", "index.js"));
initLocale("zh");

let pass = 0;
const fail = [];
const asyncChecks = [];
function check(name, fn) {
  // 异步用例排队串行：共用 setTransport，并发会互相覆盖 stub
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

const EMPTY = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>';
const A_CAL = "http://a.test/dav/cal/";
const B_CAL = "http://b.test/dav/cal/";
const cal = (url, enabled = true, displayName = "日历") => ({ url, displayName, enabled });
const acc = (over) => ({
  id: "acc-x",
  name: "X",
  enabled: true,
  serverUrl: "http://x.test/",
  username: "u",
  password: "p",
  calendarPath: "",
  serverType: "caldav",
  channel: "auto",
  conflict: "server",
  pastDays: 90,
  futureDays: 370,
  calendars: [],
  ...over
});

// ═════════════════════════════════ ① 迁移
check("平铺老数据 → 搬进 accounts[0]，字段零丢失", () => {
  const s = {
    serverUrl: "https://nas/dav.php/",
    username: "bonebear",
    password: "secret",
    calendarPath: "/calendars/",
    serverType: "icloud",
    channel: "direct",
    conflict: "local",
    pastDays: 30,
    futureDays: 180,
    attachSizeMaxMB: 3,
    icsSizeMaxMB: 7,
    calendars: [cal(A_CAL), cal(B_CAL, false)]
  };
  T.migrateToAccounts(s);
  assert.strictEqual(s.accounts.length, 1, "应生成一个账户");
  const a = s.accounts[0];
  assert.strictEqual(a.serverUrl, "https://nas/dav.php/");
  assert.strictEqual(a.username, "bonebear");
  assert.strictEqual(a.password, "secret");
  assert.strictEqual(a.calendarPath, "/calendars/");
  assert.strictEqual(a.serverType, "icloud");
  assert.strictEqual(a.channel, "direct");
  assert.strictEqual(a.conflict, "local");
  assert.strictEqual(a.pastDays, 30);
  assert.strictEqual(a.futureDays, 180);
  // 两个上限本质是服务器特性，迁移时原值要带给账户（丢了就等于偷偷改了用户的上限）
  assert.strictEqual(a.attachSizeMaxMB, 3, "附件上限没带过来");
  assert.strictEqual(a.icsSizeMaxMB, 7, "ICS 上限没带过来");
  assert.strictEqual(a.calendars.length, 2, "日历一个都不能少");
  assert.ok(a.id, "账户要有 id");
});

check("迁移后老键必须摘掉（留着会被 persist 写成第二处真相）", () => {
  const s = { serverUrl: "https://x/", username: "u", password: "p", calendars: [cal(A_CAL)] };
  T.migrateToAccounts(s);
  for (const k of [
    "serverUrl",
    "username",
    "password",
    "calendarPath",
    "serverType",
    "channel",
    "conflict",
    "pastDays",
    "futureDays",
    "calendars",
    "attachSizeMaxMB",
    "icsSizeMaxMB"
  ]) {
    assert.ok(!(k in s), `老键 ${k} 应被删掉`);
  }
});

check("幂等：重复调用不再造第二个账户（判据是「老键在不在」不是「accounts 是否数组」）", () => {
  const s = { serverUrl: "https://x/", username: "u", password: "p", calendars: [cal(A_CAL)] };
  T.migrateToAccounts(s);
  const id1 = s.accounts[0].id;
  T.migrateToAccounts(s);
  T.migrateToAccounts(s);
  assert.strictEqual(s.accounts.length, 1, "重复迁移不该多出账户");
  assert.strictEqual(s.accounts[0].id, id1, "不该重建账户（id 变了等于漏同步状态）");
});

check("全新安装（老键全空）不造空账户占位", () => {
  const s = { accounts: [] };
  T.migrateToAccounts(s);
  assert.deepStrictEqual(s.accounts, [], "空配置不该凭空造一个账户");
});

check("护栏：平铺老键与已有 accounts 共存时，只摘老键、绝不覆盖现有账户", () => {
  // 云同步把旧副本与新数据混在一起的极端情况 —— 这里一旦拿平铺值造账户，
  // 就是一次性抹掉用户其余全部账户的静默数据丢失。
  const existing = acc({ id: "keep-me", name: "现有账户", serverUrl: "https://new/", calendars: [cal(B_CAL)] });
  const s = { serverUrl: "https://old/", username: "old", password: "old", calendars: [cal(A_CAL)], accounts: [existing] };
  T.migrateToAccounts(s);
  assert.strictEqual(s.accounts.length, 1, "不该追加账户");
  assert.strictEqual(s.accounts[0].id, "keep-me", "现有账户被覆盖了");
  assert.strictEqual(s.accounts[0].serverUrl, "https://new/", "现有账户的服务器地址被老值盖了");
  assert.ok(!("serverUrl" in s), "老键仍要摘掉");
});

// ═════════════════════════════════ ② 启用集合与反查
check("enabledAccounts 只留启用账户", () => {
  const s = { accounts: [acc({ id: "a" }), acc({ id: "b", enabled: false })] };
  assert.deepStrictEqual(T.enabledAccounts(s).map((a) => a.id), ["a"]);
});

check("enabledCalendars = 启用账户下的启用日历（停用账户的日历一个都不算）", () => {
  const s = {
    accounts: [
      acc({ id: "a", calendars: [cal(A_CAL, true), cal("http://a.test/dav/cal2/", false)] }),
      // 停用账户下的**启用**日历也不能算 —— 漏掉这条会表现为「停用账户的条目还在显示」
      acc({ id: "b", enabled: false, calendars: [cal(B_CAL, true)] })
    ]
  };
  assert.deepStrictEqual(T.enabledCalendars(s).map((c) => c.url), [A_CAL]);
});

check("accountOfUrl / findCalendarByUrl / accountOfItem 跨账户反查", () => {
  const s = { accounts: [acc({ id: "a", calendars: [cal(A_CAL)] }), acc({ id: "b", calendars: [cal(B_CAL)] })] };
  assert.strictEqual(T.accountOfUrl(s, B_CAL).id, "b");
  assert.strictEqual(T.findCalendarByUrl(s, B_CAL).url, B_CAL);
  assert.strictEqual(T.accountOfItem(s, { calendarUrl: A_CAL }).id, "a");
  assert.strictEqual(T.accountOfUrl(s, ""), undefined, "空地址不该命中任何账户");
  assert.strictEqual(T.accountOfUrl(s, "http://nope/"), undefined);
});

check("findCalendarByUrl 能找到**停用**日历（编辑旧条目时要把它补回下拉）", () => {
  const s = { accounts: [acc({ id: "a", calendars: [cal(A_CAL, false)] })] };
  assert.ok(T.findCalendarByUrl(s, A_CAL), "停用日历也要能查到");
  assert.strictEqual(T.enabledCalendars(s).length, 0, "但不应算进启用集合");
});

// ═════════════════════════════════ ③ 默认日历两级解析
const twoAcc = () => ({
  accounts: [
    acc({ id: "a", name: "A账户", calendars: [cal(A_CAL, true, "A1"), cal("http://a.test/dav/cal2/", true, "A2")] }),
    acc({ id: "b", name: "B账户", calendars: [cal(B_CAL, true, "B1")] })
  ]
});

check("默认日历 url 有效 → 直接命中", () => {
  const s = twoAcc();
  s.defaultCalendarUrl = B_CAL;
  assert.strictEqual(T.resolveDefaultCalendar(s).displayName, "B1");
});

check("defaultAccountId 指向**第二个**启用账户 → 取它的第一个启用日历（不是第一个账户的）", () => {
  // ⚠️ 这条必须指向第二个账户：指向第一个时与「回退到第一个启用账户」撞结果，
  // 判据就没区分度了（变异验证时不会转红）。
  const s = twoAcc();
  s.defaultAccountId = "b";
  assert.strictEqual(T.resolveDefaultCalendar(s).displayName, "B1", "默认账户被忽略了");
});

check("默认日历 url 已失效（日历被停用）→ 落到默认账户的第一个启用日历", () => {
  const s = twoAcc();
  s.defaultAccountId = "b";
  s.defaultCalendarUrl = A_CAL;
  s.accounts[0].calendars[0].enabled = false; // A1 停用
  s.accounts[0].calendars[1].enabled = false;
  assert.strictEqual(T.resolveDefaultCalendar(s).displayName, "B1");
});

check("都没配 → 回退第一个启用账户的第一个启用日历（不能指着空气）", () => {
  const s = twoAcc();
  assert.strictEqual(T.resolveDefaultCalendar(s).displayName, "A1");
});

check("一个启用账户都没有 → undefined（不抛）", () => {
  const s = { accounts: [acc({ id: "a", enabled: false, calendars: [cal(A_CAL)] })] };
  assert.strictEqual(T.resolveDefaultCalendar(s), undefined);
});

// ═════════════════════════════════ ④ 单账户失败不阻塞
const mkStore = (accounts, items = []) => {
  const st = new CalStore({ loadData: async () => undefined, saveData: async () => undefined });
  st.settings.accounts = accounts;
  for (const it of items) st.put(it);
  return st;
};

check("A 账户凭据不全 → 只报「账户「A账户」：…」，B 账户照常同步", async () => {
  const hits = { a: 0, b: 0 };
  http.setTransport(async (url) => {
    if (String(url).startsWith("http://a.test")) hits.a++;
    if (String(url).startsWith("http://b.test")) hits.b++;
    return { status: 207, headers: {}, body: EMPTY };
  });
  const st = mkStore([
    acc({ id: "a", name: "A账户", serverUrl: "http://a.test/", password: "", calendars: [cal(A_CAL)] }),
    acc({ id: "b", name: "B账户", serverUrl: "http://b.test/", calendars: [cal(B_CAL)] })
  ]);
  const rep = await new SyncEngine(st, () => "direct").syncAll();
  assert.ok(
    rep.errors.some((e) => e.includes("A账户")),
    "错误必须带账户名，实际：" + JSON.stringify(rep.errors)
  );
  assert.ok(hits.b > 0, "B 账户一个请求都没发 —— 被坏账户带停了");
  assert.strictEqual(hits.a, 0, "凭据不全的账户不该发请求");
});

check("A 账户日历地址与服务器地址不符（stale）→ 只报 A，B 照常", async () => {
  const hits = { b: 0 };
  http.setTransport(async (url) => {
    if (String(url).startsWith("http://b.test")) hits.b++;
    return { status: 207, headers: {}, body: EMPTY };
  });
  const st = mkStore([
    // 服务器已换成 new.test，日历还指着 a.test → 明确报错，不能「静默同步成功」
    acc({ id: "a", name: "A账户", serverUrl: "http://new.test/", calendars: [cal(A_CAL)] }),
    acc({ id: "b", name: "B账户", serverUrl: "http://b.test/", calendars: [cal(B_CAL)] })
  ]);
  const rep = await new SyncEngine(st, () => "direct").syncAll();
  assert.ok(
    rep.errors.some((e) => e.includes("A账户") && e.includes("日历")),
    "stale 日历要报带账户名的错，实际：" + JSON.stringify(rep.errors)
  );
  assert.ok(hits.b > 0, "B 账户被带停了");
});

check("一个启用账户都没有 → 报「没有启用的账户」且不抛异常", async () => {
  http.setTransport(async () => ({ status: 207, headers: {}, body: EMPTY }));
  const st = mkStore([acc({ id: "a", enabled: false, calendars: [cal(A_CAL)] })]);
  const rep = await new SyncEngine(st, () => "direct").syncAll();
  assert.strictEqual(rep.ok, false);
  assert.ok(rep.errors.length > 0, "应有明确错误");
});

check("同步窗口按账户（两个账户各设各的 pastDays，互不干扰）", () => {
  const syncSrc = read("src/core/sync.ts");
  const seg = syncSrc.slice(syncSrc.indexOf("const rangeStart"), syncSrc.indexOf("const rangeStart") + 300);
  assert.ok(/acc\.pastDays/.test(seg), "窗口开始应取账户的 pastDays");
  assert.ok(/acc\.futureDays/.test(seg), "窗口结束应取账户的 futureDays");
});

// ═════════════════════════════════ ⑤ 设置页源码防漂移
const tab = read("src/ui/settings-tab.ts");

check("账户控件 key 都带 `acc.<id>.` 前缀（同名控件歧义的根治手段）", () => {
  // 2026-10-25 思源端事故：收起卡仍渲染 body，同名 input 同时在 DOM 里，
  // 全局查询只命中第一张卡 → 添加第二个账户保存后串写成第一个账户的值。
  assert.ok(/const pre = `acc\.\$\{open\.id\}\.`;/.test(tab), "账户键应有账户 id 前缀");
  assert.ok(/key\.startsWith\("acc\."\)/.test(tab), "getControlValue 应能识别账户键");
  assert.ok(/const ak = this\.accKey\(key\);/.test(tab), "setControlValue 应能识别账户键");
});

check("手风琴：只为**展开**的那个账户 push 三段（收起的绝不渲染）", () => {
  assert.ok(/const open = this\.activeAcc\(\);/.test(tab));
  assert.ok(/if \(open\) \{/.test(tab), "三段必须包在「有展开账户」的条件里");
  // 三段都挂在 accDetail 上，而 accDetail 只在 open 时 push
  const seg = tab.slice(tab.indexOf("const accDetail"), tab.indexOf("defs.push({\n      type: \"group\",\n      heading: t(\"settings.groupAccount\")"));
  assert.ok(/accDetail\.push/.test(seg), "三段应 push 进 accDetail");
  assert.ok(/if \(open\)/.test(seg), "accDetail 的填充必须在 open 分支内");
});

check("详情三段必须是顶层 defs（group.items 嵌套 group/list 会被宿主整个忽略）", () => {
  // 2026-10-26 实踩：把「服务器/日历/策略」三段塞进「日历账户」组的 items，
  // Obsidian 的 SettingGroupItem 只收 SettingDefinition/Page，嵌套组静默不渲染——
  // 展开按钮变「收起」但详情凭空消失。类型上被 Record<string, unknown> 绕过没拦住。
  assert.ok(/defs\.push\(\.\.\.accDetail\);/.test(tab), "详情段应作为顶层 defs push");
  const acctGrp = tab.slice(
    tab.indexOf("heading: t(\"settings.groupAccount\")"),
    tab.indexOf("defs.push(...accDetail);")
  );
  assert.ok(!acctGrp.includes("...accDetail"), "账户组的 items 里绝不能再展开 accDetail");
  // 类型护栏：defs/accDetail 必须用宿主类型，不能用 Record 绕过检查
  assert.ok(/const defs: SettingDefinitionItem\[\] = \[\];/.test(tab), "defs 应声明为 SettingDefinitionItem[]");
  assert.ok(/const accDetail: SettingDefinitionItem\[\] = \[\];/.test(tab), "accDetail 应声明为 SettingDefinitionItem[]");
});

check("账户内第三段叫「策略」，含冲突/窗口/两个上限", () => {
  // 标题带账户名（sec() 拼接）——多账户下不标名看不出这三段属于谁
  const start = tab.indexOf('heading: sec(t("settings.groupStrategy"))');
  assert.ok(start > 0, "账户内应有「策略」段");
  const grp = tab.slice(start, tab.indexOf('type: "group"', start + 10));
  for (const key of ["conflict", "pastDays", "attachSizeMaxMB", "icsSizeMaxMB"]) {
    assert.ok(grp.includes(key), `策略段应含 ${key}`);
  }
});

check("全局「同步」段只剩间隔 + 默认账户 + 默认日历（上限已下沉）", () => {
  const start = tab.indexOf('heading: t("settings.groupSync")');
  const grp = tab.slice(start, tab.indexOf('type: "group"', start + 10));
  // 间隔走 `num()` 辅助函数，键是作为入参传的，不是 `key:` 字面量
  assert.ok(/num\("syncIntervalMin", 0\)/.test(grp), "应保留同步间隔");
  assert.ok(/key: "defaultAccountId"/.test(grp), "应有默认账户下拉");
  assert.ok(/key: "defaultCalendarUrl"/.test(grp), "应有默认日历下拉");
  assert.ok(!/attachSizeMaxMB/.test(grp) && !/icsSizeMaxMB/.test(grp), "两个上限已下沉到账户，同步段不该再留");
});

check("默认日历下拉按**默认账户**收窄，且当前值不在列表时要补回", () => {
  assert.ok(/function defaultCalendarOptions/.test(tab), "应有 defaultCalendarOptions");
  const seg = tab.slice(tab.indexOf("function defaultCalendarOptions"), tab.indexOf("/** 日历所属账户名"));
  assert.ok(/enabledAccounts\(s\)\.find\(\(a\) => a\.id === s\.defaultAccountId\)/.test(seg), "应按默认账户取日历");
  assert.ok(/findCalendarByUrl\(s, s\.defaultCalendarUrl\)/.test(seg), "当前值不在列表里要补回（否则看着像默认日历丢了）");
});

check("CalSettings 上不再有平铺的服务器字段（防回退）", () => {
  const src = read("src/core/types.ts");
  const block = src.slice(src.indexOf("export interface CalSettings"), src.indexOf("export interface PurgeBackup"));
  for (const k of ["serverUrl", "username", "password", "calendarPath", "conflict", "pastDays", "futureDays"]) {
    assert.ok(!new RegExp(`^\\s{2}${k}[?]?:`, "m").test(block), `CalSettings 不该再有 ${k}`);
  }
  assert.ok(/accounts:\s*CalAccount\[\]/.test(block), "CalSettings 应有 accounts");
  assert.ok(/defaultAccountId/.test(block), "CalSettings 应有 defaultAccountId");
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
  console.log(`\n[multi-account] ${pass} 项通过${fail.length ? `，${fail.length} 项失败` : ""}`);
  if (fail.length > 0) process.exitCode = 1;
})();
