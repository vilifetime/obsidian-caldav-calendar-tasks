/**
 * 回归测试：编辑器保存不阻塞关窗（2026-10-20 雄哥实测「编辑完附件点保存，窗口关不掉」）
 *
 * 根因：保存处理器写成 `void updateItem(...).then(() => host.close())` ——
 * **等上传成功才关窗**。待办附件是 base64 内联进 ICS 的，一个 5MB 附件 → ICS 约 7MB，
 * 家用 NAS 上行只有几百 KB/s 时上传要一分多钟，窗口全程挂着，用户以为卡死。
 * （思源侧 2026-10-15 修过同一个病：当时是删掉 5MB 附件后保存仍卡约 1 分钟，
 * 真实原因是服务器根本不响应 HTTP。）
 *
 * 终版写法（与思源 editor.ts 同构）：
 *   本地保存（putAndEmit → emit 内含 400ms 防抖 persist）随即落盘 →
 *   `void updateItem(...).catch(...)` 后台上传 → **立即 host.close()**，
 *   上传结果走页脚状态条（lastNote/lastError）。
 *
 * 即发即忘的数据安全性靠两件事，本测试各钉一条：
 *   ① emit() 必须自带防抖 persist（store.ts）——否则上传跑几分钟期间崩了会丢编辑；
 *   ② pushAndPersist 的上传失败必须进 report.errors → lastError（sync.ts）——
 *      否则后台上传失败用户完全看不到反馈。
 *
 * ⚠️ Obsidian 侧无 DOM 布局环境，这里守源码级形状；「真的几秒关窗」靠真机验。
 *
 * 用法：node test/editor-save-close.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SIYUAN_ROOT = path.resolve(ROOT, "..", "SiYuanCalDAV");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readSiyuan = (rel) => fs.readFileSync(path.join(SIYUAN_ROOT, rel), "utf8");

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("  [PASS]", name);
  } catch (e) {
    console.error("  [FAIL]", name, "\n     ", e.message);
    process.exitCode = 1;
  }
}

const editor = read("src/ui/editor.ts");
const store = read("src/core/store.ts");
const sync = read("src/core/sync.ts");
const editorSy = readSiyuan("src/ui/editor.ts");

// 剥注释再断言：注释里出现 host.close() 不算真的调用
const bare = editor
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

// ---------- ① 保存处理器形状 ----------
console.log("[editor-save-close] 保存处理器");

t("保存不再等上传：void 即发即忘 + catch，不等 then 再关", () => {
  // 旧病根：`.then(() => host.close())` 把关窗挂在上传结果上
  assert.ok(
    !/\.then\(\s*\(\)\s*=>\s*host\.close\(\)/.test(bare),
    "保存仍在等上传完成才关窗（.then(() => host.close())）——大附件上传期间窗口假死"
  );
  // 新写法：void 调用 + .catch，且 host.close() 在同一个 try 块里紧跟其后
  assert.ok(
    /void \(isNew \? ctx\.sync\.createItem\(saved\) : ctx\.sync\.updateItem\(saved\)\)\.catch\(/.test(bare),
    "缺少后台上传的 void+catch 形状"
  );
  assert.ok(
    /\.catch\(\(e\) => \{[\s\S]{0,120}host\.close\(\);[\s\S]{0,80}\} catch/.test(bare) ||
      /\.catch\([\s\S]{0,200}?\}\);\s*\n\s*host\.close\(\);/.test(bare),
    "host.close() 没有紧跟在后台上传之后立即执行"
  );
});

t("后台上传带 .catch：失败不会变成 unhandled rejection", () => {
  // 没有 catch 时上传失败既不让关窗（旧代码 .then 无 catch）、也无任何提示
  const m = /void \(isNew \? ctx\.sync\.createItem\(saved\) : ctx\.sync\.updateItem\(saved\)\)(\.catch\()/.exec(bare);
  assert.ok(m, "后台上传没有 .catch —— 失败会静默吞掉或冒泡成 unhandled rejection");
});

t("collect 的同步校验失败仍然拦住关窗（标题空/结束早于开始等）", () => {
  // collect 抛错必须被 try/catch 接住并写 errEl，不能关窗
  assert.ok(
    /const saved = collect\(ctx, el, it, attachList\);[\s\S]{0,600}?catch \(e: unknown\) \{\s*\n\s*errEl\.textContent/.test(bare),
    "collect 抛错路径被改坏 —— 校验失败会把用户晾在关掉的窗口前"
  );
});

// ---------- ② 即发即忘的数据安全性 ----------
console.log("[editor-save-close] 本地落盘安全网");

t("emit() 自带防抖 persist（关窗后 400ms 内落盘，不丢编辑）", () => {
  assert.ok(/private emit\(\): void \{[\s\S]{0,200}?persistSoon\(\);/.test(store), "emit 不再触发防抖 persist —— 即发即忘会丢本地编辑");
  assert.ok(/persistSoon\(\): void \{[\s\S]{0,300}?setTimeout\(\(\) => void this\.persist\(\), 400\)/.test(store), "防抖 persist 的 400ms 形态被改掉");
});

t("pushAndPersist 上传失败进 lastError（页脚可见，不静默）", () => {
  assert.ok(
    /this\.store\.lastError = report\.errors\.length \? report\.errors\.join\("; "\) : this\.store\.lastError/.test(sync),
    "上传失败不再写 lastError —— 后台上传失败用户看不到任何反馈"
  );
});

// ---------- ③ 两端同构 ----------
console.log("[editor-save-close] 与思源侧同构");

t("思源侧保存处理器同为 void+catch+立即销毁", () => {
  const sy = editorSy
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(
    /void \(isNew \? ctx\.sync\.createItem\(saved\) : ctx\.sync\.updateItem\(saved\)\)\.catch\(/.test(sy),
    "思源侧形状变了 —— 两端已漂移，本测试的前提需要复核"
  );
  assert.ok(!/\.then\(\s*\(\)\s*=>\s*(dialog\.destroy|host\.close)\(\)/.test(sy), "思源侧又回到了等上传才关窗");
});

console.log(`\n[editor-save-close] ${passed} 项通过`);
if (process.exitCode) console.error("存在失败项");
