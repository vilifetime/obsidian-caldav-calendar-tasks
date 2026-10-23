/**
 * 极简 CalDAV 客户端：发现 / 拉取 / 上传 / 删除 / sync-token 增量
 */
import type { CalCalendar, CalItem } from "./types";
import { httpRequest, HttpError, isNetworkLevelError, uploadTimeoutMs, type HttpResult, type Channel } from "./http";
import { itemsFromICS, ICS_SIZE_MAX_MB, mbToBytes, parseAttachLine } from "./ics";
import { t } from "../i18n";

export interface DavAuth {
  username: string;
  password: string;
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/** 从服务端返回的 URL / href 归一化为绝对地址 */
export function toAbsolute(base: string, href: string): string {
  try {
    return new URL(href, base.endsWith("/") ? base : base + "/").toString();
  } catch {
    return joinUrl(base, href);
  }
}

async function dav(
  url: string,
  method: string,
  body: string,
  channel: Channel,
  auth: DavAuth,
  depth = "0",
  extraHeaders: Record<string, string> = {}
): Promise<HttpResult> {
  return httpRequest(
    url,
    {
      method,
      body,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: depth,
        ...extraHeaders
      },
      timeoutMs: 30000
    },
    channel,
    auth
  );
}

function pickHrefXml(xml: string): string[] {
  // 不做完整 XML 解析，提取 <D:href> / <href>（CalDAV 服务端响应结构固定）
  // ⚠️ 必须允许 href 带属性：iCloud 等服务器会写成 <href xmlns="DAV:">…</href>，
  // 原写法 `<(?:...:)?href>` 要求 href 后紧跟 `>`，匹配不到带 xmlns 属性的标签，
  // 导致 principal / 同步拉取时的 href 抽取为空（2026-10-21 实测：iCloud 发现日历
  // 报「无法定位 principal」正是此因 —— current-user-principal 内的 <href xmlns="DAV:">
  // 被漏掉）。
  const out: string[] = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

/**
 * 临时诊断：发现/同步链路失败时把真实 HTTP 响应（URL + status + body）追加到
 * D:/Temp/caldav-debug.txt，便于在没有凭据的情况下定位「服务器到底回了什么」。
 * 仅在桌面端（Electron 提供 globalThis.require）生效；其它环境静默跳过。
 * TODO(临时): 确认 iCloud 修复后删除本函数及其三处调用。
 */
function debugDump(label: string, url: string, status: number, body: string, headers?: Record<string, string>): void {
  try {
    const g: any = globalThis;
    const fs = g.require?.("fs");
    if (!fs) return;
    try { fs.mkdirSync("D:/Temp", { recursive: true }); } catch { /* 已存在 */ }
    const hdr = headers
      ? "\nHEADERS:\n" + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n")
      : "";
    const line = `\n===== ${label} =====\nURL: ${url}\nSTATUS: ${status}${hdr}\nBODY:\n${body}\n`;
    fs.appendFileSync("D:/Temp/caldav-debug.txt", line);
  } catch { /* 诊断失败不影响主流程 */ }
}

/** 取响应头里的 ETag（小写归一化后） */
function etagOf(res: HttpResult): string | undefined {
  const v = (res.headers["etag"] || "").replace(/^"|"$/g, "").trim();
  return v || undefined;
}

/**
 * 从 iCalendar 文本（可能含 RFC 5545 折行）解析出**所有**托管附件条目。
 *
 * MANAGED-ID 形态两种都要认：
 *   `ATTACH;MANAGED-ID="abc":https://…`（带引号，RFC 5545 参数值含 `:`/`/` 时规范要求）
 *   `ATTACH;MANAGED-ID=abc:https://…`（裸写）
 * 先展开折行（续行并入上一行），否则长 URI 会被截断。
 */
export function parseAllManagedAttach(body: string): { uri: string; managedId: string }[] {
  if (!body) return [];
  const ics = body.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const out: { uri: string; managedId: string }[] = [];
  for (const line of ics.split(/\r\n|\n/)) {
    if (!/^ATTACH[;:]/i.test(line)) continue;
    const parsed = parseAttachLine(line);
    const managedId = parsed?.params["MANAGED-ID"]?.trim();
    if (parsed && managedId && parsed.value) out.push({ uri: parsed.value, managedId });
  }
  return out;
}

/**
 * Apple 附件文件名禁令（2026-10-23 真机实测）：文件名含 `\ / : * ? " |` 时
 * POST ?action=attachment-add 直接回 **400**。上传前把这些字符换掉，
 * 本地 attachments[].name 保持用户原文件名不动（下载/显示用本地的）。
 */
function sanitizeIcloudFilename(name: string): string {
  return (name || "attachment")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"|]/g, "_");
}

/**
 * attachment-add 请求的 Content-Disposition 头值。
 *
 * ⚠️ 2026-10-23 雄哥实测（Obsidian 桌面端，中文名附件「南坞古道.jpg」）：
 * HTTP 头值只收 Latin-1 域字符（\t \x20-\x7e \x80-\xff），中文裸写进去，
 * Node http 直接抛 `Invalid character in header content ["Content-Disposition"]`
 * ——请求都发不出去，同步红字。所以非 ASCII 名不能裸写进头：
 *  - 纯 ASCII 名 → RFC 8607 §3.4 标准形态 `filename="x.jpg"`；
 *  - 含非 ASCII → RFC 5987/6266 的 `filename*=UTF-8''%E5…`（头值纯 ASCII，
 *    任何传输层都吃得下）。iCloud 不解析 RFC 5987、会把 `UTF-8''…` 字面量
 *    存进服务端 FILENAME（真机实测），本地由 ics.ts recoverServerFilename()
 *    还原；界面显示/下载/ICS 序列化一概用本地名，不受影响。
 */
export function icloudContentDisposition(name: string): string {
  const safe = sanitizeIcloudFilename(name);
  if (!/[^\x20-\x7e]/.test(safe)) return `attachment; filename="${safe}"`;
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * 判断「回 GET 到的 ICS 里的 URI」与「POST 回应的 location 头」是否指向同一个托管附件。
 *
 * ⚠️ 2026-10-23 01:23 雄哥真机 dump（服务端积了 9 条托管附件那次）：**location 头比
 * ICS 里的 URI 少尾部 token 段**——
 *   location: https://gateway.icloud.com/…/attach/4_XXX/UTF-8%27%27%25E5….jpg
 *   ICS URI:  https://gateway.icloud.com/…/attach/4_XXX/UTF-8%27%27%25E5….jpg/YXR0YWNoYXR0YWNoYXR0YQ…
 * （缺了签名段，location 直接去 GET 会 400。）但 `/attach/<上传次号>/<文件名>` 基名每次
 * 上传唯一，按「互为前缀」判同一附件即可；精确相等、百分号解码后相等都兜底。
 * 写成精确相等会永远不命中——location 优先认领失效，又掉回扣减法被积压歧义判死
 * （雄哥 01:23 报的「无法确认托管信息」就是这条）。
 */
function sameIcloudAttachmentUri(icsUri: string, locationUri: string): boolean {
  if (!icsUri || !locationUri) return false;
  if (icsUri === locationUri) return true;
  if (icsUri.startsWith(locationUri) || locationUri.startsWith(icsUri)) return true;
  try {
    const a = decodeURIComponent(icsUri);
    const b = decodeURIComponent(locationUri);
    return a === b || a.startsWith(b) || b.startsWith(a);
  } catch {
    return false;
  }
}

/**
 * POST attachment-add 之后，回 GET 资源本体，从新鲜 ICS 里认出「我们刚传的那个」托管附件。
 *
 * 为什么需要这一步（2026-10-22 雄哥在思源端实测）：iCloud 对 attachment-add 返回
 * **HTTP 200 但响应体为空**——RFC 8607 要求响应体带更新后的日历对象资源，iCloud 没给。
 * 上传其实成功了（再 GET 资源，托管 ATTACH 已在里面），只是本地拿不到托管信息。
 *
 * 「哪个是新传的」两级认领：
 *  ① **location 头优先**：POST 响应给了 `location: <附件规范URI>`。⚠️ 它与回 GET 到的
 *     ICS 里本次那条 ATTACH 的 URI **不是全等——location 缺尾部 token 段**（2026-10-23
 *     01:23 真机 dump：location 到文件名结尾，ICS URI 后面还拖一截
 *     `/YXR0YWNoYXR0YWNoYXR0YQ…`；缺签名段，location 直接 GET 会 400）。判「同一个
 *     附件」走 sameIcloudAttachmentUri（互为前缀 + 解码兜底）。这是服务端权威指向——
 *     资源上积了历史托管附件（认领失败→不 PUT→越积越多）时扣减法会歧义，location 不受影响。
 *  ② 扣减法兜底：传入上传前就已托管的 MANAGED-ID 集合，GET 回来的全量托管条目扣掉
 *     它们，剩下唯一一个就是本次的。多于一个说明并发改动，不猜，让上层失败重试
 *     （猜错＝把别人的附件 URI 挂到本条目上）。
 *
 * 顺带解决一个隐藏坑：attachment-add 会改变服务端资源的 etag，响应体的 ETag 头
 * iCloud 也不给（空 body），只能从这里拿新 etag——后续 PUT 带旧 etag 必 412。
 *
 * @param locationUri POST 响应 location 头的值（没有则空串，直接走扣减法）
 */
async function fetchFreshManagedAttach(
  href: string,
  known: Set<string>,
  channel: Channel,
  auth: DavAuth,
  locationUri = ""
): Promise<{ uri: string; managedId: string; etag?: string } | null> {
  const res = await httpRequest(href, { method: "GET" }, channel, auth);
  if (res.status >= 400) return null;
  const all = parseAllManagedAttach(res.body);
  // ① location 命中：服务端指着说这就是刚传的那个，历史积压再多也不歧义
  if (locationUri) {
    const hit = all.find((a) => sameIcloudAttachmentUri(a.uri, locationUri));
    if (hit) return { ...hit, etag: etagOf(res) };
  }
  // ② 扣减法：恰好一条未知才算认领
  const fresh = all.filter((a) => !known.has(a.managedId));
  if (fresh.length !== 1) return null;
  return { ...fresh[0], etag: etagOf(res) };
}

function pickTextXml(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}[^>]*>([^<]*)</(?:[A-Za-z0-9_-]+:)?${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export interface DiscoverResult {
  principal?: string;
  home?: string;
  calendars: CalCalendar[];
}

const COLORS = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];

/** 自动发现：principal -> calendar-home -> 日历集合列表 */
export async function discoverCalendars(
  serverUrl: string,
  channel: Channel,
  auth: DavAuth,
  hintPath = ""
): Promise<DiscoverResult> {
  const base = serverUrl.endsWith("/") ? serverUrl : serverUrl + "/";
  let home = hintPath ? toAbsolute(base, hintPath) : "";

  // 1. current-user-principal（有 hint 时跳过）
  let principal = "";
  if (!home) {
    const res = await dav(
      base,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`,
      channel,
      auth
    );
    if (res.status === 401) throw new HttpError(401, t("net.authFailed401Short"));
    if (res.status >= 400) throw new HttpError(res.status, t("net.discoverPrincipalFailed", { status: res.status }));
    const hrefs = pickHrefXml(res.body);
    const cur = /<(?:[A-Za-z0-9_-]+:)?current-user-principal[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?current-user-principal>/.exec(res.body);
    if (cur) {
      const inner = pickHrefXml(cur[1]);
      principal = inner[0] || "";
    } else if (hrefs.length) {
      principal = hrefs[0];
    }
    if (!principal) {
      debugDump("principal", base, res.status, res.body);
      const snippet = (res.body || "(空响应体)").slice(0, 500);
      throw new HttpError(res.status, `${t("net.principalNotFound")}（HTTP ${res.status}；响应前500字：\n${snippet}）`);
    }
    home = toAbsolute(base, principal);
  }

  // 2. calendar-home-set
  const homeRes = await dav(
    home,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><D:prop><c:calendar-home-set/></D:prop></D:propfind>`,
    channel,
    auth
  );
  if (homeRes.status < 400) {
    const cur = /<(?:[A-Za-z0-9_-]+:)?calendar-home-set[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?calendar-home-set>/.exec(homeRes.body);
    const inner = cur ? pickHrefXml(cur[1]) : [];
    if (inner[0]) home = toAbsolute(base, inner[0]);
  }

  // 3. 枚举日历集合（Depth 1）
  const listRes = await dav(
    home,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="urn:ietf:params:xml:ns:caldav-extensions"><D:prop><D:resourcetype/><D:displayname/><cs:getctag/><a:calendar-color/><D:current-user-privilege-set/></D:prop></D:propfind>`,
    channel,
    auth,
    "1"
  );
  if (listRes.status >= 400) {
    debugDump("listCalendars", home, listRes.status, listRes.body);
    throw new HttpError(listRes.status, t("net.listCalendarsFailed", { status: listRes.status }));
  }

  const calendars: CalCalendar[] = [];
  // 按 <response> 分块。注意：iCloud 等服务器给 <response> 加了 xmlns 属性
  // （<response xmlns="DAV:">），原写法 `<response>` 要求 > 紧跟 response，匹配不到带
  // 属性的标签，会导致整个返回没被切开、发现 0 个日历。改用 \b[^>]*> 允许属性。
  const chunks = listRes.body.split(/<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>/i).slice(1);
  let colorIdx = 0;
  for (const chunk of chunks) {
    const href = pickHrefXml(chunk)[0];
    if (!href) continue;
    // 资源类型必须含 <calendar> 才算日历集合。iCloud 等服务器会给 <calendar> 加
    // xmlns 属性：<calendar xmlns="urn:ietf:params:xml:ns:caldav"/>，原写法
    // `<calendar\s*\/?>` 匹配不到带属性的写法，导致 iCloud 发现 0 个日历。
    // (?![\w-]) 用于排除 <calendar-color> 等属性元素的误匹配。
    if (!/<(?:[A-Za-z0-9_-]+:)?calendar(?![\w-])[^>]*>/.test(chunk)) continue;
    const names = pickTextXml(chunk, "displayname");
    const name = (names[0] || decodeURIComponent(href.replace(/\/+$/, "").split("/").pop() || "")).trim();
    const colorM = /<(?:[A-Za-z0-9_-]+:)?calendar-color[^>]*>([^<]*)</.exec(chunk);
    let color = colorM ? colorM[1].trim() : "";
    if (/^#[0-9a-fA-F]{8}$/.test(color)) color = color.slice(0, 7);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = COLORS[colorIdx++ % COLORS.length];
    const supported = pickHrefXml(chunk); // 无用，占位
    void supported;
    const compM = chunk.match(/<(?:[A-Za-z0-9_-]+:)?comp[^>]*name="(VEVENT|VTODO)"/g);
    let supportsEvent = true;
    let supportsTodo = true;
    if (compM && compM.length) {
      const set = new Set(compM.map((c) => /name="(VEVENT|VTODO)"/.exec(c)![1]));
      supportsEvent = set.has("VEVENT");
      supportsTodo = set.has("VTODO");
      if (!set.size) { supportsEvent = true; supportsTodo = true; }
    }
    const url = toAbsolute(base, href);
    const desc = pickTextXml(chunk, "description")[0] || "";
    calendars.push({
      url,
      displayName: name || t("net.defaultCalName"),
      eventColor: color,
      todoColor: color,
      enabled: true,
      supportsEvent,
      supportsTodo,
      description: desc
    });
  }
  return { principal: principal || undefined, home, calendars };
}

/** 全量拉取一个日历（calendar-query 时间窗） */
export async function fetchCalendarItems(
  cal: CalCalendar,
  channel: Channel,
  auth: DavAuth,
  rangeStartIsoUtc: string,
  rangeEndIsoUtc: string
): Promise<{ items: CalItem[]; syncToken?: string }> {
  // RFC 4791：同一层 comp-filter 为 AND 语义，VEVENT 与 VTODO 必须分两次查询
  const kindFilters: string[] = [];
  if (cal.supportsEvent !== false) {
    kindFilters.push(`<c:comp-filter name="VEVENT"><c:time-range start="${rangeStartIsoUtc}" end="${rangeEndIsoUtc}"/></c:comp-filter>`);
  }
  if (cal.supportsTodo) {
    kindFilters.push(`<c:comp-filter name="VTODO"/>`);
  }
  const items: CalItem[] = [];
  for (const compFilter of kindFilters) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><c:calendar-data/></D:prop>
  <c:filter><c:comp-filter name="VCALENDAR">${compFilter}</c:comp-filter></c:filter>
</c:calendar-query>`;
    const res = await dav(cal.url, "REPORT", body, channel, auth, "1");
    if (res.status >= 400) throw new HttpError(res.status, t("net.queryFailed", { status: res.status }));
    items.push(...parseMultistatus(res.body, cal));
  }
  return { items, syncToken: undefined };
}

/**
 * 取 URL / href 的文件名。
 *
 * 对账时必须拿它比：服务端 PROPFIND 回的多半是**路径**（`/dav/cal/x.ics`），
 * 而本地存的是**完整 URL**（`http://host/dav/cal/x.ics`），直接比字符串永远不等。
 * 同一个日历集合内文件名唯一，比 basename 最稳（也顺手吃掉 %40 之类的转义差异）。
 */
export function fileNameOf(url: string): string {
  // 先切 basename 再解码：畸形转义（如 "%E0%A4%A"）时退回**未解码的 basename**，
  // 而不是整条 URL —— 否则同一条资源在两处算出的名字不一致，对账会误判。
  const raw = String(url || "").split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 列出日历集合下**所有**资源的文件名（PROPFIND Depth:1，只取 href 不取正文）。
 *
 * 用途：同步后的「幽灵条目对账」（见 sync.ts 的 reconcile）——
 * 本地记着 etag 却被服务端删掉的条目，**不会被任何增量查询报出来**
 * （deletedHrefs 只在增量路径产出，sync-token 失效回退全量时恒为空）。
 * 这里直接要一份完整清单来比对，与 sync-token / time-range 都无关。
 */
export async function listResourceNames(cal: CalCalendar, channel: Channel, auth: DavAuth): Promise<string[]> {
  const res = await httpRequest(
    cal.url,
    {
      method: "PROPFIND",
      headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "1" },
      body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>`,
      timeoutMs: 20000
    },
    channel,
    auth
  );
  if (res.status >= 400) throw new HttpError(res.status, t("net.listResourcesFailed", { status: res.status }));
  return [...res.body.matchAll(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]*)</g)]
    .map((m) => fileNameOf(m[1]))
    .filter((n) => /\.ics$/i.test(n));
}

/** sync-token 增量拉取：返回 变更条目 + 已删除 href */
export async function syncCollection(
  cal: CalCalendar,
  channel: Channel,
  auth: DavAuth,
  syncToken: string
): Promise<{ items: CalItem[]; deletedHrefs: string[]; syncToken?: string }> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>${syncToken}</D:sync-token>
  <D:sync-level>1</D:sync-level>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;
  const res = await dav(cal.url, "REPORT", body, channel, auth, "1");
  if (res.status >= 400) throw new HttpError(res.status, t("net.incrementalFailed", { status: res.status }));
  const tokenM = /<(?:[A-Za-z0-9_-]+:)?sync-token[^>]*>([^<]*)</.exec(res.body);
  const deletedHrefs: string[] = [];
  const chunks = res.body.split(/<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>/i).slice(1);
  const changed: string[] = [];
  for (const chunk of chunks) {
    const href = pickHrefXml(chunk)[0] || "";
    const status = pickTextXml(chunk, "status")[0] || "";
    if (/404/.test(status) || /<deleted|status>HTTP[^<]*404/.test(chunk)) deletedHrefs.push(href);
    else changed.push(href);
  }
  let items: CalItem[] = [];
  if (changed.length) {
    items = await multiget(cal, channel, auth, changed);
  }
  return { items, deletedHrefs, syncToken: tokenM ? tokenM[1].trim() : undefined };
}

/** calendar-multiget 精确取回 ICS 数据 */
async function multiget(cal: CalCalendar, channel: Channel, auth: DavAuth, hrefs: string[]): Promise<CalItem[]> {
  const base = cal.url;
  const items: CalItem[] = [];
  // 分批 50 个
  for (let i = 0; i < hrefs.length; i += 50) {
    const batch = hrefs.slice(i, i + 50);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><c:calendar-data/></D:prop>
  ${batch.map((h) => `<D:href>${escapeXml(h)}</D:href>`).join("\n  ")}
</c:calendar-multiget>`;
    const res = await dav(base, "REPORT", body, channel, auth, "1");
    if (res.status >= 400) throw new HttpError(res.status, t("net.multigetFailed", { status: res.status }));
    items.push(...parseMultistatus(res.body, cal));
  }
  return items;
}

export function parseMultistatus(xml: string, cal: CalCalendar): CalItem[] {
  const items: CalItem[] = [];
  const chunks = xml.split(/<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>/i).slice(1);
  for (const chunk of chunks) {
    const href = unescapeXml(pickHrefXml(chunk)[0] || "");
    // 服务端（Baïkal/sabre）的 getetag 以 XML 转义形态返回：&quot;xxxx&quot;，
    // 必须先反解码成 "xxxx" 再剥引号；否则本地 etag 残留 &quot;，发出
    // If-Match: ""&quot;xxxx&quot;"" 会让所有条件 PUT/DELETE 返回 412（长期固有 bug）。
    const etag = sanitizeEtag(pickTextXml(chunk, "getetag")[0] || "");
    const calDataM = /<(?:[A-Za-z0-9_-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?calendar-data>/i.exec(chunk);
    if (!href || !calDataM) continue;
    // 同 SiYuan：iCloud 在 calendar-data 外包 <![CDATA[ ]]>，必须剥离，否则 item.raw
    // 被污染 → itemToEditedICS 误吐裸组件 → PUT 被 iCloud 判 HTTP 400（2026-10-23 根因）。
    const ics = unescapeXml(stripCdata(calDataM[1]));
    items.push(...itemsFromICS(ics, cal.url, toAbsolute(cal.url, href), etag));
  }
  return items;
}

/** 若整段被 <![CDATA[ ... ]]> 包裹则取其中文本，否则原样返回（iCloud 实测会在 calendar-data 外包 CDATA）。 */
function stripCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}

function unescapeXml(s: string): string {
  // 顺序很关键：&amp; 必须最后替换，否则 &amp;lt; 会先变 &lt; 再变 <。
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** 还原 etag 的 XML 转义并剥掉 DAV 引用字符串的引号，得到纯 hex（与 putItem 响应头一致）。 */
export function sanitizeEtag(etag: string): string {
  return unescapeXml(etag).replace(/^"|"$/g, "");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface PutResult {
  etag?: string;
}

/** 上传/修改条目；etag 提供 If-Match */
export async function putItem(
  item: CalItem,
  ics: string,
  channel: Channel,
  auth: DavAuth,
  icsSizeMaxMB?: number
): Promise<PutResult> {
  // 超大直接拒，请求都不发（2026-10-20 第二批从思源侧同构移植）。
  // Radicale 默认 max_resource_size=10MB、PHP 默认 post_max_size=8MB，超了必然 413。
  // 放进去的结果只有一个：这个条目永远同步不过，而且每次重试都把整份 ICS 再推一遍，
  // 报出来还是含糊的「网络请求失败」——把用户往错方向引（2026-10-15 实测）。
  const icsBytes = new TextEncoder().encode(ics).length;
  const maxMB =
    typeof icsSizeMaxMB === "number" && Number.isFinite(icsSizeMaxMB) && icsSizeMaxMB > 0 ? icsSizeMaxMB : ICS_SIZE_MAX_MB;
  const maxBytes = mbToBytes(maxMB, ICS_SIZE_MAX_MB);
  if (icsBytes > maxBytes) {
    throw new HttpError(413, t("net.icsTooLarge", { size: (icsBytes / 1024 / 1024).toFixed(1), max: maxMB }));
  }
  const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
  if (item.etag) headers["If-Match"] = `"${item.etag}"`;
  // 超时按 ICS 实际字节数放宽：附件是 base64 内联的，5MB 图片 → ICS 约 7MB，
  // 家庭宽带上行传完要一分多钟，固定 30s 必然超时（2026-10-15 实测卡死）。
  const res = await httpRequest(item.href, { method: "PUT", body: ics, headers, timeoutMs: uploadTimeoutMs(icsBytes) }, channel, auth);
  if (res.status === 412) throw new HttpError(412, t("net.serverChanged412"));
  if (res.status === 413) {
    // 别把插件的设置值说成「服务器默认」：真实上限各不相同——nginx 反代常见
    // 默认仅 1MB（client_max_body_size），Radicale 默认 10MB，PHP 默认 8MB。
    // 2026-10-18 雄哥的 Baïkal 前有 nginx，413 就来自反代而非 CalDAV 服务器。
    throw new HttpError(413, t("net.tooLarge413"));
  }
  if (res.status >= 400) {
    // 507 Insufficient Storage：iCloud 等对内联 base64 附件说不的服务器会返回它；
    // 也可能真是 iCloud 账户存储满了。两种情况都给出可读提示，不再只甩一个状态码。
    if (res.status === 507) throw new HttpError(507, t("net.putFailed507"));
    // 诊断落盘（2026-10-23 雄哥实测过一次无法复现的 PUT 400：同一份 ICS/etag 换通道
    // 就能 204，缺响应体只能瞎猜）。412/413 在上面已分别处理，到这里的是真异常。
    debugDump("icloud-put-item", `${item.href} (If-Match: ${item.etag || "无"})`, res.status, res.body, res.headers);
    throw new HttpError(res.status, t("net.putFailed", { status: res.status }));
  }
  const etag = (res.headers["etag"] || res.headers["etag".toLowerCase()] || "").replace(/^"|"$/g, "");
  return { etag: etag || undefined };
}

/**
 * iCloud 托管附件上传（RFC 8607 managed attachments）。
 *
 * 对**已存在**的日历对象资源 POST 原始二进制，服务器把附件存进 iCloud 专用存储，
 * 回写带 `MANAGED-ID` 的 `ATTACH` 行。这样 ICS 里只留托管 URI、不再内联 base64，
 * 正好绕开内联附件会被拒（507）的问题，实现「iCloud 待办直接传文件」。
 *
 *   POST <item.href>?action=attachment-add
 *   Content-Type: <mime>
 *   Content-Disposition: attachment; filename="<name>"（非 ASCII 名走 filename*=UTF-8''…，见 icloudContentDisposition）
 *   body: <raw bytes>
 *
 * ⚠️ iCloud 跨域 301：`caldav.icloud.com` → `pN-caldav.icloud.com`。本插件桌面端
 * 走 `node-https-transport`，自行跟随重定向并**保留 Authorization**（见该文件顶部注释），
 * 故 POST 二进制能完整走通；移动端（requestUrl）跨域重定向会剥头，仍受限于填节点完整路径。
 *
 * 响应体是更新后的 iCalendar 文本，解析出其中的 `ATTACH;MANAGED-ID=<id>:<uri>` 返回。
 */
/**
 * 把单个文件 POST 进 iCloud 的托管附件存储（RFC 8607 managed attachments）。
 *
 * 服务端把文件收进专用存储。RFC 8607 说响应体是更新后的 iCalendar、附件改写为
 * `ATTACH;MANAGED-ID=<id>:<uri>`；**但 iCloud 实测返回 200 空 body**，所以响应体
 * 解析不到时回 GET 资源本体补拿托管信息 + 新 etag（见 fetchFreshManagedAttach：
 * 优先用 POST 响应的 `location` 头认领，扣减法兜底）。
 * 本地只留托管 URI + ID，ICS 不再内联二进制。
 *
 * @param knownManagedIds 上传前该条目已托管的 MANAGED-ID（回 GET 时用来扣减出「新传的那个」）
 * @returns 托管 URI + MANAGED-ID；若经过回 GET，还带服务端新 etag（调用方必须更新 item.etag）
 */
export async function uploadIcloudAttachment(
  item: CalItem,
  bytes: Uint8Array,
  name: string,
  mime: string,
  channel: Channel,
  auth: DavAuth,
  knownManagedIds: string[] = []
): Promise<{ uri: string; managedId: string; etag?: string }> {
  if (!item.href) throw new HttpError(400, t("net.attachNoHref"));
  // ⚠️ 动作名是 attachment-add 不是 add-attachment（RFC 8607 §3.3.1）。
  //    2026-10-23 实测：写错时 iCloud 把未知动作当空操作——回 200 空 body、
  //    资源 etag 都不变，表现为「上传成功但解析不到托管信息」的假失败。
  const url = item.href + "?action=attachment-add";
  const headers: Record<string, string> = {
    "Content-Type": mime || "application/octet-stream",
    // RFC 8607 §3.4：SHOULD 带 filename（iPhone 上显示的名字）。
    // ⚠️ 2026-10-23 实测两件事：① Apple 拒收文件名含 \ / : * ? " | 的附件（400），
    //    先替换；② HTTP 头只收 Latin-1 域字符，中文名裸写会被 Node 抛
    //    `Invalid character in header content`——统一走 icloudContentDisposition，
    //    非 ASCII 名改送 filename*=UTF-8''…，服务端存的字面量由 recoverServerFilename 还原。
    "Content-Disposition": icloudContentDisposition(name),
    // RFC 8607：带了它服务器 SHOULD 在响应体回更新后的资源（省一次 GET）。
    // iCloud 无视（恒空 body），但对规范服务器有益，无害。
    Prefer: "return=representation"
  };
  const res = await httpRequest(
    url,
    { method: "POST", body: bytes, headers, timeoutMs: uploadTimeoutMs(bytes.length) },
    channel,
    auth
  );
  if (res.status >= 400) {
    if (res.status === 507) throw new HttpError(507, t("net.putFailed507"));
    debugDump("icloud-add-attachment", url, res.status, res.body, res.headers);
    throw new HttpError(res.status, t("net.attachUploadFailed", { status: res.status }));
  }
  // ① 响应体带托管信息（RFC 8607 标准形态）→ 直接用；ETag 头有就一起拿
  const parsed = parseManagedAttach(res.body);
  if (parsed) return { ...parsed, etag: etagOf(res) };
  // ② iCloud 形态：200 空 body。上传已成功，回 GET 资源本体认领托管附件 + 新 etag。
  //    location 头是服务端权威指向（与 ICS 里本次 ATTACH 的 URI 同基名——它缺尾部 token 段，
  //    2026-10-23 01:23 真机实测；匹配走 sameIcloudAttachmentUri），带上它认领——资源上有
  //    历史积压附件时扣减法会歧义（2026-10-23 00:55 雄哥实测踩坑）。
  const location = (res.headers["location"] || res.headers["Location"] || "").trim();
  const fresh = await fetchFreshManagedAttach(item.href, new Set(knownManagedIds), channel, auth, location);
  if (fresh) return fresh;
  // ③ GET 也认不出（真出事：上传没落上 / 服务端异常）→ dump 两份现场让人能贴回来定位
  const getDump = await httpRequest(item.href, { method: "GET" }, channel, auth).catch(() => null);
  debugDump("icloud-add-attachment-parse", url, res.status, res.body, res.headers);
  if (getDump) {
    debugDump("icloud-add-attachment-get-fallback", item.href, getDump.status, getDump.body, getDump.headers);
  }
  throw new HttpError(res.status, t("net.attachConfirmFailed", { name }));
}

/** 从 attachment-add 响应解析出托管 URI 与 MANAGED-ID（只取第一条）。 */
function parseManagedAttach(body: string): { uri: string; managedId: string } | null {
  const all = parseAllManagedAttach(body);
  return all.length ? all[0] : null;
}

/** 删除服务端条目 */
export async function deleteItem(item: CalItem, channel: Channel, auth: DavAuth): Promise<void> {
  const headers: Record<string, string> = {};
  if (item.etag) headers["If-Match"] = `"${item.etag}"`;
  const res = await httpRequest(item.href, { method: "DELETE", headers, timeoutMs: 30000 }, channel, auth);
  if (res.status >= 400 && res.status !== 404) {
    throw new HttpError(res.status, t("net.deleteFailed", { status: res.status }));
  }
}

/**
 * 把网络级失败翻译成用户能照着做的提示。
 * 「Failed to fetch」是浏览器在请求根本没发出去时的笼统报错，
 * 与密码无关（密码错会返回 401）——手机端多半是 WebView 拦了明文 HTTP / 跨域。
 */
export function describeNetworkError(e: unknown, channel: Channel): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  if (!isNetworkLevelError(e)) return raw;
  if (channel === "direct") {
    // Obsidian 的 requestUrl 走原生 HTTP，理论上不受 CORS 限制；走到这里通常是
    // 移动端 WebView 拦了明文 HTTP，或地址在移动端网络上不可达。
    return t("net.unreachableHttpHint", { raw });
  }
  return t("net.unreachablePlain", { raw });
}

/** 测试连接：PROPFIND 根集合 */
export async function testConnection(serverUrl: string, channel: Channel, auth: DavAuth): Promise<{ ok: boolean; message: string }> {
  try {
    const base = serverUrl.endsWith("/") ? serverUrl : serverUrl + "/";
    const res = await dav(
      base,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`,
      channel,
      auth
    );
    if (res.status === 401) return { ok: false, message: t("net.authFailedTest") };
    if (res.status >= 400) return { ok: false, message: t("net.httpStatus", { status: res.status }) };
    // 只走 connectOkDirect：Obsidian 下 via 恒为 "direct"（http.ts 的单传输实现），
    // 「内核代理」分支是从思源版搬过来的死代码 —— 留着会让 connectOkProxy
    // 这条带「内核代理」字样的文案永远无人使用，却仍在暗示存在第二条通道。
    return { ok: true, message: t("net.connectOkDirect", { ms: res.elapsedMs }) };
  } catch (e: unknown) {
    return { ok: false, message: t("settings.connectFail", { msg: describeNetworkError(e, channel) }) };
  }
}

/** 服务端时间窗 ISO（UTC 基本格式 20260101T000000Z） */
export function icsRangeIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
