/**
 * 从 manifest.json + CHANGELOG.md 生成 Release 说明文字。
 *
 * **为什么用模板而不是在 workflow 里拼字符串**
 * 1. 插件改名时（社区要求 name 为纯 ASCII），硬编码的说明会漏改，
 *    Release 页面仍显示旧名—— 与 manifest、README、页签标题不一致。
 *    这里全部从 manifest 读，改名只需改 manifest 一处。
 * 2. 说明文字含 Markdown（反引号、代码块），在 YAML 里内嵌极易踩转义坑
 *    （\` 会吞掉反引号），放独立脚本里写最稳。
 *
 * **更新内容来自 CHANGELOG.md**（2026-10-07 补上）
 * 此前模板里只有安装步骤、没有本次更新内容 —— 因为压根没有 changelog 可取材。
 * 现约定：`CHANGELOG.md` 顶部有`## [未发布]` 段落，发版时把它当成本次说明素材。
 * 发版后**记得把该段落的标题改成实际版本号**（见scripts/rename-changelog.mjs）。
 *
 * 用法：node scripts/build-notes.mjs <输出路径>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const template = JSON.parse(
  fs.readFileSync(path.join(__dirname, "release-notes.template.json"), "utf8")
).body;

/**
 * 从 CHANGELOG.md 抽出「未发布」段落的正文（去掉 `## [未发布]` 这一行本身）。
 * 找不到时返回空串 —— 不让发版流程因changelog 缺一段而整个挂掉。
 */
function readUnreleased() {
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) return "";
  const text = fs.readFileSync(changelogPath, "utf8");

  // ⚠️ 这里**不能用带 /m 的正则**去切段落（踩过两次）：
  //   - `\Z` 是 Perl 语法，JS 不支持，会静默匹配失败
  //   - 改用 `(?=^##\s|$)` +/m 也不行 —— /m 让 `$` 匹配**每个行尾**，
  //     段落会在第一行就截断（只剩「### 新增」三个字）
  // 正确做法：先定位标题行的**下标**，再从那里找下一个同级标题。
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*\[未发布\]\s*$/.test(l));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  // 占位文案（如「（暂无）」）视为无内容
  if (!body || /^（.*）$/.test(body)) return "";
  return body;
}

const version = process.env.GITHUB_REF_NAME || manifest.version;
const unreleased = readUnreleased();

let body = template
  .replaceAll("{{NAME}}", manifest.name)
  .replaceAll("{{ID}}", manifest.id)
  .replaceAll("{{VERSION}}", version)
  .replaceAll("{{CHANGELOG}}", unreleased);

// 「更新内容」小节只在确有内容时保留整段（避免留下空标题）
if (!unreleased) {
  body = body.replace(/\n## 本次更新\n+[\s\S]*?(?=\n## )/, "\n");
  body = body.replace(/\n## 本次更新\n*$/, "\n");
}

const out = process.argv[2] || path.join(ROOT, "RELEASE_NOTES.md");
fs.writeFileSync(out, body, "utf8");
console.log(body);
console.log(`\n[notes] 已写入 ${out}`);
if (!unreleased) {
  console.log("[notes] ⚠️ CHANGELOG 的「未发布」段落为空 —— Release 说明里没有更新内容");
}
