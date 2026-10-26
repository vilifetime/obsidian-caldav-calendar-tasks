/**
 * 回归测试：两处筛选下拉的「默认值」可自定义（2026-10-26 雄哥要求）
 *
 * 背景：Dock 默认写死「未来七天」、任务视图默认写死「所有未完成」，
 * 用户希望可改；设置里新增两项，默认「上次使用项」。
 * 雄哥追加：无「上次使用项」记录时，Dock 的初始值也由「未来七天」改为「所有未完成」。
 *
 * ## 2026-10-27 重要修正：「上次使用项」的存储从 localStorage 改到配置
 *
 * 原实现把「上次用的筛选」记在 localStorage，结果永远记不住。实锤：
 * 思源每次启动的**内核端口是随机的**（实测 9905 / 11038 / 4008 / 8351 …），
 * 而 localStorage 按 origin —— **含端口** —— 隔离。记录写进去了（Electron 的
 * leveldb 里能看到一串不同端口下的记录），但下次启动是另一个 origin，一条也读不回来。
 * 表现就是「上次使用项」永远回落到默认值。
 *
 * 按雄哥 2026-10-27 的要求改存**配置**（`settings.lastDockFilter` / `lastTaskFilter`），
 * 跟着 data.json 一起同步到其他设备。Obsidian 端顺带修好了另一个毛病：
 * localStorage 是 **app 级**的、所有 vault 共享一份，换 vault 会串味；
 * data.json 是 per-vault 的。
 *
 * 覆盖：
 *   ① DEFAULT_SETTINGS 两项默认都是 "last"
 *   ② 无记录时回落：Dock = undone / 任务视图 = allincomplete
 *   ③ 写了「上次使用项」后能读回（往返）
 *   ④ 设置固定成某一项时，忽略「上次使用项」直接用它
 *   ⑤ 脏数据（不在合法集合内）视为无记录，不把面板卡死
 *   ⑥ 配置从别台设备同步过来时，记录照样读得回（本次修复的核心）
 *   ⑦ 选项表与两个下拉同源（防加项时两边漂移）
 *   ⑧ 源码级护栏：UI 偏好的读写**不许再碰浏览器存储**
 *   ⑨ 选中时确实写进了 settings 并触发落盘
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
  assert.strictEqual(P.DEFAULT_DOCK_FILTER, "undone");
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
});
check("无记录：任务视图回落到 allincomplete（所有未完成）", () => {
  assert.strictEqual(P.DEFAULT_TASK_FILTER, "allincomplete");
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
});

// ③ 上次使用项往返（写进 settings → 读回 → resolve 也用它）
check("Dock：save 后能 load 回，resolve 也用它", () => {
  const s = settings();
  P.saveLastDockFilter(s, "thisweek");
  assert.strictEqual(s.lastDockFilter, "thisweek", "没写进配置");
  assert.strictEqual(P.loadLastDockFilter(s), "thisweek");
  assert.strictEqual(P.resolveDockFilter(s), "thisweek");
});
check("任务视图：save 后能 load 回，resolve 也用它", () => {
  const s = settings();
  P.saveLastTaskFilter(s, "overdue");
  assert.strictEqual(s.lastTaskFilter, "overdue", "没写进配置");
  assert.strictEqual(P.loadLastTaskFilter(s), "overdue");
  assert.strictEqual(P.resolveTaskFilter(s), "overdue");
});

// ④ 固定成某一项时忽略「上次使用项」
check("Dock 固定为 today 时，即使有上次记录也用 today", () => {
  const s = settings({ defaultDockFilter: "today", lastDockFilter: "thisweek" });
  assert.strictEqual(P.resolveDockFilter(s), "today");
});
check("任务视图固定为 doneall 时，即使有上次记录也用 doneall", () => {
  const s = settings({ defaultTaskFilter: "doneall", lastTaskFilter: "overdue" });
  assert.strictEqual(P.resolveTaskFilter(s), "doneall");
});

// ⑤ 脏数据视为无记录
check("Dock 脏数据（不在合法集合内）视为无记录", () => {
  const s = settings({ lastDockFilter: "not-a-real-filter" });
  assert.strictEqual(P.loadLastDockFilter(s), null);
  assert.strictEqual(P.resolveDockFilter(s), "undone");
});
check("任务视图脏数据视为无记录", () => {
  const s = settings({ lastTaskFilter: "???" });
  assert.strictEqual(P.loadLastTaskFilter(s), null);
  assert.strictEqual(P.resolveTaskFilter(s), "allincomplete");
});
check("设置里存了非法筛选键时回落到默认值", () => {
  assert.strictEqual(P.resolveDockFilter(settings({ defaultDockFilter: "bogus" })), "undone");
  assert.strictEqual(P.resolveTaskFilter(settings({ defaultTaskFilter: "bogus" })), "allincomplete");
});

// ⑥ 本次修复的核心：配置从别台设备同步过来时，记录照样读得回
check("配置里带着 lastDockFilter（同步自别的设备）时照样生效", () => {
  const s = settings({ lastDockFilter: "overdue" });
  assert.strictEqual(P.loadLastDockFilter(s), "overdue");
  assert.strictEqual(P.resolveDockFilter(s), "overdue");
});
check("配置里带着 lastTaskFilter 时照样生效", () => {
  const s = settings({ lastTaskFilter: "thisweek" });
  assert.strictEqual(P.resolveTaskFilter(s), "thisweek");
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

// ⑧ 源码级护栏：UI 偏好不许再碰浏览器存储
// 思源端口随机 → localStorage/IndexedDB/cookie 全按 origin 隔离，等于每次都丢；
// Obsidian 的 localStorage 是 app 级、所有 vault 共享 → 会串味。谁改回去都会复现问题。
{
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const BROWSER_STORE = /localStorage|indexedDB/i;
  const prefSrc = fs.readFileSync(path.join(ROOT, "src/ui/filter-pref.ts"), "utf8");
  const viewSrc = fs.readFileSync(path.join(ROOT, "src/ui/view-pref.ts"), "utf8");
  const typesSrc = fs.readFileSync(path.join(ROOT, "src/core/types.ts"), "utf8");
  const storeSrc = fs.readFileSync(path.join(ROOT, "src/core/store.ts"), "utf8");
  check("filter-pref.ts 不使用浏览器存储", () => {
    assert.ok(!BROWSER_STORE.test(stripComments(prefSrc)), "filter-pref 不该再碰 localStorage/IndexedDB");
  });
  check("view-pref.ts 不使用浏览器存储", () => {
    assert.ok(!BROWSER_STORE.test(stripComments(viewSrc)), "view-pref 不该再碰 localStorage/IndexedDB");
  });
  check("UI 偏好的记录字段在 CalSettings 里（随配置同步）", () => {
    for (const f of ["lastDockFilter", "lastTaskFilter", "lastView", "lastCalendarView"]) {
      assert.ok(new RegExp(`${f}\\?:`).test(typesSrc), `CalSettings 缺 ${f}`);
    }
  });
  check("store 落盘带上 settings（记录才跟着走）", () => {
    assert.ok(/settings: \{ \.\.\.this\.settings/.test(storeSrc));
    assert.ok(/markSettingsDirty/.test(storeSrc), "改了 settings 要有落盘入口");
  });
}

// ⑨ 选中时确实写进了 settings 并触发落盘
check("Dock 选中某项时写进 settings 并排期落盘", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel.ts"), "utf8");
  assert.ok(/saveLastDockFilter\(opts\.store\.settings, dockFilter\)/.test(src));
  assert.ok(/opts\.store\.markSettingsDirty\(\)/.test(src), "只改内存不落盘等于没记住");
});
check("任务视图切筛选时写进 settings 并排期落盘", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ui/view-task.ts"), "utf8");
  assert.ok(/saveLastTaskFilter\(ctx\.store\.settings, val\)/.test(src));
  assert.ok(/ctx\.store\.markSettingsDirty\(\)/.test(src));
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
