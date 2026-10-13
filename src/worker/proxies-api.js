// ---------------------------------------------------------------------------
// 面板的代理管理接口（需登录）：/api/proxies（增删改、同步、启停、换 UUID）、/api/proxy-sync-all、/api/proxy-status、/api/alt-routes
// ---------------------------------------------------------------------------
const pickProxy = (cfg, id) => (id ? cfg.proxies.find(p => p.id === id) : (cfg.proxy || cfg.proxies[0])) || null;

// 备用线路表（解析后）：线路表读不到时不能下发（会把代理上的线路换成默认表），直接报错
async function loadAltTable(env) {
  const r = await readRoutes(env);
  if (r.error) throw new Error('备用线路表读取失败（KV 暂时无法读取），为避免下发错误的内容，已取消');
  return parseAltRoutes(r.text).table;
}

// 由代理的 status 回应得出面板用的状态；inSync = 代理上保存的状态与面板应下发的完全一致
async function statusFrom(p, st, table) {
  const want = p.uuid ? await shortHash(JSON.stringify(buildState(p, table))) : '';
  return {
    configured: true, id: p.id, name: p.name, enabledHere: p.enabled,
    up: true, ok: st.ok === true, version: String(st.version || ''), problems: Array.isArray(st.problems) ? st.problems.map(String) : [],
    storage: st.storage === true, kvError: String(st.kvError || ''), provisioned: st.provisioned === true, enabled: st.enabled !== false,
    inSync: !!want && st.stateHash === want,
  };
}
// 代理状态（给仪表盘）：调用失败不抛错，返回 { configured, up, error }
async function proxyStatusOf(p, table) {
  if (!p) return { configured: false };
  const base = { configured: true, id: p.id, name: p.name, enabledHere: p.enabled };
  if (!p.key) return Object.assign(base, { up: false, error: '没有填写密钥' });
  try { return await statusFrom(p, await callProxyOk(p, 'status', {}), table); }
  catch (e) { return Object.assign(base, { up: false, error: String((e && e.message) || e) }); }
}
const proxyFail = (e) => json({ ok: false, msg: String((e && e.message) || e), errors: (e && e.errors) || [] }, (e && e.errors && e.errors.length) ? 400 : 502);
const fieldErrors = (errors) => json({ ok: false, msg: errors.map(e => e.msg).join('；'), errors }, 400);

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
  const patchOf = (id, patch) => cfg.proxies.map(x => (x.id === id ? Object.assign({}, x, patch) : x));

  // 同步一个代理并把可能新生成的 UUID 存回面板；失败不抛错，返回 { ok:false, error }
  const syncAndStore = async (id, table) => {
    const p = cfg.proxies.find(x => x.id === id);
    try {
      const r = await syncProxy(p, table);
      if (Object.keys(r.patch).length) await save(patchOf(id, r.patch));
      const cur = cfg.proxies.find(x => x.id === id);
      return { ok: r.status.ok === true && r.inSync, actions: r.actions, status: await statusFrom(cur, r.status, table), error: !r.status.ok ? (r.status.problems || []).join(' ') : (r.inSync ? '' : '代理没有按下发的内容更新状态') };
    } catch (e) { return { ok: false, error: String((e && e.message) || e), actions: [] }; }
  };
  const withTable = async (fn) => { let table; try { table = await loadAltTable(env); } catch (e) { return json({ ok: false, msg: e.message }, 503); } return fn(table); };

  if (apiName === 'alt-routes') {
    if (method === 'GET') {
      const r = await readRoutes(env);
      return json({ ok: true, data: { text: r.text, defaultText: DEFAULT_ALT_ROUTES, tags: Object.keys(parseAltRoutes(r.text).table), error: r.error } });
    }
    if (method !== 'POST') return json({ ok: false, msg: '仅支持 GET / POST' }, 405);
    const kv = kvStore(env);
    if (!kv || typeof kv.put !== 'function') return json({ ok: false, msg: '未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存线路表' }, 400);
    const body = await readBody();
    if (!body || typeof body.text !== 'string' || body.text.length > 8000) return json({ ok: false, msg: '缺少线路表文本（text，最长 8000 个字符）' }, 400);
    const { table, errors } = parseAltRoutes(body.text);
    if (errors.length) return fieldErrors(errors.map(e => ({ field: 'text', msg: e.msg })));
    await saveRoutes(env, body.text);
    return json({ ok: true, data: { tags: Object.keys(table) } });
  }
  if (apiName === 'proxy-sync-all') {
    if (method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
    const blocked = guardWrite(); if (blocked) return blocked;
    return withTable(async (table) => {
      const results = [];
      for (const p of cfg.proxies) results.push(Object.assign({ id: p.id, name: p.name }, await syncAndStore(p.id, table)));
      return json({ ok: true, data: { results } });
    });
  }
  if (apiName === 'proxy-status') {
    if (method !== 'GET') return json({ ok: false, msg: '仅支持 GET' }, 405);
    return withTable(async (table) => {
      // ?all=1：全部代理的状态（并行查询，给仪表盘与代理列表）
      if (url.searchParams.get('all') === '1') return json({ ok: true, data: { proxies: await Promise.all(cfg.proxies.map(p => proxyStatusOf(p, table))) } });
      return json({ ok: true, data: await proxyStatusOf(pickProxy(cfg, url.searchParams.get('id')), table) });
    });
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
    const rec = cleanProxyRecord(Object.assign({ id: newProxyId(), name: '代理 ' + (cfg.proxies.length + 1), uuid: '', enabled: true }, value));
    const all = errors.concat(errors.length ? [] : crossCheckProxy(rec));
    if (all.length) return fieldErrors(all);
    return withTable(async (table) => {
      await save([...cfg.proxies, rec]);
      const sync = body.sync === false ? null : await syncAndStore(rec.id, table);
      return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === rec.id)), sync } });
    });
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
    const next = cleanProxyRecord(Object.assign({}, p, value));
    const all = errors.concat(errors.length ? [] : crossCheckProxy(next));
    if (all.length) return fieldErrors(all);
    return withTable(async (table) => {
      await save(cfg.proxies.map(x => (x.id === id ? next : x)));
      const sync = body.sync === false ? null : await syncAndStore(id, table);
      return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === id)), sync } });
    });
  }
  if (method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
  const blocked = guardWrite(); if (blocked) return blocked;
  return withTable(async (table) => {
    if (action === 'sync') {
      const sync = await syncAndStore(id, table);
      return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === id)), sync } });
    }
    if (action === 'enabled') {
      const body = await readBody();
      if (!body || typeof body.enabled !== 'boolean') return json({ ok: false, msg: '缺少 enabled（true / false）' }, 400);
      // 面板这边立刻生效（停用的代理不进订阅）；同时把新状态下发给代理（停用 = 代理对外只显示 Hello World），代理没响应时只给出提醒，之后可以「连接并同步」补上
      await save(patchOf(id, { enabled: body.enabled }));
      const sync = await syncAndStore(id, table);
      const warning = sync.ok ? '' : '面板已' + (body.enabled ? '启用' : '停用') + '，但没能通知代理：' + sync.error + '。代理上的状态以后可以点「连接并同步」补上';
      return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === id)), synced: sync.ok, warning } });
    }
    if (action === 'rotate') {
      // 先把新 UUID 下发给代理，成功了才改面板的记录；旧 UUID 在代理上保留一段宽限期
      const next = Object.assign({}, p, { uuid: crypto.randomUUID(), prev: p.uuid, prevUntil: p.uuid ? Date.now() + UUID_GRACE_MS : 0 });
      try {
        const r = await syncProxy(next, table);
        if (!r.status.ok) throw new Error('代理的环境变量有问题：' + (r.status.problems || []).join(' '));
        if (!r.inSync) throw new Error('代理没有按下发的内容更新状态');
      } catch (e) { return proxyFail(e); }
      await save(cfg.proxies.map(x => (x.id === id ? next : x)));
      return json({ ok: true, data: { proxy: publicProxy(next), graceMs: p.uuid ? UUID_GRACE_MS : 0 } });
    }
    return json({ ok: false, msg: '未知操作：' + action }, 404);
  });
}
