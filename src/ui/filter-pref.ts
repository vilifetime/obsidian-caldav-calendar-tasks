/**
 * 筛选记忆：记住两处筛选下拉上次用的是哪一项，下次打开时恢复。
 *
 * 2026-10-26 雄哥要求：Dock / 任务视图的筛选默认值「不希望固定不可更改」，
 * 设置里新增「上次使用项」（默认）+ 各自下拉的全部取值。
 *
 * ## 为什么存 localStorage 而不进设置
 *
 * 与 `view-pref.ts`（记住上次视图）同一套理由：这是**本机 UI 偏好**，不是业务数据 ——
 *   - 桌面端可能想看「本周任务」、手机端只想看「今日」，没必要跨设备同步
 *   - 不该混进 `CalSettings`（那是给用户看的配置，混进内部状态会污染设置页）
 *   - 切筛选是高频操作，走 data.json 意味着每次都落盘
 *
 * ## 「上次使用项」不存在时的回落
 *
 * 雄哥 2026-10-26：原来 Dock 初始值是「未来七天」，一并改成「所有未完成」。
 * 即 `DEFAULT_DOCK_FILTER = "undone"`、`DEFAULT_TASK_FILTER = "allincomplete"`。
 *
 * ## 文案走 i18n key 而非字面译文
 *
 * 与 ui/panel.ts 的 DOCK_FILTERS 同样处理：模块级常量在 import 时就求值完，
 * 若把译文直接放进来，用户中途改语言后这个列表不会跟着变。故存 key、渲染时再 t()。
 *
 * ## 容错
 *
 * localStorage 可能因隐私模式 / 配额而抛异常，**读写全部包 try**；
 * 读到的值必须落在合法集合内，否则视为无记录 —— 不让脏数据把面板卡死。
 */
import type { CalSettings, DockFilterKey, TaskFilterKey } from "../core/types";

/** 上次使用的 Dock 筛选 */
const KEY_DOCK = "caldav-dock-filter";
/** 上次使用的任务视图筛选 */
const KEY_TASK = "caldav-task-filter";

/**
 * Dock 下拉的顺序（即下拉中的显示顺序）。
 *
 * ⚠️ 键集合与顺序的**唯一来源**：Dock 下拉（ui/panel.ts）与设置页
 * 「侧边栏 Dock 默认筛选」都引用它，避免加项时两边漂移。
 */
export const DOCK_FILTER_KEYS: readonly DockFilterKey[] = [
  "next7", "today", "tomorrow", "thisweek", "future",
  "overdue", "past7", "undone", "nodate",
  "doneToday", "doneYesterday", "done"
];

/** 任务视图下拉的顺序（同上，唯一来源） */
export const TASK_FILTER_KEYS: readonly TaskFilterKey[] = [
  "allitems", "today", "tomorrow", "next7", "thisweek", "future",
  "overdue", "past7", "allincomplete", "nodate",
  "todaydone", "yesterdaydone", "doneall"
];

/** key → i18n key */
export const DOCK_FILTER_I18N: Record<DockFilterKey, string> = {
  next7: "dock.filter.next7",
  today: "dock.filter.today",
  tomorrow: "dock.filter.tomorrow",
  thisweek: "dock.filter.thisweek",
  future: "dock.filter.future",
  overdue: "dock.filter.overdue",
  past7: "dock.filter.past7",
  undone: "dock.filter.undone",
  nodate: "dock.filter.nodate",
  doneToday: "dock.filter.doneToday",
  doneYesterday: "dock.filter.doneYesterday",
  done: "dock.filter.done"
};

export const TASK_FILTER_I18N: Record<TaskFilterKey, string> = {
  allitems: "task.filter.allitems",
  today: "task.filter.today",
  tomorrow: "task.filter.tomorrow",
  next7: "task.filter.next7",
  thisweek: "task.filter.thisweek",
  future: "task.filter.future",
  overdue: "task.filter.overdue",
  past7: "task.filter.past7",
  allincomplete: "task.filter.allincomplete",
  nodate: "task.filter.nodate",
  todaydone: "task.filter.todaydone",
  yesterdaydone: "task.filter.yesterdaydone",
  doneall: "task.filter.doneall"
};

/** 无记录时 Dock 的初始筛选（雄哥要求：由「未来七天」改为「所有未完成」） */
export const DEFAULT_DOCK_FILTER: DockFilterKey = "undone";
/** 无记录时任务视图的初始筛选（与原本一致） */
export const DEFAULT_TASK_FILTER: TaskFilterKey = "allincomplete";

function read(key: string, valid: readonly string[]): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    return valid.includes(raw) ? raw : null; // 脏数据视为无记录
  } catch {
    // 隐私模式 / 配额受限：读不到就走默认值，不打扰用户
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 忽略：记不住只是下次回到默认筛选，不影响使用 */
  }
}

export function loadLastDockFilter(): DockFilterKey | null {
  return read(KEY_DOCK, DOCK_FILTER_KEYS) as DockFilterKey | null;
}

export function saveLastDockFilter(k: DockFilterKey): void {
  write(KEY_DOCK, k);
}

export function loadLastTaskFilter(): TaskFilterKey | null {
  return read(KEY_TASK, TASK_FILTER_KEYS) as TaskFilterKey | null;
}

export function saveLastTaskFilter(k: TaskFilterKey): void {
  write(KEY_TASK, k);
}

/**
 * 解析「Dock 默认筛选」设置 → 实际该用的初始筛选。
 * - `"last"`（或没设过）→ 上次使用项；无记录则回落「所有未完成」
 * - 具体筛选键 → 固定用它
 */
export function resolveDockFilter(s: CalSettings): DockFilterKey {
  const v = s.defaultDockFilter;
  if (!v || v === "last") return loadLastDockFilter() ?? DEFAULT_DOCK_FILTER;
  return DOCK_FILTER_KEYS.includes(v) ? v : DEFAULT_DOCK_FILTER;
}

/** 解析「任务视图默认筛选」设置 → 实际该用的初始筛选（同上） */
export function resolveTaskFilter(s: CalSettings): TaskFilterKey {
  const v = s.defaultTaskFilter;
  if (!v || v === "last") return loadLastTaskFilter() ?? DEFAULT_TASK_FILTER;
  return TASK_FILTER_KEYS.includes(v) ? v : DEFAULT_TASK_FILTER;
}
