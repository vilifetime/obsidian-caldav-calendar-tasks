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
t("i18n 两份字典都有转换文案（中文用短文案，避免页脚溢出）", () => {
  const zh = JSON.parse(read("src/i18n/zh_CN.json"));
  const en = JSON.parse(read("src/i18n/en_US.json"));
  assert.strictEqual(zh["editor.convertToEvent"], "转日程");
  assert.strictEqual(zh["editor.convertToTodo"], "转待办");
  assert.ok(!/为/.test(zh["editor.convertToEvent"] + zh["editor.convertToTodo"]), "不得回退为「转为…」长文案");
  assert.ok(en["editor.convertToEvent"] && en["editor.convertToTodo"]);
});
t("转换按钮有样式", () => {
  assert.ok(/caldav-foot-btn--convert\s*\{/.test(read("src/styles.css")));
});
t("作废按钮英文与思源端统一为 Cancelled（且不得与「取消」撞词）", () => {
  const zh = JSON.parse(read("src/i18n/zh_CN.json"));
  const en = JSON.parse(read("src/i18n/en_US.json"));
  const sy = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "SiYuanCalDAV", "src/i18n/en_US.json"), "utf8"));
  assert.strictEqual(zh["editor.void"], "作废");
  assert.strictEqual(en["editor.void"], "Cancelled", "作废按钮英文须为 Cancelled（雄哥 2026-11-08 拍板以思源为准）");
  assert.strictEqual(en["editor.void"], sy["作废"], "两端作废译名必须一致");
  assert.strictEqual(en["common.cancel"], "Cancel");
  assert.notStrictEqual(en["editor.void"], en["common.cancel"], "作废与取消两个按钮不能同词");
  assert.notStrictEqual(en["editor.void"], "Void", "旧译名 Void 已废弃");
});
t("页脚锁死单行：不换行、不越界，按钮整体缩小 + 横向不滚动", () => {
  const css = read("src/styles.css");
  const start = css.indexOf(".caldav-editor-foot {");
  assert.ok(start > 0, "缺 .caldav-editor-foot 基础规则");
  const block = css.slice(start, css.indexOf("}", start));
  assert.ok(/^\s*flex-wrap:\s*nowrap\s*;/m.test(block),
    "页脚必须锁死单行 nowrap；允许换行会把「保存」挤到第二行（雄哥 2026-11-07 二次截图）");
  assert.ok(!/^\s*flex-wrap:\s*wrap\s*;/m.test(block), "基础规则里不得出现 wrap 声明");
  assert.ok(/^\s*overflow-x:\s*hidden\s*;/m.test(block),
    "页脚同样不得渲染横向滚动条：与 form 统一用 hidden（按声明行匹配，勿命中注释）");
  assert.ok(!/^\s*overflow-x:\s*(auto|scroll)\s*;/m.test(block),
    "页脚不得保留 auto/scroll 的横向 overflow 兜底");
  assert.ok(/^\s*gap:\s*4px\s*;/m.test(block), "页脚间隙应收紧到 4px（Cancelled 变长后的补偿）");
  // 作废译名 Void → Cancelled 变长 5 字符，按钮 padding 6×9 会在 440px
  // 窄容器溢出 20.5px，故收到 6×7：Edge 实测中英 × 440/480/520/560/600 ×
  // 字距 0/1.2/1.6 共 30 场景均单行、无越界、无滚动条。
  // 2026-11-08 两端术语统一后转换按钮由 Convert to task 缩成 To To-do，更宽裕。
  const btnStart = css.indexOf(".caldav-editor-foot .caldav-foot-btn {");
  assert.ok(btnStart > start, "缺页脚按钮专属规则");
  const btnBlock = css.slice(btnStart, css.indexOf("}", btnStart));
  assert.ok(/^\s*padding:\s*6px 7px\s*;/m.test(btnBlock), "页脚按钮 padding 需收紧到 6×7px");
  assert.ok(/^\s*font-size:\s*12px\s*;/m.test(btnBlock), "页脚按钮字号需缩到 12px");
  assert.ok(/^\s*gap:\s*4px\s*;/m.test(btnBlock), "页脚按钮内图标与文字间隙需缩到 4px");
  assert.ok(/\.caldav-editor-foot \.caldav-foot-btn svg\s*\{[^}]*width:\s*12px/.test(css),
    "页脚图标需同步缩到 12px");
  assert.ok(/flex:\s*0 0 auto/.test(btnBlock) && /white-space:\s*nowrap/.test(btnBlock),
    "按钮仍不收缩、内部图标+文字不断行");
  // 占位元素不得 grow 抢走「保存」的空间，右侧靠 auto margin 对齐
  assert.ok(/\.caldav-editor-foot \.caldav-flex\s*\{\s*flex:\s*0 1 0/.test(css),
    "页脚占位元素不得参与 grow");
  assert.ok(/\.caldav-editor-foot \.caldav-foot-btn--ghost[\s\S]{0,80}margin-left:\s*auto/.test(css),
    "右侧按钮组需靠 margin-left:auto 推到最右");
  // 判据自测：换回 wrap 应判红（防假绿）
  const broken = block.replace(/flex-wrap:\s*nowrap/, "flex-wrap: wrap");
  assert.ok(!/^\s*flex-wrap:\s*nowrap\s*;/m.test(broken), "判据在缺实现时应返回 false");
});

console.log(`\n[kind-convert] ${passed} 项通过`);
