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
      const known: readonly (keyof HostSettings)[] = ["systemNotification", "dailyNoteFolder"];
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
      validate: (n: number) => (Number.isFinite(n) && n >= 0 ? undefined : "请输入不小于 0 的数字"),
    });

    const defs: Record<string, unknown>[] = [];

    // ---- 服务器 ----
    defs.push({ type: "group", heading: "服务器", items: [] });
    const serverGroup = defs[0] as { items: Record<string, unknown>[] };
    serverGroup.items = [
      {
        name: "服务器地址",
        desc: "CalDAV 根地址或日历集合地址，例如 http://192.168.1.10:5232/",
        control: { type: "text", key: "serverUrl", placeholder: "http://…" },
        aliases: ["server", "url", "地址", "caldav", "服务器"],
      },
      {
        name: "用户名",
        control: { type: "text", key: "username" },
        aliases: ["username", "账号", "用户名"],
      },
      {
        name: "密码",
        desc: "落盘时以 AES-GCM 加密存储；主密钥随插件数据一起保存，多设备可共用。",
        // 声明式的 text 控件没有 `password` 选项（无原生密码输入），
        // 故用 render 自绘一个type=password 的输入框。
        render: (el: HTMLElement) => this.renderPasswordRow(el),
        aliases: ["password", "密码"],
      },
      ...(this.plugin.store.credentialsIssue()
        ? [{ name: "凭据状态", desc: this.plugin.store.credentialsIssue() }]
        : []),
      {
        name: "日历集合路径（可选）",
        desc: "留空自动发现；已知确切路径时填写可跳过发现步骤。",
        control: { type: "text", key: "calendarPath", placeholder: "留空自动发现" },
        aliases: ["calendar", "path", "路径", "集合"],
      },
      {
        name: "连接与发现",
        desc: "先测试连接，再发现服务器上的日历。",
        action: (el: HTMLElement) => this.renderConnectionButtons(el),
        aliases: ["测试", "连接", "发现", "test", "discover"],
      },
    ];

    // ---- 日历 ----
    const calItems: Record<string, unknown>[] = s.calendars.length
      ? s.calendars.map((cal) => this.calendarDefinition(cal))
      : [
          {
            name: "尚未发现日历",
            desc: "填写服务器与账号后点击「发现日历」。",
          },
        ];
    defs.push({
      type: "list",
      heading: "日历",
      items: calItems,
      cls: "caldav-cal-list",
    });

    // ---- 同步 ----
    defs.push({
      type: "group",
      heading: "同步",
      items: [
        {
          name: "自动同步间隔（分钟）",
          desc: "0 表示关闭自动同步，仅手动触发。",
          control: num("syncIntervalMin", 0),
          aliases: ["同步", "间隔", "interval", "自动"],
        },
        {
          name: "冲突处理",
          desc: "本地与服务端同时改动同一条目时的取舍。",
          control: {
            type: "dropdown" as const,
            key: "conflict",
            defaultValue: "server",
            options: { server: "服务端优先", local: "本地优先" },
          },
          aliases: ["冲突", "conflict", "优先级"],
        },
        {
          name: "显示范围",
          desc: `过去 ${s.pastDays} 天 / 未来 ${s.futureDays} 天（影响拉取与视图范围）`,
          // 一个 Setting 需要两个数字输入，声明式里用 render 表达
          render: (el: HTMLElement) => this.renderRangeRow(el),
          aliases: ["范围", "过去", "未来", "range"],
        },
      ],
    });

    // ---- 提醒 ----
    defs.push({
      type: "group",
      heading: "提醒",
      items: [
        {
          name: "启用提醒",
          desc: "对设置了提醒时间的日程与待办，到点弹出提示。移动端仅应用内提示。",
          control: { type: "toggle" as const, key: "enableReminders", defaultValue: false },
          aliases: ["提醒", "reminder", "闹钟"],
        },
        {
          name: "同时发送系统通知",
          desc: "桌面端在应用内提示之外再发一条系统通知，点击可跳到面板。",
          control: { type: "toggle" as const, key: "host.systemNotification", defaultValue: false },
          aliases: ["系统通知", "通知", "notification"],
        },
        {
          name: "提醒状态",
          desc: this.plugin.mainCtx.reminderStatus?.() ?? "-",
          action: (el: HTMLElement) => this.renderReminderTestButton(el),
          aliases: ["测试", "提醒状态", "test"],
        },
      ],
    });

    // ---- 日记 ----
    defs.push({
      type: "group",
      heading: "日记",
      items: [
        {
          name: "日记目录",
          desc: "「插入今日日程」写入的位置。留空则库根目录；文件名固定为 YYYY-MM-DD.md。",
          control: { type: "text" as const, key: "host.dailyNoteFolder", placeholder: "例如 DailyNotes" },
          aliases: ["日记", "daily", "note", "目录"],
        },
      ],
    });

    // ---- 视图 ----
    defs.push({
      type: "group",
      heading: "视图",
      items: [
        {
          name: "日历视图中显示待办",
          desc: "关闭后日历视图只显示日程，待办仍可在任务视图与列表中看到。",
          control: { type: "toggle" as const, key: "showTodosInCalendar", defaultValue: true },
          aliases: ["视图", "待办", "todo", "view"],
        },
      ],
    });

    return defs as unknown as SettingDefinitionItem[];
  }

  /** 单个日历的声明式定义：启用勾选 + 日程色 / 待办色 */
  private calendarDefinition(cal: CalCalendar): Record<string, unknown> {
    const caps = [cal.supportsEvent ? "日程" : "", cal.supportsTodo ? "待办" : ""]
      .filter(Boolean)
      .join(" / ");
    return {
      name: cal.displayName || cal.url,
      desc: caps ? `支持：${caps}` : cal.url,
      render: (el: HTMLElement) => this.renderCalendarRow(el, cal),
      aliases: ["日历", "calendar", cal.displayName || cal.url],
    };
  }

  /** 声明式下需要自绘的少数几处（多控件行/ 按钮组 / 密码框） */

  /** 密码框：声明式的 text 控件不支持 password 类型，只能自绘 */
  private renderPasswordRow(el: HTMLElement): void {
    new Setting(el)
      .setName("密码")
      .setDesc("落盘时以 AES-GCM 加密存储；主密钥随插件数据一起保存，多设备可共用。")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.s.password).onChange((v) => {
          this.s.password = v;
          void this.save();
        });
      });
  }


  private renderConnectionButtons(el: HTMLElement): void {
    new Setting(el)
      .setName("连接与发现")
      .setDesc("先测试连接，再发现服务器上的日历。")
      .addButton((b) =>
        b.setButtonText("测试连接").onClick(async () => {
          const auth = { username: this.s.username, password: this.s.password };
          try {
            const r = await testConnection(this.s.serverUrl, this.s.channel, auth);
            new Notice(r.ok ? `连接成功：${r.message || "OK"}` : `连接失败：${r.message}`, r.ok ? 3000 : 6000);
          } catch (e) {
            new Notice(`连接失败：${describeNetworkError(e, this.s.channel)}`, 6000);
          }
        })
      )
      .addButton((b) =>
        b.setButtonText("发现日历").onClick(async () => {
          await this.discover();
        })
      );
  }

  private renderReminderTestButton(el: HTMLElement): void {
    new Setting(el)
      .setName("提醒状态")
      .setDesc(this.plugin.mainCtx.reminderStatus?.() ?? "-")
      .addButton((b) =>
        b.setButtonText("发送测试提醒").onClick(async () => {
          await this.plugin.mainCtx.testReminder?.();
          // 提醒状态已变，重渲染让描述里的排程数刷新
          this.update();
        })
      );
  }

  /** 「显示范围」一行两个数字输入，声明式无对应控件类型，用 render 自绘 */
  private renderRangeRow(el: HTMLElement): void {
    const apply = (key: "pastDays" | "futureDays") => (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return;
      this.s[key] = Math.floor(n);
      void this.save();
    };
    // 声明式的 render 回调收到的是「已分配好标题行的容器」，
    // 这里补出描述文字与两个数字输入（前者=过去天数，后者=未来天数）。
    el.createEl("p", {
      cls: "setting-item-description",
      text: `过去 ${this.s.pastDays} 天 / 未来 ${this.s.futureDays} 天（影响拉取与视图范围）`,
    });
    new Setting(el)
      .setName("显示范围")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setPlaceholder("过去天数");
        t.setValue(String(this.s.pastDays)).onChange(apply("pastDays"));
      })
      .addText((t) => {
        t.inputEl.type = "number";
        t.setPlaceholder("未来天数");
        t.setValue(String(this.s.futureDays)).onChange(apply("futureDays"));
      });
  }

  // ─────────────────────────────────────────────────────────────
  // 命令式设置（Obsidian < 1.13.0，以及 1.13+ 尚未实现声明式时的兜底）
  // ─────────────────────────────────────────────────────────────


  /** 单个日历：启用勾选 + 名称 + 日程色 / 待办色 */
  private renderCalendarRow(containerEl: HTMLElement, cal: CalCalendar): void {
    const caps = [cal.supportsEvent ? "日程" : "", cal.supportsTodo ? "待办" : ""]
      .filter(Boolean)
      .join(" / ");

    new Setting(containerEl)
      .setName(cal.displayName || cal.url)
      .setDesc(caps ? `支持：${caps}` : cal.url)
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
      new Notice("请先填写服务器地址", 4000);
      return;
    }
    const auth = { username: s.username, password: s.password };
    try {
      new Notice("正在发现日历…", 2000);
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
      new Notice(`发现 ${s.calendars.length} 个日历`);
    } catch (e) {
      new Notice(`发现日历失败：${describeNetworkError(e, s.channel)}`, 6000);
    }
  }

  /** 修改设置 → 持久化并通知订阅者（面板会随之重渲染） */
  private async save(): Promise<void> {
    this.plugin.store.saveSettings();
    await this.plugin.store.persist();
  }
}
