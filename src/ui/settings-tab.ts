/**
 * 设置界面（PluginSettingTab）
 *
 * 由思源版 `ui/settings-dialog.ts`（379 行，自定义 Dialog）重写为 Obsidian 标准设置页。
 *
 * 保留的能力：服务器/账号/密码、日历发现与逐个勾选（含日程色与待办色分设）、
 * 同步间隔与冲突策略、提醒开关与自检、显示范围。
 * 新增：日记目录（宿主侧设置，思源版靠内核 API 查日记文档，Obsidian 需显式指定）。
 *
 * 密码语义与思源版一致：内存里是明文，落盘时由 CalStore.persist() 自动加密为 enc:v3。
 *
 * ## 只有一套实现：声明式 `getSettingDefinitions()`
 *
 * Obsidian 1.13.0 起支持**声明式设置 API**：插件返回一份设置项的**数据描述**，
 * Obsidian 负责渲染，并把这些项纳入设置搜索 —— 用户在设置搜索框里能直接搜到
 * 「同步间隔」「密码」「冲突」这些项。
 *
 * 本插件的 `minAppVersion` 就是 **1.13.0**，所以只保留这一套实现。原先还留了
 * 命令式的 `display()` 给 1.5.0~1.12 兜底，代价是**同一批设置项写两遍**
 * （本文件一度631 行），每次改动都要同步两处，极易漏改。已整段删除。
 *
 * 三处声明式表达不了的设置用 `render` 自绘（仍用 `new Setting(...)`）：
 * 密码框（text 控件无 password 选项）、显示范围（一行两个数字）、按钮组。
 */
import { Notice, PluginSettingTab, Setting, type App, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type CalDavPlugin from "@/main";
import type { HostSettings } from "@/main";
import { describeNetworkError, discoverCalendars, testConnection } from "@/core/caldav";
import { clearAuthCache } from "@/core/http";
import {
  calEventColor,
  calTodoColor,
  enabledAccounts,
  enabledCalendars,
  findCalendarByUrl,
  newAccountId,
  type CalAccount,
  type CalCalendar,
  type CalSettings
} from "@/core/types";
import { t, currentLang } from "@/i18n";
import { forceRefreshChinaCalendar, getLastHolidayError } from "@/core/holiday-cn";
import { DOCK_FILTER_KEYS, DOCK_FILTER_I18N, TASK_FILTER_KEYS, TASK_FILTER_I18N } from "./filter-pref";
import { formatTimeText } from "@/core/server-id";
import type { TimerHandle } from "@/constants";
/**
 * 按动态键读写设置对象的一个字段。
 *
 * 声明式设置的控件通过 `key` 字符串标识自己，而 `CalSettings` /
 * `HostSettings` 都没有索引签名，故直接 `obj[key]` 过不了类型检查。
 * 集中到这两个函数里，避免同一处`as unknown as Record<...>` 重复写三遍
 * ——断言本身是必要的（不是社区扫描报的 unnecessary assertion）。
 */
function dynamicField(obj: object, key: string): unknown {
  return (obj as Record<string, unknown>)[key];
}

function setDynamicField(obj: object, key: string, value: unknown): void {
  (obj as Record<string, unknown>)[key] = value;
}

/**
 * 「新建条目的默认日历」下拉的选项。
 *
 * 随**默认账户**联动：选了账户就只列该账户的启用日历，没选（自动）就列全部启用日历。
 * 当前已存的值即使不在列表里（如日历被停用）也要补回来 —— 否则下拉显示不出原值，
 * 用户一眼看去像「默认日历丢了」。
 */
function defaultCalendarOptions(s: CalSettings): Record<string, string> {
  const acc = enabledAccounts(s).find((a) => a.id === s.defaultAccountId);
  const base = acc ? (acc.calendars || []).filter((c) => c.enabled) : enabledCalendars(s);
  const cur = s.defaultCalendarUrl ? findCalendarByUrl(s, s.defaultCalendarUrl) : undefined;
  const list = cur && !base.some((c) => c.url === cur.url) ? [...base, cur] : base;
  const out: Record<string, string> = { "": t("settings.defaultCalendarAuto") };
  for (const c of list) out[c.url] = acc ? c.displayName : `${accNameOf(s, c.url)}${c.displayName}`;
  return out;
}

/** 日历所属账户名（跨账户展示时用于消除同名日历的歧义），查不到返回空串 */
function accNameOf(s: CalSettings, calUrl: string): string {
  const acc = (s.accounts || []).find((a) => (a.calendars || []).some((c) => c.url === calUrl));
  return acc ? `${acc.name} / ` : "";
}

export class CalDavSettingTab extends PluginSettingTab {
  private plugin: CalDavPlugin;

  constructor(app: App, plugin: CalDavPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private get s() {
    return this.plugin.store.settings;
  }

  // ─────────────────────────────────────────────────────────────
  // 声明式设置（Obsidian >= 1.13.0）
  // ─────────────────────────────────────────────────────────────

  /**
   * 设置项的取值/存值桥接。
   *
   * 声明式 API 的控件通过 `key` 标识自己，取值与持久化都回到这两个方法。
   * 本插件的设置分散在两处，故按 key 前缀路由：
   *   - `host.*` →宿主侧设置（日记目录、系统通知），走 plugin.updateHostSettings
   *   - 其余→ core 的 CalSettings，走 store.saveSettings + persist
   */
  /**
   * 当前展开（手风琴）的账户 id。
   *
   * ⚠️ 与思源端同一条铁律（2026-10-25 事故）：**只渲染展开账户的控件**。
   * 思源端曾把收起账户的输入框也渲染出来再 hidden，结果同名控件同时在 DOM 里，
   * 全局查询只会命中第一张卡 —— 添加第二个账户保存后数据被串写成第一个账户的。
   * Obsidian 侧用「defs 里只为展开账户 push 子项」实现同一效果，
   * 且每个控件的 `key` 带账户 id（`acc.<id>.<field>`），从根上不存在歧义。
   */
  private activeAccId: string | null = null;

  /** 当前展开的账户；id 失效（被删）时返回 undefined */
  private activeAcc(): CalAccount | undefined {
    if (!this.activeAccId) return undefined;
    return (this.s.accounts || []).find((a) => a.id === this.activeAccId);
  }

  /** 把 key 拆成账户 + 字段（`acc.<id>.<field>` → [账户, 字段]），非账户键返回 null */
  private accKey(key: string): { acc: CalAccount; field: string } | null {
    if (!key.startsWith("acc.")) return null;
    const i = key.indexOf(".", 4);
    if (i < 0) return null;
    const id = key.slice(4, i);
    const field = key.slice(i + 1);
    const acc = (this.s.accounts || []).find((a) => a.id === id);
    return acc ? { acc, field } : null;
  }

  getControlValue(key: string): unknown {
    if (key.startsWith("host.")) return this.hostValue(key);
    const ak = this.accKey(key);
    if (ak) return (ak.acc as unknown as Record<string, unknown>)[ak.field];
    return dynamicField(this.s, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key.startsWith("host.")) {
      // key 由本文件的 getSettingDefinitions 固定为 "host.systemNotification" /
      // "host.dailyNoteFolder" 两个，动态拼出来的对象无法静态满足 Partial<HostSettings>。
      // 这里做一次运行时校验：只接受 HostSettings 里真实存在的键，其余忽略 ——
      // 比原来的 `as never` 诚实（never 等于关掉类型检查，且拼错键会静默写坏数据）。
      const field = key.slice(5);
      // 不用 `as Partial<HostSettings>` 断言：社区扫描报 unnecessary assertion ——
      // 动态 key 的对象本身就能匹配 Partial<>，因为 HostSettings 全是可选字段。
      // 也不用 satisfies：它把数组收窄成字面量元组，includes 的参数类型跟着变窄，
      // 反而要求只能传那几个字面量。显式注解成 `readonly (keyof HostSettings)[]`：
      // 键的可拼写性由注解保证；新增字段忘了加进这个列表，会被下面的运行时守卫拦下。
      const known: readonly (keyof HostSettings)[] = ["systemNotification", "dailyNoteFolder", "language"];
      if (!known.includes(field as keyof HostSettings)) return;
      await this.plugin.updateHostSettings({ [field]: value });
      return;
    }
    // ── 账户级字段（`acc.<id>.<field>`）──────────────────────
    const ak = this.accKey(key);
    if (ak) {
      (ak.acc as unknown as Record<string, unknown>)[ak.field] = value;
      // 选 iCloud 时自动填入默认服务器地址，省得用户手敲（2026-10-21）。
      // 只在 serverUrl 为空时填，避免覆盖用户已填的自定义地址（如 iCloud 节点主机）。
      if (ak.field === "serverType" && value === "icloud" && !ak.acc.serverUrl) {
        ak.acc.serverUrl = "https://caldav.icloud.com";
        this.update(); // 让「服务器地址」输入框立即显示新默认值
      }
      await this.save();
      return;
    }
    setDynamicField(this.s, key, value);
    // 默认账户换了 → 默认日历下拉要重填（defs 里的选项随账户而变），重渲整页
    if (key === "defaultAccountId") this.update();
    await this.save();
  }

  private hostValue(key: string): unknown {
    return dynamicField(this.plugin.hostSettings(), key);
  }

  /**
   * 声明式设置项清单。
   *
   * 控件类型用 `type` + `key` + 选项描述，值由 getControlValue/setControlValue
   * 负责读写 —— 这样 Obsidian 能索引每一项的name/desc/aliases 用于搜索。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.s;
    const num = (key: string, fallback: number) => ({
      type: "number" as const,
      key,
      defaultValue: fallback,
      min: 0,
      step: 1,
      validate: (n: number) => (Number.isFinite(n) && n >= 0 ? undefined : t("settings.invalidNumber")),
    });

    // ⚠️ 类型必须是 SettingDefinitionItem / SettingGroupItem，不能用 Record<string, unknown>：
    // 2026-10-26 实踩——Record 绕过类型检查，把 group 嵌进了 group.items（宿主只允许
    // 顶层 defs 放 group/list），运行时整段被忽略，展开的账户详情「凭空消失」。
    const defs: SettingDefinitionItem[] = [];

    // ---- 语言 ----
    // 放在最前面：改语言要立刻重渲染整页，排在后面用户会看不到变化。
    defs.push({
      type: "group",
      heading: t("lang.name"),
      items: [
        {
          name: t("lang.name"),
          desc: t("lang.desc"),
          control: {
            type: "dropdown" as const,
            key: "host.language",
            defaultValue: "auto",
            options: {
              auto: t("lang.auto", { lang: t(currentLang() === "zh" ? "lang.zh" : "lang.en") }),
              zh: t("lang.zh"),
              en: t("lang.en"),
            },
          },
          aliases: ["language", "语言", "lang", "locale", "i18n"],
        },
      ],
    });

    // ---- 日历账户 ----
    // 卡片列表 + 手风琴：每项一行（名称 / 摘要 / 启用开关 / 展开 / 删除），
    // **只有展开的那个账户**把「服务器 / 日历 / 策略」三段 push 进 defs。
    const accounts = s.accounts || [];
    const accItems: SettingGroupItem[] = accounts.length
      ? accounts.map((acc) => ({
          name: acc.name,
          desc: acc.serverUrl
            ? `${acc.serverUrl} · ${(acc.calendars || []).filter((c) => c.enabled).length}/${(acc.calendars || []).length} ${t("settings.calCountSuffix")}`
            : t("settings.accNoServer"),
          render: (setting: Setting) => this.renderAccountRow(setting, acc),
          aliases: ["账户", "account", acc.name, acc.serverUrl],
        }))
      : [{ name: t("settings.accEmpty"), desc: t("settings.accEmptyDesc") }];

    // 展开账户的三段（服务器 / 日历 / 策略）——收起的账户不渲染，见 activeAccId 注释。
    // ⚠️ 这三段必须是**顶层 defs**（紧跟「日历账户」组之后）：group.items 只收
    // SettingDefinition/Page，嵌套 group/list 会被宿主整个忽略（2026-10-26 实踩）。
    // 标题带账户名——多账户下不标名看不出这三段属于谁。
    const open = this.activeAcc();
    const accDetail: SettingDefinitionItem[] = [];
    if (open) {
      const pre = `acc.${open.id}.`;
      const sec = (h: string): string => `${h} · ${open.name}`;
      // ---- 服务器 ----
      accDetail.push({ type: "group", heading: sec(t("settings.groupServer")), items: [
        {
          name: t("settings.accName"),
          desc: t("settings.accNameDesc"),
          control: { type: "text", key: pre + "name" },
          aliases: ["账户名", "名称", "account name"],
        },
        {
          name: t("settings.serverType"),
          desc: t("settings.serverTypeDesc"),
          control: {
            type: "dropdown" as const,
            key: pre + "serverType",
            defaultValue: "caldav",
            options: { caldav: t("settings.serverTypeCaldav"), icloud: t("settings.serverTypeIcloud") },
          },
          aliases: ["type", "类型", "icloud", "caldav", "服务器类型", "server type"],
        },
        {
          name: t("settings.serverUrl"),
          desc: t("settings.serverUrlDesc"),
          control: { type: "text", key: pre + "serverUrl", placeholder: "http://…" },
          aliases: ["server", "url", "地址", "caldav", "服务器", "address", "host"],
        },
        {
          name: t("settings.username"),
          control: { type: "text", key: pre + "username" },
          aliases: ["username", "账号", "用户名", "account", "user"],
        },
        {
          name: t("settings.password"),
          desc: t("settings.passwordDesc"),
          // 声明式的 text 控件没有 `password` 选项（无原生密码输入），
          // 故用 render 自绘。**签名必须是 (setting, group)** ——
          // Obsidian 已建好 Setting 并设好 name/desc，我们只往它身上加控件。
          // 传成 (el: HTMLElement) 会在 `new Setting(el)` 处炸掉，
          // 表现为「密码框及之后的设置项全部消失」（实测踩到，2026-10-06）。
          render: (setting: Setting) => this.renderPasswordRow(setting, open),
          aliases: ["password", "密码"],
        },
        ...(this.plugin.store.credentialsIssue()
          ? [{ name: t("settings.credentialsIssue"), desc: this.plugin.store.credentialsIssue() }]
          : []),
        {
          name: t("settings.calendarPath"),
          desc: t("settings.calendarPathDesc"),
          control: { type: "text", key: pre + "calendarPath", placeholder: t("settings.calendarPathPlaceholder") },
          aliases: ["calendar", "path", "路径", "集合", "collection"],
        },
        {
          name: t("settings.connection"),
          desc: t("settings.connectionDesc"),
          // 用 render 而非 action：action 的 el 已是 Obsidian 分配好的容器，
          // 在里面再 `new Setting(el)` 会套出错误的嵌套结构 ——
          // 表现为标题文字被挤成竖排、整行重复多次（实测踩到，2026-10-06）。
          render: (setting: Setting) => this.renderConnectionButtons(setting, open),
          aliases: ["测试", "连接", "发现", "test", "discover", "connect"],
        },
      ] });

      // ---- 日历 ----
      const calItems: SettingGroupItem[] = (open.calendars || []).length
        ? (open.calendars || []).map((cal) => this.calendarDefinition(cal, open))
        : [{ name: t("settings.noCalendar"), desc: t("settings.noCalendarDesc") }];
      accDetail.push({ type: "list", heading: sec(t("settings.groupCalendar")), items: calItems, cls: "caldav-cal-list" });

      // ---- 策略（原「同步」段中属于账户的部分：冲突 / 窗口 / 附件上限）----
      accDetail.push({ type: "group", heading: sec(t("settings.groupStrategy")), items: [
        {
          name: t("settings.conflict"),
          desc: t("settings.conflictDesc"),
          control: {
            type: "dropdown" as const,
            key: pre + "conflict",
            defaultValue: "server",
            options: { server: t("settings.conflictServer"), local: t("settings.conflictLocal") },
          },
          aliases: ["冲突", "conflict", "优先级"],
        },
        {
          name: t("settings.range"),
          desc: t("settings.rangeDesc", { past: open.pastDays, future: open.futureDays }),
          // 一个 Setting 需要两个数字输入，声明式里用 render 表达
          render: (setting: Setting) => this.renderRangeRow(setting, open),
          aliases: ["范围", "过去", "未来", "range"],
        },
        {
          // 附件/ICS 体积上限是**服务器特性**（2026-10-26 下沉到账户）：
          // Radicale 10MB / PHP 8MB / iCloud 另有一套，不同服务器各配各的。
          name: t("settings.attachLimit"),
          desc: t("settings.attachLimitDesc"),
          control: num(pre + "attachSizeMaxMB", 5),
          aliases: ["附件", "大小", "上限", "attach", "limit", "size"],
        },
        {
          name: t("settings.icsLimit"),
          desc: t("settings.icsLimitDesc"),
          control: num(pre + "icsSizeMaxMB", 10),
          aliases: ["ICS", "单个文件", "上限", "ics", "limit"],
        },
      ] });
    }
    defs.push({
      type: "group",
      heading: t("settings.groupAccount"),
      items: [
        ...accItems,
        {
          name: t("settings.accAdd"),
          desc: t("settings.accAddDesc"),
          render: (setting: Setting) => this.renderAddAccountButton(setting),
          aliases: ["添加", "新增", "账户", "add", "account"],
        },
      ],
    });
    // 展开账户的详情段是顶层组（group.items 不允许嵌套 group/list，见上方注释）
    defs.push(...accDetail);

    // ---- 同步（全局）----
    defs.push({
      type: "group",
      heading: t("settings.groupSync"),
      items: [
        {
          name: t("settings.syncInterval"),
          desc: t("settings.syncIntervalDesc"),
          control: num("syncIntervalMin", 0),
          aliases: ["同步", "间隔", "interval", "自动", "sync", "auto"],
        },
        {
          // 新建条目的默认归属：两级选择（默认账户 → 默认日历），2026-10-26 从思源侧同构
          name: t("settings.defaultAccount"),
          desc: t("settings.defaultAccountDesc"),
          control: {
            type: "dropdown" as const,
            key: "defaultAccountId",
            defaultValue: "",
            options: {
              "": t("settings.defaultAccountAuto"),
              ...Object.fromEntries((enabledAccounts(s) || []).map((a) => [a.id, a.name])),
            },
          },
          aliases: ["默认账户", "账户", "default", "account"],
        },
        {
          name: t("settings.defaultCalendar"),
          desc: t("settings.defaultCalendarDesc"),
          control: {
            type: "dropdown" as const,
            key: "defaultCalendarUrl",
            defaultValue: "",
            options: defaultCalendarOptions(s),
          },
          aliases: ["默认日历", "日历", "default", "calendar"],
        },
      ],
    });

    // ---- 提醒 ----
    defs.push({
      type: "group",
      heading: t("settings.groupReminder"),
      items: [
        {
          name: t("settings.enableReminders"),
          desc: t("settings.enableRemindersDesc"),
          control: { type: "toggle" as const, key: "enableReminders", defaultValue: false },
          aliases: ["提醒", "reminder", "闹钟", "alarm"],
        },
        {
          name: t("settings.systemNotification"),
          desc: t("settings.systemNotificationDesc"),
          control: { type: "toggle" as const, key: "host.systemNotification", defaultValue: false },
          aliases: ["系统通知", "通知", "notification"],
        },
        {
          name: t("settings.reminderStatus"),
          desc: this.plugin.mainCtx.reminderStatus?.() ?? "-",
          // 同上：用 render 拿 Setting，不要在 action 的容器里再 new Setting
          render: (setting: Setting) => this.renderReminderTestButton(setting),
          aliases: ["测试", "提醒状态", "test"],
        },
      ],
    });

    // ---- 日记 ----
    defs.push({
      type: "group",
      heading: t("settings.groupDiary"),
      items: [
        {
          name: t("settings.dailyNoteFolder"),
          desc: t("settings.dailyNoteFolderDesc"),
          control: { type: "text" as const, key: "host.dailyNoteFolder", placeholder: t("settings.dailyNoteFolderPlaceholder") },
          aliases: ["日记", "daily", "note", "目录", "folder"],
        },
        {
          name: t("settings.includeOverdueTodos"),
          desc: t("settings.includeOverdueTodosDesc"),
          control: { type: "toggle" as const, key: "includeOverdueTodos" },
          aliases: ["逾期", "overdue", "待办", "todo"],
        },
      ],
    });

    // ---- 中国日历叠加层 ----
    // 纯展示：节假日/农历/节气挂在日期数字旁，不进 CalDAV、不参与同步、不写服务器。
    // 声明式最多只能到 group.items 一层（嵌套 group/list 会被宿主忽略），故「立即检查更新」
    // 用 render 自绘一个按钮即可；下拉/开关都是原生声明式控件，无需自绘。
    defs.push({
      type: "group",
      heading: t("settings.groupChina"),
      items: [
        {
          name: t("settings.showHolidaysCN"),
          desc: t("settings.showHolidaysCNDesc"),
          control: { type: "toggle" as const, key: "showHolidaysCN" },
          aliases: ["节假日", "法定", "holiday", "休", "班"],
        },
        {
          name: t("settings.showLunarCN"),
          desc: t("settings.showLunarCNDesc"),
          control: { type: "toggle" as const, key: "showLunarCN" },
          aliases: ["农历", "lunar", "阴历"],
        },
        {
          name: t("settings.showTermCN"),
          desc: t("settings.showTermCNDesc"),
          control: { type: "toggle" as const, key: "showTermCN" },
          aliases: ["节气", "term", "jieqi"],
        },
        {
          name: t("settings.holidayCnSource"),
          desc: t("settings.holidayCnSourceDesc"),
          control: {
            type: "dropdown" as const,
            key: "holidayCnSource",
            defaultValue: "timor",
            options: {
              timor: t("settings.holidayCnSourceTimor"),
              "holiday-cn": t("settings.holidayCnSourceHolidayCn"),
              "chinese-days": t("settings.holidayCnSourceChineseDays"),
              custom: t("settings.holidayCnSourceCustom"),
            },
          },
          aliases: ["数据源", "source", "timor", "jsdelivr"],
        },
        {
          name: t("settings.holidayCnCustomUrl"),
          desc: t("settings.holidayCnCustomUrlDesc"),
          control: { type: "text" as const, key: "holidayCnCustomUrl", placeholder: "https://example.com/{year}.json" },
          aliases: ["自定义", "custom", "url"],
        },
        {
          name: t("settings.holidayCnUpdateFreq"),
          desc: t("settings.holidayCnUpdateFreqDesc"),
          control: {
            type: "dropdown" as const,
            key: "holidayCnUpdateFreq",
            defaultValue: "weekly",
            options: {
              manual: t("settings.holidayCnUpdateManual"),
              daily: t("settings.holidayCnUpdateDaily"),
              weekly: t("settings.holidayCnUpdateWeekly"),
            },
          },
          aliases: ["频率", "更新", "freq"],
        },
        {
          name: t("settings.cnRefresh"),
          desc: t("settings.cnRefreshDesc"),
          render: (setting: Setting) => this.renderCnRefreshButton(setting),
          aliases: ["刷新", "更新", "refresh", "节假日"],
        },
      ],
    });

    // ---- 杂项（MISC）----
    // 两处筛选下拉的「默认值」：默认都是「上次使用项」（记在配置里，随数据同步），
    // 也可固定成某一项。选项表直接取自 ui/filter-pref.ts，
    // 与 Dock 下拉 / 任务视图下拉同一份，避免加项时两边漂移。
    defs.push({
      type: "group",
      heading: t("settings.groupMisc"),
      items: [
        {
          name: t("settings.defaultDockFilter"),
          desc: t("settings.defaultDockFilterDesc"),
          control: {
            type: "dropdown" as const,
            key: "defaultDockFilter",
            defaultValue: "last",
            options: {
              last: t("settings.defaultFilterLast"),
              ...Object.fromEntries(DOCK_FILTER_KEYS.map((k) => [k, t(DOCK_FILTER_I18N[k])])),
            },
          },
          aliases: ["dock", "侧边栏", "筛选", "filter", "默认"],
        },
        {
          name: t("settings.defaultTaskFilter"),
          desc: t("settings.defaultTaskFilterDesc"),
          control: {
            type: "dropdown" as const,
            key: "defaultTaskFilter",
            defaultValue: "last",
            options: {
              last: t("settings.defaultFilterLast"),
              ...Object.fromEntries(TASK_FILTER_KEYS.map((k) => [k, t(TASK_FILTER_I18N[k])])),
            },
          },
          aliases: ["任务视图", "筛选", "filter", "默认"],
        },
        {
          // 新建待办的默认截止时间（2026-10-27，与思源端同构）
          name: t("settings.todoDefaultEnd"),
          desc: t("settings.todoDefaultEndDesc"),
          control: {
            type: "dropdown" as const,
            key: "todoDefaultEnd",
            defaultValue: "plus8h",
            options: {
              none: t("settings.todoDefaultEndNone"),
              plus1h: t("settings.todoDefaultEndPlus1h"),
              plus8h: t("settings.todoDefaultEndPlus8h"),
            },
          },
          aliases: ["待办", "截止", "默认", "due", "todo"],
        },
      ],
    });

    // ---- 本地数据 ----
    // 「切换服务器时清理旧条目」开关已随多账户废除（2026-10-25）：清理由「删除账户」
    // 时可选执行（store.purgeAccountItems），不再有一个容易误伤的常开开关。
    defs.push({
      type: "group",
      heading: t("settings.groupLocalData"),
      items: [
        {
          name: t("settings.purgeNow"),
          // 状态说明 + 两个按钮（立即清理 / 恢复）用 render 自绘：
          // 声明式控件没有「带确认的删除按钮」这种形态。
          render: (setting: Setting) => this.renderPurgeRow(setting),
          aliases: ["清理", "恢复", "purge", "restore", "孤儿"],
        },
      ],
    });

    // 2026-10-09 雄哥要求删掉设置页里的「日历视图中显示待办」——
    // 它跟面板工具栏「日历筛选」浮层里的同名开关是同一个 setting.showTodosInCalendar，
    // 两处都能改就会让人怀疑到底听谁的，而且设置页那个改完不重绘面板（要等下次同步），
    // 看起来像「没生效」。现在统一只在工具栏里改。
    // 任务视图的两个混入开关（showEventsInTaskView / showExpiredEventsInTaskView）
    // 同样只在工具栏里，本来就没在设置页重复过。
    //
    // ⚠️ settings.showTodosInCalendar 这个字段本身**必须保留**在 types.ts / DEFAULT_SETTINGS 里：
    //    老数据（data.json）里已经存了这个键，删掉定义会让读取端拿不到默认值而走偏，
    //    并且 toolbar 的读写路径依赖它。删的只是设置页这一处 UI。

    return defs as unknown as SettingDefinitionItem[];
  }

  /**
   * 「立即清理旧服务器条目」+「恢复上次清理」两个按钮 + 状态说明。
   *
   * ⚠️ 收到的 `setting` 是**已建好的 Setting 对象**，直接往它身上加控件即可 ——
   *    在 action 的容器里再 `new Setting(el)` 会套出错误的嵌套结构（2026-10-06 实测）。
   *
   * 清理是删除动作，按项目约定**二次点击确认**（不用 confirm()）：
   * 第一次点把按钮文案改成「再点一次确认清理 N 条」，第二次才真删。
   */
  private renderPurgeRow(setting: Setting): void {
    const store = this.plugin.store;
    const orphans = store.orphanItems();
    const bk = store.purgeBackup;

    // 状态说明：当前有多少孤儿条目、上次清理是什么时候
    const status = document.createElement("div");
    status.className = "caldav-purge-status";
    const parts: string[] = [];
    if (orphans.length) {
      parts.push(t("settings.purgeStatus", { count: String(orphans.length) }));
    } else if (store.activeServerOrigins().size) {
      parts.push(t("settings.purgeStatusNone"));
    } else {
      parts.push(t("settings.purgeStatusNoServer"));
    }
    if (bk && bk.items.length) {
      parts.push(
        t("settings.purgeBackupInfo", {
          time: formatTimeText(bk.at),
          count: String(bk.count),
          from: bk.removedServers ? t("settings.purgeBackupFrom", { servers: bk.removedServers }) : ""
        })
      );
    }
    status.textContent = parts.join("；");
    setting.descEl.appendChild(status);

    // 二次点击确认的状态（存在闭包里，按钮重绘时不丢）
    let armed = false;
    // 句柄类型必须是 number（见 constants.ts 的 TimerHandle 注释），且定时器
    // 一律走 window.setTimeout / window.clearTimeout —— 全仓禁裸定时器调用。
    let armTimer: TimerHandle | null = null;

    setting
      .addButton((b) => {
        // 按钮组件本身要留着：改文案走它的 setButtonText，
        // 直接改 buttonEl.textContent 会把 Obsidian 挂在按钮上的内部状态弄乱。
        const btn = b;
        b.setButtonText(t("settings.purgeNow")).onClick(async () => {
          const cur = store.orphanItems();
          if (!cur.length) {
            new Notice(t("settings.purgeNothing"), 4000);
            return;
          }
          if (!armed) {
            armed = true;
            btn.setButtonText(t("settings.purgeConfirmHint", { count: String(cur.length) }));
            if (armTimer) window.clearTimeout(armTimer);
            armTimer = window.setTimeout(() => {
              armed = false;
              btn.setButtonText(t("settings.purgeNow"));
            }, 5000);
            return;
          }
          armed = false;
          if (armTimer) {
            window.clearTimeout(armTimer);
            armTimer = null;
          }
          btn.setButtonText(t("settings.purgeNow"));
          // 手动清理**不受开关限制** —— 用户点了就是明确意图
          const n = await store.purgeOrphanItems();
          new Notice(n ? t("settings.purgeDone", { count: String(n) }) : t("settings.purgeNothing"), 5000);
          this.update();
        });
        b.buttonEl.disabled = !orphans.length;
      })
      .addButton((b) => {
        b.setButtonText(t("settings.purgeRestore")).onClick(async () => {
          const n = await store.restorePurgedItems();
          new Notice(n ? t("settings.purgeRestored", { count: String(n) }) : t("settings.purgeRestoreNothing"), 5000);
          this.update();
        });
        b.buttonEl.disabled = !bk || !bk.items.length;
      });
  }

  /** 单个日历的声明式定义：启用勾选 + 日程色 / 待办色 */
  private calendarDefinition(cal: CalCalendar, acc: CalAccount): SettingGroupItem {
    return {
      name: cal.displayName || cal.url,
      desc: this.calendarCaps(cal) ? t("settings.capDesc", { caps: this.calendarCaps(cal) }) : cal.url,
      render: (setting: Setting) => this.renderCalendarRow(setting, cal, acc),
      aliases: ["日历", "calendar", cal.displayName || cal.url],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 账户卡片（手风琴）：名称 / 启用 / 展开 / 删除
  // ─────────────────────────────────────────────────────────────

  /**
   * 账户行：启用开关 + 展开/收起 + 删除（二次点击确认，另可选清理本地条目）。
   *
   * 删除是破坏性动作，按项目约定**不用 confirm()**，改成内联二次确认：
   * 第一次点「删除」把该行换成「确认删除 / 删除并清理本地条目 / 取消」三个按钮。
   */
  private renderAccountRow(setting: Setting, acc: CalAccount): void {
    setting
      .addToggle((tg) =>
        tg
          .setTooltip(t("settings.accEnabled"))
          .setValue(acc.enabled)
          .onChange((v) => {
            acc.enabled = v;
            void this.save();
            // 停用/启用立刻反映到面板（视图里该账户的日历显不显示）
            this.plugin.refreshViews?.();
            this.update();
          })
      )
      .addButton((b) => {
        const isOpen = this.activeAccId === acc.id;
        b.setButtonText(isOpen ? t("settings.accCollapse") : t("settings.accExpand"))
          .setTooltip(t("settings.accExpandDesc"))
          .onClick(() => {
            this.activeAccId = isOpen ? null : acc.id;
            this.update();
          });
      })
      .addButton((b) => {
        const btn = b;
        // 确认区：第一次点击后方才创建，避免平时占地方
        let conf: HTMLElement | null = null;
        let armTimer: TimerHandle | null = null;
        const reset = (): void => {
          btn.setButtonText(t("settings.accDelete"));
          if (armTimer) {
            window.clearTimeout(armTimer);
            armTimer = null;
          }
          conf?.remove();
          conf = null;
        };
        b.setButtonText(t("settings.accDelete")).onClick(async () => {
          if (conf) return;
          // ── 二次确认：展开两个选择（是否连本地条目一起清理）──
          conf = document.createElement("div");
          conf.className = "caldav-acc-delconf";
          const hint = document.createElement("div");
          hint.className = "caldav-set-hint";
          const n = this.plugin.store.getAll().filter((it) => (acc.calendars || []).some((c) => c.url === it.calendarUrl)).length;
          hint.textContent = t("settings.accDeleteHint", { name: acc.name, count: String(n) });
          conf.appendChild(hint);
          const row = document.createElement("div");
          row.className = "caldav-acc-delconf-row";
          const mk = (label: string, purge: boolean): HTMLButtonElement => {
            const el = document.createElement("button");
            el.className = "caldav-btn caldav-btn--sm" + (purge ? "" : " mod-cta");
            el.textContent = label;
            el.addEventListener("click", () => {
              void (async () => {
                await this.deleteAccount(acc, purge);
                reset();
              })();
            });
            return el;
          };
          row.appendChild(mk(t("settings.accDeleteOnly"), false));
          row.appendChild(mk(t("settings.accDeletePurge"), true));
          const cancel = document.createElement("button");
          cancel.className = "caldav-btn caldav-btn--sm";
          cancel.textContent = t("common.cancel");
          cancel.addEventListener("click", reset);
          row.appendChild(cancel);
          conf.appendChild(row);
          setting.descEl.appendChild(conf);
          btn.setButtonText(t("settings.accDeleteConfirming"));
          armTimer = window.setTimeout(reset, 12000);
        });
      });
  }

  /** 删除账户（可选连本地条目一起清理，先备份可恢复） */
  private async deleteAccount(acc: CalAccount, purge: boolean): Promise<void> {
    if (purge) {
      const n = await this.plugin.store.purgeAccountItems(acc.id);
      if (n) new Notice(t("settings.purgeDone", { count: String(n) }), 5000);
    }
    this.s.accounts = (this.s.accounts || []).filter((a) => a.id !== acc.id);
    if (this.activeAccId === acc.id) this.activeAccId = null;
    await this.save();
    this.plugin.refreshViews?.();
    this.update();
    new Notice(t("settings.accDeleted", { name: acc.name }), 4000);
  }

  /** 「添加账户」按钮：新建一个空账户并立刻展开它 */
  private renderAddAccountButton(setting: Setting): void {
    setting.addButton((b) =>
      b
        .setButtonText(t("settings.accAdd"))
        .setCta()
        .onClick(async () => {
          const acc: CalAccount = {
            id: newAccountId(),
            name: t("settings.accDefaultName", { n: String((this.s.accounts || []).length + 1) }),
            enabled: true,
            serverUrl: "",
            username: "",
            password: "",
            calendarPath: "",
            serverType: "caldav",
            channel: "auto",
            conflict: "server",
            pastDays: 90,
            futureDays: 370,
            calendars: []
          };
          this.s.accounts = [...(this.s.accounts || []), acc];
          this.activeAccId = acc.id; // 新账户直接展开，顺手就能填
          await this.save();
          this.update();
        })
    );
  }

  /** 「日程 / 待办」能力标签，如「事件 / 任务」 */
  private calendarCaps(cal: CalCalendar): string {
    return [cal.supportsEvent ? t("kindEvent") : "", cal.supportsTodo ? t("kindTodo") : ""]
      .filter(Boolean)
      .join(" / ");
  }

  /** 声明式下需要自绘的少数几处（多控件行/ 按钮组 / 密码框） */

  /**
   * 密码框：声明式的 text 控件不支持 password 类型，只能自绘。
   *
   * ⚠️ 收到的 `setting` 是**已建好的 Setting 对象**（Obsidian 已设好 name/desc），
   * 直接往它身上 addText 即可 —— 不要再 `new Setting(...)`。
   */
  private renderPasswordRow(setting: Setting, acc: CalAccount): void {
    // 参数名用 tc 而不是 t —— t 是本模块从 @/i18n 导入的 t()，同名会遮蔽它
    setting.addText((tc) => {
      tc.inputEl.type = "password";
      tc.setValue(acc.password).onChange((v) => {
        acc.password = v;
        void this.save();
      });
    });
  }


  /**
   * 「连接与发现」两个按钮。
   *
   * ⚠️ `setting` 是**已建好的 Setting**（name/desc 已由 defs 设好），
   * 直接 addButton即可。原写法 `new Setting(el)` 会造出嵌套的错误结构，
   * 表现为标题文字竖排、整行重复 —— 2026-10-06 实测踩到。
   */
  private renderConnectionButtons(setting: Setting, acc: CalAccount): void {
    setting
      .addButton((b) =>
        b.setButtonText(t("settings.testConnection")).onClick(async () => {
          const auth = { username: acc.username, password: acc.password };
          try {
            const r = await testConnection(acc.serverUrl, acc.channel, auth);
            new Notice(
              r.ok ? t("settings.connectOk", { msg: r.message || t("settings.connectOkBare") }) : t("settings.connectFail", { msg: r.message }),
              r.ok ? 3000 : 6000,
            );
          } catch (e) {
            new Notice(t("settings.connectFail", { msg: describeNetworkError(e, acc.channel) }), 6000);
          }
        })
      )
      .addButton((b) =>
        b.setButtonText(t("settings.discover")).onClick(async () => {
          await this.discover(acc);
        })
      );
  }

  /** 「提醒状态」+ 发送测试提醒按钮。同样直接用传入的 Setting。 */
  private renderReminderTestButton(setting: Setting): void {
    setting
      .addButton((b) =>
        b.setButtonText(t("settings.sendTestReminder")).onClick(async () => {
          await this.plugin.mainCtx.testReminder?.();
          // 提醒状态已变，重渲染让描述里的排程数刷新
          this.update();
        })
      );
  }

  /**
   * 中国日历「立即检查更新」按钮。
   * 强制拉取当前年 ±1 的节假日数据；成功则刷新日历视图，失败回显最近一次真实错误原因。
   */
  private renderCnRefreshButton(setting: Setting): void {
    setting
      .addButton((b) =>
        b.setButtonText(t("settings.cnRefresh")).onClick(async () => {
          const y = new Date().getFullYear();
          const ok = await forceRefreshChinaCalendar(this.s, [y - 1, y, y + 1]);
          if (ok) {
            new Notice(t("settings.cnRefreshOk"));
            this.plugin.refreshViews?.();
          } else {
            const err = getLastHolidayError();
            new Notice(t("settings.cnRefreshFail", { msg: err || t("settings.cnRefreshFailUnknown") }));
          }
        })
      );
  }

  /**
   * 「显示范围」一行两个数字输入，声明式无对应控件类型，用 render 自绘。
   *
   * ⚠️ `setting` 是**已建好的 Setting**（name/desc 已由 defs 设好），
   * 直接 addText两次即可。原注释写的「收到的是已分配好标题行的容器」是错的 ——
   * 那正是 2026-10-06 设置项集体消失的根因。
   */
  private renderRangeRow(setting: Setting, acc: CalAccount): void {
    const apply = (key: "pastDays" | "futureDays") => (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return;
      acc[key] = Math.floor(n);
      void this.save();
    };
    setting.setDesc(t("settings.rangeDesc", { past: acc.pastDays, future: acc.futureDays }));
    setting
      .addText((t2) => {
        t2.inputEl.type = "number";
        t2.setPlaceholder(t("settings.pastDaysPlaceholder"));
        t2.setValue(String(acc.pastDays)).onChange(apply("pastDays"));
      })
      .addText((t2) => {
        t2.inputEl.type = "number";
        t2.setPlaceholder(t("settings.futureDaysPlaceholder"));
        t2.setValue(String(acc.futureDays)).onChange(apply("futureDays"));
      });
  }

  // ─────────────────────────────────────────────────────────────
  // 命令式设置（Obsidian < 1.13.0，以及 1.13+ 尚未实现声明式时的兜底）
  // ─────────────────────────────────────────────────────────────


  /** 单个日历：启用勾选 + 名称 + 日程色 / 待办色 */
  private renderCalendarRow(setting: Setting, cal: CalCalendar, _acc: CalAccount): void {
    const caps = this.calendarCaps(cal);
    // name / desc 因日历而异，故在这里覆盖（defs 里只能给静态值）
    setting.setName(cal.displayName || cal.url).setDesc(caps ? t("settings.capDesc", { caps }) : cal.url);
    setting
      .addToggle((tg) =>
        tg.setValue(cal.enabled).onChange((v) => {
          cal.enabled = v;
          void this.save();
        })
      )
      .addColorPicker((cp) =>
        cp
          .setValue(calEventColor(cal))
          .onChange((v) => {
            cal.eventColor = v;
            void this.save();
          })
      )
      .addColorPicker((cp) =>
        cp
          .setValue(calTodoColor(cal))
          .onChange((v) => {
            cal.todoColor = v;
            void this.save();
          })
      );
  }

  /** 发现日历（**按账户**）：保留用户已有的勾选与配色，只更新服务端侧的元信息 */
  private async discover(acc: CalAccount): Promise<void> {
    if (!acc.serverUrl) {
      new Notice(t("settings.noServerFirst"), 4000);
      return;
    }
    const auth = { username: acc.username, password: acc.password };
    try {
      new Notice(t("settings.discovering"), 2000);
      const r = await discoverCalendars(acc.serverUrl, acc.channel, auth, acc.calendarPath);
      const existing = new Map((acc.calendars || []).map((c) => [c.url, c]));
      acc.calendars = r.calendars.map((c) => {
        const old = existing.get(c.url);
        // 已配置过的日历：沿用勾选状态与自定义配色，避免重新发现就丢设置
        return old
          ? { ...c, enabled: old.enabled, eventColor: old.eventColor, todoColor: old.todoColor }
          : { ...c, enabled: true };
      });
      await this.save();
      // 日历列表已变（新增/移除），让声明式设置重新拉取
      this.update();
      new Notice(t("settings.discoverDone", { count: acc.calendars.length }));
    } catch (e) {
      new Notice(t("settings.discoverFailed", { msg: describeNetworkError(e, acc.channel) }), 6000);
    }
  }

  /** 修改设置 → 持久化并通知订阅者（面板会随之重渲染） */
  private async save(): Promise<void> {
    // 语言是插件级 UI 状态而非数据：立刻切换并重渲染整页，
    // 存盘只是让下次启动能保持该选择。
    this.plugin.applyLanguage();
    this.plugin.store.saveSettings();
    // 凭据或服务器地址可能刚被改过：丢掉 Digest 协商缓存，
    // 否则下次请求会拿着旧 nonce/旧密码重发，白挨一次 401
    // （2026-10-20 从思源侧同构移植）
    clearAuthCache();
    await this.plugin.store.persist();
  }
}
