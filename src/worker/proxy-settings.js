// ---------------------------------------------------------------------------
// 代理的在线状态：身份（UUID）、启用开关与运行设置，由面板通过控制接口（proxy-control.js）读写
// ---------------------------------------------------------------------------
// 保存在代理自己的 KV 里（绑定变量名 NODE_KV，单独的命名空间，只有代理绑定它），一个键 state：
//   { uuid, prev, prevUntil, enabled, set }
//   uuid / prev / prevUntil  当前 UUID；轮换后旧 UUID 在 prevUntil 之前仍被接受（10 分钟宽限，在途连接与尚未更新订阅的客户端不会立刻断开）
//   enabled                  false = 停用：节点路径与其它路径一样只返回伪装页（控制接口仍可用，用来重新启用）
//   set                      7 项运行设置的覆盖项，优先级：这里 > 环境变量 > 默认值；与环境变量相同的值不落盘
// 没有 NODE_KV 时无处保存 UUID，代理无法被面板配置好，节点路径上只会返回伪装页。
// 读取走 isolate 内存缓存（STATE_MEM_TTL）+ KV 边缘缓存，每个 isolate 约每 20 秒读一次 KV；只有节点路径上的连接才会触发。
// KV 读取失败时沿用上一次读到的状态（从没读到过就视为未配置），绝不因此影响已有连接。
const STATE_KEY = 'state';
const STATE_MEM_TTL = 20 * 1000;
const UUID_GRACE_MS = 10 * 60 * 1000;
const SETTINGS_FIELDS = ['edgeIP', 'hopAddr', 'hopMode', 'alt.mode', 'alt.region', 'alt.region2', 'alt.custom'];
const AEAD_METHODS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'];
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function nodeKv(env) {
  const kv = env && env.NODE_KV;
  return kv && typeof kv === 'object' && typeof kv.get === 'function' ? kv : null;
}

// cfg ↔ 扁平的设置对象（键为 SETTINGS_FIELDS）
function flatSettings(cfg) {
  return {
    edgeIP: cfg.edgeIP, hopAddr: cfg.hopAddr, hopMode: cfg.hopMode,
    'alt.mode': cfg.alt.mode, 'alt.region': cfg.alt.region, 'alt.region2': cfg.alt.region2, 'alt.custom': cfg.alt.custom,
  };
}
function applySettings(cfg, flat) {
  for (const k of SETTINGS_FIELDS) {
    if (!(k in flat)) continue;
    if (k.startsWith('alt.')) cfg.alt[k.slice(4)] = flat[k];
    else cfg[k] = flat[k];
  }
  return cfg;
}
const DEFAULT_SETTINGS = flatSettings({ edgeIP: '', hopAddr: '', hopMode: '', alt: { mode: 'builtin', region: '', region2: '', custom: '' } });

// 单项校验与规范化：返回 { value } 或 { error }（规则与原先面板里的字段校验一致）
function checkSetting(key, v) {
  if (v == null) v = '';
  if (typeof v !== 'string') return { error: '格式不正确' };
  v = v.trim();
  const oneOf = (list, label) => (list.includes(v) ? { value: v } : { error: label + '：不支持的选项「' + v.slice(0, 40) + '」' });
  const regions = Object.keys(ALT_DOMAINS);
  switch (key) {
    case 'edgeIP': {
      if (!v) return { value: '' };
      if (v.length > 256) return { error: '长度不能超过 256' };
      if (!/^[^\s/]+$/.test(v)) return { error: '格式为 host 或 host:port' };
      const { host, port } = parseHostPort(v, 443);
      if (!host) return { error: '缺少主机名' };
      if (!(port >= 1 && port <= 65535)) return { error: '端口须为 1 - 65535' };
      return { value: v };
    }
    case 'hopAddr': {
      if (!v) return { value: '' };
      if (v.length > 1024) return { error: '长度不能超过 1024' };
      if (!/^\S+$/.test(v)) return { error: '出站代理不能包含空格' };
      const p = parseHopAddress(v);
      if (!p || !p.host) return { error: '无法解析出站代理地址（格式如 socks5://user:pass@1.2.3.4:1080）' };
      if (!(p.port >= 1 && p.port <= 65535)) return { error: '出站代理端口须为 1 - 65535' };
      if (p.type === 'ss') {
        if (!aeadAlgo(p.method)) return { error: 'AEAD 加密方式仅支持 ' + AEAD_METHODS.join(' / ') };
        if (!p.password) return { error: 'AEAD 缺少密码' };
      }
      return { value: v };
    }
    case 'hopMode': return oneOf(['', 'no', 'only'], '出站方式');
    case 'alt.mode': return oneOf(['builtin', 'custom', 'off'], '地区反代模式');
    case 'alt.region': case 'alt.region2': {
      const extra = key === 'alt.region2' ? ['', 'none'] : [''];
      const hit = regions.find(r => r.toLowerCase() === v.toLowerCase());
      if (hit) return { value: hit };
      return oneOf(extra, key === 'alt.region' ? '首选反代地区' : '次选反代地区');
    }
    case 'alt.custom': {
      if (v.length > 1024) return { error: '长度不能超过 1024' };
      const seen = new Set(), out = [];
      for (const raw of v.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)) {
        const { host, port } = parseHostPort(raw, 443);
        const h = host.toLowerCase();
        if (!h || !(isValidIp(h) || HOSTNAME_RE.test(h))) return { error: '「' + raw.slice(0, 60) + '」不是有效的反代地址（格式 host 或 host:port，IPv6 需加方括号）' };
        if (!(port >= 1 && port <= 65535)) return { error: '「' + raw.slice(0, 60) + '」的端口须为 1 - 65535' };
        const entry = (h.indexOf(':') >= 0 ? '[' + h + ']' : h) + (port === 443 ? '' : ':' + port);
        if (!seen.has(entry)) { seen.add(entry); out.push(entry); }
      }
      if (out.length > ALT_CUSTOM_MAX) return { error: '最多 ' + ALT_CUSTOM_MAX + ' 个自定义反代（当前 ' + out.length + ' 个）' };
      return { value: out.join('\n') };
    }
  }
  return { error: '未知设置项' };
}
// 校验一批设置：只处理出现的项；未登记的项记入 ignored（strict 写入时报告，读取 KV 时直接丢弃无效项）
function sanitizeSettings(input) {
  const values = {}, errors = [], ignored = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { values, errors: [{ field: '', msg: '设置必须是一个对象' }], ignored };
  for (const k of Object.keys(input)) {
    if (!SETTINGS_FIELDS.includes(k)) { ignored.push(k); continue; }
    const r = checkSetting(k, input[k]);
    if (r.error) errors.push({ field: k, msg: r.error });
    else values[k] = r.value;
  }
  return { values, errors, ignored };
}
function crossCheckSettings(flat) {
  const errors = [];
  if (flat['alt.mode'] === 'custom' && !flat['alt.custom']) {
    errors.push({ field: 'alt.custom', msg: '已选择「仅使用自定义反代」，请至少填写一个反代地址（或改回内置 / 关闭）' });
  }
  return errors;
}

// 状态的规范化：只认合法的字段，其它一律丢弃（无效项不影响其它项）
function emptyState() { return { uuid: '', prev: '', prevUntil: 0, enabled: true, set: {} }; }
function sanitizeState(obj) {
  const st = emptyState();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return st;
  if (typeof obj.uuid === 'string' && isUUID(obj.uuid)) st.uuid = obj.uuid.toLowerCase();
  if (typeof obj.prev === 'string' && isUUID(obj.prev) && Number(obj.prevUntil) > 0) { st.prev = obj.prev.toLowerCase(); st.prevUntil = Number(obj.prevUntil); }
  if (obj.enabled === false) st.enabled = false;
  st.set = sanitizeSettings(obj.set).values;
  return st;
}

// 读 KV 里保存的状态：返回 { state, error }（error：'' / 'unavailable' / 'corrupt'）；带 isolate 内存缓存
const STATE_MEM = new WeakMap();
async function readNodeState(kv, fresh) {
  const now = Date.now(), hit = STATE_MEM.get(kv);
  if (!fresh && hit && now - hit.t < STATE_MEM_TTL) return hit;
  let entry;
  try {
    const raw = await kv.get(STATE_KEY, fresh ? undefined : { cacheTtl: 30 });
    let state = emptyState(), error = '';
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new SyntaxError('not an object');
        state = sanitizeState(obj);
      } catch (e) { state = emptyState(); error = 'corrupt'; }
    }
    entry = { t: now, state, error };
  } catch (e) {
    // 读取失败：沿用上一次读到的状态，5 秒后重试；从没读到过就视为未配置
    entry = { t: now - STATE_MEM_TTL + 5000, state: hit ? hit.state : emptyState(), error: 'unavailable' };
  }
  STATE_MEM.set(kv, entry);
  return entry;
}
async function writeNodeState(kv, state) {
  await kv.put(STATE_KEY, JSON.stringify(state));
  STATE_MEM.set(kv, { t: Date.now(), state, error: '' });
}
// 当前接受的 UUID 列表：当前的一个，加上宽限期内的旧的一个
function acceptedUuids(st, now) {
  const out = [];
  if (st.uuid) out.push(st.uuid);
  if (st.prev && st.prevUntil > now) out.push(st.prev);
  return out;
}

// 代理运行时使用的配置：环境变量 + KV 里的状态（UUID 列表、启用开关、设置覆盖项）。没有 NODE_KV 或环境变量有问题时就是环境变量本身（没有 UUID）
async function loadNodeConfig(env, base) {
  const cfg = base || nodeConfig(env);
  const kv = nodeKv(env);
  if (!kv || cfg._problems.length) return cfg;
  const { state } = await readNodeState(kv);
  cfg.uuids = acceptedUuids(state, Date.now());
  cfg.enabled = state.enabled;
  return applySettings(cfg, state.set);
}

// getSettings 的返回值：生效值、环境变量值、每项的来源、可选地区
function describeSettings(env, set, error) {
  const envFlat = flatSettings(nodeConfig(env));
  const settings = Object.assign({}, envFlat, set);
  const source = {};
  for (const k of SETTINGS_FIELDS) source[k] = k in set ? 'kv' : (envFlat[k] !== DEFAULT_SETTINGS[k] ? 'env' : 'default');
  const kv = nodeKv(env);
  return { ok: true, storage: !!(kv && typeof kv.put === 'function'), settings, env: envFlat, source, regions: Object.keys(ALT_DOMAINS), error: error || '' };
}
const NO_KV_MSG = '代理没有绑定 KV（变量名 NODE_KV），无法保存：UUID 与在线设置都保存在这个 KV 里，请先给代理绑定一个单独的 KV 命名空间';
async function getNodeSettings(env) {
  const kv = nodeKv(env);
  if (!kv) return describeSettings(env, {}, '');
  const { state, error } = await readNodeState(kv);
  return describeSettings(env, state.set, error);
}
// 读-改-写：先用 fresh 读到当前状态（KV 读取失败时拒绝，避免覆盖；内容损坏时允许写入来修复），再由 mutate 改出新状态
async function updateNodeState(env, mutate) {
  const kv = nodeKv(env);
  if (!kv || typeof kv.put !== 'function') return { ok: false, error: NO_KV_MSG };
  const cur = await readNodeState(kv, true);
  if (cur.error === 'unavailable') return { ok: false, error: 'KV 暂时无法读取，为避免覆盖已有状态，已禁止保存' };
  const next = mutate(Object.assign({}, cur.state, { set: Object.assign({}, cur.state.set) }));
  if (next.error) return { ok: false, error: next.error, errors: next.errors || [], ignored: next.ignored || [] };
  try { await writeNodeState(kv, next.state); }
  catch (e) { return { ok: false, error: 'KV 写入失败：' + ((e && e.message) || e) }; }
  return { ok: true, state: next.state, ignored: next.ignored || [] };
}
// 保存设置：patch 里出现的项逐项校验（任何一项出错整批都不保存），与环境变量相同的值不落盘
async function saveNodeSettings(env, patch) {
  const { values, errors, ignored } = sanitizeSettings(patch);
  if (errors.length) return { ok: false, error: errors.map(e => e.msg).join('；'), errors, ignored };
  const envFlat = flatSettings(nodeConfig(env));
  const r = await updateNodeState(env, (st) => {
    const merged = Object.assign({}, envFlat, st.set, values);
    const cross = crossCheckSettings(merged);
    if (cross.length) return { error: cross.map(e => e.msg).join('；'), errors: cross, ignored };
    const set = {};
    for (const k of SETTINGS_FIELDS) if (merged[k] !== envFlat[k]) set[k] = merged[k];
    st.set = set;
    return { state: st, ignored };
  });
  return r.ok ? Object.assign(describeSettings(env, r.state.set, ''), { ignored: r.ignored }) : r;
}
// 重置设置：只清除设置覆盖项，回到环境变量 + 默认值；UUID 与启用开关不动
async function resetNodeSettings(env) {
  const r = await updateNodeState(env, (st) => { st.set = {}; return { state: st }; });
  return r.ok ? describeSettings(env, {}, '') : r;
}
// 下发 UUID：rotate 为真且已有不同的 UUID 时，旧的保留 UUID_GRACE_MS 的宽限期
async function setNodeIdentity(env, args) {
  const uuid = args && typeof args.uuid === 'string' ? args.uuid.trim().toLowerCase() : '';
  if (!isUUID(uuid)) return { ok: false, error: 'UUID 格式不正确' };
  const r = await updateNodeState(env, (st) => {
    if (st.uuid && st.uuid !== uuid && args.rotate === true) { st.prev = st.uuid; st.prevUntil = Date.now() + UUID_GRACE_MS; }
    else if (st.uuid !== uuid) { st.prev = ''; st.prevUntil = 0; }
    st.uuid = uuid;
    return { state: st };
  });
  return r.ok ? { ok: true, uuidTag: await uuidTag(uuid), graceMs: r.state.prev ? UUID_GRACE_MS : 0 } : r;
}
// 读出当前 UUID（只有持有密钥的面板能调到）：面板丢了自己保存的 UUID（比如重新添加这个代理）时用来接管，而不是生成新的把客户端搞断
async function getNodeIdentity(env) {
  const kv = nodeKv(env);
  if (!kv) return { ok: false, error: NO_KV_MSG };
  const { state, error } = await readNodeState(kv, true);
  if (error === 'unavailable') return { ok: false, error: 'KV 暂时无法读取' };
  return state.uuid ? { ok: true, uuid: state.uuid } : { ok: false, error: '代理还没有下发 UUID' };
}
// 启用 / 停用：停用后节点路径只返回伪装页（控制接口不受影响）
async function setNodeEnabled(env, args) {
  if (!args || typeof args.enabled !== 'boolean') return { ok: false, error: '缺少 enabled（true / false）' };
  const r = await updateNodeState(env, (st) => { st.enabled = args.enabled; return { state: st }; });
  return r.ok ? { ok: true, enabled: r.state.enabled } : r;
}
// 状态：是否在线 / 版本 / 配置问题 / 是否已下发 UUID / 是否启用 / 设置摘要（不含 UUID、路径、密钥、反代地址与出站代理的主机和密码）
async function nodeStatus(env) {
  const base = nodeConfig(env);
  const kv = nodeKv(env);
  let state = emptyState(), kvError = '';
  if (kv && !base._problems.length) { const r = await readNodeState(kv); state = r.state; kvError = r.error; }
  const cfg = applySettings(nodeConfig(env), state.set);
  const out = cfg.hopAddr ? parseHopAddress(cfg.hopAddr) : null;
  return {
    ok: base._problems.length === 0,
    version: VERSION,
    problems: base._problems,
    storage: !!kv,
    kvError,
    provisioned: !!state.uuid,
    enabled: state.enabled,
    uuidTag: state.uuid ? await uuidTag(state.uuid) : '',
    settings: {
      edgeIP: !!cfg.edgeIP,
      hopAddr: out ? out.type : '',
      hopMode: cfg.hopMode,
      altMode: cfg.alt.mode,
      altRegion: cfg.alt.region,
      altRegion2: cfg.alt.region2,
      altCustom: cfg.alt.custom ? cfg.alt.custom.split('\n').length : 0,
    },
  };
}
