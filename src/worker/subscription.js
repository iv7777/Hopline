// 单次订阅的节点上限（按 Workers / Pages 免费额度 10ms CPU 硬限设定）：结构化格式（Clash / Sing-box 等）
// 约 400 节点 ~8ms，行式格式拼接成本很低；统一取 500
const NODE_CAP = 500;

// 根据 UA 或指定格式生成订阅
async function generateSubscription(env, cfg, requestUrl, format, ua) {
  // 明文端口节点只由「仅 TLS 端口」控制（默认开启）；ECH 只对 TLS 生效，开启时同样只下发 TLS 端口节点。
  // 自定义域名的明文端口需在 Cloudflare 关闭「始终使用 HTTPS」，否则被 301 重定向、WebSocket 握手失败
  const rc = Object.assign({}, cfg, { host: cfg.host || new URL(requestUrl).hostname });
  const prefList = effectivePrefDomains(cfg);   // 面板填写的优选域名（整体替换内置列表）或内置列表
  if (rc.ech) rc.tlsOnly = true;
  // 筛选含 IPv6 时查询 AAAA 记录并生成 IPv6 节点（默认双选 IPv4+IPv6 同样生效）；
  // 仅勾选 IPv6（单选）时全部走 IPv6 来源
  const ipT = (cfg.filter && cfg.filter.ipType) || [];
  const wantV6 = ipT.includes('IPv6');
  const onlyV6 = ipT.length === 1 && ipT[0] === 'IPv6';
  // 节点池由「地址来源」三项组装（rc.preferredDomains / rc.preferredIPs 只是本次订阅的内部中间结果，不是配置项）——
  // 1) 原生地址（src.native）：工作器域名直接作为节点 server 下发（默认关闭）；
  // 2) 优选域名（src.prefDomain）：第三方优选域名直接作为节点 server 下发（客户端连接时动态 DNS 解析，拿到当前最优 CF 边缘 IP）；
  // 3) 优选 IP（src.prefIp）：自定义优选 API / HostMonit / uouin / 微测网等在线来源（「优选配置 → 优选 IP 来源」）。
  // 这些来源都是 Cloudflare 任播 IP / 域名，大多不带地区标记（任播 IP 的落地机房取决于客户端所在网络），
  // 因此面板「节点地区」筛选通常不改变节点构成；来源一律只保留 Cloudflare 段，非 CF 段 IP 无法转发到 Worker
  const src = cfg.src || {};
  const useNative = src.native === true;            // 启用原生地址（工作器域名）
  const useDomain = src.prefDomain !== false;       // 启用优选域名（默认开）
  const useIp = src.prefIp !== false;               // 启用优选 IP（内置池 + 实时拉取，默认开）
  rc.preferredDomains = '';
  rc.preferredIPs = [];
  // 原生地址（工作器域名，IPv4 入口）：仅勾选 IPv6 时跳过，避免 v4 域名混入
  if (useNative && !onlyV6) rc.preferredDomains = rc.host + '#原生地址';
  // 仅勾选 IPv6 时跳过 v4 优选域名（域名节点为 IPv4 入口，混入会占满 cap 并被 filterNodes 剔除，导致数量控制下发不足）
  if (useDomain && !onlyV6) {
    // 域名按原样下发（不预检）：客户端连接时自行解析到当前最优的 CF 边缘 IP；失效的域名可用「优选配置 → 优选域名 → 测试」找出
    rc.preferredDomains = (rc.preferredDomains ? rc.preferredDomains + '\n' : '') + prefList;
  }
  // 「优选 IP」的在线来源（面板「优选配置 → 优选 IP 来源」开关控制，并行拉取，每个来源 1 个子请求、缓存 10 分钟）：
  // 自定义优选 API 1 / 2（用户自选来源排最前）→ HostMonit → uouin → 微测网。HostMonit 为纯 IPv4，仅勾选 IPv6 时跳过；微测网只拉取所选 IP 类型对应的页面
  if (useIp) {
    const ps = cfg.ipsrc || {};
    const apiSrc = (n) => (ps['api' + n] && ps['api' + n + 'Url'])
      ? resolvePreferredDomains(ps['api' + n + 'Url'], 200, 300, true, false).catch(() => [])
      : Promise.resolve([]);
    const results = await Promise.all([
      apiSrc(1),
      apiSrc(2),
      (ps.hostmonit !== false && !onlyV6) ? fetchLatestPreferredIPs(150).catch(() => null) : null,
      ps.uouin === true ? fetchUouinIPs(!onlyV6, wantV6).catch(() => []) : null,
      ps.wetest === true ? fetchWetestIPs(!onlyV6, wantV6).catch(() => []) : null,
    ]);
    for (const list of results) if (list && list.length) rc.preferredIPs.push(...list);
  }
  // IPv6 节点来源：筛选含 IPv6 时只查询优选域名的 AAAA 记录（v4 已由域名节点覆盖，不重复查 A）。
  // 子请求预算：Workers 免费版每次请求最多 50 个子请求——IPv4+IPv6 混合时只解析前 V6_DOMAIN_LIMIT 个域名；
  // 仅勾选 IPv6 时 v4 来源全部跳过，预算充足，解析全部域名并并入官方域名 AAAA
  if (wantV6 && useDomain) {
    try {
      const v6src = onlyV6
        ? dohPrefDomains(prefList) + '\n' + BUILTIN_OFFICIAL_DOMAINS.join('\n')
        : prefList.split('\n').slice(0, V6_DOMAIN_LIMIT).join('\n');
      const v6dom = await resolvePreferredDomains(v6src, 40, onlyV6 ? 800 : 240, true, 'only');
      // 解析结果名为「域名-序号」，统一改为不带地区的通用名「优选IP-V6-NN」（地区筛选时作为通用节点保留）
      if (v6dom && v6dom.length) rc.preferredIPs.push(...v6dom.map((x, i) => Object.assign({}, x, { name: '优选IP-V6-' + String(i + 1).padStart(2, '0') })));
    } catch (e) { /* AAAA 解析失败不影响其它来源 */ }
  }
  // 地址来源全部关闭时用官方域名兜底，保证订阅不为空（客户端不会收到「无效订阅」）
  if (!useNative && !useDomain && !useIp) rc.preferredDomains = BUILTIN_OFFICIAL_DOMAINS.map((d, i) => d + '#域名-' + String(i + 1).padStart(2, '0')).join('\n');
  // 仅勾选 IPv6（单选）时清掉各来源混入的 IPv4（域名 AAAA 解析的 v4 与各在线来源中的 v4 一并剔除，
  // 避免 filterNodes 过滤空集后放宽回退全 v4）
  if (onlyV6 && rc.preferredIPs) rc.preferredIPs = rc.preferredIPs.filter(x => String(x.ip).indexOf(':') >= 0);
  ua = (ua || '').toLowerCase();
  const forced = (format || '').toLowerCase();
  const cap = NODE_CAP;
  // 不做任何测活剔除：Worker 边缘连通性 ≠ 客户端连通性，且 Workers 无法连接 CF 段 IP；全量按顺序下发由客户端自行择优
  let nodes = filterNodes(await buildNodes(rc, cap), cfg.filter);
  // 所有来源都没有产出节点时（如在线来源全部失败），用官方域名节点兜底，保证订阅不为空
  // （客户端不会收到「无效订阅」）；域名节点由客户端自行解析，IPv4 / IPv6 均可
  if (!nodes.length) {
    const fb = Object.assign({}, rc, { preferredDomains: BUILTIN_OFFICIAL_DOMAINS.map((d, i) => d + '#域名-' + String(i + 1).padStart(2, '0')).join('\n'), preferredIPs: [], tlsOnly: true });
    nodes = await buildNodes(fb, cap);
  }
  // 严格封顶：多协议膨胀可能越过上限，统一截断（节点数量只做上限，来源不足时按实际数量下发）
  if (nodes.length > cap) nodes.length = cap;
  nodes = uniqueNodeNames(nodes);
  let type, body;
  if (forced === 'clash' || forced === 'stash') { type = 'text/yaml'; body = generateClash(rc, nodes, await requireClashTemplate(env)); }   // Stash 使用 Clash 格式（与按 UA 识别一致）
  else if (forced === 'singbox' || forced === 'sing-box') { type = 'application/json'; body = generateSingbox(rc, nodes); }
  else if (forced === 'surge') { type = 'text/plain'; body = generateSurge(rc, nodes); }
  else if (forced === 'loon') { type = 'text/plain'; body = generateLoon(rc, nodes); }
  else if (forced === 'quanx' || forced === 'quantumultx') { type = 'text/plain'; body = generateQuanX(rc, nodes); }
  else if (forced === 'plain' || forced === 'raw') { type = 'text/plain'; body = nodes.join('\n'); }
  else if (forced === 'v2ray' || forced === 'v2rayn' || forced === 'shadowrocket' || forced === 'nekoray') {
    // 明文下发（与 1.0.6 一致）：base64 订阅在 AsteriskNG / v2rayNG 中按系统编码（GBK）解码，
    // 中文节点名（UTF-8）会被误读成乱码（如 美国 → 缇庡浗）；明文按响应 charset=utf-8 读取则正常
    type = 'text/plain'; body = nodes.join('\n');
  }
  // UA 自动识别
  else if (ua.includes('clash') || ua.includes('stash')) { type = 'text/yaml'; body = generateClash(rc, nodes, await requireClashTemplate(env)); }
  else if (ua.includes('sing-box')) { type = 'application/json'; body = generateSingbox(rc, nodes); }
  else if (ua.includes('surge')) { type = 'text/plain'; body = generateSurge(rc, nodes); }
  else if (ua.includes('loon')) { type = 'text/plain'; body = generateLoon(rc, nodes); }
  else if (ua.includes('quantumult')) { type = 'text/plain'; body = generateQuanX(rc, nodes); }
  // 默认（v2rayN / Shadowrocket / 未知客户端）：返回 base64 编码订阅（V2rayN 标准格式）
  else { type = 'text/plain'; body = nodes.join('\n'); }   // 明文（同 1.0.6，避免客户端按 GBK 解码 base64 导致中文名称乱码）
  return { type, body, count: nodes.length };
}

