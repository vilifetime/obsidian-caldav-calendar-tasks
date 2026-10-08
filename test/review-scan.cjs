/**
 * 社区审核「静态扫描类」问题的回归测试。
 *
 * 背景：2026-10-08 社区目录审核返回 3 条：
 *   ① Warning: This assertion is unnecessary since it does not change the type
 *      of the expression.  — src/ui/panel.ts:1309, 1311
 *   ② Recommendation: 'initLocale' is defined but never used. — src/ui/settings-tab.ts:30
 *
 * 这两条 tsc 与 eslint 都抓不到：
 *   ① 冗余类型断言是完全合法的 TS，`tsc` 不报错、`no-unnecessary-type-assertion`
 *      需要开 eslint 规则才能查。
 *   ② 孤儿 import 同理 —— `noUnusedLocals` 在本项目 tsconfig 里是**显式 false**
 *      （为了容忍某些刻意保留的写法），所以 tsc 永远不报。
 *
 * 本测试把两类问题钉死，避免下次审核再返回同样的条目。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

/** 递归收集所有 .ts 源文件（跳过 node_modules）。 */
function collectTs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = collectTs(SRC);
let failed = 0;
const pass = (m) => console.log("  [PASS] " + m);
const fail = (m) => {
  console.log("  [FAIL] " + m);
  failed++;
};

/* ── ① 不允许 `querySelector(...) as HTMLElement | null` ─────────
 *
 * `querySelector` 本就返回 `Element | null`，`HTMLElement` 是子类型，
 * 所以 `as HTMLElement | null` **不改变类型** → 冗余断言。
 * 正确写法：`querySelector<HTMLElement>(...)`，保留 null 检查。
 *
 * ⚠️ 反过来，**不带 `| null` 的 `as HTMLElement` 不在管辖范围** ——
 *    那是「去掉 null 直接访问属性」的刻意写法（去掉会给 tsc 带来成片错误），
 *    审核也没报。不要用一条规则把两种情况一起禁掉。
 */
{
  const hits = [];
  // 只匹配「带 | null」的断言：as HTMLElement | null / as HTMLElement|null 等写法
  const re = /querySelector(?:<[^>]*>)?\([^)]*\)\s+as\s+[A-Za-z_$][\w$.]*(?:\s*\|\s*null)+\s*[;,)]/g;
  for (const f of files) {
    const code = fs.readFileSync(f, "utf8");
    code.split("\n").forEach((line, i) => {
      if (re.test(line)) hits.push(`src/${path.relative(SRC, f)}:${i + 1}`);
    });
  }
  if (hits.length) {
    fail(
      `存在冗余类型断言（querySelector 返回值本就含 null，断言不改变类型）:\n         ${hits.join("\n         ")}`
    );
  } else {
    pass("无冗余的 querySelector 断言（as ... | null 形式已清零）");
  }
}

/* ── ② 不允许孤儿 import（import 了但正文零引用） ──────────────
 *
 * ⚠️ 判据的三个坑（都实测踩过，写错会误报 22 处、或漏报真孤儿）：
 *   ① 必须剥掉 `type ` 前缀 —— `import type { X }` 的 clause 首段就是 "type"，
 *      不剥会被当成「默认导入名叫 type」而误报。
 *   ② 必须按 `from "..."` 切出**单条** import 语句，不能用跨行贪婪匹配 ——
 *      否则会一路吃到后面的 `from`，把函数调用也当成 import 的一部分。
 *   ③ 计数用的边界**不能排除前导 `.`**。展开运算符写法
 *      `items.push(...itemsFromICS(x))` 里名字紧跟一个 `.`，
 *      若用 `(?<![\w$.])` 会误判成「零引用」。只排除词字符即可。
 */
{
  const hits = [];
  for (const f of files) {
    const code = fs.readFileSync(f, "utf8");
    // 单条 import 语句：import <clause> from "<path>";
    const stmtRe = /^import\s+([\s\S]*?)\s+from\s+"[^"]+";?/gm;
    let m;
    while ((m = stmtRe.exec(code)) !== null) {
      const clause = m[1];
      const names = [];
      const braceStart = clause.indexOf("{");

      // 默认导入（import Foo from / import Foo, { ... } from）
      if (braceStart >= 0) {
        // ⚠️ ① clause 可能是 "type { X }"，首段要连 type 一起剥掉
        const def = clause
          .slice(0, braceStart)
          .replace(/,\s*$/, "")
          .replace(/^type\s+/, "")
          .trim();
        if (def && !def.startsWith("*")) names.push(def);
        // 命名导入：剥 type 前缀，取别名
        const inner = clause.slice(braceStart + 1, clause.lastIndexOf("}"));
        for (const part of inner.split(",")) {
          let n = part.trim();
          if (!n) continue;
          n = n.replace(/^type\s+/, ""); // ①
          n = n.split(/\s+as\s+/).pop().trim();
          if (n) names.push(n);
        }
      } else {
        const def = clause.replace(/^type\s+/, "").trim(); // ①
        if (def && !def.startsWith("*")) names.push(def);
      }

      // ② 精确切掉这条 import，剩下的才是"正文"
      const body = code.slice(0, m.index) + code.slice(m.index + m[0].length);

      for (const n of names) {
        if (!/^[A-Za-z_$][\w$]*$/.test(n)) continue;
        const use = new RegExp("(?<![\\w$])" + n + "(?![\\w$])", "g"); // ③
        if ((body.match(use) || []).length === 0) {
          hits.push(`src/${path.relative(SRC, f)} → ${n}`);
        }
      }
    }
  }
  if (hits.length) {
    fail(`存在孤儿 import（import 了但正文零引用）:\n         ${hits.join("\n         ")}`);
  } else {
    pass(`无孤儿 import（已扫描 ${files.length} 个源文件）`);
  }
}

/* ── ③ 确认上面两条判据本身在工作（注入假阳性） ──────────────────
 *
 * 「检查项全过」≠「检查器在工作」。对① 用必然冗余的样本自测；
 * 对 ② 直接构造三种 import 语句（含两个应豁免的反例）跑同一套解析逻辑。
 */
{
  // ① 冗余断言判据
  const SAMPLES = [
    { src: 'const a = el.querySelector("[x]") as HTMLElement | null;', want: 1 },
    { src: 'const b = el.querySelector("[x]") as HTMLElement;', want: 0 },
    { src: 'const c = el.querySelector<HTMLElement>("[x]");', want: 0 },
    { src: 'const d = el.querySelector("[x]") as HTMLDivElement | null, e = 1;', want: 1 },
  ];
  const re = /querySelector(?:<[^>]*>)?\([^)]*\)\s+as\s+[A-Za-z_$][\w$.]*(?:\s*\|\s*null)+\s*[;,)]/g;
  const wrong = SAMPLES.filter((s) => (s.src.match(re) || []).length !== s.want);
  if (wrong.length) {
    fail("冗余断言判据自身失效，用例未达预期: " + wrong.map((w) => w.src).join(" | "));
  } else {
    pass("冗余断言判据自测通过（4 个用例，含 2 个应豁免的反例）");
  }

  // ② 孤儿 import 解析判据 —— 用真实代码片段跑同一套名字提取逻辑
  const parseNames = (clause) => {
    const names = [];
    const braceStart = clause.indexOf("{");
    if (braceStart >= 0) {
      const def = clause
        .slice(0, braceStart)
        .replace(/,\s*$/, "")
        .replace(/^type\s+/, "")
        .trim();
      if (def && !def.startsWith("*")) names.push(def);
      const inner = clause.slice(braceStart + 1, clause.lastIndexOf("}"));
      for (const part of inner.split(",")) {
        let n = part.trim();
        if (!n) continue;
        n = n.replace(/^type\s+/, "");
        n = n.split(/\s+as\s+/).pop().trim();
        if (n) names.push(n);
      }
    } else {
      const def = clause.replace(/^type\s+/, "").trim();
      if (def && !def.startsWith("*")) names.push(def);
    }
    return names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  };

  const NAME_CASES = [
    { clause: "{ a, b }", want: ["a", "b"] },
    { clause: "type { A }", want: ["A"] }, // ①type 前缀不是名字
    { clause: "{ a as b }", want: ["b"] }, // 别名取别名
    { clause: "Foo, { bar }", want: ["Foo", "bar"] },
    { clause: "type Foo", want: ["Foo"] },
    { clause: "{ itemsFromICS }", want: ["itemsFromICS"] },
  ];
  const nameWrong = NAME_CASES.filter(
    (c) => JSON.stringify(parseNames(c.clause)) !== JSON.stringify(c.want)
  );
  if (nameWrong.length) {
    fail(
      "import 名字提取判据失效: " +
        nameWrong.map((c) => `${c.clause} → ${JSON.stringify(parseNames(c.clause))}，期望 ${JSON.stringify(c.want)}`).join(" | ")
    );
  } else {
    pass(`import 名字提取判据自测通过（${NAME_CASES.length} 个用例）`);
  }

  // ③ 计数边界不能排除前导 `.`（展开运算符写法）
  const countUse = (body, n) => (body.match(new RegExp("(?<![\\w$])" + n + "(?![\\w$])", "g")) || []).length;
  const USE_CASES = [
    { body: "items.push(...itemsFromICS(ics));", name: "itemsFromICS", want: 1 },
    { body: "const a = 1;", name: "itemsFromICS", want: 0 },
    { body: "foo.bar();", name: "bar", want: 1 },
  ];
  const useWrong = USE_CASES.filter((c) => countUse(c.body, c.name) !== c.want);
  if (useWrong.length) {
    fail(
      "引用计数边界失效: " + useWrong.map((c) => `${JSON.stringify(c.body)} 中 ${c.name} 计数为 ${countUse(c.body, c.name)}，期望 ${c.want}`).join(" | ")
    );
  } else {
    pass(`引用计数边界自测通过（${USE_CASES.length} 个用例，含展开运算符写法）`);
  }
}

console.log(
  failed
    ? `\n✗ 审核静态扫描类回归测试失败：${failed} 项不符`
    : "\n✓ 审核静态扫描类回归测试通过"
);
process.exit(failed ? 1 : 0);
