/**
 * 回归测试：两处筛选下拉的「默认值」可自定义（2026-10-26 雄哥要求）
 *
 * 背景：Dock 默认写死「未来七天」、任务视图默认写死「所有未完成」，
 * 用户希望可改；设置里新增两项，默认「上次使用项」（本机 localStorage 记住）。
 * 雄哥追加：无「上次使用项」记录时，Dock 的初始值也由「未来七天」改为「所有未完成」。
 *
 * 覆盖：
 *   ① DEFAULT_SETTINGS 两项默认都是 "last"
 *   ② 无记录时回落：Dock = undone / 任务视图 = allincomplete
 *   ③ 写了「上次使用项」后能读回（往返）
 *   ④ 设置固定成某一项时，忽略「上次使用项」直接用它
 *   ⑤ 脏数据（不在合法集合内）视为无记录，不把面板卡死
 *   ⑥ localStorage 抛异常时降级，不崩
 *   ⑦ 选项表与两个下拉同源（防加项时两边漂移）
 *   ⑧ 下拉被选中时确实写进了 localStorage（saveLast* 有被调用）
 *
 * 用法：node test/default-filter.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const outDir = path.join(ROOT, ".test-deffilter");

execSync(
  `npx tsc src/core/types.ts src/ui/filter-pref.ts ` +
    `--outDir .test-deffilter --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "pipe" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

// 极简 localStorage 桩：可开关抛异常，用来验降级
function makeStorage(throwOnAccess = false) {
  const m = new Map();
  return {
    getItem(k) {
      if (throwOnAccess) throw new Error("localStorage denied");
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnAccess) throw new Error("localStorage denied");
      m.set(k, String(v));
    },
    _map: m,
  };
}

// tsc 把 src/ 下的两个文件编到扁平目录（rootDir = src/core|src/ui 的公共根）
const prefPath = fs.existsSync(path.join(outDir, "filter-pref.js"))
  ? path.join(outDir, "filter-pref.js")
  : path.join(outDir, "ui", "filter-pref.js");
const typesPath = fs.existsSync(path.join(outDir, "types.js"))
  ? path.join(outDir, "types.js")
  : path.join(outDir, "core", "types.js");

const P = require(prefPath);
const T = require(typesPath);

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

const settings = (over) => Object.assign({}, T.DEFAULT_SETTINGS, over || {});

// ① 默认都是「上次使用项」
check("DEFAULT_SETTINGS 两项默认都是 last", () => {
  assert.strictEqual(T.DEFAULT_SETTINGS.defaultDockFilter, "last");
  assert.strictEqual(T.DEFAULT_SETTINGS.defaultTaskFilter, "last");
});

// ② 无记录时的回落（含雄哥要求的 Dock 由「未来七天」→「所有未完成」）
check("无记录：Dock 回落到 undone（所有未完成）", () => {
  globalThis.localStorage = makeStorage();
  assert.strictEqual(P.DEFAULT_DOCK_FILTER, "undone");
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
});
check("无记录：任务视图回落到 allincomplete（所有未完成）", () => {
  globalThis.localStorage = makeStorage();
  assert.strictEqual(P.DEFAULT_TASK_FILTER, "allincomplete");
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
});

// ③ 上次使用项往返
check("Dock：save 后能 load 回，resolve 也用它", () => {
  globalThis.localStorage = makeStorage();
  P.saveLastDockFilter("thisweek");
  assert.strictEqual(P.loadLastDockFilter(), "thisweek");
  assert.strictEqual(P.resolveDockFilter(settings({ defaultDockFilter: "last" })), "thisweek");
});
check("任务视图：save 后能 load 回，resolve 也用它", () => {
  globalThis.localStorage = makeStorage();
  P.saveLastTaskFilter("overdue");
  assert.strictEqual(P.loadLastTaskFilter(), "overdue");
  assert.strictEqual(P.resolveTaskFilter(settings({ defaultTaskFilter: "last" })), "overdue");
});

// ④ 固定成某一项时忽略「上次使用项」
check("Dock 固定为 today 时，即使有上次记录也用 today", () => {
  globalThis.localStorage = makeStorage();
  P.saveLastDockFilter("thisweek");
  assert.strictEqual(P.resolveDockFilter(settings({ defaultDockFilter: "today" })), "today");
});
check("任务视图固定为 doneall 时，即使有上次记录也用 doneall", () => {
  globalThis.localStorage = makeStorage();
  P.saveLastTaskFilter("overdue");
  assert.strictEqual(P.resolveTaskFilter(settings({ defaultTaskFilter: "doneall" })), "doneall");
});

// ⑤ 脏数据视为无记录
check("Dock 脏数据（不在合法集合内）视为无记录", () => {
  const st = makeStorage();
  st.setItem("caldav-dock-filter", "not-a-real-filter");
  globalThis.localStorage = st;
  assert.strictEqual(P.loadLastDockFilter(), null);
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
});
check("任务视图脏数据视为无记录", () => {
  const st = makeStorage();
  st.setItem("caldav-task-filter", "???");
  globalThis.localStorage = st;
  assert.strictEqual(P.loadLastTaskFilter(), null);
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
});
check("设置里存了非法筛选键时回落到默认值", () => {
  globalThis.localStorage = makeStorage();
  assert.strictEqual(P.resolveDockFilter(settings({ defaultDockFilter: "bogus" })), "undone");
  assert.strictEqual(P.resolveTaskFilter(settings({ defaultTaskFilter: "bogus" })), "allincomplete");
});

// ⑥ localStorage 抛异常时降级不崩
check("localStorage 抛异常时读写都不崩，走默认值", () => {
  globalThis.localStorage = makeStorage(true);
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
  P.saveLastDockFilter("today"); // 不应抛
  P.saveLastTaskFilter("today"); // 不应抛
});
check("localStorage 根本不存在时也不崩", () => {
  delete globalThis.localStorage;
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
});

// ⑦ 选项表与两个下拉同源（防漂移）
check("Dock 选项表 12 项、任务视图 13 项，且与合法集合一致", () => {
  assert.strictEqual(P.DOCK_FILTER_KEYS.length, 12);
  assert.strictEqual(P.TASK_FILTER_KEYS.length, 13);
  for (const k of P.DOCK_FILTER_KEYS) assert.ok(P.DOCK_FILTER_I18N[k], `Dock ${k} 缺 i18n key`);
  for (const k of P.TASK_FILTER_KEYS) assert.ok(P.TASK_FILTER_I18N[k], `Task ${k} 缺 i18n key`);
});
{
  const srcPanel = fs.readFileSync(path.join(ROOT, "src/ui/panel.ts"), "utf8");
  const srcTask = fs.readFileSync(path.join(ROOT, "src/ui/view-task.ts"), "utf8");
  const srcSettings = fs.readFileSync(path.join(ROOT, "src/ui/settings-tab.ts"), "utf8");
  check("panel.ts 的 Dock 下拉由共享表生成（不再各写一份）", () => {
    assert.ok(/DOCK_FILTER_KEYS\.map/.test(srcPanel), "panel.ts 应引用 DOCK_FILTER_KEYS");
    assert.ok(!/\{\s*key:\s*"next7",\s*label:\s*"dock\.filter\.next7"/.test(srcPanel), "panel.ts 不该再内联选项表");
  });
  check("view-task.ts 的下拉文案走共享 i18n 映射", () => {
    assert.ok(/TASK_FILTER_I18N\./.test(srcTask));
  });
  check("设置页两项下拉的选项也取自共享表", () => {
    assert.ok(/DOCK_FILTER_KEYS\.map/.test(srcSettings));
    assert.ok(/TASK_FILTER_KEYS\.map/.test(srcSettings));
  });
}

// ⑧ 选中时确实写进了 localStorage
check("Dock 选中某项时调用 saveLastDockFilter", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel.ts"), "utf8");
  assert.ok(/saveLastDockFilter\(dockFilter\)/.test(src));
});
check("任务视图切筛选时调用 saveLastTaskFilter", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/view-task.ts"), "utf8");
  assert.ok(/saveLastTaskFilter\(val\)/.test(src));
});
check("Dock 初始化走设置解析（不再写死 next7）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel.ts"), "utf8");
  assert.ok(/resolveDockFilter\(opts\.store\.settings\)/.test(src));
  assert.ok(!/let dockFilter: DockFilter = "next7"/.test(src), "不该再写死 next7");
});
check("Dock 初始化与「切视图联动」分成两个函数，互不覆盖", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel.ts"), "utf8");
  assert.ok(/function applyInitialDockFilter\(\)/.test(src), "应有 applyInitialDockFilter");
  assert.ok(/function applyViewDefault\(\)/.test(src), "applyViewDefault 应保留（切视图联动）");
  assert.ok(/applyInitialDockFilter\(\);/.test(src), "初始化应调 applyInitialDockFilter");
});

if (fail.length) {
  console.error(`\n❌ default-filter: ${fail.length} 项失败：`);
  for (const f of fail) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n✅ default-filter: ${pass} 项全部通过`);
  process.exit(0);
}
