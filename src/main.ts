/**
 * CalDAV Calendar and Tasks —— Obsidian 插件入口
 *
 * 由思源版 `src/index.ts`（957 行）重写而来。宿主差异对照：
 *
 *   addDock + addTab 双承载      →  registerView 单 ItemView
 *   openTab / 移动端全屏 Dialog  →  统一 View（Obsidian 两端共用，无 Dialog 分支）
 *   addTopBar                    →  addRibbonIcon
 *   addIcons                     →  addIcon
 *   showMessage                  →  Notice
 *   loadData(name)/saveData(name)→  loadData()/saveData()（单文件 data.json）
 *   内核 API（SQL / 块操作）      →  Vault API
 *   setDirectFallbackToProxy     →  删除（Obsidian 请求无 CORS）
 *
 * 原版为承载「移动端没有页签栏」而写的一整套 Dialog 层级管理（mobile-layers.ts、
 * dialog-resize.ts）在 Obsidian 下不需要，已整体移除。
 */
import { Notice, Plugin, TFile, normalizePath, type App, type WorkspaceLeaf } from "obsidian";
import { CalStore } from "@/core/store";
import { SyncEngine, type SyncReport } from "@/core/sync";
import type { CalItem, CalSettings } from "@/core/types";
import { occurrencesInRange } from "@/core/ics";
import { parseLocalStamp, todayStamp, fmtTime } from "@/core/date";
import { setTransport } from "@/core/http";
import { ReminderEngine } from "@/core/reminder";
import { obsidianTransport } from "@/obs/http-transport";
import { isMobile } from "@/obs/platform";
import { initLocale, t } from "@/i18n";
import { CalDavView } from "@/ui/main-view";
import { CalDavDockView } from "@/ui/dock-view";
import {
  notifyDockAllUndone,
  notifyDockItemDetail,
  notifyDockScope,
  TOGGLE_DOCK_EVENT,
  TOGGLE_DOCK_ITEM_EVENT,
  type FocusScope,
} from "@/ui/panel";
import { CalDavSettingTab } from "@/ui/settings-tab";
import { todoDueOccurrences } from "@/ui/view-common";
import { clearReminderToasts, showReminderToast } from "@/ui/reminder-toast";
import type { PanelCtx, ViewMode } from "@/ui/panel-ctx";
import { DIARY_SECTION_TITLE, DOCK_VIEW_TYPE, ICON_ID, VIEW_TYPE_CALDAV } from "@/constants";
import type { TimerHandle } from "./constants";

export { VIEW_TYPE_CALDAV };

/**
 * Obsidian **未公开** API 的最小结构声明。
 *
 * 下列成员确实存在于运行时，但不在 `obsidian` 包的类型定义里：
 *   - `WorkspaceLeaf.getRoot()`：判断叶子挂在哪个分栏（主区/ 侧栏）
 *   - `Workspace.rootSplit` / `rightSplit`：两个分栏根节点
 *   - `App.setting`：打开设置页
 *   - `App.internalPlugins`：读内置插件实例（如 daily-notes 的日记目录）
 *
 * 原先这些位置一律写 `(x as any).foo`，社区扫描会报 `Unexpected any`。
 * 改为**声明用到的最小形状**并用可选链兜底：类型安全的同时，
 * 万一未来 Obsidian 改名/移除，也只是取到 undefined 而非崩在方法调用上。
 */
interface ObsidianInternals {
  getRoot?: () => unknown;
  rootSplit?: unknown;
  rightSplit?: unknown;
}

/** 读叶子页所属的根分栏节点；API 变更时返回 undefined */
function leafRoot(leaf: WorkspaceLeaf): unknown {
  try {
    return (leaf as unknown as ObsidianInternals).getRoot?.();
  } catch {
    return undefined;
  }
}

function splitOf(ws: unknown, which: "rootSplit" | "rightSplit"): unknown {
  return (ws as ObsidianInternals | undefined)?.[which];
}

interface AppInternals {
  setting?: { open?: () => void; openTabById?: (id: string) => void };
  internalPlugins?: {
    getPluginById?: (id: string) => { instance?: { options?: { folder?: unknown } } } | undefined;
  };
}

function internals(app: App): AppInternals {
  return app as unknown as AppInternals;
}

/** 插件额外设置：不属于 CalSettings 的宿主侧项（存进同一份 data.settings，不污染 core 类型） */
interface HostSettings {
  dailyNoteFolder?: string;
  /** 桌面端是否同时弹系统通知（应用内 Notice 之外） */
  systemNotification?: boolean;
  /**
   * 视图位置迁移标记。
   * 早期版本把面板开在右侧栏，Obsidian 会把视图位置写进 workspace.json，
   * 重启后照样在侧栏恢复 —— 所以升级后必须主动迁一次，且只做一次：
   * 之后尊重用户自己的摆放（他想拖回侧栏也不再干预）。
   */
  viewPlacedInMain?: boolean;
  /** Dock 是否已自动打开过一次（只自动开一次，之后尊重用户的手动关闭） */
  dockAutoOpened?: boolean;
}

export default class CalDavPlugin extends Plugin {
  store!: CalStore;
  sync!: SyncEngine;
  mainCtx!: PanelCtx;

  private reminder?: ReminderEngine;
  private statusBarEl?: HTMLElement;
  /** 「稍后提醒」的定时器：卸载时要一并清掉，否则会在插件停用后仍触发 */
  private snoozeTimers = new Set<TimerHandle>();

  async onload(): Promise<void> {
    // ① 注入宿主传输实现 —— 必须最先做，core/http.ts 依赖它发请求
    setTransport(obsidianTransport);
    initLocale();

    // ② 数据层：Obsidian 的 loadData/saveData 与思源语义一致（后者多一个文件名参数）
    this.store = new CalStore({
      loadData: () => this.loadData(),
      saveData: (d) => this.saveData(d),
    });
    await this.store.load();

    this.sync = new SyncEngine(this.store, () => this.store.settings.channel);
    this.mainCtx = this.createCtx();

    // ③ 数据变化 → 重算提醒排程 + 刷新状态栏
    this.store.onChange(() => {
      this.reconcileReminders();
      this.reminder?.reschedule();
      this.updateStatusBar();
    });

    // ④ 视图与入口
    this.registerView(VIEW_TYPE_CALDAV, (leaf: WorkspaceLeaf) => new CalDavView(leaf, this));
    this.registerView(DOCK_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CalDavDockView(leaf, this));
    this.addRibbonIcon(ICON_ID, t("openPanel"), () => void this.activateView());

    this.addCommand({
      id: "open-panel",
      name: t("openPanel"),
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "sync-now",
      name: t("syncNow"),
      callback: () => void this.runSync(true),
    });
    this.addCommand({
      id: "insert-today-to-diary",
      name: t("insertToday"),
      callback: () => void this.insertTodayToDiary(),
    });
    this.addCommand({
      id: "test-reminder",
      name: t("testReminder"),
      callback: () => void this.testReminder(),
    });
    this.addCommand({
      id: "open-in-right-sidebar",
      name: t("openInSidebar"),
      callback: () => void this.activateView("right"),
    });
    this.addCommand({
      id: "open-dock",
      name: t("openDock"),
      callback: () => void this.activateDock(),
    });

    this.addSettingTab(new CalDavSettingTab(this.app, this));

    // ⑤ 状态栏
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("caldav-status");
    this.statusBarEl.onClickEvent(() => void this.runSync(true));
    this.updateStatusBar();

    // ⑥ 自动同步
    if (this.store.settings.syncIntervalMin > 0) {
      this.sync.startAutoSync(() => this.reminder?.reschedule());
    }
    // 启动后延迟首同步：等 Obsidian 完成布局加载，避免与启动流程抢 IO
    this.app.workspace.onLayoutReady(() => {
      // 先校正视图位置（升级后把遗留在侧栏的主面板迁到主区域），再开 Dock、延迟首同步
      this.ensureViewPlacement();
      this.ensureDockOpen();
      window.setTimeout(() => void this.runSync(false), 1500);
    });

    this.reconcileReminders();

    /**
     * 双击日历空白处 → 显示 / 隐藏右侧栏（详见 toggleDock 的说明）。
     *
     * 这里用原生 addEventListener 而非 this.registerDomEvent：后者的类型签名限定在
     * 标准事件名（keyof DocumentEventMap）内，自定义事件名过不了类型检查。
     */
    const onToggleDock = (e: Event): void => {
      const date = (e as CustomEvent).detail as string;
      if (date) this.toggleDock(date);
    };
    document.addEventListener(TOGGLE_DOCK_EVENT, onToggleDock);
    this.register(() => document.removeEventListener(TOGGLE_DOCK_EVENT, onToggleDock));

    /** 右击条目 → 开 / 收右侧栏并展示该条目详情 */
    const onToggleDockItem = (e: Event): void => {
      const key = (e as CustomEvent).detail as string;
      if (key) this.toggleDockItem(key);
    };
    document.addEventListener(TOGGLE_DOCK_ITEM_EVENT, onToggleDockItem);
    this.register(() => document.removeEventListener(TOGGLE_DOCK_ITEM_EVENT, onToggleDockItem));
  }

  onunload(): void {
    this.sync?.stopAutoSync();
    this.reminder?.stop();
    this.reminder = undefined;
    // 清掉浮层与「稍后提醒」定时器：否则插件停用后仍会弹出提醒卡片
    clearReminderToasts();
    for (const t of this.snoozeTimers) window.clearTimeout(t);
    this.snoozeTimers.clear();
  }

  // ─────────────────────────── 视图 ───────────────────────────

  /**
   * 打开日历面板。
   *
   * 默认在**主编辑区新开标签页**，而不是塞进右侧栏 —— 日历面板（尤其月/周视图）
   * 在 300px 宽的侧栏里会被压扁，主区域才有足够宽度，也与库内其它日历插件
   * （Ogenda 等）的打开位置一致。想常驻侧栏可用命令「在右侧栏打开」。
   */
  async activateView(mode: "main" | "right" = "main", viewMode?: ViewMode): Promise<void> {
    // Dock 的「日历视图 / 任务视图」按钮会带 viewMode 过来：先写进上下文并让已挂载的
    // 面板重渲染，这样即便主面板已经开着也能立即切换（而不是只把标签页聚焦一下）。
    if (viewMode) {
      this.mainCtx.viewMode = viewMode;
      this.mainCtx.navigate?.(viewMode);
    }
    const { workspace } = this.app;
    const targetRoot = mode === "main" ? splitOf(workspace, "rootSplit") : splitOf(workspace, "rightSplit");
    const inTarget = (leaf: WorkspaceLeaf): boolean => {
      // getRoot / rootSplit / rightSplit 未出现在公开类型定义里，splitOf 与
      // leafRoot 声明了最小形状并用可选链兜底
      return leafRoot(leaf) === targetRoot;
    };

    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CALDAV);
    const hit = leaves.find(inTarget);
    if (hit) {
      void workspace.revealLeaf(hit);
      return;
    }
    // 同一视图不该存在多份：清掉其它位置的实例再在目标位置重开
    for (const l of leaves) l.detach();

    const leaf =
      mode === "main" ? workspace.getLeaf("tab") : (workspace.getRightLeaf(false) ?? workspace.getLeaf("tab"));
    await leaf.setViewState({ type: VIEW_TYPE_CALDAV, active: true });
    void workspace.revealLeaf(leaf);
  }

  /**
   * 打开（或聚焦）右侧栏的 Dock 面板 —— 原思源插件左侧 Dock 的对应物。
   * 侧栏若未展开，`getRightLeaf(false)` 会自动展开它。
   */
  async activateDock(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(DOCK_VIEW_TYPE);
    if (existing.length > 0) {
      void workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: DOCK_VIEW_TYPE, active: true });
    void workspace.revealLeaf(leaf);
  }

  /**
   * 双击日历空白处 → 按「右侧栏当前处于哪一态」决定行为（行为表定义的三态循环）：
   *
   *   ① 右侧栏隐藏（不存在 / 已被折叠）→ 展开它，并切到「所有未完成」
   *   ② 已打开且为「所有未完成」        → 切到该格子日期所在的月 / 周清单（不隐藏）
   *   ③ 已打开且已聚焦（月 / 周）       → 隐藏右侧栏
   *
   * ⚠️ 表格用的是「隐藏」而非「关闭」：指把**整个右侧栏折叠起来**（rightSplit.collapse），
   * 而不是把插件视图 detach 掉 —— 视图实例保留，再展开时它还保持着原来的状态。
   * 用 collapse / expand 而不是 detach，也是「隐藏 ▸ 打开」能配成一对的原因。
   *
   * ②③ 靠 Dock 自报状态判断，而不是在入口侧另记一份 —— 用户可能在下拉里手动切过筛选，
   * 入口无从得知。
   *
   * @param date 所点格子的日期（"YYYY-MM-DD"），②态据此决定聚焦到哪一月 / 周
   */
  private toggleDock(date: string): void {
    const { workspace } = this.app;
    const rightSplit = workspace.rightSplit;
    const isCollapsed = !!rightSplit?.collapsed;
    const leaves = workspace.getLeavesOfType(DOCK_VIEW_TYPE);

    // ① 视图不存在、或整个右侧栏被折叠 → 展开 + 「所有未完成」
    if (leaves.length === 0 || isCollapsed) {
      void this.activateDock().then(() => {
        try {
          rightSplit?.expand();
        } catch {
          /* 展开失败（如右侧栏被禁用）就忽略 —— 视图本身已经开出来了 */
        }
        notifyDockAllUndone();
      });
      return;
    }

    const view = leaves[0].view;
    if (!(view instanceof CalDavDockView)) {
      notifyDockAllUndone();
      return;
    }
    // ② 已打开且为「所有未完成」→ 切到该格子日期所在的月 / 周
    //    粒度按主面板当前视图取：周 / 日视图 → 该周；年 / 月 / 任务视图 → 该月
    if (view.isDefaultState()) {
      const m = this.mainCtx.viewMode;
      const scope: FocusScope = m === "week" || m === "day" ? "week" : "month";
      notifyDockScope(date, scope);
      return;
    }
    // ③ 隐藏 = 折叠整个右侧栏。
    //    条件：已聚焦到某月 / 某周，**或者当前处于日视图** ——
    //    表格对日视图单独放宽：日视图下不必再走一遍「切到所在周」，第二次右击直接收起。
    if (view.isScopedState() || this.mainCtx.viewMode === "day") {
      try {
        rightSplit?.collapse();
      } catch {
        // 折叠不可用则退回关闭视图，至少保证能收起
        leaves[0].detach();
      }
      return;
    }
    // 兜底：用户手动选过预设筛选 → 回到「所有未完成」
    notifyDockAllUndone();
  }

  /**
   * 右击条目 → 开 / 收右侧栏并展示该条目详情。
   *
   * 只有两态（与单元格那个三态不同）：隐藏 → 打开并显示详情；已打开 → 收起。
   * 与 toggleDock 的区别是它不碰清单筛选，打开时右侧栏直接进「详情模式」。
   */
  private toggleDockItem(key: string): void {
    const { workspace } = this.app;
    const rightSplit = workspace.rightSplit;
    const isCollapsed = !!rightSplit?.collapsed;
    const leaves = workspace.getLeavesOfType(DOCK_VIEW_TYPE);

    // ① 右侧栏隐藏（视图不存在 / 已折叠）→ 展开并显示该条目详情
    if (leaves.length === 0 || isCollapsed) {
      void this.activateDock().then(() => {
        try {
          rightSplit?.expand();
        } catch {
          /* 展开失败就忽略 —— 视图本身已经开出来了 */
        }
        notifyDockItemDetail(key);
      });
      return;
    }
    // ② 已打开 → 收起
    try {
      rightSplit?.collapse();
    } catch {
      // 折叠不可用则退回关闭视图，至少保证能收起
      leaves[0].detach();
    }
  }

  /**
   * 首次加载时把 Dock 打开到右侧栏（只开一次）。
   *
   * 为什么只做一次：Dock 是插件的主要入口，升级后应让用户立刻看到它出现在右侧栏；
   * 但用户若主动关掉，就不该每次加载又给他弹回来 —— 之后交给命令 / Ribbon 手动打开。
   */
  private ensureDockOpen(): void {
    if (this.hostSettings().dockAutoOpened) return;
    void this.updateHostSettings({ dockAutoOpened: true });
    if (this.app.workspace.getLeavesOfType(DOCK_VIEW_TYPE).length > 0) return;
    void this.activateDock();
  }

  /**
   * 把历史遗留的「侧栏承载」视图迁到主区域（只做一次）。
   *
   * 为什么必须主动做：Obsidian 会把视图位置持久化到 workspace.json，重启后按原样
   * 恢复 —— 光把 activateView 改成主区域，用户不动手就永远看不到变化。
   * 迁移后置 viewPlacedInMain 标记，此后尊重用户自己的摆放。
   */
  private ensureViewPlacement(): void {
    if (this.hostSettings().viewPlacedInMain) return;
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CALDAV);

    const markDone = () => void this.updateHostSettings({ viewPlacedInMain: true });
    if (!leaves.length) {
      markDone();
      return;
    }
    const inMain = (leaf: WorkspaceLeaf): boolean => {
      return leafRoot(leaf) === splitOf(workspace, "rootSplit");
    };
    const inSidebar = leaves.filter((l) => !inMain(l));
    if (!inSidebar.length) {
      markDone();
      return;
    }
    const hadMain = leaves.length > inSidebar.length;
    for (const l of inSidebar) l.detach();
    markDone();
    if (!hadMain) void this.activateView("main");
  }

  /** 刷新所有已打开的面板（数据变化后由视图自行订阅，此处供外部调用） */
  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALDAV)) {
      if (leaf.view instanceof CalDavView) leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(DOCK_VIEW_TYPE)) {
      if (leaf.view instanceof CalDavDockView) leaf.view.refresh();
    }
  }

  // ─────────────────────────── 上下文 ───────────────────────────

  private createCtx(): PanelCtx {
    return {
      store: this.store,
      sync: this.sync,
      app: this.app,
      i18n: (k) => t(k),
      openSettings: () => this.openSetting(),
      insertTodayToDiary: () => this.insertTodayToDiary(),
      unsaved: new Set(),
      viewMode: "month" as ViewMode,
      cursor: todayStamp(),
      sortMode: "start",
      testReminder: () => this.testReminder(),
      reminderStatus: () => this.reminderStatus(),
    };
  }

  /** 供设置界面调用：打开设置页 */
  openSetting(): void {
    const setting = internals(this.app).setting;
    setting?.open?.();
    setting?.openTabById?.(this.manifest.id);
  }

  // ─────────────────────────── 同步 ───────────────────────────

  /** 执行同步；manual=true 时无论结果都给出提示（自动同步只在出错时提示） */
  async runSync(manual: boolean): Promise<SyncReport | undefined> {
    if (this.statusBarEl) this.statusBarEl.setText(t("statusBarSyncing"));
    try {
      const report = await this.sync.syncAll();
      this.updateStatusBar();
      this.refreshViews();
      this.reminder?.reschedule();

      if (report.errors.length > 0) {
        this.notify(`同步完成，但有 ${report.errors.length} 个错误：${report.errors[0]}`, "error");
      } else if (manual) {
        this.notify(
          `同步完成：拉取 ${report.fetched} · 上传 ${report.uploaded} · 删除 ${report.deleted}（${report.elapsedMs}ms）`
        );
      }
      return report;
    } catch (e) {
      this.updateStatusBar();
      this.notify(`同步失败：${(e as Error)?.message || e}`, "error");
      return undefined;
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const err = this.store.lastError;
    if (err) {
      this.statusBarEl.setText(`${t("statusBarError")}：${err.slice(0, 24)}`);
      return;
    }
    const when = this.store.lastSync ? this.store.lastSync.slice(5, 16).replace("T", " ") : "未同步";
    this.statusBarEl.setText(`${t("statusBarIdle")} · ${when}`);
  }

  // ─────────────────────────── 提醒 ───────────────────────────

  private reconcileReminders(): void {
    // 移动端系统通知通道不稳，只在桌面端启用提醒引擎（与思源版策略一致）
    const want = !!this.store.settings.enableReminders && !isMobile();
    if (want && !this.reminder) {
      this.reminder = new ReminderEngine(
        () => this.store.getAll(),
        (item, anchorISO, alarmMin) => this.fireReminder(item, anchorISO, alarmMin)
      );
      this.reminder.start();
    } else if (!want && this.reminder) {
      this.reminder.stop();
      this.reminder = undefined;
    }
  }

  private reminderStatus(): string {
    if (isMobile()) return "移动端不启用系统通知";
    if (!this.store.settings.enableReminders) return "未开启提醒";
    if (!this.reminder) return "提醒引擎未运行（重新勾选保存可重启）";
    return `已排程 ${this.reminder.count()} 条 · 带提醒时间的条目 ${this.reminder.armedCount()} 个`;
  }

  private reminderText(item: CalItem, anchorISO: string, alarmMin: number): { title: string; body: string } {
    const kind = item.kind === "todo" ? "待办" : "日程";
    const when = item.allDay ? "全天" : fmtTime(anchorISO);
    const ahead = alarmMin > 0 ? ` · ${alarmMin} 分钟前提醒` : "";
    const title = `【${kind}】${item.summary || "(无标题)"}`;
    const lines = [`时间：${when}${ahead}`];
    if (item.location) lines.push(`地点：${item.location}`);
    return { title, body: lines.join("\n") };
  }

  /**
   * 提醒投递。
   *
   * 与原思源版的通道对照：
   *   ① `showReminderToast`（自研浮层，带「打开」「稍后提醒」）→ **保留**，零宿主依赖
   *   ② `notifySystem`（系统通知）→ **保留**，桌面端可选
   *   ③ `showMessage`（思源站内提示）→ `Notice`
   *   ④ `pushMsg`（思源通知中心留存）→ Obsidian 无对应，由 ③ 承担
   *
   * 浮层为主通道：它是纯 DOM 实现，在 Obsidian 渲染进程里必然可见，
   * 因此不必像思源版那样再叠一条 Notice 兜底（那会让一次提醒弹两层，很吵）。
   */
  private fireReminder(item: CalItem, anchorISO: string, alarmMin: number): void {
    const { title, body } = this.reminderText(item, anchorISO, alarmMin);
    const open = () => void this.activateView();

    showReminderToast({
      title,
      body,
      onOpen: open,
      onSnooze: (min) => this.snoozeReminder(item, anchorISO, alarmMin, min),
    });

    if (this.hostSettings().systemNotification && !isMobile()) {
      this.notifySystem(title, body, open);
    }
  }

  /** 系统通知：失败只记日志，不影响浮层通道（Windows 便携版缺快捷方式时常失败） */
  private notifySystem(title: string, body: string, onClick: () => void): void {
    try {
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      const n = new Notification(title, { body, silent: false });
      n.onclick = () => {
        try {
          onClick();
        } catch {
          /* 忽略 */
        }
        try {
          n.close();
        } catch {
          /* 忽略 */
        }
      };
      // 20 秒后自动收起，避免通知中心堆积
      const t = window.setTimeout(() => {
        this.snoozeTimers.delete(t);
        try {
          n.close();
        } catch {
          /* 忽略 */
        }
      }, 20000);
      this.snoozeTimers.add(t);
    } catch (e) {
      // 系统通知不可用时的降级提示。保留 warn 而非删除：这是唯一能留下诊断线索的地方
      // ——应用内浮层会照常提醒用户，功能不受影响，但用户报障时需要据此判断是
      // 「通知权限被拒」还是「构造通知抛异常」。用 warn 不用 log/info，避免被当作噪音。
      console.warn("[caldav] 系统通知不可用，已由应用内浮层承担:", e);
    }
  }

  /** 稍后提醒：N 分钟后再走一遍同一投递链路（仅本次会话有效，不写入 ICS） */
  private snoozeReminder(item: CalItem, anchorISO: string, alarmMin: number, minutes: number): void {
    const t = window.setTimeout(() => {
      this.snoozeTimers.delete(t);
      this.fireReminder(item, anchorISO, alarmMin);
    }, Math.max(1, minutes) * 60000);
    this.snoozeTimers.add(t);
  }

  async testReminder(): Promise<string> {
    if (isMobile()) return this.notify("移动端不启用系统通知，仅应用内提示可用");
    if (!this.store.settings.enableReminders) return this.notify("请先在设置中开启提醒", "error");
    this.reconcileReminders();
    return this.notify(this.reminderStatus());
  }

  // ─────────────────────────── 日记 ───────────────────────────

  /**
   * 把今日日程与待办写入日记。
   *
   * 与思源版的差异（宿主 API 全部替换，业务逻辑保持一致）：
   *   /api/query/sql 找日记文档  →  Vault 按路径查找（目录可配置）
   *   /api/block/insertBlock     →  vault.process() 整体重写
   *   /api/block/deleteBlock     →  同上，一次替换小节，无需先删后插
   *   openTab({doc:{id}})        →  workspace.getLeaf().openFile()
   *
   * 重复点击是「刷新」而非无限追加：靠 DIARY_SECTION_TITLE 定位旧小节并整段替换。
   */
  async insertTodayToDiary(): Promise<string> {
    try {
      const today = todayStamp();
      const startMs = parseLocalStamp(today + "T00:00:00").getTime();
      const endMs = startMs + 86400000;
      const enabled = new Set(
        this.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url)
      );

      // 收集真正落在今天的实例：日程展开重复规则，待办取到期时刻
      const rows: { ms: number; line: string }[] = [];
      for (const it of this.store.getAll()) {
        if (it.deleted || it.dirty || !enabled.has(it.calendarUrl)) continue;
        if (it.kind === "todo" && it.percent === 100) continue;
        const occs =
          it.kind === "todo"
            ? todoDueOccurrences(it, startMs, endMs)
            : occurrencesInRange(it, startMs, endMs);
        for (const occ of occs) {
          if (!occ) continue;
          const ms = parseLocalStamp(occ).getTime();
          if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
          const timed = !it.allDay && /T\d{1,2}:\d{2}/.test(occ);
          const mark = it.kind === "todo" ? "☑️" : "📅";
          rows.push({
            ms,
            line: `- ${mark} ${timed ? occ.slice(11, 16) : "全天"} ${it.summary || "(无标题)"}`,
          });
        }
      }
      rows.sort((a, b) => a.ms - b.ms);
      if (!rows.length) return this.notify("今天没有日程或待办");

      const md = `## ${DIARY_SECTION_TITLE}\n${rows.map((r) => r.line).join("\n")}\n`;

      const folder = this.getDailyNoteFolder();
      const path = normalizePath(folder ? `${folder}/${today}.md` : `${today}.md`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      // 用 instanceof 窄化而非 `as TFile` 强转（官方规则）：强转会掩盖
      // 「路径其实指向 TFolder」的情况，写入时才炸。
      let target: TFile;
      if (existing instanceof TFile) {
        target = existing;
      } else {
        // 目录不存在时先补建，再创建日记
        if (folder && !this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
          await this.app.vault.createFolder(normalizePath(folder)).catch(() => undefined);
        }
        target = await this.app.vault.create(path, "");
      }

      const replaced = await this.writeDiarySection(target, md);
      await this.app.workspace.getLeaf(false).openFile(target);

      return this.notify(
        `已${replaced ? "更新" : "写入"}今日日记「${DIARY_SECTION_TITLE}」${rows.length} 条`
      );
    } catch (e) {
      // 静默失败会让用户以为没执行而重复点击，异常必须有反馈
      return this.notify(`插入日记失败：${(e as Error)?.message || e}`, "error");
    }
  }

  /**
   * 日记目录：优先用户设置，其次读核心「日记」插件配置，最后落库根目录。
   * 读核心插件用的是内部 API（Obsidian 未公开日记配置的读取接口），失败即回退。
   */
  private getDailyNoteFolder(): string {
    const s = this.store.settings as CalSettings & HostSettings;
    if (typeof s.dailyNoteFolder === "string" && s.dailyNoteFolder.trim()) {
      return s.dailyNoteFolder.trim();
    }
    try {
      const dn = internals(this.app).internalPlugins?.getPluginById?.("daily-notes");
      const folder = dn?.instance?.options?.folder;
      if (typeof folder === "string" && folder.trim()) return folder.trim();
    } catch {
      /* 内部 API 不可用：回退库根 */
    }
    return "";
  }

  /**
   * 写入 / 替换日记中的目标小节。
   * 返回 true 表示命中了已有小节并替换，false 表示追加到文末。
   */
  private async writeDiarySection(file: TFile, md: string): Promise<boolean> {
    let replaced = false;
    const block = md.trimEnd().split("\n");
    await this.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const start = lines.findIndex((l) => l.trim() === `## ${DIARY_SECTION_TITLE}`);
      if (start >= 0) {
        // 小节范围：到下一个同级或更高级标题为止（含空行），文件尾则到末尾
        let end = lines.length;
        for (let i = start + 1; i < lines.length; i++) {
          if (/^#{1,2}\s/.test(lines[i])) {
            end = i;
            break;
          }
        }
        replaced = true;
        const before = lines.slice(0, start);
        const after = lines.slice(end);
        return [...before, ...block, "", ...after].join("\n");
      }
      const base = data.trimEnd();
      return (base ? base + "\n\n" : "") + block.join("\n") + "\n";
    });
    return replaced;
  }

  // ─────────────────────────── 工具 ───────────────────────────

  /** 统一反馈出口：应用内提示 + 返回文案（命令面板与调用方复用同一句） */
  notify(text: string, type: "info" | "error" = "info"): string {
    new Notice(text, type === "error" ? 5000 : 3000);
    return text;
  }

  /** 读取宿主侧设置（dailyNoteFolder 等，存于同一份 data.settings） */
  hostSettings(): HostSettings {
    return this.store.settings as CalSettings & HostSettings;
  }

  /** 修改宿主侧设置并落盘 */
  async updateHostSettings(patch: Partial<HostSettings>): Promise<void> {
    Object.assign(this.store.settings as CalSettings & HostSettings, patch);
    await this.store.persist();
    this.reconcileReminders();
  }
}
