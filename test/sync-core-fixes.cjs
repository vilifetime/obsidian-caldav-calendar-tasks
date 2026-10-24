/**
 * 回归测试：同步核心三修复（2026-10-20 第四批，从思源同构移植）。
 *
 * 背景（2026-10-19 雄哥在思源侧实测）：
 *  缺陷 A：多端场景下服务端 etag 变了但受管字段没变（别端改了 DTSTAMP/ATTENDEE，
 *          或服务器重算指纹），mergeServerItems 的 same 分支不回写 etag → 本地
 *          etag 一直滞后 → 下次编辑 PUT 带旧 etag 发 If-Match → 必被 412 → 又按
 *          「服务端优先」把用户的改动静默丢掉。症状：打勾完成即报「服务端已变更，
 *          本地改动已按策略丢弃」。
 *  缺陷 B：412 服务端优先分支只清 dirty 不清 etag，字段还是本地乐观值 → 下一轮
 *          拉取因「字段恰好相同」走 same 分支仍不纠正 → UI 挂假完成态（勾是假的）。
 *  计数虚胖：同一事件操作几次，同步就报「上传 N 条」（按轮次累加，不按条目去重）。
 *
 * 行为层用真 CalStore（tsc 编译后引），源码层钉住 sync.ts 的两处结构。
 *
 * 用法：node test/sync-core-fixes.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 与 upload-limits.cjs 同一套路：tsc 编译到临时目录再引
const outDir = path.join(ROOT, ".test-synccore");
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
    `src/core/store.ts src/core/secret.ts src/core/errors.ts src/constants.ts ` +
    `--outDir .test-synccore --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "pipe" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
{
  // store.ts 牵出 config-backup.ts → 它 require("obsidian")（Notice 等），
  // 照 upload-limits.cjs 建个最小 stub
  const stubDir = path.join(outDir, "node_modules", "obsidian");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "obsidian", version: "0.0.0-stub", main: "index.js" })
  );
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `"use strict";\n` +
      `function Notice() {}\n` +
      `exports.Notice = Notice;\n` +
      `exports.normalizePath = function normalizePath(p) {\n` +
      `  return String(p).replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");\n` +
      `};\n`
  );
}
global.window = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};
const { CalStore } = require(path.join(outDir, "core", "store.js"));
const { keyOf } = require(path.join(outDir, "core", "store.js"));

let pass = 0;
const fail = [];
const asyncChecks = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      asyncChecks.push(
        r.then(
          () => {
            pass++;
          },
          (e) => {
            fail.push(`${name}: ${e.message}`);
          }
        )
      );
      return;
    }
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
}

const CAL = "http://127.0.0.1:5232/testuser/work/";
const mkItem = (over = {}) => ({
  uid: "u1@test",
  kind: "event",
  calendarUrl: CAL,
  href: CAL + "u1.ics",
  etag: '"old"',
  summary: "测试日程",
  allDay: false,
  start: "2026-10-20T09:00:00",
  end: "2026-10-20T10:00:00",
  dirty: false,
  deleted: false,
  ...over
});

const newStore = () =>
  new CalStore({
    loadData: async () => undefined,
    saveData: async () => undefined
  });

/* ── 缺陷 A：etag 回写（行为层） ─────────────────────────────── */

check("same 分支回写 etag（多端改了非受管字段的场景）", () => {
  const s = newStore();
  s.put(mkItem());
  const r = s.mergeServerItems([mkItem({ etag: '"new-server"' })]);
  const cur = s.get(keyOf(mkItem()));
  assert.strictEqual(cur.etag, '"new-server"', "服务端 etag 变了必须回写，否则下次编辑必被 412");
  assert.strictEqual(r.changed, true, "回写 etag 要标 changed 让它落盘");
});

check("etag 相同则不标 changed（不制造假变化）", () => {
  const s = newStore();
  s.put(mkItem());
  const r = s.mergeServerItems([mkItem({ etag: '"old"' })]);
  assert.strictEqual(r.changed, false, "etag 相同、字段全同时不该标 changed");
});

check("缺 raw 时顺手补 raw（老数据自愈，与 etag 回写同分支）", () => {
  const s = newStore();
  s.put(mkItem()); // 本地无 raw
  s.mergeServerItems([mkItem({ etag: '"new"', raw: "BEGIN:VCALENDAR\nEND:VCALENDAR" })]);
  const cur = s.get(keyOf(mkItem()));
  assert.strictEqual(cur.raw, "BEGIN:VCALENDAR\nEND:VCALENDAR");
  assert.strictEqual(cur.etag, '"new"', "补 raw 与回写 etag 互不排斥");
});

check("受管字段真不同 → 整体替换（不走 same 分支）", () => {
  const s = newStore();
  s.put(mkItem());
  const r = s.mergeServerItems([mkItem({ summary: "改了标题", etag: '"new2"' })]);
  const cur = s.get(keyOf(mkItem()));
  assert.strictEqual(cur.summary, "改了标题");
  assert.strictEqual(cur.etag, '"new2"');
  assert.strictEqual(r.applied, 1, "字段不同算一次真实拉取");
});

check("本地脏数据不被服务端版本覆盖（脏数据优先）", () => {
  const s = newStore();
  s.put(mkItem({ dirty: true, summary: "本地改的" }));
  s.mergeServerItems([mkItem({ summary: "服务端版本", etag: '"new3"' })]);
  const cur = s.get(keyOf(mkItem()));
  assert.strictEqual(cur.summary, "本地改的", "本地脏数据要保留，等上传后被服务端确认");
  assert.strictEqual(cur.etag, '"old"', "脏条目这一轮不动 etag");
});

check("attachments 空 ≡ 没有（删光附件不每轮被拉回）", () => {
  const s = newStore();
  s.put(mkItem({ attachments: [] }));
  const r = s.mergeServerItems([mkItem({ etag: '"new4"' })]); // 服务端无 ATTACH → undefined
  assert.strictEqual(r.applied, 0, "[] 与 undefined 必须判成相同（不整体替换），否则删完附件的条目每轮被拉回");
  assert.strictEqual(s.get(keyOf(mkItem())).etag, '"new4"', "顺带仍要回写 etag（缺陷 A 的修复不被附件归一化影响）");
});

/* ── 缺陷 B：412 服务端优先清 etag（源码层） ───────────────────
 * pushDirty 需要真实 HTTP 失败路径（putItem 抛 412），模块级函数难以注入；
 * 且要防的是「结构被改回去」，故钉源码。 */

check("412 服务端优先分支 dirty=false 与 etag=undefined 成对", () => {
  const src = read("src/core/sync.ts");
  // 抓到 sync.discardLocal 那个 else 分支的函数体
  const i = src.indexOf('t("sync.discardLocal"');
  assert.ok(i > 0, "应找到服务端优先丢弃分支");
  const body = src.slice(i - 500, i + 200);
  assert.ok(/item\.dirty = false;/.test(body), "丢弃分支要清 dirty");
  assert.ok(/item\.etag = undefined;/.test(body), "**必须同时清 etag**——只清 dirty 会让下一轮拉取因字段相同不纠正，UI 挂假完成态");
  // 顺序：先 dirty 后 etag（都可，但两条都要在 discardLocal 之前）
  assert.ok(body.indexOf("item.etag = undefined;") < i, "清 etag 要发生在报 discardLocal 的同一分支里");
});

check("412 本地优先分支保留原有强制覆盖逻辑（没被误伤）", () => {
  const src = read("src/core/sync.ts");
  assert.ok(/item\.etag = r\.etag \|\| keep;/.test(src), "本地优先重试成功后要恢复 etag");
  assert.ok(/item\.etag = undefined;[\s\S]{0,600}item\.etag = r\.etag \|\| keep;/.test(src), "先清后恢的顺序不能反");
});

/* ── 计数去重（行为层 + 源码层） ────────────────────────────── */

check("markUploaded 同 key 只攒一条", () => {
  const s = newStore();
  s.markUploaded("k1");
  s.markUploaded("k1");
  s.markUploaded("k1");
  assert.deepStrictEqual(s.pendingUploadedKeys, ["k1"], "同一条目推 N 次只能计一条");
});

check("markDeleted 同 key 只攒一条、与上传分列", () => {
  const s = newStore();
  s.markDeleted("k2");
  s.markDeleted("k2");
  s.markUploaded("k3");
  assert.deepStrictEqual(s.pendingDeletedKeys, ["k2"]);
  assert.deepStrictEqual(s.pendingUploadedKeys, ["k3"]);
});

check("pending 存取盘链路：hydrate 读回 + persist 写出", () => {
  // hydrate：loadData 带回 key 数组（load 内部还会走密钥解密，Node 下应安静完成）
  const data = {
    settings: {},
    items: [],
    sync: { pendingUploadedKeys: ["a", "b"], pendingDeletedKeys: ["c"] }
  };
  const s2 = new CalStore({
    loadData: async () => data,
    saveData: async () => undefined
  });
  return s2.load().then(async () => {
    assert.deepStrictEqual(s2.pendingUploadedKeys, ["a", "b"], "load 要读回 pending keys");
    assert.deepStrictEqual(s2.pendingDeletedKeys, ["c"]);
    // persist：saveData 捕获写出的数据
    let saved = null;
    const s3 = new CalStore({
      loadData: async () => undefined,
      saveData: async (d) => {
        saved = d;
      }
    });
    s3.markUploaded("x");
    s3.markDeleted("y");
    await s3.persist();
    assert.ok(saved, "persist 要调 saveData");
    assert.deepStrictEqual(saved.sync.pendingUploadedKeys, ["x"], "persist 要写 pendingUploadedKeys");
    assert.deepStrictEqual(saved.sync.pendingDeletedKeys, ["y"], "persist 要写 pendingDeletedKeys");
  });
});

check("syncAll 合并口径是 Set 并集（复刻 sync.ts 那段算一遍）", () => {
  // 与 sync.ts 合并区同构：本轮 pushed + 历史 pending 取并集
  const report = { uploadedKeys: ["k1", "k2"], deletedKeys: ["d1"] };
  const store = { pendingUploadedKeys: ["k2", "k3"], pendingDeletedKeys: [] };
  const upKeys = new Set([...(report.uploadedKeys ?? []), ...store.pendingUploadedKeys]);
  const delKeys = new Set([...(report.deletedKeys ?? []), ...store.pendingDeletedKeys]);
  assert.strictEqual(upKeys.size, 3, "k1/k2/k3 三条（k2 两边都有只计一次）");
  assert.strictEqual(delKeys.size, 1);
  assert.ok(/const upKeys = new Set\(\[\.\.\.\(report\.uploadedKeys \?\? \[\]\), \.\.\.this\.store\.pendingUploadedKeys\]\)/.test(read("src/core/sync.ts")), "sync.ts 合并区要用同一算式");
});

check("pushDirty 成功分支记 key（上传×3 / 删除×2）", () => {
  const src = read("src/core/sync.ts");
  const pushes = src.match(/report\.uploadedKeys\?\.push\(keyOf\(item\)\)/g) || [];
  // 3 处：上传主路径 + 本地优先重试路径 + 403 降级重传（2026-10-24「日程↔待办互转」
  // 新增：服务端拒收同 href 换组件类型时走「删旧资源 → 同 URI 重建」，成功同样要记 key）
  assert.strictEqual(pushes.length, 3, "上传主路径 + 本地优先重试路径 + 403 降级重传都要记");
  const dels = src.match(/report\.deletedKeys\?\.push\(keyOf\(item\)\)/g) || [];
  assert.strictEqual(dels.length, 2, "删除主路径 + 本地优先强删（412 重试）都要记");
});

check("SyncReport 接口有 uploadedKeys/deletedKeys", () => {
  const src = read("src/core/sync.ts");
  assert.ok(/uploadedKeys\?: string\[\]/.test(src), "SyncReport 要声明 uploadedKeys");
  assert.ok(/deletedKeys\?: string\[\]/.test(src), "SyncReport 要声明 deletedKeys");
});

check("旧数字计数字段彻底移除（防回退）", () => {
  const src = read("src/core/sync.ts") + read("src/core/store.ts") + read("src/core/types.ts");
  assert.ok(!/pendingUploaded\b(?!Keys)/.test(src), "不许再出现按轮次的 pendingUploaded 数字");
  assert.ok(!/pendingDeleted\b(?!Keys)/.test(src), "不许再出现按轮次的 pendingDeleted 数字");
});

/* ── 结果 ─────────────────────────────────────────────────── */
(async () => {
  await Promise.all(asyncChecks);
  if (fail.length) {
    console.log(`\n[FAIL] ${fail.length} 个用例失败`);
    for (const f of fail) console.log("  - " + f);
    process.exit(1);
  }
  console.log(`[PASS] sync-core-fixes: ${pass} 项全部通过`);
})();
