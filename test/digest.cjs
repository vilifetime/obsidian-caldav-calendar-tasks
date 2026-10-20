/**
 * Digest 认证回归（2026-10-20 从思源侧 digest.test.mjs 同构移植）
 *
 * 背景：Baïkal 的用户库只存 digest_a1_hash、不验 Basic 密码，对它只发 Basic
 * 永远 401（表现为「认证失败：用户名或密码错误」），而同一对凭据在
 * DAVx5 / Thunderbird 里能登录——那些客户端收到 `WWW-Authenticate: Digest`
 * challenge 后会自动协商。本测试钉住协商全链路：
 *   1. md5 / parseDigestChallenge / buildDigestAuthorization 纯函数（含 RFC 2617 公开向量）
 *   2. httpRequest 的 Observable 行为：Basic 401+challenge → Digest 重试、
 *      按 origin+用户名 缓存、nc 递增、stale 换 nonce 重协商一次、
 *      无 challenge 的 401 是真·密码错原样上交、无 auth 不发第二次
 *   3. 源码断言：设置保存处必须 clearAuthCache，http.ts 的 Basic 首次行为不丢
 *
 * 与思源版的差异：Obsidian 是单通道（requestUrl 天然无 CORS），测试不桩 fetch，
 * 直接用 core/http.ts 的 setTransport 注入假 transport；断言改为观察
 * transport 收到的 Authorization 头（而不是代理 body）。
 *
 * 用法：node test/digest.cjs
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 与 upload-limits.cjs 同一套路：tsc 编译到临时目录再引
const outDir = path.join(ROOT, ".test-digest");
execSync(
  `npx tsc src/core/digest.ts src/core/http.ts src/i18n/index.ts ` +
    `--outDir .test-digest --module commonjs --target es2020 --moduleResolution node ` +
    `--esModuleInterop --skipLibCheck --strict false --resolveJsonModule`,
  { cwd: ROOT, stdio: "inherit" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const digest = require(path.join(outDir, "core", "digest.js"));
const http = require(path.join(outDir, "core", "http.js"));

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("  [PASS]", name);
  } catch (e) {
    console.error("  [FAIL]", name, "\n     ", e.message);
    failed++;
  }
}
async function ta(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  [PASS]", name);
  } catch (e) {
    console.error("  [FAIL]", name, "\n     ", e.message);
    failed++;
  }
}
const eq = (a, b, hint) => {
  if (a !== b) throw new Error(`${hint || ""} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};
const ok = (cond, hint) => {
  if (!cond) throw new Error(hint || "断言失败");
};

// ---------- MD5 标准向量（含 UTF-8） ----------
console.log("[digest] MD5 向量");
t("md5 空串", () => eq(digest.md5(""), "d41d8cd98f00b204e9800998ecf8427e"));
t("md5 abc", () => eq(digest.md5("abc"), "900150983cd24fb0d6963f7d28e17f72"));
t("md5 fox", () =>
  eq(digest.md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6")
);
t("md5 UTF-8 中文", () => eq(digest.md5("中文密码"), "3d4acf94adca8562b4990599b15488de"));
t("md5 长输入（2000 字节跨多块）", () => eq(digest.md5("a".repeat(2000)), "7c1c566ab4cdb11ac8971191694e8bec"));
t("md5 中英混合长串", () => eq(digest.md5("CalDAV-Sync-中文-1234567890"), "c6d3962861235eef60c100f6dfa0eaa7"));
t("md5 64/128 字节边界", () => {
  // 55 字节（刚好不需第二块）、56 字节（需要第二块）、64 字节
  for (const n of [55, 56, 63, 64, 65, 119, 120]) {
    const v = digest.md5("x".repeat(n));
    ok(/^[0-9a-f]{32}$/.test(v), `len ${n} 非法: ${v}`);
  }
});

// ---------- RFC 2617 §3.5.3 完整向量 ----------
console.log("[digest] RFC 2617 标准链");
t("Digest 头 response 与 RFC 公开值一致", () => {
  const cred = {
    username: "Mufasa",
    password: "Circle Of Life",
    challenge: { realm: "testrealm@host.com", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", qop: "auth" },
    nc: 0
  };
  const hdr = digest.buildDigestAuthorization(cred, "GET", "/dir/index.html", "0a4f113b");
  ok(hdr.startsWith("Digest "), hdr);
  ok(hdr.includes('response="6629fae49393a05397450978507c4ef1"'), hdr);
  ok(hdr.includes("nc=00000001"), hdr);
  ok(hdr.includes('cnonce="0a4f113b"'), hdr);
  ok(hdr.includes('uri="/dir/index.html"'), hdr);
  ok(hdr.includes("qop=auth"), hdr);
  eq(cred.nc, 1, "nc 应自增到 1");
});
t("第二次构造 nc=00000002", () => {
  const cred = { username: "u", password: "p", challenge: { realm: "r", nonce: "n", qop: "auth" }, nc: 0 };
  digest.buildDigestAuthorization(cred, "PROPFIND", "/dav.php/", "c1");
  const hdr2 = digest.buildDigestAuthorization(cred, "PROPFIND", "/dav.php/", "c2");
  ok(hdr2.includes("nc=00000002"), hdr2);
});
t("无 qop（RFC 2069）也能构造", () => {
  const cred = { username: "u", password: "p", challenge: { realm: "r", nonce: "n" }, nc: 0 };
  const hdr = digest.buildDigestAuthorization(cred, "GET", "/x", "c");
  ok(hdr.startsWith("Digest "));
  ok(!hdr.includes("nc="), hdr);
  ok(hdr.includes('response="'), hdr);
});

// ---------- challenge 解析 ----------
console.log("[digest] challenge 解析");
t("解析 Baïkal 真实 challenge", () => {
  const ch = digest.parseDigestChallenge(
    'Digest realm="BaikalDAV",qop="auth",nonce="6ad4dd36dd671",opaque="d66d5f0524036afcb61420e358f990ce"'
  );
  ok(ch, "应解析出 challenge");
  eq(ch.realm, "BaikalDAV");
  eq(ch.nonce, "6ad4dd36dd671");
  eq(ch.qop, "auth");
  eq(ch.opaque, "d66d5f0524036afcb61420e358f990ce");
});
t("Basic challenge 返回 null", () => eq(digest.parseDigestChallenge('Basic realm="BaikalDAV"'), null));
t("空/undefined 返回 null", () => {
  eq(digest.parseDigestChallenge(undefined), null);
  eq(digest.parseDigestChallenge(""), null);
});
t("多 scheme 合并头能定位 Digest 段", () => {
  const ch = digest.parseDigestChallenge('Basic realm="a", Digest realm="b", nonce="n1", qop="auth"');
  ok(ch, "应定位到 Digest 段");
  eq(ch.realm, "b");
  eq(ch.nonce, "n1");
});
t("缺 nonce 返回 null", () => eq(digest.parseDigestChallenge('Digest realm="r"'), null));
t("只有 auth-int 时返回 null（不支持）", () =>
  eq(digest.parseDigestChallenge('Digest realm="r", nonce="n", qop="auth-int"'), null));
t("stale=true 被解析", () => {
  const ch = digest.parseDigestChallenge('Digest realm="r", nonce="n", qop="auth", stale=true');
  eq(ch && ch.stale, true);
});
t("algorithm=MD5-sess 透传", () => {
  const ch = digest.parseDigestChallenge('Digest realm="r", nonce="n", algorithm=MD5-sess');
  eq(ch && ch.algorithm, "MD5-sess");
});

// ---------- httpRequest 协商行为（假 transport） ----------
console.log("[digest] httpRequest 协商行为");

(async () => {
const BAIKAL_CHALLENGE = 'Digest realm="BaikalDAV",qop="auth",nonce="NONCE-1",opaque="OP-1"';

/** 假 transport：script 逐步返回，最后一步粘滞；记录每个请求的 Authorization */
function makeServer(script) {
  const received = [];
  let i = 0;
  return {
    received,
    handle(auth) {
      received.push({ auth: auth || null });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return step;
    }
  };
}

function installTransport(server) {
  http.setTransport(async (_url, opts) => {
    const step = server.handle((opts.headers || {}).Authorization);
    // 与 obsidianTransport 一致：键名归一化为小写（www-authenticate 查找依赖它）
    const headers = {};
    for (const [k, v] of Object.entries(step.headers || {})) headers[k.toLowerCase()] = v;
    return { status: step.status, headers, body: step.body || "", elapsedMs: 1, via: "direct" };
  });
}

function digestParams(hdr) {
  const out = {};
  for (const m of hdr.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

const OPTS = {
  method: "PROPFIND",
  body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
  headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
  timeoutMs: 15000
};
const AUTH = { username: "bonebear", password: "pw-secret" };

await ta("Basic 401 + Digest challenge → 协商后 207", async () => {
  http.clearAuthCache();
  const server = makeServer([
    { status: 401, headers: { "Www-Authenticate": BAIKAL_CHALLENGE }, body: "<error/>" },
    { status: 207, headers: {}, body: "<multistatus/>" }
  ]);
  installTransport(server);
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "direct", AUTH);
  eq(r.status, 207);
  eq(server.received.length, 2, "应恰好两次请求：Basic + Digest");
  ok(server.received[0].auth.startsWith("Basic "), "第一次必须是 Basic");
  ok(server.received[1].auth.startsWith("Digest "), "第二次必须是 Digest");
  const p = digestParams(server.received[1].auth);
  // 独立重算 response，验证整条 MD5 链
  const ha1 = digest.md5(`${AUTH.username}:BaikalDAV:${AUTH.password}`);
  const ha2 = digest.md5("PROPFIND:/dav.php/");
  const expect = digest.md5(`${ha1}:NONCE-1:${p.nc}:${p.cnonce}:auth:${ha2}`);
  eq(p.response, expect, "Digest response 与独立重算不一致");
  eq(p.nc, "00000001");
  eq(p.uri, "/dav.php/");
  eq(p.opaque, "OP-1");
});

await ta("协商后缓存生效：同服务器下一次直接 Digest（无 401 往返）", async () => {
  const server = makeServer([{ status: 207, headers: {}, body: "<multistatus/>" }]);
  installTransport(server);
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "direct", AUTH);
  eq(r.status, 207);
  eq(server.received.length, 1, "有缓存时应只发一次");
  ok(server.received[0].auth.startsWith("Digest "), "应直接走 Digest");
  ok(server.received[0].auth.includes("nc=00000002"), "nc 应递增");
});

await ta("Basic 服务器密码错：401 无 challenge → 不重试、原样返回", async () => {
  http.clearAuthCache();
  const server = makeServer([{ status: 401, headers: {}, body: "denied" }]);
  installTransport(server);
  const r = await http.httpRequest("http://radicale.test:5232/user/cal/", OPTS, "direct", AUTH);
  eq(r.status, 401);
  eq(server.received.length, 1, "没有 Digest challenge 时不能重试");
  ok(server.received[0].auth.startsWith("Basic "));
});

await ta("Basic 服务器正常：一次 207，不碰 Digest 逻辑", async () => {
  http.clearAuthCache();
  const server = makeServer([{ status: 207, headers: {}, body: "<multistatus/>" }]);
  installTransport(server);
  const r = await http.httpRequest("http://radicale.test:5232/user/cal/", OPTS, "direct", AUTH);
  eq(r.status, 207);
  eq(server.received.length, 1);
  ok(server.received[0].auth.startsWith("Basic "));
});

await ta("nonce 过期（stale）：丢缓存换新 nonce 重试一次", async () => {
  http.clearAuthCache();
  // 先建立缓存
  const warm = makeServer([
    { status: 401, headers: { "Www-Authenticate": BAIKAL_CHALLENGE }, body: "" },
    { status: 207, headers: {}, body: "" }
  ]);
  installTransport(warm);
  await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "direct", AUTH);
  // 再模拟 nonce 过期：服务端给新 challenge（stale=true）
  const renewed = 'Digest realm="BaikalDAV",qop="auth",nonce="NONCE-2",opaque="OP-2",stale=true';
  const server = makeServer([
    { status: 401, headers: { "www-authenticate": renewed }, body: "" },
    { status: 207, headers: {}, body: "" }
  ]);
  installTransport(server);
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "direct", AUTH);
  eq(r.status, 207);
  eq(server.received.length, 2, "过期时应：Digest 401 → 换 nonce 再 Digest");
  ok(server.received[0].auth.includes("NONCE-1"), "第一次还用旧 nonce");
  ok(server.received[1].auth.includes("NONCE-2"), "第二次必须换新 nonce");
  // 缓存已更新：再下一次直接用新 nonce
  const after = makeServer([{ status: 207, headers: {}, body: "" }]);
  installTransport(after);
  await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "direct", AUTH);
  eq(after.received.length, 1);
  ok(after.received[0].auth.includes("NONCE-2"), "缓存应已是新 nonce");
  // 新 nonce 在重试那一下已用掉 nc=1，所以再下一次是 nc=2
  ok(after.received[0].auth.includes("nc=00000002"), "新 nonce 的 nc 应续着计");
});

await ta("clearAuthCache 后回到 Basic 首次流程", async () => {
  const server = makeServer([
    { status: 401, headers: { "Www-Authenticate": BAIKAL_CHALLENGE }, body: "" },
    { status: 207, headers: {}, body: "" }
  ]);
  installTransport(server);
  http.clearAuthCache();
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "direct", AUTH);
  eq(r.status, 207);
  eq(server.received.length, 2, "清缓存后应重新 Basic→Digest 协商");
  ok(server.received[0].auth.startsWith("Basic "));
});

await ta("无 auth 的请求不带 Authorization、不发第二次", async () => {
  const server = makeServer([{ status: 207, headers: {}, body: "" }]);
  installTransport(server);
  const r = await http.httpRequest("http://x.test/dav.php/", OPTS, "direct");
  eq(r.status, 207);
  eq(server.received.length, 1);
  eq(server.received[0].auth, null);
});

await ta("不同 origin 分别协商（缓存键含 origin）", async () => {
  http.clearAuthCache();
  const s1 = makeServer([
    { status: 401, headers: { "Www-Authenticate": BAIKAL_CHALLENGE }, body: "" },
    { status: 207, headers: {}, body: "" }
  ]);
  installTransport(s1);
  await http.httpRequest("http://a.test/dav.php/", OPTS, "direct", AUTH);
  eq(s1.received.length, 2, "第一个服务器应先 Basic 后 Digest");
  // 第二个 origin：不该命中第一个的缓存（realm/nonce 不同，拿旧 nonce 只会 401）
  const s2 = makeServer([
    { status: 401, headers: { "Www-Authenticate": BAIKAL_CHALLENGE }, body: "" },
    { status: 207, headers: {}, body: "" }
  ]);
  installTransport(s2);
  const r = await http.httpRequest("http://b.test/dav.php/", OPTS, "direct", AUTH);
  eq(r.status, 207);
  eq(s2.received.length, 2, "第二个 origin 应重新协商，而不是复用第一个的 Digest 缓存");
  ok(s2.received[0].auth.startsWith("Basic "), "第二个 origin 第一次也必须是 Basic");
});

await ta("带 body 但没传 timeoutMs：自动按 uploadTimeoutMs 放宽", async () => {
  http.clearAuthCache();
  let seenTimeout = null;
  http.setTransport(async (_url, opts) => {
    seenTimeout = opts.timeoutMs;
    return { status: 207, headers: {}, body: "", elapsedMs: 1, via: "direct" };
  });
  // 32KB/s 折算：1MB → 60s + 32s = 92000ms
  await http.httpRequest("http://c.test/dav.php/", { method: "PUT", body: "x".repeat(1024 * 1024) }, "direct", AUTH);
  eq(seenTimeout, 92000, "1MB body 应得 92s 预算");
  // 显式传了 timeoutMs 的调用方保持原值（caldav.ts 的 dav() 传 30000）
  await http.httpRequest("http://c.test/dav.php/", { method: "PROPFIND", body: "small", timeoutMs: 30000 }, "direct", AUTH);
  eq(seenTimeout, 30000, "显式 timeoutMs 不能被覆盖");
});

  // ---------- 源码断言 ----------
  console.log("[digest] 源码断言");
  t("settings-tab 保存后调用 clearAuthCache", () => {
    // 先剥注释：注释里出现函数名不能算调用
    const src = read("src/ui/settings-tab.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    ok(/import\s*\{\s*clearAuthCache\s*\}\s*from\s*"@\/core\/http"/.test(src), "缺少 clearAuthCache import");
    ok(/clearAuthCache\(\)/.test(src), "保存流程里没有调用 clearAuthCache()");
  });
  t("http.ts 保留 Basic 首次行为与上传预算逻辑", () => {
    const src = read("src/core/http.ts");
    ok(src.includes("basicAuthHeader(auth.username, auth.password)"), "Basic 首次行为被改掉");
    ok(/uploadTimeoutMs\(/.test(src), "上传预算逻辑丢失");
    ok(/parseDigestChallenge\(/.test(src), "Digest challenge 解析丢失");
  });

  console.log(`\n[digest] ${passed} 项通过${failed ? `，${failed} 项失败` : ""}`);
  if (failed > 0) process.exitCode = 1;
})();
