/**
 * 回归测试：视图记忆（记住上次用的视图）。
 *
 * 2026-10-07 雄哥要求：「记住当前的视图（日历视图/任务视图），
 * 下次初次打开时默认使用上次视图。任务视图初次打开时，默认显示『所有未完成』。」
 *
 * ## 2026-10-27：载体从 localStorage 换成配置
 *
 * 原先记在 localStorage。两端都改存**配置**（settings.lastView /
 * settings.lastCalendarView），跟 data.json 一起同步：
 *   - 思源端**必须**改：它每次启动的内核端口是随机的，而 localStorage 按 origin
 *     （**含端口**）隔离，写进去的记录下次永远读不回来，等于根本没记住。
 *   - Obsidian 端顺带修好「localStorage 是 app 级、所有 vault 共享一份」的串味。
 *
 * 这类功能有三个易错点，tsc 与 eslint 都抓不到：
 *   ① 写入点漏了某条切换路径（切换有三条：navigate / segBtn / toggleBtn）
 *   ② 读到的值不合法时把面板卡死
 *   ③ 脏数据（手改配置、旧版本残留）导致 viewMode 取到非法值
 *
 * 用法：node test/view-pref.cjs
 */
const assert = require("assert");

// ── 复刻 view-pref.ts 的实现（载体 = 配置对象）──
const VALID = ["year", "month", "week", "day", "task"];
const DEFAULT_VIEW = "month";

function makePref(settings) {
  return {
    loadViewMode() {
      const raw = settings.lastView;
      if (!raw) return null;
      return VALID.includes(raw) ? raw : null;
    },
    saveViewMode(mode) {
      settings.lastView = mode;
    },
    initialViewMode() {
      return this.loadViewMode() ?? DEFAULT_VIEW;
    }
  };
}

let failed = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failed++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${cond ? "" : "  " + extra}`);
};

// ── 1. 无记录时回落默认（月视图）──
{
  const p = makePref({});
  check("无记录时用默认月视图", p.initialViewMode() === "month");
  check("无记录时 loadViewMode 返回 null", p.loadViewMode() === null);
}

// ── 2. 存了 task 就恢复 task（本次需求的核心）──
{
  const s = {};
  const p = makePref(s);
  p.saveViewMode("task");
  check("存 task 后能恢复 task", p.initialViewMode() === "task");
  check("确实写进了配置（settings.lastView）", s.lastView === "task");
}

// ── 3. 五种视图都能往返 ──
{
  const bad = [];
  for (const m of VALID) {
    const p = makePref({});
    p.saveViewMode(m);
    if (p.initialViewMode() !== m) bad.push(m);
  }
  check("五种视图均可往返", bad.length === 0, "失败: " + bad.join(","));
}

// ── 4. 脏数据不能把面板卡死（②③）──
{
  const cases = [
    ["垃圾字符串", "not-a-view"],
    ["空串", ""],
    ["大小写不符", "TASK"],
    ["旧版本残留的合法值", "week"]
  ];
  const wrong = [];
  for (const [label, val] of cases) {
    const p = makePref({ lastView: val });
    const got = p.initialViewMode();
    const expected = VALID.includes(val) ? val : "month";
    if (got !== expected) wrong.push(`${label}(${val})→${got}`);
  }
  check("脏数据安全回落", wrong.length === 0, wrong.join("; "));
}

// ── 5. 配置缺字段时静默降级，不影响使用 ──
{
  const p = makePref({});
  let ok = true;
  try {
    if (p.initialViewMode() !== "month") ok = false;
    p.saveViewMode("task"); // 不应抛出
  } catch (e) {
    ok = false;
  }
  check("配置缺字段时降级为默认视图", ok);
}

// ── 6. 配置整体为空（极端环境）──
{
  let ok = true;
  try {
    const p = makePref(Object.create(null));
    if (p.initialViewMode() !== "month") ok = false;
    p.saveViewMode("week");
  } catch {
    ok = false;
  }
  check("配置对象为空时也不崩", ok);
}

// ── 7. 配置从别台设备同步过来时，记录照样读得回 ──
// 这正是 localStorage 做不到的：它的记录锁在上一次启动那个随机端口的 origin 里。
{
  const p = makePref({ lastView: "week" });
  check("配置里带着 lastView（同步自别的设备）时照样生效", p.initialViewMode() === "week");
}

// ── 8. 关键钉子：mainCtx 初始化必须走 initialViewMode 而非硬编码 ──
//     面板里有三条切换路径（navigate / segBtn / toggleBtn），
//     写入点统一收在 notifyViewChange 里 —— 此断言防止有人又写死"month"。
{
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("./../src/main.ts"), "utf8");
  check(
    "main.ts 用 initialViewMode() 而非硬编码 viewMode: \"month\"",
    /viewMode:\s*initialViewMode\(/.test(src) && !/viewMode:\s*"month"/.test(src)
  );
  const panel = fs.readFileSync(require.resolve("./../src/ui/panel.ts"), "utf8");
  const fn = (panel.match(/export function notifyViewChange[\s\S]*?\n\}/) || [""])[0];
  check("notifyViewChange 内调用 saveViewMode", /saveViewMode\(store\.settings, mode\)/.test(fn));
  check("notifyViewChange 内落盘（markSettingsDirty）", /store\.markSettingsDirty\(\)/.test(fn));
}

// ── 9. 源码护栏：视图记忆不许再碰浏览器存储 ──
// 思源端口随机 → localStorage/IndexedDB/cookie 全按 origin 隔离，等于每次都丢；
// Obsidian 的 localStorage 是 app 级、所有 vault 共享 → 会串味。
{
  const fs = require("fs");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const viewPref = strip(fs.readFileSync(require.resolve("./../src/ui/view-pref.ts"), "utf8"));
  const filterPref = strip(fs.readFileSync(require.resolve("./../src/ui/filter-pref.ts"), "utf8"));
  check("view-pref.ts 不使用浏览器存储", !/localStorage|indexedDB/i.test(viewPref));
  check("filter-pref.ts 不使用浏览器存储", !/localStorage|indexedDB/i.test(filterPref));
}

// ── 10. 任务视图默认筛选：不再写死，走设置解析；无记录回落「所有未完成」──
// 2026-10-26 雄哥要求筛选默认值可自定义，默认「上次使用项」。
// 原来这里断言 `dataset.filter || "allincomplete"`（写死），现在改为解析设置。
{
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("./../src/ui/view-task.ts"), "utf8");
  const pref = fs.readFileSync(require.resolve("./../src/ui/filter-pref.ts"), "utf8");
  check("view-task 默认筛选走 resolveTaskFilter（不再写死）", /resolveTaskFilter\(ctx\.store\.settings\)/.test(src));
  check("view-task 不再残留写死的默认筛选", !/dataset\.filter\s*\|\|\s*"allincomplete"/.test(src));
  check(
    'resolveTaskFilter 的无记录回落是 "allincomplete"',
    /DEFAULT_TASK_FILTER:\s*TaskFilterKey\s*=\s*"allincomplete"/.test(pref)
  );
  check(
    'Dock 的无记录回落是 "undone"（雄哥要求：由「未来七天」改为「所有未完成」）',
    /DEFAULT_DOCK_FILTER:\s*DockFilterKey\s*=\s*"undone"/.test(pref)
  );
  check("「所有项目」选项仍在（供随时切换到一致口径）", /key:\s*"allitems"/.test(src));
}

console.log(failed === 0 ? "\n✓ 视图记忆回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
