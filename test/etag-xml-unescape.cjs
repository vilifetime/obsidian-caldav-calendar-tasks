/**
 * 回归测试：CalDAV etag 的 XML 转义还原（2026-10-20 修复）。
 *
 * 背景：服务端（Baïkal/sabre）的 getetag 以 XML 转义形态返回 `&quot;xxxx&quot;`，
 * 旧版 parseMultistatus 只对 calendar-data 反解码、漏了解 etag，导致本地存进
 * `&quot;xxxx&quot;`。发送端 putItem/deleteItem 又给包一层引号 →
 * `If-Match: ""&quot;xxxx&quot;""` → 所有条件 PUT/DELETE 返回 412。
 * 表现为：任何「纯拉取、从未在本地改过」的条目，一删/一改就报 412。
 *
 * 修复：parseMultistatus 对 etag/href/ics 统一 unescapeXml，并新增 sanitizeEtag
 * （反解码 + 剥 DAV 引号 → 纯 hex，与 putItem 响应头一致）；store.load() 加载时
 * 对残留 &quot; 的 etag 幂等自愈。
 *
 * 用法：node test/etag-xml-unescape.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const ROOT = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "obs-etag-"));

// 编译 caldav.ts 及其依赖树（不牵出 obsidian 全局，可在 node 里直接 require）。
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/core/caldav.ts")],
  outdir: OUT,
  bundle: true,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
});

const { sanitizeEtag, parseMultistatus } = require(path.join(OUT, "caldav.js"));

// ── 1. sanitizeEtag 行为 ──
assert.strictEqual(
  sanitizeEtag('&quot;a36652e6f28cdc9201772d4ed8be15de&quot;'),
  "a36652e6f28cdc9201772d4ed8be15de",
  "sanitizeEtag 应把 &quot; 包裹反解码成纯 hex"
);
assert.strictEqual(
  sanitizeEtag("a36652e6f28cdc9201772d4ed8be15de"),
  "a36652e6f28cdc9201772d4ed8be15de",
  "已是纯 hex 应原样返回（幂等）"
);
assert.strictEqual(
  sanitizeEtag('"a36652e6f28cdc9201772d4ed8be15de"'),
  "a36652e6f28cdc9201772d4ed8be15de",
  "带字面引号的 DAV 引用字符串应剥引号"
);
assert.strictEqual(
  sanitizeEtag('&quot;3c96c5a94b1aa97fc5110540e69b6e84&quot;'),
  "3c96c5a94b1aa97fc5110540e69b6e84",
  "另一个样本也应还原"
);
console.log("  [PASS] sanitizeEtag：&quot; 包裹 / 纯 hex / 字面引号 三种形态都正确");

// ── 2. parseMultistatus：真实服务器响应（etag 带 &quot;）解析后必须干净 ──
const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
<d:response>
<d:href>/dav.php/calendars/bonebear/default/sy-mvgcy8o8-m3snnrp7.ics</d:href>
<d:propstat><d:prop>
<d:getetag>&quot;a36652e6f28cdc9201772d4ed8be15de&quot;</d:getetag>
<cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:sy-mvgcy8o8-5e2sh8b3
SUMMARY:测试全天事件1
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261020
END:VEVENT
END:VCALENDAR
</cal:calendar-data>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
</d:multistatus>`;

const items = parseMultistatus(xml, { url: "http://nas.bonebear.cn:5808/dav.php/calendars/bonebear/default/" });
assert.strictEqual(items.length, 1, "应解析出 1 条条目");
assert.strictEqual(items[0].etag, "a36652e6f28cdc9201772d4ed8be15de", "parseMultistatus 的 etag 不得残留 &quot;");
assert.ok(!items[0].etag.includes("&quot;"), "etag 不得再含 &quot;");
assert.strictEqual(items[0].uid, "sy-mvgcy8o8-5e2sh8b3", "UID 应正确解析");
assert.strictEqual(items[0].href, "http://nas.bonebear.cn:5808/dav.php/calendars/bonebear/default/sy-mvgcy8o8-m3snnrp7.ics", "href 应为绝对 URL");
console.log("  [PASS] parseMultistatus：&quot; 转义的 etag 解析为干净 hex，href/UID 正确");

// ── 3. 源码断言：store.load() 加载时幂等自愈污染 etag ──
const store = fs.readFileSync(path.join(ROOT, "src/core/store.ts"), "utf8").replace(/\r\n/g, "\n");
assert.ok(
  store.includes('typeof it.etag === "string"') && store.includes("&(quot|amp|lt|gt|apos);"),
  "store.load() 应检测并还原 &quot; 等被 XML 转义的 etag"
);
assert.ok(store.includes("it.etag = sanitizeEtag(it.etag)"), "store.load() 应调用 sanitizeEtag 自愈");
console.log("  [PASS] store.load()：加载时幂等自愈 &quot; 污染的 etag");
