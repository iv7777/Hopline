// ---------------------------------------------------------------------------
// 面板调用代理的控制接口（签名的 HTTPS 请求；协议见 proxy-control.js）
// ---------------------------------------------------------------------------
// 面板与代理没有任何绑定关系：只需要代理的域名、节点路径与密钥，所以可以在不同的 Cloudflare 账号里。
// 代理必须使用自定义域名（Worker 对同一 zone 内 workers.dev / 路由上的另一个 Worker 发 fetch 会被 Cloudflare 拒绝，见错误 1042 / 1024）。
const CALL_TIMEOUT = 6000;
const CALL_BODY_MAX = 64 * 1024;
const PROXY_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// 面板只会连到管理员填写的域名：必须是域名（不是 IP）、不带端口 / 路径
function proxyHostOk(host) {
  host = String(host || '');
  return host.length <= 253 && PROXY_HOST_RE.test(host) && !isValidIp(host);
}
function randomNonce() { return b64uOfBytes(crypto.getRandomValues(new Uint8Array(16))); }

// 把 Cloudflare 的错误页 / 伪装页翻译成管理员能看懂的原因
function explainControlFailure(status, text) {
  const code = (String(text).match(/error code:\s*(\d{4})/i) || [])[1];
  if (code === '1042') return 'Cloudflare 拒绝了这次请求（错误 1042）：面板与代理在同一个 zone 里，代理必须用自定义域名（Custom Domain），不能是 workers.dev 或路由';
  if (code === '1024') return 'Cloudflare 拒绝了这次请求（错误 1024）：不能向 Cloudflare 的 IP 发请求，请填写代理的域名而不是 IP';
  if (code) return 'Cloudflare 返回了错误 ' + code;
  if (status === 503 && text) return '代理返回：' + String(text).trim().slice(0, 200);
  if (/Hello World/i.test(text)) return '代理没有响应控制请求：节点路径或密钥不对、代理还没设置 NODE_KEY，或代理脚本版本过旧';
  return '代理返回了无法识别的响应（HTTP ' + status + '）';
}
// 发一次签名请求并验证回应；失败抛 Error（message 可直接显示）。proxy：{ host, nodePath, key }；args 是对象，rawArgs 给出时原样作为参数文本（setState 要让代理保存的 JSON 与面板算哈希的一致）
async function callProxy(proxy, op, args, rawArgs) {
  if (!proxy || !proxy.key) throw new Error('这个代理还没有填写密钥');
  if (!proxyHostOk(proxy.host)) throw new Error('代理域名不正确（只能是域名，不能是 IP，也不带端口或路径）');
  const ts = Date.now(), n = randomNonce(), a = rawArgs !== undefined ? rawArgs : JSON.stringify(args || {});
  const body = JSON.stringify({ ts, n, op, a, s: await hmacB64u(proxy.key, ts + '.' + n + '.' + op + '.' + a) });
  const url = 'https://' + proxy.host + '/' + proxy.nodePath + '/' + await routeTag(proxy.key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT);
  let res, text;
  try {
    res = await fetch(url, { method: 'POST', body, redirect: 'manual', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' } });
    text = (await res.text()).slice(0, CALL_BODY_MAX);
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? '调用超时（代理 ' + CALL_TIMEOUT / 1000 + ' 秒内没有响应）' : '无法连接代理：' + ((e && e.message) || e));
  } finally { clearTimeout(timer); }
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* 不是 JSON：下面按失败说明 */ }
  if (!j || typeof j.d !== 'string' || typeof j.s !== 'string' || typeof j.ts !== 'number') throw new Error(explainControlFailure(res.status, text));
  if (!timingSafeEqual(await hmacB64u(proxy.key, j.ts + '.' + n + '.' + j.d), j.s)) throw new Error('代理的回应签名不对（密钥不一致？）');
  if (Math.abs(Date.now() - j.ts) > 60000) throw new Error('代理的回应时间偏差过大');
  const d = JSON.parse(j.d);
  if (!d || typeof d !== 'object') throw new Error('代理返回的内容不正确');
  return d;
}
// 把「操作失败」的结果（ok:false）转成 Error，方便调用方统一处理
async function callProxyOk(proxy, op, args, rawArgs) {
  const d = await callProxy(proxy, op, args, rawArgs);
  if (d.ok === false) throw Object.assign(new Error(String(d.error || '代理拒绝了这次操作')), { errors: Array.isArray(d.errors) ? d.errors : [] });
  return d;
}

// 同步：把面板保存的完整状态下发给代理（UUID、启用开关、运行设置、备用线路表）。面板没有 UUID 时先生成一个。
// 先读代理的 status，状态哈希一致就什么都不做。返回 { status, actions, patch, inSync }：
// patch 是要存回面板记录的字段（新生成的 UUID、清掉已过期的旧 UUID）；代理自己的环境变量有问题（status.ok 为假）时不下发
async function syncProxy(proxy, table) {
  const actions = [];
  let st = await callProxyOk(proxy, 'status', {});
  if (!st.ok) return { status: st, actions, patch: {}, inSync: false };
  const patch = {};
  if (!proxy.uuid) { patch.uuid = crypto.randomUUID(); actions.push('已生成 UUID'); }
  if (proxy.prev && proxy.prevUntil <= Date.now()) { patch.prev = ''; patch.prevUntil = 0; }
  const next = Object.assign({}, proxy, patch);
  const state = buildState(next, table);
  const raw = JSON.stringify(state);
  const want = await shortHash(raw);
  if (st.stateHash !== want) {
    const r = await callProxyOk(proxy, 'setState', null, raw);
    actions.push(st.provisioned ? '已把设置重新下发给代理' : '已把 UUID 与设置下发给代理');
    // 以 setState 的回应为准（代理写入 KV 后返回所存内容的哈希），不再另查一次 status：
    // 那次请求可能落在代理的另一个 isolate 上，它内存里还是旧状态，会误报「没有按下发的内容更新」
    st = Object.assign({}, st, { stateHash: String(r.stateHash || ''), provisioned: state.uuids.length > 0, enabled: state.enabled, kvError: '' });
  }
  return { status: st, actions, patch, inSync: st.stateHash === want };
}
