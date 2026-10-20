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
  /** sync-collection 支持的 sync-token，空则回退全量 */
  syncToken?: string;
  /** 描述（如 Nextcloud 共享说明） */
  description?: string;
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
  serverUrl: string;
  username: string;
  password: string;
  /** 可选，直接指定日历集合或主目录；空则自动发现 */
  calendarPath: string;
  /** auto：内核代理优先、失败回退直连 */
  channel: "auto" | "proxy" | "direct";
  /** 自动同步间隔（分钟），0 关闭 */
  syncIntervalMin: number;
  /** 启用提醒通知（托盘运行时，对设置了提醒时间的日程/待办到点弹系统通知） */
  enableReminders?: boolean;
  /** 服务端冲突时：server 服务端优先 / local 本地优先 */
  conflict: "server" | "local";
  /** 显示范围：过去 N 天 / 未来 N 天 */
  pastDays: number;
  futureDays: number;
  calendars: CalCalendar[];
  defaultCalendarUrl?: string;
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
  /**
   * 单个内联附件的硬上限（MB），超过在挑选时直接拒绝、不给确认机会。默认 5。
   *
   * 附件以 base64 内联进 ICS 同步，体积会涨约 1/3；服务端普遍限制单条日历数据
   * 大小（Radicale 默认 10MB、PHP 默认 post_max_size 8MB），超了必然 413。
   */
  attachSizeMaxMB?: number;
  /**
   * 整份 ICS（含全部 base64 附件）的硬上限（MB），超过拒绝保存/上传。默认 10。
   *
   * 单文件上限挡不住「多个 4MB 凑 12MB」，所以按真实序列化结果卡总账。
   * 自己的服务器上限更大就把这里调大（报错文案里的数字也取此值）。
   */
  icsSizeMaxMB?: number;
}

export const DEFAULT_SETTINGS: CalSettings = {
  serverUrl: "",
  username: "",
  password: "",
  calendarPath: "",
  channel: "auto",
  syncIntervalMin: 15,
  enableReminders: false,
  conflict: "server",
  pastDays: 90,
  futureDays: 370,
  calendars: [],
  showTodosInCalendar: true,
  categories: DEFAULT_CATEGORIES,
  categoryMulti: false,
  includeOverdueTodos: false,
  attachSizeMaxMB: 5,
  icsSizeMaxMB: 10
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
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
