// ---------------------------------------------------------------------------
// 面板的代理管理接口（需登录）：/api/proxies（增删改、同步、启停、换 UUID）、/api/proxy-status、/api/proxy-settings、/api/proxy-reset
// ---------------------------------------------------------------------------
const pickProxy = (cfg, id) => (id ? cfg.proxies.find(p => p.id === id) : (cfg.proxy || cfg.proxies[0])) || null;

// 代理状态（给仪表盘）：调用失败不抛错，返回 { configured, up, error }
async function proxyStatusOf(p) {
  if (!p) return { configured: false };
  const base = { configured: true, id: p.id, name: p.name, enabledHere: p.enabled };
  if (!p.key) return Object.assign(base, { up: false, error: '没有填写密钥' });
  try {
    const st = await callProxyOk(p, 'status', {});
    return Object.assign(base, {
      up: true, ok: st.ok === true, version: String(st.version || ''), problems: Array.isArray(st.problems) ? st.problems.map(String) : [],
      storage: st.storage === true, kvError: String(st.kvError || ''), provisioned: st.provisioned === true, enabled: st.enabled !== false,
      uuidMatch: !!(st.provisioned && p.uuid && st.uuidTag === await uuidTag(p.uuid)),
      settings: st.settings && typeof st.settings === 'object' ? st.settings : {},
    });
  } catch (e) { return Object.assign(base, { up: false, error: String((e && e.message) || e) }); }
}
const proxyFail = (e) => json({ ok: false, msg: String((e && e.message) || e), errors: (e && e.errors) || [] }, (e && e.errors && e.errors.length) ? 400 : 502);
const noProxy = () => json({ ok: false, msg: '还没有代理：请先在「面板设置 → 代理」添加一个（填写域名、节点路径和密钥）' }, 400);

async function handleProxiesApi(apiName, request, env, cfg, segs, url) {
  const method = request.method;
  const guardWrite = () => {
    if (cfg._proxiesError) return json({ ok: false, msg: '代理列表读取失败（' + (cfg._proxiesError === 'corrupt' ? 'KV 里的内容已损坏' : 'KV 暂时无法读取') + '），为避免覆盖已有数据，已禁止保存' }, 503);
    const kv = kvStore(env);
    if (!kv || typeof kv.put !== 'function') return json({ ok: false, msg: '未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存代理；请在面板 Worker 设置中绑定 KV 后重试' }, 400);
    return null;
  };
  const readBody = async () => { try { return await request.json(); } catch (e) { return undefined; } };
  const save = async (list) => { await saveProxies(env, list); cfg.proxies = list; cfg.proxy = list.find(p => p.enabled) || null; };

  if (apiName === 'proxy-status') {
    if (method !== 'GET') return json({ ok: false, msg: '仅支持 GET' }, 405);
    return json({ ok: true, data: await proxyStatusOf(pickProxy(cfg, url.searchParams.get('id'))) });
  }
  if (apiName === 'proxy-settings' || apiName === 'proxy-reset') {
    const p = pickProxy(cfg, url.searchParams.get('id'));
    if (!p) return noProxy();
    try {
      if (apiName === 'proxy-reset') {
        if (method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
        return json({ ok: true, data: await callProxyOk(p, 'resetSettings', {}) });
      }
      if (method === 'GET') return json({ ok: true, data: await callProxyOk(p, 'getSettings', {}) });
      if (method === 'POST') {
        const body = await readBody();
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, msg: '请求体必须为 JSON 对象' }, 400);
        return json({ ok: true, data: await callProxyOk(p, 'setSettings', body) });
      }
      return json({ ok: false, msg: '仅支持 GET / POST' }, 405);
    } catch (e) { return proxyFail(e); }
  }

  // /api/proxies[/<id>[/<action>]]
  const id = segs[3] || '', action = segs[4] || '';
  if (!id) {
    if (method === 'GET') return json({ ok: true, data: { proxies: cfg.proxies.map(publicProxy), error: cfg._proxiesError || '' } });
    if (method !== 'POST') return json({ ok: false, msg: '仅支持 GET / POST' }, 405);
    const blocked = guardWrite(); if (blocked) return blocked;
    if (cfg.proxies.length >= PROXIES_MAX) return json({ ok: false, msg: '最多 ' + PROXIES_MAX + ' 个代理' }, 400);
    const body = await readBody();
    const { value, errors } = sanitizeProxyInput(body);
    if (errors.length) return json({ ok: false, msg: errors.map(e => e.msg).join('；'), errors }, 400);
    const rec = cleanProxyRecord(Object.assign({ id: newProxyId(), name: '代理 ' + (cfg.proxies.length + 1), uuid: '', enabled: true }, value));
    await save([...cfg.proxies, rec]);
    const sync = body.sync === false ? null : await syncAndStore(env, cfg, rec.id, save);
    return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === rec.id)), sync } });
  }
  const p = cfg.proxies.find(x => x.id === id);
  if (!p) return (method !== 'GET' && guardWrite()) || json({ ok: false, msg: '没有这个代理' }, 404);
  if (!action) {
    const blocked = method === 'GET' ? null : guardWrite(); if (blocked) return blocked;
    if (method === 'GET') return json({ ok: true, data: { proxy: publicProxy(p) } });
    if (method === 'DELETE') {
      await save(cfg.proxies.filter(x => x.id !== id));
      return json({ ok: true, msg: '已从面板删除；代理本身没有被改动（要让它停止服务，请先「停用」再删除，或到代理上清除）' });
    }
    if (method !== 'POST') return json({ ok: false, msg: '仅支持 GET / POST / DELETE' }, 405);
    const body = await readBody();
    const { value, errors } = sanitizeProxyInput(body, { partial: true });
    if (errors.length) return json({ ok: false, msg: errors.map(e => e.msg).join('；'), errors }, 400);
    const next = cleanProxyRecord(Object.assign({}, p, value));
    await save(cfg.proxies.map(x => (x.id === id ? next : x)));
    const sync = body.sync === false ? null : await syncAndStore(env, cfg, id, save);
    return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === id)), sync } });
  }
  if (method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
  const blocked = guardWrite(); if (blocked) return blocked;
  if (action === 'sync') {
    const sync = await syncAndStore(env, cfg, id, save);
    return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === id)), sync } });
  }
  if (action === 'enabled') {
    const body = await readBody();
    if (!body || typeof body.enabled !== 'boolean') return json({ ok: false, msg: '缺少 enabled（true / false）' }, 400);
    const next = Object.assign({}, p, { enabled: body.enabled });
    await save(cfg.proxies.map(x => (x.id === id ? next : x)));
    // 面板这边立刻生效（停用的代理不进订阅）；同时通知代理本身启用 / 停用，代理没响应时只给出提醒，之后可以「连接并同步」补上
    let synced = false, warning = '';
    try { await callProxyOk(next, 'setEnabled', { enabled: body.enabled }); synced = true; } catch (e) { warning = '面板已' + (body.enabled ? '启用' : '停用') + '，但没能通知代理：' + e.message + '。代理上的状态以后可以点「连接并同步」补上'; }
    return json({ ok: true, data: { proxy: publicProxy(next), synced, warning } });
  }
  if (action === 'rotate') {
    const uuid = crypto.randomUUID();
    try { var r = await callProxyOk(p, 'setIdentity', { uuid, rotate: true }); } catch (e) { return proxyFail(e); }
    const next = Object.assign({}, p, { uuid });
    await save(cfg.proxies.map(x => (x.id === id ? next : x)));
    return json({ ok: true, data: { proxy: publicProxy(next), graceMs: r.graceMs || 0 } });
  }
  return json({ ok: false, msg: '未知操作：' + action }, 404);
}
// 同步一个代理并把可能新生成的 UUID 存回面板；失败不抛错，返回 { ok:false, error }
async function syncAndStore(env, cfg, id, save) {
  const p = cfg.proxies.find(x => x.id === id);
  try {
    const r = await syncProxy(p);
    if (r.uuid !== p.uuid) await save(cfg.proxies.map(x => (x.id === id ? Object.assign({}, x, { uuid: r.uuid }) : x)));
    return { ok: r.status.ok === true, actions: r.actions, status: await proxyStatusOf(cfg.proxies.find(x => x.id === id)), error: r.status.ok ? '' : r.status.problems.join(' ') };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), actions: [] }; }
}
