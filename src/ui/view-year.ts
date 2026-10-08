/**
 * 年视图：12 个迷你月历网格，标注有日程/任务的日期（圆点 + 颜色）。
 * 点击月标题跳转到该月；点击某天跳转到该天（日视图）。
 */
import { addDays, dateStampOfMs, todayStamp } from "../core/date";
import { calColorOf, type ViewArgs } from "./view-common";
import { setHtml } from "./dom";
import { t } from "@/i18n";

const WEEK_LABEL_KEYS = [
  "cal.weekdayShortMon",
  "cal.weekdayShortTue",
  "cal.weekdayShortWed",
  "cal.weekdayShortThu",
  "cal.weekdayShortFri",
  "cal.weekdayShortSat",
  "cal.weekdayShortSun"
];

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function renderYearView({ ctx, viewEl, occurrences }: ViewArgs): void {
  const y = +ctx.cursor.slice(0, 4);
  const startMs = new Date(y, 0, 1).getTime();
  const endMs = new Date(y + 1, 0, 1).getTime();
  const occMap = occurrences(startMs, endMs);
  const today = todayStamp();

  // 按日期分桶：数量 + 首个日历颜色（用于圆点）
  const byDay = new Map<string, { count: number; colors: Set<string> }>();
  let total = 0;
  for (const [it, occs] of occMap) {
    for (const occ of occs) {
      const day = occ.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, { count: 0, colors: new Set() });
      const e = byDay.get(day)!;
      e.count++;
      e.colors.add(calColorOf(ctx, it));
      total++;
    }
  }

  const months: string[] = [];
  for (let m = 0; m < 12; m++) {
    const first = new Date(y, m, 1);
    const gridStart = new Date(first);
    gridStart.setDate(1 - ((first.getDay() + 6) % 7)); // 周一起始
    const cells: string[] = [];
    for (let i = 0; i < 42; i++) {
      const day = addDays(dateStampOfMs(gridStart.getTime()), i);
      const inMonth = +day.slice(5, 7) === m + 1;
      const isToday = day === today;
      const info = byDay.get(day);
      const dot = info ? `<span class="cal-year-dot" style="background:${[...info.colors][0]}"></span>` : "";
      const badge = info && info.count > 1 ? `<span class="cal-year-count">${info.count}</span>` : "";
      cells.push(`<div class="cal-year-cell ${inMonth ? "" : "is-out"} ${isToday ? "is-today" : ""}" data-day="${day}">
        <span class="cal-year-num">${+day.slice(8, 10)}</span>${dot}${badge}
      </div>`);
    }
    months.push(`<div class="cal-year-month">
      <div class="cal-year-month-head" data-month="${y}-${pad2(m + 1)}" title="${t("cal.yearMonthHead", { m: m + 1 })}">${t("cal.yearMonthLabel", { m: m + 1 })}</div>
      <div class="cal-year-weeks">${WEEK_LABEL_KEYS.map((k) => `<span>${t(k)}</span>`).join("")}</div>
      <div class="cal-year-grid">${cells.join("")}</div>
    </div>`);
  }

  setHtml(viewEl, `<div class="cal-year">
    <div class="cal-year-head">${t("cal.yearHead", { y, total })}</div>
    <div class="cal-year-months">${months.join("")}</div>
  </div>`);

  // 导航：点月标题 → 月视图；点某天 → 日视图
  viewEl.querySelector(".cal-year-months")?.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const mh = t.closest<HTMLElement>("[data-month]");
    if (mh) {
      ctx.navigate?.("month", mh.dataset.month + "-01");
      return;
    }
    const cell = t.closest<HTMLElement>("[data-day]");
    // 上面的 closest 命中已保证元素带 data-day，但 TS 不知道该属性非空。
    // 显式收窄 —— 比原来的 `cell.dataset.day!` 好：既消掉非空断言，
    // 又让 navigate 的第二个参数类型正确，且 cell 为 undefined 时直接短路。
    const day = cell?.dataset.day;
    if (day && !cell.classList.contains("is-out")) {
      ctx.navigate?.("day", day);
    }
  });
}
