/**
 * 极简 i18n。
 *
 * 原思源版的 i18n 是思源集市要求的 `{ key: { other, zh_CN } }` 嵌套结构，
 * 且只覆盖命令文案（UI 正文本身是硬编码中文）。Obsidian 的命令名直接写字符串，
 * 不需要 langKey，故这里改成扁平字典 + `t()` 查表。
 *
 * ## 为什么这个文件不能 import "obsidian"
 *
 * `src/core/` 是宿主无关的纯逻辑层，全项目铁律是「core 层零 obsidian 依赖」
 * （否则 Node 测试环境跑不起来，见 core/http.ts 的 setTransport 注释）。
 * 但 core 层也出用户可见文案（错误消息、日期格式），所以 i18n 必须比 core 更底层：
 * 本文件只用浏览器内置 API，谁都能 import —— core、ui、obs 皆可。
 *
 * ## 语言判定顺序
 *   ① 用户在设置里手动指定的语言（override，唯一持久化的依据）
 *   ② Obsidian 界面语言（moment.locale()）
 *   ③ localStorage 里 Obsidian 存的语言标记
 *   ④ 兜底英文（未知语言一律英文，宁可给英语也不要给错语言的中文）
 */
import zhCN from "./zh_CN.json";
import enUS from "./en_US.json";

export type Lang = "zh" | "en";

const dicts: Record<Lang, Record<string, string>> = {
  zh: zhCN as Record<string, string>,
  en: enUS as Record<string, string>,
};

/** 按 Obsidian 界面语言猜测：中文前缀归中文，其余一律英文 */
function detectHostLang(): Lang {
  // moment.locale() 是最准的（Obsidian 会把界面语言映射到 moment locale），
  // 但它挂在 obsidian 模块上，本文件不能 import，故从全局 window 上取。
  const m = (globalThis as { moment?: { locale?: () => string } }).moment;
  if (m && typeof m.locale === "function") {
    const loc = m.locale();
    if (typeof loc === "string" && loc.toLowerCase().startsWith("zh")) return "zh";
    if (loc) return "en";
  }
  // 次选：Obsidian 会在 localStorage 存语言标记
  try {
    const stored = globalThis.localStorage?.getItem("language");
    if (stored) return stored.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    // 隐私模式 / 无 localStorage：忽略，走兜底
  }
  return "en";
}

let current: Lang = "en";
let override: Lang | null = null;

/**
 * 初始化语言。
 *
 * @param manual 用户在设置里手动指定的语言；传 undefined 表示「跟随 Obsidian」，
 *               此时每次调用都会重新探测宿主语言（用户在 Obsidian 里改语言后，
 *               下次打开设置页就能看到新文案）。
 */
export function initLocale(manual?: string | null): void {
  override = manual === "zh" || manual === "en" ? manual : null;
  current = override ?? detectHostLang();
}

export function currentLang(): Lang {
  return current;
}

/** 字典里的插值参数 */
export type Vars = Record<string, string | number>;

/**
 * 查表 + 插值。
 *
 * 插值语法 `{name}`，未提供的占位符原样保留（便于一眼看出漏传参数）。
 * 查不到 key 时回落中文字典，再查不到就返回 key 本身 —— 不返回空串，
 * 因为空串会让界面出现「按钮存在但没字」这种更难排查的现象。
 */
export function t(key: string, vars?: Vars): string {
  const dict = dicts[current];
  const raw = dict?.[key] ?? dicts.zh[key] ?? key;
  if (vars === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * 批量插值：把字典条目里全部 `{name}` 占位符用给定变量填掉。
 * 与 `t()` 等价，供不想写 t 两次的地方使用。
 */
export function tf(key: string, vars: Vars): string {
  return t(key, vars);
}
