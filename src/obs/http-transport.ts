/**
 * HTTP 传输实现：Obsidian requestUrl
 *
 * 由入口在 onload 时注入给 core/http.ts 的 setTransport()。
 *
 * 为什么不用渲染进程的 `fetch`：Obsidian 渲染进程同样受 CORS 约束，
 * 跨域请求 CalDAV 服务器会被拦；`requestUrl` 才是官方提供的绕行通道。
 * 桌面端走 Electron net、移动端走 Capacitor 原生 HTTP，**两端都无 CORS**。
 *
 * 关于自定义方法：CalDAV 依赖 `PROPFIND` / `REPORT` 等非标准方法，
 * `requestUrl` 的 `method` 为字符串会原样透传；`Depth` 等自定义头同理。
 * （库内的 Full Calendar Remastered 即以此方式工作，见迁移方案 §6.1）
 */
import { requestUrl } from "obsidian";
import type { HttpOptions, HttpResult, Transport } from "@/core/http";
import { t } from "../i18n";

export const obsidianTransport: Transport = async (
  url: string,
  opts: HttpOptions
): Promise<HttpResult> => {
  const t0 = Date.now();
  let currentUrl = url;
  let currentOpts = opts;
  // iCloud 等服务器会把根地址跨域重定向到节点主机
  // （caldav.icloud.com → p217-caldav.icloud.com.cn）。Obsidian 的 requestUrl
  // **不会自动跟随这类重定向**（实测 PROPFIND 拿到 301 就停、返回体为空），
  // 导致 principal 发现 0 结果、报「无法定位 principal」。
  // 这里手动跟随 3xx，并**保留原 method / body / Authorization 头**，
  // 既修好 iCloud 自动发现，也顺手消除跨域重定向丢认证头的风险。
  const MAX_REDIRECTS = 6;
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    const res = await requestUrl({
      url: currentUrl,
      method: currentOpts.method || "GET",
      headers: currentOpts.headers,
      // iCloud 附件上传会传 Uint8Array 二进制；requestUrl 只认 string|ArrayBuffer，
      // 这里把字节视图转成底层 ArrayBuffer（移动端走本传输层时也能发）。
      body: typeof currentOpts.body === "string" ? currentOpts.body : (currentOpts.body as Uint8Array).buffer as ArrayBuffer,
      /**
       * false = 4xx/5xx/3xx 都不抛异常，由本函数按 status 判定；
       * 网络级错误（DNS / 连接被拒 / TLS）仍会抛，供 sync.ts 的
       * isNetworkLevelError() 分类。
       */
      throw: false,
    });

    const status = res.status;
    if (
      (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
      attempt < MAX_REDIRECTS
    ) {
      const location = (res.headers?.location || res.headers?.Location || "").trim();
      if (location) {
        // 合并相对/绝对重定向目标；new URL 的 base 用当前 URL 以兼容相对路径
        currentUrl = new URL(location, currentUrl).toString();
        // 303 规范强制改 GET；其余（301/302/307/308）保留原方法，
        // 因为 CalDAV / iCloud 期望 PROPFIND/REPORT/PUT 等方法不变。
        if (status === 303) {
          currentOpts = { ...currentOpts, method: "GET", body: undefined };
        }
        continue;
      }
    }

    // 归一化键名为小写。requestUrl 返回的 headers 本身已是 Record<string, string>，
    // 原来的 `as Record<string, string>` 断言是多余的（社区扫描报的
    // no-unnecessary-type-assertion），直接用即可。
    const headers: Record<string, string> = {};
    for (const k of Object.keys(res.headers ?? {})) headers[k.toLowerCase()] = String(res.headers[k]);

    return {
      status,
      headers,
      body: res.text,
      // requestUrl 的 arrayBuffer 是原样二进制；托管附件下载走这个，text 是 utf8 解码会失真。
      bytes: res.arrayBuffer ? new Uint8Array(res.arrayBuffer) : undefined,
      elapsedMs: Date.now() - t0,
      via: "direct",
    };
  }

  throw new Error(t("net.tooManyRedirects"));
};
