/**
 * 回归测试：日历视图待办勾选圈的「勾子只在完成态出现」（2026-10-08）。
 *
 * 背景：雄哥反馈日历视图上**未完成**的待办圆圈里也有淡勾。根因不是 CSS
 * 颜色算错，而是三处模板**无条件写死 `✓`**、只靠 CSS 把字染成 transparent
 * 藏起来 —— 一旦 `:not(.is-done):hover` 给任何非 transparent 的颜色，
 * 淡勾就浮出来了。且 hover 态在「鼠标点完停在圈上」时**必然**生效，
 * 所以用户看到的几乎总是有勾的样子。
 *
 * 正确做法：勾子的可见性由**内容里有没有 `✓` 字符**决定（`${done ? "✓" : ""}`），
 * CSS 只管颜色 —— 两边不要重复控制。任务视图一直是对的（view-task.ts 有条件），
 * 日历三处（view-common 月视图 chip、view-week 全天 chip、view-week 时间块）漏了。
 *
 * 用法：node test/check-mark-visible.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── 1. 三处日历勾选圈必须按 done 条件渲染勾子 ──
{
  const checks = [
    { file: "src/ui/view-common.ts", label: "月视图 chip" },
    { file: "src/ui/view-week.ts", label: "周视图时间块" },
  ];
  for (const c of checks) {
    const src = read(c.file);
    // 取 cal-chip-check 那一整行（可能跨行，故取到下一个 ${ 结尾）
    const re = /cal-chip-check[\s\S]{0,220}?<\/button>/g;
    const hits = src.match(re) || [];
    assert.ok(hits.length > 0, `${c.label}：没找到 cal-chip-check 的模板`);
    for (const h of hits) {
      assert.ok(
        /\$\{done \? "✓" : ""\}|class="cal-task-check"/.test(h),
        `${c.label}：勾子仍是无条件写死的 ✓ —— 必须改成 \${done ? "✓" : ""}\n      实际：${h.trim()}`
      );
    }
  }
}

// ── 2. 未完成的 hover 规则里不得给 color（有勾字形就会显形）──
{
  const css = read("src/styles.css");
  // 取出所有「未完成态 hover」的规则块
  const blocks = css.match(/\.[\w-]+:not\(\.is-done\)\s+\.cal-chip-check:hover[^{]*\{[^}]*\}/g) || [];
  assert.ok(blocks.length > 0, "没找到未完成态 hover 规则（可能被改名了，请同步本测试）");
  for (const b of blocks) {
    // ⚠️ 必须排除 `border-color` / `background` 里的 color-mix —— 正则
    // `/\bcolor\s*:/` 会把 `border-color:` 一并匹配上（实测踩过）。
    // 只认**独立**的 color 属性：`color` 前面不能有连字符。
    const standalone = b.match(/(?<![\w-])color\s*:/g) || [];
    assert.ok(
      standalone.length === 0,
      `未完成态 hover 里不能设 color —— 勾子会显形，症状就是「未完成看着已打勾」\n      实际：${b.trim()}`
    );
  }
}

// ── 3. 完成态必须同时给填充与白色勾子 ──
{
  const css = read("src/styles.css");
  // 只取完成态的**基础**规则，排除 `:hover` 变体（hover 只是 filter 提亮，
  // 按「必须含 background/color」去查它必然失败 —— 这是测试自身的错，不是代码的）。
  const all = css.match(/\.[\w-]+\.is-done\s+\.cal-chip-check[^{]*\{[^}]*\}/g) || [];
  const doneBlocks = all.filter((b) => !/:hover/.test(b));
  assert.ok(doneBlocks.length > 0, "没找到完成态基础规则");
  for (const b of doneBlocks) {
    assert.ok(/background\s*:/.test(b), `完成态必须有填充色：${b.trim()}`);
    assert.ok(/color\s*:\s*#fff/.test(b), `完成态必须有白色勾子：${b.trim()}`);
  }
}

// ── 4. 空心圆基底：未完成时背景透明 ──
{
  const css = read("src/styles.css");
  const base = css.match(/\.cal-chip-check \{[^}]*\}/);
  assert.ok(base, "没找到 .cal-chip-check 基底规则");
  assert.ok(/background\s*:\s*transparent/.test(base[0]), "未完成底色必须透明（空心）");
  assert.ok(/border-radius\s*:\s*50%/.test(base[0]), "必须是圆形");
}

// ── 5. 就地更新必须同步 textContent（勾子的可见性由字符决定，class 管不了）──
//
// 补这条是因为真出现过：勾选走「就地更新」路径（updateTodoCheckDOM，只切
// is-done class 而不重渲染 HTML），于是**填充色变了、小勾子没有** ——
// 半修状态最难认，以为改完了其实只对了一半。
{
  const src = read("src/ui/panel.ts");
  const fn = src.match(/function updateTodoCheckDOM[\s\S]*?\n  \}/);
  assert.ok(fn, "没找到 updateTodoCheckDOM");
  assert.ok(
    /btn\.textContent\s*=\s*done \? "✓" : ""/.test(fn[0]),
    "updateTodoCheckDOM 必须同步设 textContent —— 只切 class 会出现「有填充色无勾」"
  );
  // 且必须限定在勾圈类上：Dock 的 .caldav-dock-check 内含真 <input type=checkbox>，
  // 塞文字节点会显示出一个多余的「✓」
  assert.ok(
    /cal-chip-check/.test(fn[0]) && /cal-task-check/.test(fn[0]),
    "textContent 赋值必须限定在勾圈类（cal-chip-check / cal-task-check）上"
  );
}

console.log("  [PASS] 日历视图三处勾选圈：勾子按 done 条件渲染，无条件写死的已清零");
console.log("  [PASS] 未完成 hover 不设 color（勾子不会显形）");
console.log("  [PASS] 完成态：填充 + 白勾；基底：透明 + 圆形");
console.log("  [PASS] 就地更新同步 textContent（点击后有填充色也有勾）");
console.log("✓ 勾选圈勾子可见性回归测试通过");