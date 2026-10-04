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
    throw new Error(
      "HTTP 传输未初始化：宿主必须在 onload 时调用 setTransport()。" +
        "（请勿在 core 层直接使用 fetch —— 移动端会被 CORS 拦截。）"
    );
  }
  return transport(url, opts);
}

export function basicAuthHeader(username: string, password: string): string {
  return "Basic " + btoa(unescape(encodeURIComponent(username + ":" + password)));
}

/**
 * 按通道发起请求。
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
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (auth) headers["Authorization"] = basicAuthHeader(auth.username, auth.password);
  void channel; // 单通道，参数保留以免改动 caldav.ts / sync.ts
  return viaTransport(url, { ...opts, headers });
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
