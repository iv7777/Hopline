
// 代理测试（node:test，无第三方依赖）：直接加载构建产物 Hopline-proxy.js，
// 桩替换 cloudflare:sockets、WebSocketPair 与外网 fetch。运行：npm test
import { test } from 'node:test';

import assert from 'node:assert/strict';

import { register } from 'node:module';

// cloudflare:sockets 仅存在于 Workers 运行时：测试中替换为桩
const hooks = `

export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:sockets') {
    // 默认不可用；出站测试通过 globalThis.__connect 注入可控的假连接
    return { url: 'data:text/javascript,export function connect(a, b){ if (globalThis.__connect) return globalThis.__connect(a, b); throw new Error("sockets unavailable in tests"); }', shortCircuit: true };
  }
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

// 外网一律离线（DoH 等由各用例用 withFetch 注入）
globalThis.fetch = async () => { throw new Error('offline in tests'); };

const proxyModule = await import('../Hopline-proxy.js');
const worker = proxyModule.default;

const UUID = '11111111-2222-4333-8444-555555555555';
const KEY = 'test-node-key-0123456789-abcdef';
// 代理的环境变量只有 PATH 与 NODE_KEY；UUID 由面板下发、保存在 NODE_KV 的 state 里（这里直接预置）；路径取 UUID 的值，使 /<UUID> 即节点入口
// 状态（UUID、启用、落地 / 出站 / 备用线路）整份来自面板：测试里默认是「一个 UUID + 内置地区线路表，但没有选用任何备用线路」；要用备用线路的测试用 altEnv（顺序 US,HK，固定，不受机房影响），用 set 覆盖其中的项
const REGION_TABLE = Object.fromEntries(['HK', 'US', 'SG', 'JP', 'KR', 'DE', 'SE', 'NL', 'FI', 'GB'].map(r => [r, { host: `proxyip.${r.toLowerCase()}.cmliussss.net` }]));
const stateWith = (set = {}) => ({ uuids: [[UUID, 0]], enabled: true, edgeIP: '', hop: null, hopMode: '', altTable: REGION_TABLE, altPick: [], ...set });
const baseEnv = (extra = {}) => { const { set, ...rest } = extra; return { PATH: UUID, NODE_KEY: KEY, NODE_KV: memKv({ state: stateWith(set) }), ...rest }; };
// 有备用线路的环境（先 US 再 HK）；默认的 baseEnv 没有备用线路，目标永远不回数据的假连接就不会触发首包看门狗（看门狗只在有备用线路时生效）
const altEnv = (extra = {}) => baseEnv({ ...extra, set: { altPick: ['US', 'HK'], ...(extra.set || {}) } });
const quietEnv = baseEnv;

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
  globalThis.__connect = ({ hostname, port }, opts) => {
    const b = net[hostname] || { delay: 'fail' };
    const sock = { hostname, port, opts, written: [], closedByUs: false };
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
    const ws = await openWs(altEnv());
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
    let ws = await openWs(altEnv());
    let t0 = Date.now();
    await ws.emit('message', { data: vlessReq('cf-learn.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.ok(Date.now() - t0 < 500, '直连立即失败：反代马上接管，不等窗口');
    assert.equal(log.filter(s => s.hostname === 'cf-learn.example').length, 1);
    log.length = 0;
    ws = await openWs(altEnv());
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
    let ws = await openWs(altEnv());
    await ws.emit('message', { data: vlessReq('slowok.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    await until(() => log.find(s => s.hostname === 'slowok.example').closedByUs);   // 直连随后连通，被回收
    log.length = 0;
    ws = await openWs(altEnv());
    await ws.emit('message', { data: vlessReq('slowok.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.filter(s => s.hostname === 'slowok.example').length, 1, '未被记录：仍然尝试直连');
    // 已记录的站点：反代全部失败 → 回落直连，记录删除
    log = fakeNet({ 'flip.example': { delay: 'fail' }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
    ws = await openWs(altEnv());
    await ws.emit('message', { data: vlessReq('flip.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));   // 记录 flip.example
    log = fakeNet({ 'flip.example': { delay: 5 }, '203.0.113.10': { delay: 'fail' }, '203.0.113.20': { delay: 'fail' } });
    ws = await openWs(altEnv());
    await ws.emit('message', { data: vlessReq('flip.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, 'flip.example', '反代不通：回落直连');
    log = fakeNet({ 'flip.example': { delay: 5 }, '203.0.113.10': { delay: 'fail' }, '203.0.113.20': { delay: 'fail' } });
    ws = await openWs(altEnv());
    await ws.emit('message', { data: vlessReq('flip.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log[0].hostname, 'flip.example', '记录已删除：直连优先');
  });
});

test('目标为 Cloudflare IP：不发注定失败的直连，直接走反代；反代不通时才回落直连', async () => {
  const req = new Uint8Array([0, ...uuidBytes, 0, 1, 1, 187, 1, 104, 16, 0, 5, ...TLS_HELLO]);   // 104.16.0.5:443
  let log = fakeNet({ '104.16.0.5': { delay: 5 }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    let ws = await openWs(altEnv());
    await ws.emit('message', { data: req.buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, '203.0.113.10');
    assert.equal(log.filter(s => s.hostname === '104.16.0.5').length, 0, '没有直连尝试');
    log = fakeNet({ '104.16.0.5': { delay: 5 }, '203.0.113.10': { delay: 'fail' }, '203.0.113.20': { delay: 'fail' } });
    ws = await openWs(altEnv());
    await ws.emit('message', { data: req.buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, '104.16.0.5', '反代不通：回落直连');
  });
});

test('备用线路默认只查 A 记录；线路表里标了 txt 的才先查 TXT', async () => {
  fakeNet({ '198.51.100.31': { delay: 5 }, '198.51.100.32': { delay: 5 }, 'tx.example': { delay: 'fail' } });
  const dns = [];
  const stub = dohStub({ 'cloudflare-dns.com': { answers: {
    'proxyip.jp.cmliussss.net|A': ['198.51.100.31'], 'proxyip.sg.cmliussss.net|A': ['198.51.100.32'], 'my-alt.example.net|A': ['198.51.100.31'] } } }, dns);
  await withFetch(stub, () => connectVia(altEnv({ set: { altPick: ['JP', 'SG'] } }), 'tx.example'));
  await until(() => dns.filter(d => /cmliussss/.test(d.name)).length >= 2);
  assert.deepEqual(dns.filter(d => /cmliussss/.test(d.name)).map(d => d.type), ['A', 'A']);
  await withFetch(stub, () => connectVia(altEnv({ set: { altTable: { 'my-alt': { host: 'my-alt.example.net', txt: true } }, altPick: ['my-alt'] } }), 'tx.example'));
  await until(() => dns.filter(d => d.name === 'my-alt.example.net').length >= 2);
  assert.deepEqual(dns.filter(d => d.name === 'my-alt.example.net').map(d => d.type).sort(), ['A', 'TXT']);
});

test('出站竞速：直连在优先窗口内成功时使用直连，已建立的反代连接被关闭', async () => {
  const log = fakeNet({ 'direct.example': { delay: 120 }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(altEnv());
    await ws.emit('message', { data: vlessReq('direct.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, 'direct.example');
    await until(() => log.filter(s => s.hostname.startsWith('203.')).every(s => s.closedByUs));
  });
});

test('出站竞速：直连较慢（600ms）但能通时仍用直连，不被反代抢走；直连失败则立即换反代', async () => {
  const log = fakeNet({ 'slow.example': { delay: 600 }, '203.0.113.10': { delay: 10 }, '203.0.113.20': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(altEnv());
    await ws.emit('message', { data: vlessReq('slow.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log.find(s => s.written.length).hostname, 'slow.example', '慢直连不应被反代取代');
  });
});

test('WS 下行：已到达的小块合并成一条消息（最多 64KB），字节顺序完整；之后到达的数据单独发出；目标结束后关闭 WS', async () => {
  const log = fakeNet({ 'batch.example': { delay: 5 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(altEnv());
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
    const ws = await openWs(altEnv());
    await ws.emit('message', { data: vlessReq('tg.example', 443, [0xef, 0xef, 0xef, 0xef]).buffer });
    await until(() => log.some(s => s.written.length));
    assert.deepEqual(log.map(s => s.hostname), ['tg.example']);
  });
});

test('VLESS 响应头在头部解析后立即下发；头部与首包分帧到达时等待首包判定（不超过 80ms）', async () => {
  const log = fakeNet({ 'split.example': { delay: 10 } });
  await withFetch(relayDoh, async () => {
    const ws = await openWs(altEnv());
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
    const ws = await openWs(quietEnv(), { 'Sec-WebSocket-Protocol': b64url(vlessReq('early.example', 443, TLS_HELLO)) });
    await until(() => log.some(s => s.written.length));
    assert.deepEqual([...log[0].written[0]], TLS_HELLO, '未收到任何 WS 数据帧即已转发首包');
    assert.deepEqual(ws.sent.map(x => [...x]), [[0, 0]]);
    await ws.emit('message', { data: new Uint8Array([9, 9]).buffer });   // 后续数据帧直接写出站
    await until(() => log[0].written.length === 2);
    // 普通子协议名 / 其它 UUID 的早数据：不建连，等待数据帧
    const other = vlessReq('early.example', 443, TLS_HELLO); other[1] ^= 0xff;
    for (const proto of ['binary', b64url(other)]) {
      const n = log.length;
      const w2 = await openWs(quietEnv(), { 'Sec-WebSocket-Protocol': proto });
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

test('出站代理：S5 带用户名密码认证、对 IPv6 目标使用 ATYP=4；HTTP CONNECT 给 IPv6 加方括号', async () => {
  const feed = async (sock, bytes) => { await until(() => sock.push); sock.push(new Uint8Array(bytes)); };
  // SOCKS5：用户名 us、密码 p@ss（面板已把地址解析好，代理收到的是结构化的数据）
  let log = fakeNet({ '10.0.0.1': { delay: 5 } });
  let env = baseEnv({ set: { hop: { type: 'socks5', host: '10.0.0.1', port: 1080, user: 'us', pass: 'p@ss' }, hopMode: 'only' } });
  let ws = await openWs(env);
  ws.emit('message', { data: vlessReqV6(443).buffer });   // 握手需要下面喂数据才会完成：不能 await
  await until(() => log.length && log[0].written.length);
  assert.equal(log[0].hostname, '10.0.0.1');
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
  env = baseEnv({ set: { hop: { type: 'http', host: '10.0.0.2', port: 8080 }, hopMode: 'only' } });
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
    const ws = await openWs(altEnv());
    await ws.emit('message', { data: full.slice(0, cut).buffer });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(log.length, 0);
    assert.equal(ws.closed, null);
    await ws.emit('message', { data: full.slice(cut).buffer });
    await until(() => log.some(s => s.written.length));
    assert.equal(log[0].hostname, 'split.example');
    // VLESS MUX（cmd=3）
    const mux = vlessReq('x.example', 443, TLS_HELLO); mux[1 + 16 + 1] = 3;
    const w2 = await openWs(altEnv());
    await w2.emit('message', { data: mux.buffer });
    assert.equal(w2.closed.code, 1011);
    assert.match(w2.closed.reason, /不支持的命令/);
    // Trojan 已移除：即使客户端发来密码哈希正确的 Trojan 握手也只会被当作无效的 VLESS 头而拒绝，不建立任何出站连接
    const hex = createHash('sha224').update(UUID).digest('hex');
    const trojan = new Uint8Array([...Buffer.from(hex + '\r\n'), 1, 3, 9, ...Buffer.from('x.example'), 1, 187, 13, 10, ...TLS_HELLO]);
    const n = log.length;
    const w3 = await openWs(altEnv());
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
  const env = quietEnv();
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
  const env = altEnv({ set: { edgeIP: 'dedupe.example.com' } });
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
  let env = altEnv({ set: { edgeIP: 'fallback.example.com' } });
  await withFetch(dohStub({ 'dns.alidns.com': { answers: { 'fallback.example.com|A': ['198.51.100.6'] } } }, dns), () => connectVia(env, 't.example'));
  let hosts = dns.filter(d => d.name === 'fallback.example.com').map(d => d.host);
  assert.deepEqual([...new Set(hosts)].sort(), ['cloudflare-dns.com', 'dns.alidns.com']);
  assert.ok(!hosts.includes('doh.pub'));
  // 全部失败：第一次尝试所有端点，第二次连接直接用缓存的「无结果」
  dns = [];
  env = altEnv({ set: { edgeIP: 'neg.example.com' } });
  await withFetch(dohStub({}, dns), () => connectVia(env, 't.example'));
  const first = dns.filter(d => d.name === 'neg.example.com').length;
  assert.ok(first >= 6, `第一次查询了所有端点（${first}）`);
  dns.length = 0;
  await withFetch(dohStub({}, dns), () => connectVia(env, 't.example'));
  assert.equal(dns.filter(d => d.name === 'neg.example.com').length, 0, '30 秒内不再重复查询');
});

// UDP-DNS 的数据报与分帧：Xray / sing-box 的 VLESS UDP 每个数据报前加 2 字节长度（Xray encoding/addons.go 的 MultiLengthPacketWriter，
// sing-vmess vless/client.go 的 PacketConn）；收的一方先读 2 字节 VLESS 响应头，再逐个读「2 字节长度 + 应答」
const dnsQuery = (id, name) => [id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...name.split('.').flatMap(l => [l.length, ...Buffer.from(l)]), 0, 0, 1, 0, 1];
const framed = (...pkts) => pkts.flatMap(p => [p.length >> 8, p.length & 255, ...p]);
// VLESS UDP 请求头（command=0x02，目标为 IPv4）+ 数据
const udpReq = (ip, port, payload = []) => new Uint8Array([0, ...uuidBytes, 0, 2, port >> 8, port & 255, 1, ...ip.split('.').map(Number), ...payload]);
// 把发给客户端的全部字节按 VLESS UDP 的格式拆开：[0,0] 响应头 + 若干「2 字节长度 + 应答」；返回 { header, packets }
const unframe = (sent) => {
  const all = Buffer.concat(sent.map(m => Buffer.from(m)));
  const packets = [];
  for (let o = 2; o + 2 <= all.length;) { const n = all.readUInt16BE(o); packets.push(all.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  return { header: [...all.subarray(0, 2)], packets };
};

test('UDP DNS（VLESS UDP 53）：按 Xray / sing-box 的分帧收发——先回 [0,0] 响应头，每个应答前加 2 字节长度；同一连接上的多个查询（含跨帧、半个数据报）都应答，连接保持', async () => {
  const ans = { 'example.com|A': ['93.184.216.34'], 'example.org|A': ['93.184.216.35'], 'example.net|A': ['93.184.216.36'] };
  await withFetch(dohStub({ 'cloudflare-dns.com': { answers: ans } }), async () => {
    const ws = await openWs(baseEnv());
    const second = framed(dnsQuery(0x2222, 'example.org'));
    // 首帧：请求头 + 一个完整查询 + 第二个查询的前 5 个字节；第二帧：第二个查询的其余部分 + 第三个查询
    await ws.emit('message', { data: udpReq('8.8.8.8', 53, [...framed(dnsQuery(0x1111, 'example.com')), ...second.slice(0, 5)]).buffer });
    await ws.emit('message', { data: new Uint8Array([...second.slice(5), ...framed(dnsQuery(0x3333, 'example.net'))]).buffer });
    await until(() => unframe(ws.sent).packets.length === 3);
    const { header, packets } = unframe(ws.sent);
    assert.deepEqual(header, [0, 0], '先回 VLESS 响应头');
    const byId = Object.fromEntries(packets.map(p => [p.readUInt16BE(0), [...p.subarray(-4)]]));
    assert.deepEqual(byId, { 0x1111: [93, 184, 216, 34], 0x2222: [93, 184, 216, 35], 0x3333: [93, 184, 216, 36] });
    assert.equal(ws.closed, null, '连接保持，直到客户端关闭');
    await ws.emit('close', {});
    assert.ok(ws.closed);
  });
});

test('UDP DNS：一条连接最多应答 20 个查询（每个查询至少占 1 个子请求，免费版每个请求只有 50 个），应答完后关闭连接，客户端会新开一条', async () => {
  const ans = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`q${i}.example.com|A`, ['93.184.216.' + i]]));
  await withFetch(dohStub({ 'cloudflare-dns.com': { answers: ans } }), async () => {
    const ws = await openWs(baseEnv());
    const pkts = Array.from({ length: 25 }, (_, i) => dnsQuery(i, `q${i}.example.com`));
    await ws.emit('message', { data: udpReq('8.8.8.8', 53, framed(...pkts.slice(0, 5))).buffer });
    await until(() => unframe(ws.sent).packets.length === 5);
    assert.equal(ws.closed, null, '不到 20 个时连接保持');
    await ws.emit('message', { data: new Uint8Array(framed(...pkts.slice(5))).buffer });
    await until(() => ws.closed);
    const { packets } = unframe(ws.sent);
    assert.equal(packets.length, 20);
    assert.deepEqual(packets.map(p => p.readUInt16BE(0)).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
    assert.equal(ws.closed.code, 1000);
  });
});

test('UDP DNS：Cloudflare 优先，失败才换 Google（JSON 接口是 /resolve）；不再使用境内解析器；非 53 端口的 UDP 直接关闭', async () => {
  const ans = { 'example.com|A': ['93.184.216.34'] };
  const run = async (table) => {
    const dns = [];
    await withFetch(dohStub(table, dns), async () => {
      const ws = await openWs(baseEnv());
      await ws.emit('message', { data: udpReq('8.8.8.8', 53, framed(dnsQuery(0x1234, 'example.com'))).buffer });
      await new Promise(r => setTimeout(r, 1600));   // 等所有端点都试过（含 0.7 秒的提前并发）
      const { packets } = unframe(ws.sent);
      if (table['cloudflare-dns.com'] || table['dns.google']) assert.equal(packets.length, 1, '有应答');
      else assert.equal(packets.length, 0, '全部失败时不应答');
    });
    return [...new Set(dns.map(d => d.host))];
  };
  assert.deepEqual(await run({ 'cloudflare-dns.com': { answers: ans } }), ['cloudflare-dns.com']);
  assert.deepEqual(await run({ 'dns.google': { answers: ans } }), ['cloudflare-dns.com', 'dns.google']);
  assert.deepEqual(await run({}), ['cloudflare-dns.com', 'dns.google'], '只有这两个端点');
  // 实际请求的地址：Cloudflare 是 /dns-query，Google 是 /resolve
  const calls = [];
  await withFetch(async (url) => {
    calls.push(url);
    if (url.includes('cloudflare-dns.com')) return new Response('x', { status: 500 });
    return new Response(JSON.stringify({ Status: 0, Answer: ans['example.com|A'].map(data => ({ type: 1, data })) }));
  }, async () => {
    const ws = await openWs(baseEnv());
    await ws.emit('message', { data: udpReq('8.8.8.8', 53, framed(dnsQuery(1, 'example.com'))).buffer });
    await until(() => unframe(ws.sent).packets.length === 1);
  });
  assert.deepEqual(calls, ['https://cloudflare-dns.com/dns-query?name=example.com&type=1', 'https://dns.google/resolve?name=example.com&type=1']);
  // 非 53 端口：没有 UDP socket，直接关闭，也不回响应头
  const ws = await openWs(baseEnv());
  await ws.emit('message', { data: udpReq('1.1.1.1', 443, [0, 3, 1, 2, 3]).buffer });
  assert.equal(ws.closed.code, 1000);
  assert.equal(ws.sent.length, 0);
});

// ---------------- 纯函数已知答案 / 协议头模糊测试 ----------------
import { createHmac, hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { assemble } from '../build.mjs';

// 内部函数不对外导出；改用合并源码（assemble），
// 去掉 import / export default 后在函数作用域内求值，取出要测的纯函数
const internals = (() => {
  const src = assemble('proxy')
    .replace(/^import .*$/gm, '').replace('export default {', 'const __default = {').replace(/^export class /gm, 'class ');
  return new Function('connect', src + '\n;return { parseVssProtoHeader, isValidIp, altPlan, selectAltRegion, COLO_REGIONS, nodeConfig, checkState, pumpReadable, routeTag, shortHash };')(() => { throw new Error('no sockets'); });
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

test('协议头解析：任意截断只会报「头部过短」；乱码只会抛普通 Error（不出现 RangeError / TypeError）', () => {
  const cfg = { uuids: [UUID] };
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

// ---------------- 可配置：优选域名 / 内置地区反代 ----------------
const cfDoh = (map, log = []) => async (url) => {   // 简易 DoH：map[域名] = [A 记录]，其余无记录
  const u = new URL(url); const name = u.searchParams.get('name'), type = { 1: 'A', 28: 'AAAA' }[u.searchParams.get('type')] || u.searchParams.get('type');
  log.push({ name, type });
  const ips = type === 'A' ? (map[name] || []) : [];
  return new Response(JSON.stringify({ Status: 0, Answer: ips.map(data => ({ type: 1, data })) }));
};

test('备用线路计划：auto = 按机房选最近的地区、再依次补它相邻的地区；按 altPick 的顺序取前 3 个不重复的线路，第一条取 2 个 IP，其余各 1 个；表里没有的标签跳过；altPick 为空 = 不使用', () => {
  const plan = (st, colo) => internals.altPlan(st, colo).map(p => `${p.host}:${p.port}x${p.take}`);
  const R = (r) => REGION_TABLE[r].host;
  const def = { altTable: REGION_TABLE, altPick: ['auto'] };
  assert.deepEqual(plan(def, 'NRT'), [`${R('JP')}:443x2`, `${R('SG')}:443x1`, `${R('KR')}:443x1`], '日本机房：JP + 相邻的 SG、KR');
  assert.deepEqual(plan(def, 'HKG'), [`${R('HK')}:443x2`, `${R('SG')}:443x1`, `${R('JP')}:443x1`]);
  assert.deepEqual(plan(def, 'FRA'), [`${R('DE')}:443x2`, `${R('NL')}:443x1`, `${R('GB')}:443x1`], '欧洲机房补欧洲的相邻地区，不会补到香港 / 美国');
  assert.deepEqual(plan(def, 'LAX'), [`${R('US')}:443x2`, `${R('SG')}:443x1`, `${R('JP')}:443x1`], '表里没有的机房一律按 US');
  assert.deepEqual(plan(def, undefined), [`${R('US')}:443x2`, `${R('SG')}:443x1`, `${R('JP')}:443x1`]);
  assert.deepEqual(plan({ ...def, altPick: ['auto', 'HK'] }, 'NRT'), [`${R('JP')}:443x2`, `${R('SG')}:443x1`, `${R('KR')}:443x1`], '最多 3 条');
  assert.deepEqual(plan({ ...def, altPick: ['HK', 'auto'] }, 'NRT'), [`${R('HK')}:443x2`, `${R('JP')}:443x1`, `${R('SG')}:443x1`], '固定的排前面，auto 的补在后面，重复的跳过');
  assert.deepEqual(plan({ altTable: { JP: { host: 'jp.example.com' }, KR: { host: 'kr.example.com' } }, altPick: ['auto'] }, 'NRT'), ['jp.example.com:443x2', 'kr.example.com:443x1'], '相邻地区不在表里就跳过');
  assert.deepEqual(plan({ ...def, altPick: ['DE', 'NL'] }, 'NRT'), [`${R('DE')}:443x2`, `${R('NL')}:443x1`], '固定顺序不受机房影响');
  assert.deepEqual(plan({ ...def, altPick: ['DE', 'nope', 'DE', 'SE'] }, 'NRT'), [`${R('DE')}:443x2`, `${R('SE')}:443x1`], '表里没有的标签与重复的线路被跳过');
  const mine = { altTable: { a: { host: 'a.example.com' }, b: { host: 'b.example.com', port: 8443 }, c: { host: '203.0.113.9' }, d: { host: 'd.example.com' }, same: { host: 'a.example.com' } }, altPick: ['a', 'same', 'b', 'c', 'd'] };
  assert.deepEqual(plan(mine, 'NRT'), ['a.example.com:443x2', 'b.example.com:8443x1', '203.0.113.9:443x1'], '最多 3 条，同一条线路不重复');
  assert.deepEqual(plan({ ...def, altPick: [] }, 'NRT'), []);
  assert.deepEqual(plan({ altTable: {}, altPick: ['auto'] }, 'NRT'), [], '线路表是空的：没有备用线路');
  for (const [colo, region] of [['HKG', 'HK'], ['sin', 'SG'], ['NRT', 'JP'], ['KIX', 'JP'], ['ICN', 'KR'], ['FRA', 'DE'], ['CDG', 'DE'], ['ARN', 'SE'], ['AMS', 'NL'], ['HEL', 'FI'], ['LHR', 'GB'], ['LAX', 'US'], ['SJC', 'US'], ['', 'US'], [undefined, 'US']]) {
    assert.equal(internals.selectAltRegion(colo), region, String(colo));
  }
});

test('备用线路：altPick 为空时不解析也不连接任何线路；自定义线路只连自己的；固定地区只解析该地区', async () => {
  // 空：目标直连失败后不尝试任何备用线路，连接被关闭
  let log = fakeNet({});
  let dns = [];
  let env = altEnv({ set: { altPick: [] } });
  await withFetch(cfDoh({}, dns), async () => {
    const ws = await openWs(env);
    await ws.emit('message', { data: vlessReq('off-test.example', 443, TLS_HELLO).buffer });
    assert.equal(ws.closed.code, 1011);
  });
  assert.deepEqual(log.map(s => s.hostname), ['off-test.example'], '只尝试了直连');
  assert.equal(dns.filter(d => d.name.startsWith('proxyip.')).length, 0, '没有解析任何线路域名');
  // 自定义线路：直连挂起（目标在 Cloudflare 上）→ 自己的线路接管，地区线路不被碰
  log = fakeNet({ 'cf-custom.example': { delay: 'hang' }, '203.0.113.31': { delay: 10 }, '203.0.113.30': { delay: 40 } });
  dns = [];
  env = altEnv({ set: { altTable: { mine: { host: 'my-alt.example.com' }, ip: { host: '203.0.113.30', port: 8443 } }, altPick: ['mine', 'ip'] } });
  await withFetch(cfDoh({ 'my-alt.example.com': ['203.0.113.31'] }, dns), async () => {
    const ws = await openWs(env);
    await ws.emit('message', { data: vlessReq('cf-custom.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
  });
  const used = log.find(s => s.written.length);
  assert.equal(used.hostname, '203.0.113.31');
  assert.deepEqual([...used.written[0]], TLS_HELLO);
  assert.equal(log.find(s => s.hostname === '203.0.113.30').port, 8443, 'IP:端口 原样连接');
  assert.equal(dns.filter(d => d.name.startsWith('proxyip.')).length, 0, '没有解析地区线路');
  // 固定地区：只用 SE → 只解析 SE
  log = fakeNet({ 'cf-se.example': { delay: 'hang' }, '203.0.113.50': { delay: 10 } });
  dns = [];
  env = altEnv({ set: { altPick: ['SE'] } });
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
  const env = quietEnv();
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
  const env = quietEnv();
  const body = new ReadableStream({ start(c) { c.enqueue(vlessReq('bp.example', 443, TLS_HELLO)); } });   // 请求体保持打开
  const res = await xhttpPost(env, `/${UUID}`, body);
  const reader = res.body.getReader();
  assert.deepEqual([...(await reader.read()).value], [0, 0]);
  assert.equal((await reader.read()).value.byteLength, 64 * 1024);
  await new Promise(r => setTimeout(r, 100));   // 客户端停止读取
  assert.ok(pulls <= 10, `目标连接被读取了 ${pulls} 次（无背压时会一直增长）`);
  await reader.cancel();
  await until(() => closed);
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
  assert.equal(log.filter(s => s.hostname === 'half.example').length, 0);   // （其它测试遗留的连接可能还在重试，只看这个目标）
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
  const ws = await openWs(quietEnv());
  const frames = Array.from({ length: 300 }, (_, i) => new Uint8Array(500).fill(i & 255));
  ws.emit('message', { data: vlessReq('burst.example', 443).buffer });            // 先只有头部
  for (const f of frames) ws.emit('message', { data: f.buffer.slice(0) });         // 连接建立前一口气到达
  await until(() => log[0] && log[0].written.reduce((n, w) => n + w.length, 0) >= 300 * 500);
  const got = Buffer.concat(log[0].written.map(w => Buffer.from(w)));
  assert.equal(Buffer.compare(got, Buffer.concat(frames.map(f => Buffer.from(f)))), 0);
});

// ---------------- 借鉴改进：https 出站代理走 TLS、首包看门狗、上行队列、XHTTP 响应头 ----------------
// 把首包看门狗的 3.5 秒等待缩短到 40 毫秒（只影响这一个定时器）
const fastWatchdog = async (fn) => {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...a) => real(f, ms === 3500 ? 40 : ms, ...a);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
};
const sendTls = async (ws, host) => ws.emit('message', { data: vlessReq(host, 443, TLS_HELLO).buffer });
const hostLog = (log, host) => log.filter(x => x.hostname === host);

test('https 出站代理先与代理建立 TLS（secureTransport），再在 TLS 里发 CONNECT；http / socks5 出站代理不带 TLS 选项', async () => {
  const feed = async (sock, bytes) => { await until(() => sock.push); sock.push(new Uint8Array(bytes)); };
  let log = fakeNet({ '10.0.1.1': { delay: 5 } });
  let ws = await openWs(baseEnv({ set: { hop: { type: 'https', host: '10.0.1.1', port: 443 }, hopMode: 'only' } }));
  ws.emit('message', { data: vlessReq('hop-tls.example', 443, TLS_HELLO).buffer });
  await until(() => log.length && log[0].written.length);
  assert.deepEqual(log[0].opts, { secureTransport: 'on', allowHalfOpen: false });
  assert.match(Buffer.from(log[0].written[0]).toString(), /^CONNECT hop-tls\.example:443 HTTP\/1\.1\r\n/);
  for (const hop of [{ type: 'http', host: '10.0.1.2', port: 8080 }, { type: 'socks5', host: '10.0.1.3', port: 1080 }]) {
    log = fakeNet({ [hop.host]: { delay: 5 } });
    ws = await openWs(baseEnv({ set: { hop, hopMode: 'only' } }));
    ws.emit('message', { data: vlessReq('hop-plain.example', 443, TLS_HELLO).buffer });
    await until(() => log.length && log[0].written.length);
    assert.equal(log[0].opts, undefined, hop.type);
  }
  void feed;
});

test('首包看门狗（WS）：直连接通但目标不回数据 → 换备用线路并重发同一份首包；直连有数据 / 非 TLS / 没有备用线路时不重试；备用线路也不通时继续等慢的直连', async () => {
  await fastWatchdog(async () => {
    const TLS_REPLY = new Uint8Array([22, 3, 3, 0, 4, 9, 9, 9, 9]);
    // 1) 直连静默 → 备用线路接管，首包原样重发，之后双向数据走新连接
    let log = fakeNet({ 'silent.example': { delay: 5 }, '203.0.113.10': { delay: 5 }, '203.0.113.20': { delay: 5 } });
    await withFetch(relayDoh, async () => {
      const ws = await openWs(altEnv());
      sendTls(ws, 'silent.example');
      await until(() => hostLog(log, '203.0.113.10').some(x => x.written.length));
      const alt = hostLog(log, '203.0.113.10').find(x => x.written.length);
      assert.deepEqual([...alt.written[0]], TLS_HELLO, '同一份首包原样重发给备用线路');
      assert.equal(hostLog(log, 'silent.example')[0].closedByUs, true, '静默的直连被关闭');
      ws.emit('message', { data: new Uint8Array([7, 7]).buffer });   // 之后的上行数据走新连接
      await until(() => alt.written.length >= 2);
      alt.push(TLS_REPLY);
      await until(() => ws.sent.some(m => m.byteLength === TLS_REPLY.byteLength));
    });
    // 2) 直连接通后没回数据就关闭 → 立即重试（不等超时）
    log = fakeNet({ 'closing.example': { delay: 5 }, '203.0.113.10': { delay: 5 }, '203.0.113.20': { delay: 5 } });
    await withFetch(relayDoh, async () => {
      const ws = await openWs(altEnv());
      sendTls(ws, 'closing.example');
      await until(() => hostLog(log, 'closing.example')[0] && hostLog(log, 'closing.example')[0].end);
      hostLog(log, 'closing.example')[0].end();
      await until(() => hostLog(log, '203.0.113.10').some(x => x.written.length));
    });
    // 3) 直连有数据：不重试，备用线路连接被释放
    log = fakeNet({ 'chatty.example': { delay: 5 }, '203.0.113.10': { delay: 5 }, '203.0.113.20': { delay: 5 } });
    await withFetch(relayDoh, async () => {
      const ws = await openWs(altEnv());
      sendTls(ws, 'chatty.example');
      await until(() => hostLog(log, 'chatty.example')[0] && hostLog(log, 'chatty.example')[0].push);
      hostLog(log, 'chatty.example')[0].push(TLS_REPLY);
      await until(() => ws.sent.some(m => m.byteLength === TLS_REPLY.byteLength));
      await new Promise(r => setTimeout(r, 120));
      assert.equal(log.filter(x => x.written.length && x.hostname.startsWith('203.')).length, 0, '没有向备用线路重发任何东西');
    });
    // 4) 非 TLS 首包：不启用看门狗（SNI 型备用线路本来就不接非 TLS）
    log = fakeNet({ 'plain.example': { delay: 5 }, '203.0.113.10': { delay: 5 } });
    await withFetch(relayDoh, async () => {
      const ws = await openWs(altEnv());
      ws.emit('message', { data: vlessReq('plain.example', 80, [71, 69, 84, 32, 47]).buffer });   // "GET /"
      await until(() => hostLog(log, 'plain.example')[0] && hostLog(log, 'plain.example')[0].written.length);
      await new Promise(r => setTimeout(r, 120));
      assert.equal(hostLog(log, 'plain.example')[0].closedByUs, false);
      assert.equal(log.filter(x => x.hostname.startsWith('203.') && x.written.length).length, 0);
    });
    // 5) 没有备用线路：静默的直连保持原样（不关闭、不重试）
    log = fakeNet({ 'quiet.example': { delay: 5 } });
    const wsq = await openWs(baseEnv());
    sendTls(wsq, 'quiet.example');
    await until(() => hostLog(log, 'quiet.example')[0] && hostLog(log, 'quiet.example')[0].written.length);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(hostLog(log, 'quiet.example')[0].closedByUs, false);
    // 6) 备用线路也连不上：慢的直连不被放弃，数据来了照常转发
    log = fakeNet({ 'slowpoke.example': { delay: 5 } });   // 203.* 都不在网络表里 = 连接失败
    await withFetch(relayDoh, async () => {
      const ws = await openWs(altEnv());
      sendTls(ws, 'slowpoke.example');
      await until(() => hostLog(log, 'slowpoke.example')[0] && hostLog(log, 'slowpoke.example')[0].push);
      await new Promise(r => setTimeout(r, 200));   // 超过看门狗等待，备用线路已经失败
      assert.equal(hostLog(log, 'slowpoke.example')[0].closedByUs, false);
      hostLog(log, 'slowpoke.example')[0].push(TLS_REPLY);
      await until(() => ws.sent.some(m => m.byteLength === TLS_REPLY.byteLength));
    });
    // 7) 客户端等待期间走了：不再建立备用线路连接
    log = fakeNet({ 'gone.example': { delay: 5 }, '203.0.113.10': { delay: 5 } });
    await withFetch(relayDoh, async () => {
      const ws = await openWs(altEnv());
      sendTls(ws, 'gone.example');
      await until(() => hostLog(log, 'gone.example')[0] && hostLog(log, 'gone.example')[0].written.length);
      await ws.emit('close', { code: 1000 });
      await new Promise(r => setTimeout(r, 150));
      assert.equal(log.filter(x => x.hostname.startsWith('203.') && x.written.length).length, 0);
    });
  });
});

test('首包看门狗（XHTTP）：直连静默时换备用线路，响应里是备用线路的数据；直连有数据时数据面不变', async () => {
  await fastWatchdog(async () => {
    const TLS_REPLY = new Uint8Array([22, 3, 3, 0, 4, 5, 5, 5, 5]);
    const readAll = async (res, n) => { const r = res.body.getReader(); let got = []; while (got.length < n) { const x = await r.read(); if (x.done) break; got.push(...x.value); } await r.cancel(); return got; };
    let log = fakeNet({ 'xsilent.example': { delay: 5 }, '203.0.113.10': { delay: 5 }, '203.0.113.20': { delay: 5 } });
    await withFetch(relayDoh, async () => {
      const resP = xhttpPost(altEnv(), `/${UUID}`, new ReadableStream({ start(c) { c.enqueue(vlessReq('xsilent.example', 443, TLS_HELLO)); } }));
      await until(() => hostLog(log, '203.0.113.10').some(x => x.written.length));
      const alt = hostLog(log, '203.0.113.10').find(x => x.written.length);
      assert.deepEqual([...alt.written[0]], TLS_HELLO);
      alt.push(TLS_REPLY);
      const res = await resP;
      assert.equal(res.status, 200);
      assert.deepEqual(await readAll(res, 2 + TLS_REPLY.length), [0, 0, ...TLS_REPLY]);
    });
    log = fakeNet({ 'xchatty.example': { delay: 5 }, '203.0.113.10': { delay: 5 } });
    await withFetch(relayDoh, async () => {
      const resP = xhttpPost(altEnv(), `/${UUID}`, new ReadableStream({ start(c) { c.enqueue(vlessReq('xchatty.example', 443, TLS_HELLO)); } }));
      await until(() => hostLog(log, 'xchatty.example')[0] && hostLog(log, 'xchatty.example')[0].push);
      hostLog(log, 'xchatty.example')[0].push(TLS_REPLY);
      assert.deepEqual(await readAll(await resP, 2 + TLS_REPLY.length), [0, 0, ...TLS_REPLY]);
      assert.equal(log.filter(x => x.hostname.startsWith('203.') && x.written.length).length, 0);
    });
  });
});

test('上行队列（WS）：目标写得慢时客户端的小帧合并成不超过 16KB 的块写出，字节顺序完整；积压超过上限就断开而不是无限占内存', async () => {
  // 目标的写入被卡住：释放前客户端发来的帧都在队列里
  let release, writes = [];
  const gate = new Promise(r => { release = r; });
  globalThis.__connect = () => ({
    opened: Promise.resolve(), close() {},
    writable: new WritableStream({ async write(c) { writes.push(new Uint8Array(c)); if (writes.length === 1) await gate; } }),
    readable: new ReadableStream({ type: 'bytes' }),
  });
  let ws = await openWs(baseEnv());
  ws.emit('message', { data: vlessReq('up.example', 443, TLS_HELLO).buffer });   // 首包的写入被卡住，这个事件处理要等到释放后才结束：不能 await
  await until(() => writes.length === 1);   // 首包已写出（并卡住）
  const frames = Array.from({ length: 200 }, (_, i) => new Uint8Array(100).fill(i));
  for (const f of frames) ws.emit('message', { data: f.buffer.slice(0) });
  release();
  await until(() => writes.slice(1).reduce((n, w) => n + w.length, 0) >= 200 * 100);
  const rest = writes.slice(1);
  assert.ok(rest.length <= 3, `合并后只写了 ${rest.length} 次`);
  assert.ok(rest.every(w => w.length <= 16 * 1024), '每块不超过 16KB');
  assert.equal(Buffer.compare(Buffer.concat(rest.map(w => Buffer.from(w))), Buffer.concat(frames.map(f => Buffer.from(f)))), 0, '字节顺序完整');
  // 积压超限：写入一直卡住，客户端继续发 → 断开
  writes = [];
  globalThis.__connect = () => ({
    opened: Promise.resolve(), close() {},
    writable: new WritableStream({ write() { return new Promise(() => {}); } }),
    readable: new ReadableStream({ type: 'bytes' }),
  });
  ws = await openWs(baseEnv());
  ws.emit('message', { data: vlessReq('flood.example', 443, TLS_HELLO).buffer });
  await new Promise(r => setTimeout(r, 30));
  for (let i = 0; i < 20 && !ws.closed; i++) ws.emit('message', { data: new Uint8Array(32 * 1024).buffer });
  await until(() => ws.closed);
  assert.equal(ws.closed.code, 1011); assert.match(ws.closed.reason, /上行缓冲溢出/);
});

test('XHTTP 响应头：content-type 为 application/grpc，并带一条填充头（头名 = UUID 第 2–7 位，值是带 100–1000 个随机字符的 URL，参数名 = _ + UUID 第 26–31 位），每次长度随机', async () => {
  fakeNet({ 'hdr.example': { delay: 5 } });
  const env = baseEnv();
  const lens = new Set();
  for (let i = 0; i < 6; i++) {
    const res = await xhttpPost(env, `/${UUID}`, vlessReq('hdr.example', 443, TLS_HELLO));
    assert.equal(res.headers.get('content-type'), 'application/grpc');
    assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const v = res.headers.get(UUID.slice(1, 7));
    const m = v.match(/^https:\/\/node\.example\.com\/\?_([0-9a-f]{6})=([0-9A-Za-z]+)$/);
    assert.ok(m, v.slice(0, 60));
    assert.equal(m[1], UUID.slice(25, 31));
    assert.ok(m[2].length >= 100 && m[2].length <= 1000, String(m[2].length));
    lens.add(m[2].length);
    await res.body.cancel();
  }
  assert.ok(lens.size > 1, '长度是随机的');
  // 宽限期里的旧 UUID 也用它自己的填充头名
  const OLD = 'bbbbbbbb-2222-4333-8444-555555555555';
  const env2 = baseEnv({ set: { uuids: [[UUID, 0], [OLD, Date.now() + 600000]] } });
  const req = vlessReq('hdr.example', 443, TLS_HELLO); req.set(OLD.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16)), 1);
  const res = await xhttpPost(env2, `/${UUID}`, req);
  assert.ok(res.headers.get(OLD.slice(1, 7)), '头名跟着匹配到的 UUID');
  await res.body.cancel();
});

// ---------------- 代理配置（环境变量只有 PATH 与 NODE_KEY）与路由 ----------------
import { readFileSync } from 'node:fs';
import { PROXY_VERSION } from './helpers-version.mjs';

test('环境变量：PATH 首尾斜杠自动去掉；UUID 与所有设置都不再来自环境变量（旧的变量被忽略）', () => {
  const cfg = internals.nodeConfig({ PATH: '/mynode/', NODE_KEY: KEY, UUID, EDGEIP: 'x.example', HOP_ADDR: 'socks5://1.2.3.4:1', HOP_MODE: 'only', ALT_MODE: 'off' });
  assert.equal(cfg.path, 'mynode');
  assert.equal(cfg.key, KEY);
  assert.deepEqual(cfg._problems, []);
  assert.deepEqual(cfg.uuids, []);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.edgeIP, ''); assert.equal(cfg.hop, null); assert.equal(cfg.hopMode, '');
  assert.deepEqual(cfg.altTable, {}); assert.deepEqual(cfg.altPick, [], '没有面板下发的线路表时没有备用线路');
});

test('必填环境变量：PATH / NODE_KEY 缺失或非法时所有请求返回 503 设置说明', async () => {
  for (const [env, re] of [
    [{}, /PATH[\s\S]*NODE_KEY/],
    [{ NODE_KEY: KEY }, /PATH/],
    [{ PATH: 'p' }, /NODE_KEY/],
    [{ PATH: 'p', NODE_KEY: 'short' }, /NODE_KEY 的值不正确/],
    [{ PATH: 'p', NODE_KEY: 'has space in it 0123456789abcdef' }, /NODE_KEY 的值不正确/],
    [{ NODE_KEY: KEY, PATH: 'a/b' }, /PATH 的值不正确/],
    [{ NODE_KEY: KEY, PATH: 'x'.repeat(129) }, /PATH 的值不正确/],
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
  const env = quietEnv({ PATH: 'mynode' });
  const hello = async (path, init) => {
    const res = await worker.fetch(new Request('https://node.example.com' + path, init), env, {});
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /Hello World/, path);
  };
  for (const path of ['/', '/login', '/version', '/mynode/api/config', '/mynode/sub', `/${UUID}/sub`, `/${UUID}`, '/mynode/x', '/other', '/mynode/status', '/mynode/ctl']) {
    await hello(path, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    await hello(path, { headers: { 'User-Agent': 'v2rayN/7.0' } });
  }
  await hello('/login', { method: 'POST', body: 'username=admin&password=x' });
  await hello('/other', { method: 'POST', body: new Uint8Array(vlessReq('x.example', 443)) });
  await hello('/mynode', { headers: { 'User-Agent': 'Mozilla/5.0' } });   // 节点路径上的普通 GET 也只是伪装页
  // 与 Cloudflare 默认的 Hello World Worker（return new Response('Hello World!')）完全一致：正文、状态码与响应头
  const stub = await worker.fetch(new Request('https://node.example.com/'), env, {});
  const ref = new Response('Hello World!');
  assert.equal(await stub.clone().text(), 'Hello World!');
  assert.equal(stub.status, ref.status);
  assert.deepEqual([...stub.headers], [...ref.headers], '没有任何多余的响应头');
  assert.equal(stub.headers.get('content-type'), 'text/plain;charset=UTF-8');
  // 节点路径（首尾斜杠无关）上：WebSocket 升级与 XHTTP POST 始终可用，无需任何开关
  const ws = await worker.fetch(new Request('https://node.example.com/mynode/', { headers: { Upgrade: 'websocket' } }), env, {});
  assert.equal(ws.status, 101);
  const post = await xhttpPost(env, '/mynode', vlessReq('route.example', 443, TLS_HELLO));
  assert.equal(post.headers.get('content-type'), 'application/grpc');
});

test('构建产物：代理脚本不含面板 / 登录 / 订阅 / 面板 KV / 更新检测的代码，没有 Shadowsocks 与内置的第三方线路域名，也不导出任何 RPC 入口', () => {
  const code = readFileSync(new URL('../Hopline-proxy.js', import.meta.url), 'utf8');
  for (const needle of ['hopline_auth', '/api/', 'CONFIG_KV', 'loginHTML', 'generateSubscription', 'raw.githubusercontent.com', 'clash-template', 'PBKDF2', 'ADMIN', 'WorkerEntrypoint', 'cloudflare:workers', 'cmliussss', 'chacha', 'md5Bytes', 'hkdf']) {
    assert.ok(!code.toLowerCase().includes(needle.toLowerCase()), needle);
  }
  assert.deepEqual(Object.keys(proxyModule), ['default']);
});

// ---------------- 面板整份下发的状态与签名控制接口 ----------------
function memKv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const kv = { m, gets: 0, puts: 0, down: false,
    async get(k) { kv.gets++; if (kv.down) throw new Error('KV unavailable'); return m.has(k) ? m.get(k) : null; },
    async put(k, v) { kv.puts++; if (kv.down) throw new Error('KV unavailable'); m.set(k, v); },
    async delete(k) { m.delete(k); } };
  return kv;
}
const hm = (key, msg) => createHmac('sha256', key).update(msg).digest('base64url');
const TAG = hm(KEY, 'route').slice(0, 16);
let nonceSeq = 0;
// 发一条控制请求；args 是对象（会序列化）或已经是文本；o 可覆盖 key / ts / n / s / tag / path / method / body 来构造各种错误请求
async function ctl(env, op, args = {}, o = {}) {
  const key = o.key ?? KEY, ts = o.ts ?? Date.now(), n = o.n ?? ('nonce-' + (++nonceSeq) + '-abcdefgh');
  const a = typeof args === 'string' ? args : JSON.stringify(args);
  const s = o.s ?? hm(key, `${ts}.${n}.${op}.${a}`);
  const path = o.path ?? `/${env.PATH}/${o.tag ?? TAG}`;
  const body = o.body ?? JSON.stringify({ ts, n, op, a, s });
  const res = await worker.fetch(new Request('https://node.example.com' + path, { method: o.method || 'POST', body: (o.method === 'GET') ? undefined : body }), env, {});
  return { res, n, ts };
}
// 发控制请求并检查回应签名，返回解析后的结果
async function call(env, op, args = {}) {
  const { res, n } = await ctl(env, op, args);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.s, hm(KEY, `${j.ts}.${n}.${j.d}`), '回应带有绑定请求随机串的签名');
  return JSON.parse(j.d);
}
const rawState = (kv) => kv.m.get('state');
const isHello = async (res) => { assert.equal(res.status, 200); assert.match(await res.text(), /Hello World/); };
const shortHashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);

test('控制接口：任何不合规的请求都和其它路径一样返回 Hello World（方法、签名、密钥、时间偏差、重放、路径标记、畸形请求体）', async () => {
  const env = baseEnv({ PATH: 'mynode' });
  assert.equal((await call(env, 'status')).ok, true);
  const n1 = 'replay-nonce-0001';
  const first = await ctl(env, 'status', {}, { n: n1 });
  assert.match(first.res.headers.get('content-type'), /json/);
  await isHello((await ctl(env, 'status', {}, { n: n1 })).res);                 // 同一随机串第二次：重放
  await isHello((await ctl(env, 'status', {}, { method: 'GET' })).res);          // 方法不对
  await isHello((await ctl(env, 'status', {}, { key: 'another-key-0123456789-abcdefgh' })).res);   // 密钥不对
  await isHello((await ctl(env, 'status', {}, { s: 'AAAA' })).res);              // 签名被改
  await isHello((await ctl(env, 'status', {}, { ts: Date.now() - 31000 })).res);  // 太旧
  await isHello((await ctl(env, 'status', {}, { ts: Date.now() + 31000 })).res);  // 太新
  await isHello((await ctl(env, 'status', {}, { tag: 'wrongtag0123456' })).res);  // 路径标记不对
  await isHello((await ctl(env, 'status', {}, { path: `/other/${TAG}` })).res);  // 路径不对
  await isHello((await ctl(env, 'status', {}, { body: '{not json' })).res);
  await isHello((await ctl(env, 'status', {}, { body: '[]' })).res);
  await isHello((await ctl(env, 'status', {}, { body: JSON.stringify({ ts: 1, n: 'x', op: 'status', a: '', s: '' }) })).res);
  await isHello((await ctl(env, 'status', {}, { body: 'x'.repeat(20000) })).res);
  // 被篡改的参数（签名针对原参数）
  const ts = Date.now(), n = 'tamper-nonce-0001';
  const good = JSON.stringify(stateWith());
  const sig = hm(KEY, `${ts}.${n}.setState.${good}`);
  await isHello((await ctl(env, 'setState', JSON.stringify(stateWith({ enabled: false })), { ts, n, s: sig })).res);
  assert.equal(env.NODE_KV.puts, 0, '被拒绝的请求没有写入任何东西');
  // 签名正确但操作未知：仍然是已认证的回应（只告诉持有密钥的一方）
  assert.equal((await call(env, 'nope')).ok, false);
  assert.equal((await call(env, 'getSettings')).ok, false, '旧的操作都不存在了');
});

test('控制接口 status：在线、版本、是否已下发 UUID / 启用、状态哈希；不返回 UUID、路径、密钥与任何设置内容', async () => {
  const set = { edgeIP: 'alt.private.example:8443', hop: { type: 'socks5', host: '10.9.8.7', port: 1080, user: 'alice', pass: 'hunter2' }, hopMode: 'only' };
  const env = baseEnv({ PATH: 'secret-node-path', set });
  const st = await call(env, 'status');
  assert.deepEqual(Object.keys(st).sort(), ['enabled', 'kvError', 'ok', 'problems', 'provisioned', 'stateHash', 'storage', 'version']);
  assert.equal(st.ok, true);
  assert.equal(st.version, PROXY_VERSION);
  assert.deepEqual(st.problems, []);
  assert.equal(st.storage, true); assert.equal(st.provisioned, true); assert.equal(st.enabled, true);
  assert.equal(st.stateHash, shortHashOf(rawState(env.NODE_KV)));
  const text = JSON.stringify(st);
  for (const secret of [UUID, 'secret-node-path', KEY, 'alt.private.example', 'alice', 'hunter2', '10.9.8.7']) assert.ok(!text.includes(secret), secret);
  // 没有 KV：照常在线，但 storage:false、尚未下发
  const noKv = { PATH: 'secret-node-path', NODE_KEY: KEY };
  const s2 = await call(noKv, 'status');
  assert.equal(s2.storage, false); assert.equal(s2.provisioned, false); assert.equal(s2.stateHash, '');
  // 公开响应里没有版本号
  const pub = await worker.fetch(new Request('https://node.example.com/'), env, {});
  assert.ok(!(await pub.text()).includes(PROXY_VERSION));
});

test('未下发状态（或没有 NODE_KV）的代理：节点路径与其它路径一样只是 Hello World，WebSocket 与 XHTTP 都不进入', async () => {
  fakeNet({ 'x.example': { delay: 5 } });
  for (const env of [{ PATH: 'mynode', NODE_KEY: KEY }, { PATH: 'mynode', NODE_KEY: KEY, NODE_KV: memKv() }]) {
    const ws = await worker.fetch(new Request('https://node.example.com/mynode', { headers: { Upgrade: 'websocket' } }), env, {});
    await isHello(ws);
    await isHello(await xhttpPost(env, '/mynode', vlessReq('x.example', 443, TLS_HELLO)));
  }
});

test('setState：整份覆盖，KV 里保存的就是面板发来的 JSON 原文，返回的哈希与面板自己算的一致；节点立即可用', async () => {
  const kv = memKv();
  const env = baseEnv({ PATH: 'mynode', NODE_KV: kv });
  assert.equal((await call(env, 'status')).provisioned, false);
  const raw = JSON.stringify(stateWith({ edgeIP: 'e.example.com', hop: { type: 'http', host: 'h.example.com', port: 8080, user: 'u', pass: 'p' }, hopMode: 'only' }));
  const r = await call(env, 'setState', raw);
  assert.deepEqual(r, { ok: true, stateHash: shortHashOf(raw) });
  assert.equal(rawState(kv), raw, '原文保存，不做任何改写');
  const st = await call(env, 'status');
  assert.equal(st.provisioned, true); assert.equal(st.stateHash, shortHashOf(raw));
  // 换成没有出站代理的状态后，节点按它出站
  assert.equal((await call(env, 'setState', JSON.stringify(stateWith()))).ok, true);
  const log = fakeNet({ 'id.example': { delay: 5 } });
  const ws = await worker.fetch(new Request('https://node.example.com/mynode', { headers: { Upgrade: 'websocket' } }), env, {});
  assert.equal(ws.status, 101);
  await lastServer.emit('message', { data: vlessReq('id.example', 443, TLS_HELLO).buffer });
  await until(() => log.some(s => s.written.length));
  // 再下发一份：整份覆盖（没有合并）
  const raw2 = JSON.stringify(stateWith({ edgeIP: '', hop: null }));
  assert.equal((await call(env, 'setState', raw2)).ok, true);
  assert.equal(rawState(kv), raw2);
});

test('setState 校验：类型、长度、未知字段、非法的主机 / 端口 / UUID / 标签都被拒绝并说明原因，不写 KV；没有 NODE_KV 时明确拒绝', async () => {
  const kv = memKv();
  const env = baseEnv({ PATH: 'mynode', NODE_KV: kv });
  const ok = stateWith();
  const bad = [
    [{ bogus: 1 }, /未知字段/], [{ uuids: [] .concat([['not-a-uuid', 0]]) }, /uuids/], [{ uuids: [[UUID, -1]] }, /uuids/], [{ uuids: Array(5).fill([UUID, 0]) }, /uuids/],
    [{ enabled: 'yes' }, /enabled/], [{ edgeIP: 'bad host' }, /edgeIP/], [{ edgeIP: 'x.example:99999' }, /edgeIP/], [{ edgeIP: 5 }, /edgeIP/],
    [{ hopMode: 'no' }, /hopMode/], [{ hop: { type: 'ss', host: 'h.example', port: 1 } }, /hop/], [{ hop: { type: 'socks5', host: 'bad host', port: 1 } }, /hop/],
    [{ hop: { type: 'socks5', host: 'h.example', port: 0 } }, /hop/], [{ hop: 'socks5://h' }, /hop/], [{ hop: { type: 'http', host: 'h.example', port: 80, user: 5 } }, /hop/],
    [{ altTable: { 'bad tag': { host: 'a.example' } } }, /altTable/], [{ altTable: { a: { host: 'bad host' } } }, /altTable/], [{ altTable: { a: { host: 'a.example', port: 70000 } } }, /altTable/],
    [{ altTable: { a: { host: 'a.example', txt: 'y' } } }, /altTable/], [{ altTable: [] }, /altTable/], [{ altPick: ['bad tag'] }, /altPick/], [{ altPick: Array(9).fill('a') }, /altPick/], [{ altPick: 'auto' }, /altPick/],
  ];
  for (const [patch, re] of bad) {
    const r = await call(env, 'setState', JSON.stringify({ ...ok, ...patch }));
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, re, JSON.stringify(patch));
  }
  assert.equal((await call(env, 'setState', '{not json')).ok, false);
  assert.equal((await call(env, 'setState', '[]')).ok, false);
  const missing = { ...ok }; delete missing.altPick;
  assert.equal((await call(env, 'setState', JSON.stringify(missing))).ok, false, '缺字段');
  assert.equal(kv.puts, 0, '校验失败不写 KV');
  const noKv = { PATH: 'mynode', NODE_KEY: KEY };
  const r = await call(noKv, 'setState', JSON.stringify(ok));
  assert.equal(r.ok, false); assert.match(r.error, /NODE_KV/);
});

test('更换 UUID 的宽限期：状态里带失效时间的旧 UUID 在期内可用、过期后被拒绝，新的 UUID 一直可用', async () => {
  const NEW = 'aaaaaaaa-2222-4333-8444-555555555555';
  const realNow = Date.now; let t = realNow(); Date.now = () => t;
  try {
    const kv = memKv({ state: stateWith({ uuids: [[NEW, 0], [UUID, t + 10 * 60 * 1000]] }) });
    const env = baseEnv({ PATH: 'mynode', NODE_KV: kv });
    const withUuid = (u) => { const r = vlessReq('grace.example', 443, TLS_HELLO); r.set(u.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16)), 1); return r; };
    const tryConnect = async (u) => {
      const log = fakeNet({ 'grace.example': { delay: 5 } });
      const res = await worker.fetch(new Request('https://node.example.com/mynode', { headers: { Upgrade: 'websocket' } }), env, {});
      assert.equal(res.status, 101);
      await lastServer.emit('message', { data: withUuid(u).buffer });
      await new Promise(r => setTimeout(r, 40));
      return log.some(s => s.written.length);
    };
    assert.equal(await tryConnect(NEW), true, '新 UUID');
    assert.equal(await tryConnect(UUID), true, '宽限期内的旧 UUID');
    t += 10 * 60 * 1000 + 1000;
    assert.equal(await tryConnect(NEW), true);
    assert.equal(await tryConnect(UUID), false, '宽限期过后旧 UUID 被拒绝（不需要面板再下发任何东西）');
  } finally { Date.now = realNow; }
});

test('停用：面板下发 enabled:false 后代理对外只显示 Hello World（WebSocket / XHTTP 都不进入），控制接口不受影响；启用后恢复', async () => {
  const kv = memKv({ state: stateWith() });
  const env = quietEnv({ PATH: 'mynode', NODE_KV: kv });
  const log = fakeNet({ 'off.example': { delay: 5 } });
  const wsReq = () => worker.fetch(new Request('https://node.example.com/mynode', { headers: { Upgrade: 'websocket' } }), env, {});
  assert.equal((await wsReq()).status, 101);
  assert.equal((await call(env, 'setState', JSON.stringify(stateWith({ enabled: false })))).ok, true);
  // 同一 isolate 内立即生效（写入后缓存已更新）
  await isHello(await wsReq());
  await isHello(await xhttpPost(env, '/mynode', vlessReq('off.example', 443, TLS_HELLO)));
  assert.equal(log.length, 0, '没有发起任何出站连接');
  const st = await call(env, 'status');
  assert.equal(st.enabled, false); assert.equal(st.ok, true); assert.equal(st.provisioned, true);
  assert.equal((await call(env, 'setState', JSON.stringify(stateWith()))).ok, true);
  assert.equal((await wsReq()).status, 101);
  const post = await xhttpPost(env, '/mynode', vlessReq('off.example', 443, TLS_HELLO));
  assert.equal(post.headers.get('content-type'), 'application/grpc');
});

test('KV 状态：损坏的内容被忽略（视为未下发，节点只显示 Hello World）并可被重新下发覆盖；读取失败时沿用上次读到的状态，写入失败明确报错', async () => {
  const kv = memKv({ state: '{not json' });
  const env = baseEnv({ PATH: 'mynode', NODE_KV: kv });
  const st = await call(env, 'status');
  assert.equal(st.kvError, 'corrupt'); assert.equal(st.provisioned, false); assert.equal(st.stateHash, '');
  await isHello(await worker.fetch(new Request('https://node.example.com/mynode', { headers: { Upgrade: 'websocket' } }), env, {}));
  assert.equal((await call(env, 'setState', JSON.stringify(stateWith()))).ok, true, '重新下发即可修复');
  assert.equal((await call(env, 'status')).kvError, '');
  // 内容合法 JSON 但字段不对：同样按损坏处理
  const kv2 = memKv({ state: { uuids: 'x' } });
  assert.equal((await call(baseEnv({ PATH: 'mynode', NODE_KV: kv2 }), 'status')).kvError, 'corrupt');
  // 读取失败：沿用上一次读到的状态
  const kv3 = memKv({ state: stateWith() });
  const env3 = baseEnv({ PATH: 'mynode', NODE_KV: kv3 });
  assert.equal((await call(env3, 'status')).provisioned, true);
  kv3.down = true;
  const realNow = Date.now; Date.now = () => realNow() + 25 * 1000;   // 缓存过期，触发重新读取
  try {
    const down = await call(env3, 'status');
    assert.equal(down.kvError, 'unavailable'); assert.equal(down.provisioned, true, '沿用上次的状态');
  } finally { Date.now = realNow; }
  const w = await call(env3, 'setState', JSON.stringify(stateWith({ enabled: false })));
  assert.equal(w.ok, false); assert.match(w.error, /KV 写入失败/);
});

test('混淆版代理脚本：只导出默认入口，控制接口、状态下发与节点连接同样可用', async () => {
  const obf = await import('../obf_Hopline-proxy.js?obf-test');
  assert.deepEqual(Object.keys(obf), ['default']);
  const kv = memKv();
  const env = baseEnv({ PATH: 'mynode', NODE_KV: kv });
  const send = async (op, args = {}) => {
    const ts = Date.now(), n = 'obf-' + op + '-nonce-' + (++nonceSeq), a = typeof args === 'string' ? args : JSON.stringify(args);
    const res = await obf.default.fetch(new Request(`https://node.example.com/mynode/${TAG}`, { method: 'POST', body: JSON.stringify({ ts, n, op, a, s: hm(KEY, `${ts}.${n}.${op}.${a}`) }) }), env, {});
    return JSON.parse((await res.json()).d);
  };
  const st = await send('status');
  assert.equal(st.ok, true); assert.equal(st.version, PROXY_VERSION); assert.equal(st.provisioned, false);
  await isHello(await obf.default.fetch(new Request('https://node.example.com/mynode', { headers: { Upgrade: 'websocket' } }), env, {}));
  const raw = JSON.stringify(stateWith({ hopMode: 'only', hop: { type: 'socks5', host: '10.0.0.1', port: 1080 } }));
  assert.equal((await send('setState', raw)).ok, true);
  assert.equal(rawState(kv), raw);
  const ws = await obf.default.fetch(new Request('https://node.example.com/mynode', { headers: { Upgrade: 'websocket' } }), env, {});
  assert.equal(ws.status, 101);
});

test('面板下发的状态真正生效：节点路径上的连接按状态出站；KV 读取有缓存、伪装页请求不读 KV；KV 故障时沿用上次的状态', async () => {
  const kv = memKv({ state: stateWith({ altPick: [] }) });
  const env = altEnv({ NODE_KV: kv });
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    // 伪装页 / 其它路径：不读 KV
    for (const path of ['/', '/other', '/login']) await worker.fetch(new Request('https://node.example.com' + path), env, {});
    assert.equal(kv.gets, 0, '没有节点路径上的连接就不读 KV');
    // 没有备用线路：直连失败后不尝试任何线路
    let log = fakeNet({});
    const dns = [];
    await withFetch(cfDoh({}, dns), async () => {
      for (let i = 0; i < 3; i++) {
        const ws = await openWs(env);
        await ws.emit('message', { data: vlessReq('kv-off.example', 443, TLS_HELLO).buffer });
        assert.equal(ws.closed.code, 1011);
      }
    });
    assert.equal(dns.filter(d => d.name.startsWith('proxyip.')).length, 0, '状态里 altPick 为空：没有解析任何线路');
    assert.equal(kv.gets, 1, '3 个连接只读了一次 KV（isolate 内存缓存）');
    // 改成自定义线路，缓存过期后新状态生效
    kv.m.set('state', JSON.stringify(stateWith({ altTable: { mine: { host: 'kv-alt.example.com' } }, altPick: ['mine'] })));
    t += 25 * 1000;
    log = fakeNet({ 'kv-cf.example': { delay: 'hang' }, '203.0.113.77': { delay: 10 } });
    await withFetch(cfDoh({ 'kv-alt.example.com': ['203.0.113.77'] }, []), async () => {
      const ws = await openWs(env);
      await ws.emit('message', { data: vlessReq('kv-cf.example', 443, TLS_HELLO).buffer });
      await until(() => log.some(s => s.written.length));
    });
    assert.equal(log.find(s => s.written.length).hostname, '203.0.113.77', '缓存过期后读到新状态');
    assert.equal(kv.gets, 2);
    // KV 故障：沿用上次读到的状态（含 UUID），连接不受影响
    kv.down = true;
    t += 25 * 1000;
    log = fakeNet({ 'kv-cf.example': { delay: 'hang' }, '203.0.113.77': { delay: 10 } });
    await withFetch(cfDoh({ 'kv-alt.example.com': ['203.0.113.77'] }, []), async () => {
      const ws = await openWs(env);
      await ws.emit('message', { data: vlessReq('kv-cf.example', 443, TLS_HELLO).buffer });
      await until(() => log.some(s => s.written.length));
    });
    assert.equal(log.find(s => s.written.length).hostname, '203.0.113.77', 'KV 读取失败时沿用上次的状态');
  } finally { Date.now = realNow; }
  // 通过控制接口下发后，同一 isolate 立即生效（不等缓存过期）
  const kv2 = memKv({ state: stateWith() });
  const env2 = altEnv({ NODE_KV: kv2 });
  fakeNet({});
  const dns2 = [];
  await withFetch(cfDoh({}, dns2), async () => {
    const before = await openWs(env2);
    await before.emit('message', { data: vlessReq('save-live.example', 443, TLS_HELLO).buffer });
    await call(env2, 'setState', JSON.stringify(stateWith({ altPick: [] })));
    dns2.length = 0;
    const after = await openWs(env2);
    await after.emit('message', { data: vlessReq('save-live.example', 443, TLS_HELLO).buffer });
  });
  assert.equal(dns2.filter(d => d.name.startsWith('proxyip.')).length, 0, '下发后新连接不再用备用线路');
});

// ---------------- 审查修复（代理 3.2.2）：探测伪装、出站代理握手期限、状态如实回报、only 模式、首帧大小、机房地区、输入校验 ----------------
test('探测：节点路径上的 XHTTP 出错（UUID 不符 / 乱码 / 空请求体 / 没有请求体）都返回 Hello World；WebSocket 在请求头通过校验前出错时关闭帧不带原因', async () => {
  fakeNet({});
  const env = baseEnv();
  const wrong = vlessReq('x.example', 443, TLS_HELLO); wrong[1] ^= 0xff;
  for (const body of [wrong, new Uint8Array(20).fill(1), new Uint8Array(0)]) await isHello(await xhttpPost(env, `/${UUID}`, body));
  await isHello(await worker.fetch(new Request(`https://node.example.com/${UUID}`, { method: 'POST' }), env, {}));
  for (const bad of [wrong, new Uint8Array(20).fill(1)]) {
    const ws = await openWs(env);
    await ws.emit('message', { data: bad.buffer });
    assert.deepEqual(ws.closed, { code: 1011, reason: '' }, '不透露 UUID 不符等内部信息');
  }
  // 请求头通过校验之后的错误仍带原因（客户端日志里能看到）
  const mux = vlessReq('x.example', 443, TLS_HELLO); mux[1 + 16 + 1] = 3;
  const ws = await openWs(env);
  await ws.emit('message', { data: mux.buffer });
  assert.match(ws.closed.reason, /不支持的命令/);
});

test('出站代理握手有期限：只接受 TCP、不回应的出站代理超时后回落直连；握手失败（含超时）时关闭与出站代理的连接', async () => {
  const feed = async (sock, bytes) => { await until(() => sock.push && sock.written.length); sock.push(new Uint8Array(bytes)); };
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...a) => real(f, ms === 6000 ? 60 : ms, ...a);   // 握手期限 6 秒缩短到 60 毫秒
  try {
    const log = fakeNet({ 'hop.example': { delay: 5 }, 'target.example': { delay: 5 } });
    const ws = await openWs(baseEnv({ set: { hop: { type: 'socks5', host: 'hop.example', port: 1080 } } }));
    sendTls(ws, 'target.example');
    await until(() => hostLog(log, 'target.example').some(s => s.written.length));
    assert.equal(hostLog(log, 'hop.example')[0].closedByUs, true, '超时的出站代理连接被关闭');
    assert.equal(ws.closed, null);
  } finally { globalThis.setTimeout = real; }
  for (const [hop, reply] of [
    [{ type: 'socks5', host: 'hop.example', port: 1080 }, [5, 0xff]],
    [{ type: 'http', host: 'hop.example', port: 8080 }, [...Buffer.from('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')]],
  ]) {
    const log = fakeNet({ 'hop.example': { delay: 5 }, 'target.example': { delay: 5 } });
    const ws = await openWs(baseEnv({ set: { hop } }));
    sendTls(ws, 'target.example');
    await until(() => log.length);
    await feed(log[0], reply);
    await until(() => hostLog(log, 'target.example').some(s => s.written.length));
    assert.equal(hostLog(log, 'hop.example')[0].closedByUs, true, hop.type + '：握手被拒绝后连接被关闭');
  }
});

test('控制接口 status 如实回报 KV 里的状态（不走 20 秒的内存缓存）：别的 isolate 刚下发的新状态立即可见；节点连接仍走缓存', async () => {
  fakeNet({});
  const kv = memKv({ state: stateWith() });
  const env = baseEnv({ NODE_KV: kv });
  const before = await call(env, 'status');
  assert.equal(before.stateHash, shortHashOf(JSON.stringify(stateWith())));
  // 另一个 isolate 写入了新状态（这里直接改 KV 模拟）
  const next = JSON.stringify(stateWith({ uuids: [['99999999-2222-4333-8444-555555555555', 0]] }));
  kv.m.set('state', next);
  assert.equal((await call(env, 'status')).stateHash, shortHashOf(next), 'status 读到的是 KV 的最新内容');
  const ws = await openWs(env);   // 这次 status 顺便刷新了本 isolate 的缓存：新 UUID 立即可用、旧的不再接受
  await ws.emit('message', { data: vlessReq('x.example', 443, TLS_HELLO).buffer });
  assert.equal(ws.closed.code, 1011);
});

test('出站方式 only：配置了出站代理时不用反代 / 落地 IP（它会绕过出站代理）；没配出站代理时落地 IP 照常使用', async () => {
  let log = fakeNet({ '198.51.100.7': { delay: 5 }, 'hop.example': { delay: 5 }, 'target.example': { delay: 5 } });
  let ws = await openWs(baseEnv({ set: { edgeIP: '198.51.100.7', hop: { type: 'socks5', host: 'hop.example', port: 1080 }, hopMode: 'only' } }));
  sendTls(ws, 'target.example');
  await until(() => log.length);
  assert.deepEqual(log.map(s => s.hostname), ['hop.example'], '只连出站代理');
  log = fakeNet({ '198.51.100.7': { delay: 5 }, 'target.example': { delay: 5 } });
  ws = await openWs(baseEnv({ set: { edgeIP: '198.51.100.7', hopMode: 'only' } }));
  await sendTls(ws, 'target.example');
  await until(() => log.some(s => s.written.length));
  assert.equal(log.find(s => s.written.length).hostname, '198.51.100.7');
  // 默认出站方式：落地 IP 仍然优先于出站代理（行为不变）
  log = fakeNet({ '198.51.100.7': { delay: 5 }, 'hop.example': { delay: 5 } });
  ws = await openWs(baseEnv({ set: { edgeIP: '198.51.100.7', hop: { type: 'socks5', host: 'hop.example', port: 1080 } } }));
  await sendTls(ws, 'target.example');
  await until(() => log.some(s => s.written.length));
  assert.equal(log.find(s => s.written.length).hostname, '198.51.100.7');
});

test('WS 首帧：请求头完整时，头部 + 大块数据（超过 64KB）照常转发（64KB 的限制只针对还不完整的请求头）', async () => {
  const log = fakeNet({ 'big.example': { delay: 5 } });
  const big = vlessReq('big.example', 443, [...TLS_HELLO, ...new Array(70000).fill(7)]);
  const ws = await openWs(baseEnv());
  await ws.emit('message', { data: big.buffer });
  await until(() => log.some(s => s.written.length));
  assert.equal(ws.closed, null);
  assert.equal(log[0].written.reduce((n, c) => n + c.byteLength, 0), TLS_HELLO.length + 70000);
  // 请求头不完整（域名只到一半）：继续等后续分片
  const head = vlessReq('x'.repeat(200), 443).slice(0, 25);
  const w2 = await openWs(baseEnv());
  await w2.emit('message', { data: head.buffer });
  assert.equal(w2.closed, null, '还在等后续分片');
});

test('机房 → 地区：台湾 / 澳门归 HK，东南亚 / 南亚 / 大洋洲归 SG，中东 / 非洲 / 南欧 / 东欧归 DE，北欧与英爱各归其地区；美洲与未知机房为 US；每个机房只属于一个地区', () => {
  const want = { TPE: 'HK', KHH: 'HK', MFM: 'HK', HKG: 'HK', BKK: 'SG', KUL: 'SG', MNL: 'SG', CGK: 'SG', SGN: 'SG', BOM: 'SG', DEL: 'SG', SYD: 'SG', AKL: 'SG',
    DXB: 'DE', TLV: 'DE', IST: 'DE', JNB: 'DE', CAI: 'DE', LIS: 'DE', ATH: 'DE', CPH: 'DE', OSL: 'SE', ARN: 'SE', BRU: 'NL', AMS: 'NL', TLL: 'FI', HEL: 'FI',
    DUB: 'GB', EDI: 'GB', LHR: 'GB', KIX: 'JP', GUM: 'JP', ICN: 'KR', PPT: 'US', LAX: 'US', GRU: 'US', YYZ: 'US', XYZ: 'US', '': 'US' };
  for (const [colo, region] of Object.entries(want)) assert.equal(internals.selectAltRegion(colo), region, colo);
  const seen = new Map();
  for (const [region, codes] of Object.entries(internals.COLO_REGIONS)) {
    for (const c of codes.split(' ')) {
      assert.match(c, /^[A-Z]{3}$/, region + ' 里的「' + c + '」');
      assert.ok(!seen.has(c), c + ' 同时出现在 ' + seen.get(c) + ' 与 ' + region);
      seen.set(c, region);
    }
  }
});

test('目标域名里有空白或控制字符（如 \\r\\n）时拒绝，不会被拼进发给 HTTP 出站代理的 CONNECT 请求', async () => {
  const log = fakeNet({ 'hop.example': { delay: 5 } });
  for (const host of ['a.com:443 HTTP/1.1\r\nX-Injected: yes\r\n\r\nGET /', 'bad host.example', 'tab\there.example']) {
    const ws = await openWs(baseEnv({ set: { hop: { type: 'http', host: 'hop.example', port: 8080 } } }));
    await ws.emit('message', { data: vlessReq(host, 443, TLS_HELLO).buffer });
    assert.deepEqual(ws.closed, { code: 1011, reason: '' }, JSON.stringify(host));
  }
  assert.equal(log.length, 0, '没有建立任何连接');
  assert.throws(() => internals.parseVssProtoHeader(new Uint8Array([0, ...uuidBytes, 0, 1, 1, 187, 2, 0, ...TLS_HELLO]), { uuids: [UUID] }), /目标域名不正确/, '空域名');
});

test('setState 校验出站代理的凭据：用户名与密码要么都有、要么都没有；按 UTF-8 字节数限制在 255 以内（SOCKS5 的长度字段只有 1 个字节）', () => {
  const hop = (extra) => stateWith({ hop: { type: 'socks5', host: 'hop.example', port: 1080, ...extra } });
  assert.equal(internals.checkState(hop({})), '');
  assert.equal(internals.checkState(hop({ user: 'u', pass: '' })), '');
  assert.equal(internals.checkState(hop({ user: 'é'.repeat(127), pass: 'p' })), '', '254 个字节');
  assert.equal(internals.checkState(hop({ user: 'u' })), 'hop 不正确', '有用户名没密码');
  assert.equal(internals.checkState(hop({ pass: 'p' })), 'hop 不正确', '有密码没用户名');
  assert.equal(internals.checkState(hop({ user: 'é'.repeat(200), pass: 'p' })), 'hop 不正确', '200 个字但 400 个字节');
  assert.equal(internals.checkState(hop({ user: 'u', pass: 'x'.repeat(256) })), 'hop 不正确');
});
