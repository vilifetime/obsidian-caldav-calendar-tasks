/**
 * 回归测试：Dock 三态判断与详情模式的关系。
 *
 * 真实故障（2026-10-06，雄哥实测反馈）：右侧栏显示**条目详情**时，
 * 右击日历格子切不到「所有未完成」，界面看起来毫无反应。
 *
 * 根因：Dock 的 `isDefaultState()` 原先是
 *     focusDate === null && dockFilter === "undone"
 * **完全没考虑 `detailKey`**。而进入详情时只设detailKey，focusDate /
 * dockFilter 都不动 —— 于是在详情模式下这个判断仍返回 true，
 * toggleDock 走了「切到该格子所在月」分支，**但** `renderDockList()`
 * 因 detailKey 非空仍渲染详情卡，净效果是：状态变了、界面没变。
 *
 * 这个 bug tsc / eslint 全部抓不到（类型完全合法），只能靠实测发现。
 * 故用本测试把「详情态的优先级」钉死。
 *
 * 用法：node test/dock-toggle.cjs
 */
const assert = require("assert");

/** 与 panel.ts 的 isDefaultState 保持一致（当前修复后的版本） */
const isDefaultState = (s) => s.focusDate === null && s.dockFilter === "undone" && s.detailKey === null;
const isScopedState = (s) => s.focusDate !== null;
// ⚠️ 用 `!= null`（同时匹配 null 与 undefined）而非 `!== null`：
// 状态对象缺 detailKey 键时它是 undefined，而 `undefined !== null` 为 true，
// 会让「默认态」被误判成「详情态」。写这个测试时就被它坑了一次。
const isDetailState = (s) => s.detailKey != null;

/**
 * 复刻 main.ts 的 toggleDock 判断链（只看分支选择，不涉及 DOM）。
 * 返回该走的分支名。
 */
function branchOf(viewMode, s) {
  if (isDetailState(s)) return "exit-detail";
  if (isDefaultState(s)) return "scope";
  if (isScopedState(s) || viewMode === "day") return "collapse";
  return "all-undone";
}

const DONE = { focusDate: null, dockFilter: "undone", detailKey: null };

const cases = [
  // ── 这次修的主场景 ──
  ["详情模式 + 年视图", { viewMode: "year", state: { ...DONE, detailKey: "k1" } }, "exit-detail"],
  ["详情模式 + 月视图", { viewMode: "month", state: { ...DONE, detailKey: "k1" } }, "exit-detail"],
  ["详情模式 + 任务视图", { viewMode: "task", state: { ...DONE, detailKey: "k1" } }, "exit-detail"],
  // 详情 + 已聚焦某日（detailKey 与 focusDate 同时非空）
  ["详情模式 + 已聚焦某日", { viewMode: "month", state: { focusDate: "2026-10-08", dockFilter: "undone", detailKey: "k1" } }, "exit-detail"],

  // ── 回归：非详情态的三态循环不能被带偏 ──
  ["默认态 + 月视图→ 切该月", { viewMode: "month", state: { ...DONE } }, "scope"],
  ["默认态 + 周视图 → 切该周", { viewMode: "week", state: { ...DONE } }, "scope"],
  ["已聚焦某月 + 月视图 → 收起", { viewMode: "month", state: { focusDate: "2026-10-01", dockFilter: "undone", detailKey: null } }, "collapse"],
  ["已聚焦某日 + 日视图 → 收起", { viewMode: "day", state: { focusDate: "2026-10-08", dockFilter: "undone", detailKey: null } }, "collapse"],
  ["预设筛选 → 回所有未完成", { viewMode: "month", state: { focusDate: null, dockFilter: "nodate", detailKey: null } }, "all-undone"],
];

let failed = 0;
for (const [name, input, expected] of cases) {
  const got = branchOf(input.viewMode, input.state);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name.padEnd(26)} → ${got}（期望 ${expected}）`);
}

// 显式钉住这次的故障组合
assert.strictEqual(
  branchOf("year", { focusDate: null, dockFilter: "undone", detailKey: "k1" }),
  "exit-detail",
  "详情模式下必须先退出详情，不能切月（否则界面无反应）—— 这正是 2026-10-06 的故障"
);
// 且详情态下 isDefaultState 必须为 false，否则又会漏进「切月」分支
assert.strictEqual(
  isDefaultState({ focusDate: null, dockFilter: "undone", detailKey: "k1" }),
  false,
  "详情态下 isDefaultState() 必须返回 false"
);

console.log(failed === 0 ? "\n✓ Dock 三态回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
