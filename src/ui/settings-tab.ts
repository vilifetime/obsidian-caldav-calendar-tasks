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
import { Notice, PluginSettingTab, Setting, type App, type SettingDefinitionItem } from "obsidian";
import type CalDavPlugin from "@/main";
import type { HostSettings } from "@/main";
import { describeNetworkError, discoverCalendars, testConnection } from "@/core/caldav";
import { calEventColor, calTodoColor, type CalCalendar } from "@/core/types";
import { t, currentLang } from "@/i18n";

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
  getControlValue(key: string): unknown {
    if (key.startsWith("host.")) return this.hostValue(key);
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
    setDynamicField(this.s, key, value);
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

    const defs: Record<string, unknown>[] = [];

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

    // ---- 服务器 ----
    defs.push({ type: "group", heading: t("settings.groupServer"), items: [] });
    const serverGroup = defs[1] as { items: Record<string, unknown>[] };
    serverGroup.items = [
      {
        name: t("settings.serverUrl"),
        desc: t("settings.serverUrlDesc"),
        control: { type: "text", key: "serverUrl", placeholder: "http://…" },
        aliases: ["server", "url", "地址", "caldav", "服务器", "address", "host"],
      },
      {
        name: t("settings.username"),
        control: { type: "text", key: "username" },
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
        render: (setting: Setting) => this.renderPasswordRow(setting),
        aliases: ["password", "密码"],
      },
      ...(this.plugin.store.credentialsIssue()
        ? [{ name: t("settings.credentialsIssue"), desc: this.plugin.store.credentialsIssue() }]
        : []),
      {
        name: t("settings.calendarPath"),
        desc: t("settings.calendarPathDesc"),
        control: { type: "text", key: "calendarPath", placeholder: t("settings.calendarPathPlaceholder") },
        aliases: ["calendar", "path", "路径", "集合", "collection"],
      },
      {
        name: t("settings.connection"),
        desc: t("settings.connectionDesc"),
        // 用 render 而非 action：action 的 el 已是 Obsidian 分配好的容器，
        // 在里面再 `new Setting(el)` 会套出错误的嵌套结构 ——
        // 表现为标题文字被挤成竖排、整行重复多次（实测踩到，2026-10-06）。
        // render 收到的是已建好的 Setting，直接 addButton 即可。
        render: (setting: Setting) => this.renderConnectionButtons(setting),
        aliases: ["测试", "连接", "发现", "test", "discover", "connect"],
      },
    ];

    // ---- 日历 ----
    const calItems: Record<string, unknown>[] = s.calendars.length
      ? s.calendars.map((cal) => this.calendarDefinition(cal))
      : [
          {
            name: t("settings.noCalendar"),
            desc: t("settings.noCalendarDesc"),
          },
        ];
    defs.push({
      type: "list",
      heading: t("settings.groupCalendar"),
      items: calItems,
      cls: "caldav-cal-list",
    });

    // ---- 同步 ----
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
          name: t("settings.conflict"),
          desc: t("settings.conflictDesc"),
          control: {
            type: "dropdown" as const,
            key: "conflict",
            defaultValue: "server",
            options: { server: t("settings.conflictServer"), local: t("settings.conflictLocal") },
          },
          aliases: ["冲突", "conflict", "优先级"],
        },
        {
          name: t("settings.range"),
          desc: t("settings.rangeDesc", { past: s.pastDays, future: s.futureDays }),
          // 一个 Setting 需要两个数字输入，声明式里用 render 表达
          render: (setting: Setting) => this.renderRangeRow(setting),
          aliases: ["范围", "过去", "未来", "range"],
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
      ],
    });

    // ---- 视图 ----
    defs.push({
      type: "group",
      heading: t("settings.groupView"),
      items: [
        {
          name: t("settings.showTodosInCalendar"),
          desc: t("settings.showTodosInCalendarDesc"),
          control: { type: "toggle" as const, key: "showTodosInCalendar", defaultValue: true },
          aliases: ["视图", "待办", "todo", "view"],
        },
      ],
    });

    return defs as unknown as SettingDefinitionItem[];
  }

  /** 单个日历的声明式定义：启用勾选 + 日程色 / 待办色 */
  private calendarDefinition(cal: CalCalendar): Record<string, unknown> {
    return {
      name: cal.displayName || cal.url,
      desc: this.calendarCaps(cal) ? t("settings.capDesc", { caps: this.calendarCaps(cal) }) : cal.url,
      render: (setting: Setting) => this.renderCalendarRow(setting, cal),
      aliases: ["日历", "calendar", cal.displayName || cal.url],
    };
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
  private renderPasswordRow(setting: Setting): void {
    // 参数名用 tc 而不是 t —— t 是本模块从 @/i18n 导入的 t()，同名会遮蔽它
    setting.addText((tc) => {
      tc.inputEl.type = "password";
      tc.setValue(this.s.password).onChange((v) => {
        this.s.password = v;
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
  private renderConnectionButtons(setting: Setting): void {
    setting
      .addButton((b) =>
        b.setButtonText(t("settings.testConnection")).onClick(async () => {
          const auth = { username: this.s.username, password: this.s.password };
          try {
            const r = await testConnection(this.s.serverUrl, this.s.channel, auth);
            new Notice(
              r.ok ? t("settings.connectOk", { msg: r.message || t("settings.connectOkBare") }) : t("settings.connectFail", { msg: r.message }),
              r.ok ? 3000 : 6000,
            );
          } catch (e) {
            new Notice(t("settings.connectFail", { msg: describeNetworkError(e, this.s.channel) }), 6000);
          }
        })
      )
      .addButton((b) =>
        b.setButtonText(t("settings.discover")).onClick(async () => {
          await this.discover();
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
   * 「显示范围」一行两个数字输入，声明式无对应控件类型，用 render 自绘。
   *
   * ⚠️ `setting` 是**已建好的 Setting**（name/desc 已由 defs 设好），
   * 直接 addText两次即可。原注释写的「收到的是已分配好标题行的容器」是错的 ——
   * 那正是 2026-10-06 设置项集体消失的根因。
   */
  private renderRangeRow(setting: Setting): void {
    const apply = (key: "pastDays" | "futureDays") => (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return;
      this.s[key] = Math.floor(n);
      void this.save();
    };
    setting.setDesc(t("settings.rangeDesc", { past: this.s.pastDays, future: this.s.futureDays }));
    setting
      .addText((t2) => {
        t2.inputEl.type = "number";
        t2.setPlaceholder(t("settings.pastDaysPlaceholder"));
        t2.setValue(String(this.s.pastDays)).onChange(apply("pastDays"));
      })
      .addText((t2) => {
        t2.inputEl.type = "number";
        t2.setPlaceholder(t("settings.futureDaysPlaceholder"));
        t2.setValue(String(this.s.futureDays)).onChange(apply("futureDays"));
      });
  }

  // ─────────────────────────────────────────────────────────────
  // 命令式设置（Obsidian < 1.13.0，以及 1.13+ 尚未实现声明式时的兜底）
  // ─────────────────────────────────────────────────────────────


  /** 单个日历：启用勾选 + 名称 + 日程色 / 待办色 */
  private renderCalendarRow(setting: Setting, cal: CalCalendar): void {
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

  /** 发现日历：保留用户已有的勾选与配色，只更新服务端侧的元信息 */
  private async discover(): Promise<void> {
    const s = this.s;
    if (!s.serverUrl) {
      new Notice(t("settings.noServerFirst"), 4000);
      return;
    }
    const auth = { username: s.username, password: s.password };
    try {
      new Notice(t("settings.discovering"), 2000);
      const r = await discoverCalendars(s.serverUrl, s.channel, auth, s.calendarPath);
      const existing = new Map(s.calendars.map((c) => [c.url, c]));
      s.calendars = r.calendars.map((c) => {
        const old = existing.get(c.url);
        // 已配置过的日历：沿用勾选状态与自定义配色，避免重新发现就丢设置
        return old
          ? { ...c, enabled: old.enabled, eventColor: old.eventColor, todoColor: old.todoColor }
          : { ...c, enabled: true };
      });
      await this.save();
      // 日历列表已变（新增/移除），让声明式设置重新拉取
      this.update();
      new Notice(t("settings.discoverDone", { count: s.calendars.length }));
    } catch (e) {
      new Notice(t("settings.discoverFailed", { msg: describeNetworkError(e, s.channel) }), 6000);
    }
  }

  /** 修改设置 → 持久化并通知订阅者（面板会随之重渲染） */
  private async save(): Promise<void> {
    // 语言是插件级 UI 状态而非数据：立刻切换并重渲染整页，
    // 存盘只是让下次启动能保持该选择。
    this.plugin.applyLanguage();
    this.plugin.store.saveSettings();
    await this.plugin.store.persist();
  }
}
