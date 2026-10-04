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
 */
import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type CalDavPlugin from "@/main";
import { describeNetworkError, discoverCalendars, testConnection } from "@/core/caldav";
import { calEventColor, calTodoColor, type CalCalendar } from "@/core/types";

export class CalDavSettingTab extends PluginSettingTab {
  private plugin: CalDavPlugin;

  constructor(app: App, plugin: CalDavPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private get s() {
    return this.plugin.store.settings;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    /**
     * 注意：**不要**给容器加 `caldav-settings` 类。
     *
     * 原思源 CSS 里有这样一条：`.caldav-editor, .caldav-settings, .caldav-catmgr { … height:100%; overflow:hidden }`
     * —— 它是为思源设置 Dialog 设计的固定高度容器，内部另有 `.caldav-settings-form`
     * 负责滚动。Obsidian 的设置页是自然流式布局、由 Obsidian 自己管理滚动，
     * 套上该类后内容会被裁掉且无法滚动（实测踩到）。
     * 故改用无冲突的新类名，需要时再针对它写样式。
     */
    containerEl.addClass("caldav-settings-page");

    // ───────────────── 服务器 ─────────────────
    // 用 Setting.setHeading() 而非 createEl("h3")：官方要求这样写，
    // 标题才会被 Obsidian 识别为设置项分区（影响 1.13+ 的设置搜索与折叠行为）。
    new Setting(containerEl).setName("服务器").setHeading();

    new Setting(containerEl)
      .setName("服务器地址")
      .setDesc("CalDAV 根地址或日历集合地址，例如 http://192.168.1.10:5232/")
      .addText((t) =>
        t
          .setPlaceholder("http://…")
          .setValue(this.s.serverUrl)
          .onChange((v) => {
            this.s.serverUrl = v.trim();
            void this.save();
          })
      );

    new Setting(containerEl)
      .setName("用户名")
      .addText((t) =>
        t.setValue(this.s.username).onChange((v) => {
          this.s.username = v.trim();
          void this.save();
        })
      );

    new Setting(containerEl)
      .setName("密码")
      .setDesc("落盘时以 AES-GCM 加密存储；主密钥随插件数据一起保存，多设备可共用。")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.s.password).onChange((v) => {
          this.s.password = v;
          void this.save();
        });
      });

    const issue = this.plugin.store.credentialsIssue();
    if (issue) {
      new Setting(containerEl).setName("凭据状态").setDesc(issue);
    }

    new Setting(containerEl)
      .setName("日历集合路径（可选）")
      .setDesc("留空自动发现；已知确切路径时填写可跳过发现步骤。")
      .addText((t) =>
        t
          .setPlaceholder("留空自动发现")
          .setValue(this.s.calendarPath)
          .onChange((v) => {
            this.s.calendarPath = v.trim();
            void this.save();
          })
      );

    new Setting(containerEl)
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

    // ───────────────── 日历 ─────────────────
    new Setting(containerEl).setName("日历").setHeading();
    if (!this.s.calendars.length) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "尚未发现日历。填写服务器与账号后点击「发现日历」。",
      });
    } else {
      for (const cal of this.s.calendars) this.renderCalendarRow(containerEl, cal);
    }

    // ───────────────── 同步 ─────────────────
    new Setting(containerEl).setName("同步").setHeading();

    new Setting(containerEl)
      .setName("自动同步间隔（分钟）")
      .setDesc("0 表示关闭自动同步，仅手动触发。")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.s.syncIntervalMin)).onChange((v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) return;
          this.s.syncIntervalMin = Math.floor(n);
          void this.save();
        });
      });

    new Setting(containerEl)
      .setName("冲突处理")
      .setDesc("本地与服务端同时改动同一条目时的取舍。")
      .addDropdown((d) =>
        d
          .addOption("server", "服务端优先")
          .addOption("local", "本地优先")
          .setValue(this.s.conflict)
          .onChange((v) => {
            this.s.conflict = v as "server" | "local";
            void this.save();
          })
      );

    new Setting(containerEl)
      .setName("显示范围")
      .setDesc(`过去 ${this.s.pastDays} 天 / 未来 ${this.s.futureDays} 天（影响拉取与视图范围）`)
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.s.pastDays));
        t.onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            this.s.pastDays = Math.floor(n);
            void this.save();
          }
        });
      })
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.s.futureDays));
        t.onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            this.s.futureDays = Math.floor(n);
            void this.save();
          }
        });
      });

    // ───────────────── 提醒 ─────────────────
    new Setting(containerEl).setName("提醒").setHeading();

    new Setting(containerEl)
      .setName("启用提醒")
      .setDesc("对设置了提醒时间的日程与待办，到点弹出提示。移动端仅应用内提示。")
      .addToggle((tg) =>
        tg.setValue(!!this.s.enableReminders).onChange((v) => {
          this.s.enableReminders = v;
          void this.save();
        })
      );

    new Setting(containerEl)
      .setName("同时发送系统通知")
      .setDesc("桌面端在应用内提示之外再发一条系统通知，点击可跳到面板。")
      .addToggle((tg) =>
        tg.setValue(!!this.plugin.hostSettings().systemNotification).onChange(async (v) => {
          await this.plugin.updateHostSettings({ systemNotification: v });
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("提醒状态")
      .setDesc(this.plugin.mainCtx.reminderStatus?.() ?? "-")
      .addButton((b) =>
        b.setButtonText("发送测试提醒").onClick(async () => {
          await this.plugin.mainCtx.testReminder?.();
          this.display();
        })
      );

    // ───────────────── 日记 ─────────────────
    new Setting(containerEl).setName("日记").setHeading();

    new Setting(containerEl)
      .setName("日记目录")
      .setDesc("「插入今日日程」写入的位置。留空则库根目录；文件名固定为 YYYY-MM-DD.md。")
      .addText((t) =>
        t
          .setPlaceholder("例如 DailyNotes")
          .setValue(this.plugin.hostSettings().dailyNoteFolder ?? "")
          .onChange(async (v) => {
            await this.plugin.updateHostSettings({ dailyNoteFolder: v.trim() });
          })
      );

    // ───────────────── 视图 ─────────────────
    new Setting(containerEl).setName("视图").setHeading();

    new Setting(containerEl)
      .setName("日历视图中显示待办")
      .setDesc("关闭后日历视图只显示日程，待办仍可在任务视图与列表中看到。")
      .addToggle((tg) =>
        tg.setValue(this.s.showTodosInCalendar !== false).onChange((v) => {
          this.s.showTodosInCalendar = v;
          void this.save();
        })
      );
  }

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
      this.display();
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
