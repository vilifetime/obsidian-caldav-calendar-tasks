/**
 * 编辑不能丢数据 —— ICS 原文（raw）必须跟着拉取一起下来（2026-10-14 数据丢失事故回归）
 *
 * 为什么单独一个文件：这是本次事故的根因，而且它与「附件功能」无关 ——
 * 任何一次编辑都可能把服务端的 ORGANIZER / ATTENDEE / VTIMEZONE / X- 扩展属性
 * / 二进制 ATTACH / 同一资源里的其它组件一并抹掉。
 *
 * 根因：`itemsFromICS` 从不把服务端原文写进 `item.raw`，于是 `itemToEditedICS`
 * 退化成 `itemToNewICS` 从 CalItem 整份重拼。实测用户本地 250 条里只有 9 条有
 * raw（全是插件自己新建的），其余 241 条全部中招。
 *
 * 本文件与思源侧 `test/todo-attach.cjs` 的「数据丢失回归」段同构，
 * 但**不依赖附件功能**（附件还没移植过来），只钉 raw / 组件定位 / 自愈这三件事。
 *
 * ⚠️ 用例一律**不手工补 `it.raw`** —— 手工补原文正是当初让真 bug 一路绿灯的原因。
 *
 * 用法：node test/ics-raw.cjs
 */
const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 源码是 TS，Node 不能直接 require —— 用 tsc 编译到临时目录再引（与思源侧同一套路）
// --resolveJsonModule：store.ts → ../i18n → *.json，不加这个 flag 编译直接失败
const outDir = path.join(ROOT, ".test-icsraw");
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts ` +
    `--outDir .test-icsraw --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "inherit" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
// store.ts → config-backup.ts → `obsidian`，而 node_modules/obsidian 只有 .d.ts
// （Obsidian API 的官方做法：类型声明，运行时代码由宿主注入）。Node 里 require 不到，
// 在这里垫一个桩。只用到 normalizePath，别的都是 type-only import。
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
      `// 测试桩：只实现被测代码真正调用到的那一个函数。\n` +
      `// 路径规范化在 POSIX 语义下就是原样返回（反斜杠换正斜杠、去掉重复斜杠），\n` +
      `// 本测试不涉及真实文件系统，够用。\n` +
      `exports.normalizePath = function normalizePath(p) {\n` +
      `  return String(p).replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");\n` +
      `};\n`
  );
}
// Obsidian 的 persistSoon 走 window.setTimeout —— popout 窗口是独立 window 对象，
// 裸 setTimeout 绑的是主窗口、窗口不可见时不执行，所以必须 window. 前缀（这是对的）。
// 但 Node 里没有 window，垫一个只透传定时器的桩。本测试不验证落盘时序。
global.window = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};
// 编译清单跨了 src/core 与 src/（constants.ts），tsc 推定的公共根是 src/，
// 产物因此落在 core/ 下 —— 别照抄思源侧的平铺路径。
const ics = require(path.join(outDir, "core", "ics.js"));
const storeMod = require(path.join(outDir, "core", "store.js"));

let failed = 0;
function check(name, cond, hint) {
  if (cond) console.log("  [PASS] " + name);
  else {
    console.log("  [FAIL] " + name + (hint ? " —— " + hint : ""));
    failed++;
  }
}

/** 一份带「未管理属性」的待办原文：二进制 ATTACH / ORGANIZER / ATTENDEE / VTIMEZONE / X- */
function makeIcs() {
  const BIN = Buffer.from("binary-blob").toString("base64");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VTODO",
    "UID:raw-1@test",
    "SUMMARY:带未管理属性的待办",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "ORGANIZER:mailto:boss@example.com",
    "ATTENDEE;CN=小红:mailto:xh@example.com",
    "X-CUSTOM-FLAG:keepme",
    `ATTACH;VALUE=BINARY;ENCODING=BASE64;FBTYPE=application/msword;X-LINK-UID=x1:${BIN}`,
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
}

const parse = (raw) => ics.itemsFromICS(raw, "http://cal/", "http://cal/raw-1.ics", '"e1"')[0];

console.log("数据丢失回归：拉取必须带上 ICS 原文");

{
  const it = parse(makeIcs());
  const raw = it.raw || "";
  check(
    "服务端解析出的条目自带 raw",
    typeof it.raw === "string" && raw.includes("BEGIN:VCALENDAR"),
    "没有 raw → 编辑走 itemToNewICS 整份重拼，服务端属性全丢（2026-10-14 实测）"
  );
  check(
    "raw 是整份资源（含 VCALENDAR 外壳，VTIMEZONE 才保得住）",
    raw.includes("BEGIN:VCALENDAR") && raw.includes("END:VCALENDAR") && raw.includes("BEGIN:VTODO")
  );
}

{
  // 最关键的一条：**完全不碰 raw**，只改标题，未管理属性必须都还在。
  const it = parse(makeIcs());
  it.summary = "改了标题";
  const out = ics.itemToEditedICS(it);
  check("不补 raw：标题确实改了（对照组）", out.includes("SUMMARY:改了标题"));
  check("不补 raw：ORGANIZER 保留", out.includes("ORGANIZER:mailto:boss@example.com"));
  check("不补 raw：ATTENDEE 保留", out.includes("ATTENDEE;CN=小红:mailto:xh@example.com"));
  check("不补 raw：VTIMEZONE 保留", out.includes("BEGIN:VTIMEZONE") && out.includes("TZID:Asia/Shanghai"));
  check("不补 raw：X- 扩展属性保留", out.includes("X-CUSTOM-FLAG:keepme"));
  check(
    "不补 raw：二进制 ATTACH 保留",
    /ATTACH;VALUE=BINARY/.test(out) && out.includes(Buffer.from("binary-blob").toString("base64"))
  );
}

{
  // 同一份资源里两个 VTODO：编辑一个，另一个必须原样不动、且不能被打成一条
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:multi-a@test",
    "SUMMARY:甲",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "END:VTODO",
    "BEGIN:VTODO",
    "UID:multi-b@test",
    "SUMMARY:乙",
    "DTSTART:20261022T090000",
    "DUE:20261023T090000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const items = ics.itemsFromICS(raw, "http://cal/", "http://cal/multi.ics", '"e1"');
  check("一份资源解析出 2 个条目", items.length === 2, "实际 " + items.length);
  const b = items.find((i) => i.uid === "multi-b@test");
  b.summary = "乙改过了";
  const out = ics.itemToEditedICS(b);
  check("同资源的另一条组件原样保留", out.includes("SUMMARY:甲"));
  check("目标组件真的改了", out.includes("SUMMARY:乙改过了"));
  check("两条组件都还在（没被压成一条）", (out.match(/BEGIN:VTODO/g) || []).length === 2);
}

{
  // 周期性例外：与主条目 UID 相同，只能靠 RECURRENCE-ID 区分
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:rec-1@test",
    "SUMMARY:主条目",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VTODO",
    "BEGIN:VTODO",
    "UID:rec-1@test",
    "RECURRENCE-ID:20261021T090000",
    "SUMMARY:例外",
    "DTSTART:20261021T100000",
    "DUE:20261022T100000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const items = ics.itemsFromICS(raw, "http://cal/", "http://cal/rec.ics", '"e1"');
  check("周期性资源解析出主条目 + 例外", items.length === 2, "实际 " + items.length);
  const ov = items.find((i) => i.recurId);
  check("例外条目带 recurId", !!ov && ov.recurId === "2026-10-21T09:00:00", JSON.stringify(ov && ov.recurId));
  ov.summary = "例外改过了";
  const out = ics.itemToEditedICS(ov);
  check("例外条目改的是例外自己", out.includes("SUMMARY:例外改过了"));
  check("主条目标题没被顺手改掉", out.includes("SUMMARY:主条目"), out);
  // 真正钉死「写对组件」的判据：例外条目自己没有 RRULE，
  // 一旦把改动写进主条目（只比 UID 的写法就会这样），主条目的 RRULE 随之消失。
  check("主条目的 RRULE 还在（没被例外条目覆盖掉）", out.includes("RRULE:FREQ=DAILY;COUNT=3"), out);
  check("例外组件的 RECURRENCE-ID 还在", /RECURRENCE-ID:2026\d{4}T\d{6}Z?/.test(out), out);
}

{
  // 原文里找不到目标组件 → **抛错**，绝不能静默整份重拼（那正是数据丢失的形态）
  const it = parse(makeIcs());
  it.raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:完全是另一个@test",
    "SUMMARY:别人",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  let threw = "";
  try {
    ics.itemToEditedICS(it);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("原文里没有目标组件时抛错（而不是整份重拼丢数据）", /找不到/.test(threw), "实际: " + threw);
  check("报错信息带 UID，便于定位", threw.includes("raw-1@test"));
}

console.log("\n数据丢失回归：mergeServerItems 给老数据自愈");

{
  const s = new storeMod.CalStore({ loadData: async () => ({}), saveData: async () => {} });
  const serverItem = parse(makeIcs());
  const legacy = { ...serverItem };
  delete legacy.raw; // 老数据：内容一致但没有原文
  s.put(legacy);
  const r1 = s.mergeServerItems([serverItem], []);
  const key = storeMod.keyOf(serverItem);
  check("老条目被判定为无变化（etag 相同）", r1.applied === 0, JSON.stringify(r1));
  check(
    "无变化时也补上了 raw（自愈生效）",
    typeof s.get(key)?.raw === "string",
    "etag 相同会 continue，不补 raw 的话老条目的下次编辑照样毁数据"
  );
  const healed = s.get(key);
  healed.summary = "自愈后编辑";
  const out = ics.itemToEditedICS(healed);
  check("自愈后编辑，ORGANIZER 还在", out.includes("ORGANIZER:mailto:boss@example.com"));
  check("自愈后编辑，VTIMEZONE 还在", out.includes("BEGIN:VTIMEZONE"));
  check("自愈不计入拉取数、但标记 changed 让它落盘", r1.applied === 0 && r1.changed === true, JSON.stringify(r1));
}

console.log("\n数据丢失回归：源码防漂移");

{
  const icsSrc = read("src/core/ics.ts");
  const fn = /export function itemsFromICS\(([\s\S]*?)\n\}/.exec(icsSrc);
  check("能定位 itemsFromICS", !!fn);
  check(
    "itemsFromICS 把 text 传给 itemFromComponent",
    /itemFromComponent\(comp,\s*"(event|todo)",\s*calendarUrl,\s*href,\s*etag,\s*text\)/.test(fn?.[1] || ""),
    "少传一个参数 → 拉回来的条目全都没有 raw → 每次编辑都整份重拼"
  );
  check("itemFromComponent 收 raw 参数", /etag\?: string,\s*raw\?: string/.test(icsSrc));
  // ⚠️ 行尾要用 \r?\n：本仓库是 CRLF，写死 \n 会假红（2026-10-14 踩过）
  check("CalItem 字面量里赋了 raw", /const item: CalItem = \{[\s\S]*?\braw,\r?\n/.test(icsSrc));
  check(
    "组件定位用 UID + RECURRENCE-ID（不是只比 UID）",
    /recurIdOf\(c\) === want/.test(icsSrc) && !/comps\.find\(\(c\) => firstProp\(c, "UID"\)\?\.value === item\.uid\) \|\| comps\[0\]/.test(icsSrc),
    "只比 UID 会把周期性例外的改动写进主条目"
  );
  check(
    "找不到目标组件时抛错，不退回整份重拼",
    /已中止写入以免丢失其它属性/.test(icsSrc) && !/if \(!match\) return itemToNewICS/.test(icsSrc)
  );
  const storeSrc = read("src/core/store.ts");
  check(
    "mergeServerItems 有 adoptRaw 自愈（老数据补原文）",
    /const adoptRaw = \(cur: CalItem, inc: CalItem\)/.test(storeSrc) && /adoptRaw\(cur, inc\)/.test(storeSrc),
    "不给 2026-10-14 之前的老条目补 raw，它们的下一次编辑照样毁数据"
  );
  check(
    "pushDirty 有原文才走增量改写",
    /const ics = item\.raw \? itemToEditedICS\(item, dropBinary\) : itemToNewICS\(item, dropBinary\);/.test(read("src/core/sync.ts"))
  );
}

console.log(failed === 0 ? "\n✓ ICS 原文回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
