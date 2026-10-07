/**
 * 面板上下文与视图模式（类型定义，无实现依赖）
 *
 * 原项目把 `PanelCtx` 与 `ViewMode` 定义在 `panel.ts` 里，导致 `view-common.ts`
 * 为了拿一个类型不得不 import 整个面板实现（而 panel.ts 又反向依赖 view-month/week/
 * year/task 与 editor），形成类型层面的环。
 *
 * 移植时把这两个类型抽出来独立存放：视图模块只依赖本文件，不依赖实现。
 * 字段与原定义保持一一对应，panel.ts 迁移过来后从本文件 re-export，调用方无感。
 */
import type { App } from "obsidian";
import type { CalStore } from "@/core/store";
import type { SyncEngine } from "@/core/sync";
import type { SortMode } from "@/core/types";
import type { DiaryRange } from "./diary-range";

export type ViewMode = "year" | "month" | "week" | "day" | "task";

export interface PanelCtx {
  store: CalStore;
  sync: SyncEngine;
  /**
   * 宿主 App 实例。
   * 编辑器（Modal）与提醒浮层需要它 —— 思源版的 Dialog 自带全局上下文，
   * Obsidian 的 Modal 构造函数要求显式传入 app。
   */
  app: App;
  i18n: (key: string) => string;
  /**
   * 打开插件设置页。
   * 思源版此处直接 `openSettingsDialog(ctx)` 弹自定义 Dialog；Obsidian 改用
   * 标准 `PluginSettingTab`，由入口注入「打开设置」的调用。
   */
  openSettings: () => void;
  /** 把今日日程插入日记（由入口注入，依赖宿主的文件 API） */
  /** 写入日记；不传范围时按「当日」处理（命令行调用与旧行为一致） */
  insertTodayToDiary: (range?: DiaryRange) => Promise<string>;
  /** 发送一条测试提醒（由入口注入，用于自检提醒投递通道） */
  testReminder?: () => Promise<string>;
  /** 提醒状态摘要（由入口注入，显示已排程条数与带提醒时间的条目数） */
  reminderStatus?: () => string;
  unsaved: Set<string>;
  viewMode: ViewMode;
  /** 当前聚焦日期 YYYY-MM-DD */
  cursor: string;
  /** 排序方式：开始/结束/优先级/完成/创建/分类/标题 */
  sortMode: SortMode;
  /** 视图内导航（年视图跳月/日用），由 renderPanel 注入 */
  navigate?: (mode: ViewMode, cursor?: string) => void;
}
