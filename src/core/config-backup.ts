/**
 * 配置备份 —— 让「卸载后重装」不必重新配置服务器与日历。
 *
 * ## 为什么要这个
 *
 * Obsidian 卸载插件时会把 `.obsidian/plugins/caldav-calendar-tasks/` **整个目录**
 * 删掉，含 `data.json`。而 `data.json` 里存着服务器地址、用户名、日历列表、
 * 甚至加密后的密码 —— 全部一起丢。用户重装后面对的是一片空白设置页。
 *
 * Obsidian **没有** `onUninstall` 钩子（只有 `onunload`，且它是同步的、
 * 不保证在目录被删之后还能写盘），所以唯一的办法是：**趁 `data.json` 还在时，
 * 把配置另存一份到卸载删不到的地方**，重装时再问用户要不要恢复。
 *
 * ## 存哪：`.obsidian/caldav-calendar-tasks/backup.json`
 *
 * 卸载只删 `plugins/<id>/` 一个目录，`.obsidian/` 下别的东西都不动。
 * 选它而不是库根目录：① 不会被同步软件/网盘当笔记文件扫进去；② 不会被
 * Obsidian 的文件索引当成笔记；③ 位置固定、可预期。
 *
 * ## 存什么：settings + keyring，**不含 items**
 *
 * 条目数据（events/todos）不在这里 —— 它们体量大、且本来就能通过 CalDAV
 * 重新拉回来，备份它们只会让这个文件膨胀到几十 MB。真正会丢且捞不回来的
 * 是**配置**：服务器地址、日历集合、颜色、分类、提醒设置。
 *
 * ## 密码怎么办
 *
 * `settings.password` 在 `data.json` 里**本来就是密文**（`enc:v3:`，见
 * core/secret.ts），所以这里存的也永远是密文，**不会出现明文密码落盘**。
 * 同时把 `keyring`（主密钥，base64）一起存 —— 它本来就与密文同行存在
 * `data.json` 里（这是有意的：密钥随数据走才能多端解密），所以这不新增
 * 任何暴露面，恢复后密码直接可用。
 *
 * 但要注意一个**安全边界**：这个备份文件是明文 JSON，里面有 keyring，
 * 拿到它就等于拿到密码。它的保护级别应当与 `data.json` 相同 —— 都在
 * 用户的 `.obsidian/` 目录里、都可能被同步软件带走。若用户把 `.obsidian/`
 * 提交到公开仓库，那密码就等于公开了。这是既有设计（data.json 本来就这样），
 * 本模块不引入新风险，但也不该把备份推到更暴露的地方（所以不放库根目录）。
 *
 * @module core/config-backup
 */

import { normalizePath, type App } from "obsidian";
import { DEFAULT_SETTINGS, type CalSettings } from "./types";
import { isEncrypted } from "./secret";

/**
 * 备份文件在**库根下的相对路径**。
 *
 * ⚠️ 必须显式带上 `.obsidian/` 前缀。`app.vault.adapter` 的根是**库根目录**，
 * 不是 `.obsidian/` —— 传裸相对路径会落在 `<库根>/caldav-calendar-tasks/backup.json`，
 * 也就是库根下一个可见文件夹（会被文件索引当成笔记目录、被同步软件/网盘扫走）。
 * 这个错误在 0.4.6 真实发生过：路径与注释不符，备份写到了库根。
 */
export const BACKUP_DIR = ".obsidian/caldav-calendar-tasks";
export const BACKUP_FILE = "backup.json";

/** 备份文件的格式版本。改动结构时递增，旧版本按缺字段处理（不整体拒绝）。 */
export const BACKUP_VERSION = 1;

/** 备份文件名在库根下的完整相对路径（含 `.obsidian/` 前缀） */
export function backupPathOf(): string {
  return normalizePath(`${BACKUP_DIR}/${BACKUP_FILE}`);
}

/**
 * 备份文件的**绝对路径**（桌面端）。
 *
 * 存在的理由：写备份是「保险」，而保险最怕写到别处 —— 0.4.6 把裸相对路径交给
 * adapter，结果落在库根而非 `.obsidian/`，静默失效了一整天。所以这里先用
 * `getFullPath()` 拿到真实绝对路径并**验证它确实在 `.obsidian/` 里**，验证不过
 * 就不写。与其写错地方让人以为有备份，不如明确失败。
 *
 * 移动端 adapter 的 getFullPath 语义不一致（部分实现返回空串），故返回 undefined，
 * 由调用方退回 adapter 抽象。
 */
export function backupAbsPathOf(app: App): string | undefined {
  const adapter = app.vault.adapter as { getFullPath?: (p: string) => string };
  if (typeof adapter.getFullPath !== "function") return undefined;
  let abs: string;
  try {
    abs = adapter.getFullPath(backupPathOf());
  } catch {
    return undefined;
  }
  if (!abs) return undefined;
  const norm = abs.replace(/\\/g, "/");
  // 必须落在 .obsidian/ 内，且不是 plugins/ 的子路径（后者卸载时会被删）
  if (!/\/\.obsidian\//.test(norm)) return undefined;
  if (/\/\.obsidian\/plugins\//.test(norm)) return undefined;
  return abs;
}

/**
 * 备份文件里存的东西。
 *
 * 刻意**不含** items：条目可通过 CalDAV 重新拉取，备份它们只会让文件膨胀。
 */
export interface BackupPayload {
  /** 格式版本，用于将来改结构时平滑迁移 */
  v: number;
  /** 写入时刻（ISO 8601），只用于显示「这份备份是什么时候的」 */
  savedAt: string;
  /** 服务器地址、用户名、日历列表、分类、提醒设置等。password 在其中是**密文** */
  settings: CalSettings;
  /**
   * 凭据加密主密钥（base64）。没有它，备份里的密文解不开、等于没备份密码。
   * 与 `data.json` 的做法一致：密钥与密文同行，才能多端解密。
   */
  keyring?: string;
}

/** 判断一份解析结果是否像合法的备份（用于拒绝写坏的文件 / 他处的同名文件） */
function isBackupPayload(v: unknown): v is BackupPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Partial<BackupPayload>;
  return typeof o.v === "number" && !!o.settings && typeof o.settings === "object";
}

/**
 * 组装要写入的备份内容。
 *
 * 传入的 `settings` 必须已经是**磁盘形态**（密码为密文）—— 也就是
 * `CalStore.persist()` 交给 `saveData` 的那一份，不能是内存里的明文版本。
 * 这条是安全底线，由调用方保证；这里不做（也不该做）解密。
 */
export function buildBackup(settings: CalSettings, keyring: string | undefined): BackupPayload {
  return {
    v: BACKUP_VERSION,
    savedAt: new Date().toISOString(),
    settings: { ...settings },
    keyring: keyring || undefined
  };
}

/**
 * 写到磁盘（原子替换）。
 *
 * 原子性用「先写临时文件、再改名」实现：直接覆盖的话，中途断电/崩溃会留下
 * 半截 JSON，重装时用户就丢掉了唯一的备份 —— 这正是本模块要解决的问题，
 * 不能自己再制造一次。
 *
 * **空配置不写**（`isBackupUseful` 为假就返回）：新装后配置还没填时如果照样写，
 * 产出的备份既不能恢复什么，又会挡住将来真正的备份（读侧同样按可用性过滤，
 * 用户永远等不到提示）。宁可不写。
 */
export async function writeBackup(app: App, payload: BackupPayload): Promise<boolean> {
  if (!isBackupUseful(payload)) return false;
  const adapter = app.vault.adapter;
  const target = backupPathOf();
  // 取完整目录名（".obsidian/caldav-calendar-tasks"）。不能只取第一段 ——
  // 那样拿到的是已存在的 ".obsidian"，真正的备份子目录反而建不出来。
  const dir = target.slice(0, target.lastIndexOf("/"));
  const tmp = `${target}.tmp`;
  // 写之前验证落点。0.4.6 的事故正是「以为写进 .obsidian/、实际落在库根」：
  // adapter 的根是库根，路径少个前缀就静默写到别处，用户全程无感。
  // 验证不过宁可不写 —— 写错位置的备份比没有备份更危险，它会让人以为有保险。
  if (target !== normalizePath(`${BACKUP_DIR}/${BACKUP_FILE}`) || !target.startsWith(".obsidian/")) {
    return false;
  }
  if (backupAbsPathOf(app) === undefined) {
    // 拿不到绝对路径就无法验证（移动端 adapter 可能不支持）。此时退回按
    // adapter 抽象写，但仍要求上面的相对路径形状正确。
    if (!dir.startsWith(".obsidian/")) return false;
  }
  try {
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(tmp, JSON.stringify(payload, null, 2));
    // rename 在多数适配器上不支持覆盖，先删再改名（仍在 adapter 抽象内，跨端一致）
    if (await adapter.exists(target)) await adapter.remove(target);
    await adapter.rename(tmp, target);
    return true;
  } catch {
    // 备份是「保险」，失败绝不能影响正常配置流程 —— 吞掉并清掉半截临时文件
    void adapter.remove(tmp).catch(() => undefined);
    return false;
  }
}

/**
 * 读备份。
 *
 * 解析失败一律返回 undefined，**不抛** —— 用户手改坏这个文件、或跨设备时
 * 撞上别的插件的同名文件都很常见，不该因此让整个插件加载失败。
 */
export async function readBackup(app: App): Promise<BackupPayload | undefined> {
  const adapter = app.vault.adapter;
  const target = backupPathOf();
  try {
    if (!(await adapter.exists(target))) return undefined;
    const raw = await adapter.read(target);
    const parsed: unknown = JSON.parse(raw);
    return isBackupPayload(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 删掉备份。用户在恢复提示里点「不恢复」时调用 —— 否则每次重装都问一遍，
 * 问到最后变成噪音。
 */
export async function clearBackup(app: App): Promise<void> {
  const adapter = app.vault.adapter;
  try {
    const target = backupPathOf();
    if (await adapter.exists(target)) await adapter.remove(target);
  } catch {
    // 同 writeBackup：清不掉就算了，它只是不再被读到而已
  }
}

/**
 * 把备份合进当前设置。
 *
 * 返回新的 settings 对象，**不改传入的那个**（store 那边还要继续用）。
 *
 * 合并策略是「备份为底、当前为上」：`{...DEFAULT_SETTINGS, ...backup.settings}`。
 * 这样用户重装后即使默认值本身在两个版本间改过，也能拿到备份里的旧值，
 * 而不是被新版默认值覆盖掉。
 *
 * ⚠️ 这里必须**清掉每个日历的 syncToken**（2026-10-09 修复）。
 * sync-token 是服务端发的增量游标，语义是「服务端截至该时刻的全量，我本地
 * 已经全都有了」；而备份**故意不含 items**（只存 settings + keyring，见 writeBackup
 * 的取舍说明）—— 于是恢复出来的状态自相矛盾：拿着「本地全都有」的凭证，本地却是空的。
 * 后果不是报错而是**静默空白**：增量拉取如实返回 0 条，日历空的，且不会自愈
 * （只要服务端没再变动，那个 token 就一直有效）。
 *
 * 在这里清（而不是只在 onRestore 里清）是因为这是恢复的唯一漏斗 ——
 * 将来若再加「从文件导入配置」之类的入口，自动就带上这个修正。
 * 双保险还有 core/sync.ts 里的「本地空则忽略 token」通用护栏。
 */
export function mergeBackupSettings(backup: BackupPayload): CalSettings {
  const merged: CalSettings = { ...DEFAULT_SETTINGS, ...backup.settings };
  // 日历数组要**新建**，不能就地改：merged.calendars 与 backup.settings.calendars
  // 是同一个数组引用，就地清token 会把调用方（读备份做展示的那侧）的对象也改掉。
  merged.calendars = (merged.calendars || []).map((c) => ({ ...c, syncToken: undefined }));
  return merged;
}

/**
 * 备份里有没有可恢复的实质内容（只有一个空服务器地址的备份不值得打扰用户）。
 *
 * ⚠️ 存了密文却没存keyring 的备份，**不算可用**（2026-10-09 修复）。
 * 判据是「密码字段与 keyring 必须成对」：
 * 备份里的 password 是 `enc:v3:` 密文，没有配套主密钥就解不开，恢复后
 * 表现为「服务器地址有了、一同步就报密码解不开」—— 用户看到的现象像是
 * 密码记错了，实际上整份备份里的密码部分都是死的。
 * 这种情况宁可判为不可用、让用户重新填密码（一次输入即换新本机密钥，
 * 之后自动备份就完整了），也别让一份半死的备份躺在那儿冒充保险。
 *
 * 顺带兼容 v1/v2 密文：它们的密钥是从设备标识派生的，不依赖 keyring 字段，
 * 所以只在遇到 **v3** 密文时才要求 keyring。
 */
export function isBackupUseful(b: BackupPayload): boolean {
  if (!(b.settings?.serverUrl || (b.settings?.calendars || []).length)) return false;
  // v3 密文必须配keyring，否则密码解不开（v1/v2 用设备派生密钥，不在此列）
  const pw = b.settings?.password || "";
  if (pw.startsWith("enc:v3:") && !(b.keyring || "").trim()) return false;
  return true;
}

/**
 * 人类可读的一行摘要，给恢复提示用。
 * 例如「Bonebear 的 CalDAV（2 个日历）」。
 */
export function describeBackup(b: BackupPayload): string {
  const n = (b.settings?.calendars || []).length;
  const host = safeHost(b.settings?.serverUrl || "");
  const cals = n ? ` · ${n} 个日历` : "";
  return `${host || "（未设置服务器）"}${cals}`;
}

function safeHost(url: string): string {
  const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url);
  return m ? m[1] : url.slice(0, 40);
}

/**
 * 判断这是不是「刚装上」——`data.json` 为空（loadData 返回空/无 settings）。
 *
 * 必须是"空"而不是"文件不存在"：Obsidian 的 `loadData()` 在文件缺失时返回
 * `null`，但某些情况下会返回 `{}`，两者都算新装。
 */
export function looksFreshInstall(loaded: unknown): boolean {
  if (loaded === null || loaded === undefined) return true;
  if (typeof loaded !== "object") return true;
  const o = loaded as { settings?: unknown };
  // 有 settings 且带服务器地址 → 明确是老装，直接走正常路径
  if (o.settings && typeof o.settings === "object") {
    return !(o.settings as { serverUrl?: string }).serverUrl;
  }
  return true;
}

/**
 * 备份的时间戳能否解析。
 *
 * 用在恢复提示上：解析不了就不展示时间（显示「某个时间」）而不是 `Invalid Date`
 * 那种字符串。这只是展示层的判断，不影响恢复逻辑本身。
 */
export function backupTimeText(b: BackupPayload, fallback: string): string {
  const ms = Date.parse(b.savedAt || "");
  if (Number.isNaN(ms)) return fallback;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? fallback : d.toLocaleString();
}

/**
 * 写入前的一致性检查：备份里的密码若是**明文**（旧版本遗留、或用户手写过），
 * 直接落盘就是安全事故。这里作为最后一道闸 —— 返回 true 表示需要拒绝。
 *
 * 判据直接复用 core/secret.ts 的 `isEncrypted`（它认 v1/v2/v3 三个前缀），
 * 不自己写正则 —— 免得 secret.ts 将来加 v4 时这里漏掉、变成形同虚设的检查。
 */
export function hasPlaintextPassword(b: BackupPayload): boolean {
  const p = b.settings?.password || "";
  return !!p && !isEncrypted(p);
}

/** 供测试与调试：把备份内容读成可比较的普通对象（去掉时间戳） */
export function stableForCompare(b: BackupPayload): Omit<BackupPayload, "savedAt"> {
  const { savedAt: _savedAt, ...rest } = b;
  void _savedAt;
  return rest;
}
