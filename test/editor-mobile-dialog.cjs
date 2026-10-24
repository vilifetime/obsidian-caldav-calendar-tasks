/**
 * 回归测试：Obsidian 移动端编辑器日期框被裁（2026-10-25 雄哥实测截图）
 *
 * 症状：Obsidian 移动端编辑弹窗「开始 / 结束」行的日期框只显示「2026/」，
 * 「2026/10/24」被裁掉；思源端同位置完整显示，正常。
 *
 * 根因：styles.css 里窄屏收紧规则的选择器统一写成
 *   `.caldav-mobile-dialog .caldav-datetime-row { gap: 6px }` 等一整套，
 * 而 Obsidian 侧编辑器弹窗只挂了 `.caldav-dialog--mobile`（那条只管 Modal 占满
 * 视口的尺寸），从没挂过 `.caldav-mobile-dialog` —— 选择器在 DOM 里匹不到，
 * 整套窄屏适配静默失效，日期框退回桌面尺寸（原生 type=date 固有宽约 125px +
 * padding-left 34px），窄屏上内容被裁。`.caldav-touch` 也救不了：它只出现在
 * 面板根 .caldav-root 内部，而 Modal 的 DOM 在 body 下、与面板不相邻。
 * （思源侧靠 Dialog 的 containerClassName 挂 `caldav-mobile-dialog`，故正常。）
 *
 * 修法：editor.ts 的 onOpen 在 mobile 分支给 modalEl 补挂 `caldav-mobile-dialog`，
 * 与 `caldav-dialog--mobile` 并存（后者仍被 .modal.caldav-dialog.caldav-dialog--mobile
 * 的全屏尺寸规则依赖，不能替换）。
 *
 * ⚠️ Obsidian 侧无 DOM 布局环境，这里守源码级形状；「日期框真的不被裁」靠真机验。
 *
 * 用法：node test/editor-mobile-dialog.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SIYUAN_ROOT = path.resolve(ROOT, "..", "SiYuanCalDAV");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readSiyuan = (rel) => fs.readFileSync(path.join(SIYUAN_ROOT, rel), "utf8");

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("  [PASS]", name);
  } catch (e) {
    console.error("  [FAIL]", name, "\n     ", e.message);
    process.exitCode = 1;
  }
}

// 剥注释再断言：注释里出现 addClass("caldav-mobile-dialog") 不算真的挂载
const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const editor = strip(read("src/ui/editor.ts"));
const css = read("src/styles.css");
const editorSy = readSiyuan("src/ui/editor.ts");

// ---------- ① 挂载形状 ----------
console.log("[editor-mobile-dialog] 弹窗容器类挂载");

t("mobile 分支给 modalEl 挂 caldav-mobile-dialog（窄屏规则的选择器）", () => {
  assert.ok(
    /if \(this\.mobile\) \{\s*this\.modalEl\.addClass\("caldav-dialog--mobile"\);[\s\S]{0,700}?this\.modalEl\.addClass\("caldav-mobile-dialog"\);\s*\}/.test(
      editor
    ),
    "mobile 分支缺少 addClass(\"caldav-mobile-dialog\") —— .caldav-mobile-dialog .* 窄屏规则匹配不到任何元素，日期框退回桌面尺寸被裁"
  );
});

t("caldav-dialog--mobile 仍要挂（全屏尺寸规则依赖它，不能被替换）", () => {
  assert.ok(
    /if \(this\.mobile\) \{\s*this\.modalEl\.addClass\("caldav-dialog--mobile"\);/.test(editor),
    "caldav-dialog--mobile 被改名/替换 —— .modal.caldav-dialog.caldav-dialog--mobile 的 100vw 全屏规则会失效"
  );
  // 反向：两个类都得在，只挂其中一个都不对
  const m = /if \(this\.mobile\) \{([\s\S]*?)\}/.exec(editor);
  assert.ok(m, "找不到 mobile 分支");
  assert.ok(
    m[1].includes('addClass("caldav-dialog--mobile")') &&
      m[1].includes('addClass("caldav-mobile-dialog")'),
    "mobile 分支里两个类不同时存在"
  );
});

// ---------- ② 挂上类之后，规则必须真的存在 ----------
console.log("[editor-mobile-dialog] 窄屏规则在位");

// 逐条核对 .caldav-mobile-dialog 后代选择器：类挂了但规则被删，一样静默失效
const needles = [
  ["datetime-row 行间隙收紧", /\.caldav-mobile-dialog \.caldav-datetime-row \{ gap: 6px; \}/],
  ["datetime-label 标签收窄", /\.caldav-mobile-dialog \.caldav-datetime-label \{ flex: 0 0 26px; font-size: 11\.5px; \}/],
  ["datetime-inputs 间隙收紧", /\.caldav-mobile-dialog \.caldav-datetime-inputs \{ gap: 4px; \}/],
  ["date-input 参与收缩", /\.caldav-mobile-dialog \.caldav-date-input \{ flex: 1 1 90px; padding-left: 25px; padding-right: 8px; \}/],
  ["input-wrap--date 允许收缩", /\.caldav-mobile-dialog \.caldav-input-wrap--date \{ flex: 1 1 auto; \}/],
  ["input-wrap--time 固定窄宽", /\.caldav-mobile-dialog \.caldav-input-wrap--time \{ flex: 0 0 68px; min-width: 68px; \}/],
  ["time-trigger 内边距收紧", /\.caldav-mobile-dialog \.caldav-input\.caldav-time-trigger \{ padding: 8px 6px 8px 25px; \}/],
  ["input-icon 位置收紧", /\.caldav-mobile-dialog \.caldav-input-icon \{ left: 7px; \}/],
];
for (const [name, re] of needles) {
  t(`.caldav-mobile-dialog 规则在位：${name}`, () => {
    assert.ok(re.test(css), `${name} 规则缺失 —— 挂上类也不会生效`);
  });
}

t("极窄屏（max-width:350px）兜底规则里也有 .caldav-mobile-dialog 一路", () => {
  const media = /@media \(max-width: 350px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(media, "找不到 @media (max-width: 350px) 兜底块");
  for (const re of [
    /\.caldav-mobile-dialog \.caldav-datetime-row \.caldav-input-icon \{ display: none; \}/,
    /\.caldav-mobile-dialog \.caldav-date-input \{ padding-left: 9px; padding-right: 2px; font-size: 11\.5px; \}/,
    /\.caldav-mobile-dialog \.caldav-input-wrap--time \{ flex: 0 0 62px; min-width: 62px; \}/,
  ]) {
    assert.ok(re.test(media[1]), `极窄屏兜底缺少规则：${re}`);
  }
});

// ---------- ③ 两端机制对等 ----------
console.log("[editor-mobile-dialog] 与思源侧机制对等");

t("思源侧同样给移动端弹窗挂 caldav-mobile-dialog（containerClassName）", () => {
  assert.ok(
    /containerClassName: mobile \? "caldav-mobile-dialog" : undefined/.test(editorSy),
    "思源侧形状变了 —— 两端已漂移，本测试的前提需要复核"
  );
});

console.log(`\n[editor-mobile-dialog] ${passed} 项通过`);
if (process.exitCode) console.error("存在失败项");
