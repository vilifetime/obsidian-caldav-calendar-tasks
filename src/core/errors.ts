/**
 * 未知值（`unknown` / `any`）的类型守卫工具。
 *
 * 社区目录的源码扫描会报 `Unexpected any`。本项目原本在 12 处 `catch (e: any)`
 * 上用any —— 但这些块里只用到 `e?.message` 和 `String(e)`，any 纯属图省事：
 * 换成 `unknown` 后编译器会强制你先判窄，杜绝「以为 e 是 HttpError 其实不是」
 * 这类隐患（`e?.status` 那种访问尤甚）。
 *
 * 统一收敛到这里，catch 块写`catch (e: unknown)`，取值一律经下列函数。
 */

/** 取错误对象上的 `message` 字段（兼容非Error 的异常值） */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e ?? "");
}

/** 取 HTTP 状态码；非 HttpError 或无该字段时返回 undefined */
export function errStatus(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}
