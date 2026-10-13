// ---------------------------------------------------------------------------
// 代理的状态：面板整份下发（控制接口 setState），代理只存、只读，不做合并
// ---------------------------------------------------------------------------
// 保存在代理自己的 KV 里（绑定变量名 NODE_KV，单独的命名空间），一个键 state，内容就是面板发来的那段 JSON 原文：
//   uuids      [[UUID, 失效时间]]：接受的 UUID（失效时间 0 = 不失效）；轮换后旧 UUID 带一个 10 分钟的失效时间，在途连接与尚未更新订阅的客户端不会立刻断开
//   enabled    false = 停用：节点路径与其它路径一样只返回伪装页（控制接口仍可用，用来重新启用）
//   edgeIP     反代 / 落地 IP（host 或 host:port）：填写后作为固定出口优先使用
//   hop        出站代理 { type: socks5 | http | https, host, port, user, pass } 或 null
//   hopMode    '' = 出站代理优先，失败后直连 ∥ 备用线路；only = 仅走出站代理（失败用备用线路兜底）
//   altTable   备用线路表：标签 → { host, port, txt }
//   altPick    备用线路的优先顺序：标签列表，auto = 按 Worker 机房选最近的地区；空 = 不使用备用线路
// 面板是唯一的写入方，所以没有读-改-写，也不需要合并：整份覆盖，重复下发无副作用。状态的短哈希（stateHash）随 status 返回，面板据此判断两边是否一致。
// 没有 NODE_KV 时无处保存状态，代理无法被面板配置好，节点路径上只会返回伪装页。
// 读取走 isolate 内存缓存（STATE_MEM_TTL）+ KV 边缘缓存，每个 isolate 约每 20 秒读一次 KV；只有节点路径上的连接才会触发。
// KV 读取失败时沿用上一次读到的状态（从没读到过就视为未配置），绝不因此影响已有连接。
const STATE_KEY = 'state';
const STATE_MEM_TTL = 20 * 1000;
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const TAG_RE = /^[A-Za-z0-9_-]{1,16}$/;
const STATE_KEYS = ['uuids', 'enabled', 'edgeIP', 'hop', 'hopMode', 'altTable', 'altPick'];
const NO_KV_MSG = '代理没有绑定 KV（变量名 NODE_KV），无法保存：UUID 与设置都保存在这个 KV 里，请先给代理绑定一个单独的 KV 命名空间';

function emptyState() {
  return { uuids: [], enabled: true, edgeIP: '', hop: null, hopMode: '', altTable: {}, altPick: [] };
}
function nodeKv(env) {
  const kv = env && env.NODE_KV;
  return kv && typeof kv === 'object' && typeof kv.get === 'function' ? kv : null;
}
const okHost = (h) => typeof h === 'string' && h.length <= 253 && (isValidIp(h) || HOSTNAME_RE.test(h));
const okPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

// 校验面板发来的状态：返回错误说明，没问题返回 ''（只做类型与长度检查，防止坏数据让代理出错；内容的友好校验在面板里做）
function checkState(st) {
  if (!isObj(st)) return '状态必须是 JSON 对象';
  for (const k of Object.keys(st)) if (!STATE_KEYS.includes(k)) return '未知字段：' + k.slice(0, 40);
  if (!Array.isArray(st.uuids) || st.uuids.length > 4 || !st.uuids.every(u => Array.isArray(u) && typeof u[0] === 'string' && isUUID(u[0]) && Number.isFinite(u[1]) && u[1] >= 0)) return 'uuids 不正确';
  if (typeof st.enabled !== 'boolean') return 'enabled 必须是布尔值';
  if (typeof st.edgeIP !== 'string' || st.edgeIP.length > 260) return 'edgeIP 不正确';
  if (st.edgeIP) { const e = parseHostPort(st.edgeIP, 443); if (!okHost(e.host) || !okPort(e.port)) return 'edgeIP 不是有效的 host 或 host:port'; }
  if (st.hopMode !== '' && st.hopMode !== 'only') return 'hopMode 不正确';
  const h = st.hop;
  if (h !== null && !(isObj(h) && ['socks5', 'http', 'https'].includes(h.type) && okHost(h.host) && okPort(h.port) && (h.user === undefined || (typeof h.user === 'string' && h.user.length <= 255)) && (h.pass === undefined || (typeof h.pass === 'string' && h.pass.length <= 255)))) return 'hop 不正确';
  if (!isObj(st.altTable) || Object.keys(st.altTable).length > 32) return 'altTable 不正确';
  for (const [tag, e] of Object.entries(st.altTable)) {
    if (!TAG_RE.test(tag) || !isObj(e) || !okHost(e.host) || (e.port !== undefined && !okPort(e.port)) || (e.txt !== undefined && typeof e.txt !== 'boolean')) return 'altTable 里的「' + tag.slice(0, 20) + '」不正确';
  }
  if (!Array.isArray(st.altPick) || st.altPick.length > 8 || !st.altPick.every(t => typeof t === 'string' && TAG_RE.test(t))) return 'altPick 不正确';
  return '';
}

// 读 KV 里保存的状态：返回 { raw, state, error }（error：'' / 'unavailable' / 'corrupt'）；带 isolate 内存缓存
const STATE_MEM = new WeakMap();
async function readNodeState(kv) {
  const now = Date.now(), hit = STATE_MEM.get(kv);
  if (hit && now - hit.t < STATE_MEM_TTL) return hit;
  let entry;
  try {
    const raw = await kv.get(STATE_KEY, { cacheTtl: 30 });
    let state = emptyState(), error = '';
    if (raw) {
      try { const obj = JSON.parse(raw); if (checkState(obj)) throw new SyntaxError('invalid'); state = obj; }
      catch (e) { error = 'corrupt'; }
    }
    entry = { t: now, raw: error ? '' : (raw || ''), state, error };
  } catch (e) {
    // 读取失败：沿用上一次读到的状态，5 秒后重试；从没读到过就视为未配置
    entry = { t: now - STATE_MEM_TTL + 5000, raw: hit ? hit.raw : '', state: hit ? hit.state : emptyState(), error: 'unavailable' };
  }
  STATE_MEM.set(kv, entry);
  return entry;
}

// 代理运行时使用的配置：环境变量 + KV 里的状态。没有 NODE_KV 或环境变量有问题时就是环境变量本身（没有 UUID）
async function loadNodeConfig(env, base) {
  const cfg = base || nodeConfig(env);
  const kv = nodeKv(env);
  if (!kv || cfg._problems.length) return cfg;
  const { state } = await readNodeState(kv);
  const now = Date.now();
  return Object.assign(cfg, state, { uuids: state.uuids.filter(u => !u[1] || u[1] > now).map(u => u[0]) });
}

// 控制接口 setState：raw 是面板发来的 JSON 原文（校验通过后原样保存，stateHash 因此与面板算出的一致）
async function setNodeState(env, raw) {
  const kv = nodeKv(env);
  if (!kv || typeof kv.put !== 'function') return { ok: false, error: NO_KV_MSG };
  let st;
  try { st = JSON.parse(raw); } catch (e) { return { ok: false, error: '状态不是合法的 JSON' }; }
  const bad = checkState(st);
  if (bad) return { ok: false, error: bad };
  try { await kv.put(STATE_KEY, raw); }
  catch (e) { return { ok: false, error: 'KV 写入失败：' + ((e && e.message) || e) }; }
  STATE_MEM.set(kv, { t: Date.now(), raw, state: st, error: '' });
  return { ok: true, stateHash: await shortHash(raw) };
}

// 状态：是否在线 / 版本 / 配置问题 / 是否已下发 UUID / 是否启用 / 状态哈希（不含任何设置内容）
async function nodeStatus(env) {
  const base = nodeConfig(env);
  const kv = nodeKv(env);
  let entry = { raw: '', state: emptyState(), error: '' };
  if (kv && !base._problems.length) entry = await readNodeState(kv);
  return {
    ok: base._problems.length === 0,
    version: VERSION,
    problems: base._problems,
    storage: !!kv,
    kvError: entry.error,
    provisioned: entry.state.uuids.length > 0,
    enabled: entry.state.enabled,
    stateHash: entry.raw ? await shortHash(entry.raw) : '',
  };
}
