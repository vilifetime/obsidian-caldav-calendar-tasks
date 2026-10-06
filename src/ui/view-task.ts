/**
 * 任务视图：模仿思源「任务笔记管理」插件的下拉筛选风格。
 * 顶部一个筛选下拉（12 个维度 + 计数），下方展示当前筛选下的列表。
 *
 * ## 列表按时间轴分组（2026-10-06）
 *
 * 此前是**平铺**且**无排序** —— 顺序取决于服务器返回，190 条待办里
 * 「逾期 18 天」与「无日期」混在一起，扫不出轻重缓急。
 * 现按「逾期 / 今天 / 明天 / 本周 / 下周后 / 无日期」分桶，组头带计数、可折叠。
 * 纯粹是**渲染层的分桶**，不改动CalItem、不涉及同步逻辑。
 *
 * ## 日程事件混入（可选）
 *
 * 默认只列待办。设置里打开「任务视图中显示日程事件」后，日程也进同一列表；
 * 此时才再出现「任务视图中显示过期日程」这一层开关（嵌套联动）。
 */
import { addDays, defaultStartStamp, diffDays, parseLocalStamp, startOfWeek, todayStamp } from "../core/date";
import type { CalItem } from "../core/types";
import { calEventColor } from "../core/types";
import { occurrencesInRange } from "../core/ics";
import { calColorOf, escape, keyOfItem, todoDueOccurrences, type ViewArgs } from "./view-common";
import { setHtml } from "./dom";

type FilterKey =
  | "today"
  | "tomorrow"
  | "next7"
  | "thisweek"
  | "future"
  | "overdue"
  | "past7"
  | "allincomplete"
  | "nodate"
  | "todaydone"
  | "yesterdaydone"
  | "doneall";

interface TaskFilter {
  key: FilterKey;
  label: string;
  match: (it: CalItem, due: string) => boolean;
}

function completedOn(it: CalItem, dateStr: string): boolean {
  return it.percent === 100 && !!it.completedAt && it.completedAt.slice(0, 10) === dateStr;
}

export function renderTaskView({ ctx, viewEl, occurrences }: ViewArgs): void {
  const today = todayStamp();
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  const in7 = addDays(today, 7);
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);
  const past7Start = addDays(today, -7);

  const filters: TaskFilter[] = [
    { key: "today", label: "今日", match: (_it, d) => !done(_it) && d === today },
    { key: "tomorrow", label: "明日", match: (_it, d) => !done(_it) && d === tomorrow },
    {
      key: "next7",
      label: "未来七天",
      match: (_it, d) => !done(_it) && d > tomorrow && d <= in7
    },
    {
      key: "thisweek",
      label: "本周",
      match: (_it, d) => !done(_it) && d >= weekStart && d <= weekEnd
    },
    { key: "future", label: "未来", match: (_it, d) => !done(_it) && d > in7 },
    { key: "overdue", label: "过期", match: (_it, d) => !done(_it) && !!d && d < today },
    {
      key: "past7",
      label: "过去七天",
      match: (_it, d) => !done(_it) && !!d && d >= past7Start && d < today
    },
    { key: "allincomplete", label: "所有未完成", match: (_it) => !done(_it) },
    { key: "nodate", label: "无日期", match: (_it, d) => !done(_it) && !d },
    { key: "todaydone", label: "今日已完成", match: (it) => completedOn(it, today) },
    { key: "yesterdaydone", label: "昨日已完成", match: (it) => completedOn(it, yesterday) },
    { key: "doneall", label: "已完成", match: (it) => done(it) }
  ];

  // 收集启用日历下的条目。默认只有待办（VTODO）；
  // 设置里打开「任务视图中显示日程事件」后，日程（VEVENT）也进同一列表。
  const enabled = new Set(ctx.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url));
  const showEvents = ctx.store.settings.showEventsInTaskView === true;
  const showExpired = ctx.store.settings.showExpiredEventsInTaskView === true;
  /** 列表里的一行。`due` 为归属日期（YYYY-MM-DD），无日期为空串。 */
  const rows: { it: CalItem; due: string; isEvent: boolean }[] = [];
  const endMs = parseLocalStamp(addDays(today, 400)).getTime();
  const startMs = parseLocalStamp(addDays(today, -400)).getTime();
  for (const it of ctx.store.getAll()) {
    if (it.deleted) continue;
    if (it.kind !== "todo" && it.kind !== "event") continue;
    if (!enabled.has(it.calendarUrl)) continue;
    if (it.kind === "event" && !showEvents) continue;

    if (it.kind === "todo") {
      // 待办的归属时间段一律以「到期日期」为准（无到期日则进「无日期」）
      const dueSrc = it.end;
      if (!dueSrc) {
        rows.push({ it, due: "", isEvent: false });
        continue;
      }
      const occs = todoDueOccurrences(it, parseLocalStamp(today).getTime(), endMs);
      rows.push({ it, due: occs.length && occs[0] ? occs[0].slice(0, 10) : dueSrc.slice(0, 10), isEvent: false });
      continue;
    }

    // 日程：取时间窗内最近一次发生；已过期是否收进列表取决于第二层开关。
    // 过期的日程默认藏起来（没有「完成」语义，默认显示只会污染列表）。
    const occs = occurrencesInRange(it, startMs, endMs);
    let due = "";
    if (occs.length) {
      // occurrencesInRange 按时间升序，取第一个尚未过去的；全在过去则取最后一个
      const future = occs.find((o) => o.slice(0, 10) >= today);
      due = (future ?? occs[occs.length - 1]).slice(0, 10);
    } else {
      due = it.start.slice(0, 10);
    }
    const isPast = due !== "" && due < today;
    // 「显示过期日程」未开启时，过期日程不进列表（没有「完成」语义，
    // 默认显示只会污染待办列表）。注意是 continue 不是 break —— 还要继续遍历。
    if (isPast && !showExpired) continue;
    rows.push({ it, due, isEvent: true });
  }
  const todos = rows;

  const countOf = (f: TaskFilter) => todos.filter((t) => f.match(t.it, t.due)).length;
  //外层断言必要（dataset.filter 是 string，|| 之后仍是 string，需收窄到 FilterKey）；
  // 内层那个 `as FilterKey` 紧跟在 `||` 结果之后，作用对象已是 string，**完全不改变类型**
  // （社区扫描报的 no-unnecessary-type-assertion 就是它），故去掉。
  const current: FilterKey = (viewEl.dataset.filter || "allincomplete") as FilterKey;

  /** iCal PRIORITY（1 最高、9 最低）→ 文案与配色级别；覆盖 1~9 全部取值 */
  const priorityMeta = (p?: number): { label: string; cls: string } => {
    if (!p || p <= 0) return { label: "", cls: "" };
    if (p <= 2) return { label: "紧急", cls: "prio-urgent" };
    if (p <= 4) return { label: "高", cls: "prio-high" };
    if (p <= 6) return { label: "中", cls: "prio-mid" };
    return { label: "低", cls: "prio-low" };
  };

  /**
   * 时间轴分组（2026-10-06）。
   *
   * 顺序即「轻重缓急」：逾期的最该做，无日期的沉到最后。
   * 「本周」= **明天之后到本周日**（自然周，周一起算 —— 雄哥确认）。
   *  故它的跨度随「今天是周几」浮动：周一进来是 6 天，周二进来只剩 4 天。
   * 「下周后」= weekEnd 之后（含更远）；无日期 = 未设到期日。
   *
   * 组头用 --group-color 承载该组紧迫度色，点一下可折叠；只有一组时不显示组头
   * （避免「今天到期」这类筛选下多出一层无用标题）。
   */
  type Row = { it: CalItem; due: string; isEvent: boolean };
  const GROUPS: { key: string; label: string; color: string; match: (r: Row) => boolean }[] = [
    { key: "overdue", label: "逾期", color: "var(--caldav-danger)", match: (r) => !done(r.it) && r.due !== "" && r.due < today },
    { key: "today", label: "今天", color: "#BA7517", match: (r) => !done(r.it) && r.due === today },
    { key: "tomorrow", label: "明天", color: "#378ADD", match: (r) => !done(r.it) && r.due === tomorrow },
    { key: "thisweek", label: "本周", color: "#1D9E75", match: (r) => !done(r.it) && r.due > tomorrow && r.due <= weekEnd },
    { key: "later", label: "下周后", color: "#888780", match: (r) => !done(r.it) && r.due > weekEnd },
    { key: "nodate", label: "无日期", color: "#B4B2A9", match: (r) => !done(r.it) && r.due === "" },
    { key: "done", label: "已完成", color: "#1D9E75", match: (r) => done(r.it) }
  ];

  /** 把筛选后的列表按组切分；每组内部按「日期升序 → 有优先级的在前」排 */
  function bucketize(list: Row[]): { g: (typeof GROUPS)[number]; items: Row[] }[] {
    const out: { g: (typeof GROUPS)[number]; items: Row[] }[] = [];
    for (const g of GROUPS) {
      const items = list.filter(g.match);
      if (!items.length) continue;
      items.sort((a, b) => {
        // 逾期的排最前（更早的更急），无日期恒沉底
        if (a.due === "" || b.due === "") return a.due === "" ? 1 : -1;
        if (a.due !== b.due) return a.due < b.due ? -1 : 1;
        // 同一天：优先级高的（数字小）排前
        const pa = a.it.priority || 9;
        const pb = b.it.priority || 9;
        return pa - pb;
      });
      out.push({ g, items });
    }
    return out;
  }

  /** 已完成组的折叠状态存在 viewEl 的 dataset 上，跨筛选切换保持 */
  function isCollapsed(gkey: string): boolean {
    if (gkey !== "done") return false; // 只有已完成组可折叠
    const raw = viewEl.dataset.collapsedGroups;
    if (!raw) return true; // 已完成默认折叠 —— 181 条不该和待办抢注意力
    return raw.split(",").includes(gkey);
  }
  function setCollapsed(gkey: string, collapsed: boolean): void {
    const cur = (viewEl.dataset.collapsedGroups || "").split(",").filter(Boolean);
    const next = collapsed ? [...new Set([...cur, gkey])] : cur.filter((x) => x !== gkey);
    if (next.length) viewEl.dataset.collapsedGroups = next.join(",");
    else delete viewEl.dataset.collapsedGroups;
  }

  /** 单条渲染；抽成函数是为了让「分组列表」与「不分组的扁平列表」共用同一份标记 */
  function itemHtml({ it, due, isEvent }: Row): string {
    const k = keyOfItem(it);
    const isDone = done(it);
    const overdue = !isDone && !!due && due < today;
    const pr = priorityMeta(it.priority);
    const cal = ctx.store.settings.calendars.find((c) => c.url === it.calendarUrl);
    const dueText = isDone
      ? it.completedAt
        ? "完成于 " + it.completedAt.slice(5, 10)
        : "已完成"
      : !due
      ? "无日期"
      : due === today
      ? "今天"
      : due === tomorrow
      ? "明天"
      : overdue
      ? `逾期 ${Math.abs(diffDays(due, today))} 天`
      : due.slice(5);
    // 日程没有「完成」语义：勾选框改为「打开详情」，且不显示优先级（VEVENT 无 PRIORITY）
    const check = isEvent
      ? `<span class="cal-task-check cal-task-check--event" title="日程，不可勾选"></span>`
      : `<button class="cal-task-check" data-toggle="${k}" title="${isDone ? "标记未完成" : "标记完成"}">${isDone ? "✓" : ""}</button>`;
    const prio = !isEvent && pr.label ? `<span class="cal-task-priority ${pr.cls}">${pr.label}</span>` : "";
    return `
<div class="cal-task ${isDone ? "is-done" : ""} ${overdue ? "is-overdue" : ""} ${isEvent ? "is-event" : ""}" data-open="${k}" style="--cal-color:${calColorOf(ctx, it)}">
  ${check}
  <div class="cal-task-body">
    <div class="cal-task-title">${isEvent ? '<span class="cal-task-kind">日程</span>' : ""}${it.rrule ? "↻ " : ""}${escape(it.summary || "(无标题)")}
      ${prio}</div>
    <div class="cal-task-meta">
      <span class="${overdue ? "cal-task-overdue" : ""}">${dueText}</span>
      ${it.description ? `<span class="cal-task-desc" title="${escape(it.description)}">${escape(it.description).slice(0, 40)}</span>` : ""}
      <span class="cal-task-cal"><i style="background:${calEventColor(cal)}"></i>${escape(cal?.displayName || "")}</span>
    </div>
  </div>
</div>`;
  }

  function listHtml(filterKey: FilterKey): string {
    const f = filters.find((x) => x.key === filterKey)!;
    const list = todos.filter((t) => f.match(t.it, t.due));
    if (!list.length) {
      return `<div class="cal-task-empty">该筛选下暂无任务</div>`;
    }
    /**
    * 只返回列表**内层**内容；外层 `.cal-task-list` 由模板提供。
    * （分组版曾在这里又套一层 `<div class="cal-task-list">`，会与模板里的
    *   外层嵌套 —— 折叠时重渲染的是外层，内层多包一级虽不出错但结构冗余。）
    */
    // 按时间轴分组渲染；只有一组时不显示组头（避免「所有未完成」下多余的一层标题）
    const buckets = bucketize(list);
    if (buckets.length <= 1) {
      return list.map(itemHtml).join("");
    }
    return buckets
      .map(({ g, items }) => {
        const collapsed = isCollapsed(g.key);
        const caret = collapsed ? "▸" : "▾";
        return `
<div class="cal-task-group" data-group="${g.key}">
  <div class="cal-task-group-head" data-toggle-group="${g.key}" role="button" tabindex="0">
    <span class="cal-task-group-caret">${caret}</span>
    <span class="cal-task-group-dot" style="background:${g.color}"></span>
    <span class="cal-task-group-label">${g.label}</span>
    <span class="cal-task-group-count">${items.length}</span>
  </div>
  ${collapsed ? "" : `<div class="cal-task-group-body">${items.map(itemHtml).join("")}</div>`}
</div>`;
      })
      .join("");
  }

  /**
   * 统计条（2026-10-06）：原先 4 张大卡片（各占 1/4 宽、90px 高），
   * 现改为**一行 6 项**紧凑排列，省纵向空间。
   *
   * 数字的字号与配色沿用原样（20px / 各组色），只改排布。
   * 新增的「未来」「无日期」用中性色 —— 二者都不紧急，不该抢注意力，
   * 但也不能淡到像已完成那样看不见。
   *
   * ⚠️ 计数**复用 GROUPS 的 match**，不要另写一套 —— 两处口径容易漂移
   * （统计说 190 待办、分组加起来却不是 190）。
   */
  const undone = todos.filter((t) => !done(t.it));
  const countBy = (key: string): number => {
    const g = GROUPS.find((x) => x.key === key);
    return g ? todos.filter(g.match).length : 0;
  };
  const statHtml = [
    { cls: "cal-stat-total", label: "待办总数", n: undone.length },
    { cls: "cal-stat-today", label: "今日", n: countBy("today") },
    { cls: "cal-stat-overdue", label: "逾期", n: countBy("overdue") },
    // 「未来」= 明天之后的全部未完成（明天 / 本周 / 下周后 三组合并）
    { cls: "cal-stat-future", label: "未来", n: undone.filter((t) => t.due !== "" && t.due > today).length },
    { cls: "cal-stat-nodate", label: "无日期", n: undone.filter((t) => t.due === "").length },
    { cls: "cal-stat-done", label: "已完成", n: countBy("done") }
  ]
    .map((s) => `<div class="cal-task-stat ${s.cls}"><b>${s.n}</b><span>${s.label}</span></div>`)
    .join("");

  const optsHtml = filters
    .map((f) => `<option value="${f.key}" ${f.key === current ? "selected" : ""}>${f.label} (${countOf(f)})</option>`)
    .join("");

  setHtml(
    viewEl,
    `
<div class="cal-task-view">
  <div class="cal-task-summary">${statHtml}</div>
  <div class="cal-task-filterbar">
    <select class="cal-task-filter" data-filter title="按条件筛选">${optsHtml}</select>
    <input class="caldav-input cal-task-quick" placeholder="快速添加待办，回车保存（默认今天）…" data-quickadd/>
  </div>
  <div class="cal-task-list">${listHtml(current)}</div>
</div>`
  );

  const select = viewEl.querySelector<HTMLSelectElement>("[data-filter]");
  select?.addEventListener("change", () => {
    const val = select.value as FilterKey;
    viewEl.dataset.filter = val;
    const list = viewEl.querySelector<HTMLElement>(".cal-task-list");
    if (list) setHtml(list, listHtml(val));
  });

  /**
   * 组头折叠 / 展开。
   *
   * 绑在 `viewEl` 上做事件委托而非逐个组头绑 —— 折叠会让列表整体重渲染，
   * 逐个绑定就得每次重新挂，漏挂一处就点不动。
   */
  viewEl.addEventListener("click", (ev) => {
    const head = (ev.target as HTMLElement).closest<HTMLElement>("[data-toggle-group]");
    if (!head || !viewEl.contains(head)) return;
    const gkey = head.dataset.toggleGroup!;
    setCollapsed(gkey, !isCollapsed(gkey));
    const list = viewEl.querySelector<HTMLElement>(".cal-task-list");
    if (list) setHtml(list, listHtml(current));
  });
  // 键盘可达：组头是 role=button，Enter / Space 等同点击
  viewEl.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const head = (ev.target as HTMLElement).closest<HTMLElement>("[data-toggle-group]");
    if (!head || !viewEl.contains(head)) return;
    ev.preventDefault();
    const gkey = head.dataset.toggleGroup!;
    setCollapsed(gkey, !isCollapsed(gkey));
    const list = viewEl.querySelector<HTMLElement>(".cal-task-list");
    if (list) setHtml(list, listHtml(current));
  });

  const input = viewEl.querySelector<HTMLInputElement>("[data-quickadd]");
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && input.value.trim()) {
      const title = input.value.trim();
      const cal = ctx.store.settings.calendars.find((c) => c.enabled && c.supportsTodo !== false) || ctx.store.settings.calendars[0];
      void ctx.sync
        .createItem({
          uid: genUid(),
          kind: "todo",
          calendarUrl: cal.url,
          href: cal.url.replace(/\/+$/, "") + "/" + genUid() + ".ics",
          summary: title,
          allDay: false,
          // 快速添加同样落在「下一个整点」，而不是固定 9:00
          start: defaultStartStamp(today),
          end: defaultStartStamp(today),
          priority: 0,
          status: "NEEDS-ACTION",
          percent: 0,
          createdAt: today + "T09:00:00",
          dirty: true
        })
        .then(() => {
          input.value = "";
        });
    }
  });
}

function done(it: CalItem): boolean {
  return it.percent === 100;
}

export function genUid(): string {
  return "sy-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
