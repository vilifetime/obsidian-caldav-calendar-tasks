/**
 * 回归测试：跨服务器孤儿条目的清理 / 备份 / 恢复（与 SiYuan 同构，2026-10-24 起）
 *
 * 覆盖：
 *   ① core/server-id.ts 的服务器身份判定（origin 归一 + iCloud 归一 + 退化路径）
 *   ② core/store.ts 的孤儿条目识别（activeServerOrigins / orphanItems）
 *   ③ 清理 + 备份 + 恢复的完整往返
 *   ④ **删除账户时**的可选清理（purgeAccountItems，多账户改造后取代原「切换
 *      服务器时自动清理」开关 —— 那个常开开关容易误伤，改成用户点删除时显式选）
 *
 * ⚠️ Obsidian 端特有约束：备份条目快照必须存**数据顶层**（PersistData.purgeBackup），
 *    绝不能进 CalSettings —— core/config-backup.ts 的「配置备份」只抄 settings，
 *    塞条目快照会让备份文件膨胀几十 MB。
 *
 * 用法：node test/purge-switch.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const outDir = path.join(ROOT, ".test-purge");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts src/core/server-id.ts src/i18n/index.ts ` +
    `--outDir .test-purge --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "pipe" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
{
  // store.ts → config-backup.ts → require("obsidian")，node_modules/obsidian 只有 .d.ts
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

const sid = require(path.join(outDir, "core", "server-id.js"));
const storeMod = require(path.join(outDir, "core", "store.js"));
const { initLocale } = require(path.join(outDir, "i18n", "index.js"));
initLocale("zh");

let passed = 0;
const fail = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => {
          passed++;
          console.log(`  [PASS] ${name}`);
        },
        (e) => {
          fail.push({ name, e });
          console.error(`  [FAIL] ${name}\n         ${e.message}`);
        }
      );
    }
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    fail.push({ name, e });
    console.error(`  [FAIL] ${name}\n         ${e.message}`);
  }
  return Promise.resolve();
}

// ---------------------------------------------------------------- 测试夹具

const NAS = "http://nas.bonebear.cn:5808";
const NAS_CAL = `${NAS}/dav.php/calendars/work/`;
const NAS_CAL2 = `${NAS}/dav.php/calendars/home/`;
const OLD = "http://nas.bonebear.cn:5232";
const OLD_CAL = `${OLD}/dav.php/calendars/old/`;
const ICLOUD_CAL = "https://p12-caldav.icloud.com:443/1234567/reminders/";

function mkItem(uid, calendarUrl, extra = {}) {
  return {
    uid,
    kind: "event",
    calendarUrl,
    href: `${calendarUrl}${uid}.ics`,
    etag: `"etag-${uid}"`,
    summary: `条目 ${uid}`,
    allDay: false,
    start: "2026-10-24T090000",
    end: "2026-10-24T100000",
    raw: `BEGIN:VCALENDAR\r\nUID:${uid}\r\nEND:VCALENDAR`,
    ...extra
  };
}

const { seedAccounts } = require("./accfx.cjs");

const cal = (url, enabled = true, displayName = "日历") => ({ url, displayName, enabled });

// 多账户（2026-10-26）：服务器地址与日历都挂在账户上，直接写 settings.calendars
// 等于没配 —— activeServerOrigins 会拿到空集合，所有条目都不算孤儿。
// extraAccounts 用于「另一个账户」场景（旧服务器的条目来自被删掉的那个账户）。
function mkStore(items, calendars, serverUrl = NAS, extraAccounts = []) {
  const st = new storeMod.CalStore({
    loadData: async () => undefined,
    saveData: async () => {}
  });
  seedAccounts(st, [{ id: "acc-main", name: "主账户", serverUrl, calendars }, ...extraAccounts]);
  for (const it of items) st.put(it);
  return st;
}

(async () => {
  // ============================================================== ① 身份判定
  console.log("[purge] 服务器身份判定（server-origin）");

  await t("同主机不同路径 → 同一身份", () => {
    assert.strictEqual(sid.serverOriginOf(NAS_CAL), sid.serverOriginOf(NAS_CAL2));
    assert.strictEqual(sid.serverOriginOf(NAS_CAL), sid.serverOriginOf(`${NAS}/dav.php`));
  });

  await t("端口不同 → 不同身份", () => {
    assert.notStrictEqual(sid.serverOriginOf(NAS), sid.serverOriginOf(OLD));
  });

  await t("协议不同 → 不同身份", () => {
    assert.notStrictEqual(sid.serverOriginOf("http://a.com/x"), sid.serverOriginOf("https://a.com/x"));
  });

  await t("默认端口被归一（:80/:443 不算不同身份）", () => {
    assert.strictEqual(sid.serverOriginOf("http://a.com:80/x"), "http://a.com");
    assert.strictEqual(sid.serverOriginOf("https://a.com:443/x"), "https://a.com");
  });

  await t("主机名大小写不敏感", () => {
    assert.strictEqual(sid.serverOriginOf("HTTP://NAS.BoneBear.CN:5808/x"), "http://nas.bonebear.cn:5808");
  });

  await t("iCloud 及其节点主机名统一归一为 icloud", () => {
    assert.strictEqual(sid.serverOriginOf("https://caldav.icloud.com"), "icloud");
    assert.strictEqual(sid.serverOriginOf("https://p12-caldav.icloud.com:443/x/"), "icloud");
    assert.strictEqual(sid.serverOriginOf("https://www.icloud.com"), "icloud");
    assert.notStrictEqual(sid.serverOriginOf("https://evil-icloud.com"), "icloud");
  });

  await t("空地址 → 空身份", () => {
    assert.strictEqual(sid.serverOriginOf(""), "");
    assert.strictEqual(sid.serverOriginOf("   "), "");
  });

  await t("缺协议的裸主机名退化为带端口的裸标识（不同端口仍是不同身份）", () => {
    assert.notStrictEqual(sid.serverOriginOf("nas.bonebear.cn:5232"), sid.serverOriginOf("nas.bonebear.cn:5808"));
    assert.strictEqual(sid.serverOriginOf("nas.bonebear.cn:5232"), "nas.bonebear.cn:5232");
  });

  await t("formatTimeText 解析不了就原样返回（不显示 Invalid Date）", () => {
    assert.ok(!/Invalid/i.test(sid.formatTimeText("不是时间")));
    assert.strictEqual(sid.formatTimeText("不是时间"), "不是时间");
    assert.ok(/\d{4}\/\d{2}\/\d{2}/.test(sid.formatTimeText("2026-10-24T08:00:00Z")));
  });

  // ============================================================== ② 孤儿识别
  console.log("[purge] 孤儿条目识别");

  await t("activeServerOrigins 只取启用的日历", () => {
    const st = mkStore([], [cal(NAS_CAL, true), cal(OLD_CAL, false)]);
    const origins = st.activeServerOrigins();
    assert.strictEqual(origins.size, 1);
    assert.ok(origins.has(sid.serverOriginOf(NAS)));
  });

  await t("同一服务器的两个日历只算一个身份", () => {
    const st = mkStore([], [cal(NAS_CAL, true), cal(NAS_CAL2, true)]);
    assert.strictEqual(st.activeServerOrigins().size, 1);
  });

  await t("orphanItems 认出跨服务器的条目、保留同服务器的条目", () => {
    const st = mkStore(
      [mkItem("a", NAS_CAL), mkItem("b", NAS_CAL2), mkItem("c", OLD_CAL), mkItem("d", ICLOUD_CAL)],
      [cal(NAS_CAL, true), cal(NAS_CAL2, true)]
    );
    const orphans = st.orphanItems().map((i) => i.uid).sort();
    assert.deepStrictEqual(orphans, ["c", "d"]);
  });

  await t("一个启用日历都没有 → 一条都不算孤儿", () => {
    const st = mkStore([mkItem("a", NAS_CAL), mkItem("b", OLD_CAL)], [cal(NAS_CAL, false)]);
    assert.strictEqual(st.orphanItems().length, 0);
  });

  await t("判不出归属的条目（calendarUrl 为空）保留", () => {
    const st = mkStore([mkItem("z", "")], [cal(NAS_CAL, true)]);
    assert.strictEqual(st.orphanItems().length, 0);
  });

  // ============================================================== ③ 清理/备份/恢复
  console.log("[purge] 清理 / 备份 / 恢复往返");

  await t("purgeOrphanItems 删掉孤儿、留下备份", async () => {
    const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)]);
    const n = await st.purgeOrphanItems();
    assert.strictEqual(n, 1);
    assert.strictEqual(st.getAll().length, 1);
    assert.ok(st.get("a"));
    assert.strictEqual(st.get("c"), undefined);
    assert.ok(st.purgeBackup);
    assert.strictEqual(st.purgeBackup.count, 1);
    assert.strictEqual(st.purgeBackup.items[0].uid, "c");
    assert.strictEqual(st.purgeBackup.items[0].raw, mkItem("c", OLD_CAL).raw);
    assert.ok(st.purgeBackup.removedServers.includes("5232"));
  });

  await t("restorePurgedItems 完整还原", async () => {
    const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)]);
    await st.purgeOrphanItems();
    assert.strictEqual(await st.restorePurgedItems(), 1);
    assert.strictEqual(st.getAll().length, 2);
    assert.ok(st.get("c"));
    assert.strictEqual(st.purgeBackup, undefined);
  });

  await t("恢复出来的条目不带脏标记", async () => {
    const st = mkStore([mkItem("c", OLD_CAL, { dirty: true, deleted: true })], [cal(NAS_CAL, true)]);
    await st.purgeOrphanItems();
    await st.restorePurgedItems();
    const it = st.get("c");
    assert.strictEqual(it.dirty, false);
    assert.strictEqual(it.deleted, false);
  });

  await t("键冲突时恢复跳过、不覆盖现有数据", async () => {
    const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)]);
    await st.purgeOrphanItems();
    st.put(mkItem("c", OLD_CAL, { summary: "本地已有" }));
    assert.strictEqual(await st.restorePurgedItems(), 0);
    assert.strictEqual(st.get("c").summary, "本地已有");
  });

  await t("没有备份时恢复返回 0（不抛错）", async () => {
    const st = mkStore([], [cal(NAS_CAL, true)]);
    assert.strictEqual(await st.restorePurgedItems(), 0);
  });

  await t("清理后备份落盘在数据顶层（不在 settings 里）", async () => {
    let saved = null;
    const st = new storeMod.CalStore({
      loadData: async () => undefined,
      saveData: async (d) => {
        saved = d;
      }
    });
    st.settings.accounts = [{ id: "acc-main", name: "主账户", enabled: true, serverUrl: NAS, calendars: [cal(NAS_CAL, true)], username: "u", password: "p", calendarPath: "", serverType: "caldav", channel: "auto", conflict: "server", pastDays: 90, futureDays: 370, attachSizeMaxMB: 5, icsSizeMaxMB: 10 }];
    st.put(mkItem("c", OLD_CAL));
    await st.purgeOrphanItems();
    assert.ok(saved);
    assert.ok(saved.purgeBackup);
    assert.strictEqual(saved.purgeBackup.count, 1);
    assert.strictEqual(saved.settings.purgeBackup, undefined);
  });

  await t("重新加载后备份仍在（重启也能恢复）", async () => {
    const st1 = new storeMod.CalStore({
      loadData: async () => undefined,
      saveData: async () => {}
    });
    seedAccounts(st1, [{ id: "acc-main", name: "主账户", serverUrl: NAS, calendars: [cal(NAS_CAL, true)] }]);
    st1.put(mkItem("c", OLD_CAL));
    await st1.purgeOrphanItems();

    const st2 = new storeMod.CalStore({
      loadData: async () => ({ settings: st1.settings, items: [], purgeBackup: st1.purgeBackup }),
      saveData: async () => {}
    });
    await st2.load();
    assert.ok(st2.purgeBackup);
    assert.strictEqual(await st2.restorePurgedItems(), 1);
  });

  // ============================================================== ④ 删除账户时的清理
  // 2026-10-26：原「切换服务器时自动清理」开关**已废除** —— 一个常开的自动开关
  // 会在用户换服务器（或手滑改地址）时静默删掉本地数据，太容易误伤。
  // 改成：删除账户时由用户显式二选一（只删账户 / 连带清理本地条目），
  // 且清理前照样留备份可恢复。
  console.log("[purge] 删除账户时的可选清理（purgeAccountItems）");

  await t("iCloud → 自建服务器切换：iCloud 的条目被认出为孤儿", () => {
    const st = mkStore([mkItem("x", ICLOUD_CAL), mkItem("y", NAS_CAL)], [cal(NAS_CAL, true)]);
    assert.deepStrictEqual(st.orphanItems().map((i) => i.uid), ["x"]);
  });

  await t("purgeAccountItems 只清该账户日历下的条目，别的账户一条不动", async () => {
    const st = mkStore(
      [mkItem("a", NAS_CAL), mkItem("x", ICLOUD_CAL), mkItem("y", NAS_CAL2)],
      [cal(NAS_CAL, true), cal(NAS_CAL2, true)],
      NAS,
      [{ id: "acc-icloud", name: "iCloud", serverUrl: "https://caldav.icloud.com", calendars: [cal(ICLOUD_CAL, true)] }]
    );
    const n = await st.purgeAccountItems("acc-icloud");
    assert.strictEqual(n, 1, "只清 iCloud 账户那一条");
    assert.deepStrictEqual(st.getAll().map((i) => i.uid).sort(), ["a", "y"], "主账户的条目必须原样留下");
    assert.strictEqual(st.purgeBackup.count, 1);
    assert.strictEqual(st.purgeBackup.removedServers, "iCloud", "备份要记清是哪个账户被清的");
    assert.ok(st.purgeBackup.keptServer.includes("主账户"), "备份要记清留下了谁");
  });

  await t("purgeAccountItems 连**已停用**日历的条目一起清（账户都没了，留着纯占位）", async () => {
    const st = mkStore([mkItem("a", NAS_CAL), mkItem("x", ICLOUD_CAL)], [cal(NAS_CAL, true)], NAS, [
      { id: "acc-icloud", name: "iCloud", serverUrl: "https://caldav.icloud.com", calendars: [cal(ICLOUD_CAL, false)] }
    ]);
    assert.strictEqual(await st.purgeAccountItems("acc-icloud"), 1);
    assert.deepStrictEqual(st.getAll().map((i) => i.uid), ["a"]);
  });

  await t("账户 id 不存在 / 没有日历 → 返回 0，不误伤任何条目", async () => {
    const st = mkStore([mkItem("a", NAS_CAL)], [cal(NAS_CAL, true)], NAS, [
      { id: "acc-empty", name: "空账户", serverUrl: "https://x/", calendars: [] }
    ]);
    assert.strictEqual(await st.purgeAccountItems("acc-empty"), 0, "没日历 → 0");
    assert.strictEqual(await st.purgeAccountItems("acc-不存在"), 0, "账户不存在 → 0");
    assert.strictEqual(st.getAll().length, 1, "一条都不该少");
    assert.strictEqual(st.purgeBackup, undefined, "没清东西就不该产生备份");
  });

  await t("删除账户清理后仍可完整恢复（备份挂在数据顶层）", async () => {
    const st = mkStore([mkItem("a", NAS_CAL), mkItem("x", ICLOUD_CAL)], [cal(NAS_CAL, true)], NAS, [
      { id: "acc-icloud", name: "iCloud", serverUrl: "https://caldav.icloud.com", calendars: [cal(ICLOUD_CAL, true)] }
    ]);
    await st.purgeAccountItems("acc-icloud");
    assert.strictEqual(await st.restorePurgedItems(), 1);
    assert.deepStrictEqual(st.getAll().map((i) => i.uid).sort(), ["a", "x"]);
    assert.strictEqual(st.get("x").dirty, false, "恢复出来的条目不带脏标记");
  });

  // ============================================================== ⑤ 源码级约束
  console.log("[purge] 源码级约束");

  await t("备份条目快照不得放进 CalSettings（会污染配置备份）", () => {
    const src = read("src/core/types.ts");
    const settingsBlock = src.slice(src.indexOf("export interface CalSettings"), src.indexOf("export interface PurgeBackup"));
    assert.ok(!/purgeBackup\??\s*:\s*PurgeBackup/.test(settingsBlock), "CalSettings 里不应有 purgeBackup");
    assert.ok(/export interface PurgeBackup/.test(src));
    assert.ok(/purgeBackup\??\s*:\s*PurgeBackup/.test(src.slice(src.indexOf("export interface PersistData"))));
  });

  await t("设置页：删除账户时可选清理（废除的自动开关不许复活）", () => {
    const src = read("src/ui/settings-tab.ts");
    assert.ok(/purgeAccountItems/.test(src), "删除账户应能连带清理本地条目");
    assert.ok(/renderPurgeRow/.test(src), "仍要有手动清理/恢复按钮行");
    assert.ok(/restorePurgedItems/.test(src), "仍要有恢复入口");
    // 常开的自动清理开关是误伤源，2026-10-26 随多账户废除，不许再回来
    assert.ok(!/purgeOtherServerOnSwitch|purgeOrphansIfEnabled/.test(src), "「切换服务器自动清理」开关已废除，不许复活");
    const types = read("src/core/types.ts");
    assert.ok(!/purgeOtherServerOnSwitch/.test(types), "CalSettings 里不该再有该开关字段");
  });

  await t("i18n 中英文案对位且齐全", () => {
    const zh = JSON.parse(read("src/i18n/zh_CN.json"));
    const en = JSON.parse(read("src/i18n/en_US.json"));
    const keys = [
      "settings.groupLocalData",
      "settings.purgeNow",
      "settings.purgeRestore",
      "settings.purgeStatus",
      "settings.purgeStatusNone",
      "settings.purgeStatusNoServer",
      "settings.purgeBackupInfo",
      "settings.purgeBackupFrom",
      "settings.purgeDone",
      "settings.purgeNothing",
      "settings.purgeRestored",
      "settings.purgeRestoreNothing",
      "settings.purgeConfirmHint"
    ];
    for (const k of keys) {
      assert.ok(zh[k], `zh_CN 缺 ${k}`);
      assert.ok(en[k], `en_US 缺 ${k}`);
    }
  });

  await t("i18n 字典中英文键集完全一致", () => {
    const zh = JSON.parse(read("src/i18n/zh_CN.json"));
    const en = JSON.parse(read("src/i18n/en_US.json"));
    const zk = Object.keys(zh).sort();
    const ek = Object.keys(en).sort();
    assert.deepStrictEqual(zk, ek);
  });

  console.log(`\n[purge] 通过 ${passed} 项，失败 ${fail.length} 项`);
  if (fail.length) {
    for (const f of fail) console.error(`  ✗ ${f.name}: ${f.e.message}`);
    process.exitCode = 1;
  }
})();
