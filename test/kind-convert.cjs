/**
 * 回归测试：日程↔待办 互转（与 SiYuan core.test.mjs「待办/日程 互转」同构，2026-10-24）
 *
 * 关键点：
 * 1. 转换必须走专用 itemToConvertedICS（按旧 kind 找组件、按新 kind 输出）。直接复用
 *    itemToEditedICS 会在翻 kind 后找不到旧组件而抛错。
 * 2. 条目主键不再含 kind（keyOf = uid[|recurId]），所以「转事件后原任务还在」的重复
 *    现象的根因被消除：转换后的条目与旧条目是同一个键，直接覆盖。
 * 3. 目标为事件时丢弃 priority/percent/status；目标为待办时补默认状态。
 * 4. 非受管属性（VTIMEZONE / ORGANIZER / X-）必须原样保留。
 *
 * 用法：node test/kind-convert.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const ROOT = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "obs-conv-"));

esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/core/ics.ts"), path.join(ROOT, "src/core/store.ts")],
  outdir: OUT,
  bundle: true,
  format: "cjs",
  platform: "node",
  // store.ts → config-backup.ts → `obsidian`，而 node_modules/obsidian 只有 .d.ts
  // （运行时由宿主注入），Node 里 require 不到 → 外包外部化，再在产物目录垫一个桩。
  external: ["obsidian"],
  logLevel: "silent",
});
{
  const stubDir = path.join(OUT, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" })
  );
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `"use strict";\nexports.normalizePath = function normalizePath(p) {\n` +
      `  return String(p).replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");\n};\n`
  );
}

const ics = require(path.join(OUT, "ics.js"));
const store = require(path.join(OUT, "store.js"));

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  [PASS] ${name}`);
};

console.log("[kind-convert] 事件 → 待办");
const eventRaw = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//x//CN",
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Shanghai",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:evt-conv@test",
  "SUMMARY:项目评审",
  "ORGANIZER;CN=boss:mailto:boss@x",
  "DTSTART:20261023T100000Z",
  "DTEND:20261023T113000Z",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");
const evt = ics.itemsFromICS(eventRaw, "http://x/cal/", "http://x/cal/evt-conv.ics", "etag1")[0];
t("事件解析带 raw", () => assert.ok(evt.raw && evt.raw.includes("BEGIN:VEVENT")));

const todo = ics.convertItemKind(evt, "todo");
t("组件翻成 VTODO", () => {
  assert.ok(todo.raw.includes("BEGIN:VTODO"));
  assert.ok(!todo.raw.includes("BEGIN:VEVENT"));
});
t("DTEND→DUE", () => assert.ok(todo.raw.includes("DUE:20261023T113000")));
t("DTSTART 保留", () => assert.ok(todo.raw.includes("DTSTART:20261023T100000")));
t("保留 VTIMEZONE 与 ORGANIZER", () => {
  assert.ok(todo.raw.includes("BEGIN:VTIMEZONE"));
  assert.ok(todo.raw.includes("ORGANIZER"));
});
t("UID 不变", () => assert.strictEqual(todo.uid, evt.uid));
t("默认待办状态", () => {
  assert.strictEqual(todo.kind, "todo");
  assert.strictEqual(todo.percent, 0);
  assert.strictEqual(todo.status, "NEEDS-ACTION");
});
t("转换结果可被 itemToEditedICS 再次编辑", () => {
  assert.ok(ics.itemToEditedICS(todo).includes("BEGIN:VTODO"));
});
t("转换后主键与原条目一致（同键覆盖，不会残留旧待办）", () => {
  assert.strictEqual(store.keyOf(todo), store.keyOf(evt));
});

console.log("[kind-convert] 待办 → 事件");
const todoRaw = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO",
  "UID:todo-conv@test", "SUMMARY:交周报", "DUE:20261025T180000Z",
  "PRIORITY:1", "PERCENT-COMPLETE:40", "STATUS:IN-PROCESS",
  "END:VTODO", "END:VCALENDAR"
].join("\r\n");
const td = ics.itemsFromICS(todoRaw, "http://x/cal/", "http://x/cal/todo-conv.ics", "etag2")[0];
const ev = ics.convertItemKind(td, "event");
t("组件翻成 VEVENT", () => {
  assert.ok(ev.raw.includes("BEGIN:VEVENT"));
  assert.ok(!ev.raw.includes("BEGIN:VTODO"));
});
t("DUE→DTSTART", () => assert.ok(ev.raw.includes("DTSTART:20261025T180000")));
t("丢弃 priority/percent/status", () => {
  assert.ok(!ev.raw.includes("PRIORITY"));
  assert.ok(!ev.raw.includes("PERCENT-COMPLETE"));
  assert.ok(!ev.raw.includes("STATUS"));
});
t("默认 1 小时时长", () => assert.ok(ev.raw.includes("DTEND:20261025T190000")));
t("UID 不变", () => assert.strictEqual(ev.uid, td.uid));
t("转换后主键与原条目一致", () => assert.strictEqual(store.keyOf(ev), store.keyOf(td)));

console.log("[kind-convert] 源码级约束");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
t("store.keyOf 不再把 kind 编进主键", () => {
  const src = read("src/core/store.ts");
  const m = src.match(/export function keyOf\(item: CalItem\): string \{[\s\S]*?\n\}/);
  assert.ok(m, "未找到 keyOf 定义");
  assert.ok(!/item\.kind/.test(m[0]), "keyOf 仍包含 item.kind，转换后会残留旧条目");
});
t("view-common.keyOfItem 同步去掉 kind", () => {
  const src = read("src/ui/view-common.ts");
  const m = src.match(/export function keyOfItem\(it: CalItem\): string \{[\s\S]*?\n\}/);
  assert.ok(m, "未找到 keyOfItem 定义");
  assert.ok(!/it\.kind/.test(m[0]), "keyOfItem 仍包含 it.kind");
});
t("月/周视图 chip 带 data-kind（键不再含 kind，勾选态需另标记）", () => {
  const vc = read("src/ui/view-common.ts");
  const wk = read("src/ui/view-week.ts");
  assert.ok(/data-kind=/.test(vc), "view-common 缺 data-kind");
  assert.ok(/data-kind=/.test(wk), "view-week 缺 data-kind");
});
t("编辑器有转换按钮且接了事件", () => {
  const src = read("src/ui/editor.ts");
  assert.ok(/data-action="convert"/.test(src));
  assert.ok(/convertItemKind/.test(src));
});
t("i18n 两份字典都有转换文案", () => {
  const zh = JSON.parse(read("src/i18n/zh_CN.json"));
  const en = JSON.parse(read("src/i18n/en_US.json"));
  assert.strictEqual(zh["editor.convertToEvent"], "转为日程");
  assert.strictEqual(zh["editor.convertToTodo"], "转为待办");
  assert.ok(en["editor.convertToEvent"] && en["editor.convertToTodo"]);
});
t("转换按钮有样式", () => {
  assert.ok(/caldav-foot-btn--convert\s*\{/.test(read("src/styles.css")));
});

console.log(`\n[kind-convert] ${passed} 项通过`);
