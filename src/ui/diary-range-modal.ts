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

interface Option {
  key: DiaryRange;
  label: string;
  hint: string;
}

/** 顺序即显示顺序；第一项同时是默认项 */
const OPTIONS: Option[] = [
  { key: "day", label: "当日", hint: "今天的日程与待办" },
  { key: "week", label: "本周", hint: "本周一至今天（自然周，周一起算）" },
  { key: "month", label: "本月", hint: "本月 1 日至今天" },
  { key: "all", label: "所有", hint: "全部历史与未来的条目，写入今日日记" },
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
  modal.setTitle("插入日记");
  modal.modalEl.addClass("caldav-diary-range-modal");

  setHtml(
    modal.contentEl,
    `
<div class="caldav-range">
  <div class="caldav-range-lead">要把哪个范围的日程与待办写入日记？</div>
  <fieldset class="caldav-range-opts">
    <legend class="sr-only">插入范围</legend>
    ${OPTIONS.map(
      (o) => `
    <label class="caldav-range-opt">
      <input type="radio" name="caldav-range" value="${o.key}"${o.key === "day" ? " checked" : ""}/>
      <span class="caldav-range-opt-body">
        <span class="caldav-range-opt-label">${o.label}</span>
        <span class="caldav-range-opt-hint">${o.hint}</span>
      </span>
    </label>`
    ).join("")}
  </fieldset>
</div>`
  );

  modal.contentEl.querySelectorAll<HTMLInputElement>('input[name="caldav-range"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) picked = r.value as DiaryRange;
    });
  });

  const actions = modal.contentEl.createDiv({ cls: "caldav-range-actions" });
  const cancel = actions.createEl("button", { text: "取消" });
  cancel.addEventListener("click", () => modal.close());

  const ok = actions.createEl("button", {
    cls: "mod-cta",
    text: "确认插入",
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