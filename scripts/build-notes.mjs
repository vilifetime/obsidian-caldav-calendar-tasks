/**
 * 从 manifest.json 生成 Release 说明文字。
 *
 * **为什么用模板而不是在 workflow 里拼字符串**
 * 1. 插件改名时（社区要求 name 为纯 ASCII），硬编码的说明会漏改，
 *    Release 页面仍显示旧名—— 与 manifest、README、页签标题不一致。
 *    这里全部从 manifest 读，改名只需改 manifest 一处。
 * 2. 说明文字含 Markdown（反引号、代码块），在 YAML 里内嵌极易踩转义坑
 *    （\` 会吞掉反引号），放独立脚本里写最稳。
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

const version = process.env.GITHUB_REF_NAME || manifest.version;
const body = template
  .replaceAll("{{NAME}}", manifest.name)
  .replaceAll("{{ID}}", manifest.id)
  .replaceAll("{{VERSION}}", version);

const out = process.argv[2] || path.join(ROOT, "RELEASE_NOTES.md");
fs.writeFileSync(out, body, "utf8");
console.log(body);
console.log(`\n[notes] 已写入 ${out}`);
