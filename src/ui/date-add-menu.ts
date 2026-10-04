/**
 * 「新建」浮层：选种类（日程 / 待办）后打开编辑器。
 *
 * 两个入口共用：
 *   1. 工具条的「+ 新建」按钮（原本是两个独立的「+日程」「+待办」按钮）
 *   2. 日历日期单元格双击
 * 两者都是「先选种类、再打开编辑器」，故合并为同一实现，文案与外观统一。
 */
import type { PanelCtx } from "./panel-ctx";
import { openEditor } from "./editor";
import { icons } from "./icons";
import { setHtml } from "./dom";

/** 在 (x, y) 处弹出新增浮层；day 形如 YYYY-MM-DD；startEvent 为双击时间轴时算出的默认开始时间 */
export function openDateAddMenu(ctx: PanelCtx, x: number, y: number, day: string, startEvent?: string): void {
  document.querySelector(".caldav-add-menu")?.remove();
  // 用 Obsidian 的 createDiv 扩展而非 document.createElement（官方规则）：
  // 它是 HTMLElement 的类型安全构造，同时省掉手工 className 赋值。
  const menu = document.body.createDiv({ cls: "caldav-add-menu" });
  setHtml(
    menu,
    `
    <button class="caldav-add-menu-item" data-kind="event">${icons.plus}<span>日程</span></button>
    <button class="caldav-add-menu-item" data-kind="todo">${icons.plus}<span>待办</span></button>
  `
  );
  document.body.appendChild(menu);

  const r = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - r.width - 8));
  const top = Math.min(Math.max(8, y + 6), Math.max(8, window.innerHeight - r.height - 8));
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  const close = (): void => {
    menu.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onDoc = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  // 延迟绑定，避免本次点击立即触发关闭
  window.setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);

  menu.querySelectorAll<HTMLElement>(".caldav-add-menu-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const kind = item.dataset.kind as "event" | "todo";
      // 点击空白处新建时只带日期，时刻交给编辑弹窗补（今天 = 下一个整点）
      const start = kind === "event" ? startEvent || day : day;
      close();
      openEditor(ctx, { kind, start });
    });
  });
}
