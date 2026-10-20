/**
 * 回归测试：周/日视图色块高度算法（2026-10-20 从思源侧 wk-todo-block.test.mjs 同构移植）
 *
 * 背景（思源侧 2026-10-19 雄哥截图三连报，Obsidian 侧同批移植）：
 *  ① 待办没有「时段」——occ 取到期日（DUE），算出来恒 0 分钟，只靠事件地板兜底，
 *     文字溢出成一小条（「行高太小」）；
 *  ② 跨午夜日程（23:00→次日 00:00）只取 end 时分 → 解析成 0 分钟，被压成 15 分钟；
 *  ③ 重复条目 it.end 属于首个实例，天数差为负 → 同样被压成 15 分钟。
 * 终版算法：事件按「开始 + 原时长」算结束分钟（原时长平移到当前 occ）；待办走
 * 「occ 自己的时分 + 1 小时 floorMin 保底」；地板一律按**绝对分钟**换算（Obsidian
 * 侧原先是 4% ≈ 42px ≈ 57 分钟，所有短事件都被撑超真实时段）；保底后贴底收口
 * （top+height ≤ 100%，防 23:30 到期的待办块底越出 24:00 网格线）。
 *
 * ⚠️ Obsidian 侧无 DOM 布局环境，量不了真实像素——这里守**源码级形状与两端
 * 常量一致**；几何真验靠真机（用户移植后目验）。思源侧对应测试是
 * test/wk-todo-block.test.mjs（jsdom + 行内样式百分比换算），两端分工：
 * 思源守 Observable 几何，本文件守跨端移植不漂移。
 *
 * 用法：node test/wk-block-height.cjs
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

const wk = read("src/ui/view-week.ts");
const css = read("src/styles.css");
const wkSy = readSiyuan("src/ui/view-week.ts");
const cssSy = readSiyuan("src/index.css");

// ---------- ① 块高算法 ----------
console.log("[wk-block-height] 块高算法");

t("地板按绝对分钟换算（todo 60 / event 15），不再写 4% 百分比", () => {
  assert.ok(
    /const floorMin = b\.it\.kind === "todo" \? 60 : 15;/.test(wk),
    "floorMin 60/15 两档缺失"
  );
  assert.ok(
    /let height = Math\.max\(\(\(b\.endMin - b\.startMin\) \/ 1440\) \* 100, \(floorMin \/ 1440\) \* 100\);/.test(wk),
    "地板没有按 (floorMin/1440)*100 绝对换算"
  );
  // 旧病根：4% ≈ 42px ≈ 57 分钟，把 42 分钟以内的事件全撑超真实时段
  assert.ok(
    !/Math\.max\(\(\(b\.endMin - b\.startMin\) \/ 1440\) \* 100,\s*4\)/.test(wk),
    "又回到 4% 百分比地板 —— 短事件会被撑到 42px"
  );
});

t("贴底收口：保底后块底不得越出 24:00 网格线", () => {
  assert.ok(
    /if \(top \+ height > 100\) height = Math\.max\(100 - top, \(15 \/ 1440\) \* 100\);/.test(wk),
    "缺少贴底收口 —— 23:30 到期的待办（1 小时保底）块底越出网格线约 21px"
  );
});

t("事件结束分钟按「开始 + 原时长」，绝不直接取 end 的时分", () => {
  // 跨午夜（23:00→次日 00:00）与重复条目（it.end 属于首个实例）一锅端
  assert.ok(
    /const durMs = it\.start && it\.end \? parseLocalStamp\(it\.end\)\.getTime\(\) - parseLocalStamp\(it\.start\)\.getTime\(\) : 0;/.test(wk),
    "durMs 计算缺失"
  );
  assert.ok(
    /const durMin = Number\.isFinite\(durMs\) && durMs > 0 \? Math\.round\(durMs \/ 60000\) : 15;/.test(wk),
    "durMin 兜底 15 缺失"
  );
  assert.ok(/endMin = startMin \+ durMin;/.test(wk), "事件分支没有按 startMin + durMin 收口");
  // 事件分支里不允许再出现「取 end 时分」的旧写法
  const eventBranch = wk.slice(wk.indexOf("} else {"), wk.indexOf("blocks.push"));
  assert.ok(
    !/timeRe\.exec\(it\.end/.test(eventBranch),
    "事件分支又在直接取 it.end 的时分 —— 跨午夜/重复条目会被压成 15 分钟"
  );
});

t("待办分支保持「occ 自己的时分 + 15 分钟下限」", () => {
  assert.ok(
    /endMin = Math\.max\(startMin \+ 15, endMatch \? \+endMatch\[1\] \* 60 \+ \+endMatch\[2\] : startMin \+ 60\);/.test(wk),
    "待办分支公式被改坏"
  );
});

// ---------- ② 文字行数分档 ----------
console.log("[wk-block-height] 高度分档");

t("tierClassOf 存在且阈值 34/54，与 styles.css 说明一致", () => {
  assert.ok(/const TIER_XS_MAX = 34;/.test(wk), "TIER_XS_MAX 缺失或不是 34");
  assert.ok(/const TIER_S_MAX = 54;/.test(wk), "TIER_S_MAX 缺失或不是 54");
  assert.ok(
    /function tierClassOf\(heightPct: number\): string \{[\s\S]{0,300}?wk-h-xs[\s\S]{0,120}?wk-h-s/.test(wk),
    "tierClassOf 形状不对"
  );
  // CSS 侧必须有对应规则，且注释里的阈值数字与 TS 一致（改一处忘另一处是跨端漂移重灾区）
  assert.ok(/\.cal-wk-block\.wk-h-xs \.cal-wk-block-time,\s*\n\s*\.cal-wk-block\.wk-h-xs \.cal-wk-block-loc \{ display: none; \}/.test(css), "wk-h-xs 隐藏时间/地点规则缺失");
  assert.ok(/\.cal-wk-block\.wk-h-s \.cal-wk-block-loc \{ display: none; \}/.test(css), "wk-h-s 隐藏地点规则缺失");
  assert.ok(/\.cal-wk-block\.wk-h-xs \{ display: flex; flex-direction: column; justify-content: center; \}/.test(css), "wk-h-xs 垂直居中规则缺失");
  const cssComment = css.slice(css.indexOf("高度分档"), css.indexOf("高度分档") + 700);
  assert.ok(cssComment.includes("34"), "CSS 注释里没有 34px 阈值说明");
  assert.ok(cssComment.includes("54"), "CSS 注释里没有 54px 阈值说明");
});

t("块 class 挂上档位（tierClassOf(height)）", () => {
  assert.ok(
    /cal-wk-block \$\{b\.it\.kind === "todo" \? "cal-wk-block-todo" : ""\} \$\{done \? "is-done" : ""\}\$\{tierClassOf\(height\)\}/.test(wk),
    "块 class 没有挂 tierClassOf —— 分档规则永远不会命中"
  );
});

// ---------- ③ box-sizing ----------
console.log("[wk-block-height] box-sizing");

t(".cal-wk-block 显式 border-box（无全局 reset，padding 会撑高 4px）", () => {
  const rule = css.slice(css.indexOf(".cal-wk-block {"), css.indexOf(".cal-wk-block:hover"));
  assert.ok(/box-sizing: border-box;/.test(rule), ".cal-wk-block 缺 box-sizing —— top/height 百分比不含 padding，色块比声明时段高 4px");
  // 防回归：确认真没有全局 reset 兜底（有的话这条断言的前提要复核）
  assert.ok(!/^\s*\*\s*,\s*$[\s\S]{0,80}box-sizing: border-box/m.test(css), "出现了全局 border-box reset —— 本断言的前提需要复核");
});

// ---------- ④ 两端同构 ----------
console.log("[wk-block-height] 与思源侧同构");

t("思源侧关键常量与算法一致（floorMin/收口/durMs/档位阈值）", () => {
  assert.ok(/const floorMin = b\.it\.kind === "todo" \? 60 : 15;/.test(wkSy), "思源侧 floorMin 变了");
  assert.ok(/if \(top \+ height > 100\) height = Math\.max\(100 - top, \(15 \/ 1440\) \* 100\);/.test(wkSy), "思源侧收口变了");
  assert.ok(/const durMin = Number\.isFinite\(durMs\) && durMs > 0 \? Math\.round\(durMs \/ 60000\) : 15;/.test(wkSy), "思源侧 durMin 变了");
  assert.ok(/const TIER_XS_MAX = 34;/.test(wkSy) && /const TIER_S_MAX = 54;/.test(wkSy), "思源侧档位阈值变了");
  assert.ok(/\.cal-wk-block\.wk-h-s \.cal-wk-block-loc \{ display: none; \}/.test(cssSy), "思源侧档位 CSS 变了");
});

console.log(`\n[wk-block-height] ${passed} 项通过`);
if (process.exitCode) console.error("存在失败项");
