/**
 * 共享常量。
 *
 * 单独成文件的原因：`VIEW_TYPE_CALDAV` 同时被入口（注册视图）与视图模块（声明类型）使用，
 * 若定义在 main.ts 会形成 `main.ts ↔ ui/main-view.ts` 的循环 import —— 打包成 CJS 后
 * 循环链上取到的可能是 undefined，表现为「视图注册成功但打不开」。放这里两边都单向引用。
 */

/** 视图类型标识：主日历面板（在中间主区域打开） */
export const VIEW_TYPE_CALDAV = "caldav-main-view";

/**
 * 视图类型标识：Dock 精简导航面板（在右侧栏打开）。
 *
 * 对应原思源插件左侧的 Dock（renderDockPanel）—— 在 Obsidian 里改放右侧栏：
 * 日历主面板放中间主区域、Dock 放右侧栏，两者并排，与思源版「Dock + 主窗口页签」的
 * 双承载形态最接近。
 */
export const DOCK_VIEW_TYPE = "caldav-dock-view";

/**
 * 图标 id。
 *
 * 直接用 Obsidian 内置的 lucide 图标 `calendar-check`（日历 + 勾选，语义正好是
 * 「日历任务」），而**不是** `addIcon` 注册自定义 SVG。
 *
 * 原因：原先用 `addIcon(ICON_ID, '<rect …/><line …/>')` 传的是 lucide 风格的
 * **内部内容**（不含 `<svg>` 包裹与 viewBox），结果 Ribbon 上只渲染出一个极小的点
 * —— 没有 viewBox 时 SVG 退回默认坐标系（300×150），24×24 视口下内容被缩到几乎不可见。
 * 改传完整 `<svg viewBox="0 0 24 24">…</svg>` 虽可行，但内置图标零风险且自带主题适配。
 */
export const ICON_ID = "calendar-check";

/** 写入日记的小节标题，兼作「重复点击 → 替换而非追加」的识别标记 */
export const DIARY_SECTION_TITLE = "今日日程与待办";
