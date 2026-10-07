/**
 * 回归测试：插入日记的范围计算。
 *
 * 2026-10-07 雄哥要求：原按钮直接插「今日」，改为先问范围
 * （当日 / 本周 / 本月 / 所有，默认当日）。
 *
 * 范围计算是**纯函数**，最易出边界错（跨月、跨年、周一起算），故钉死。
 * 刻意复刻实现而非 import —— 源文件是 TS 且 import "obsidian"，Node 无法 require。
 */
const assert = require("assert");

// ── 复刻 src/ui/diary-range.ts 的实现 ──
function pad2(n) { return String(n).padStart(2, "0"); }
function parseLocalStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return new Date(NaN);
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
function stampOfMs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDays(stamp, days) {
  const d = parseLocalStamp(stamp + "T00:00:00");
  d.setDate(d.getDate() + days);
  return stampOfMs(d.getTime());
}
function startOfWeek(stamp) {
  const d = parseLocalStamp(stamp + "T00:00:00");
  const wd = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - wd);
  return stampOfMs(d.getTime());
}
function nextMonth(stamp) {
  const d = parseLocalStamp(stamp + "T00:00:00");
  return stampOfMs(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime());
}
const midnightMs = (s) => parseLocalStamp(s + "T00:00:00").getTime();

function diarySpanOf(range, today) {
  switch (range) {
    case "day":
      return { from: today, toExclusive: addDays(today, 1), label: "当日", sectionTitle: "日程与待办" };
    case "week": {
      const from = startOfWeek(today);
      const to = addDays(from, 7);
      return {
        from,
        toExclusive: to,
        label: "本周",
        sectionTitle: `日程与待办（${from} ~ ${addDays(to, -1)}）`,
      };
    }
    case "month": {
      const from = today.slice(0, 8) + "01";
      return {
        from,
        toExclusive: nextMonth(from),
        label: "本月",
        sectionTitle: `日程与待办（${from.slice(0, 7)}）`,
      };
    }
    case "all": {
      const from = "1900-01-01";
      return { from, toExclusive: addDays(today, 36500), label: "所有", sectionTitle: "日程与待办" };
    }
  }
}
const spanContains = (span, ms) => ms >= midnightMs(span.from) && ms < midnightMs(span.toExclusive);

// ── 用例 ──
let failed = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failed++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${cond ? "" : "  " + extra}`);
};

// 1. 当日：区间就是今天这一天，标题不带区间
{
  const s = diarySpanOf("day", "2026-10-07");
  check("当日 from = 今天", s.from === "2026-10-07", s.from);
  check("当日 toExclusive = 次日", s.toExclusive === "2026-10-08", s.toExclusive);
  check("当日标题不带区间", s.sectionTitle === "日程与待办", s.sectionTitle);
}

// 2. 本周：自然周、周一起算（与任务视图口径一致）
{
  // 2026-10-07 是周三 → 本周一 = 10-05
  const s = diarySpanOf("week", "2026-10-07");
  check("本周从周一起算", s.from === "2026-10-05", s.from);
  check("本周 toExclusive = 下周一", s.toExclusive === "2026-10-12", s.toExclusive);
  check("本周标题带区间", s.sectionTitle.includes("2026-10-05 ~ 2026-10-11"), s.sectionTitle);

  // 周日归属上一个周一（易错：`(0+6)%7=6`，要减6 天）
  const sun = diarySpanOf("week", "2026-10-11"); // 周日
  check("周日归属上一个周一（不减到本周日）", sun.from === "2026-10-05", sun.from);

  // 周一当天 → 自己就是起点
  const mon = diarySpanOf("week", "2026-10-05");
  check("周一当天的周起点是自己", mon.from === "2026-10-05", mon.from);
}

// 3. 本月：1 号起，跨月要正确进位
{
  const s = diarySpanOf("month", "2026-10-07");
  check("本月从1 号起", s.from === "2026-10-01", s.from);
  check("本月 toExclusive = 下月 1 号", s.toExclusive === "2026-11-01", s.toExclusive);
  check("本月标题含年月", s.sectionTitle.includes("2026-10"), s.sectionTitle);

  // 跨年：12 月 → 次年 1 月
  const dec = diarySpanOf("month", "2026-12-15");
  check("12 月 → 次年 1 月", dec.toExclusive === "2027-01-01", dec.toExclusive);

  // 闰年 2 月 → 3 月（2028 是闰年）
  const feb = diarySpanOf("month", "2028-02-10");
  check("闰年 2 月 → 3 月 1 号", feb.toExclusive === "2028-03-01", feb.toExclusive);
}

// 4. 所有：下界足够早、上界在未来
{
  const s = diarySpanOf("all", "2026-10-07");
  check("所有含历史（下界很早）", midnightMs("2000-01-01") >= midnightMs(s.from));
  check("所有含未来（上界很晚）", midnightMs("2030-01-01") < midnightMs(s.toExclusive));
  check("所有标题不带区间", s.sectionTitle === "日程与待办", s.sectionTitle);
}

// 5. 边界：左闭右开（当天 0点含、当天 24 点不含）
{
  const s = diarySpanOf("day", "2026-10-07");
  check("当天 00:00 含", spanContains(s, midnightMs("2026-10-07")));
  check("当天 23:59 含", spanContains(s, midnightMs("2026-10-07") + 23 * 3600000 + 59 * 60000));
  check("次日 00:00 不含", !spanContains(s, midnightMs("2026-10-08")));
  check("前日 23:59 不含", !spanContains(s, midnightMs("2026-10-06") + 23 * 3600000 + 59 * 60000));
}

// 6. 本周范围应包含本周一，不含上周日
{
  const s = diarySpanOf("week", "2026-10-07");
  check("本周含本周一", spanContains(s, midnightMs("2026-10-05")));
  check("本周不含上周日", !spanContains(s, midnightMs("2026-10-04")));
}

// 7. 写日记的目标文件：当日/本周/本月用区间起始日，all 用今天
{
  const d = diarySpanOf("day", "2026-10-07");
  const w = diarySpanOf("week", "2026-10-07");
  const m = diarySpanOf("month", "2026-10-07");
  check("当日 → 今天", d.from === "2026-10-07");
  check("本周 → 周一", w.from === "2026-10-05");
  check("本月 → 1 号", m.from === "2026-10-01");
}

// 8. 关键钉子：小节标题必须随范围变，否则「重复点击替换」会失效
//    （writeDiarySection 按实际标题匹配；标题固定就会永远命中不了）
{
  const titles = ["day", "week", "month", "all"].map((r) => diarySpanOf(r, "2026-10-07").sectionTitle);
  check("四种范围至少产生两种标题", new Set(titles).size >= 2, JSON.stringify(titles));
}

// 9. 关键钉子：面板按钮文案已去掉「今日」
{
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("./../src/ui/panel.ts"), "utf8");
  check("按钮文案是「把日程与待办插入日记」", src.includes(">把日程与待办插入日记</button>"));
  check("旧文案「把今日日程与待办插入日记」已不存在", !src.includes("把今日日程与待办插入日记"));
  // 点击必须弹范围选择，而不是直接调insertTodayToDiary()
  check("点击后先弹范围框", /askDiaryRange\(ctx\.app/.test(src));
}

// 10. 关键钉子：writeDiarySection 不得再用固定常量匹配
{
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("./../src/main.ts"), "utf8");
  const fn = (src.match(/private async writeDiarySection[\s\S]*?\n  \}/) || [""])[0];
  check("按实际写入的标题匹配", /findIndex\(\(l\) => l\.trim\(\) === header\.trim\(\)\)/.test(fn));
  check("不再引用 DIARY_SECTION_TITLE", !fn.includes("DIARY_SECTION_TITLE"));
  // 该常量应已从constants 删除
  const consts = fs.readFileSync(require.resolve("./../src/constants.ts"), "utf8");
  check("constants.ts 已删除 DIARY_SECTION_TITLE", !/export const DIARY_SECTION_TITLE/.test(consts));
}

console.log(failed === 0 ? "\n✓ 插入日记范围回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);