/**
 * 「今天」单元格视觉 + 视图记忆回归（2026-10-20 雄哥两条需求）
 *
 * 需求 1：月/周视图中「今天」所在单元格只要背景色，不要框线。
 *   原实现：月视图 .cal-month-cell.is-today 有 `box-shadow: inset 0 0 0 2px`
 *   （内描边方框）；周视图 .cal-wk-dayhead.is-today .cal-wk-num 是实心圆点
 *   （accent 底 + 白字 + border-radius:50%，实心块同属框线状标记）。
 *   现实现：月视图只留 background；周视图表头加同款淡 accent 底、数字改文字色强调。
 *   年视图 .cal-year-cell.is-today 本来就是纯底色，不动（反向断言钉住它没被误改）。
 *
 * 需求 2：记住日历视图当前选用的视图（年/月/周/日），从任务视图切回日历视图时
 *   不默认到月视图。
 *   原实现：panel.ts toggle-view 硬编码 `ctx.viewMode === "task" ? "month" : "task"`；
 *   且 view-pref 只有一个键（含 task），进 task 时会把日历视图记录覆盖成 task，
 *   直接读它会死循环。现实现：第二个键 caldav-calendar-view 只记日历视图
 *   （saveCalendarView 对 task 直接 return），toggle-view 返回时
 *   `loadCalendarView() ?? DEFAULT_VIEW`。
 *
 * 用法：node test/today-view-pref.cjs
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { rmrf } = require("./fsx.cjs");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
// 统一 normalize 行尾：仓库是 LF，但断言不写死 \n（CRLF 仓库教训）
const readLF = (rel) => read(rel).replace(/\r\n/g, "\n");

// 编译 view-pref.ts 到临时目录（与 digest.cjs 同套路）。
// view-pref.ts 的 import 用了 @/ 别名，命令行 tsc 不认 --paths → 落临时 tsconfig。
const outDir = path.join(ROOT, ".test-viewpref");
rmrf(outDir);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "commonjs", target: "es2020", moduleResolution: "node",
      esModuleInterop: true, skipLibCheck: true, strict: false, resolveJsonModule: true,
      baseUrl: "..", paths: { "@/*": ["src/*"] }, outDir: ".",
    },
    files: ["../src/ui/view-pref.ts", "../src/ui/panel-ctx.ts"],
  })
);
execSync(`npx tsc -p .test-viewpref/tsconfig.json`, { cwd: ROOT, stdio: "pipe" });
// tsc 的 paths 不改写运行期 require，编译后手工改写成相对路径
const rewrite = (p) => {
  let s = fs.readFileSync(p, "utf8");
  const depth = path.relative(path.dirname(p), outDir).split(path.sep).filter(Boolean).length;
  const prefix = depth === 0 ? "./" : "../".repeat(depth);
  s = s.replace(/require\("@\/([^"]+)"\)/g, (_, m) => `require("${prefix}${m}")`);
  fs.writeFileSync(p, s);
};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) rewrite(p);
  }
};
walk(outDir);
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const vp = require(path.join(outDir, "ui", "view-pref.js"));

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}\n         ${e.message}`);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ---------- 需求 1：今天单元格无框线 ----------
console.log("[today-view-pref] 今天单元格 CSS");

t("月视图 is-today 无框线（box-shadow/outline/border 全无）", () => {
  const css = readLF("src/styles.css");
  const m = /\.cal-month-cell\.is-today\s*\{([^}]*)\}/.exec(css);
  ok(m, "找不到 .cal-month-cell.is-today 规则");
  const body = m[1];
  ok(!/box-shadow/.test(body), "月视图今日格仍有 box-shadow 框线");
  ok(!/outline/.test(body), "月视图今日格有 outline");
  ok(!/border/.test(body), "月视图今日格有 border");
  ok(/background:/.test(body), "月视图今日格丢了背景色（应保留）");
});

t("月视图 is-today:hover 无框线", () => {
  const css = readLF("src/styles.css");
  const m = /\.cal-month-cell\.is-today:hover\s*\{([^}]*)\}/.exec(css);
  ok(m, "找不到 .cal-month-cell.is-today:hover 规则");
  ok(!/box-shadow|outline/.test(m[1]), "hover 态带回框线");
  ok(/background:/.test(m[1]), "hover 态丢了背景色");
});

t("周视图今日表头有背景色、无圆点无框线", () => {
  const css = readLF("src/styles.css");
  const head = /\.cal-wk-dayhead\.is-today\s*\{([^}]*)\}/.exec(css);
  ok(head, "找不到 .cal-wk-dayhead.is-today 规则");
  ok(/background:/.test(head[1]), "周视图今日表头缺背景色");
  ok(!/box-shadow|outline/.test(head[1]), "周视图今日表头有框线");
  const num = /\.cal-wk-dayhead\.is-today \.cal-wk-num\s*\{([^}]*)\}/.exec(css);
  ok(num, "找不到 .cal-wk-dayhead.is-today .cal-wk-num 规则");
  ok(!/background/.test(num[1]), "日期数字又是实心圆点（background 底）");
  ok(!/border-radius/.test(num[1]), "日期数字保留圆形");
  ok(/color:/.test(num[1]), "日期数字丢了文字色强调");
});

t("年视图 is-today 本来就是纯底色，未被误改", () => {
  const css = readLF("src/styles.css");
  const m = /\.cal-year-cell\.is-today\s*\{([^}]*)\}/.exec(css);
  ok(m, "找不到 .cal-year-cell.is-today 规则");
  ok(/background:/.test(m[1]), "年视图今日格丢了背景色");
  ok(!/box-shadow|outline|border/.test(m[1]), "年视图今日格被加上了框线");
});

// ---------- 需求 2：视图记忆 ----------
console.log("[today-view-pref] 视图记忆逻辑");

// ⚠️ 2026-10-27：载体从 localStorage 换成**配置**（settings.lastView /
// lastCalendarView），跟 data.json 一起同步。思源端**必须**这么改 —— 它每次启动的
// 内核端口是随机的，而 localStorage 按 origin（含端口）隔离，写进去的记录下次永远
// 读不回来；Obsidian 端顺带修好「localStorage 是 app 级、所有 vault 共享一份」的串味。
const mkSettings = () => ({});

t("saveCalendarView(task) 不写日历视图字段", () => {
  const s = mkSettings();
  vp.saveCalendarView(s, "task");
  eq(vp.loadCalendarView(s), null, "task 竟被记进日历视图");
  eq(s.lastCalendarView, undefined, "task 落进了 settings.lastCalendarView");
});

t("saveCalendarView(week) → loadCalendarView 读回 week", () => {
  const s = mkSettings();
  vp.saveCalendarView(s, "week");
  eq(s.lastCalendarView, "week", "没写进配置");
  eq(vp.loadCalendarView(s), "week", "日历视图字段读写不一致");
});

t("saveViewMode(task) 不影响 loadCalendarView", () => {
  const s = mkSettings();
  vp.saveCalendarView(s, "day");
  vp.saveViewMode(s, "task"); // 模拟进入任务视图
  eq(vp.loadCalendarView(s), "day", "进 task 覆盖了日历视图记录（会死循环）");
  eq(vp.loadViewMode(s), "task", "当前视图字段没记到 task");
});

t("loadCalendarView 脏值回落 null", () => {
  eq(vp.loadCalendarView({ lastCalendarView: "garbage" }), null, "脏值没被拒");
});

t("配置里带着 lastCalendarView（同步自别的设备）时照样读得回", () => {
  // 这正是 localStorage 做不到的：它的记录锁在上一次启动那个随机端口的 origin 里。
  eq(vp.loadCalendarView({ lastCalendarView: "year" }), "year", "同步过来的记录读不到");
  eq(vp.loadViewMode({ lastView: "week" }), "week", "同步过来的记录读不到");
});

t("配置缺字段时不崩，回落 null", () => {
  eq(vp.loadCalendarView(mkSettings()), null, "读失败应回落 null");
  eq(vp.loadViewMode(mkSettings()), null, "读失败应回落 null");
  vp.saveCalendarView(mkSettings(), "week"); // 不抛即过
  vp.saveViewMode(mkSettings(), "task");
});

// ---------- 源码断言 ----------
console.log("[today-view-pref] 源码断言");

t("panel.ts toggle-view 不再硬编码落回月视图", () => {
  const src = readLF("src/ui/panel.ts");
  ok(
    src.includes('ctx.viewMode = ctx.viewMode === "task" ? loadCalendarView(ctx.store.settings) ?? DEFAULT_VIEW : "task"'),
    "toggle-view 仍硬编码 month 或没用 loadCalendarView"
  );
  ok(!/=== "task" \? "month" : "task"/.test(src), "旧硬编码写法残留");
  ok(/import \{[^}]*loadCalendarView[^}]*\} from "\.\/view-pref"/.test(src), "panel.ts 没 import loadCalendarView");
});

t("notifyViewChange 汇聚点记日历视图", () => {
  const src = readLF("src/ui/panel.ts");
  // 剥注释后确认调用存在（注释里出现函数名不算）
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const seg = bare.slice(bare.indexOf("export function notifyViewChange"));
  ok(/saveCalendarView\(/.test(seg), "notifyViewChange 里没调 saveCalendarView");
  ok(/saveViewMode\(/.test(seg), "notifyViewChange 里丢了 saveViewMode");
  ok(/markSettingsDirty\(\)/.test(seg), "notifyViewChange 里没落盘（改了内存但没写盘等于没记住）");
});

t("view-pref.ts 双字段分工正确", () => {
  const src = readLF("src/ui/view-pref.ts");
  ok(/s\.lastView\s*=/.test(src), "缺当前视图字段 lastView");
  ok(/s\.lastCalendarView\s*=/.test(src), "缺日历视图专用字段 lastCalendarView");
  ok(/VALID_CALENDAR/.test(src), "缺日历视图合法集合");
  ok(/if \(!VALID_CALENDAR\.includes\(mode\)\) return;/.test(src), "saveCalendarView 没过滤非日历视图");
});

t("view-pref.ts 不再碰浏览器存储（端口隔离 → 记录永远读不回）", () => {
  const src = readLF("src/ui/view-pref.ts");
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/localStorage|indexedDB/i.test(bare), "view-pref 又用回 localStorage/IndexedDB 了");
});

console.log(`\n[today-view-pref] ${passed} 项通过${failed ? `，${failed} 项失败` : ""}`);
if (failed > 0) process.exitCode = 1;
