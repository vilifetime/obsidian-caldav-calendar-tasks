/**
 * 回归测试：从思源侧同步回来的三项编辑器 / 日记优化。
 *
 * 2026-10-12 雄哥要求：思源插件 `D:\ProgramData\WorkBuddyData\Develop\SiYuanCalDAV`
 * 的三项改动同样作用到 Obsidian 插件：
 *   ① 新增条目界面排版优化（日历并入标题行、全天与持续同行）
 *   ② 插入日记的优化（includeOverdueTodos 开关 + 「逾期的待办」小节）
 *   ③ 时间下拉框优化（选中项贴顶用列内偏移，而非 scrollIntoView）
 *
 * 为什么单独立一个文件：这三项都是**跨文件联动**的（types.ts 字段 + settings-tab
 * 声明式项 + i18n 字典 + editor.ts DOM + main.ts 逻辑 + styles.css），
 * 任何一处漏改或回滚，另几处都还是好的 —— 只有整体比对才能发现。
 * 且排版类改动 tsc 完全不报（模板字符串里的 HTML 没有类型约束）。
 *
 * 判据刻意用**源码文本断言**而非渲染结果：本机无 Obsidian 宿主，
 * 跑不起编辑器，只能靠结构性断言。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf8");
const editor = read("ui/editor.ts");
const main = read("main.ts");
const types = read("core/types.ts");
const settingsTab = read("ui/settings-tab.ts");
const css = read("styles.css");
const zh = JSON.parse(fs.readFileSync(path.join(SRC, "i18n/zh_CN.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(SRC, "i18n/en_US.json"), "utf8"));

/**
 * 剥离 JS 注释（块注释 + 行注释），保留换行以维持行号。
 *
 * 必须做的原因：源码注释里**经常出现被禁用 API 的名字**
 * （例如「原写法是 scrollIntoView({block:'center'})」这种说明），
 * 直接 grep 会把自己的说明文字判成违规。check-report.mjs 已因同类问题栽过。
 *
 * ⚠️ 行注释判据：`//` 前面必须是**空白或行首**。
 * 这是为了绕开 URL：`https://a.com//b` 里两个 `//` 的前一个字符分别是 `:` 和 `m`，
 * 都不是空白，故不会被误剥。（试过 `(?<!:)` 负回顾 —— 没用，它只查紧邻一字，
 * 会从 URL 的**第二个** `//` 起匹配，照样把 `//b";` 剥掉。）
 *
 * 已知取舍：`code();//注释`（`//` 紧贴分号）不会被剥。本项目无此写法，
 * 且漏剥只会让断言更严格（注释里的旧 API 名仍会被算），不会放跑违规。
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

let failed = 0;
function check(name, cond, hint) {
  if (cond) console.log("  [PASS] " + name);
  else {
    console.log("  [FAIL] " + name + (hint ? " —— " + hint : ""));
    failed++;
  }
}

console.log("\n① 新增条目界面排版");

check(
  "标题行含「日历」标签与下拉框（caldav-title-cal）",
  /caldav-title-head[\s\S]*?caldav-title-cal/.test(editor) && /caldav-title-cal-label/.test(editor),
  "标题行里应出现 caldav-title-cal 容器与 caldav-title-cal-label 标签"
);
check(
  "标题输入框仍在（caldav-title-row 未在重构中丢失）",
  /caldav-title-row[\s\S]*?caldav-title-input/.test(editor),
  "caldav-title-row / caldav-title-input 必须保留 —— 曾在此类重构中整块丢失"
);
check(
  "日历下拉的触发与弹层节点仍在（data-cal-pop / data-action=cal-toggle）",
  /data-action="cal-toggle"/.test(editor) && /data-cal-pop/.test(editor),
  "JS 靠 data-cal-pop 与 cal-toggle 绑定事件，节点丢了选择器就失效"
);
check(
  "独立「日历」section 已移除（不再有 caldav-section-title + caldav-cal-head 组合）",
  !/caldav-section-title caldav-cal-head/.test(editor),
  "日历已并入标题行，独立 section 应删除"
);
check(
  "全天开关与持续时长在同一行（caldav-all-day-row 内含 duration）",
  /caldav-all-day-row[\s\S]*?caldav-duration-row--inline[\s\S]*?caldav-all-day-row/.test(editor) === false &&
    /caldav-all-day-row[\s\S]*?caldav-duration-row caldav-duration-row--inline/.test(editor),
  "持续时长应嵌在 caldav-all-day-row 内"
);
check(
  "旧的独立 duration-row 已删除（全文件只剩 inline 那一处）",
  (stripComments(editor).match(/class="caldav-duration-row/g) || []).length === 1,
  "应只剩带 --inline 的那一处，否则会重复渲染两个持续时长"
);
check(
  "CSS：caldav-title-cal / caldav-all-day-row / --inline 三个新类齐备",
  /\.caldav-title-cal \{/.test(css) &&
    /\.caldav-title-cal-label \{/.test(css) &&
    /\.caldav-all-day-row \{/.test(css) &&
    /\.caldav-duration-row--inline \{/.test(css),
  "DOM 改了但 CSS 没跟上，新结构会完全没样式"
);

console.log("\n② aiParse 默认开");

check(
  "CalItem.aiParse 字段已声明",
  /aiParse\?: boolean/.test(types),
  "types.ts 需要 aiParse 可选字段"
);
check(
  "勾选框按「仅显式 false 才不勾」渲染",
  /data-f="aiParse" \$\{it\.aiParse === false \? "" : "checked"\}/.test(editor),
  "默认勾选的判据必须是 it.aiParse === false"
);
check(
  "该字段注释标明「不持久化、不参与同步」",
  /aiParse\?: boolean[\s\S]{0,600}?(不持久化|不参与同步)/.test(types) ||
    /不持久化[\s\S]{0,600}?aiParse\?: boolean/.test(types),
  "注释可能在字段上方或下方，两个方向都要判"
);

console.log("\n③ 插入日记包含逾期的待办");

check(
  "CalSettings.includeOverdueTodos 已声明且默认关",
  /includeOverdueTodos\?: boolean/.test(types) && /includeOverdueTodos: false/.test(types),
  "types.ts 需要字段 + DEFAULT_SETTINGS 默认 false"
);
check(
  "设置页声明式项已加（日记分组）",
  /key: "includeOverdueTodos"/.test(settingsTab),
  "settings-tab.ts 的 getSettingDefinitions 需要这一项"
);
check(
  "中英文案齐备且不含空串",
  !!zh["settings.includeOverdueTodos"] && !!en["settings.includeOverdueTodos"] &&
    !!zh["settings.includeOverdueTodosDesc"] && !!en["settings.includeOverdueTodosDesc"] &&
    !!zh["diary.sectionOverdue"] && !!en["diary.sectionOverdue"],
  "缺任一文案的 key，该语言下会显示 key 名本身"
);
check(
  "英文文案不含中文",
  !/[一-鿿]/.test(en["settings.includeOverdueTodos"]) &&
    !/[一-鿿]/.test(en["settings.includeOverdueTodosDesc"]) &&
    !/[一-鿿]/.test(en["diary.sectionOverdue"]),
  "英文界面露中文（本项目已栽过一次）"
);
check(
  "main.ts 收集逾期的待办（DUE 早于今天零点）",
  /includeOverdue = !!this\.store\.settings\.includeOverdueTodos/.test(main) &&
    /dueMs < todayMidnight/.test(main),
  "收集条件必须是 DUE < 今天零点"
);
check(
  "逾期的待办单独成小节且排在前面",
  /### \$\{t\("diary\.sectionOverdue"\)\}/.test(main) &&
    /const md = `## \$\{span\.sectionTitle\}\\n\$\{overdueMd\}\$\{rows/.test(main),
  "小节标题走 t()，且 overdueMd 必须拼在 rows 之前"
);
check(
  "已落在范围内的条目不会重复计入（inRange 判据）",
  /let inRange = false/.test(main) && /inRange = true/.test(main) && /!inRange/.test(main),
  "「所有」范围本来就含逾期条目，不去重会写两遍"
);
check(
  "空结果判据同时看 rows 与 overdueRows",
  /if \(!rows\.length && !overdueRows\.length\)/.test(main),
  "只看 rows 会让「仅有逾期条目」时误报「没有日程或待办」"
);
check(
  "逾期的待办按 DUE 升序（逾期最久排最前）",
  /overdueRows\.sort\(\(a, b\) => a\.ms - b\.ms\)/.test(main),
  "排序丢了就变成按遍历顺序，最该赶的反而在最后"
);

console.log("\n④ 时间下拉框贴顶");

check(
  "选中项滚动用列内偏移（a.offsetTop - c.offsetTop）",
  /a\.offsetTop - c\.offsetTop/.test(editor),
  "scrollIntoView({block:'center'}) 在列内滚动场景定位不准"
);
check(
  "不再使用 scrollIntoView 定位（剥注释后）",
  !/scrollIntoView/.test(stripComments(editor)),
  "scrollIntoView 应已全部移除。⚠️ 必须先剥注释 —— 说明文字里提到旧写法名是常事，"
  + "本项目已因「自查命中自己写的注释」栽过（check-report 的 globalThis 项）"
);
check(
  "滚动计算包了 rAF（弹层刚渲染完才有布局），且走 window. 前缀",
  /window\.requestAnimationFrame\(pos\)/.test(editor) &&
    /typeof window\.requestAnimationFrame/.test(editor),
  "渲染与定位同一帧会拿到旧布局；裸 requestAnimationFrame 会绑错窗口（见 ⑨ 组）"
);
check(
  "scrollTop 有下限保护（不会出现负值）",
  /Math\.max\(0, a\.offsetTop - c\.offsetTop\)/.test(editor),
  "负 scrollTop 被浏览器钳成 0 且部分环境报错"
);

console.log("\n⑤ 判据自测（防止检查项自身失效）");
// 这三个用例验证上面的断言不是「永远为真」——注入假阳性必须能被抓住。
const SELF = [
  {
    name: "title-row 判据能命中缺失场景",
    probe: '<div class="caldav-title-head"></div>', // 没有 title-row
    re: /caldav-title-row[\s\S]*?caldav-title-input/,
    want: false,
  },
  {
    name: "caldav-title-cal 判据能命中缺失场景",
    probe: '<div class="caldav-title-head"><label class="caldav-title-label"></label></div>',
    re: /caldav-title-head[\s\S]*?caldav-title-cal/,
    want: false,
  },
  {
    name: "offsetTop 判据能命中 scrollIntoView 旧写法",
    probe: 'pop.querySelector(".is-active")?.scrollIntoView?.({ block: "center" });',
    re: /a\.offsetTop - c\.offsetTop/,
    want: false,
  },
];
for (const c of SELF) {
  const got = c.re.test(c.probe);
  check(c.name + "（" + (got === c.want ? "判据有效" : "判据失效") + "）", got === c.want,
    "探针 " + JSON.stringify(c.probe.slice(0, 40)) + " 判定为 " + got + "，期望 " + c.want);
}

// stripComments 自身也必须验证 —— 它若把 URL 误剥，「无 scrollIntoView」那条断言
// 就会失效，而输出看着仍是 PASS。这条 2026-10-12 实测栽过：`(?<!:)` 方案对
// `http://a.com//b` 无效，因为正则会从**第二个** // 起匹配，照样剥掉 `//b";`。
const STRIP_CASES = [
  { name: "行尾注释被剥掉", in: "const x = 1; // scrollIntoView 旧写法", wantHas: false, has: "scrollIntoView" },
  { name: "块注释被剥掉", in: "/* scrollIntoView 说明 */", wantHas: false, has: "scrollIntoView" },
  { name: "行首注释被剥掉", in: "// scrollIntoView 行首", wantHas: false, has: "scrollIntoView" },
  { name: "URL 里的 // 不被误剥", in: 'const y = "http://a.com//b";', wantHas: true, has: "http://a.com//b" },
  { name: "字符串里的 // 不被误剥", in: 'const z = "//not a comment";', wantHas: true, has: '"//not a comment"' },
];
for (const c of STRIP_CASES) {
  const out = stripComments(c.in);
  const got = out.includes(c.has);
  check(
    "stripComments：" + c.name + "（" + (got === c.wantHas ? "判据有效" : "判据失效") + "）",
    got === c.wantHas,
    "输入 " + JSON.stringify(c.in) + " → 输出 " + JSON.stringify(out)
  );
}

console.log("\n⑥ 图标尺寸（2026-10-12 雄哥要求放大）");
// 截图反馈：粘贴识别日期的 sparkle、清除日期/时间的垃圾桶都太小。
// 这两个是「功能入口但长得像装饰」的典型 —— 图标一小，用户根本发现不了能点。
// 判据同时钉住 Ob 与思源两侧，避免只改一边导致两个项目不一致。
const cssSize = (text, sel) => {
  const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*?width:\\s*(\\d+)px").exec(text);
  return m ? +m[1] : null;
};
const siyuanCss = fs.existsSync(path.join(ROOT, "..", "SiYuanCalDAV", "src", "index.css"))
  ? fs.readFileSync(path.join(ROOT, "..", "SiYuanCalDAV", "src", "index.css"), "utf8")
  : null;
check(
  "Ob：sparkle 图标 ≥ 26px（原 17px，雄哥两次反馈后定）",
  (cssSize(css, ".caldav-title-action svg") || 0) >= 26,
  "当前 " + cssSize(css, ".caldav-title-action svg") + "px"
);
check(
  "Ob：清除按钮图标 ≥ 28px（原 14px，雄哥三次反馈后定）",
  (cssSize(css, ".caldav-input-clear svg") || 0) >= 28,
  "当前 " + cssSize(css, ".caldav-input-clear svg") + "px"
);
check(
  "Ob：两个按钮本身也放大了（图标大但按钮小会顶到边框）",
  (cssSize(css, ".caldav-title-action") || 0) >= 36 &&
    (cssSize(css, ".caldav-input-clear") || 0) >= 34,
  "按钮 " + cssSize(css, ".caldav-title-action") + " / " + cssSize(css, ".caldav-input-clear") + "px"
);
if (siyuanCss) {
  // ⚠️ 这里**不要求思源与 Ob 同尺寸**：Obsidian 放大是因为宿主有 svg 属性坑 +
  //    雄哥两次反馈；思源侧 base.css 没有那个坑、也没人反馈它小，
  //    强行拉平会让思源界面无缘无故变样。只要求思源的 svg 也没有 width/height 属性
  //    （它同样受 icons.ts 管，若哪天思源也遇到宿主坑，改法一致）。
  check(
    "思源侧 icons.ts 同样不带 svg 尺寸属性（改法一致，便于对照）",
    (() => {
      const syIcons = path.join(ROOT, "..", "SiYuanCalDAV", "src", "ui", "icons.ts");
      if (!fs.existsSync(syIcons)) return true;
      return !/<svg[^>]*\swidth=/.test(fs.readFileSync(syIcons, "utf8"));
    })(),
    "思源 icons.ts 仍带 width/height 属性"
  );
} else {
  console.log("  [SKIP] 思源侧源码不在预期路径，跳过跨项目一致性断言");
}

console.log("\n⑦ svg 不得带 width/height 属性（Obsidian 宿主坑）");
// 2026-10-13：雄哥两次反馈「图标框内的图形小」，而 CSS 里明明写了 20px。
// 根因是 icons.ts 的 svg() 工厂函数在每个 <svg> 上写了 width="14" height="14"，
// 而 Obsidian 宿主自己的全局 svg 规则特异性高于插件的 `.xxx svg { width: 20px }`
// —— 于是 HTML 属性尺寸赢、CSS 输。思源侧不犯（它的 base.css 没有同类规则），
// 同一个文件两边行为不同，极难对照。
//
// 判据：产物与源码里的 <svg> 都不得出现 width= / height= 属性。
// 这条是**根因级**断言：只断言 CSS 尺寸数字，挡不住属性把 CSS 盖掉这种情况。
const iconsSrc = read("ui/icons.ts");
check(
  "icons.ts 的 svg() 不再输出 width/height 属性",
  /<svg viewBox="\$\{viewBox\}" fill="none"/.test(iconsSrc),
  "svg() 模板串里若还有 width=\"14\" height=\"14\"，宿主的全局规则会盖过各处 CSS"
);
check(
  "icons.ts 的 <svg> 标签上没有 width=/height= 属性",
  !/<svg[^>]*\swidth=/.test(iconsSrc) && !/<svg[^>]*\sheight=/.test(iconsSrc),
  "只查 <svg> 标签本身 —— 图形内部的 <rect width=\"17\"> 是合法属性，不能一起禁"
);
// 上面那条判据的自测：曾把范围写宽成「源码里任何 width=\"N\"」，
// 结果把 <rect width="17"> 这类**图形内部属性**也判成违规（FAIL 了一次）。
// 收窄后必须验证它仍能抓住真正的违规写法。
const SVG_ATTR_RE = /<svg[^>]*\swidth=/;
const SVG_CASES = [
  { code: '<svg viewBox="0 0 24 24" width="14" height="14">', want: true, why: "旧写法，属性在后" },
  { code: '<svg width="14" viewBox="0 0 24 24">', want: true, why: "属性在前也要命中" },
  { code: '<svg viewBox="0 0 24 24" fill="none">', want: false, why: "新写法" },
  { code: '<rect x="3" y="4" width="17" height="16" rx="3"/>', want: false, why: "图形内部属性" },
  { code: '<circle cx="12" cy="12" r="3"/>', want: false, why: "无 width" },
];
const svgWrong = SVG_CASES.filter((c) => SVG_ATTR_RE.test(c.code) !== c.want);
check(
  "svg 属性判据自测通过（" + SVG_CASES.length + " 个用例）",
  svgWrong.length === 0,
  svgWrong.map((c) => c.why + " 判定为 " + SVG_ATTR_RE.test(c.code) + "，期望 " + c.want).join(" | ")
);
check(
  "四个新增兜底尺寸规则齐备（去属性后不能有图标没尺寸）",
  /\.caldav-btn svg \{ width:/.test(css) &&
    /\.caldav-cat-manage svg \{ width:/.test(css) &&
    /\.caldav-catmgr-btn svg \{ width:/.test(css) &&
    /\.caldav-reminder-x svg \{ width:/.test(css),
  "去掉属性后，原先靠属性兜底的容器必须补 CSS 尺寸"
);

console.log("\n⑧ select 必须显式给 height（否则裁字）");
// 2026-10-13 雄哥截图：新建待办时「优先级」下拉框高度不够，「无」字被裁。
// 根因：`select` 的固有高度由 option 行高决定，与 input 的文本行高不一致；
// 在 box-sizing:border-box 下 Obsidian 宿主又给它定 height，两者叠加就裁字。
// .cal-task-filter 已因此栽过一次（见 styles.css 里那条长注释），
// 但编辑器里 4 处 select.caldav-input 一直没补 —— 这次一并修。
// 取「独立的 select.caldav-input 规则块」。
// ⚠️ 不能简单用 /select\.caldav-input \{([^}]*)\}/ —— 文件里更早有一行
// `.caldav-field-icon select.caldav-input { padding-right: 28px; }`，
// 它会抢先匹配，把结果截成只剩 padding-right，height 判据永远 FAIL。
// 故要求选择器**单独成行**（行首即 select，前面只有空白）。
const selectBlockOf = (text) => {
  const m = text.match(/^select\.caldav-input \{([\s\S]*?)\}/m);
  return m ? m[1] : "";
};
const selectRule = selectBlockOf(css);
check(
  "select.caldav-input 有显式 height",
  /height:\s*36px/.test(selectRule),
  "当前规则：" + selectRule.replace(/\s+/g, " ").trim().slice(0, 80)
);
check(
  "select 右侧留出箭头位（padding-right）",
  /padding-right:\s*28px/.test(selectRule),
  "appearance:none 后原生箭头消失，靠自绘 chevron，不留位会压在文字上"
);
check(
  "编辑器里 4 处 select 都在（提醒/频率/结束模式/优先级）",
  ["data-alarm", 'data-f="freq"', 'data-f="endMode"', 'data-f="priority"'].every((k) =>
    new RegExp("<select class=\"caldav-input\"[^>]*" + k.replace(/"/g, '\\"')).test(editor)
  ),
  "漏一处那个下拉就还裁字"
);
check(
  "思源侧同样补了 height（两边实现一字不差）",
  (() => {
    const sy = path.join(ROOT, "..", "SiYuanCalDAV", "src", "index.css");
    if (!fs.existsSync(sy)) return true;
    return /height:\s*36px/.test(selectBlockOf(fs.readFileSync(sy, "utf8")));
  })(),
  "思源侧 select.caldav-input 仍无 height"
);
// 判据自测：确认它抓的是独立规则块，不会被子选择器那一行抢先。
const SELFB = [
  { name: "能抓到独立规则块里的 height", in: "select.caldav-input {\n  height: 36px;\n}", want: true },
  { name: "不被 .caldav-field-icon 前缀行抢先", in: ".caldav-field-icon select.caldav-input { padding-right: 28px; }\nselect.caldav-input {\n  height: 36px;\n}", want: true },
  { name: "没有 height 时报 FAIL", in: "select.caldav-input {\n  cursor: pointer;\n}", want: false },
];
for (const c of SELFB) {
  const got = /height:\s*36px/.test(selectBlockOf(c.in));
  check("select 规则块判据自测：" + c.name, got === c.want, "判定为 " + got + "，期望 " + c.want);
}

console.log("\n⑨ rAF 必须走 window.（popout 窗口兼容）");
// 社区审核 0.4.10 报的：src/ui/editor.ts:688 用了裸 requestAnimationFrame()。
// Obsidian 的 popout 窗口是**独立的 window 对象**，裸调用绑的是主窗口的 rAF，
// 主窗口不可见时它不执行 —— 弹层在新窗口里打不开、选中项定位失效。
// 项目里 reminder-toast.ts 早就是 window.requestAnimationFrame（写法正确），
// 只有 editor.ts 这一处漏了，故这里做**跨文件互查**：两边都要带 window. 前缀。
const reminder = read("ui/reminder-toast.ts");
check(
  "editor.ts 用 window.requestAnimationFrame",
  /window\.requestAnimationFrame/.test(stripComments(editor)) &&
    !/(^|[^.])\brequestAnimationFrame\s*\(/.test(stripComments(editor).replace(/window\.requestAnimationFrame/g, "")),
  "editor.ts 仍有裸 requestAnimationFrame 调用"
);
check(
  "reminder-toast.ts 保持 window. 前缀（参照物不能退化）",
  /window\.requestAnimationFrame/.test(stripComments(reminder)),
  "这处本来就是对的，别被顺手改回裸调用"
);
check(
  "降级路径用 window.setTimeout（同属该 window）",
  /window\.setTimeout\(pos, 0\)/.test(stripComments(editor)),
  "退化到 setTimeout 也要走 window.，否则同样绑错窗口"
);
// 判据自测：确认它能分辨带前缀与不带前缀的两种写法。
const RAF = [
  { code: "if (typeof window.requestAnimationFrame === \"function\") window.requestAnimationFrame(pos);", want: true },
  { code: "if (typeof requestAnimationFrame !== \"undefined\") requestAnimationFrame(pos);", want: false },
  { code: "const nextFrame = (cb) => window.requestAnimationFrame(cb);", want: true },
  { code: "window.setTimeout(pos, 0);", want: false },
];
const rafWrong = RAF.filter((c) => /window\.requestAnimationFrame/.test(c.code) !== c.want);
check(
  "rAF 判据自测通过（" + RAF.length + " 个用例）",
  rafWrong.length === 0,
  rafWrong.map((c) => JSON.stringify(c.code.slice(0, 40)) + " 判定为 " + /window\.requestAnimationFrame/.test(c.code) + "，期望 " + c.want).join(" | ")
);

console.log("\n⑩ 待办默认截止 + 清除日期时间按钮（2026-10-13 雄哥要求）");
// ① 待办新建时默认截止 = 下一日同一时刻（原先是 undefined「无截止」）
// ② 默认开始时间落在「下一个整点」——这条由 defaultStartStamp 负责，这里顺带核
// ③ 全天开关后面加「清除日期时间」按钮，一键清 4 个字段
const syEditor = fs.existsSync(path.join(ROOT, "..", "SiYuanCalDAV", "src", "ui", "editor.ts"))
  ? fs.readFileSync(path.join(ROOT, "..", "SiYuanCalDAV", "src", "ui", "editor.ts"), "utf8")
  : null;
const dateSrc = read("core/date.ts");

check(
  "Ob：待办新建默认截止 = addDays(start, 1)，不再是 undefined",
  /if \(kind === "todo" && isNew\) it\.end = addDays\(it\.start, 1\)/.test(stripComments(editor)),
  "默认值改动测试不会失败，必须用断言钉住"
);
check(
  "Ob：代码里不再有待办默认无截止的旧写法",
  !/kind === "todo" && isNew\) it\.end = undefined/.test(stripComments(editor)),
  "若还在，说明有人把默认值改回去了"
);
check(
  "Ob：defaultStartStamp 保持「今天 → 下一个整点」",
  /d\.setHours\(d\.getHours\(\) \+ 1, 0, 0, 0\)/.test(dateSrc),
  "整点默认值由它负责；非今天仍是 09:00"
);
check(
  "Ob：清除日期时间按钮在天全开关之后",
  /caldav-all-day-switch[\s\S]*?data-clear-datetime[\s\S]*?caldav-duration-row/.test(stripComments(editor)),
  "按钮必须位于全天开关与持续时长之间"
);
check(
  "Ob：按钮文案走 i18n（中英齐备）",
  !!zh["common.clearDateTime"] && !!en["common.clearDateTime"] &&
    zh["common.clearDateTime"] === "清除日期时间" &&
    /[A-Za-z]/.test(en["common.clearDateTime"]),
  "按钮上的文字与 tooltip 用同一个 key"
);
check(
  "Ob：点击清 4 个字段（startDate/startTime/endDate/endTime）",
  /for \(const name of \["startDate", "startTime", "endDate", "endTime"\]\)/.test(stripComments(editor)),
  "漏一个字段就等于没清干净"
);
check(
  "Ob：CSS 有 all-day-clear 按钮样式与 svg 尺寸",
  /\.caldav-all-day-clear \{/.test(css) && /\.caldav-all-day-clear svg \{ width:/.test(css),
  "DOM 加了但 CSS 没跟上，按钮会完全没样式"
);
check(
  "Ob：all-day-row 不再用 space-between（三个子元素会被均铺）",
  (() => {
    const m = css.match(/^\.caldav-all-day-row \{([\s\S]*?)\}/m);
    return m ? !/justify-content:\s*space-between/.test(m[1]) : false;
  })(),
  "加按钮后仍是 space-between，开关和按钮会被拉开"
);
check(
  "Ob：持续时长靠 margin-left:auto 推到行尾",
  (() => {
    const m = css.match(/^\.caldav-duration-row--inline \{([\s\S]*?)\}/m);
    return m ? /margin-left:\s*auto/.test(m[1]) : false;
  })(),
  "不加会被清除按钮挤到中间"
);
if (syEditor) {
  check(
    "思源：默认截止 / 按钮 / 事件绑定 / CSS 四项同步",
    /kind === "todo" && isNew\) it\.end = addDays\(it\.start, 1\)/.test(syEditor) &&
      /data-clear-datetime/.test(syEditor) &&
      /for \(const name of \["startDate", "startTime", "endDate", "endTime"\]\)/.test(syEditor) &&
      /\.caldav-all-day-clear \{/.test(fs.readFileSync(path.join(ROOT, "..", "SiYuanCalDAV", "src", "index.css"), "utf8")),
    "四项中有一项没同步，两边行为就会不一致"
  );
} else {
  console.log("  [SKIP] 思源侧源码不在预期路径，跳过一致性断言");
}
// 判据自测：确认「默认截止」判据能分辨 undefined 旧写法。
const DUE = [
  { code: 'if (kind === "todo" && isNew) it.end = addDays(it.start, 1);', want: true },
  { code: 'if (kind === "todo" && isNew) it.end = undefined;', want: false },
];
const dueWrong = DUE.filter((c) => /it\.end = addDays\(it\.start, 1\)/.test(c.code) !== c.want);
check(
  "默认截止判据自测通过（2 个用例）",
  dueWrong.length === 0,
  dueWrong.map((c) => c.code + " 判定为 " + /it\.end = addDays\(it\.start, 1\)/.test(c.code)).join(" | ")
);

console.log(
  failed === 0 ? "\n✓ 思源侧同步回归测试通过" : `\n✗ ${failed} 个用例失败`
);
process.exit(failed === 0 ? 0 : 1);
