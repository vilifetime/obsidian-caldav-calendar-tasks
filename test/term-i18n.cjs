/**
 * 术语约定回归锁（2026-11-08 雄哥二次拍板）。
 *
 *  思源 / Obsidian **两端统一**：日程 = Event、待办 = To-do
 *
 *  中途曾定过「思源 Schedule/To-do、Obsidian Event/Task，各用一套」，
 *  雄哥随后改主意，要求不管哪一端全部统一成 Event 和 To-do。
 *  本测试锁死 Obsidian 这一端：待办实体一律 To-do，日程实体一律 Event。
 *
 * 边界（与思源端一致，不算混用）：中文原文就叫「任务」的功能名 ——
 * 任务视图 / 任务设置 / 搜索任务 / 日历与任务 / 任务编辑器 —— 保留 Task。
 * 这类按 key 精确豁免；其余 value 里出现裸 task / todo 一律判红。
 *
 * `reminder.scheduled` 的 "scheduled" 是「已排程」，`lang.zh` 是语言选项
 * 母语原名，两者与术语无关。
 *
 * 用法：node test/term-i18n.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const en = JSON.parse(read("src/i18n/en_US.json"));
const zh = JSON.parse(read("src/i18n/zh_CN.json"));

let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log(`  [OK] ${name}`);
};

// 中文原文为「任务」的功能名，两端都保留 Task。
const TASK_ALLOWED_KEYS = new Set([
  "openPanel", "openInSidebar", "openDock",
  "settings.defaultTaskFilter", "settings.defaultTaskFilterDesc",
  "toolbar.showEventsInTaskView", "toolbar.showExpiredEvents", "toolbar.toTaskView",
  "empty.taskNoResult", "empty.taskSearchNoMatch", "task.searchPlaceholder",
  "catmgr.note", "settings.todoDuePositionDesc", "dock.title",
]);

// 只扫 value；key 里带 todo / task 是历史命名，不算污染。
const FORBIDDEN = /\b(tasks?|todos?)\b/i;
const dirty = (dict) => Object.entries(dict)
  .filter(([k, v]) => !TASK_ALLOWED_KEYS.has(k) && typeof v === "string" && FORBIDDEN.test(v))
  .map(([k, v]) => `${k} = ${v}`);

const ANCHORS = {
  "addmenu.event": "Event",
  "addmenu.todo": "To-do",
  "kindEvent": "event",
  "kindTodo": "to-do",
  "editor.newEvent": "New Event",
  "editor.newTodo": "New To-do",
  "editor.editEvent": "Edit Event",
  "editor.editTodo": "Edit To-do",
  "editor.convertToEvent": "To Event",
  "editor.convertToTodo": "To To-do",
  "editor.tabTodoSettings": "To-do settings",
  "editor.todoTitle": "To-do title",
  "editor.summaryPlaceholderTodo": "Enter a to-do title",
  "detail.todoTask": "To-do",
  "title.todo": "To-dos",
  "list.empty": "No events or to-dos in this period",
  "task.restoreCancelled": "Restore as to-do",
  "settings.todoDuePosition": "To-do placement in calendar",
  "settings.todoReminderAnchor": "To-do reminder anchor",
  "settings.todoDefaultEnd": "Default due time for new to-dos",
  "settings.includeOverdueTodos": "Include overdue to-dos",
  "diary.sectionBase": "Events and to-dos",
  "dock.nodateHidden": "{count} undated to-do(s) hidden · Click to view",
};

// 本轮 40 条改写里挑关键长句再逐字锁一遍，防止「只改了短按钮」的半吊子回退。
const FIXED = {
  "editor.attachHintIcloud": "iCloud attachments use managed upload: the file is sent to iCloud's dedicated storage and the to-do keeps only a managed link (RFC 8607 managed attachments) — no external link needed and no 507. Pick a file and it uploads automatically when you save.",
  "editor.attachConfirmIcloud": '"{name}" is currently {size}. It will be uploaded to iCloud\'s managed storage (not inlined into the to-do); every edit of this to-do still syncs the attachment along. Upload anyway?',
  "net.tooLarge413": "Upload failed: content too large, server rejected (HTTP 413). The server (or its reverse proxy) has a limit on single calendar data — nginx reverse proxies commonly default to only 1MB, Radicale to 10MB. Remove the large attachment from this to-do or use an external link and retry.",
  "settings.todoDefaultEndDesc": "Due time pre-filled for new to-dos. Based on the start time (which defaults to the next full hour when creating); all-day to-dos still default to the next day. Affects new to-dos only.",
  "settings.todoReminderAnchorDesc": "Which time a to-do reminder fires from: due date (default) or start date. To-dos with only one of the two fall back to the other.",
  "diary.lead": "Which range of events and to-dos should be written to the daily note?",
};

const termClean = (dict) => dirty(dict).length === 0;
const anchorsOk = (dict) =>
  Object.entries(ANCHORS).every(([k, v]) => dict[k] === v) &&
  Object.entries(FIXED).every(([k, v]) => dict[k] === v);

const CROSS_PAIRS = [
  ["日程", "addmenu.event", "Event"],
  ["待办", "addmenu.todo", "To-do"],
  ["新建日程", "editor.newEvent", "New Event"],
  ["新建待办", "editor.newTodo", "New To-do"],
  ["该时间段内暂无日程或待办", "list.empty", "No events or to-dos in this period"],
];
const crossOk = (sy, ob) => {
  for (const [sk, ok, expect] of CROSS_PAIRS) {
    if (sy[sk] !== expect || ob[ok] !== expect) return false;
  }
  return sy["{0} 转日程"].replace("{0} ", "") === ob["editor.convertToEvent"] &&
         sy["{0} 转待办"].replace("{0} ", "") === ob["editor.convertToTodo"];
};

console.log("\n① Obsidian 英文字典：Event / To-do，零裸 task / todo（功能名除外）");
check(`en_US ${Object.keys(en).length} 条 value 里没有旧术语`, () => {
  assert.deepStrictEqual(dirty(en), [], "英文界面仍有旧术语：\n  " + dirty(en).join("\n  "));
});
check(`${Object.keys(ANCHORS).length} 条术语锚点逐条命中 Event / To-do`, () => {
  for (const [k, v] of Object.entries(ANCHORS)) {
    assert.strictEqual(en[k], v, `${JSON.stringify(k)} 应为 ${JSON.stringify(v)}，实为 ${JSON.stringify(en[k])}`);
  }
});
check(`${Object.keys(FIXED).length} 条长句里的 to-do 已改到位`, () => {
  for (const [k, v] of Object.entries(FIXED)) {
    assert.strictEqual(en[k], v, `${JSON.stringify(k)} 仍是旧写法：${JSON.stringify(en[k])}`);
  }
});
check("zh_CN / en_US key 集合仍一致、中文端未被动过", () => {
  assert.deepStrictEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.strictEqual(zh["kindEvent"], "日程");
  assert.strictEqual(zh["kindTodo"], "待办");
});
check("合法例外不受影响：scheduled / lang.zh / 任务视图", () => {
  assert.match(en["reminder.scheduled"], /scheduled/);
  assert.strictEqual(en["lang.zh"], "简体中文");
  assert.match(en["toolbar.toTaskView"], /task view/);
});

console.log("\n② 两端统一：Obsidian ≡ 思源（对端仓库存在时才比对）");
const syPath = path.resolve(ROOT, "../SiYuanCalDAV/src/i18n/en_US.json");
const syDict = fs.existsSync(syPath) ? JSON.parse(fs.readFileSync(syPath, "utf8")) : null;
check("5 组实体名 + 2 个转换按钮，两端逐字一致", () => {
  if (!syDict) {
    console.log("    (对端仓库不在同机，跳过跨端比对)");
    return;
  }
  assert.strictEqual(crossOk(syDict, en), true);
});

console.log("\n③ 判据自测：改回旧写法必须判红（防假绿）");
check("把 addmenu.todo 译回 Task → 禁词与锚点判据都应失败", () => {
  const bad = { ...en, "addmenu.todo": "Task" };
  assert.strictEqual(termClean(bad), false);
  assert.strictEqual(anchorsOk(bad), false);
});
check("把 kindTodo 译回 todo → 禁词与锚点判据都应失败", () => {
  const bad = { ...en, "kindTodo": "todo" };
  assert.strictEqual(termClean(bad), false);
  assert.strictEqual(anchorsOk(bad), false);
});
check("把 editor.newEvent 译回 New Schedule → 锚点判据必须失败", () => {
  assert.strictEqual(anchorsOk({ ...en, "editor.newEvent": "New Schedule" }), false);
});
check("恢复一条裸 todos（new todos）→ 禁词判据必须失败", () => {
  assert.strictEqual(termClean({ ...en, "settings.todoDefaultEnd": "Default due time for new todos" }), false);
});
check("删掉一条术语键 → 锚点判据必须失败", () => {
  const bad = { ...en };
  delete bad["editor.newTodo"];
  assert.strictEqual(anchorsOk(bad), false);
});
check("把对端「日程」改回 Schedule → 跨端一致性判据必须失败", () => {
  if (!syDict) {
    console.log("    (对端仓库不在同机，跳过)");
    return;
  }
  assert.strictEqual(crossOk({ ...syDict, "日程": "Schedule" }, en), false);
  assert.strictEqual(crossOk({ ...syDict, "待办": "Task" }, en), false);
});

console.log(`\n[term-i18n] ${pass} 项全部通过\n`);
