/**
 * Obsidian 插件构建配置（esbuild）
 *
 * 与思源版（Vite lib 模式）的差异：
 *   - 输出 CJS single-file main.js（Obsidian 插件规范），而非 dist/index.js
 *   - external 从 ["siyuan", "process"] 换成 Obsidian 宿主提供的模块
 *   - CSS 不走打包：src/styles.css 由 deploy 脚本直接复制为 styles.css
 *     （esbuild 打包 CSS 会产出 main.css，与 Obsidian 约定不符）
 */
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deploy } from "./scripts/deploy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";

/** `@/xxx` → `src/xxx`，与源项目 tsconfig 的 paths 保持一致 */
const aliasPlugin = {
  name: "alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.resolve(__dirname, "src", args.path.slice(2));
      const candidates = [base, base + ".ts", base + ".tsx", base + ".js", path.join(base, "index.ts")];
      for (const p of candidates) {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return { path: p };
      }
      return { path: base };
    });
  },
};

/** 构建结束即同步到 vault，便于配合 Hot Reload 插件免手动重载 */
const deployPlugin = {
  name: "deploy",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.error("[deploy] 构建有错误，跳过部署");
        return;
      }
      try {
        deploy();
      } catch (e) {
        console.error("[deploy] 部署失败:", e.message);
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: [path.resolve(__dirname, "src/main.ts")],
  outfile: path.resolve(__dirname, "main.js"),
  bundle: true,
  format: "cjs",
  target: "es2018",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: false,
  plugins: [aliasPlugin, deployPlugin],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    // 宿主 Node 内置模块，不可打包。
    // 原先依赖 builtin-modules 包来生成这份清单，但社区目录已把该包标记为
    // 弃用（建议改用 es-tooling/module-replacements）。实测本项目从未 import
    // 过它——清单是手写的，故直接移除依赖并保留这份显式列表。
    "child_process",
    "crypto",
    "fs",
    "http",
    "https",
    "net",
    "os",
    "path",
    "stream",
    "url",
    "util",
    "zlib",
  ],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("[watch] 正在监听源文件变化…");
}
