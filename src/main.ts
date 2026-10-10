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
import { ButtonComponent, Modal, Notice, Plugin, TFile, normalizePath, type App, type Workspace, type WorkspaceLeaf } from "obsidian";
import { CalStore } from "@/core/store";
import { SyncEngine, type SyncReport } from "@/core/sync";
import type { CalItem, CalSettings } from "@/core/types";
import { occurrencesInRange } from "@/core/ics";
import { parseLocalStamp, todayStamp, fmtTime } from "@/core/date";
import {
  diarySpanOf,
  spanContains,
  diaryTargetStamp,
  targetOptionsOf,
  type DiaryRange,
  type DiaryTarget,
} from "@/ui/diary-range";
import { setTransport } from "@/core/http";
import { ReminderEngine } from "@/core/reminder";
import { obsidianTransport } from "@/obs/http-transport";
import { isMobile } from "@/obs/platform";
import { initLocale, t } from "@/i18n";
import { CalDavView } from "@/ui/main-view";
import { CalDavDockView } from "@/ui/dock-view";
import {
  notifyDockAllUndone,
  notifyDockExitDetail,
  notifyDockItemDetail,
  notifyDockScope,
  TOGGLE_DOCK_EVENT,
  TOGGLE_DOCK_ITEM_EVENT,
  type FocusScope,
} from "@/ui/panel";
import { initialViewMode } from "@/ui/view-pref";
import { CalDavSettingTab } from "@/ui/settings-tab";
import { todoDueOccurrences } from "@/ui/view-common";
import { clearReminderToasts, showReminderToast } from "@/ui/reminder-toast";
import type { PanelCtx, ViewMode } from "@/ui/panel-ctx";
import { DOCK_VIEW_TYPE, ICON_ID, VIEW_TYPE_CALDAV } from "@/constants";
import type { TimerHandle } from "./constants";
import {
  backupTimeText,
  buildBackup,
  clearBackup,
  describeBackup,
  hasPlaintextPassword,
  isBackupUseful,
  looksFreshInstall,
  readBackup,
  writeBackup,
  type BackupPayload
} from "@/core/config-backup";

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

/**
 * 把叶子页带到前台，兼容 Obsidian 1.5.0~ 1.7.1。
 *
 * ## 为什么需要这个助手
 *
 * 社区扫描的 `no-unsupported-api` 规则报出`workspace.revealLeaf()` ——
 * 该API **@since 1.7.2**，而本插件 `minAppVersion` 是 1.5.0，属于「声明支持
 * 却调用了更高版本 API」。规则要求改代码而不是抬 `minAppVersion`（抬了会把
 * 仍在用 1.5~1.7 的用户挡在门外）。
 *
 * `setActiveLeaf()` 的`@since` 是 **0.16.3**，远早于 1.5.0，全程安全。
 *
 * ## 行为差异（可接受）
 *
 * `revealLeaf` 若叶子在侧栏里会**顺手展开侧栏**；`setActiveLeaf` 不会。
 * 本插件的 Dock 位于右侧栏，理论上会有差别 —— 但：
 *   1. 两处调用点（`activateView` / `activateDock`）在调用前都已确保视图存在，
 *      侧栏若折叠则用户根本看不到入口，不会走到这里；
 *   2. `activateDock` 里 `getRightLeaf(false)` 本身就会展开侧栏，展开动作
 *      已经发生，不依赖 `revealLeaf`。
 * 故用 `setActiveLeaf` 足够。
 *
 * 仍做能力检测：万一未来 Obsidian 改名或移除，两种方式都能安全退化。
 */
function bringLeafToFront(workspace: Workspace, leaf: WorkspaceLeaf): void {
  const ws = workspace as unknown as {
    revealLeaf?: (l: WorkspaceLeaf) => Promise<void>;
    setActiveLeaf?: (l: WorkspaceLeaf) => void;
  };
  if (typeof ws.revealLeaf === "function") {
    void ws.revealLeaf(leaf);
    return;
  }
  ws.setActiveLeaf?.(leaf);
}

/**
 * 判断 `leaf` 是否挂在 `targetRoot` 这个分栏里。
 *
 * ⚠️ **两侧都拿不到时必须返回 false，绝不能让 undefined === undefined 成立。**
 *
 * 这不是洁癖，是实测踩过的坑：原先 `getRoot()` 出错时 catch 返回 `false`、
 * 目标分栏也可能是 undefined，但那时 `false === undefined` 为假，恰好安全。
 * 改成 `leafRoot()` / `splitOf()` 两个助手后，**两边都变成 undefined**，
 * 于是 `undefined === undefined` 成立 ——「取不到根节点」被误判成
 * 「正好在主区」，进而让 `toggleDock` 的三态判断整体错位：
 * 右击单元格该切月视图的却隐藏了侧栏，右击条目该展开的却收起。
 *
 * `WorkspaceRoot` 是稳定公开 API（obsidian.d.ts 有声明），取不到说明
 * Obsidian 变了，此时**保守判「不在目标区」**才是安全侧。
 */
function leafInSplit(leaf: WorkspaceLeaf, targetRoot: unknown): boolean {
  if (targetRoot === undefined || targetRoot === null) return false;
  const root = leafRoot(leaf);
  if (root === undefined || root === null) return false;
  return root === targetRoot;
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
export interface HostSettings {
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
  /**
   * 界面语言：`"zh"` / `"en"` / `undefined`（跟随 Obsidian）。
   *
   * 不设默认值 —— 用户没选过就跟随 Obsidian 界面语言，这是绝大多数人的预期。
   */
  language?: "zh" | "en";
}

export default class CalDavPlugin extends Plugin {
  store!: CalStore;
  sync!: SyncEngine;
  mainCtx!: PanelCtx;

  private reminder?: ReminderEngine;
  private statusBarEl?: HTMLElement;
  /** 「稍后提醒」的定时器：卸载时要一并清掉，否则会在插件停用后仍触发 */
  private snoozeTimers = new Set<TimerHandle>();
  /** 配置备份的去抖定时器（见 syncBackupSoon） */
  private backupTimer: TimerHandle | null = null;
  /** 上次写备份时的配置指纹，用来判「配置是否真的变了」（见 settingsFingerprint） */
  private lastBackupFingerprint = "";
  /**
   * 正在跑的同步（null = 空闲）。
   * 用 promise 而非 boolean：并发调用方要能**等**上一轮跑完再接上，
   * 单纯 `if (syncing) return` 会把请求静默丢掉（见 runSync）。
   */
  private inflight: Promise<SyncReport | undefined> | null = null;

  async onload(): Promise<void> {
    // ① 注入宿主传输实现 —— 必须最先做，core/http.ts 依赖它发请求
    setTransport(obsidianTransport);

    // ② 数据层：Obsidian 的 loadData/saveData 与思源语义一致（后者多一个文件名参数）
    //    先把原始数据取出来判「是否新装」—— loadData() 只能调一次（缓存了），
    //    所以这里手动取一次并注入给 store。
    const rawLoaded = (await this.loadData()) as unknown;
    this.store = new CalStore({
      loadData: async () => rawLoaded,
      saveData: (d) => this.saveData(d),
    });
    await this.store.load();

    // ②.5 配置备份：卸载插件会连 data.json 一起删掉，重装后设置全丢。
    // 这里在数据还在内存里时另存一份到 .obsidian/caldav-calendar-tasks/backup.json
    // （卸载只删 plugins/<id>/ 一个目录，这个位置不受影响），并在「新装且有备份」
    // 时问用户要不要恢复。详见 core/config-backup.ts。
    const fresh = looksFreshInstall(rawLoaded);
    if (fresh) void this.offerRestore();
    else {
      // 先把当前指纹记下来，否则首次 onChange 会被误判成「配置变了」而白写一轮
      this.lastBackupFingerprint = this.settingsFingerprint(this.store.settings);
      void this.syncBackupSoon();
    }

    // 语言要在数据加载后初始化 —— 用户可能手动指定过语言，值存在插件数据里。
    initLocale(this.hostSettings().language);

    this.sync = new SyncEngine(this.store, () => this.store.settings.channel);
    this.mainCtx = this.createCtx();

    // ③ 数据变化 → 重算提醒排程 + 刷新状态栏
    this.store.onChange(() => {
      this.reconcileReminders();
      this.reminder?.reschedule();
      this.updateStatusBar();
      // 配置一变就排队备份。用户改服务器/日历/分类全走这里 ——
      // 之前只在 onload 排过一次，等于「改完配置再卸载」必然丢备份。
      // onChange 也会被勾待办、拖颜色这类高频操作触发，所以下面按内容判重。
      this.scheduleBackupIfSettingsChanged();
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
    // 卸载前把「最后一刻的改动」落盘。
    //
    // 为什么要在这里再存一次：persist 与备份各自是去抖的（400ms / 3s），
    // 用户改完配置不到一秒就卸载的话，两个定时器都会在卸载时被清掉 ——
    // 结果是 data.json 还是旧的，而 data.json 紧接着就被卸载删掉。
    // adapter 全是 async、构建目标又是 browser（拿不到 fs），无法同步写；
    // 这里只能发起 async 写。Obsidian 停用插件不会立刻销毁进程，实测能落盘；
    // 即便没落上也还有备份兜底，不是唯一一道保险。
    void this.store?.persist();
    if (this.backupTimer) window.clearTimeout(this.backupTimer);
    void this.syncBackup();
  }

  // ────────────────────── 配置备份（卸载后重装免重配） ──────────────────────

  /**
   * 把当前配置另存一份到 `.obsidian/caldav-calendar-tasks/backup.json`。
   *
   * ## 为什么必须去抖
   *
   * `persist()` 本身是 400ms 去抖的，但它触发得**很频繁**（勾一个待办、
   * 拖一次颜色都算）。备份是一次真实的磁盘写，跟着每次都写会让同步备份文件
   * 变成 IO 热点；而且 Obsidian 的 `adapter.write` 在移动端还可能跨进程。
   * 这里再叠一层 3 秒去抖：配置改动通常在 3 秒内会连续来好几下，合并成一次写。
   *
   * ## 为什么用磁盘形态（密文）而不是内存明文
   *
   * `store.settings.password` 在内存里是**明文**（store 加载时解开了）。
   * 直接把它写进备份就是明文密码落盘 —— 即使文件在 `.obsidian/` 里，
   * 这也是我们不该做的事（备份比 data.json 更可能被用户复制出去）。
   * 正确做法是复用 `persist()` 存到 `data.json` 的那一份形态：密码是密文。
   */
  private syncBackupSoon(): void {
    if (this.backupTimer) window.clearTimeout(this.backupTimer);
    this.backupTimer = window.setTimeout(() => void this.syncBackup(), 3000);
  }

  /**
   * 配置指纹：只有它变了才需要重新写备份。
   *
   * `store.onChange` 触发得极频繁（勾一个待办、拖一次颜色都算），若无条件排队
   * 备份，同步一次就会写一轮磁盘 —— 而备份文件里并不含 items，这些写入纯属浪费。
   * 指纹只取「用户配置」相关字段，items 的变化不会引起它变化。
   */
  private settingsFingerprint(s: CalSettings): string {
    return JSON.stringify([
      s.serverUrl,
      s.username,
      s.password,
      s.channel,
      s.syncIntervalMin,
      s.enableReminders,
      s.conflict,
      s.pastDays,
      s.futureDays,
      s.showTodosInCalendar,
      s.categoryMulti,
      (s.calendars || []).map((c) => [c.url, c.displayName, c.eventColor, c.todoColor, c.enabled]),
      (s.categories || []).map((c) => [c.name, c.color])
    ]);
  }

  /**
   * store 变化后：配置指纹变了才排队备份。
   *
   * 判重放在这里（而不是 syncBackup 里）是为了让「没变就不排队」，
   * 省掉高频操作下的定时器反复重设。
   */
  private scheduleBackupIfSettingsChanged(): void {
    if (!this.store) return;
    const fp = this.settingsFingerprint(this.store.settings);
    if (fp === this.lastBackupFingerprint) return;
    this.lastBackupFingerprint = fp;
    this.syncBackupSoon();
  }

  /**
   * 实际写备份。
   *
   * 走 `store.persist()` 落盘的同一份数据形状：为此临时调一次 persist 的
   * 数据构造不方便（persist 是 async 且带解密逻辑），所以改为**读回磁盘**
   * —— 刚保存完的 `data.json` 就是最权威的磁盘形态，直接复制它的 settings。
   * 若读不到（极端情况，如刚改完还没落盘就卸载），就退回内存值并**把密码
   * 整个剔除**：宁可不备份密码，也不能把明文写出去。
   */
  private async syncBackup(): Promise<void> {
    this.backupTimer = null;
    if (!this.store) return;
    let settings = this.store.settings;
    try {
      // 优先读回磁盘形态（data.json 里那一份密码是密文，直接拿它就是安全的）。
      // ⚠️ onunload 里调用时**读不到最新值** —— Obsidian 在停用插件后可能已让
      // loadData 返回卸载前的缓存。所以卸载路径由调用方先 await persist()，
      // 这里的读只是兜底；拿不到就退回内存值并**整个剔除密码**。
      const disk = (await this.loadData()) as { settings?: CalSettings } | null;
      if (disk?.settings?.password !== undefined) settings = disk.settings;
      else settings = { ...settings, password: "" };
    } catch {
      settings = { ...settings, password: "" };
    }
    const payload = buildBackup(settings, this.store.keyring);
    // 最后一道闸：万一上游逻辑变了、备份里出现明文密码，宁可不写。
    if (hasPlaintextPassword(payload)) return;
    await writeBackup(this.app, payload);
  }

  /**
   * 新装且检测到备份时，问用户要不要恢复。
   *
   * 刻意**不静默恢复**：用户重装插件的原因可能正是「想推倒重来」（比如换
   * 服务器、或之前配置搞坏了）。静默恢复会把这部分人 stuck 在旧配置里，
   * 而他们既不知道发生了什么、也不知道怎么清掉 —— 比重新配一次更糟。
   *
   * 三条前置检查（任一不满足就当没有备份）：
   *   ① 备份读得出来且格式对；
   *   ② 备份里确有实质内容（否则空备份只是噪音）；
   *   ③ 备份里没有明文密码（有的话宁可不恢复，也不能把明文搬进 data.json）。
   *
   * 其中 ② 已经涵盖「v3 密文却没带 keyring」这一种（见 isBackupUseful）：
   * 那份备份恢复了也必然解不开密码，弹窗只会让用户白点一次、
   * 然后对着「密码解不开（密文可能来自另一台设备）」这句提示费解——
   * 密钥不匹配与「设备不对」是两回事，提示语容易把人引向错误的排查方向。
   * 这种备份直接当没有，让用户走「重新填密码」：一次输入换新本机密钥，
   * 之后自动备份就是完整的了。
   */
  private async offerRestore(): Promise<void> {
    let backup: BackupPayload | undefined;
    try {
      backup = await readBackup(this.app);
    } catch {
      return;
    }
    if (!backup || !isBackupUseful(backup)) return;
    if (hasPlaintextPassword(backup)) return;

    new RestoreConfigModal(this.app, backup, {
      onRestore: async () => {
        // ⚠️ 重新读一次磁盘，**不要**用弹窗打开时捕获的那份快照。
        // offerRestore() 在弹窗弹出时就读好了 backup 并传进来，而弹窗可能停留很久；
        // 期间备份文件完全可能已被改写（自动备份会覆写它，见 writeBackup）。
        // 拿旧快照恢复 ⇒ 恢复的是一份已经不存在的配置。
        //
        // 真实事故（2026-10-09）：弹窗弹出时 backup.json 还没有 keyring，
        // 几分钟后另一处把正确的 keyring 写进了磁盘文件，用户此时点「恢复」——
        // 恢复的仍是内存里那份没有 keyring 的旧快照，于是 adoptKeyring("") 回退到
        // localStorage 里的**另一把**密钥，配不上密文，永久性mismatch，
        // 还把写回磁盘的 backup.json 一起污染成错配对。
        //
        // 读失败（文件被删/损坏）就退回最初那份：宁可恢复一份旧配置，
        // 也别在用户点确认的瞬间什么都不做。
        let payload = backup;
        try {
          const fresh = await readBackup(this.app);
          if (fresh && isBackupUseful(fresh)) payload = fresh;
        } catch {
          /* 保留最初那份 */
        }

        // 恢复 = 把备份里的设置整份写进 store，再立刻落盘。
        // keyring 一并交回：它必须与密文同时到位，否则密码解不开。
        //
        // ⚠️ 必须 await adoptBackup —— 它内部要解密码（异步 WebCrypto），
        // 不等就往下走的话，此刻 settings.password 还是密文，同步必然 401，
        // 落盘还会把密文套一层。用户看到的就是「恢复了但一条都没回来」。
        await this.store.adoptBackup(payload);
        await this.store.persist();
        new Notice(t("backup.restored", { host: describeBackup(payload) }));
        // 恢复后马上同步一次：让用户立刻看到条目回来，也顺便验证配置真的可用。
        // manual=true → 出结果给提示（含失败原因），否则这次同步是「静默」的，
        // 万一密码/地址有问题用户只会看到一片空日历。
        await this.runSync(true);
      },
      onDismiss: async () => {
        // 点「不恢复」= 用户想重新配 → 把备份删掉，否则每次重装都问一遍
        await clearBackup(this.app);
        new Notice(t("backup.skipped"));
      }
    }).open();
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
      // 两侧任一取不到都判「不在目标区」，理由见 leafInSplit 的注释
      return leafInSplit(leaf, targetRoot);
    };

    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CALDAV);
    const hit = leaves.find(inTarget);
    if (hit) {
      bringLeafToFront(workspace, hit);
      return;
    }
    // 同一视图不该存在多份：清掉其它位置的实例再在目标位置重开
    for (const l of leaves) l.detach();

    const leaf =
      mode === "main" ? workspace.getLeaf("tab") : (workspace.getRightLeaf(false) ?? workspace.getLeaf("tab"));
    await leaf.setViewState({ type: VIEW_TYPE_CALDAV, active: true });
    bringLeafToFront(workspace, leaf);
  }

  /**
   * 打开（或聚焦）右侧栏的 Dock 面板 —— 原思源插件左侧 Dock 的对应物。
   * 侧栏若未展开，`getRightLeaf(false)` 会自动展开它。
   */
  async activateDock(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(DOCK_VIEW_TYPE);
    if (existing.length > 0) {
      bringLeafToFront(workspace, existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: DOCK_VIEW_TYPE, active: true });
    bringLeafToFront(workspace, leaf);
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
    // ⓿ 详情模式 → 退出详情，**保留当前清单筛选**。
    //    必须排在下面两个判断之前：详情是覆盖在列表之上的一层界面，此刻
    //    focusDate / dockFilter 都没变（仍是进入详情前那一份），所以
    //    isDefaultState() 会返回 true —— 若不先处理，②会切到该格子所在月，
    //    而 renderDockList 因detailKey 非空仍渲染详情，界面看上去毫无反应。
    if (view.isDetailState()) {
      notifyDockExitDetail();
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
      return leafInSplit(leaf, splitOf(workspace, "rootSplit"));
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
      // ⚠️ 必须把 range / target 都透传下去 —— 写成 `() => this.insertTodayToDiary()`
      // 会**吞掉传入的选择**，永远走默认 "day" + "today"。症状：选「本周/本月/所有」
      // 却提示「当日没有日程或待办」（2026-10-07 雄哥实测发现）。
      insertTodayToDiary: (range, target) => this.insertTodayToDiary(range, target),
      unsaved: new Set(),
      // 恢复上次使用的视图（2026-10-07 雄哥要求）；无记录时为月视图。
      // 纯 UI 偏好，存 localStorage 而非 data.json —— 理由见 ui/view-pref.ts。
      viewMode: initialViewMode(),
      cursor: todayStamp(),
      sortMode: "start",
      testReminder: () => this.testReminder(),
      reminderStatus: () => this.reminderStatus(),
      // 工具栏同步按钮：走 runSync，状态栏/视图/提醒/Notice 都由它统一负责
      syncNow: () => this.runSync(true),
      isSyncing: () => this.inflight !== null,
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
    // 已有同步在跑 → 等它跑完再跑一轮，而不是直接返回。
    // 静默丢弃的代价很实在：恢复配置后紧接着的首轮同步正好会被启动时的
    // 那次自动同步顶掉，于是「恢复了却没拉回数据」（2026-10-09 雄哥反馈）。
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* 上一轮的结果与本次无关，忽略 */
      }
    }
    const task = this.doRunSync(manual);
    this.inflight = task;
    try {
      return await task;
    } finally {
      if (this.inflight === task) this.inflight = null;
    }
  }

  /** runSync 的真正 bodies（调用方已处理并发排队） */
  private async doRunSync(manual: boolean): Promise<SyncReport | undefined> {
    if (this.statusBarEl) this.statusBarEl.setText(t("statusBarSyncing"));
    try {
      const report = await this.sync.syncAll();
      this.updateStatusBar();
      this.refreshViews();
      this.reminder?.reschedule();

      if (report.errors.length > 0) {
        this.notify(t("sync.doneWithErrors", { count: report.errors.length, first: report.errors[0] ?? "" }), "error");
      } else if (manual) {
        this.notify(
          t("sync.done", {
            fetched: report.fetched,
            uploaded: report.uploaded,
            deleted: report.deleted,
            ms: report.elapsedMs,
          })
        );
      }
      return report;
    } catch (e) {
      this.updateStatusBar();
      this.notify(t("sync.failed", { msg: String((e as Error)?.message || e) }), "error");
      return undefined;
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const err = this.store.lastError;
    if (err) {
      this.statusBarEl.setText(`${t("statusBarError")}：${err.slice(0, 24)}`);
      this.statusBarEl.addClass("caldav-status-is-error");
      this.statusBarEl.removeClass("caldav-status-is-note");
      return;
    }
    // 对账提示是**中性信息**，不是失败 —— 不能复用「同步失败」的前缀，
    // 否则一次成功同步会被报成失败（2026-10-10 实测）。
    const note = this.store.lastNote;
    if (note) {
      this.statusBarEl.setText(`${t("statusBarNote")}：${note.slice(0, 24)}`);
      this.statusBarEl.addClass("caldav-status-is-note");
      this.statusBarEl.removeClass("caldav-status-is-error");
      return;
    }
    const when = this.store.lastSync ? this.store.lastSync.slice(5, 16).replace("T", " ") : t("sync.never");
    this.statusBarEl.setText(`${t("statusBarIdle")} · ${when}`);
    this.statusBarEl.removeClass("caldav-status-is-error");
    this.statusBarEl.removeClass("caldav-status-is-note");
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
    if (isMobile()) return t("reminder.mobileUnsupported");
    if (!this.store.settings.enableReminders) return t("reminder.notEnabled");
    if (!this.reminder) return t("reminder.engineDown");
    return t("reminder.scheduled", { count: this.reminder.count(), armed: this.reminder.armedCount() });
  }

  private reminderText(item: CalItem, anchorISO: string, alarmMin: number): { title: string; body: string } {
    const kind = item.kind === "todo" ? t("kindTodo") : t("kindEvent");
    const when = item.allDay ? t("time.allDay") : fmtTime(anchorISO);
    const ahead = alarmMin > 0 ? t("reminder.noticeAhead", { count: alarmMin }) : "";
    const title = `${kind} · ${item.summary || t("chip.noTitle")}`;
    const lines = [t("reminder.noticeTimeLine", { when: `${when}${ahead}` })];
    if (item.location) lines.push(t("reminder.noticeLocationLine", { loc: item.location }));
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
    if (isMobile()) return this.notify(t("reminder.mobileNotice"));
    if (!this.store.settings.enableReminders) return this.notify(t("reminder.enableFirst"), "error");
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
   * 重复点击是「刷新」而非无限追加：靠小节标题定位旧小节并整段替换
   * （标题随插入范围变化，故按实际写入的那一行匹配，见 writeDiarySection）。
   */
  /**
   * 把日程与待办插入日记。
   *
   * 2026-10-07 雄哥要求：原按钮直接插「今日」，改为**先问范围**
   * （当日 / 本周 / 本月 / 所有，默认当日）。故签名从无参改为收范围，
   * 默认值仍是 "day" —— 命令行调用（`insertTodayToDiary` 那条）与旧行为一致。
   * 2026-10-08 再加一层**目标**：写到今天的日记还是区间首日的日记
   * （本周=周一 / 本月=1 号），默认 "today"。
   *
   * 范围计算见 ui/diary-range.ts（纯函数，有契约测试）。
   */
  // ⚠️ 第二个参数名叫 `diaryTarget` 而非 `target`：下面已有 `let target: TFile`
  // （日记文件对象），同名会静默撞车 —— 类型检查都未必照得出来。
  async insertTodayToDiary(
    range: DiaryRange = "day",
    diaryTarget: DiaryTarget = "today"
  ): Promise<string> {
    try {
      const span = diarySpanOf(range);
      const startMs = parseLocalStamp(span.from + "T00:00:00").getTime();
      const endMs = parseLocalStamp(span.toExclusive + "T00:00:00").getTime();
      const today = todayStamp();
      const targetLabel =
        targetOptionsOf(range, today).find((o) => o.key === diaryTarget)?.short ??
        t("diary.target.todayShort");
      const enabled = new Set(
        this.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url)
      );

      // 收集落在区间内的实例：日程展开重复规则，待办取到期时刻
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
          if (!Number.isFinite(ms) || !spanContains(span, ms)) continue;
          const timed = !it.allDay && /T\d{1,2}:\d{2}/.test(occ);
          const mark = it.kind === "todo" ? "☑️" : "📅";
          rows.push({
            ms,
            line: `- ${mark} ${timed ? occ.slice(11, 16) : t("time.allDay")} ${it.summary || t("chip.noTitle")}`,
          });
        }
      }
      rows.sort((a, b) => a.ms - b.ms);
      if (!rows.length) return this.notify(t("diary.noItems", { label: span.label }));

      const md = `## ${span.sectionTitle}\n${rows.map((r) => r.line).join("\n")}\n`;

      // 日记文件：默认今天；选「本周/本月 + 区间首日」时换成周一 / 1 号。
      // ⚠️ 走 diaryTargetStamp 收敛 —— 「所有」的区间首日是 1900-01-01 那个哨兵，
      // 直接拿来命名会去建一篇 1900 年的日记。
      const targetStamp = diaryTargetStamp(range, diaryTarget, today);
      const folder = this.getDailyNoteFolder();
      const path = normalizePath(folder ? `${folder}/${targetStamp}.md` : `${targetStamp}.md`);
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
        t("diary.written", {
          verb: t(replaced ? "diary.verbUpdate" : "diary.verbWrite"),
          section: span.sectionTitle,
          count: rows.length,
          target: targetLabel,
        })
      );
    } catch (e) {
      // 静默失败会让用户以为没执行而重复点击，异常必须有反馈
      return this.notify(t("diary.insertFailed", { msg: String((e as Error)?.message || e) }), "error");
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
   *
   * ⚠️ `sectionTitle` 必须由调用方传入**实际要写的那一行标题**，不能用固定常量。
   * 2026-10-07 起跨日范围的小节标题带区间（如「日程与待办（10-06 ~ 10-12）」），
   * 若这里仍按常量匹配，就永远命中不了 —— 结果是每次点击都**追加一个重复小节**，
   * 而「重复点击是刷新而非追加」的设计意图失效。
   */
  private async writeDiarySection(file: TFile, md: string): Promise<boolean> {
    let replaced = false;
    const block = md.trimEnd().split("\n");
    const header = block[0]; //形如 "##日程与待办（…）"，与 md 首行一致
    await this.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const start = lines.findIndex((l) => l.trim() === header.trim());
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
    if (patch.language !== undefined) this.applyLanguage();
    await this.store.persist();
    this.reconcileReminders();
  }

  /**
   * 按当前语言设置切换界面语言，并让已打开的面板/侧栏立即重渲染。
   *
   * 语言是**插件级 UI 状态**而非数据，所以这里只换字典 + 重渲染，
   * 不碰 store —— 数据层与语言无关，切语言不该触发重新同步。
   */
  applyLanguage(): void {
    initLocale(this.hostSettings().language);
    // 面板与 Dock 订阅 store 的变化，但语言切换不产生 store 变化，
    // 故需手动触发一次重渲染，否则用户改完语言要等到下次打开面板才生效。
    this.store.notify();
    this.updateStatusBar();
  }
}

/**
 * 「检测到上次的配置，是否恢复？」确认弹窗。
 *
 * 为什么用 `Modal` 而不是 `Notice` + 命令：这是个**需要用户做决定**的分叉
 * （恢复 / 不恢复），通知条只能点一下、没有第二个按钮，也不该在自动消失后
 * 让人错过的同时把备份删掉。`Modal` 有明确的两个按钮，Esc 视为「不恢复」。
 *
 * 刻意用 `Modal`（而非 `FuzzySuggestModal` 之类）：这是一次性确认，
 * 不该占用搜索入口、也不该出现在命令面板里。
 */
class RestoreConfigModal extends Modal {
  constructor(
    app: App,
    private readonly backup: BackupPayload,
    private readonly handlers: {
      onRestore: () => Promise<void>;
      onDismiss: () => Promise<void>;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("backup.title") });

    // 说清「这份备份是什么时候的、里面有什么」—— 用户据此判断要不要恢复，
    // 而不是盲点一个按钮。时间解析不了就显示兜底文案，别露出 "Invalid Date"。
    contentEl.createEl("p", {
      text: t("backup.found", {
        host: describeBackup(this.backup),
        when: backupTimeText(this.backup, t("backup.unknownTime"))
      })
    });
    contentEl.createEl("p", { text: t("backup.hint") });

    const row = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(row)
      .setButtonText(t("backup.restore"))
      .setCta()
      .onClick(() => {
        void this.handlers.onRestore();
        this.close();
      });
    new ButtonComponent(row).setButtonText(t("backup.skip")).onClick(() => {
      void this.handlers.onDismiss();
      this.close();
    });
  }

  onClose(): void {
    // 关掉弹窗（含 Esc / 点遮罩）一律按「不恢复」处理：
    // 留着备份只会让下次重装再问一遍，而用户已经用行动表示了「不需要」。
    this.contentEl.empty();
  }
}
