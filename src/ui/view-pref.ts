/**
 * 视图记忆：记住上次用的是哪个视图，下次打开时恢复。
 *
 * 2026-10-07 雄哥要求：「记住当前的视图（日历视图/任务视图），下次初次打开时
 * 默认使用上次视图。」
 *
 * ## 为什么存 localStorage 而不进 data.json
 *
 * 视图选择是**纯 UI 偏好**，不是业务数据：
 *   - 不该跟着 Obsidian 云同步跑到别的设备上（那台设备可能窗口更小、习惯不同）
 *   - 不该混进 `CalSettings`（那是给用户看的配置，混进内部状态会污染设置页）
 *   - 切换视图是高频操作，走 data.json 意味着每次都落盘 + 触发 sync 判断
 *
 * 与 `core/secret.ts` 用同一套 localStorage 思路（那里是密钥的本机镜像）。
 *
 * ## 容错
 *
 * localStorage 可能因隐私模式/配额而抛异常，**读写全部包 try**。
 * 读到的值必须落在合法集合内，否则回落默认 —— 不让脏数据把面板卡死。
 */
import type { ViewMode } from "@/ui/panel-ctx";

const KEY = "caldav-view-mode";

/** 全部合法视图。读回的值不在其中 → 视为无记录。 */
const VALID: readonly ViewMode[] = ["year", "month", "week", "day", "task"] as const;

/** 无记录时的初值：日历月视图（与面板原本的默认一致） */
export const DEFAULT_VIEW: ViewMode = "month";

/**
 * 读取上次使用的视图。
 * @returns 记录存在且合法则返回它，否则 `null`（表示「没有记录」）。
 */
export function loadViewMode(): ViewMode | null {
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (!raw) return null;
    return VALID.includes(raw as ViewMode) ? (raw as ViewMode) : null;
  } catch {
    // 隐私模式/配额受限：读不到就用默认值，不打扰用户
    return null;
  }
}

/** 记下当前视图。失败静默 —— 记不住只是下次回到默认视图，不影响使用。 */
export function saveViewMode(mode: ViewMode): void {
  try {
    window.localStorage?.setItem(KEY, mode);
  } catch {
    /* 忽略 */
  }
}

/**
 * 首次打开时该用的视图：有记录用记录的，没记录用 `DEFAULT_VIEW`。
 * 供面板初始化 mainCtx.viewMode 时调用。
 */
export function initialViewMode(): ViewMode {
  return loadViewMode() ?? DEFAULT_VIEW;
}
