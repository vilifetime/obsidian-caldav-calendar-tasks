/**
 * 附件功能第一批回归（2026-10-20 从思源侧同构移植）
 *
 * 覆盖范围（ Obsidian 侧第一批的四件事）：
 *  1. ATTACH 解析 —— URI 外链与 VALUE=BINARY 内嵌两种形式都收进 item.attachments，
 *     文件名优先 X-FILENAME 参数、否则按 MIME 推扩展名；多个 ATTACH 全收。
 *  2. X-FILENAME 序列化 —— 裸写优先，只编码 `% / , : ; "` 五个会破坏 ICS 行结构的字符；
 *     中文等非 ASCII 原样透传（emClient 实测：整体 encodeURIComponent 会显示乱码）。
 *  3. unescapeText 单遍扫描 —— 字面「反斜杠+n」不能被误读成换行（多轮 replace 的老 bug）。
 *  4. 体积常量与换算 —— ATTACH_SIZE_MAX_MB / ICS_SIZE_MAX_MB / mbToBytes / 两个生效值函数。
 *
 * 附带钉住两件老数据相关的事：
 *  - attachments 为 undefined（附件支持之前解析的老数据）时，编辑原样带回原文 ATTACH；
 *  - attachments 一旦存在（哪怕空数组）就以它为准 —— 删空附件的编辑必须真的删掉。
 *
 * 与思源侧 test/todo-attach.cjs 的「X-FILENAME / 编码策略 / unescapeText」段同构，
 * 但**不含编辑器 UI 断言**（Obsidian 附件界面尚未移植，属第三批）。
 *
 * ⚠️ 本仓库是 CRLF：源码断言的行尾一律写 \r?\n，写死 \n 会假红（2026-10-14 踩过）。
 *
 * 用法：node test/attach-ics.cjs
 */
const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 源码是 TS，Node 不能直接 require —— 用 tsc 编译到临时目录再引（与 ics-raw.cjs 同一套路）
const outDir = path.join(ROOT, ".test-attachics");
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts ` +
    `--outDir .test-attachics --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "inherit" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
// store.ts → config-backup.ts → `obsidian`，node_modules/obsidian 只有 .d.ts，垫个桩
{
  const stubDir = path.join(outDir, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" })
  );
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `"use strict";\n` +
      `exports.normalizePath = function normalizePath(p) {\n` +
      `  return String(p).replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");\n` +
      `};\n`
  );
}
// persistSoon 走 window.setTimeout —— popout 窗口是独立 window 对象（这是对的），
// 但 Node 里没有 window，垫一个只透传定时器的桩。本测试不验证落盘时序。
global.window = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};
// 编译清单跨了 src/core 与 src/（constants.ts），产物落在 core/ 下 —— 别照抄思源侧的平铺路径
const ics = require(path.join(outDir, "core", "ics.js"));

let failed = 0;
function check(name, cond, hint) {
  if (cond) console.log("  [PASS] " + name);
  else {
    console.log("  [FAIL] " + name + (hint ? " —— " + hint : ""));
    failed++;
  }
}

const B64_SHORT = Buffer.from("hello-attach").toString("base64");
// 200 字节的载荷：base64 约 268 字符，必然触发 foldLine 折行，专测折行 round-trip
const B64_LONG = Buffer.alloc(200, 7).toString("base64");

const parse = (raw) => ics.itemsFromICS(raw, "http://cal/", "http://cal/x.ics", '"e1"')[0];

/** 展平折行：foldLine 会在 74 字符处插入 "\r\n "，断言参数值前必须先拼回来 */
const flat = (s) => s.replace(/\r\n[ \t]/g, "");

/** 包一份最小 VCALENDAR；props 是 VTODO 里的属性行 */
function wrap(props) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "BEGIN:VTODO", "UID:att-1@test", "SUMMARY:附件待办", "DUE:20261021T090000", ...props, "END:VTODO", "END:VCALENDAR"].join("\r\n");
}

console.log("ATTACH 解析：两种形式都收，文件名优先 X-FILENAME");

{
  const it = parse(wrap([`ATTACH:https://example.com/docs/周报.pdf`]));
  check("URI 外链收进 attachments", Array.isArray(it.attachments) && it.attachments.length === 1, JSON.stringify(it.attachments));
  check("URI 形式记 uri", it.attachments?.[0].uri === "https://example.com/docs/周报.pdf");
  check("URI 文件名取末段（中文原样）", it.attachments?.[0].name === "周报.pdf", it.attachments?.[0].name);
}

{
  const it = parse(wrap([`ATTACH;VALUE=BINARY;ENCODING=BASE64;FBTYPE=application/msword:${B64_SHORT}`]));
  check("二进制内嵌收进 attachments", it.attachments?.length === 1 && !!it.attachments[0].b64);
  check("base64 原样存（未折行前的完整载荷）", it.attachments?.[0].b64 === B64_SHORT);
  check("无 X-FILENAME 时按 MIME 推名字（总得有个名字显示）", typeof it.attachments?.[0].name === "string" && it.attachments[0].name.length > 0, it.attachments?.[0].name);
  check("FMTTYPE/FBTYPE 都认", it.attachments?.[0].fmttype === "application/msword");
}

{
  const it = parse(wrap([`ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=image/png;X-FILENAME=截图 2026-10-20.png:${B64_SHORT}`]));
  check("X-FILENAME 优先于 MIME 猜测", it.attachments?.[0].name === "截图 2026-10-20.png", it.attachments?.[0].name);
  check("X-FILENAME 里的空格不被吃掉", it.attachments?.[0].name?.includes("2026-10-20"));
}

{
  // firstProp 只能拿第一个 —— 多个 ATTACH 必须遍历全收（漏收 = 编辑一次抹掉其余附件）
  const it = parse(
    wrap([
      "ATTACH:https://example.com/a.pdf",
      `ATTACH;VALUE=BINARY;ENCODING=BASE64;X-FILENAME=b.bin:${B64_SHORT}`
    ])
  );
  check("多个 ATTACH 全收（firstProp 只拿第一个，必须遍历）", it.attachments?.length === 2, JSON.stringify(it.attachments?.map((a) => a.name)));
  check("第一个是外链", it.attachments?.[0].uri === "https://example.com/a.pdf");
  check("第二个是二进制", it.attachments?.[1].b64 === B64_SHORT && it.attachments?.[1].name === "b.bin");
}

{
  // 别的客户端可能写裸 % 的怪值，无脑 decodeURIComponent 会抛 URIError 丢名字
  const it = parse(wrap([`ATTACH;VALUE=BINARY;ENCODING=BASE64;X-FILENAME=50%.pdf:${B64_SHORT}`]));
  check("safeDecodeFilename：裸 % 不抛错、原样返回", it.attachments?.[0].name === "50%.pdf", it.attachments?.[0].name);
}

console.log("\nX-FILENAME 序列化：裸写优先，只编码五个危险字符");

{
  // 中文 + % 混合：% 必须编码（否则解析端 decode 误读），中文必须裸写
  const it = parse(wrap([`ATTACH;VALUE=BINARY;ENCODING=BASE64;X-FILENAME=old.png:${B64_SHORT}`]));
  it.attachments[0].name = "周报 50%.pdf";
  const out = flat(ics.itemToEditedICS(it));
  check("序列化结果带 X-FILENAME 参数", out.includes("X-FILENAME="));
  check("% 编码成 %25（防解析端误读）", out.includes("X-FILENAME=周报 50%25.pdf"), (out.match(/X-FILENAME=[^\r\n]*/) || [""])[0]);
  check("中文裸写、不整体 encodeURIComponent", !out.includes("%E5%91%A8"), "外部客户端（emClient 实测）会显示 %E5%91%A8… 乱码");
  const back = ics.itemsFromICS(out, "http://cal/", "http://cal/x.ics", '"e2"')[0];
  check("round-trip：文件名原样回来", back.attachments?.[0].name === "周报 50%.pdf", back.attachments?.[0].name);
}

{
  // 五个危险字符全上一遍：, : ; " / 各自编码，解析后整体还原
  const it = parse(wrap([`ATTACH;VALUE=BINARY;ENCODING=BASE64;X-FILENAME=old.bin:${B64_SHORT}`]));
  it.attachments[0].name = 'a,b:c;d"e/f%g';
  const out = flat(ics.itemToEditedICS(it));
  const m = /X-FILENAME=([^:]*):/.exec(out);
  check("能抓出 X-FILENAME 参数值", !!m, out.slice(0, 200));
  const v = m?.[1] || "";
  check("逗号编码 %2C", v.includes("%2C"), v);
  check("冒号编码 %3A", v.includes("%3A"), v);
  check("分号编码 %3B", v.includes("%3B"), v);
  check("引号编码 %22", v.includes("%22"), v);
  check("斜杠编码 %2F", v.includes("%2F"), v);
  check("百分号编码 %25", v.includes("%25"), v);
  check("字母数字原样（不过度编码）", v.includes("a") && v.includes("g"), v);
  const back = ics.itemsFromICS(out, "http://cal/", "http://cal/x.ics", '"e3"')[0];
  check("危险字符 round-trip 还原", back.attachments?.[0].name === 'a,b:c;d"e/f%g', back.attachments?.[0].name);
}

{
  // 200 字节载荷必被折行；折行 + X-FILENAME 一起必须 round-trip
  const it = parse(wrap([`ATTACH;VALUE=BINARY;ENCODING=BASE64;X-FILENAME=big.zip:${B64_LONG}`]));
  it.attachments[0].name = "大文件 50%.zip";
  const out = ics.itemToEditedICS(it);
  check("长 base64 确实被折行（对照组）", out.includes("\r\n "));
  const back = ics.itemsFromICS(out, "http://cal/", "http://cal/x.ics", '"e4"')[0];
  check("折行 round-trip：base64 完整还原", back.attachments?.[0].b64 === B64_LONG, back.attachments?.[0].b64?.length);
  check("折行 round-trip：文件名也还原", back.attachments?.[0].name === "大文件 50%.zip", back.attachments?.[0].name);
}

console.log("\n附件接管语义：undefined 原样带回，空数组 = 删光");

{
  // 老数据（附件支持之前解析的）：attachments 为 undefined，插件没接管 → 原文有什么带回什么。
  // 注意：现在的解析器见到二进制 ATTACH 就会填 attachments，所以老数据只能靠 delete 模拟。
  const raw = wrap([`ATTACH;VALUE=BINARY;ENCODING=BASE64;FBTYPE=application/msword;X-LINK-UID=x1:${B64_SHORT}`]);
  const it = parse(raw);
  delete it.attachments;
  assert.ok(it.attachments === undefined, "本用例前提：老数据 attachments 为 undefined");
  it.summary = "只改标题";
  // ⚠️ 必须展平折行再断言：这条 ATTACH 行 76 字符，foldLine 在 74 处折行，
  //    X-LINK-UID=x1 和 base64 都跨在折行点上，直接 includes 会假红
  const out = flat(ics.itemToEditedICS(it));
  check("undefined：原文二进制 ATTACH 原样带回（含 X-LINK-UID）", out.includes("X-LINK-UID=x1") && out.includes(B64_SHORT));
  check("undefined：标题确实改了（对照组）", out.includes("SUMMARY:只改标题"));
}

{
  // 字段一旦存在（哪怕空数组）就以它为准 —— 用户在编辑器里删光附件必须真的落进 ICS
  const it = parse(wrap([`ATTACH;VALUE=BINARY;ENCODING=BASE64;X-FILENAME=a.bin:${B64_SHORT}`]));
  assert.ok(it.attachments?.length === 1, "本用例前提：解析出 1 个附件");
  it.attachments = [];
  const out = ics.itemToEditedICS(it);
  check("空数组：ATTACH 真的被删掉", !out.includes("ATTACH"), "删完附件的条目每轮被服务端拉回，就是这里没删干净");
}

{
  // 接管后新增：从无到有
  // ⚠️ 别用 X-NO-ATTACH 这类属性名占位 —— 名字里含 "ATTACH" 会让下面的 includes 断言恒真
  const it = parse(wrap(["X-CUSTOM:1"]));
  it.attachments = [{ b64: B64_SHORT, name: "new.png", fmttype: "image/png" }];
  const out = ics.itemToEditedICS(it);
  check("新增附件写进 ICS", /ATTACH;VALUE=BINARY;ENCODING=BASE64/.test(out));
  check("新增附件带 X-FILENAME", out.includes("X-FILENAME=new.png"));
}

{
  // dropBinary：iCloud 等不支持内联 base64 的服务器，上传时剥掉二进制内联附件、
  // 只保留 URI 外链（否则 iCloud 拒收、返回 507）。注意这**只**影响序列化输出，
  // 不改 item.attachments 本身（本地仍可显示，待下一轮拉取由服务端为准清理）。
  const it = parse(
    wrap([
      "ATTACH:https://example.com/a.pdf",
      `ATTACH;VALUE=BINARY;ENCODING=BASE64;X-FILENAME=b.bin:${B64_SHORT}`
    ])
  );
  it.attachments.push({ uri: "https://example.com/c.xlsx", name: "c.xlsx", fmttype: "application/vnd.ms-excel" });
  const keepLines = flat(ics.itemToEditedICS(it, true)).split(/\r?\n/).filter((l) => l.startsWith("ATTACH"));
  check("dropBinary=true：URI 外链仍保留", keepLines.some((l) => l.includes("c.xlsx")) && keepLines.some((l) => l.includes("a.pdf")));
  check("dropBinary=true：二进制内联被剥掉", !keepLines.some((l) => l.includes("VALUE=BINARY")));
  check("dropBinary=true：仅剩 URI 外链（a.pdf + c.xlsx）", keepLines.length === 2, "实际 " + keepLines.length);
  const allLines = flat(ics.itemToEditedICS(it, false)).split(/\r?\n/).filter((l) => l.startsWith("ATTACH"));
  check("dropBinary=false：二进制内联仍在", allLines.some((l) => l.includes("VALUE=BINARY")));
  check("dropBinary=false：共 3 条 ATTACH", allLines.length === 3, "实际 " + allLines.length);
}

console.log("\nunescapeText：单遍扫描，字面反斜杠+n 不是换行");

{
  check("字面「反斜杠+n」原样解回（老 bug：被误读成换行）", ics.unescapeText("a\\\\nb") === "a\\nb", JSON.stringify(ics.unescapeText("a\\\\nb")));
  check("真转义 \\n 解成换行", ics.unescapeText("a\\nb") === "a\nb");
  check("大写 \\N 也解成换行（RFC 5545 允许）", ics.unescapeText("a\\Nb") === "a\nb");
  check("\\, 与 \\; 还原", ics.unescapeText("a\\,b\\;c") === "a,b;c");
  check("\\\\ 还原成单个反斜杠", ics.unescapeText("a\\\\b") === "a\\b");
  check("未知转义 \\x 原样保留（宽容解析）", ics.unescapeText("a\\xb") === "a\\xb");

  // 经 escapeText → unescapeText 全链路：备注里先写反斜杠再写 n
  const it = parse(wrap([]));
  it.description = "路径 C:\\\\temp 与换行\n第二行";
  const out = ics.itemToEditedICS(it);
  const back = ics.itemsFromICS(out, "http://cal/", "http://cal/x.ics", '"e5"')[0];
  check(
    "全链路：反斜杠+n 字面量保真",
    back.description === "路径 C:\\\\temp 与换行\n第二行",
    JSON.stringify(back.description)
  );
}

console.log("\n体积常量与换算");

{
  check("ATTACH_SIZE_MAX_MB 默认 5", ics.ATTACH_SIZE_MAX_MB === 5);
  check("ICS_SIZE_MAX_MB 默认 10", ics.ICS_SIZE_MAX_MB === 10);
  check("mbToBytes 正常换算", ics.mbToBytes(2.5, 5) === 2.5 * 1024 * 1024);
  check("mbToBytes undefined 回退默认", ics.mbToBytes(undefined, 5) === 5 * 1024 * 1024);
  check("mbToBytes 0/负数回退默认", ics.mbToBytes(0, 5) === 5 * 1024 * 1024 && ics.mbToBytes(-1, 5) === 5 * 1024 * 1024);
  check("attachSizeMaxBytes 读设置值", ics.attachSizeMaxBytes({ attachSizeMaxMB: 7 }) === 7 * 1024 * 1024);
  check("attachSizeMaxBytes 老数据回退 5MB", ics.attachSizeMaxBytes({}) === 5 * 1024 * 1024);
  check("icsSizeMaxBytes 读设置值", ics.icsSizeMaxBytes({ icsSizeMaxMB: 20 }) === 20 * 1024 * 1024);
  check("icsSizeMaxBytes null 回退 10MB", ics.icsSizeMaxBytes(null) === 10 * 1024 * 1024);
}

console.log("\n源码防漂移");

{
  const src = read("src/core/ics.ts");
  const managed = /const MANAGED = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  check("MANAGED 含 ATTACH（否则界面上增删附件落不进 ICS）", !!managed && /"ATTACH"/.test(managed[1]));
  // 源码断言一律用字符串包含，不写正则 —— 转义层数一多就看不出在匹配什么
  check(
    "icsFilenameParam 只编码五个危险字符",
    src.includes('.replace(/[%/,:;"]/g,'),
    "字符类必须是 [%/,:;\"] —— 多编码一个中文就变 emClient 乱码，少编码一个就破坏行结构"
  );
  check(
    "X-FILENAME 只挂在二进制分支",
    src.includes('...(a.name ? { "X-FILENAME": icsFilenameParam(a.name) } : {})')
  );
  check(
    "unescapeText 是单遍扫描",
    src.includes("s.replace(/\\\\(n|N|,|;|\\\\)/g") && !src.includes("s.replace(/\\\\n/gi"),
    "拆成多轮 replace 会把字面「反斜杠+n」误读成换行"
  );
  check(
    "解析端走 safeDecodeFilename",
    /safeDecodeFilename\(fname\)/.test(src) && /function safeDecodeFilename/.test(src),
    "别的客户端可能写裸 % 值，无脑 decodeURIComponent 会抛 URIError 丢名字"
  );
  check(
    "attachments undefined 时原样带回原文 ATTACH",
    /if \(item\.attachments === undefined\) \{[\s\S]*?if \(p\.name === "ATTACH"\) props\.push\(p\);/.test(src),
    "老数据不接管就原样带回，否则升级后第一次编辑抹掉服务端附件"
  );
}

console.log(failed === 0 ? "\n✓ 附件第一批回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
