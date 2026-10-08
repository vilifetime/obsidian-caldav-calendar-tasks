/**
 * 回归测试：「日历视图中显示待办」开关不许在设置页与工具栏同时存在（2026-10-09 新增）。
 *
 * 背景：雄哥反馈设置页「View」分组里那个开关跟面板工具栏「日历筛选」浮层里的
 * 同名开关重复 —— 两者读写的是**同一个** `settings.showTodosInCalendar`。
 * 重复不只是冗余，还有个实际毛病：设置页改完不重绘面板（要等下次同步/重开才生效），
 * 看起来像「没生效」，于是又去工具栏改一遍，两处越改越疑神疑鬼。
 * 已按要求删掉设置页那一处（连「View」分组一起消失 —— 组里只剩它一项）。
 *
 * 为什么写成源码级断言而不是 jsdom 交互测试：
 * 设置项是**声明式数据**（`buildDefs()` 返回的数组），不是渲染出来的 DOM；
 * 真正要防的是「有人又往 defs 里加了一行」，而不是某个点击有没有生效。
 * 所以这里直接读 settings-tab.ts 的源码，断言它不再提这个 key。
 *
 * 同时钉住另一半：工具栏那一处**必须还在**，否则删设置页就成了把功能删掉。
 *
 * 用法：node test/settings-dedupe.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const settingsTab = read("src/ui/settings-tab.ts");
const panel = read("src/ui/panel.ts");
const types = read("src/core/types.ts");

/* ── ① 设置页不许再声明这个开关 ─────────────────────────────────
 *
 * 判据用 `key: "showTodosInCalendar"`（defs 里 control 的写法），
 * 而不是裸词 `showTodosInCalendar` —— 后者会连注释里那句解释一起命中，
 * 反而让这条断言永远为真、等于没写。
 */
assert.ok(
  !/key:\s*"showTodosInCalendar"/.test(settingsTab),
  "设置页不该再声明「日历视图中显示待办」（与工具栏日历筛选浮层里的开关重复）"
);
assert.ok(
  !/t\("settings\.showTodosInCalendar"\)/.test(settingsTab),
  "设置页不该再引用该设置项的中文文案键"
);

/* ── ② 「View」分组整体消失（组里只剩这一项，删掉后组必须一起走）──
 *
 * 留着空组会在设置页底部留一个只有标题的光杆标题栏，比设置项本身还怪。
 */
assert.ok(
  !settingsTab.includes("settings.groupView"),
  "「View」分组已无内容，不该再保留（否则设置页底部会剩一个空标题栏）"
);

/* ── ③ 工具栏那一处必须还在，且仍在写同一个 setting 键 ───────────
 *
 * 删设置页 ≠ 删功能。这三行是「开关还在、且改完会立刻重绘」的唯一保证：
 * 数据来源（data-opt）→ DOM 取到 → 写 settings + saveSettings（emit 触发 renderAll）。
 */
for (const needle of [
  'data-opt="showTodos"',
  'querySelector(\'[data-opt="showTodos"]\')',
  "ctx.store.settings.showTodosInCalendar = showTodosInput.checked",
  "ctx.store.saveSettings()",
]) {
  assert.ok(panel.includes(needle), `工具栏日历筛选浮层里应保留：${needle}`);
}

/* ── ④ settings 字段本身不许删（老数据兼容）────────────────────
 *
 * data.json 里早就存了这个键。types.ts 里的字段与 DEFAULT_SETTINGS 默认值
 * 是所有读取端的兜底 —— 删掉会让老用户的开关读出undefined，
 * `!== false` 判定虽还能兜住 true，但一旦有人改成 `=== true` 就静默变 false。
 */
assert.ok(
  /showTodosInCalendar\?:\s*boolean/.test(types),
  "Settings.showTodosInCalendar 字段必须保留（老 data.json 里有这个键）"
);
assert.ok(
  /showTodosInCalendar:\s*true/.test(types),
  "DEFAULT_SETTINGS.showTodosInCalendar 必须保留默认值 true"
);

/* ── ⑤ 两个 i18n 键不许复活 ────────────────────────────────────
 *
 * 删设置项时把文案键一起删了（settings.showTodosInCalendar / ...Desc）。
 * 留着它们的话，i18n-dict.cjs 查不出问题（两边字典都还在、也非空），
 * 就是纯粹的死键；哪天有人看到「设置页没有这个文案」又照着加回去就会撞车。
 */
for (const dict of ["src/i18n/zh_CN.json", "src/i18n/en_US.json"]) {
  const raw = read(dict);
  assert.ok(
    !/"settings\.showTodosInCalendar"/.test(raw),
    `${dict} 里不该再有 settings.showTodosInCalendar（设置项已删）`
  );
  assert.ok(
    !/"settings\.groupView"/.test(raw),
    `${dict} 里不该再有 settings.groupView（分组已删）`
  );
}

/* ── ⑥ 工具栏那条文案键必须留着（它是现在唯一的入口）─────────── */
for (const dict of ["src/i18n/zh_CN.json", "src/i18n/en_US.json"]) {
  assert.ok(
    /"toolbar\.showTodosInCalendar"/.test(read(dict)),
    `${dict} 里必须保留 toolbar.showTodosInCalendar（工具栏是唯一入口了）`
  );
}

console.log("✓ 设置项去重测试通过");
console.log("  - 设置页已无「日历视图中显示待办」，View 分组一并移除");
console.log("  - 工具栏日历筛选浮层里的同名开关完整保留（DOM + 写设置 + 立即生效）");
console.log("  - settings.showTodosInCalendar 字段与默认值仍在，老数据不受影响");
console.log("  - i18n：settings.* 死键已清，toolbar.* 保留");