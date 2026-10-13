// ---------------------------------------------------------------------------
// 配置加载：默认值 < 环境变量 < KV 图形化配置
// KV 读取走 Cloudflare KV 内置边缘缓存 cacheTtl=30：请求/面板读配置命中边缘缓存，大幅减少 KV 读量；
// 不使用模块级内存缓存（不同 isolate 不共享且会残留陈旧值）。KV 是最终一致的：同一机房写入后随即可见，
// 其它机房最多约 1 分钟后同步（面板保存提示即此含义）。
// ---------------------------------------------------------------------------

// KV 读取失败 / 配置损坏时不能静默当作「没有配置」：否则在此状态下保存会用默认值覆盖掉真实配置。
// cfg._kvError 记录原因（unavailable：KV 读取出错；corrupt：存储内容不是合法 JSON），调用方据此拒绝写入；
// 读取不到 KV 时面板与订阅按环境变量 + 默认值工作
async function loadConfig(env) {
  let kvCfg = null, kvError = '';
  const kv = kvStore(env);
  if (kv && typeof kv.get === 'function') {
    try {
      const kvJson = await kv.get('config', { cacheTtl: 30 });
      if (kvJson) {
        try { kvCfg = JSON.parse(kvJson); if (!kvCfg || typeof kvCfg !== 'object') throw new SyntaxError('not an object'); }
        catch (e) { kvCfg = null; kvError = 'corrupt'; }
      }
    } catch (e) { kvError = 'unavailable'; }
  }
  const cfg = buildConfig(env, kvCfg);
  if (kvError) cfg._kvError = kvError;
  return cfg;
}

// 环境变量 UUID（有效时返回小写形式，否则空串）
function envUuid(env) {
  const v = String(envVar(env, 'uuid') || '').toLowerCase();
  return isUUID(v) ? v : '';
}

// 面板路径（环境变量 PATH）：去掉首尾 /，只允许 字母 数字 . _ ~ -，且不能是保留路径。返回 { value, error }
function normalizePanelPath(raw) {
  const v = String(raw == null ? '' : raw).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!v) return { value: '', error: '' };
  if (!new RegExp(PATH_SEG_PATTERN).test(v) || v.length > 128) return { value: '', error: '只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位' };
  if (RESERVED_PATHS.indexOf(v.toLowerCase()) >= 0) return { value: '', error: '「' + v + '」为保留路径，请换一个' };
  return { value: v, error: '' };
}

// 由「默认值 < 环境变量 < KV 配置 < 锁定的环境变量」组装完整配置（纯函数：保存接口用刚写入的数据直接组装，
// 不经 KV 边缘缓存，避免保存后回读到旧配置）。cfg.uuid / cfg.host / cfg.nodePath 为空表示代理端点尚未填写，cfg.path 为空表示 PATH 未设置 / 非法
function buildConfig(env, kvCfg) {
  const cfg = schemaDefaults();
  const flag = (v) => v === true || v === 'true' || v === '1' || v === 1;
  // 环境变量
  const envBase = { host: '', nodePath: '' };
  if (envVar(env, 'uuid')) cfg.uuid = String(envVar(env, 'uuid')).toLowerCase();
  if (env.HOST) envBase.host = String(env.HOST).replace(/^https?:\/\//, '').split('/')[0];
  if (envVar(env, 'nodePath')) envBase.nodePath = String(envVar(env, 'nodePath')).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  cfg.host = envBase.host;
  cfg.nodePath = envBase.nodePath;
  if (flag(envVar(env, 'ech'))) cfg.ech = true;
  if (env.ALPN) cfg.alpn = String(env.ALPN);
  // KV 图形化配置（更高优先级）：按字段表逐项合并，未登记的字段自动忽略
  if (kvCfg && typeof kvCfg === 'object') {
    for (const d of CONFIG_SCHEMA) {
      const v = getPath(kvCfg, d.key);
      if (v !== undefined) setPath(cfg, d.key, cloneJSON(v));
    }
  }
  // 环境变量锁定字段（PATH / ADMIN / ADMIN_USER）优先于 KV：面板中这些项只读
  const locked = envLockedFields(env);
  for (const key of Object.keys(locked)) {
    const d = SCHEMA_BY_KEY.get(key);
    let v = String(env[locked[key]]);
    if (d.lower) v = v.toLowerCase();
    setPath(cfg, key, v);
  }
  // 代理端点三项：面板里留空（或 UUID 非法）时回退环境变量；仍没有则留空，订阅会提示尚未填写
  cfg.uuid = String(cfg.uuid || '').toLowerCase();
  if (!isUUID(cfg.uuid)) cfg.uuid = envUuid(env);
  if (!cfg.host) cfg.host = envBase.host;
  if (!cfg.nodePath) cfg.nodePath = envBase.nodePath;
  // 面板路径只认环境变量 PATH（不再回退 UUID）；非法值按未设置处理并记下原因
  const np = normalizePanelPath(locked.path ? env[locked.path] : '');
  cfg.path = np.value;
  if (np.error) cfg._pathError = np.error;
  return cfg;
}

// 写入 KV：只保存字段表登记的配置项；由环境变量锁定的字段（管理密码、面板路径）不写入
// （避免明文密码落盘，也避免与环境变量不一致）。返回实际写入的对象；未绑定 KV 返回 null
async function saveConfig(env, cfg) {
  const kv = kvStore(env);
  if (!kv || typeof kv.put !== 'function') return null;
  const stored = pickSchema(cfg);
  // 环境变量提供、且面板里没有被改动的值不写入 KV：否则一次保存就会把 HOST / ALPN 等
  // 环境变量快照进 KV（KV 优先级更高），之后再改环境变量会被静默忽略。
  // 面板中改成与环境变量不同的值才视为覆盖并保存
  const envBase = buildConfig(env, null), defaults = schemaDefaults();
  for (const d of CONFIG_SCHEMA) {
    const ev = getPath(envBase, d.key);
    if (JSON.stringify(ev) === JSON.stringify(getPath(defaults, d.key))) continue;   // 环境变量未提供该项
    if (JSON.stringify(getPath(stored, d.key)) !== JSON.stringify(ev)) continue;     // 面板中已改动：保存为覆盖值
    const ks = d.key.split('.');
    const parent = ks.length > 1 ? getPath(stored, ks.slice(0, -1).join('.')) : stored;
    if (parent) delete parent[ks[ks.length - 1]];
  }
  for (const key of Object.keys(envLockedFields(env))) {
    const ks = key.split('.');
    const parent = ks.length > 1 ? getPath(stored, ks.slice(0, -1).join('.')) : stored;
    if (parent) delete parent[ks[ks.length - 1]];
  }
  await kv.put('config', JSON.stringify(stored));
  return stored;
}


