/**
 * 「插入日记」的范围计算（2026-10-07）。
 *
 * 雄哥要求：原按钮直接插「今日」，改为先问范围 —— 当日 / 本周 / 本月 / 所有，
 * 默认「当日」。
 *
 * 这里只做**纯计算**，不碰文件与 UI —— 便于写契约测试（见 test/diary-range.cjs）。
 * 「本周」沿用项目既有约定：**自然周，周一起算**（与任务视图的分组一致）。
 */
import { addDays, dateStampOfMs, parseLocalStamp, startOfWeek, todayStamp } from "@/core/date";
import type { LocalStamp } from "@/core/types";

/** 范围种类 */
export type DiaryRange = "day" | "week" | "month" | "all";

export interface DiarySpan {
  /** 起始日期（含） */
  from: string;
  /** 结束日期（不含）—— 统一用「次日零点」表示，便于与毫秒区间比较 */
  toExclusive: string;
  /** 展示用的中文标签，供弹窗与通知复用 */
  label: string;
  /** 写入日记时的小节标题。跨日范围要带上区间，否则读者不知道这段是哪天的 */
  sectionTitle: string;
}

const SECTION_BASE = "日程与待办";

/** 把日期字符串当成「当日零点」的毫秒值 */
function midnightMs(stamp: string): number {
  return parseLocalStamp(stamp + "T00:00:00").getTime();
}

/** 日期加一天（月末会自动进位，交给 Date 处理） */
function nextDay(stamp: string): string {
  return addDays(stamp, 1);
}

/** 当月最后一天 +1 = 下月首日 */
function nextMonth(stamp: string): string {
  const d = parseLocalStamp(stamp + "T00:00:00");
  return dateStampOfMs(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime());
}

/**
 * 算出某个范围对应的日期区间。
 *
 * `all` 不设上界 —— 传一个足够远的未来（比如今天 +100 年），
 * 这样调用方可以一律用 `ms >= from && ms < toExclusive` 判断，不必写分支。
 */
export function diarySpanOf(range: DiaryRange, today: LocalStamp = todayStamp()): DiarySpan {
  switch (range) {
    case "day":
      return {
        from: today,
        toExclusive: nextDay(today),
        label: "当日",
        sectionTitle: SECTION_BASE,
      };

    case "week": {
      // 自然周：周一起算，与任务视图「本周」分组的口径一致
      const from = startOfWeek(today);
      const to = addDays(from, 7);
      return {
        from,
        toExclusive: to,
        label: "本周",
        // 跨日的范围必须标出区间，否则读者不知道这段覆盖哪天
        sectionTitle: `${SECTION_BASE}（${from} ~ ${addDays(to, -1)}）`,
      };
    }

    case "month": {
      const from = today.slice(0, 8) + "01";
      const to = nextMonth(from);
      return {
        from,
        toExclusive: to,
        label: "本月",
        sectionTitle: `${SECTION_BASE}（${from.slice(0, 7)}）`,
      };
    }

    case "all": {
      const from = "1900-01-01";
      const to = addDays(today, 36500);
      return {
        from,
        toExclusive: to,
        label: "所有",
        sectionTitle: SECTION_BASE,
      };
    }
  }
}

/** 区间是否包含某个毫秒时间点（统一用「左闭右开」） */
export function spanContains(span: DiarySpan, ms: number): boolean {
  return ms >= midnightMs(span.from) && ms < midnightMs(span.toExclusive);
}