# CalDAV Calendar and Tasks

Two-way sync between Obsidian and your CalDAV server, covering **calendar events (VEVENT)** and **task lists (VTODO)**. Four calendar views (year / month / week / day) plus a dedicated task view, inline editing, priority and category filters, a bilingual UI, and one-click export of the day's agenda into your daily note.

[中文说明](#中文说明) · [English](#english)

---

## English

Two-way sync of calendar events (VEVENT) and task lists (VTODO) with your own CalDAV
server — Radicale, Nextcloud, Baikal, and other standard implementations. Most community
plugins handle events only, are read-only, or borrow another plugin's credentials. This one
syncs **VTODO task lists both ways** as well, and depends on no other plugin.

### Features

- **Two-way sync for events and tasks.** Edits you make in Obsidian are written back to the
  server; changes made on the server are pulled back in.
- **Four calendar views plus a task view.** Year / month / week / day, and a task list you can
  narrow down by condition — overdue, today, this week, upcoming, undated, completed.
- **Full editing.** Title, start and end time, all-day flag, location, description, categories,
  separate colors for events and tasks, reminder times, and recurrence rules.
- **Priority and category filters.** Both live in the sidebar's filter popover; when both are
  active, items must satisfy both.
- **Bilingual interface.** English or Simplified Chinese, chosen in settings or inherited from
  the Obsidian interface language.
- **Conflict handling.** When the same item was changed both locally and on the server, you can
  decide which side wins.
- **Reminders.** In-app notices when a reminder time is reached; on desktop you can also get a
  system notification.
- **Write into your daily note.** Pick a range (today / this week / this month / all) and the
  matching events and tasks are inserted into that day's note.
- **Adjustable display range.** Only fetch and show items within a chosen number of days back
  and ahead.

### Installation

#### From the community directory (recommended)

Open **Settings → Community plugins → Browse**, search for
`CalDAV Calendar and Tasks`, then install and enable it.

#### Manual install

Download `main.js`, `manifest.json`, and `styles.css` from the
[Releases](https://github.com/vilifetime/obsidian-caldav-calendar-tasks/releases) page and
place them in your vault's plugin folder:

```
<vault>/.obsidian/plugins/caldav-calendar-tasks/
```

Then enable the plugin under **Settings → Community plugins**.

### Setup

Open **Settings → CalDAV Calendar and Tasks** and fill in your server details.

1. **Server address** — the CalDAV root URL, or the URL of a calendar collection, for example
   `http://192.168.1.10:5232/`.
2. **Username / Password** — leave the password empty for anonymous access.
3. Click **Test connection** to verify reachability, then **Discover calendars** to list the
   calendars on the server.
4. Under **Calendars**, tick each collection you want to sync, and pick a color for its events
   and for its tasks.
5. Adjust the rest as needed: **Auto-sync interval (minutes)**, **Conflict handling**,
   **Display range**, reminders, **Daily note folder**, and whether tasks appear in the
   calendar view.

Verified working against Radicale, Nextcloud, Baikal, and other standard CalDAV
implementations.

> **About the password.** It is encrypted with AES-GCM before being written to disk, and the
> master key is stored alongside the plugin's data inside the vault. That way several devices
> can share the same credentials, instead of overwriting each other over a sync service that
> carries your notes but not the key file.

### Usage

- **Open calendar and tasks** — the full panel, in the middle of the workspace.
- **Open calendar and tasks in the right sidebar** — the same full panel, docked to the right.
- **Open calendar and tasks manager (right sidebar)** — a compact list for keeping the sidebar
  open full time.
- Mouse actions on day cells and items — see [Mouse actions](#mouse-actions) below.
- **Sync CalDAV now**, **New task**, **New event**, **Insert events and tasks into daily
  note**, and **Send a test reminder** are all available from the command palette.
- The status bar shows `CalDAV` in the bottom right, and changes appearance while syncing and
  when a sync fails.

#### Mouse actions

What each mouse gesture does depends on what is already on screen — in particular whether the
sidebar is open and which day, if any, is focused.

| Mouse action | Current state | Result |
| --- | --- | --- |
| Click a day cell | that day is not focused | Focus that day (its border darkens) and list that day in the sidebar. The sidebar is left open or closed as it was |
| Click a day cell | that day is already focused | Clear the focus and restore what the sidebar was showing before. The sidebar is left open or closed as it was |
| Right-click a day cell | sidebar hidden | Open the sidebar and switch it to **All unfinished** |
| Right-click a day cell | sidebar open, showing **All unfinished** | Switch to the list for the month containing that date (in month view) or the week containing it (in week view) — the sidebar dropdown shows that date's month. The sidebar stays open |
| Right-click a day cell | sidebar open, showing that month or week, or the day view is showing | Hide the sidebar |
| Right-click an item | sidebar hidden | Open the sidebar with that item's full details |
| Right-click an item | sidebar open | Hide the sidebar |
| Click an item | that item is not focused | Show that item's full details. The sidebar is left open or closed as it was |
| Click an item | that item is already focused | Restore what the sidebar was showing before. The sidebar is left open or closed as it was |
| Double-click an item | — | Open the editor for that item |
| Double-click a day cell | — | Open the new-item menu |

Two things worth knowing:

- Right-clicking a day cell **cycles the sidebar through three states** — open it at
  "All unfinished", then widen it to that date's month (month view) or week (week view), then
  hide it. In the day view the cycle has no middle step, so it goes straight from open to
  hidden.
- On touch devices, **long-pressing an item is the same as right-clicking it**. Day cells have
  no long-press gesture; use **New task / New event** from the command palette instead.

### Privacy and network use

This plugin accesses the network to talk to your own CalDAV server. In full disclosure:

- **Services contacted.** Only the one CalDAV server address you enter in the settings. The
  plugin contacts no third-party service, no analytics service, and no advertising service.
- **Requests sent.** `PROPFIND` (discover calendars and fetch items), `REPORT` (query by time
  range), `PUT` (create or update an item), and `DELETE` (remove an item) — all standard
  CalDAV methods, aimed at the calendar collections on that server.
- **Credentials.** Your username and password are sent to your own server with those requests
  (HTTP Basic authentication). The password is AES-GCM encrypted at rest.
- **No data collection.** The plugin contains no telemetry, no analytics, and no code that
  sends your data to the developer or anyone else.
- **Clipboard.** Not used.
- **Files written.** Two files inside the vault's `.obsidian` directory: the plugin's own
  `data.json` (settings and cached items), and `caldav-calendar-tasks/backup.json` — a copy of
  the settings only, so that reinstalling after an uninstall does not require configuring the
  server again. The backup contains the encrypted password together with the key that decrypts
  it (the same pairing that already exists in `data.json`), never a plaintext password. It is
  never read or sent anywhere except your own disk.
- **Files outside the vault.** Apart from the network access above, no file outside the vault
  directory is read or written.
- **Reminder notifications.** Desktop system notifications are emitted by Obsidian itself and
  go through no external service.

### Mobile

Supported. The plugin only uses Obsidian's `requestUrl` and the browser Web Crypto API — no
Node.js or Electron — so it works on iOS and Android as well (`isDesktopOnly: false`). On
mobile, reminders appear as in-app notices only; system notifications are desktop-only.

### Frequently asked questions

**Cannot connect to the server.** Check that Obsidian can reach the address. Local network
addresses such as `192.168.1.10` are usually unreachable from a phone — use an address the
phone can reach. Self-signed HTTPS certificates may fail the certificate chain check.

**Discovering calendars returns nothing.** Try filling in the calendar collection path directly
to skip discovery, or check that the account has read access to the target collection.

**Tasks are not syncing.** Make sure the collection supports VTODO. Each calendar in the
discovery list is labelled with what it supports; if only events are shown, that collection
contains no task component.

**Do I have to configure the server again after uninstalling and reinstalling?** No. Settings are
backed up to `.obsidian/caldav-calendar-tasks/backup.json` whenever they change — uninstalling
removes the `plugins/` directory, and this file is not part of it. On the first launch after
reinstalling, a dialog reports the settings that were found: choose "Restore" to bring back the
server, calendars, categories and password together, or "Set up again" to discard the backup and
start from scratch. Items themselves are not part of the backup; a sync runs right after
restoring so they come back.

**The password changed and can no longer be decrypted.** If you clear the password in settings
and type a new one, the master key is kept and re-encryption works. If a credential error is
reported, the **Credential status** line in settings explains why.

### Development

```bash
npm install       # install dependencies
npm run dev       # watch build, and sync to the local vault
npm run build     # production build (type check, then bundle)
npm run typecheck # type check only
npm test          # regression tests
```

`npm run build` emits CommonJS `main.js`, as the Obsidian plugin format requires. Styles are not
bundled: `scripts/deploy.mjs` copies `src/styles.css` to `styles.css` directly.

### License

[MIT](LICENSE) © 2026 vilifetime

---

## 中文说明

在 Obsidian 里双向同步 CalDAV 服务器的**日历事件（VEVENT）**与**待办任务（VTODO）**，提供
月 / 周 / 日 / 年四种日历视图与专门的任务列表，支持就地编辑、优先级与分类筛选，并可把当天
日程一键写入日记。界面支持中英双语。

其他社区插件大多只做日程、只读，或仅"借用"其他插件的令牌；本插件同时覆盖 **VTODO 待办的
双向同步**，且不依赖任何第三方插件。

### 功能

- **双向同步事件与待办**：在 Obsidian 里的增删改会写回服务器，服务器上的改动也会拉回本地。
- **四种日历视图 + 任务视图**：年 / 月 / 周 / 日，以及按条件筛选的待办列表（逾期、今天、本周、
  待办无日期、已完成等）。
- **完整编辑能力**：标题、起止时间、全天标记、地点、描述、分类、日程色与待办色分设、提醒时间、
  重复规则。
- **优先级与分类筛选**：两者都在右侧栏的筛选弹层里，可同时启用，同时启用时条目须同时满足。
- **中英双语界面**：英文或简体中文，可在设置中选择，默认跟随 Obsidian 界面语言。
- **冲突策略可选**：本地与服务端同时改动同一条目时，可指定服务端优先或本地优先。
- **提醒**：对带提醒时间的日程与待办到点提示；桌面端可同时发系统通知。
- **写入日记**：先选范围（当日 / 本周 / 本月 / 所有），再把对应日程与待办插入当天日记。
- **显示范围可调**：只同步 / 显示过去与未来指定天数内的事项。

### 安装

#### 从社区插件目录安装（推荐）

在 Obsidian 中打开 **设置 → 第三方插件 → 浏览**，搜索 `CalDAV Calendar and Tasks`
并安装启用。

#### 手动安装

从本仓库的 [Releases](https://github.com/vilifetime/obsidian-caldav-calendar-tasks/releases)
下载最新版本的 `main.js`、`manifest.json`、`styles.css` 三个文件，放到你的库目录下：

```
<库名>/.obsidian/plugins/caldav-calendar-tasks/
```

然后在 **设置 → 第三方插件** 中启用。

### 配置

首次使用需要填写服务器信息：**设置 → CalDAV Calendar and Tasks**。

1. **服务器地址**：CalDAV 根地址或某个日历集合地址，例如 `http://192.168.1.10:5232/`。
2. **用户名 / 密码**：留空表示匿名访问。3. 点击 **测试连接** 验证连通性，再点 **发现日历** 列出服务器上的日历。
4. 在 **日历** 分区逐个勾选要同步的集合，并为日程色与待办色取值。
5. 其余分项（同步间隔、冲突处理、显示范围、提醒、日记目录、待办是否显示在日历中）按需调整。

已验证可用的服务端：Radicale、Nextcloud、Baikal，以及其他标准 CalDAV 实现。

> **关于密码**：密码在落盘时经 AES-GCM 加密，主密钥随插件数据一起保存在库内的插件数据文件中。
> 这样多设备可以共用同一份凭据，而不会因云同步只带走笔记、不带走密钥而互相覆盖。

### 使用

- **打开日历与任务**：面板出现在主工作区中央。
- **在右侧栏打开日历与任务**：同一个完整面板，停在右侧栏。
- **打开日历任务管理（右侧栏）**：精简清单，适合常驻右侧栏。
- 日期格与条目上的鼠标动作见下方[鼠标操作](#鼠标操作)。
- **立即同步**、**新建待办**、**新建日程**、**把今日日程与待办插入日记** 等命令均可在命令面板找到。
- 状态栏右下角显示 `CalDAV` 字样，同步中与失败会切换显示。

#### 鼠标操作

同一手势做什么，取决于当前屏幕上是什么状态 —— 尤其是右侧栏是否打开、以及当前有没有聚焦某一天。

| 鼠标动作 | 当前状态 | 执行操作 |
| --- | --- | --- |
| 单击单元格 | 未聚焦该日 | 聚焦该日（并加深单元格边框），右侧栏显示该日清单，不改变右侧栏打开或隐藏状态 |
| 单击单元格 | 已聚焦该日 | 取消聚焦该日，右侧栏恢复之前显示内容，不改变右侧栏打开或关闭状态 |
| 右击单元格 | 右侧栏隐藏 | 打开右侧栏 + 切到「所有未完成」 |
| 右击单元格 | 右侧栏已打开，且清单为「所有未完成」 | 切到「单元格日期所在月（月视图时）/ 周（周视图时）」清单（右侧栏下拉菜单内显示该日期所在月），不隐藏右侧栏 |
| 右击单元格 | 右侧栏已打开，且清单为「单元格日期所在月/周」或者当前为日视图 | 隐藏右侧栏 |
| 右击条目 | 右侧栏隐藏 | 打开右侧栏，显示该条目的所有详细信息 |
| 右击条目 | 右侧栏已打开 | 隐藏右侧栏 |
| 单击条目 | 未聚焦该条目 | 显示该条目的所有详细信息，不改变右侧栏打开或隐藏状态 |
| 单击条目 | 已聚焦该条目 | 右侧栏恢复之前显示内容，不改变右侧栏打开或关闭状态 |
| 双击条目 | — | 弹出编辑界面 |
| 双击单元格 | — | 弹出新建菜单 |

两点补充：

- 右击单元格是**右侧栏的三态循环** —— 先打开到「所有未完成」，再展开到该日期所在月（月视图）/ 周（周视图），
  再隐藏。日视图没有中间这一档，于是直接从打开跳到隐藏。
- 触摸端**长按条目等同于右击条目**。日期格没有长按手势，需要新建请用命令面板里的「新建待办 / 新建日程」。

### 隐私与网络使用

本插件需要访问网络，用于与你自己的 CalDAV 服务器通信。在此明确披露：

- **连接的服务**：仅连接**你自己在设置中填写的那一个 CalDAV 服务器地址**。插件不连接任何第三方
  服务、统计分析服务或广告服务。
- **发送的请求**：`PROPFIND`（发现日历与拉取条目）、`REPORT`（按时间范围查询）、`PUT`（创建或更新
  条目）、`DELETE`（删除条目），均为 CalDAV 标准方法，目标是该服务器上的日历集合。
- **凭据**：用户名与密码随上述请求发送给你自己的服务器（HTTP Basic 认证）。密码落盘时经
  AES-GCM 加密。
- **不收集数据**：插件不包含任何遥测、埋点或分析代码，不向开发者或第三方发送你的数据。
- **剪贴板**：不使用。
- **写入的文件**：库内 `.obsidian` 目录下两个文件 —— 插件自身的 `data.json`（设置与条目缓存），
  以及 `caldav-calendar-tasks/backup.json`（**仅设置**，用于卸载后重装免去重新配置服务器）。
  备份里保存的是**加密后的密码**及其解密密钥（与 `data.json` 中原有的配对方式相同），
  **不会出现明文密码**；除你自己的磁盘外，该文件不会被读取或发送到任何地方。
- **库外文件**：除上述网络访问外，不访问库目录以外的任何文件。
- **提醒通知**：桌面端系统通知由 Obsidian 自身发出，不经任何外部服务。

### 移动端

支持。插件仅使用 Obsidian 的 `requestUrl` 与浏览器 Web Crypto API，不依赖 Node.js / Electron，
因此在 iOS 与 Android 客户端同样可用（`isDesktopOnly: false`）。移动端提醒仅以应用内提示呈现，
系统通知为桌面端专属。

### 常见问题

**连不上服务器。** 确认 Obsidian 能访问该地址。局域网地址（如 `192.168.1.10`）在手机上通常
无法访问，需用对手机可达的地址。自签名 HTTPS 证书可能因证书链校验失败而连接失败。

**发现日历返回空。** 尝试直接填写「日历集合路径」跳过发现步骤，或检查账号是否对目标集合有读权限。

**待办没有同步。** 确认该日历集合支持 VTODO。发现列表中每个日历下方会标注「支持：日程 / 待办」，
若只显示日程则该集合不含待办组件。

**卸载插件后重装，要重新配一遍服务器吗？** 不用。设置会在每次改动后备份到
`.obsidian/caldav-calendar-tasks/backup.json`（卸载插件删的是 `plugins/` 目录，这个文件不受影响）。
重装后首次打开会弹窗告知找到了上次的配置，点「恢复」即可 —— 服务器、日历、分类与密码一并恢复。
选「重新配置」则丢弃这份备份、从空白开始。条目本身不进备份，恢复后会立即同步一次重新拉回。

**密码变了之后解不开。** 若在设置中清空密码后再重新填写，主密钥保持不变，可正常重新加密。
若提示凭据异常，可在设置页查看「凭据状态」的具体说明。

### 开发

```bash
npm install       # 安装依赖
npm run dev       # 监听构建，并自动同步到本机库
npm run build     # 生产构建（先类型检查再打包）
npm run typecheck # 仅类型检查
npm test          # 回归测试
```

`npm run build` 产物为 CommonJS 的 `main.js`，符合 Obsidian 插件规范。样式不经打包，
由 `scripts/deploy.mjs` 从 `src/styles.css` 直接复制为 `styles.css`。

### 许可

[MIT](LICENSE) © 2026 vilifetime
