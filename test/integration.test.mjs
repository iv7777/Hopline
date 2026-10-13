// 面板与代理的端到端衔接：面板生成的节点链接，能被代理接受并转发（两个脚本之间只有这条 vless:// 链接）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const hooks = `
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
  }
  if (spec === 'cloudflare:sockets') {
    return { url: 'data:text/javascript,export function connect(a){ return globalThis.__connect(a); }', shortCircuit: true };
  }
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
globalThis.fetch = async () => { throw new Error('offline in tests'); };

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
  sock.readable = new ReadableStream({ type: 'bytes' });
  sock.close = () => {};
  return sock;
};

const proxyModule = await import('../Hopline-proxy.js');
const proxy = proxyModule.default;
const panel = (await import('../Hopline-panel.js')).default;

const PROXY_UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PROXY_HOST = 'edge.proxy-example.net';
const PROXY_PATH = 'tunnel-7';
const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };

test('面板里填写代理端点后生成的 vless 链接，可被代理（只配了 UUID 与 PATH）接受并转发', async () => {
  // 面板：环境变量只有 PATH / ADMIN，代理端点在面板里保存
  const penv = { PATH: 'my-panel', ADMIN: 'pw', CONFIG_KV: kv() };
  const loginRes = await panel.fetch(new Request('https://panel.example.org/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.7' },
    body: 'username=admin&password=pw&next=' + encodeURIComponent('/my-panel'),
  }), penv, {});
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('Set-Cookie').split(';')[0];
  const save = await panel.fetch(new Request('https://panel.example.org/my-panel/api/config', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host: PROXY_HOST, uuid: PROXY_UUID, nodePath: PROXY_PATH,
      src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false }, enableXhttp: true,
    }),
  }), penv, {});
  assert.equal(save.status, 200, await save.clone().text());
  // 优选来源全部关闭、原生地址开启：节点 server 就是代理域名本身
  const save2 = await panel.fetch(new Request('https://panel.example.org/my-panel/api/config', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ src: { native: true, prefDomain: false, prefIp: false } }),
  }), penv, {});
  assert.equal(save2.status, 200);
  const subRes = await panel.fetch(new Request(`https://panel.example.org/${PROXY_UUID}/sub/plain`, { headers: { 'User-Agent': 'v2rayN/7.0' } }), penv, {});
  assert.equal(subRes.status, 200);
  const links = (await subRes.text()).split('\n').filter(l => l.startsWith('vless://'));
  assert.ok(links.length >= 2, '原生地址下发 VLESS 与 XHTTP 两种节点');
  const urls = links.map(l => new URL(l.replace('vless://', 'http://')));
  for (const u of urls) {
    assert.equal(decodeURIComponent(u.username), PROXY_UUID);
    assert.equal(u.searchParams.get('sni'), PROXY_HOST);
    assert.equal(u.searchParams.get('host'), PROXY_HOST);
    assert.equal(u.searchParams.get('path').split('?')[0], '/' + PROXY_PATH);
  }
  const ws = urls.find(u => u.searchParams.get('type') === 'ws');
  const xh = urls.find(u => u.searchParams.get('type') === 'xhttp');
  assert.ok(ws && xh);

  // 代理：只有 UUID 与 PATH 两个环境变量，没有任何面板信息
  const xenv = { UUID: PROXY_UUID, PATH: PROXY_PATH };
  const upgrade = await proxy.fetch(new Request(`https://${PROXY_HOST}${ws.searchParams.get('path')}`, { headers: { Upgrade: 'websocket' } }), xenv, {});
  assert.equal(upgrade.status, 101, 'WebSocket 节点链接里的路径被代理接受（含 ?ed=2048）');
  const uuidBytes = PROXY_UUID.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16));
  const tls = [0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5];
  const host = 'target.example';
  const req = new Uint8Array([0, ...uuidBytes, 0, 1, 1, 187, 2, host.length, ...Buffer.from(host), ...tls]);
  await lastServer.emit('message', { data: req.buffer });
  for (let i = 0; i < 100 && !connections.some(c => c.written.length); i++) await new Promise(r => setTimeout(r, 10));
  const c = connections.find(x => x.written.length);
  assert.equal(c && c.hostname, host, '用链接里的 UUID 发起的请求被转发到目标');
  assert.deepEqual([...c.written[0]], tls);
  // XHTTP 节点链接的路径同样被代理接受
  const xhRes = await proxy.fetch(new Request(`https://${PROXY_HOST}${xh.searchParams.get('path')}`, { method: 'POST', body: new Uint8Array(req), duplex: 'half' }), xenv, {});
  assert.equal(xhRes.status, 200);
  assert.equal(xhRes.headers.get('content-type'), 'application/octet-stream');
  // 代理不接受面板路径，也不认识别的 UUID
  const wrongPath = await proxy.fetch(new Request(`https://${PROXY_HOST}/my-panel`, { headers: { Upgrade: 'websocket' } }), xenv, {});
  assert.notEqual(wrongPath.status, 101);
});

test('服务绑定：面板通过 PROXY 绑定读到真实代理的在线状态与版本；代理未配置好时面板显示配置问题', async () => {
  const login = async (penv) => {
    const res = await panel.fetch(new Request('https://panel.example.org/login', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.8' },
      body: 'username=admin&password=pw&next=' + encodeURIComponent('/my-panel'),
    }), penv, {});
    return res.headers.get('Set-Cookie').split(';')[0];
  };
  const status = async (proxyEnv) => {
    const penv = { PATH: 'my-panel', ADMIN: 'pw', CONFIG_KV: kv(), PROXY: new proxyModule.ProxyStatus({}, proxyEnv) };
    const res = await panel.fetch(new Request('https://panel.example.org/my-panel/api/proxy-status', { headers: { Cookie: await login(penv) } }), penv, {});
    return (await res.json()).data;
  };
  const good = await status({ UUID: PROXY_UUID, PATH: PROXY_PATH, OUTBOUND_PROXY: 'http://user:pw@1.2.3.4:8080' });
  assert.equal(good.up, true); assert.equal(good.ok, true);
  assert.equal(good.version, good.panelVersion, '两个脚本同一版本号');
  assert.equal(good.settings.outboundProxy, 'http');
  assert.ok(!JSON.stringify(good).includes('user:pw') && !JSON.stringify(good).includes(PROXY_UUID));
  const bad = await status({ PATH: PROXY_PATH });
  assert.equal(bad.up, true); assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' '), /UUID/);
});
