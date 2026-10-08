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
import type { DiaryRange, DiaryTarget } from "./diary-range";
import { targetOptionsOf } from "./diary-range";
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
export function askDiaryRange(
  app: App,
  onPick: (range: DiaryRange, target: DiaryTarget) => void
): void {
  // 默认「当日」+ 写到今天的日记 —— 雄哥要求，也与旧行为（直接插今日）一致
  let picked: DiaryRange = "day";
  let pickedTarget: DiaryTarget = "today";

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
  <!-- 只有「本周 / 本月」才有两个目标可选（见 targetOptionsOf），此时才展开 -->
  <div class="caldav-range-sub" data-sub hidden>
    <div class="caldav-range-sub-lead">${t("diary.targetLead")}</div>
    <fieldset class="caldav-range-opts caldav-range-opts--sub" data-sub-opts></fieldset>
  </div>
</div>`
  );

  // 选中态由 JS 直接切 class，不用 CSS `:has(input:checked)`
  //（2026-10-07 社区扫描报「Avoid :has — can cause significant performance
  //  issues due to broad selector invalidation」：`:has()` 会让浏览器在**每次
  //  DOM 变更**时重新评估匹配关系，在 Obsidian 这种频繁重渲染的宿主里代价明显。）
  const markChecked = (inputs: HTMLInputElement[], current: HTMLInputElement) => {
    inputs.forEach((other) => {
      const label = other.closest<HTMLElement>(".caldav-range-opt");
      if (label) label.classList.toggle("is-checked", other === current);
    });
  };

  const subWrap = modal.contentEl.querySelector<HTMLElement>("[data-sub]");
  const subOpts = modal.contentEl.querySelector<HTMLElement>("[data-sub-opts]");

  /**
   * 重建目标子选项区。
   *
   * 换范围就重建 DOM（选项文案随范围变：本周一 / 本月 1 日），比预渲染四种
   * 再靠 hidden 切换更省心 —— 也避免「上次选的 spanStart 留在新范围上」这种
   * 状态残留（week 的 spanStart 与 month 的 spanStart 是两回事）。
   */
  const renderSub = () => {
    if (!subWrap || !subOpts) return;
    const opts = targetOptionsOf(picked);
    // 只有一项时不渲染子选项区：问「插入到今天的日记 / 插入到今天的日记」没有意义
    if (opts.length < 2) {
      subWrap.hidden = true;
      subOpts.empty();
      pickedTarget = "today";
      return;
    }
    subWrap.hidden = false;
    subOpts.empty();
    opts.forEach((o, i) => {
      const label = subOpts.createDiv({ cls: `caldav-range-opt${i === 0 ? " is-checked" : ""}` });
      const input = label.createEl("input", { type: "radio" }) as HTMLInputElement;
      input.name = "caldav-target";
      input.value = o.key;
      input.checked = i === 0;
      const body = label.createDiv({ cls: "caldav-range-opt-body" });
      body.createDiv({ cls: "caldav-range-opt-label", text: o.label });
      body.createDiv({ cls: "caldav-range-opt-hint", text: o.hint });
      input.addEventListener("change", () => {
        if (!input.checked) return;
        pickedTarget = input.value as DiaryTarget;
        const inputs = Array.from(
          subOpts.querySelectorAll<HTMLInputElement>('input[name="caldav-target"]')
        );
        markChecked(inputs, input);
      });
    });
    pickedTarget = "today";
  };

  const rows = Array.from(
    modal.contentEl.querySelectorAll<HTMLInputElement>('input[name="caldav-range"]')
  );
  rows.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      picked = r.value as DiaryRange;
      markChecked(rows, r);
      renderSub();
    });
  });
  // 默认项（当日）初始即为选中态；「当日」只有一个目标，子选项区保持隐藏
  const firstLabel = rows[0]?.closest<HTMLElement>(".caldav-range-opt");
  firstLabel?.classList.add("is-checked");
  renderSub();

  const actions = modal.contentEl.createDiv({ cls: "caldav-range-actions" });
  const cancel = actions.createEl("button", { text: t("common.cancel") });
  cancel.addEventListener("click", () => modal.close());

  const ok = actions.createEl("button", {
    cls: "mod-cta",
    text: t("diary.confirm"),
  });
  ok.addEventListener("click", () => {
    const range = picked;
    const target = pickedTarget;
    modal.close();
    onPick(range, target);
  });

  // 焦点默认落在「取消」上：这一步会写文件，防误触更安全
  window.setTimeout(() => cancel.focus(), 0);

  // ⚠️ 必须显式 open() —— `new Modal(app)` 只构造，**不会自动显示**
  // （漏这行 = 点按钮毫无反应；2026-10-07 首次实测踩过）
  modal.open();
}