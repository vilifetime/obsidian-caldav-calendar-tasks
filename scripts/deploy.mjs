/**
 * 把构建产物同步到 Obsidian 库的插件目录
 *
 * 目标路径优先级：
 *   1. 环境变量 OBSIDIAN_VAULT
 *   2. 项目根 .vault-deploy-target 文件（单行，存 vault 绝对路径；该文件已加入 .gitignore）
 *   3. 默认值（雄哥本机路径）
 *
 * ⚠️ 库会搬家：2026-09-30 从 `D:\Obsidian\Obsidian` 移到了 `D:\ProgramData\Obsidian`。
 * 搬库后必须同步更新这里（或写 .vault-deploy-target），否则构建"成功"但产物送不到，
 * 表现为「改了代码却毫无变化」—— 排查时容易误判成代码问题。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_ID = "caldav-calendar-tasks";

const DEFAULT_VAULT = "D:\\ProgramData\\Obsidian";

function resolveVault() {
  if (process.env.OBSIDIAN_VAULT) return process.env.OBSIDIAN_VAULT;
  const targetFile = path.join(ROOT, ".vault-deploy-target");
  if (fs.existsSync(targetFile)) {
    const v = fs.readFileSync(targetFile, "utf8").trim();
    if (v) return v;
  }
  return DEFAULT_VAULT;
}

export function deploy() {
  const vault = resolveVault();
  const pluginDir = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);

  if (!fs.existsSync(path.join(vault, ".obsidian"))) {
    throw new Error(`目标不是有效的 Obsidian 库（缺少 .obsidian 目录）：${vault}`);
  }
  fs.mkdirSync(pluginDir, { recursive: true });

  const copies = [
    ["main.js", "main.js"],
    ["manifest.json", "manifest.json"],
    [path.join("src", "styles.css"), "styles.css"],
  ];

  const done = [];
  for (const [from, to] of copies) {
    const src = path.join(ROOT, from);
    if (!fs.existsSync(src)) {
      console.warn(`[deploy] 跳过（源文件不存在）：${from}`);
      continue;
    }
    fs.copyFileSync(src, path.join(pluginDir, to));
    done.push(to);
  }

  console.log(`[deploy] → ${pluginDir}`);
  console.log(`[deploy] 已同步：${done.join(", ")}`);
  return pluginDir;
}

// 允许 `node scripts/deploy.mjs` 单独执行
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  deploy();
}
