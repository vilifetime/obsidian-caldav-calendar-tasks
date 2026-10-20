/**
 * HTTP 通道（宿主无关）
 *
 * 本文件**不 import 任何宿主模块**，实际传输由入口通过 `setTransport()` 注入：
 *   - Obsidian 入口注入基于 `requestUrl` 的实现（见 src/obs/http-transport.ts）
 *   - Node 测试环境不注入，自动回退到全局 `fetch`
 *
 * 这样分层的原因：源项目的 `test/*.test.mjs` 全在 Node 下直接跑 core 层，
 * 若此处 `import { requestUrl } from "obsidian"`，测试环境会因缺少宿主模块而失败。
 *
 * ── 与原思源版的差异 ────────────────────────────────────────────────
 * 原版是双通道（思源内核 `forwardProxy` 代理 + 浏览器直连自动回退），因为思源渲染进程
 * 受 CORS 与明文 HTTP 限制。Obsidian 的 `requestUrl()` 桌面端走 Electron、移动端走
 * Capacitor 原生 HTTP，**天然无 CORS**，因此本版：
 *   - 删除 `buildProxyBody()` / `viaProxy()`，连带作废三条思源内核约定
 *     （headers 必须是单键对象数组 / payloadEncoding 强制 base64 / contentType 独立字段）
 *   - 删除 `directFallbackToProxy` / `setDirectFallbackToProxy` / `kernelBase` / `setKernelBase`
 *   - `channel` 参数保留但已退化：不再有第二条通道可切
 *
 * **对外函数签名保持不变**，因此 `caldav.ts` / `sync.ts` 无需任何改动。
 *
 * ── 一个必须保留的语义 ─────────────────────────────────────────────
 * 传输实现遇 4xx/5xx 应正常返回 status（不抛异常），但**网络级错误
 * （DNS 失败 / 连接被拒 / TLS 失败）必须抛异常** —— 这正是我们要的：
 * `sync.ts` 依赖 `isNetworkLevelError()` 区分「服务器返回了错误」与「根本没连上」，
 * 前者直接报给用户，后者应提示检查地址与网络。
 */

import { t } from "../i18n";
import { buildDigestAuthorization, parseDigestChallenge, type DigestCred } from "./digest";

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
  /** 保留原字段以兼容调用方：Obsidian 下恒为 "direct" */
  via: "proxy" | "direct";
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type Channel = "auto" | "proxy" | "direct";

/** 由宿主注入的传输实现 */
export type Transport = (url: string, opts: HttpOptions) => Promise<HttpResult>;

let transport: Transport | null = null;

/** 入口在 onload 时调用；测试环境不调用则回退全局 fetch */
export function setTransport(t: Transport | null): void {
  transport = t;
}

/** 网络级失败（请求根本没到达服务器）而非服务器返回的 HTTP 错误 */
export function isNetworkLevelError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /failed to fetch|networkerror|network request failed|load failed|err_|net::|econnrefused|enotfound|etimedout|timeout/i.test(
    msg
  );
}

/**
 * 上传（带 body 的请求）的超时预算：小 body 用默认 60s，body 越大给得越宽
 * （2026-10-15 从思源侧同构移植，含 10-16 的放宽）。
 *
 * 为什么不能固定 30s：待办附件是 base64 内联进 ICS 的，一个 5MB 的图片 →
 * ICS 约 7MB。家用 NAS 的上行常常只有几百 KB/s（还可能经域名/中转绕一圈），
 * 7MB 传完要一分多钟。固定 30s 的结果是「挑选时放行、保存时也放行、上传
 * 永远超时」——条目卡在 dirty 里每轮同步反复重试（2026-10-15 实测：5.03MB
 * 附件，auto 通道代理/直连各 30s 全超时，报「上传 任务测试Z: 请求超时」）。
 *
 * 预算按 32KB/s 的保守速率折算，封顶 10 分钟——再慢就是真的传不动，不该让
 * 用户干等。Obsidian 单通道（requestUrl）吃这个值的方式是调用方把
 * `timeoutMs` 传进 HttpOptions（见 obs/http-transport.ts）。
 *
 * 2026-10-16 雄哥实测：NAS 上行有时比 64KB/s 的估速还慢，预算整体翻倍
 * （基线 30→60s、速率 64→32KB/s、封顶 5→10 分钟）。注意只翻「带 body 的
 * 上传」——PROPFIND/DELETE 等小请求仍是各调用点的 30s，那些卡死时等 60s
 * 只会更烦。
 */
export function uploadTimeoutMs(bodyBytes: number): number {
  const BASE_MS = 60000;
  const FLOOR_BYTES_PER_SEC = 32 * 1024;
  const CAP_MS = 600000;
  if (!Number.isFinite(bodyBytes) || bodyBytes <= 0) return BASE_MS;
  return Math.min(CAP_MS, BASE_MS + Math.ceil((bodyBytes / FLOOR_BYTES_PER_SEC) * 1000));
}

/**
 * 统一出口：始终走宿主注入的传输实现。
 *
 * 原本这里有个「未注入就回退全局 fetch」的兜底，现已删除，原因有三：
 *   1. 社区目录的移动端支持清单明确要求「用 `requestUrl` 而不是 `fetch`」——
 *      静态扫描会直接命中 `fetch(`，删掉比加豁免注释更彻底；
 *   2. 那条兜底路径在生产中**永不生效**：`main.ts` 的 `onload()` 第一件事就是
 *      `setTransport(obsidianTransport)`，而后者基于 `requestUrl`
 *      （桌面端走 Electron、移动端走 Capacitor 原生 HTTP，天然无 CORS）；
 *   3. 真走到「宿主未注入」时，静默降级比明确报错更糟 —— 用户会看到
 *      「连不上服务器」却查不出原因。抛错能让问题立刻暴露。
 *
 * 若 Node 测试环境需要真实发请求，应在测试里注入一个基于 node:http 的 transport，
 * 而不是让core 层自带 fetch。
 */
async function viaTransport(url: string, opts: HttpOptions): Promise<HttpResult> {
  if (!transport) {
    throw new Error(t("net.transportUninit"));
  }
  return transport(url, opts);
}

/**
 * 生成 HTTP Basic 认证头。
 *
 * Basic 认证的规范是「把 `user:pass` 的字节序列base64 编码」。
 * 旧写法 `btoa(unescape(encodeURIComponent(s)))` 依赖已弃用的 `unescape`
 * （社区扫描报的 deprecation 警告）。
 *
 * ## 等价性说明（重要，改写时勿简化）
 *
 * 旧写法的两步是：① `encodeURIComponent` 把字符串编成 UTF-8 并转义成 `%XX`；
 * ② `unescape` 把 `%XX` 还原成**原始字节**（每个字节当作 Latin-1 码位）。
 * 所以结果是「**UTF-8 字节序列**」再 base64。
 *
 * 直接用 `encodeURIComponent(s)` 会得到 `%XX` 文本（错的），
 * 直接取码位低 8 位 `codePointAt(0) & 0xff` 也会得到不同字节（非 ASCII 时，
 * 实测「名前:パス」两种写法结果不同）—— **两种"简化"都会改变行为**。
 *
 * 正确等价实现：`TextEncoder` 给出 UTF-8 字节（等价于 ①），
 * 再把每个字节当 Latin-1 码位拼成字符串（等价于 ②）。
 *
 * 注：非 Latin-1 字符（如中文密码）严格说不该用 Basic 传输，标准做法是用户
 * 改用 ASCII 密码；此处维持旧行为不变，避免影响现有用户的连接。
 */
export function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(username + ":" + password);
  let latin1 = "";
  for (const b of bytes) latin1 += String.fromCharCode(b);
  return "Basic " + btoa(latin1);
}

// —— Digest 认证协商（2026-10-20 从思源侧同构移植）——
// Baïkal 用户库只存 digest_a1_hash、不验 Basic，对它只发 Basic 永远 401；
// DAVx5/Thunderbird 能登是因为会自动协商 Digest。流程：
//   首次按 Basic 发 → 401 且响应带 Digest challenge → 算 Digest 重试，并按
//   「origin+用户名」缓存（nonce 复用、nc 递增）；之后同服务器请求直接走
//   Digest，不再每次 401 往返。nonce 过期（服务端常带 stale=true）时丢缓存
//   重协商一次；不带 challenge 的 401 是真·密码错，原样上交、行为不变。
const digestCache = new Map<string, DigestCred>();

/** 设置里改了凭据时调用，避免缓存里留着旧密码的协商结果 */
export function clearAuthCache(): void {
  digestCache.clear();
}

function digestCacheKey(url: string, username: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* 非标准 URL 时退回全串 */
  }
  return origin + "|" + username;
}

/** Digest 头里的 uri 必须是请求实际发出的路径（去掉 scheme/host） */
function requestUri(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * 发起请求；带 auth 时自动协商 Digest（见上方流程注释）。
 *
 * `channel` 仅为兼容原调用点而保留：Obsidian 下不存在第二条通道，
 * 三个取值都走同一实现。签名保持不变，调用方无需改动。
 */
export async function httpRequest(
  url: string,
  opts: HttpOptions,
  channel: Channel,
  auth?: { username: string; password: string }
): Promise<HttpResult> {
  const full: HttpOptions = { ...opts, headers: { ...(opts.headers || {}) } };
  // 没显式给超时的带 body 请求（上传类）按 body 大小放宽预算，见 uploadTimeoutMs：
  // 几 MB 的日历数据在家庭宽带上传一分钟以上是常事，固定 30s 等于必然超时。
  // 显式传了 timeoutMs 的调用方（caldav.ts 的 putItem 等）保持原值不动。
  if (full.timeoutMs === undefined && typeof full.body === "string" && full.body.length > 0) {
    full.timeoutMs = uploadTimeoutMs(new TextEncoder().encode(full.body).length);
  }

  // 单通道派发（Obsidian 的 requestUrl 天然无 CORS，不需要回退逻辑）
  const dispatch = async (o: HttpOptions): Promise<HttpResult> => viaTransport(url, o);

  if (!auth) return dispatch(full);

  const method = full.method || "GET";
  const uri = requestUri(url);
  const withAuth = (header: string): HttpOptions => ({
    ...full,
    headers: { ...full.headers, Authorization: header }
  });
  const digestHeader = (cred: DigestCred) => withAuth(buildDigestAuthorization(cred, method, uri));

  const key = digestCacheKey(url, auth.username);
  const cached = digestCache.get(key);
  if (cached) {
    // 已协商过：直接 Digest 发一次，不再 401 往返
    const r = await dispatch(digestHeader(cached));
    if (r.status !== 401) return r;
    // nonce 过期：丢缓存；带了新 challenge 就换 nonce 重试一次，否则按普通 401 上交
    digestCache.delete(key);
    const renewed = parseDigestChallenge(r.headers["www-authenticate"]);
    if (!renewed) return r;
    const cred: DigestCred = { username: auth.username, password: auth.password, challenge: renewed, nc: 0 };
    digestCache.set(key, cred);
    return dispatch(digestHeader(cred));
  }

  // 首次：Basic（Radicale/Nextcloud 走这条路，行为不变）
  const r = await dispatch(withAuth(basicAuthHeader(auth.username, auth.password)));
  if (r.status !== 401) return r;
  const challenge = parseDigestChallenge(r.headers["www-authenticate"]);
  if (!challenge) return r; // 真·密码错（Basic 服务器）→ 原样返回，调用方文案不变
  const cred: DigestCred = { username: auth.username, password: auth.password, challenge, nc: 0 };
  digestCache.set(key, cred);
  console.info("[caldav] 服务器要求 Digest 认证，已协商（Baïkal 类服务器只认 Digest）");
  return dispatch(digestHeader(cred));
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string
  ) {
    super(message);
  }
}
