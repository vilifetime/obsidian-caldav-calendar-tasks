/**
 * 「插入日记」的范围选择对话框（2026-10-07）。
 *
 * 雄哥要求：原按钮直接插「今日」，改为先问范围 —— 当日 / 本周 / 本月 / 所有，
 * 默认「当日」，带确认 / 取消。
 *
 * 为什么用 `Modal` 而非浮层：这是**有默认值的写文件确认**，
 * 需要明确的「确认 / 取消」与焦点管理；浮层适合「选种类」这类轻量选择
 * （见 date-add-menu.ts）。
 */
import { Modal, type App } from "obsidian";
import { setHtml } from "./dom";
import type { DiaryRange } from "./diary-range";
import { t } from "@/i18n";

interface Option {
  key: DiaryRange;
  label: string;
  hint: string;
}

/**
 * 顺序即显示顺序；第一项同时是默认项。
 *
 * label / hint 存 i18n key —— 模块级常量在 import 时求值完，
 * 用户中途改语言不会重新求值，故在渲染处 t()。
 */
const OPTIONS: Option[] = [
  { key: "day", label: "diary.range.day", hint: "diary.range.dayHint" },
  { key: "week", label: "diary.range.week", hint: "diary.range.weekHint" },
  { key: "month", label: "diary.range.month", hint: "diary.range.monthHint" },
  { key: "all", label: "diary.range.all", hint: "diary.range.allHint" },
];

/**
 * 弹出范围选择框。
 * @param app Obsidian 应用实例（Modal 构造必需）
 * @param onPick 用户点「确认插入」时回调；取消 / Esc / 点遮罩则不调用。
 */
export function askDiaryRange(app: App, onPick: (range: DiaryRange) => void): void {
  // 默认「当日」—— 雄哥要求，也与旧行为（直接插今日）一致
  let picked: DiaryRange = "day";

  const modal = new Modal(app);
  modal.setTitle(t("diary.title"));
  modal.modalEl.addClass("caldav-diary-range-modal");

  setHtml(
    modal.contentEl,
    `
<div class="caldav-range">
  <div class="caldav-range-lead">${t("diary.lead")}</div>
  <fieldset class="caldav-range-opts">
    <legend class="sr-only">${t("diary.legend")}</legend>
    ${OPTIONS.map(
      (o) => `
    <label class="caldav-range-opt">
      <input type="radio" name="caldav-range" value="${o.key}"${o.key === "day" ? " checked" : ""}/>
      <span class="caldav-range-opt-body">
        <span class="caldav-range-opt-label">${t(o.label)}</span>
        <span class="caldav-range-opt-hint">${t(o.hint)}</span>
      </span>
    </label>`
    ).join("")}
  </fieldset>
</div>`
  );

  // 选中态由 JS 直接切 class，不用 CSS `:has(input:checked)`
  //（2026-10-07 社区扫描报「Avoid :has — can cause significant performance
  //  issues due to broad selector invalidation」：`:has()` 会让浏览器在**每次
  //  DOM 变更**时重新评估匹配关系，在 Obsidian 这种频繁重渲染的宿主里代价明显。）
  const rows = Array.from(
    modal.contentEl.querySelectorAll<HTMLInputElement>('input[name="caldav-range"]')
  );
  rows.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      picked = r.value as DiaryRange;
      rows.forEach((other) => {
        const label = other.closest<HTMLElement>(".caldav-range-opt");
        if (label) label.classList.toggle("is-checked", other === r);
      });
    });
  });
  // 默认项（当日）初始即为选中态
  const firstLabel = rows[0]?.closest<HTMLElement>(".caldav-range-opt");
  firstLabel?.classList.add("is-checked");

  const actions = modal.contentEl.createDiv({ cls: "caldav-range-actions" });
  const cancel = actions.createEl("button", { text: t("common.cancel") });
  cancel.addEventListener("click", () => modal.close());

  const ok = actions.createEl("button", {
    cls: "mod-cta",
    text: t("diary.confirm"),
  });
  ok.addEventListener("click", () => {
    const range = picked;
    modal.close();
    onPick(range);
  });

  // 焦点默认落在「取消」上：这一步会写文件，防误触更安全
  window.setTimeout(() => cancel.focus(), 0);

  // ⚠️ 必须显式 open() —— `new Modal(app)` 只构造，**不会自动显示**
  // （漏这行 = 点按钮毫无反应；2026-10-07 首次实测踩过）
  modal.open();
}