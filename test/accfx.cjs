/**
 * 多账户时代的测试夹具（2026-10-26 同构自思源端多账户改造）。
 *
 * 背景：`serverUrl / username / password / calendarPath / serverType / channel /
 * conflict / pastDays / futureDays / calendars / 两个体积上限` 已从「全局平铺字段」
 * 下沉进 `settings.accounts: CalAccount[]`。老测试里 `st.settings.calendars = [...]`
 * 这种写法现在等于什么都没配 —— syncAll 遍历启用账户，一个都没有就直接报
 * 「没有启用的账户」，用例会以莫名其妙的方式红掉（看着像功能坏了，其实是夹具过期）。
 *
 * 用法：
 *   const { account, seedAccounts } = require("./accfx.cjs");
 *   seedAccounts(st, { calendars: [cal], conflict: "local" });   // 单个账户
 *   seedAccounts(st, [{ ...accA }, { ...accB }]);                // 多个账户
 */
const assert = require("assert");

/** 一个完整的账户对象（缺省值对齐 DEFAULT_SETTINGS / store.load 的迁移结果） */
function account(over = {}) {
  const a = {
    id: "acc-1",
    name: "测试账户",
    enabled: true,
    serverUrl: "http://127.0.0.1:5232/",
    username: "u",
    password: "p",
    calendarPath: "",
    serverType: "caldav",
    channel: "auto",
    conflict: "server",
    pastDays: 90,
    futureDays: 370,
    calendars: [],
    attachSizeMaxMB: 5,
    icsSizeMaxMB: 10,
  };
  for (const [k, v] of Object.entries(over || {})) if (v !== undefined) a[k] = v;
  return a;
}

/**
 * 把账户写进 store.settings（**不触发迁移**：老测试直接改内存里的 settings，
 * 走 load() 反而会被 migrateToAccounts 再搬一次，这里只做结构填充）。
 */
function seedAccounts(st, accs) {
  const list = Array.isArray(accs) ? accs : [accs];
  st.settings.accounts = list.map((a, i) =>
    account(Object.assign({ id: a.id || `acc-${i + 1}`, name: a.name || `测试账户${i + 1}` }, a))
  );
  return st;
}

/**
 * 夹具自检：账户结构必须能被 core 的唯一入口 `enabledCalendars` 认出来。
 * 这条放在夹具里而不是某个测试里 —— 夹具一旦过期，所有用例一起红，
 * 先自检能一眼看出是「夹具坏了」还是「功能坏了」。
 */
function selfTestEnabledCalendars(fn) {
  const st = { settings: {} };
  seedAccounts(st, [{ calendars: [{ url: "http://x/a/", enabled: true }] }]);
  const got = fn(st.settings).map((c) => c.url);
  assert.deepStrictEqual(got, ["http://x/a/"], "enabledCalendars 认不出夹具塞进去的日历");
}

module.exports = { account, seedAccounts, selfTestEnabledCalendars };
