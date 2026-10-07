/**
 * 回归测试：视图记忆（记住上次用的视图）。
 *
 * 2026-10-07 雄哥要求：「记住当前的视图（日历视图/任务视图），
 * 下次初次打开时默认使用上次视图。任务视图初次打开时，默认显示『所有未完成』。」
 *
 * 这类「读写 localStorage」的功能有三个易错点，tsc 与 eslint 都抓不到：
 *   ① 写入点漏了某条切换路径（切换有三条：navigate / segBtn / toggleBtn）
 *   ② localStorage 抛异常（隐私模式）时把面板卡死
 *   ③ 脏数据（手改 localStorage、旧版本残留）导致 viewMode 取到非法值
 *
 * 用法：node test/view-pref.cjs
 */
const assert = require("assert");

// ── 复刻 view-pref.ts 的实现（用可注入的 fake storage）──
const VALID = ["year", "month", "week", "day", "task"];
const DEFAULT_VIEW = "month";
const KEY = "caldav-view-mode";

function makePref(win) {
  return {
    loadViewMode() {
      try {
        const raw = win.localStorage?.getItem(KEY);
        if (!raw) return null;
        return VALID.includes(raw) ? raw : null;
      } catch {
        return null;
      }
    },
    saveViewMode(mode) {
      try {
        win.localStorage?.setItem(KEY, mode);
      } catch {
        /* 忽略 */
      }
    },
    initialViewMode() {
      return this.loadViewMode() ?? DEFAULT_VIEW;
    }
  };
}

/** 正常 localStorage */
function okStorage(initial = {}) {
  const map = { ...initial };
  return {
    localStorage: {
      getItem: (k) => (k in map ? map[k] : null),
      setItem: (k, v) => {
        map[k] = String(v);
      }
    },
    _map: map
  };
}

/** 抛异常的 localStorage（隐私模式/配额耗尽） */
function throwingStorage() {
  return {
    localStorage: {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      }
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
  const p = makePref(okStorage());
  check("无记录时用默认月视图", p.initialViewMode() === "month");
  check("无记录时 loadViewMode 返回 null", p.loadViewMode() === null);
}

// ── 2. 存了 task 就恢复 task（本次需求的核心）──
{
  const w = okStorage();
  const p = makePref(w);
  p.saveViewMode("task");
  check("存 task 后能恢复 task", p.initialViewMode() === "task");
  check("确实写进了 localStorage", w._map[KEY] === "task");
}

// ── 3. 五种视图都能往返 ──
{
  const bad = [];
  for (const m of VALID) {
    const p = makePref(okStorage());
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
    const p = makePref(okStorage({ [KEY]: val }));
    const got = p.initialViewMode();
    const expected = VALID.includes(val) ? val : "month";
    if (got !== expected) wrong.push(`${label}(${val})→${got}`);
  }
  check("脏数据安全回落", wrong.length === 0, wrong.join("; "));
}

// ── 5. localStorage 抛异常时静默降级，不影响使用 ──
{
  const p = makePref(throwingStorage());
  let ok = true;
  try {
    if (p.initialViewMode() !== "month") ok = false;
    p.saveViewMode("task"); // 不应抛出
  } catch (e) {
    ok = false;
  }
  check("localStorage 抛异常时降级为默认视图", ok);
}

// ── 6. localStorage 整体缺失（极端环境）──
{
  const p = makePref({});
  let ok = true;
  try {
    if (p.initialViewMode() !== "month") ok = false;
    p.saveViewMode("week");
  } catch {
    ok = false;
  }
  check("localStorage 不存在时也不崩", ok);
}

// ── 7. 关键钉子：mainCtx 初始化必须走 initialViewMode 而非硬编码 ──
//     面板里有三条切换路径（navigate / segBtn / toggleBtn），
//     写入点统一收在 notifyViewChange 里 —— 此断言防止有人又写死"month"。
{
  const src = require("fs").readFileSync(require.resolve("./../src/main.ts"), "utf8");
  check(
    "main.ts 用 initialViewMode() 而非硬编码 viewMode: \"month\"",
    /viewMode:\s*initialViewMode\(\)/.test(src) && !/viewMode:\s*"month"/.test(src)
  );
  const panel = require("fs").readFileSync(require.resolve("./../src/ui/panel.ts"), "utf8");
  const fn = (panel.match(/export function notifyViewChange[\s\S]*?\n\}/) || [""])[0];
  check("notifyViewMode 内调用 saveViewMode", /saveViewMode\(mode\)/.test(fn));
}

// ── 8. 任务视图默认筛选为「所有未完成」──
{
  const src = require("fs").readFileSync(require.resolve("./../src/ui/view-task.ts"), "utf8");
  check(
    'view-task 默认筛选是 "allincomplete"',
    /dataset\.filter\s*\|\|\s*"allincomplete"/.test(src)
  );
  check(
    "「所有项目」选项仍在（供随时切换到一致口径）",
    /key:\s*"allitems"/.test(src)
  );
}

console.log(failed === 0 ? "\n✓ 视图记忆回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
