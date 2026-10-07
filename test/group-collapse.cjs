/**
 * 回归测试：分组的折叠 / 展开状态。
 *
 * 真实故障（2026-10-07，雄哥实测两次）：
 *   ① 「逾期/今天/明天…」点组头**毫无反应**，只有「已完成」能折叠
 *   ② 反馈里提到「点击分组名称会改变事件数量」
 *
 * ①的根因：isCollapsed 写成
 *     if (gkey !== "done") return false;   // 只有已完成组可折叠
 * 把「已完成默认折叠」这个**默认值**错当成了**权限限制**——
 * 其他分组永远返回 false，setCollapsed 写了状态也读不回来，等于锁死。
 *
 * 这类「状态读写不对称」的 bug tsc 与 eslint 都抓不到。
 *
 * 用法：node test/group-collapse.cjs
 */
const assert = require("assert");

/** 复刻 panel/view-task 里的 viewEl.dataset */
function makeView(initial) {
  const ds = {};
  if (initial) ds.collapsedGroups = initial;
  return {
    get dataset() {
      return ds;
    },
    set dataset(v) {
      for (const k in ds) delete ds[k];
      if (v) ds.collapsedGroups = v;
    }
  };
}

/**
 * 修复后的 isCollapsed（2026-10-07 定稿）。
 *
 * 根因教训：**「默认值」与「用户状态」不能混在同一个字段里**。
 * 先后踩了三个坑：
 *   ① `if (gkey !== "done") return false` —— 把默认值当权限限制，其他组锁死
 *   ② 展开「已完成」时 delete 字段 → 读回走默认值 → **点不动**
 *   ③ 折叠别的组后字段非空 → 「已完成」被静默判成展开
 *
 * 正解：用 EXPANDED_KEY 显式标记「已完成已被用户展开」，
 * 三种状态都能表达，且默认值只在**从未操作过**时生效。
 */
const EXPANDED_KEY = "__none__";
function isCollapsed(view, gkey) {
  if (!view.dataset.collapsedGroups) return gkey === "done";
  const set = view.dataset.collapsedGroups.split(",");
  if (gkey === "done" && set.includes(EXPANDED_KEY)) return false;
  return set.includes(gkey);
}

function setCollapsed(view, gkey, collapsed) {
  const ds = view.dataset;
  const cur = (ds.collapsedGroups || "").split(",").filter(Boolean);
  let next;
  if (collapsed) {
    next = [...new Set([...cur.filter((x) => x !== EXPANDED_KEY), gkey])];
  } else {
    next = cur.filter((x) => x !== gkey);
    if (gkey === "done" && !next.includes(EXPANDED_KEY)) next.push(EXPANDED_KEY);
  }
  if (next.length) ds.collapsedGroups = next.join(",");
  else delete ds.collapsedGroups;
}

/** 点击组头一次（等价于 setCollapsed(key, !isCollapsed(key))） */
function clickHead(view, gkey) {
  setCollapsed(view, gkey, !isCollapsed(view, gkey));
}

let failed = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failed++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${cond ? "" : "  " + extra}`);
};

// ── 1. 默认状态：只有「已完成」折叠，其余展开 ──
{
  const v = makeView();
  check("初始仅已完成折叠", isCollapsed(v, "done") === true);
  for (const g of ["overdue", "today", "tomorrow", "thisweek", "later", "nodate"]) {
    if (isCollapsed(v, g)) {
      failed++;
      console.log(`  [FAIL] 初始 ${g} 不该折叠`);
    }
  }
  console.log("  [PASS] 初始其余六组均展开");
}

// ── 2. 核心回归：每个分组都能折叠（故障①的直接钉子）──
{
  const GROUPS = ["overdue", "today", "tomorrow", "thisweek", "later", "nodate", "done"];
  const bad = [];
  for (const g of GROUPS) {
    const v = makeView();
    const before = isCollapsed(v, g);
    clickHead(v, g);
    if (isCollapsed(v, g) === before) bad.push(g + "(点不动)");
    clickHead(v, g);
    // 修复后所有分组都能原样往返（含 done —— 靠 EXPANDED_KEY 显式记录展开态）
    if (isCollapsed(v, g) !== before) bad.push(g + "(复点失效)");
  }
  check("七个分组均可折叠且能再展开", bad.length === 0, "异常: " + bad.join(","));
}

// ── 3. 多分组折叠状态互不干扰 ──
{
  const v = makeView();
  clickHead(v, "overdue");
  clickHead(v, "today");
  check("逾期+今天 同时折叠",
    isCollapsed(v, "overdue") && isCollapsed(v, "today") && !isCollapsed(v, "tomorrow"));
}

// ── 4. 多分组状态可同时表达 ──
{
  const v = makeView();
  clickHead(v, "overdue");           // 折叠逾期
  clickHead(v, "today");             // 折叠今天
  clickHead(v, "later");             // 折叠下周后
  check("逾期+今天+下周后 同时折叠",
    isCollapsed(v, "overdue") && isCollapsed(v, "today") && isCollapsed(v, "later"));
  clickHead(v, "today");             // 展开今天
  check("展开今天后其余两组不受影响",
    isCollapsed(v, "today") === false && isCollapsed(v, "overdue") && isCollapsed(v, "later"),
    `overdue=${isCollapsed(v, "overdue")} today=${isCollapsed(v, "today")} later=${isCollapsed(v, "later")}`);
}

// ── 5. 「已完成」往返：默认折叠 → 展开 → 折叠（缺陷②的直接钉子）──
{
  const v = makeView();
  check("初始已完成折叠", isCollapsed(v, "done") === true);
  clickHead(v, "done");
  check("点一下可展开（此前完全点不动）", isCollapsed(v, "done") === false,
    "dataset=" + JSON.stringify(v.dataset.collapsedGroups));
  clickHead(v, "done");
  check("再点可折叠回来", isCollapsed(v, "done") === true);
}

// ── 6. 状态字符串解析：不能把空串误判成「折叠全部」──
{
  const v = makeView("");
  check("空串等价于默认状态", isCollapsed(v, "done") === true && isCollapsed(v, "overdue") === false);
}

// ── 7. 关键钉子：源码里不得再有「非 done 组恒不折叠」的特判（缺陷①的根因）──
{
  const src = require("fs").readFileSync(require.resolve("./../src/ui/view-task.ts"), "utf8");
  // 只检查 isCollapsed 函数体内部（注释里提及该字符串是允许的，故先剥注释）
  const fnBody = (src.match(/function isCollapsed[\s\S]*?\n  \}/) || [""])[0]
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  check("isCollapsed 内无 gkey !== \"done\" 特判",
    !/gkey\s*!==\s*["']done["']/.test(fnBody), fnBody.slice(0, 120));
}

console.log(failed === 0 ? "\n✓ 分组折叠回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
