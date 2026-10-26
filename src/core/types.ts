/** 条目种类 */
export type CalKind = "event" | "todo";

/** 排序方式（Dock 排序菜单 + 月/周视图条目排序共用） */
export type SortMode = "start" | "end" | "priority" | "completed" | "created" | "category" | "title";

/** 本地墙上时间：时间型 "YYYY-MM-DDTHH:mm:ss"，全天 "YYYY-MM-DD" */
export type LocalStamp = string;

export interface Recurrence {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay?: string[]; // ["MO", "TU", ...]（WEEKLY/MONTHLY 生效）
  byMonthDay?: number[]; // MONTHLY 生效
  count?: number;
  until?: LocalStamp;
}

export interface Alarm {
  minutesBefore: number; // 提前分钟数
}

/**
 * 附件（iCalendar ATTACH，2026-10-14 从思源侧同构移植）。
 *
 * Radicale 日历目录只收 iCalendar，传 .txt/.pdf 一律 400（服务端日志
 * `Failed to parse line`），所以附件不能单独放文件，只能内联进条目本身、
 * 跟着 ICS 一起同步（RFC 5545 标准形式，任何客户端都能读）。
 */
export interface CalAttachment {
  /**
   * URI 形式（外链）。与 `b64` **二选一**，两者都空 = 无效条目（保存时忽略）。
   */
  uri?: string;
  /**
   * 二进制内联形式：base64 载荷（**未折行**，折行由序列化时统一做）。
   * 对应 RFC 5545 的 `ATTACH;VALUE=BINARY;ENCODING=BASE64:…`。
   */
  b64?: string;
  /** iCloud（RFC 8607 managed-attachments）返回的托管附件 ID；重传/删除时带回，避免服务器重复建附件 */
  managedId?: string;
  /** 文件名：URI 形式取末段，二进制件用上传时的文件名 */
  name: string;
  /** MIME 类型（FMTTYPE / FBTYPE 参数），可能为空 */
  fmttype?: string;
}

/** 本地缓存的一条日历条目（事件或待办） */
export interface CalItem {
  uid: string;
  kind: CalKind;
  calendarUrl: string;
  /** 服务器资源地址（.ics），PUT/DELETE 用 */
  href: string;
  etag?: string;
  summary: string;
  description?: string;
  location?: string;
  categories?: string[];
  allDay: boolean;
  /** 开始（本地墙上时间） */
  start: LocalStamp;
  /** 结束（本地墙上时间；待办为 due，可为空） */
  end?: LocalStamp;
  /** RRULE 描述；不存在则无重复 */
  rrule?: Recurrence;
  /** RECURRENCE-ID：覆盖实例的基准开始时间 */
  recurId?: LocalStamp;
  exdates?: LocalStamp[];
  alarms?: Alarm[];
  /**
   * 附件：URI 形式（外链）与二进制内联形式（`b64`，见 CalAttachment）并存。
   *
   * ⚠️ 这个字段**就是权威来源** —— 解析时把所有 ATTACH 都收进来，编辑时按它重写。
   * 唯一的例外：字段为 `undefined` 时（老数据，解析发生在本次改动之前），
   * `rebuildComponent` 仍会把原文里的二进制件原样带回，避免升级后第一次编辑就丢附件。
   */
  attachments?: CalAttachment[];
  /** 待办：0 无 9 低 5 中 3 高 1 紧急 */
  priority?: number;
  /** 待办状态：needs-action / in-process / completed */
  status?: string;
  /** 待办完成度 0-100 */
  percent?: number;
  completedAt?: LocalStamp;
  /** 创建时间（本地墙上时间；解析 ICS CREATED 或本地新建时写入） */
  createdAt?: LocalStamp;
  /** 本地脏标记：待上传 */
  dirty?: boolean;
  /** 本地删除标记：同步时执行服务端删除 */
  deleted?: boolean;
  /** 服务端 ICS 原文，编辑时在其基础上修改 */
  raw?: string;
  /**
   * 编辑器会话态：粘贴时是否自动识别标题里的日期时间。默认开（仅显式 false 才关）。
   *
   * **不持久化到 ICS、不参与同步** —— 它只是编辑器打开期间那个勾选框的状态，
   * 关掉弹窗就丢。做成可选字段是为了让「默认勾选」能用一个显式 false 表达：
   * `it.aiParse === false` 才不勾，undefined / true 都勾。
   */
  aiParse?: boolean;
  /**
   * 「换日历搬家」的来源资源：上传成功后要把它从原日历里删掉，否则服务端留孤儿。
   *
   * 触发场景：① 编辑器里直接换日历；② 日程↔待办互转时，原日历不支持目标类型
   * （iCloud 的日历只收 VEVENT、提醒事项只收 VTODO）必须搬到支持它的日历。
   *
   * ⚠️ 顺序铁律：**先 PUT 新资源，成功后再删旧的**。先删后建一旦新建被拒（403/400），
   * 服务端那一条就彻底没了（2026-10-24 雄哥实测）。删除失败只记提示、不阻断上传。
   */
  movedFrom?: {
    href: string;
    calendarUrl?: string;
    etag?: string;
  };
}

export interface CalCalendar {
  url: string;
  displayName: string;
  /** 该日历「日程」的默认颜色（HEX）；空则回退中性灰 */
  eventColor?: string;
  /** 该日历「待办」的默认颜色（HEX）；空则回退 eventColor / 中性灰 */
  todoColor?: string;
  enabled: boolean;
  /** 支持 VTODO */
  supportsTodo?: boolean;
  /** 支持 VEVENT */
  supportsEvent?: boolean;
  /**
   * 是否已真正向服务端问过 `supported-calendar-component-set`（RFC 4791 §5.2.3）。
   *
   * ⚠️ 为什么需要这个标记：`supportsEvent/supportsTodo` 缺省就是 `true`，光看字段
   * 分不清「服务端确实支持」和「压根没问过、取了默认值」。2026-10-24 之前发现日历
   * 的 PROPFIND **根本没请求**这个属性，于是 iCloud 的「提醒事项」集合也被标成
   * 「既支持日程又支持待办」，往里 PUT VEVENT 被 403，且当时的降级策略先删服务端
   * 旧资源才重建，把待办直接删没了。缺此标记的老配置要在同步前补探测。
   */
  componentSetProbed?: boolean;
  /** sync-collection 支持的 sync-token，空则回退全量 */
  syncToken?: string;
  /** 描述（如 Nextcloud 共享说明） */
  description?: string;
}

/**
 * 一个日历账户（2026-10-25 从思源侧同构，2026-10-26 补附件上限）。
 *
 * 此前一个插件只能配一台服务器：serverUrl/凭据/日历全平铺在 CalSettings 上。
 * 现在「服务器 / 日历 / 同步」三类设置**下沉到账户**，每个账户一套；
 * 全局只留不分服务器的设置（同步间隔、提醒、日记、显示、默认账户与日历）。
 *
 * 老数据由 migrateToAccounts() 一次性迁进 accounts[0]。
 */
export interface CalAccount {
  id: string;
  name: string;
  /** 停用后：其日历不显示、不参与同步 */
  enabled: boolean;
  serverUrl: string;
  username: string;
  password: string;
  /** 可选，直接指定日历集合或主目录；空则自动发现 */
  calendarPath: string;
  /**
   * 服务器类型：icloud / caldav。仅作元数据与默认值驱动，
   * 发现逻辑本身类型无关（iCloud 与标准 CalDAV 走同一条 principal→home-set→枚举链）。
   */
  serverType: "icloud" | "caldav";
  /** auto：代理优先、失败回退直连 */
  channel: "auto" | "proxy" | "direct";
  /** 服务端冲突时：server 服务端优先 / local 本地优先 */
  conflict: "server" | "local";
  /** 显示范围：过去 N 天 / 未来 N 天 */
  pastDays: number;
  futureDays: number;
  /**
   * 单个内联附件的硬上限（MB），超过在挑选时直接拒绝。默认 5。
   *
   * ⚠️ 这是**服务器特性**（2026-10-26 下沉到账户）：附件以 base64 内联进
   * ICS 同步，体积涨约 1/3；服务端普遍限制单条日历数据大小（Radicale 默认 10MB、
   * PHP post_max_size 8MB、iCloud 另有一套），不同服务器上限不同，所以每个账户各配。
   */
  attachSizeMaxMB?: number;
  /**
   * 整份 ICS（含全部 base64 附件）的硬上限（MB），超过拒绝保存/上传。默认 10。
   *
   * 单文件上限挡不住「多个 4MB 凑 12MB」，所以按真实序列化结果卡总账。
   * 同样是服务器特性，账户级配置（报错文案里的数字也取此值）。
   */
  icsSizeMaxMB?: number;
  /** 该账户发现的日历集合 */
  calendars: CalCalendar[];
}

/** 生成一个新账户 ID（迁移与「添加账户」共用） */
export function newAccountId(): string {
  return `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 老数据迁移：单账户 settings → accounts 数组。**幂等，可重复调用。**
 *
 * 老数据里 serverUrl/凭据/日历都平铺在 CalSettings 上，这里整体搬进
 * accounts[0]，之后 settings 上不再保留这些字段（避免两处真相漂移）。
 * 老字段全空（全新安装）时建空数组，不造一个空账户占位。
 *
 * ⚠️ 幂等判据是「**老键还在不在**」而不是「accounts 是不是数组」——
 * load() 会先合并 DEFAULT_SETTINGS（自带 accounts: []），
 * 只看数组会让老数据被误判成「已是新结构」而跳过迁移。
 */
export function migrateToAccounts(s: any): void {
  const hasOldKeys = "serverUrl" in s || "username" in s || "password" in s || "calendarPath" in s || "calendars" in s;
  if (!hasOldKeys) return;
  const hasOld = !!(s.serverUrl || s.username || s.password || (Array.isArray(s.calendars) && s.calendars.length));
  if (!Array.isArray(s.accounts)) s.accounts = [];
  // 只有 accounts 为空时才用平铺字段造第一个账户。两者**共存**时（云同步把旧副本与
  // 新数据混在一起的极端情况）平铺字段只是残留，绝不能拿它覆盖现有账户数组 ——
  // 那是一次性抹掉用户其余全部账户的静默数据丢失。
  if (hasOld && !s.accounts.length) {
    s.accounts = [
      {
        id: newAccountId(),
        name: s.serverType === "icloud" ? "iCloud 账户" : "CalDAV 账户",
        enabled: true,
        serverUrl: s.serverUrl || "",
        username: s.username || "",
        password: s.password || "",
        calendarPath: s.calendarPath || "",
        serverType: s.serverType || "caldav",
        channel: s.channel || "auto",
        conflict: s.conflict || "server",
        pastDays: typeof s.pastDays === "number" ? s.pastDays : 90,
        futureDays: typeof s.futureDays === "number" ? s.futureDays : 370,
        // 附件/ICS 上限原来是全局值，本质是服务器特性 → 迁移时原值带给账户
        attachSizeMaxMB: typeof s.attachSizeMaxMB === "number" ? s.attachSizeMaxMB : undefined,
        icsSizeMaxMB: typeof s.icsSizeMaxMB === "number" ? s.icsSizeMaxMB : undefined,
        calendars: Array.isArray(s.calendars) ? s.calendars : []
      }
    ];
  }
  // 老字段从 settings 上摘掉：留着就会被 persist 原样写回，变成第二处真相
  for (const k of [
    "serverUrl",
    "username",
    "password",
    "calendarPath",
    "serverType",
    "channel",
    "conflict",
    "pastDays",
    "futureDays",
    "calendars",
    "attachSizeMaxMB",
    "icsSizeMaxMB"
  ]) {
    delete s[k];
  }
}

/** 所有启用账户 */
export function enabledAccounts(s: CalSettings): CalAccount[] {
  return (s.accounts || []).filter((a) => a && a.enabled);
}

/**
 * **真正在用**的日历集合 = 启用账户下的启用日历。
 *
 * 全仓唯一入口 —— 视图 / Dock / 日记 / 同步都走它，避免十几处
 * `settings.calendars.filter(enabled)` 各写一遍、漏改一处就表现为
 * 「停用账户的条目还在显示」。
 */
export function enabledCalendars(s: CalSettings): CalCalendar[] {
  const out: CalCalendar[] = [];
  for (const a of enabledAccounts(s)) {
    for (const c of a.calendars || []) if (c.enabled) out.push(c);
  }
  return out;
}

/** 按日历集合地址反查所属账户（同步层按它取凭据与通道） */
export function accountOfUrl(s: CalSettings, calUrl: string): CalAccount | undefined {
  if (!calUrl) return undefined;
  for (const a of s.accounts || []) {
    for (const c of a.calendars || []) {
      if (c.url === calUrl) return a;
    }
  }
  return undefined;
}

/** 按日历集合地址找日历配置（跨所有账户，含停用日历） */
export function findCalendarByUrl(s: CalSettings, calUrl: string): CalCalendar | undefined {
  if (!calUrl) return undefined;
  for (const a of s.accounts || []) {
    const hit = (a.calendars || []).find((c) => c.url === calUrl);
    if (hit) return hit;
  }
  return undefined;
}

/** 按条目反查所属账户 */
export function accountOfItem(s: CalSettings, item: CalItem): CalAccount | undefined {
  return accountOfUrl(s, item.calendarUrl);
}

/**
 * 新建条目的默认日历：设置页按「默认账户 → 默认日历」两级选，最终落在
 * `defaultCalendarUrl`。解析顺序：① url 仍有效（属于启用账户且日历启用）；
 * ② defaultAccountId 指向的启用账户的第一个启用日历；③ 回退到**第一个启用
 * 账户的第一个启用日历**（账户停用/日历删掉时不能指着空气）。
 */
export function resolveDefaultCalendar(s: CalSettings): CalCalendar | undefined {
  const all = enabledCalendars(s);
  if (s.defaultCalendarUrl) {
    const hit = all.find((c) => c.url === s.defaultCalendarUrl);
    if (hit) return hit;
  }
  if (s.defaultAccountId) {
    const acc = enabledAccounts(s).find((a) => a.id === s.defaultAccountId);
    const cal = acc?.calendars.find((c) => c.enabled);
    if (cal) return cal;
  }
  return all[0];
}

/** 找不到日历 / 日历没设颜色时的中性兜底色 */
export const NEUTRAL_ITEM_COLOR = "#64748b";

/** 日历的「日程默认色」——顺带承担日历自身的身份色（点、徽标等） */
export function calEventColor(cal?: CalCalendar | null): string {
  return cal?.eventColor || NEUTRAL_ITEM_COLOR;
}

/** 日历的「待办默认色」；没单独设过就跟着日程色走 */
export function calTodoColor(cal?: CalCalendar | null): string {
  return cal?.todoColor || cal?.eventColor || NEUTRAL_ITEM_COLOR;
}

/** 任务分类定义（编辑弹窗的彩色药丸） */
export interface CategoryDef {
  id: string;
  name: string;
  /** 药丸底色（HEX） */
  color: string;
  /** 图标（emoji 或单字符） */
  icon: string;
}

export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { id: "work", name: "工作", color: "#e05a4c", icon: "🎯" },
  { id: "study", name: "学习", color: "#3d82d6", icon: "📖" },
  { id: "life", name: "生活", color: "#43a05c", icon: "🍀" }
];

export interface CalSettings {
  /**
   * 多日历账户（2026-10-25 从思源侧同构）。「服务器 / 日历 / 同步」三类设置
   * 已下沉到这里，每个账户一套；全局只留不分服务器的设置（同步间隔、提醒、
   * 日记、显示、默认账户与日历）。老数据由 migrateToAccounts() 一次性迁移。
   */
  accounts: CalAccount[];
  /** 自动同步间隔（分钟），0 关闭。全局一个周期，跑的时候把所有启用账户过一遍 */
  syncIntervalMin: number;
  /** 启用提醒通知（托盘运行时，对设置了提醒时间的日程/待办到点弹系统通知） */
  enableReminders?: boolean;
  /**
   * 新建条目的默认日历（全局一个，不区分账户）。
   * 配套 defaultAccountId 组成设置页的「默认账户 + 默认日历」两级选择；
   * 停用/删除后由 resolveDefaultCalendar() 回退到第一个启用账户的第一个启用日历。
   */
  defaultCalendarUrl?: string;
  /**
   * 新建条目的默认**账户**（设置页第一级下拉）。只影响设置页联动与回退顺序，
   * 最终生效的仍是 defaultCalendarUrl（日历 url 全仓唯一）。
   */
  defaultAccountId?: string;
  /**
   * 日历视图（年/月/周/日）是否显示待办任务，默认 true。
   * 关掉后日历视图只显示日程事件 —— 待办仍可在「任务视图」与 Dock 列表中看到与勾选，
   * 所以这是一个纯展示开关，不影响数据与同步。
   */
  showTodosInCalendar?: boolean;
  /**
   * 任务视图是否把**日程事件**（VEVENT）也一并显示，默认 false。
   *
   * 任务视图本来只列待办（VTODO）。打开后同一列表里会混入日程，
   * 便于「今天既要做什么、又要做什么」一眼看全。
   * 纯展示开关，不影响数据与同步。
   */
  showEventsInTaskView?: boolean;
  /**
   * 「已过期日程」开关**只管日程**，与上面那个开关相互独立：
   *
   * - `showEventsInTaskView = false` → 日程**完全不进列表**，统计里也不含它
   *   （与 `showExpiredEventsInTaskView` 无关，两值组合下都如此）
   * - `showEventsInTaskView = true`  → 日程进列表与统计；此时才由
   *   `showExpiredEventsInTaskView` 决定**过期的**那些是否也进来
   *
   * 二者是「要不要显示日程」与「过期日程要不要显示」两层，
   * 不是同一个开关的两级。
   */
  showExpiredEventsInTaskView?: boolean;
  /** 任务分类（编辑弹窗药丸选择），空数组时回退 DEFAULT_CATEGORIES */
  categories?: CategoryDef[];
  /** 分类是否允许多选 */
  categoryMulti?: boolean;
  /**
   * 插入日记时是否把逾期的待办也写进去，默认 false。
   *
   * 关着时只写「当日 / 本周 / 本月」范围内的条目，逾期的待办一条都不写
   * —— 用户看到的日记是「接下来要做什么」。
   *
   * 打开后，DUE 早于今天零点且未完成的待办会被排在日记最前面，
   * 单独成一个「逾期待办」子节，与范围内的条目不混在一起。
   * 已经落在范围内的条目不会重复计入（「所有」范围本来含它们）。
   *
   * 2026-10-12 从思源侧同步回来（见思源 CalSettings.includeOverdueTodos）。
   */
  includeOverdueTodos?: boolean;

  // ── 中国日历叠加层（2026-10-26 从思源侧同构）──
  // 纯展示：节假日/农历/节气一律不进 CalDAV、不参与同步、不写服务器。
  // 节假日联网按年拉取缓存；农历/节气走内置 lunar-javascript 算法。
  /** 显示节假日（名称 + 休/班） */
  showHolidaysCN?: boolean;
  /** 显示农历 */
  showLunarCN?: boolean;
  /** 显示节气（优先于农历，有节气时只显节气） */
  showTermCN?: boolean;
  /**
   * 节假日数据源：timor / holiday-cn / chinese-days / custom。
   * 默认 timor（国内部署，最稳）；各预设都把 timor 作为最终兜底候选。
   */
  holidayCnSource?: "timor" | "holiday-cn" | "chinese-days" | "custom";
  /** 自定义源 URL（holidayCnSource=custom 时生效，支持 {year} 占位） */
  holidayCnCustomUrl?: string;
  /** 节假日缓存复查频率：manual 不自动复查 / daily 每日 / weekly 每周 */
  holidayCnUpdateFreq?: "manual" | "daily" | "weekly";

  // ── 杂项（MISC）：两处筛选下拉的默认值（2026-10-26）──
  /**
   * 侧边栏 Dock 打开时的默认筛选。
   * `"last"` = 上次使用项（本机 localStorage 记住；无记录时回落「所有未完成」），
   * 其余取值 = 固定为该筛选，每次打开都用它。
   */
  defaultDockFilter?: "last" | DockFilterKey;
  /**
   * 任务视图打开时的默认筛选，语义同 defaultDockFilter。
   */
  defaultTaskFilter?: "last" | TaskFilterKey;
}

/**
 * 侧边栏 Dock 筛选下拉的全部键（顺序即下拉中的顺序，见 ui/filter-pref.ts）。
 *
 * ⚠️ 放在 core/types.ts 而不是 ui/panel.ts：设置项 `defaultDockFilter` 的类型
 * 要引用它，而 core 不能反向依赖 ui（会成环）。SortMode 同理早已放这里。
 */
export type DockFilterKey =
  | "today" | "tomorrow" | "next7" | "thisweek" | "future"
  | "overdue" | "past7" | "undone" | "nodate"
  | "doneToday" | "doneYesterday" | "done";

/** 任务视图筛选下拉的全部键（见 ui/filter-pref.ts） */
export type TaskFilterKey =
  | "allitems" | "today" | "tomorrow" | "next7" | "thisweek" | "future"
  | "overdue" | "past7" | "allincomplete" | "nodate"
  | "todaydone" | "yesterdaydone" | "doneall";

/**
 * 「清理旧服务器条目」的备份。
 *
 * 存的是**条目快照**（含 raw 原文），恢复时直接写回本地仓库即可，
 * 不需要再跟服务端同步一趟。
 *
 * ⚠️ 它存在**数据文件的顶层**（PersistData.purgeBackup），不是 settings 里 ——
 * settings 会被「配置备份」单独抄走（core/config-backup.ts 明确只存配置、
 * 不存条目），把条目快照塞进 settings 会让那个备份文件凭空膨胀几十 MB，
 * 破坏它「轻量配置备份」的定位。
 */
export interface PurgeBackup {
  /** 清理时间（ISO 字符串） */
  at: string;
  /** 清理后保留的账户名（可能有多个，顿号分隔） */
  keptServer: string;
  /** 被清理的账户名 */
  removedServers: string;
  /** 被清理的条目数 */
  count: number;
  /** 被清理的条目快照 */
  items: CalItem[];
  /** 一并被移除的日历配置（恢复时连配置一起还原，可直接重新启用） */
  calendars?: CalCalendar[];
}

export const DEFAULT_SETTINGS: CalSettings = {
  accounts: [],
  syncIntervalMin: 15,
  enableReminders: false,
  showTodosInCalendar: true,
  categories: DEFAULT_CATEGORIES,
  categoryMulti: false,
  includeOverdueTodos: false,
  // 中国日历叠加层默认全开（纯展示，不影响同步）；数据源默认 timor（国内部署最稳），每周复查一次
  showHolidaysCN: true,
  showLunarCN: true,
  showTermCN: true,
  holidayCnSource: "timor",
  holidayCnUpdateFreq: "weekly",
  // 两处筛选下拉的默认值：一律「上次使用项」（本机记住；无记录时回落「所有未完成」）
  defaultDockFilter: "last",
  defaultTaskFilter: "last"
};

export interface SyncState {
  lastSync?: string;
  lastError?: string;
  /**
   * 上次同步的**中性提示**（如「对账清理了 N 条幽灵条目」）。
   *
   * 为什么不能塞进 `lastError`：对账是正常自愈，不是失败。塞进去会让状态栏
   * 显示「同步失败」、面板挂红色报错横幅，把一次成功同步报成失败
   * （2026-10-10 实测）。两者必须分通道。
   */
  lastNote?: string;
  /**
   * 自上次全量同步以来，**即时推送**（新建/编辑/删除单条）累计成功的条目 key。
   *
   * 为什么要有这个：单条编辑走 `pushAndPersist()` 立刻上云，它的计数原先被
   * 整个丢弃。用户随后点全量同步时会看到「上传 0 · 删除 0」，以为改动没同步
   * （2026-10-10 实测）。故这里先攒着，等下一轮 syncAll 合并进报告再清零。
   *
   * **按 key 而非按条数**：同一条目被编辑 N 次会推 N 次，按轮次累加会让
   * 同步报告虚报「上传 N 条」（2026-10-19 雄哥实测「操作几次就报上传几次」）。
   * 合并时与本轮 uploadedKeys 取 Set 并集去重，同一条目只计一条。
   */
  pendingUploadedKeys?: string[];
  /** 同上，即时推送累计成功的删除条目 key */
  pendingDeletedKeys?: string[];
}

export interface PersistData {
  settings: CalSettings;
  items: CalItem[];
  sync: SyncState;
  /**
   * 凭据加密的主密钥（base64）。**故意与密文放在同一份数据里**：
   * 这份数据会被思源云同步带到别的设备，密钥同行才能保证「换设备/多端」都解得开。
   * 详见 core/secret.ts 里对 v2（设备绑定密钥）被淘汰的原因说明。
   */
  keyring?: string;
  /**
   * 最近一次「清理旧服务器条目」的备份（见 PurgeBackup）。
   *
   * 放顶层而不是 settings 里 —— settings 会被「配置备份」单独抄走，
   * 那个文件明确只存配置不存条目（见 core/config-backup.ts 的取舍说明）。
   */
  purgeBackup?: PurgeBackup;
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
