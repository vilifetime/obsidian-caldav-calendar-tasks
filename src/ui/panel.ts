/**
 * 面板骨架：
 *  - 主窗口页签形态：顶部工具栏（年/月/周/日 切换 + 导航 + 新增 + 日历筛选）+ 视图容器
 *  - 左侧 Dock：标题「日历任务管理」+ 一行 5 个按钮（新增、排序、日历视图、任务视图、刷新）
 * Dock 负责导航与新增/排序/刷新，主面板只呈现日历视图。
 */
import type { CalStore } from "../core/store";
import { keyOf } from "../core/store";
import type { CalItem, SortMode } from "../core/types";
import { DEFAULT_CATEGORIES, calEventColor } from "../core/types";
import { occurrencesInRange } from "../core/ics";
import { parseLocalStamp, stampOfMs, todayStamp, startOfWeek, addDays, isDateOnly, fmtTime, fmtDateCn, diffDays } from "../core/date";
import { icons } from "./icons";
import { isMobile } from "@/obs/platform";
import { openEditor } from "./editor";
import { openDateAddMenu } from "./date-add-menu";
import { renderMonthView } from "./view-month";
import { renderWeekView } from "./view-week";
import { renderTaskView } from "./view-task";
import { renderYearView } from "./view-year";
import { todoDueOccurrences } from "./view-common";
import { setHtml } from "./dom";

/**
 * `PanelCtx` 与 `ViewMode` 原本定义在本文件内，移植时抽到了 `./panel-ctx`。
 *
 * 原因：view-common.ts / editor.ts / date-add-menu.ts / category-manager.ts 都只需要
 * 这个**类型**，若定义在此处，它们就得 import 整个面板实现（而面板又反向依赖各视图
 * 与编辑器），在类型层面形成环。此处 re-export，原调用方的 import 路径保持不变。
 */
export type { PanelCtx, ViewMode } from "./panel-ctx";
import type { PanelCtx, ViewMode } from "./panel-ctx";
import type { TimerHandle } from "../constants";

export function renderPanel(root: HTMLElement, ctx: PanelCtx): { destroy: () => void; refresh: () => void } {
  root.classList.add("caldav-root");
  // 触摸形态标记：移动端日历格子里放不下「时间 + 标题」，只留标题（见 index.css .caldav-touch）。
  // 用类而不是媒体查询，桌面端把窗口拖窄时仍保留时间列。
  root.classList.toggle("caldav-touch", isMobile());
  setHtml(
    root,
    `
<div class="caldav-app caldav-app--flat">
  <main class="caldav-main">
    <header class="caldav-toolbar">
      <div class="caldav-toolbar-left">
        <button class="caldav-icon-btn" data-action="prev" title="上一页">${icons.prev}</button>
        <button class="caldav-btn" data-action="today">今天</button>
        <button class="caldav-icon-btn" data-action="next" title="下一页">${icons.next}</button>
        <span class="caldav-cursor-title"></span>
      </div>
      <div class="caldav-toolbar-center">
        <div class="caldav-seg" role="tablist" aria-label="视图切换">
          <button class="caldav-seg-btn" data-view="year">年</button>
          <button class="caldav-seg-btn" data-view="month">月</button>
          <button class="caldav-seg-btn" data-view="week">周</button>
          <button class="caldav-seg-btn" data-view="day">日</button>
        </div>
      </div>
      <div class="caldav-toolbar-right">
        <button class="caldav-btn caldav-btn-primary" data-action="new">${icons.plus} 新建</button>
        <div class="caldav-calfilter-wrap">
          <button class="caldav-icon-btn" data-action="calfilter" title="日历筛选">${icons.layers}</button>
          <div class="caldav-calfilter-pop" data-pop="calfilter" hidden>
            <div class="caldav-cal-head">日历筛选</div>
            <div class="caldav-cal-list"></div>
            <label class="caldav-switch-line caldav-switch-line--inline caldav-calfilter-opt">
              <span class="caldav-switch-label">日历视图中显示待办任务</span>
              <span class="caldav-switch">
                <input type="checkbox" data-opt="showTodos"/>
                <span class="caldav-switch-track"></span>
              </span>
            </label>
            <div class="caldav-calfilter-foot">
              <button class="caldav-link" data-action="insert-diary">把今日日程与待办插入日记</button>
            </div>
          </div>
        </div>
        <button class="caldav-icon-btn" data-action="toggle-view" title="切换到任务视图" aria-label="切换到任务视图"></button>
      </div>
    </header>
    <div class="caldav-view"></div>
  </main>
</div>
<div class="caldav-ctxmenu" hidden>
  <button class="caldav-ctxmenu-item" data-ctx="edit">${icons.pencil} 编辑</button>
  <button class="caldav-ctxmenu-item" data-ctx="delete">${icons.trash} 删除</button>
  <div class="caldav-ctxmenu-err" hidden></div>
</div>`
  );

  const app = root.querySelector(".caldav-app") as HTMLElement;
  const calListEl = root.querySelector(".caldav-cal-list") as HTMLElement;
  const calfilterPop = root.querySelector(".caldav-calfilter-pop") as HTMLElement;
  const showTodosInput = root.querySelector('[data-opt="showTodos"]') as HTMLInputElement;
  const viewEl = root.querySelector(".caldav-view") as HTMLElement;
  const cursorTitleEl = root.querySelector(".caldav-cursor-title") as HTMLElement;
  const ctxMenu = root.querySelector(".caldav-ctxmenu") as HTMLElement;
  const segBtns = Array.from(root.querySelectorAll(".caldav-seg-btn")) as HTMLElement[];
  const viewToggleBtn = root.querySelector('[data-action="toggle-view"]') as HTMLElement;
  let destroyed = false;
  /** 右键菜单当前指向的条目 key */
  let ctxMenuKey: string | null = null;

  function renderCalList(): void {
    const cals = ctx.store.settings.calendars;
    if (!cals.length) {
      setHtml(
        calListEl,
        `<div class="caldav-cal-empty">尚未配置服务器<br><button class="caldav-link" data-action="settings">去配置 →</button></div>`
      );
      return;
    }
    setHtml(
      calListEl,
      cals
      .map(
        (c, i) => `
      <div class="caldav-cal-item ${c.enabled ? "" : "is-off"}" data-cal="${i}"
           title="${c.enabled ? "点击在视图中隐藏此日历" : "点击在视图中显示此日历"}">
        <span class="caldav-cal-dot" style="background:${calEventColor(c)}"></span>
        <span class="caldav-cal-name" title="${escapeAttr(c.url)}">${escapeHtml(c.displayName)}</span>
        <button class="caldav-icon-btn caldav-cal-toggle" type="button"
                aria-pressed="${c.enabled ? "true" : "false"}"
                title="${c.enabled ? "隐藏此日历" : "显示此日历"}"
                aria-label="${c.enabled ? "隐藏此日历" : "显示此日历"}">${c.enabled ? icons.eye : icons.eyeOff}</button>
      </div>`
      )
      .join("")
    );
  }

  /**
   * 切换某个日历的启用状态（眼睛按钮 / 整行点击）。
   * 关掉后：日历视图、任务视图、Dock 列表与计数同时不再包含该日历的条目（都读 settings.calendars[].enabled）。
   * persist() 不触发 onChange，所以这里必须自己 renderAll()。
   */
  function toggleCalendar(idx: number): void {
    const cal = ctx.store.settings.calendars[idx];
    if (!cal) return;
    cal.enabled = !cal.enabled;
    void ctx.store.persist();
    renderAll();
  }

  /** 「日历视图中显示待办任务」开关：未设置过（老数据）按开启处理 */
  function todosShownInCalendar(): boolean {
    return ctx.store.settings.showTodosInCalendar !== false;
  }

  function renderFilterOpts(): void {
    showTodosInput.checked = todosShownInCalendar();
  }

  function cursorTitle(): string {
    const c = ctx.cursor;
    if (ctx.viewMode === "year") return `${+c.slice(0, 4)} 年`;
    if (ctx.viewMode === "month") return `${+c.slice(0, 4)} 年 ${+c.slice(5, 7)} 月`;
    if (ctx.viewMode === "week") {
      const ws = startOfWeek(c);
      const we = addDays(ws, 6);
      return `${fmtDateCn(ws)} – ${fmtDateCn(we)}`;
    }
    if (ctx.viewMode === "day") return `${+c.slice(0, 4)} 年 ${+c.slice(5, 7)} 月 ${+c.slice(8, 10)} 日`;
    return "待办任务";
  }

  function renderToolbarState(): void {
    segBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.view === ctx.viewMode));
    app.classList.toggle("is-task", ctx.viewMode === "task");
    cursorTitleEl.textContent = cursorTitle();
    renderViewToggle();
  }

  /** 视图切换按钮：图标表示「点击后将切换到的视图」，标题同步说明，随当前视图模式更新 */
  function renderViewToggle(): void {
    const toTask = ctx.viewMode !== "task";
    setHtml(viewToggleBtn, toTask ? icons.taskList : icons.calCheck);
    const label = toTask ? "切换到任务视图" : "切换到日历视图";
    viewToggleBtn.title = label;
    viewToggleBtn.setAttribute("aria-label", label);
  }

  /** 当前启用日历下、时间窗内的展开实例（待办按到期日，见 view-common.todoDueOccurrences） */
  function visibleOccurrences(startMs: number, endMs: number): Map<CalItem, string[]> {
    const enabled = new Set(ctx.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url));
    const showTodos = todosShownInCalendar();
    const out = new Map<CalItem, string[]>();
    for (const it of ctx.store.getAll()) {
      if (it.deleted) continue;
      if (!enabled.has(it.calendarUrl)) continue;
      // 只影响日历视图（年/月/周/日）：关掉开关后只留日程事件。
      // 任务视图自己收集待办（见 view-task.ts），不读这个开关，因此不受影响。
      if (!showTodos && it.kind === "todo") continue;
      const occ =
        it.kind === "todo" ? todoDueOccurrences(it, startMs, endMs) : occurrencesInRange(it, startMs, endMs);
      if (occ.length) out.set(it, occ);
    }
    return out;
  }

  /**
   * 当前聚焦的日期格子（右侧栏正显示这一天的清单）。
   *
   * 表格要求：单击某格且未聚焦时，「聚焦该日**并加深单元格边框**」，再单击同格则取消。
   * 视图切换会重建 DOM，故在 renderView 末尾统一恢复高亮，而不是只在点击时标一次。
   */
  let selectedDay: string | null = null;

  /**
   * 选中的小时（0–23，仅周 / 日视图有意义）。
   * 时间轴不整列框住，而是只框「点中的那 1 小时」—— 顶部日头一框 + 该小时一框，
   * 两段高亮。月 / 年视图没有小时概念，保持 null。
   */
  let selectedHour: number | null = null;

  function markSelectedDay(cell: HTMLElement | null, hour: number | null = null): void {
    selectedDay = cell?.dataset.day || null;
    selectedHour = selectedDay ? hour : null;
    applySelectedDay();
  }

  function applySelectedDay(): void {
    root.querySelectorAll<HTMLElement>("[data-day]").forEach((c) => {
      // 时间轴列（.cal-wk-col）不再整列高亮 —— 改为只标所点的那一小时（见下方）
      if (c.classList.contains("cal-wk-col")) {
        c.classList.remove("is-selected");
        return;
      }
      // 月 / 年视图里相邻月份的补白格子（is-out）可能与当前月同日，不参与高亮
      const hit = !!selectedDay && c.dataset.day === selectedDay && !c.classList.contains("is-out");
      c.classList.toggle("is-selected", hit);
    });

    // 小时块：绝对定位在对应列内。用百分比定位，免得和格子高度常量（HOUR_H）耦合。
    root.querySelectorAll<HTMLElement>(".cal-wk-selected-hour").forEach((n) => n.remove());
    if (!selectedDay || selectedHour == null) return;
    const col = root.querySelector<HTMLElement>(`.cal-wk-col[data-day="${selectedDay}"]`);
    if (!col) return;
    const box = col.createDiv({ cls: "cal-wk-selected-hour" });
    box.style.top = `${(selectedHour / 24) * 100}%`;
    box.style.height = `${100 / 24}%`;
    col.appendChild(box);
  }

  /**
   * 点击位置对应的小时（0–23）。只在时间轴列（.cal-wk-col）上有意义 ——
   * 月 / 年视图的格子、以及周视图顶部的日头都不分小时，返回 null。
   */
  function hourFromClick(cell: HTMLElement, ev: MouseEvent): number | null {
    if (!cell.classList.contains("cal-wk-col")) return null;
    const rect = cell.getBoundingClientRect();
    if (!rect.height) return null;
    const ratio = (ev.clientY - rect.top) / rect.height;
    return Math.min(23, Math.max(0, Math.floor(ratio * 24)));
  }

  function renderView(): void {
    renderToolbarState();
    const args = { ctx, viewEl, occurrences: visibleOccurrences };
    if (ctx.viewMode === "year") renderYearView(args);
    else if (ctx.viewMode === "month") renderMonthView(args);
    else if (ctx.viewMode === "week") renderWeekView(args, 7);
    else if (ctx.viewMode === "day") renderWeekView(args, 1);
    else renderTaskView(args);
    // DOM 刚被重建，恢复选中格高亮
    applySelectedDay();
  }

  function renderAll(): void {
    if (destroyed) return;
    hideCtxMenu();
    renderCalList();
    renderFilterOpts();
    renderView();
  }

  // ---- 右键菜单（日历/任务视图上的条目） ----
  const ctxErrEl = ctxMenu.querySelector(".caldav-ctxmenu-err") as HTMLElement;
  const ctxDelBtn = ctxMenu.querySelector('[data-ctx="delete"]') as HTMLElement;
  let ctxDisarmTimer: TimerHandle | null = null;

  function resetCtxDelete(): void {
    if (ctxDisarmTimer) {
      window.clearTimeout(ctxDisarmTimer);
      ctxDisarmTimer = null;
    }
    ctxDelBtn.classList.remove("is-armed");
    setHtml(ctxDelBtn, `${icons.trash} 删除`);
  }

  function hideCtxMenu(): void {
    if (ctxMenu.hidden) return;
    ctxMenu.hidden = true;
    ctxMenuKey = null;
    resetCtxDelete();
    ctxErrEl.hidden = true;
    ctxErrEl.textContent = "";
  }

  /** 在鼠标位置展开菜单，并做视口边界收敛 */
  function showCtxMenu(key: string, x: number, y: number): void {
    ctxMenuKey = key;
    ctxErrEl.hidden = true;
    ctxErrEl.textContent = "";
    resetCtxDelete();

    /**
     * 必须先挂到 body 下再定位。
     *
     * 菜单用 position:fixed，而 Obsidian 的视图容器带 `contain`（paint / layout）——
     * 这会让容器成为 fixed 元素的**包含块**：于是 ev.clientX（视口坐标）被当成相对
     * 容器的坐标，菜单整体右移一个「左栏宽度」，看起来跑到很远的地方。
     * 挂到 body 下即恢复以视口为参照（与 .caldav-add-menu 的做法一致）。
     * 点击监听本就绑在 ctxMenu 自身（见下方 on(ctxMenu, ...)），移动元素不影响。
     */
    if (ctxMenu.parentElement !== document.body) document.body.appendChild(ctxMenu);

    ctxMenu.hidden = false;
    // 先显示再量尺寸，否则 offsetWidth 为 0
    const w = ctxMenu.offsetWidth;
    const h = ctxMenu.offsetHeight;
    const pad = 8;
    const left = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - h - pad));
    ctxMenu.style.left = `${left}px`;
    ctxMenu.style.top = `${top}px`;
  }

  // ---- 条目菜单触发：桌面右键 / 触摸长按 ----
  // 触摸端长按是桌面右键的等价操作。不能只靠 contextmenu：iOS 的 WKWebView 不派发
  // contextmenu；Android WebView 长按则两者都触发，用时间戳去重避免菜单重复展开。
  const LONG_PRESS_MS = 480;
  const PRESS_MOVE_TOLERANCE = 10;
  let lastLongPressAt = 0;
  let pressTimer: TimerHandle | null = null;
  let pressPoint = { x: 0, y: 0 };
  let longPressFired = false;

  function clearPressTimer(): void {
    if (pressTimer) {
      window.clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  /**
   * 注册监听并登记撤销。
   * 面板根元素与右键菜单都可能被复用（移动端 Dock 容器长期存活、思源会重建侧栏），
   * 漏摘监听就会在同一元素上叠加处理器 —— 一次点击触发多次动作。
   */
  const offs: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (ev: HTMLElementEventMap[K]) => void,
    opts?: boolean | AddEventListenerOptions
  ): void => {
    el.addEventListener(type, fn as EventListener, opts);
    offs.push(() => el.removeEventListener(type, fn as EventListener, opts));
  };
  const offAll = (): void => offs.splice(0).forEach((off) => off());

  /**
   * 单击的延迟计时器。
   *
   * 单击与双击共存于同一元素时，浏览器必定**先派发 click、再派发 dblclick**。
   * 若单击立刻生效，双击的第一下就会先把状态改成「聚焦该日」，等第二下到达时 Dock
   * 已处于聚焦态，于是走到「关闭右侧栏」而不是「切到该日所在月 / 周」——
   * 表现就是**双击的三态循环卡住**（实测反馈）。
   *
   * 故单击延后 250ms 执行：期间若来了第二下，就取消挂起的单击、只按双击处理。
   */
  let clickTimer: TimerHandle | null = null;

  function cancelPendingClick(): void {
    if (clickTimer) {
      window.clearTimeout(clickTimer);
      clickTimer = null;
    }
  }

  /**
   * 命中的「日历空白处」格子。
   *
   * 返回 null 表示：不在日期格子上，或点在了条目（`.cal-chip` / `[data-open]`）上 ——
   * 条目有各自的交互（双击编辑、右键上下文菜单），不该被当作空白处。
   */
  function blankDayCell(t: HTMLElement): HTMLElement | null {
    if (t.closest("[data-open]")) return null;
    const cell = t.closest("[data-day]") as HTMLElement | null;
    return cell && app.contains(cell) && cell.dataset.day ? cell : null;
  }

  /**
   * 新建时的默认开始时刻。
   *
   * 周视图的时间轴列上，按点击的纵向位置取整到 30 分钟 —— 这段逻辑原先写在 view-week 的
   * 双击处理器里，改由容器统一委托后要在这里补上；其余情况返回 undefined（只给日期，
   * 时刻交给编辑弹窗补默认值）。
   */
  function startStampForCell(cell: HTMLElement, ev: MouseEvent): string | undefined {
    if (!cell.classList.contains("cal-wk-col") || ev.target !== cell) return undefined;
    const rect = cell.getBoundingClientRect();
    if (!rect.height) return undefined;
    const day = cell.dataset.day!;
    const mins = Math.floor((((ev.clientY - rect.top) / rect.height) * 1440) / 30) * 30;
    return `${day}T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;
  }

  // 右键：条目上 → 上下文菜单；日历空白处 → 右侧栏三态循环
  on(app, "contextmenu", (ev) => {
    const t = ev.target as HTMLElement;
    if (!app.contains(t)) return;

    // ① 条目上右键 → 开 / 收右侧栏并展示该条目详情。
    //    （表格本次修订新增；原先这里是弹「编辑 / 删除」菜单，现已改由双击条目进入编辑器）
    const openEl = t.closest("[data-open]") as HTMLElement | null;
    if (openEl && app.contains(openEl)) {
      const key = openEl.dataset.open!;
      if (!ctx.store.get(key)) return;
      ev.preventDefault();
      ev.stopPropagation();
      // 触摸端长按已展开过等价界面，这里只挡掉系统菜单
      if (Date.now() - lastLongPressAt < 800) return;
      notifyToggleDockItem(key);
      return;
    }

    // ② 日历空白处右键 → 显示 / 隐藏右侧栏的三态循环
    //    （行为表本次修订：与「双击空白处」的行为互换，该手势从双击移到了右击）
    //
    //    只广播，由入口（main.ts 的 toggleDock）决定具体行为 —— 开关 Dock 属于承载层的事。
    const cell = blankDayCell(t);
    if (!cell) {
      hideCtxMenu();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    hideCtxMenu();
    // 三态会改变右侧栏的整体状态（打开 / 换范围 / 隐藏），主面板无从预知最终是哪种，
    // 故一并清掉单击留下的高亮，免得边框与实际的聚焦范围对不上。
    markSelectedDay(null);
    notifyToggleDock(cell.dataset.day!);
  });

  // 双击：条目上 → 编辑 / 删除菜单；日历空白处 → 新建菜单
  // （行为表本次修订：这两个手势与「右击」互换 —— 三态循环移到了右击上）
  on(app, "dblclick", (ev) => {
    const t = ev.target as HTMLElement;
    if (!app.contains(t)) return;

    // ① 条目上双击 → **直接进入编辑**。
    //    不是弹「编辑 / 删除」菜单：编辑器左下角本来就有删除按钮，再弹一层菜单是多余的
    //    —— 表格里写的「弹出编辑菜单」指的也是打开编辑器本身。
    const openEl = t.closest("[data-open]") as HTMLElement | null;
    if (openEl && app.contains(openEl)) {
      const item = ctx.store.get(openEl.dataset.open!);
      if (!item) return;
      ev.preventDefault();
      ev.stopPropagation();
      cancelPendingClick(); // 撤掉第一下挂起的聚焦，别让它在编辑器打开后又改一次状态
      openEditor(ctx, { item });
      return;
    }

    // ② 日历空白处双击 → 新建菜单
    const cell = blankDayCell(t);
    if (!cell) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelPendingClick();
    openDateAddMenu(ctx, ev.clientX, ev.clientY, cell.dataset.day!, startStampForCell(cell, ev));
  });

  // 触摸长按 → 等同于右键（命中区与右键一致：带 data-open 且 store 中存在的条目）
  on(app, "pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    const openEl = (ev.target as HTMLElement).closest("[data-open]") as HTMLElement | null;
    if (!openEl || !app.contains(openEl)) return;
    const key = openEl.dataset.open!;
    if (!ctx.store.get(key)) return;
    pressPoint = { x: ev.clientX, y: ev.clientY };
    longPressFired = false;
    clearPressTimer();
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      longPressFired = true;
      lastLongPressAt = Date.now();
      // 与桌面右击等价：开 / 收右侧栏并展示该条目详情。
      // （原先这里弹的是「编辑 / 删除」菜单，随右击行为一并改掉）
      notifyToggleDockItem(key);
    }, LONG_PRESS_MS);
  });

  // 手指移动超过阈值视为滚动，取消长按
  on(app, "pointermove", (ev) => {
    if (!pressTimer || ev.pointerType !== "touch") return;
    if (
      Math.abs(ev.clientX - pressPoint.x) > PRESS_MOVE_TOLERANCE ||
      Math.abs(ev.clientY - pressPoint.y) > PRESS_MOVE_TOLERANCE
    ) {
      clearPressTimer();
    }
  });

  on(app, "pointerup", (ev) => {
    if (ev.pointerType !== "touch") return;
    clearPressTimer();
  });

  on(app, "pointercancel", clearPressTimer);

  // 长按已弹菜单时吞掉随之而来的 click —— pointerup 的 preventDefault 挡不住 click，
  // 不拦的话手指抬起会顺带触发条目的「打开编辑弹窗」。用捕获阶段抢在条目自身处理之前。
  on(
    app,
    "click",
    (ev) => {
      if (!longPressFired) return;
      longPressFired = false;
      ev.preventDefault();
      ev.stopPropagation();
    },
    true
  );

  on(ctxMenu, "click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("[data-ctx]") as HTMLElement | null;
    if (!btn || !ctxMenuKey) return;
    const key = ctxMenuKey;
    const item = ctx.store.get(key);
    if (!item) {
      hideCtxMenu();
      return;
    }
    ev.stopPropagation();

    if (btn.dataset.ctx === "edit") {
      hideCtxMenu();
      openEditor(ctx, { item });
      return;
    }
    if (btn.dataset.ctx !== "delete") return;

    // 二次点击确认：与编辑弹窗内删除保持一致，不用原生 confirm
    if (!btn.classList.contains("is-armed")) {
      btn.classList.add("is-armed");
      setHtml(btn, `${icons.trash} 再点一次确认删除`);
      ctxDisarmTimer = window.setTimeout(resetCtxDelete, 4000);
      return;
    }
    resetCtxDelete();
    btn.setAttribute("disabled", "");
    btn.textContent = "删除中…";
    void ctx.sync
      .removeItem(item)
      .then(() => {
        if (ctx.store.get(key)) {
          // 仍留在本地 = 服务端 DELETE 未成功，会留待下次同步重试
          ctxErrEl.textContent = "服务器删除未成功，已记录，将在下次同步重试";
          ctxErrEl.hidden = false;
          btn.removeAttribute("disabled");
          setHtml(btn, `${icons.trash} 删除`);
          return;
        }
        hideCtxMenu();
        renderCalList();
        renderView();
      })
      .catch((e: any) => {
        ctxErrEl.textContent = "删除失败：" + (e?.message || e);
        ctxErrEl.hidden = false;
        btn.removeAttribute("disabled");
        setHtml(btn, `${icons.trash} 删除`);
      });
  });

  // 视图内导航（年视图跳月/日）
  ctx.navigate = (mode: ViewMode, cursor?: string) => {
    if (cursor) ctx.cursor = cursor;
    ctx.viewMode = mode;
    notifyViewChange(mode);
    renderAll();
  };

  // 勾选待办时就地更新可见视图，抑制本次 store 变更触发的整视图重渲染
  // （否则会闪烁、且周/日视图滚动位置被重置到默认当前时间）
  let suppressRerender = false;
  function updateTodoCheckDOM(root: HTMLElement, key: string, done: boolean): void {
    root
      .querySelectorAll<HTMLElement>(`[data-toggle="${key}"]`)
      .forEach((btn) => (btn.title = done ? "标记未完成" : "标记完成"));
    root
      .querySelectorAll<HTMLElement>(`[data-open="${key}"]`)
      .forEach((el) => el.classList.toggle("is-done", done));
  }

  // ---- 事件委托 ----
  on(app, "click", (ev) => {
    const t0 = ev.target as HTMLElement;

    // 待办快速勾选
    const toggleEl = t0.closest("[data-toggle]") as HTMLElement | null;
    if (toggleEl && app.contains(toggleEl)) {
      const item = ctx.store.get(toggleEl.dataset.toggle!);
      if (item && item.kind === "todo") {
        const nextDone = item.percent !== 100;
        item.percent = nextDone ? 100 : 0;
        item.status = nextDone ? "COMPLETED" : "NEEDS-ACTION";
        item.completedAt = nextDone ? new Date().toISOString().slice(0, 19) : undefined;
        const key = toggleEl.dataset.toggle!;
        updateTodoCheckDOM(app, key, nextDone);
        suppressRerender = true;
        // 兜底：万一同步 promise 一直挂着（网络挂起/等待解锁），最多抑制 10s，
        // 否则界面从此再也不刷新，表现出来就是「点了没反应」。
        const guard = window.setTimeout(() => (suppressRerender = false), 10000);
        void ctx.sync.updateItem(item).finally(() => {
          window.clearTimeout(guard);
          suppressRerender = false;
          // 同步收尾后按 store 里的真实状态校正一次：上面那次是乐观更新，
          // 若推送失败/被服务端覆盖而界面停留在乐观值，用户会以为「点了没用」。
          const real = ctx.store.get(key);
          if (real) updateTodoCheckDOM(app, key, real.percent === 100);
        });
        ev.stopPropagation();
        return;
      }
      ev.stopPropagation();
      return;
    }
    // 条目：单击 → 聚焦并列出该条目所在日期的清单。
    //
    // ⚠️ 这里**只管单击**，双击一律交给下面的 dblclick 处理器。
    // 早先的实现用 `ev.detail >= 2` 在 click 里判双击并打开编辑器，后来改成监听
    // `dblclick` 事件时，那个分支忘了删 —— 结果一次双击被两条路径各处理一次，
    // **弹出两个编辑器**，点一次「取消」只关掉上面那个，用户就得点两次（实测反馈）。
    const openEl = t0.closest("[data-open]") as HTMLElement | null;
    if (openEl && app.contains(openEl)) {
      const item = ctx.store.get(openEl.dataset.open!);
      if (item) {
        // 延后执行，理由见 clickTimer 的说明。
        // 日期取「用户实际点的那个格子」：同一条重复日程会出现在多个格子里，
        // 用条目自身的 start 会对不上用户看到的那个。
        const cell = openEl.closest("[data-day]") as HTMLElement | null;
        const date = cell?.dataset.day || item.start.slice(0, 10);
        cancelPendingClick();
        clickTimer = window.setTimeout(() => {
          clickTimer = null;
          if (destroyed) return;
          notifyFocusDate(date);
        }, 250);
      }
      return;
    }

    // 日历格子：单击 → 右侧栏列出当日清单。
    //
    // ⚠️ 这里**只负责改内容，不负责打开右侧栏**：右侧栏若当前是关着的，这个事件没有
    // 接收者，自然什么都不会发生 —— 开关右侧栏是「双击空白处」的职责（见 notifyToggleDock）。
    // 这样单击与双击不会互相打架：双击空白处的第一下无副作用，第二下才真正切换。
    const dayCell = t0.closest("[data-day]") as HTMLElement | null;
    if (dayCell && app.contains(dayCell) && dayCell.dataset.day) {
      const day = dayCell.dataset.day;
      // 时间轴列上按点击的纵向位置算出小时（周 / 日视图才有）；其余格子为 null
      const hour = hourFromClick(dayCell, ev);
      // 延后 250ms 执行：若是双击，第二下到达时会把这次挂起的单击取消掉
      cancelPendingClick();
      clickTimer = window.setTimeout(() => {
        clickTimer = null;
        if (destroyed) return;
        // 与 Dock 端的聚焦切换保持同步：已聚焦该日 → 取消高亮；否则高亮该格
        if (selectedDay === day) markSelectedDay(null);
        else markSelectedDay(dayCell, hour);
        notifyFocusDate(day);
      }, 250);
      return;
    }

    // 日历启用/禁用（眼睛按钮，或点击整行）。
    // ⚠️ 必须放在下面那句通用 target 解析**之前**：眼睛按钮自身不带 data-* 属性，
    // closest("[data-view],[data-action],[data-cal]") 会跳过它直接命中父级 .caldav-cal-item，
    // 于是后面那句 target.classList.contains("caldav-cal-toggle") 永远为 false —— 这正是
    // 「点了眼睛没任何反应」的原因（旧实现在此处静默失效）。
    const calItem = t0.closest(".caldav-cal-item") as HTMLElement | null;
    if (calItem && app.contains(calItem) && calItem.dataset.cal !== undefined) {
      toggleCalendar(+calItem.dataset.cal);
      ev.stopPropagation();
      return;
    }

    const target = t0.closest("[data-view],[data-action],[data-cal]") as HTMLElement | null;
    if (!target || !app.contains(target)) return;

    const view = target.dataset.view;
    if (view) {
      ctx.viewMode = view as ViewMode;
      notifyViewChange(ctx.viewMode);
      renderAll();
      return;
    }
    const action = target.dataset.action;
    if (action === "toggle-view") {
      // 日历视图（年/月/周/日）↔ 任务视图 互切；从任务视图返回时统一落回月视图
      ctx.viewMode = ctx.viewMode === "task" ? "month" : "task";
      notifyViewChange(ctx.viewMode);
      renderAll();
      return;
    }
    if (action === "prev" || action === "next") {
      const dir = action === "next" ? 1 : -1;
      ctx.cursor = stepCursor(ctx.cursor, ctx.viewMode, dir);
      renderAll();
      return;
    }
    if (action === "today") {
      ctx.cursor = todayStamp();
      renderAll();
      return;
    }
    if (action === "settings") {
      // 思源版此处弹自定义设置 Dialog，关闭后回调 renderAll。
      // Obsidian 改用标准设置页（无关闭回调），改设置的副作用由 store.onChange
      // 驱动重渲染 —— plugin.store.saveSettings() 会 emit，面板已订阅。
      ctx.openSettings();
      return;
    }
    if (action === "insert-diary") {
      // 反馈与「打开日记页签」都在入口侧完成（含失败提示），这里不重复处理
      void ctx.insertTodayToDiary();
      return;
    }
    if (action === "new") {
      // 原「+日程」「+待办」两个按钮合并为一个「新建」：点击先弹种类浮层，再进编辑器。
      // 复用日历格子双击用的同一个浮层（ui/date-add-menu.ts），文案与交互统一 ——
      // 那条路径本来就是「先选种类再打开编辑器」，与这里的需求完全一致。
      // 只给日期，时刻交给编辑弹窗补默认值（今天 = 下一个整点）。
      const r = target.getBoundingClientRect();
      openDateAddMenu(ctx, r.left, r.bottom, ctx.cursor);
      return;
    }
    if (action === "calfilter") {
      calfilterPop.hidden = !calfilterPop.hidden;
      return;
    }
  });

  // 「日历视图中显示待办任务」开关：写设置后走 saveSettings()（emit → 所有面板实例
  // 自动 renderAll + 落盘），不用在这里手动重渲染。
  showTodosInput.addEventListener("change", () => {
    ctx.store.settings.showTodosInCalendar = showTodosInput.checked;
    ctx.store.saveSettings();
  });

  // 点击面板其它区域时收起浮层（日历筛选 + 右键菜单）
  const onDocClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    if (!ctxMenu.hidden && !t.closest(".caldav-ctxmenu")) hideCtxMenu();
    if (calfilterPop.hidden) return;
    if (t.closest(".caldav-calfilter-wrap")) return;
    calfilterPop.hidden = true;
  };
  document.addEventListener("click", onDocClick, true);

  // Esc 关闭；滚动/窗口尺寸变化时菜单会与条目错位，直接收起
  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      hideCtxMenu();
      calfilterPop.hidden = true;
    }
  };
  const onReflow = () => hideCtxMenu();
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onReflow);
  // 捕获阶段监听滚动（视图容器自身也可滚）
  document.addEventListener("scroll", onReflow, true);

  const unsub = ctx.store.onChange(() => {
    if (!suppressRerender) renderAll();
  });
  renderAll();

  return {
    destroy() {
      destroyed = true;
      // 摘掉挂在根元素/右键菜单上的监听（它们可能被复用，漏摘会叠加处理器）
      offAll();
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      unsub();
      cancelPendingClick();
      // ctxMenu 可能已被挂到 body 下（见 showCtxMenu），清空 root 清不掉它，
      // 留着会在插件重载后变成孤儿节点
      if (ctxMenu.parentElement === document.body) ctxMenu.remove();
      root.empty();
    },
    refresh() {
      // 已销毁的面板可能还被人拿着引用（旧弹层、旧页签），刷新要变成空操作：
      // 让它去动已被清空的 DOM 只会徒增抛错风险（视图切换就调它）。
      if (destroyed) return;
      renderAll();
    }
  };
}

/** 视图切换事件：Dock 导航与主面板页签联动 */
export const VIEW_CHANGE_EVENT = "caldav-view-change";

export function notifyViewChange(mode: ViewMode): void {
  document.dispatchEvent(new CustomEvent(VIEW_CHANGE_EVENT, { detail: mode }));
}

/**
 * 「聚焦某日期」广播：主面板单击日历格子或条目时发出，右侧栏的 Dock 监听后切到该日清单。
 *
 * 为什么用 document 事件而不是直接调用：主面板（中间视图）与 Dock（右侧栏视图）是
 * 两个独立的 ItemView 实例，互相拿不到对方引用；事件总线是二者唯一的解耦通道。
 * 写法与上面的 notifyViewChange 保持一致。
 */
export const FOCUS_DATE_EVENT = "caldav-focus-date";

export function notifyFocusDate(date: string): void {
  if (!date) return;
  document.dispatchEvent(new CustomEvent(FOCUS_DATE_EVENT, { detail: date }));
}

/**
 * 「右击日历空白处」广播：主面板发出，由**入口**（main.ts）负责显示 / 隐藏右侧栏。
 * （行为表修订后该手势从双击移到了右击。）
 *
 * 为什么不在这里直接操作视图：开关 Dock 属于承载层的事（要访问 workspace 与 leaf），
 * 面板本身不该知道 Dock 的存在，故只广播，由入口决策。
 */
export const TOGGLE_DOCK_EVENT = "caldav-toggle-dock";

/** 双击时把「所点格子的日期」一并带上 —— 入口据此决定要聚焦到哪一天所在的月/周 */
export function notifyToggleDock(date: string): void {
  document.dispatchEvent(new CustomEvent(TOGGLE_DOCK_EVENT, { detail: date }));
}

/**
 * 入口 → Dock：聚焦到某日期所在的「月 / 周」。
 *
 * 用于双击格子的**中间态**（右侧栏已打开、且当前是「所有未完成」时）——
 * 此时既不该停在「所有未完成」，也不该直接关闭，而是先落到该格子所在的月 / 周清单。
 */
export const DOCK_SCOPE_EVENT = "caldav-dock-scope";

export function notifyDockScope(date: string, scope: FocusScope): void {
  document.dispatchEvent(new CustomEvent(DOCK_SCOPE_EVENT, { detail: { date, scope } }));
}

/**
 * 「右击条目」广播：主面板发出，由入口（main.ts）负责开 / 收右侧栏。
 *
 * 与 TOGGLE_DOCK_EVENT 的区别是它带着条目 key —— 打开时右侧栏要展示的是**该条目的详情**，
 * 而不是清单。两个手势各自独立、互不干扰。
 */
export const TOGGLE_DOCK_ITEM_EVENT = "caldav-toggle-dock-item";

export function notifyToggleDockItem(key: string): void {
  document.dispatchEvent(new CustomEvent(TOGGLE_DOCK_ITEM_EVENT, { detail: key }));
}

/**
 * 入口 → Dock：切到「条目详情」模式（右击条目且右侧栏原本隐藏时）。
 */
export const DOCK_ITEM_DETAIL_EVENT = "caldav-dock-item-detail";

export function notifyDockItemDetail(key: string): void {
  document.dispatchEvent(new CustomEvent(DOCK_ITEM_DETAIL_EVENT, { detail: key }));
}

/**
 * 强制 Dock 切到「所有未完成」。
 *
 * 与 VIEW_CHANGE_EVENT 的区别：后者按当前视图套默认筛选（月→所有未完成、周→本周任务），
 * 而这个是不论视图一律落到「所有未完成」—— 双击显示右侧栏时用的就是它。
 */
export const DOCK_ALL_UNDONE_EVENT = "caldav-dock-all-undone";

export function notifyDockAllUndone(): void {
  document.dispatchEvent(new CustomEvent(DOCK_ALL_UNDONE_EVENT));
}

/**
 * Dock 面板：标题「日历任务管理」（右侧带设置图标按钮）+ 一行 5 个按钮。
 * 新增 / 排序 为下拉菜单；日历视图 / 任务视图 打开主窗口页签；刷新 触发重新同步。
 * 设置入口从主面板「日历筛选」浮层迁到这里 —— 浮层只留过滤相关的动作，职责更单一。
 */
type DockFilter =
  | "today" | "tomorrow" | "next7" | "thisweek" | "future"
  | "overdue" | "past7" | "undone" | "nodate"
  | "doneToday" | "doneYesterday" | "done";

/**
 * 聚焦粒度。
 *   单击格子 / 条目        → "day"（聚焦那一天）
 *   双击格子（右侧栏已开且为「所有未完成」时）→ 按当前视图取 "month" 或 "week"
 */
export type FocusScope = "day" | "month" | "week";

/**
 * Dock 筛选下拉的选项（数组顺序即下拉中的顺序）。
 * 下拉是**自定义**的而非原生 <select>：原生弹出列表由操作系统绘制，
 * 选中项永远是系统高亮色（蓝），CSS 无法让它跟随主题（option:hover / :checked 会被忽略）。
 */
const DOCK_FILTERS: Array<{ key: DockFilter; label: string }> = [
  { key: "next7", label: "未来七天" },
  { key: "today", label: "今日任务" },
  { key: "tomorrow", label: "明日任务" },
  { key: "thisweek", label: "本周任务" },
  { key: "future", label: "未来任务" },
  { key: "overdue", label: "过期任务" },
  { key: "past7", label: "过去七天" },
  { key: "undone", label: "所有未完成" },
  { key: "nodate", label: "无日期任务" },
  { key: "doneToday", label: "今日已完成" },
  { key: "doneYesterday", label: "昨日已完成" },
  { key: "done", label: "已完成" }
];

export interface DockPanelOpts {
  store: CalStore;
  onNav: (mode: ViewMode) => void;
  onSync: () => Promise<unknown>;
  onSettings: () => void;
  onAddEvent: () => void;
  onAddTask: () => void;
  onSort: (mode: SortMode) => void;
  onOpenEditor: (item: CalItem) => void;
  onToggleDone: (item: CalItem) => void | Promise<void>;
  /** 主面板当前的视图模式 —— Dock 据此决定默认筛选（见 VIEW_DEFAULT_FILTER） */
  getViewMode: () => ViewMode;
  /** 主面板当前聚焦的日期 —— 日视图下 Dock 默认聚焦这一天 */
  getCursor: () => string;
}

export function renderDockPanel(
  root: HTMLElement,
  opts: DockPanelOpts
): {
  refresh: () => void;
  destroy: () => void;
  isDefaultState: () => boolean;
  isScopedState: () => boolean;
} {
  root.classList.add("caldav-dock");
  root.classList.toggle("caldav-touch", isMobile());
  setHtml(
    root,
    `
<div class="caldav-dock-filters">
  <div class="caldav-dock-list-head">
    <div class="caldav-dock-filter-wrap">
      <button class="caldav-dock-select" data-dock="filter" data-toggle="dock-filter" type="button">
        <span class="caldav-dock-select-text"></span>
      </button>
      <span class="caldav-dock-select-arrow">${icons.chevron}</span>
      <div class="caldav-dock-pop caldav-dock-filter-pop" data-pop="dock-filter" hidden>
        ${DOCK_FILTERS.map(
          (f) => `<button class="caldav-dock-popitem" data-dock-filter="${f.key}" type="button">${f.label}</button>`
        ).join("")}
      </div>
    </div>
    <button class="caldav-dock-filter-btn" data-dock="category">分类筛选</button>
    <div class="caldav-dock-cat-pop" data-pop="category" hidden>
      <div class="caldav-dock-cat-head">选择分类</div>
      <div class="caldav-dock-cat-list" data-cat-list></div>
      <div class="caldav-dock-cat-foot">
        <button class="caldav-foot-btn caldav-foot-btn--ghost" data-cat-action="cancel">取消</button>
        <button class="caldav-foot-btn caldav-foot-btn--primary" data-cat-action="ok">确定</button>
      </div>
    </div>
  </div>
  <div class="caldav-dock-search-wrap">
    <span class="caldav-dock-search-icon">${icons.search}</span>
    <input class="caldav-dock-search" data-dock="search" placeholder="搜索任务..." />
  </div>
</div>
<div class="caldav-dock-list">
  <div class="caldav-dock-items" data-dock="items"></div>
</div>`
  );

  const listEl = root.querySelector("[data-dock='items']") as HTMLElement;
  const pops = Array.from(root.querySelectorAll<HTMLElement>(".caldav-dock-pop"));
  let localSort: SortMode = "start";
  let destroyed = false;

  function closePops(): void {
    pops.forEach((p) => (p.hidden = true));
    const catPop = root.querySelector<HTMLElement>("[data-pop='category']");
    if (catPop) catPop.hidden = true;
    root.querySelectorAll(".caldav-dock-act.is-open").forEach((b) => b.classList.remove("is-open"));
  }

  function openCategoryPop(): void {
    pendingCategoryFilter = [...dockCategoryFilter];
    renderCategoryPop();
    const catPop = root.querySelector<HTMLElement>("[data-pop='category']");
    const btn = root.querySelector<HTMLElement>("[data-dock='category']");
    if (catPop) {
      catPop.hidden = false;
      if (btn) {
        const r = btn.getBoundingClientRect();
        catPop.style.top = `${r.top}px`;
        catPop.style.left = `${r.right + 8}px`;
      }
    }
  }

  function togglePop(name: string): void {
    const pop = pops.find((p) => p.dataset.pop === name);
    const open = !pop?.hidden;
    closePops();
    if (open) return;
    if (pop) pop.hidden = false;
    const btn = root.querySelector(`[data-toggle="${name}"]`);
    btn?.classList.add("is-open");
  }

  function renderSortActive(): void {
    root.querySelectorAll<HTMLElement>(".caldav-dock-popitem[data-action^='sort-']").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.action === `sort-${localSort}`);
    });
  }

  /** 同步筛选触发按钮上的文案，并高亮下拉里的当前项 */
  /** 聚焦状态在下拉里的文案：日→「10月9日」；月→「2026 年 10 月」；周→「10月5日 – 10月11日」 */
  function focusLabel(): string {
    if (!focusDate) return "";
    if (focusScope === "month") return `${+focusDate.slice(0, 4)} 年 ${+focusDate.slice(5, 7)} 月`;
    if (focusScope === "week") {
      const ws = startOfWeek(focusDate);
      return `${fmtDateCn(ws)} – ${fmtDateCn(addDays(ws, 6))}`;
    }
    return fmtDateCn(focusDate);
  }

  function syncDockFilterLabel(): void {
    // 聚焦时下拉文案显示当前聚焦范围 —— 用户一眼能看出列表为什么变了；
    // 此时不点亮任何预设筛选项，因为当前状态不是任何一个预设。
    const label = focusDate
      ? focusLabel()
      : DOCK_FILTERS.find((f) => f.key === dockFilter)?.label || "";
    const textEl = root.querySelector<HTMLElement>(".caldav-dock-select-text");
    if (textEl) textEl.textContent = label;
    root.querySelectorAll<HTMLElement>("[data-dock-filter]").forEach((b) => {
      b.classList.toggle("is-active", !focusDate && b.dataset.dockFilter === dockFilter);
    });
  }

  /**
   * Dock 底部的同步状态块与错误行**已移除**。
   *
   * 原因：Obsidian 底部状态栏已经在显示同一份同步信息（见 main.ts 的 addStatusBarItem），
   * Dock 里再放一个是冗余，而右侧栏的纵向空间本就紧张。
   * 同步错误不会因此丢失 —— 状态栏会显示错误摘要，runSync 也会弹 Notice。
   */

  let dockFilter: DockFilter = "next7";
  let dockSearch = "";
  let dockCategoryFilter: string[] = []; // 空 = 所有分类；"__none__" = 无分类
  /**
   * 聚焦锚点日期（"YYYY-MM-DD"）与聚焦粒度。非空时**优先于** dockFilter：
   *   - 单击格子 / 条目 → 聚焦该「日」
   *   - 双击格子（右侧栏已开且为「所有未完成」）→ 聚焦该日所在的「月 / 周」
   * 用户在下拉里选任一预设筛选即退出聚焦。
   */
  let focusDate: string | null = null;
  let focusScope: FocusScope = "day";

  /**
   * 进入聚焦前的筛选状态。
   * 「取消聚焦」时要**恢复之前显示的内容**（表格里对单击的规定），故先记一份。
   */
  let beforeFocusFilter: DockFilter | null = null;

  /**
   * 详情模式：非空时列表区整块让给「该条目的详细信息」（右击条目打开）。
   * 点详情卡片上的「返回列表」即清空本状态。
   */
  let detailKey: string | null = null;

  /**
   * 各视图的默认筛选。
   *
   * 对应「进入某个视图时右侧栏该显示什么」：
   *   月 / 年  → 所有未完成（未完成待办 + 尚未结束的日程）
   *   周       → 本周任务
   *   日       → 不设预设筛选，直接聚焦主面板当前所在的那一天
   *   任务视图 → 所有未完成
   */
  const VIEW_DEFAULT_FILTER: Record<ViewMode, DockFilter | null> = {
    year: "undone",
    month: "undone",
    week: "thisweek",
    day: null,
    task: "undone",
  };

  /**
   * 套用「当前视图的默认状态」。
   *
   * 两处会走到这里：
   *   1. Dock 初始化（初次进入某视图）
   *   2. 主面板切换视图（VIEW_CHANGE_EVENT）
   * （原先还有「再次单击已选中的格子」这条路径，随单击联动一并取消。）
   */
  function applyViewDefault(): void {
    const mode = opts.getViewMode();
    if (mode === "day") {
      // 日视图：直接聚焦那一天，而不是给一个笼统的预设筛选
      focusDate = opts.getCursor();
      focusScope = "day";
      dockFilter = "undone"; // 兜底值；用户选任一预设筛选即覆盖
    } else {
      focusDate = null;
      dockFilter = VIEW_DEFAULT_FILTER[mode] ?? "undone";
    }
    syncDockFilterLabel();
    renderDockList();
  }

  /** 勾选待办时抑制整列表重建：改状态只改这一行的 class/复选框，列表不闪、滚动不复位 */
  let suppressDockRerender = false;

  function isEnabledCalendar(it: CalItem): boolean {
    return opts.store.settings.calendars.some((c) => c.enabled && c.url === it.calendarUrl);
  }

  /** 条目用于「归属时间段」的日期：待办取到期日（DUE），事件取开始时间 */
  function dateKeyOf(it: CalItem): string {
    return (it.kind === "todo" ? it.end : it.start)?.slice(0, 10) || "";
  }

  function matchesDockFilter(it: CalItem, filter: DockFilter): boolean {
    if (it.deleted) return false;
    if (!isEnabledCalendar(it)) return false;

    const today = todayStamp();
    const date = dateKeyOf(it);
    const diff = diffDays(date, today);
    const weekStart = startOfWeek(today);
    const weekEnd = addDays(weekStart, 6).slice(0, 10);
    const isTodo = it.kind === "todo";
    const isDone = isTodo && it.percent === 100;
    /** 已过期但尚未完成的待办 —— 这类条目即使过期也要留在列表里 */
    const overdue = isTodo && !isDone && !!date && diff < 0;
    // 事件是否已结束：按**结束时间**与当前时刻比较（进行中的保留，只有真正结束的才隐藏）。
    // 全天事件只有日期，按日期比较，避免当天事件过了 00:00 就被藏掉。
    const evEnd = it.end || it.start || "";
    const ended = !isTodo && !!evEnd && (isDateOnly(evEnd) ? evEnd < today : evEnd < stampOfMs(Date.now()));

    /**
     * 时间窗筛选统一口径：
     *  - 待办：命中窗口，或者「已过期且未完成」（没完成的过期任务照样显示）
     *  - 事件：命中窗口，且尚未结束（当前时间以前的不显示）
     */
    const inWindow = (hit: boolean): boolean => (isTodo ? hit || overdue : hit && !ended);

    switch (filter) {
      case "today":
        return inWindow(date === today);
      case "tomorrow":
        return inWindow(date === addDays(today, 1).slice(0, 10));
      case "next7":
        return inWindow(diff >= 0 && diff <= 6);
      case "thisweek":
        return inWindow(date >= weekStart && date <= weekEnd);
      case "future":
        return inWindow(diff >= 0);
      case "overdue":
        return overdue;
      case "past7":
        // 回顾用：保留过去 7 天（含已经结束的事件），不套用 inWindow
        return diff >= -6 && diff < 0;
      case "undone":
        // 「所有未完成」= 未完成的待办 + 尚未结束的日程。
        // 后者用 ended（按结束时间比较）判定，进行中的日程也会保留，只有真正结束的才隐藏 ——
        // 与用户对这个筛选的预期一致：「未完成的待办 + 当前时间之后的日程」。
        return isTodo ? !isDone : !ended;
      case "nodate":
        return isTodo && !date;
      case "doneToday":
        return isDone && !!it.completedAt && it.completedAt.slice(0, 10) === today;
      case "doneYesterday":
        return isDone && !!it.completedAt && it.completedAt.slice(0, 10) === addDays(today, -1).slice(0, 10);
      case "done":
        return isDone;
      default:
        return true;
    }
  }

  function matchesDockSearch(it: CalItem, q: string): boolean {
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return (
      it.summary.toLowerCase().includes(s) ||
      (it.description || "").toLowerCase().includes(s) ||
      (it.location || "").toLowerCase().includes(s) ||
      (it.categories || []).some((c) => c.toLowerCase().includes(s))
    );
  }

  function matchesDockCategoryFilter(it: CalItem, filter: string[]): boolean {
    if (!filter.length) return true;
    const hasNone = filter.includes("__none__");
    const cats = filter.filter((f) => f !== "__none__");
    const itemCats = it.categories || [];
    if (hasNone && itemCats.length === 0) return true;
    if (cats.length && itemCats.some((c) => cats.includes(c))) return true;
    return false;
  }

  function formatDockTimeRange(it: CalItem): string {
    if (it.allDay) return "全天";
    if (it.kind === "event" && it.end) return `${fmtTime(it.start)} - ${fmtTime(it.end)}`;
    // 待办以到期时间为准，不再展示开始时间
    if (it.kind === "todo" && it.end) return isDateOnly(it.end) ? "" : fmtTime(it.end);
    if (!isDateOnly(it.start)) return fmtTime(it.start);
    return "";
  }

  /**
   * iCal PRIORITY（1 最高、9 最低）→ 文案与配色级别。
   * 覆盖 1~9 全部取值，不只认 1/3/5/9 这四个数字。
   */
  function prioMeta(p: number): { label: string; cls: string } {
    if (p <= 2) return { label: "紧急", cls: "prio-urgent" };
    if (p <= 4) return { label: "高", cls: "prio-high" };
    if (p <= 6) return { label: "中", cls: "prio-mid" };
    return { label: "低", cls: "prio-low" };
  }

  function buildDockTags(it: CalItem): string {
    const tags: string[] = [];
    const today = todayStamp();
    const date = dateKeyOf(it);
    const diff = diffDays(date, today);
    const isDoneTodo = it.kind === "todo" && it.percent === 100;
    // 逾期天数：只有「未完成且到期日已过」的待办才算逾期（完成的过往条目不该标红）
    const overdueDays = it.kind === "todo" && !isDoneTodo && !!date && diff < 0 ? -diff : 0;

    // 主时间标签：逾期的待办直接标成红色「逾期 N 天」
    // （原来的「N 天前」说的正是同一件事，改成红色标志更醒目，也避免同一行出现两个重复标签）
    let timeLabel = "";
    let timeCls = "caldav-dock-tag--primary";
    if (overdueDays > 0) {
      timeLabel = `逾期 ${overdueDays} 天`;
      timeCls = "caldav-dock-tag--overdue";
    } else if (isDoneTodo) timeLabel = "已完成";
    else if (!date) timeLabel = "无日期";
    else if (diff === 0) timeLabel = "今天";
    else if (diff === 1) timeLabel = "明天";
    else if (diff > 1) timeLabel = `${diff}天后开始`;
    else if (diff === -1) timeLabel = "昨天";
    else timeLabel = `${-diff}天前`;
    tags.push(`<span class="caldav-dock-tag ${timeCls}">${timeLabel}</span>`);

    // 类型 / 优先级
    if (it.kind === "event") {
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary">${icons.calendar}日程</span>`);
    } else if (it.priority) {
      const pm = prioMeta(it.priority);
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary ${pm.cls}">${icons.flag}${pm.label}</span>`);
    } else {
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary">${icons.tasks}任务</span>`);
    }

    // 自定义分类
    if (it.categories) {
      for (const c of it.categories) {
        tags.push(`<span class="caldav-dock-tag caldav-dock-tag--ghost">${icons.tag}${escapeHtml(c)}</span>`);
      }
    }

    return tags.join("");
  }

  let pendingCategoryFilter: string[] = [];

  function renderCategoryPop(): void {
    const pop = root.querySelector("[data-pop='category']") as HTMLElement;
    const listEl = pop.querySelector("[data-cat-list]") as HTMLElement;
    const cats = opts.store.settings.categories?.length ? opts.store.settings.categories : DEFAULT_CATEGORIES;
    const filter = pendingCategoryFilter;
    const isAll = filter.length === 0;

    const items = [
      { key: "__all__", label: "所有分类", icon: "", color: "" },
      { key: "__none__", label: "无分类", icon: "", color: "" },
      ...cats.map((c) => ({ key: c.name, label: c.name, icon: c.icon, color: c.color }))
    ];

    setHtml(
      listEl,
      items
        .map((item) => {
          const checked = item.key === "__all__" ? isAll : filter.includes(item.key);
          const iconHtml = item.icon
            ? `<span class="caldav-dock-cat-icon" style="background:${escapeAttr(item.color)}">${escapeHtml(item.icon)}</span>`
            : "";
          return `<label class="caldav-dock-cat-item ${checked ? "is-active" : ""}" data-cat-key="${escapeAttr(item.key)}">
      <input type="checkbox" ${checked ? "checked" : ""}/>
      ${iconHtml}<span>${escapeHtml(item.label)}</span>
    </label>`;
        })
        .join("")
    );
  }

  function dockSort(a: CalItem, b: CalItem): number {
    const sv = (it: CalItem): string | number => {
      switch (localSort) {
        case "end":
          // 待办以到期日为准；无到期日的排最后
          return it.kind === "todo" ? it.end || "9999-12-31T23:59:59" : it.end || it.start;
        case "priority":
          return it.priority && it.priority > 0 ? it.priority : 9; // 无优先级视为最低
        case "completed":
          return it.completedAt || "9999-12-31T23:59:59"; // 未完成排最后
        case "created":
          return it.createdAt || it.start;
        case "category":
          return (it.categories && it.categories[0]) || "";
        case "title":
          return (it.summary || "").toLowerCase();
        case "start":
        default:
          // 待办按到期时间排序（与时间归属口径一致）
          return dateKeyOf(it) + "T" + (it.kind === "todo" ? it.end || "" : it.start).slice(11);
      }
    };
    const av = sv(a);
    const bv = sv(b);
    if (av < bv) return -1;
    if (av > bv) return 1;
    // 并列回退：开始时间 → 标题
    if (a.start !== b.start) return a.start.localeCompare(b.start);
    return (a.summary || "").localeCompare(b.summary || "", "zh");
  }

  /**
   * 当前筛选下被隐藏的无日期未完成待办数量。
   * 用户在编辑弹窗里清空日期后，这类条目会落在「无日期」里，
   * 若不提示，看起来就像「记录消失了」（实测用户就是这么反馈的）。
   */
  function hiddenNodateCount(): number {
    if (dockFilter === "nodate" || dockFilter === "undone" || dockFilter.startsWith("done")) return 0;
    const q = dockSearch.toLowerCase().trim();
    return opts.store
      .getAll()
      .filter((it) => it.kind === "todo" && !it.deleted && it.percent !== 100)
      .filter((it) => isEnabledCalendar(it))
      .filter((it) => !dateKeyOf(it))
      .filter((it) => matchesDockCategoryFilter(it, dockCategoryFilter))
      .filter((it) => matchesDockSearch(it, q)).length;
  }

  /**
   * 条目在 [from, to] 闭区间内是否有实例（按日期前缀比对）。
   *
   * ⚠️ 不能用「展开结果非空」判定命中：`expandRepeats` 对**没有 rrule 的条目**直接
   * `return [item.start]`、不做窗口过滤（见 core/ics.ts），用非空判定会把所有普通日程
   * 都算成命中。必须逐个比对日期前缀 —— 这也正是日历视图判断「这条落在哪一格」的口径。
   */
  function matchesRange(it: CalItem, from: string, to: string): boolean {
    const fromMs = parseLocalStamp(from + "T00:00:00").getTime();
    const toMs = parseLocalStamp(to + "T00:00:00").getTime() + 86400000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
    const occ =
      it.kind === "todo" ? todoDueOccurrences(it, fromMs, toMs) : occurrencesInRange(it, fromMs, toMs);
    return occ.some((s) => {
      if (!s) return false;
      const d = s.slice(0, 10);
      return d >= from && d <= to;
    });
  }

  /** 条目是否落在当前聚焦范围内（日 / 月 / 周，由 focusScope 决定） */
  function matchesFocus(it: CalItem): boolean {
    if (!focusDate) return false;
    if (focusScope === "month") {
      // "…-31" 只用于字符串比较的上界，2 月等不足 31 天的月份会落到下月初，无妨
      const ym = focusDate.slice(0, 7);
      return matchesRange(it, ym + "-01", ym + "-31");
    }
    if (focusScope === "week") {
      const ws = startOfWeek(focusDate);
      return matchesRange(it, ws, addDays(ws, 6));
    }
    return matchesRange(it, focusDate, focusDate);
  }

  // ---- 条目详情（右击条目 → 右侧栏展示该条目的全部信息）----

  /** "YYYY-MM-DDTHH:mm" → 「10月9日 09:00」；只有日期时不带时刻 */
  function fmtStampFull(s: string): string {
    const t = s.slice(11, 16);
    return t ? `${fmtDateCn(s.slice(0, 10))} ${t}` : fmtDateCn(s.slice(0, 10));
  }

  function priorityLabel(p: number): string {
    return p === 1 ? "紧急" : p === 3 ? "高" : p === 5 ? "中" : p === 9 ? "低" : `P${p}`;
  }

  function alarmText(mins: number): string {
    if (mins <= 0) return "准时";
    if (mins % 1440 === 0) return `${mins / 1440} 天前`;
    if (mins % 60 === 0) return `${mins / 60} 小时前`;
    return `${mins} 分钟前`;
  }

  function rruleText(r: NonNullable<CalItem["rrule"]>): string {
    const base =
      r.freq === "DAILY" ? "每天" : r.freq === "WEEKLY" ? "每周" : r.freq === "MONTHLY" ? "每月" : "每年";
    const unit = base.slice(1); // 天 / 周 / 月 / 年
    const parts = [r.interval > 1 ? `每 ${r.interval} ${unit}` : base];
    if (r.byDay?.length) parts.push(r.byDay.join("、"));
    if (r.byMonthDay?.length) parts.push(`每月 ${r.byMonthDay.join("、")} 日`);
    if (r.count) parts.push(`共 ${r.count} 次`);
    else if (r.until) parts.push(`至 ${fmtDateCn(r.until.slice(0, 10))}`);
    return parts.join(" · ");
  }

  function renderItemDetail(): void {
    const it = detailKey ? opts.store.get(detailKey) : null;
    if (!it) {
      // 条目已不在（被删除 / 被别处改动）→ 退回列表，别把用户困在空详情里
      detailKey = null;
      renderDockList();
      return;
    }
    const isTodo = it.kind === "todo";
    const cal = opts.store.settings.calendars.find((c) => c.url === it.calendarUrl);
    const rows: Array<[string, string]> = [];

    rows.push(["类型", isTodo ? "待办任务" : "日程"]);
    rows.push(["日历", cal?.displayName || it.calendarUrl]);
    if (isTodo) {
      rows.push(["到期", it.end ? fmtStampFull(it.end) : "无"]);
      const done = it.percent === 100;
      rows.push([
        "状态",
        done ? `已完成${it.completedAt ? `（${fmtStampFull(it.completedAt)}）` : ""}` : "未完成",
      ]);
      if (it.priority) rows.push(["优先级", priorityLabel(it.priority)]);
    } else {
      rows.push(["开始", fmtStampFull(it.start)]);
      rows.push(["结束", it.end ? fmtStampFull(it.end) : "—"]);
      if (it.allDay) rows.push(["全天", "是"]);
    }
    if (it.location) rows.push(["地点", it.location]);
    if (it.categories?.length) rows.push(["分类", it.categories.join("、")]);
    if (it.rrule) rows.push(["重复", rruleText(it.rrule)]);
    if (it.alarms?.length) rows.push(["提醒", it.alarms.map((a) => alarmText(a.minutesBefore)).join("、")]);
    if (it.description) rows.push(["描述", it.description]);
    if (it.createdAt) rows.push(["创建于", fmtStampFull(it.createdAt)]);

    setHtml(
      listEl,
      `
      <div class="caldav-detail">
        <button class="caldav-detail-back" data-dock-action="back-to-list" type="button">← 返回列表</button>
        <div class="caldav-detail-title">${escapeHtml(it.summary || "(无标题)")}</div>
        <div class="caldav-detail-rows">
          ${rows
            .map(
              ([k, v]) =>
                `<div class="caldav-detail-row"><span class="caldav-detail-label">${escapeHtml(k)}</span><span class="caldav-detail-value">${escapeHtml(v)}</span></div>`
            )
            .join("")}
        </div>
      </div>`
    );
  }

  function renderDockList(): void {
    if (destroyed) return;
    // 详情模式：列表区整块让给条目详情（右击条目打开，点「返回列表」退出）
    if (detailKey) {
      renderItemDetail();
      return;
    }
    const q = dockSearch.toLowerCase().trim();
    const items = opts.store
      .getAll()
      // 聚焦（日 / 月 / 周）优先：它来自主面板的单击或双击，比预设筛选更具体
      .filter((it) => (focusDate ? matchesFocus(it) : matchesDockFilter(it, dockFilter)))
      .filter((it) => matchesDockCategoryFilter(it, dockCategoryFilter))
      .filter((it) => matchesDockSearch(it, q))
      .sort(dockSort)
      .slice(0, 50);

    const nodateHidden = hiddenNodateCount();
    const nodateHint = nodateHidden
      ? `<button class="caldav-dock-hint" data-dock-action="show-nodate">另有 ${nodateHidden} 条无日期待办未显示 · 点此查看</button>`
      : "";

    if (!items.length) {
      setHtml(listEl, `<div class="caldav-dock-empty">暂无匹配条目</div>${nodateHint}`);
      return;
    }

    setHtml(
      listEl,
      items
        .map((it) => {
        const key = keyOf(it);
        const date = it.kind === "todo" ? it.end : it.start;
        const dateStr = date ? fmtDateCn(date) : "无日期";
        const timeStr = formatDockTimeRange(it);
        const tags = buildDockTags(it);
        const isDoneTodo = it.kind === "todo" && it.percent === 100;
        return `
      <div class="caldav-dock-item ${isDoneTodo ? "is-done" : ""}" data-open="${key}">
        <span class="caldav-dock-check" data-toggle="${key}">
          ${it.kind === "todo"
            ? `<input type="checkbox" ${isDoneTodo ? "checked" : ""}/>`
            : `<span class="caldav-dock-kind">${icons.calendar}</span>`}
        </span>
        <div class="caldav-dock-item-main">
          <div class="caldav-dock-item-title">${escapeHtml(it.summary)}</div>
          <div class="caldav-dock-item-meta">
            <span class="caldav-dock-item-date">
              ${it.kind === "todo" ? icons.tasks : icons.calendar}
              ${dateStr}${timeStr ? " " + timeStr : ""}
            </span>
          </div>
          <div class="caldav-dock-item-tags">${tags}</div>
        </div>
      </div>`;
        })
        .join("") + nodateHint
    );
  }

  // ⚠️ 必须具名：移动端这个容器元素是**长期存活**的（思源的 removeMobilePluginDock
  // 只清内容，元素本身留着；侧栏重建也只搬运它），重挂时若不摘掉旧监听，
  // 就会在同一元素上叠加多个处理器 —— 一次点击触发多次动作，
  // 症状就是「点一次设置弹出两个设置窗口」（且随每次插件热更新越叠越多）。
  const onRootClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;

    // 标题栏右侧设置图标按钮
    const brandSet = t.closest("[data-dock-action='settings']");
    if (brandSet && root.contains(brandSet)) {
      opts.onSettings();
      return;
    }

    // 详情卡片上的「返回列表」
    if (t.closest("[data-dock-action='back-to-list']")) {
      detailKey = null;
      renderDockList();
      return;
    }

    // 「另有 N 条无日期待办」提示：直接切到无日期筛选
    const nodateBtn = t.closest("[data-dock-action='show-nodate']");
    if (nodateBtn) {
      dockFilter = "nodate";
      syncDockFilterLabel();
      renderDockList();
      ev.stopPropagation();
      return;
    }

    // Dock 列表内部：复选框 / 卡片打开
    const toggleEl = t.closest("[data-toggle]") as HTMLElement | null;
    if (toggleEl && listEl.contains(toggleEl)) {
      const item = opts.store.get(toggleEl.dataset.toggle!);
      if (item && item.kind === "todo") {
        // 就地更新：只改这一行的完成态，不重建列表（否则整列闪烁、滚动位置复位）
        const nextDone = item.percent !== 100;
        const row = toggleEl.closest(".caldav-dock-item") as HTMLElement | null;
        row?.classList.toggle("is-done", nextDone);
        const cb = toggleEl.querySelector<HTMLInputElement>("input[type=checkbox]");
        if (cb) cb.checked = nextDone;
        const key = toggleEl.dataset.toggle!;
        suppressDockRerender = true;
        const guard = window.setTimeout(() => (suppressDockRerender = false), 10000);
        void Promise.resolve(opts.onToggleDone(item)).finally(() => {
          window.clearTimeout(guard);
          suppressDockRerender = false;
          // 与日历视图同理：同步收尾后按 store 真实值校正这一行
          const real = opts.store.get(key);
          if (real) {
            const done = real.percent === 100;
            row?.classList.toggle("is-done", done);
            if (cb) cb.checked = done;
          }
        });
      }
      ev.stopPropagation();
      return;
    }
    const openEl = t.closest("[data-open]") as HTMLElement | null;
    if (openEl && listEl.contains(openEl)) {
      const item = opts.store.get(openEl.dataset.open!);
      if (item) opts.onOpenEditor(item);
      return;
    }

    // 下拉内的动作
    const popItem = t.closest("[data-action]") as HTMLElement | null;
    if (popItem && root.contains(popItem)) {
      const a = popItem.dataset.action!;
      closePops();
      if (a === "add-event") return opts.onAddEvent();
      if (a === "add-task") return opts.onAddTask();
      if (a.startsWith("sort-")) {
        localSort = a.slice(5) as SortMode;
        renderSortActive();
        renderDockList();
        return opts.onSort(localSort);
      }
      if (a === "cal-view") return opts.onNav("month");
      if (a === "task-view") return opts.onNav("task");
    }

    // 分类筛选弹层
    const catPopEl = root.querySelector<HTMLElement>("[data-pop='category']");
    const catItem = t.closest(".caldav-dock-cat-item") as HTMLElement | null;
    const catAction = t.closest("[data-cat-action]") as HTMLElement | null;
    if (catPopEl && !catPopEl.hidden && (catItem || catAction)) {
      if (catAction) {
        if (catAction.dataset.catAction === "ok") {
          dockCategoryFilter = pendingCategoryFilter;
          renderDockList();
        }
        closePops();
        return;
      }
      if (catItem) {
        const key = catItem.dataset.catKey!;
        if (key === "__all__") {
          pendingCategoryFilter = [];
        } else {
          const set = new Set(pendingCategoryFilter);
          if (set.has(key)) set.delete(key);
          else set.add(key);
          pendingCategoryFilter = Array.from(set);
        }
        renderCategoryPop();
        return;
      }
    }
    if (t.closest("[data-dock='category']")) {
      const catPopEl2 = root.querySelector<HTMLElement>("[data-pop='category']");
      if (catPopEl2?.hidden) openCategoryPop();
      else closePops();
      return;
    }

    // 筛选下拉：选中某一项
    const filterItem = t.closest("[data-dock-filter]") as HTMLElement | null;
    if (filterItem && root.contains(filterItem)) {
      dockFilter = filterItem.dataset.dockFilter as DockFilter;
      focusDate = null; // 选了预设筛选即退出「日期聚焦」
      syncDockFilterLabel();
      renderDockList();
      closePops();
      return;
    }

    // 菜单展开/收起
    const toggle = t.closest("[data-toggle]") as HTMLElement | null;
    if (toggle && root.contains(toggle)) {
      togglePop(toggle.dataset.toggle!);
      return;
    }
  };
  root.addEventListener("click", onRootClick);

  /**
   * 接收主面板的「单击某日」广播。
   *
   * 单击是**切换**语义（表格里对单击的规定）：
   *   未聚焦该日 → 聚焦该日，列出该日清单
   *   已聚焦该日 → 取消聚焦，并**恢复进入聚焦前显示的内容**
   * 全程不改变右侧栏的打开 / 关闭状态 —— 开关是双击的职责。
   *
   * 用 document 事件而非直接调用：主面板与 Dock 是两个独立视图实例，互不持有引用。
   */
  const onFocusDate = (e: Event): void => {
    const date = (e as CustomEvent).detail as string;
    if (!date) return;
    if (focusDate === date && focusScope === "day") {
      // 再点同一日 → 取消聚焦，回到进入聚焦前的那份筛选
      focusDate = null;
      dockFilter = beforeFocusFilter ?? "undone";
      beforeFocusFilter = null;
    } else {
      // 进入聚焦前记一份当前筛选，供取消时恢复；从 A 日切到 B 日时不覆盖
      if (!focusDate) beforeFocusFilter = dockFilter;
      focusDate = date;
      focusScope = "day";
    }
    syncDockFilterLabel();
    renderDockList();
  };
  document.addEventListener(FOCUS_DATE_EVENT, onFocusDate);

  /**
   * 双击格子的「中间态」：右侧栏已开且为「所有未完成」→ 聚焦该日所在的月 / 周。
   * 粒度由入口按主面板当前视图决定（月视图→月、周视图→周）。
   */
  const onDockScope = (e: Event): void => {
    const d = (e as CustomEvent).detail as { date?: string; scope?: FocusScope } | undefined;
    if (!d?.date) return;
    beforeFocusFilter = dockFilter;
    focusDate = d.date;
    focusScope = d.scope ?? "day";
    syncDockFilterLabel();
    renderDockList();
  };
  document.addEventListener(DOCK_SCOPE_EVENT, onDockScope);

  /** 右击条目且右侧栏原本隐藏 → 打开并切到该条目的详情 */
  const onItemDetail = (e: Event): void => {
    const key = (e as CustomEvent).detail as string;
    if (!key) return;
    detailKey = key;
    renderDockList();
  };
  document.addEventListener(DOCK_ITEM_DETAIL_EVENT, onItemDetail);

  /** 主面板切换视图 → 套用该视图的默认筛选 */
  const onViewChange = (): void => applyViewDefault();
  document.addEventListener(VIEW_CHANGE_EVENT, onViewChange);

  /** 双击日历空白处且右侧栏已打开 → 强制切到「所有未完成」（见 main.ts 的 toggleDock） */
  const onAllUndone = (): void => {
    focusDate = null;
    focusScope = "day";
    beforeFocusFilter = null;
    dockFilter = "undone";
    syncDockFilterLabel();
    renderDockList();
  };
  document.addEventListener(DOCK_ALL_UNDONE_EVENT, onAllUndone);

  // 筛选下拉已改为自定义控件（原生 <select> 的 change 监听随之移除）

  const onRootInput = (ev: Event) => {
    const target = ev.target as HTMLElement;
    if (target.dataset.dock === "search") {
      dockSearch = (target as HTMLInputElement).value;
      renderDockList();
    }
  };
  root.addEventListener("input", onRootInput);

  const onDocClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    if (!root.contains(t)) closePops();
  };
  document.addEventListener("click", onDocClick, true);

  const listScrollEl = root.querySelector<HTMLElement>(".caldav-dock-list");
  const onScrollClose = () => closePops();
  listScrollEl?.addEventListener("scroll", onScrollClose);
  window.addEventListener("resize", onScrollClose);

  const unsub = opts.store.onChange(() => {
    // 勾选引发的变更跳过重建：DOM 已就地更新，重建只会闪一下并把滚动打回顶部
    if (suppressDockRerender) return;
    renderDockList();
  });
  // 初次进入：按主面板当前视图套用默认筛选（月 = 所有未完成 / 周 = 本周任务 / 日 = 聚焦当天）
  // applyViewDefault 内部已调 syncDockFilterLabel + renderDockList，此处不重复
  applyViewDefault();
  renderSortActive();
  syncDockFilterLabel();
  renderDockList();

  return {
    /** 只重画数据，不重建 DOM —— 移动端侧栏复用面板时用（见 index.ts: mountDock） */
    refresh() {
      if (destroyed) return;
      renderSortActive();
      syncDockFilterLabel();
      renderDockList();
    },
    /**
     * 当前是否处于「所有未完成」默认态。
     * 入口据此判断双击日历空白处该「切回默认」还是「隐藏右侧栏」（见 main.ts 的 toggleDock）。
     */
    isDefaultState: () => focusDate === null && dockFilter === "undone",
    /** 是否处于聚焦态（聚焦某日 / 某月 / 某周）—— 入口据此决定双击该切到月/周还是关闭右侧栏 */
    isScopedState: () => focusDate !== null,
    destroy() {
      destroyed = true;
      // 先摘掉挂在容器自身上的监听：容器可能被复用（移动端 Dock），
      // 漏掉就会叠加处理器，一次点击触发多次（见 onRootClick 处说明）。
      root.removeEventListener("click", onRootClick);
      root.removeEventListener("input", onRootInput);
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener(FOCUS_DATE_EVENT, onFocusDate);
      document.removeEventListener(VIEW_CHANGE_EVENT, onViewChange);
      document.removeEventListener(DOCK_ALL_UNDONE_EVENT, onAllUndone);
      document.removeEventListener(DOCK_SCOPE_EVENT, onDockScope);
      document.removeEventListener(DOCK_ITEM_DETAIL_EVENT, onItemDetail);
      listScrollEl?.removeEventListener("scroll", onScrollClose);
      window.removeEventListener("resize", onScrollClose);
      unsub();
      root.empty();
    }
  };
}

/**
 * 勾选待办（Dock 走这条）：返回 Promise，便于调用方在同步完成后再解除重渲染抑制。
 * 这里只负责「改状态 + 落库同步」，DOM 由调用方就地更新（避免整列表重建导致闪烁/滚动复位）。
 */
export function toggleTodoDone(ctx: PanelCtx, item: CalItem): Promise<void> {
  if (item.kind !== "todo") return Promise.resolve();
  const done = item.percent === 100;
  item.percent = done ? 0 : 100;
  item.status = done ? "NEEDS-ACTION" : "COMPLETED";
  if (!done) item.completedAt = new Date().toISOString().slice(0, 19);
  else item.completedAt = undefined;
  return ctx.sync.updateItem(item);
}

export function stepCursor(cursor: string, mode: ViewMode, dir: number): string {
  const d = parseLocalStamp(cursor);
  if (mode === "year") {
    d.setFullYear(d.getFullYear() + dir);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (mode === "month") {
    d.setDate(1);
    d.setMonth(d.getMonth() + dir);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (mode === "week") return addDays(cursor, dir * 7);
  return addDays(cursor, dir);
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export { fmtTime, isDateOnly, parseLocalStamp };
