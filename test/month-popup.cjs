/**
 * 回归测试：月视图「某日全部条目」浮层（2026-10-14，与思源侧同构同步）。
 *
 * 背景：月视图每格只渲染 3 条，超出的收进「还有 N 项…」，看不到全貌。
 * 两端都改成「鼠标悬浮 → 浮层展开该日全部条目」，收起规则：
 *  ① 只有条目数 > 3 的格子才出浮层；
 *  ② 指针移出格子且不在浮层上 → 延迟 CLOSE_DELAY(600ms) 后消失；
 *  ③ 指针移入浮层后又移出 → 同样延迟后消失；
 *  ④ 指针停在浮层上则一直保留，直到点某个条目（进编辑器时随之关闭）。
 *
 * 为什么主要是源码级断言：本项目 Obsidian 侧没有 DOM 布局环境（jsdom 不做布局），
 * 「浮层贴不贴格子底边」「间隙多大」这类**几何**结论只能靠思源侧
 * test/loader.test.mjs（真 DOM 行为）与 CDP 几何脚本验证。
 * 本文件守的是**另一半、且最容易在跨端移植时被漏掉**的部分：
 *  ① 触发与收起规则的关键代码不许退化；
 *  ② 浮层挂在 body 上 → CSS 必须自带 `--caldav-*` 变量映射
 *     （思源侧已踩过：拿不到变量时边框退化成 currentColor、底色变透明）；
 *  ③ **两端的关键常量必须一致**（延迟值、GAP、锚点选择）——
 *     跨端移植最常见的静默漂移就是「一边改了另一边忘了改」。
 *
 * 用法：node test/month-popup.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SIYUAN_ROOT = path.resolve(ROOT, "..", "SiYuanCalDAV");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readSiyuan = (rel) => fs.readFileSync(path.join(SIYUAN_ROOT, rel), "utf8");

const pop = read("src/ui/month-day-popup.ts");
const month = read("src/ui/view-month.ts");
const css = read("src/styles.css");

/* ---------- ① 触发与收起规则 ---------- */

// 只由悬停触发：不得再有 click 打开浮层（会与「右键新建」抢地盘）
assert.ok(
  !/addEventListener\("click"[\s\S]{0,200}showFor/.test(month),
  "浮层只能由悬停触发：view-month.ts 不该再用 click 打开浮层"
);
assert.ok(
  /addEventListener\("mouseenter"/.test(month),
  "月视图格子必须监听 mouseenter 来展开浮层"
);
assert.ok(
  /addEventListener\("mouseleave"[\s\S]{0,200}schedulePopupClose/.test(month),
  "移出格子必须启动延迟收起（schedulePopupClose）"
);
// 只有放得下不下的格子才出浮层：靠 data-more 判定
assert.ok(
  /data-more="\$\{more\}"/.test(month),
  "格子必须把「还差几条」写进 data-more（悬停时据此判断要不要弹）"
);
assert.ok(
  /Number\(cell\.dataset\.more \|\| "0"\) <= 0/.test(month),
  "data-more <= 0 的格子必须直接 return，不出浮层"
);

/* ---------- ② 保持区必须「小而精确」 ----------
 * 前两轮返工的根因：传视图容器 → 范围近乎全屏 → 永远收不掉；
 * 只判浮层不判格子 → 指针划向浮层途中先离开格子 → 立即收就点不到。 */
assert.ok(
  /hoverZone = cell \|\| null/.test(pop),
  "保持区必须是「触发的那一个格子」—— 传容器会导致浮层永远收不掉"
);
assert.ok(
  /pointerInsideZone[\s\S]{0,400}hoverZone\.contains/.test(pop),
  "关闭判定必须把「触发格子」也算作范围内"
);
// 调用处：锚点与保持区都传 cell，viewEl 只作「点不关」范围
assert.ok(
  /openMonthDayPopup\(ctx, day, list, cell, \(\) => renderMonthView/.test(month),
  "调用时必须把格子（cell）同时作为**锚点**与**保持区**，viewEl 只作为「点不关」范围"
);
// 锚点不能用「还有 N 项…」那一行：格子 overflow:hidden，它被裁在可视区外，定位会浮在半空
assert.ok(
  !/cell\.querySelector\("\.cal-chip-more"\)\s*\|\|\s*cell/.test(month),
  "锚点不能取「还有 N 项…」行（它被 overflow:hidden 裁掉，定位会浮在半空留出可见的缝）"
);

/* ---------- ③ 浮层挂在 body 上 → CSS 必须自带变量映射 ---------- */
const popBlock = (() => {
  const i = css.indexOf(".caldav-month-pop {");
  assert.ok(i >= 0, "CSS 里找不到 .caldav-month-pop");
  return css.slice(i, i + 900);
})();
for (const v of ["--caldav-bg", "--caldav-border", "--caldav-text", "--caldav-accent"]) {
  assert.ok(
    popBlock.includes(v),
    `浮层挂在 body 上拿不到 .caldav-root 的变量，自身必须声明 ${v}`
  );
}
assert.ok(/position: fixed/.test(popBlock), "浮层必须 position: fixed（挂 body 上按 absolute 会跑到视口外）");
const listStart = css.indexOf(".caldav-month-pop-list {");
assert.ok(listStart >= 0, "CSS 里找不到 .caldav-month-pop-list");
const listBlock = css.slice(listStart, listStart + 300);
assert.ok(/overflow-y: auto/.test(listBlock), "浮层列表应可滚动（条目多时头部不跟着走）");
assert.ok(/min-height: 0/.test(listBlock), "可滚动容器必须配 min-height: 0，否则撑破 flex 上限");

/* ---------- ④ 两端关键常量必须一致（防跨端静默漂移）---------- */
const siyuanPop = readSiyuan("src/ui/month-day-popup.ts");
const siyuanMonth = readSiyuan("src/ui/view-month.ts");

const grabNum = (src, re) => {
  const m = re.exec(src);
  assert.ok(m, `源码里找不到：${re}`);
  return m[1];
};
const gapOf = (src) => Number(grabNum(src, /const GAP = (\d+);/));
const delayOf = (src) => Number(grabNum(src, /const CLOSE_DELAY = (\d+);/));

assert.strictEqual(
  gapOf(pop),
  gapOf(siyuanPop),
  `两端 GAP 应一致（Obsidian=${gapOf(pop)} / 思源=${gapOf(siyuanPop)}）`
);
assert.strictEqual(
  delayOf(pop),
  delayOf(siyuanPop),
  `两端收起延迟应一致（Obsidian=${delayOf(pop)}ms / 思源=${delayOf(siyuanPop)}ms）`
);
// 锚点口径一致：两端都直接把 cell 当锚点传
assert.ok(
  /openMonthDayPopup\(ctx, day, list, cell, /.test(siyuanMonth),
  "思源侧锚点也应是 cell（两端口径必须一致）"
);

/* ---------- ⑤ 主题变量名是两端最容易抄错的地方 ---------- */
// Obsidian 用 --interactive-accent / --background-primary…，与思源的 --b3-theme-* 完全不同
assert.ok(
  popBlock.includes("--interactive-accent") || popBlock.includes("--background-primary"),
  "Obsidian 侧浮层应映射 Obsidian 的主题变量（--interactive-accent/--background-primary…），别抄思源的 --b3-theme-*"
);
assert.ok(
  !popBlock.includes("--b3-theme-"),
  "Obsidian 侧浮层不该出现思源的 --b3-theme-* 变量（抄过来会全部取不到值）"
);

/* ---------- ⑥ 社区审核红线：新文件不许用 innerHTML ----------
 * 审核明确点名 innerHTML（会连带丢弃已绑定的监听），项目用 dom.ts 的 setHtml 替代。
 * 本轮移植时就在浮层里写了一次 `pop.innerHTML =` —— 已有既定工具却没用上，
 * 所以在这里钉死，别指望下次记得。
 *
 * ⚠️ 判据必须**剥掉注释**：否则本说明与代码注释里出现的 `pop.innerHTML =`
 *    会被自己匹配上（踩过一次：加了断言后立刻自己红）。
 */
const popCode = pop.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
assert.ok(
  !/\.innerHTML\s*=/.test(popCode),
  "浮层不许用 innerHTML（社区审核红线）：请用 dom.ts 的 setHtml()"
);
assert.ok(
  /from "\.\/dom"/.test(popCode) && /setHtml\(\s*pop/.test(popCode),
  "浮层应通过 dom.ts 的 setHtml() 插入 DOM"
);

/* ---------- ⑦ 浮层文案必须走 i18n ----------
 * 本项目有 en_US，硬编码中文会让英文用户看到「10月4日」这种字样。
 * 移植时最容易漏的就是这一条（思源侧无 i18n，抄过去时容易保留硬编码）。 */
assert.ok(
  /t\("cal\.dayPopupTitle"/.test(pop) && /t\("cal\.dayPopupCount"/.test(pop),
  "浮层标题与计数必须走 i18n（硬编码中文会让英文用户看到中文）"
);
const zh = JSON.parse(read("src/i18n/zh_CN.json"));
const en = JSON.parse(read("src/i18n/en_US.json"));
for (const key of ["cal.dayPopupTitle", "cal.dayPopupCount"]) {
  assert.ok(zh[key], `zh_CN.json 缺 ${key}`);
  assert.ok(en[key], `en_US.json 缺 ${key}（中英必须齐备）`);
}

console.log(
  "[month-popup] 月视图浮层通过（只由悬停触发 / 保持区=触发格 / data-more 判定 / " +
    `GAP=${gapOf(pop)} / 延迟=${delayOf(pop)}ms 与思源一致 / body 级浮层自带变量映射 / 主题变量名未抄错）`
);