/**
 * 主面板视图（ItemView）
 *
 * 承载 `ui/panel.ts` 的完整日历面板 —— 月 / 周 / 日 / 年 四种日历视图 + 任务视图，
 * 含顶部导航、新增、日历筛选与条目交互（点击编辑、右键菜单、勾选待办）。
 *
 * ── 与思源版的承载方式差异 ────────────────────────────────────────
 * 思源版是「Dock + 主窗口页签」双承载：
 *   - 左侧 Dock（240px）：精简导航（新增 / 排序 / 切换视图 / 刷新）
 *   - 主窗口页签：完整日历面板（renderPanel）
 *   - 移动端因 addTab/openTab 是空实现且没有页签栏，另用全屏 Dialog 承载同一个
 *     renderPanel，由此衍生出 mobile-layers.ts（192 行）那套 Dialog 层级管理。
 *
 * Obsidian 只需一个 ItemView：桌面端停靠主区域或侧栏，移动端同样支持，两端共用。
 *
 * 关于顶部工具条：曾加过一行宿主级操作（同步 / 插入日记 / 设置），现已**移除** ——
 * 日历面板自身已有完整工具条（导航 + 视图切换 + 新建 + 筛选），再叠一行太占地方。
 * 那三项功能并未丢失，只是改用 Obsidian 原生的入口：
 *   - 同步：状态栏（点击即可）、命令面板「立即同步 CalDAV」、自动同步
 *   - 插入日记：命令面板「把今日日程与待办插入日记」
 *   - 设置：设置 → 第三方插件 → CalDAV Calendar and Tasks
 */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type CalDavPlugin from "@/main";
import { ICON_ID, VIEW_TYPE_CALDAV } from "@/constants";
import { renderPanel } from "./panel";

export class CalDavView extends ItemView {
  private plugin: CalDavPlugin;
  private panel: { destroy: () => void; refresh: () => void } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CalDavPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CALDAV;
  }

  getDisplayText(): string {
    // 与 manifest.name 保持一致：社区目录要求 name 为纯 Basic Latin，
    // 页签标题若仍是中文会与插件名不一致（截图、标签页都显示这个）
    return "CalDAV Calendar and Tasks";
  }

  getIcon(): string {
    return ICON_ID;
  }

  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.addClass("caldav-view");

    // 主体交给完整面板；它自带 store 订阅，数据变化会自行重渲染
    const body = el.createDiv({ cls: "caldav-view-body" });
    this.panel = renderPanel(body, this.plugin.mainCtx);

    this.renderNotConfiguredIfNeeded();
  }

  async onClose(): Promise<void> {
    this.panel?.destroy();
    this.panel = null;
  }

  /** 入口在同步完成后调用 */
  refresh(): void {
    this.panel?.refresh();
    this.renderNotConfiguredIfNeeded();
  }

  /** 配置缺失 / 密码解不开 / 上次同步报错 —— 都要显式说明，否则用户只看到空面板 */
  private renderNotConfiguredIfNeeded(): void {
    const el = this.contentEl;
    el.querySelectorAll(".caldav-status").forEach((n) => n.remove());
    const store = this.plugin.store;
    const issue = store.credentialsIssue();
    const msg = issue
      ? issue
      : store.lastError
        ? "同步错误：" + store.lastError
        : "";
    if (!msg) return;
    const bar = el.createDiv({ cls: "caldav-status is-error", text: msg });
    // 插到面板之前（面板本身没有这类宿主级提示位）
    const body = el.querySelector(".caldav-view-body");
    if (body) el.insertBefore(bar, body);
  }
}
