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

/* ---- CSS 专项：!important ----
   社区扫描明确点名这条。2026-10-07 清理时发现 16 处里有 15 处是**思源死代码**
   （b3-dialog__* / caldav-mobile-dialog 等在 Obsidian 版 TS 中根本不存在的类），
   唯一「活」的那处靠提高选择器特异性解决，无需 !important。

   **必须剥掉注释再匹配** —— 清理时留下了多处解释「为什么移除」的注释，
   注释里出现 !important 会被误判。 */
const cssPath = "src/styles.css";
const cssRaw = fs.readFileSync(cssPath, "utf8");
const cssStripped = strip(cssRaw);

/* ---- artifact attestation（构建溯源签名）----
   社区扫描的 Recommendation 项：「Missing GitHub artifact attestations for
   release assets」。

   ⚠️ 只查**配置**，查不了线上是否已生成 —— 后者要拿产物的 sha256 去问
   GitHub API（`GET /attestations/{sha256}`），而自查脚本跑在本地、没有网络。
   所以这里防的是「配置漏了」，实际上传成功与否仍要看 Actions 日志。
   踩过的坑：第一次只写 `id-token: write`、漏了 `attestations: write`，
   线上一直报「Failed to persist attestation: Resource not accessible by
   integration」—— 官方文档要求三项齐全。
   ⚠️ 且**改了工作流必须重打 tag**：`rerun` 跑的是当时那一版 YAML，
   不重新读main 的最新文件。 */
{
  const wfPath = ".github/workflows/release.yml";
  if (fs.existsSync(wfPath)) {
    const wf = fs.readFileSync(wfPath, "utf8");
    const hasStep = /actions\/attest-build-provenance@v\d/.test(wf);
    const hasIdToken = /id-token:\s*write/.test(wf);
    const hasAttestations = /attestations:\s*write/.test(wf);
    // attest 必须排在 Release 创建之后 —— 它签的是「已上传的产物」
    const stepAt = wf.indexOf("attest-build-provenance");
    const relAt = wf.indexOf("action-gh-release");
    const orderOk = stepAt > 0 && relAt > 0 && stepAt > relAt;

    const allOk = hasStep && hasIdToken && hasAttestations && orderOk;
    console.log(
      `  [${allOk ? "PASS" : "FAIL"}] 工作流已配置 artifact attestation` +
        (allOk
          ? "（步骤 + id-token + attestations + 顺序）"
          : ` —— step=${hasStep} id-token=${hasIdToken} attestations=${hasAttestations} 顺序=${orderOk}`)
    );
  } else {
    console.log("  [提示] 未找到 .github/workflows/release.yml，跳过 attestation 配置检查");
  }
}
{
  const hits = [...cssStripped.matchAll(/!important/g)];
  const ok = hits.length === 0;
  console.log(
    `  [${ok ? "PASS" : "FAIL"}] styles.css 无 !important（实际 ${hits.length} 处）` +
      (ok ? "" : " —— 改用提高选择器特异性")
  );

  /* :has() 同样被社区扫描点名：「can cause significant performance issues
     due to broad selector invalidation」——它在每次 DOM 变更时会触发匹配关系
     的重评估，在 Obsidian 这种频繁重渲染的宿主里代价明显。
     替代写法：由 JS 直接切class（如 .is-checked），CSS 查普通类。
     同样必须剥注释 —— 替换处留了解释为何不用 :has 的注释。 */
  const hasHits = [...cssStripped.matchAll(/:has\(/g)];
  const hasOk = hasHits.length === 0;
  console.log(
    `  [${hasOk ? "PASS" : "FAIL"}] styles.css 无 :has()（实际 ${hasHits.length} 处）` +
      (hasOk ? "" : " —— 改由 JS 切 class，避免选择器重评估")
  );
  // 顺带扫一下思源遗留类名：它们在 Obsidian 下永不匹配，属于该清的死代码。
  // 只作提示（不算 FAIL）—— 这类残留不影响任何社区报项，
  // 属清理债而非合规问题，别让自查脚本误报成红项。
  const deadClasses = ["b3-dialog", "caldav-mobile-dialog", "caldav-mobile-host", "caldav-resize"];
  const found = deadClasses.filter((c) => cssStripped.includes("." + c));
  if (found.length) {
    console.log(
      `  [提示] styles.css 仍有思源遗留死类名 ${found.length} 种（不影响报项，清理债）：` +
        found.join(", ")
    );
  } else {
    console.log("  [PASS] styles.css 无思源遗留死类名");
  }
}

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
  // ⚠️ 这条不是「禁用 globalThis」—— 社区规范要求**访问宿主对象**用 `window`，
  //    但 `globalThis` 本身在跨环境代码（core 层、Node 测试）里是更稳的写法。
  //    2026-10-06 i18n 改造时被误伤：src/i18n/index.ts 用 globalThis.moment /
  //    globalThis.localStorage 做语言探测，是刻意为之。故改为**精确匹配**
  //    「用 globalThis 取 window 上的宿主对象」才报警。
  "globalThis 取宿主对象（应用 window）": [/globalThis\.(?!moment\b|localStorage\b)/],
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
  // 🔴 2026-10-06 真实故障（两次，同一根因）：
  // 声明式回调收到的是**已建好的 Setting 对象**，
  //   render: (setting: Setting, group: SettingGroup) => void
  //   action: (el: HTMLElement, index: number) => void
  // 不是 (el: HTMLElement)。两种错法的症状不同：
  //   ① render 用错签名 → new Setting(el) 抛异常 → **该行及之后设置项全部消失**
  //   ② action 里再 new Setting(el) → 套出嵌套结构 → **标题竖排、整行重复多次**
  // tsc 都不报错（联合类型的回调参数没有位置约束），只能靠自查 + 实测。
  "render 回调误用 HTMLElement": [/render:\s*\(\s*el: HTMLElement\s*\)/],
  "action 回调里再 new Setting": [/action:[^\n]*\n(?:[^\n]*\n)??[^\n]*new Setting\(/],
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

/* ---- i18n：源码里不该再有硬编码的中文用户可见文案 ----
   2026-10-06 起接入 i18n，目标是「Obsidian 界面语言是英语时插件也显示英语」。
   这条检查防的是回退：新增 UI 文案时顺手写了中文，英文界面就露出汉字，
   而 tsc / eslint / 社区扫描**全都抓不到**。

   ⚠️ 上面的 strip() 不够用 —— 它只去块注释和**独占一行的**行注释，
   而中文残留大量藏在行尾注释里（`const wd = 1; // 周一=0`）。
   故这里另写 stripComments() 处理，详见该函数注释里的坑。 */
/**
 * 剥掉块注释与行注释，**保留所有换行**（行号不能错位，后续还要按行统计）。
 *
 * ⚠️ 这里**故意不用「逐字符状态机」**—— 试过，漏了正则字面量：
 * `/[年月日号]/` 里的内容不含引号还好，但 `/(?:上午|下午)/` 之类一旦与
 * 前后字符串混排，状态就会错乱，表现为**注释没被剥掉、中文行号全部偏位**，
 * 结果是凭空冒出一堆「残留中文」假警报，还容易让人误判成真问题。
 *
 * 改用两条可靠规则：
 *   ① 块注释：先把成对的块注释分隔符整段替换成等长空白（保留换行）。
 *   ② 行注释：逐行找双斜杠，**但要先确认它不在引号内**；确认不了就整行豁免。
 *      宁可漏剥（进白名单人工看），不可错剥（把真代码当注释放过）。
 *
 * ⚠️ 本段注释自身不得出现「块注释起止符」的字面样例 —— 那会提前闭合。
 */
function stripComments(src) {
  let out = src
    // ① HTML 注释：模板字符串里大量使用 `<!-- ... -->`（panel.ts 的工具栏等）。
    //    它不是 JS 注释，但同样是「给人看的说明」，不该被当成待翻译文案。
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    // ② JS 块注释
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return out
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i < 0) return line;
      const head = line.slice(0, i);
      const q = countUnquotes(head);
      // 引号数为奇数说明双斜杠落在字符串里（如 "http://x"）→ 不能剥
      return q % 2 === 0 ? line.slice(0, i) : line;
    })
    .join("\n");
}

/** 数 head 里引号的个数；只作奇偶判断，不作精确解析。 */
function countUnquotes(head) {
  let n = 0;
  for (let i = 0; i < head.length; i += 1) {
    const c = head[i];
    if (c === "\\") { i += 1; continue; }
    if (c === '"' || c === "'" || c === "`") n += 1;
  }
  return n;
}

const CJK_RE = /[一-鿿]/;

/**
 * 允许残留中文的位置。**刻意列出具体行特征，不按文件整体豁免** ——
 * 同一个文件里往往既有该保留的中文（输入解析规则）也有必须改的（UI 文案），
 * 按文件豁免等于把整个文件变成盲区。
 *
 * ⚠️ 白名单自身的正则里也含中文（要匹配中文才行），故它们写在这里而**不放进
 * CJK_RE 的排除逻辑** —— 否则检查会自己豁免自己，白名单形同虚设。
 */
const CJK_ALLOWED = [
  // ① 设置搜索关键词 aliases：Obsidian 的设置搜索框靠它匹配，
  //    刻意中英双语并存（英文界面下用户会搜 "server" / "calendar"），
  //    不走 i18n —— 译成当前语言反而搜不到另一种语言的词。
  { re: /aliases:\s*\[/, why: "设置搜索 aliases（刻意双语）" },
  // ② 中文日期/时间输入解析：识别「下周三」「3月5日」「元旦」「上午9点」这类写法。
  //    这是**输入识别规则**不是 UI 文案 —— 英文界面下粘贴中文标题仍须能识别，
  //    译了就等于功能失效。逐条列出特征码，不做整文件豁免。
  { re: /WEEKDAY_NUM/, why: "中文日期时间输入解析（功能规则，非文案）" },
  { re: /\[\s*"[^"]*",\s*-?\d+\]/, why: "中文日期时间输入解析：相对日词表" },
  { re: /"[^"]*",\s*\d{1,2},\s*\d{1,2}\]/, why: "中文日期时间输入解析：节日表" },
  { re: /[年月日号]/, why: "中文日期时间输入解析：年月日正则" },
  { re: /"(?:每|下|本|这|上|周|星期|礼拜|半)"/, why: "中文日期时间输入解析：星期与时段词" },
  { re: /(?:上午|下午|早上|晚上|中午|傍晚|早晨|凌晨|夜里|半夜)/, why: "中文日期时间输入解析：时段词" },
  // ③ 默认分类名：是**用户数据**不是 UI 文案。
  //    用户库里已存在的中文分类不该因切语言被改写，且这属于用户可自行编辑的内容。
  { re: /\{\s*id:\s*"(?:work|study|life)"/, why: "DEFAULT_CATEGORIES 数据值" },
  // ④ console 输出：只在开发者控制台出现，不属于界面文案。
  { re: /console\.(?:warn|log|error|debug)\(/, why: "console 调试输出" },
];

console.log("");
console.log("  i18n：源码残留中文审计（已剥注释）");
const cjkHits = [];
for (const f of files) {
  const cleaned = stripComments(fs.readFileSync(f, "utf8"));
  cleaned.split("\n").forEach((line, idx) => {
    if (!CJK_RE.test(line)) return;
    const allowed = CJK_ALLOWED.find((a) => a.re.test(line));
    cjkHits.push({ f, n: idx + 1, line: line.trim(), why: allowed?.why ?? null });
  });
}
const violations = cjkHits.filter((h) => !h.why);
const exempted = cjkHits.filter((h) => h.why);
if (violations.length) {
  console.log(`  [FAIL] 源码残留未国际化的中文 ${violations.length} 处：`);
  for (const v of violations) console.log(`         ${v.f}:${v.n}  ${v.line}`);
} else {
  console.log(`  [PASS] 源码无未国际化的中文（另有 ${exempted.length} 处按白名单豁免）`);
  const byWhy = new Map();
  for (const e of exempted) byWhy.set(e.why, (byWhy.get(e.why) ?? 0) + 1);
  for (const [why, cnt] of byWhy) console.log(`         豁免 ${cnt} 处 —— ${why}`);
}
