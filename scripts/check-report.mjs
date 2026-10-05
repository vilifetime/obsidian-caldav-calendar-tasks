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
  "createDocumentFragment": [/createDocumentFragment/],
  "this 赋给外部变量": [/(?<![.\w])this\s*=\s*this/],
  "getSettingDefinitions 已实现": [/getSettingDefinitions\s*\(\)\s*:\s*SettingDefinitionItem/],
  "errText 残留": [/\berrText\b/],
  "ctxMenu 残留": [/ctxMenu|hideCtxMenu|showCtxMenu|resetCtxDelete/],
  ": any / as any": [/:\s*any\b|\bas\s+any\b/],
  "裸 fetch(": [/[^.\w]fetch\s*\(/],
  "console.log": [/console\.log/],
  "globalThis": [/globalThis/],
  "裸定时器": [/(?<!\.)\b(setTimeout|clearTimeout|setInterval|clearInterval)\s*\(/],
};

// 期望「有命中」的项目（保留是故意的）
const expectHit = new Set(["createDocumentFragment", "getSettingDefinitions 已实现"]);

for (const [name, [re]] of Object.entries(checks)) {
  const hits = find(re);
  const ok = expectHit.has(name) ? hits.length > 0 : hits.length === 0;
  const mark = ok ? "PASS" : "FAIL";
  const detail = hits.length ? `${hits.length} (${hits.slice(0, 3).join(" ")})` : "0";
  console.log(`  [${mark}] ${name.padEnd(30)} ${detail}`);
}
