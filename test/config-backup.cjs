/**
 * 回归测试：配置备份（卸载后重装免重配）。
 *
 * 2026-10-09 雄哥反馈：Obsidian 里把插件卸载后重装，服务器等配置全丢，要重新配一遍。
 * 根因很直白：Obsidian 卸载插件会删掉整个 `.obsidian/plugins/<id>/` 目录，
 * `data.json` 一起没了；而 Obsidian **没有** `onUninstall` 钩子可利用。
 * 解法是「趁data.json 还在时另存一份到卸载删不到的位置」，重装时问用户要不要恢复。
 *
 * 这个功能最危险的失败模式是**把明文密码写出去**（备份文件是明文 JSON），
 * 所以断言重心压在「绝不出明文」与「备份坏掉时不拖垮插件」这两条上。
 *
 * 用法：node test/config-backup.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── ① 逻辑层：直接跑编译后的模块（纯函数，无宿主依赖）──
// 用 esbuild 把 TS 打成 CJS 再 require，比在测试里复刻实现更可靠 ——
// 复刻会与源码漂移，而这类安全断言一旦漂移就等于没有。
const OUT = path.join(ROOT, ".test-config-backup");
fs.rmSync(OUT, { recursive: true, force: true });
// 直接用 esbuild 的 JS API，不用 CLI —— Windows 上 spawnSync("npx.cmd") 会 EINVAL。
require(path.join(ROOT, "node_modules", "esbuild")).buildSync({
  entryPoints: [path.join(ROOT, "src/core/config-backup.ts")],
  bundle: true,
  format: "cjs",
  outfile: path.join(OUT, "backup.cjs"),
  external: ["obsidian"],
  logLevel: "error"
});

// obsidian 只用到 normalizePath，给一个与真实现一致的最小实现
const Module = require("module");
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "obsidian") return { normalizePath: (p) => String(p).replace(/\\/g, "/").replace(/\/{2,}/g, "/") };
  return origLoad.call(this, req, ...rest);
};
const B = require(path.join(OUT, "backup.cjs"));
Module._load = origLoad;

const ok = (m) => console.log("  ✓ " + m);

/* ── 1. 备份里必须有 keyring，否则密文解不开、等于没备份密码 ── */
{
  const p = B.buildBackup({ serverUrl: "https://dav.example.com/", password: "enc:v3:AAAA" }, "KEYRING_X");
  assert.strictEqual(p.v, 1, "应带格式版本");
  assert.strictEqual(p.keyring, "KEYRING_X", "keyring 必须随备份一起存");
  assert.ok(p.savedAt && !Number.isNaN(Date.parse(p.savedAt)), "savedAt 必须是可解析的时间");
  ok("buildBackup 带版本、时间戳与 keyring");
}

/* ── 2. 安全闸：明文密码一律判为不安全 ── */
{
  const plain = B.buildBackup({ serverUrl: "s", password: "hunter2" }, "k");
  assert.strictEqual(B.hasPlaintextPassword(plain), true, "明文密码必须被识别出来");
  ok("hasPlaintextPassword 能抓出明文密码");

  // 三种密文前缀都要认（判据复用 secret.ts 的 isEncrypted，不能自己写窄正则）
  for (const enc of ["enc:v3:AAAA", "enc:v2:BBBB", "enc:v1:CCCC"]) {
    const b = B.buildBackup({ serverUrl: "s", password: enc }, "k");
    assert.strictEqual(B.hasPlaintextPassword(b), false, `${enc} 应被认作密文（安全）`);
  }
  ok("v1/v2/v3 三种密文前缀都算安全（判据与 secret.ts 对齐）");

  // 空密码不算不安全 —— 它压根没有密码可泄漏
  assert.strictEqual(B.hasPlaintextPassword(B.buildBackup({ serverUrl: "s", password: "" }, "k")), false, "空密码不应误报");
  assert.strictEqual(B.hasPlaintextPassword(B.buildBackup({ serverUrl: "s" }, "k")), false, "字段缺失不应误报");
  ok("空/缺省密码不误报");
}

/* ── 3. looksFreshInstall：只在真的没配置时才算新装 ── */
{
  assert.strictEqual(B.looksFreshInstall(null), true, "loadData 返回 null = 新装");
  assert.strictEqual(B.looksFreshInstall(undefined), true, "undefined = 新装");
  assert.strictEqual(B.looksFreshInstall({}), true, "空对象 = 新装");
  assert.strictEqual(B.looksFreshInstall({ settings: {} }), true, "有 settings 但无服务器 = 新装");
  assert.strictEqual(B.looksFreshInstall({ settings: { serverUrl: "" } }), true, "服务器地址为空 = 新装");
  assert.strictEqual(B.looksFreshInstall({ settings: { serverUrl: "https://x/" } }), false, "已有服务器 = 老装，不能弹恢复提示");
  assert.strictEqual(B.looksFreshInstall("乱码"), true, "非对象数据按新装处理");
  ok("looksFreshInstall 只在真正无配置时为真（老装不会被打扰）");
}

/* ── 4. 合并策略：备份为底、默认值为上，新版默认值不能盖掉用户旧配置 ── */
{
  const merged = B.mergeBackupSettings({
    v: 1, savedAt: "", keyring: "k",
    settings: { serverUrl: "https://old.example.com/", channel: "auto" }
  });
  assert.strictEqual(merged.serverUrl, "https://old.example.com/", "备份里的值必须胜出");
  assert.ok(merged.conflict, "备份没带的字段应落回默认值（不能是 undefined）");
  ok("mergeBackupSettings 以备份为底，新版默认值只兜未带的字段");
}

/* ── 5. 只有实质内容的备份才值得打扰用户 ── */
{
  assert.strictEqual(B.isBackupUseful(B.buildBackup({ serverUrl: "" }, "k")), false, "空配置不该弹提示");
  assert.strictEqual(B.isBackupUseful(B.buildBackup({ serverUrl: "https://x/" }, "k")), true, "有服务器就该提示");
  assert.strictEqual(B.isBackupUseful(B.buildBackup({ serverUrl: "", calendars: [{}, {}] }, "k")), true, "有日历列表也算有内容");
  ok("isBackupUseful 过滤掉空备份");
}

/* ── 6. 路径必须在 plugins/ 之外（卸载只删 plugins/<id>/）── */
{
  const p = B.backupPathOf();
  assert.strictEqual(p, "caldav-calendar-tasks/backup.json", `路径应固定，实际 ${p}`);
  assert.ok(!p.startsWith("plugins/"), "备份绝不能落在会被卸载删掉的 plugins/ 下");
  ok("备份路径位于 plugins/ 之外：" + p);
}

/* ── 7. 描述文案：解析不出时间就用兜底，不露出 Invalid Date ── */
{
  assert.strictEqual(B.backupTimeText({ savedAt: "" }, "兜底"), "兜底", "空时间应走兜底");
  assert.strictEqual(B.backupTimeText({ savedAt: "不是时间" }, "兜底"), "兜底", "非法时间应走兜底");
  const txt = B.backupTimeText({ savedAt: new Date().toISOString() }, "兜底");
  assert.ok(txt && !/Invalid/i.test(txt), `合法时间应格式化，实际 ${txt}`);
  assert.ok(/2 个日历/.test(B.describeBackup(B.buildBackup({ serverUrl: "https://dav.example.com/", calendars: [{}, {}] }, "k"))), "摘要应含日历数");
  ok("backupTimeText / describeBackup 兜底正确");
}

/* ── 8. 磁盘读写：原子替换 + 损坏/非法内容不抛 ──
 * 走一个内存 adapter 桩，真实跑 writeBackup/readBackup/clearBackup。
 * 「解析失败返回 undefined 而不是抛」是关键 —— 用户手改坏文件、或跨设备
 * 撞上同名文件都很常见，不该因此让插件加载失败。
 */
{
  const files = new Map();
  const dirs = new Set();
  const app = {
    vault: {
      adapter: {
        exists: async (p) => files.has(p) || dirs.has(p),
        mkdir: async (p) => { dirs.add(p); },
        write: async (p, c) => { files.set(p, c); },
        read: async (p) => files.get(p),
        remove: async (p) => { files.delete(p); },
        rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }
      }
    }
  };
  (async () => {
    const payload = B.buildBackup({ serverUrl: "https://dav.example.com/", username: "u", password: "enc:v3:CIPHER" }, "KR");
    const wrote = await B.writeBackup(app, payload);
    assert.strictEqual(wrote, true, "写入应成功");
    assert.ok(!files.has("caldav-calendar-tasks/backup.json.tmp"), "临时文件必须已改名掉，不能残留");
    assert.ok(files.has("caldav-calendar-tasks/backup.json"), "目标文件应存在");

    const back = await B.readBackup(app);
    assert.ok(back, "应能读回");
    assert.strictEqual(back.keyring, "KR", "keyring 必须往返不丢");
    assert.strictEqual(back.settings.serverUrl, "https://dav.example.com/", "服务器地址必须往返");
    assert.strictEqual(back.settings.password, "enc:v3:CIPHER", "密码保持密文形态往返");
    ok("写入 / 读回往返一致，且密码全程是密文");

    // 覆盖写：第二次写不应把第一次的残留拼进去
    await B.writeBackup(app, B.buildBackup({ serverUrl: "https://new.example.com/" }, "KR2"));
    const back2 = await B.readBackup(app);
    assert.strictEqual(back2.settings.serverUrl, "https://new.example.com/", "覆盖写应完全替换");
    ok("重复写入是替换而非追加（原子改名路径正确）");

    // 损坏的 JSON
    files.set("caldav-calendar-tasks/backup.json", "{ 这不是 JSON");
    assert.strictEqual(await B.readBackup(app), undefined, "坏 JSON 必须返回 undefined 而非抛异常");
    ok("备份文件损坏时不抛异常（返回 undefined）");

    // 格式对但内容不是备份（撞上同名文件）
    files.set("caldav-calendar-tasks/backup.json", JSON.stringify({ hello: "world" }));
    assert.strictEqual(await B.readBackup(app), undefined, "非备份内容必须被拒");
    ok("内容不合法的文件被拒绝（不误认成备份）");

    // 读失败（adapter 抛）也不应冒泡
    const brokenApp = { vault: { adapter: { exists: async () => true, read: async () => { throw new Error("EACCES"); } } } };
    assert.strictEqual(await B.readBackup(brokenApp), undefined, "读失败必须降级为 undefined");
    ok("读取失败降级为 undefined，不影响插件加载");

    // 写入失败返回 false（保险失败不能影响正常配置流程）
    const failApp = { vault: { adapter: { exists: async () => false, mkdir: async () => { throw new Error("EROFS"); }, remove: async () => {} } } };
    assert.strictEqual(await B.writeBackup(failApp, payload), false, "写入失败应返回 false 而非抛");
    ok("写入失败返回 false（保险失败不拖垮正常流程）");

    // clearBackup
    files.set("caldav-calendar-tasks/backup.json", "{}");
    await B.clearBackup(app);
    assert.strictEqual(files.has("caldav-calendar-tasks/backup.json"), false, "clearBackup 应删掉文件");
    await B.clearBackup(app); // 再删一次不能抛
    ok("clearBackup 可重复调用（点过「重新配置」后不会再问）");

    console.log("\n✓ 配置备份测试通过");
    console.log("  - 备份含 keyring，密码全程密文（明文一律被拒）");
    console.log("  - 只在真正无配置时才提示恢复；空备份不打扰");
    console.log("  - 路径在 plugins/ 之外，卸载删不到");
    console.log("  - 原子替换写入；备份损坏 / 读失败 / 写失败均不抛异常");
  })().catch((e) => {
    console.error("✗ 配置备份测试失败：", e && e.message ? e.message : e);
    process.exit(1);
  });
}

/* ── 9. 源码级防漂移：接线和安全约束不许被删掉 ── */
{
  const main = read("src/main.ts");
  const store = read("src/core/store.ts");

  // onload 里必须先取原始数据再判新装（loadData 只能调一次）
  assert.ok(/const rawLoaded = \(await this\.loadData\(\)\)/.test(main),
    "onload 必须先取一次原始 data.json 用于判新装（loadData 只能调一次，重复调会拿到 undefined）");
  assert.ok(/const fresh = looksFreshInstall\(rawLoaded\)/.test(main), "必须用 looksFreshInstall 判断新装");
  assert.ok(/if \(fresh\) void this\.offerRestore\(\)/.test(main), "只有新装时才问是否恢复");

  // 备份写入必须去抖，且 onunload 要清掉定时器
  assert.ok(/backupTimer = window\.setTimeout\(\(\) => void this\.syncBackup\(\), 3000\)/.test(main),
    "备份写入必须去抖（persist 触发太频繁，会成IO 热点）");
  assert.ok(/if \(this\.backupTimer\) window\.clearTimeout\(this\.backupTimer\)/.test(main),
    "onunload 必须清掉备份定时器，否则插件停用后仍写盘");

  // 两条安全闸：明文密码不写、不恢复
  assert.ok(/if \(hasPlaintextPassword\(payload\)\) return;/.test(main),
    "写入前必须过明文密码闸");
  assert.ok(/if \(hasPlaintextPassword\(backup\)\) return;/.test(main),
    "恢复前必须过明文密码闸（不能把明文搬进 data.json）");

  // 读不到磁盘形态时必须剔除密码，而不是拿内存明文去写
  assert.ok(/settings = \{ \.\.\.settings, password: "" \};\s*\n\s*}\s*\ncatch \{/.test(main) ||
    /catch \{\s*\n\s*settings = \{ \.\.\.settings, password: "" \};/.test(main),
    "读不到磁盘形态时必须把密码整个剔除（内存里是明文，绝不能落盘）");

  // 恢复走 store.adoptBackup，且先给 keyring 再解密
  assert.ok(/this\.store\.adoptBackup\(backup\)/.test(main), "恢复必须走 store.adoptBackup");
  const adopt = store.slice(store.indexOf("adoptBackup("));
  const keyringAt = adopt.indexOf("adoptKeyring(");
  const unlockAt = adopt.indexOf("unlockPassword(");
  assert.ok(keyringAt > 0 && unlockAt > keyringAt,
    "必须先 adoptKeyring 再 unlockPassword（反了会把新密文误判成解不开而丢弃）");
  assert.ok(/this\.rawCipher = "";/.test(adopt),
    "恢复时必须清掉 rawCipher，否则恢复失败会把作废的旧密文写回去");

  // 备份不含 items —— 判据是「结构里没有该字段」，而不是「源码里没有 items 这个词」
  //（源码的注释里必须解释清楚为什么不含，那段文字里就会出现 items）。
  const cb = read("src/core/config-backup.ts");
  const iface = cb.slice(cb.indexOf("export interface BackupPayload"));
  assert.ok(!/\bitems\??\s*:/.test(iface.slice(0, iface.indexOf("}"))),
    "BackupPayload 里不该有 items 字段（条目能重新拉取，备份只会让文件膨胀）");
  ok("BackupPayload 不含 items（结构级断言）");

  console.log("  ✓ 接线和安全约束的源码级断言通过");
}
