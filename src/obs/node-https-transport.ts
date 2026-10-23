/**
 * 桌面端 HTTP 传输：基于 Node 内置 https/http 模块，自行控制重定向。
 *
 * ── 为什么桌面端不复用 requestUrl（见 http-transport.ts）─────────────────
 * requestUrl 桌面端走 Electron `net.request({ redirect: "follow" })`，**自动跟随重定向**，
 * 而 Chromium 网络栈在**跨域重定向时会剥离 Authorization 头**（防止凭据泄露到其它域）。
 *
 * iCloud 正是这种场景：`caldav.icloud.com` 跨域 301 到 `p217-caldav.icloud.com.cn`，
 * requestUrl 跟随时凭据被剥 → 节点主机收不到认证 → principal 发现失败 → 报「无法定位 principal」。
 * （实测：选 iCloud 自动填的根地址，第一步 principal PROPFIND 拿到的就是被剥头的响应。）
 *
 * ── 本实现怎么修 ───────────────────────────────────────────────────────
 * 自己发请求、遇到 3xx **自己跟随**，并重发时**显式保留 method / body / Authorization**，
 * 从而正确走完 iCloud 的发现链。顺带对所有 CalDAV 服务器都更稳健：
 * 标准浏览器跟随会在 301/302/303 把 PROPFIND/REPORT/PUT 等方法改成 GET，而 CalDAV
 * 服务器（尤其 iCloud）期望重定向后继续用原方法——这里一律保留原方法。
 *
 * ── 为什么只在桌面端注入 / 动态 require ────────────────────────────────
 * 移动端（Capacitor）没有 Node 环境，跑不了本文件。main.ts 按 Platform.isMobile 选择：
 *   桌面端 → nodeHttpsTransport（本文件）
 *   移动端 → obsidianTransport（requestUrl；iCloud 跨域重定向在移动端同样受限，
 *            引导用户填 iCloud 节点的完整路径，或等后续用代理方案）
 * 因此本文件**不能在模块顶层 require Node 模块**——否则移动端加载 main.js 时会因
 * `require("https")` 直接崩。改为函数内通过 `globalThis.require` 动态获取，模块加载时
 * 零副作用，移动端即便导入了本模块也不会执行到（它用的是 requestUrl 传输）。
 */
import type { HttpOptions, HttpResult, Transport } from "@/core/http";
import { t } from "../i18n";

export const nodeHttpsTransport: Transport = async (
  url: string,
  opts: HttpOptions
): Promise<HttpResult> => {
  // 桌面端 Electron 在 globalThis 上暴露 require；通过属性访问而非裸标识符，
  // 避免被打包器误判为静态 import。移动端 WebView 无 require，但也不会执行本函数。
  const g: any = globalThis;
  const nodeRequire: any = g.require;
  const https = nodeRequire("https") as typeof import("https");
  const http = nodeRequire("http") as typeof import("http");
  const zlib = nodeRequire("zlib") as typeof import("zlib");

  const t0 = Date.now();
  const MAX_REDIRECTS = 6;
  const method = (opts.method || "GET").toUpperCase();
  const baseHeaders: Record<string, string> = { ...(opts.headers || {}) };
  const body = opts.body;
  const timeoutMs = opts.timeoutMs || 30000;

  let currentUrl = url;
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    const result = await new Promise<HttpResult>((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(currentUrl);
      } catch (e) {
        reject(e);
        return;
      }
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;
      const port = u.port || (isHttps ? 443 : 80);

      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port,
          path: u.pathname + u.search,
          method,
          headers: baseHeaders,
          timeout: timeoutMs,
        },
        (res: any) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const encoding = (res.headers["content-encoding"] || "").toLowerCase();
            const finish = (raw: Buffer) => {
              const text = raw.toString("utf8");
              const h: Record<string, string> = {};
              for (const k of Object.keys(res.headers)) h[k.toLowerCase()] = String(res.headers[k]);
              // bytes：把底层 Buffer 按真实长度切出（Buffer 可能比 ArrayBuffer 容量小，
              // 不切片会把尾随垃圾也算进来）。托管附件下载走这个，utf8 解码会破坏二进制。
              const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
              resolve({ status: res.statusCode || 0, headers: h, body: text, bytes, elapsedMs: Date.now() - t0, via: "direct" });
            };
            if (encoding === "gzip") zlib.gunzip(buf, (e: Error | null, d: Buffer) => (e ? finish(buf) : finish(d)));
            else if (encoding === "deflate") zlib.inflate(buf, (e: Error | null, d: Buffer) => (e ? finish(buf) : finish(d)));
            else if (encoding === "br") zlib.brotliDecompress(buf, (e: Error | null, d: Buffer) => (e ? finish(buf) : finish(d)));
            else finish(buf);
          });
        }
      );

      // 超时：socket 无活动 / 连接过慢都触发，抛含 "timeout" 的错误，
      // 供 http.ts 的 isNetworkLevelError() 归为网络级失败。
      req.on("timeout", () => req.destroy(new Error(t("net.timeout"))));
      req.on("error", (e: Error) => reject(e));

      if (body) req.write(body);
      req.end();
    });

    // 3xx：自行跟随（requestUrl 自动跟随会剥跨域头，这里重发时保留 baseHeaders 里的 Authorization）
    if (result.status >= 300 && result.status < 400) {
      const location = (result.headers["location"] || "").trim();
      if (location && attempt < MAX_REDIRECTS) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
    }

    return result;
  }

  throw new Error(t("net.tooManyRedirects"));
};
