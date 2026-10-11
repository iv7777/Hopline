// 管理面板与配置接口测试（node:test，无第三方依赖）：直接加载构建产物 Hopline.js，
// 用内存 Map 模拟 KV、桩替换 cloudflare:sockets 与外网 fetch。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// cloudflare:sockets 仅存在于 Workers 运行时：测试中替换为不可用的桩
const hooks = `
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:sockets') {
    // 默认不可用；出站测试通过 globalThis.__connect 注入可控的假连接
    return { url: 'data:text/javascript,export function connect(a){ if (globalThis.__connect) return globalThis.__connect(a); throw new Error("sockets unavailable in tests"); }', shortCircuit: true };
  }
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
// 订阅生成会拉取外部优选源：测试环境一律离线，走各处的失败兜底
// 面板页面由 Worker 运行时按版本标签从 GitHub 拉取：默认让这类请求返回本地的 dist/panel.html（SHA-256 与构建时写入 Worker 的一致），其余一律离线
import { readFileSync } from 'node:fs';
const PANEL_FILE = readFileSync(new URL('../dist/panel.html', import.meta.url));
// Clash 配置模板同理：运行时按版本标签拉取，测试里默认返回本地的 dist/clash-template.yaml（withFetch 里也一样，除非用例把 CLASH_FROM_LOCAL 关掉来模拟拉取失败）
const CLASH_FILE = readFileSync(new URL('../dist/clash-template.yaml', import.meta.url));
let CLASH_FROM_LOCAL = true;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/dist/panel.html')) return new Response(PANEL_FILE);
  if (String(url).endsWith('/dist/clash-template.yaml')) return new Response(CLASH_FILE);
  throw new Error('offline in tests');
};

const worker = (await import('../Hopline.js')).default;

const UUID = '11111111-2222-4333-8444-555555555555';
const UUID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64)';

function kv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}
const stored = (env) => JSON.parse(env.CONFIG_KV.m.get('config'));

async function call(env, path, { method = 'GET', body, cookie, ua = BROWSER, headers = {} } = {}) {
  const h = { 'User-Agent': ua, ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined && typeof body !== 'string') { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  return worker.fetch(new Request('https://node.example.com' + path, { method, headers: h, body, redirect: 'manual' }), env, {});
}
async function login(env, password = 'pw', panelPath = UUID, username = 'admin') {
  const res = await call(env, '/login', {
    method: 'POST', body: 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password) + '&next=' + encodeURIComponent('/' + panelPath),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.' + Math.floor(Math.random() * 250) },
  });
  assert.equal(res.status, 200, 'login should succeed');
  return res.headers.get('Set-Cookie').split(';')[0];
}
const baseEnv = (extra = {}) => ({ UUID, PATH: UUID, ADMIN: 'pw', CONFIG_KV: kv(), ...extra });   // PATH、ADMIN 必填；路径取 UUID 的值，使 /<UUID> 即面板入口
// 固定节点列表：把若干 `IP:端口#名称` 行托管为「自定义优选 API 1」的响应（默认模式下唯一的节点来源），测试里用它精确控制节点
const NODE_LISTS = new Map();
const fixedNodes = (lines, extra = {}) => {
  const url = 'https://nodes.test/' + createHash('md5').update(lines).digest('hex') + '.txt';
  NODE_LISTS.set(url, lines);
  return { src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false, api1: true, api1Url: url }, filter: { ipType: ['IPv4'] }, enableXhttp: false, ...extra };
};
const nodesFetch = (u) => NODE_LISTS.has(u) ? new Response(NODE_LISTS.get(u)) : new Response('Not Found', { status: 404 });

test('GET /api/config 返回字段表默认值（与旧 DEFAULT_CONFIG 一致）及派生信息', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const r = await (await call(env, `/${UUID}/api/config`, { cookie })).json();
  assert.equal(r.ok, true);
  const d = r.data;
  // 默认值（filter.region 为 ['all']，src 为面板保存的地址来源默认值）；XHTTP 默认开启，IP 类型默认只有 IPv4
  const legacy = {
    host: '', enableVless: true, enableXhttp: true,
    alpn: '', ech: false, echHost: 'cloudflare-ech.com', echDns: '', tlsOnly: true,
    proxyIP: '', outboundProxy: '', outboundMode: '',
    filter: { region: ['all'], ipType: ['IPv4'], isp: ['移动', '联通', '电信'] },
    src: { native: false, prefDomain: true, prefIp: true },
  };
  for (const [k, v] of Object.entries(legacy)) assert.deepEqual(d[k], v, k);
  for (const k of ['optimizer', 'preferredDomains', 'preferredIPs']) assert.equal(k in d, false, `已移除的自定义订阅 / 随机优选配置 ${k}`);
  assert.equal(d.uuid, UUID);
  assert.equal(d.path, UUID, '面板路径来自环境变量 PATH');
  assert.equal(d.panelPath, UUID);
  assert.equal(d.adminSet, true);
  assert.equal('admin' in d, false, '不下发管理密码');
  assert.deepEqual(d.envLocked, { path: 'PATH', admin: 'ADMIN' }, 'PATH 与 ADMIN 来自环境变量，面板只读');
  for (const k of ['nodeLimit', 'nodeLimitCount', 'polling', 'cfAccountId', 'cfApiToken', 'cfApiTokenSet', 'quotaAuto', 'caps']) assert.equal(k in d, false, `已移除的配额安全字段 ${k}`);
  assert.equal(d.ipsrc.uouin, true, 'uouin 默认开启');
  assert.equal(d.ipsrc.wetest, false, '微测网默认关闭');
});

test('保存空 / 非法 UUID 被拒绝并返回字段级错误（问题 1）', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  for (const bad of ['', 'not-a-uuid']) {
    const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { uuid: bad } });
    assert.equal(res.status, 400);
    const r = await res.json();
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].field, 'uuid');
  }
  assert.equal(env.CONFIG_KV.m.has('config'), false, '校验失败不写 KV');
});

test('KV 中残留非法 UUID 时回退环境变量 U，面板仍可进入（问题 1）', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: { uuid: '', path: '' } }) });
  const cookie = await login(env);
  const res = await call(env, `/${UUID}/api/config`, { cookie });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.uuid, UUID);
});

test('字段校验：范围、枚举、格式、全部协议关闭', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const cases = [
    [{ subUrl: 'a/b' }, 'subUrl'],
    [{ subUrl: 'login' }, 'subUrl'],
    [{ subUrl: 'version' }, 'subUrl'],
    [{ host: 'bad host' }, 'host'],
    [{ outboundProxy: 'ss://rc4:pw@1.2.3.4:8388' }, 'outboundProxy'],
    [{ prefDomains: 'a.example.com:443' }, 'prefDomains'],
    [{ filter: { region: ['XX'] } }, 'filter.region'],
    [{ enableVless: false, enableXhttp: false }, 'enableVless'],
  ];
  for (const [body, field] of cases) {
    const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    const r = await res.json();
    assert.ok(r.errors.some(e => e.field === field), `${JSON.stringify(body)} → ${JSON.stringify(r.errors)}`);
  }
});

test('保存只写入字段表登记的配置项，规范化取值，忽略未知与内部字段（问题 8）', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const res = await call(env, `/${UUID}/api/config`, {
    method: 'POST', cookie,
    body: {
      admin: 'new-secret', _quotaCap: 1, version: '9.9.9', fragment: 'x', src: { customPref: true, native: true },
      optimizer: { subRandomCount: '30', subMode: 'random' }, nodeLimitCount: 300, subUrl: '/AAZ/sub', host: 'https://Node.Example.com/path', filter: { region: ['all', 'HK'] },
      preferredIPs: [{ ip: '[2606:4700::1]', port: '8443', name: ' 香港 ' }], preferredDomains: 'x.example.com',
    },
  });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  const s = stored(env);
  assert.equal('admin' in s, false, 'ADMIN 由环境变量提供时不写入 KV');
  for (const k of ['_quotaCap', 'version', 'fragment']) assert.equal(k in s, false, k);
  assert.equal('customPref' in s.src, false);
  assert.equal(s.src.native, true);
  for (const k of ['optimizer', 'preferredIPs', 'preferredDomains']) assert.equal(k in s, false, `${k}（已移除的自定义订阅 / 随机优选配置）不写入`);
  assert.equal('nodeLimitCount' in s, false, '已移除的字段不写入');
  assert.equal(s.subUrl, 'AAZ');
  assert.equal(s.host, 'Node.Example.com');
  assert.deepEqual(s.filter.region, ['all']);
  assert.ok(r.ignored.includes('admin') && r.ignored.includes('_quotaCap') && r.ignored.includes('src.customPref') && r.ignored.includes('nodeLimitCount'));
  assert.ok(r.ignored.includes('optimizer') && r.ignored.includes('preferredIPs') && r.ignored.includes('preferredDomains'));
  assert.equal(r.data.src.native, true, '响应直接反映刚保存的配置');
});

test('未绑定 KV 时保存返回明确错误（问题 10）', async () => {
  const env = baseEnv({ CONFIG_KV: undefined });
  const cookie = await login(env);
  const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { alpn: 'h2' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).msg, /KV/);
});

test('修改 UUID：重新签发登录态；面板路径来自 PATH，不随 UUID 变化（问题 2）', async () => {
  const env = baseEnv({ ADMIN: undefined, CONFIG_KV: kv({ config: { admin: 'pw' } }) });
  const cookie = await login(env);
  const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { uuid: UUID2.toUpperCase() } });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  assert.equal(r.data.uuid, UUID2);
  assert.equal(r.data.panelPath, UUID, '面板路径来自 PATH，不随 UUID 变化');
  const newCookie = res.headers.get('Set-Cookie');
  assert.ok(newCookie && newCookie.startsWith('hopline_auth='));
  const again = await call(env, `/${UUID}/api/config`, { cookie: newCookie.split(';')[0] });
  assert.equal(again.status, 200, '新令牌可直接访问面板');
  const old = await call(env, `/${UUID}/api/config`, { cookie });
  assert.equal(old.status, 403, '旧令牌随 UUID 变更失效');
});

test('登录会话：使用面板时顺延 24 小时（10 分钟内不重复签发），24 小时未使用失效，自登录起最长 7 天；旧格式令牌失效', async () => {
  const realNow = Date.now;
  let off = 0;
  Date.now = () => realNow() + off;
  try {
    const env = baseEnv();
    const H = 3600 * 1000;
    const api = (cookie) => call(env, `/${UUID}/api/config`, { cookie });
    const cookieOf = (res) => (res.headers.get('Set-Cookie') || '').split(';')[0];
    const maxAge = (res) => Number(((res.headers.get('Set-Cookie') || '').match(/Max-Age=(\d+)/) || [])[1]);
    let cookie = await login(env);
    assert.equal(cookie.split('=')[1].split('.').length, 3, '令牌含过期时间与登录时间');
    // 5 分钟后使用：有效期只会延长 5 分钟，不重新签发
    off = 5 * 60 * 1000;
    let r = await api(cookie);
    assert.equal(r.status, 200); assert.equal(r.headers.get('Set-Cookie'), null);
    // 2 小时后使用：重新签发，有效期为此刻起 24 小时
    off = 2 * H;
    r = await api(cookie);
    assert.equal(r.status, 200);
    assert.ok(Math.abs(maxAge(r) - 86400) <= 2, 'Max-Age ≈ 24h');
    const old = cookie;
    cookie = cookieOf(r);
    // 原令牌在其自身有效期内仍可用；顺延后的令牌在原令牌过期后仍可用
    off = 25 * H;
    assert.equal((await api(old)).status, 403, '24 小时未使用的令牌失效');
    r = await api(cookie);
    assert.equal(r.status, 200, '顺延后的令牌仍有效');
    cookie = cookieOf(r) || cookie;
    // 每天使用一次（间隔 23 小时）：一直有效，直到登录满 7 天
    for (let d = 1; d <= 6; d++) { off = 25 * H + d * 23 * H; r = await api(cookie); assert.equal(r.status, 200, '第 ' + d + ' 次'); cookie = cookieOf(r) || cookie; }
    off = 6.9 * 24 * H;
    r = await api(cookie);
    assert.equal(r.status, 200);
    if (r.headers.get('Set-Cookie')) { assert.ok(maxAge(r) <= 0.1 * 24 * 3600 + 2, '续期不超过登录后 7 天'); cookie = cookieOf(r); }
    off = 7 * 24 * H + 60 * 1000;
    assert.equal((await api(cookie)).status, 403, '登录满 7 天必须重新登录');
    // 旧格式（过期时间.签名）令牌不再接受
    off = 0;
    assert.equal((await api('hopline_auth=' + (realNow() + H) + '.deadbeef')).status, 403);
    // 退出登录：响应自己的清除 Cookie 不被续期覆盖
    cookie = await login(env);
    off = 2 * H;
    const out = await call(env, `/${UUID}/api/logout`, { method: 'POST', cookie });
    assert.match(out.headers.get('Set-Cookie'), /hopline_auth=; .*Max-Age=0/);
  } finally { Date.now = realNow; }
});

test('默认配置的订阅：含 XHTTP 节点（.X），不含 IPv6 地址', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: fixedNodes('104.16.9.1:443#a\n[2606:4700::1]:443#v6', { enableXhttp: undefined, filter: undefined }) }) });
  const links = await withFetch(nodesFetch, async () => (await (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text()).split('\n').filter(Boolean));
  assert.deepEqual(links.map(nameOf), ['a', 'a.X']);
  assert.ok(/type=xhttp/.test(links[1]));
});

test('必填环境变量：PATH 未设置 / 非法时所有请求返回 503 设置说明；PATH 首尾斜杠自动去掉', async () => {
  const text = async (env, path = '/', init) => { const r = await call(env, path, init); return [r.status, await r.text()]; };
  // 未设置 PATH：任何路径（含 /<UUID> 与 /login）都返回设置说明，且不泄露配置
  const none = baseEnv({ PATH: undefined });
  for (const path of ['/', `/${UUID}`, `/${UUID}/sub`, '/login', '/anything']) {
    const [status, body] = await text(none, path);
    assert.equal(status, 503, path);
    assert.match(body, /PATH/); assert.match(body, /ADMIN/);
    assert.ok(!body.includes(UUID), '说明里不含 UUID');
  }
  // 非法 PATH：说明具体原因
  for (const [bad, reason] of [['a/b', /只能包含/], ['bad path', /只能包含/], ['login', /保留路径/], ['Version', /保留路径/], ['x'.repeat(129), /最长 128/]]) {
    const [status, body] = await text(baseEnv({ PATH: bad }), '/');
    assert.equal(status, 503, bad); assert.match(body, /PATH 的值不正确/); assert.match(body, reason, bad);
  }
  // 首尾斜杠自动去掉
  const env = baseEnv({ PATH: '/mypanel/' });
  const cookie = await login(env, 'pw', 'mypanel');
  assert.equal((await call(env, '/mypanel', { cookie })).status, 200);
  assert.equal((await call(env, '/mypanel/api/config', { cookie })).status, 200);
  // ADMIN 未设置：面板与管理接口禁用（节点与订阅不受影响）
  const noAdmin = baseEnv({ ADMIN: undefined });
  const [st, body] = await text(noAdmin, `/${UUID}`);
  assert.equal(st, 403); assert.match(body, /ADMIN/);
});

test('面板路径只认 PATH：节点路径为 /<PATH>，UUID 仅作节点身份；订阅仍可从 /<UUID>/sub 取得', async () => {
  const env = baseEnv({ PATH: 'mypanel', CONFIG_KV: kv({ config: customCfg() }) });
  assert.equal((await call(env, `/${UUID}`, { ua: BROWSER })).status, 200, 'UUID 路径不是面板入口（返回伪装页）');
  assert.equal((await call(env, '/mypanel', { ua: BROWSER })).status, 302, '面板入口在 PATH 下，未登录跳转登录页');
  const links = await withFetch(nodesFetch, async () => (await (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text()).split('\n').filter(l => /^vless:\/\//.test(l)));
  assert.ok(links.length > 0);
  assert.ok(links.every(l => l.includes(`@`) && l.startsWith(`vless://${UUID}@`)), 'UUID 作为用户 ID');
  assert.ok(links.every(l => /path=%2Fmypanel(%3F|&)/.test(l)), '节点 ws 路径为 /<PATH>');
  // WebSocket 代理在 /<PATH> 下工作，/<UUID> 下不是代理入口
  const log = fakeNet({ 'ws.example': { delay: 5 } });
  const res = await worker.fetch(new Request('https://node.example.com/mypanel', { headers: { Upgrade: 'websocket' } }), env, {});
  assert.equal(res.status, 101);
  const res2 = await worker.fetch(new Request(`https://node.example.com/${UUID}`, { headers: { Upgrade: 'websocket' } }), env, {});
  assert.notEqual(res2.status, 101);
  assert.equal(log.length, 0);
});

test('绑定域名留空时 SNI / Host 取访问域名；填写后用绑定域名（链接、Clash、sing-box 均如此）', async () => {
  const sub = (env, ua, fmt = '') => withFetch(nodesFetch, async () => (await (await call(env, `/${UUID}/sub${fmt}`, { ua })).text()));
  const blank = baseEnv({ CONFIG_KV: kv({ config: customCfg() }) });
  const links = (await sub(blank, 'v2rayN/7.0')).split('\n').filter(l => /^vless:\/\//.test(l));
  assert.ok(links.length > 0);
  for (const l of links) {
    assert.match(l, /[?&]sni=node\.example\.com(&|#)/, l);
    assert.match(l, /[?&]host=node\.example\.com(&|#)/, l);
  }
  assert.match(await sub(blank, 'clash.meta', '?fmt=clash'), /servername: node\.example\.com/);
  assert.match(await sub(blank, 'sing-box/1.9', '?fmt=singbox'), /"server_name":\s*"node\.example\.com"/);
  const bound = baseEnv({ CONFIG_KV: kv({ config: customCfg({ host: 'sub.example.org' }) }) });
  for (const l of (await sub(bound, 'v2rayN/7.0')).split('\n').filter(l => /^vless:\/\//.test(l))) {
    assert.match(l, /[?&]sni=sub\.example\.org(&|#)/, l);
    assert.match(l, /[?&]host=sub\.example\.org(&|#)/, l);
  }
});

test('UUID 可选：未设置时首次访问随机生成并保存到 KV，之后一直沿用，面板可查看与修改；保留 KV 中已有的其它设置', async () => {
  const env = baseEnv({ UUID: undefined, CONFIG_KV: kv({ config: { alpn: 'h2' } }) });
  const cookie = await login(env);
  const stored1 = stored(env);
  assert.match(stored1.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, '生成 v4 UUID 并写入 KV');
  assert.equal(stored1.alpn, 'h2', '已有设置保留');
  const get = async () => (await (await call(env, `/${UUID}/api/config`, { cookie })).json()).data;
  const d1 = await get(), d2 = await get();
  assert.equal(d1.uuid, stored1.uuid); assert.equal(d2.uuid, stored1.uuid, '每次请求相同');
  const subUuid = async () => (await (await call(env, `/${stored1.uuid}/sub`, { ua: 'v2rayN/7.0' })).text()).match(/^vless:\/\/([0-9a-f-]+)@/m)[1];
  assert.equal(await withFetch(notFound, subUuid), stored1.uuid, '订阅使用生成的 UUID');
  // 面板里修改后以新值为准，不再重新生成
  const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { uuid: UUID2 } });
  assert.equal(res.status, 200);
  assert.equal(stored(env).uuid, UUID2);
  const renewed = res.headers.get('Set-Cookie').split(';')[0];   // 修改 UUID 后旧登录态失效，当前会话已续签
  assert.equal((await (await call(env, `/${UUID}/api/config`, { cookie: renewed })).json()).data.uuid, UUID2);
  // 同一实例的并发首次请求不会各生成一个
  const env2 = baseEnv({ UUID: undefined, CONFIG_KV: kv() });
  const ids = await Promise.all([1, 2, 3, 4].map(async () => (await (await call(env2, `/${UUID}`, { ua: BROWSER })).text(), stored(env2).uuid)));
  assert.equal(new Set(ids).size, 1);
});

test('UUID 可选的前提：没有 KV 就没处保存自动生成的 UUID，必须手动设置（返回 503 说明）；设置了则不需要 KV', async () => {
  const noKv = baseEnv({ UUID: undefined, CONFIG_KV: undefined });
  const r = await call(noKv, '/', {});
  assert.equal(r.status, 503);
  const body = await r.text();
  assert.match(body, /CONFIG_KV/); assert.match(body, /UUID/);
  // 手动设置 UUID 后无需 KV
  const ok = baseEnv({ CONFIG_KV: undefined });
  const cookie = await login(ok);
  assert.equal((await call(ok, `/${UUID}/api/config`, { cookie })).status, 200);
});

test('环境变量：使用当前名称；旧版短变量名（U / D / S / K / ECH / OUTBOUND / admin）不再识别', async () => {
  const read = async (env, path) => {
    const cookie = await login(env, 'pw', path);
    return (await (await call(env, `/${path}/api/config`, { cookie })).json()).data;
  };
  const base = { UUID: undefined, PATH: undefined, ADMIN: 'pw', CONFIG_KV: kv() };
  const a = await read({ ...base, UUID: UUID2, PATH: 'newpath', OUTBOUND_PROXY: 'socks5://1.2.3.4:1080', ENABLE_ECH: 'true' }, 'newpath');
  assert.equal(a.uuid, UUID2); assert.equal(a.outboundProxy, 'socks5://1.2.3.4:1080'); assert.equal(a.ech, true);
  assert.equal(a.envLocked.path, 'PATH');
  // 旧名称被忽略：UUID 另行生成、出站代理与 ECH 保持默认
  const b = await read({ ...base, PATH: 'p1', U: UUID2, OUTBOUND: 'socks5://2.2.2.2:2', S: 'socks5://3.3.3.3:3', ECH: 'true' }, 'p1');
  assert.notEqual(b.uuid, UUID2); assert.equal(b.outboundProxy, ''); assert.equal(b.ech, false);
  // 旧名 D / admin 不再提供 PATH / ADMIN：面板仍未配置，无法登录
  const unconfigured = baseEnv({ PATH: undefined, ADMIN: undefined, D: 'oldpath', admin: 'pw', CONFIG_KV: kv() });
  assert.equal((await call(unconfigured, '/oldpath', {})).status === 200, false);
  // KV 绑定只认 CONFIG_KV：旧名 K 不再绑定，面板显示未绑定
  const viaOld = baseEnv({ CONFIG_KV: undefined, K: kv({ config: { alpn: 'h2' } }) });
  const o = await read(viaOld, UUID);
  assert.equal(o.kv, false); assert.equal(o.alpn, '');
});

test('环境变量锁定的字段在面板只读、保存时忽略（问题 3）', async () => {
  const env = baseEnv({ PATH: 'panel' });
  const cookie = await login(env, 'pw', 'panel');
  const r = await (await call(env, '/panel/api/config', { cookie })).json();
  assert.deepEqual(r.data.envLocked, { path: 'PATH', admin: 'ADMIN' });
  const res = await call(env, '/panel/api/config', { method: 'POST', cookie, body: { path: 'other' } });
  const s = await res.json();
  assert.equal(res.status, 200);
  assert.equal(s.data.panelPath, 'panel');
  assert.equal('path' in stored(env), false);
});

test('订阅别名只输出订阅，不开放面板 / 管理接口（问题 6）', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: { subUrl: 'AAZ', filter: { ipType: ['IPv4'] } } }) });
  const cookie = await login(env);
  const sub = await call(env, '/AAZ/sub', { ua: 'v2rayN/7.0' });
  assert.equal(sub.status, 200);
  assert.match(await sub.text(), /^vless:\/\//m);
  assert.equal((await call(env, '/AAZ', { cookie })).status, 200, '别名下不提供面板');
  assert.equal((await call(env, '/AAZ/api/config', { cookie })).status, 200, '别名下不提供管理接口');
  assert.equal((await call(env, `/${UUID}`, { cookie })).status, 200, '面板路径不受影响');
});

test('自定义订阅路径留空：订阅地址为 /<UUID>/sub（面板路径自定义时同样如此），面板路径下的 /sub 继续可用；UUID 路径下不开放面板 / 管理接口', async () => {
  const env = baseEnv({ PATH: 'panel', CONFIG_KV: kv({ config: { filter: { ipType: ['IPv4'] } } }) });
  const cookie = await login(env, 'pw', 'panel');
  for (const p of [`/${UUID}/sub`, '/panel/sub', `/${UUID}/sub/clash`]) {
    const r = await call(env, p, { ua: 'v2rayN/7.0' });
    assert.equal(r.status, 200, p);
  }
  assert.match(await (await call(env, `/${UUID}`, { ua: 'v2rayN/7.0' })).text(), /^vless:\/\//m, '客户端 UA 访问 /<UUID> 同样得到订阅');
  assert.equal((await call(env, `/${UUID}`, { cookie })).status, 200, 'UUID 路径下不提供面板');
  assert.equal((await call(env, `/${UUID}/api/config`, { cookie })).status, 200, 'UUID 路径下不提供管理接口');
  assert.equal((await call(env, '/panel', { cookie })).status, 200, '面板路径不受影响');
  // 设置了自定义订阅路径：UUID 不再作为订阅入口（面板路径与 UUID 不同时）
  const env2 = baseEnv({ PATH: 'panel', CONFIG_KV: kv({ config: { subUrl: 'AAZ' } }) });
  assert.equal((await call(env2, '/AAZ/sub', { ua: 'v2rayN/7.0' })).status, 200);
  assert.equal((await call(env2, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).status, 200);
});

test('预览与订阅同一流程：返回节点数，订阅不写 KV（问题 7）', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `104.16.1.${i + 1}:443#n${i + 1}`).join('\n');
  const env = baseEnv({ CONFIG_KV: kv({ config: fixedNodes(lines) }) });
  const cookie = await login(env);
  await withFetch(nodesFetch, async () => {
    const r = await (await call(env, `/${UUID}/api/sub?fmt=v2ray`, { cookie })).json();
    assert.equal(r.ok, true);
    assert.equal(r.count, 10);
    assert.equal(r.body.trim().split('\n').length, 10);
    const sub = await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' });
    assert.equal((await sub.text()).trim().split('\n').length, 10);
  });
  assert.deepEqual([...env.CONFIG_KV.m.keys()], ['config'], '订阅不再写入轮询窗口（issued）');
});

test('面板页面注入字段表与共用校验函数', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const res = await call(env, `/${UUID}`, { cookie });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(html.includes('@HOPLINE_'), false, '占位符均已替换');
  const schemaJson = html.match(/var SCHEMA = (\[.*?\]) \|\| \[\];/s);
  assert.ok(schemaJson, '字段表已注入');
  const schema = JSON.parse(schemaJson[1]);
  assert.ok(schema.some(d => d.key === 'uuid' && d.el === 'a-uuid'));
  assert.ok(schema.every(d => !('check' in d)), '仅服务端属性不下发');
  // 注入的校验函数可在页面独立执行（不依赖外部变量）；用下一条语句（var SCHEMA_BY_KEY = {};）定位结尾，
  // 不假设函数源码是单行（Hopline.js 不再经 terser 压缩，toString() 下来的是原始多行格式）
  const src = html.match(/var sharedCheck = ([\s\S]+?);\nvar SCHEMA_BY_KEY = \{\};/);
  assert.ok(src, '校验函数已注入');
  const check = new Function('return ' + src[1])();
  assert.deepEqual(check({ type: 'int', min: 1, max: 99 }, '42'), { value: 42 });
  assert.ok(check({ type: 'int', min: 1, max: 99 }, '500').error);
  assert.ok(check(schema.find(d => d.key === 'uuid'), 'x').error);
  // 页面中的每个字段控件都存在
  for (const d of schema) {
    for (const id of [d.el, ...Object.values(d.els || {})].filter(Boolean)) assert.ok(html.includes(`id="${id}"`), `缺少控件 #${id}（${d.key}）`);
  }
});

test('检测更新：以仓库 Hopline.js 为基准，有更新时直接返回其内容，60 秒内走缓存；/api/status 标注非混淆部署', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const status = await (await call(env, `/${UUID}/api/status`, { cookie })).json();
  assert.equal(status.data.obfuscated, false, '本构建非混淆产物');
  const offline = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url) === 'https://raw.githubusercontent.com/iv7777/Hopline/main/Hopline.js') {
      return new Response("/*!Hopline v9.9.9*/\nconst a=1;\n");
    }
    return new Response('Not Found', { status: 404 });
  };
  try {
    const r = await (await call(env, `/${UUID}/api/update`, { cookie })).json();
    assert.equal(r.ok, true);
    assert.equal(r.data.latest, '9.9.9');
    assert.equal(r.data.hasUpdate, true);
    assert.match(r.data.code, /^\/\*!Hopline v9\.9\.9\*\//);
    assert.deepEqual(seen, ['https://raw.githubusercontent.com/iv7777/Hopline/main/Hopline.js'], '非混淆部署只请求 Hopline.js，不请求 obf_Hopline.js');
    const again = await (await call(env, `/${UUID}/api/update`, { cookie })).json();
    assert.equal(again.data.latest, '9.9.9');
    assert.equal(seen.length, 1, '60 秒内复用缓存');
  } finally {
    globalThis.fetch = offline;
  }
});

test('检测更新（混淆部署）：按部署类型自动切换为仓库 obf_Hopline.js；/api/status 标注混淆部署', async () => {
  const obfWorker = (await import('../obf_Hopline.js?update-test=' + Math.random())).default;
  const env = baseEnv();
  const loginRes = await obfWorker.fetch(new Request('https://node.example.com/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9' },
    body: 'username=admin&password=pw&next=' + encodeURIComponent('/' + UUID),
  }), env, {});
  const cookie = loginRes.headers.get('Set-Cookie').split(';')[0];
  const get = (path) => obfWorker.fetch(new Request('https://node.example.com/' + UUID + path, { headers: { Cookie: cookie } }), env, {});
  const status = await (await get('/api/status')).json();
  assert.equal(status.data.obfuscated, true, 'obf_Hopline.js 应标注 obfuscated: true');
  const offline = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url) === 'https://raw.githubusercontent.com/iv7777/Hopline/main/obf_Hopline.js') {
      return new Response("/*!Hopline v9.9.9 obfuscated:medium*/\nconst a=1;\n");
    }
    return new Response('Not Found', { status: 404 });
  };
  try {
    const r = await (await get('/api/update')).json();
    assert.equal(r.ok, true);
    assert.equal(r.data.latest, '9.9.9');
    assert.equal(r.data.hasUpdate, true);
    assert.deepEqual(seen, ['https://raw.githubusercontent.com/iv7777/Hopline/main/obf_Hopline.js'], '混淆部署只请求 obf_Hopline.js，不请求 Hopline.js');
  } finally {
    globalThis.fetch = offline;
  }
});

// ---------------- 优选 IP 来源与下发 ----------------
const subLinks = async (env) => (await (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text()).split('\n').filter(l => /^vless:\/\//.test(l));
const hostOf = (l) => l.match(/@(\[[^\]]+\]|[^:?]+)/)[1];
const nameOf = (l) => decodeURIComponent(l.slice(l.indexOf('#') + 1));

test('单次订阅最多下发 500 个节点，每次下发相同（不再轮询换新）', async () => {
  // 两个自定义 API 各提供 200 个 CF IP，VLESS + XHTTP 共 800 个节点：截断到 500
  const pool = (n) => Array.from({ length: 200 }, (_, i) => '104.16.' + n + '.' + (i + 1)).join('\n');
  const offline = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const m = String(url).match(/^https:\/\/pool\.example\.com\/cap(\d)\.txt$/);
    return m ? new Response(pool(10 + Number(m[1]))) : new Response('Not Found', { status: 404 });
  };
  const env = baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: true, filter: { ipType: ['IPv4'] }, src: { prefDomain: false },
    ipsrc: { hostmonit: false, uouin: false, api1: true, api1Url: 'https://pool.example.com/cap1.txt', api2: true, api2Url: 'https://pool.example.com/cap2.txt' } } }) });
  try {
    const a = await subLinks(env);
    const b = await subLinks(env);
    assert.equal(a.length, 500);
    assert.deepEqual(b, a, '两次更新下发相同节点');
  } finally { globalThis.fetch = offline; }
  assert.equal(env.CONFIG_KV.m.has('issued'), false);
});

test('选择具体地区时仍保留不带地区的通用节点（优选域名节点）', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: { filter: { region: ['HK'], ipType: ['IPv4'] } } }) });
  const names = (await subLinks(env)).map(nameOf);
  assert.ok(names.some(n => /^优选域名-\d+$/.test(n)), '优选域名节点（通用）保留');
});

test('默认模式（IPv4+IPv6）子请求数不超过免费版 50 个上限，DoH 不重复查询', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: {} }) });
  const offline = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).startsWith('https://cloudflare-dns.com/')) return new Response(JSON.stringify({ Status: 0, Answer: [] }), { headers: { 'content-type': 'application/dns-json' } });
    return new Response('Not Found', { status: 404 });
  };
  try {
    const links = await subLinks(env);
    assert.ok(links.length > 0);
  } finally {
    globalThis.fetch = offline;
  }
  assert.ok(seen.length <= 50, `子请求 ${seen.length} 个：\n${seen.join('\n')}`);
  assert.equal(seen.filter(u => u.includes('alidns')).length, 0, 'Cloudflare DoH 正常应答（即使无记录）时不再查询阿里 DNS');
  assert.equal(seen.filter(u => u.startsWith('https://bestcf.pages.dev/')).length, 0, '默认模式不再拉取 bestcf 中转池');
});

test('HostMonit 优选改为调用数据接口：按运营商命名、只保留 CF 段并去重；运营商筛选保留通用节点', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, filter: { ipType: ['IPv4'], isp: ['移动'] } } }) });
  const offline = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push([String(url), opts.method || 'GET', opts.body]);
    if (String(url) === 'https://api.hostmonit.com/get_optimization_ip') {
      return new Response(JSON.stringify({ code: 200, info: [
        { ip: '198.41.208.52', line: 'CM' }, { ip: '198.41.209.212', line: 'CM' },
        { ip: '162.159.128.65', line: 'CU' }, { ip: '198.41.208.52', line: 'CT' },   // 重复 IP：一个节点，名称含两条线路
        { ip: '104.19.0.9', line: 'CT' }, { ip: '8.8.8.8', line: 'CM' },             // 非 CF 段：丢弃
      ] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  };
  let links;
  try { links = await subLinks(env); } finally { globalThis.fetch = offline; }
  const hm = calls.find(c => c[0].includes('hostmonit'));
  assert.deepEqual([hm[1], JSON.parse(hm[2])], ['POST', { key: 'iDetkOys' }]);
  const byName = Object.fromEntries(links.map(l => [nameOf(l), hostOf(l)]));
  assert.equal(byName['移动/电信-01'], '198.41.208.52');
  assert.equal(byName['移动-01'], '198.41.209.212');
  assert.equal(links.filter(l => hostOf(l) === '198.41.208.52').length, 1, '同一 IP 只下发一次');
  assert.ok(!links.some(l => hostOf(l) === '8.8.8.8'), '非 CF 段 IP 被丢弃');
  // 只勾选「移动」：剔除联通 / 电信节点，保留移动节点与不带运营商标记的通用节点
  assert.ok(!('联通-01' in byName) && !('电信-01' in byName), '未勾选运营商的节点被剔除');
  assert.ok(Object.keys(byName).some(n => /^优选域名-\d+$/.test(n)), '通用节点（优选域名）保留');
});

// ---------------- 优选 IP 来源开关：HostMonit / uouin / 自定义 API ----------------
import { createHash } from 'node:crypto';
const md5 = (s) => createHash('md5').update(s).digest('hex');
async function withFetch(handler, fn) {
  const offline = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (CLASH_FROM_LOCAL && String(url).endsWith('/dist/clash-template.yaml')) return new Response(CLASH_FILE);
    calls.push(String(url)); return handler(String(url), opts);
  };
  try { return await fn(calls); } finally { globalThis.fetch = offline; }
}
const notFound = () => new Response('Not Found', { status: 404 });

test('uouin 来源：签名与文档一致，按线路命名、只保留 CF 段，默认开启', async () => {
  const uouinData = { data: {
    ctcc: { info: [{ ip: '172.64.147.19' }, { ip: '8.8.8.8' }] },
    cucc: { info: [{ ip: '104.20.20.241' }] },
    cmcc: { info: [{ ip: '104.17.212.240' }] },
    bgp: { info: [{ ip: '172.64.151.168' }] },
    ipv6: { info: [{ ip: '[2a06:98c1:310a:fb::5f0]' }] },
  } };
  const handler = (url) => url.startsWith('https://api.uouin.com/') ? new Response(JSON.stringify(uouinData)) : notFound();
  // 默认开启
  await withFetch(handler, async (calls) => {
    const links = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, filter: { ipType: ['IPv4', 'IPv6'] } } }) }));
    const u = new URL(calls.find(x => x.includes('uouin')));
    assert.equal(u.searchParams.get('key'), md5(md5('DdlTxtN0sUOu') + '70cloudflareapikey' + u.searchParams.get('time')));
    assert.match(u.searchParams.get('time'), /^\d{13}$/);
    const byName = Object.fromEntries(links.map(l => [nameOf(l), hostOf(l)]));
    assert.equal(byName['电信-U01'], '172.64.147.19');
    assert.equal(byName['联通-U01'], '104.20.20.241');
    assert.equal(byName['移动-U01'], '104.17.212.240');
    assert.equal(byName['多线-U01'], '172.64.151.168');
    assert.equal(byName['IPv6-U01'], '[2a06:98c1:310a:fb::5f0]');
    assert.ok(!links.some(l => hostOf(l) === '8.8.8.8'));
  });
  // 关闭：不请求 uouin，也不下发其（已缓存的）节点
  await withFetch(handler, async (calls) => {
    const links = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, ipsrc: { uouin: false } } }) }));
    assert.equal(calls.filter(u => u.includes('uouin')).length, 0);
    assert.ok(!links.some(l => /-U\d+$/.test(nameOf(l))));
  });
});

// 微测网页面：服务端渲染的 HTML 表格（data-label 单元格）
const WETEST_V4 = 'https://www.wetest.vip/page/cloudflare/address_v4.html';
const WETEST_V6 = 'https://www.wetest.vip/page/cloudflare/address_v6.html';
const wetestPage = (rows) => '<html><body><table><tr><th>线路名称</th><th>优选地址</th></tr>' + rows.map(([line, ip, colo]) =>
  `<tr><td data-label="线路名称">${line}</td><td data-label="优选地址">${ip}</td><td data-label="数据中心">${colo}</td></tr>`).join('') + '</table></body></html>';

test('微测网来源：默认关闭；开启后只拉取所选 IP 类型的页面、按线路命名、只保留 CF 段，同一 IP 的多条线路合并', async () => {
  const handler = (url) => url === WETEST_V4
    ? new Response(wetestPage([['移动', '104.17.171.3', 'HKG'], ['联通', '104.17.154.27', 'SJC'], ['电信', '8.8.8.8', 'FRA']]))
    : url === WETEST_V6
      ? new Response(wetestPage([['移动', '2606:4700:24::2a95:c83b', 'SEA'], ['电信', '2606:4700:24::2a95:c83b', 'SEA'], ['联通', '2001:db8::1', 'LAX']]))
      : notFound();
  const cfg = (ipType) => baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false, wetest: true }, filter: { ipType } } }) });
  const byName = (links) => Object.fromEntries(links.map(l => [nameOf(l), hostOf(l)]));
  await withFetch(handler, async (calls) => {
    // 默认关闭：不请求微测网
    await subLinks(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false }, filter: { ipType: ['IPv4'] } } }) }));
    assert.equal(calls.filter(u => u.includes('wetest')).length, 0);
    // 仅 IPv4：只拉 v4 页面
    const v4 = await subLinks(cfg(['IPv4']));
    assert.deepEqual(calls.filter(u => u.includes('wetest')), [WETEST_V4]);
    assert.deepEqual(byName(v4), { '移动-W01': '104.17.171.3', '联通-W01': '104.17.154.27' }, '非 CF 段的 8.8.8.8 被丢弃');
    // 仅 IPv6：只拉 v6 页面；同一 IPv6 出现在移动与电信两条线路时合并为一个节点
    const v6 = await subLinks(cfg(['IPv6']));
    assert.deepEqual(calls.filter(u => u.includes('wetest')), [WETEST_V4, WETEST_V6]);
    assert.deepEqual(byName(v6), { '移动/电信-W6-01': '[2606:4700:24::2a95:c83b]' }, '非 CF 段的 2001:db8::1 被丢弃');
    // IPv4 + IPv6：两页都已缓存（10 分钟），不再请求
    const both = await subLinks(cfg(['IPv4', 'IPv6']));
    assert.equal(calls.filter(u => u.includes('wetest')).length, 2);
    assert.equal(both.length, 3);
  });
});

test('微测网测试接口：返回两页合并结果、丢弃项与行摘要；一页版式变化时另一页仍可用并带回错误；需登录', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const post = () => call(env, `/${UUID}/api/ipsrc-test`, { method: 'POST', cookie, body: { source: 'wetest' } });
  assert.equal((await call(env, `/${UUID}/api/ipsrc-test`, { method: 'POST', body: { source: 'wetest' } })).status, 403, '未登录');
  await withFetch((url) => url === WETEST_V4
    ? new Response(wetestPage([['移动', '104.17.171.3', 'HKG'], ['电信', '8.8.8.8', 'FRA']]))
    : url === WETEST_V6 ? new Response(wetestPage([['联通', '[2606:4700:24::2a95:c83b]:8443', 'SEA']])) : notFound(), async () => {
    const d = (await (await post()).json()).data;
    assert.equal(d.count, 2);
    assert.deepEqual(d.items.map(x => [x.name, x.ip, x.port]), [['移动-W01', '104.17.171.3', 443], ['联通-W6-01', '2606:4700:24::2a95:c83b', 443]]);
    assert.deepEqual(d.dropped, ['8.8.8.8']);
    assert.equal(d.error, '');
    assert.match(d.raw, /IPv4 页面\n移动  104\.17\.171\.3  HKG/);
  });
  await withFetch((url) => url === WETEST_V4 ? new Response(wetestPage([['移动', '104.17.171.3', 'HKG']])) : new Response('<html>改版了</html>'), async () => {
    const d = (await (await post()).json()).data;
    assert.equal(d.count, 1, 'v4 页面仍可用');
    assert.match(d.error, /IPv6：页面中没有解析到 IP/);
  });
});

test('HTML 线路表解析支持 IPv6：自定义优选 API 可直接使用微测网 IPv6 页面（含 [IPv6]:端口 与裸 IPv6），非法地址跳过', async () => {
  const page = wetestPage([['移动', '2606:4700:24::2a95:c83b', 'SEA'], ['联通', '[2606:4700:23::6acf:9b0c]:8443', 'SEA'], ['电信', '2606:4700:zz::1', 'SIN'], ['电信', '2001:db8::1', 'SIN']]);
  await withFetch((url) => url === 'https://mine.example.com/v6.html' ? new Response(page) : notFound(), async () => {
    const links = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false, api1: true, api1Url: 'https://mine.example.com/v6.html' }, filter: { ipType: ['IPv6'] } } }) }));
    assert.deepEqual(links.map(l => [nameOf(l), hostOf(l), l.match(/\]:(\d+)\?/)[1]]), [
      ['移动-01', '[2606:4700:24::2a95:c83b]', '443'],
      ['联通-01', '[2606:4700:23::6acf:9b0c]', '8443'],
    ]);
  });
});

test('自定义优选 API 1/2：开关控制、只保留 CF 段；开启但未填地址时保存报错', async () => {
  const handler = (url) => url === 'https://mine.example.com/ips.txt'
    ? new Response('104.16.5.5:443#自有-A\n104.16.5.6\n8.8.8.8:443#外部')
    : notFound();
  await withFetch(handler, async (calls) => {
    const off = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, filter: { ipType: ['IPv4'] }, ipsrc: { api1Url: 'https://mine.example.com/ips.txt' } } }) }));
    assert.ok(!off.some(l => hostOf(l) === '104.16.5.5'), '开关关闭时不使用');
    assert.equal(calls.filter(u => u.includes('mine.example.com')).length, 0);
    const on = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, filter: { ipType: ['IPv4'] }, ipsrc: { api2: true, api2Url: 'https://mine.example.com/ips.txt' } } }) }));
    const byHost = Object.fromEntries(on.map(l => [hostOf(l), nameOf(l)]));
    assert.equal(byHost['104.16.5.5'], '自有-A');
    assert.ok('104.16.5.6' in byHost);
    assert.ok(!('8.8.8.8' in byHost), '非 CF 段被丢弃');
  });
  const env = baseEnv();
  const cookie = await login(env);
  const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { ipsrc: { api1: true, api1Url: '' } } });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).errors.some(e => e.field === 'ipsrc.api1Url'));
});

test('HostMonit 开关关闭时不下发其节点；选定地区时保留运营商线路节点', async () => {
  // 上一个 HostMonit 测试已写入 10 分钟缓存（含 198.41.208.52「移动-01」）
  const on = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { filter: { ipType: ['IPv4'], region: ['HK'] } } }) }));
  assert.ok(on.some(l => nameOf(l) === '移动-01'), '选定地区时运营商线路节点（无地区标记）保留');
  const off = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { filter: { ipType: ['IPv4'] }, ipsrc: { hostmonit: false } } }) }));
  assert.ok(!off.some(l => /^(移动|联通|电信)(\/(移动|联通|电信))*-\d+$/.test(nameOf(l))), '关闭后不含 HostMonit 节点');
});

test('优选来源测试接口：强制重新拉取，返回解析结果、丢弃项与原始响应；需登录', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const post = (body) => call(env, `/${UUID}/api/ipsrc-test`, { method: 'POST', cookie, body });
  const handler = (url) => {
    if (url === 'https://api.hostmonit.com/get_optimization_ip') {
      return new Response(JSON.stringify({ code: 200, info: [{ ip: '198.41.208.99', line: 'CU' }, { ip: '9.9.9.9', line: 'CM' }] }));
    }
    if (url.startsWith('https://api.uouin.com/')) return new Response(JSON.stringify({ code: -1, msg: '密钥错误，如需对接请使用开放API！' }));
    if (url === 'https://mine.example.com/list.txt') return new Response('104.16.7.7:443#自有-B\n1.1.1.1\n');
    if (url === 'https://mine.example.com/404') return new Response('nope', { status: 404 });
    return notFound();
  };
  await withFetch(handler, async (calls) => {
    // HostMonit：即使缓存里已有结果也会重新请求
    let d = (await (await post({ source: 'hostmonit' })).json()).data;
    assert.equal(calls.filter(u => u.includes('hostmonit')).length, 1, '测试不读缓存');
    assert.deepEqual(d.items, [{ ip: '198.41.208.99', port: 443, name: '联通-01' }]);
    assert.deepEqual(d.dropped, ['9.9.9.9']);
    assert.equal(d.status, 200);
    assert.match(d.raw, /198\.41\.208\.99/);
    // uouin：接口报错时带回对方的错误信息
    d = (await (await post({ source: 'uouin' })).json()).data;
    assert.equal(d.count, 0);
    assert.match(d.error, /密钥错误/);
    // 自定义 API：用请求中的地址（无需先保存）
    d = (await (await post({ source: 'api1', url: 'https://mine.example.com/list.txt' })).json()).data;
    assert.deepEqual(d.items.map(x => [x.ip, x.name]), [['104.16.7.7', '自有-B']]);
    assert.deepEqual(d.dropped, ['1.1.1.1']);
    assert.match(d.raw, /自有-B/);
    d = (await (await post({ source: 'api2', url: 'https://mine.example.com/404' })).json()).data;
    assert.equal(d.status, 404);
    assert.equal(d.error, 'HTTP 404');
  });
  assert.equal((await post({ source: 'api1', url: 'ftp://x' })).status, 400, '非法地址');
  assert.equal((await post({ source: 'api1' })).status, 400, '缺少地址');
  assert.equal((await post({ source: 'nope' })).status, 400, '未知来源');
  assert.equal((await call(env, `/${UUID}/api/ipsrc-test`, { method: 'POST', body: { source: 'hostmonit' } })).status, 403, '未登录');
});

test('分线路来源：某条线路的 IP 全部与其它线路重复时，该线路仍保留在节点名中（HostMonit 联通 / uouin cucc）', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const post = (body) => call(env, `/${UUID}/api/ipsrc-test`, { method: 'POST', cookie, body });
  const handler = (url) => {
    if (url.includes('hostmonit')) return new Response(JSON.stringify({ code: 200, info: [
      { ip: '104.16.1.1', line: 'CM' }, { ip: '104.16.1.2', line: 'CT' },
      { ip: '104.16.1.1', line: 'CU' }, { ip: '104.16.1.2', line: 'CU' },   // 联通的 IP 全部与移动 / 电信重复
    ] }));
    if (url.includes('uouin')) return new Response(JSON.stringify({ data: {
      ctcc: { info: [{ ip: '104.16.2.1' }] }, cucc: { info: [{ ip: '104.16.2.1' }] }, cmcc: { info: [] }, bgp: { info: [{ ip: '104.16.2.1' }] }, ipv6: { info: [] },
    } }));
    return notFound();
  };
  await withFetch(handler, async () => {
    const hm = (await (await post({ source: 'hostmonit' })).json()).data.items.map(x => x.name);
    assert.deepEqual(hm, ['移动/联通-01', '电信/联通-01']);
    const uo = (await (await post({ source: 'uouin' })).json()).data.items.map(x => x.name);
    assert.deepEqual(uo, ['电信/联通/多线-U01']);
  });
  // 运营商筛选只勾选「联通」时，合并名称中含联通的节点保留、只标记其它运营商的节点剔除
  //（用未缓存的自定义 API 来源验证；HostMonit / uouin 在前面的测试中已写入 10 分钟缓存）
  const list = (url) => url === 'https://mine.example.com/lines.txt'
    ? new Response('104.16.3.3:443#电信/联通-01\n104.16.3.4:443#移动-01\n') : notFound();
  const env2 = baseEnv({ CONFIG_KV: kv({ config: { filter: { ipType: ['IPv4'], isp: ['联通'] }, ipsrc: { hostmonit: false, api1: true, api1Url: 'https://mine.example.com/lines.txt' } } }) });
  const names = await withFetch(list, async () => (await subLinks(env2)).map(nameOf));
  assert.ok(names.includes('电信/联通-01'), '含联通的合并节点保留');
  assert.ok(!names.includes('移动-01'), '只标记移动的节点被剔除');
});

test('不再内置静态 IP 池；所有来源都没有产出时用官方域名兜底，订阅不为空', async () => {
  // 默认模式：在线来源关闭 / 离线（前面的测试已写入 HostMonit / uouin 缓存，这里显式关闭）、优选域名关闭 → 官方域名兜底
  const a = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false } } }) }));
  assert.deepEqual(a.map(hostOf), ['cloudflare.com', 'www.cloudflare.com', 'speed.cloudflare.com']);
  // 默认模式（优选域名开启、在线来源离线）：只有优选域名节点，没有任何 IP 节点
  const b = await subLinks(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false, filter: { ipType: ['IPv4'] }, ipsrc: { hostmonit: false, uouin: false } } }) }));
  assert.ok(b.length > 0 && b.every(l => !/^\d+\.\d+\.\d+\.\d+$/.test(hostOf(l))), '无内置静态 IP');
});

test('节点命名：优选域名节点为「优选域名-NN」，优选 IP 来源中不带名称的为「优选IP-NN」，两者编号各自独立、不再互相撞名', async () => {
  const url = 'https://names.example.com/list.txt';
  const config = { enableXhttp: false, filter: { ipType: ['IPv4'] }, prefDomains: 'a.example.com\nb.example.com',
    ipsrc: { hostmonit: false, uouin: false, api1: true, api1Url: url } };
  const names = await withFetch((u) => u === url ? new Response('104.16.1.1\n104.16.1.2') : notFound(), async () => {
    const t = await (await call(baseEnv({ CONFIG_KV: kv({ config }) }), `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text();
    return t.split('\n').filter(l => /^vless:\/\//.test(l)).map(l => hostOf(l) + ' ' + nameOf(l));
  });
  assert.deepEqual(names, ['a.example.com 优选域名-01', 'b.example.com 优选域名-02', '104.16.1.1 优选IP-01', '104.16.1.2 优选IP-02']);
});

test('仅 TLS 端口：默认开启；关闭后 443 节点追加 80 明文节点，自定义域名同样生效；ECH 强制仅 TLS', async () => {
  const url = 'https://ports.example.com/list.txt';
  const handler = (u) => u === url ? new Response('104.16.1.1\n104.16.1.2:8080#p8080\n104.16.1.3:8443#p8443') : notFound();
  const cfg = (extra) => ({ enableXhttp: false, filter: { ipType: ['IPv4'] }, src: { prefDomain: false },
    ipsrc: { hostmonit: false, uouin: false, api1: true, api1Url: url }, ...extra });
  const portsOf = async (config) => withFetch(   // node.example.com：自定义域名
  handler, async () => {
    const env = baseEnv({ CONFIG_KV: kv({ config }) });
    const t = await (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text();
    return t.split('\n').filter(l => /^vless:\/\//.test(l)).map(l => l.match(/:(\d+)\?/)[1] + ' ' + nameOf(l)).sort();
  });
  // 默认（开启）：只有 TLS 端口
  assert.deepEqual(await portsOf(cfg({})), ['443 优选IP-01', '8443 p8443']);
  // 关闭：自定义域名也下发明文端口（443 → 追加 ·80，来源自带的 8080 原样保留），明文节点 security=none
  const off = await portsOf(cfg({ tlsOnly: false }));
  assert.deepEqual(off, ['443 优选IP-01', '80 优选IP-01·80', '8080 p8080', '8443 p8443']);
  // ECH 开启时强制仅 TLS
  assert.deepEqual(await portsOf(cfg({ tlsOnly: false, ech: true })), ['443 优选IP-01', '8443 p8443']);
  // 面板保存的关闭状态保留
  const env = baseEnv({ CONFIG_KV: kv() });
  const cookie = await login(env);
  assert.equal((await (await call(env, `/${UUID}/api/config`, { cookie })).json()).data.tlsOnly, true);
  await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { tlsOnly: false } });
  assert.equal((await (await call(env, `/${UUID}/api/config`, { cookie })).json()).data.tlsOnly, false);
});

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
    'proxyip.jp.cmliussss.net|A': ['198.51.100.31'], 'proxyip.sg.cmliussss.net|A': ['198.51.100.32'], 'my-relay.example.net|A': ['198.51.100.31'] } } }, dns);
  await withFetch(stub, () => connectVia(baseEnv({ CONFIG_KV: kv({ config: { relay: { mode: 'builtin', region: 'JP', region2: 'SG' } } }) }), 'tx.example'));
  await until(() => dns.filter(d => /cmliussss/.test(d.name)).length >= 2);
  assert.deepEqual(dns.filter(d => /cmliussss/.test(d.name)).map(d => d.type), ['A', 'A']);
  await withFetch(stub, () => connectVia(baseEnv({ CONFIG_KV: kv({ config: { relay: { mode: 'custom', custom: 'my-relay.example.net' } } }) }), 'tx.example'));
  await until(() => dns.filter(d => d.name === 'my-relay.example.net').length >= 2);
  assert.deepEqual(dns.filter(d => d.name === 'my-relay.example.net').map(d => d.type).sort(), ['A', 'TXT']);
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

test('订阅：TLS ws 节点带 ed=2048、ALPN 随面板下发；多协议时 XHTTP 名称加 .X，节点名全局唯一', async () => {
  // 优选 API 返回的两条地址dup（名称按来源原样使用）
  const env = baseEnv({ CONFIG_KV: kv({ config: fixedNodes('104.16.9.1:443#dup\n104.16.9.2:443#dup', { enableXhttp: true, alpn: 'h2, http/1.1' }) }) });
  const get = (fmt) => withFetch(nodesFetch, async () => (await call(env, `/${UUID}/sub/${fmt}`, { ua: 'x' })).text());
  const links = (await get('plain')).split('\n').filter(Boolean);
  assert.deepEqual(links.map(nameOf), ['dup', 'dup.X', 'dup·2', 'dup.X·2']);
  const [v, x] = links;
  assert.match(v, /path=%2F[0-9a-f-]+%3Fed%3D2048&/, 'VLESS ws 带 ed=2048');
  assert.ok(!/ed%3D2048/.test(x), 'XHTTP 不带 ed');
  for (const l of [v, x]) assert.match(l, /&alpn=h2,http\/1\.1(&|#)/, 'ALPN 原样逗号分隔');
  // Clash：ws-opts.path 带 ed=2048，alpn 取面板设置，GEOSITE 数据源与规则
  const clash = await get('clash');
  assert.match(clash, /path: "\/[0-9a-f-]+\?ed=2048"/);
  assert.match(clash, /alpn: \[h2, http\/1\.1\]/);
  assert.match(clash, /geox-url:\n  geoip: "https:\/\/testingcf\.jsdelivr\.net\//);
  assert.match(clash, /- GEOSITE,CN,直接连接/);
  // sing-box：tag 唯一、无 xhttp（官方内核不支持）、early data 用字段声明而非 path、二进制规则集
  const sb = JSON.parse(await get('singbox'));
  const nodes = sb.outbounds.filter(o => o.server);
  assert.deepEqual(nodes.map(o => o.tag), ['dup', 'dup·2']);
  const tags = sb.outbounds.map(o => o.tag);
  assert.equal(new Set(tags).size, tags.length, 'outbound tag 不重复');
  assert.ok(nodes.every(o => o.transport.type === 'ws' && o.transport.max_early_data === 2048 && !o.transport.path.includes('?')));
  assert.deepEqual(nodes[0].tls.alpn, ['h2', 'http/1.1']);
  assert.ok(sb.route.rule_set.every(r => r.format === 'binary' && r.url.endsWith('.srs')));
  assert.ok(!sb.outbounds.some(o => o.type === 'dns' || o.type === 'block'), '不含已移除的 dns / block 出站');
  assert.ok(!JSON.stringify(sb.route.rules).includes('"geoip"'), '不含已移除的 geoip 规则');
});

// ---------------- 批次 1 修复：多格式订阅 / 出站代理解析 / 协议头处理 ----------------
const subOf = (env, fmt, ua = 'x') => withFetch(nodesFetch, async () => call(env, `/${UUID}/sub/${fmt}`, { ua }));
const customCfg = (extra) => fixedNodes('104.16.9.1:443#a', extra);   // 一个固定节点「a」

test('明文端口节点在 Clash / sing-box / QuanX / Surge 中不启用 TLS（security=none）', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: customCfg({ enableXhttp: false, tlsOnly: false }) }) });
  const clash = await (await subOf(env, 'clash')).text();
  const block = clash.split('\n  - name:').find(b => b.includes('a·80'));
  assert.ok(block && /port: 80\n/.test(block));
  assert.ok(!/tls: true/.test(block), 'Clash 明文节点无 tls: true');
  assert.match(block, /ws-opts:\n {6}path: "?\/[0-9a-f-]+"?\n/, '明文节点 path 不带 ed');
  const sb = JSON.parse(await (await subOf(env, 'singbox')).text());
  assert.equal(sb.outbounds.find(o => o.server_port === 80).tls.enabled, false);
  assert.equal(sb.outbounds.find(o => o.server_port === 443).tls.enabled, true);
  const qx = await (await subOf(env, 'quanx')).text();
  assert.match(qx, /vless=104\.16\.9\.1:80, method=none, password=[^,]+, obfs=ws,/);
  assert.match(qx, /vless=104\.16\.9\.1:443, method=none, password=[^,]+, obfs=wss,/);
  const surge = await (await subOf(env, 'surge')).text();
  assert.match(surge, /a·80 = vless, 104\.16\.9\.1, 80, .*tls=false/);
});

test('sing-box：仅启用 XHTTP（无可用节点）时报错，而不是输出空 selector 的无效配置', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: customCfg({ enableVless: false, enableXhttp: true }) }) });
  const res = await subOf(env, 'singbox');
  assert.equal(res.status, 500);
  assert.match(await res.text(), /不支持 XHTTP/);
  // 同时启用 VLESS 时仍正常输出
  const ok = baseEnv({ CONFIG_KV: kv({ config: customCfg({ enableXhttp: true }) }) });
  const sb = JSON.parse(await (await subOf(ok, 'singbox')).text());
  assert.ok(sb.outbounds[0].outbounds.length > 0);
});

test('原生地址节点同样遵循多协议命名（XHTTP .X）', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: true, src: { native: true, prefDomain: false, prefIp: false }, filter: { ipType: ['IPv4'] } } }) });
  const links = (await (await subOf(env, 'plain')).text()).split('\n').filter(Boolean);
  assert.deepEqual(links.filter(l => nameOf(l).startsWith('原生地址')).map(nameOf), ['原生地址', '原生地址.X']);
});

const ipv6Bytes = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];   // 2001:db8::1
const vlessReqV6 = (port) => new Uint8Array([0, ...uuidBytes, 0, 1, port >> 8, port & 255, 3, ...ipv6Bytes, ...TLS_HELLO]);

test('出站代理：密码含未编码 @ 时主机名解析正确；SOCKS5 对 IPv6 目标使用 ATYP=4；HTTP CONNECT 给 IPv6 加方括号', async () => {
  const feed = async (sock, bytes) => { await until(() => sock.push); sock.push(new Uint8Array(bytes)); };
  // SOCKS5：socks5://us:p@ss@10.0.0.1:1080
  let log = fakeNet({ '10.0.0.1': { delay: 5 } });
  let env = baseEnv({ CONFIG_KV: kv({ config: { outboundProxy: 'socks5://us:p@ss@10.0.0.1:1080', outboundMode: 'only' } }) });
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
  env = baseEnv({ CONFIG_KV: kv({ config: { outboundProxy: 'http://10.0.0.2:8080', outboundMode: 'only' } }) });
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

test('Trojan 已移除：KV 中遗留的 enableTrojan / trojanPassword 与旧环境变量被忽略，订阅里没有 trojan 节点，配置接口不再返回这些字段', async () => {
  const env = baseEnv({ ENABLE_TROJAN: 'true', TROJAN: 'true', TROJAN_PASSWORD: 'x',
    CONFIG_KV: kv({ config: customCfg({ enableTrojan: true, trojanPassword: 'legacy' }) }) });
  const body = await withFetch(nodesFetch, async () => (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text());
  assert.ok(body.includes('vless://') && !body.includes('trojan'));
  const data = (await (await call(env, `/${UUID}/api/config`, { cookie: await login(env) })).json()).data;
  assert.equal('enableTrojan' in data, false);
  assert.equal('trojanPassword' in data, false);
  assert.equal((await subOf(env, 'surfboard')).status, 200, 'Surfboard 专用格式已移除：与未知后缀一样回落为通用链接列表');
});

test('面板关闭 VLESS 后服务端不再接受 VLESS WebSocket 连接', async () => {
  const log = fakeNet({ 'x.example': { delay: 5 } });
  const env = baseEnv({ CONFIG_KV: kv({ config: { enableVless: false } }) });
  const ws = await openWs(env);
  await ws.emit('message', { data: vlessReq('x.example', 443, TLS_HELLO).buffer });
  assert.equal(ws.closed.code, 1011);
  assert.equal(log.length, 0);
});

test('WebSocket 关闭原因按字节截断（含中文的长错误信息不会让 close() 抛异常）', async () => {
  globalThis.__connect = () => { throw new Error('出站连接失败：' + '很长的错误信息'.repeat(30)); };
  const ws = await openWs(baseEnv({ CONFIG_KV: kv({ config: { outboundMode: '' } }) }));
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
  const env = baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: true } }) });
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

// ---------------- 批次 2 修复：Clash 本地凭据 / 登录加固 / 管理密码存储 / 环境变量不固化 / 页面安全头 ----------------
const nextQs = (path) => '?next=' + encodeURIComponent('/' + path);

test('Clash 模板不再包含公开的默认凭据：SS 密码 / 认证 / API 密钥按 UUID 派生且稳定，CORS 不再是 *，DNS 只监听本机', async () => {
  const get = async (env) => (await subOf(env, 'clash')).text();
  const a = await get(baseEnv({ CONFIG_KV: kv({ config: customCfg() }) }));
  assert.ok(!/yyds666|Xf3#Lp9WqZ|__HOPLINE_/.test(a), '无默认密码 / 未替换的占位符');
  const d = (purpose, uuid = UUID) => createHash('sha224').update(`hopline-clash|${purpose}|${uuid}`).digest('hex').slice(0, 20);
  assert.ok(a.includes(`password: "${d('ss')}"`) && a.includes(`- "mihomo:${d('auth')}"`) && a.includes(`secret: "${d('api')}"`), '与 UUID 派生一致（同时校验 SHA-224 实现）');
  assert.equal(await get(baseEnv({ CONFIG_KV: kv({ config: customCfg() }) })), a, '同一部署每次订阅结果稳定');
  const other = await (await withFetch(nodesFetch, () => call(baseEnv({ UUID: UUID2, CONFIG_KV: kv({ config: customCfg() }) }), `/${UUID2}/sub/clash`, { ua: 'x' }))).text();
  assert.ok(!other.includes(d('api')) && other.includes(`secret: "${d('api', UUID2)}"`), '不同部署密钥不同');
  assert.ok(!/allow-origins:\n\s+- "\*"/.test(a), 'CORS 不是 *');
  assert.match(a, /listen: 127\.0\.0\.1:1053/);
});

test('管理密码：面板设置的密码以加盐摘要存入 KV；旧版明文密码在下次保存时升级；以摘要前缀开头的密码被拒绝', async () => {
  const env = baseEnv({ ADMIN: undefined, CONFIG_KV: kv({ config: { admin: 'legacy-pw' } }) });
  const cookie = await login(env, 'legacy-pw');                       // 旧版明文仍可登录
  assert.equal(stored(env).admin, 'legacy-pw');
  const r = await (await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { alpn: 'h2' } })).json();
  assert.equal(r.ok, true);
  const h = stored(env).admin;
  assert.match(h, /^hopline-pbkdf2\$10000\$[0-9a-f]{32}\$[0-9a-f]{64}$/, '保存任意配置后明文升级为摘要');
  assert.ok(!JSON.stringify(stored(env)).includes('legacy-pw'));
  await login(env, 'legacy-pw');                                      // 密码不变，仍可登录
  // 修改密码：新密码生效，旧密码失效；每次的盐不同
  const cookie2 = await login(env, 'legacy-pw');
  const set = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie: cookie2, body: { admin: 'brand-new' } });
  assert.ok(set.headers.get('Set-Cookie'), '密码变更后重新签发登录态');
  assert.notEqual(stored(env).admin, h);
  assert.ok(!JSON.stringify(stored(env)).includes('brand-new'));
  await login(env, 'brand-new');
  const bad = await call(env, '/login', { method: 'POST', body: 'username=admin&password=legacy-pw&next=' + encodeURIComponent('/' + UUID), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '198.51.100.77' } });
  assert.equal(bad.status, 403);
  const rej = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie: await login(env, 'brand-new'), body: { admin: 'hopline-pbkdf2$x' } });
  assert.equal(rej.status, 400);
});

test('管理用户名：默认 admin；用户名或密码任一错误都拒绝且提示相同；改用户名后旧会话失效、当前会话续签；区分大小写', async () => {
  const env = baseEnv();
  const ip = () => '198.18.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
  const post = (u, pw) => call(env, '/login', { method: 'POST', body: `username=${encodeURIComponent(u)}&password=${pw}&next=${encodeURIComponent('/' + UUID)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip() } });
  const noUser = await call(env, '/login', { method: 'POST', body: `password=pw&next=${encodeURIComponent('/' + UUID)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip() } });
  assert.equal(noUser.status, 403, '不带用户名不能登录');
  const wrongUser = await post('root', 'pw'), wrongPw = await post('admin', 'bad');
  assert.equal(wrongUser.status, 403); assert.equal(wrongPw.status, 403);
  assert.equal((await wrongUser.json()).msg, (await wrongPw.json()).msg, '错误提示不区分是哪一项');
  const oldCookie = await login(env);   // 默认用户名 admin
  // 面板修改用户名：当前会话续签，旧 Cookie 失效
  const save = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie: oldCookie, body: { adminUser: 'Boss' } });
  const r = await save.json();
  assert.equal(r.ok, true); assert.equal(r.data.adminUser, 'Boss');
  const renewed = save.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await call(env, `/${UUID}/api/config`, { cookie: renewed })).status, 200, '当前会话续签');
  assert.equal((await call(env, `/${UUID}/api/config`, { cookie: oldCookie })).status, 403, '旧会话失效');
  assert.equal((await post('admin', 'pw')).status, 403, '旧用户名不能再登录');
  assert.equal((await post('boss', 'pw')).status, 403, '区分大小写');
  await login(env, 'pw', UUID, 'Boss');
  // 校验：空格 / 控制字符拒绝；留空恢复默认 admin
  const bad = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie: renewed, body: { adminUser: 'a b' } });
  assert.equal(bad.status, 400);
  const reset = await (await call(env, `/${UUID}/api/config`, { method: 'POST', cookie: renewed, body: { adminUser: '' } })).json();
  assert.equal(reset.data.adminUser, 'admin');
  await login(env, 'pw', UUID, 'admin');
});

test('管理用户名：环境变量 ADMIN_USER 优先且面板只读（保存时忽略、不写入 KV）', async () => {
  const env = baseEnv({ ADMIN_USER: 'ops' });
  const cookie = await login(env, 'pw', UUID, 'ops');
  const cfg = (await (await call(env, `/${UUID}/api/config`, { cookie })).json()).data;
  assert.equal(cfg.adminUser, 'ops'); assert.equal(cfg.envLocked.adminUser, 'ADMIN_USER');
  const r = await (await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { adminUser: 'other', tlsOnly: false } })).json();
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(env.CONFIG_KV.m.get('config')).adminUser, undefined, 'ADMIN_USER 不写入 KV');
  await login(env, 'pw', UUID, 'ops');
});

test('登录加固：/login 与 /version 对不知道面板路径的人返回 404；IPv6 按 /64 计数；限速表满时不会被清零', async () => {
  const env = baseEnv();
  assert.equal((await call(env, '/login')).status, 404);
  assert.equal((await call(env, '/login?next=/wrong')).status, 404);
  assert.equal((await call(env, '/login' + nextQs(UUID))).status, 200);
  const post = (pw, ip, path = UUID) => call(env, '/login', { method: 'POST', body: `username=admin&password=${pw}&next=${encodeURIComponent('/' + path)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip } });
  assert.equal((await post('pw', '203.0.113.1', 'wrong')).status, 404, 'next 不指向面板路径：不处理、不计数');
  assert.equal((await call(env, '/version')).status, 404);
  assert.equal((await call(env, '/version', { cookie: await login(env) })).status, 200);
  // 同一 /64 内换地址也算同一来源
  const p = '2001:db8:' + Math.floor(Math.random() * 60000).toString(16) + ':1';
  for (let i = 0; i < 5; i++) assert.equal((await post('bad', `${p}::${i + 1}`)).status, 403);
  assert.equal((await post('pw', `${p}:ffff:ffff:ffff:ffff`)).status, 429, '同 /64 的其它地址同样被限制');
  assert.equal((await post('pw', `${p}::1`)).status, 429, '限速期间正确密码也不接受');
  // 灌入大量来源后，已被限制的来源仍然受限（旧实现表满即整体清空）
  const victim = '192.0.2.' + (1 + Math.floor(Math.random() * 250));
  const flood = async (from, to) => { for (let i = from; i < to; i++) await post('bad', `10.${i >> 8 & 255}.${i & 255}.9`); };
  await flood(0, 4900);
  for (let i = 0; i < 5; i++) await post('bad', victim);
  await flood(4900, 5600);   // 表超过 5000 上限：旧实现整表清空，新实现只淘汰最旧的来源
  assert.equal((await post('pw', victim)).status, 429, '灌表不能清零已有计数');
});

test('环境变量提供的值不会因为一次保存被固化进 KV；面板改成不同的值才保存为覆盖', async () => {
  const env = baseEnv({ ADMIN: undefined, PROXYIP: 'relay.example.com:443', ALPN: 'h2',
    CONFIG_KV: kv({ config: { admin: 'pw' } }) });
  const first = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie: await login(env), body: { tlsOnly: false } });
  const r = await first.json();
  assert.equal(r.ok, true);
  const cookie = first.headers.get('Set-Cookie').split(';')[0];   // 旧版明文密码升级为摘要后登录态重新签发
  const s = stored(env);
  for (const k of ['proxyIP', 'alpn', 'uuid']) assert.equal(k in s, false, `${k} 不应固化进 KV`);
  assert.equal(s.tlsOnly, false, '面板里改动的其它项正常保存');
  // 环境变量之后变更，立即生效（KV 中没有旧快照）
  const later = { ...env, PROXYIP: 'new-relay.example.com:443' };
  const cfgRes = await call(later, `/${UUID}/api/config`, { cookie });
  const cfg = await cfgRes.json();
  assert.equal(cfg.data.proxyIP, 'new-relay.example.com:443');
  // 面板中改成不同的值：保存为覆盖
  await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { proxyIP: 'mine.example.com:443', alpn: 'http/1.1' } });
  assert.equal(stored(env).proxyIP, 'mine.example.com:443');
  assert.equal(stored(env).alpn, 'http/1.1');
});

test('页面安全头：面板 / 登录页带 CSP、frame-ancestors、nosniff；订阅不受影响；二维码脚本带 SRI；支持退出登录', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const panel = await call(env, `/${UUID}`, { cookie });
  const html = await panel.text();
  for (const res of [panel, await call(env, '/login' + nextQs(UUID))]) {
    assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  }
  assert.match(html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcode-generator@1\.4\.4\/qrcode\.js" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/);
  const api = await call(env, `/${UUID}/api/status`, { cookie });
  assert.equal(api.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(api.headers.get('Content-Security-Policy'), null, 'JSON 接口不带页面 CSP');
  const sub = await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7' });
  assert.equal(sub.headers.get('Content-Security-Policy'), null);
  // 退出登录：清除 Cookie
  const out = await call(env, `/${UUID}/api/logout`, { method: 'POST', cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('Set-Cookie'), /hopline_auth=; .*Max-Age=0/);
  assert.equal((await call(env, `/${UUID}/api/logout`)).status, 403, '未登录不可调用');
});

// ---------------- 批次 3：配置存储异常 / DoH 子请求 / 机房共享缓存 ----------------
const failingKv = (init = {}) => {
  const k = kv(init); let down = true;
  return Object.assign(k, { puts: 0, setDown(v) { down = v; },
    async get(key, opts) { if (down) throw new Error('KV unavailable'); return k.m.has(key) ? k.m.get(key) : null; },
    async put(key, v) { this.puts++; k.m.set(key, v); } });
};

test('KV 读取失败：有环境变量 UUID 时节点与订阅照常工作，保存与重置被拒绝且不会覆盖已有配置；无环境变量 UUID 时返回 503', async () => {
  const k = failingKv({ config: { alpn: 'h2' } });
  const env = baseEnv({ CONFIG_KV: k });
  const cookie = await login(env);                                   // ADMIN 来自环境变量，不依赖 KV
  assert.equal((await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7' })).status, 200, '订阅仍可用');
  const cfg = await (await call(env, `/${UUID}/api/config`, { cookie })).json();
  assert.match(cfg.data.kvError, /KV 暂时无法读取/);
  const save = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { alpn: 'http/1.1' } });
  assert.equal(save.status, 503);
  assert.equal(k.puts, 0, '没有向 KV 写入任何内容');
  assert.equal((await call(env, `/${UUID}/api/reset`, { method: 'POST', cookie })).status, 503);
  assert.equal(k.m.has('config'), true, '配置未被删除');
  // 恢复后一切正常，原有配置还在
  k.setDown(false);
  const after = await (await call(env, `/${UUID}/api/config`, { cookie })).json();
  assert.equal(after.data.alpn, 'h2');
  assert.equal(after.data.kvError, '');
  // 未设置环境变量 U：此时 UUID 只能是随机值，直接 503，不再让登录与节点悄悄失效
  const noU = { ADMIN: 'pw', CONFIG_KV: failingKv() };
  const res = await call(noU, `/${UUID}/sub`, { ua: 'v2rayN/7' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '30');
});

test('KV 中的配置损坏（不是合法 JSON）：显示提示并禁止保存，但允许重置修复', async () => {
  const k = kv({ config: '{"alpn": "h2"' });
  const env = baseEnv({ CONFIG_KV: k });
  const cookie = await login(env);
  const cfg = await (await call(env, `/${UUID}/api/config`, { cookie })).json();
  assert.match(cfg.data.kvError, /已损坏/);
  assert.equal((await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { alpn: 'h2' } })).status, 503);
  assert.equal(k.m.get('config'), '{"alpn": "h2"', '损坏内容保持原样，未被默认值覆盖');
  assert.equal((await call(env, `/${UUID}/api/reset`, { method: 'POST', cookie })).status, 200);
  assert.equal(k.m.has('config'), false);
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
  const env = baseEnv({ CONFIG_KV: kv({ config: { proxyIP: 'dedupe.example.com' } }) });
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
  let env = baseEnv({ CONFIG_KV: kv({ config: { proxyIP: 'fallback.example.com' } }) });
  await withFetch(dohStub({ 'dns.alidns.com': { answers: { 'fallback.example.com|A': ['198.51.100.6'] } } }, dns), () => connectVia(env, 't.example'));
  let hosts = dns.filter(d => d.name === 'fallback.example.com').map(d => d.host);
  assert.deepEqual([...new Set(hosts)].sort(), ['cloudflare-dns.com', 'dns.alidns.com']);
  assert.ok(!hosts.includes('doh.pub'));
  // 全部失败：第一次尝试所有端点，第二次连接直接用缓存的「无结果」
  dns = [];
  env = baseEnv({ CONFIG_KV: kv({ config: { proxyIP: 'neg.example.com' } }) });
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

test('机房共享缓存：优选 API 结果写入 / 读取 Cache API；命中时不再请求对方；Cache API 不可用时照常工作', async () => {
  const store = new Map(), puts = [];
  globalThis.caches = { default: {
    async match(req) { return store.has(req.url) ? new Response(store.get(req.url)) : undefined; },
    async put(req, res) { puts.push({ url: req.url, cc: res.headers.get('Cache-Control') }); store.set(req.url, await res.text()); },
  } };
  try {
    const cfgFor = (url) => ({ filter: { ipType: ['IPv4'] }, src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false, api1: true, api1Url: url } });
    const linksFor = async (url, handler) => {
      const env = baseEnv({ CONFIG_KV: kv({ config: cfgFor(url) }) });
      return withFetch(handler, async (calls) => {
        const t = await (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text();
        return { calls, hosts: t.split('\n').filter(l => /^vless:\/\//.test(l)).map(l => l.match(/@([^:]+):/)[1]) };
      });
    };
    // 1) 共享缓存未命中：请求对方并写入共享缓存（max-age=600）
    const urlA = 'https://shared-a.example.com/ips.txt';
    const a = await linksFor(urlA, (u) => u === urlA ? new Response('104.16.8.8') : notFound());
    assert.ok(a.hosts.includes('104.16.8.8'));
    const key = 'https://hopline-cache.invalid/url-' + md5('url:' + urlA);
    assert.deepEqual(puts.filter(p => p.url === key).map(p => p.cc), ['max-age=600']);
    // 2) 共享缓存命中（模拟另一个实例写入的结果）：完全不请求对方
    const urlB = 'https://shared-b.example.com/ips.txt';
    store.set('https://hopline-cache.invalid/url-' + md5('url:' + urlB), JSON.stringify([{ ip: '104.16.7.7', port: 443, name: '共享-01' }]));
    const b = await linksFor(urlB, (u) => { if (u === urlB) throw new Error('不应请求对方'); return notFound(); });
    assert.ok(b.hosts.includes('104.16.7.7'));
    assert.ok(!b.calls.includes(urlB));
  } finally { delete globalThis.caches; }
  // 3) 没有 Cache API：退回内存缓存，订阅照常
  const urlC = 'https://shared-c.example.com/ips.txt';
  const env = baseEnv({ CONFIG_KV: kv({ config: { filter: { ipType: ['IPv4'] }, src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false, api1: true, api1Url: urlC } } }) });
  const t = await withFetch((u) => u === urlC ? new Response('104.16.6.6') : notFound(), async () => (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text());
  assert.match(t, /@104\.16\.6\.6:443/);
});

// ---------------- 批次 4：纯函数已知答案 / 协议头模糊测试 / 面板注入 ----------------
import { createHmac, hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assemble } from '../build.mjs';
// 内部函数不对外导出，且构建产物里名称已被 terser 重命名；改用未压缩的合并源码（assemble），
// 去掉 import / export default 后在函数作用域内求值，取出要测的纯函数
const internals = (() => {
  const src = assemble()
    .replace(/^import .*$/m, '').replace('export default {', 'const __default = {');
  return new Function('connect', src + '\n;return { md5hex, sha224hex, sha1Bytes, hmacSha1, hkdfSha1, poly1305, chacha20Poly1305Seal, chacha20Poly1305Open, parseVlessHeader, HTTP_PORTS, ipInCidrV6, isValidIp, parseProxyAddress, loginRateKey, relayPlan, RELAY_DOMAINS, SERVER_CHECKS, effectivePrefDomains, DEFAULT_PREFERRED_DOMAINS, pumpReadable };')(() => { throw new Error('no sockets'); });
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

test('MD5 / SHA-224 / SHA-1 / HMAC-SHA1 / HKDF-SHA1 与 node:crypto 结果一致（含 RFC 已知答案与填充边界）', () => {
  assert.equal(internals.md5hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(internals.md5hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(internals.sha224hex('abc'), '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
  assert.equal(hex(internals.sha1Bytes(new TextEncoder().encode('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  for (const n of lens) {
    const m = msgOf(n), bytes = new TextEncoder().encode(m);
    assert.equal(internals.md5hex(m), createHash('md5').update(m).digest('hex'), `md5 len ${n}`);
    assert.equal(internals.sha224hex(m), createHash('sha224').update(m).digest('hex'), `sha224 len ${n}`);
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
    const header = internals.parseVlessHeader(full, cfg).headerLength;
    for (let k = 0; k < header; k++) {
      assert.throws(() => internals.parseVlessHeader(full.slice(0, k), cfg), (e) => e.constructor === Error && /头部过短/.test(e.message), `VLESS 截断 ${k}/${header}`);
    }
    assert.equal(internals.parseVlessHeader(full.slice(0, header), cfg).headerLength, header);
  }
  for (let i = 0; i < 500; i++) {   // 随机字节：要么解析成功，要么抛出我们自己的 Error
    const junk = randomBytes(1 + Math.floor(Math.random() * 90)); if (i % 2) { junk[0] = 0; junk.set(uuidBytes.slice(0, Math.min(16, junk.length - 1)), 1); }
    try { internals.parseVlessHeader(junk, cfg); } catch (e) { assert.equal(e.constructor, Error, `${e.name}: ${e.message}`); }
  }
});

test('面板注入服务端的明文端口表（不再各存一份）', async () => {
  const env = baseEnv();
  const html = await (await call(env, `/${UUID}`, { cookie: await login(env) })).text();
  assert.ok(html.includes('var HTTP_PORTS = ' + JSON.stringify([...internals.HTTP_PORTS])), '注入值与服务端 HTTP_PORTS 一致');
  assert.ok(!html.includes('/*@HOPLINE_HTTP_PORTS@*/'), '占位符已替换');
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
      const env = baseEnv({ CONFIG_KV: kv({ config: { outboundProxy: `ss://${method}:${encodeURIComponent(password)}@10.0.0.9:8388`, outboundMode: 'only' } }) });
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
    const env = baseEnv({ CONFIG_KV: kv({ config: { outboundProxy: `ss://${method}:${password}@10.0.0.9:8388`, outboundMode: 'only' } }) });
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
const domainsOfSub = async (config, fetchHandler = notFound) => {
  const env = baseEnv({ CONFIG_KV: kv({ config: { ...config } }) });
  const t = await withFetch(fetchHandler, async () => (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7' })).text());
  return t.split('\n').filter(l => /^vless:\/\//.test(l)).map(l => l.match(/@([^:?]+):/)[1]);
};

test('优选域名校验：只接受纯主机名；规范化（小写、去重、多种分隔符）；上限 30 个', () => {
  const chk = internals.SERVER_CHECKS.domainList;
  assert.deepEqual(chk('A.Example.com, b.example.org\nA.example.com;  c.example.net'), { value: 'a.example.com\nb.example.org\nc.example.net' });
  assert.deepEqual(chk(''), { value: '' });
  for (const bad of ['https://a.example.com', 'a.example.com:443', 'a.example.com/path', '*.example.com', '1.2.3.4', 'localhost', '-a.example.com', 'a..example.com', 'a_b.example.com', 'exa mple.com x']) {
    assert.equal(typeof chk(bad), 'string', `应拒绝：${bad}`);
  }
  const many = Array.from({ length: 31 }, (_, i) => `d${i}.example.com`).join('\n');
  assert.match(chk(many), /最多 30 个/);
  assert.equal(typeof chk(many.split('\n').slice(0, 30).join('\n')), 'object');
});

test('优选域名：填写后整体替换内置列表（默认模式域名节点、IPv6 解析），留空用内置列表', async () => {
  const base = { enableXhttp: false, filter: { ipType: ['IPv4'] }, ipsrc: { hostmonit: false, uouin: false } };
  // 默认模式：域名节点的 server 就是配置的域名
  const own = await domainsOfSub({ ...base, prefDomains: 'one.example.com\ntwo.example.org' });
  assert.deepEqual(own.filter(h => /example\.(com|org)$/.test(h)), ['one.example.com', 'two.example.org']);
  assert.ok(!own.includes('cloudflare.182682.xyz') && !own.includes('bestcf.top'), '内置列表被整体替换');
  const builtin = await domainsOfSub(base);
  assert.deepEqual(builtin.slice(0, 3), internals.DEFAULT_PREFERRED_DOMAINS.split('\n').slice(0, 3), '留空沿用内置列表');
  assert.equal(builtin.length, 14);
  for (const dead of ['speed.marisalnc.com', 'freeyx.cloudflare88.eu.org', 'bestcf.top', 'cfip.cfcdn.vip', 'cf.zhetengsha.eu.org', 'cloudflare.9jy.cc', 'cf.zerone-cdn.pp.ua', '115155.xyz', 'cname.xirancdn.us', 'f3058171cad.002404.xyz', '8.889288.xyz']) {
    assert.ok(!builtin.includes(dead), `${dead} 实测失效，不应在内置列表中`);
  }
  // 仅 IPv6：只查询配置的域名（+官方域名）的 AAAA
  const log6 = [];
  await domainsOfSub({ ...base, filter: { ipType: ['IPv6'] }, prefDomains: 'one.example.com' }, cfDoh({}, log6));
  const names6 = new Set(log6.filter(x => x.type === 'AAAA').map(x => x.name));
  assert.ok(names6.has('one.example.com') && names6.has('cloudflare.com'));
  assert.ok(![...names6].some(n => internals.DEFAULT_PREFERRED_DOMAINS.split('\n').includes(n)));
});

test('保存校验：非法优选域名 / 自定义反代给出字段级错误；「仅使用自定义反代」但列表为空被拒绝；配置可往返', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const save = (body) => call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body });
  let r = await save({ prefDomains: 'https://bad.example.com' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).errors[0].field, 'prefDomains');
  r = await save({ relay: { custom: 'a.example.com\nb.example.com\nc.example.com\nd.example.com' } });
  assert.match((await r.json()).msg, /最多 3 个/);
  r = await save({ relay: { custom: 'bad host' } });
  assert.equal(r.status, 400);
  r = await save({ relay: { mode: 'custom', custom: '' } });
  assert.equal((await r.json()).errors[0].field, 'relay.custom');
  r = await save({ relay: { mode: 'sideways' } });
  assert.equal(r.status, 400);
  r = await save({ prefDomains: 'Z.Example.com\na.example.com', relay: { mode: 'custom', custom: 'Relay.Example.com:8443, [2001:db8::1]:443', region: 'JP', region2: 'none' } });
  assert.equal(r.status, 200);
  const d = (await r.json()).data;
  assert.equal(d.prefDomains, 'z.example.com\na.example.com');
  assert.deepEqual(d.relay, { mode: 'custom', region: 'JP', region2: 'none', custom: 'relay.example.com:8443\n[2001:db8::1]' });
  assert.equal(d.builtinPrefDomains.length, 14, '面板「载入内置列表」所需');
  assert.equal(stored(env).relay.mode, 'custom');
});

test('地区反代计划：默认按机房自动选地区；可固定首选 / 次选；none 只用首选；custom 取前 3 个；off 为空', () => {
  const plan = (relay, colo) => internals.relayPlan({ relay }, colo).map(p => `${p.host}:${p.port}x${p.take}`);
  const R = internals.RELAY_DOMAINS;
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
  let env = baseEnv({ CONFIG_KV: kv({ config: { relay: { mode: 'off' } } }) });
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
  env = baseEnv({ CONFIG_KV: kv({ config: { relay: { mode: 'custom', custom: 'my-relay.example.com\n203.0.113.30:8443' } } }) });
  await withFetch(cfDoh({ 'my-relay.example.com': ['203.0.113.31'] }, dns), async () => {
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
  env = baseEnv({ CONFIG_KV: kv({ config: { relay: { mode: 'builtin', region: 'SE', region2: 'none' } } }) });
  await withFetch(cfDoh({ 'proxyip.se.cmliussss.net': ['203.0.113.50'] }, dns), async () => {
    const ws = await openWs(env);
    await ws.emit('message', { data: vlessReq('cf-se.example', 443, TLS_HELLO).buffer });
    await until(() => log.some(s => s.written.length));
  });
  assert.equal(log.find(s => s.written.length).hostname, '203.0.113.50');
  assert.deepEqual([...new Set(dns.filter(d => d.name.startsWith('proxyip.')).map(d => d.name))], ['proxyip.se.cmliussss.net']);
});

test('优选域名测试接口：解析输入框中尚未保存的域名，标出是否在 Cloudflare 段；非法输入 400；需登录', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const test = (body, ck = cookie) => call(env, `/${UUID}/api/ipsrc-test`, { method: 'POST', cookie: ck, body });
  const doh = cfDoh({ 'good.example.com': ['104.16.1.1', '104.16.1.2'], 'moved.example.com': ['203.0.113.7'] });
  await withFetch(doh, async () => {
    const r = await (await test({ source: 'domains', text: 'good.example.com\nmoved.example.com\nnone.example.com' })).json();
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1);
    const byName = Object.fromEntries(r.data.domains.map(x => [x.domain, x]));
    assert.equal(byName['good.example.com'].ok, true);
    assert.equal(byName['moved.example.com'].ok, false);
    assert.deepEqual(byName['moved.example.com'].ips, ['203.0.113.7']);
    assert.equal(byName['none.example.com'].ok, false);
    assert.equal((await test({ source: 'domains', text: 'http://bad.example.com' })).status, 400);
    assert.equal((await test({ source: 'domains', text: '' })).status, 200, '留空测试内置列表');
  });
  assert.equal((await test({ source: 'domains', text: 'good.example.com' }, '')).status, 403);
});

test('自定义订阅 / 随机优选已移除：旧 KV 中的相关字段与 YX 环境变量被忽略，订阅按默认来源生成，面板不再有对应控件', async () => {
  const legacy = { enableXhttp: false, filter: { ipType: ['IPv4'] }, ipsrc: { hostmonit: false, uouin: false },
    optimizer: { subMode: 'custom', subIncludeDefault: true, subRandomCount: 5 }, preferredDomains: 'my.custom.example\n104.16.0.9:443#MINE',
    preferredIPs: [{ ip: '104.16.0.10', port: 443, name: 'MINE2' }] };
  const env = baseEnv({ YX: '104.16.0.11:443#ENV', CONFIG_KV: kv({ config: legacy }) });
  const links = (await (await subOf(env, 'plain')).text()).split('\n').filter(Boolean);
  assert.equal(links.length, 14, '按默认来源（内置 14 个优选域名）生成');
  assert.ok(!links.some(l => ['my.custom.example', '104.16.0.9', '104.16.0.10', '104.16.0.11'].includes(l.match(/@([^:?]+):/)[1])));
  assert.ok(!links.some(l => /MINE|ENV/.test(nameOf(l))));
  const cookie = await login(env);
  const html = await (await call(env, `/${UUID}`, { cookie })).text();
  for (const id of ['o-submode', 'o-subinc', 'o-rand', 'f-preferred', 'sm-custom', 'sm-random', 'fl-custom-pref', 'fl-random-pref']) assert.ok(!html.includes(`id="${id}"`), `${id} 已移除`);
  // 下次保存时旧字段被清掉
  const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { alpn: 'h2' } });
  assert.equal(res.status, 200);
  for (const k of ['optimizer', 'preferredDomains', 'preferredIPs']) assert.equal(k in stored(env), false, `${k} 已从 KV 清除`);
});

test('节点测活已移除：旧 KV 的 probeAlive 与 PROBE_ALIVE 环境变量被忽略，订阅不再对优选域名做任何预检解析，面板无对应开关', async () => {
  const env = baseEnv({ PROBE_ALIVE: '1', CONFIG_KV: kv({ config: { enableXhttp: false, probeAlive: true, filter: { ipType: ['IPv4'] }, ipsrc: { hostmonit: false, uouin: false } } }) });
  const calls = [];
  const links = await withFetch((u) => { calls.push(u); return nodesFetch(u); }, async () =>
    (await (await call(env, `/${UUID}/sub/plain`, { ua: 'x' })).text()).split('\n').filter(Boolean));
  assert.equal(links.length, 14, '14 个内置优选域名原样下发');
  assert.equal(calls.filter(u => /cloudflare-dns\.com|alidns/.test(u)).length, 0, '没有为预检发出任何 DoH 请求');
  const cookie = await login(env);
  const cfg = await (await call(env, `/${UUID}/api/config`, { cookie })).json();
  assert.equal('probeAlive' in cfg.data, false);
  const html = await (await call(env, `/${UUID}`, { cookie })).text();
  assert.ok(!html.includes('id="q-probe-on"') && !html.includes('节点测活'));
  await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { alpn: 'h2' } });
  assert.equal('probeAlive' in stored(env), false, '下次保存时从 KV 清除');
});

test('Stash 手动选择格式时输出 Clash 配置（与按 UA 识别一致），不再是明文链接', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: customCfg() }) });
  const forced = await (await subOf(env, 'stash')).text();
  assert.match(forced, /^# Hopline 订阅\ntest-url:/);
  assert.match(forced, /\nproxies:\n/);
  const byUa = await (await withFetch(nodesFetch, () => call(env, `/${UUID}/sub`, { ua: 'Stash/2.7 Clash/1.9' }))).text();
  assert.equal(forced, byUa, '手动选 Stash 与 Stash 客户端自动识别得到同一份配置');
});

test('Surge / Loon / Quantumult X 不输出 XHTTP 节点（它们没有 XHTTP 传输）；只启用 XHTTP 时明确报错', async () => {
  const both = baseEnv({ CONFIG_KV: kv({ config: customCfg({ enableXhttp: true }) }) });
  for (const [fmt, nodeRe] of [['surge', /^a(\.X)? = vless,/m], ['loon', /^a(\.X)? = vless,/m], ['quanx', /tag=a(\.X)?$/m]]) {
    const body = await (await subOf(both, fmt)).text();
    assert.ok(!/\.X\b/.test(body), `${fmt} 不含 XHTTP 节点（.X）`);
    assert.match(body, nodeRe, `${fmt} 仍包含 VLESS 节点`);
  }
  const only = baseEnv({ CONFIG_KV: kv({ config: customCfg({ enableVless: false, enableXhttp: true }) }) });
  for (const [fmt, name] of [['surge', 'Surge'], ['loon', 'Loon'], ['quanx', 'Quantumult X']]) {
    const res = await subOf(only, fmt);
    assert.equal(res.status, 500, fmt);
    assert.match(await res.text(), new RegExp(name + ' 不支持 XHTTP'));
  }
  // 链接类订阅与 Clash 仍然包含 XHTTP 节点
  assert.match(await (await subOf(both, 'plain')).text(), /type=xhttp/);
  assert.match(await (await subOf(both, 'clash')).text(), /network: xhttp/);
});

// ---------------- XHTTP（stream-one）----------------
const xhttpPost = (env, path, body) => worker.fetch(new Request(`https://node.example.com${path}`, { method: 'POST', body, duplex: 'half', headers: { 'User-Agent': 'Go-http-client/2.0' } }), env, {});

test('XHTTP：Xray 风格请求（路径带结尾 / 与 x_padding 查询串）被接受，响应以 VLESS 响应头开始并转发上行数据', async () => {
  const log = fakeNet({ 'slash.example': { delay: 5 } });
  const env = baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: true } }) });
  const res = await xhttpPost(env, `/${UUID}/?x_padding=${'x'.repeat(300)}`, vlessReq('slash.example', 443, TLS_HELLO));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const first = await res.body.getReader().read();
  assert.deepEqual([...first.value], [0, 0], '响应以 2 字节 VLESS 响应头开始');
  await until(() => log.some(s => s.written.length));
  assert.equal(log[0].hostname, 'slash.example');
  assert.deepEqual([...log[0].written[0]], TLS_HELLO);
  // 关闭 XHTTP 时不接受代理请求
  const off = await xhttpPost(baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: false } }) }), `/${UUID}/`, vlessReq('slash.example', 443, TLS_HELLO));
  assert.notEqual(off.headers.get('content-type'), 'application/octet-stream');
});

test('XHTTP 下行有背压：客户端不读取时不会无限缓冲目标连接的数据；客户端断开后释放目标连接', async () => {
  let pulls = 0, closed = false;
  globalThis.__connect = () => ({
    opened: Promise.resolve(),
    writable: new WritableStream({ write() {} }),
    readable: new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(64 * 1024)); } }),   // 目标不停地发数据
    close() { closed = true; },
  });
  const env = baseEnv({ CONFIG_KV: kv({ config: { enableXhttp: true } }) });
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

test('XHTTP 链接：未设置 ALPN 时显式带 alpn=h2（stream-one 依赖 HTTP/2），WS 节点不带；面板设置的 ALPN 优先', async () => {
  const links = async (alpn) => {
    const env = baseEnv({ CONFIG_KV: kv({ config: customCfg({ enableXhttp: true, ...(alpn ? { alpn } : {}) }) }) });
    return (await (await subOf(env, 'plain')).text()).split('\n').filter(Boolean);
  };
  let [ws, x] = await links();
  assert.ok(!/alpn=/.test(ws) && /type=ws/.test(ws), 'WS 节点未设置 ALPN 时不带 alpn 参数');
  assert.match(x, /type=xhttp&mode=stream-one&extra=[^&]+&path=%2F[0-9a-f-]+&alpn=h2(&|#)/);
  [ws, x] = await links('h2,http/1.1');
  assert.match(x, /&alpn=h2,http\/1\.1(&|#)/);
  assert.match(ws, /&alpn=h2,http\/1\.1(&|#)/);
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

test('sing-box 的 VLESS 出站不再指定 packet_encoding=xudp（服务端不支持 Mux/XUDP，只支持 UDP-DNS）', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: customCfg() }) });
  const sb = JSON.parse(await (await subOf(env, 'singbox')).text());
  const vless = sb.outbounds.filter(o => o.type === 'vless');
  assert.ok(vless.length > 0 && vless.every(o => !('packet_encoding' in o)));
});

// ---------------- 面板加载器：按版本标签拉取、校验哈希、分层缓存 ----------------
// 每个用例用带查询串的 URL 加载一份全新的 Hopline.js 模块实例，隔离 isolate 内存、失败冷却等模块级状态
let freshSeq = 0;
const freshWorker = async () => (await import('../Hopline.js?fresh=' + (++freshSeq))).default;
const panelReq = (path = UUID) => new Request('https://node.example.com/' + path, { headers: { 'User-Agent': BROWSER, Cookie: '' } });
async function panelGet(w, env) {
  const cookie = await (async () => {   // 复用公共登录流程，但针对给定的 worker 实例
    const res = await w.fetch(new Request('https://node.example.com/login', {
      method: 'POST', headers: { 'User-Agent': BROWSER, 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.' + Math.floor(Math.random() * 250) },
      body: 'username=admin&password=pw&next=' + encodeURIComponent('/' + UUID),
    }), env, {});
    return res.headers.get('Set-Cookie').split(';')[0];
  })();
  return w.fetch(new Request('https://node.example.com/' + UUID, { headers: { 'User-Agent': BROWSER, Cookie: cookie } }), env, {});
}
const memCache = () => {   // 最小的 Cache API 内存实现（caches.default）
  const m = new Map();
  return { m, async match(k) { const r = m.get(String(k.url || k)); return r ? r.clone() : undefined; }, async put(k, r) { m.set(String(k.url || k), r); } };
};
async function withGlobals(globals, fn) {
  const saved = {};
  for (const k of Object.keys(globals)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); globalThis[k] = globals[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(globals)) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; } }
}

test('面板：来源固定为版本标签 v<VERSION>，哈希与 dist/panel.html 一致，页面不内嵌面板', async () => {
  const w = await freshWorker();
  const urls = [];
  await withFetch((url) => { urls.push(url); return new Response(PANEL_FILE); }, async () => {
    const res = await panelGet(w, baseEnv());
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="stEntry"') && !html.includes('@HOPLINE_'), '页面完整，占位符已替换');
  });
  const ver = readFileSync(new URL('../Hopline.js', import.meta.url), 'utf8').match(/Hopline v(\d+\.\d+\.\d+)/)[1];
  assert.equal(urls.length, 3, '三个镜像并发请求');
  assert.ok(urls.every(u => u.includes('@v' + ver + '/dist/panel.html') || u.includes('/v' + ver + '/dist/panel.html')), urls.join('\n'));
  assert.ok(urls.every(u => !/@(main|latest)\b|\/main\//.test(u)), '不拉取可变引用');
  assert.ok(readFileSync(new URL('../Hopline.js', import.meta.url), 'utf8').includes(createHash('sha256').update(PANEL_FILE).digest('hex')), '哈希已写进 Worker');
});

test('面板：镜像篡改 / 返回错误内容时被拒绝，不缓存', async () => {
  const w = await freshWorker();
  const cache = memCache(), env = baseEnv();
  await withGlobals({ caches: { default: cache } }, () => withFetch(() => new Response(PANEL_FILE.toString() + '<script>evil()</script>'), async () => {
    const res = await panelGet(w, env);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /面板页面暂时无法加载/);
  }));
  assert.equal(cache.m.size, 0, '校验失败的内容不进缓存');
  assert.deepEqual([...env.CONFIG_KV.m.keys()].filter(k => k.startsWith('panel:')), [], '也不写 KV');
});

test('面板：一个镜像失败，另一个成功即可；成功后写入 Cache API 与 KV', async () => {
  const w = await freshWorker();
  const cache = memCache(), env = baseEnv();
  await withGlobals({ caches: { default: cache } }, () => withFetch((url) => url.startsWith('https://raw.githubusercontent.com/') ? new Response(PANEL_FILE) : new Response('boom', { status: 502 }), async () => {
    const res = await panelGet(w, env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }));
  assert.equal(cache.m.size, 1, '写入 Cache API');
  const key = [...cache.m.keys()][0];
  assert.match(key, /^https:\/\/hopline\.invalid\/panel\/[0-9a-f]{64}$/, '缓存键 = 内容哈希');
  assert.deepEqual([...env.CONFIG_KV.m.keys()].filter(k => k.startsWith('panel:')), ['panel:' + key.split('/').pop()], '写入 KV');
});

test('面板：升级后哈希变化 → 新缓存键，旧条目不会被误用', async () => {
  const w = await freshWorker();
  const env = baseEnv();
  // 旧版本留下的缓存 / KV 条目（键里是另一个哈希）：新 Worker 不读，也不删，直接走网络
  const stale = memCache();
  await stale.put('https://hopline.invalid/panel/' + 'ab'.repeat(32), new Response('OLD PANEL'));
  env.CONFIG_KV.m.set('panel:' + 'ab'.repeat(32), 'OLD PANEL');
  let hits = 0;
  await withGlobals({ caches: { default: stale } }, () => withFetch(() => { hits++; return new Response(PANEL_FILE); }, async () => {
    const res = await panelGet(w, env);
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes('OLD PANEL'));
  }));
  assert.equal(hits, 3, '未命中新键 → 拉网络');
  assert.equal(stale.m.size, 2, '旧条目原样保留，等待 TTL 过期');
});

test('面板：Cache API 命中时不再访问网络；缓存内容被破坏则当作未命中', async () => {
  const w1 = await freshWorker();
  const cache = memCache(), env = baseEnv();
  await withGlobals({ caches: { default: cache } }, async () => {
    await withFetch(() => new Response(PANEL_FILE), () => panelGet(w1, env));
    const w2 = await freshWorker();   // 新 isolate：内存为空，应命中 Cache API
    await withFetch(() => { throw new Error('不应访问网络'); }, async (calls) => {
      assert.equal((await panelGet(w2, env)).status, 200);
      assert.equal(calls.length, 0);
    });
    cache.m.set([...cache.m.keys()][0], new Response('corrupted'));
    const w3 = await freshWorker();
    const env2 = baseEnv();   // 没有 KV 副本
    await withFetch(() => new Response(PANEL_FILE), async (calls) => {
      assert.equal((await panelGet(w3, env2)).status, 200);
      assert.equal(calls.length, 3, '损坏的缓存被忽略并重新拉取');
    });
  });
});

test('面板：只有 KV 有副本时从 KV 读取（并回填 Cache API）', async () => {
  const w1 = await freshWorker();
  const env = baseEnv();
  await withFetch(() => new Response(PANEL_FILE), () => panelGet(w1, env));   // 先填充 KV（无 Cache API）
  assert.ok([...env.CONFIG_KV.m.keys()].some(k => k.startsWith('panel:')));
  const w2 = await freshWorker(), cache = memCache();
  await withGlobals({ caches: { default: cache } }, () => withFetch(() => { throw new Error('不应访问网络'); }, async (calls) => {
    assert.equal((await panelGet(w2, env)).status, 200);
    assert.equal(calls.length, 0);
  }));
  assert.equal(cache.m.size, 1, '回填 Cache API');
});

test('面板：全部来源失败 → 503 说明页，15 秒内不再重试；代理与订阅不受影响', async () => {
  const w = await freshWorker(), env = baseEnv();
  await withFetch(() => new Response('nope', { status: 404 }), async (calls) => {
    const res = await panelGet(w, env);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Retry-After'), '15');
    assert.match(await res.text(), /代理与订阅不受影响/);
    assert.equal(calls.length, 3);
    assert.equal((await panelGet(w, env)).status, 503);
    assert.equal(calls.length, 3, '冷却期内不再请求镜像');
    // 登录页内嵌，不依赖网络；订阅照常
    assert.equal((await w.fetch(new Request('https://node.example.com/login?next=' + encodeURIComponent('/' + UUID), { headers: { 'User-Agent': BROWSER } }), env, {})).status, 200);
  });
});

test('面板：并发首次访问只拉取一次', async () => {
  const w = await freshWorker(), env = baseEnv();
  await withFetch(async () => { await new Promise(r => setTimeout(r, 20)); return new Response(PANEL_FILE); }, async (calls) => {
    const rs = await Promise.all([panelGet(w, env), panelGet(w, env), panelGet(w, env)]);
    assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
    assert.equal(calls.length, 3, '三个镜像各一次，而不是 3×3');
  });
});

// ---------------- 主题：默认跟随系统，三态循环 ----------------
// 取面板脚本里「主题」一节，在桩出来的 window / document / localStorage 下执行
function themeHarness({ stored, systemLight = true } = {}) {
  const src = readFileSync(new URL('../src/panel/panel.js', import.meta.url), 'utf8');
  const section = src.slice(src.indexOf('/* ===== 主题'), src.indexOf('/* ===== 更新检测'));
  const store = new Map(stored === undefined ? [] : [['tp_theme', stored]]);
  const attrs = {}, toasts = [], listeners = [];
  const mq = { matches: systemLight, addEventListener: (_, fn) => listeners.push(fn) };
  const btn = { title: '', click: null, addEventListener(_, fn) { this.click = fn; } };
  const icon = { d: '', setAttribute(_, v) { this.d = v; } };
  const run = new Function('window', 'document', 'localStorage', '$', 'toast',
    section + '\n;return { storedTheme, applyTheme };');
  const api = run(
    { matchMedia: () => mq },
    { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } }, getElementById: (id) => (id === 'themeIcon' ? icon : null) },
    { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    () => btn, (m) => toasts.push(m));
  return { ...api, attrs, toasts, store, mq, btn, icon, fire: () => listeners.forEach(fn => fn()) };
}

test('主题：未保存时默认跟随系统（日间 / 夜间系统各自生效），无效取值按跟随系统处理', () => {
  assert.equal(themeHarness({ systemLight: true }).attrs['data-theme'], 'light');
  assert.equal(themeHarness({ systemLight: false }).attrs['data-theme'], 'dark');
  assert.equal(themeHarness({ stored: 'garbage', systemLight: false }).attrs['data-theme'], 'dark');
  assert.equal(themeHarness({ stored: 'garbage' }).storedTheme(), 'auto');
});

test('主题：按钮三态循环 跟随系统 → 日间 → 夜间 → 跟随系统，并保存选择', () => {
  const h = themeHarness({ systemLight: false });
  assert.equal(h.attrs['data-theme'], 'dark', '跟随系统（夜间系统）');
  h.btn.click(); assert.equal(h.store.get('tp_theme'), 'light'); assert.equal(h.attrs['data-theme'], 'light');
  h.btn.click(); assert.equal(h.store.get('tp_theme'), 'dark'); assert.equal(h.attrs['data-theme'], 'dark');
  h.btn.click(); assert.equal(h.store.get('tp_theme'), 'auto'); assert.equal(h.attrs['data-theme'], 'dark', '回到跟随系统');
  assert.deepEqual(h.toasts, ['已切换为日间模式', '已切换为夜间模式', '已切换为跟随系统']);
  assert.match(h.btn.title, /跟随系统/);
});

test('主题：跟随系统时系统主题变化立即生效；固定日间 / 夜间时不受影响', () => {
  const h = themeHarness({ systemLight: true });
  h.mq.matches = false; h.fire();
  assert.equal(h.attrs['data-theme'], 'dark');
  const fixed = themeHarness({ stored: 'light', systemLight: true });
  fixed.mq.matches = false; fixed.fire();
  assert.equal(fixed.attrs['data-theme'], 'light');
});

test('主题：页面头部提前套用主题，登录页同样默认跟随系统', () => {
  for (const f of ['panel', 'login']) {
    const html = readFileSync(new URL(`../src/panel/${f}.html`, import.meta.url), 'utf8');
    assert.match(html, /<\/title>\n<script>\(function\(\)\{var t='auto'/, `${f}.html 头部有提前套用主题的脚本`);
    assert.ok(!html.includes("|| 'light'"), `${f}.html 不再默认日间`);
  }
});

// ---------------- Clash 配置模板：与面板同一套「版本标签 + SHA-256 + 分层缓存」加载 ----------------
const clashSub = (w, env, path = 'sub/clash', ua = 'clash.meta') => w.fetch(new Request(`https://node.example.com/${UUID}/${path}`, { headers: { 'User-Agent': ua } }), env, {});
const clashEnv = () => baseEnv({ CONFIG_KV: kv({ config: customCfg() }) });
async function withRemoteClash(handler, fn) {   // 关闭本地直出，让 Clash 模板的请求走用例自己的 handler
  CLASH_FROM_LOCAL = false;
  try { return await withFetch((url, opts) => url.endsWith('/dist/clash-template.yaml') ? handler(url, opts) : nodesFetch(url), fn); }
  finally { CLASH_FROM_LOCAL = true; }
}

test('Clash 模板：来源固定为版本标签 v<VERSION>，哈希与 dist/clash-template.yaml 一致，Hopline.js 不内嵌模板', async () => {
  const w = await freshWorker(), urls = [];
  await withRemoteClash((url) => { urls.push(url); return new Response(CLASH_FILE); }, async () => {
    const res = await clashSub(w, clashEnv());
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /^# Hopline 订阅\ntest-url:/);
    assert.ok(body.includes('FilterHK') && body.includes('- GEOSITE,CN,直接连接'), '模板已拼在节点之后');
    assert.ok(!body.includes('__HOPLINE_'), '占位符均已替换');
  });
  const src = readFileSync(new URL('../Hopline.js', import.meta.url), 'utf8');
  const ver = src.match(/Hopline v(\d+\.\d+\.\d+)/)[1];
  assert.equal(urls.length, 3, '三个镜像并发请求');
  assert.ok(urls.every(u => u.includes('@v' + ver + '/dist/clash-template.yaml') || u.includes('/v' + ver + '/dist/clash-template.yaml')), urls.join('\n'));
  assert.ok(src.includes(createHash('sha256').update(CLASH_FILE).digest('hex')), '哈希已写进 Worker');
  assert.ok(!src.includes('FilterHK'), '模板不内嵌在 Hopline.js 里');
});

test('Clash 模板：拉取失败或被篡改时，只有 Clash / Stash 订阅返回 503，其它格式不受影响，也不缓存', async () => {
  for (const handler of [() => new Response('boom', { status: 502 }), () => new Response(CLASH_FILE.toString() + 'evil: 1\n')]) {
    const w = await freshWorker(), cache = memCache(), env = clashEnv();
    await withGlobals({ caches: { default: cache } }, () => withRemoteClash(handler, async () => {
      const res = await clashSub(w, env);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), '15');
      assert.match(await res.text(), /Clash 配置模板暂时无法加载/);
      assert.equal((await clashSub(w, env, 'sub/clash', 'Stash/2.7')).status, 503, 'Stash 同样走 Clash 模板');
      for (const [path, ua] of [['sub', 'v2rayN/7.0'], ['sub/singbox', 'sing-box/1.9'], ['sub/surge', 'Surge/5']]) {
        assert.equal((await clashSub(w, env, path, ua)).status, 200, path);
      }
    }));
    assert.deepEqual([...cache.m.keys()].filter(k => k.startsWith('https://hopline.invalid/clash/')), [], '校验失败的内容不进缓存');
    assert.deepEqual([...env.CONFIG_KV.m.keys()].filter(k => k.startsWith('clash:')), [], '也不写 KV');
  }
});

test('Clash 模板：成功后写入 Cache API 与 KV；新 isolate 直接命中缓存，不再请求网络', async () => {
  const w1 = await freshWorker(), cache = memCache(), env = clashEnv();
  const hash = createHash('sha256').update(CLASH_FILE).digest('hex');
  await withGlobals({ caches: { default: cache } }, async () => {
    await withRemoteClash(() => new Response(CLASH_FILE), async () => { assert.equal((await clashSub(w1, env)).status, 200); });
    assert.ok(cache.m.has('https://hopline.invalid/clash/' + hash), '写入 Cache API');
    assert.ok(env.CONFIG_KV.m.has('clash:' + hash), '写入 KV');
    const w2 = await freshWorker();
    await withRemoteClash(() => { throw new Error('不应请求网络'); }, async () => { assert.equal((await clashSub(w2, env)).status, 200); });
  });
});
