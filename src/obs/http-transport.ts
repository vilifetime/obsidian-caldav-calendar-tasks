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

export const obsidianTransport: Transport = async (
  url: string,
  opts: HttpOptions
): Promise<HttpResult> => {
  const t0 = Date.now();
  const res = await requestUrl({
    url,
    method: opts.method || "GET",
    headers: opts.headers,
    body: opts.body,
    /**
     * false = 4xx/5xx 不抛异常，由调用方按 status 判定；
     * 网络级错误（DNS / 连接被拒 / TLS）仍会抛，供 sync.ts 的
     * isNetworkLevelError() 分类。
     */
    throw: false,
  });

  // 归一化键名为小写。requestUrl 返回的 headers 本身已是 Record<string, string>，
  // 原来的 `as Record<string, string>` 断言是多余的（社区扫描报的
  // no-unnecessary-type-assertion），直接用即可。
  const headers: Record<string, string> = {};
  for (const k of Object.keys(res.headers ?? {})) headers[k.toLowerCase()] = String(res.headers[k]);

  return {
    status: res.status,
    headers,
    body: res.text,
    elapsedMs: Date.now() - t0,
    via: "direct",
  };
};
