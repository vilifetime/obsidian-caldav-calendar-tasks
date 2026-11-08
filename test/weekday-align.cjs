/**
 * 回归锁：周 / 日视图星期名不错位 + 列表视图全量 i18n（2026-11-08 雄哥截图）
 *
 * 症状：英文周视图第一列（11/2 周一）没有星期名，Monday 跑到第二列（11/3），
 * 后面整行右移一列，周日无词；日视图同样错一天。
 *
 * 根因：view-week.ts 的星期名数组写成
 *   ["", "cal.weekdayMon", …, "cal.weekdaySat"]
 * 却用 `(getDay() + 6) % 7`（周一 = 0）取下标 —— 前置空串把整行推后一格。
 * 修法：7 项、下标 0 = 周一，且只存 i18n key，渲染时才 t()。
 *
 * 顺带把列表视图（原先写死中文）的星期名与空态/计数/类型标记一起纳入，
 * 防止「英文界面夹中文」在另一个视图里复活。
 *
 * 测试用 tsc 把 view-week.ts + view-list.ts 及其依赖编译成 CJS，
 * 用最小 DOM 替身**真实渲染**中英两套 HTML，再逐列核对表头；
 * 另加源码契约与变异自测防假绿。
 *
 * 用法：node test/weekday-align.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const outDir = path.join(ROOT, ".test-weekday");
fs.mkdirSync(outDir, { recursive: true });

// tsconfig 放进 .test-*/ 里（已 gitignore），跑完就删，不给 git 留垃圾。
const tsCfg = path.join(outDir, "tsconfig.json");
fs.writeFileSync(tsCfg, JSON.stringify({
  compilerOptions: {
    target: "ES2020",
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false,
    resolveJsonModule: true,
    baseUrl: "..",
    paths: { "@/*": ["src/*"] },
    outDir: ".",
    rootDir: "../src"
  },
  include: ["../src/ui/view-week.ts", "../src/ui/view-list.ts"]
}, null, 2));
try {
  execSync(`npx tsc -p "${tsCfg}"`, { cwd: ROOT, stdio: "pipe" });
} catch (e) {
  console.error("[weekday-align] tsc 编译失败:\n" + String(e.stdout || "") + String(e.stderr || ""));
  process.exit(1);
} finally {
  try { fs.unlinkSync(tsCfg); } catch { /* 已在忽略目录里，删不掉也不影响 */ }
}
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
{
  const stubDir = path.join(outDir, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "package.json"),
    JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" }));
  fs.writeFileSync(path.join(stubDir, "index.js"), `"use strict";\nexports.App = function App() {};\n`);
}

// "@/xxx" → 编译产物目录
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(outDir, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

// 最小 DOM 替身：dom.ts 走 DOMParser + DocumentFragment + replaceChildren。
// querySelector 返回 null 可跳过 view-week.ts 末尾的滚动补偿（那里要 window）。
globalThis.DocumentFragment = class DocumentFragment {
  constructor() { this.childNodes = []; }
  appendChild(n) { this.childNodes.push(n); return n; }
};
globalThis.DOMParser = class DOMParser {
  parseFromString(html) { return { body: { childNodes: [html] } }; }
};
function mkViewEl() {
  return {
    innerHTML: "",
    replaceChildren(frag) { this.innerHTML = (frag.childNodes || []).join(""); },
    querySelector() { return null; }
  };
}

const { initLocale } = require(path.join(outDir, "i18n", "index.js"));
const { renderWeekView } = require(path.join(outDir, "ui", "view-week.js"));
const { renderListView } = require(path.join(outDir, "ui", "view-list.js"));

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log("  [PASS]", name); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.log("  [FAIL]", name, "—", e.message); }
}

function mkCtx(cursor, viewMode = "week") {
  return {
    cursor,
    viewMode,
    sortMode: "start",
    store: {
      settings: {
        categories: [],
        calendars: [],
        showTodosInCalendar: true,
        showHolidaysCN: false,
        showLunarCN: false,
        showTermCN: false
      },
      getAll: () => []
    },
    sync: {}
  };
}
function mkItem(over = {}) {
  return {
    uid: over.uid || "u1",
    kind: over.kind || "event",
    calendarUrl: "c1",
    href: "/c1/u1.ics",
    summary: over.summary || "Standup",
    start: over.start || "2026-11-02T09:00:00",
    end: over.end || "2026-11-02T10:00:00",
    allDay: false
  };
}
function renderWeek(cursor, days) {
  const viewEl = mkViewEl();
  renderWeekView({ ctx: mkCtx(cursor), viewEl, occurrences: () => new Map() }, days);
  return viewEl.innerHTML;
}
function renderList(cursor, items) {
  const viewEl = mkViewEl();
  const m = new Map();
  for (const it of items) m.set(it, [it.start]);
  renderListView({ ctx: mkCtx(cursor, "week"), viewEl, occurrences: () => m });
  return viewEl.innerHTML;
}
/** 从真实渲染的 HTML 里按 DOM 顺序抽出「日期 → 星期名」 */
function weekHeads(html) {
  const re = /<div class="cal-wk-dayhead[^"]*" data-day="(\d{4}-\d{2}-\d{2})">([\s\S]*?)<\/div>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const wd = /<span class="cal-wk-wd">([^<]*)<\/span>/.exec(m[2]);
    out.push({ day: m[1], wd: wd ? wd[1] : null });
  }
  return out;
}
const EN_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ZH_DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WEEK = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

console.log("\n① 周视图：7 列与日期逐列对齐（英文）");
initLocale("en");
check("英文周表头 = Monday…Sunday，第一列不空、最后一列 Sunday", () => {
  const heads = weekHeads(renderWeek("2026-11-04", 7));
  assert.strictEqual(heads.length, 7, `应有 7 个日期头，实际 ${heads.length}`);
  assert.deepStrictEqual(heads.map((h) => h.day), WEEK, "日期列顺序不对");
  assert.deepStrictEqual(heads.map((h) => h.wd), EN_DAYS, "星期名与日期列错位");
  assert.ok(heads[0].wd, "第一列（周一）不得没有星期名 —— 截图里的症状");
  assert.strictEqual(heads[6].wd, "Sunday", "周日必须有词，不能被 Saturday 挤掉");
});
check("判据自测：把星期数组前插空串，逐列断言必须判红", () => {
  // 复刻旧实现：["", Mon, …, Sat] + (getDay()+6)%7
  const broken = ["", ...EN_DAYS.slice(0, 6)];
  const labels = WEEK.map((d) => broken[(new Date(`${d}T12:00:00`).getDay() + 6) % 7] || "");
  assert.notDeepStrictEqual(labels, EN_DAYS, "旧错位实现必须被逐列断言抓住");
  assert.strictEqual(labels[0], "", "旧实现里周一确实取到空串");
  assert.strictEqual(labels[1], "Monday", "旧实现里 Monday 确实落到 11/3");
});

console.log("\n② 日视图：任意星期几都对得上");
check("11/8（周日）显示 Sunday、11/2（周一）显示 Monday", () => {
  const sun = weekHeads(renderWeek("2026-11-08", 1));
  const mon = weekHeads(renderWeek("2026-11-02", 1));
  assert.strictEqual(sun.length, 1);
  assert.strictEqual(sun[0].day, "2026-11-08");
  assert.strictEqual(sun[0].wd, "Sunday", "旧实现会错成 Saturday");
  assert.strictEqual(mon[0].wd, "Monday", "旧实现会是空串");
});

console.log("\n③ 中文界面：周/日视图一字不改");
initLocale("zh");
check("中文周表头 = 周一…周日", () => {
  assert.deepStrictEqual(weekHeads(renderWeek("2026-11-04", 7)).map((h) => h.wd), ZH_DAYS);
});
check("中文日视图周日 = 周日", () => {
  assert.strictEqual(weekHeads(renderWeek("2026-11-08", 1))[0].wd, "周日");
});

console.log("\n④ 列表视图：星期名与全部文案按语言切换");
initLocale("en");
check("英文列表：日期组是 Monday，且整段 HTML 无中文", () => {
  const html = renderList("2026-11-04", [mkItem()]);
  assert.match(html, /cal-list-wd">Monday</, "列表分组的星期名没走字典");
  assert.ok(!CJK.test(html), "英文界面仍夹中文（空态/计数/类型/状态/全天/无标题）");
  assert.match(html, /1 item\(s\) in total/, "总计数未走字典");
  assert.match(html, /1 item\(s\)<\/span>/, "分组计数未走字典");
  assert.match(html, /title="event"/, "类型角标未走字典");
});
check("英文空态无中文", () => {
  const html = renderList("2026-11-04", []);
  assert.match(html, /cal-list-empty/);
  assert.ok(!CJK.test(html), "空态提示仍是中文");
});
initLocale("zh");
check("中文列表：周一 / 共 1 项 / 1 项 / 日程 全部保持原样", () => {
  const html = renderList("2026-11-04", [mkItem({ summary: "晨会" })]);
  assert.match(html, /cal-list-wd">周一</);
  assert.match(html, /共 1 项/);
  assert.match(html, /1 项<\/span>/);
  assert.match(html, /title="日程"/);
  assert.match(renderList("2026-11-04", []), /该时间段内暂无日程或待办/, "中文空态文案须与旧版一致");
});

console.log("\n⑤ 源码契约 + 变异自测");
const weekSrc = read("src/ui/view-week.ts");
const listSrc = read("src/ui/view-list.ts");
/** 取出 WEEKDAY_KEYS 数组里的 key 列表 */
function keysOf(src) {
  const m = /const WEEKDAY_KEYS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, "缺 WEEKDAY_KEYS 常量");
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}
function assertKeysOk(src) {
  const keys = keysOf(src);
  assert.strictEqual(keys.length, 7, "必须是 7 项（周一…周日）");
  assert.strictEqual(keys[0], "cal.weekdayMon", "下标 0 必须是周一，不能有前置空串");
  assert.strictEqual(keys[6], "cal.weekdaySun", "下标 6 必须是周日");
  assert.ok(!keys.includes(""), "数组里不得有空串");
  assert.ok(!keys.some((k) => CJK.test(k)), "不得写死中文星期名");
}
check("view-week.ts / view-list.ts 的星期数组都是 7 项、周一在首位", () => {
  assertKeysOk(weekSrc);
  assertKeysOk(listSrc);
});
check("两处都在渲染时用 t(WEEKDAY_KEYS[…]) 查表", () => {
  for (const src of [weekSrc, listSrc]) {
    assert.match(src, /t\(WEEKDAY_KEYS\[\(parseLocalStamp\(/,
      "星期名必须在渲染时查表，不能模块顶层求值");
  }
});
check("view-list.ts 不再有写死中文的 WEEK_LABELS", () => {
  assert.ok(!/const WEEK_LABELS = \["周一"/.test(listSrc), "又退回写死中文数组");
  assert.ok(!/暂无日程或待办|"全天"|"日程" : "待办"|共 \$\{total\} 项/.test(listSrc),
    "列表视图仍有中文硬编码文案");
});
check("判据自测：把前置空串插回数组，契约断言必须判红", () => {
  const broken = weekSrc.replace("const WEEKDAY_KEYS = [", 'const WEEKDAY_KEYS = ["",');
  assert.throws(() => assertKeysOk(broken), /7 项|周一|空串/, "前置空串必须被契约抓住");
});
check("判据自测：把中文字典写死回源码，契约断言必须判红", () => {
  const broken = listSrc.replace('"cal.weekdayMon"', '"周一"');
  assert.throws(() => assertKeysOk(broken), /不得写死中文|周一/, "中文硬编码必须被契约抓住");
});

console.log("\n⑥ 作废译名两端一致（思源 Cancelled 为准）");
check("en_US editor.void = Cancelled，且不等于 common.cancel", () => {
  const en = JSON.parse(read("src/i18n/en_US.json"));
  const sy = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "SiYuanCalDAV", "src/i18n/en_US.json"), "utf8"));
  assert.strictEqual(en["editor.void"], "Cancelled");
  assert.strictEqual(en["editor.void"], sy["作废"]);
  assert.notStrictEqual(en["editor.void"], en["common.cancel"]);
});

console.log(`\nweekday-align: ${pass} PASS / ${fails.length} FAIL`);
if (fails.length) { console.error(fails.join("\n")); process.exitCode = 1; }
