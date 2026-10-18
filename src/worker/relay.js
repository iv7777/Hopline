// ---------------------------------------------------------------------------
// 出站兜底：直连与自定义反代均失败后使用，透明代理模式发送去掉 VLESS 头部的原始
// TLS 数据，由对端按 SNI 路由到目标
// ---------------------------------------------------------------------------
// Worker 所在机房（IATA 代码）→ 最近的地区标签（表里没有的机房按 US，主要是美洲）。地区标签对应面板下发的备用线路表里的标签。
// 台湾、澳门归 HK；东南亚、南亚、大洋洲归 SG（这些地方离新加坡比离美国近得多）；中东、非洲、南欧与东欧归 DE
const COLO_REGIONS = {
  HK: 'HKG TPE KHH MFM',
  SG: 'SIN KUL JHB PEN BKK CNX HKT CGK SUB DPS MNL CEB SGN HAN DAD PNH RGN VTE CMB MLE DAC KTM BOM DEL MAA BLR HYD CCU AMD NAG PAT KHI LHE ISB SYD MEL BNE PER ADL CBR HBA AKL CHC NOU',
  JP: 'NRT KIX TYO OSA FUK OKA CTS GUM', KR: 'ICN SEL',
  SE: 'ARN GOT OSL', NL: 'AMS BRU LUX', FI: 'HEL TLL RIX VNO', GB: 'LHR MAN EDI DUB ORK',
  DE: 'FRA BER MUC DUS HAM STR CDG MRS LYS MAD BCN LIS VIE ZRH GVA MXP FCO PMO PRG WAW BUD BTS LJU ZAG BEG SOF OTP KBP KIV ATH SKG IST ADB CPH ' +
    'TLV AMM BEY DXB AUH DOH BAH KWI MCT RUH JED DMM BGW EBL TBS EVN GYD CAI ALG TUN CMN LOS ACC ABJ DKR NBO DAR JNB CPT DUR MPM LAD KGL ADD',
};
const COLO_TO_REGION = new Map(Object.entries(COLO_REGIONS).flatMap(([r, codes]) => codes.split(' ').map(c => [c, r])));
function selectAltRegion(colo) { return COLO_TO_REGION.get(String(colo || '').toUpperCase().slice(0, 3)) || 'US'; }
// 地区的相邻地区（按优先顺序）：auto 先取本地区，再依次取相邻的，欧洲的机房不会被补到香港 / 美国去
const ALT_NEIGHBORS = {
  US: 'SG JP KR', SG: 'JP KR US', JP: 'SG KR US', KR: 'JP SG US', HK: 'SG JP KR',
  DE: 'NL GB SE FI', SE: 'DE NL FI GB', NL: 'DE GB SE FI', FI: 'SE DE NL GB', GB: 'DE NL SE FI',
};

// EDGEIP 反代 IP 解析缓存（TTL 5 分钟：域名 → DoH TXT/A 解析结果）
const EDGEIP_CACHE = new Map();

// 解析反代域名为 IP 候选列表：
//   - IP 字面量直接返回
//   - 域名先查 TXT：TXT 含逗号/换行分隔的 IP 列表则解析为多候选；
//     TXT 为约定的标记值或无有效 TXT 时查 A 记录
//   - 结果缓存 5 分钟，避免每次连接都触发 DoH
//   - opts.txt === false：只查 A 记录（内置地区反代域名没有 TXT 记录，已实测全部 14 个地区，查 TXT 只是白白多一次 DoH）
// 注意：不能把「进行中的解析」（Promise）跨请求共享——Workers 中 fetch 归属发起它的请求，该请求结束（客户端断开）时
// fetch 被取消，共享这个 Promise 的其它请求会永远等不到结果，且之后同一域名的解析全部卡死（已在 workerd 中复现）。
// 只缓存解析完成的结果（普通数据可以跨请求共享）
const EDGEIP_TTL = 5 * 60 * 1000, EDGEIP_NEG_TTL = 30 * 1000;   // 成功缓存 5 分钟；失败 / 无记录缓存 30 秒（避免每个连接都重新查 DoH）
const EDGEIP_DOHS = ['https://cloudflare-dns.com/dns-query', 'https://dns.alidns.com/resolve', 'https://doh.pub/dns-query'];
async function resolveEdgeIPs(host, port, opts) {
  port = port || 443;
  if (isValidIp(host)) return [{ hostname: host, port }];
  const txt = !(opts && opts.txt === false);
  const cacheKey = host + ':' + port + (txt ? '' : ':a');
  const hit = EDGEIP_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.t < (hit.ips.length ? EDGEIP_TTL : EDGEIP_NEG_TTL)) return hit.ips;
  const ips = await resolveEdgeIPsUncached(host, port, txt);
  EDGEIP_CACHE.set(cacheKey, { t: Date.now(), ips });
  capMap(EDGEIP_CACHE, 200);
  return ips;
}
async function resolveEdgeIPsUncached(host, port, txt) {
  // 每种记录类型按端点顺序查询：前一个端点失败才换下一个（正常只占 1 个子请求）；
  // SERVFAIL 等视为失败换端点，NOERROR / NXDOMAIN 视为确定结果
  const dohQuery = async (type, filterType) => {
    const r = await dohFirst(EDGEIP_DOHS, (url) => url + '?name=' + encodeURIComponent(host) + '&type=' + type, (j) => {
      if (!j || (j.Status !== 0 && j.Status !== 3)) return null;
      return (j.Answer || []).filter(a => a.type === filterType).map(a => a.data);
    });
    return r || [];
  };

  // 并发查询 TXT 与 A 记录（TXT 优先，无有效 TXT 用 A）
  const [txtRecords, aRecords] = await Promise.all([txt ? dohQuery('TXT', 16) : [], dohQuery('A', 1)]);

  let targets = [];
  // 1) TXT 记录：反代服务约定——TXT 存逗号/换行分隔的 IP 列表（支持 ip:port），或约定的标记值
  for (const raw of txtRecords) {
    // DNS TXT 转义：\010 是八进制换行符，需还原为分隔符；去掉首尾引号
    const val = String(raw).replace(/^"|"$/g, '').replace(/\\010/g, ',').replace(/\n/g, ',').trim();
    if (!val) continue;
    if (val === atob('QGVkdHVubmVs')) {
      // 标记值：实际备用线路 IP 在 A 记录中
      targets = aRecords.filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)).map(ip => ({ hostname: ip, port }));
      break;
    }
    // TXT 值为逗号/分号/空格分隔的条目，每条可为 IP 或 IP:port
    const entries = val.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const parsed = [];
    for (const entry of entries) {
      const { host: h, port: p } = parseHostPort(entry, port);
      if (isValidIp(h)) parsed.push({ hostname: h, port: p });
    }
    if (parsed.length) { targets = parsed; break; }
  }

  // 2) 无有效 TXT 时用 A 记录
  if (!targets.length) {
    targets = aRecords.filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)).map(ip => ({ hostname: ip, port }));
  }

  // 3) 无 A 记录时回退 AAAA（IPv6 反代）
  if (!targets.length) {
    const aaaaRecs = await dohQuery('AAAA', 28);
    targets = aaaaRecs.filter(ip => isValidIp(ip)).map(ip => ({ hostname: ip, port }));
  }

  // 去重（按 hostname:port）
  const seen = new Set();
  return targets.filter(t => { const k = t.hostname + ':' + t.port; if (seen.has(k)) return false; seen.add(k); return true; });
}

// 出站并发竞速：同时发起多路连接，取最先握手成功的一路，后到的成功连接立即关闭（释放 CF 同时连接配额）。
// 比串行尝试更快：目标站在 Cloudflare 上时直连会被回环保护拦截，串行要白等约 6s 才轮到反代
async function raceConnect(jobs) {
  if (!jobs || !jobs.length) return null;
  let settled = false;
  return await new Promise((resolve) => {
    let left = jobs.length;
    const finish = (sock) => {
      left--;
      if (sock) {
        if (settled) { try { sock.close(); } catch (e) { /* 忽略 */ } }
        else { settled = true; resolve(sock); }
      } else if (left <= 0 && !settled) {
        resolve(null);
      }
    };
    for (const job of jobs) {
      Promise.resolve().then(job).then((s) => finish(s && s.readable ? s : null), () => finish(null));
    }
  });
}

// 学习型路由：直连失败、由反代接通的目标（Cloudflare 上的站点，直连会被回环保护拦截）记下来，
// 之后到该目标的连接直接走反代：不再发注定失败的直连，也不需要任何 DNS 查询。
// 只在直连「确实失败」（报错 / 超时）时记录；直连只是慢、超出优先窗口但最终能通的站点不记录（继续直连优先）。
// 记录 30 分钟；按记录走反代却失败时删除记录并回落直连
const ALT_HOSTS = new Map();
const ALT_HOST_TTL = 30 * 60 * 1000;
function altHostKnown(host) {
  const t = ALT_HOSTS.get(host);
  if (t === undefined) return false;
  if (Date.now() - t > ALT_HOST_TTL) { ALT_HOSTS.delete(host); return false; }
  return true;
}
function markAltHost(host) { ALT_HOSTS.delete(host); ALT_HOSTS.set(host, Date.now()); capMap(ALT_HOSTS, 1000); }

// 直连优先竞速：直连与反代并发发起，但优先采用直连——
//   · 直连在 graceMs 内成功 → 用直连（反代是第三方 SNI 中转，多一跳且可能误路由）
//   · 直连失败（立即）/ 窗口到期 → 用已就绪的反代（反代并发建立，不额外等待）
//   · 反代也不可用          → 继续等直连
// 若不设窗口，就近反代的握手普遍比跨境直连快，几乎所有 TLS 流量都会被反代抢走。
// graceMs = 0：不等直连（目标确定在 CF 段，直连必被回环保护拦截）；onDirectFail：直连最终失败时回调（学习型路由）
// 反代整体等待上限 ALT_WAIT_MAX：任何情况下都不会无限等待
async function racePreferDirect(directJob, altJobs, graceMs, onDirectFail) {
  let used = null;
  const recycle = (s) => { if (s && s !== used) { try { s.close(); } catch (e) { /* 忽略 */ } } };
  const directP = directJob
    ? Promise.resolve().then(directJob).then((s) => (s && s.readable ? s : null), () => null)
    : Promise.resolve(null);
  // 直连最终失败且这次由反代接通：回调 onDirectFail（两件事先后顺序不定，都发生时调用一次）
  let directFailed = false, altUsed = false;
  const learnIfBoth = () => { if (directFailed && altUsed && onDirectFail) { onDirectFail(); onDirectFail = null; } };
  if (directJob) directP.then((s) => { if (!s) { directFailed = true; learnIfBoth(); } });
  const altP = (altJobs && altJobs.length)
    ? nullAfter(raceConnect(altJobs).then((s) => (s && s.readable ? s : null), () => null), ALT_WAIT_MAX, recycle)
    : Promise.resolve(null);
  let graceTimer = null;
  const first = await Promise.race([
    directP,
    new Promise((r) => { graceTimer = setTimeout(() => r(GRACE_EXPIRED), graceMs); }),
  ]);
  clearTimeout(graceTimer);
  if (first && first !== GRACE_EXPIRED) { used = first; altP.then(recycle); return used; }   // 直连胜出
  const alt = await altP;
  if (alt) { used = alt; altUsed = true; learnIfBoth(); directP.then(recycle); return used; }   // 反代接管
  used = await directP;                                                                          // 反代不可用：等直连
  return used;
}
const GRACE_EXPIRED = Symbol('grace');
// 等待 promise，超过 ms 返回 null；超时后才到达的连接交给 late 关闭
function nullAfter(promise, ms, late) {
  let timer = null, timedOut = false;
  return Promise.race([
    promise.then((v) => { clearTimeout(timer); if (timedOut && late) late(v); return v; }),
    new Promise((r) => { timer = setTimeout(() => { timedOut = true; r(null); }, ms); }),
  ]);
}

const DIRECT_TIMEOUT = 4000;   // 直连超时（反代并发进行，无需久等）
const ALT_TIMEOUT = 4000;    // 单个反代 IP 连接超时
const MAX_RACERS = 4;          // 单次竞速最多并发路数（CF 单请求同时出站连接上限 6，留余量给 DoH 等）
const FIRST_BYTE_MS = 3500;  // 直连接通后等目标首个数据的上限，超过就换备用线路重试
const FIRST_WAIT_MS = 80;      // 头部已完整但尚无数据时，等首包判定协议的上限（不能拖慢建连）
const ALT_WAIT_MAX = 10000;  // 反代整体等待上限（DoH 解析 + 连接）
const DIRECT_GRACE_MS = 1500;  // 直连优先窗口（直连失败会立即换反代，窗口只管「慢但能通」的直连；过短会让反代抢走正常站点的流量，如 YouTube 视频）

// 首包协议判定：自定义反代与内置地区反代都是 SNI 型透明代理，只能搬运 TLS 流量（按 ClientHello 的 SNI 路由）。
// 非 TLS 流量（Telegram MTProto / 明文 HTTP / 裸 TCP）经反代能握手但转发不出任何数据 → 客户端无限重连，
// 因此非 TLS 只走直连与用户配置的出站代理（SOCKS5 / HTTP / SS 是真代理，可承载任意协议）。
// TLS 记录头固定为 0x16 0x03；数据不足 3 字节为 unknown（按可走反代处理，保持原行为）
function payloadKindOf(bytes) {
  if (!bytes || bytes.byteLength < 3) return 'unknown';
  return (bytes[0] === 0x16 && bytes[1] === 0x03) ? 'tls' : 'nontls';
}

// 按面板下发的备用线路得出要竞速的线路：[{ host, port, txt, take }]（take = 取该域名解析结果的前几个 IP）。
// altPick 是按优先顺序排列的标签（auto = 按 Worker 机房选最近的地区，再依次补它相邻的地区），altTable 是 标签 → { host, port, txt }；
// 取前 ALT_MAX 个不重复的线路，第一个取 2 个 IP，其余各 1 个；altPick 为空 = 不使用备用线路
function altPlan(cfg, colo) {
  const out = [], seen = new Set();
  const add = (tag) => {
    const e = cfg.altTable && cfg.altTable[tag];
    if (!e || out.length >= ALT_MAX) return;
    const key = e.host + ':' + (e.port || 443);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ host: e.host, port: e.port || 443, txt: e.txt === true, take: out.length ? 1 : 2 });
  };
  for (const tag of cfg.altPick || []) {
    if (tag !== 'auto') { add(tag); continue; }
    const region = selectAltRegion(colo);
    add(region);
    for (const n of (ALT_NEIGHBORS[region] || '').split(' ')) add(n);
  }
  return out;
}

// 给连接记下它是怎么建立的（direct / alt / edge / hop），首包看门狗只对直连有效
const via = (sock, how) => { if (sock) sock._via = how; return sock; };
// 备用线路的连接任务：每条线路先解析（5 分钟缓存），再并发连接前 take 个 IP；返回的任务数组交给竞速
function altJobsFor(cfg, colo, attempt) {
  return altPlan(cfg, colo).map((p) => async () => {
    let ts = [];
    try { ts = await resolveEdgeIPs(p.host, p.port, { txt: p.txt }); } catch (e) { return null; }
    if (!ts.length) return null;
    return via(await raceConnect(ts.slice(0, p.take).map(t => () => attempt(() => connectDirect(t, ALT_TIMEOUT)))), 'alt');
  });
}
// 只走备用线路（首包看门狗重试用）：返回已连接的 socket，没有可用线路返回 null
async function openAltOnly(cfg, colo) {
  const attempt = async (fn) => { try { return await fn(); } catch (e) { return null; } };
  return racePreferDirect(null, altJobsFor(cfg, colo, attempt).slice(0, MAX_RACERS - 1), 0);
}
// 首包看门狗：直连接通了，但目标 FIRST_BYTE_MS 内没有回任何数据，或者没回数据就关闭了
// （目标在 Cloudflare 上被回环保护「接通后吞掉」、或中途被重置：延迟有、流量 0）——换备用线路并重发同一份首包，只重试一次。
// 只对 TLS 首包（可原样重发）、直连建立的连接、且有备用线路时生效；其它情况原样返回。
// 备用线路没接通时不放弃原连接（只是慢的目标仍能用）：继续等它的首个数据。
// alive：客户端是否还在（已断开就不再重试）。
// 返回 { conn, first }：first 是已经读到的第一块数据（调用方先把它发给客户端），重试后的新连接 first 为 null；
// conn 为 null = 原连接确实没有数据且备用线路也没有（原连接已关闭）
async function firstByteOrRetry(conn, payload, cfg, colo, alive = () => true) {
  if (!payload || !payload.byteLength || conn._via !== 'direct' || payloadKindOf(payload) !== 'tls' || !altPlan(cfg, colo).length) return { conn, first: null };
  const reader = conn.readable.getReader();
  const hasData = (r) => !!(r && !r.done && r.value && r.value.byteLength);
  const readP = reader.read().catch(() => null);
  let timer = null;
  const r1 = await Promise.race([readP, new Promise((res) => { timer = setTimeout(() => res(null), FIRST_BYTE_MS); })]);
  clearTimeout(timer);
  if (hasData(r1)) { reader.releaseLock(); return { conn, first: r1.value }; }
  if (!alive()) { try { conn.close(); } catch (e) { /* 忽略 */ } return { conn: null, first: null }; }   // 客户端已经走了：不再建立新的连接
  const alt = await openAltOnly(cfg, colo);
  if (alt) {
    try { conn.close(); } catch (e) { /* 忽略 */ }
    try { const w = alt.writable.getWriter(); await w.write(payload); w.releaseLock(); return { conn: alt, first: null }; }
    catch (e) { try { alt.close(); } catch (e2) { /* 忽略 */ } return { conn: null, first: null }; }
  }
  // 备用线路没接通：原连接若只是慢，继续等它的首个数据；它已经关闭 / 出错就没有别的办法了
  const late = r1 || await readP;
  if (hasData(late)) { reader.releaseLock(); return { conn, first: late.value }; }
  try { conn.close(); } catch (e) { /* 忽略 */ }
  return { conn: null, first: null };
}

// 打开到目标的出站连接（自定义反代 / 出站代理 / 直连 / 地区反代）
// 反代均为透明代理：发送去掉 VLESS 头部的原始 TLS 数据，对端按 SNI 路由到目标。
// 出站模式语义：only = 仅走出站代理（失败用备用线路兜底，没有备用线路时不兜底）；'' 默认 = 出站代理优先，失败后直连 ∥ 备用线路
async function openUpstream(parsed, cfg, colo, payloadKind) {
  const hop = cfg.hop || null;
  const mode = cfg.hopMode || '';
  const allowSniAlt = payloadKind !== 'nontls';

  const viaHop = hop ? (hop.type === 'socks5' ? (t) => connectViaS5(hop, t) : (t) => connectViaHtHop(hop, t)) : null;

  let lastErr;
  const attempt = async (fn) => { try { const r = await fn(); if (r) return r; } catch (e) { lastErr = e; } return null; };
  const fail = () => { throw lastErr || new Error('所有出站方式均失败'); };

  // 1) 用户填写的「反代 / 落地 IP」：作为固定出口优先使用（多个解析结果并发竞速），失败再走下面的流程。
  //    出站模式为 only 且配置了出站代理时不用它：only 的意思是流量只从出站代理出去，落地 IP 会绕过出站代理
  const edge = cfg.edgeIP && !(mode === 'only' && viaHop) ? parseHostPort(cfg.edgeIP, 443) : null;
  if (edge && edge.host && allowSniAlt) {
    let customTargets = await resolveEdgeIPs(edge.host, edge.port);
    if (!customTargets.length) customTargets = [{ hostname: edge.host, port: edge.port }];
    const r = via(await raceConnect(customTargets.slice(0, MAX_RACERS).map(t => () => attempt(() => connectDirect(t, ALT_TIMEOUT)))), 'edge');
    if (r) return r;
  }

  const target = { hostname: parsed.addr, port: parsed.port };
  // 2) 地区反代（面板「内置地区反代」设置）：builtin = 首选地区（2 个 IP）+ 次选地区（1 个 IP）；custom = 自定义列表；
  //    off = 不使用。各条目的 DoH 解析（5 分钟缓存）与连接并发竞速
  const altJobs = () => (allowSniAlt ? altJobsFor(cfg, colo, attempt) : []);
  const directJob = () => attempt(async () => via(await connectDirect(target, DIRECT_TIMEOUT), 'direct'));
  const hopJob = viaHop ? () => attempt(async () => via(await viaHop(target), 'hop')) : null;
  const hostKey = String(parsed.addr || '').toLowerCase();
  const cfIp = isCloudflareIP(hostKey);
  const learn = !isValidIp(hostKey);   // 学习型路由只针对域名目标（IP 目标按 CF 段直接判断）
  const pickBest = async () => {
    const jobs = altJobs().slice(0, MAX_RACERS - 1);
    // 目标为 CF 段 IP，或已记录需要反代的域名：直连必被回环保护拦截，直接走反代（不发注定失败的直连）；
    // 反代不通时删除记录并回落直连（反代失效时仍能连通）
    if (jobs.length && (cfIp || (learn && altHostKnown(hostKey)))) {
      const r = await racePreferDirect(null, jobs, 0);
      if (r) return r;
      if (learn) ALT_HOSTS.delete(hostKey);
      return racePreferDirect(directJob, [], 0);
    }
    return racePreferDirect(directJob, jobs, DIRECT_GRACE_MS, (learn && jobs.length) ? () => markAltHost(hostKey) : null);
  };

  if (mode === 'only') {
    if (hopJob) {
      const r = await hopJob(); if (r) return r;
      const r2 = await racePreferDirect(null, altJobs(), 0); if (r2) return r2;
      return fail();
    }
    const r = await pickBest(); if (r) return r;   // 未配置出站代理：按直连处理
    return fail();
  }
  if (hopJob) {   // 默认：出站代理优先，失败后直连 ∥ 备用线路
    const r = await hopJob(); if (r) return r;
  }
  const r = await pickBest(); if (r) return r;
  return fail();
}

// 下行管道（WebSocket）：目标可读流 → send 回调；结束（含出错）调用 onDone。
// CPU 主要花在读取次数上：运行时 socket 的默认读取每次只给约 4KB，1MB 就是约 256 轮 JS 调度（免费版每个请求只有 10ms CPU）。
// 改用 BYOB 读取器、自带 64KB 缓冲：一次读取取走已到达的全部数据（最多 64KB），不额外等待网络，交互流量照常即时发出。
// workerd 实测 64MB 下行：读取次数 16522 → 1040，每 MB CPU 约 5.5ms → 1.1ms，吞吐约 2.5 倍。
// ws.send() 不会立即复制数据：发出的缓冲不能再交给下一次读取（复用会把后读的数据写进尚未发出的消息，实测数据损坏）。
// 大块原样发出并换新缓冲；小块复制一份发出，缓冲继续复用（交互流量不必每次分配 64KB）
const WS_READ_BUF = 64 * 1024, WS_COPY_BELOW = 32 * 1024;
async function pumpReadable(readable, send, onDone) {
  let reader = null;
  try { reader = readable.getReader({ mode: 'byob' }); } catch (e) { /* 非字节流（如 SS 出站的解密流）：走默认读取 */ }
  try {
    if (!reader) await pumpBatched(readable.getReader(), send);
    else {
      let buf = new ArrayBuffer(WS_READ_BUF);
      while (true) {
        const { done, value } = await reader.read(new Uint8Array(buf, 0, WS_READ_BUF));
        if (done) break;
        if (value.byteLength >= WS_COPY_BELOW) { send(value); buf = new ArrayBuffer(WS_READ_BUF); }
        else { if (value.byteLength) send(value.slice()); buf = value.buffer; }
      }
    }
  } catch (e) { /* 忽略 */ }
  try { if (onDone) onDone(); } catch (e) { /* 忽略 */ }
}

// 默认读取（不支持 BYOB 的流）：把「已经到达」的后续数据（同一轮 I/O 内、不额外等待网络）合并成最多 64KB 一条消息再发。
// 只在读满时合并：一次读到不足 4KB 说明缓冲已读空（交互流量），直接发出，不等待；
// 读满 4KB 时才用 0ms 定时器探测后续数据是否已到达（读取先于定时器完成 = 已在缓冲中），否则立即发出已攒的
// （定时器粒度约 1ms，若对每块都等会让交互往返多约 1ms）
const WS_BATCH_MAX = 64 * 1024, WS_FULL_READ = 4096;
async function pumpBatched(reader, send) {
  let timer = null;
  const tick = () => new Promise((r) => { timer = setTimeout(() => r(null), 0); });
  const read = () => { const p = reader.read(); p.catch(() => {}); return p; };
  try {
    let next = read();
    while (true) {
      const first = await next;
      if (first.done) break;
      next = read();
      let parts = null, size = first.value.byteLength, ended = false, last = size;
      while (last >= WS_FULL_READ && size < WS_BATCH_MAX) {
        const r = await Promise.race([next, tick()]);
        clearTimeout(timer);   // 定时器必须清掉：运行时限制同时存在的定时器数量（超限会抛 QuotaExceededError）
        if (!r) break;                               // 暂无更多数据：发出已攒的
        if (r.done) { ended = true; break; }
        (parts || (parts = [first.value])).push(r.value);
        size += r.value.byteLength;
        last = r.value.byteLength;
        next = read();
      }
      if (!parts) send(first.value);
      else {
        const out = new Uint8Array(size);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.byteLength; }
        send(out);
      }
      if (ended) break;
    }
  } catch (e) { /* 忽略 */ }
}
