/**
 * 运行环境判定（Obsidian 版）
 *
 * 原思源版用 `getFrontend().endsWith("mobile")` 区分移动端 —— 思源移动端没有页签栏、
 * Dialog 全屏、触摸取代鼠标，插件必须按前端类型分支渲染。
 *
 * Obsidian 的情况简单得多：桌面端与移动端**共用 ItemView**，视图承载方式一致，
 * 差异只剩少数触摸交互细节（如日历格子内放不下「时间 + 标题」）。
 * 因此这里只保留 `isMobile()` 供 UI 层做样式与交互微调。
 */
import { Platform } from "obsidian";

/** 是否运行在移动端（手机 / 平板 App） */
export function isMobile(): boolean {
  return Platform.isMobile;
}

/** 是否运行在桌面端 App（不含浏览器 serv 模式） */
export function isDesktopApp(): boolean {
  return Platform.isDesktopApp;
}
