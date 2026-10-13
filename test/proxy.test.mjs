
// 代理测试（node:test，无第三方依赖）：直接加载构建产物 Hopline-proxy.js，
// 桩替换 cloudflare:sockets、WebSocketPair 与外网 fetch。运行：npm test
import { test } from 'node:test';

import assert from 'node:assert/strict';

import { register } from 'node:module';

// cloudflare:sockets / cloudflare:workers 仅存在于 Workers 运行时：测试中替换为桩
const hooks = `

export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
  }
  if (spec === 'cloudflare:sockets') {
    // 默认不可用；出站测试通过 globalThis.__connect 注入可控的假连接
    return { url: 'data:text/javascript,export function connect(a){ if (globalThis.__connect) return globalThis.__connect(a); throw new Error("sockets unavailable in tests"); }', shortCircuit: true };
  }
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

// 外网一律离线（DoH 等由各用例用 withFetch 注入）
globalThis.fetch = async () => { throw new Error('offline in tests'); };

const proxyModule = await import('../Hopline-proxy.js');
const worker = proxyModule.default;

const UUID = '11111111-2222-4333-8444-555555555555';
const baseEnv = (extra = {}) => ({ UUID, PATH: UUID, ...extra });   // 代理只需要 UUID 与 PATH 两个环境变量；路径取 UUID 的值，使 /<UUID> 即节点入口

// ---------------- 优选 IP 来源开关：HostMonit / uouin / 自定义 API ----------------
import { createHash } from 'node:crypto';

async function withFetch(handler, fn) {
  const offline = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(String(url)); return handler(String(url), opts);
  };
  try { return await fn(calls); } finally { globalThis.fetch = offline; }
}


// ---------------- 代理：出站竞速 / WS 0-RTT 早数据 / VLESS 响应头 ----------------
// Workers 运行时对象的最小替身：WebSocketPair、101 响应、可控时延的 TCP 连接
class FakeWS {
  constructor() { this.sent = []; this.closed = null; this.l = {}; this.binaryType = ''; }
  accept() {}
  send(d) { this.sent.push(new Uint8Array(d)); }
  close(code, reason) { this.closed = { code, reason }; }
  addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
  emit(t, ev) { return Promise.all((this.l[t] || []).map(f => f(ev))); }
}

let lastServer = null;

globalThis.WebSocketPair = function () { const client = new FakeWS(), server = new FakeWS(); lastServer = server; return { 0: client, 1: server }; };

const NodeResponse = globalThis.Response;

globalThis.Response = class extends NodeResponse {
  constructor(body, init) {
    if (init && init.status === 101) { super(null, { status: 200, headers: init.headers }); Object.defineProperty(this, 'status', { value: 101 }); this.webSocket = init.webSocket; }
    else super(body, init);
  }
};

// 字节流关闭：按规范，挂起中的 BYOB 读取要由数据源 respond(0) 才会以 done 结束（运行时的 socket 内部会处理）
const closeBytes = (c) => { c.close(); if (c.byobRequest) c.byobRequest.respond(0); };

// 假网络：net[hostname] = { delay: 毫秒 | 'hang' | 'fail' }；记录每次连接与写入内容
function fakeNet(net) {
  const log = [];
  globalThis.__connect = ({ hostname, port }) => {
    const b = net[hostname] || { delay: 'fail' };
    const sock = { hostname, port, written: [], closedByUs: false };
    log.push(sock);
    sock.opened = b.delay === 'hang' ? new Promise(() => {})
      : b.delay === 'fail' ? Promise.reject(new Error('refused'))
      : new Promise(r => setTimeout(r, b.delay));
    sock.opened.catch(() => {});
    sock.writable = new WritableStream({ write(c) { sock.written.push(new Uint8Array(c)); } });
    // 与运行时的 socket 一致：字节流（支持 BYOB 读取）。enqueue 会转移缓冲区，先复制一份，测试里的原数组保持可用
    sock.readable = new ReadableStream({ type: 'bytes', start(c) { sock.push = (d) => c.enqueue(new Uint8Array(d)); sock.end = () => closeBytes(c); } });
    sock.close = () => { sock.closedByUs = true; };
    return sock;
  };
  return log;
}

const until = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };

const uuidBytes = UUID.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16));

// VLESS TCP 请求头（目标为域名）+ 首包
const vlessReq = (host, port, payload = []) => new Uint8Array([0, ...uuidBytes, 0, 1, port >> 8, port & 255, 2, host.length, ...Buffer.from(host), ...payload]);

const TLS_HELLO = [0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5];

// 内置地区反代的 DoH 解析：US → 203.0.113.10，HK → 203.0.113.20（无 colo 时本地区为 US、次地区为 HK）
const relayDoh = (url) => {
  const name = new URL(url).searchParams.get('name') || '';
  const type = new URL(url).searchParams.get('type');
  const ip = name.includes('.us.') ? '203.0.113.10' : name.includes('.hk.') ? '203.0.113.20' : name === 'cf-site.example' ? '104.16.0.1' : null;
  return new Response(JSON.stringify({ Status: 0, Answer: type === 'A' && ip ? [{ type: 1, data: ip }] : [] }));
};

async function openWs(env, headers = {}) {
  const res = await worker.fetch(new Request(`https://node.example.com/${UUID}`, { headers: { Upgrade: 'websocket', ...headers } }), env, {});
  assert.equal(res.status, 101);
  return lastServer;
}

test('出站竞速：直连挂起（Cloudflare 上的站点，SYN 被静默丢弃）时，直连优先窗口（1.5s）到期由内置反代接管', async () => {
  const log = fakeNet({ 'cf-site.example': { delay: 'hang' }, '203.0.113.10': { delay: 20 }, '203.0.113.20': { delay: 40 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(baseEnv());
    const t0 = Date.now();
    await ws.emit('message', { data: vlessReq('cf-site.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    const ms = Date.now() - t0;
    const used = log.find(s => s.written.length);
    assert.equal(used.hostname, '203.0.113.10', '本地区反代胜出');
    assert.deepEqual([...used.written[0]], TLS_HELLO, '反代收到去掉 VLESS 头的原始 TLS 数据');
    assert.ok(ms >= 1400 && ms < 2500, `建连耗时 ${ms}ms`);
    await until(() => log.find(s => s.hostname === '203.0.113.20').closedByUs);   // 败者连接被释放
  });
});

test('学习型路由：直连失败、由反代接通的站点被记住，之后的连接直接走反代（不再发直连、不查 DNS）', async () => {
  const log = fakeNet({ 'cf-learn.example': { delay: 'fail' }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
  const dns = [];
  await withFetch((url) => { dns.push(new URL(url).searchParams.get('name')); return relayDoh(url); }, async () => {
    let ws = await openWs(baseEnv());
    let t0 = Date.now();
    await ws.emit('message', { data: vlessReq('cf-learn.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.ok(Date.now() - t0 < 500, '直连立即失败：反代马上接管，不等窗口');
    assert.equal(log.filter(s => s.hostname === 'cf-learn.example').length, 1);
    log.length = 0;
    ws = await openWs(baseEnv());
    t0 = Date.now();
    await ws.emit('message', { data: vlessReq('cf-learn.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, '203.0.113.10');
    assert.equal(log.filter(s => s.hostname === 'cf-learn.example').length, 0, '第二次不再尝试直连');
    assert.ok(!dns.includes('cf-learn.example'), '目标域名从不查 DNS');
  });
});

test('学习型路由：直连只是慢（超出窗口但最终连通）的站点不记录；已记录的站点反代失败时回落直连并删除记录', async () => {
  let log = fakeNet({ 'slowok.example': { delay: 1800 }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    let ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('slowok.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    await until(() => log.find(s => s.hostname === 'slowok.example').closedByUs);   // 直连随后连通，被回收
    log.length = 0;
    ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('slowok.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.filter(s => s.hostname === 'slowok.example').length, 1, '未被记录：仍然尝试直连');
    // 已记录的站点：反代全部失败 → 回落直连，记录删除
    log = fakeNet({ 'flip.example': { delay: 'fail' }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
    ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('flip.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));   // 记录 flip.example
    log = fakeNet({ 'flip.example': { delay: 5 }, '203.0.113.10': { delay: 'fail' }, '203.0.113.20': { delay: 'fail' } });
    ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('flip.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, 'flip.example', '反代不通：回落直连');
    log = fakeNet({ 'flip.example': { delay: 5 }, '203.0.113.10': { delay: 'fail' }, '203.0.113.20': { delay: 'fail' } });
    ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('flip.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log[0].hostname, 'flip.example', '记录已删除：直连优先');
  });
});

test('目标为 Cloudflare IP：不发注定失败的直连，直接走反代；反代不通时才回落直连', async () => {
  const req = new Uint8Array([0, ...uuidBytes, 0, 1, 1, 187, 1, 104, 16, 0, 5, ...TLS_HELLO]);   // 104.16.0.5:443
  let log = fakeNet({ '104.16.0.5': { delay: 5 }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    let ws = await openWs(baseEnv());
    await ws.emit('message', { data: req.buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, '203.0.113.10');
    assert.equal(log.filter(s => s.hostname === '104.16.0.5').length, 0, '没有直连尝试');
    log = fakeNet({ '104.16.0.5': { delay: 5 }, '203.0.113.10': { delay: 'fail' }, '203.0.113.20': { delay: 'fail' } });
    ws = await openWs(baseEnv());
    await ws.emit('message', { data: req.buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, '104.16.0.5', '反代不通：回落直连');
  });
});

test('内置地区反代域名只查 A 记录（这些域名没有 TXT），自定义反代仍查 TXT', async () => {
  fakeNet({ '198.51.100.31': { delay: 5 }, '198.51.100.32': { delay: 5 }, 'tx.example': { delay: 'fail' } });
  const dns = [];
  const stub = dohStub({ 'cloudflare-dns.com': { answers: {
    'proxyip.jp.cmliussss.net|A': ['198.51.100.31'], 'proxyip.sg.cmliussss.net|A': ['198.51.100.32'], 'my-alt.example.net|A': ['198.51.100.31'] } } }, dns);
  await withFetch(stub, () => connectVia(baseEnv({ ALT_MODE: 'builtin', ALT_REGION: 'JP', ALT_REGION2: 'SG' }), 'tx.example'));
  await until(() => dns.filter(d => /cmliussss/.test(d.name)).length >= 2);
  assert.deepEqual(dns.filter(d => /cmliussss/.test(d.name)).map(d => d.type), ['A', 'A']);
  await withFetch(stub, () => connectVia(baseEnv({ ALT_MODE: 'custom', ALT_CUSTOM: 'my-alt.example.net' }), 'tx.example'));
  await until(() => dns.filter(d => d.name === 'my-alt.example.net').length >= 2);
  assert.deepEqual(dns.filter(d => d.name === 'my-alt.example.net').map(d => d.type).sort(), ['A', 'TXT']);
});

test('出站竞速：直连在优先窗口内成功时使用直连，已建立的反代连接被关闭', async () => {
  const log = fakeNet({ 'direct.example': { delay: 120 }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('direct.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, 'direct.example');
    await until(() => log.filter(s => s.hostname.startsWith('203.')).every(s => s.closedByUs));
  });
});

test('出站竞速：直连较慢（600ms）但能通时仍用直连，不被反代抢走；直连失败则立即换反代', async () => {
  const log = fakeNet({ 'slow.example': { delay: 600 }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('slow.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, 'slow.example', '慢直连不应被反代取代');
  });
});

test('WS 下行：已到达的小块合并成一条消息（最多 64KB），字节顺序完整；之后到达的数据单独发出；目标结束后关闭 WS', async () => {
  const log = fakeNet({ 'batch.example': { delay: 5 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('batch.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    const sock = log.find(s => s.written.length);
    const n0 = ws.sent.length;   // VLESS 响应头
    // 同一时刻到达 100 个 4KB 块（400KB）：应合并为约 7 条 ≤64KB 的消息
    const blocks = Array.from({ length: 100 }, (_, i) => new Uint8Array(4096).fill(i));
    for (const b of blocks) sock.push(b);
    await until(() => ws.sent.slice(n0).reduce((a, x) => a + x.byteLength, 0) >= 409600);
    const msgs = ws.sent.slice(n0);
    assert.ok(msgs.length <= 10, `合并后 ${msgs.length} 条消息`);
    assert.ok(msgs.every(m => m.byteLength <= 64 * 1024 + 4096), '单条不超过 64KB（+ 最后一块）');
    const all = Buffer.concat(msgs.map(m => Buffer.from(m)));
    assert.ok(all.equals(Buffer.concat(blocks.map(b => Buffer.from(b)))), '字节顺序完整');
    // 稍后单独到达的小块：不等待凑满，直接发出
    sock.push(new Uint8Array([1, 2, 3]));
    await until(() => ws.sent.length === n0 + msgs.length + 1);
    assert.deepEqual([...ws.sent.at(-1)], [1, 2, 3]);
    sock.end();
    await until(() => ws.closed);
    assert.equal(ws.closed.code, 1000);
  });
});

test('WebSocket 不协商压缩：101 响应给出不含 permessage-deflate 的扩展值（运行时据此不启用压缩）', async () => {
  fakeNet({});
  const res = await worker.fetch(new Request(`https://node.example.com/${UUID}`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' } }), baseEnv(), {});
  assert.equal(res.status, 101);
  assert.ok(!/permessage-deflate/i.test(res.headers.get('Sec-WebSocket-Extensions') || ''));
});

test('非 TLS 首包（如 Telegram MTProto）只走直连，不送进 SNI 型反代', async () => {
  const log = fakeNet({ 'tg.example': { delay: 30 }, '203.0.113.10': { delay: 5 }, '203.0.113.20': { delay: 5 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('tg.example', 443, [0xef, 0xef, 0xef, 0xef]).buffer });
    await until(() => log.some(s => s.written.length));
    assert.deepEqual(log.map(s => s.hostname), ['tg.example']);
  });
});

test('VLESS 响应头在头部解析后立即下发；头部与首包分帧到达时等待首包判定（不超过 80ms）', async () => {
  const log = fakeNet({ 'split.example': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(baseEnv());
    await ws.emit('message', { data: vlessReq('split.example', 443).buffer });   // 只有头部
    assert.deepEqual(ws.sent.map(x => [...x]), [[0, 0]], '收到头部即回响应头，早于建连');
    assert.equal(log.length, 0, '首包未到：暂不建连');
    await ws.emit('message', { data: new Uint8Array(TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.deepEqual([...log.find(s => s.written.length).written[0]], TLS_HELLO);
    assert.equal(ws.sent.length, 1, '响应头只发一次');
  });
});

test('WS 0-RTT：Sec-WebSocket-Protocol 中的早数据在握手阶段即建连；非法 / UUID 不符的早数据被忽略', async () => {
  const log = fakeNet({ 'early.example': { delay: 10 } });
  const b64url = (u8) => Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await withFetch(relayDoh, async () => {
    const ws = await openWs(baseEnv(), { 'Sec-WebSocket-Protocol': b64url(vlessReq('early.example', 443, TLS_HELLO)) });
    await until(() => log.some(s => s.written.length));
    assert.deepEqual([...log[0].written[0]], TLS_HELLO, '未收到任何 WS 数据帧即已转发首包');
    assert.deepEqual(ws.sent.map(x => [...x]), [[0, 0]]);
    await ws.emit('message', { data: new Uint8Array([9, 9]).buffer });   // 后续数据帧直接写出站
    await until(() => log[0].written.length === 2);
    // 普通子协议名 / 其它 UUID 的早数据：不建连，等待数据帧
    const other = vlessReq('early.example', 443, TLS_HELLO); other[1] ^= 0xff;
    for (const proto of ['binary', b64url(other)]) {
      const n = log.length;
      const w2 = await openWs(baseEnv(), { 'Sec-WebSocket-Protocol': proto });
      await new Promise(r => setTimeout(r, 30));
      assert.equal(log.length, n, proto);
      assert.equal(w2.closed, null);
    }
  });
});

test('明文端口 WebSocket（http://）不再被重定向到 https；普通 http 请求仍重定向', async () => {
  fakeNet({});
  const ws = await worker.fetch(new Request(`http://node.example.com/${UUID}`, { headers: { Upgrade: 'websocket' } }), baseEnv(), {});
  assert.equal(ws.status, 101);
  const page = await worker.fetch(new Request(`http://node.example.com/${UUID}`), baseEnv(), {});
  assert.equal(page.status, 301);
});

const ipv6Bytes = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];   // 2001:db8::1

const vlessReqV6 = (port) => new Uint8Array([0, ...uuidBytes, 0, 1, port >> 8, port & 255, 3, ...ipv6Bytes, ...TLS_HELLO]);

test('出站代理：密码含未编码 @ 时主机名解析正确；S5 对 IPv6 目标使用 ATYP=4；HTTP CONNECT 给 IPv6 加方括号', async () => {
  const feed = async (sock, bytes) => { await until(() => sock.push); sock.push(new Uint8Array(bytes)); };
  // SOCKS5：socks5://us:p@ss@10.0.0.1:1080
  let log = fakeNet({ '10.0.0.1': { delay: 5 } });
  let env = baseEnv({ HOP_ADDR: 'socks5://us:p@ss@10.0.0.1:1080', HOP_MODE: 'only' });
  let ws = await openWs(env);
  ws.emit('message', { data: vlessReqV6(443).buffer });   // 握手需要下面喂数据才会完成：不能 await
  await until(() => log.length && log[0].written.length);
  assert.equal(log[0].hostname, '10.0.0.1', '以最后一个 @ 分隔凭据与主机');
  assert.equal(log[0].port, 1080);
  await feed(log[0], [5, 2]);                                   // 服务器选择用户名密码认证
  await until(() => log[0].written.length >= 2);
  assert.equal(Buffer.from(log[0].written[1]).toString('latin1', 5), 'p@ss', '密码完整');
  await feed(log[0], [1, 0]);                                   // 认证成功
  await until(() => log[0].written.length >= 3);
  const req = [...log[0].written[2]];
  assert.deepEqual(req.slice(0, 4), [5, 1, 0, 4], 'IPv6 目标用 ATYP=4');
  assert.deepEqual(req.slice(4, 20), ipv6Bytes);
  assert.deepEqual(req.slice(20), [1, 187]);
  // HTTP CONNECT
  log = fakeNet({ '10.0.0.2': { delay: 5 } });
  env = baseEnv({ HOP_ADDR: 'http://10.0.0.2:8080', HOP_MODE: 'only' });
  ws = await openWs(env);
  ws.emit('message', { data: vlessReqV6(443).buffer });
  await until(() => log.length && log[0].written.length);
  assert.match(Buffer.from(log[0].written[0]).toString(), /^CONNECT \[2001:db8::1\]:443 HTTP\/1\.1\r\nHost: \[2001:db8::1\]:443\r\n/);
});

test('协议头：地址被截断时等待后续分片（不按错误地址建连、不断开）；VLESS MUX 命令被拒绝；Trojan 握手不再被接受', async () => {
  const log = fakeNet({ 'split.example': { delay: 5 } });
  await withFetch(relayDoh, async () => {
    // 域名只到一半：旧实现会把截断的域名当目标
    const full = vlessReq('split.example', 443, TLS_HELLO);
    const cut = full.length - TLS_HELLO.length - 5;
    const ws = await openWs(baseEnv());
    await ws.emit('message', { data: full.slice(0, cut).buffer });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(log.length, 0);
    assert.equal(ws.closed, null);
    await ws.emit('message', { data: full.slice(cut).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log[0].hostname, 'split.example');
    // VLESS MUX（cmd=3）
    const mux = vlessReq('x.example', 443, TLS_HELLO); mux[1 + 16 + 1] = 3;
    const w2 = await openWs(baseEnv());
    await w2.emit('message', { data: mux.buffer });
    assert.equal(w2.closed.code, 1011);
    assert.match(w2.closed.reason, /不支持的命令/);
    // Trojan 已移除：即使客户端发来密码哈希正确的 Trojan 握手也只会被当作无效的 VLESS 头而拒绝，不建立任何出站连接
    const hex = createHash('sha224').update(UUID).digest('hex');
    const trojan = new Uint8Array([...Buffer.from(hex + '\r\n'), 1, 3, 9, ...Buffer.from('x.example'), 1, 187, 13, 10, ...TLS_HELLO]);
    const n = log.length;
    const w3 = await openWs(baseEnv());
    await w3.emit('message', { data: trojan.buffer });
    assert.equal(w3.closed.code, 1011);
    assert.equal(log.length, n);
  });
});

test('WebSocket 关闭原因按字节截断（含中文的长错误信息不会让 close() 抛异常）', async () => {
  globalThis.__connect = () => { throw new Error('出站连接失败：' + '很长的错误信息'.repeat(30)); };
  const ws = await openWs(baseEnv());
  // 直连与反代均失败 → fail(lastErr)
  await withFetch(() => new Response('{}'), async () => {
    await ws.emit('message', { data: vlessReq('x.example', 443, TLS_HELLO).buffer });
  });
  assert.ok(ws.closed, '连接已被关闭');
  assert.ok(Buffer.byteLength(ws.closed.reason) <= 123, `reason ${Buffer.byteLength(ws.closed.reason)} 字节`);
  assert.ok(!ws.closed.reason.includes('�'));
});

test('XHTTP：首个请求体块短于 VLESS 头部时累积后再解析', async () => {
  const log = fakeNet({ 'xh.example': { delay: 5 } });
  const env = baseEnv();
  const full = vlessReq('xh.example', 443, TLS_HELLO);
  const body = new ReadableStream({ async start(c) {
    c.enqueue(full.slice(0, 7)); await new Promise(r => setTimeout(r, 10));
    c.enqueue(full.slice(7, 30)); await new Promise(r => setTimeout(r, 10));
    c.enqueue(full.slice(30)); c.close();
  } });
  const res = await worker.fetch(new Request(`https://node.example.com/${UUID}`, { method: 'POST', body, duplex: 'half', headers: { 'User-Agent': 'x' } }), env, {});
  assert.equal(res.status, 200);
  await until(() => log.some(s => s.written.length));
  assert.equal(log[0].hostname, 'xh.example');
  assert.deepEqual([...log[0].written[0]], TLS_HELLO);
});

// 反代域名解析：DoH 记录与统计
const dohStub = (table, log = []) => async (url) => {
  const u = new URL(url); const name = u.searchParams.get('name'); const type = { 1: 'A', 28: 'AAAA', 16: 'TXT' }[u.searchParams.get('type')] || u.searchParams.get('type');
  log.push({ host: u.host, name, type });
  const rule = table[u.host] || table['*'];
  if (!rule) return new Response('x', { status: 500 });
  if (rule.status) return new Response('x', { status: rule.status });
  if (rule.delay) await new Promise(r => setTimeout(r, rule.delay));
  const ans = (rule.answers && rule.answers[name + '|' + type]) || [];
  return new Response(JSON.stringify({ Status: 0, Answer: ans.map(data => ({ type: type === 'A' ? 1 : type === 'TXT' ? 16 : 28, data })) }));
};

const connectVia = async (env, host) => {
  const ws = await openWs(env);
  await ws.emit('message', { data: vlessReq(host, 443, TLS_HELLO).buffer });
  return ws;
};

test('反代 / 落地域名解析：每种记录只发 1 个 DoH 请求（Cloudflare 优先）；结果缓存复用，但不跨请求共享进行中的解析', async () => {
  const log = fakeNet({ '198.51.100.5': { delay: 5 } });
  const dns = [];
  const env = baseEnv({ EDGEIP: 'dedupe.example.com' });
  await withFetch(dohStub({ 'cloudflare-dns.com': { delay: 40, answers: { 'dedupe.example.com|A': ['198.51.100.5'] } } }, dns), async () => {
    const sockets = [];
    for (let i = 0; i < 4; i++) sockets.push(await openWs(env));
    await Promise.all(sockets.map(ws => ws.emit('message', { data: vlessReq('t.example', 443, TLS_HELLO).buffer })));
    await until(() => log.filter(s => s.hostname === '198.51.100.5').length === 4);
    // 解析完成后的连接：直接用缓存，不再查询
    const n = dns.length;
    await connectVia(env, 't.example');
    await until(() => log.filter(s => s.hostname === '198.51.100.5').length === 5);
    assert.equal(dns.length, n, '缓存命中：不再查询');
  });
  const mine = dns.filter(d => d.name === 'dedupe.example.com');
  // 进行中的解析不跨请求共享（Workers 中发起请求结束时 fetch 被取消，共享者会永远挂起）：并发冷启动时各自查询
  assert.deepEqual(mine.map(d => d.type).sort(), ['A', 'A', 'A', 'A', 'TXT', 'TXT', 'TXT', 'TXT']);
  assert.ok(mine.every(d => d.host === 'cloudflare-dns.com'), '只用第一个端点，没有同时发给 3 个');
});

test('反代域名解析：首选 DoH 失败时才换下一个端点；全部失败后 30 秒内不再重复查询', async () => {
  fakeNet({ '198.51.100.6': { delay: 5 }, 'neg.example.com': { delay: 5 } });
  // 首选端点 500 → 第二个端点接手，第三个不被访问
  let dns = [];
  let env = baseEnv({ EDGEIP: 'fallback.example.com' });
  await withFetch(dohStub({ 'dns.alidns.com': { answers: { 'fallback.example.com|A': ['198.51.100.6'] } } }, dns), () => connectVia(env, 't.example'));
  let hosts = dns.filter(d => d.name === 'fallback.example.com').map(d => d.host);
  assert.deepEqual([...new Set(hosts)].sort(), ['cloudflare-dns.com', 'dns.alidns.com']);
  assert.ok(!hosts.includes('doh.pub'));
  // 全部失败：第一次尝试所有端点，第二次连接直接用缓存的「无结果」
  dns = [];
  env = baseEnv({ EDGEIP: 'neg.example.com' });
  await withFetch(dohStub({}, dns), () => connectVia(env, 't.example'));
  const first = dns.filter(d => d.name === 'neg.example.com').length;
  assert.ok(first >= 6, `第一次查询了所有端点（${first}）`);
  dns.length = 0;
  await withFetch(dohStub({}, dns), () => connectVia(env, 't.example'));
  assert.equal(dns.filter(d => d.name === 'neg.example.com').length, 0, '30 秒内不再重复查询');
});

test('UDP DNS（VLESS UDP 53）转 DoH：Cloudflare 优先，失败才换端点', async () => {
  const query = new Uint8Array([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, ...Buffer.from('example'), 3, ...Buffer.from('com'), 0, 0, 1, 0, 1]);
  const req = () => new Uint8Array([0, ...uuidBytes, 0, 2, 0, 53, 1, 8, 8, 8, 8, ...query]);   // VLESS UDP（cmd=2）→ 8.8.8.8:53
  const run = async (table) => {
    const dns = [];
    await withFetch(dohStub(table, dns), async () => {
      const ws = await openWs(baseEnv());
      await ws.emit('message', { data: req().buffer });
      assert.equal(ws.sent.length, 1, 'DNS 应答');
      const resp = ws.sent[0];
      assert.deepEqual([...resp.slice(0, 2)], [0x12, 0x34]);
      assert.deepEqual([...resp.slice(-4)], [93, 184, 216, 34]);
    });
    return dns.map(d => d.host);
  };
  const ans = { 'example.com|A': ['93.184.216.34'] };
  assert.deepEqual(await run({ 'cloudflare-dns.com': { answers: ans } }), ['cloudflare-dns.com']);
  assert.deepEqual(await run({ 'dns.google': { answers: ans } }), ['cloudflare-dns.com', 'dns.google']);
});

// ---------------- 纯函数已知答案 / 协议头模糊测试 ----------------
import { createHmac, hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { assemble } from '../build.mjs';

// 内部函数不对外导出；改用合并源码（assemble），
// 去掉 import / export default 后在函数作用域内求值，取出要测的纯函数
const internals = (() => {
  const src = assemble('proxy')
    .replace(/^import .*$/gm, '').replace('export default {', 'const __default = {').replace(/^export class /gm, 'class ');
  return new Function('connect', 'WorkerEntrypoint', src + '\n;return { md5Bytes, sha1Bytes, hmacSha1, hkdfSha1, poly1305, chacha20Poly1305Seal, chacha20Poly1305Open, parseVssProtoHeader, isValidIp, parseHopAddress, altPlan, ALT_DOMAINS, nodeConfig, pumpReadable };')(() => { throw new Error('no sockets'); }, class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } });
})();

const hex = (u8) => Buffer.from(u8).toString('hex');

// ---- WS 下行管道 pumpReadable：BYOB 64KB 读取 / 非字节流回退 ----
// 收集 send 的消息；消息内容在管道结束后才检查：ws.send 不立即复制数据，若读取缓冲被复用，先发出的消息会被后读的数据覆盖
const pumpAll = async (readable) => {
  const sent = []; let done = 0;
  await internals.pumpReadable(readable, (m) => sent.push(m), () => done++);
  return { sent, done, bytes: Buffer.concat(sent.map(m => Buffer.from(m.buffer, m.byteOffset, m.byteLength))) };
};

const pattern = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

test('WS 下行 BYOB：已到达的数据一次读取最多 64KB 作为一条消息；大小块混合时字节完整，先发出的消息不被后续读取覆盖', async () => {
  const sizes = [3, 4096, 100000, 70, 65536, 1, 32768, 32767, 200000, 5];
  const chunks = sizes.map((n, i) => pattern(n, i));
  let k = 0;
  // 每次 pull 只给一块（模拟数据陆续到达），大块会被 64KB 缓冲拆成多次读取
  const { sent, done, bytes } = await pumpAll(new ReadableStream({ type: 'bytes', pull(c) { if (k < chunks.length) c.enqueue(chunks[k++].slice()); else closeBytes(c); } }));
  assert.equal(done, 1, 'onDone 调用一次');
  assert.ok(bytes.equals(Buffer.concat(chunks.map(c => Buffer.from(c)))), '字节顺序与内容完整');
  assert.ok(sent.every(m => m.byteLength > 0 && m.byteLength <= 64 * 1024), '每条消息 1B–64KB');
  // 同时到达的 100 个 4KB 块（400KB）：BYOB 一次读取取走 64KB → 7 条消息
  const blocks = Array.from({ length: 100 }, (_, i) => new Uint8Array(4096).fill(i));
  const r = await pumpAll(new ReadableStream({ type: 'bytes', start(c) { for (const b of blocks) c.enqueue(b.slice()); }, pull(c) { closeBytes(c); } }));
  assert.equal(r.sent.length, 7);
  assert.ok(r.bytes.equals(Buffer.concat(blocks.map(b => Buffer.from(b)))));
});

test('WS 下行：非字节流（SS 出站解密流）回退为默认读取并合并；出错时同样调用 onDone', async () => {
  const blocks = Array.from({ length: 40 }, (_, i) => pattern(4096, i));
  const r = await pumpAll(new ReadableStream({ start(c) { for (const b of blocks) c.enqueue(b); c.close(); } }));
  assert.equal(r.done, 1);
  assert.ok(r.bytes.equals(Buffer.concat(blocks.map(b => Buffer.from(b)))));
  assert.ok(r.sent.length < blocks.length, `合并为 ${r.sent.length} 条`);
  for (const type of ['bytes', undefined]) {
    const e = await pumpAll(new ReadableStream({ type, start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, pull(c) { c.error(new Error('reset')); } }));
    assert.equal(e.done, 1, `${type || 'default'}：出错后 onDone 调用一次`);
    assert.deepEqual([...e.bytes], [1, 2, 3]);
  }
});

const fromHexStr = (h) => new Uint8Array(Buffer.from(h.replace(/\s+/g, ''), 'hex'));

const lens = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000];   // 覆盖填充边界

const msgOf = (n) => 'x'.repeat(n);

test('MD5 / SHA-1 / HMAC-SHA1 / HKDF-SHA1 与 node:crypto 结果一致（含 RFC 已知答案与填充边界）', () => {
  const md5hex = (m) => hex(internals.md5Bytes(new TextEncoder().encode(m)));
  assert.equal(md5hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(hex(internals.sha1Bytes(new TextEncoder().encode('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  for (const n of lens) {
    const m = msgOf(n), bytes = new TextEncoder().encode(m);
    assert.equal(md5hex(m), createHash('md5').update(m).digest('hex'), `md5 len ${n}`);
    assert.equal(hex(internals.sha1Bytes(bytes)), createHash('sha1').update(m).digest('hex'), `sha1 len ${n}`);
  }
  const key = randomBytes(100), data = randomBytes(77);   // 密钥超过一个分组：先哈希
  assert.equal(hex(internals.hmacSha1(key, data)), createHmac('sha1', key).update(data).digest('hex'));
  const ikm = randomBytes(32), salt = randomBytes(16);
  for (const keyLen of [16, 32]) {
    assert.equal(hex(internals.hkdfSha1(ikm, salt, keyLen)), Buffer.from(hkdfSync('sha1', ikm, salt, 'ss-subkey', keyLen)).toString('hex'), `hkdf ${keyLen}`);
  }
});

test('Poly1305 / ChaCha20-Poly1305 通过 RFC 8439 已知答案，并与 node:crypto 互通、拒绝被篡改的数据', () => {
  // RFC 8439 §2.5.2 Poly1305
  const tag = internals.poly1305(fromHexStr('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b'), new TextEncoder().encode('Cryptographic Forum Research Group'));
  assert.equal(hex(tag), 'a8061dc1305136c6c22b8baf0c0127a9');
  // RFC 8439 §2.8.2 AEAD
  const key = fromHexStr('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
  const nonce = fromHexStr('070000004041424344454647');
  const aad = fromHexStr('50515253c0c1c2c3c4c5c6c7');
  const pt = new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const sealed = internals.chacha20Poly1305Seal(key, nonce, pt, aad);
  assert.equal(hex(sealed.slice(-16)), '1ae10b594f09e26a7e902ecbd0600691');
  assert.equal(hex(sealed.slice(0, 16)), 'd31a8d34648e60db7b86afbc53ef7ec2');
  assert.equal(Buffer.from(internals.chacha20Poly1305Open(key, nonce, sealed, aad)).toString(), Buffer.from(pt).toString());
  // 与 node 互通（随机数据、多种长度）
  for (const n of [0, 1, 15, 16, 17, 64, 65, 200, 1000]) {
    const k = randomBytes(32), nc = randomBytes(12), p = randomBytes(n);
    const c = createCipheriv('chacha20-poly1305', k, nc, { authTagLength: 16 });
    const expected = Buffer.concat([c.update(p), c.final(), c.getAuthTag()]);
    assert.equal(hex(internals.chacha20Poly1305Seal(k, nc, p)), expected.toString('hex'), `seal len ${n}`);
  }
  const bad = Uint8Array.from(sealed); bad[3] ^= 1;
  assert.equal(internals.chacha20Poly1305Open(key, nonce, bad, aad), null, '篡改后认证失败');
});

test('协议头解析：任意截断只会报「头部过短」；乱码只会抛普通 Error（不出现 RangeError / TypeError）', () => {
  const cfg = { uuid: UUID };
  const vless = [vlessReq('example.com', 443), vlessReqV6(443), new Uint8Array([0, ...uuidBytes, 3, 7, 7, 7, 1, 0, 80, 1, 1, 2, 3, 4])];
  for (const full of vless) {
    const header = internals.parseVssProtoHeader(full, cfg).headerLength;
    for (let k = 0; k < header; k++) {
      assert.throws(() => internals.parseVssProtoHeader(full.slice(0, k), cfg), (e) => e.constructor === Error && /头部过短/.test(e.message), `VLESS 截断 ${k}/${header}`);
    }
    assert.equal(internals.parseVssProtoHeader(full.slice(0, header), cfg).headerLength, header);
  }
  for (let i = 0; i < 500; i++) {   // 随机字节：要么解析成功，要么抛出我们自己的 Error
    const junk = randomBytes(1 + Math.floor(Math.random() * 90)); if (i % 2) { junk[0] = 0; junk.set(uuidBytes.slice(0, Math.min(16, junk.length - 1)), 1); }
    try { internals.parseVssProtoHeader(junk, cfg); } catch (e) { assert.equal(e.constructor, Error, `${e.name}: ${e.message}`); }
  }
});

// ---------------- Shadowsocks AEAD 出站：对照 node:crypto 实现的参考服务端 ----------------
// 参考实现完全按 SS AEAD 规范独立编写（EVP_BytesToKey、salt=密钥长度、HKDF-SHA1 子密钥、小端 nonce 计数、≤0x3FFF 分块、
// 数据流以目标地址头开头），用来验证 worker 的 ss:// 出站客户端能与真实服务端互通
const ssMethods = { 'aes-128-gcm': { cipher: 'aes-128-gcm', keyLen: 16 }, 'aes-256-gcm': { cipher: 'aes-256-gcm', keyLen: 32 }, 'chacha20-ietf-poly1305': { cipher: 'chacha20-poly1305', keyLen: 32 } };

function ssRefKey(password, keyLen) {
  let key = Buffer.alloc(0), prev = Buffer.alloc(0);
  while (key.length < keyLen) { prev = createHash('md5').update(Buffer.concat([prev, Buffer.from(password)])).digest(); key = Buffer.concat([key, prev]); }
  return key.subarray(0, keyLen);
}

function ssRefStream(method, password, salt) {
  const m = ssMethods[method];
  const sub = Buffer.from(hkdfSync('sha1', ssRefKey(password, m.keyLen), salt, 'ss-subkey', m.keyLen));
  let counter = 0n;
  const nonce = () => { const n = Buffer.alloc(12); n.writeBigUInt64LE(counter++); return n; };   // 小端计数器
  return {
    seal(pt) { const c = createCipheriv(m.cipher, sub, nonce(), { authTagLength: 16 }); return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]); },
    open(ct) { const d = createDecipheriv(m.cipher, sub, nonce(), { authTagLength: 16 }); d.setAuthTag(ct.subarray(-16)); return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]); },
  };
}

// 从客户端写入的字节流解出全部明文（遇到不完整的块停止）
function ssRefDecodeClient(method, password, bytes) {
  const keyLen = ssMethods[method].keyLen;
  const buf = Buffer.concat(bytes.map(b => Buffer.from(b)));
  if (buf.length < keyLen) return { plain: Buffer.alloc(0), maxChunk: 0 };
  const dec = ssRefStream(method, password, buf.subarray(0, keyLen));
  let off = keyLen, maxChunk = 0; const out = [];
  while (off + 18 <= buf.length) {
    const len = dec.open(buf.subarray(off, off + 18)).readUInt16BE(0);
    if (len > 0x3fff || off + 18 + len + 16 > buf.length) break;
    out.push(dec.open(buf.subarray(off + 18, off + 18 + len + 16)));
    off += 18 + len + 16; maxChunk = Math.max(maxChunk, len);
  }
  return { plain: Buffer.concat(out), maxChunk };
}
for (const method of Object.keys(ssMethods)) {
  test(`Shadowsocks 出站（${method}）：与按规范实现的参考服务端互通——目标地址头、分块、小端 nonce、双向数据`, async () => {
    const password = 'p@ss word!';
    const targets = [
      ['example.com', Buffer.from([3, 11, ...Buffer.from('example.com'), 1, 187])],
    ];
    for (const [host, expectHeader] of targets) {
      const log = fakeNet({ '10.0.0.9': { delay: 5 } });
      const env = baseEnv({ HOP_ADDR: `ss://${method}:${encodeURIComponent(password)}@10.0.0.9:8388`, HOP_MODE: 'only' });
      const ws = await openWs(env);
      const big = new Uint8Array(40000).map((_, i) => i & 255); big.set(TLS_HELLO);   // 超过单块上限：必须拆块
      await ws.emit('message', { data: vlessReq(host, 443, [...big]).buffer });
      await until(() => log.length && ssRefDecodeClient(method, password, log[0].written).plain.length >= expectHeader.length + big.length);
      const { plain, maxChunk } = ssRefDecodeClient(method, password, log[0].written);
      assert.deepEqual([...plain.subarray(0, expectHeader.length)], [...expectHeader], '数据流以目标地址头开始');
      assert.deepEqual([...plain.subarray(expectHeader.length)], [...big], '转发的数据完整');
      assert.ok(maxChunk <= 0x3fff, `单块 ${maxChunk} 字节不超过 0x3FFF`);
      assert.equal(log[0].written[0].length >= ssMethods[method].keyLen, true);
      // 服务端回包：salt + 多个块（nonce 逐块递增），客户端解密后转给 WebSocket
      const serverSalt = randomBytes(ssMethods[method].keyLen);
      const enc = ssRefStream(method, password, serverSalt);
      const chunk = (pt) => Buffer.concat([enc.seal(Buffer.from([pt.length >> 8, pt.length & 255])), enc.seal(Buffer.from(pt))]);
      log[0].push(Buffer.concat([serverSalt, chunk([9, 9, 9]), chunk([7, 7])]));
      const down = () => ws.sent.slice(1).flatMap(x => [...x]);   // 下行小块可能被合并成一条消息：按字节比较
      await until(() => down().length >= 5);
      assert.deepEqual(down(), [9, 9, 9, 7, 7]);
    }
  });
}

test('Shadowsocks 出站：IPv4 / IPv6 目标使用对应的地址类型；密码派生与 EVP_BytesToKey 一致', async () => {
  const method = 'aes-256-gcm', password = 'secret';
  const run = async (req, header) => {
    const log = fakeNet({ '10.0.0.9': { delay: 5 } });
    const env = baseEnv({ HOP_ADDR: `ss://${method}:${password}@10.0.0.9:8388`, HOP_MODE: 'only' });
    const ws = await openWs(env);
    await ws.emit('message', { data: req.buffer });
    await until(() => log.length && ssRefDecodeClient(method, password, log[0].written).plain.length >= header.length);
    assert.deepEqual([...ssRefDecodeClient(method, password, log[0].written).plain.subarray(0, header.length)], [...header]);
  };
  await run(new Uint8Array([0, ...uuidBytes, 0, 1, 1, 187, 1, 1, 2, 3, 4, ...TLS_HELLO]), [1, 1, 2, 3, 4, 1, 187]);
  await run(vlessReqV6(443), [4, ...ipv6Bytes, 1, 187]);
});

// ---------------- 可配置：优选域名 / 内置地区反代 ----------------
const cfDoh = (map, log = []) => async (url) => {   // 简易 DoH：map[域名] = [A 记录]，其余无记录
  const u = new URL(url); const name = u.searchParams.get('name'), type = { 1: 'A', 28: 'AAAA' }[u.searchParams.get('type')] || u.searchParams.get('type');
  log.push({ name, type });
  const ips = type === 'A' ? (map[name] || []) : [];
  return new Response(JSON.stringify({ Status: 0, Answer: ips.map(data => ({ type: 1, data })) }));
};

test('地区反代计划：默认按机房自动选地区；可固定首选 / 次选；none 只用首选；custom 取前 3 个；off 为空', () => {
  const plan = (relay, colo) => internals.altPlan({ alt: relay }, colo).map(p => `${p.host}:${p.port}x${p.take}`);
  const R = internals.ALT_DOMAINS;
  assert.deepEqual(plan(undefined, 'NRT'), [`${R.JP}:443x2`, `${R.HK}:443x1`], '默认：机房对应地区 + 默认的另一地区');
  assert.deepEqual(plan({ mode: 'builtin' }, 'HKG'), [`${R.HK}:443x2`, `${R.US}:443x1`], '首选为 HK 时次选用 US');
  assert.deepEqual(plan({ mode: 'builtin', region: 'DE', region2: 'NL' }, 'NRT'), [`${R.DE}:443x2`, `${R.NL}:443x1`]);
  assert.deepEqual(plan({ mode: 'builtin', region: 'DE', region2: 'none' }, 'NRT'), [`${R.DE}:443x2`]);
  assert.deepEqual(plan({ mode: 'builtin', region: 'DE', region2: 'DE' }, 'NRT'), [`${R.DE}:443x2`, `${R.HK}:443x1`], '次选与首选相同：回到默认的另一地区');
  assert.deepEqual(plan({ mode: 'builtin', region: 'bogus' }, 'NRT'), [`${R.JP}:443x2`, `${R.HK}:443x1`], '无效地区回退自动');
  assert.deepEqual(plan({ mode: 'custom', custom: 'a.example.com\nb.example.com:8443\n203.0.113.9\nd.example.com' }, 'NRT'),
    ['a.example.com:443x2', 'b.example.com:8443x1', '203.0.113.9:443x1']);
  assert.deepEqual(plan({ mode: 'off' }, 'NRT'), []);
});

test('地区反代模式：off 时不解析也不连接任何地区反代；custom 只连自己的反代；固定地区只解析该地区', async () => {
  // off：目标直连失败后不尝试任何反代，连接被关闭
  let log = fakeNet({});
  let dns = [];
  let env = baseEnv({ ALT_MODE: 'off' });
  await withFetch(cfDoh({}, dns), async () => {
    const ws = await openWs(env);
    await ws.emit('message', { data: vlessReq('off-test.example', 443, TLS_HELLO).buffer });
    assert.equal(ws.closed.code, 1011);
  });
  assert.deepEqual(log.map(s => s.hostname), ['off-test.example'], '只尝试了直连');
  assert.equal(dns.filter(d => d.name.startsWith('proxyip.')).length, 0, '没有解析任何内置反代域名');
  // custom：直连挂起（目标在 Cloudflare 上）→ 自定义反代接管，内置反代不被碰
  log = fakeNet({ 'cf-custom.example': { delay: 'hang' }, '203.0.113.31': { delay: 10 }, '203.0.113.30': { delay: 40 } });
  dns = [];
  env = baseEnv({ ALT_MODE: 'custom', ALT_CUSTOM: 'my-alt.example.com\n203.0.113.30:8443' });
  await withFetch(cfDoh({ 'my-alt.example.com': ['203.0.113.31'] }, dns), async () => {
    const ws = await openWs(env);
    await ws.emit('message', { data: vlessReq('cf-custom.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
  });
  const used = log.find(s => s.written.length);
  assert.equal(used.hostname, '203.0.113.31');
  assert.deepEqual([...used.written[0]], TLS_HELLO);
  assert.equal(log.find(s => s.hostname === '203.0.113.30').port, 8443, 'IP:端口 原样连接');
  assert.equal(dns.filter(d => d.name.startsWith('proxyip.')).length, 0, '自定义模式不解析内置反代');
  // 固定地区：首选 SE、次选不使用 → 只解析 SE
  log = fakeNet({ 'cf-se.example': { delay: 'hang' }, '203.0.113.50': { delay: 10 } });
  dns = [];
  env = baseEnv({ ALT_MODE: 'builtin', ALT_REGION: 'SE', ALT_REGION2: 'none' });
  await withFetch(cfDoh({ 'proxyip.se.cmliussss.net': ['203.0.113.50'] }, dns), async () => {
    const ws = await openWs(env);
    await ws.emit('message', { data: vlessReq('cf-se.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
  });
  assert.equal(log.find(s => s.written.length).hostname, '203.0.113.50');
  assert.deepEqual([...new Set(dns.filter(d => d.name.startsWith('proxyip.')).map(d => d.name))], ['proxyip.se.cmliussss.net']);
});

// ---------------- XHTTP（stream-one）----------------
const xhttpPost = (env, path, body) => worker.fetch(new Request(`https://node.example.com${path}`, { method: 'POST', body, duplex: 'half', headers: { 'User-Agent': 'Go-http-client/2.0' } }), env, {});

test('XHTTP：Xray 风格请求（路径带结尾 / 与 x_padding 查询串）被接受，响应以 VLESS 响应头开始并转发上行数据', async () => {
  const log = fakeNet({ 'slash.example': { delay: 5 } });
  const env = baseEnv();
  const res = await xhttpPost(env, `/${UUID}/?x_padding=${'x'.repeat(300)}`, vlessReq('slash.example', 443, TLS_HELLO));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const first = await res.body.getReader().read();
  assert.deepEqual([...first.value], [0, 0], '响应以 2 字节 VLESS 响应头开始');
  await until(() => log.some(s => s.written.length));
  assert.equal(log[0].hostname, 'slash.example');
  assert.deepEqual([...log[0].written[0]], TLS_HELLO);
});

test('XHTTP 下行有背压：客户端不读取时不会无限缓冲目标连接的数据；客户端断开后释放目标连接', async () => {
  let pulls = 0, closed = false;
  globalThis.__connect = () => ({
    opened: Promise.resolve(),
    writable: new WritableStream({ write() {} }),
    readable: new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(64 * 1024)); } }),   // 目标不停地发数据
    close() { closed = true; },
  });
  const env = baseEnv();
  const body = new ReadableStream({ start(c) { c.enqueue(vlessReq('bp.example', 443, TLS_HELLO)); } });   // 请求体保持打开
  const res = await xhttpPost(env, `/${UUID}`, body);
  const reader = res.body.getReader();
  assert.deepEqual([...(await reader.read()).value], [0, 0]);
  assert.equal((await reader.read()).value.byteLength, 64 * 1024);
  await new Promise(r => setTimeout(r, 100));   // 客户端停止读取
  assert.ok(pulls <= 10, `目标连接被读取了 ${pulls} 次（无背压时会一直增长）`);
  await reader.cancel();
  assert.equal(closed, true, '客户端断开后关闭目标连接');
});

// ---------------- VLESS WebSocket ----------------
test('WS：客户端在握手 / 等首包 / 建连期间断开时，服务端 WebSocket 与出站连接都被释放（allowHalfOpen 下不会自动回应关闭帧）', async () => {
  // 1) 只发了头部、还在等首包时断开
  let log = fakeNet({ 'half.example': { delay: 5 } });
  let ws = await openWs(baseEnv());
  ws.emit('message', { data: vlessReq('half.example', 443).buffer });
  await ws.emit('close', { code: 1000 });
  assert.ok(ws.closed, '服务端 WebSocket 已关闭，没有悬挂');
  await new Promise(r => setTimeout(r, 120));   // 超过首包等待：不得再建立出站连接
  assert.equal(log.length, 0);
  // 2) 建连过程中断开：连接建好后立即释放
  log = fakeNet({ 'slow.example': { delay: 80 } });
  ws = await openWs(baseEnv());
  const p = ws.emit('message', { data: vlessReq('slow.example', 443, TLS_HELLO).buffer });
  await until(() => log.length > 0);
  await ws.emit('close', { code: 1000 });
  await p;
  await until(() => log.every(s => s.closedByUs));
  assert.ok(ws.closed);
  // 3) 已在转发时断开：释放出站连接
  log = fakeNet({ 'live.example': { delay: 5 } });
  ws = await openWs(baseEnv());
  await ws.emit('message', { data: vlessReq('live.example', 443, TLS_HELLO).buffer });
  await ws.emit('close', { code: 1000 });
  assert.equal(log[0].closedByUs, true);
});

test('WS：同一帧内一次性到达的大量数据帧（建连完成前）按序、完整地转发', async () => {
  const log = fakeNet({ 'burst.example': { delay: 30 } });
  const ws = await openWs(baseEnv());
  const frames = Array.from({ length: 300 }, (_, i) => new Uint8Array(500).fill(i & 255));
  ws.emit('message', { data: vlessReq('burst.example', 443).buffer });            // 先只有头部
  for (const f of frames) ws.emit('message', { data: f.buffer.slice(0) });         // 连接建立前一口气到达
  await until(() => log[0] && log[0].written.reduce((n, w) => n + w.length, 0) >= 300 * 500);
  const got = Buffer.concat(log[0].written.map(w => Buffer.from(w)));
  assert.equal(Buffer.compare(got, Buffer.concat(frames.map(f => Buffer.from(f)))), 0);
});

// ---------------- 代理配置（只来自环境变量）与路由 ----------------
import { readFileSync } from 'node:fs';

test('环境变量：PATH 首尾斜杠自动去掉；其余设置缺省时与原先面板里的默认值一致', () => {
  const cfg = internals.nodeConfig({ UUID: UUID.toUpperCase(), PATH: '/mynode/' });
  assert.equal(cfg.uuid, UUID, 'UUID 转小写');
  assert.equal(cfg.path, 'mynode');
  assert.deepEqual(cfg._problems, []);
  assert.equal(cfg.edgeIP, '');
  assert.equal(cfg.hopAddr, '');
  assert.equal(cfg.hopMode, '');
  assert.deepEqual(cfg.alt, { mode: 'builtin', region: '', region2: '', custom: '' });
});

test('环境变量：出站 / 地区反代设置按原先的取值校验，无效值回落默认；自定义反代最多 3 个、支持换行与逗号分隔', () => {
  const c = (extra) => internals.nodeConfig({ UUID, PATH: 'p', ...extra });
  assert.equal(c({ EDGEIP: ' proxy.example.com:8443 ' }).edgeIP, 'proxy.example.com:8443');
  assert.equal(c({ HOP_ADDR: 'socks5://u:p@1.2.3.4:1080' }).hopAddr, 'socks5://u:p@1.2.3.4:1080');
  assert.equal(c({ HOP_MODE: 'only' }).hopMode, 'only');
  assert.equal(c({ HOP_MODE: 'NO' }).hopMode, 'no');
  assert.equal(c({ HOP_MODE: 'bogus' }).hopMode, '');
  assert.equal(c({ ALT_MODE: 'off' }).alt.mode, 'off');
  assert.equal(c({ ALT_MODE: 'custom' }).alt.mode, 'custom');
  assert.equal(c({ ALT_MODE: 'nonsense' }).alt.mode, 'builtin');
  assert.equal(c({ ALT_REGION: 'jp', ALT_REGION2: 'NONE' }).alt.region, 'JP', '地区名不区分大小写');
  assert.equal(c({ ALT_REGION: 'jp', ALT_REGION2: 'NONE' }).alt.region2, 'none');
  assert.equal(c({ ALT_REGION: 'digitalocean' }).alt.region, 'DigitalOcean');
  assert.equal(c({ ALT_REGION: 'Atlantis' }).alt.region, '');
  assert.equal(c({ ALT_CUSTOM: 'a.example.com, b.example.com:8443\nc.example.com;d.example.com' }).alt.custom, 'a.example.com\nb.example.com:8443\nc.example.com');
});

test('必填环境变量：UUID / PATH 缺失或非法时所有请求返回 503 设置说明', async () => {
  for (const [env, re] of [
    [{}, /UUID[\s\S]*PATH/],
    [{ UUID }, /PATH/],
    [{ PATH: 'p' }, /UUID/],
    [{ UUID: 'not-a-uuid', PATH: 'p' }, /UUID 的值不正确/],
    [{ UUID, PATH: 'a/b' }, /PATH 的值不正确/],
    [{ UUID, PATH: 'x'.repeat(129) }, /PATH 的值不正确/],
  ]) {
    for (const path of ['/', '/p', '/anything']) {
      const res = await worker.fetch(new Request('https://node.example.com' + path), env, {});
      assert.equal(res.status, 503, JSON.stringify(env) + ' ' + path);
      assert.match(await res.text(), re);
    }
  }
});

test('路由：只有节点路径上的 WebSocket / XHTTP 进入代理，其余一律是 Hello World 伪装页（没有面板、登录、订阅与管理接口）', async () => {
  fakeNet({ 'route.example': { delay: 5 } });
  const env = baseEnv({ PATH: 'mynode' });
  const hello = async (path, init) => {
    const res = await worker.fetch(new Request('https://node.example.com' + path, init), env, {});
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /Hello World/, path);
  };
  for (const path of ['/', '/login', '/version', '/mynode/api/config', '/mynode/sub', `/${UUID}/sub`, `/${UUID}`, '/mynode/x', '/other']) {
    await hello(path, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    await hello(path, { headers: { 'User-Agent': 'v2rayN/7.0' } });
  }
  await hello('/login', { method: 'POST', body: 'username=admin&password=x' });
  await hello('/other', { method: 'POST', body: new Uint8Array(vlessReq('x.example', 443)) });
  await hello('/mynode', { headers: { 'User-Agent': 'Mozilla/5.0' } });   // 节点路径上的普通 GET 也只是伪装页
  // 节点路径（首尾斜杠无关）上：WebSocket 升级与 XHTTP POST 始终可用，无需任何开关
  const ws = await worker.fetch(new Request('https://node.example.com/mynode/', { headers: { Upgrade: 'websocket' } }), env, {});
  assert.equal(ws.status, 101);
  const post = await xhttpPost(env, '/mynode', vlessReq('route.example', 443, TLS_HELLO));
  assert.equal(post.headers.get('content-type'), 'application/octet-stream');
});

test('构建产物：代理脚本不含面板 / 登录 / 订阅 / 管理接口 / KV / 更新检测的任何代码', () => {
  const code = readFileSync(new URL('../Hopline-proxy.js', import.meta.url), 'utf8');
  for (const needle of ['hopline_auth', '/api/', 'CONFIG_KV', 'loginHTML', 'generateSubscription', 'raw.githubusercontent.com', 'clash-template', 'PBKDF2', 'ADMIN']) {
    assert.ok(!code.includes(needle), needle);
  }
});

// ---------------- 只读状态入口 NodeStatus（服务绑定） ----------------
import { PROXY_VERSION } from './helpers-version.mjs';

test('NodeStatus.status()：在线与否、版本、配置问题与非敏感的设置摘要；不返回 UUID / 路径 / 反代地址 / 出站代理的主机与密码', async () => {
  assert.equal(typeof proxyModule.NodeStatus, 'function');
  const env = baseEnv({ PATH: 'secret-node-path', EDGEIP: 'alt.private.example:8443', HOP_ADDR: 'socks5://alice:hunter2@10.9.8.7:1080', HOP_MODE: 'only', ALT_MODE: 'custom', ALT_CUSTOM: 'a.example\nb.example' });
  const st = await new proxyModule.NodeStatus({}, env).status();
  assert.equal(st.ok, true);
  assert.equal(st.version, PROXY_VERSION);
  assert.deepEqual(st.problems, []);
  assert.deepEqual(st.settings, { edgeIP: true, hopAddr: 'socks5', hopMode: 'only', altMode: 'custom', altRegion: '', altRegion2: '', altCustom: 2 });
  const text = JSON.stringify(st);
  for (const secret of [UUID, 'secret-node-path', 'alt.private.example', 'alice', 'hunter2', '10.9.8.7', 'a.example']) assert.ok(!text.includes(secret), secret);
  // 默认设置
  const d = await new proxyModule.NodeStatus({}, baseEnv()).status();
  assert.deepEqual(d.settings, { edgeIP: false, hopAddr: '', hopMode: '', altMode: 'builtin', altRegion: '', altRegion2: '', altCustom: 0 });
  // 配置有问题时仍在线，但 ok 为 false 并列出原因
  const bad = await new proxyModule.NodeStatus({}, {}).status();
  assert.equal(bad.ok, false);
  assert.equal(bad.version, PROXY_VERSION);
  assert.equal(bad.problems.length, 2);
});

test('状态只能通过服务绑定读取：没有任何 HTTP 路由能拿到版本或状态，公开响应里没有版本号', async () => {
  const env = baseEnv({ PATH: 'mynode' });
  for (const path of ['/', '/status', '/version', '/NodeStatus', '/mynode', '/mynode/status', '/mynode/version', '/api/status']) {
    for (const init of [{}, { method: 'POST', body: 'x' }, { headers: { 'User-Agent': 'Mozilla/5.0' } }]) {
      if (path === '/mynode' && init.method === 'POST') continue;   // 节点路径上的 POST 是 XHTTP 入口，不是伪装页
      const res = await worker.fetch(new Request('https://node.example.com' + path, init), env, {});
      const body = await res.text();
      assert.equal(res.status, 200, path);
      assert.match(body, /Hello World/, path);
      assert.ok(!body.includes(PROXY_VERSION), path);
    }
  }
  assert.deepEqual(Object.keys(proxyModule).sort(), ['NodeControl', 'NodeStatus', 'default'], '模块只导出默认入口与两个 RPC 入口');
});

test('混淆版代理脚本保留入口名 NodeStatus / NodeControl（服务绑定按名字找入口），在线设置同样可用', async () => {
  const obf = await import('../obf_Hopline-proxy.js?obf-test');
  assert.deepEqual(Object.keys(obf).sort(), ['NodeControl', 'NodeStatus', 'default']);
  const kv = memKv();
  const st = await new obf.NodeControl({}, baseEnv({ NODE_KV: kv })).status();
  assert.equal(st.ok, true);
  assert.equal(st.version, PROXY_VERSION);
  assert.equal(st.control, true);
  assert.equal((await new obf.NodeControl({}, baseEnv({ NODE_KV: kv })).setSettings({ hopMode: 'no' })).ok, true);
  assert.deepEqual(JSON.parse(kv.m.get('settings')), { hopMode: 'no' });
});

// ---------------- 在线修改设置：NodeControl + 代理自己的 KV（NODE_KV） ----------------
function memKv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const kv = { m, gets: 0, puts: 0, down: false,
    async get(k) { kv.gets++; if (kv.down) throw new Error('KV unavailable'); return m.has(k) ? m.get(k) : null; },
    async put(k, v) { kv.puts++; if (kv.down) throw new Error('KV unavailable'); m.set(k, v); },
    async delete(k) { m.delete(k); } };
  return kv;
}
const control = (env) => new proxyModule.NodeControl({}, env);
const storedOf = (kv) => JSON.parse(kv.m.get('settings'));

test('NodeControl 没有 KV 时：getSettings 只读（storage:false，显示环境变量的值），setSettings / resetSettings 明确拒绝', async () => {
  const env = baseEnv({ EDGEIP: 'env-alt.example:8443', ALT_MODE: 'off' });
  const g = await control(env).getSettings();
  assert.equal(g.ok, true); assert.equal(g.storage, false);
  assert.equal(g.settings.edgeIP, 'env-alt.example:8443'); assert.equal(g.settings['alt.mode'], 'off');
  assert.deepEqual(g.source, { edgeIP: 'env', hopAddr: 'default', hopMode: 'default', 'alt.mode': 'env', 'alt.region': 'default', 'alt.region2': 'default', 'alt.custom': 'default' });
  assert.ok(g.regions.includes('HK') && g.regions.includes('Multacom'));
  const s = await control(env).setSettings({ edgeIP: 'x.example' });
  assert.equal(s.ok, false); assert.match(s.error, /NODE_KV/);
  assert.equal((await control(env).resetSettings()).ok, false);
});

test('NodeControl.setSettings：校验后保存到 KV，生效值 = KV > 环境变量 > 默认；与环境变量相同的值不落盘；只读入口 NodeStatus 没有这些方法', async () => {
  const kv = memKv();
  const env = baseEnv({ NODE_KV: kv, EDGEIP: 'env-alt.example', HOP_ADDR: 'socks5://u:p@1.2.3.4:1080' });
  const r = await control(env).setSettings({
    edgeIP: ' mine.example:8443 ', hopAddr: 'socks5://u:p@1.2.3.4:1080', hopMode: 'only',
    'alt.mode': 'custom', 'alt.custom': 'A.Example.com, [2001:db8::1]:8443\nb.example.com:443', bogus: 'x',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ignored, ['bogus']);
  assert.deepEqual(storedOf(kv), { edgeIP: 'mine.example:8443', hopMode: 'only', 'alt.mode': 'custom', 'alt.custom': 'a.example.com\n[2001:db8::1]:8443\nb.example.com' }, '与环境变量相同的出站代理没有落盘');
  assert.equal(r.settings.hopAddr, 'socks5://u:p@1.2.3.4:1080');
  assert.equal(r.storage, true);
  assert.equal(r.source.edgeIP, 'kv'); assert.equal(r.source.hopAddr, 'env'); assert.equal(r.source['alt.region'], 'default');
  // 之后环境变量变化立即生效（KV 里没有它的快照）
  const later = baseEnv({ NODE_KV: kv, EDGEIP: 'env-alt.example', HOP_ADDR: 'socks5://u:p@9.9.9.9:1080' });
  assert.equal((await control(later).getSettings()).settings.hopAddr, 'socks5://u:p@9.9.9.9:1080');
  // 改回与环境变量相同：该项从 KV 里移除
  const back = await control(env).setSettings({ edgeIP: 'env-alt.example' });
  assert.equal(back.ok, true);
  assert.equal('edgeIP' in storedOf(kv), false);
  assert.equal(back.source.edgeIP, 'env');
  // 只读入口没有写方法，也没有 getSettings
  const ro = new proxyModule.NodeStatus({}, env);
  for (const m of ['getSettings', 'setSettings', 'resetSettings']) assert.equal(ro[m], undefined, m);
});

test('NodeControl.setSettings 校验：每项给出字段级错误，整批都不保存；自定义模式必须有反代列表；UUID / PATH 改不了', async () => {
  const kv = memKv();
  const env = baseEnv({ NODE_KV: kv });
  const bad = [
    [{ edgeIP: 'bad host' }, 'edgeIP'], [{ edgeIP: 'a/b' }, 'edgeIP'], [{ edgeIP: 'x.example:99999' }, 'edgeIP'],
    [{ hopAddr: 'ss://rc4:pw@1.2.3.4:8388' }, 'hopAddr'], [{ hopAddr: 'ss://aes-256-gcm@1.2.3.4:8388' }, 'hopAddr'],
    [{ hopAddr: 'socks5://has space@1.2.3.4:1' }, 'hopAddr'], [{ hopMode: 'sideways' }, 'hopMode'],
    [{ 'alt.mode': 'sideways' }, 'alt.mode'], [{ 'alt.region': 'Atlantis' }, 'alt.region'], [{ 'alt.region2': 'Atlantis' }, 'alt.region2'],
    [{ 'alt.custom': 'a.example.com\nb.example.com\nc.example.com\nd.example.com' }, 'alt.custom'], [{ 'alt.custom': 'bad host' }, 'alt.custom'],
    [{ 'alt.custom': 'x.example.com:70000' }, 'alt.custom'], [{ 'alt.mode': 'custom' }, 'alt.custom'], [{ edgeIP: 123 }, 'edgeIP'],
  ];
  for (const [patch, field] of bad) {
    const r = await control(env).setSettings(patch);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.errors.some(e => e.field === field), JSON.stringify(patch) + ' → ' + JSON.stringify(r.errors));
  }
  // 一批里有一项出错：其它合法项也不保存
  const mixed = await control(env).setSettings({ hopMode: 'no', edgeIP: 'bad host' });
  assert.equal(mixed.ok, false);
  assert.equal(kv.puts, 0, '校验失败不写 KV');
  assert.equal((await control(env).setSettings(null)).ok, false);
  // UUID / PATH 不是可修改的设置：被报告为忽略，不会写入
  const id = await control(env).setSettings({ UUID: 'x', PATH: 'y', uuid: 'z', path: 'w', hopMode: 'no' });
  assert.equal(id.ok, true);
  assert.deepEqual(id.ignored.sort(), ['PATH', 'UUID', 'path', 'uuid']);
  assert.deepEqual(storedOf(kv), { hopMode: 'no' });
  assert.ok(!kv.m.get('settings').includes(UUID));
});

test('NodeControl：KV 损坏时忽略并允许保存来修复；KV 读取失败时拒绝保存、不覆盖已有设置；resetSettings 清除覆盖项', async () => {
  const kv = memKv({ settings: '{not json' });
  const env = baseEnv({ NODE_KV: kv, ALT_MODE: 'off' });
  const g = await control(env).getSettings();
  assert.equal(g.error, 'corrupt'); assert.equal(g.settings['alt.mode'], 'off', '损坏的设置被忽略，用环境变量');
  assert.equal((await control(env).setSettings({ hopMode: 'no' })).ok, true, '损坏时允许保存（修复）');
  assert.deepEqual(storedOf(kv), { hopMode: 'no' });
  // 无效项在读取时被丢弃，其它项保留
  const kv2 = memKv({ settings: { hopMode: 'sideways', edgeIP: 'ok.example', bogus: 1 } });
  const g2 = await control(baseEnv({ NODE_KV: kv2 })).getSettings();
  assert.equal(g2.settings.edgeIP, 'ok.example'); assert.equal(g2.settings.hopMode, '');
  // 读取失败：拒绝保存
  const kv3 = memKv({ settings: { edgeIP: 'keep.example' } });
  kv3.down = true;
  const env3 = baseEnv({ NODE_KV: kv3 });
  const refused = await control(env3).setSettings({ edgeIP: 'new.example' });
  assert.equal(refused.ok, false); assert.match(refused.error, /KV 暂时无法读取/);
  assert.equal(kv3.puts, 0);
  kv3.down = false;
  // reset
  const kv4 = memKv({ settings: { edgeIP: 'x.example' } });
  const env4 = baseEnv({ NODE_KV: kv4, EDGEIP: 'env.example' });
  const rs = await control(env4).resetSettings();
  assert.equal(rs.ok, true); assert.equal(rs.settings.edgeIP, 'env.example'); assert.equal(kv4.m.has('settings'), false);
  assert.equal((await control(env4).getSettings()).settings.edgeIP, 'env.example');
});

test('status()：control 标志、是否有 KV、摘要反映 KV 里的在线设置；仍不返回任何密钥', async () => {
  const kv = memKv({ settings: { 'alt.mode': 'off', hopAddr: 'http://carol:s3cret@10.1.1.1:8080', hopMode: 'only' } });
  const env = baseEnv({ NODE_KV: kv });
  const full = await control(env).status();
  assert.equal(full.control, true); assert.equal(full.storage, true);
  assert.deepEqual(full.settings, { edgeIP: false, hopAddr: 'http', hopMode: 'only', altMode: 'off', altRegion: '', altRegion2: '', altCustom: 0 });
  assert.ok(!JSON.stringify(full).includes('s3cret') && !JSON.stringify(full).includes('10.1.1.1'));
  const ro = await new proxyModule.NodeStatus({}, baseEnv()).status();
  assert.equal(ro.control, false); assert.equal(ro.storage, false);
});

test('在线设置真正生效：节点路径上的连接按 KV 里的设置出站；KV 读取有缓存、伪装页请求不读 KV；KV 故障时沿用上次的设置', async () => {
  const kv = memKv({ settings: { 'alt.mode': 'off' } });
  const env = baseEnv({ NODE_KV: kv });
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    // 伪装页 / 其它路径：不读 KV
    for (const path of ['/', '/other', '/login']) await worker.fetch(new Request('https://node.example.com' + path), env, {});
    assert.equal(kv.gets, 0, '没有节点路径上的连接就不读 KV');
    // relay off：直连失败后不尝试任何反代
    let log = fakeNet({});
    const dns = [];
    await withFetch(cfDoh({}, dns), async () => {
      for (let i = 0; i < 3; i++) {
        const ws = await openWs(env);
        await ws.emit('message', { data: vlessReq('kv-off.example', 443, TLS_HELLO).buffer });
        assert.equal(ws.closed.code, 1011);
      }
    });
    assert.equal(dns.filter(d => d.name.startsWith('proxyip.')).length, 0, 'KV 里的 alt.mode=off 生效：没有解析内置反代');
    assert.equal(kv.gets, 1, '3 个连接只读了一次 KV（isolate 内存缓存）');
    // 改成自定义反代，缓存过期后新设置生效
    kv.m.set('settings', JSON.stringify({ 'alt.mode': 'custom', 'alt.custom': 'kv-alt.example.com' }));
    t += 25 * 1000;
    log = fakeNet({ 'kv-cf.example': { delay: 'hang' }, '203.0.113.77': { delay: 10 } });
    await withFetch(cfDoh({ 'kv-alt.example.com': ['203.0.113.77'] }, []), async () => {
      const ws = await openWs(env);
      await ws.emit('message', { data: vlessReq('kv-cf.example', 443, TLS_HELLO).buffer });
      await until(() => log.some(s => s.written.length));
    });
    assert.equal(log.find(s => s.written.length).hostname, '203.0.113.77', '缓存过期后读到新设置');
    assert.equal(kv.gets, 2);
    // KV 故障：沿用上次读到的设置，连接不受影响
    kv.down = true;
    t += 25 * 1000;
    log = fakeNet({ 'kv-cf.example': { delay: 'hang' }, '203.0.113.77': { delay: 10 } });
    await withFetch(cfDoh({ 'kv-alt.example.com': ['203.0.113.77'] }, []), async () => {
      const ws = await openWs(env);
      await ws.emit('message', { data: vlessReq('kv-cf.example', 443, TLS_HELLO).buffer });
      await until(() => log.some(s => s.written.length));
    });
    assert.equal(log.find(s => s.written.length).hostname, '203.0.113.77', 'KV 读取失败时沿用上次的设置');
  } finally { Date.now = realNow; }
  // 通过 NodeControl 保存后，同一 isolate 立即生效（不等缓存过期）
  const kv2 = memKv();
  const env2 = baseEnv({ NODE_KV: kv2 });
  fakeNet({});
  const dns2 = [];
  await withFetch(cfDoh({}, dns2), async () => {
    const before = await openWs(env2);
    await before.emit('message', { data: vlessReq('save-live.example', 443, TLS_HELLO).buffer });
    await control(env2).setSettings({ 'alt.mode': 'off' });
    dns2.length = 0;
    const after = await openWs(env2);
    await after.emit('message', { data: vlessReq('save-live.example', 443, TLS_HELLO).buffer });
  });
  assert.equal(dns2.filter(d => d.name.startsWith('proxyip.')).length, 0, '保存后新连接不再用内置反代');
});
