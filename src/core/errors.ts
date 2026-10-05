/**
 * 未知值（`unknown` / `any`）的类型守卫与安全转换工具。
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

/** 取 HTTP 状态码；非HttpError 或无该字段时返回 undefined */
export function errStatus(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/**
 * 结构化深拷贝，类型安全。
 *
 * 替代裸的 `JSON.parse(JSON.stringify(x))` —— 后者的返回值是 `any`，
 * 赋给任何变量都会被 eslint 的 `no-unsafe-assignment` 报「不安全赋值」。
 * 社区扫描在 `core/store.ts` 与 `ui/category-manager.ts` 各报了 2 处。
 *
 * 泛型参数由调用点显式给出，编译期即保证结果类型与源类型一致；
 * 若调用点写错类型参数，TS 会因结构不匹配而报错（除非二者恰好同构）。
 *
 * 用途是「拿一份可安全改写的独立副本」—— 典型场景是默认设置的深拷贝：
 * 避免多处共享同一个对象引用，改一处就串到别处。
 *
 * 不支持函数 / symbol / 循环引用（与 JSON 语义一致）。本项目用它拷贝的都是
 * 纯 JSON 数据（设置、日历、分类），不涉及这些情况。
 */
export function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
