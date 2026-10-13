// ---------------------------------------------------------------------------
// 代理列表：面板 KV 里的 proxies（一个 JSON 数组），每项 { id, name, host, nodePath, uuid, key, enabled, prev, prevUntil, edgeIP, hop, hopMode, altMode, altCustom }
// ---------------------------------------------------------------------------
// 面板是代理全部状态的唯一权威：UUID（含轮换后限时保留的旧 UUID：prev / prevUntil）、启用开关与运行设置
// （edgeIP 落地 IP、hop 出站代理地址、hopMode 出站方式、altMode / altCustom 备用线路的选用方式）都存在这里，
// 整份下发给代理（buildState → 控制接口 setState）。密钥只写不读：接口不回传，备份不导出。
const UUID_GRACE_MS = 10 * 60 * 1000;   // 更换 UUID 后，旧 UUID 在代理上再保留 10 分钟
// 订阅合并所有可用的代理（见 readyProxies）；接口 /api/proxies 与面板的代理列表按多个代理设计。
const PROXIES_KEY = 'proxies';
const PROXIES_MAX = 8;

function publicProxy(p) {
  return {
    id: p.id, name: p.name, host: p.host, nodePath: p.nodePath, uuid: p.uuid, keySet: !!p.key, enabled: p.enabled,
    prevUntil: p.prev && p.prevUntil > Date.now() ? p.prevUntil : 0,
    edgeIP: p.edgeIP, hop: p.hop, hopMode: p.hopMode, altMode: p.altMode, altCustom: p.altCustom,
  };
}
function cleanProxyRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const id = String(r.id || '');
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) return null;
  return {
    id, name: String(r.name || '').slice(0, 40) || id,
    host: String(r.host || '').toLowerCase(), nodePath: String(r.nodePath || ''),
    uuid: isUUID(r.uuid) ? String(r.uuid).toLowerCase() : '', key: typeof r.key === 'string' ? r.key : '', enabled: r.enabled !== false,
    prev: isUUID(r.prev) ? String(r.prev).toLowerCase() : '', prevUntil: Number(r.prevUntil) > 0 ? Number(r.prevUntil) : 0,
    edgeIP: typeof r.edgeIP === 'string' ? r.edgeIP : '', hop: typeof r.hop === 'string' ? r.hop : '', hopMode: r.hopMode === 'only' ? 'only' : '',
    altMode: r.altMode === 'custom' || r.altMode === 'off' ? r.altMode : 'auto', altCustom: typeof r.altCustom === 'string' ? r.altCustom : '',
  };
}
// 读入面板配置时附带代理列表：cfg.proxies 全部，cfg.proxy 第一个启用的（面板接口没指定 id 时的默认代理）；读取失败记在 cfg._proxiesError（此时拒绝保存）
async function attachProxies(env, cfg) {
  cfg.proxies = []; cfg.proxy = null;
  const kv = kvStore(env);
  if (!kv || typeof kv.get !== 'function') return;
  try {
    const raw = await kv.get(PROXIES_KEY, { cacheTtl: 30 });
    if (raw) {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new SyntaxError('not an array');
      cfg.proxies = arr.map(cleanProxyRecord).filter(Boolean).slice(0, PROXIES_MAX);
    }
  } catch (e) { cfg._proxiesError = (e instanceof SyntaxError) ? 'corrupt' : 'unavailable'; }
  cfg.proxy = cfg.proxies.find(p => p.enabled) || null;
}
async function saveProxies(env, list) {
  const kv = kvStore(env);
  if (!kv || typeof kv.put !== 'function') throw new Error('未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存代理');
  await kv.put(PROXIES_KEY, JSON.stringify(list));
}

// 校验并规范化管理员提交的字段（partial：更新时只处理出现的项；密钥留空 = 保持不变）。返回 { value, errors }
function sanitizeProxyInput(input, { partial } = {}) {
  const value = {}, errors = [];
  const err = (field, msg) => errors.push({ field, msg });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value, errors: [{ field: '', msg: '请求体必须为 JSON 对象' }] };
  const has = (k) => input[k] !== undefined;
  const str = (k) => (input[k] == null ? '' : String(input[k]).trim());
  if (has('name')) { const v = str('name'); if (v.length > 40) err('name', '名称最长 40 个字符'); else value.name = v; }
  if (has('host') || !partial) {
    const v = str('host').replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
    if (!v) err('host', '请填写代理的域名，如 node.example.com');
    else if (!proxyHostOk(v)) err('host', '代理域名不正确：只能是域名（不是 IP），不带端口或路径');
    else value.host = v;
  }
  if (has('nodePath') || !partial) {
    const v = str('nodePath').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!v) err('nodePath', '请填写代理的节点路径（与代理的环境变量 PATH 相同）');
    else if (!new RegExp(PATH_SEG_PATTERN).test(v) || v.length > 128) err('nodePath', '只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位');
    else value.nodePath = v;
  }
  if (has('uuid')) {
    const v = str('uuid').toLowerCase();
    if (v && !isUUID(v)) err('uuid', 'UUID 格式不正确（应为 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx；留空则连接时自动生成）');
    else value.uuid = v;
  }
  if (has('key') && str('key') !== '') {
    const v = String(input.key).trim();
    if (v.length < 24 || v.length > 256 || !/^[\x21-\x7e]+$/.test(v)) err('key', '密钥至少 24 位，只能是可见的 ASCII 字符（可以点「生成密钥」）');
    else value.key = v;
  } else if (!partial) err('key', '请填写密钥（与代理的环境变量 NODE_KEY 相同；可以点「生成密钥」）');
  if (has('enabled')) { if (typeof input.enabled !== 'boolean') err('enabled', '必须为开或关'); else value.enabled = input.enabled; }
  // 运行设置（落地 IP / 出站代理 / 出站方式 / 备用线路）：字符串原样保存（出站代理校验通过后才保存），下发时再解析
  if (has('edgeIP')) { const r = checkEdgeIP(input.edgeIP); if (r.error) err('edgeIP', r.error); else value.edgeIP = r.value; }
  if (has('hop')) { const v = String(input.hop == null ? '' : input.hop).trim(); const r = parseHopInput(v); if (r.error) err('hop', r.error); else value.hop = v; }
  if (has('hopMode')) { if (input.hopMode !== '' && input.hopMode !== 'only') err('hopMode', '出站方式不支持「' + String(input.hopMode).slice(0, 20) + '」'); else value.hopMode = input.hopMode; }
  if (has('altMode')) { if (!['auto', 'custom', 'off'].includes(input.altMode)) err('altMode', '备用线路方式不支持「' + String(input.altMode).slice(0, 20) + '」'); else value.altMode = input.altMode; }
  if (has('altCustom')) { const r = parseAltPick(input.altCustom); if (r.error) err('altCustom', r.error); else value.altCustom = r.pick.join(','); }
  return { value, errors };
}
// 合并后的整条记录的交叉校验（单项校验过不了的组合）：返回 [{ field, msg }]
function crossCheckProxy(r) {
  const errors = [];
  if (r.altMode === 'custom' && !r.altCustom) errors.push({ field: 'altCustom', msg: '已选择自定义顺序，请填写要用的线路标签（或改回自动 / 关闭）' });
  if (r.hopMode === 'only' && !r.hop) errors.push({ field: 'hop', msg: '出站方式选了「仅走出站代理」，请先填写出站代理' });
  return errors;
}
function newProxyId() { return b64uOfBytes(crypto.getRandomValues(new Uint8Array(6))); }

// 代理应有的完整状态（整份下发）：键的顺序固定，JSON 文本因此稳定，代理返回的 stateHash 可以与面板自己算的比较。
// table 是备用线路表（parseAltRoutes 的结果）；已经过期的旧 UUID 仍然列在里面（代理自己会忽略），避免状态哈希因时间流逝而变化，
// 下一次同步时由 syncProxy 清掉
function buildState(p, table) {
  const uuids = [[p.uuid, 0]];
  if (p.prev && p.prevUntil) uuids.push([p.prev, p.prevUntil]);
  const hop = p.hop ? parseHopInput(p.hop).hop : null;
  const pick = p.altMode === 'off' ? [] : p.altMode === 'custom' ? parseAltPick(p.altCustom).pick : ALT_PICK_DEFAULT;
  return { uuids, enabled: p.enabled, edgeIP: p.edgeIP || '', hop, hopMode: p.hopMode || '', altTable: table || {}, altPick: pick };
}

// 订阅会下发的代理：启用、且域名 / 节点路径 / UUID 都已齐全（多个时订阅合并它们的节点）
function readyProxies(cfg) {
  return (cfg.proxies || []).filter(p => p.enabled && p.host && p.nodePath && p.uuid);
}
// 订阅需要的代理端点是否齐全：返回尚未就绪的说明（空数组 = 可以生成订阅）
function endpointMissing(cfg) {
  if (cfg._proxiesError) return ['代理列表（' + (cfg._proxiesError === 'corrupt' ? 'KV 里的内容已损坏' : 'KV 暂时无法读取') + '）'];
  if (readyProxies(cfg).length) return [];
  const on = (cfg.proxies || []).filter(p => p.enabled);
  if (!on.length) return [cfg.proxies && cfg.proxies.length ? '启用中的代理（现有的都已停用）' : '代理（请先在「面板设置 → 代理」添加）'];
  const px = on[0];
  return [['host', '代理域名'], ['nodePath', '节点路径'], ['uuid', 'UUID（点「连接并同步」会自动生成并下发）']].filter(([k]) => !px[k]).map(([, label]) => label);
}
