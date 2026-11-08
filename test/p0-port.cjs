/**
 * 回归锁：P0 七项「思源 → Obsidian」同构补齐（2026-11-07）
 *
 * 分界点：Obsidian 最后一次同步 = 0275fb8（2026-10-27），此后思源发了
 * 0.2.34 ~ 0.2.38。本测试把这次补进来的七项逐项钉住，防止以后 cp 覆盖 /
 * 重构时悄悄丢掉。断言以源码契约为主（与本仓既有测试同风格），另校验
 * i18n 字典键与构建产物确实包含关键实现。
 *
 * 覆盖：
 *   #1 四态映射 + 作废 + 列表状态标注
 *   #2 Dock / 任务视图筛选补齐「所有」「作废」+ 命名统一
 *   #3 勾选后延迟 3 秒重排
 *   #4 切换日历时刷新 Dock
 *   #5 待办显示位置三模式 + 提醒锚点
 *   #6 新建弹窗自动聚焦标题框
 *   #7 store.load() 清 saveTimer 竞态
 *
 * 用法：node test/p0-port.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    fails.push(`${name}: ${e.message}`);
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
}

const src = {
  taskState: read("src/core/task-state.ts"),
  types: read("src/core/types.ts"),
  ics: read("src/core/ics.ts"),
  store: read("src/core/store.ts"),
  reminder: read("src/core/reminder.ts"),
  panel: read("src/ui/panel.ts"),
  panelCtx: read("src/ui/panel-ctx.ts"),
  viewCommon: read("src/ui/view-common.ts"),
  viewTask: read("src/ui/view-task.ts"),
  viewList: read("src/ui/view-list.ts"),
  editor: read("src/ui/editor.ts"),
  filterPref: read("src/ui/filter-pref.ts"),
  settings: read("src/ui/settings-tab.ts"),
  main: read("src/main.ts"),
  css: read("src/styles.css"),
  icons: read("src/ui/icons.ts")
};
const zh = require(path.join(ROOT, "src/i18n/zh_CN.json"));
const en = require(path.join(ROOT, "src/i18n/en_US.json"));
const built = fs.existsSync(path.join(ROOT, "main.js")) ? read("main.js") : "";

console.log("[p0-port] #1 四态映射 + 作废 + 列表状态标注");
check("task-state.ts 四态常量齐全", () => {
  for (const s of ["STATUS_NEEDS_ACTION", "STATUS_IN_PROCESS", "STATUS_COMPLETED", "STATUS_CANCELLED"]) {
    assert.ok(src.taskState.includes(s), `缺 ${s}`);
  }
  assert.ok(/export function stateOfStatus/.test(src.taskState));
  assert.ok(/export function statusFields/.test(src.taskState));
});
check("i18n key 用字面量映射（动态拼 key 会被 i18n-dict 判无引用）", () => {
  for (const k of ["state.todo", "state.inProgress", "state.done", "state.canceled"]) {
    assert.ok(src.taskState.includes(`"${k}"`), `缺字面量 ${k}`);
  }
});
check("ICS：VEVENT 写 STATUS:CANCELLED，VTODO 写四态", () => {
  assert.ok(/item\.status === "CANCELLED"\) push\("STATUS", "CANCELLED"\)/.test(src.ics));
  assert.ok(/item\.status === "CANCELLED"\s*\? "CANCELLED"/.test(src.ics), "VTODO 未把 CANCELLED 当终态");
  assert.ok(/item\.status !== "CANCELLED" && item\.percent === 100/.test(src.ics), "作废时仍写 COMPLETED");
});
check("ICS：STATUS 在 VEVENT / VTODO 通用读取（作废日程读得回来）", () => {
  const idx = src.ics.indexOf("const statusProp = firstProp(comp, \"STATUS\")");
  assert.ok(idx > 0, "缺通用读取");
  assert.ok(idx < src.ics.indexOf("if (kind === \"event\")"), "通用读取必须在 kind 分支之前");
  assert.ok(/STATUS", "PRIORITY", "PERCENT-COMPLETE", "COMPLETED"/.test(src.ics), "MANAGED 集合须含 STATUS，恢复作废才不会残留旧值");
});
check("编辑器：作废按钮 / collect 终态保护 / 进度取消作废", () => {
  assert.ok(/data-action="void"/.test(src.editor));
  assert.ok(/icons\.ban/.test(src.editor) && /ban: svg\(/.test(src.icons));
  assert.ok(/if \(it\.status === "CANCELLED"\) \{\s*it\.percent = 0;/.test(src.editor), "collect 未保护作废终态");
  assert.ok(/it\.status = v === 100 \? "COMPLETED" : v > 0 \? "IN-PROCESS" : "NEEDS-ACTION"/.test(src.editor));
  assert.ok(/ctx\.deferResort\?\.\(\)/.test(src.editor), "作废后应触发延迟重排");
});
check("任务视图：isCancelled 互斥 + 已作废分组 + 默认折叠两组", () => {
  assert.ok(/function isCancelled\(r: Row\)/.test(src.viewTask));
  assert.ok(/key: "cancelled", label: t\("task\.group\.cancelled"\)/.test(src.viewTask));
  assert.ok(/new Set\(\["done", "cancelled"\]\)/.test(src.viewTask));
  assert.ok(/set\.includes\("\+" \+ gkey\)/.test(src.viewTask), "缺显式展开标记");
  assert.ok(!/EXPANDED_KEY/.test(src.viewTask), "旧的 __none__ 折叠方案应已移除");
});
check("列表视图：四态前缀 + 作废 ✕ + 删除线样式", () => {
  assert.ok(/class="cal-list-status"/.test(src.viewList));
  assert.ok(/stateText\(stateOfItem\(it\)\)/.test(src.viewList));
  assert.ok(/cancelled \? "✕"/.test(src.viewList));
  assert.ok(/cal-list-row\.is-cancelled \.cal-list-title/.test(src.css));
  assert.ok(/\.cal-list-status \{/.test(src.css));
});

console.log("[p0-port] #2 筛选补齐「所有」「作废」+ 命名统一");
check("类型与选项表都补齐新键", () => {
  assert.ok(/export type DockFilterKey =[\s\S]{0,220}"allitems"[\s\S]{0,260}"cancelled"/.test(src.types));
  assert.ok(/export type TaskFilterKey =[\s\S]{0,260}"cancelled"/.test(src.types));
  // 精确截取两个常量声明块：`readonly DockFilterKey[]` 里的 `]` 会截断 [^\]]*，
  // 用 indexOf 切片比一条大正则可靠，也不会误命中另一个常量。
  const dockBlock = src.filterPref.slice(
    src.filterPref.indexOf("export const DOCK_FILTER_KEYS"),
    src.filterPref.indexOf("export const TASK_FILTER_KEYS")
  );
  const taskBlock = src.filterPref.slice(
    src.filterPref.indexOf("export const TASK_FILTER_KEYS"),
    src.filterPref.indexOf("export const DOCK_FILTER_I18N")
  );
  assert.ok(dockBlock.length > 0 && /"allitems"/.test(dockBlock) && /"cancelled"/.test(dockBlock), "DOCK_FILTER_KEYS 缺新键");
  assert.ok(taskBlock.length > 0 && /"cancelled"/.test(taskBlock), "TASK_FILTER_KEYS 缺 cancelled");
  assert.ok(/allitems: "dock\.filter\.allitems"/.test(src.filterPref));
  assert.ok(/cancelled: "dock\.filter\.cancelled"/.test(src.filterPref));
  assert.ok(/cancelled: "task\.filter\.cancelled"/.test(src.filterPref));
});
check("Dock 匹配函数加「所有 / 作废」分支并排除其它筛选中的作废项", () => {
  assert.ok(/case "allitems":\s*return true;/.test(src.panel));
  assert.ok(/case "cancelled":\s*return isCancelled;/.test(src.panel));
  assert.ok(/const isCancelled = it\.status === "CANCELLED";/.test(src.panel));
  assert.ok(/&& !isCancelled;/.test(src.panel));
  assert.ok(/case "done":\s*return isDone && !isCancelled;/.test(src.panel));
});
check("任务视图 filters 补齐 cancelled 且其余筛选排除作废", () => {
  assert.ok(/key: "cancelled", label: t\(TASK_FILTER_I18N\.cancelled\)/.test(src.viewTask));
  assert.ok((src.viewTask.match(/!isCancelled\(r\)/g) || []).length >= 10, "筛选/分组未充分排除作废项");
});
check("i18n 两端补齐新键且筛选文案统一", () => {
  for (const k of ["dock.filter.allitems", "dock.filter.cancelled", "task.filter.cancelled", "task.group.cancelled", "state.canceled", "task.restoreCancelled"]) {
    assert.ok(zh[k] && en[k], `字典缺 ${k}`);
  }
  assert.strictEqual(zh["dock.filter.today"], "今日", "Dock 文案应与任务视图统一");
  assert.strictEqual(zh["task.filter.allitems"], "所有");
});

console.log("[p0-port] #3 延迟 3 秒重排");
check("panel.ts 有 deferResort 实现并注入 ctx", () => {
  assert.ok(/function scheduleDeferredResort\(\)/.test(src.panel));
  assert.ok(/ctx\.deferResort = scheduleDeferredResort;/.test(src.panel));
  assert.ok(/\}, 3000\);/.test(src.panel));
  assert.ok(/deferResort\?: \(\) => void/.test(src.panelCtx));
});
check("勾选路径走延迟重排，旧的 10s guard 已移除", () => {
  assert.ok(/scheduleDeferredResort\(\);\s*void ctx\.sync\.updateItem/.test(src.panel));
  assert.ok(!/const guard = window\.setTimeout\(\(\) => \(suppressRerender = false\), 10000\)/.test(src.panel));
});
check("销毁时清定时器，避免已销毁面板 3 秒后重绘", () => {
  assert.ok(/destroy\(\) \{[\s\S]{0,300}clearTimeout\(resortTimer\)/.test(src.panel));
});
check("作废态勾选 = 恢复为待办，不是标记完成", () => {
  assert.ok(/if \(item\.status === "CANCELLED"\) \{[\s\S]{0,180}item\.status = "NEEDS-ACTION";/.test(src.panel));
  assert.ok(/export function toggleTodoDone[\s\S]{0,320}item\.status === "CANCELLED"/.test(src.panel));
});

console.log("[p0-port] #4 切换日历刷新 Dock");
check("toggleCalendar 主动刷新其它面板，入口注入 refreshViews", () => {
  // 只在该函数体里找：中文说明注释很长，固定字符窗口会被撑破；切片也不会误命中别处
  const start = src.panel.indexOf("function toggleCalendar(");
  assert.ok(start > 0, "缺 toggleCalendar");
  const body = src.panel.slice(start, src.panel.indexOf("\n  }", start));
  assert.ok(/ctx\.refreshPanels\?\.\(\)/.test(body), "toggleCalendar 函数体内未刷新其它面板");
  assert.ok(/renderAll\(\)/.test(body));
  assert.ok(/refreshPanels: \(\) => this\.refreshViews\(\)/.test(src.main));
  assert.ok(/refreshPanels\?: \(\) => void/.test(src.panelCtx));
});

console.log("[p0-port] #5 待办显示位置三模式 + 提醒锚点");
check("设置项与默认值齐备", () => {
  assert.ok(/todoDuePosition\?: "due" \| "start" \| "start-due"/.test(src.types));
  assert.ok(/todoReminderAnchor\?: "due" \| "start"/.test(src.types));
  assert.ok(/todoDuePosition: "due"/.test(src.types) && /todoReminderAnchor: "due"/.test(src.types));
});
check("todoDueOccurrences 三模式 + 闭区间逐日展开", () => {
  assert.ok(/mode: CalSettings\["todoDuePosition"\] = "due"/.test(src.viewCommon));
  assert.ok(/mode === "due"/.test(src.viewCommon) && /mode === "start"/.test(src.viewCommon));
  assert.ok(/function eachDayInclusive/.test(src.viewCommon) && /const DAY_MS = 24 \* 60 \* 60 \* 1000/.test(src.viewCommon));
  assert.ok(/export function stateOfItem/.test(src.viewCommon));
});
check("只有日历主视图跟随设置，任务视图 / Dock / 日记固定按 DUE", () => {
  assert.ok(/todoDueOccurrences\(it, startMs, endMs, ctx\.store\.settings\.todoDuePosition\)/.test(src.panel));
  // 按行统计：view-task 的实参含 parseLocalStamp(today).getTime()，
  // [^)]* 会被嵌套括号提前截断，故改为「同一行同时出现调用与 \"due\"」。
  const fixedDue = (f) => f.split("\n").filter((l) => l.includes("todoDueOccurrences(") && l.includes('"due"')).length;
  const fixed = fixedDue(src.panel) + fixedDue(src.viewTask) + fixedDue(src.main);
  assert.ok(fixed >= 3, `固定 DUE 调用点应有 3 处，实测 ${fixed}`);
  assert.ok(!/todoDueOccurrences\(it, startMs, endMs, "due"\)/.test(src.panel), "日历主视图不得写死 due");
});
check("提醒引擎第四参注入设置，锚点可切 start；第三参 now 未被挤掉", () => {
  assert.ok(/now\?: \(\) => number,\s*[\s\S]{0,220}private getSettings: \(\) => CalSettings = \(\) => \(\{}\) as CalSettings/.test(src.reminder));
  assert.ok(/const mode = this\.getSettings\(\)\.todoReminderAnchor \|\| "due"/.test(src.reminder));
  assert.ok(/mode === "start"\s*\? item\.start \|\| item\.end\s*: item\.end \|\| item\.start/.test(src.reminder));
  assert.ok(/new ReminderEngine\([\s\S]{0,220}undefined,\s*\(\) => this\.store\.settings/.test(src.main));
});
check("设置页两个下拉 + 字典键齐备", () => {
  assert.ok(/key: "todoDuePosition"/.test(src.settings) && /key: "todoReminderAnchor"/.test(src.settings));
  assert.ok(/"start-due": t\("settings\.todoDuePositionRange"\)/.test(src.settings));
  for (const k of ["settings.todoDuePosition", "settings.todoDuePositionDesc", "settings.todoDuePositionRange", "settings.todoReminderAnchor", "settings.todoReminderAnchorDesc", "settings.todoAnchorDue", "settings.todoAnchorStart"]) {
    assert.ok(zh[k] && en[k], `字典缺 ${k}`);
  }
});

console.log("[p0-port] #6 新建弹窗自动聚焦标题框");
check("仅新建 + 非移动端，延迟一帧聚焦标题框", () => {
  assert.ok(/if \(this\.isNew && !this\.mobile\)[\s\S]{0,600}input\[data-f="summary"\]/.test(src.editor));
  assert.ok(/window\.setTimeout\([\s\S]{0,450}titleInput\.focus\(\{ preventScroll: true \}\)/.test(src.editor));
  assert.ok(/wrap\.contains\(active\)\)\s*return;/.test(src.editor), "用户已主动聚焦别处时不应抢焦点");
  assert.ok(/bindEvents\(this\.ctx, this, wrap, this\.it, this\.isNew\);[\s\S]{0,300}this\.isNew && !this\.mobile/.test(src.editor), "focus 必须在 Modal onOpen 之后");
});

console.log("[p0-port] #7 store.load() 清 saveTimer 竞态");
check("load() 开头清掉排队的 persistSoon", () => {
  assert.ok(/async load\(\): Promise<void> \{[\s\S]{0,400}clearTimeout\(this\.saveTimer\)[\s\S]{0,120}this\.saveTimer = null;[\s\S]{0,200}await this\.env\.loadData\(\)/.test(src.store));
});

console.log("[p0-port] 构建产物与判据自测");
check("关键实现确实进了 main.js（不是只改了源码）", () => {
  assert.ok(built.length > 0, "main.js 不存在，请先 npm run build");
  for (const s of ["CANCELLED", "todoDuePosition", "todoReminderAnchor", "deferResort", "siyuan"]) {
    // siyuan 仅作为「bundle 完整」的宽松探针，不参与功能断言
    if (s === "siyuan") continue;
    assert.ok(built.includes(s), `main.js 缺 ${s}`);
  }
});
check("判据自测：去掉关键实现片段时应判红（防假绿）", () => {
  assert.ok(!/function scheduleDeferredResort\(\)/.test("// 实现被删掉了"), "判据在无实现时应返回 false");
  assert.ok(/function scheduleDeferredResort\(\)/.test(src.panel), "判据在真实实现上应返回 true");
  // 新增的函数体切片判据同样要能判红：删掉刷新调用后必须检出
  const broken = src.panel.replace("ctx.refreshPanels?.();", "// removed");
  const s = broken.indexOf("function toggleCalendar(");
  assert.ok(s > 0 && !/ctx\.refreshPanels\?\.\(\)/.test(broken.slice(s, broken.indexOf("\n  }", s))),
    "删掉 refreshPanels 调用后判据应变红");
});

console.log(`\n[p0-port] ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.error(fails.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
