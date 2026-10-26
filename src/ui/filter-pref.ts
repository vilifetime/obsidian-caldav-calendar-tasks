/**
 * 筛选记忆：记住两处筛选下拉上次用的是哪一项，下次打开时恢复。
 *
 * 2026-10-26 雄哥要求：Dock / 任务视图的筛选默认值「不希望固定不可更改」，
 * 设置里新增「上次使用项」（默认）+ 各自下拉的全部取值。
 *
 * ## 2026-10-27：存储从 localStorage 改到配置（`CalSettings`）
 *
 * 原先按「纯 UI 偏好、不该跨设备同步」的理由存了 localStorage。现改存配置，
 * 与思源端保持一致，两条理由：
 *   ① 思源端**必须**这么改 —— 它每次启动的内核端口是随机的，而 localStorage 按
 *      origin（**含端口**）隔离，写进去的记录下次永远读不回来，等于根本没记住
 *      （这就是「上次使用项」不生效的根因）。
 *   ② Obsidian 端 localStorage 虽然能用（origin 固定），但它是 **app 级**的、
 *      所有 vault 共享同一份 —— 换个 vault 会读到另一个 vault 的筛选。
 *      data.json 是 per-vault 的，存那儿反而修好了这个串味问题。
 *
 * 代价：多端同步会互相覆盖，但只影响「上次哪个筛选」，后果很小。
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
 * 读到的值必须落在合法集合内，否则视为无记录 —— 不让脏数据把面板卡死。
 */
import type { CalSettings, DockFilterKey, TaskFilterKey } from "../core/types";

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

/** 读出来的值必须落在合法集合内，否则视为无记录（脏数据不该把面板卡死） */
function valid<T extends string>(raw: string | undefined, set: readonly string[]): T | null {
  if (!raw) return null;
  return set.includes(raw) ? (raw as T) : null;
}

export function loadLastDockFilter(s: CalSettings): DockFilterKey | null {
  return valid<DockFilterKey>(s.lastDockFilter, DOCK_FILTER_KEYS);
}

/**
 * 记下本次选的（写进配置 `settings.lastDockFilter`）。
 *
 * ⚠️ 只改内存里的 settings，**调用方负责随后 `store.markSettingsDirty()` 落盘** ——
 * 切筛选是高频操作，由调用方决定何时写，这里不越权触发持久化。
 */
export function saveLastDockFilter(s: CalSettings, k: DockFilterKey): void {
  s.lastDockFilter = k;
}

export function loadLastTaskFilter(s: CalSettings): TaskFilterKey | null {
  return valid<TaskFilterKey>(s.lastTaskFilter, TASK_FILTER_KEYS);
}

export function saveLastTaskFilter(s: CalSettings, k: TaskFilterKey): void {
  s.lastTaskFilter = k;
}

/**
 * 解析「Dock 默认筛选」设置 → 实际该用的初始筛选。
 * - `"last"`（或没设过）→ 上次使用项；无记录则回落「所有未完成」
 * - 具体筛选键 → 固定用它
 */
export function resolveDockFilter(s: CalSettings): DockFilterKey {
  const v = s.defaultDockFilter;
  if (!v || v === "last") return loadLastDockFilter(s) ?? DEFAULT_DOCK_FILTER;
  return DOCK_FILTER_KEYS.includes(v) ? v : DEFAULT_DOCK_FILTER;
}

/** 解析「任务视图默认筛选」设置 → 实际该用的初始筛选（同上） */
export function resolveTaskFilter(s: CalSettings): TaskFilterKey {
  const v = s.defaultTaskFilter;
  if (!v || v === "last") return loadLastTaskFilter(s) ?? DEFAULT_TASK_FILTER;
  return TASK_FILTER_KEYS.includes(v) ? v : DEFAULT_TASK_FILTER;
}
