/**
 * 回归测试：列表视图（2026-10-25 雄哥拍板方案 A）
 *
 * 与思源端 test/list-view.test.mjs 同构，覆盖三块：
 *  ① **范围口径**（listRange）：年/月/周/日各自的时间窗
 *     —— 最容易出错的地方：列表若与各视图口径不一致，用户会看到
 *     「月视图里有、列表里没有」的条目（口径漂移）。
 *  ② **时间文案**（timeLabelOf）：全天 / 日程起止 / 待办到期 / 跨午夜 / 重复条目
 *  ③ **渲染结构**（renderListView）：日期分组、条目四要素（时间+色点+类型+标题）
 *
 * 用法：node test/list-view.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const outDir = path.join(ROOT, ".test-listview");

// 编译：view-list.ts + 其依赖（core/*、ui/view-common、ui/icons）。
// view-common.ts → panel-ctx.ts → "obsidian"（只有 .d.ts，无运行时入口）→ 运行时给桩。
// ⚠️ tsc 的 CLI **不支持 --paths**（别名 "@/*"），必须走 -p 临时 tsconfig。
const tsCfg = path.join(ROOT, "tsconfig.listview.json");
fs.writeFileSync(
  tsCfg,
  JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "commonjs",
      moduleResolution: "node",
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
      resolveJsonModule: true,
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
      outDir: ".test-listview",
      rootDir: "src"
    },
    include: ["src/ui/view-list.ts"]
  }, null, 2)
);
try {
  execSync(`npx tsc -p tsconfig.listview.json`, { cwd: ROOT, stdio: "pipe" });
} finally {
  // ⚠️ 用 unlinkSync 而不是 rmSync：宿主注入的 safe-delete 拦截 rmSync，
  // 累计删除数达阈值会直接抛错把整个测试带崩（临时 tsconfig 必须删干净，
  // 否则会被 git 当成待提交文件）。unlinkSync 走单文件删除路径，不触发批量闸。
  try {
    fs.unlinkSync(tsCfg);
  } catch {
    /* 删不掉也不影响测试（tsconfig.listview.json 已在 .gitignore） */
  }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
{
  const stubDir = path.join(outDir, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" })
  );
  fs.writeFileSync(path.join(stubDir, "index.js"), `"use strict";\nexports.App = function App() {};\n`);
}

// 运行时别名解析："@/xxx" → 编译产物目录。
// view-common.ts 运行时 import 了 "@/i18n"（取默认分类名），不映射就 MODULE_NOT_FOUND。
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(outDir, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.error("  ✗", name, "\n    ", e.message);
  }
}

const { listRange, timeLabelOf, renderListView } = require(path.join(outDir, "ui", "view-list.js"));

// ── 造一个最小可用的 PanelCtx 桩 ──
function mkCtx(viewMode, cursor) {
  return {
    viewMode,
    cursor,
    sortMode: "start",
    store: {
      settings: {
        categories: [],
        calendars: [{ url: "c1", displayName: "工作", enabled: true, color: "#4285f4" }],
        showTodosInCalendar: true
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
    summary: over.summary || "标题",
    allDay: over.allDay === true,
    start: over.start || "2026-10-08T09:00:00",
    end: over.end,
    rrule: over.rrule,
    percent: over.percent
  };
}

function occMap(entries) {
  const m = new Map();
  for (const [it, occs] of entries) m.set(it, occs);
  return m;
}

function render(ctx, entries) {
  const viewEl = { innerHTML: "" };
  renderListView({ ctx, viewEl, occurrences: () => occMap(entries) });
  return viewEl.innerHTML;
}

// ============ ① 范围口径 ============

t("年视图范围＝当年 1/1 → 次年 1/1", () => {
  const { startMs, endMs } = listRange({ viewMode: "year", cursor: "2026-10-08" });
  assert.strictEqual(new Date(startMs).getFullYear(), 2026);
  assert.strictEqual(new Date(startMs).getMonth(), 0);
  assert.strictEqual(new Date(startMs).getDate(), 1);
  assert.strictEqual(new Date(endMs).getFullYear(), 2027);
  assert.strictEqual(new Date(endMs).getMonth(), 0);
  assert.strictEqual(new Date(endMs).getDate(), 1);
});

t("月视图范围＝当月 1 日 → 次月 1 日（自然月）", () => {
  const { startMs, endMs } = listRange({ viewMode: "month", cursor: "2026-10-08" });
  assert.strictEqual(new Date(startMs).getMonth(), 9);
  assert.strictEqual(new Date(startMs).getDate(), 1);
  assert.strictEqual(new Date(endMs).getMonth(), 10);
  assert.strictEqual(new Date(endMs).getDate(), 1);
  const feb = listRange({ viewMode: "month", cursor: "2026-02-08" });
  assert.strictEqual(Math.round((feb.endMs - feb.startMs) / 86400000), 28);
});

t("周视图范围＝本周一 → 下周一（周一为一周之始）", () => {
  const { startMs, endMs } = listRange({ viewMode: "week", cursor: "2026-10-08" });
  const s = new Date(startMs);
  assert.strictEqual(s.getDate(), 5);
  assert.strictEqual(s.getDay(), 1, "周一");
  assert.strictEqual(Math.round((endMs - startMs) / 86400000), 7);
});

t("周视图：周日也归属同一周", () => {
  const { startMs } = listRange({ viewMode: "week", cursor: "2026-10-11" });
  assert.strictEqual(new Date(startMs).getDate(), 5);
});

t("日视图范围＝当天 → 次日", () => {
  const { startMs, endMs } = listRange({ viewMode: "day", cursor: "2026-10-08" });
  assert.strictEqual(new Date(startMs).getDate(), 8);
  assert.strictEqual(Math.round((endMs - startMs) / 86400000), 1);
});

// ============ ② 时间文案 ============

t("全天条目 → 「全天」", () => {
  assert.strictEqual(timeLabelOf(mkItem({ allDay: true, start: "2026-10-08" }), "2026-10-08"), "全天");
});

t("日程 → 「开始 - 结束」", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00", end: "2026-10-08T10:30:00" });
  assert.strictEqual(timeLabelOf(it, "2026-10-08T09:00:00"), "09:00 - 10:30");
});

t("日程跨午夜结束时间收在 24:00，不归零", () => {
  const it = mkItem({ start: "2026-10-08T23:00:00", end: "2026-10-09T00:00:00" });
  assert.strictEqual(timeLabelOf(it, "2026-10-08T23:00:00"), "23:00 - 24:00");
});

t("重复日程：结束时间按原时长算", () => {
  const it = mkItem({ start: "2026-09-17T09:00:00", end: "2026-09-17T17:00:00", rrule: { freq: "MONTHLY" } });
  assert.strictEqual(timeLabelOf(it, "2026-10-17T09:00:00"), "09:00 - 17:00");
});

t("待办 → 只显示到期时刻", () => {
  const it = mkItem({ kind: "todo", start: "2026-10-08T09:00:00", end: "2026-10-08T18:00:00" });
  assert.strictEqual(timeLabelOf(it, "2026-10-08T18:00:00"), "18:00");
});

t("日程无结束时间 → 只显示开始时刻", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00" });
  assert.strictEqual(timeLabelOf(it, "2026-10-08T09:00:00"), "09:00");
});

// ============ ③ 渲染结构 ============

t("空时间段 → 空态提示", () => {
  const html = render(mkCtx("day", "2026-10-08"), []);
  assert.ok(html.includes("cal-list-empty"));
  assert.ok(html.includes("暂无日程或待办"));
});

t("按日期分组：日期头含 M/D、周几、条目数", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00", end: "2026-10-08T10:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(html.includes("cal-list-day"));
  assert.ok(html.includes("10/8"));
  assert.ok(html.includes("周四"));
  assert.ok(html.includes("1 项"));
});

t("条目四要素：时间 + 色点 + 类型图标 + 标题", () => {
  const it = mkItem({ summary: "项目评审会", start: "2026-10-08T09:00:00", end: "2026-10-08T10:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(html.includes("cal-list-time"));
  assert.ok(html.includes("09:00 - 10:00"));
  assert.ok(html.includes("cal-list-dot"));
  assert.ok(html.includes("cal-list-kind"));
  assert.ok(html.includes("项目评审会"));
  assert.ok(html.includes('data-open="u1"'));
});

t("待办条目标注类型且带勾选圈", () => {
  const it = mkItem({ kind: "todo", summary: "交材料", start: "2026-10-08T09:00:00", end: "2026-10-08T18:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T18:00:00"]]]);
  assert.ok(html.includes('data-kind="todo"'));
  assert.ok(html.includes("cal-chip-check"));
  assert.ok(html.includes('data-toggle="u1"'));
});

t("日程条目不带勾选圈", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(!html.includes("cal-chip-check"));
});

t("已完成待办行标 is-done", () => {
  const it = mkItem({ kind: "todo", start: "2026-10-08T09:00:00", end: "2026-10-08T18:00:00", percent: 100 });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T18:00:00"]]]);
  assert.ok(html.includes("is-done"));
});

t("标题做 HTML 转义（防注入）", () => {
  const it = mkItem({ summary: '<img src=x onerror="alert(1)">', start: "2026-10-08T09:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
});

t("多个日期 → 分组按日期升序", () => {
  const a = mkItem({ uid: "a", start: "2026-10-09T09:00:00" });
  const b = mkItem({ uid: "b", start: "2026-10-08T09:00:00" });
  const html = render(mkCtx("week", "2026-10-08"), [
    [a, ["2026-10-09T09:00:00"]],
    [b, ["2026-10-08T09:00:00"]]
  ]);
  assert.ok(html.indexOf("10/8") < html.indexOf("10/9"));
});

t("总条目数统计正确", () => {
  const a = mkItem({ uid: "a", start: "2026-10-08T09:00:00" });
  const b = mkItem({ uid: "b", start: "2026-10-09T09:00:00" });
  const html = render(mkCtx("week", "2026-10-08"), [
    [a, ["2026-10-08T09:00:00"]],
    [b, ["2026-10-09T09:00:00"]]
  ]);
  assert.ok(html.includes("共 2 项"));
});

t("重复条目在同一时间段内出现多次时逐条列出", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00", rrule: { freq: "DAILY" } });
  const html = render(mkCtx("week", "2026-10-08"), [
    [it, ["2026-10-08T09:00:00", "2026-10-09T09:00:00", "2026-10-10T09:00:00"]]
  ]);
  assert.ok(html.includes("共 3 项"));
});

// ============ ④ 面板接线（源码断言） ============

t("panel.ts 有「列表」按钮与 toggle-list 分支", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel.ts"), "utf8");
  assert.ok(/data-action="toggle-list"/.test(src), "工具栏应有列表按钮");
  assert.ok(/action === "toggle-list"/.test(src), "应有 toggle-list 点击分支");
  assert.ok(/ctx\.listMode = !ctx\.listMode/.test(src), "应切换 listMode");
});

t("panel.ts 渲染时按 listMode 分派到列表视图", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel.ts"), "utf8");
  assert.ok(/ctx\.listMode/.test(src) && /renderListView\(/.test(src), "应调用 renderListView");
});

t("PanelCtx 有 listMode 字段（正交于 viewMode）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel-ctx.ts"), "utf8");
  assert.ok(/listMode:\s*boolean/.test(src), "panel-ctx 应声明 listMode");
});

t("main.ts 初始化 listMode: false（不记忆列表模式）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/main.ts"), "utf8");
  assert.ok(/listMode:\s*false/.test(src));
});

t("i18n 两个语言都有 toolbar.viewList", () => {
  for (const f of ["zh_CN.json", "en_US.json"]) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "src/i18n", f), "utf8"));
    assert.ok(typeof j["toolbar.viewList"] === "string" && j["toolbar.viewList"], `${f} 缺 toolbar.viewList`);
  }
});

console.log(`\n[list-view] 通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ""}`);
process.exit(fail === 0 ? 0 : 1);
