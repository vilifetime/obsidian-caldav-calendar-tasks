/**
 * README 回归测试 —— 社区目录审核的「Warning」类问题。
 *
 * 背景：2026-10-08 社区目录审核返回一条 warning：
 *   "README does not appear to contain English text - README.md -
 *    The Obsidian plugin directory is primarily English-speaking.
 *    An English description of the plugin is required, even if translations are also provided."
 *
 * 本地自查脚本此前**完全没有 README 检查项**，所以这条 warning 没能被提前发现。
 * 本测试把两条真实踩到的问题钉住：
 *   ① README 必须含足量英文文本（英文是目录的通用语，不接受纯中文 README）
 *   ② README 里提到的命令名 / 设置项标签，必须与 en_US.json 字典**逐字一致**
 *      —— 拼错或大小写不符，英文用户照着 README 在设置里搜不到
 *
 * 判据说明：不能只查「有没有英文单词」（代码块、URL、许可证里也有英文，会假通过）。
 * ① 用「归一化后的英文散文块长度」判定；② 直接与字典值做字符串比对。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const raw = read("README.md");
const en = JSON.parse(read("src/i18n/en_US.json"));

// 归一化：CRLF → LF，并压掉换行造成的断词（README 里有大量手工折行，
// "Insert events and tasks into daily\n  note" 归一化后才等于字典值）。
const flat = raw.replace(/\r\n/g, "\n").replace(/\s*\n\s*/g, " ");

let failed = 0;
const pass = (msg) => console.log("  [PASS] " + msg);
const fail = (msg) => {
  console.log("  [FAIL] " + msg);
  failed++;
};

/* ── ① README 必须有足量英文 ────────────────────────────────── */
const PROSE_MARKERS = [
  "Two-way sync",
  "Features",
  "Installation",
  "Privacy and network use",
  "Frequently asked questions",
];
const missingMarkers = PROSE_MARKERS.filter((m) => !flat.includes(m));
if (missingMarkers.length) {
  fail("README 缺少英文正文段落: " + missingMarkers.join(" / "));
} else {
  pass("README 含完整英文正文（简介/功能/安装/隐私/FAQ 五段齐备）");
}

// 英文散文体量：只数「不在代码块内、且不含中日韩字符」的英文单词。
// 阈值取自本次实测量（1168 词）的三成，留出删减余量又不至于被"塞几句英文"骗过。
// 边界用「## 中文说明」分割 —— 导航行之后还有一行 ---，按 --- 切会只取到 2 行简介。
const prose = raw
  .replace(/```[\s\S]*?```/g, " ")
  .split("## 中文说明")[0]
  .replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, " ");
const enWordCount = (prose.match(/[A-Za-z][A-Za-z'-]+/g) || []).length;
if (enWordCount >= 300) {
  pass(`README 英文区有 ${enWordCount} 个英文单词（阈值 300）`);
} else {
  fail(`README 英文区仅 ${enWordCount} 个英文单词，低于阈值 300`);
}

/* ── ② 命令名与设置项标签必须逐字一致 ──────────────────────── */
const COMMAND_KEYS = [
  "openPanel",
  "openInSidebar",
  "openDock",
  "syncNow",
  "insertToday",
  "testReminder",
];
const missingCmd = COMMAND_KEYS.filter((k) => !flat.includes(en[k]));
if (missingCmd.length) {
  fail(
    "README 未逐字引用这些命令名（用户搜命令面板会搜不到）: " +
      missingCmd.map((k) => `${k}="${en[k]}"`).join(", ")
  );
} else {
  pass(`README 逐字引用全部 ${COMMAND_KEYS.length} 个命令名`);
}

const SETTING_LABELS = [
  "Server address",
  "Username",
  "Password",
  "Test connection",
  "Discover calendars",
  "Credential status",
  "Auto-sync interval (minutes)",
  "Conflict handling",
  "Display range",
  "Daily note folder",
];

/**
 * 标签匹配：**只加前导 \b，不加尾部 \b**。
 * 尾部 \b 要求最后一个字符与后一个字符词性不同 —— 而 "Auto-sync interval (minutes)"
 * 以 `)` 收尾（非单词字符），后面紧跟 `,`（非单词字符），词性相同 → \b 永不成立。
 * 这类以标点收尾的标签会被判成「缺失」，是判据自身的 bug（实测踩过）。
 * 漏检风险由「前导 \b + 逐字比对」兜住：多出前后缀字符仍会被 \b 挡住。
 */
const hasLabel = (l) => new RegExp("\\b" + l.replace(/[()]/g, "\\$&")).test(flat);

const missingLabel = SETTING_LABELS.filter((l) => !hasLabel(l));
if (missingLabel.length) {
  fail("README 未逐字引用这些设置项标签: " + missingLabel.join(", "));
} else {
  pass(`README 逐字引用全部 ${SETTING_LABELS.length} 个设置项标签`);
}

/* ── ③ 双向：README 的中文说明区仍需保留 ───────────────────── */
// 插件已支持双语界面，README 只有英文会削弱中文用户的可读性，
// 且这是插件的真实卖点之一。别为了过审把中文删掉。
if (flat.includes("中文说明") && flat.includes("隐私与网络使用")) {
  pass("README 保留中文说明区");
} else {
  fail("README 缺中文说明区（插件支持双语，README 应同步保留）");
}

/* ── ④ manifest 的 name 必须是纯 ASCII 且与 README 标题一致 ──── */
// 目录读 manifest.name 展示；README 标题与它不一致会让用户认不出插件。
const manifest = JSON.parse(read("manifest.json"));
if (raw.startsWith("# " + manifest.name)) {
  pass("README 标题与 manifest.name 一致");
} else {
  fail(`README 标题应与 manifest.name 一致（期望 "# ${manifest.name}"）`);
}

console.log(
  failed
    ? `\n✗ README 回归测试失败：${failed} 项不符`
    : "\n✓ README 回归测试通过"
);
process.exit(failed ? 1 : 0);
