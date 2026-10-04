/**
 * 极简 i18n。
 *
 * 原思源版的 i18n 是思源集市要求的 `{ key: { other, zh_CN } }` 嵌套结构，
 * 且只覆盖命令文案（UI 正文本身是硬编码中文）。Obsidian 的命令名直接写字符串，
 * 不需要 langKey，故这里改成扁平字典 + `t()` 查表。
 */
import { moment } from "obsidian";
import zhCN from "./zh_CN.json";
import enUS from "./en_US.json";

const dicts: Record<string, Record<string, string>> = {
  zh: zhCN as Record<string, string>,
  en: enUS as Record<string, string>,
};

let current: "zh" | "en" = "zh";

/** 按 Obsidian 当前界面语言切换；未知语言一律回落英文，中文前缀归中文 */
export function initLocale(): void {
  try {
    current = moment.locale().toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    current = "zh";
  }
}

export function t(key: string): string {
  return dicts[current]?.[key] ?? dicts.zh[key] ?? key;
}
