/**
 * VTODO / VEVENT 四态模型（与思源端 0.2.35 同构，去掉了思源文档块 marker 相关部分 ——
 * Obsidian 没有块 API，这里只保留 CalDAV 状态与 UI 展示所需的纯逻辑）。
 *
 * RFC 5545 的 STATVALUE-TODO 有四个合法值：
 *   NEEDS-ACTION / IN-PROCESS / COMPLETED / CANCELLED。
 * 之前的插件只认前三态，导致「已作废」条目在同步往返时被重算回「待办」。
 *
 * ⚠️ core 层零 obsidian 依赖：i18n 只用浏览器内置 API，可以安全 import。
 */
import { t } from "@/i18n";
import type { CalItem } from "./types";

export type TaskState = "todo" | "in-progress" | "done" | "canceled";

export const STATUS_NEEDS_ACTION = "NEEDS-ACTION";
export const STATUS_IN_PROCESS = "IN-PROCESS";
export const STATUS_COMPLETED = "COMPLETED";
export const STATUS_CANCELLED = "CANCELLED";

const VALID_STATUS = new Set<string>([
  STATUS_NEEDS_ACTION,
  STATUS_IN_PROCESS,
  STATUS_COMPLETED,
  STATUS_CANCELLED
]);

/**
 * 四态 → i18n key。
 * ⚠️ 必须是字面量映射而非模板拼接：test/i18n-dict.cjs 会硬断言字典里每个 key
 * 在源码中有 `"key"` 形式的引用，动态拼出来的 key 会被判成「无引用」。
 */
const STATE_I18N: Record<TaskState, string> = {
  "todo": "state.todo",
  "in-progress": "state.inProgress",
  "done": "state.done",
  "canceled": "state.canceled"
};

/** 四态短标签（列表 / 任务视图的状态前缀） */
export function stateText(state: TaskState): string {
  return t(STATE_I18N[state]);
}

/**
 * 服务端 STATUS（+ PERCENT-COMPLETE）→ 四态。
 * 兼容旧口径：服务端只写 PERCENT-COMPLETE:100 而没写 STATUS 时也算完成。
 */
export function stateOfStatus(status: string | undefined | null, percent?: number): TaskState {
  const s = (status || "").toUpperCase();
  if (s === STATUS_COMPLETED) return "done";
  if (s === STATUS_IN_PROCESS) return "in-progress";
  if (s === STATUS_CANCELLED) return "canceled";
  if (percent === 100) return "done";
  return "todo";
}

/** 状态 → 服务端字段（STATUS + PERCENT-COMPLETE） */
export function statusFields(state: TaskState): { status: string; percent: number } {
  switch (state) {
    case "done":
      return { status: STATUS_COMPLETED, percent: 100 };
    case "in-progress":
      return { status: STATUS_IN_PROCESS, percent: 0 };
    case "canceled":
      return { status: STATUS_CANCELLED, percent: 0 };
    default:
      return { status: STATUS_NEEDS_ACTION, percent: 0 };
  }
}

/** 把服务端可能给出的任意 STATUS 归一到四个合法值之一 */
export function normalizeTodoStatus(status: string | undefined | null, percent?: number): string {
  const s = (status || "").toUpperCase();
  if (VALID_STATUS.has(s)) return s;
  return percent === 100 ? STATUS_COMPLETED : STATUS_NEEDS_ACTION;
}

/** 条目是否处于作废终态（待办与日程通用） */
export function isCancelledItem(it: CalItem): boolean {
  return it.status === STATUS_CANCELLED;
}
