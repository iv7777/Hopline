// 面板与代理的端到端衔接：面板通过签名的 HTTPS 控制接口配置代理（生成并下发 UUID、启停、改设置），
// 面板生成的节点链接能被代理接受并转发；两个脚本之间没有服务绑定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const hooks = `
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:sockets') {
    return { url: 'data:text/javascript,export function connect(a){ return globalThis.__connect(a); }', shortCircuit: true };
  }
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
// 面板与代理之间只有 HTTPS：发往已挂载域名的 fetch 直接交给对应的代理脚本（测试里源码版与混淆版都挂载一次）
const MOUNTED = new Map();   // 域名 → { worker, env }
globalThis.fetch = async (url, opts = {}) => {
  const m = MOUNTED.get(new URL(String(url)).host);
  if (!m) throw new Error('offline in tests');
  return m.worker.fetch(new Request(url, opts), m.env, {});
};

// Workers 运行时对象的最小替身：WebSocketPair、101 响应、假 TCP 连接
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
const connections = [];
globalThis.__connect = ({ hostname, port }) => {
  const sock = { hostname, port, written: [] };
  connections.push(sock);
  sock.opened = Promise.resolve();
  sock.writable = new WritableStream({ write(c) { sock.written.push(new Uint8Array(c)); } });
  // 目标在连接后很快回一条 TLS 记录（首包看门狗要等到目标的首个数据；真实的目标都会先回数据）
  sock.readable = new ReadableStream({ type: 'bytes', start(c) { setTimeout(() => { try { c.enqueue(new Uint8Array([22, 3, 3, 0, 1, 0])); } catch (e) { /* 已关闭 */ } }, 5); } });
  sock.close = () => {};
  return sock;
};

const proxyModule = await import('../Hopline-proxy.js');
const proxy = proxyModule.default;
const panel = (await import('../Hopline-panel.js')).default;

const NODE_KEY = 'integration-node-key-0123456789ab';
const PROXY_HOST = 'edge.proxy-example.net';
const PROXY_PATH = 'tunnel-7';
const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };
// 代理上保存的状态（面板整份下发的）；uuid / prev 是方便断言的派生值
const state = (m) => { const st = JSON.parse(m.env.NODE_KV.m.get('state')); return Object.assign(st, { uuid: st.uuids[0][0], prev: st.uuids[1] ? st.uuids[1][0] : '' }); };

let loginSeq = 10;
async function panelSession() {
  const penv = { PATH: 'my-panel', ADMIN: 'pw', CONFIG_KV: kv() };
  const res = await panel.fetch(new Request('https://panel.example.org/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.' + (++loginSeq) },
    body: 'username=admin&password=pw&next=' + encodeURIComponent('/my-panel'),
  }), penv, {});
  assert.equal(res.status, 200);
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  const api = async (path, init = {}) => {
    const r = await panel.fetch(new Request('https://panel.example.org/my-panel/api/' + path, { ...init, headers: { Cookie: cookie, 'Content-Type': 'application/json' } }), penv, {});
    return { status: r.status, body: await r.json() };
  };
  return { penv, api };
}
const mount = (worker, extra = {}) => {
  const m = { worker, env: { PATH: PROXY_PATH, NODE_KEY, NODE_KV: kv(), ...extra } };
  MOUNTED.set(PROXY_HOST, m);
  return m;
};
const uuidBytes = (u) => u.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16));
const TLS = [0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5];
const reqFor = (uuid, host) => new Uint8Array([0, ...uuidBytes(uuid), 0, 1, 1, 187, 2, host.length, ...Buffer.from(host), ...TLS]);
const waitWritten = async () => { for (let i = 0; i < 100 && !connections.some(c => c.written.length); i++) await new Promise(r => setTimeout(r, 10)); return connections.find(c => c.written.length); };
const linksOf = async (penv, fmt = 'plain') => {
  const r = await panel.fetch(new Request(`https://panel.example.org/my-panel/sub/${fmt}`, { headers: { 'User-Agent': 'v2rayN/7.0' } }), penv, {});
  return { status: r.status, text: await r.text() };
};

test('面板添加代理（域名 / 节点路径 / 密钥）→ 自动生成 UUID 并下发 → 生成的 vless 链接可被代理接受并转发；停用后代理只显示 Hello World，启用后恢复', async () => {
  const m = mount(proxy);
  const { penv, api } = await panelSession();
  assert.equal((await api('config', {})).body.data.endpointMissing.length, 1, '还没有代理');
  const add = await api('proxies', { method: 'POST', body: JSON.stringify({ host: PROXY_HOST, nodePath: PROXY_PATH, key: NODE_KEY }) });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.data.sync.ok, true, JSON.stringify(add.body.data.sync));
  const uuid = add.body.data.proxy.uuid;
  assert.equal(state(m).uuid, uuid, 'UUID 由面板生成，保存在代理的 NODE_KV 里（代理没有 UUID 环境变量）');
  const id = add.body.data.proxy.id;
  // 优选来源全部关闭、原生地址开启：节点 server 就是代理域名本身
  const cfgSave = await api('config', { method: 'POST', body: JSON.stringify({ src: { native: true, prefDomain: false, prefIp: false }, enableXhttp: true }) });
  assert.equal(cfgSave.status, 200);
  const sub = await linksOf(penv);
  assert.equal(sub.status, 200);
  const links = sub.text.split('\n').filter(l => l.startsWith('vless://'));
  assert.ok(links.length >= 2, '原生地址下发 VLESS 与 XHTTP 两种节点');
  const urls = links.map(l => new URL(l.replace('vless://', 'http://')));
  for (const u of urls) {
    assert.equal(decodeURIComponent(u.username), uuid);
    assert.equal(u.searchParams.get('sni'), PROXY_HOST);
    assert.equal(u.searchParams.get('host'), PROXY_HOST);
    assert.equal(u.searchParams.get('path').split('?')[0], '/' + PROXY_PATH);
  }
  const ws = urls.find(u => u.searchParams.get('type') === 'ws');
  const xh = urls.find(u => u.searchParams.get('type') === 'xhttp');
  assert.ok(ws && xh);
  const connect = (path) => proxy.fetch(new Request(`https://${PROXY_HOST}${path}`, { headers: { Upgrade: 'websocket' } }), m.env, {});
  const upgrade = await connect(ws.searchParams.get('path'));
  assert.equal(upgrade.status, 101, 'WebSocket 节点链接里的路径被代理接受（含 ?ed=2048）');
  connections.length = 0;
  await lastServer.emit('message', { data: reqFor(uuid, 'target.example').buffer });
  const c = await waitWritten();
  assert.equal(c && c.hostname, 'target.example', '用链接里的 UUID 发起的请求被转发到目标');
  assert.deepEqual([...c.written[0]], TLS);
  const xhRes = await proxy.fetch(new Request(`https://${PROXY_HOST}${xh.searchParams.get('path')}`, { method: 'POST', body: reqFor(uuid, 'target.example'), duplex: 'half' }), m.env, {});
  assert.equal(xhRes.status, 200);
  assert.equal(xhRes.headers.get('content-type'), 'application/grpc');
  // 不认识别的 UUID，也不接受面板路径
  connections.length = 0;
  await connect('/' + PROXY_PATH); await lastServer.emit('message', { data: reqFor('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'other.example').buffer });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(connections.some(x => x.hostname === 'other.example'), false, '陌生 UUID 不被转发');
  assert.notEqual((await connect('/my-panel')).status, 101);
  // 停用：面板不再下发，代理对外只显示 Hello World
  const off = await api(`proxies/${id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal(off.body.data.synced, true);
  assert.equal((await linksOf(penv)).status, 400);
  const quiet = await connect(ws.searchParams.get('path'));
  assert.equal(quiet.status, 200); assert.match(await quiet.text(), /Hello World/);
  assert.match(await (await proxy.fetch(new Request(`https://${PROXY_HOST}/${PROXY_PATH}`, { method: 'POST', body: reqFor(uuid, 'target.example'), duplex: 'half' }), m.env, {})).text(), /Hello World/);
  const st = (await api('proxy-status')).body.data;
  assert.equal(st.up, true); assert.equal(st.enabled, false, '停用后控制接口仍可用，面板能看到状态');
  // 启用：恢复
  await api(`proxies/${id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal((await connect(ws.searchParams.get('path'))).status, 101);
  assert.equal((await linksOf(penv)).status, 200);
  // 更换 UUID：新 UUID 立即可用，旧 UUID 在宽限期内仍可用
  const rot = await api(`proxies/${id}/rotate`, { method: 'POST' });
  assert.equal(rot.status, 200);
  const fresh = rot.body.data.proxy.uuid;
  assert.notEqual(fresh, uuid);
  for (const [u, host] of [[fresh, 'new-uuid.example'], [uuid, 'old-uuid.example']]) {
    connections.length = 0;
    await connect('/' + PROXY_PATH); await lastServer.emit('message', { data: reqFor(u, host).buffer });
    assert.equal((await waitWritten()).hostname, host, host);
  }
});

test('面板里改代理设置：保存在面板的代理记录里，整份下发给代理（KV 里是面板发来的原文）→ 代理按新设置出站；备用线路表由面板下发；密钥不对时面板连不上', async () => {
  const m = mount(proxy);
  const { api } = await panelSession();
  const add = await api('proxies', { method: 'POST', body: JSON.stringify({ host: PROXY_HOST, nodePath: PROXY_PATH, key: NODE_KEY }) });
  const id = add.body.data.proxy.id, uuid = add.body.data.proxy.uuid;
  assert.equal(add.body.data.sync.status.inSync, true);
  const base = state(m);
  assert.deepEqual(base.altPick, ['auto'], '默认的备用线路选用方式');
  assert.equal(Object.keys(base.altTable).length, 14, '备用线路表来自面板（纯文本的默认表）');
  // 把线路换成自己的，再关闭备用线路
  assert.equal((await api('alt-routes', { method: 'POST', body: JSON.stringify({ text: 'mine panel-set.example:8443\n' }) })).status, 200);
  const all = await api('proxy-sync-all', { method: 'POST' });
  assert.equal(all.body.data.results[0].ok, true);
  assert.deepEqual(state(m).altTable, { mine: { host: 'panel-set.example', port: 8443 } });
  const saved = await api(`proxies/${id}`, { method: 'POST', body: JSON.stringify({ edgeIP: 'edge-set.example:8443', altMode: 'off', hopMode: '' }) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.sync.status.inSync, true);
  const st = state(m);
  assert.equal(st.edgeIP, 'edge-set.example:8443'); assert.deepEqual(st.altPick, []);
  assert.equal(st.uuid, uuid, '设置不影响 UUID');
  const status = (await api('proxy-status')).body.data;
  assert.equal(status.storage, true); assert.equal(status.provisioned, true); assert.equal(status.inSync, true);
  // 代理按新状态工作：altPick 为空 → 目标直连失败后不尝试任何备用线路（落地 IP 先试，也失败）
  const upgrade = await proxy.fetch(new Request(`https://${PROXY_HOST}/${PROXY_PATH}`, { headers: { Upgrade: 'websocket' } }), m.env, {});
  assert.equal(upgrade.status, 101);
  connections.length = 0;
  const working = globalThis.__connect;
  globalThis.__connect = ({ hostname, port }) => { connections.push({ hostname, port }); throw new Error('refused'); };
  await lastServer.emit('message', { data: reqFor(uuid, 'nowhere.example').buffer });
  await new Promise(r => setTimeout(r, 80));
  globalThis.__connect = working;
  assert.ok(connections.length >= 1 && connections.every(c => c.hostname === 'nowhere.example' || c.hostname === 'edge-set.example'), '没有尝试任何备用线路：' + JSON.stringify(connections));
  // 恢复默认（面板里的「恢复默认」）
  const reset = await api(`proxies/${id}`, { method: 'POST', body: JSON.stringify({ edgeIP: '', hop: '', hopMode: '', altMode: 'auto', altCustom: '' }) });
  assert.equal(reset.status, 200);
  assert.equal(state(m).edgeIP, ''); assert.deepEqual(state(m).altPick, ['auto']);
  // 代理上的 NODE_KEY 被改过：面板连不上，给出可读的原因
  m.env.NODE_KEY = 'changed-key-0123456789-abcdefghij';
  const lost = await api('proxy-status');
  assert.equal(lost.body.data.up, false); assert.match(lost.body.data.error, /没有响应控制请求/);
});

test('混淆版代理脚本（顶层名字也已改名）功能不变：面板同样能连接、下发 UUID，WebSocket 与 XHTTP 都能转发，在线设置生效', async () => {
  const obf = await import('../obf_Hopline-proxy.js?e2e');
  assert.deepEqual(Object.keys(obf), ['default']);
  const m = mount(obf.default);
  const { api } = await panelSession();
  const add = await api('proxies', { method: 'POST', body: JSON.stringify({ host: PROXY_HOST, nodePath: PROXY_PATH, key: NODE_KEY }) });
  assert.equal(add.body.data.sync.ok, true, JSON.stringify(add.body.data.sync));
  const uuid = add.body.data.proxy.uuid;
  assert.equal(state(m).uuid, uuid);
  // WebSocket
  connections.length = 0;
  const up = await obf.default.fetch(new Request(`https://${PROXY_HOST}/${PROXY_PATH}?ed=2048`, { headers: { Upgrade: 'websocket' } }), m.env, {});
  assert.equal(up.status, 101);
  await lastServer.emit('message', { data: reqFor(uuid, 'obf-ws.example').buffer });
  const ws = await waitWritten();
  assert.equal(ws && ws.hostname, 'obf-ws.example');
  assert.deepEqual([...ws.written[0]], TLS);
  // XHTTP
  connections.length = 0;
  const xh = await obf.default.fetch(new Request(`https://${PROXY_HOST}/${PROXY_PATH}`, { method: 'POST', body: reqFor(uuid, 'obf-xh.example'), duplex: 'half' }), m.env, {});
  assert.equal(xh.status, 200);
  assert.equal((await waitWritten()).hostname, 'obf-xh.example');
  // 伪装页与错误路径
  for (const path of ['/', '/other', '/status']) assert.match(await (await obf.default.fetch(new Request(`https://${PROXY_HOST}${path}`), m.env, {})).text(), /Hello World/);
  // 设置下发与停用
  const saved = await api(`proxies/${add.body.data.proxy.id}`, { method: 'POST', body: JSON.stringify({ edgeIP: 'saved-edge.example', altMode: 'off', hop: 'socks5://u:p@10.0.0.1:1080', hopMode: 'only' }) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.sync.status.inSync, true);
  assert.deepEqual([state(m).edgeIP, state(m).altPick, state(m).hop, state(m).hopMode], ['saved-edge.example', [], { type: 'socks5', host: '10.0.0.1', port: 1080, user: 'u', pass: 'p' }, 'only']);
  const off = await api(`proxies/${add.body.data.proxy.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal(off.body.data.synced, true);
  assert.match(await (await obf.default.fetch(new Request(`https://${PROXY_HOST}/${PROXY_PATH}`, { headers: { Upgrade: 'websocket' } }), m.env, {})).text(), /Hello World/);
});

test('源码与混淆版都没有协议 / 代理角色的名字：去掉注释后，标识符与字符串里不再出现 vless、xhttp、proxy、relay、outbound、shadowsocks、tunnel 等词（协议规定必须原样出现的字面量除外）', async () => {
  const { stripJsComments } = await import('../build.mjs');
  const { readFileSync } = await import('node:fs');
  const words = /vless|vmess|xhttp|proxy|relay|outbound|shadow|trojan|tunnel|cmliussss|edtunnel|sniff/i;
  const code = stripJsComments(readFileSync(new URL('../Hopline-proxy.js', import.meta.url), 'utf8'));
  // 允许出现的：HTTP 协议要求的头名、用户输入的 socks5:// 写法提示（含中文「出站代理」一词的校验提示）
  const allowed = [/^'Proxy-Authorization: Basic '$/, /^'无法解析出站代理地址（格式如 socks5:\/\/user:pass@1\.2\.3\.4:1080）'$/];
  const tokens = code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|[A-Za-z_$][\w$]*/g) || [];
  const bad = [...new Set(tokens.filter(t => words.test(t) && !allowed.some(a => a.test(t))))];
  assert.deepEqual(bad, [], '去掉注释后仍含这些词：' + bad.join(' | '));
  const obf = readFileSync(new URL('../obf_Hopline-proxy.js', import.meta.url), 'utf8');
  assert.ok(!/Hopline|vless|xhttp|cmliussss|edtunnel/i.test(obf), '混淆版里没有项目名、横幅或协议名');
  assert.ok(!obf.includes('handleWsProto') && !obf.includes('openUpstream') && !obf.includes('resolveEdgeIPs'), '混淆版顶层函数名已改名');
});
