/**
 * 「sync-token 护栏 + 恢复清 token」回归测试（2026-10-09 新增）
 *
 * 背景：雄哥问 backup.json 里 `http://radicale.org/ns/sync/47c08d...` 是干什么的，
 * 查着查着发现一个真实的坑。
 *
 * sync-token 是**服务端发的增量游标**（RFC 6578），语义是
 * 「服务端截至该 token 时刻的全量，我本地已经全都有了」。前缀
 * `http://radicale.org/ns/sync/` 只是**命名空间**（不同厂商防混淆，客户端
 * 原样回传、从不解析），后面那串 hex 才是游标。
 *
 * 坑：备份**故意不含 items**（只存 settings + keyring，见 writeBackup 的取舍），
 * 于是恢复出来的状态自相矛盾—— 拿着「本地全都有」的凭证，本地却是空的。
 * 后果不是报错而是**静默空白**：增量拉取如实返回 0 条，日历空的，且不会自愈
 * （只要服务端没再变动，那个 token 一直有效、一直返回 0 条）。reconcile 也兜不住，
 * 它只清理「本地有 href 而服务端没有」的幽灵条目。
 *
 * 雄哥拍板走**方案 A**：恢复时清 token + 加通用护栏（本地为空则忽略 token，
 * 强制全量拉一次）。理由是他要多端并用同一台 CalDAV，全量以服务端为准更保险。
 *
 * 为什么是源码级断言：本文件守的是「清 token 的位置对不对」与「护栏不许被摘掉」
 * 这两件纯策略的事；真正的几何/协议行为在思源侧 test/sync-token.test.mjs 里
 * 用假 fetch 跑过（那边能造出「本地空 + token 有效」这个真实场景）。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const backup = read("src/core/config-backup.ts");
const syncSrc = read("src/core/sync.ts");
const storeSrc = read("src/core/store.ts");

/* ── ① 恢复时必须清掉 syncToken ──────────────────────────────────
 * 判据用 mergeBackupSettings（恢复的唯一漏斗）而不是 onRestore：
 * 将来若再加「从文件导入配置」的入口，自动就带上这个修正。
 */
assert.ok(
  /export function mergeBackupSettings/.test(backup),
  "应有 mergeBackupSettings 这个恢复漏斗"
);
const merge = backup.slice(backup.indexOf("export function mergeBackupSettings"));
assert.ok(
  /syncToken: undefined/.test(merge),
  "mergeBackupSettings 必须清掉每个日历的 syncToken（备份含 token 但不含 items ⇒ 恢复后是「空凭证」）"
);
assert.ok(
  /merged\.calendars\s*=/.test(merge),
  "必须**新建**日历数组，不能就地改：浅拷贝下 merged.calendars 与 backup.settings.calendars 同一引用"
);

// 顺带钉住既有契约：返回新对象、不改传入的那个
assert.ok(
  /return merged;/.test(merge) && !/backup\.settings\.[a-z]+\s*=/.test(merge),
  "不许直接改 backup.settings 的字段（mergeBackupSettings 的契约是返回新对象）"
);

/* ── ② 通用护栏：本地为空则忽略 token ────────────────────────────
 * 做成通用护栏而非只在恢复路径清：触发场景还有手动删 data.json、
 * 云同步把data.json 覆盖成旧版本、多端并用时本端进度对不上。
 */
assert.ok(
  /if \(cal\.syncToken && this\.store\.isCalendarLocallyEmpty\(cal\.url\)\)/.test(syncSrc),
  "sync.ts 必须有「本地为空则丢弃 token」的护栏"
);
const guardAt = syncSrc.indexOf("isCalendarLocallyEmpty");
const incAt = syncSrc.indexOf("if (cal.syncToken) {");
assert.ok(guardAt > 0 && incAt > 0 && guardAt < incAt, "护栏必须排在增量分支之前，否则不生效");

/* ── ③ store.isCalendarLocallyEmpty 的判据 ────────────────────────
 * 「有没有任何条目」，**含 deleted**。刻意不排除：待删条目仍说明本地掌握着
 * 这个日历的状态，把它算成「空」会在用户「正清空某个日历」时触发无谓全量。
 */
assert.ok(
  /isCalendarLocallyEmpty\(calendarUrl: string\): boolean/.test(storeSrc),
  "store.ts 里应有 isCalendarLocallyEmpty"
);
const emptyM = /isCalendarLocallyEmpty\(calendarUrl: string\): boolean \{([\s\S]*?)\n {2}\}/.exec(storeSrc);
assert.ok(emptyM, "应能取到 isCalendarLocallyEmpty 的方法体");
assert.ok(
  /it\.calendarUrl === calendarUrl/.test(emptyM[1]),
  "应按 calendarUrl 匹配条目"
);
assert.ok(
  !/it\.deleted/.test(emptyM[1]),
  "刻意**不**排除 deleted：待删项也说明本地有状态，算成空会触发无谓全量"
);

/* ── ④ 恢复后必须真的同步（与 config-backup.cjs 呼应）─────────────
 * 光清 token 不够 —— 不发请求，用户看到的还是空日历。
 */
const main = read("src/main.ts");
const restore = main.slice(main.indexOf("onRestore: async () =>"));
assert.ok(
  /await this\.store\.adoptBackup\(payload\)/.test(restore),
  "恢复必须 await adoptBackup（解密是异步的，不等就会拿密文当密码去同步）"
);
assert.ok(
  /await this\.runSync\(true\)/.test(restore.slice(0, restore.indexOf("onDismiss"))),
  "恢复后必须 runSync(true)：既要把条目拉回来，也要用提示告诉用户结果"
);

/* ── ⑤ 恢复时**不许**跑「测试连接」与「发现日历」 ──────────────────
 * 这两条都是设置页的手动动作，恢复流程里做会有副作用：
 *   · 测试连接 = 多发一次 PROPFIND，同步本身已经验证了连通性，不增加信息量；
 *   · 发现日历会**覆写** calendars[]，把备份里用户配好的显示名、配色、
 *     启用状态、事件/待办支持类型全刷掉 —— 与「回到备份那一刻的状态」相悖。
 */
assert.ok(
  !/testConnection/.test(restore) && !/discoverCalendars/.test(restore),
  "恢复流程里不该有「测试连接」/「发现日历」：前者冗余，后者会覆写用户配好的日历元信息"
);

/* ── ⑥ 多端并用：护栏不能被「省掉全量」 optimizations 顺带削掉 ──────
 * token 是每端私有的同步进度，多端各自持有、互相看不见对方的进展。
 * 注释里必须写清这一点，否则后人容易以为「本地空」是异常而删掉护栏。
 */
assert.ok(
  /isCalendarLocallyEmpty[\s\S]{0,600}多端/.test(syncSrc) || /多端[\s\S]{0,600}isCalendarLocallyEmpty/.test(syncSrc),
  "sync.ts 护栏处必须写明「多端并用」这一动机（否则后人会当成冗余删掉）"
);

console.log("✓ sync-token 护栏测试通过");
console.log("  - mergeBackupSettings（恢复唯一漏斗）清掉每个日历的 syncToken，且不改传入对象");
console.log("  - sync.ts 有「本地为空 ⇒ 忽略 token」通用护栏，且排在增量分支之前");
console.log("  - isCalendarLocallyEmpty 按 calendarUrl 判空，刻意含 deleted 待删项");
console.log("  - 恢复后 await adoptBackup + runSync(true)，真的发一次同步");
console.log("  - 恢复流程里没有「测试连接」/「发现日历」（后者会覆写日历元信息）");
console.log("  - 护栏注释写明多端并用的动机，防止被当冗余删掉");