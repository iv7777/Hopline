// ---------------------------------------------------------------------------
// 代理设置的在线修改（可选）：面板通过服务绑定（入口 NodeControl）读写代理的运行设置
// ---------------------------------------------------------------------------
// 代理自己的 KV（绑定变量名 NODE_KV，建议单独建一个命名空间，只有代理绑定它）里保存一份 settings，
// 优先级：KV 里的设置 > 环境变量 > 默认值（与原先面板里的规则一致）。只有这 7 项运行设置可以在线修改，
// UUID 与 PATH（节点身份与路径）永远只来自环境变量，面板改不了。
// 没有绑定 NODE_KV 时代理完全按环境变量工作，面板里的这些设置只读。
//
// 与环境变量相同的值不会写进 KV（只保存与环境变量不同的覆盖项），之后改环境变量立即生效。
// 读取走 isolate 内存缓存（SETTINGS_MEM_TTL）+ KV 边缘缓存，每个 isolate 约每 20 秒读一次 KV；只有节点路径上的连接才会触发读取。
// KV 读取失败时沿用上一次读到的设置（没有就用环境变量），绝不因此阻断代理。
const SETTINGS_KEY = 'settings';
const SETTINGS_MEM_TTL = 20 * 1000;
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

// 读 KV 里保存的覆盖项：返回 { stored, error }（error：'' / 'unavailable' / 'corrupt'）；带 isolate 内存缓存
const SETTINGS_MEM = new WeakMap();
async function readStoredSettings(kv, fresh) {
  const now = Date.now(), hit = SETTINGS_MEM.get(kv);
  if (!fresh && hit && now - hit.t < SETTINGS_MEM_TTL) return hit;
  let entry;
  try {
    const raw = await kv.get(SETTINGS_KEY, fresh ? undefined : { cacheTtl: 30 });
    let stored = {}, error = '';
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new SyntaxError('not an object');
        stored = sanitizeSettings(obj).values;   // 无效项直接丢弃，不影响其它项
      } catch (e) { stored = {}; error = 'corrupt'; }
    }
    entry = { t: now, stored, error };
  } catch (e) {
    // 读取失败：沿用上一次读到的设置，5 秒后重试；从没读到过就用环境变量
    entry = { t: now - SETTINGS_MEM_TTL + 5000, stored: hit ? hit.stored : {}, error: 'unavailable' };
  }
  SETTINGS_MEM.set(kv, entry);
  return entry;
}

// 代理运行时使用的配置：环境变量 + KV 覆盖项（没有 NODE_KV 或环境变量有问题时就是环境变量本身）
async function loadNodeConfig(env, base) {
  const cfg = base || nodeConfig(env);
  const kv = nodeKv(env);
  if (!kv || cfg._problems.length) return cfg;
  const { stored } = await readStoredSettings(kv);
  return applySettings(cfg, stored);
}

// getSettings 的返回值：生效值、环境变量值、每项的来源、可选地区
function describeSettings(env, stored, error) {
  const envFlat = flatSettings(nodeConfig(env));
  const settings = Object.assign({}, envFlat, stored);
  const source = {};
  for (const k of SETTINGS_FIELDS) source[k] = k in stored ? 'kv' : (envFlat[k] !== DEFAULT_SETTINGS[k] ? 'env' : 'default');
  const kv = nodeKv(env);
  return { ok: true, storage: !!(kv && typeof kv.put === 'function'), settings, env: envFlat, source, regions: Object.keys(ALT_DOMAINS), error: error || '' };
}
async function getNodeSettings(env) {
  const kv = nodeKv(env);
  if (!kv) return describeSettings(env, {}, '');
  const { stored, error } = await readStoredSettings(kv);
  return describeSettings(env, stored, error);
}
// 保存：patch 里出现的项逐项校验（任何一项出错整批都不保存），与环境变量相同的值不落盘
async function saveNodeSettings(env, patch) {
  const kv = nodeKv(env);
  if (!kv || typeof kv.put !== 'function') return { ok: false, error: '代理没有绑定 KV（变量名 NODE_KV），无法保存设置；这些设置仍可以通过环境变量修改' };
  const { values, errors, ignored } = sanitizeSettings(patch);
  if (errors.length) return { ok: false, error: errors.map(e => e.msg).join('；'), errors, ignored };
  const cur = await readStoredSettings(kv, true);
  if (cur.error === 'unavailable') return { ok: false, error: 'KV 暂时无法读取，为避免覆盖已有设置，已禁止保存' };   // 内容损坏（corrupt）时允许保存来修复
  const envFlat = flatSettings(nodeConfig(env));
  const merged = Object.assign({}, envFlat, cur.stored, values);
  const cross = crossCheckSettings(merged);
  if (cross.length) return { ok: false, error: cross.map(e => e.msg).join('；'), errors: cross, ignored };
  const next = {};
  for (const k of SETTINGS_FIELDS) if (merged[k] !== envFlat[k]) next[k] = merged[k];
  try { await kv.put(SETTINGS_KEY, JSON.stringify(next)); }
  catch (e) { return { ok: false, error: 'KV 写入失败：' + ((e && e.message) || e) }; }
  SETTINGS_MEM.set(kv, { t: Date.now(), stored: next, error: '' });
  return Object.assign(describeSettings(env, next, ''), { ignored });
}
// 重置：删除 KV 里的覆盖项，回到环境变量 + 默认值
async function resetNodeSettings(env) {
  const kv = nodeKv(env);
  if (!kv || typeof kv.delete !== 'function') return { ok: false, error: '代理没有绑定 KV（变量名 NODE_KV），没有需要重置的设置' };
  try { await kv.delete(SETTINGS_KEY); }
  catch (e) { return { ok: false, error: 'KV 删除失败：' + ((e && e.message) || e) }; }
  SETTINGS_MEM.set(kv, { t: Date.now(), stored: {}, error: '' });
  return describeSettings(env, {}, '');
}
