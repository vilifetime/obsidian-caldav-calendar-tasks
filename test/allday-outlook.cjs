/**
 * 全天事件 Outlook 降级形态回归（2026-10-20 雄哥报障后修复，两端同构）。
 *
 * 背景：雄哥在服务器上发现「测试全天事件1」名字是全天、实际开始结束都是 00:00。
 * 地面真相：该 ICS 由 Outlook 侧（PRODID MailClient.VObject）10-03 创建，写的是
 *   DTSTART:20260928T000000 / DTEND:20260928T000000
 * —— Outlook 向不支持 VALUE=DATE 的 CalDAV 服务器（Baïkal）建「全天」时的降级写法。
 * 旧判定只认 8 位纯日期，于是它被当成 00:00 零时长定时事件：周/日视图里落到 00:00
 * 刻度处一条 15 分钟的矮线（endMin = startMin + 15），全天条里反而没有。
 *
 * 修复（ics.ts）：
 * ① allDay 判定放宽：start 是 `YYYYMMDDT000000` 且 DTEND 缺失或同为某日 `T000000`
 *    → 全天。人在定时事件里设不出「00:00 开始、00:00 结束、零时长」，这种形态
 *    一律按全天收；start 是 000000 但 DTEND 带真实时分的不算（有真实时长）。
 * ② parseIcsStamp(prop, forceDateOnly)：判全天时 start/end 只取日期部分，与标准
 *    VALUE=DATE 在内存里完全一致，occurrences/序列化/编辑器全走既有全天路径。
 * ③ 序列化天然升级：dateOnly = item.allDay，编辑保存时 DTSTART/DTEND 写成
 *    VALUE=DATE，服务器上的降级形态被修回正版。
 *
 * 用法：node test/allday-outlook.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SIYUAN_ROOT = path.resolve(ROOT, "..", "SiYuanCalDAV");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readSiyuan = (rel) => fs.readFileSync(path.join(SIYUAN_ROOT, rel), "utf8");

// 与其它测试同一套路：tsc 编译到临时目录再引
const outDir = path.join(ROOT, ".test-allday");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "tsconfig.dir"), { recursive: true });
fs.writeFileSync(
  path.join(outDir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "commonjs",
      target: "es2020",
      moduleResolution: "node",
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
      resolveJsonModule: true,
      baseUrl: "..",
      outDir: ".",
      paths: { "@/*": ["src/*"] },
    },
    files: ["../src/core/ics.ts", "../src/core/types.ts", "../src/core/date.ts"],
  })
);
const { execSync } = require("child_process");
execSync("npx tsc -p .test-allday/tsconfig.json", { cwd: ROOT, stdio: "inherit" });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
// tsc 的 paths 不改写运行期 require：把 @/ 别名按深度改成相对路径
{
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        const depth = path.relative(path.dirname(p), outDir).split(path.sep).filter(Boolean).length;
        const prefix = "../".repeat(depth);
        const s = fs.readFileSync(p, "utf8").replace(/require\("@\/([^"]+)"\)/g, (_, m) => `require("${prefix}${m}")`);
        fs.writeFileSync(p, s);
      }
    }
  };
  walk(outDir);
}

const { itemsFromICS, itemToNewICS, occurrencesInRange } = require(path.join(outDir, "core", "ics.js"));
const { isDateOnly, parseLocalStamp } = require(path.join(outDir, "core", "date.js"));

const URL_BASE = "http://nas.test/cal/";
let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}
/** 用最小 VCALENDAR 包一个 VEVENT 解析出条目 */
function parseEvent(props, kind = "VEVENT") {
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//test//CN", `BEGIN:${kind}`, ...props, `END:${kind}`, "END:VCALENDAR"].join("\r\n");
  const items = itemsFromICS(ics, URL_BASE, URL_BASE + "x.ics");
  return items[0];
}

/* ---------- ① 真实故障样本（服务器原文照抄） ---------- */
console.log("[allday-outlook] 真实故障样本");

t("Outlook 降级形态（零时长同日）→ 全天，start/end 取日期部分", () => {
  const it = parseEvent([
    "UID:sy-muso87f4-6vjrgoct",
    "DTSTART:20260928T000000",
    "DTEND:20260928T000000",
    "SUMMARY:测试全天事件1",
  ]);
  assert.strictEqual(it.allDay, true, "allDay 应为 true");
  assert.strictEqual(it.start, "2026-09-28", "start 应规范化成 date-only");
  assert.strictEqual(it.end, "2026-09-28", "end 应规范化成 date-only");
});

t("完整服务器原文（含 VTIMEZONE 噪音）照解析不误", () => {
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MailClient.VObject/11.0.1201.0",
    "BEGIN:VTIMEZONE",
    "TZID:China Standard Time",
    "BEGIN:STANDARD",
    "TZNAME:中国标准时间",
    "DTSTART:19800101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:sy-muso87f4-6vjrgoct",
    "DTSTART:20260928T000000",
    "DTEND:20260928T000000",
    "CREATED:20261003T173400Z",
    "DTSTAMP:20261003T173400Z",
    "LAST-MODIFIED:20261003T173400Z",
    "SUMMARY:测试全天事件1",
    "TRANSP:OPAQUE",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const items = itemsFromICS(raw, URL_BASE, URL_BASE + "sy-muso87f4-6vjrgoct.ics", "etag1");
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].allDay, true);
  assert.strictEqual(items[0].start, "2026-09-28");
  assert.ok(items[0].raw && items[0].raw.includes("X-MICROSOFT-CDO-BUSYSTATUS"), "raw 必须原文带下");
});

/* ---------- ② 其它降级变体 ---------- */
console.log("[allday-outlook] 降级形态变体");

t("排他次日 DTEND:20260929T000000 → 全天（DATE 语义的等价降级）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20260929T000000"]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.start, "2026-09-28");
  assert.strictEqual(it.end, "2026-09-29");
});

t("多日全天（28→次月1日 000000）→ 全天", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20261001T000000"]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.end, "2026-10-01");
});

t("无 DTEND（只写 DTSTART:20260928T000000）→ 全天，end 兜底次日", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000"]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.end, "2026-09-29", "全天无 end 时兜底 start+1（与 VALUE=DATE 行为一致）");
});

/* ---------- ③ 不误伤 ---------- */
console.log("[allday-outlook] 误伤防护");

t("DTEND 带真实时分（00:00→12:00）→ 非全天，时分保留", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20260928T120000"]);
  assert.strictEqual(it.allDay, false, "有真实时长不能判全天");
  assert.strictEqual(it.start, "2026-09-28T00:00:00");
  assert.strictEqual(it.end, "2026-09-28T12:00:00");
});

t("start 非 000000（10:00 开始）→ 非全天", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T100000", "DTEND:20260929T100000"]);
  assert.strictEqual(it.allDay, false);
});

t("标准 VALUE=DATE 行为不变（回归）", () => {
  const it = parseEvent(["UID:a", "DTSTART;VALUE=DATE:20260928", "DTEND;VALUE=DATE:20260929"]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.start, "2026-09-28");
  assert.strictEqual(it.end, "2026-09-29");
});

t("待办不判全天（VTODO DTSTART:20260928T000000）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DUE:20260928T000000"], "VTODO");
  assert.strictEqual(it.allDay, false, "待办没有全天概念");
});

t("带 Z 的 000000 不判全天（UTC 零点 ≠ 本地全天）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000Z", "DTEND:20260928T000000Z"]);
  assert.strictEqual(it.allDay, false);
});

/* ---------- ④ 下游链路 ---------- */
console.log("[allday-outlook] 下游链路");

t("occurrences 产出 date-only（周视图才会进全天条）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20260928T000000"]);
  const s = parseLocalStamp("2026-09-27").getTime();
  const e = parseLocalStamp("2026-09-30").getTime();
  const occs = occurrencesInRange(it, s, e);
  assert.ok(occs.length >= 1, "应有发生日");
  assert.ok(occs.every((o) => isDateOnly(o)), `occ 应全为 date-only，实得 ${JSON.stringify(occs)}`);
});

t("序列化升级：编辑保存写出 VALUE=DATE（服务器降级形态被修回正版）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20260928T000000", "SUMMARY:x"]);
  const ics = itemToNewICS(it);
  assert.ok(/DTSTART;VALUE=DATE:20260928/.test(ics), `DTSTART 未升级为 DATE，实得:\n${ics}`);
  assert.ok(/DTEND;VALUE=DATE:20260928/.test(ics), "DTEND 未升级为 DATE");
  assert.ok(!ics.includes("20260928T000000"), "不应再残留 T000000 形态");
});

/* ---------- ⑤ 两端规则一致 ---------- */
console.log("[allday-outlook] 两端一致");

t("思源侧 ics.ts 同构（同一判定规则）", () => {
  const sy = readSiyuan("src/core/ics.ts");
  assert.ok(/function isAllDayEvent\(/.test(sy), "思源侧缺少 isAllDayEvent");
  assert.ok(/\\d\{8\}T000000\$/.test(sy) || sy.includes("^\\d{8}T000000$"), "思源侧缺少 T000000 降级规则");
  assert.ok(/parseIcsStamp\(startProp, allDay\)/.test(sy), "思源侧 start 未按 allDay 规范化");
  assert.ok(/parseIcsStamp\(dtendProp, allDay\)/.test(sy), "思源侧 end 未按 allDay 规范化");
});

t("Obsidian 侧无 8 位日期的旧独苗判定残留", () => {
  const src = read("src/core/ics.ts");
  assert.ok(
    !/allDay: kind === "event" \?\?!\(startProp/.test(src),
    "对象字面量里的旧内联判定应已被 isAllDayEvent 取代"
  );
});

console.log(`\n[allday-outlook] ${pass} 项通过${fail ? `，${fail} 项失败` : ""}`);
if (fail > 0) process.exitCode = 1;
