/**
 * 回归测试：「幽灵条目对账」（reconcile）。
 *
 * 背景（2026-10-08 在思源侧实测）：思源里新建的一条任务在 Obsidian 永远看不到。
 * 根因不是上传失败，而是本地条目 `etag` 有值 ⇒ `dirty=false` ⇒ `pushDirty` 永远
 * 挑不到它；同时 `mergeServerItems` 只在 `deletedKeys` 里删本地，而 `deletedKeys`
 * **只有增量 sync-collection 路径才产出**，sync-token 失效回退全量时恒为空。
 * 于是服务端删过的条目在本地永久残留 —— 本地界面完全正常，别的客户端却看不到，
 * 而且它再也不会被重传。
 *
 * 这个 bug tsc / eslint 都抓不到（类型完全合法），只能靠「把服务端删掉再同步」
 * 的行为复现 —— 故这里复刻判定逻辑跑用例 + 源码级断言钉住结构。
 *
 * 用法：node test/reconcile.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const readSrc = (p) => fs.readFileSync(path.join(root, p), "utf8");

let failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log("  ✓", name);
  } catch (e) {
    failed++;
    process.exitCode = 1;
    console.error("  ✗", name, "\n    ", e.message);
  }
}

// ── 复刻 caldav.ts 的 fileNameOf ──
// 服务端 PROPFIND 回的是**路径**，本地存的是**完整 URL**，不归一化永远比不上。
function fileNameOf(url) {
  const raw = String(url || "").split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ── 复刻 caldav.ts 的 listResourceNames 的解析部分 ──
function parseNames(xml) {
  return [...xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]*)</g)]
    .map((m) => fileNameOf(m[1]))
    .filter((n) => /\.ics$/i.test(n));
}

// ── 复刻 sync.ts 的 reconcile 判定（不含 IO）──
// conflict: "server" | "local"；返回 {cleaned: string[], requeued: string[], skipped: string}
function reconcile(items, names, conflict) {
  const onServer = new Set(names);
  const candidates = items.filter((it) => it.calendarUrl === "CAL" && !it.deleted && !it.dirty && !!it.href);
  if (!onServer.size && candidates.length) {
    return { cleaned: [], requeued: [], skipped: "empty-list" };
  }
  const ghosts = candidates.filter((it) => !onServer.has(fileNameOf(it.href)));
  if (!ghosts.length) return { cleaned: [], requeued: [], skipped: "" };
  if (conflict === "local") return { cleaned: [], requeued: ghosts.map((g) => g.uid), skipped: "" };
  return { cleaned: ghosts.map((g) => g.uid), requeued: [], skipped: "" };
}

const I = (over) => ({
  uid: "u1",
  kind: "todo",
  calendarUrl: "CAL",
  href: "http://d/cal/u1.ics",
  summary: "待办",
  etag: '"e"',
  dirty: false,
  deleted: false,
  ...over
});

console.log("[reconcile] fileNameOf");

t("完整 URL 与服务端路径必须归一化到同一个文件名", () => {
  assert.strictEqual(fileNameOf("http://dav.test/cal/u1.ics"), "u1.ics");
  assert.strictEqual(fileNameOf("/dav/cal/u1.ics"), "u1.ics");
  assert.strictEqual(fileNameOf(""), "");
});

t("URL 转义要还原（服务端常用 %40 表示 @）", () => {
  assert.strictEqual(fileNameOf("/dav/cal/a%40b.ics"), "a@b.ics");
});

t("畸形转义退回**未解码的 basename**，不能是整条 URL", () => {
  assert.strictEqual(fileNameOf("/dav/cal/%E0%A4%A.ics"), "%E0%A4%A.ics");
});

console.log("[reconcile] 清单解析");

t("带/不带命名空间前缀的 href 都认，非 .ics 与集合自身要滤掉", () => {
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/dav/cal/</D:href></D:response>
    <D:response><D:href>/dav/cal/alive.ics</D:href></D:response>
    <D:response><href>/dav/cal/other.ics</href></D:response>
    <D:response><D:href>/dav/cal/readme.txt</D:href></D:response>
  </D:multistatus>`;
  assert.deepStrictEqual(parseNames(xml).sort(), ["alive.ics", "other.ics"]);
});

console.log("[reconcile] 判定：服务端优先 → 删本地");

t("幽灵条目被清掉，服务端仍有的与别处条目不动", () => {
  const items = [
    I({ uid: "ghost", href: "http://d/cal/ghost.ics" }),
    I({ uid: "alive", href: "http://d/cal/alive.ics" }),
    I({ uid: "foreign", calendarUrl: "OTHER", href: "http://d/other/foreign.ics" })
  ];
  const r = reconcile(items, ["alive.ics"], "server");
  assert.deepStrictEqual(r.cleaned, ["ghost"]);
  assert.deepStrictEqual(r.requeued, []);
  assert.strictEqual(r.skipped, "");
});

t("已标记删除 / 无 href / 脏的条目一律不参与", () => {
  const items = [
    I({ uid: "gone", href: "http://d/cal/gone.ics", deleted: true }),
    I({ uid: "nohref", href: "" }),
    I({ uid: "dirty", href: "http://d/cal/dirty.ics", dirty: true })
  ];
  const r = reconcile(items, ["something-else.ics"], "server");
  assert.deepStrictEqual(r.cleaned, [], "这三条都不能被当成幽灵");
  assert.strictEqual(r.skipped, "", "而且不该触发「空清单跳过」");
});

console.log("[reconcile] 判定：本地优先 → 置脏重传");

t("conflict=local 时不删，改为重新排队", () => {
  const items = [I({ uid: "ghost", href: "http://d/cal/ghost.ics" })];
  const r = reconcile(items, ["someone-else.ics"], "local");
  assert.deepStrictEqual(r.requeued, ["ghost"]);
  assert.deepStrictEqual(r.cleaned, [], "本地优先绝不删本地");
});

console.log("[reconcile] 安全约束（宁可漏判，不可误删）");

t("清单为空而本地有条目 → 整轮跳过", () => {
  const r = reconcile([I({ uid: "ghost", href: "http://d/cal/ghost.ics" })], [], "server");
  assert.strictEqual(r.skipped, "empty-list", "多半是打到了错地方，不能据此清空本地");
  assert.deepStrictEqual(r.cleaned, []);
});

t("清单为空且本地也空 → 正常无事发生（不该报「跳过」）", () => {
  const r = reconcile([], [], "server");
  assert.strictEqual(r.skipped, "");
});

console.log("[reconcile] 源码级断言（防止后续重构把对账悄悄摘掉）");

const syncSrc = readSrc("src/core/sync.ts");
const caldavSrc = readSrc("src/core/caldav.ts");

t("syncAll 每个日历拉取成功后都要调 reconcile，且排在 mergeServerItems 之后", () => {
  assert.ok(/await this\.reconcile\(cal, report\)/.test(syncSrc), "缺 reconcile 调用");
  const iMerge = syncSrc.indexOf("mergeServerItems(items, deletedKeys)");
  const iRecon = syncSrc.indexOf("await this.reconcile(cal, report)");
  assert.ok(iMerge > 0 && iRecon > iMerge, "reconcile 必须排在 mergeServerItems 之后");
});

t("三条安全约束都写在源码里", () => {
  assert.ok(/if \(!onServer\.size && candidates\.length\)/.test(syncSrc), "缺「清单为空而本地有条目 → 跳过」");
  assert.ok(/!it\.dirty/.test(syncSrc), "缺「只处理不脏条目」");
  assert.ok(/!it\.deleted/.test(syncSrc), "缺「跳过已标记删除的条目」");
  const tail = syncSrc.slice(syncSrc.indexOf("listResourceNames("));
  assert.ok(/catch \(e: unknown\)[\s\S]{0,220}return;/.test(tail), "清单拿不到要静默跳过而不是抛出去");
});

t("冲突策略两个分支都在", () => {
  assert.ok(/conflict === "local"/.test(syncSrc), "缺本地优先分支");
  assert.ok(/report\.requeued\+\+/.test(syncSrc), "本地优先要计数");
  assert.ok(/this\.store\.remove\(keyOf\(it\)\)/.test(syncSrc), "服务端优先要真的删本地");
  assert.ok(/report\.reconciled\+\+/.test(syncSrc), "服务端优先要计数");
});

t("SyncReport 带 reconciled / requeued，三处构造都补齐", () => {
  assert.ok(/reconciled: number/.test(syncSrc) && /requeued: number/.test(syncSrc), "报告字段缺失");
  const ctors = syncSrc.match(/reconciled: 0/g) || [];
  assert.strictEqual(ctors.length, 3, "三处 SyncReport 字面量都要补字段，实际 " + ctors.length);
});

t("pushAndPersist 明确不做对账（刚建的条目还没进服务端清单）", () => {
  const i = syncSrc.indexOf("private async pushAndPersist");
  const body = syncSrc.slice(i, i + 1000);
  assert.ok(/不做对账/.test(body), "pushAndPersist 里要写明为什么不做对账");
  assert.ok(!/this\.reconcile\(/.test(body), "pushAndPersist 里不许调 reconcile");
});

t("caldav.ts 暴露 fileNameOf / listResourceNames 且用 Depth:1 取全量", () => {
  assert.ok(/export function fileNameOf/.test(caldavSrc));
  assert.ok(/export async function listResourceNames/.test(caldavSrc));
  const i = caldavSrc.indexOf("export async function listResourceNames");
  const body = caldavSrc.slice(i, i + 1000);
  assert.ok(/Depth: "1"/.test(body), "必须 Depth:1 才能拿到集合内全部资源");
  assert.ok(/\.ics\$/i.test(body), "只要 .ics，集合自身与非日历文件要滤掉");
});

t("新增文案都走 i18n（Obsidian 侧不写死中文）", () => {
  const body = syncSrc.slice(syncSrc.indexOf("private async reconcile"), syncSrc.indexOf("private async pushDirty"));
  const literals = body.match(/["`](对账|资源清单|服务端清单|已清理|条本地条目)/g) || [];
  assert.deepStrictEqual(literals, [], "reconcile 里出现中文字面量：" + literals.join(","));
});

// ---- 2026-10-10 实测回归：思源删一条 → Obsidian 同步，用户看到「删除 0 条」
//      且状态栏报「同步失败：对账：已清理 1 条…」。两个独立缺陷，各自钉死。 ----

t("服务端删除要计入 report.deleted（否则用户以为删除没同步过来）", () => {
  // 调用点现在是先接住返回值再取 .removed，不是链式直取
  assert.ok(
    /const merged = this\.store\.mergeServerItems\(items, deletedKeys\)/.test(syncSrc),
    "mergeServerItems 的返回值必须先接住"
  );
  assert.ok(/report\.deleted \+= merged\.removed/.test(syncSrc), "removed 要累加进 report.deleted");
  // 对账清理的幽灵条目同理：本地确实少了一条
  const recon = syncSrc.slice(syncSrc.indexOf("private async reconcile"), syncSrc.indexOf("private async pushDirty"));
  assert.ok(/report\.reconciled\+\+/.test(recon), "对账清理要计 reconciled");
  assert.ok(
    /report\.reconciled\+\+;[\s\S]{0,200}?report\.deleted\+\+/.test(recon),
    "对账清理的条目也要计入 report.deleted（否则仍是「删除 0 条」）"
  );
});

t("mergeServerItems 返回 removed / applied 计数（store 侧真的实现了吗）", () => {
  const storeSrc = readSrc("src/core/store.ts");
  assert.ok(
    /mergeServerItems\(incoming: CalItem\[\], deletedKeys: string\[\] = \[\]\): \{ changed: boolean; removed: number; applied: number \}/.test(
      storeSrc
    ),
    "签名要返回 { changed, removed, applied }"
  );
  const body = storeSrc.slice(storeSrc.indexOf("mergeServerItems(incoming"));
  assert.ok(/let removed = 0/.test(body), "要有 removed 计数");
  assert.ok(/let applied = 0/.test(body), "要有 applied 计数（拉取用）");
  assert.ok(
    /if \(this\.items\.has\(key\)\) \{\s*this\.items\.delete\(key\);\s*changed = true;\s*removed\+\+/.test(body),
    "deletedKeys 命中时才 removed++（命中不存在的 key 不能计数，否则会虚报删除）"
  );
  assert.ok(/return \{ changed, removed, applied \}/.test(body), "要返回 removed + applied");
});

// ---- 2026-10-10 第三轮：新建一条显示「上传1 拉取1」——自环回显 ----

t("fetched 取实际写入数，不能取 items.length（否则自环回显让拉取虚增）", () => {
  assert.ok(/report\.fetched \+= merged\.applied/.test(syncSrc), "拉取要取 merged.applied");
  assert.ok(
    !/report\.fetched \+= items\.length/.test(syncSrc),
    "绝不能再取 items.length —— 自己刚推的会被当变更推回，重复计入拉取"
  );
});

t("applied 只在真写入时 ++（same 判定跳过的条目不能算拉取）", () => {
  const storeSrc = readSrc("src/core/store.ts");
  const body = storeSrc.slice(storeSrc.indexOf("mergeServerItems(incoming"));
  const iSet = body.indexOf("this.items.set(keyOf(inc)");
  const iApplied = body.indexOf("applied++");
  const iSame = body.indexOf("if (same) continue;");
  assert.ok(iSame > 0 && iSame < iSet, "same 判定要在写入之前（自环条目靠它挡掉）");
  assert.ok(iApplied > iSet, "applied++ 要紧跟在真写入之后");
});

t("对账提示走 lastNote 中性通道，绝不塞进 lastError", () => {
  assert.ok(
    /this\.store\.lastNote = notes\.join\("; "\) \|\| undefined/.test(syncSrc),
    "对账提示要写 lastNote"
  );
  assert.ok(
    /this\.store\.lastError = report\.errors\.join\("; "\) \|\| undefined/.test(syncSrc),
    "lastError 只装真错误"
  );
  assert.ok(
    !/lastError = \[\.\.\.report\.errors, \.\.\.notes\]/.test(syncSrc),
    "绝不能让对账说明混进 lastError（会把成功同步显示成「同步失败」）"
  );
});

t("lastNote 有完整的存取盘链路（加了字段但没存 = 重启即丢）", () => {
  const typesSrc = readSrc("src/core/types.ts");
  const storeSrc = readSrc("src/core/store.ts");
  assert.ok(/lastNote\?: string/.test(typesSrc), "SyncState 要有 lastNote");
  assert.ok(/lastNote\?: string/.test(storeSrc), "CalStore 要有 lastNote 字段");
  assert.ok(/this\.lastNote = data\.sync\?\.lastNote/.test(storeSrc), "load 要读 lastNote");
  assert.ok(/lastNote: this\.lastNote/.test(storeSrc), "persist 要写 lastNote");
});

t("同步抛异常时要清掉过期 lastNote（否则报错后中性提示一直挂着）", () => {
  // 用 lastNote 赋值点定位 syncAll 的兜底 catch —— 文件里有多处 catch
  // （pushDirty / 每个日历 / reconcile 各一个），按序号数位置会随重构漂移。
  const iAssign = syncSrc.indexOf("this.store.lastNote = notes.join");
  assert.ok(iAssign > 0, "先找到正常路径的 lastNote 赋值点");
  const iCatch = syncSrc.indexOf("} catch (e: unknown) {", iAssign);
  assert.ok(iCatch > iAssign, "正常路径之后应紧跟 syncAll 的兜底 catch");
  const body = syncSrc.slice(iCatch, iCatch + 600);
  assert.ok(/this\.store\.lastNote = undefined/.test(body), "异常路径要清 lastNote");
});

t("UI 层：状态栏与横幅对 lastNote 用中性样式，不用 is-error", () => {
  const mainSrc = readSrc("src/main.ts");
  const viewSrc = readSrc("src/ui/main-view.ts");
  const cssSrc = readSrc("src/styles.css");
  assert.ok(/statusBarNote/.test(mainSrc), "状态栏要有中性前缀 statusBarNote");
  assert.ok(
    /if \(note\)[\s\S]{0,300}statusBarNote/.test(mainSrc),
    "状态栏要单独处理 lastNote 分支，且放在 lastError 之后"
  );
  assert.ok(/is-note/.test(viewSrc), "面板横幅要有 is-note 样式");
  assert.ok(/\.caldav-status\.is-note/.test(cssSrc), "is-note 样式要定义");
  assert.ok(
    /statusBarError/.test(mainSrc) && /is-error/.test(viewSrc),
    "真错误仍然走原来的错误通道，别把错误提示一起降级"
  );
});

// ---- 2026-10-10 第二轮：即时推送（新建/编辑/删除单条）的计数被整个丢弃，
//      用户随后点全量同步看到「上传 0 · 删除 0」，以为改动没同步 ----

t("即时推送的 uploaded/deleted 要攒进 pending，不能丢", () => {
  const body = syncSrc.slice(syncSrc.indexOf("private async pushAndPersist"));
  assert.ok(/pendingUploaded \+= report\.uploaded/.test(body), "上传数要攒进 pendingUploaded");
  assert.ok(/pendingDeleted \+= report\.deleted/.test(body), "删除数要攒进 pendingDeleted");
  assert.ok(/report\.uploaded \+= this\.store\.pendingUploaded/.test(syncSrc), "syncAll 要并进报告");
  assert.ok(/report\.deleted \+= this\.store\.pendingDeleted/.test(syncSrc), "syncAll 要并进报告");
});

t("pending 合并后必须清零（否则下一轮重复计数）", () => {
  const i = syncSrc.indexOf("report.uploaded += this.store.pendingUploaded");
  assert.ok(i > 0, "先找到合并点");
  const body = syncSrc.slice(i, i + 400);
  assert.ok(/pendingUploaded = 0/.test(body), "合并后 pendingUploaded 要清零");
  assert.ok(/pendingDeleted = 0/.test(body), "合并后 pendingDeleted 要清零");
});

t("即时推送后立刻给反馈（用户点完删除要看得到「已上云」）", () => {
  const body = syncSrc.slice(syncSrc.indexOf("private async pushAndPersist"));
  assert.ok(/sync\.pushedUpload/.test(body) && /sync\.pushedDelete/.test(body), "要有即时反馈文案");
  assert.ok(/if \(pushed\.length\) this\.store\.lastNote = pushed\.join/.test(body), "反馈写 lastNote 中性通道");
});

t("pending 有完整的存取盘链路（重启就丢 = 计数凭空消失）", () => {
  const storeSrc2 = readSrc("src/core/store.ts");
  const typesSrc2 = readSrc("src/core/types.ts");
  assert.ok(/pendingUploaded\?: number/.test(typesSrc2), "SyncState 要有 pendingUploaded");
  assert.ok(/pendingDeleted\?: number/.test(typesSrc2), "SyncState 要有 pendingDeleted");
  assert.ok(/this\.pendingUploaded = data\.sync\?\.pendingUploaded/.test(storeSrc2), "load 要读 pending");
  assert.ok(/pendingUploaded: this\.pendingUploaded/.test(storeSrc2), "persist 要写 pending");
});

console.log(failed ? `\n[reconcile] ${failed} 项失败` : "\n[reconcile] 全部通过");