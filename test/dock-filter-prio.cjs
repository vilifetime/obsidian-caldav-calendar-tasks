/**
 * 回归测试：Dock 筛选弹层的优先级 + 分类两段筛选（2026-10-08 新增）。
 *
 * 为什么要测：优先级筛选是**过滤链上的一环**，与分类筛选 AND 关系。
 * 这类改动 tsc 抓不到、eslint 抓不到、社区扫描也抓不到 ——
 * 漏挂一个 `.filter()` 的症状是「界面显示筛了、列表没筛」或反之，
 * 而且**只在特定档位组合下才显形**（如筛「低」时未设优先级的条目算不算命中）。
 *
 * 用法：node test/dock-filter-prio.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// ── 复刻 panel.ts 的档位与判定 ──

/** prioMeta 的分档：p<=2 紧急 / p<=4 高 / p<=6 中 / 其余低 */
function tierOf(p) {
  if (p <= 2) return "urgent";
  if (p <= 4) return "high";
  if (p <= 6) return "mid";
  return "low";
}

/**
 * PRIO_TIERS 用每档的代表值（2/4/6/9）反推 —— 与源码同构。
 * 关键：**代表值取该档上界**，这样 matchesDockPriorityFilter 才能用
 * 简单的 includes() 精确命中。若改成「按优先级归到哪档就用哪个代表值」，
 * p=1 的条目就匹配不到任何档（它属于紧急档但不等于代表值 2）。
 */
const PRIO_TIERS = [2, 4, 6, 9];

/** 未设优先级 → 视为最低档 9（与 dockSort 的 `it.priority > 0 ? it.priority : 9` 一致） */
function effPriority(it) {
  return it.priority && it.priority > 0 ? it.priority : 9;
}

/**
 * 按**档位**判定，不能用 filter.includes(priority) ——
 * priority 是 1~9 连续取值，筛选是 4 档，用 includes 时 p=1 在选「紧急」会被漏掉。
 * （首版就是这么写的，被本用例第 2 组第一个断言当场揪出来。）
 */
function matchesDockPriorityFilter(it, filter) {
  if (!filter.length) return true;
  const tier = tierOf(effPriority(it));
  return filter.some((rep) => tierOf(rep) === tier);
}

function matchesDockCategoryFilter(it, filter) {
  if (!filter.length) return true;
  const hasNone = filter.includes("__none__");
  const cats = filter.filter((f) => f !== "__none__");
  const itemCats = it.categories || [];
  if (hasNone && itemCats.length === 0) return true;
  if (cats.length && itemCats.some((c) => cats.includes(c))) return true;
  return false;
}

// ── 用例 ──
const items = [
  { id: "a", priority: 1, categories: ["工作"] },   // 紧急 + 有分类
  { id: "b", priority: 3, categories: [] },          // 高 + 无分类
  { id: "c", priority: 5, categories: ["学习"] },   // 中
  { id: "d", priority: 9, categories: ["生活"] },   // 低
  { id: "e", priority: undefined, categories: [] },  // 未设优先级 + 无分类
];

const byId = (arr) => arr.map((x) => x.id);
const apply = (it, prio, cats) =>
  byId(items.filter((x) => matchesDockPriorityFilter(x, prio) && matchesDockCategoryFilter(x, cats)));

// 1. 空筛选 = 全放行（默认态）
assert.deepStrictEqual(apply(items, [], []), ["a", "b", "c", "d", "e"], "两个筛选都为空时不过滤");

// 2. 只筛优先级
assert.deepStrictEqual(apply(items, [2], []), ["a"], "紧急档只命中 p=1（代表值 2 档）");
assert.deepStrictEqual(apply(items, [4], []), ["b"], "高档只命中 p=3");
assert.deepStrictEqual(apply(items, [6], []), ["c"], "中档只命中 p=5");
assert.deepStrictEqual(apply(items, [9], []), ["d", "e"], "低档含未设优先级的条目（视为 9）");

// 3. 只筛分类
assert.deepStrictEqual(apply(items, [], ["工作"]), ["a"], "按分类名筛");
assert.deepStrictEqual(apply(items, [], ["__none__"]), ["b", "e"], "无分类档");

// 4. 两段 AND 关系
assert.deepStrictEqual(apply(items, [2], ["工作"]), ["a"], "紧急 + 工作");
assert.deepStrictEqual(apply(items, [9], ["__none__"]), ["e"], "低优先 + 无分类（未设优先级也算低）");
assert.deepStrictEqual(apply(items, [2], ["生活"]), [], "AND 无交集时为空（不是「取并集」）");

// 5. 档位与 prioMeta 一致性：每个代表值必须落在自己那一档
for (const v of PRIO_TIERS) {
  assert.ok(v >= 1 && v <= 9, `代表值 ${v} 越界`);
}
// 四档恰好覆盖 1..9 的全部取值 —— 漏一档就会有条目匹配不到任何筛选
const covered = [];
for (let p = 1; p <= 9; p += 1) {
  const tier = tierOf(p);
  const rep = PRIO_TIERS.find((v) => tierOf(v) === tier);
  assert.ok(rep !== undefined, `p=${p} 所属档 ${tier} 没有代表值`);
  covered.push(rep);
}
assert.strictEqual(new Set(covered).size, 4, "四档代表值互不重复");

// 6. 源码层面的钉子：优先级筛选必须挂在**两处**过滤链上
//    （列表本体 + 无日期条目计数）。漏一处 → 计数与列表自相矛盾。
{
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel.ts"), "utf8");
  const calls = (src.match(/matchesDockPriorityFilter\(it, dockPriorityFilter\)/g) || []).length;
  assert.strictEqual(calls, 2, `优先级过滤应挂在 2 处过滤链上，实际 ${calls} 处`);
  // 确认按钮必须同时提交两段
  assert.ok(
    /dockCategoryFilter = pendingCategoryFilter;[\s\S]{0,80}dockPriorityFilter = pendingPriorityFilter;/.test(src),
    "确认按钮必须同时提交分类与优先级两段筛选",
  );
  // 弹层必须有优先级段落
  assert.ok(src.includes("data-prio-list"), "弹层缺少优先级列表挂载点");
  assert.ok(src.includes('data-prio-key'), "优先级项缺少 data-prio-key");
}

console.log("  [PASS] 优先级+分类两段筛选：默认态 / 单段 / AND 组合 / 档位全覆盖");
console.log("  [PASS] 两处过滤链都挂了优先级筛选，且确认按钮同提交两段");
console.log("✓ Dock 筛选回归测试通过");