/**
 * 回归锁：设置页「Local data」行排版 + 编辑弹窗英文文案（2026-11-07 第五轮截图）
 *
 * ① 雄哥要求把标题行的英文开关文案 "Detect dates when pasting" 改成
 *    "Detect dates on paste"（中文「粘贴自动识别日期」不动）。旧文案在 520px
 *    弹窗里被 ellipsis 截成 "Detect dates when p…"，改短后必须完整显示。
 *
 * ② 设置页「Local data」原来极难看：Obsidian 的 .setting-item 是 flex 行
 *    [info | control]，这一行 control 里两个长按钮把 info 挤到只剩 ~70px，
 *    name 与 .caldav-purge-status 被逐词折断竖排，右侧留一整片空白。
 *    修法＝这一项改成上下两段：说明全宽、按钮组另起一行左对齐且可换行。
 *    用 .caldav-purge-row 专属 class 精确命中（由 TS 在 renderPurgeRow 里给
 *    setting.settingEl 加），绝不能写裸 .setting-item 全局覆盖，也不再用 :has()。
 *
 * ③ 「如果还造成窗口宽度不够 / 横向滚动条，就稍微扩展一点窗口宽度」是条件句。
 *    首轮 16 场景探针（默认字体）判为「无溢出、无需加宽」，但实机界面字体更宽，
 *    第七轮截图里 "Detect dates on paste" 仍被截成 "Detect dates on p…" ——
 *    条件触发。故事件 520→560、待办 560→600（各 +40），并把
 *    .caldav-title-aiparse 改成 flex:0 0 auto，文案完整由布局保证。
 *    宽字体压力探针 36 场景（旧/新布局 × 中英 × 520/560/600 × 字距压力
 *    0/1.2/1.6）：旧布局 520px 英文在 1.2/1.6 下截断（复现实机），新布局
 *    560/600 全部文案完整、form/head/foot 零横向溢出、无元素越界。
 *    注意与第五轮否掉的 660/700 区分：那次加宽只制造标题行中间空白，这次
 *    加宽用于消除 flex 压缩。下面把 560/600 锁住防两头回退。
 *
 * 用法：node test/settings-local-data.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "src/i18n/en_US.json"), "utf8"));
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "src/i18n/zh_CN.json"), "utf8"));
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
/** 取某个选择器的声明块；声明断言一律按 ^\s* 匹配声明行，避免命中注释 */
function block(sel, source = css) {
  const s = source.indexOf(sel + " {");
  assert.ok(s >= 0, `缺规则 ${sel}`);
  return source.slice(s, source.indexOf("}", s));
}
function decl(b, re, msg) {
  assert.ok(re.test(b), msg);
}
const NEW_TEXT = "Detect dates on paste";
const OLD_TEXT = "Detect dates when pasting";
const textOk = (dict) => dict["editor.parsePaste"] === NEW_TEXT;

console.log("\n① 编辑弹窗标题行英文文案（中文保持原样）");
check("en_US 是 Detect dates on paste，且旧文案已清除", () => {
  assert.ok(textOk(en), `en_US.editor.parsePaste = ${en["editor.parsePaste"]}`);
  assert.ok(!Object.values(en).includes(OLD_TEXT), "英文字典仍残留旧文案");
});
check("中文仍是「粘贴自动识别日期」，未被误改", () => {
  assert.strictEqual(zh["editor.parsePaste"], "粘贴自动识别日期");
});
check("判据自测：改回旧文案应判红（防假绿）", () => {
  assert.ok(!textOk({ ...en, "editor.parsePaste": OLD_TEXT }));
});

console.log("\n② 设置页 Local data 行：上下两段布局");
const SEL_ROOT = ".setting-item.caldav-purge-row";
check("命中项纵向排列且拉伸满宽", () => {
  const b = block(SEL_ROOT);
  decl(b, /^\s*flex-direction:\s*column\s*;/m, "缺 flex-direction:column（说明与按钮仍会挤在同一行）");
  decl(b, /^\s*align-items:\s*stretch\s*;/m, "缺 align-items:stretch（info 不会占满宽度）");
});
check("info 全宽且允许收缩", () => {
  const b = block(SEL_ROOT + " .setting-item-info");
  decl(b, /^\s*width:\s*100%\s*;/m, "info 缺 width:100%");
  decl(b, /^\s*max-width:\s*100%\s*;/m, "info 缺 max-width:100%");
  decl(b, /^\s*min-width:\s*0\s*;/m, "info 缺 min-width:0");
});
check("按钮组另起一行、左对齐、可换行", () => {
  const b = block(SEL_ROOT + " .setting-item-control");
  decl(b, /^\s*width:\s*100%\s*;/m, "control 缺 width:100%");
  decl(b, /^\s*flex-wrap:\s*wrap\s*;/m, "control 必须允许换行（窄设置页下两按钮会溢出）");
  decl(b, /^\s*justify-content:\s*flex-start\s*;/m, "按钮组应左对齐，而非贴右");
  decl(b, /^\s*margin-top:\s*10px\s*;/m, "按钮组与说明之间需要间距");
});
check("状态说明按词换行，不再被压成每词一行", () => {
  const b = block(SEL_ROOT + " .caldav-purge-status");
  decl(b, /^\s*white-space:\s*normal\s*;/m, "状态文字缺 white-space:normal");
  decl(b, /^\s*overflow-wrap:\s*break-word\s*;/m, "长 URL 需要 overflow-wrap:break-word");
});
check("精确命中：不得出现裸 .setting-item 全局覆盖", () => {
  assert.ok(css.includes(".caldav-purge-row"), "缺 .caldav-purge-row 专属选择器（应由 TS 给 setting.settingEl 加）");
  assert.ok(!css.includes(":has(.caldav-purge-status)"), "仍残留 :has(.caldav-purge-status)，应改用 .caldav-purge-row class");
  assert.ok(!/(^|\n)\.setting-item\s*\{/.test(css),
    "出现裸 .setting-item 规则，会影响其它插件的设置行");
});
check("判据自测：退回旧行布局 / 按钮不换行都应判红", () => {
  const rootBroken = block(SEL_ROOT).replace(/^(\s*)flex-direction:\s*column\s*;/m, "$1flex-direction: row;");
  assert.ok(!/^\s*flex-direction:\s*column\s*;/m.test(rootBroken), "纵向排列判据在 row 上必须返回 false");
  const ctrlBroken = block(SEL_ROOT + " .setting-item-control")
    .replace(/^(\s*)flex-wrap:\s*wrap\s*;/m, "$1flex-wrap: nowrap;");
  assert.ok(!/^\s*flex-wrap:\s*wrap\s*;/m.test(ctrlBroken), "换行判据在 nowrap 上必须返回 false");
});

console.log("\n③ 条件式加宽已触发：560/600，且仍无横向溢出");
check("事件 560px、待办 600px（各 +40px）", () => {
  const w = (sel) => {
    const m = /^\s*width:\s*(\d+)px\s*;/m.exec(block(sel));
    assert.ok(m, `${sel} 缺 width 声明`);
    return +m[1];
  };
  assert.strictEqual(w(".modal.caldav-dialog"), 560, "退回 520 会让英文文案被截断");
  assert.strictEqual(w(".modal.caldav-dialog.caldav-dialog--todo"), 600);
});
check("开关组不可收缩（文案完整由布局保证，详见 editor-layout.cjs）", () => {
  decl(block(".caldav-title-aiparse"), /^\s*flex:\s*0 0 auto\s*;/m,
    "0 1 auto 会让开关参与压缩，宽字体下文案被 ellipsis 截断");
});
check("form 与页脚仍显式 overflow-x:hidden（横滚条的根因修复未回退）", () => {
  decl(block(".caldav-editor-form, .caldav-settings-form"), /^\s*overflow-x:\s*hidden\s*;/m,
    "form 缺 overflow-x:hidden");
  decl(block(".caldav-editor-foot"), /^\s*overflow-x:\s*hidden\s*;/m,
    "页脚缺 overflow-x:hidden");
});
check("判据自测：退回 520/560 或暴涨到 660/700 都应判红", () => {
  const w = (sel, src) => +/^\s*width:\s*(\d+)px\s*;/m.exec(block(sel, src))[1];
  const narrow = css.replace("width: 560px;", "width: 520px;").replace("width: 600px;", "width: 560px;");
  assert.ok(w(".modal.caldav-dialog", narrow) !== 560 &&
    w(".modal.caldav-dialog.caldav-dialog--todo", narrow) !== 600,
    "判据在未加宽的 520/560 上必须返回 false");
  const wide = css.replace("width: 560px;", "width: 660px;").replace("width: 600px;", "width: 700px;");
  assert.ok(w(".modal.caldav-dialog", wide) !== 560 &&
    w(".modal.caldav-dialog.caldav-dialog--todo", wide) !== 600,
    "判据在 660/700 上必须返回 false");
});

console.log(`\n[settings-local-data] ${pass} 项通过、${fails.length} 项失败`);
if (fails.length) {
  fails.forEach((f) => console.error("  - " + f));
  process.exitCode = 1;
}
