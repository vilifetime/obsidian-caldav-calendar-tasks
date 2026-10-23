/**
 * 回归测试：iCloud 在 calendar-data 外包 <![CDATA[ ]]>，必须剥离；否则 item.raw 被
 * 污染 → itemToEditedICS 误吐裸组件 → iCloud PUT 判 HTTP 400（2026-10-23「无附件也
 * 400」根因，与附件无关）。与思源侧 core.test.mjs 的两条 CDATA 用例同构。
 *
 * 背景：iCloud 实测返回的 calendar-data 是 <calendar-data><![CDATA[BEGIN:VCALENDAR…
 * ]]></calendar-data> 形态。旧 parseMultistatus 把 CDATA 包裹符一起抓进 item.raw，
 * 污染后 itemToEditedICS 解析不出 VCALENDAR 层、只吐裸 VTODO → 严格服务器判 body
 * 非法 → 400。且 since raw 里仍含 BEGIN:VCALENDAR 子串，兜底判断必须用「解析出的
 * VCALENDAR 组件数」而非字符串子串，否则漏判。
 *
 * 用法：node test/cdata-edit.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const ROOT = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cdata-"));

// 编译 caldav.ts / ics.ts（含依赖树，bundle 后可在 node 直接 require）
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/core/caldav.ts"), path.join(ROOT, "src/core/ics.ts")],
  outdir: OUT,
  bundle: true,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
});

const { parseMultistatus } = require(path.join(OUT, "caldav.js"));
const { itemToEditedICS } = require(path.join(OUT, "ics.js"));

// ── 1. parseMultistatus：CDATA 包裹必须剥离 ──
const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
<d:response>
<d:href>/cal/sy-cdata-mvi7xtb1-3jcke8nn.ics</d:href>
<d:propstat><d:prop>
<d:getetag>"mvi8mw76"</d:getetag>
<cal:calendar-data><![CDATA[BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//MailClient.VObject/11.0.1267.0
BEGIN:VTODO
UID:sy-cdata-mvi7xtb1-3jcke8nn
SUMMARY:测试任务
DUE:20261023T180000Z
END:VTODO
END:VCALENDAR]]></cal:calendar-data>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
</d:multistatus>`;
const items = parseMultistatus(xml, { url: "https://pxx-caldav.icloud.com/cal/" });
assert.strictEqual(items.length, 1, "应解析出 1 条");
assert.ok(!items[0].raw.includes("CDATA"), "raw 不应残留 <![CDATA[ 包裹符");
assert.ok(items[0].raw.startsWith("BEGIN:VCALENDAR"), "raw 应以 BEGIN:VCALENDAR 开头（而非 <![CDATA[）");
assert.strictEqual(items[0].uid, "sy-cdata-mvi7xtb1-3jcke8nn");
assert.strictEqual(items[0].summary, "测试任务");

// ── 2. itemToEditedICS：CDATA 污染 raw 兜底补信封 ──
const cdataRaw =
  "<![CDATA[BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//MailClient.VObject/11.0.1267.0\r\n" +
  "BEGIN:VTODO\r\nUID:sy-cdata-mvi7xtb1-3jcke8nn\r\nSUMMARY:测试任务\r\nDUE:20261023T180000Z\r\n" +
  "PERCENT:0\r\nEND:VTODO\r\nEND:VCALENDAR]]>";
const item = {
  kind: "todo",
  uid: "sy-cdata-mvi7xtb1-3jcke8nn",
  summary: "测试任务",
  due: "2026-10-23T18:00:00",
  start: "2026-10-23T10:00:00",
  raw: cdataRaw,
  etag: "mvi8mw76",
  attachments: [],
  percent: 0,
  priority: 0,
};
const out = itemToEditedICS(item);
assert.ok(out.startsWith("BEGIN:VCALENDAR"), "产物必须以 BEGIN:VCALENDAR 开头（带信封）");
assert.ok(out.includes("BEGIN:VTODO"), "产物应包含 VTODO");
assert.ok(out.includes("SUMMARY:测试任务"), "产物应保留原 SUMMARY");
assert.ok(out.includes("END:VCALENDAR"), "产物应以 END:VCALENDAR 结尾");
assert.ok(!out.includes("CDATA"), "产物绝不可残留 CDATA 包裹符");
assert.ok(
  out.indexOf("BEGIN:VTODO") > out.indexOf("BEGIN:VCALENDAR"),
  "VTODO 必须嵌套在 VCALENDAR 之内（不是裸组件）"
);

console.log("OK: cdata-edit 全部通过（parseMultistatus 剥离 + itemToEditedICS 兜底补信封）");
