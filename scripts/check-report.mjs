/**
 * 社区扫描报告项自查。剥离注释后再匹配 —— 直接 grep 会命中我们自己写的
 * 说明文字（如「用 window 而非 globalThis」这句里就有 globalThis）。
 * 一次性脚本，用完即删。
 */
import fs from "node:fs";
import path from "node:path";

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) files.push(p);
  }
})("src");

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const codes = files.map((f) => ({ f, code: strip(fs.readFileSync(f, "utf8")) }));

const find = (re) =>
  codes.flatMap((x) =>
    x.code
      .split("\n")
      .map((t, i) => ({ f: x.f, l: i + 1, t }))
      .filter((o) => re.test(o.t))
      .map((o) => `${o.f}:${o.l}`)
  );

const checks = {
  "document.createElement": [/document\.createElement/],
  "document.createDocumentFragment": [/document\.createDocumentFragment/],
  "this 赋给外部变量": [/(?<![.\w])this\s*=\s*this/],
  "getSettingDefinitions 已实现": [/getSettingDefinitions\s*\(\)\s*:\s*SettingDefinitionItem/],
  "errText 残留": [/\berrText\b/],
  "ctxMenu 残留": [/ctxMenu|hideCtxMenu|showCtxMenu|resetCtxDelete/],
  ": any / as any": [/:\s*any\b|\bas\s+any\b/],
  "裸 fetch(": [/[^.\w]fetch\s*\(/],
  "console.log": [/console\.log/],
  "globalThis": [/globalThis/],
  "裸定时器": [/(?<!\.)\b(setTimeout|clearTimeout|setInterval|clearInterval)\s*\(/],
  // 以下为 2026-10-06 第四轮报告新增
  "unescape（已弃用）": [/\bunescape\s*\(/],
  "closest(...) as HTMLElement | null": [/closest\("[^"]+"\) as HTMLElement \| null/],
  "querySelector(...) as HTMLElement": [/querySelector\("[^"]+"\) as (HTML\w+Element)/],
  "querySelectorAll(...) as X[]": [/querySelectorAll\("[^"]+"\) as (HTML\w+Element)\[\]/],
  "as never": [/\bas never\b/],
  "async 事件监听器": [/addEventListener\([^)]*async/],
  "高版本 API：revealLeaf（需 1.7.2）": [/\bworkspace\.revealLeaf\(/],
  // 2026-10-06 第五轮：as 断言类。社区扫描的 no-unnecessary-type-assertion
  // 只报「不改变类型」的那类（如 `(x as T) as T`、动态 key 处的 `as Partial<T>`），
  // **不报**非空断言 `!` —— 故未列入本检查。
  "as Partial<T>（动态 key 场景，通常多余）": [/as Partial<\w+>/],
  "同一表达式上重复的 as": [/\)\s*as\s+\w+[\s\S]{0,4}\bas\s+\w+/],
  // 🔴 2026-10-06 真实故障：声明式 render 回调的签名是 (setting: Setting, group: SettingGroup)，
  // **不是** (el: HTMLElement)。写错时 tsc 不报错（回调参数无注解就隐式 any），
  // 运行时在 new Setting(el) 处炸掉 → 表现为「该行及之后的设置项全部消失」。
  "render 回调误用 HTMLElement": [/render:\s*\(\s*el: HTMLElement\s*\)/],
  // 注：getRightLeaf 的 @since 是 0.9.7，远低于 minAppVersion，**不在此列**。
  // 加检查前务必先查 obsidian.d.ts 的 @since，别把安全 API 当违规。
};

// 期望「有命中」的项目（保留是故意的）
const expectHit = new Set(["getSettingDefinitions 已实现"]);

for (const [name, [re]] of Object.entries(checks)) {
  const hits = find(re);
  const ok = expectHit.has(name) ? hits.length > 0 : hits.length === 0;
  const mark = ok ? "PASS" : "FAIL";
  const detail = hits.length ? `${hits.length} (${hits.slice(0, 3).join(" ")})` : "0";
  console.log(`  [${mark}] ${name.padEnd(30)} ${detail}`);
}

// 「导入了但没用到」要跨文件比对 import 与使用点，无法用单条正则判定，故单独查。
// 曾经的教训：panel.ts 留着 errMessage 的 import，但删 ctxMenu 时把唯一用到它的那行
// 一起删了，于是社区报「errMessage is defined but never used」。tsc 不会报未使用的
// import（noUnusedLocals 是 false），eslint 才会。
console.log("");
for (const fn of ["errText", "errMessage", "errStatus"]) {
  const importers = codes.filter((x) => new RegExp(`import \\{[^}]*\\b${fn}\\b`).test(x.code));
  for (const imp of importers) {
    const body = imp.code.replace(/^import .*$/gm, "");
    const uses = (body.match(new RegExp(`\\b${fn}\\b`, "g")) || []).length;
    const ok = uses > 0;
    console.log(
      `  [${ok ? "PASS" : "FAIL"}] ${fn} 在 ${imp.f.padEnd(22)} 使用 ${uses} 次`
    );
  }
}
