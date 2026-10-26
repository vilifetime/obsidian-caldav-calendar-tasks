/**
 * 视图记忆：记住上次用的是哪个视图，下次打开时恢复。
 *
 * 2026-10-07 雄哥要求：「记住当前的视图（日历视图/任务视图），下次初次打开时
 * 默认使用上次视图。」
 *
 * ## 2026-10-27：存储从 localStorage 改到配置（`CalSettings`）
 *
 * 原先按「纯 UI 偏好、不该跨设备同步」的理由存了 localStorage。现改存配置，
 * 与思源端保持一致，两条理由：
 *   ① 思源端**必须**这么改 —— 它每次启动的内核端口是随机的，而 localStorage 按
 *      origin（**含端口**）隔离，写进去的记录下次永远读不回来，等于根本没记住。
 *   ② Obsidian 端 localStorage 虽然能用（origin 固定），但它是 **app 级**的、
 *      所有 vault 共享同一份 —— 换个 vault 会读到另一个 vault 的视图。
 *      data.json 是 per-vault 的，存那儿反而修好了这个串味问题。
 *
 * 代价：多端同步会互相覆盖，但只影响「上次哪个视图」，后果很小。
 *
 * ## 容错
 *
 * 读到的值必须落在合法集合内，否则回落默认 —— 不让脏数据把面板卡死。
 */
import type { ViewMode } from "@/ui/panel-ctx";
import type { CalSettings } from "@/core/types";

/** 全部合法视图。读回的值不在其中 → 视为无记录。 */
const VALID: readonly ViewMode[] = ["year", "month", "week", "day", "task"] as const;

/** 只记日历视图（年/月/周/日）。 */
const VALID_CALENDAR: readonly ViewMode[] = ["year", "month", "week", "day"] as const;

/** 无记录时的初值：日历月视图（与面板原本的默认一致） */
export const DEFAULT_VIEW: ViewMode = "month";

/**
 * 读取上次使用的视图。
 * @returns 记录存在且合法则返回它，否则 `null`（表示「没有记录」）。
 */
export function loadViewMode(s: CalSettings): ViewMode | null {
  const raw = s.lastView;
  if (!raw) return null;
  return VALID.includes(raw as ViewMode) ? (raw as ViewMode) : null;
}

/**
 * 记下当前视图（写进配置 `settings.lastView`）。
 *
 * ⚠️ 只改内存里的 settings，**调用方负责随后 `store.markSettingsDirty()` 落盘** ——
 * 切视图是高频操作，由调用方决定何时写，这里不越权触发持久化。
 */
export function saveViewMode(s: CalSettings, mode: ViewMode): void {
  s.lastView = mode;
}

/**
 * 记下「上次使用的日历视图」。仅在 `mode` 是日历视图（年/月/周/日）时有意义，
 * task 不该覆盖它 —— 调用方负责过滤，这里也兜一层。
 */
export function saveCalendarView(s: CalSettings, mode: ViewMode): void {
  if (!VALID_CALENDAR.includes(mode)) return;
  s.lastCalendarView = mode;
}

/**
 * 读上次使用的日历视图（从任务视图返回时用）。
 * @returns 记录存在且合法则返回它，否则 `null`（调用方回落默认月视图）。
 */
export function loadCalendarView(s: CalSettings): ViewMode | null {
  const raw = s.lastCalendarView;
  if (!raw) return null;
  return VALID_CALENDAR.includes(raw as ViewMode) ? (raw as ViewMode) : null;
}

/**
 * 首次打开时该用的视图：有记录用记录的，没记录用 `DEFAULT_VIEW`。
 * 供面板初始化 mainCtx.viewMode 时调用。
 */
export function initialViewMode(s: CalSettings): ViewMode {
  return loadViewMode(s) ?? DEFAULT_VIEW;
}
