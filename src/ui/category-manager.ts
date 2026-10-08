/**
 * 分类管理弹窗：添加/编辑/删除/排序任务分类，保存后写入 store.settings.categories
 */
import { Modal } from "obsidian";
import type { CategoryDef } from "../core/types";
import { DEFAULT_CATEGORIES } from "../core/types";
import type { PanelCtx } from "./panel-ctx";
import { escape } from "./view-common";
import { icons } from "./icons";
import { setHtml } from "./dom";
import { deepCopy } from "../core/errors";
import { t } from "@/i18n";

const PALETTE = ["#e05a4c", "#3d82d6", "#43a05c", "#e0972f", "#8a63d2", "#2fa6a0", "#d4568f", "#6b7280"];

function genId(): string {
  return "cat-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function listHtml(cats: CategoryDef[], editIdx: number | null): string {
  if (!cats.length) {
    return `<div class="caldav-catmgr-empty">${t("catmgr.empty")}</div>`;
  }
  return cats
    .map((c, i) => {
      const editing = i === editIdx;
      return `<div class="caldav-catmgr-row ${editing ? "is-editing" : ""}" data-idx="${i}">
  <span class="caldav-catmgr-idx">${i + 1}</span>
  <span class="caldav-catmgr-icon" style="background:${escape(c.color)}">${escape(c.icon)}</span>
  <span class="caldav-catmgr-dot" style="background:${escape(c.color)}"></span>
  ${
    editing
      ? `<input class="caldav-input caldav-catmgr-name-input" data-edit="name" value="${escape(c.name)}" placeholder="${t("catmgr.namePlaceholder")}"/>
         <input class="caldav-catmgr-color-input" type="color" data-edit="color" value="${escape(c.color)}" title="${t("catmgr.colorTitle")}"/>
         <input class="caldav-input caldav-catmgr-icon-input" data-edit="icon" value="${escape(c.icon)}" maxlength="2" placeholder="${t("catmgr.iconPlaceholder")}" title="${t("catmgr.iconTitle")}"/>`
      : `<span class="caldav-catmgr-name">${escape(c.name)}</span>`
  }
  <span class="caldav-flex"></span>
  <button type="button" class="caldav-catmgr-btn" data-mgr="edit" title="${editing ? t("catmgr.finishEdit") : t("catmgr.edit")}">${editing ? icons.check : icons.pencil}</button>
  <button type="button" class="caldav-catmgr-btn" data-mgr="del" title="${t("catmgr.del")}">${icons.trash}</button>
  <span class="caldav-catmgr-arrows">
    <button type="button" class="caldav-catmgr-btn" data-mgr="up" title="${t("catmgr.moveUp")}" ${i === 0 ? "disabled" : ""}><span class="caldav-catmgr-arrow-up">${icons.chevron}</span></button>
    <button type="button" class="caldav-catmgr-btn" data-mgr="down" title="${t("catmgr.moveDown")}" ${i === cats.length - 1 ? "disabled" : ""}>${icons.chevron}</button>
  </span>
</div>`;
    })
    .join("");
}

function mgrHtml(cats: CategoryDef[]): string {
  return `
<div class="caldav-editor-form">
  <div class="caldav-catmgr-actions">
    <button type="button" class="caldav-foot-btn caldav-foot-btn--primary" data-mgr="add">${icons.plus} ${t("catmgr.add")}</button>
    <button type="button" class="caldav-foot-btn caldav-foot-btn--ghost" data-mgr="reset">${icons.reset} ${t("catmgr.reset")}</button>
  </div>
  <div class="caldav-catmgr-hint">${t("catmgr.hint")}</div>
  <div class="caldav-catmgr-list" data-mgr-list>${listHtml(cats, null)}</div>
</div>

<div class="caldav-editor-foot">
  <span class="caldav-catmgr-note">${t("catmgr.note")}</span>
  <div class="caldav-editor-error" data-error></div>
  <span class="caldav-flex"></span>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--ghost" data-action="cancel">${icons.close} ${t("common.cancel")}</button>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--primary" data-action="save">${icons.check} ${t("common.save")}</button>
</div>`;
}


export function openCategoryManager(ctx: PanelCtx): void {
  new CategoryManagerModal(ctx).open();
}

/**
 * 分类管理弹窗（Obsidian Modal）。
 *
 * 原思源版在 openCategoryManager 里直接 new Dialog，整段交互逻辑写成闭包。
 * 这里改为 Modal 子类：`cats` / `editIdx` 从闭包变量提升为实例字段，
 * 交互逻辑（添加/编辑/删除/排序、名称非空与查重、保存写回）原样保留。
 *
 * 删除 adoptMobileLayer / enableDialogResize —— 见 editor.ts 的同类说明。
 */
class CategoryManagerModal extends Modal {
  /** 工作副本：点「保存」才写回 store */
  private cats: CategoryDef[];
  private editIdx: number | null = null;
  private errEl!: HTMLElement;
  private listEl!: HTMLElement;

  constructor(private ctx: PanelCtx) {
    super(ctx.app);
    const src = ctx.store.settings.categories?.length
      ? ctx.store.settings.categories
      : DEFAULT_CATEGORIES;
    this.cats = deepCopy(src);
  }

  onOpen(): void {
    this.titleEl.setText(t("catmgr.title"));
    this.modalEl.addClass("caldav-dialog");

    const el = this.contentEl.createDiv({ cls: "caldav-catmgr caldav-editor" });
    setHtml(el, mgrHtml(this.cats));
    this.errEl = el.querySelector("[data-error]") as HTMLElement;
    this.listEl = el.querySelector("[data-mgr-list]") as HTMLElement;

    const commitEdit = (): void => {
      const idx = this.editIdx;
      if (idx == null || !this.cats[idx]) {
        this.editIdx = null;
        return;
      }
      const nameInput = this.listEl.querySelector<HTMLInputElement>('[data-edit="name"]');
      const colorInput = this.listEl.querySelector<HTMLInputElement>('[data-edit="color"]');
      const iconInput = this.listEl.querySelector<HTMLInputElement>('[data-edit="icon"]');
      const name = (nameInput?.value || "").trim();
      if (!name) {
        this.errEl.textContent = t("catmgr.errNameEmpty");
        return;
      }
      this.errEl.textContent = "";
      this.cats[idx] = {
        ...this.cats[idx],
        name,
        color: colorInput?.value || this.cats[idx].color,
        icon: (iconInput?.value || "").trim() || this.cats[idx].icon
      };
      this.editIdx = null;
    };

    const render = (): void => {
      setHtml(this.listEl, listHtml(this.cats, this.editIdx));
    };

    el.addEventListener("click", (ev) => {
      // 变量名不能叫 t —— 会遮蔽 i18n 的 t()，下面 t("catmgr.xxx") 会变成 HTMLElement 调用
      const tgt = ev.target as HTMLElement;
      // 顶部动作（添加 / 重置）
      const act = tgt.closest<HTMLElement>("[data-mgr]");
      if (act && el.contains(act)) {
        const a = act.dataset.mgr!;
        if (a === "add") {
          commitEdit();
          this.cats.push({
            id: genId(),
            name: t("catmgr.newCat", { n: this.cats.length + 1 }),
            color: PALETTE[this.cats.length % PALETTE.length],
            icon: "🏷"
          });
          this.editIdx = this.cats.length - 1;
          render();
          this.listEl.querySelector<HTMLInputElement>('[data-edit="name"]')?.focus();
          this.listEl.querySelector<HTMLInputElement>('[data-edit="name"]')?.select();
          return;
        }
        if (a === "reset") {
          this.cats = deepCopy(DEFAULT_CATEGORIES);
          this.editIdx = null;
          this.errEl.textContent = "";
          render();
          return;
        }
        // 行内动作
        const row = act.closest<HTMLElement>(".caldav-catmgr-row");
        if (!row) return;
        const idx = Number(row.dataset.idx);
        if (a === "edit") {
          if (this.editIdx === idx) {
            commitEdit();
          } else {
            commitEdit();
            this.editIdx = idx;
          }
          render();
          if (this.editIdx === idx) {
            this.listEl.querySelector<HTMLInputElement>('[data-edit="name"]')?.focus();
          }
          return;
        }
        if (a === "del") {
          commitEdit();
          this.cats.splice(idx, 1);
          render();
          return;
        }
        if (a === "up" && idx > 0) {
          commitEdit();
          [this.cats[idx - 1], this.cats[idx]] = [this.cats[idx], this.cats[idx - 1]];
          render();
          return;
        }
        if (a === "down" && idx < this.cats.length - 1) {
          commitEdit();
          [this.cats[idx + 1], this.cats[idx]] = [this.cats[idx], this.cats[idx + 1]];
          render();
          return;
        }
      }
      if (tgt.closest('[data-action="cancel"]')) {
        this.close();
        return;
      }
      if (tgt.closest('[data-action="save"]')) {
        commitEdit();
        const names = new Set<string>();
        for (const c of this.cats) {
          if (!c.name.trim()) {
            this.errEl.textContent = t("catmgr.errNameEmpty");
            return;
          }
          if (names.has(c.name.trim())) {
            this.errEl.textContent = t("catmgr.errNameDup", { name: c.name.trim() });
            return;
          }
          names.add(c.name.trim());
        }
        const store = this.ctx.store;
        store.settings.categories = this.cats;
        store.saveSettings();
        this.close();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
