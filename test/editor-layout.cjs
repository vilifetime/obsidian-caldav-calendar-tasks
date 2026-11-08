/**
 * 回归锁：编辑弹窗不得出现横向滚动条、标题行文案必须完整（2026-11-07，第三~七轮截图）
 *
 * 根因（第三轮）：.caldav-editor-form 只写 overflow-y:auto，按 CSS 规范
 * overflow-x:visible 会被隐式算成 auto → 横向滚动条。修法：form / 页脚显式
 * overflow-x:hidden，标题行子项允许收缩。
 *
 * 宽度沿革：第四轮曾加宽到 660/700 治滚动条，被否——横滚条与宽度无关，且
 * margin-left:auto 把多出的宽度全变成「开关 ↔ Calendar」之间的空白（英文 660px
 * 实测 158px）；第五轮退回 520/560。第七轮实机英文 "Detect dates on paste" 仍被
 * ellipsis 截成 "Detect dates on p…"，按雄哥要求**条件式小幅 +40px** 到 560/600，
 * 同时把 .caldav-title-aiparse 改成 flex:0 0 auto：文案完整由布局保证，加宽只用于
 * 消除 flex 压缩、让日历下拉保住 140px，不再靠宽度碰运气。
 *
 * 实测（headless Edge 加载真实 styles.css + 真实字典文案 + 近似 Obsidian 基础 CSS）：
 * 36 场景（旧/新布局 × 中英 × 520/560/600 × 字距压力 0/1.2/1.6）。旧布局 520px
 * 英文在压力 1.2/1.6 下截断（复现实机）；新布局 560/600 全部 formScroll==formClient、
 * 文案完整、无元素越界、无横向溢出，页脚单行。
 *
 * 用法：node test/editor-layout.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
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
/** 取某个选择器的声明块（不含 }），声明行断言一律用 ^\s* 避免命中注释 */
function block(sel, source = css) {
  const s = source.indexOf(sel + " {");
  assert.ok(s >= 0, `缺规则 ${sel}`);
  return source.slice(s, source.indexOf("}", s));
}
function decl(b, re, msg) {
  assert.ok(re.test(b), msg);
}
function widthOf(sel, source = css) {
  const m = new RegExp("^\\s*width:\\s*(\\d+)px\\s*;", "m").exec(block(sel, source));
  assert.ok(m, `${sel} 缺 width: Npx 声明`);
  return +m[1];
}

console.log("\n① 弹窗小幅加宽 560/600（第七轮实机文案截断），严禁回到 660/700");
check("事件 540~580px、待办 580~620px，且待办更宽", () => {
  const ev = widthOf(".modal.caldav-dialog");
  const td = widthOf(".modal.caldav-dialog.caldav-dialog--todo");
  assert.ok(ev >= 540 && ev <= 580,
    `事件弹窗 ${ev}px：退到 520 会截断英文文案，涨到 660 又会撑出标题行中间空白（实测 158px）`);
  assert.ok(td >= 580 && td <= 620, `待办弹窗 ${td}px 超出小幅加宽区间`);
  assert.ok(td > ev, "待办弹窗应比事件弹窗更宽（延续原有设计）");
});
check("max-width:94vw 与移动端 100vw 规则保留", () => {
  decl(block(".modal.caldav-dialog"), /^\s*max-width:\s*94vw\s*;/m, "窄视口上限不能丢");
  decl(block(".modal.caldav-dialog.caldav-dialog--mobile"), /^\s*width:\s*100vw\s*;/m,
    "移动端全屏规则不能被宽度调整影响");
});
check("判据自测：退回 520/560 或暴涨到 660/700 都应判红（防假绿）", () => {
  const narrow = css.replace("width: 560px;", "width: 520px;").replace("width: 600px;", "width: 560px;");
  assert.ok(widthOf(".modal.caldav-dialog", narrow) < 540 &&
    widthOf(".modal.caldav-dialog.caldav-dialog--todo", narrow) < 580,
    "判据在未加宽的 520/560 上必须返回 false");
  const wide = css.replace("width: 560px;", "width: 660px;").replace("width: 600px;", "width: 700px;");
  assert.ok(widthOf(".modal.caldav-dialog", wide) > 580 &&
    widthOf(".modal.caldav-dialog.caldav-dialog--todo", wide) > 620,
    "判据在 660/700 上必须返回 false");
});

console.log("\n② 中部表单显式禁止横向滚动条（真正的根因修复）");
check("form 基础块同时声明 overflow-y:auto 与 overflow-x:hidden", () => {
  const b = block(".caldav-editor-form, .caldav-settings-form");
  decl(b, /^\s*overflow-y:\s*auto\s*;/m, "中部仍需纵向滚动");
  decl(b, /^\s*overflow-x:\s*hidden\s*;/m,
    "必须显式写 overflow-x:hidden；只写 overflow-y:auto 会被规范隐式算成 auto 而弹出横向滚动条");
});
check("判据自测：删掉 hidden 后应判红（防假绿）", () => {
  const b = block(".caldav-editor-form, .caldav-settings-form");
  const broken = b.replace(/^\s*overflow-x:\s*hidden\s*;/m, "");
  assert.ok(!/^\s*overflow-x:\s*hidden\s*;/m.test(broken), "判据在缺实现时应返回 false");
});

console.log("\n③ 标题行：不换行、开关文案优先完整、日历组承担收缩，绝不越过右边界");
check("标题行 min-width:0 + 仍锁 nowrap", () => {
  const b = block(".caldav-title-head");
  decl(b, /^\s*min-width:\s*0\s*;/m, "标题行须允许收缩");
  decl(b, /^\s*flex-wrap:\s*nowrap\s*;/m, "标题行不换行（换行会打乱表单节奏）");
});
check("粘贴识别开关不可收缩，文案优先完整（ellipsis 仅作极窄兜底）", () => {
  const b = block(".caldav-title-aiparse");
  decl(b, /^\s*flex:\s*0 0 auto\s*;/m,
    "开关组必须不可收缩：0 1 auto 会让它参与整行压缩，英文 Detect dates on paste 被截成 p…");
  decl(b, /^\s*min-width:\s*0\s*;/m, "开关组缺 min-width:0");
  const lbl = block(".caldav-title-aiparse .caldav-switch-label");
  decl(lbl, /^\s*min-width:\s*0\s*;/m, "开关文案缺 min-width:0");
  decl(lbl, /^\s*text-overflow:\s*ellipsis\s*;/m, "极窄兜底应省略文案而非撑破容器");
  decl(lbl, /^\s*white-space:\s*nowrap\s*;/m, "开关文案不得换行");
});
check("判据自测：开关组改回可收缩应判红", () => {
  const broken = block(".caldav-title-aiparse").replace(/^(\s*)flex:\s*0 0 auto\s*;/m, "$1flex: 0 1 auto;");
  assert.ok(!/^\s*flex:\s*0 0 auto\s*;/m.test(broken), "判据在 0 1 auto 上必须返回 false");
});
check("日历组可收缩、仍靠 margin-left:auto 右对齐", () => {
  const b = block(".caldav-title-cal");
  decl(b, /^\s*flex:\s*0 1 auto\s*;/m, "日历组须可收缩");
  decl(b, /^\s*min-width:\s*0\s*;/m, "日历组缺 min-width:0");
  decl(b, /^\s*margin-left:\s*auto\s*;/m, "日历组仍应靠右");
});
check("日历下拉 140px 可压到 90px（560/600 压力实测保住 140px，520 压力收到 122px）", () => {
  const b = block(".caldav-title-cal .caldav-cal-wrap");
  decl(b, /^\s*flex:\s*0 1 140px\s*;/m, "下拉须可收缩，固定 0 0 auto 会撑破容器");
  decl(b, /^\s*width:\s*140px\s*;/m, "正常宽度仍为 140px");
  decl(b, /^\s*min-width:\s*90px\s*;/m, "收缩下限 90px，避免下拉不可用");
});

console.log("\n④ 页脚仍锁死单行，且同样不渲染横向滚动条");
check("页脚 flex-wrap:nowrap 按声明行匹配", () => {
  decl(block(".caldav-editor-foot"), /^\s*flex-wrap:\s*nowrap\s*;/m,
    "页脚不得换行（前两轮截图已否掉 wrap 方案）");
});
check("页脚 overflow-x 也是 hidden（弹窗全域无横向滚动条）", () => {
  const b = block(".caldav-editor-foot");
  decl(b, /^\s*overflow-x:\s*hidden\s*;/m, "页脚仍写 auto 就会在极端字号下再冒横向滚动条");
  assert.ok(!/^\s*overflow-x:\s*(auto|scroll)\s*;/m.test(b), "不得同时保留 auto/scroll 声明");
});

console.log(`\n[editor-layout] ${pass} 项通过、${fails.length} 项失败`);
if (fails.length) {
  fails.forEach((f) => console.error("  - " + f));
  process.exitCode = 1;
}
