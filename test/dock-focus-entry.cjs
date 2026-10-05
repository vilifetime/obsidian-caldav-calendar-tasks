/**
 * 回归测试：详情态下 Dock 焦点切换是否生效。
 *
 * 真实故障（2026-10-06，雄哥实测反馈，两次）：
 *   ① 右击日历格子切不到「所有未完成」（0.2.1 修了 toggleDock 分支）
 *   ② **单击单元格 / 单击条目没有任何反应**（本次）
 *
 * 根因同源：`renderDockList()` 开头有
 *     if (isDetailState()) { renderItemDetail(); return; }
 * —— 详情态下它**无视 focusDate / dockFilter**。而所有「改变 Dock 焦点」的
 * 入口（onFocusDate / onDockScope / onAllUndone）原先都只改focusDate、
 * dockFilter，从不清detailKey，于是状态变了、界面不动。
 *
 * 关键认知：**任何改变 Dock 焦点/筛选的入口，都必须先退出详情态。**
 * 详情态下用户根本点不到侧栏内部的控件（排序/分类/筛选），所以那些
 * onRootClick 内的分支**不需要**清 —— 区分「主面板驱动」与「侧栏内部驱动」。
 *
 * 用法：node test/dock-focus-entry.cjs
 */
const assert = require("assert");

/** 侧栏状态 */
const fresh = () => ({ focusDate: null, focusScope: "day", dockFilter: "undone", beforeFocusFilter: null, detailKey: null });

/**
 * 复刻 panel.ts 中各入口对状态的作用。关键断言点：`detailKey` 是否被清。
 * 返回 [新的 detailKey, 新的 focusDate]
 */
function applyEntry(entry, s) {
  const n = { ...s };
  switch (entry) {
    case "onFocusDate": // 主面板单击格子 / 单击条目
      n.detailKey = null;
      n.focusDate = "2026-10-08";
      n.focusScope = "day";
      break;
    case "onDockScope": // 主面板右击 → 切该格子所在月/周
      n.detailKey = null;
      n.beforeFocusFilter = n.dockFilter;
      n.focusDate = "2026-10-01";
      n.focusScope = "month";
      break;
    case "onAllUndone": // 切到「所有未完成」
      n.detailKey = null;
      n.focusDate = null;
      n.focusScope = "day";
      n.beforeFocusFilter = null;
      n.dockFilter = "undone";
      break;
    case "onExitDetail": // 详情模式下右击 → 仅退出详情
      n.detailKey = null;
      break;
    case "onItemDetail": // 右击条目 → 进入详情（应保留焦点状态）
      n.detailKey = "k1";
      break;
    default:
      throw new Error("未知入口: " + entry);
  }
  return n;
}

/** renderDockList 会渲染什么 */
function renders(entry, s) {
  const n = applyEntry(entry, s);
  if (n.detailKey != null) return "detail"; // 详情卡
  if (n.focusDate != null) return "list";
  return "list";
}

const DETAIL = { ...fresh(), detailKey: "k1" };

// ── 这三个入口在详情态下必须真的切走（本次修的就是这三个）──
const mustSwitch = [
  ["onFocusDate（单击格子）", "onFocusDate"],
  ["onFocusDate（单击条目，同一入口）", "onFocusDate"],
  ["onDockScope（右击→该月）", "onDockScope"],
  ["onAllUndone（切所有未完成）", "onAllUndone"],
  ["onExitDetail（详情态右击）", "onExitDetail"],
];

let failed = 0;
console.log("  ── 详情态下各入口应切走详情卡 ──");
for (const [name, entry] of mustSwitch) {
  const r = renders(entry, DETAIL);
  const ok = r === "list";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name.padEnd(32)} → 渲染 ${r}（期望 list）`);
}

console.log("");
console.log("  ── 非详情态不应被误清（回归保护）──");
const NOT_DETAIL = { ...fresh() };
for (const entry of ["onFocusDate", "onDockScope", "onAllUndone", "onExitDetail"]) {
  const n = applyEntry(entry, NOT_DETAIL);
  const ok = n.detailKey === null;
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${entry.padEnd(36)} detailKey 保持 null`);
}

// 进入详情不应破坏既有焦点状态
{
  const before = { ...fresh(), focusDate: "2026-10-01", focusScope: "month" };
  const n = applyEntry("onItemDetail", before);
  const ok = n.detailKey === "k1" && n.focusDate === "2026-10-01" && n.focusScope === "month";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 进入详情保留 focusDate/scope${ok ? "" : " → " + JSON.stringify(n)}`);
}

// 显式钉住这次的故障组合
assert.strictEqual(
  renders("onFocusDate", DETAIL),
  "list",
  "详情态下单击日历必须切走详情卡 —— 2026-10-06 的故障②"
);
assert.strictEqual(
  renders("onDockScope", DETAIL),
  "list",
  "详情态下右击切月必须切走详情卡 —— 2026-10-06 的故障①"
);

console.log(failed === 0 ? "\n✓ Dock 焦点入口回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
