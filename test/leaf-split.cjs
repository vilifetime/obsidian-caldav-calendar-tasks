/**
 * 回归测试：`leafInSplit` 的undefined 语义。
 *
 * 为什么需要它：2026-10-05 出现过一次真实故障 —— 社区扫描要求消除
 * `any`，于是把 `(leaf as any).getRoot?.() === (workspace as any).rootSplit`
 * 改成了两个助手函数（`leafRoot()` / `splitOf()`），各自在取不到时返回
 * `undefined`。原来的 `catch { return false }` 消失后，
 * `undefined === undefined` **成立** ——「取不到根节点」被误判成
 * 「正好在主区」，导致 `toggleDock` 的三态判断整体错位：
 * 右击单元格该切月视图的却隐藏了侧栏，右击条目该展开的却收起。
 *
 * 这类 bug 静态检查（tsc / eslint）全都抓不到 —— 类型上完全合法，
 * 只有真正跑起来才会暴露。故用本测试把语义钉死。
 *
 * 用法：node test/leaf-split.cjs
 */
const assert = require("assert");

/** 与 src/main.ts 中的实现保持一致（刻意复制而非 import，见下方说明） */
function leafInSplit(leafRoot, targetRoot) {
  if (targetRoot === undefined || targetRoot === null) return false;
  const root = leafRoot;
  if (root === undefined || root === null) return false;
  return root === targetRoot;
}

// 不 import src/main.ts 的原因：它是 TS 且 import "obsidian"，
// Node 下无法直接 require。复制实现来测语义，等价于契约测试。

const ROOT_MAIN = { id: "rootSplit" };
const ROOT_RIGHT = { id: "rightSplit" };

const cases = [
  // ── 正常路径 ──
  ["在主区", ROOT_MAIN, ROOT_MAIN, true],
  ["在右侧栏", ROOT_RIGHT, ROOT_RIGHT, true],
  ["在主区但目标是右侧栏", ROOT_MAIN, ROOT_RIGHT, false],

  // ── 回归重点：两侧都取不到，绝不能判成「在目标区」──
  ["两侧都是 undefined", undefined, undefined, false],
  ["两侧都是 null", null, null, false],
  ["leaf 取不到、目标有效", undefined, ROOT_MAIN, false],
  ["leaf 有效、目标取不到", ROOT_MAIN, undefined, false],
  ["leaf 取不到、目标为 null", undefined, null, false],
  ["leaf 为 null、目标取不到", null, undefined, false],
];

let failed = 0;
for (const [name, leafRoot, targetRoot, expected] of cases) {
  const got = leafInSplit(leafRoot, targetRoot);
  const ok = got === expected;
  if (!ok) failed++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(
    `  [${mark}] ${name.padEnd(24)} leafRoot=${String(leafRoot && leafRoot.id)} target=${String(
      targetRoot && targetRoot.id
    )} → ${got}（期望 ${expected}）`
  );
}

// 显式验证那个致命组合
assert.strictEqual(
  leafInSplit(undefined, undefined),
  false,
  "两侧都是 undefined 时必须返回 false —— 这正是 0.1.3 坏掉的原因"
);

console.log(failed === 0 ? "\n✓ 分栏判断回归测试通过" : `\n✗ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
