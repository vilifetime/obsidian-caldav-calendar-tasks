/**
 * 回归测试：i18n 字典完整性 + 占位符一致性。
 *
 * 背景（2026-10-06 起）：Obsidian 界面语言设为英语时插件仍显示中文，于是接入
 * i18n。字典一多就容易出三类静默故障：
 *
 *  ① **某语言缺 key** —— t() 会回退到中文，界面上出现半中半英，用户看不出问题在哪。
 *  ② **占位符集合不一致** —— 中文写了 `{count}`、英文漏了，则英文界面直接显示
 *    字面量 "{count}"；反过来英文多写了则永远替换不掉。**tsc 抓不到。**
 *  ③ **空串译文** —— `t()` 返回空串会导致「按钮存在但没字」，比缺 key 更难排查，
 *     故这里一并断言非空。
 *
 * 用法：node test/i18n-dict.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "src/i18n/zh_CN.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "src/i18n/en_US.json"), "utf8"));

// ── 复刻 i18n/index.ts 的插值实现 ──
// 刻意照抄而非 import：i18n/index.ts 是 TS + ESM import JSON，Node 的 cjs 跑不了。
const placeholders = (s) => {
  const out = new Set();
  for (const m of String(s).matchAll(/\{(\w+)\}/g)) out.add(m[1]);
  return out;
};

// ── ① 双向 key 对齐 ──
const zhKeys = Object.keys(zh);
const enKeys = Object.keys(en);
const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
assert.deepStrictEqual(missingInEn, [], `英文字典缺 ${missingInEn.length} 个 key：${missingInEn.join(", ")}`);
assert.deepStrictEqual(missingInZh, [], `中文字典缺 ${missingInZh.length} 个 key：${missingInZh.join(", ")}`);
assert.strictEqual(zhKeys.length, enKeys.length, "两字典 key 数量不等");

// ── ② 占位符集合逐 key 对齐 ──
// 正反两个方向都查：中文有 {count} 而英文没有，英文界面会露出字面量；
// 英文多出 {name} 则永远替换不掉，界面显示 "{name}"。
const mismatch = [];
for (const k of zhKeys) {
  const a = [...placeholders(zh[k])].sort().join(",");
  const b = [...placeholders(en[k])].sort().join(",");
  if (a !== b) mismatch.push(`${k}：中文{${a}} vs 英文{${b}}`);
}
assert.deepStrictEqual(mismatch, [], `占位符不一致 ${mismatch.length} 处：\n  ${mismatch.join("\n  ")}`);

// ── ③ 译文非空 + 非空白 ──
// 空串比缺 key 更难排查（按钮在、字没了），故单独设一条断言。
const empties = [];
for (const [name, dict] of [["zh", zh], ["en", en]]) {
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== "string" || v.trim() === "") empties.push(`${name}.${k}`);
  }
}
assert.deepStrictEqual(empties, [], `${empties.length} 个 key 译文为空：${empties.join(", ")}`);

// ── ④ 英文译文不应残留中文 ──
// 这是本次改造的核心目标，加一条断言防回退。注意排除专有名词与占位符。
const CJK = /[一-鿿]/;
const latinProperNouns = new Set(["iCloud", "CalDAV", "WebDAV", "Obsidian", "PRODID", "UTF"]);
// `lang.zh` 的值就是「简体中文」——语言选择器里要用**母语原名**标出选项，
// 译成 "Chinese" 反而让用户认不出自己选的是哪个。故按 key 精确豁免。
const CJK_ALLOWED_KEYS = new Set(["lang.zh"]);
const cjkInEn = enKeys
  .filter((k) => {
    const v = en[k];
    if (CJK_ALLOWED_KEYS.has(k)) return false;
    if (!CJK.test(v)) return false;
    // 逐词剔除：把 latin 专有名词换成空再测，剩余仍含中文才算残留
    let s = v;
    for (const p of latinProperNouns) s = s.split(p).join("");
    return CJK.test(s);
  })
  .map((k) => `${k} = ${en[k]}`);
assert.deepStrictEqual(cjkInEn, [], `英文译文残留中文 ${cjkInEn.length} 处：\n  ${cjkInEn.join("\n  ")}`);

// ── ⑤ 无未使用的 key（源码里查不到引用的）──
// 字典里躺着一堆没人用的 key 不会报错，但会让后来人分不清「漏译」还是「废弃」。
// 2026-10-06 首跑就靠这条揪出 11 个无引用的历史 key（addTask / addEvent /
// common.close / common.open / view.dayMon..Sun），已清理。
// 故设成**硬断言**：新增 key 请一并接上引用，别攒成技术债。
const srcFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) srcFiles.push(p);
  }
})(path.join(ROOT, "src"));
const srcAll = srcFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const unused = zhKeys.filter((k) => !srcAll.includes(`"${k}"`));
assert.deepStrictEqual(unused, [], `${unused.length} 个 key 无源码引用（新增 key 需接上引用）：${unused.join(", ")}`);

console.log(`  [PASS] i18n 字典一致：${zhKeys.length} key，占位符对齐，无空串，英文无中文残留，无废弃 key`);