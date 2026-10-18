/*!Hopline-proxy v3.2.2*/
// ============================================================================
//  Hopline 代理 —— 只做一件事：在节点路径上接收 VLESS（WebSocket / XHTTP）并转发
//  ----------------------------------------------------------------------------
//  没有面板、登录、KV 与订阅生成；节点链接由 Hopline 面板脚本（Hopline-panel.js）生成，
//  面板只需要本脚本的 域名、PATH 与 NODE_KEY：UUID 由面板生成并下发给代理。
//  环境变量只有两项必填（其余设置、UUID 与启用开关都由面板在线下发，保存在 NODE_KV 里）：
//    PATH       【必填】节点路径（WebSocket / XHTTP 共用），如 mynode
//    NODE_KEY   【必填】控制密钥（至少 24 位随机字符，面板里可以生成）：面板用它给控制请求签名
//  绑定：
//    NODE_KV    【面板配置必需】代理自己的 KV 命名空间（单独建一个，只有代理绑定）：保存 UUID、启用开关与运行设置
//  面板还没下发 UUID 或代理被停用时，节点路径与其它任何路径一样只返回伪装页。
//  落地 / 出站 / 备用线路等设置同样由面板整份下发（控制接口 setState），代理没有这些环境变量。
//  VLESS 的 WebSocket 与 XHTTP 两种传输始终同时启用。
//  控制接口是签名的 HTTPS 请求（POST /<PATH>/<由密钥派生的标记>），面板与代理可以在不同账号里；见 proxy-control.js。
// ============================================================================
import { connect } from 'cloudflare:sockets';

// 代理脚本（Hopline-proxy.js）的版本号：只通过服务绑定的 status() 报告（不会出现在任何公开响应里）。与面板脚本各自编号、各自升版本
const VERSION = '3.2.2';
// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const TE = new TextEncoder();

function isUUID(str) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str || '');
}
function parseHostPort(addr, defaultPort = 443) {
  addr = String(addr || '').trim();
  if (!addr) return { host: '', port: defaultPort };
  if (addr.startsWith('[')) {
    const m = addr.match(/^\[([^\]]+)\](?::(\d+))?$/);
    return { host: m ? m[1] : addr.replace(/^\[|\]$/g, ''), port: m && m[2] ? parseInt(m[2]) : defaultPort };
  }
  const idx = addr.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(addr.slice(idx + 1))) {
    return { host: addr.slice(0, idx), port: parseInt(addr.slice(idx + 1)) };
  }
  return { host: addr, port: defaultPort };
}
// 严格校验 IPv4 / IPv6 地址
function isValidIp(str) {
  str = String(str || '').trim();
  if (!str) return false;
  const m4 = str.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) return m4.slice(1).every(n => Number(n) <= 255);
  if (!/^[0-9a-fA-F:]+$/.test(str)) return false;
  if ((str.match(/::/g) || []).length > 1) return false;
  const hasDbl = str.includes('::');
  const groups = str.replace(/::/g, ':').split(':').filter(Boolean);
  if (!hasDbl && groups.length !== 8) return false;
  if (hasDbl && (groups.length < 1 || groups.length > 7)) return false;
  return groups.every(g => /^[0-9a-fA-F]{1,4}$/.test(g));
}
// 带超时的 fetch（手动 AbortController，兼容所有运行时）；超时 / 网络错误返回 null
function fetchTimeout(url, opts, ms) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}
// 限制缓存表大小：超出时淘汰最先插入的项（Map 按插入顺序遍历），避免长期运行的实例内存无限增长
function capMap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }

// 路径不对（根路径、未知路由）时返回与 Cloudflare 默认的 Hello World Worker 完全相同的响应：
//   return new Response('Hello World!');  → 200，纯文本，没有任何多余的头；
// 看起来像个刚创建的占位 Worker，既不暴露路径 / UUID，也不返回 404 引人注意
function stubPage() {
  return new Response('Hello World!');
}
// ---------------------------------------------------------------------------
// HMAC-SHA256 与常量时间比较（面板与代理共用：面板签名控制请求，代理验证并签名回应）
// ---------------------------------------------------------------------------
function b64uOfBytes(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const HMAC_KEYS = new Map();   // 原始密钥字符串 → CryptoKey（至多缓存 4 个）
async function hmacB64u(keyStr, msg) {
  let k = HMAC_KEYS.get(keyStr);
  if (!k) {
    k = await crypto.subtle.importKey('raw', TE.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (HMAC_KEYS.size >= 4) HMAC_KEYS.clear();
    HMAC_KEYS.set(keyStr, k);
  }
  return b64uOfBytes(new Uint8Array(await crypto.subtle.sign('HMAC', k, TE.encode(msg))));
}
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let r = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}
// 控制请求的路径标记：由密钥派生，不知道密钥就找不到控制入口
async function routeTag(keyStr) { return (await hmacB64u(keyStr, 'route')).slice(0, 16); }
// 短哈希（SHA-256 前 4 字节的十六进制）：面板据此判断代理上保存的状态是否与自己下发的一致，而不必回传内容本身
async function shortHash(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', TE.encode(String(text))));
  return Array.from(d.subarray(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// ---------------------------------------------------------------------------
// Cloudflare 地址段（面板与代理共用）：节点入口必须是 CF 边缘 IP；代理出站时目标为 CF IP 则不发直连
// ---------------------------------------------------------------------------
// Cloudflare 官方 IPv4 地址段（入口 IP 校验）
const CLOUDFLARE_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];

// Cloudflare 官方 IPv6 地址段（用于入口 IP 过滤）
const CLOUDFLARE_CIDRS_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
];

// IPv6 CIDR 前缀匹配（展开为 16 进制组后按位比较）
function ipInCidrV6(ip, cidr) {
  const [net, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const expand = (a) => {
    const dbl = a.indexOf('::');
    let groups;
    if (dbl >= 0) {
      const left = a.slice(0, dbl).split(':').filter(Boolean);
      const right = a.slice(dbl + 2).split(':').filter(Boolean);
      const fill = 8 - left.length - right.length;
      groups = [...left, ...Array(fill).fill('0'), ...right];
    } else groups = a.split(':');
    return groups.map(g => g.padStart(4, '0'));
  };
  const bitStr = (groups) => groups.map(g => parseInt(g, 16).toString(2).padStart(16, '0')).join('');
  return bitStr(expand(ip)).slice(0, bits) === bitStr(expand(net)).slice(0, bits);
}

// 判断 IP 是否属于 Cloudflare Anycast 段：节点入口必须是 CF 边缘 IP，
// 非 CF IP（如各地区云服务器/落地 IP）无法把客户端 TLS 转发到 Worker，下发必然连不通
function isCloudflareIP(ip) {
  ip = String(ip || '');
  if (!isValidIp(ip)) return false;
  if (ip.indexOf(':') >= 0) return CLOUDFLARE_CIDRS_V6.some(cidr => ipInCidrV6(ip, cidr));
  const p = ip.split('.').map(Number);
  const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  return CLOUDFLARE_RANGES.some(([start, end]) => n >= start && n <= end);
}

function cidrToRange(cidr) {
  const [ip, bits] = cidr.split('/');
  const b = ip.split('.').map(Number);
  const base = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const mask = bits >= 32 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const start = (base & mask) >>> 0;   // >>> 0 保证无符号：位运算结果可能为负（如 162.158.0.0），比较/加减前必须归一
  const end = (base | (~mask >>> 0)) >>> 0;
  return [start, end];
}
// CIDR 掩码表预编译：初始化时一次性把 CF 地址段编译为无符号整数区间数组，IP 校验变纯整数比较（性能提升数十倍，应对免费版 10ms CPU 硬限）
const CLOUDFLARE_RANGES = CLOUDFLARE_CIDRS.map(cidrToRange);
const TD = new TextDecoder();

// ---------------------------------------------------------------------------
// VLESS 请求头解析
// ---------------------------------------------------------------------------
function readAddress(data, view, offset, atyp) {
  // 数据不足一律抛「头部过短」：WS / XHTTP 据此继续等待后续分片，而不是因越界异常直接断开连接
  const need = (n) => { if (offset + n > data.byteLength) throw new Error('VSS 头部过短'); };
  if (atyp === 1) { // IPv4
    need(4);
    return { addr: `${view.getUint8(offset)}.${view.getUint8(offset + 1)}.${view.getUint8(offset + 2)}.${view.getUint8(offset + 3)}`, len: 4 };
  }
  if (atyp === 2) { // 域名
    need(1);
    const len = view.getUint8(offset);
    need(1 + len);
    const bytes = data.subarray(offset + 1, offset + 1 + len);
    const addr = TD.decode(bytes);
    // 域名里不能有空白与控制字符：否则经 HTTP 出站代理时会被拼进 CONNECT 请求（如 \r\n 注入额外的请求头）
    if (!addr || /[\x00-\x20\x7f]/.test(addr)) throw new Error('目标域名不正确');
    return { addr, len: 1 + len };
  }
  if (atyp === 3) { // IPv6
    need(16);
    const bytes = data.subarray(offset, offset + 16);
    return { addr: formatIPv6(bytes), len: 16 };
  }
  throw new Error('无法识别的地址类型');
}

// VLESS 请求头：Version(1) | UUID(16) | AddonsLen(1) | Addons | Cmd(1) | Port(2) | Atyp(1) | Addr | [TCP]1字节User | [UDP]数据包
// 必须校验 UUID，否则任意 UUID 都能使用代理。UUID 由面板下发并保存在代理的 KV 里：cfg.uuids 是当前接受的 UUID 列表
// （当前的一个；轮换后 10 分钟内还包含旧的一个）
const UUID_BYTES_CACHE = new Map();
function uuidToBytes(u) {
  const str = String(u || '');
  const hit = UUID_BYTES_CACHE.get(str);
  if (hit) return hit;
  const h = str.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error('服务端 UUID 配置无效');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  if (UUID_BYTES_CACHE.size >= 8) UUID_BYTES_CACHE.clear();
  UUID_BYTES_CACHE.set(str, b);
  return b;
}
// 16 字节（getByte(i) 取第 i 个）匹配 cfg.uuids 里的哪一项：返回匹配的 UUID 文本，都不匹配返回 ''；逐项逐字节比较，不因提前不符而短路
function uuidAccepted(getByte, cfg) {
  let ok = '';
  for (const u of (cfg && cfg.uuids) || []) {
    let want;
    try { want = uuidToBytes(u); } catch (e) { continue; }
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= (getByte(i) ^ want[i]);
    if (diff === 0) ok = u;
  }
  return ok;
}
function parseVssProtoHeader(data, cfg) {
  if (!data || data.byteLength < 1) throw new Error('VSS 头部过短');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  if (view.getUint8(0) !== 0) throw new Error('不支持的 VSS 版本');
  if (data.byteLength < 17) throw new Error('VSS 头部过短');
  const uuid = uuidAccepted((i) => view.getUint8(1 + i), cfg);
  if (!uuid) throw new Error('UUID 不匹配');
  offset += 1 + 16;                       // version + uuid
  if (offset >= data.byteLength) throw new Error('VSS 头部过短');
  const addonsLen = view.getUint8(offset); offset += 1;
  offset += addonsLen;
  if (offset + 4 > data.byteLength) throw new Error('VSS 头部过短');   // 命令(1) + 端口(2) + 地址类型(1)
  const command = view.getUint8(offset); offset += 1;
  const port = view.getUint16(offset); offset += 2;
  const atyp = view.getUint8(offset); offset += 1;
  const { addr, len } = readAddress(data, view, offset, atyp);
  offset += len;
  return {
    command, port, addr, uuid,
    headerLength: offset,
    earlyData: data.subarray(offset)
  };
}

// DoH 端点池（UDP/DNS → DoH 转换用，使 V2rayNG 关闭「本地 DNS」时远端 DNS 仍可用）
// Cloudflare 优先（Worker 与其同机房，延迟最低），Google 兜底（JSON 接口是 /resolve；/dns-query 只收 RFC 8484 格式，用 name= 查询会返回 400）。
// 不用境内解析器：这里解析的是用户自己访问的域名，境内解析器既会看到这些查询，回的也是面向境内优化（甚至被污染）的结果
const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve'
];
// IPv6 字符串 → 16 字节（支持 :: 压缩）
function ipv6ToBytes(ip) {
  const sp = String(ip).split('::');
  const h = sp[0] ? sp[0].split(':').filter(Boolean) : [];
  const t = sp[1] ? sp[1].split(':').filter(Boolean) : [];
  const parts = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  const out = new Uint8Array(16);
  parts.forEach((p, i) => { const n = parseInt(p, 16) || 0; out[i * 2] = (n >> 8) & 255; out[i * 2 + 1] = n & 255; });
  return out;
}
// 解析标准 DNS 查询（12B 头 + QNAME + QTYPE + QCLASS），经 DoH 查询后构造标准 DNS 响应（仅 A/AAAA 单查询）
async function dnsToDoH(query) {
  if (!query || query.byteLength < 17) return null;
  const view = new DataView(query.buffer, query.byteOffset, query.byteLength);
  const id = view.getUint16(0);
  if (view.getUint16(2) & 0x8000) return null;           // 非查询报文直接忽略
  if (view.getUint16(4) !== 1) return null;               // 仅支持单问题查询
  let off = 12, labels = [];
  while (off < query.byteLength) {
    const len = view.getUint8(off);
    if (len === 0) { off++; break; }
    if ((len & 0xC0) === 0xC0) { off += 2; break; }       // 压缩指针（罕见，直接略过）
    if (off + 1 + len > query.byteLength) return null;
    labels.push(TD.decode(query.subarray(off + 1, off + 1 + len)));
    off += 1 + len;
  }
  if (off + 4 > query.byteLength || labels.length === 0) return null;
  const qtype = view.getUint16(off);                      // 1=A 28=AAAA
  const qclass = view.getUint16(off + 2);
  const qEnd = off + 4;
  if (qtype !== 1 && qtype !== 28) return null;           // 仅 A/AAAA
  const name = labels.join('.');
  const question = query.subarray(12, qEnd);              // 响应中原样回显
  const answer = await dohFirst(DOH_ENDPOINTS, (ep) => ep + '?name=' + encodeURIComponent(name) + '&type=' + qtype, (j) => {
    if (!j || j.Status !== 0) return null;
    const an = (j.Answer || []).filter(a => a.type === qtype && (a.type === 1 ? isValidIp(String(a.data)) : /^[0-9a-fA-F:]+$/.test(String(a.data))));
    return an.length ? an : null;
  }, { timeoutMs: 5000 });
  if (!answer) return null;
  const header = new Uint8Array(12);
  const dv = new DataView(header.buffer);
  dv.setUint16(0, id); dv.setUint16(2, 0x8180); dv.setUint16(4, 1); dv.setUint16(6, answer.length);
  const chunks = [header, question];
  for (const a of answer) {
    const data = String(a.data);
    const rdata = a.type === 1 ? Uint8Array.from(data.split('.').map(Number)) : ipv6ToBytes(data);
    if (rdata.length !== (a.type === 1 ? 4 : 16)) continue;
    const h = new Uint8Array(10);
    const dh = new DataView(h.buffer);
    dh.setUint16(0, 0xC00C); dh.setUint16(2, a.type); dh.setUint16(4, qclass === 0 ? 1 : qclass);
    dh.setUint32(6, Number(a.TTL) || 300);
    chunks.push(h, new Uint8Array([(rdata.length >> 8) & 255, rdata.length & 255]), rdata);
  }
  let total = 0; chunks.forEach(c => total += c.byteLength);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

function formatIPv6(bytes) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // 简单压缩：连续 0 组用 ::，仅压缩最长段
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (parts[i] === '0') {
      if (curStart < 0) { curStart = i; curLen = 1; } else curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else { curStart = -1; curLen = 0; }
  }
  if (bestLen >= 2) {
    const head = parts.slice(0, bestStart).join(':');
    const tail = parts.slice(bestStart + bestLen).join(':');
    return (head ? head + '::' : '::') + tail;
  }
  return parts.join(':');
}
// ---------------------------------------------------------------------------
// DoH 查询（面板与代理共用）
// ---------------------------------------------------------------------------
// 依次尝试 DoH 端点：前一个失败（网络错误 / 非 200 / SERVFAIL 等）立即换下一个；
// 前一个超过 hedgeMs 仍未返回时提前并发发起下一个，先到先得。正常情况下每次查询只消耗 1 个子请求。
// validate(json) 返回非 null 即视为成功结果（含「确认无记录」的空数组），返回 null 则换端点。全部失败返回 null
function dohFirst(endpoints, buildUrl, validate, opts) {
  const hedgeMs = (opts && opts.hedgeMs) || 700, timeoutMs = (opts && opts.timeoutMs) || 4000;
  return new Promise((resolve) => {
    let next = 0, pending = 0, done = false, timer = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const launch = () => {
      if (done) return;
      clearTimeout(timer);
      if (next >= endpoints.length) { if (!pending) finish(null); return; }
      const ep = endpoints[next++];
      pending++;
      if (next < endpoints.length) timer = setTimeout(launch, hedgeMs);
      (async () => {
        let out = null;
        try {
          const res = await fetchTimeout(buildUrl(ep), { headers: { accept: 'application/dns-json' } }, timeoutMs);
          if (res && res.ok) out = validate(await res.json());
        } catch (e) { /* 视为失败，换下一个端点 */ }
        pending--;
        if (out != null) finish(out);
        else if (!done && pending === 0) launch();
      })();
    };
    launch();
  });
}
// ---------------------------------------------------------------------------
// 出站连接：直连 / SOCKS5 / HTTP CONNECT
// ---------------------------------------------------------------------------
// 通用超时助手：promise 超时即 reject（出站层兜底，避免目标 SYN 被静默丢弃时永久阻塞）
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg || '操作超时')), ms || 6000))
  ]);
}

// connect + opened 超时：CF 回环保护会静默丢弃对 CF 托管站点的 SYN（连接永远挂起），
// 带超时快速失败，由 openUpstream 按序走下一出站方式（反代兜底），解决「延迟有、流量 0」
async function connectWithTimeout(hostname, port, ms, opts) {
  const socket = opts ? connect({ hostname, port }, opts) : connect({ hostname, port });
  try {
    await withTimeout(socket.opened, ms || 6000, '连接超时（SYN 被静默丢弃）');
  } catch (e) {
    try { socket.close(); } catch (e2) { /* 忽略 */ }
    throw e;
  }
  return socket;
}

async function connectDirect(target, timeoutMs) {
  return connectWithTimeout(target.hostname, target.port, timeoutMs || 6000);
}

// 出站代理的握手（SOCKS5 协商 / HTTP CONNECT）：连上之后对方可能一直不回应（只接受 TCP、不说话），
// 没有期限就会让这条连接永远挂着、也不会回落到直连。HOP_HANDSHAKE_MS 内没完成算失败；失败（含超时）时关闭这个 socket，
// 否则它会一直占着 Workers 的同时连接名额，直到整个请求结束
const HOP_HANDSHAKE_MS = 6000;
async function hopHandshake(socket, fn) {
  let timer = null;
  try {
    return await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('出站代理握手超时')), HOP_HANDSHAKE_MS); })]);
  } catch (e) {
    try { socket.close(); } catch (e2) { /* 忽略 */ }
    throw e;
  } finally { clearTimeout(timer); }
}

// 通过 SOCKS5 代理建立到目标的连接
async function connectViaS5(hop, target) {
  // 6s 超时快速失败：代理不可达时不能永久挂起
  const socket = await connectWithTimeout(hop.host, hop.port, 6000);
  return hopHandshake(socket, () => s5Handshake(socket, hop, target));
}
async function s5Handshake(socket, hop, target) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  // 带缓存的读取器：多余字节保留，避免丢失后续 VLESS 数据流
  let pending = new Uint8Array(0);
  const readN = async (n) => {
    while (pending.length < n) {
      const { done, value } = await reader.read();
      if (done) throw new Error('连接被关闭');
      pending = concatBytes(pending, value);
    }
    const out = pending.slice(0, n);
    pending = pending.subarray(n);
    return out;
  };
  // 握手：声明支持的方法（有凭据则同时声明无认证+用户名密码，服务器选择其一）
  const methods = hop.user ? [5, 2, 0, 2] : [5, 1, 0];
  await writer.write(new Uint8Array(methods));
  const h1 = await readN(2);
  if (h1[0] !== 5 || h1[1] === 0xff) throw new Error('S5 握手失败');
  if (h1[1] === 2) { // 服务器选择用户名密码认证（RFC 1929）
    if (!hop.user) throw new Error('S5 服务器要求认证但未提供凭据');
    const u = TE.encode(hop.user), p = TE.encode(hop.pass);
    const auth = new Uint8Array([1, u.length, ...u, p.length, ...p]);
    await writer.write(auth);
    const h2 = await readN(2);
    if (h2[1] !== 0) throw new Error('S5 认证失败');
  } else if (h1[1] !== 0) {
    throw new Error('S5 不支持的认证方法 ' + h1[1]);
  }
  // CONNECT 请求
  const addrBytes = TE.encode(target.hostname);
  let connReq;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(target.hostname)) {
    connReq = new Uint8Array([5, 1, 0, 1, ...target.hostname.split('.').map(Number), (target.port >> 8) & 255, target.port & 255]);
  } else if (target.hostname.indexOf(':') >= 0 && isValidIp(target.hostname)) {
    // IPv6 字面量用 ATYP=4（16 字节），不能当域名发送
    connReq = new Uint8Array([5, 1, 0, 4, ...ipv6ToBytes(target.hostname), (target.port >> 8) & 255, target.port & 255]);
  } else {
    // 域名模式
    connReq = new Uint8Array([5, 1, 0, 3, addrBytes.length, ...addrBytes, (target.port >> 8) & 255, target.port & 255]);
  }
  await writer.write(connReq);
  const rep = await readN(4);
  if (rep[1] !== 0) throw new Error('S5 连接失败 码' + rep[1]);
  // 跳过 BND.ADDR + BND.PORT（必须完整消费否则残留字节污染后续 VLESS 数据流）
  if (rep[3] === 1) await readN(6);
  else if (rep[3] === 3) { const l = (await readN(1))[0]; await readN(l + 2); }
  else if (rep[3] === 4) await readN(18);
  // 握手期间多读的字节（目标端早期数据）不能丢弃：挂到 socket._preamble，
  // 由 WebSocket / xhttp 转发前先补发给客户端，避免 Telegram 等 TLS 握手中途被截断
  if (pending.byteLength > 0) socket._preamble = pending;
  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

// 通过 HTTP/HTTPS CONNECT 代理建立连接
async function connectViaHtHop(hop, target) {
  // 6s 超时快速失败：代理不可达时不能永久挂起；https 类型的出站代理要先与它建立 TLS（secureTransport），再在 TLS 里发 CONNECT
  const socket = await connectWithTimeout(hop.host, hop.port, 6000, hop.type === 'https' ? { secureTransport: 'on', allowHalfOpen: false } : undefined);
  return hopHandshake(socket, () => htHandshake(socket, hop, target));
}
async function htHandshake(socket, hop, target) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let authHeader = '';
  if (hop.user) authHeader = 'Proxy-Authorization: Basic ' + b64FromBytes(TE.encode(`${hop.user}:${hop.pass}`)) + '\r\n';
  const authority = (target.hostname.indexOf(':') >= 0 ? '[' + target.hostname + ']' : target.hostname) + ':' + target.port;   // IPv6 须加方括号
  const connectReq = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authHeader}\r\n`;
  await writer.write(TE.encode(connectReq));
  // 读取响应头直到空行；空行后同包多读的字节（目标端早期数据）一并保留
  const { head, leftover } = await readUntilHeaderEnd(reader);
  if (!/^HTTP\/\d\.\d\s+2\d\d/i.test(head)) throw new Error('HTTP 代理 CONNECT 失败: ' + head.split('\r\n')[0]);
  // 残留字节挂 socket._preamble（用法同 SOCKS5）
  if (leftover && leftover.byteLength > 0) socket._preamble = leftover;
  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

// 读取 HTTP 响应头（到空行为止）
async function readUntilHeaderEnd(reader) {
  let buf = new Uint8Array(0);
  while (buf.length < 65536) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = concatBytes(buf, value);
    const idx = findBytes(buf, [13, 10, 13, 10]);
    // 返回头部文本 + 空行之后同一包内多读的残留字节
    if (idx >= 0) return { head: TD.decode(buf.subarray(0, idx)), leftover: buf.subarray(idx + 4) };
  }
  return { head: TD.decode(buf), leftover: new Uint8Array(0) };
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
function findBytes(hay, needle) {
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// Base64 编码（出站 HTTP 代理认证用）
function b64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
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
// ---------------------------------------------------------------------------
// WebSocket 代理（VLESS）
// ---------------------------------------------------------------------------
// WS 0-RTT 早数据（节点 path 的 ?ed=2048 / sing-box max_early_data）：客户端把首个数据包 base64url 编码后
// 放进握手请求的 Sec-WebSocket-Protocol 头，服务端在握手阶段即可解析并抢先建立出站，省去约 1 个 RTT。
// 只接受能通过协议校验的数据（版本 0 + 本机 UUID），其它取值
// （如客户端声明的普通子协议名）一律返回 null，走原有流程，无副作用
function decodeEarlyData(header, cfg) {
  const raw = String(header || '').trim();
  if (!raw || raw.length > 8192 || !/^[A-Za-z0-9\-_+/=]+$/.test(raw)) return null;
  let bytes;
  try {
    const norm = raw.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(norm + '='.repeat((4 - norm.length % 4) % 4));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (e) { return null; }
  if (!bytes.byteLength || bytes.byteLength > 6144) return null;
  if (bytes.byteLength < 17 || bytes[0] !== 0) return null;
  if (!uuidAccepted((i) => bytes[i + 1], cfg)) return null;
  return bytes;
}

// WebSocket 关闭原因上限 123 字节（UTF-8）：按字节截断且不拆开多字节字符，
// 否则含中文的长错误信息会让 close() 抛异常，连接因此不会被关闭
function closeReason(msg) {
  let out = '', bytes = 0;
  for (const ch of String(msg)) {
    const n = TE.encode(ch).length;
    if (bytes + n > 120) break;
    out += ch; bytes += n;
  }
  return out;
}

// 上行队列（WebSocket 路径）：客户端的数据帧先入队，由单个写入循环合并成不超过 UP_BATCH 的块再写给目标；
// 队列有上限（字节数与块数），客户端发得比目标收得快时超限就断开，而不是在内存里无限堆积
const UP_MAX_BYTES = 256 * 1024, UP_MAX_COUNT = 2048, UP_BATCH = 16 * 1024, UP_SMALL = 4 * 1024;
function uplinkQueue() {
  const q = [];
  let bytes = 0;
  return {
    get empty() { return !q.length; },
    get bytes() { return bytes; },
    push(chunk) {
      if (!chunk.byteLength) return true;
      if (bytes + chunk.byteLength > UP_MAX_BYTES || q.length >= UP_MAX_COUNT) return false;
      q.push(chunk); bytes += chunk.byteLength;
      return true;
    },
    take() {
      if (!q.length) return null;
      const head = q.shift();
      bytes -= head.byteLength;
      if (!q.length || head.byteLength >= UP_BATCH) return head;
      const parts = [head];
      let total = head.byteLength;
      while (q.length && total + q[0].byteLength <= UP_BATCH) { const c = q.shift(); bytes -= c.byteLength; total += c.byteLength; parts.push(c); }
      if (parts.length === 1) return head;
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of parts) { out.set(c, o); o += c.byteLength; }
      return out;
    },
    clear() { q.length = 0; bytes = 0; },
  };
}
// XHTTP 响应里的填充头：头名取 UUID 的第 2–7 位、值是带随机长度（100–1000）填充的 URL（参数名取 UUID 的第 26–31 位前加 _），
// 与面板下发给客户端的 xPadding 参数（nodes.js 的 xhttpPadding）一致
function xhtPaddingHeader(uuid, host) {
  const len = 100 + (crypto.getRandomValues(new Uint32Array(1))[0] % 901);
  const rnd = crypto.getRandomValues(new Uint8Array(len));
  let pad = '';
  for (let i = 0; i < len; i++) pad += B62[rnd[i] % 62];
  return [uuid.slice(1, 7), 'https://' + host + '/?_' + uuid.slice(25, 31) + '=' + pad];
}
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// UDP-DNS（command=0x02、端口 53）：VLESS 的 UDP 数据在流里逐个以「2 字节长度 + 数据报」分帧（Xray / sing-box 都是这样发和收的），
// 每个查询经 DoH 解析后，同样加上 2 字节长度回给客户端；同一连接上的多个查询（如 A 与 AAAA）都会应答。
// 每个查询至少占 1 个子请求（免费版每个请求只有 50 个），客户端会长时间复用同一条连接：应答满 DNS_PER_CONN 个后
// 调用 onDone 关闭连接，客户端下一次查询会新开一条（新的请求、新的子请求额度）。
// 返回 feed(bytes)：喂入客户端发来的数据（可以是半个数据报，凑齐后再处理）
const DNS_PER_CONN = 20;
function dnsFeeder(send, onDone) {
  let buf = new Uint8Array(0), count = 0, inflight = 0;
  const settle = () => { inflight--; if (count >= DNS_PER_CONN && !inflight) onDone(); };
  const reply = (resp) => {
    const out = new Uint8Array(2 + resp.byteLength);
    out[0] = resp.byteLength >> 8; out[1] = resp.byteLength & 255;
    out.set(resp, 2);
    send(out);
  };
  return (chunk) => {
    if (chunk && chunk.byteLength) buf = buf.byteLength ? concatBytes(buf, chunk) : chunk;
    while (buf.byteLength >= 2) {
      const len = (buf[0] << 8) | buf[1];
      if (buf.byteLength < 2 + len) break;   // 数据报还没收全
      const pkt = buf.slice(2, 2 + len);
      buf = buf.subarray(2 + len);
      if (len < 12 || count >= DNS_PER_CONN) continue;   // 到数之后的查询不再处理（连接即将关闭，客户端会在新连接上重试）
      count++; inflight++;
      dnsToDoH(pkt).then((r) => { if (r) reply(r); }, () => { /* 解析失败不应答，客户端按超时处理 */ }).finally(settle);
    }
  };
}

async function handleWsProto(request, cfg) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  try { server.accept({ allowHalfOpen: true }); } catch (e) { server.accept(); }
  // 关键：必须声明二进制类型，否则 CF 将二进制帧按 UTF-8 解码成 string，VLESS 头（含 16 字节原始 UUID）会被损坏导致隧道失败
  server.binaryType = 'arraybuffer';
  let socket = null, writer = null, headerSent = false, pending = null, protoWait = null, respSent = false, dnsFeed = null;
  let authed = false;   // 请求头已通过校验（UUID 正确）：此前出错时关闭帧不带原因，探测请求看不到任何内部信息
  const up = uplinkQueue();
  let draining = false, burst = null;
  let closed = false, pumped = false, wsClosed = false;   // closed：WS 已关闭（之后建好的出站连接要立即释放）；pumped：已开始把目标数据转给客户端（由它负责在结束时关闭 WS）

  const send = (data) => { try { server.send(data); } catch (e) { /* 忽略 */ } };
  // 只发一次关闭帧（重复 close 在运行时会抛异常，也会覆盖先发出的关闭码）
  const closeWs = (code, reason) => { if (wsClosed) return; wsClosed = true; try { server.close(code, reason); } catch (e) { /* 忽略 */ } };
  const fail = (err) => { closeWs(1011, authed ? closeReason(err && err.message || err) : ''); cleanup(); };
  // 上行写入循环：出站就绪（writer 已设置）后把队列里的数据合并写给目标；同一时刻只有一个循环在跑
  const drain = async () => {
    if (draining || !writer) return;
    draining = true;
    try {
      for (let c; writer && (c = up.take());) {
        await writer.write(c);
        if (burst && up.bytes < UP_BATCH) break;   // 合并窗口内：凑不满一块的留给定时器一起写（见下方 kick）
      }
    } catch (err) { fail(err); }
    finally { draining = false; }
  };
  // 上行合并：CPU 主要花在 socket 写入次数上（每次写入约 15µs，与块大小关系不大）。写入循环在每次写完后立刻取下一帧，
  // 与帧的到达步调一致，几乎合并不到（workerd 实测 1KB 帧时 32000 帧 = 32000 次写入）。
  // 改为：空闲时到达的帧立即写出（交互流量不加延迟），同时开一个 0ms 定时器；定时器到点前到达的帧留在队列里，到点后合并写出，
  // 期间仍有数据就继续下一轮，没有就结束（下一帧又是立即写出）。只对小帧（< UP_SMALL）这样做：8KB 以上的帧合并后 CPU 不再下降，定时器反而多花一点。
  // workerd 实测上传每 MB CPU：1KB 帧约 22ms → 13ms，4KB 以上与原来持平
  // 出站未就绪或上一次写入还没完成时不再续定时器（避免等待期间空转）：写入循环这时不会中途让出，会一直写到队列清空
  const onBurst = () => { burst = null; if (up.empty || closed || !writer || draining) return; burst = setTimeout(onBurst, 0); drain(); };
  // 窗口内攒满一块（UP_BATCH）就立即写出，不等定时器：否则高速上传时一个定时器周期内就可能攒到队列上限（UP_MAX_BYTES）而断开
  const kick = () => {
    if (burst) { if (up.bytes >= UP_BATCH) drain(); return; }
    if (writer) burst = setTimeout(onBurst, 0);
    drain();
  };

  // 首包处理：WS 数据帧与 0-RTT 早数据共用。headerSent 在任何 await 之前置位，
  // 解析期间到达的后续帧走下方「暂存 / 直写」分支，不会重复解析
  const handleFirstChunk = async (chunk, forced) => {
    // 累积缓冲：WS 消息可能分片到达，不足头部长度时等待后续数据
    if (chunk && chunk.byteLength) pending = pending ? concatBytes(pending, chunk) : chunk;
    if (!pending || headerSent) return;
    let parsed;
    try {
      parsed = parseVssProtoHeader(pending, cfg);
    } catch (err) {
      if (!/头部过短/.test(err.message || '')) throw err;
      // 握手头正常仅数十字节；持续收到不完整分片（异常 / 恶意）时限制缓冲，防内存膨胀。
      // 只限制「头部还不完整」的情况：头部完整时首个数据帧再大（头部 + 大块数据）也照常处理，与 XHTTP 一致
      if (pending.byteLength > 65536) throw new Error('握手头超过 64KB');
      return;   // 等下一个分片
    }
    authed = true;
    // 仅支持 TCP（0x01）与 UDP-DNS（0x02）；VLESS MUX 等其它命令
    // 此前会被当成 TCP 连接目标地址，现在明确拒绝，客户端据此回退
    if (parsed.command !== 1 && parsed.command !== 2) {
      throw new Error('不支持的命令 ' + parsed.command);
    }
    // UDP 只支持 DNS（端口 53）：CF Workers 没有 UDP socket，其余 UDP 直接关闭（客户端自动回退）
    if (parsed.command === 2 && parsed.port !== 53) { headerSent = true; closeWs(1000); cleanup(); return; }
    // 头部解析成功立即回 VLESS 响应头（version=0 + addonsLen=0），早于首包判定与出站建连：
    // 部分客户端（mihomo 等）收到这 2 字节才发送首个数据包，晚发会与服务端互相等待。UDP-DNS 同样先回这 2 字节，再回各个应答
    if (!respSent) { respSent = true; send(new Uint8Array([0, 0])); }
    // 首包判定出站方式（非 TLS 不走 SNI 型反代，见 payloadKindOf）；头部完整但暂无数据时短暂等待首包，
    // 超时（FIRST_WAIT_MS）仍无数据按 unknown 放行，不让连接悬挂
    const payload = pending.byteLength > parsed.headerLength ? pending.subarray(parsed.headerLength) : null;
    const payloadKind = payloadKindOf(payload);
    if (payloadKind === 'unknown' && !forced) {
      if (!protoWait) protoWait = setTimeout(() => { protoWait = null; handleFirstChunk(null, true).catch(fail); }, FIRST_WAIT_MS);
      return;
    }
    if (protoWait) { clearTimeout(protoWait); protoWait = null; }
    headerSent = true;
    // UDP-DNS：查询经 DoH(HTTPS) 解析后回标准 DNS 应答（使 V2rayNG 关闭「本地 DNS」时远端 DNS 仍可用）；
    // 之后到达的数据帧也交给 dnsFeed（见 dnsFeeder），连接保持到客户端关闭或应答满 DNS_PER_CONN 个
    if (parsed.command === 2) {
      dnsFeed = dnsFeeder(send, () => { closeWs(1000); cleanup(); });
      pending = null;
      dnsFeed(payload);
      return;
    }
    const conn = await openUpstream(parsed, cfg, request.cf && request.cf.colo, payloadKind);
    // 建连期间客户端已断开：立即释放刚建好的出站连接，否则它会一直挂到目标端关闭
    if (closed) { try { conn.close(); } catch (e) { /* 忽略 */ } return; }
    socket = conn;
    const firstPayload = pending && pending.byteLength > parsed.headerLength ? pending.subarray(parsed.headerLength) : null;
    pending = null;   // 头部之后到达的数据帧进上行队列（有上限），出站就绪后合并写出
    // 透明代理：去掉 VLESS 头部，发送原始 TLS 数据，由对端按 SNI 路由
    // 补发 SOCKS5/HTTP 代理握手残留字节（目标端早期数据），避免 TLS 握手中途被截断
    if (conn._preamble && conn._preamble.byteLength > 0) send(conn._preamble);
    let w = conn.writable.getWriter();
    if (firstPayload) await w.write(firstPayload);
    // 首包看门狗：直连接通但目标不回数据时换备用线路重试（期间 writer 保持为空，客户端的后续数据留在队列里）。
    // 这一步可能等几秒，所以放到后台继续：不占着数据帧的事件处理，出错同样走 fail
    const colo = request.cf && request.cf.colo;
    const resume = async () => {
      let first = null;
      if (firstPayload && payloadKind === 'tls') {
        const r = await firstByteOrRetry(conn, firstPayload, cfg, colo, () => !closed);
        if (r.conn !== conn) { try { w.releaseLock(); } catch (e) { /* 忽略 */ } w = r.conn ? r.conn.writable.getWriter() : null; }
        if (!r.conn) { socket = null; throw new Error('目标没有响应'); }
        socket = r.conn; first = r.first;
        if (closed) { try { r.conn.close(); } catch (e) { /* 忽略 */ } return; }
      }
      writer = w;
      if (first) send(first);
      pumped = true;
      pumpReadable(socket.readable, send, () => closeWs(1000));
      drain();
    };
    resume().catch(fail);
  };

  // WS 0-RTT：先处理握手头中预发的首包，再处理数据帧；校验不通过时 earlyBytes 为 null，走原流程
  const earlyBytes = decodeEarlyData(request.headers.get('sec-websocket-protocol'), cfg);
  if (earlyBytes) handleFirstChunk(earlyBytes).catch(fail);

  server.addEventListener('message', async (ev) => {
    try {
      const chunk = typeof ev.data === 'string' ? TE.encode(ev.data) : new Uint8Array(ev.data);
      if (!headerSent) await handleFirstChunk(chunk);
      else if (dnsFeed) dnsFeed(chunk);
      // 头部之后的数据帧一律先入上行队列：出站未就绪时暂存（避免早期数据帧被丢弃 → TLS 握手不完整 → 连接通但流量为 0），就绪后合并写出
      else { if (!up.push(chunk)) throw new Error('上行缓冲溢出'); if (chunk.byteLength < UP_SMALL) kick(); else drain(); }
    } catch (err) { fail(err); }
  });
  // accept({ allowHalfOpen: true }) 下收到客户端的关闭帧不会自动回应：这里必须自己收尾。
  // 已有数据转发时，目标连接被关闭后由 pumpReadable 结束并关闭 WS；还没开始转发（握手 / 等首包 / 建连中）时直接关闭，避免连接悬挂
  function cleanup() {
    closed = true;
    up.clear();
    if (protoWait) { clearTimeout(protoWait); protoWait = null; }
    if (burst) { clearTimeout(burst); burst = null; }
    if (socket) { try { socket.close(); } catch (e) { /* 忽略 */ } socket = null; }
    if (!pumped) closeWs(1000);
  }
  server.addEventListener('close', cleanup);
  server.addEventListener('error', cleanup);
  // 拒绝 WebSocket 压缩（permessage-deflate）：客户端请求时运行时会自动协商，对视频等已压缩数据毫无收益，
  // workerd 实测每 MB CPU 约 12ms → 49ms（免费版每个请求只有 10ms CPU）。响应里给出不含 permessage-deflate 的扩展值，
  // 运行时即不启用压缩并从响应中去掉该头
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Extensions': 'identity' } });
}

// xhttp 代理（stream-one 模式：请求体即 VLESS 流）
async function handleXhtProto(request, cfg) {
  if (!request.body) return stubPage();
  const bodyReader = request.body.getReader();
  // 首个数据块可能短于 VLESS 头部（分块到达）：累积到能完整解析为止（上限 64KB，与 WS 路径一致）
  let buf = new Uint8Array(0), parsed = null;
  while (!parsed) {
    const chunk = await bodyReader.read();
    if (chunk.done) return stubPage();
    buf = buf.byteLength ? concatBytes(buf, chunk.value) : chunk.value;
    try { parsed = parseVssProtoHeader(buf, cfg); }
    catch (err) {
      if (!/头部过短/.test(err.message || '')) throw err;
      if (buf.byteLength > 65536) throw new Error('握手头超过 64KB');
    }
  }
  if (parsed.command !== 1) throw new Error('XHT 仅支持 TCP 命令');
  const firstPayload = buf.subarray(parsed.headerLength);
  const conn = await openUpstream(parsed, cfg, request.cf && request.cf.colo, payloadKindOf(firstPayload));
  // 数据面全部交给运行时原生管道（pipeTo），不经过 JS 逐块搬运：
  // 免费版每个请求只有 10ms CPU，XHTTP 每条代理连接就是一个长请求；若每个数据块都在 JS 里 read → enqueue / write，
  // 看视频时几 MB 数据就超出 CPU 上限（日志 Worker exceeded CPU time limit），连接被限流变得极慢。
  // 原生流之间的 pipeTo 由运行时内部完成，几乎不计 JS CPU；背压与断开传播也由管道自动处理
  const writer = conn.writable.getWriter();
  if (firstPayload.byteLength) await writer.write(firstPayload);
  writer.releaseLock();
  bodyReader.releaseLock();
  // 首包看门狗（同 WebSocket 路径）：直连接通但目标不回数据时换备用线路重试。TLS 里客户端要等到服务端回应才会继续发数据，
  // 所以等首个数据期间先不接上行管道（请求体由运行时缓冲），拿到首包或重试完成后再接，数据面仍然是原生管道
  let up = conn, firstChunk = null;
  if (firstPayload.byteLength && payloadKindOf(firstPayload) === 'tls') {
    const r = await firstByteOrRetry(conn, firstPayload, cfg, request.cf && request.cf.colo, () => !request.signal.aborted);
    if (!r.conn) throw new Error('目标没有响应');
    up = r.conn; firstChunk = r.first;
  }
  // 上行：请求体 → 目标（请求体结束时关闭目标写端，即 TCP 半关闭）
  request.body.pipeTo(up.writable).catch(() => {});

  // 下行：先写 2 字节 VLESS 响应头（version=0 + addonsLen=0，否则 xhttp 客户端报 unexpected response version）
  // 与 SOCKS5/HTTP 代理握手残留字节（目标端早期数据），再把目标连接原生管道接到响应体
  const ts = typeof IdentityTransformStream === 'function' ? new IdentityTransformStream() : new TransformStream();
  (async () => {
    try {
      const w = ts.writable.getWriter();
      await w.write(new Uint8Array([0, 0]));
      if (up._preamble && up._preamble.byteLength > 0) await w.write(up._preamble);
      if (firstChunk) await w.write(firstChunk);
      w.releaseLock();
      await up.readable.pipeTo(ts.writable);   // 客户端断开 → 取消目标读取；目标结束 → 响应结束
    } catch (e) { /* 忽略 */ }
    try { up.close(); } catch (e) { /* 忽略 */ }
  })();
  // 响应头与常见的 XHTTP 服务端一致：content-type 为 application/grpc，并带一条随机长度的填充头
  const [padName, padValue] = xhtPaddingHeader(parsed.uuid, new URL(request.url).host);
  return new Response(ts.readable, { status: 200, headers: { 'content-type': 'application/grpc', 'x-accel-buffering': 'no', 'cache-control': 'no-store', [padName]: padValue } });
}

// ---------------------------------------------------------------------------
// 代理配置：环境变量只有两项，其余（UUID、启用开关、落地 / 出站 / 备用线路）全部由面板通过控制接口下发
//   PATH       【必填】节点路径（WebSocket / XHTTP 共用）
//   NODE_KEY   【必填】控制密钥（至少 24 位随机字符）：面板用它给控制请求签名，也决定控制入口的路径
// 面板下发的状态保存在 NODE_KV 里（见 proxy-settings.js）；还没下发 UUID（或代理被停用）时，节点路径上的请求和其它任何路径一样只返回伪装页。
// ---------------------------------------------------------------------------
const NODE_PATH_RE = /^[A-Za-z0-9._~-]+$/;
const NODE_KEY_MIN = 24;
const ALT_MAX = 3;   // 备用线路最多 3 条：与直连并发竞速，受 Workers 6 个同时出站连接的限制

function nodeConfig(env) {
  const str = (k) => (env && env[k] != null ? String(env[k]).trim() : '');
  const cfg = Object.assign({ path: '', key: '', _problems: [] }, emptyState());
  const path = str('PATH').replace(/^\/+/, '').replace(/\/+$/, '');
  if (path && NODE_PATH_RE.test(path) && path.length <= 128) cfg.path = path;
  else cfg._problems.push(path ? '环境变量 PATH 的值不正确：只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位。' : '请设置环境变量 PATH（节点的访问路径，如 mynode）。');
  const key = str('NODE_KEY');
  if (key.length >= NODE_KEY_MIN && key.length <= 256 && /^[\x21-\x7e]+$/.test(key)) cfg.key = key;
  else cfg._problems.push(key ? '环境变量 NODE_KEY 的值不正确：至少 ' + NODE_KEY_MIN + ' 位，只能是可见的 ASCII 字符（面板里可以点「生成密钥」）。' : '请设置环境变量 NODE_KEY（控制密钥，至少 ' + NODE_KEY_MIN + ' 位随机字符，与面板里填写的密钥一致）。');
  return cfg;
}
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
// 因此面板下发后，其它 isolate 最长约 1 分钟才用上新状态（换 UUID、停用都是这样）；控制接口的 status 不走内存缓存，如实回报 KV 里的内容。
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
// 出站代理的用户名 / 密码：要么都没有，要么都是字符串；SOCKS5 用 1 个字节表示长度，所以按 UTF-8 字节数限制在 255 以内
const okCred = (s) => typeof s === 'string' && TE.encode(s).length <= 255;
const okHopAuth = (h) => (h.user === undefined && h.pass === undefined) || (okCred(h.user) && okCred(h.pass));

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
  if (h !== null && !(isObj(h) && ['socks5', 'http', 'https'].includes(h.type) && okHost(h.host) && okPort(h.port) && okHopAuth(h))) return 'hop 不正确';
  if (!isObj(st.altTable) || Object.keys(st.altTable).length > 32) return 'altTable 不正确';
  for (const [tag, e] of Object.entries(st.altTable)) {
    if (!TAG_RE.test(tag) || !isObj(e) || !okHost(e.host) || (e.port !== undefined && !okPort(e.port)) || (e.txt !== undefined && typeof e.txt !== 'boolean')) return 'altTable 里的「' + tag.slice(0, 20) + '」不正确';
  }
  if (!Array.isArray(st.altPick) || st.altPick.length > 8 || !st.altPick.every(t => typeof t === 'string' && TAG_RE.test(t))) return 'altPick 不正确';
  return '';
}

// 读 KV 里保存的状态：返回 { raw, state, error }（error：'' / 'unavailable' / 'corrupt'）；带 isolate 内存缓存。
// fresh：跳过内存缓存直接读 KV（控制接口的 status 用）——面板下发后紧接着查状态，这次请求可能落在另一个 isolate 上，
// 它内存里还是旧状态；KV 在写入的同一机房里立即可见，直接读 KV 才能如实回报（读到的结果也顺便更新这个 isolate 的缓存）
const STATE_MEM = new WeakMap();
async function readNodeState(kv, fresh) {
  const now = Date.now(), hit = STATE_MEM.get(kv);
  if (!fresh && hit && now - hit.t < STATE_MEM_TTL) return hit;
  let entry;
  try {
    const raw = fresh ? await kv.get(STATE_KEY) : await kv.get(STATE_KEY, { cacheTtl: 30 });
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
  if (kv && !base._problems.length) entry = await readNodeState(kv, true);
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
// ---------------------------------------------------------------------------
// 控制接口：面板通过签名的 HTTPS 请求读写代理的状态（取代原来的服务绑定，面板与代理可以在不同账号里）
// ---------------------------------------------------------------------------
// 入口：POST /<PATH>/<标记>，标记由 NODE_KEY 派生（不知道密钥就找不到入口）。请求体是 JSON：
//   { ts, n, op, a, s }   ts 毫秒时间戳，n 一次性随机串，op 操作名，a 参数的 JSON 文本，s = HMAC-SHA256(NODE_KEY, ts.n.op.a)
// 任何一步不符（方法、体积、JSON、时间偏差、重放、签名）都返回与其它路径完全相同的伪装页，不泄露这里有入口。
// 操作只有两个：status（读状态摘要）与 setState（整份覆盖状态，a 就是状态的 JSON 原文）。
// 验证通过后返回 { ts, d, s }：d 是结果的 JSON 文本，s = HMAC-SHA256(NODE_KEY, ts.n.d)（绑定了请求的 n，面板据此确认回应来自持有密钥的一方）。
// 重放：时间偏差 CONTROL_SKEW_MS 内同一个 n 只接受一次（isolate 内存里记）；各操作都是幂等的，跨 isolate 的重放最多重复一次相同的写入。
const CONTROL_SKEW_MS = 30 * 1000;
const CONTROL_BODY_MAX = 16 * 1024;
const SEEN_NONCES = new Map();   // n → 过期时间

function seenNonce(n, now) {
  for (const [k, exp] of SEEN_NONCES) { if (exp > now) break; SEEN_NONCES.delete(k); }   // Map 按插入顺序，最先插入的最先过期
  if (SEEN_NONCES.has(n)) return true;
  SEEN_NONCES.set(n, now + 2 * CONTROL_SKEW_MS);
  while (SEEN_NONCES.size > 1000) SEEN_NONCES.delete(SEEN_NONCES.keys().next().value);
  return false;
}
async function runControlOp(env, op, raw) {
  switch (op) {
    case 'status': return nodeStatus(env);
    case 'setState': return setNodeState(env, raw);
  }
  return { ok: false, error: '未知操作' };
}
async function handleControl(request, env, base) {
  try {
    if (request.method !== 'POST') return stubPage();
    const raw = await request.text();
    if (raw.length > CONTROL_BODY_MAX) return stubPage();
    const m = JSON.parse(raw);
    if (!m || typeof m.ts !== 'number' || typeof m.n !== 'string' || typeof m.op !== 'string' || typeof m.a !== 'string' || typeof m.s !== 'string') return stubPage();
    if (m.n.length < 8 || m.n.length > 64 || m.op.length > 32) return stubPage();
    const now = Date.now();
    if (Math.abs(now - m.ts) > CONTROL_SKEW_MS) return stubPage();
    if (!timingSafeEqual(await hmacB64u(base.key, m.ts + '.' + m.n + '.' + m.op + '.' + m.a), m.s)) return stubPage();
    if (seenNonce(m.n, now)) return stubPage();
    const result = await runControlOp(env, m.op, m.a);
    const d = JSON.stringify(result), ts = Date.now();
    return new Response(JSON.stringify({ ts, d, s: await hmacB64u(base.key, ts + '.' + m.n + '.' + d) }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (e) { return stubPage(); }
}
// ---------------------------------------------------------------------------
// 路由：节点路径上（已被面板配置好且启用时）的 WebSocket 升级与 XHTTP POST 进入代理；
// 控制入口（路径含由密钥派生的标记）交给 handleControl；其余一律返回伪装页
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    // HTTP → HTTPS（WebSocket 升级除外：明文端口节点 80/8080 等以 http 到达，重定向会让其永远无法连接）
    if (url.protocol === 'http:' && upgrade !== 'websocket') {
      return Response.redirect(url.href.replace('http://', 'https://'), 301);
    }
    const cfg = nodeConfig(env);
    // 必填的环境变量（PATH、NODE_KEY）缺失或非法：统一返回设置说明
    if (cfg._problems.length) {
      return new Response(cfg._problems.join('\n'), { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path === cfg.path) {
      // 只有节点路径上的连接才会读 NODE_KV 里的状态（伪装页请求不触发任何 KV 读取）
      const live = await loadNodeConfig(env, cfg);
      // 还没下发 UUID 或已被停用：和其它路径一样是伪装页
      if (!live.enabled || !live.uuids.length) return stubPage();
      if (upgrade === 'websocket') return handleWsProto(request, live);
      // XHTTP 出错（含 UUID 不符、请求体为空等）一律返回伪装页：错误信息不外露，探测请求看不出这条路径与其它路径有何不同
      if (request.method === 'POST') {
        try { return await handleXhtProto(request, live); }
        catch (e) { return stubPage(); }
      }
    } else if (path.startsWith(cfg.path + '/') && path.slice(cfg.path.length + 1) === await routeTag(cfg.key)) {
      return handleControl(request, env, cfg);
    }
    return stubPage();
  }
};
