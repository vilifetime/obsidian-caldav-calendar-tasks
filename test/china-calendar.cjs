/**
 * 回归测试：中国日历叠加层（Obsidian 端，2026-10-26 同构自思源端）
 *
 * 覆盖：
 *   ① lunarFor 农历/节气换算（内置算法，含「正月/冬月/腊月」「节气优先」的字形）
 *   ② timor 源按年拉取 + 归一化（休/班）
 *   ③ 多源竞速回退：holiday-cn 的 jsdelivr 全挂、timor 兜底成功
 *   ④ 失败降级：所有候选失败 → 返回 null 且记录真实原因（getLastHolidayError）
 *   ⑤ 缓存复用：同一年的第二次拉取不重复请求
 *   ⑥ forceRefreshChinaCalendar：强制忽略缓存重拉
 *   ⑦ 自定义源：{year} 占位 + genericNormalize
 *
 * 用法：node test/china-calendar.cjs
 *
 * ⚠️ 不触发真实网络：通过 setHolidayTransport 注入内存 mock；只直接调
 *    loadHolidayYear / forceRefreshChinaCalendar，绝不走 warm（warm 在真实宿主才联网）。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const outDir = path.join(ROOT, ".test-china");

execSync(
  `npx tsc src/core/lunar-javascript.d.ts src/core/types.ts src/core/holiday-cn.ts ` +
    `--outDir .test-china --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "pipe" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
// obsidian 桩（本套测试不依赖宿主模块，但保留以防 tsc/require 链路误引）
{
  const stubDir = path.join(outDir, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" }));
  fs.writeFileSync(path.join(stubDir, "index.js"), `"use strict";\nexports.Notice = function Notice() {};\n`);
}
global.window = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };

const { lunarFor, holidayFor, loadHolidayYear, forceRefreshChinaCalendar, getLastHolidayError, setHolidayTransport } = require(path.join(
  outDir,
  "holiday-cn.js"
));

// ── 可控 mock 传输：每个用例前重设 ──
let transportImpl = async () => ({ ok: false, error: "未设置 mock" });
let fetchCount = 0;
setHolidayTransport(async (url, ms, headers) => {
  fetchCount++;
  return transportImpl(url, ms, headers);
});

const TIMOR_URL = (y) => `https://timor.tech/api/holiday/year/${y}`;
const timorJson = (y) => ({
  code: 0,
  holiday: {
    "10-01": { holiday: true, name: "国庆节", date: `${y}-10-01` },
    "10-02": { holiday: true, name: "国庆次日", date: `${y}-10-02` },
    "10-03": { holiday: false, name: "国庆调休补班", date: `${y}-10-03` },
  },
});

const settings = (over) =>
  Object.assign(
    { showHolidaysCN: true, showLunarCN: true, showTermCN: true, holidayCnSource: "timor", holidayCnUpdateFreq: "weekly" },
    over || {}
  );

let pass = 0;
const fail = [];
const asyncChecks = [];
function check(name, fn) {
  if (fn.constructor.name === "AsyncFunction") {
    asyncChecks.push({ name, fn });
    return;
  }
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
}

// ═════════════════════════════════ ① 农历/节气换算（纯算法）
check("lunarFor：正月初一（2026 春节）", () => {
  assert.strictEqual(lunarFor("2026-02-17").lunar, "正月初一");
});
check("lunarFor：冬月十七", () => {
  assert.strictEqual(lunarFor("2026-12-25").lunar, "冬月十七");
});
check("lunarFor：节气优先返回（秋分）", () => {
  const r = lunarFor("2026-09-23");
  assert.strictEqual(r.jieqi, "秋分");
  assert.strictEqual(r.lunar, "八月十三");
});
check("lunarFor：霜降节气", () => {
  assert.strictEqual(lunarFor("2026-10-23").jieqi, "霜降");
});

// ═════════════════════════════════ ② timor 源拉取 + 归一化
check("timor 源：按年拉取并归一化（休/班）", async () => {
  const y = 2026;
  transportImpl = async (url) => (url === TIMOR_URL(y) ? { ok: true, data: timorJson(y) } : { ok: false, error: "非 timor 候选" });
  const map = await loadHolidayYear(settings({ holidayCnSource: "timor" }), y, true);
  assert.ok(map, "应返回归一化 map");
  assert.strictEqual(map[`${y}-10-01`].name, "国庆节");
  assert.strictEqual(map[`${y}-10-01`].off, true);
  assert.strictEqual(map[`${y}-10-03`].off, false, "调休补班应为 班(false)");
  // 缓存已写入，holidayFor 同步可读
  assert.strictEqual(holidayFor(`${y}-10-01`).name, "国庆节");
});

// ═════════════════════════════════ ③ 多源竞速回退（holiday-cn → timor 兜底）
check("holiday-cn 源：jsdelivr 全挂、timor 兜底成功", async () => {
  const y = 2027;
  transportImpl = async (url) => {
    if (url.includes("timor.tech")) return { ok: true, data: timorJson(y) };
    return { ok: false, error: "jsdelivr 不可达" };
  };
  const map = await loadHolidayYear(settings({ holidayCnSource: "holiday-cn" }), y, true);
  assert.ok(map, "timor 兜底应成功");
  assert.strictEqual(map[`${y}-10-01`].name, "国庆节");
});

// ═════════════════════════════════ ④ 失败降级：全部候选失败 → null + 记录原因
check("失败降级：所有候选失败返回 null 且记录真实原因", async () => {
  const y = 2028;
  transportImpl = async () => ({ ok: false, error: "网络不可达" });
  const map = await loadHolidayYear(settings({ holidayCnSource: "holiday-cn" }), y, true);
  assert.strictEqual(map, null, "全失败应返回 null");
  const err = getLastHolidayError();
  assert.ok(err && err.includes("所有候选源均失败"), "应记录失败原因，实际：" + err);
});

// ═════════════════════════════════ ⑤ 缓存复用：同一年不重复请求
check("缓存复用：同一年第二次拉取不重复请求", async () => {
  const y = 2030;
  transportImpl = async (url) => (url === TIMOR_URL(y) ? { ok: true, data: timorJson(y) } : { ok: false, error: "x" });
  fetchCount = 0;
  await loadHolidayYear(settings({ holidayCnSource: "timor" }), y);
  assert.strictEqual(fetchCount, 1, "首次应请求 1 次");
  await loadHolidayYear(settings({ holidayCnSource: "timor" }), y);
  assert.strictEqual(fetchCount, 1, "缓存命中不应再次请求");
});

// ═════════════════════════════════ ⑥ forceRefreshChinaCalendar：强制忽略缓存重拉
check("forceRefreshChinaCalendar：强制重拉返回数据", async () => {
  const y = 2031;
  transportImpl = async (url) => (url === TIMOR_URL(y) ? { ok: true, data: timorJson(y) } : { ok: false, error: "x" });
  fetchCount = 0;
  await loadHolidayYear(settings({ holidayCnSource: "timor" }), y); // 先填缓存
  const ok = await forceRefreshChinaCalendar(settings({ holidayCnSource: "timor" }), [y]);
  assert.strictEqual(ok, true, "force 应成功重拉");
  assert.strictEqual(fetchCount, 2, "force 应再次请求（缓存无效）");
});

// ═════════════════════════════════ ⑦ 自定义源：{year} 占位 + genericNormalize
check("自定义源：{year} 占位与 NateScarlet 结构归一化", async () => {
  const y = 2032;
  const customUrl = "https://my.example.com/holiday/{year}.json";
  transportImpl = async (url) =>
    url === customUrl.replace("{year}", String(y))
      ? {
          ok: true,
          data: { days: [{ name: "元旦", date: `${y}-01-01`, isOffDay: true }, { name: "补班", date: `${y}-01-02`, isOffDay: false }] },
        }
      : { ok: false, error: "x" };
  const map = await loadHolidayYear(settings({ holidayCnSource: "custom", holidayCnCustomUrl: customUrl }), y, true);
  assert.ok(map, "自定义源应解析成功");
  assert.strictEqual(map[`${y}-01-01`].name, "元旦");
  assert.strictEqual(map[`${y}-01-02`].off, false);
});

// ── 串行跑异步用例（共用 setHolidayTransport，并发会互相覆盖 mock）──
(async () => {
  for (const { name, fn } of asyncChecks) {
    try {
      await fn();
      pass++;
    } catch (e) {
      fail.push(`${name}: ${e.message}`);
    }
  }
  if (fail.length) {
    console.error(`\n❌ china-calendar: ${fail.length} 项失败：`);
    for (const f of fail) console.error("  - " + f);
    process.exit(1);
  } else {
    console.log(`\n✅ china-calendar: ${pass} 项全部通过`);
    process.exit(0);
  }
})();
