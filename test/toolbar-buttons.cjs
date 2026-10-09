/**
 * 回归测试：面板工具栏按钮的尺寸与手动同步按钮（2026-10-09 新增）。
 *
 * 背景：雄哥反馈「新建按钮和日历筛选、视图切换等按钮高度不一致，或者没有居中对齐」。
 * 根因是**宿主的 button 规则**（Obsidian 的 `.theme-* button`、思源 base.css）
 * 给了 `height`/`line-height`，而 `.caldav-btn` 只靠 padding 撑高度、没写 height，
 * 于是文字按钮（约 30px）比定高的 `.caldav-icon-btn`（34px）矮一截，且两者顶对齐。
 *
 * 为什么是源码级断言：按钮等高是**纯 CSS 几何**，jsdom 不做布局。
 * 真正量几何的活儿在思源侧的 test/verify-toolbar-btns.mjs（真浏览器 + CDP），
 * 那边已经把「文字按钮与图标按钮等高、顶底边对齐、内容垂直居中」钉住了。
 * 本文件守的是**另一半**：CSS 里那几条声明不许被改回去，以及同步按钮不许消失。
 *
 * 用法：node test/toolbar-buttons.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const css = read("src/styles.css");
const panel = read("src/ui/panel.ts");
const main = read("src/main.ts");
const store = read("src/core/store.ts");

/** 先剥掉 CSS 注释：注释里也会出现 .caldav-btn / { / }，不剥会干扰定位与括号配对 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 取一条 CSS 规则的声明块（选择器 → 声明文本），用于精确判断「某条声明在不在这条规则里」。
 *
 * ⚠️ 这里**不能**用 `indexOf(selector)` 再往后找第一个 `{`：
 * 调用方传进来的选择器通常已自带 `{`（如 ".caldav-btn {"），
 * 跳过它之后找到的是**下一条规则**的左括号（.caldav-btn → .caldav-btn:hover），
 * 于是断言在错误的声明块上跑 —— 本文件第一版就栽在这里，
 * 明明 CSS 里写了 height 却报「.caldav-btn 必须定高」。
 *
 * 正确做法：剥注释后按「行首（可选空白）出现该选择器 + 紧跟 {」精确锚定，
 * 再做括号配对。last=true 取**最后一条**同名规则（后写的覆盖先写的，
 * 比如 .caldav-icon-btn 有 26px 与 34px 两版，生效的是后者）。
 */
function rule(selector, options = {}) {
  const opts = typeof options === "string" ? { source: options } : options;
  const { source = css, last = false } = opts;
  const src = stripComments(source);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]*${escaped}[ \\t]*\\{`, "gm");
  const hits = [...src.matchAll(re)];
  if (!hits.length) return null;
  const hit = last ? hits[hits.length - 1] : hits[0];
  const open = hit.index + hit[0].length - 1;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  return null;
}

/* ── ① 文字按钮必须显式定高 ─────────────────────────────────────
 * 只写 padding 的话，宿主的 height 会赢 —— 那正是本次的 bug。
 */
const btnRule = rule(".caldav-btn");
assert.ok(btnRule, "应存在 .caldav-btn 规则");
assert.ok(
  /height:\s*var\(--caldav-btn-h\)/.test(btnRule),
  ".caldav-btn 必须用 height: var(--caldav-btn-h) 定高（只靠 padding 会被宿主 button 的 height 压矮）"
);
assert.ok(
  /box-sizing:\s*border-box/.test(btnRule),
  ".caldav-btn 必须 border-box（否则高度还会被上下边框撑大 2px）"
);
assert.ok(
  !/padding:\s*7px/.test(btnRule),
  ".caldav-btn 竖向 padding 应交由固定高度 + flex 居中管；写回 7px 会与 height 打架"
);

/* ── ② 图标按钮共用同一个高度变量 + border-box ───────────────────
 * 取**最后**一条 .caldav-icon-btn：文件里有 26px 与 34px 两版，后写的生效。
 */
const iconRule = rule(".caldav-icon-btn", { last: true });
assert.ok(iconRule, "应存在 .caldav-icon-btn 规则（取最后一条，即生效的那条）");
assert.ok(
  /height:\s*var\(--caldav-btn-h\)/.test(iconRule),
  ".caldav-icon-btn 必须与 .caldav-btn 共用 --caldav-btn-h（两处各写各的就会差几像素）"
);
assert.ok(
  /box-sizing:\s*border-box/.test(iconRule),
  ".caldav-icon-btn 必须 border-box（34px + 上下各 1px 边框 = 36px，会比文字按钮高 2px）"
);

/* ── ③ 高度变量必须真的定义了 ─────────────────────────────────── */
assert.ok(
  /--caldav-btn-h:\s*34px/.test(css),
  ".caldav-root 里必须定义 --caldav-btn-h（否则 var() 解析为空，height 失效退回 auto）"
);

/* ── ④ 工具栏这一排要居中，且 hover 不许上浮 ───────────────────── */
const rightRule = rule(".caldav-toolbar-right");
assert.ok(
  /align-items:\s*center/.test(rightRule || ""),
  ".caldav-toolbar-right 必须 align-items: center（否则组内顶对齐，视觉上没居中）"
);
const wrapRule = rule(".caldav-calfilter-wrap");
assert.ok(
  /align-items:\s*center/.test(wrapRule || ""),
  ".caldav-calfilter-wrap 必须居中：它是 flex 项，不设 align 的话里面的按钮会被拉高"
);
assert.ok(
  /\.caldav-toolbar \.caldav-icon-btn:hover[\s\S]*?transform:\s*none/.test(css),
  "工具栏按钮的 hover 不许上浮（一排按钮里唯一浮起来的那个看着就像没对齐）"
);

/* ── ⑤ 手动同步按钮：DOM + 交互 + 入口回调，三处都要在 ─────────── */
// 只看工具栏右侧那一段（"prev/today/next" 在左边，不相干）。
// 逐个抓 data-action 的**出现顺序**，比对「同步按钮紧跟在新建后面」——
// 用 slice(newIdx, syncIdx) 再正则找 data-action 是错的：切片**包含 new 自身**，
// 那条 data-action="new" 必然命中，整条断言恒假。
const toolbarRight = panel.slice(
  panel.indexOf('class="caldav-toolbar-right"'),
  panel.indexOf('class="caldav-calfilter-wrap"')
);
assert.ok(toolbarRight.length > 0, "应能找到工具栏右侧这一段");
const rightOrder = [...toolbarRight.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
assert.deepStrictEqual(
  rightOrder,
  ["new", "sync-now"],
  "工具栏右侧在「新建」与筛选按钮之间只该有同步按钮，且顺序必须是 新建 → 同步"
);

for (const needle of [
  'data-action="sync-now"',
  'title="${t("toolbar.syncNow")}',
  'aria-label="${t("toolbar.syncNow")}',
  'classList.add("is-syncing")',
  'classList.remove("is-syncing")',
  "syncBtn.disabled = true",
  "syncBtn.disabled = false",
  // 防重复点击的闸（分两行写：同步中 return、没注入 syncNow 也 return）
  "if (syncBusy) return",
  "if (!ctx.syncNow) return",
  "syncBusy = true",
]) {
  assert.ok(panel.includes(needle), `面板同步按钮应包含：${needle}`);
}

assert.ok(
  /syncNow:\s*\(\)\s*=>\s*this\.runSync\(true\)/.test(main),
  "ctx.syncNow 必须接到入口的 runSync(true)（手动同步要出提示，且状态栏/视图/提醒统一刷新）"
);
assert.ok(
  /isSyncing:\s*\(\)\s*=>\s*this\.inflight !== null/.test(main),
  "ctx.isSyncing 必须报告真实同步态"
);

/* ── ⑥ 同步按钮的视觉反馈：旋转 + 禁用 ────────────────────────── */
assert.ok(
  /\.caldav-icon-btn\.is-syncing svg\s*\{[^}]*animation:\s*caldav-btn-spin/.test(css),
  "同步中必须有旋转动画（否则点了没反馈，用户不知道在同步）"
);
assert.ok(
  /@keyframes caldav-btn-spin/.test(css),
  "必须定义 caldav-btn-spin 关键帧"
);
assert.ok(
  /\.caldav-icon-btn:disabled\s*\{[^}]*opacity:\s*0?\.6/.test(css),
  "禁用态要有透明度变化（同步中按钮应变淡）"
);

/* ── ⑦ i18n 键不许缺（缺了 title 就是原始 key） ───────────────── */
for (const dict of ["src/i18n/zh_CN.json", "src/i18n/en_US.json"]) {
  const raw = read(dict);
  assert.ok(/"toolbar\.syncNow"/.test(raw), `${dict} 缺 toolbar.syncNow`);
  const m = /"toolbar\.syncNow":\s*"([^"]+)"/.exec(raw);
  assert.ok(m && m[1].trim().length > 0, `${dict} 的 toolbar.syncNow 不能为空串`);
}

/* ── ⑧ 恢复配置后必须真的同步 ───────────────────────────────────
 * 见 config-backup.cjs 的细断言，这里只钉住「并发同步不许丢弃请求」——
 * 丢掉的话，恢复后紧接着的首轮同步正好会被启动时的自动同步顶掉。
 */
assert.ok(
  /if \(this\.inflight\)[\s\S]{0,200}await this\.inflight/.test(main),
  "runSync 遇到已有同步必须 await 等它跑完，不能静默丢弃"
);
assert.ok(
  /adoptBackup\([^)]*\): Promise<void>/.test(store),
  "store.adoptBackup 必须返回 Promise<void>（内部要等异步解密，调用方要能 await）"
);

console.log("✓ 工具栏按钮测试通过");
console.log("  - 文字/图标按钮共用 --caldav-btn-h: 34px + border-box，严格等高");
console.log("  - 工具栏右侧与筛选浮层包裹层居中，hover 不上浮");
console.log("  - 手动同步按钮在「新建」右侧，带旋转 + 禁用反馈、防连点");
console.log("  - ctx.syncNow / isSyncing 已接线到入口 runSync");
console.log("  - i18n 中英文 toolbar.syncNow 齐备");
console.log("  - adoptBackup 可 await，runSync 并发排队不丢弃");