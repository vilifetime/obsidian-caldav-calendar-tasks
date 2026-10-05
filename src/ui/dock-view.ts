/**
 * Dock 视图（右侧栏）—— 原思源插件左侧 Dock 的 Obsidian 承载。
 *
 * ── 与原思源版的对应关系 ──────────────────────────────────────────
 * 思源版：左侧 Dock（240px 精简导航）+ 主窗口页签（完整日历）双承载。
 * Obsidian 版：Dock 放**右侧栏**、完整日历放**中间主区域** —— 并排效果最接近思源原版。
 *
 * Dock 本体（`renderDockPanel`）是从思源直接迁过来的，零宿主依赖：品牌栏、新增/排序
 * 下拉、日历/任务视图切换、刷新、筛选下拉、分类筛选弹层、搜索框、条目列表、同步状态。
 *
 * ── 两个视图怎么通信 ─────────────────────────────────────────────
 * 它们是各自独立的 ItemView 实例，互不持有引用，故走 `document` 事件：
 *   - 主面板单击格子/条目 → `FOCUS_DATE_EVENT` → 本视图切到该日清单
 *   - 本视图的「日历视图 / 任务视图」按钮 → 通过 plugin.activateView 让主面板切视图
 */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type CalDavPlugin from "@/main";
import { DOCK_VIEW_TYPE, ICON_ID } from "@/constants";
import { renderDockPanel, toggleTodoDone } from "./panel";
import { openEditor } from "./editor";

export class CalDavDockView extends ItemView {
  private plugin: CalDavPlugin;
  private dock: {
    refresh: () => void;
    destroy: () => void;
    isDefaultState: () => boolean;
    isScopedState: () => boolean;
    isDetailState: () => boolean;
  } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CalDavPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return DOCK_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "日历任务管理";
  }

  getIcon(): string {
    return ICON_ID;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("caldav-dock-host");
    const ctx = this.plugin.mainCtx;

    this.dock = renderDockPanel(this.contentEl, {
      store: this.plugin.store,
      // 「日历视图 / 任务视图」按钮：在中间主区域打开面板并切到对应视图
      onNav: (mode) => void this.plugin.activateView("main", mode),
      onSync: () => this.plugin.runSync(true),
      onSettings: () => this.plugin.openSetting(),
      onAddEvent: () => openEditor(ctx, { kind: "event", start: ctx.cursor }),
      onAddTask: () => openEditor(ctx, { kind: "todo", start: ctx.cursor }),
      // Dock 内部已按 localSort 自行排序，外部无需介入；保留接口以匹配原签名
      onSort: () => {},
      onOpenEditor: (item) => openEditor(ctx, { item }),
      onToggleDone: (item) => toggleTodoDone(ctx, item),
      // Dock 的默认筛选随主面板视图而定（月=所有未完成 / 周=本周任务 / 日=聚焦当天），
      // 故需要读主面板当前所在的视图与日期
      getViewMode: () => ctx.viewMode,
      getCursor: () => ctx.cursor,
    });
  }

  async onClose(): Promise<void> {
    this.dock?.destroy();
    this.dock = null;
  }

  /** 入口在同步完成 / 数据变化后调用 */
  refresh(): void {
    this.dock?.refresh();
  }

  /**
   * 当前是否处于「所有未完成」默认态。
   * 入口据此判断「双击日历空白处」该切回默认还是隐藏右侧栏（见 main.ts 的 toggleDock）。
   */
  isDefaultState(): boolean {
    return this.dock?.isDefaultState() ?? false;
  }

  /** 是否处于聚焦态（聚焦某日 / 某月 / 某周） */
  isScopedState(): boolean {
    return this.dock?.isScopedState() ?? false;
  }

  /** 是否处于条目详情态（右击条目后展示的那张详情卡） */
  isDetailState(): boolean {
    return this.dock?.isDetailState() ?? false;
  }
}
