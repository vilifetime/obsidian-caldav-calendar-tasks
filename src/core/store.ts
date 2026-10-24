/**
 * 本地存储与条目仓库：插件私有数据读写 + 内存索引 + 订阅
 */
import type { CalAttachment, CalItem, CalSettings, PersistData, PurgeBackup } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { deepCopy } from "./errors";
import type { TimerHandle } from "../constants";
import {
  adoptKeyring,
  decryptSecretDeep,
  encryptSecret,
  getKeyring,
  isEncrypted,
  isLegacyEncrypted
} from "./secret";
import { t } from "../i18n";
import { mergeBackupSettings } from "./config-backup";
import { sanitizeEtag } from "./caldav";
import { serverOriginOf } from "./server-id";

/**
 * 宿主提供的持久化接口。
 *
 * Obsidian 的 `Plugin.loadData()` 返回 `Promise<any>`（官方类型定义如此），
 * 故这里只能接 `unknown` —— 由 `load()` 内部断言成 `PersistData`。
 */
export interface StoreEnv {
  loadData: () => Promise<unknown>;
  saveData: (data: PersistData) => Promise<void>;
}

export class CalStore {
  settings: CalSettings = deepCopy(DEFAULT_SETTINGS);
  private items = new Map<string, CalItem>();
  lastSync?: string;
  lastError?: string;
  /** 上次同步的中性提示（对账自愈等），**不是错误**，见 types.ts 的 SyncState */
  lastNote?: string;
  /** 即时推送累计成功的条目 key（上传/删除分列），下一轮 syncAll 合并进报告后清零。
   *  按 key 而非按条数：同一条目推 N 次只计一条（2026-10-19 修「操作几次就报上传几次」）。 */
  pendingUploadedKeys: string[] = [];
  pendingDeletedKeys: string[] = [];
  /** 密码解密失败（本地密钥丢失/损坏），需要用户重新输入密码 */
  secretBroken = false;
  /** 密钥尚未就绪导致的「暂时解不开」——不是密码损坏，稍后可重试 */
  pendingUnlock = false;
  /** 随数据持久化的主密钥（云同步会把它带到别的设备，见 core/secret.ts） */
  keyring = "";
  /**
   * 最近一次「清理旧服务器条目」的备份（见 types.ts 的 PurgeBackup）。
   *
   * 存顶层而不是 settings 里 —— settings 会被「配置备份」单独抄走，
   * 那个文件明确只存配置不存条目（见 core/config-backup.ts 的取舍说明）。
   */
  purgeBackup?: PurgeBackup;
  /** 磁盘上的原始密文：解密失败时用它回写，绝不把密文覆盖成空串 */
  private rawCipher = "";
  private listeners = new Set<() => void>();
  private saveTimer: TimerHandle | null = null;

  constructor(private env: StoreEnv) {}

  async load(): Promise<void> {
    const data = (await this.env.loadData()) as PersistData | undefined;
    if (data) {
      this.settings = { ...deepCopy(DEFAULT_SETTINGS), ...data.settings };
      this.items = new Map(
        (data.items || []).map((it) => {
          // 幂等自愈：历史上拉取回来的 etag 被服务端 XML 转义成 &quot;xxxx&quot; 残留在本地
          // （见 core/caldav.ts 的 parseMultistatus 修复），这里加载时还原，避免 If-Match 永远 412。
          if (it && typeof it.etag === "string" && /&(quot|amp|lt|gt|apos);/.test(it.etag)) {
            it.etag = sanitizeEtag(it.etag);
          }
          return [keyOf(it), it];
        })
      );
      this.lastSync = data.sync?.lastSync;
      this.lastError = data.sync?.lastError;
      this.lastNote = data.sync?.lastNote;
      this.pendingUploadedKeys = Array.isArray(data.sync?.pendingUploadedKeys) ? data.sync.pendingUploadedKeys : [];
      this.pendingDeletedKeys = Array.isArray(data.sync?.pendingDeletedKeys) ? data.sync.pendingDeletedKeys : [];
      this.keyring = data.keyring || "";
      this.purgeBackup = data.purgeBackup;
    }
    // 先注入主密钥再解密：密钥的权威副本随数据走，新生成的由 sink 回写持久化
    adoptKeyring(this.keyring, (k) => {
      this.keyring = k;
      this.persistSoon();
    });
    await this.unlockPassword();
  }

  /**
   * 把持久化的密码还原为内存明文；旧明文会在下次保存时自动改写为密文。
   *
   * 三条铁律（缺一条就会「丢密码」，见 core/secret.ts 的说明）：
   *   1. 密钥未就绪（unavailable）**不算**密码损坏：不置 secretBroken、不写盘，等重试；
   *   2. 解不开（mismatch）也只做提示，**原密文留在 rawCipher**，由 persist() 原样写回；
   *   3. 内存 password 为空 ≠ 用户想清空密码 —— persist() 必须能区分这两种情况。
   */
  private async unlockPassword(): Promise<void> {
    const raw = this.settings.password || "";
    this.rawCipher = raw;
    if (!raw) return;
    if (!isEncrypted(raw)) {
      // 旧版明文：兼容使用，并立即回写一份密文
      void this.persist();
      return;
    }
    // 逐层剥：兼容旧版把 enc:v3 当明文再包一层的套娃密文（升级过渡期）
    const r = await decryptSecretDeep(raw);
    if (r.ok) {
      this.settings.password = r.value ?? "";
      this.secretBroken = false;
      this.pendingUnlock = false;
      // v1/v2 密文的密钥是本机派生的，别的设备永远读不了 —— 既然本机解得开，
      // 立刻重存为 v3（密钥随数据走），否则下次照样「丢密码」。
      if (isLegacyEncrypted(raw)) void this.persist();
      return;
    }
    this.settings.password = "";
    this.pendingUnlock = r.reason === "unavailable";
    this.secretBroken = !this.pendingUnlock;
    // 以下两处 console.warn 刻意保留（官方只禁 console.log/info）：密码解密失败是
    // 「多设备来回覆盖导致丢密码」这类问题的唯一诊断线索，且已同时写入 lastError
    // 供 Dock状态栏显示——控制台与UI 两路都留，便于用户报障时定位。
    if (this.pendingUnlock) {
      // 密钥还没到位：别惊动用户，更别动磁盘上的密文，等 retryUnlock()
      console.warn("[caldav] 密钥尚未就绪，暂缓解密密码（磁盘上的密文保持原样）");
      return;
    }
    // 写进 lastError，让 Dock 状态栏能直接显示出来（否则只在控制台，用户看不到）
    this.lastError = t("sync.storeSecretBroken");
    console.warn("[caldav] 密码解密失败（密钥不匹配），请在设置中重新输入密码");
  }

  /** 密钥就绪后重试解密（例如设备标识迟到，或数据由另一台设备同步过来） */
  async retryUnlock(): Promise<void> {
    if (!this.pendingUnlock) return;
    await this.unlockPassword();
    if (!this.pendingUnlock) this.notify();
  }


  /** 凭据是否可用（用于同步前检查与界面提示） */
  credentialsIssue(): string | undefined {
    if (this.pendingUnlock) return t("sync.storePendingUnlock");
    if (this.secretBroken) return t("sync.storeSecretBrokenShort");
    if (this.settings.serverUrl && !this.settings.password) return t("sync.storeNoPassword");
    return undefined;
  }

  private persistSoon(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.persist(), 400);
  }

  async persist(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const plain = this.settings.password || "";
    // 内存里没有明文有两种完全不同的含义 ——
    //   a) 已解开密文、用户本来就没密码 → 存空；
    //   b) 还没解开（密钥未就绪 / 密钥不匹配）→ **必须原样写回 rawCipher**。
    // 曾经不区分，b 会把磁盘上的密文覆盖成空串，密文永久丢失（「总是丢密码」的放大器）。
    const locked = this.secretBroken || this.pendingUnlock;
    const password = plain ? await encryptSecret(plain) : locked ? this.rawCipher : "";
    await this.env.saveData({
      keyring: getKeyring() || this.keyring,
      settings: { ...this.settings, password },
      items: Array.from(this.items.values()),
      purgeBackup: this.purgeBackup,
      sync: {
        lastSync: this.lastSync,
        lastError: this.lastError,
        lastNote: this.lastNote,
        pendingUploadedKeys: this.pendingUploadedKeys,
        pendingDeletedKeys: this.pendingDeletedKeys
      }
    });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 用一份备份替换当前设置（卸载后重装的恢复路径）。
   *
   * 三件事，按顺序都不能省：
   *   1. **设置整份替换**（不是合并）—— 半份设置比没有更糟，用户看不出哪缺了；
   *   2. **keyring 一并交回** —— 必须**先**给 keyring 再解密 password，
   *      否则新密文会被当成解不开的脏数据（`mismatch`）而被丢弃；
   *   3. **清掉 `rawCipher`** —— 它存着上一个（已作废的）密文，
   *      若新解锁失败会把旧密文写回去，等于备份没生效。
   *
   * 恢复失败（密钥对不上、密文解不开）**不抛**：退化成「没恢复」的状态，
   * 让用户手工重填，比插件加载失败好。
   *
   * 返回一个 Promise，**必须等它完成**再拿设置去同步或落盘。
   * 解密是异步的（WebCrypto），而这里把 `unlockPassword()` 丢在后台 fire-and-forget：
   * 调用方若不等，`settings.password` 此刻仍是那串 `enc:v3:` 密文 ——
   * 同步会拿密文当密码去连服务器（401），落盘还会把密文再加密一层（套娃）。
   * 这正是「恢复后没有立即同步」的直接成因（2026-10-09 雄哥反馈）。
   */
  adoptBackup(backup: { settings: CalSettings; keyring?: string }): Promise<void> {
    this.settings = mergeBackupSettings({ v: 1, savedAt: "", settings: backup.settings });
    this.secretBroken = false;
    this.pendingUnlock = false;
    // 先 adopt keyring：它会把主密钥灌进 secret.ts 的模块级缓存，
    // 不先给的话下面 decryptSecretDeep 会因取不到密钥而判为 mismatch。
    adoptKeyring(backup.keyring || "", (k) => {
      this.keyring = k;
    });
    // 旧密文就此作废 —— 必须清空。否则恢复失败时 persist() 会把它写回去，
    // 看起来就像「备份没生效」。
    this.rawCipher = "";
    return this.unlockPassword()
      .catch(() => {
        this.settings.password = "";
        this.rawCipher = "";
        this.secretBroken = true;
      })
      .then(() => {
        // emit() 内含 persistSoon()，顺带通知面板重渲染
        this.emit();
      });
  }

  private emit(): void {
    this.persistSoon();
    for (const fn of this.listeners) fn();
  }

  getAll(): CalItem[] {
    return Array.from(this.items.values());
  }

  get(key: string): CalItem | undefined {
    return this.items.get(key);
  }

  /**
   * 某个日历在本地**一条条目都没有**吗？
   *
   * 用于「该不该信任 sync-token」的判定（见 core/sync.ts 的拉取分支）。
   *
   * 判据是「有没有任何条目」，**包含标记了 deleted 的** —— 待删条目同样说明
   * 本地掌握着这个日历的状态（哪怕 DELETE 这轮失败了），token 的声明仍然可信。
   *
   * 已知取舍：服务端本来就是空的日历（或条目全在时间窗外）会让本地恒为空，
   * 于是每轮都走全量。但那只是多一次返回空的 REPORT，代价可忽略；反过来，
   * 若把待删条目算成「空」，就会在「正清空某个日历」的当口触发无谓的全量重拉。
   */
  isCalendarLocallyEmpty(calendarUrl: string): boolean {
    for (const it of this.items.values()) {
      if (it.calendarUrl === calendarUrl) return false;
    }
    return true;
  }

  /** upsert（不触发 emit 的低层方法） */
  put(item: CalItem): void {
    this.items.set(keyOf(item), item);
  }

  putAndEmit(item: CalItem): void {
    this.put(item);
    this.emit();
  }

  remove(key: string): void {
    this.items.delete(key);
    this.emit();
  }

  /**
   * 当前**真正在用**的服务器身份集合（来自启用日历的集合地址）。
   *
   * 为什么不用 settings.serverUrl 直接判定：用户改了服务器地址但还没重新点
   * 「发现日历」时，启用日历仍指向旧服务器 —— 那时按新地址判定就会把**旧服务器
   * 正在用的条目**当成「其他服务器的」清掉，那是真的丢数据。
   * 启用日历才是「插件此刻在跟谁同步」的权威依据。
   *
   * 判据是 origin（协议+主机+端口，见 core/server-id.ts）：同一台服务器上的
   * 多个日历集合算同一个身份，必须一起保留。
   */
  activeServerOrigins(): Set<string> {
    const out = new Set<string>();
    for (const c of this.settings.calendars) {
      if (!c.enabled) continue;
      const o = serverOriginOf(c.url || "");
      if (o) out.add(o);
    }
    return out;
  }

  /**
   * 「孤儿条目」：本地留着、但属于**其它服务器**的条目。
   *
   * 典型来源：换服务器后旧服务器的条目（2026-10-24 实测换 iCloud → 自建服务器
   * 后残留一批）。它们既不显示也不同步（没有对应日历），却一直占着本地存储，
   * 换回去时还会「诈尸」冒出来。
   *
   * ⚠️ 一个启用日历都没有时返回空数组（**不清任何东西**）——
   *    配置还没填好时绝不能把全部数据当成孤儿清空。
   *
   * ⚠️ calendarUrl 为空/异常的条目保留（判不出归属就别动）。
   */
  orphanItems(): CalItem[] {
    const active = this.activeServerOrigins();
    if (!active.size) return [];
    const out: CalItem[] = [];
    for (const it of this.items.values()) {
      const o = serverOriginOf(it.calendarUrl || "");
      if (!o) continue;
      if (!active.has(o)) out.push(it);
    }
    return out;
  }

  /**
   * 清理孤儿条目，并把被删内容备份进 `purgeBackup`（见 types.ts）。
   *
   * **只清本地，不动服务端** —— 旧服务器上的条目还在，用户哪天换回去照样能拉到。
   * 清理前必须留备份：这是删除动作，用户后悔了要能一键恢复。
   *
   * 返回清理条数（0 = 没有可清的）。
   */
  async purgeOrphanItems(): Promise<number> {
    const victims = this.orphanItems();
    if (!victims.length) return 0;
    const active = this.activeServerOrigins();
    const removed = new Set<string>();
    for (const v of victims) {
      const o = serverOriginOf(v.calendarUrl || "");
      if (o) removed.add(o);
      this.items.delete(keyOf(v));
    }
    this.purgeBackup = {
      at: new Date().toISOString(),
      keptServer: Array.from(active).join("、"),
      removedServers: Array.from(removed).join("、"),
      count: victims.length,
      items: victims.map((v) => ({ ...v }))
    };
    this.emit();
    // 立刻落盘：emit() 只 debounce 400ms，用户可能在这之前就关了窗口
    await this.persist();
    return victims.length;
  }

  /**
   * 按开关决定是否清理孤儿条目。返回清理条数（0 = 没清或开关关着）。
   *
   * 这是「切换服务器时清理旧条目」的唯一执行入口：
   * 开关关着 → 什么都不做；开关开着 → 把不属于当前启用日历服务器的条目清掉。
   *
   * ⚠️ 守卫：**启用日历必须全部指向当前服务器地址**，否则一律跳过。
   *    否则用户正在设置页里逐字输入新地址时（每敲一个字符都会存一次设置），
   *    启用日历还指着旧服务器，会把**正要切过去的那台服务器的条目**当成孤儿清掉 ——
   *    切回去时数据已经没了。配置还没对齐时不动，是这里最重要的安全阀。
   */
  async purgeOrphansIfEnabled(): Promise<number> {
    if (!this.settings.purgeOtherServerOnSwitch) return 0;
    const active = this.activeServerOrigins();
    if (!active.size) return 0;
    const urlOrigin = serverOriginOf(this.settings.serverUrl || "");
    if (!urlOrigin) return 0;
    for (const o of active) {
      if (o !== urlOrigin) return 0; // 配置未对齐（还没重新「发现日历」）→ 不动
    }
    return this.purgeOrphanItems();
  }

  /**
   * 恢复最近一次清理掉的条目。返回恢复条数。
   *
   * 键冲突（本地已有同 UID 条目）时**跳过不覆盖** —— 覆盖会把用户现在的数据
   * 换成备份里的旧数据，那是另一种数据丢失。
   */
  async restorePurgedItems(): Promise<number> {
    const b = this.purgeBackup;
    if (!b || !b.items.length) return 0;
    let n = 0;
    for (const it of b.items) {
      const k = keyOf(it);
      if (this.items.has(k)) continue;
      this.items.set(k, { ...it, dirty: false, deleted: false });
      n++;
    }
    this.purgeBackup = undefined;
    this.emit();
    await this.persist();
    return n;
  }

  /** 用一批服务端条目合并替换同日历的远端态（保留本地脏数据） */
  mergeServerItems(incoming: CalItem[], deletedKeys: string[] = []): { changed: boolean; removed: number; applied: number } {
    let changed = false;
    // 本地实际消失的条目数。**必须报给上层**，否则服务端删掉的条目在同步报告里
    // 表现为「删除 0 条」，用户会以为删除没同步过来（2026-10-10 实测）。
    let removed = 0;
    // 本地**实际写入**的条目数。上层要用它当「拉取 N 条」——
    // 不能用 incoming.length，否则自己刚推上去的条目被服务端当变更推回时，
    // 会被重复计入拉取（自环回显，2026-10-10 实测：新建一条显示「上传1 拉取1」）。
    let applied = 0;
    // 老数据自愈：2026-10-14 之前的版本**从不在拉取时保存 ICS 原文**，本地 store 里
    // 一大批条目的 `raw` 是 undefined。这些条目一旦被编辑就会走 `itemToNewICS` 整份重拼，
    // 服务端的 ATTACH / ORGANIZER / ATTENDEE / VTIMEZONE 全部被抹掉（实测数据丢失）。
    // 服务端内容没变（etag 相同 / 字段全同）时顺手把原文补上：数据上一个字节都没变，
    // 所以**不计入 `applied`**（否则「拉取 N 条」会虚增），只标 changed 让它落盘。
    const adoptRaw = (cur: CalItem, inc: CalItem): void => {
      if (cur.raw || !inc.raw) return;
      cur.raw = inc.raw;
      changed = true;
    };
    // ⚠️ 附件要按「空 ≡ 没有」归一化（2026-10-20 第一批附件移植时补上）：
    //    编辑器删光附件时写的是 `[]`，而解析器在无 ATTACH 时留 `undefined`。
    //    直接比会把这两者判成「有变化」，于是删完附件的条目每轮同步都被拉回一次
    //    （自环回显的变种）。
    const attKey = (a?: CalAttachment[]): string => (a && a.length ? JSON.stringify(a) : "");
    for (const inc of incoming) {
      // 本地脏数据优先：等上传后再被服务端确认覆盖
      const existing = this.items.get(keyOf(inc));
      if (existing?.dirty) continue;
      const cur = existing;
      if (cur && cur.href === inc.href) {
        // etag 是服务端对**内容**算的指纹：相同即代表服务端内容与本地上次同步时
        // 一致，没有实质变化，不必写入。
        //
        // 这是挡住「自环回显」唯一可靠的判据。逐字段比对做不到 —— 其中最脆弱的
        // `raw`：本地是生成的 ICS 原文，服务端返回的是它规范化过的版本（换行、
        // 属性顺序、补 PRODID/DTSTAMP 等），几乎必然不等，于是自己刚推上去的
        // 条目每轮都被判成「有变化」，拉取永远虚增 1（2026-10-10 实测）。
        if (cur.etag && inc.etag && cur.etag === inc.etag) {
          adoptRaw(cur, inc);
          continue;
        }
        // etag 缺失（老数据 / 服务端不返回）时才退回逐字段比对
        const same =
          cur.summary === inc.summary &&
          cur.start === inc.start &&
          cur.end === inc.end &&
          cur.description === inc.description &&
          cur.location === inc.location &&
          cur.priority === inc.priority &&
          cur.percent === inc.percent &&
          cur.status === inc.status &&
          JSON.stringify(cur.rrule || null) === JSON.stringify(inc.rrule || null) &&
          JSON.stringify(cur.alarms || null) === JSON.stringify(inc.alarms || null) &&
          JSON.stringify(cur.categories || null) === JSON.stringify(inc.categories || null) &&
          // 附件按 attKey 归一化比对（空数组 ≡ undefined）：服务端增删附件必须判得出
          // 「有变化」，否则本地一直用旧附件列表；删光的也不能每轮被拉回。
          attKey(cur.attachments) === attKey(inc.attachments) &&
          JSON.stringify(cur.exdates || null) === JSON.stringify(inc.exdates || null);
        if (same) {
          adoptRaw(cur, inc);
          // 服务端 etag 变了但受管字段没变（多端改了 DTSTAMP/ATTENDEE/ORGANIZER 等
          // 插件不管的字段、或服务器重算指纹）：必须把新 etag 回写，否则本地 etag 一直
          // 滞后，下一次编辑 PUT 带着旧 etag 发 If-Match，必被服务端 412、又按「服务端
          // 优先」把用户的改动静默丢掉（2026-10-19 雄哥实测：打勾完成即报「服务端已变更，
          // 本地改动已按策略丢弃」，根因就是这里漏了回写——单端不触发，多端/服务器重算才触发）。
          if (inc.etag && cur.etag !== inc.etag) {
            cur.etag = inc.etag;
            changed = true;
          }
          // 服务端 etag 变了但受管字段没变（多端改了 DTSTAMP/ATTENDEE/ORGANIZER 等
          // 插件不管的字段、或服务器重算指纹）：必须把新 etag 回写，否则本地 etag 一直
          // 滞后，下一次编辑 PUT 带着旧 etag 发 If-Match，必被服务端 412、又按「服务端
          // 优先」把用户的改动静默丢掉（2026-10-19 雄哥实测：打勾完成即报「服务端已变更，
          // 本地改动已按策略丢弃」，根因就是这里漏了回写——单端不触发，多端/服务器重算才触发）。
          continue;
        }
      }
      this.items.set(keyOf(inc), { ...inc, dirty: false, deleted: false });
      changed = true;
      applied++;
    }
    for (const key of deletedKeys) {
      if (this.items.has(key)) {
        this.items.delete(key);
        changed = true;
        removed++;
      }
    }
    // 清理标记 deleted 且已处理完的
    for (const [k, it] of Array.from(this.items.entries())) {
      if (it.deleted && !it.dirty) {
        this.items.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit();
    return { changed, removed, applied };
  }

  /** 记录一条即时推送成功的条目 key（按 key 去重，防「操作几次就报上传几次」） */
  markUploaded(key: string): void {
    if (!this.pendingUploadedKeys.includes(key)) this.pendingUploadedKeys.push(key);
  }

  /** 同 markUploaded，删除口径 */
  markDeleted(key: string): void {
    if (!this.pendingDeletedKeys.includes(key)) this.pendingDeletedKeys.push(key);
  }

  /** 待上传的脏条目 */
  dirtyItems(): CalItem[] {
    return this.getAll().filter((it) => it.dirty && !it.deleted);
  }

  /** 待删除 */
  deletedItems(): CalItem[] {
    return this.getAll().filter((it) => it.dirty && it.deleted);
  }

  isConfigured(): boolean {
    return !!this.settings.serverUrl && !!this.settings.username && this.settings.calendars.some((c) => c.enabled);
  }

  /** 手动通知订阅者（数据已被外部流程修改后） */
  notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** 修改 settings 后调用：持久化并通知订阅者 */
  saveSettings(): void {
    this.emit();
  }
}

export function keyOf(item: CalItem): string {
  // 主键只用 UID（重复实例覆盖多一段 recurId）。**刻意不含 kind**：日程↔待办互转
  // 会翻转 kind，若 kind 参与主键，转换保存就会变成「另立新条」，旧待办残留本地、
  // 新条目带着旧资源的 href/etag 上传，同步必然错乱（2026-10-23 雄哥实测）。
  // 同一日历集合内 UID 本就要求唯一（RFC 4791），「同 UID 一 VEVENT 一 VTODO」
  // 属非规范数据，撞键时后写者胜，可接受。
  return item.recurId ? `${item.uid}|${item.recurId}` : item.uid;
}
