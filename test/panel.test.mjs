
// 面板与订阅测试（node:test，无第三方依赖）：直接加载构建产物 Hopline-panel.js，
// 用内存 Map 模拟 KV、桩替换外网 fetch。运行：npm test
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PANEL_VERSION, PROXY_VERSION } from './helpers-version.mjs';

import assert from 'node:assert/strict';

// 订阅生成会拉取外部优选源：测试环境一律离线，走各处的失败兜底
globalThis.fetch = async () => { throw new Error('offline in tests'); };

const worker = (await import('../Hopline-panel.js')).default;

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

const baseEnv = (extra = {}) => ({ UUID, PATH: UUID, ADMIN: 'pw', CONFIG_KV: kv(), HOST: 'node.example.com', NODE_PATH: UUID, ...extra });   // PATH、ADMIN 必填；路径取 UUID 的值，使 /<UUID> 即面板入口

// 固定节点列表：把若干 `IP:端口#名称` 行托管为「自定义优选 API 1」的响应（默认模式下唯一的节点来源），测试里用它精确控制节点
const NODE_LISTS = new Map();

const fixedNodes = (lines, extra = {}) => {
  const url = 'https://nodes.test/' + createHash('md5').update(lines).digest('hex') + '.txt';
  NODE_LISTS.set(url, lines);
  return { src: { prefDomain: false }, ipsrc: { hostmonit: false, uouin: false, api1: true, api1Url: url }, filter: { ipType: ['IPv4'] }, enableXhttp: false, ...extra };
};

const nodesFetch = (u) => NODE_LISTS.has(u) ? new Response(NODE_LISTS.get(u)) : new Response('Not Found', { status: 404 });

test('GET /api/config 返回字段表默认值及派生信息；代理端点（域名 / UUID / 节点路径）来自环境变量默认值', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const r = await (await call(env, `/${UUID}/api/config`, { cookie })).json();
  assert.equal(r.ok, true);
  const d = r.data;
  // 默认值（filter.region 为 ['all']，src 为面板保存的地址来源默认值）；XHTTP 默认开启，IP 类型默认只有 IPv4
  const legacy = {
    host: 'node.example.com', nodePath: UUID, enableVless: true, enableXhttp: true,
    alpn: '', ech: false, echHost: 'cloudflare-ech.com', echDns: '', tlsOnly: true,
    filter: { region: ['all'], ipType: ['IPv4'], isp: ['移动', '联通', '电信'] },
    src: { native: false, prefDomain: true, prefIp: true },
  };
  for (const [k, v] of Object.entries(legacy)) assert.deepEqual(d[k], v, k);
  for (const k of ['optimizer', 'preferredDomains', 'preferredIPs']) assert.equal(k in d, false, `已移除的自定义订阅 / 随机优选配置 ${k}`);
  assert.equal(d.uuid, UUID);
  assert.deepEqual(d.endpointMissing, [], '代理端点三项都有值');
  for (const k of ['edgeIP', 'hopAddr', 'hopMode', 'alt']) assert.equal(k in d, false, `出站 / 地区反代设置 ${k} 属于代理脚本，面板不再有`);
  assert.equal(d.path, UUID, '面板路径来自环境变量 PATH');
  assert.equal(d.panelPath, UUID);
  assert.equal(d.adminSet, true);
  assert.equal('admin' in d, false, '不下发管理密码');
  assert.deepEqual(d.envLocked, { path: 'PATH', admin: 'ADMIN' }, 'PATH 与 ADMIN 来自环境变量，面板只读');
  for (const k of ['nodeLimit', 'nodeLimitCount', 'polling', 'cfAccountId', 'cfApiToken', 'cfApiTokenSet', 'quotaAuto', 'caps']) assert.equal(k in d, false, `已移除的配额安全字段 ${k}`);
  assert.equal(d.ipsrc.uouin, true, 'uouin 默认开启');
  assert.equal(d.ipsrc.wetest, false, '微测网默认关闭');
});

test('保存非法的代理 UUID / 域名 / 节点路径被拒绝并返回字段级错误；留空允许（回退环境变量，没有环境变量则订阅提示未填写）', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  for (const [bad, field] of [[{ uuid: 'not-a-uuid' }, 'uuid'], [{ host: 'bad host' }, 'host'], [{ nodePath: 'a/b' }, 'nodePath'], [{ nodePath: 'a b' }, 'nodePath']]) {
    const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    const r = await res.json();
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].field, field);
  }
  assert.equal(env.CONFIG_KV.m.has('config'), false, '校验失败不写 KV');
  const ok = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { uuid: '', host: '', nodePath: '' } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).data.endpointMissing, [], '留空 = 回退环境变量 HOST / UUID / NODE_PATH');
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
    [{ nodePath: 'a/b' }, 'nodePath'],
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
      optimizer: { subRandomCount: '30', subMode: 'random' }, nodeLimitCount: 300, subUrl: '/mysub/sub', host: 'https://Node.Example.com/path', filter: { region: ['all', 'HK'] },
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
  assert.equal(s.subUrl, 'mysub');
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

test('修改代理端点（UUID / 域名 / 节点路径）与登录无关：不影响登录态，面板路径来自 PATH', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const res = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { uuid: UUID2.toUpperCase(), host: 'Other.Example.com', nodePath: '/other/' } });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  assert.equal(r.data.uuid, UUID2);
  assert.equal(r.data.host, 'Other.Example.com');
  assert.equal(r.data.nodePath, 'other');
  assert.equal(r.data.panelPath, UUID, '面板路径来自 PATH，不随代理 UUID 变化');
  assert.equal(res.headers.get('Set-Cookie'), null, '登录态签名不含代理 UUID：无需重新签发');
  assert.equal((await call(env, `/${UUID}/api/config`, { cookie })).status, 200, '原登录态继续有效');
});

test('代理端点没填全：面板照常使用并提示缺哪几项，订阅与预览返回明确的 400，填全后恢复', async () => {
  const env = baseEnv({ PATH: 'pp', HOST: undefined, NODE_PATH: undefined, UUID: undefined, CONFIG_KV: kv({ config: customCfg() }) });
  const cookie = await login(env, 'pw', 'pp');
  const cfg = (await (await call(env, '/pp/api/config', { cookie })).json()).data;
  assert.deepEqual(cfg.endpointMissing, ['代理域名', '代理 UUID', '代理节点路径']);
  assert.equal((await call(env, '/pp', { cookie })).status, 200, '面板页面可打开');
  const sub = await call(env, '/pp/sub', { ua: 'v2rayN/7.0' });
  assert.equal(sub.status, 400);
  assert.match(await sub.text(), /代理域名、代理 UUID、代理节点路径/);
  const pv = await call(env, '/pp/api/sub', { cookie });
  assert.equal(pv.status, 400);
  assert.match((await pv.json()).msg, /请先在面板「代理端点」里填写/);
  // 只填一部分：仍然提示还缺的
  const part = await call(env, '/pp/api/config', { method: 'POST', cookie, body: { host: 'proxy.example.com' } });
  assert.deepEqual((await part.json()).data.endpointMissing, ['代理 UUID', '代理节点路径']);
  // 在面板里填全后即可生成订阅（订阅别名默认是代理 UUID）
  const save = await call(env, '/pp/api/config', { method: 'POST', cookie, body: { host: 'proxy.example.com', uuid: UUID2, nodePath: 'np' } });
  assert.equal(save.status, 200);
  assert.deepEqual((await save.json()).data.endpointMissing, []);
  const links = await withFetch(nodesFetch, async () => (await (await call(env, `/${UUID2}/sub`, { ua: 'v2rayN/7.0' })).text()).split('\n').filter(l => /^vless:\/\//.test(l)));
  assert.ok(links.length > 0);
  assert.ok(links.every(l => l.startsWith(`vless://${UUID2}@`) && /[?&]sni=proxy\.example\.com(&|#)/.test(l) && /path=%2Fnp(%3F|&)/.test(l)));
});

test('面板页面：代理端点三项在「面板设置」里，出站 / 落地 / 地区反代在单独的「代理设置」页（不属于面板配置）；页面内嵌，不依赖网络', async () => {
  const env = baseEnv();
  const res = await call(env, `/${UUID}`, { cookie: await login(env) });
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const id of ['a-host', 'a-uuid', 'a-nodepath', 'epwarn']) assert.ok(html.includes(`id="${id}"`), id);
  for (const id of ['s-proxyIP', 's-outbound', 's-outmode', 'rl-mode', 'rl-region', 'rl-region2', 'rl-custom', 'px-note', 'px-save', 'px-reset']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('data-view="proxy"') && html.includes('function saveProxySettings(') && html.includes('function loadProxySettings('));
  assert.ok(html.includes('var SCHEMA = ') && !html.includes('/*@HOPLINE_SCHEMA@*/'), '字段表已注入');
  const schema = JSON.parse(html.match(/var SCHEMA = (\[.*?\]) \|\| \[\];/s)[1]);
  const keys = schema.map(d => d.key);
  for (const k of ['host', 'uuid', 'nodePath']) assert.ok(keys.includes(k), k);
  for (const k of ['edgeIP', 'hopAddr', 'hopMode', 'alt.mode', 'alt.region', 'alt.region2', 'alt.custom']) assert.ok(!keys.includes(k), `${k} 是代理的设置，不在面板的字段表里`);
  // 页面里每个字段表登记的控件都存在（回填 / 收集依赖它）
  for (const d of schema) for (const id of [d.el, ...Object.values(d.els || {})].filter(Boolean)) assert.ok(html.includes(`id="${id}"`), `${d.key} → #${id}`);
});

test('构建产物：面板脚本不含任何代理代码（sockets、WebSocket、XHTTP、出站、VLESS 头解析），也不再从网络拉取面板页面或 Clash 模板', () => {
  const code = readFileSync(new URL('../Hopline-panel.js', import.meta.url), 'utf8');
  for (const needle of ['cloudflare:sockets', 'WebSocketPair', 'handleWsProto', 'handleXhtProto', 'openUpstream', 'connectViaS5', 'parseVssProtoHeader', 'ALT_DOMAINS', 'proxyip.hk', 'assetFromNetwork', 'sha256Hex', 'IS_OBFUSCATED', 'dist/panel.html', 'clash-template.yaml']) {
    assert.ok(!code.includes(needle), needle);
  }
  assert.match(code, /^\/\*!Hopline-panel v\d+\.\d+\.\d+\*\//);
  assert.match(readFileSync(new URL('../Hopline-proxy.js', import.meta.url), 'utf8'), /^\/\*!Hopline-proxy v\d+\.\d+\.\d+\*\//);
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

test('面板路径（PATH）与代理节点路径（NODE_PATH）互相独立：面板入口在 PATH 下，节点链接用代理端点的路径；面板没有任何代理入口；订阅仍可从 /<UUID>/sub 取得', async () => {
  const env = baseEnv({ PATH: 'mypanel', NODE_PATH: 'mynode', HOST: 'proxy.example.org', CONFIG_KV: kv({ config: customCfg() }) });
  assert.equal((await call(env, `/${UUID}`, { ua: BROWSER })).status, 200, 'UUID 路径不是面板入口（返回伪装页）');
  assert.equal((await call(env, '/mypanel', { ua: BROWSER })).status, 302, '面板入口在 PATH 下，未登录跳转登录页');
  const links = await withFetch(nodesFetch, async () => (await (await call(env, `/${UUID}/sub`, { ua: 'v2rayN/7.0' })).text()).split('\n').filter(l => /^vless:\/\//.test(l)));
  assert.ok(links.length > 0);
  assert.ok(links.every(l => l.startsWith(`vless://${UUID}@`)), '代理 UUID 作为用户 ID');
  assert.ok(links.every(l => /path=%2Fmynode(%3F|&)/.test(l)), '节点 ws 路径为代理节点路径 /<NODE_PATH>，而不是面板路径');
  assert.ok(links.every(l => /[?&]host=proxy\.example\.org(&|#)/.test(l) && /[?&]sni=proxy\.example\.org(&|#)/.test(l)), 'SNI / Host 为代理域名，而不是访问面板的域名');
  // 面板脚本没有代理：无论面板路径还是节点路径，WebSocket 升级与 XHTTP POST 都不会被代理
  for (const p of ['/mypanel', '/mynode']) {
    const ws = await worker.fetch(new Request('https://panel.example.com' + p, { headers: { Upgrade: 'websocket' } }), env, {});
    assert.notEqual(ws.status, 101, p);
    const post = await worker.fetch(new Request('https://panel.example.com' + p, { method: 'POST', body: 'x' }), env, {});
    assert.notEqual(post.headers.get('content-type'), 'application/octet-stream', p);
  }
});

test('环境变量：使用当前名称；旧版短变量名（U / D / S / K / ECH / OUTBOUND / admin）不再识别', async () => {
  const read = async (env, path) => {
    const cookie = await login(env, 'pw', path);
    return (await (await call(env, `/${path}/api/config`, { cookie })).json()).data;
  };
  const base = { UUID: undefined, PATH: undefined, ADMIN: 'pw', CONFIG_KV: kv() };
  const a = await read({ ...base, UUID: UUID2, PATH: 'newpath', HOST: 'https://Node.Example.com/x', NODE_PATH: '/np/', ALPN: 'h2', ENABLE_ECH: 'true' }, 'newpath');
  assert.equal(a.uuid, UUID2); assert.equal(a.host, 'Node.Example.com'); assert.equal(a.nodePath, 'np'); assert.equal(a.alpn, 'h2'); assert.equal(a.ech, true);
  assert.deepEqual(a.endpointMissing, []);
  assert.equal(a.envLocked.path, 'PATH');
  // 旧名称被忽略：代理端点未填写（不再自动生成 UUID），ECH 保持默认；代理的出站设置（HOP_ADDR 等）面板不再读取
  const b = await read({ ...base, PATH: 'p1', U: UUID2, OUTBOUND: 'socks5://2.2.2.2:2', HOP_ADDR: 'socks5://3.3.3.3:3', S: 'socks5://3.3.3.3:3', ECH: 'true' }, 'p1');
  assert.equal(b.uuid, ''); assert.equal('hopAddr' in b, false); assert.equal(b.ech, false);
  assert.deepEqual(b.endpointMissing, ['代理域名', '代理 UUID', '代理节点路径']);
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
  const env = baseEnv({ CONFIG_KV: kv({ config: { subUrl: 'mysub', filter: { ipType: ['IPv4'] } } }) });
  const cookie = await login(env);
  const sub = await call(env, '/mysub/sub', { ua: 'v2rayN/7.0' });
  assert.equal(sub.status, 200);
  assert.match(await sub.text(), /^vless:\/\//m);
  assert.equal((await call(env, '/mysub', { cookie })).status, 200, '别名下不提供面板');
  assert.equal((await call(env, '/mysub/api/config', { cookie })).status, 200, '别名下不提供管理接口');
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
  const env2 = baseEnv({ PATH: 'panel', CONFIG_KV: kv({ config: { subUrl: 'mysub' } }) });
  assert.equal((await call(env2, '/mysub/sub', { ua: 'v2rayN/7.0' })).status, 200);
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
  // 不假设函数源码是单行（构建产物不再经 terser 压缩，toString() 下来的是原始多行格式）
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

test('检测更新：以仓库 Hopline-panel.js 为基准，有更新时直接返回其内容，60 秒内走缓存；只检测面板脚本（没有混淆版）', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const status = await (await call(env, `/${UUID}/api/status`, { cookie })).json();
  assert.equal('obfuscated' in status.data, false, '面板脚本没有混淆版');
  const offline = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url) === 'https://raw.githubusercontent.com/iv7777/Hopline/main/Hopline-panel.js') {
      return new Response("/*!Hopline-panel v9.9.9*/\nconst a=1;\n");
    }
    return new Response('Not Found', { status: 404 });
  };
  try {
    const r = await (await call(env, `/${UUID}/api/update`, { cookie })).json();
    assert.equal(r.ok, true);
    assert.equal(r.data.latest, '9.9.9');
    assert.equal(r.data.hasUpdate, true);
    assert.match(r.data.code, /^\/\*!Hopline-panel v9\.9\.9\*\//);
    assert.deepEqual(seen, ['https://raw.githubusercontent.com/iv7777/Hopline/main/Hopline-panel.js'], '只请求 Hopline-panel.js');
    const again = await (await call(env, `/${UUID}/api/update`, { cookie })).json();
    assert.equal(again.data.latest, '9.9.9');
    assert.equal(seen.length, 1, '60 秒内复用缓存');
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
  const env = baseEnv({ ADMIN: undefined, HOST: 'env.example.com', NODE_PATH: 'envnode', ALPN: 'h2',
    CONFIG_KV: kv({ config: { admin: 'pw' } }) });
  const first = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie: await login(env), body: { tlsOnly: false } });
  const r = await first.json();
  assert.equal(r.ok, true);
  const cookie = first.headers.get('Set-Cookie').split(';')[0];   // 旧版明文密码升级为摘要后登录态重新签发
  const s = stored(env);
  for (const k of ['host', 'nodePath', 'alpn', 'uuid']) assert.equal(k in s, false, `${k} 不应固化进 KV`);
  assert.equal(s.tlsOnly, false, '面板里改动的其它项正常保存');
  // 环境变量之后变更，立即生效（KV 中没有旧快照）
  const later = { ...env, HOST: 'new-env.example.com', NODE_PATH: 'newnode' };
  const cfgRes = await call(later, `/${UUID}/api/config`, { cookie });
  const cfg = await cfgRes.json();
  assert.equal(cfg.data.host, 'new-env.example.com');
  assert.equal(cfg.data.nodePath, 'newnode');
  // 面板中改成不同的值：保存为覆盖
  await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { host: 'mine.example.com', nodePath: 'mine', alpn: 'http/1.1' } });
  assert.equal(stored(env).host, 'mine.example.com');
  assert.equal(stored(env).nodePath, 'mine');
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

test('节点 SNI / Host 取代理域名（环境变量 HOST 或面板设置），不再取访问面板的域名；链接、Clash、sing-box 均如此', async () => {
  const sub = (env, ua, fmt = '') => withFetch(nodesFetch, async () => (await (await call(env, `/${UUID}/sub${fmt}`, { ua })).text()));
  const fromEnv = baseEnv({ HOST: 'proxy.example.net', CONFIG_KV: kv({ config: customCfg() }) });
  const links = (await sub(fromEnv, 'v2rayN/7.0')).split('\n').filter(l => /^vless:\/\//.test(l));
  assert.ok(links.length > 0);
  for (const l of links) {
    assert.match(l, /[?&]sni=proxy\.example\.net(&|#)/, l);
    assert.match(l, /[?&]host=proxy\.example\.net(&|#)/, l);
    assert.ok(!l.includes('node.example.com'), '访问面板用的域名 node.example.com 不出现在节点里');
  }
  assert.match(await sub(fromEnv, 'clash.meta', '?fmt=clash'), /servername: proxy\.example\.net/);
  assert.match(await sub(fromEnv, 'sing-box/1.9', '?fmt=singbox'), /"server_name":\s*"proxy\.example\.net"/);
  // 面板里填写的以面板为准
  const bound = baseEnv({ HOST: 'proxy.example.net', CONFIG_KV: kv({ config: customCfg({ host: 'sub.example.org' }) }) });
  for (const l of (await sub(bound, 'v2rayN/7.0')).split('\n').filter(l => /^vless:\/\//.test(l))) {
    assert.match(l, /[?&]sni=sub\.example\.org(&|#)/, l);
    assert.match(l, /[?&]host=sub\.example\.org(&|#)/, l);
  }
});

test('KV 读取失败：用环境变量的默认值照常出订阅，保存与重置被拒绝且不会覆盖已有配置；恢复后原有配置还在', async () => {
  const k = failingKv({ config: { alpn: 'h2' } });
  const env = baseEnv({ CONFIG_KV: k });
  const cookie = await login(env);                                   // ADMIN 来自环境变量，不依赖 KV
  assert.equal((await withFetch(notFound, async () => call(env, `/${UUID}/sub`, { ua: 'v2rayN/7' }))).status, 200, '订阅仍可用');
  const cfg = await (await call(env, `/${UUID}/api/config`, { cookie })).json();
  assert.match(cfg.data.kvError, /KV 暂时无法读取/);
  const save = await call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body: { alpn: 'http/1.1' } });
  assert.equal(save.status, 503);
  assert.equal(k.puts, 0, '没有向 KV 写入任何内容');
  assert.equal((await call(env, `/${UUID}/api/reset`, { method: 'POST', cookie })).status, 503);
  assert.equal(k.m.has('config'), true, '配置未被删除');
  k.setDown(false);
  const after = await (await call(env, `/${UUID}/api/config`, { cookie })).json();
  assert.equal(after.data.alpn, 'h2');
  assert.equal(after.data.kvError, '');
});

test('检测更新：仓库 main 上没有 Hopline-panel.js（404）时给出明确原因，而不是只说 HTTP 404；其它错误码照旧', async () => {
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000;   // 越过其它用例留在模块里的 60 秒更新缓存
  const env = baseEnv();
  const cookie = await login(env);
  const offline = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('404: Not Found', { status: 404 });
    const r = await (await call(env, `/${UUID}/api/update`, { cookie })).json();
    assert.equal(r.ok, true);
    assert.equal(r.data.hasUpdate, false);
    assert.equal(r.data.latest, null);
    assert.match(r.data.error, /仓库 main 分支上没有 Hopline-panel\.js（HTTP 404）/);
    assert.match(r.data.error, /还没有合并发布到 main|不是公开的/);
    globalThis.fetch = async () => new Response('boom', { status: 502 });
    const r2 = await (await call(env, `/${UUID}/api/update`, { cookie })).json();
    assert.equal(r2.data.error, 'Hopline-panel.js HTTP 502');
  } finally { globalThis.fetch = offline; Date.now = realNow; }
});

test('代理状态 /api/proxy-status：需登录；没有服务绑定 PROXY 时返回 bound:false，面板其它功能不受影响', async () => {
  const env = baseEnv();
  assert.equal((await call(env, `/${UUID}/api/proxy-status`)).status, 403, '未登录');
  const r = await (await call(env, `/${UUID}/api/proxy-status`, { cookie: await login(env) })).json();
  assert.deepEqual(r, { ok: true, data: { bound: false } });
});

test('代理状态：绑定后显示在线与版本、非敏感设置摘要；代理配置有问题、调用失败、超时都不会让面板报错', async () => {
  const get = async (proxy) => {
    const env = baseEnv({ PROXY: proxy });
    return (await (await call(env, `/${UUID}/api/proxy-status`, { cookie: await login(env) })).json()).data;
  };
  const up = await get({ status: async () => ({ ok: true, version: '9.9.9', problems: [], control: false, storage: false, settings: { edgeIP: true, hopAddr: 'socks5', hopMode: '', altMode: 'builtin', altRegion: '', altRegion2: '', altCustom: 0 } }) });
  assert.deepEqual(up, { bound: true, up: true, ok: true, version: '9.9.9', problems: [], control: false, storage: false, settings: { edgeIP: true, hopAddr: 'socks5', hopMode: '', altMode: 'builtin', altRegion: '', altRegion2: '', altCustom: 0 } });
  const bad = await get({ status: async () => ({ ok: false, version: '3.0.1', problems: ['请设置环境变量 UUID（节点用户 ID）。'] }) });
  assert.equal(bad.up, true); assert.equal(bad.ok, false); assert.deepEqual(bad.problems, ['请设置环境变量 UUID（节点用户 ID）。']);
  const down = await get({ status: async () => { throw new Error('The RPC receiver does not implement the method "status".'); } });
  assert.equal(down.bound, true); assert.equal(down.up, false); assert.match(down.error, /does not implement/);
  const junk = await get({ status: async () => 'not an object' });
  assert.equal(junk.up, false); assert.match(junk.error, /返回内容不正确/);
  // 超时：状态调用一直不返回（把 4 秒的超时缩短到 5ms 来测）
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 4000 ? 5 : ms, ...a);
  try {
    const hung = await get({ status: () => new Promise(() => {}) });
    assert.equal(hung.up, false); assert.match(hung.error, /调用超时/);
  } finally { globalThis.setTimeout = realSetTimeout; }
});

test('面板页面有「代理状态」行与检测按钮；两个脚本的横幅版本号各自对应自己的版本文件', async () => {
  const env = baseEnv();
  const html = await (await call(env, `/${UUID}`, { cookie: await login(env) })).text();
  for (const id of ['stProxy', 'stProxyHint']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('onclick="checkProxy()"') && html.includes('function checkProxy('));
  const v = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').match(/^\/\*!Hopline-\w+ v([\d.]+)\*\//)[1];
  assert.equal(v('../Hopline-panel.js'), PANEL_VERSION);
  assert.equal(v('../Hopline-proxy.js'), PROXY_VERSION);
});

test('代理设置 API：需登录；没有服务绑定时给出明确提示；方法与请求体校验', async () => {
  const env = baseEnv();
  const base = `/${UUID}/api/proxy-settings`;
  for (const [path, method] of [[base, 'GET'], [base, 'POST'], [`/${UUID}/api/proxy-reset`, 'POST']]) assert.equal((await call(env, path, { method, body: method === 'POST' ? {} : undefined })).status, 403, path + ' 未登录');
  const cookie = await login(env);
  const g = await call(env, base, { cookie });
  assert.equal(g.status, 400);
  assert.match((await g.json()).msg, /没有绑定服务绑定 PROXY.*NodeControl/);
  assert.equal((await call(env, `/${UUID}/api/proxy-reset`, { method: 'POST', cookie })).status, 400);
  const bound = baseEnv({ PROXY: { setSettings: async () => ({ ok: true }) } });
  const c2 = await login(bound);
  assert.equal((await call(bound, base, { method: 'PUT', cookie: c2 })).status, 405);
  assert.equal((await call(bound, base, { method: 'POST', cookie: c2, body: '{bad' })).status, 400);
  assert.equal((await call(bound, base, { method: 'POST', cookie: c2, body: '[1]' })).status, 400);
  assert.equal((await call(bound, `/${UUID}/api/proxy-reset`, { cookie: c2 })).status, 405, 'proxy-reset 只接受 POST');
});

test('代理设置 API：读取 / 保存 / 恢复都转给代理的 NodeControl；代理的校验错误原样回给面板（400 + 字段级错误）；调用失败 / 超时 / 绑定了只读入口时给出提示', async () => {
  const calls = [];
  const settings = { edgeIP: 'p.example', hopAddr: '', hopMode: '', 'alt.mode': 'builtin', 'alt.region': '', 'alt.region2': '', 'alt.custom': '' };
  const proxy = {
    getSettings: async () => { calls.push(['get']); return { ok: true, storage: true, settings, env: settings, source: {}, regions: ['HK'], error: '' }; },
    setSettings: async (b) => { calls.push(['set', b]); return b.hopMode === 'bad' ? { ok: false, error: '出站方式：不支持的选项', errors: [{ field: 'hopMode', msg: '出站方式：不支持的选项' }] } : { ok: true, storage: true, settings: { ...settings, ...b }, ignored: [] }; },
    resetSettings: async () => { calls.push(['reset']); return { ok: true, storage: true, settings }; },
  };
  const env = baseEnv({ PROXY: proxy });
  const cookie = await login(env);
  const api = (path, init = {}) => call(env, `/${UUID}/api/${path}`, { cookie, ...init });
  const g = await (await api('proxy-settings')).json();
  assert.equal(g.ok, true); assert.equal(g.data.settings.edgeIP, 'p.example'); assert.deepEqual(g.data.regions, ['HK']);
  const s = await (await api('proxy-settings', { method: 'POST', body: { hopMode: 'only', 'alt.mode': 'off' } })).json();
  assert.equal(s.ok, true); assert.equal(s.data.settings.hopMode, 'only');
  assert.deepEqual(calls[1], ['set', { hopMode: 'only', 'alt.mode': 'off' }], '请求体原样转给代理');
  const e = await api('proxy-settings', { method: 'POST', body: { hopMode: 'bad' } });
  assert.equal(e.status, 400);
  const ej = await e.json();
  assert.equal(ej.ok, false); assert.equal(ej.errors[0].field, 'hopMode'); assert.match(ej.msg, /不支持的选项/);
  assert.equal((await (await api('proxy-reset', { method: 'POST' })).json()).ok, true);
  assert.equal(calls.at(-1)[0], 'reset');
  // 代理调用失败（如绑定的是只读入口 NodeStatus，没有这些方法）
  const ro = baseEnv({ PROXY: { status: async () => ({ ok: true }) } });
  const r = await call(ro, `/${UUID}/api/proxy-settings`, { cookie: await login(ro) });
  assert.equal(r.status, 502);
  assert.match((await r.json()).msg, /无法调用代理.*入口是 NodeControl/);
  // 超时
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 4000 ? 5 : ms, ...a);
  try {
    const hung = baseEnv({ PROXY: { getSettings: () => new Promise(() => {}) } });
    const h = await call(hung, `/${UUID}/api/proxy-settings`, { cookie: await login(hung) });
    assert.equal(h.status, 502); assert.match((await h.json()).msg, /调用超时/);
  } finally { globalThis.setTimeout = realSetTimeout; }
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

import { assemble } from '../build.mjs';

// 内部函数不对外导出，且构建产物里名称已被 terser 重命名；改用未压缩的合并源码（assemble），
// 去掉 import / export default 后在函数作用域内求值，取出要测的纯函数
const internals = (() => {
  const src = assemble('panel')
    .replace(/^import .*$/m, '').replace('export default {', 'const __default = {');
  return new Function('connect', src + '\n;return { md5hex, sha224hex, HTTP_PORTS, ipInCidrV6, isValidIp, loginRateKey, SERVER_CHECKS, effectivePrefDomains, DEFAULT_PREFERRED_DOMAINS };')(() => { throw new Error('no sockets'); });
})();



const lens = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000];   // 覆盖填充边界

const msgOf = (n) => 'x'.repeat(n);

test('MD5 / SHA-224 与 node:crypto 结果一致（含 RFC 已知答案与填充边界）', () => {
  assert.equal(internals.md5hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(internals.md5hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(internals.sha224hex('abc'), '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
  for (const n of lens) {
    const m = msgOf(n);
    assert.equal(internals.md5hex(m), createHash('md5').update(m).digest('hex'), `md5 len ${n}`);
    assert.equal(internals.sha224hex(m), createHash('sha224').update(m).digest('hex'), `sha224 len ${n}`);
  }
});

test('面板注入服务端的明文端口表（不再各存一份）', async () => {
  const env = baseEnv();
  const html = await (await call(env, `/${UUID}`, { cookie: await login(env) })).text();
  assert.ok(html.includes('var HTTP_PORTS = ' + JSON.stringify([...internals.HTTP_PORTS])), '注入值与服务端 HTTP_PORTS 一致');
  assert.ok(!html.includes('/*@HOPLINE_HTTP_PORTS@*/'), '占位符已替换');
});

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

test('保存校验：非法优选域名给出字段级错误；配置可往返；出站 / 地区反代设置属于代理脚本，面板保存时直接忽略', async () => {
  const env = baseEnv();
  const cookie = await login(env);
  const save = (body) => call(env, `/${UUID}/api/config`, { method: 'POST', cookie, body });
  let r = await save({ prefDomains: 'https://bad.example.com' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).errors[0].field, 'prefDomains');
  r = await save({ prefDomains: 'Z.Example.com\na.example.com', edgeIP: 'x.example.com', hopAddr: 'socks5://1.2.3.4:1', hopMode: 'only', alt: { mode: 'custom', custom: 'a.example.com' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.data.prefDomains, 'z.example.com\na.example.com');
  assert.deepEqual(j.ignored.sort(), ['alt', 'edgeIP', 'hopAddr', 'hopMode'], '代理的出站设置不是面板配置项');
  for (const k of ['edgeIP', 'hopAddr', 'hopMode', 'alt']) { assert.equal(k in j.data, false, k); assert.equal(k in stored(env), false, k); }
  assert.equal(j.data.builtinPrefDomains.length, 14, '面板「载入内置列表」所需');
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

test('sing-box 的 VLESS 出站不再指定 packet_encoding=xudp（服务端不支持 Mux/XUDP，只支持 UDP-DNS）', async () => {
  const env = baseEnv({ CONFIG_KV: kv({ config: customCfg() }) });
  const sb = JSON.parse(await (await subOf(env, 'singbox')).text());
  const vless = sb.outbounds.filter(o => o.type === 'vless');
  assert.ok(vless.length > 0 && vless.every(o => !('packet_encoding' in o)));
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
