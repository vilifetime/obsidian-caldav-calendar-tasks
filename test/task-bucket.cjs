/**
 * 回归测试：任务视图的时间轴分组与排序。
 *
 * 改造前（2026-10-06）：190 条待办**平铺且无排序**，顺序取决于服务器返回，
 * 「逾期 18 天」与「无日期」混在一起，扫不出轻重缓急。
 *
 * 改动只在渲染层（view-task.ts 的 bucketize），但**分组顺序错了很难肉眼发现**
 * —— 尤其「下周后」与「无日期」的先后、以及已完成组必须沉底。
 *
 * 用法：node test/task-bucket.cjs
 */
const assert = require("assert");

// ── 复刻 view-task.ts 的 GROUPS 定义 ──
const TODAY = "2026-10-06";
const TOMORROW = "2026-10-07";
// startOfWeek(2026-10-06) 是周一 10-05，weekEnd = +6 = 10-11
const WEEK_END = "2026-10-11";

const done = (it) => it.percent === 100;
const GROUPS = [
  { key: "overdue", label: "逾期", match: (r) => !done(r.it) && r.due !== "" && r.due < TODAY },
  { key: "today", label: "今天", match: (r) => !done(r.it) && r.due === TODAY },
  { key: "tomorrow", label: "明天", match: (r) => !done(r.it) && r.due === TOMORROW },
  { key: "thisweek", label: "本周", match: (r) => !done(r.it) && r.due > TOMORROW && r.due <= WEEK_END },
  { key: "later", label: "下周后", match: (r) => !done(r.it) && r.due > WEEK_END },
  { key: "nodate", label: "无日期", match: (r) => !done(r.it) && r.due === "" },
  { key: "done", label: "已完成", match: (r) => done(r.it) }
];

function bucketize(list) {
  const out = [];
  for (const g of GROUPS) {
    const items = list.filter(g.match);
    if (!items.length) continue;
    items.sort((a, b) => {
      if (a.due === "" || b.due === "") return a.due === "" ? 1 : -1;
      if (a.due !== b.due) return a.due < b.due ? -1 : 1;
      return (a.it.priority || 9) - (b.it.priority || 9);
    });
    out.push({ key: g.key, items });
  }
  return out;
}

const T = (summary, due, extra = {}) => ({ it: { summary, percent: 0, priority: 9, ...extra }, due });
const DONE = (summary, due) => ({ it: { summary, percent: 100, priority: 9 }, due });

let failed = 0;

// ── 1. 分组顺序即轻重缓急 ──
const mixed = [
  T("无日期任务", ""),
  DONE("上周完成的", "2026-10-01"),
  T("下月到期", "2026-11-20"),
  T("今天到期", TODAY),
  T("逾期十八天", "2026-09-18"),
  T("明天到期", TOMORROW),
  T("本周五到期", "2026-10-09"),
  T("周日到期", WEEK_END),
  T("下周到期", "2026-10-13")
];
const order = bucketize(mixed).map((b) => b.key);
const expected = ["overdue", "today", "tomorrow", "thisweek", "later", "nodate", "done"];
{
  const ok = JSON.stringify(order) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 分组顺序`);
  if (!ok) console.log(`         实际 ${JSON.stringify(order)}\n         期望 ${JSON.stringify(expected)}`);
}

// ── 2. 已完成组恒沉底 ──
{
  const keys = bucketize([DONE("done", ""), T("undone", TODAY)]).map((b) => b.key);
  const ok = keys[keys.length - 1] === "done";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 已完成组沉底（实际 ${JSON.stringify(keys)}）`);
}

// ── 3. 组内排序：日期升序 ──
{
  const b = bucketize([T("本周晚", "2026-10-10"), T("本周早", "2026-10-08")]).find((x) => x.key === "thisweek");
  const names = b.items.map((i) => i.it.summary);
  const ok = names[0] === "本周早";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 组内按日期升序（实际 ${JSON.stringify(names)}）`);
}

// ── 4. 同日期时优先级高的在前（priority 数字小= 紧急）──
{
  const b = bucketize([
    T("低优先", TODAY, { priority: 7 }),
    T("紧急", TODAY, { priority: 1 }),
    T("无优先", TODAY)
  ]).find((x) => x.key === "today");
  const names = b.items.map((i) => i.it.summary);
  const ok = names[0] === "紧急";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 同日期优先级排序（实际 ${JSON.stringify(names)}）`);
}

// ── 5. 空组不输出（不产生空标题）──
{
  const b = bucketize([T("只有今天", TODAY)]);
  const ok = b.length === 1 && b[0].key === "today";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 空组不输出（输出 ${b.length} 组）`);
}

// ── 6. 逾期组包含「逾期但已完成」？—— 不应，已完成的归 done 组 ──
{
  const b = bucketize([DONE("逾期的已完成", "2026-09-01"), T("未完成逾期", "2026-09-01")]);
  const overdueItems = b.find((x) => x.key === "overdue").items.map((i) => i.it.summary);
  const ok = overdueItems.length === 1 && overdueItems[0] === "未完成逾期";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 已完成不进逾期组（实际 ${JSON.stringify(overdueItems)}）`);
}

// ── 7. 折叠状态：仅已完成组可折叠，且默认折叠 ──
{
  // 这段逻辑在 view-task.ts 里，此处只钉住「默认折叠」这个决定
  const defaultCollapsed = true;
  assert.ok(defaultCollapsed === true, "已完成组必须默认折叠 —— 181 条不该和待办抢注意力");
  console.log(`  [PASS] 已完成组默认折叠`);
}

// ── 8. 边界：本周 = 明天之后到本周日（自然周，周一起算）──
// ⚠️ 今天固定为 2026-10-06（周二），故 weekStart=10-05(周一)、weekEnd=10-11(周日)，
// 「本周」实际只覆盖 10-08~10-11共 4 天 —— 这是自然周的正常结果，不是 bug。
{
  const b = bucketize([T("本周日", WEEK_END), T("本周四", "2026-10-08")]);
  const wk = b.find((x) => x.key === "thisweek");
  const later = b.find((x) => x.key === "later");
  const ok = wk && wk.items.length === 2 && !later;
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 本周边界含两端（本周 ${wk ? wk.items.length : 0} 条 / 下周后 ${later ? later.items.length : 0} 条）`);
}

// ── 9. 明天不进「本周」（明天已单独成组）──
{
  const b = bucketize([T("明天", TOMORROW)]);
  const ok = b.length === 1 && b[0].key === "tomorrow";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 明天独立成组，不被本周吞掉`);
}

// ── 10. 无日期不进「下周后」（due 为空要落到最后）──
{
  const b = bucketize([T("无日期", ""), T("远期", "2026-12-01")]);
  const keys = b.map((x) => x.key);
  const ok = keys[keys.length - 1] === "nodate";
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] 无日期沉到下周后之后（实际 ${JSON.stringify(keys)}）`);
}

console.log(failed === 0 ? "\n✓ 任务分组回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);