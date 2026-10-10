/**
 * 回归测试：任务视图工具栏的「快速添加 + 搜索」两框。
 *
 * 2026-10-09 雄哥要求（思源 + Obsidian 同步）：
 *   ① 左侧 Dock 里的搜索框**去掉**（它只显示少量条目，在那儿搜等于
 *      「搜一个看不见全貌的列表」，搜到了也看不到全貌）；
 *   ② 把快速添加框截成两段：**2/3 给快速添加、1/3 给搜索**。
 *
 * 两处风险都不是「视觉」而是「行为」：
 *   - 搜索框若整体重渲染 viewEl，输入框连同用户刚敲的字一起被换掉，
 *     表现为「每打一个字符框就清空一次」，输入根本打不完；
 *   - 搜索词若只放局部变量，重渲染后即丢失（同上）。
 * 所以下面用源码断言把「只重渲染列表」与「搜索词存 dataset」钉死，
 * 纯函数部分（匹配口径）则直接跑编译后的模块验证。
 *
 * 用法：node test/task-search.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

/** 取函数体的内容（按花括号配平，从第一个 `{` 起） */
function fnBody(src) {
  const start = src.indexOf("{");
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(0, i);
    }
  }
  return src;
}

// ══════════════════════════════════════════════════════════════
// ① 纯函数层：直接跑编译后的 matchesSearchQuery
// ══════════════════════════════════════════════════════════════
const OUT = path.join(ROOT, ".test-task-search");
fs.rmSync(OUT, { recursive: true, force: true });
require(path.join(ROOT, "node_modules", "esbuild")).buildSync({
  entryPoints: [path.join(ROOT, "src/ui/view-common.ts")],
  bundle: true,
  format: "cjs",
  outfile: path.join(OUT, "view-common.cjs"),
  external: ["obsidian"],
  logLevel: "error"
});
const Module = require("module");
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  // view-common 会 import PanelCtx 类型（编译后已擦除）与 types；这里只提供 normalizePath
  if (req === "obsidian") return { normalizePath: (p) => String(p).replace(/\\/g, "/").replace(/\/{2,}/g, "/") };
  return origLoad.call(this, req, ...rest);
};
const VC = require(path.join(OUT, "view-common.cjs"));

const it = (o = {}) => ({
  uid: "u1",
  kind: "todo",
  calendarUrl: "c",
  href: "c/1.ics",
  summary: "智慧食堂整改",
  allDay: false,
  start: "2026-09-24T09:00:00",
  end: "2026-09-24T09:00:00",
  priority: 0,
  status: "NEEDS-ACTION",
  percent: 0,
  createdAt: "2026-09-24T09:00:00",
  dirty: false,
  ...o
});

let passed = 0;
const ok = (m) => { passed++; console.log("  ✓ " + m); };

{
  const m = VC.matchesSearchQuery;
  assert.ok(typeof m === "function", "view-common 应导出 matchesSearchQuery");
  ok("matchesSearchQuery 已从 view-common 导出（Dock 移除后不再当孤儿函数）");

  // 空关键词一律命中 —— 调用方不必自己先判空
  assert.strictEqual(m(it(), ""), true, "空字符串应判为命中");
  assert.strictEqual(m(it(), "   "), true, "纯空格应判为命中（trim 后为空）");
  ok("空关键词/纯空格一律命中");

  // 四个匹配字段
  assert.strictEqual(m(it(), "食堂"), true, "标题命中");
  assert.strictEqual(m(it({ description: "跟进后勤处" }), "后勤"), true, "备注命中");
  assert.strictEqual(m(it({ location: "三楼" }), "三楼"), true, "地点命中");
  assert.strictEqual(m(it({ categories: ["工程", "安全"] }), "安全"), true, "分类命中");
  ok("标题 / 备注 / 地点 / 分类 四个字段都能匹配");

  // 大小写与首尾空格
  assert.strictEqual(m(it({ summary: "Warehouse Audit" }), "  audit  "), true,
    "应大小写不敏感且忽略首尾空格");
  assert.strictEqual(m(it(), "不存在的词"), false, "不匹配应判 false");
  ok("大小写不敏感 + 首尾空格被 trim");

  // ⚠️ 边界：summary 可能为空串，调用 `.includes` 前必须兜住
  assert.strictEqual(m(it({ summary: "" }), "x"), false, "summary 为空串不应抛异常");
  assert.strictEqual(m(it({ summary: "", description: "", location: "", categories: [] }), "x"), false,
    "四个字段全空时不应抛异常");
  assert.strictEqual(m(it({ summary: undefined }), "x"), false, "summary 为 undefined 不应抛异常");
  ok("空 summary / 全空字段 / undefined 均不抛（原先 it.summary.toLowerCase() 会炸）");
}

// ══════════════════════════════════════════════════════════════
// ② 源码契约层：Dock 无搜索框、两框并排、搜索行为正确
// ══════════════════════════════════════════════════════════════
{
  const panel = read("src/ui/panel.ts");
  const panelCode = stripComments(panel);
  const viewTask = read("src/ui/view-task.ts");
  const css = read("src/styles.css");

  /* ── Dock 里的搜索框必须彻底没了 ── */
  assert.ok(!/data-dock="search"/.test(panel), "Dock 不该再有 data-dock=\"search\" 的输入框");
  assert.ok(!/caldav-dock-search/.test(panelCode), "panel.ts 不该再引用 .caldav-dock-search* 类");
  assert.ok(!/caldav-dock-search/.test(css), "CSS 不该再有 .caldav-dock-search* 规则（留着就是死样式）");
  assert.ok(!/dockSearch/.test(panelCode), "panel.ts 不该再有 dockSearch 状态");
  assert.ok(!/onRootInput/.test(panelCode), "Dock 搜索框专属的 input 监听应随之删除");
  // 也不该再有「搜索框专属」的孤儿匹配函数
  assert.ok(!/function matchesDockSearch/.test(panelCode),
    "panel.ts 里的 matchesDockSearch 已挪到 view-common，不该留成孤儿函数");
  ok("Dock 搜索框已彻底移除（DOM / CSS / 状态 / 事件 / 孤儿函数 五处都清干净）");

  /* ── filterbar 里两框并排，顺序：下拉 → 快速添加 → 搜索 ── */
  // ⚠️ 切片边界不能拿 `cal-task-list` 定位：那个类名在别处（CSS 说明注释、
  // 「外层 .cal-task-list 由模板提供」那段注释里）也出现，indexOf 会命中
  // filterbar **之前**的位置，切出空串或半截。这类"用字符串定位模板片段"的
  // 断言要认准唯一锚点—— 这里用 data-task-search 再回溯到 filterbar 的开标签。
  const iSearchAttr = viewTask.indexOf("data-task-search");
  const iBarOpen = viewTask.lastIndexOf('class="cal-task-filterbar"', iSearchAttr);
  const barEnd = viewTask.indexOf("</div>", viewTask.indexOf("</div>", viewTask.indexOf("</div>", iSearchAttr) + 1) + 1);
  assert.ok(iBarOpen >= 0 && iSearchAttr > iBarOpen && barEnd > iSearchAttr,
    "定位 filterbar 模板片段失败");
  const bar = viewTask.slice(iBarOpen, barEnd);
  const iFilter = bar.indexOf("data-filter");
  const iQuick = bar.indexOf("data-quickadd");
  const iSearch = bar.indexOf("data-task-search");
  assert.ok(iFilter >= 0 && iQuick >= 0 && iSearch >= 0,
    "filterbar 里应同时有筛选下拉、快速添加框与搜索框");
  assert.ok(iFilter < iQuick && iQuick < iSearch,
    `顺序应为 下拉 → 快速添加 → 搜索，实际 ${iFilter}/${iQuick}/${iSearch}`);
  ok("filterbar 三元素顺序正确：下拉 → 快速添加 → 搜索");

  // 搜索框必须有放大镜 + 占位符 + 回填 value（否则重渲染后词丢失）
  assert.ok(/cal-task-search-icon/.test(bar) && /icons\.search/.test(bar), "搜索框应带放大镜图标");
  assert.ok(/placeholder=/.test(bar) && /data-task-search/.test(bar), "搜索框应有占位提示");
  assert.ok(/value="\$\{escape\(searchQuery\(\)\)\}"/.test(bar),
    "搜索框的 value 必须从 searchQuery() 回填（重渲染后要保住用户输入）");
  ok("搜索框带图标 + 占位提示 + value 回填");

  /* ── 宽度 2:1 ── */
  assert.ok(/\.cal-task-quick\s*\{[^}]*flex:\s*2 1 0/.test(css),
    "快速添加框应占 2 份（flex: 2 1 0）");
  assert.ok(/\.cal-task-searchwrap\s*\{[^}]*flex:\s*1 1 0/.test(css),
    "搜索框应占 1 份（flex: 1 1 0）—— 包裹层承担 flex，input 本身不能设");
  assert.ok(/\.cal-task-filterbar\s*\{[^}]*align-items:\s*center/.test(css),
    "filterbar 需要 align-items: center（包裹层是两级嵌套，顶对齐会错位）");
  // min-width:0 是 flex 必备 —— 否则长内容会把框撑破 2:1
  assert.ok(/\.cal-task-quick\s*\{[^}]*min-width:\s*0/.test(css) &&
    /\.cal-task-searchwrap\s*\{[^}]*min-width:\s*0/.test(css),
    "两个框都要 min-width: 0，否则 flex 子项不肯收缩、2:1 会被内容撑破");
  ok("宽度按 2:1 分配，且补齐 align-items / min-width");

  /* ── 搜索行为：只重渲染列表、绝不整体重渲染 ── */
  const searchBind = viewTask.slice(viewTask.indexOf('addEventListener("input"'));
  const bindEnd = searchBind.indexOf("});");
  const bind = searchBind.slice(0, bindEnd > 0 ? bindEnd : 400);
  assert.ok(/setSearchQuery\(searchInput\.value\)/.test(bind), "输入时应把值写进 searchQuery");
  assert.ok(/\.cal-task-list/.test(bind), "输入时必须重渲染 .cal-task-list");
  assert.ok(/listHtml\(curFilter\(\)\)/.test(bind),
    "输入时要用 curFilter() 现读筛选，不能用渲染那一刻的 current 常量");
  assert.ok(!/viewEl\.innerHTML\s*=/.test(bind),
    "⚠️ 输入时绝不能重渲染 viewEl 整体 —— 会把输入框连同用户刚敲的字一起换掉，" +
    "表现为「每打一个字符框就清空一次」，输入根本打不完");
  ok("搜索只重渲染列表、不动输入框，且用现读筛选");

  /* ── 搜索词存 dataset（跨重渲染存活） ── */
  assert.ok(/function searchQuery\(\)[\s\S]*?viewEl\.dataset\.taskQuery/.test(viewTask),
    "搜索词应从 viewEl.dataset.taskQuery 读");
  assert.ok(/function setSearchQuery\(q: string\)[\s\S]*?viewEl\.dataset\.taskQuery\s*=\s*q/.test(viewTask),
    "setSearchQuery 应写入 dataset");
  assert.ok(/delete viewEl\.dataset\.taskQuery/.test(viewTask),
    "清空时要 delete 而不是写空串（否则 dataset 里留着空串，isCollapsed 式的「未设置」判断会失效）");
  ok("搜索词存 dataset.taskQuery，清空时 delete");

  /* ── 搜索必须排在筛选之后 ── */
  const listBody = fnBody(viewTask.slice(viewTask.indexOf("function listHtml")));
  assert.ok(/todos\.filter\(f\.match\)\.filter\(\s*\(row\)\s*=>\s*matchesSearchQuery/.test(listBody),
    "搜索必须接在筛选之后（顺序反了会让下拉里的 (N) 计数与列表对不上）");
  assert.ok(/row\.it/.test(listBody),
    "匹配要传 row.it —— list 里是 Row 包装（{ it, due, isEvent }）不是裸 CalItem");
  ok("搜索接在筛选之后，且正确取 row.it");

  /* ── 空态要区分「筛选没东西」与「被搜索过滤光了」 ── */
  assert.ok(/taskSearchNoMatch|task\.searchPlaceholder/.test(viewTask),
    "被搜索过滤光时应给「没有匹配…的任务」而不是笼统的「无结果」");
  ok("空态区分「筛选为空」与「搜索无匹配」");

  /* ── ★ 0.4.8 修复的三个回归（2026-10-10 雄哥实测） ── */

  // ① 折叠重渲染不许用 current 常量：切到「所有项目」后点组头，
  //    列表会按旧筛选（所有未完成）重滤 → 已完成条目全没 → 空组不渲染组头
  //    →「点一下已完成组就消失」。初始模板那处 ${listHtml(current)} 是对的
  //    （渲染那一刻它就等于 dataset），只有 setHtml/innerHTML 重渲染必须现读。
  assert.ok(!/setHtml\(list,\s*listHtml\(current\)\)/.test(viewTask),
    "折叠/键盘重渲染不许用 listHtml(current) —— 必须现读 curFilter()" +
    "（否则切筛选后点组头，列表退回旧筛选，已完成组「一点就消失」）");
  assert.ok(!/list\.innerHTML\s*=\s*listHtml\(current\)/.test(viewTask),
    "同上（innerHTML 写法）");
  const curUses = [...viewTask.matchAll(/listHtml\(curFilter\(\)\)/g)].length;
  assert.ok(curUses >= 3, `折叠 click/keydown 与搜索输入三处都应现读 curFilter()，实际只有 ${curUses} 处`);
  ok("折叠重渲染一律现读 curFilter()（已完成组「一点就消失」的修复）");

  // ② 放大镜不压字：padding-left 必须双类提特异性。
  //    .caldav-input 的 padding 简写在本文件更后面，同特异性下后写者赢，
  //    单类 .cal-task-search 的 padding-left 会被整体覆盖 → 图标压在占位文字上。
  assert.ok(/\.caldav-input\.cal-task-search\s*\{[^}]*padding-left:\s*30px/.test(css),
    "padding-left: 30px 必须写在 .caldav-input.cal-task-search 双类上" +
    "（单类会被后面 .caldav-input 的 padding 简写覆盖，放大镜压字）");
  // ⚠️ 先剥掉双类规则再测负向：`.caldav-input.cal-task-search` 本身包含
  // 子串 `.cal-task-search`，不剥的话这条负向断言会被刚写的正解误命中。
  const cssWithoutDual = css.replace(/\.caldav-input\.cal-task-search/g, "");
  assert.ok(!/\.cal-task-search\s*\{[^}]*padding-left/.test(cssWithoutDual),
    "不许再留单类 .cal-task-search 的 padding-left（会被覆盖，等于没写）");
  ok("放大镜 padding-left 走双类特异性（不再被 .caldav-input 覆盖）");

  // ③ 占位文案
  const zh = JSON.parse(read("src/i18n/zh_CN.json"));
  assert.strictEqual(zh["task.searchPlaceholder"], "搜索...",
    "中文占位应为「搜索...」（雄哥指定）");
  ok("占位文案 =「搜索...」");
}

console.log(`\n✓ 任务视图搜索测试通过（${passed} 组断言）`);
console.log("  - Dock 搜索框已移除，匹配函数上移到 view-common 复用");
console.log("  - filterbar 三列：下拉 → 快速添加(2份) → 搜索(1份)");
console.log("  - 输入只重渲染列表，输入框不丢焦点/内容");
console.log("  - 搜索词存 dataset，跨重渲染存活；空态区分两种「空」");

// 清理编译产物：不留 .test-task-search/ 残渣（已被 .gitignore 兜住，
// 但本地攒久了还是垃圾，且会被误当成有意义的目录）
fs.rmSync(OUT, { recursive: true, force: true });
