// ---------------------------------------------------------------------------
// 路由与调度
// ---------------------------------------------------------------------------
// JSON 响应（面板的管理接口用；代理没有任何 JSON 响应，出错一律是伪装页）
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}) });
}

function isBrowserUA(ua) {
  // 任何包含 Mozilla 的 UA 视为浏览器；curl / ClashForAndroid / Sing-box 等客户端不含
  return (ua || '').toLowerCase().includes('mozilla');
}

// 鉴权：
//  - 未设置 ADMIN 时一律拒绝
//  - Cookie 为带过期时间的 HMAC-SHA256 签名令牌
//  - 常量时间比较 + 登录失败限速
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', TE.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, TE.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// 管理密码存储：KV 中保存加盐 PBKDF2-SHA256 摘要（格式 前缀 + 迭代次数 + $ + 盐 + $ + 摘要），不保存明文。
// 迭代次数写在摘要里，日后可调高而不影响已保存的密码；取 1 万次是为了控制免费版 10ms CPU 限制下的登录开销。
// 由环境变量 ADMIN 提供的密码仍是明文（环境变量本身即密钥存储），按常量时间比较。
// KV 中若存有明文密码同样可用，下次在面板保存任意配置时自动改存摘要。
const ADMIN_HASH_PREFIX = 'hopline-pbkdf2$';
const ADMIN_HASH_ITER = 10000;
const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from((String(h).match(/../g) || []).map(x => parseInt(x, 16)));
async function pbkdf2Hex(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', TE.encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)));
}
function isAdminHash(v) { return typeof v === 'string' && v.startsWith(ADMIN_HASH_PREFIX); }
async function hashAdminPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return ADMIN_HASH_PREFIX + ADMIN_HASH_ITER + '$' + toHex(salt) + '$' + await pbkdf2Hex(password, salt, ADMIN_HASH_ITER);
}
async function verifyAdminPassword(stored, password) {
  stored = String(stored || ''); password = String(password == null ? '' : password);
  if (!stored) return false;
  if (!isAdminHash(stored)) return timingSafeEqual(password, stored);   // 环境变量 / KV 中的明文
  const parts = stored.slice(ADMIN_HASH_PREFIX.length).split('$');
  const iter = parseInt(parts[0], 10);
  if (parts.length !== 3 || !(iter >= 1000 && iter <= 100000) || !parts[1] || !parts[2]) return false;
  return timingSafeEqual(await pbkdf2Hex(password, fromHex(parts[1]), iter), parts[2]);
}
// 登录会话：空闲 24 小时过期——登录后每次使用面板（打开页面 / 调用接口）都把有效期顺延为 24 小时，
// 但自登录起最长 7 天，到期必须重新登录（限制遗失或被盗的 Cookie 可用的时长）。
// 令牌格式「过期时间.登录时间.签名」，签名覆盖两个时间，无法篡改；服务端不保存会话
const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_REFRESH_MIN_MS = 10 * 60 * 1000;   // 新有效期至少比当前晚 10 分钟才重新签发（连续操作时不必每个请求都换 Cookie）
// 当前生效的管理用户名（KV 中为空等异常情况回落默认 admin）
function adminUserOf(cfg) { return String(cfg.adminUser || '') || 'admin'; }
// 会话签名密钥含用户名：修改用户名与修改密码一样，使其它浏览器的登录态失效（代理端点的 UUID 等与登录无关，不参与）
function authKey(cfg) { return 'hopline-auth|' + String(cfg.admin) + '|' + adminUserOf(cfg); }
// iat：登录时间（续期时沿用，保证 7 天上限从首次登录算起）；返回 { token, exp }
async function makeAuthToken(cfg, iat) {
  const now = Date.now();
  iat = iat || now;
  const exp = Math.min(now + AUTH_TTL_MS, iat + AUTH_MAX_MS);
  return { token: exp + '.' + iat + '.' + await hmacHex(authKey(cfg), exp + '.' + iat), exp };
}
// 校验登录 Cookie：有效时返回会话 { exp, iat }，否则 false。
// 传入 state 时顺便判断是否需要续期，需要则把新 Cookie 放到 state.setCookie（由 fetch 入口附加到响应上）
async function requireAuth(request, cfg, state) {
  if (!cfg.admin) return false;
  const cookies = request.headers.get('Cookie') || '';
  const m = cookies.match(/(?:^|;\s*)hopline_auth=([^;]+)/);
  if (!m) return false;
  const parts = m[1].split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !parts[2]) return false;
  const exp = Number(parts[0]), iat = Number(parts[1]), now = Date.now();
  if (exp < now || now - iat > AUTH_MAX_MS) return false;
  if (!timingSafeEqual(parts[2], await hmacHex(authKey(cfg), parts[0] + '.' + parts[1]))) return false;
  const session = { exp, iat };
  if (state && Math.min(now + AUTH_TTL_MS, iat + AUTH_MAX_MS) - exp >= AUTH_REFRESH_MIN_MS) {
    const t = await makeAuthToken(cfg, iat);
    state.setCookie = authCookie(t.token, t.exp);
  }
  return session;
}
// 登录失败限速（按客户端 IP，同一 Worker 实例内生效，属尽力而为）：15 分钟内最多 5 次失败。
// IPv6 按 /64 网段计数（单个用户通常拥有整个 /64，逐地址计数会被轻易绕过）；
// 表满时只淘汰最旧项，不整表清空（否则攻击者灌入大量来源即可清零所有计数）
const LOGIN_FAILS = new Map();
const LOGIN_MAX_FAILS = 5, LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_TABLE_MAX = 5000;
function loginRateKey(ip) {
  ip = String(ip || 'unknown');
  if (ip.indexOf(':') < 0) return ip;
  const dbl = ip.indexOf('::');
  let groups;
  if (dbl >= 0) {
    const left = ip.slice(0, dbl).split(':').filter(Boolean), right = ip.slice(dbl + 2).split(':').filter(Boolean);
    groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  } else groups = ip.split(':');
  return groups.slice(0, 4).map(g => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
function loginBlocked(ip) {
  const k = loginRateKey(ip), r = LOGIN_FAILS.get(k);
  if (!r) return false;
  if (Date.now() - r.t > LOGIN_WINDOW_MS) { LOGIN_FAILS.delete(k); return false; }
  return r.n >= LOGIN_MAX_FAILS;
}
function loginFail(ip) {
  const k = loginRateKey(ip), now = Date.now(), r = LOGIN_FAILS.get(k);
  if (!r || now - r.t > LOGIN_WINDOW_MS) { LOGIN_FAILS.delete(k); LOGIN_FAILS.set(k, { n: 1, t: now }); }
  else r.n++;
  // Map 按插入顺序遍历，而记录的时间戳是首次失败时间——最先插入的就是最先过期的，淘汰最旧项即可（O(1)）
  while (LOGIN_FAILS.size > LOGIN_TABLE_MAX) LOGIN_FAILS.delete(LOGIN_FAILS.keys().next().value);
}
function loginSuccess(ip) { LOGIN_FAILS.delete(loginRateKey(ip)); }
// 登录页与登录接口只对「知道面板路径」的人开放：next 必须指向面板路径（面板入口的跳转自带），
// 否则返回 404——扫描器无法凭 /login 识别部署，也无法在不知道路径的情况下爆破管理密码
function loginNextOk(next, panelPath) {
  next = String(next || '');
  if (!/^\/[^\/\\]/.test(next)) return false;
  let seg = next.slice(1).split(/[\/?#]/)[0];
  try { seg = decodeURIComponent(seg); } catch (e) { return false; }
  return seg === panelPath;
}
function safeNext(next, panelPath) {
  next = String(next || '');
  return (/^\/[^\/\\]/.test(next)) ? next : ('/' + panelPath);
}
// Cookie 有效期与令牌的过期时间一致
function authCookie(token, exp) {
  const maxAge = Math.max(0, Math.floor((exp - Date.now()) / 1000));
  return `hopline_auth=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
// 返回给面板的配置：只含字段表登记的配置项，不下发管理密码明文；附带面板需要的派生信息
function publicConfig(cfg, env) {
  const out = pickSchema(cfg);
  out.version = VERSION;
  out.adminSet = !!cfg.admin;
  delete out.admin;
  out.path = cfg.path;                              // 环境变量 PATH 提供（面板中只读）
  out.panelPath = cfg.path;                         // 当前生效的面板路径
  out.endpointMissing = endpointMissing(cfg);       // 尚未填写的代理端点字段（空数组 = 可以生成订阅）
  out.envLocked = envLockedFields(env);             // { 字段: 环境变量名 }：面板中只读
  out.kv = !!(kvStore(env) && typeof kvStore(env).put === 'function');
  out.builtinPrefDomains = DEFAULT_PREFERRED_DOMAINS.split('\n');   // 面板「载入内置列表」使用
  out.kvError = cfg._kvError ? kvErrorMessage(cfg._kvError) : '';   // 非空 = 配置存储异常，面板提示且保存被禁用
  return out;
}
function kvErrorMessage(kind) {
  return kind === 'corrupt' ? 'KV 中保存的配置已损坏（不是合法 JSON），当前使用的是环境变量与默认值' : 'KV 暂时无法读取，当前使用的是环境变量与默认值';
}
function formatConfigErrors(errors) {
  return errors.map(e => (e.label ? e.label + '：' : '') + e.msg).join('；');
}

// 生成订阅：/sub 与面板预览共用同一流程，保证预览与客户端实际拿到的一致
async function serveSubscription(request, cfg, fmt) {
  const UA = request.headers.get('User-Agent') || '';
  return generateSubscription(Object.assign({}, cfg), fmt, UA);
}

// 必填环境变量检查：返回说明文字（有问题时），否则空串。PATH 必填；ADMIN 必填（缺失时面板与管理接口禁用，见面板入口处的提示）
function setupProblems(env, cfg) {
  if (cfg.path) return '';
  return cfg._pathError
    ? '环境变量 PATH 的值不正确：' + cfg._pathError + '。'
    : 'Hopline 面板尚未完成配置：请在 Worker 环境变量中设置 PATH（面板与订阅的访问路径，如 mypanel）和 ADMIN（管理密码），然后重新访问。';
}

async function handleRequest(request, env, state) {
  const url = new URL(request.url);
  const UA = request.headers.get('User-Agent') || '';

  // HTTP → HTTPS
  if (url.protocol === 'http:') {
    return Response.redirect(url.href.replace('http://', 'https://'), 301);
  }

  const cfg = await loadConfig(env);
  // 必填项缺失：PATH（面板与订阅的访问路径）未设置或非法。没有路径就无法路由任何请求，统一返回设置说明
  const setupMsg = setupProblems(env, cfg);
  if (setupMsg) return new Response(setupMsg, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const panelPath = cfg.path;
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  const segs = path.split('/');

  // ---------- 版本接口（仅登录后可用；公开会让扫描器识别部署与版本） ----------
  if (segs[0] === 'version') {
    if (!(await requireAuth(request, cfg, state))) return new Response('Not Found', { status: 404 });
    return json({ version: VERSION });
  }

  // ---------- 登录 ----------
  if (segs[0] === 'login') {
    // 未设置 ADMIN 时登录页不存在（避免暴露面板路径）
    if (!cfg.admin) return new Response('Not Found', { status: 404 });
    if (request.method === 'POST') {
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      const body = await request.text();
      const params = new URLSearchParams(body);
      if (!loginNextOk(params.get('next'), panelPath)) return new Response('Not Found', { status: 404 });
      if (loginBlocked(clientIp)) return json({ ok: false, msg: '尝试次数过多，请 15 分钟后再试' }, 429);
      // 用户名与密码都校验完再判定（密码校验总会执行，不因用户名错误提前返回），错误提示不区分是哪一项
      const userOk = timingSafeEqual(params.get('username') || '', adminUserOf(cfg));
      const passOk = await verifyAdminPassword(cfg.admin, params.get('password') || '');
      if (userOk && passOk) {
        loginSuccess(clientIp);
        const t = await makeAuthToken(cfg);
        return new Response(JSON.stringify({ ok: true, next: safeNext(params.get('next'), panelPath) }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': authCookie(t.token, t.exp)
          }
        });
      }
      loginFail(clientIp);
      return json({ ok: false, msg: '用户名或密码错误' }, 403);
    }
    if (!loginNextOk(url.searchParams.get('next'), panelPath)) return new Response('Not Found', { status: 404 });
    return new Response(loginHTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // 订阅入口：自定义订阅路径（如 /mysub/sub）；面板路径下的 /sub 始终可用。
  // 面板入口与管理 API 只认 panelPath，订阅入口下不开放面板与管理接口
  const subAlias = String(cfg.subUrl || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const isPanelRoot = segs[0] === panelPath;
  const isSubRoot = isPanelRoot || (subAlias !== '' && segs[0] === subAlias);

  // 根路径不跳转到面板入口（否则会把面板路径 / UUID 告诉任何访问者），返回伪装页
  if (segs[0] === '') {
    return stubPage();
  }

  // ---------- 订阅 ----------
  if (isSubRoot && (segs[1] === 'sub' || (segs.length === 1 && !isBrowserUA(UA)))) {
    const fmt = segs.length >= 3 ? segs[2] : '';
    try {
      const sub = await serveSubscription(request, cfg, fmt);
      return new Response(sub.body, { status: 200, headers: { 'Content-Type': sub.type + '; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="Hopline"; filename*=utf-8\'\'Hopline' } });
    } catch (e) {
      const status = (e && e.status) || 500;
      return new Response('订阅生成失败: ' + (e && e.message || e), { status, headers: status === 503 ? { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '15' } : { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }

  // ---------- 面板（浏览器访问） ----------
  if (isPanelRoot && segs.length === 1 && isBrowserUA(UA)) {
    if (!cfg.admin) {
      return new Response('面板已禁用：请先在 Worker 环境变量中设置 ADMIN（管理密码），然后重新访问。', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (!(await requireAuth(request, cfg, state))) {
      return Response.redirect(new URL('/login?next=' + encodeURIComponent('/' + panelPath), request.url).href, 302);
    }
    return new Response(panelPage(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  // ---------- API ----------
  if (isPanelRoot && segs[1] === 'api') {
    const apiName = segs[2] || '';
    const authed = await requireAuth(request, cfg, state);
    if (!authed) {
      return json({ ok: false, status: 403, msg: '未授权（需要管理密码）' }, 403);
    }

    if (apiName === 'config') {
      if (request.method === 'GET') {
        return json({ ok: true, data: publicConfig(cfg, env) });
      }
      if (request.method === 'POST') {
        if (cfg._kvError) return json({ ok: false, msg: kvErrorMessage(cfg._kvError) + '，为避免覆盖已有配置，已禁止保存' }, 503);
        // 未绑定 KV 时保存不会持久化，必须拒绝而不是提示「已保存」
        const kv = kvStore(env);
        if (!kv || typeof kv.put !== 'function') {
          return json({ ok: false, msg: '未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存面板配置；请在 Worker 设置中绑定 KV 后重试' }, 400);
        }
        let body;
        try { body = await request.json(); } catch (e) { return json({ ok: false, msg: '请求体不是合法的 JSON' }, 400); }
        try {
          // 按字段表校验：只接受登记过的字段，逐项校验并规范化；有错误时返回字段级错误列表供面板标注
          const { patch, errors, ignored } = sanitizeConfigPatch(body, env);
          if (errors.length) return json({ ok: false, msg: formatConfigErrors(errors), errors, ignored }, 400);
          const merged = pickSchema(cfg);
          for (const d of CONFIG_SCHEMA) {
            const v = getPath(patch, d.key);
            if (v !== undefined) setPath(merged, d.key, v);
          }
          const crossErrors = crossCheckConfig(merged);
          if (crossErrors.length) return json({ ok: false, msg: formatConfigErrors(crossErrors), errors: crossErrors, ignored }, 400);
          // KV 里的管理密码只存摘要：面板新设的密码（以及 KV 中已有的明文密码）都在这里转成摘要
          if (merged.admin && !isAdminHash(merged.admin) && !envLockedFields(env).admin) merged.admin = await hashAdminPassword(merged.admin);
          const stored = await saveConfig(env, merged);
          // 直接用刚写入的数据组装新配置（不回读 KV：边缘缓存可能仍是旧值）
          const fresh = buildConfig(env, stored);
          // UUID / 管理密码 / 管理用户名变更会使登录态签名失效：当前会话已通过鉴权，直接签发新令牌，面板无需重新登录
          // （沿用原登录时间，7 天上限不因此重置）
          const headers = {};
          if (fresh.admin && authKey(fresh) !== authKey(cfg)) { const t = await makeAuthToken(fresh, authed.iat); headers['Set-Cookie'] = authCookie(t.token, t.exp); }
          return json({ ok: true, data: publicConfig(fresh, env), ignored, msg: '已保存：本地区立即生效，其他地区约 1 分钟内同步' }, 200, headers);
        } catch (e) { return json({ ok: false, msg: '保存失败: ' + (e.message || e) }, 500); }
      }
      return json({ ok: false, msg: '仅支持 GET / POST' }, 405);
    }

    // 代理管理（增删改 / 同步 / 启停 / 状态 / 在线设置）：面板通过签名的 HTTPS 请求调用代理的控制接口，见 proxies-api.js
    if (apiName === 'proxies' || apiName === 'proxy-status' || apiName === 'proxy-sync-all' || apiName === 'alt-routes') return handleProxiesApi(apiName, request, env, cfg, segs, url);

    if (apiName === 'logout') {
      if (request.method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
      // 会话令牌是无状态的签名令牌，无法在服务端单独吊销：这里清除浏览器中的 Cookie。
      // 要让已签发的令牌全部失效，修改管理密码、管理用户名或 UUID 即可（签名密钥随之变化）
      return json({ ok: true, msg: '已退出登录' }, 200, { 'Set-Cookie': 'hopline_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
    }

    if (apiName === 'reset') {
      if (request.method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
      try {
        if (cfg._kvError === 'unavailable') return json({ ok: false, msg: kvErrorMessage(cfg._kvError) + '，暂时无法重置' }, 503);   // 配置损坏（corrupt）时允许重置来修复
        const kvr = kvStore(env);
        if (!kvr || typeof kvr.delete !== 'function') return json({ ok: false, msg: '未绑定 KV 命名空间，无需重置' }, 400);
        await kvr.delete('config');
        return json({ ok: true, msg: '已重置：KV 已清空，面板还原为初始部署状态' });
      } catch (e) { return json({ ok: false, msg: '重置失败: ' + (e.message || e) }, 500); }
    }

    if (apiName === 'status') {
      return json({ ok: true, data: { version: VERSION, host: url.hostname, path: panelPath, region: (request.cf && request.cf.colo) || 'unknown', kv: !!(kvStore(env) && typeof kvStore(env).get === 'function'), workersDev: /\.workers\.dev$/i.test(url.hostname) } });
    }

    if (apiName === 'update') {
      try {
        const r = await checkUpdate();
        const d = { current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, error: r.error || '' };
        if (r.hasUpdate && r.code) d.code = r.code;
        return json({ ok: true, data: d });
      } catch (e) { return json({ ok: false, msg: '检测失败: ' + (e.message || e) }, 500); }
    }

    // 优选 IP 来源测试（面板「测试」按钮）：强制重新拉取指定来源（不读写缓存），返回解析结果与原始响应片段。
    // 自定义 API 使用请求中的地址（面板输入框当前值，可在保存前测试）
    if (apiName === 'ipsrc-test') {
      if (request.method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
      let body = {};
      try { body = await request.json(); } catch (e) { /* 空请求体 */ }
      const source = String((body && body.source) || '');
      const t0 = Date.now();
      let r;
      if (source === 'hostmonit') r = await hostmonitFetch(150);
      else if (source === 'uouin') r = await uouinFetch();
      else if (source === 'wetest') r = await wetestFetch();
      else if (source === 'domains') {
        // 测试面板输入框里尚未保存的域名列表；留空则测试内置列表
        const chk = SERVER_CHECKS.domainList(String((body && body.text) || ''));
        if (typeof chk === 'string') return json({ ok: false, msg: chk }, 400);
        r = await domainsFetch(chk.value ? chk.value.split('\n') : DEFAULT_PREFERRED_DOMAINS.split('\n'));
      }
      else if (source === 'api1' || source === 'api2') {
        const chk = checkFieldValue(SCHEMA_BY_KEY.get('ipsrc.' + source + 'Url'), body.url);
        if (chk.error || !chk.value) return json({ ok: false, msg: chk.error || '请先填写 API 地址' }, 400);
        r = await customApiFetch(chk.value);
      } else return json({ ok: false, msg: '未知来源：' + source }, 400);
      const RAW_MAX = 4000;
      return json({ ok: true, data: {
        source, ms: Date.now() - t0, status: r.status, error: r.error || '',
        count: r.items.length, items: r.items.slice(0, 300),
        droppedCount: r.dropped.length, dropped: r.dropped.slice(0, 50),
        raw: r.raw.slice(0, RAW_MAX), rawLength: r.raw.length, domains: r.domains,
      } });
    }

    if (apiName === 'sub') {
      const fmt = url.searchParams.get('fmt') || '';
      try {
        const sub = await serveSubscription(request, cfg, fmt);
        return json({ ok: true, type: sub.type, body: sub.body, count: sub.count });
      } catch (e) { return json({ ok: false, msg: '订阅生成失败: ' + (e.message || e) }, (e && e.status) || 500); }
    }

    return json({ ok: false, msg: '未知 API: ' + apiName }, 404);
  }

  // 未匹配任何有效路由（路径不对）：返回伪装页，不暴露部署存在
  return stubPage();
}

// 安全响应头：只加在 HTML 页面与 JSON 接口上（订阅、WebSocket、XHTTP 流不动）。
// CSP 允许面板自带的内联脚本 / 样式与 jsDelivr 上带 SRI 的二维码库；frame-ancestors 'none' 防止面板被嵌入框架点击劫持
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function withSecurityHeaders(res) {
  if (!res || res.status === 101 || res.webSocket) return res;
  const ct = res.headers.get('Content-Type') || '';
  const isHtml = /^text\/html/i.test(ct), isJson = /^application\/json/i.test(ct);
  if (!isHtml && !isJson) return res;
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  if (isHtml) {
    h.set('Content-Security-Policy', PAGE_CSP);
    h.set('X-Frame-Options', 'DENY');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    const state = {};
    let res = await handleRequest(request, env, state);
    // 登录会话续期：已登录的请求在响应上附带新 Cookie（响应自己设置了 Cookie 时以响应为准，如退出登录、改密码）
    if (state.setCookie && res.status !== 101 && !res.headers.has('Set-Cookie')) {
      res = new Response(res.body, res);
      res.headers.set('Set-Cookie', state.setCookie);
    }
    return withSecurityHeaders(res);
  }
};
