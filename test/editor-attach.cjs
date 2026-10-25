/**
 * 回归测试：待办编辑器「备注附件」标签页（2026-10-20 第三批移植）。
 *
 * 背景：Obsidian 侧附件功能此前整体为零（编辑器只有纯备注标签页）。本批从思源
 * 同构移植：备注+附件两张卡片、上传/外链、提示语实时刷新、大文件确认栏
 * （建议口吻三态）、下载按钮、icons、CSS、设置项两个上限。
 *
 * 为什么写成源码级断言而不是 jsdom 交互测试：
 * 编辑器是 Obsidian Modal，实例化需要完整的 obsidian API mock；而本批要防的
 * 核心风险是「结构被改回去」——标签页分流、两级闸门顺序、确认栏口吻、CSS 配套
 * 这些恰恰都是源码里的固定结构。交互行为（点上传→读文件→进 atts）由
 * attach-ics.cjs 的序列化 round-trip 从另一侧覆盖。
 *
 * 用法：node test/editor-attach.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const editor = read("src/ui/editor.ts");
const icons = read("src/ui/icons.ts");
const css = read("src/styles.css");
const settingsTab = read("src/ui/settings-tab.ts");
const types = read("src/core/types.ts");
const zh = JSON.parse(read("src/i18n/zh_CN.json"));
const en = JSON.parse(read("src/i18n/en_US.json"));

let pass = 0;
const fail = [];
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
}

/* ── ① 标签页文案分流：待办=备注附件，日程=日程备注 ─────────────────
 * 雄哥原话：「待办第二个标签叫『备注附件』（日程仍『日程备注』）」。
 * 判据是 i18n key 的值，不是 editor.ts 里的模板串（那里只有 key 名）。 */
check("待办第二个标签叫「备注附件」", () => {
  assert.strictEqual(zh["editor.tabTodoNote"], "备注附件");
  assert.strictEqual(en["editor.tabTodoNote"], "Note & attachments");
});
check("日程第二个标签仍叫「日程备注」", () => {
  assert.strictEqual(zh["editor.tabEventNote"], "日程备注");
  assert.strictEqual(en["editor.tabEventNote"], "Event note");
});

/* ── ② 附件区只在待办下渲染 ─────────────────────────────────────
 * `isTodo ? ... : ""` 三元包裹是唯一保证：日程打开编辑器时 DOM 里不该有
 * data-attach 节点，否则 bindEvents 会给日程也挂上附件交互。 */
check("附件卡片由 isTodo 三元门控", () => {
  assert.ok(
    /isTodo\s*\n?\s*\?\s*`<div class="caldav-section caldav-section--card caldav-attach" data-attach>/.test(editor),
    "附件卡片必须由 isTodo 三元包裹（日程没有附件区）"
  );
});
check("备注卡片有无门控都在（两种条目都有备注）", () => {
  assert.ok(editor.includes('<div class="caldav-section-title"><span class="caldav-section-icon">${icons.doc}</span>${t("editor.noteTitle")}</div>'));
});

/* ── ③ data-attach-* 钩子齐全 ─────────────────────────────────── */
for (const hook of [
  "data-attach-rows",
  "data-attach-upload",
  "data-attach-add",
  "data-attach-file",
  "data-attach-hint",
  "data-attach-msg",
  "data-attach-uri",
  "data-attach-del",
  "data-attach-dl",
  "data-attach-i",
  "data-attach-confirm",
]) {
  check(`钩子 ${hook} 存在`, () => assert.ok(editor.includes(hook), `editor.ts 里找不到 ${hook}`));
}

/* ── ④ 两级闸门：硬拒在前、软确认在后 ───────────────────────────
 * 顺序反了会先弹确认栏再拒，用户白点一次；只写软确认忘了硬拒则会发出
 * 注定 413 的请求。 */
check("硬上限拒绝在软确认之前", () => {
  const hard = editor.indexOf("file.size > maxBytes");
  const soft = editor.indexOf("file.size > ATTACH_SIZE_WARN");
  assert.ok(hard > 0 && soft > 0, "两处闸门都必须存在");
  assert.ok(hard < soft, "硬上限（超过设置值直接拒）必须排在软确认（800KB 建议）之前");
});
check("硬拒走 is-error 红字并 return（不发请求）", () => {
  assert.ok(/file\.size > maxBytes\)[\s\S]{0,220}setMsg\(t\("editor\.attachTooLarge"[\s\S]{0,80},\s*true\);/.test(editor));
});
check("软确认只由确认栏说话，挑选侧不预发 setMsg 文件信息", () => {
  // 大文件分支里 setMsg("") 清场后直接进确认栏，不再预发一段说明
  assert.ok(/file\.size > ATTACH_SIZE_WARN\)[\s\S]{0,400}setMsg\(""\);[\s\S]{0,200}confirmLargeFile\(/.test(editor));
});

/* ── ⑤ 提示语实时刷新 ─────────────────────────────────────────
 * 2026-10-15 雄哥报「改了 7M 还提示 5M」：开弹窗时的上限快照会过期，
 * 挑选文件这一刻必须按当前设置重写。 */
check("挑选文件时刷新提示语（按当前设置）", () => {
  // 上限 2026-10-26 下沉到账户：必须按**条目所属账户**取（accOfItem()），
  // 写成 ctx.store.settings 的话多账户下 A 账户的条目会拿 B 账户的上限去卡。
  assert.ok(editor.includes("const maxBytes = attachSizeMaxBytes(accOfItem());"));
  assert.ok(editor.includes("refreshHint();"));
  assert.ok(
    /const refreshHint = \(\): void => \{[\s\S]{0,300}attachHintHtml\(attachSizeMaxBytes\(accOfItem\(\)\)[\s\S]{0,120}\)/.test(editor)
  );
});

/* ── ⑥ 确认栏「建议」口吻 ─────────────────────────────────────
 * 2026-10-15 雄哥：上限 7M 没到还被提醒，确认栏不能像指责用户超限。
 * 文案必须是「建议不超过」而不是「超过 N」。 */
check("确认文案是建议口吻（含「建议不超过」）", () => {
  assert.ok(/建议不超过/.test(zh["editor.attachConfirm"]), "确认文案应为「附件建议不超过 {warn}」口吻");
  // 负回顾排除「不超过」——「建议不超过 {warn}」正是期望口吻，
  // 要禁的是把它写成「超过 {warn}」的违规说法。
  assert.ok(!/([^不]|^)超过\s*\{warn\}/.test(zh["editor.attachConfirm"]), "确认栏不许写「超过 N」的违规口吻");
  assert.ok(/recommended to stay under/.test(en["editor.attachConfirm"]));
});
check("硬拒文案才用「超过」口吻（红色错误的地位）", () => {
  assert.ok(/超过单文件上限/.test(zh["editor.attachTooLarge"]));
});
check("确认栏左边框走 accent 中性色，不用 danger", () => {
  // 从确认栏注释文字本身起截（不从文件第一个 /* 起，否则整段 CSS 都进 match，
  // is-error 规则里的 --caldav-danger 会让断言恒假）
  const start = css.indexOf("大文件上传前的行内确认栏");
  assert.ok(start > 0, "CSS 里应找到确认栏注释");
  const block = css.slice(start, css.indexOf(".caldav-attach-confirm-text", start));
  const end = block.indexOf("}", block.indexOf(".caldav-attach-confirm {"));
  const rule = block.slice(0, end + 1);
  assert.ok(/border-left: 3px solid var\(--caldav-accent\)/.test(rule), "确认栏左边框应为 accent 中性色");
  assert.ok(!/--caldav-danger/.test(rule), "确认栏不许用 danger 红（红色只留给硬上限拒绝）");
});

/* ── ⑦ collect 写回语义 ─────────────────────────────────────── */
check("保存时过滤空行（既没 uri 又没 b64）", () => {
  assert.ok(
    /if \(attachList\) \{[\s\S]*?it\.attachments = attachList[\s\S]*?\.filter\(\(a\) => \(a\.uri \|\| ""\)\.trim\(\) \|\| \(a\.b64 \|\| ""\)\.trim\(\)\);/.test(editor),
    "「添加链接」后不填内容就保存会留空壳附件"
  );
});
check("iCloud 内联件不在 collect 剥掉（交同步层托管上传）", () => {
  assert.ok(
    !/!\(isIcloud && a\.b64\)/.test(editor),
    "collect 不能再按 isIcloud 剥 b64：iCloud 托管上传依赖同步层收到内联件再上传改写成托管 URI"
  );
});
check("attachList 为 undefined（日程）时不碰 it.attachments", () => {
  assert.ok(/let attachList: CalAttachment\[\] \| undefined;/.test(editor));
  assert.ok(/const attachRows = el\.querySelector<HTMLElement>\("\[data-attach-rows\]"\);/.test(editor));
});

/* ── ⑧ 二进制行不把 base64 塞进 DOM ───────────────────────────
 * 800KB 文件 = 1MB 字符串进 attribute，编辑器 DOM 难以为继。 */
check("二进制行只显示图标+文件名+大小，base64 留在 atts 数组", () => {
  assert.ok(editor.includes("caldav-attach-bin-name\">${escape(a.name || \"附件\")}"));
  assert.ok(editor.includes("caldav-attach-bin-size\">${escape(sizeText(b64Bytes(a.b64)))}"));
  assert.ok(!/data-attach-b64|value="\$\{a\.b64/.test(editor), "base64 不许进 DOM 属性");
});

/* ── ⑨ 下载按钮与净化 ───────────────────────────────────────── */
check("二进制行带下载按钮（2026-10-19 雄哥报「已有附件没法下载」）", () => {
  assert.ok(editor.includes("data-attach-dl"));
  assert.ok(/function downloadAttachment\(a: CalAttachment\): void/.test(editor));
});
check("下载文件名净化（路径分隔符/通配符/控制字符）", () => {
  assert.ok(/function safeAttachName\(name: string\): string[\s\S]{0,200}\[\\\\\/:\*\?"<>\|\\u0000-\\u001f\]/.test(editor));
});
check("编辑器无裸定时器（Obsidian 规矩：window. 前缀）", () => {
  const bare = /(^|[^.\w])setTimeout\(/.test(editor);
  assert.ok(!bare, "editor.ts 不许出现裸 setTimeout（测试套里有全仓断言，这里是提前提示）");
  assert.ok(editor.includes("window.setTimeout(() => URL.revokeObjectURL(url), 10000)"));
});

/* ── ⑩ icons：paperclip / download 存在且不写 width/height ────── */
check("icons 有 paperclip 与 download", () => {
  assert.ok(/paperclip: svg\(/.test(icons));
  assert.ok(/download: svg\(/.test(icons));
});
check("新图标同样不写 width/height 属性（宿主坑 2）", () => {
  const paperclip = /paperclip: svg\('([^']*)'/.exec(icons);
  const download = /download: svg\('([^']*)'/.exec(icons);
  for (const [name, m] of [["paperclip", paperclip], ["download", download]]) {
    assert.ok(m, `${name} 图标应存在`);
    assert.ok(!/width=|height=/.test(m[1]), `${name} 不许在 svg 上写 width/height（Obsidian 宿主全局规则会赢）`);
  }
});

/* ── ⑪ CSS 配套：svg 尺寸兜底 ─────────────────────────────────
 * icons.ts 不写尺寸，每个容器 CSS 必须配 svg{width/height}，
 * 漏了浏览器按 100% 宽算 —— 回形针巨化占满整行（2026-10-14 雄哥截图）。 */
check("bin 行配了 svg 尺寸（14px）", () => {
  assert.ok(/\.caldav-attach-bin svg \{ flex: 0 0 auto; width: 14px; height: 14px; \}/.test(css));
});
check("bin 行按钮小一档（正文才 12px，36px 会撑高整行）", () => {
  assert.ok(/\.caldav-attach-row--bin \.caldav-add-btn,\r?\n\.caldav-attach-row--bin \.caldav-attach-del \{ height: 26px; padding: 0 9px;/.test(css));
});
check("链接行按钮与输入框等高 36px、图标 16px（2026-10-23 雄哥截图）", () => {
  assert.ok(/\.caldav-attach-row \.caldav-attach-input \{ height: 36px;/.test(css));
  assert.ok(/\.caldav-attach-row \.caldav-add-btn \{ height: 36px;/.test(css));
  assert.ok(/\.caldav-attach-row \.caldav-add-btn svg \{ width: 16px; height: 16px; \}/.test(css));
});
check("删除按钮带文字且走危险色（2026-10-23 雄哥要求，不再纯图标）", () => {
  assert.ok(/caldav-add-btn caldav-attach-del/.test(editor), "editor.ts 删除按钮要用 add-btn 版式 + attach-del 类");
  assert.ok(editor.includes('${t("editor.attachDelete")}'), "删除按钮要有文字");
  assert.ok(/\.caldav-attach-del \{ color: var\(--caldav-danger\); \}/.test(css), "删除按钮要配危险色规则");
});
for (const rule of [".caldav-attach {", ".caldav-attach-rows {", ".caldav-attach-row--bin {", ".caldav-attach-hint {", ".caldav-attach-msg.is-error {"]) {
  check(`CSS 规则 ${rule} 存在`, () => assert.ok(css.includes(rule), `styles.css 里找不到 ${rule}`));
}

/* ── ⑫ 设置项：两个上限在**账户的策略段** ──────────────────────
 * 2026-10-26 雄哥：附件/ICS 体积上限是**服务器特性**（Radicale 10MB /
 * PHP 8MB / iCloud 另有一套），不同服务器各配各的 —— 已从全局「同步」段下沉
 * 到每个账户的「策略」段，key 也带账户前缀（acc.<id>.xxx）。 */
check("设置页声明 attachSizeMaxMB（账户键）", () => {
  assert.ok(/num\(pre \+ "attachSizeMaxMB", 5\)/.test(settingsTab), "账户策略段应声明附件大小限制（默认 5）");
});
check("设置页声明 icsSizeMaxMB（账户键）", () => {
  assert.ok(/num\(pre \+ "icsSizeMaxMB", 10\)/.test(settingsTab), "账户策略段应声明单个 ICS 限制（默认 10）");
});
check("两个上限项挂在账户策略分组里（groupStrategy 之内）", () => {
  // 从 groupStrategy 标题截到下一个分组标题（第一个 ] 会撞上 aliases 数组，
  // 用分组边界更稳）
  const start = settingsTab.indexOf('heading: t("settings.groupStrategy")');
  assert.ok(start > 0, "应找到策略分组");
  const nextGroup = settingsTab.indexOf('type: "group"', start + 10);
  const group = settingsTab.slice(start, nextGroup > 0 ? nextGroup : undefined);
  assert.ok(/attachSizeMaxMB/.test(group) && /icsSizeMaxMB/.test(group), "两个上限项都该在账户的策略分组内");
  // 反向钉死：全局同步段不许再留这两个上限（放回去 = 所有服务器共用一个值）
  const syncStart = settingsTab.indexOf('heading: t("settings.groupSync")');
  assert.ok(syncStart > 0, "应找到同步分组");
  const syncNext = settingsTab.indexOf('type: "group"', syncStart + 10);
  const syncGroup = settingsTab.slice(syncStart, syncNext > 0 ? syncNext : undefined);
  assert.ok(!/attachSizeMaxMB/.test(syncGroup) && !/icsSizeMaxMB/.test(syncGroup), "同步段不该再留这两个上限（已下沉到账户）");
});
check("types.ts 仍有 CalAttachment 与两个设置字段（防回退）", () => {
  assert.ok(/export interface CalAttachment/.test(types));
  assert.ok(/attachSizeMaxMB\?: number/.test(types));
  assert.ok(/icsSizeMaxMB\?: number/.test(types));
});

/* ── ⑬ i18n 两侧键集一致 ─────────────────────────────────────
 * 套件里有 i18n-dict.cjs 做全量校验，这里只钉本批新增键。 */
const attachKeys = [
  "editor.noteTitle", "editor.attachTitle", "editor.attachUpload", "editor.attachAddLink",
  "editor.attachDownload", "editor.attachDownloadTitle", "editor.attachDelete", "editor.attachDeleteOne",
  "editor.attachEmpty", "editor.attachHint1", "editor.attachHint2", "editor.attachConfirm",
  "editor.attachConfirmOk", "editor.attachReading", "editor.attachAdded",
  "editor.attachCancelled", "editor.attachDownloaded", "editor.attachTooLarge",
  "settings.attachLimit", "settings.attachLimitDesc", "settings.icsLimit", "settings.icsLimitDesc",
];
for (const k of attachKeys) {
  check(`i18n ${k} 中英都有`, () => {
    assert.ok(typeof zh[k] === "string" && zh[k].length > 0, `zh 缺 ${k}`);
    assert.ok(typeof en[k] === "string" && en[k].length > 0, `en 缺 ${k}`);
  });
}
check("占位符两侧一致（{name}/{size}/{max}/{warn}）", () => {
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const k of ["editor.attachHint2", "editor.attachConfirm", "editor.attachReading", "editor.attachAdded", "editor.attachDownloaded", "editor.attachTooLarge"]) {
    assert.strictEqual(ph(zh[k]), ph(en[k]), `${k} 占位符不一致：zh=${ph(zh[k])} en=${ph(en[k])}`);
  }
});

/* ── 结果 ─────────────────────────────────────────────────── */
if (fail.length) {
  console.log(`\n[FAIL] ${fail.length} 个用例失败`);
  for (const f of fail) console.log("  - " + f);
  process.exit(1);
}
console.log(`[PASS] editor-attach: ${pass} 项全部通过`);
