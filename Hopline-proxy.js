/*!Hopline-proxy v3.0.2*/
// ============================================================================
//  Hopline 代理 —— 只做一件事：在节点路径上接收 VLESS（WebSocket / XHTTP）并转发
//  ----------------------------------------------------------------------------
//  没有面板、登录、KV 与订阅生成；节点链接由 Hopline 面板脚本（Hopline-panel.js）生成，
//  面板只需要本脚本的 域名、UUID 与路径，两者之间没有任何运行时联系。
//  所有设置都来自环境变量：
//    UUID             【必填】VLESS 用户 ID
//    PATH             【必填】节点路径（WebSocket / XHTTP 共用），如 mynode
//    PROXYIP          自定义反代/落地 IP（填写后作为固定出口优先使用；留空则直连失败时由地区反代兜底），格式 host 或 host:port
//    OUTBOUND_PROXY   出站代理（socks5:// / http:// / ss:// 或 host:port）
//    OUTBOUND_MODE    出站方式：留空 = 出站代理优先，失败后直连 ∥ 反代；no = 直连 ∥ 反代优先；only = 仅走出站代理
//    RELAY_MODE       地区反代：builtin（默认，按 Worker 机房自动选地区）/ custom / off
//    RELAY_REGION     builtin 的首选地区（HK US SG JP KR DE SE NL FI GB Oracle DigitalOcean Vultr Multacom；留空按机房自动选）
//    RELAY_REGION2    builtin 的次选地区（同上；留空自动，none = 不使用）
//    RELAY_CUSTOM     custom 的反代列表（最多 3 个 host[:port]，换行或逗号分隔）
//  VLESS 的 WebSocket 与 XHTTP 两种传输始终同时启用。
//  可选的服务绑定入口（RPC，不是 HTTP 路由，公网访问不到；见 proxy-router.js）：
//    ProxyStatus   只读 status()：在线与否、版本、配置问题、非敏感的设置摘要
//    ProxyControl  另加 getSettings() / setSettings() / resetSettings()：面板在线修改上面 7 项出站 / 地区反代设置
//  在线修改需要给代理单独绑定一个 KV 命名空间（绑定变量名 PROXY_KV）；不绑定则一切只按环境变量。UUID 与 PATH 永远只来自环境变量。
// ============================================================================
import { connect } from 'cloudflare:sockets';
import { WorkerEntrypoint } from 'cloudflare:workers';

// 版本号：两个脚本共用（面板用于检测更新与显示；代理只通过服务绑定的 status() 报告）
const VERSION = '3.0.2';
// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const TE = new TextEncoder();

// MD5（纯 JS 实现，RFC 1321；WebCrypto 不支持 MD5）
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
];
function rotl32(x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; }
// 输入字节数组，返回 16 字节摘要（Shadowsocks 的 EVP_BytesToKey 需要对字节拼接后再哈希）
function md5Bytes(bytes) {
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const data = new Uint8Array(paddedLen);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const dv = new DataView(data.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < paddedLen; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(i + j * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const sum = (a + f + MD5_K[j] + M[g]) >>> 0;
      const nb = (b + rotl32(sum, MD5_S[j])) >>> 0;
      a = d; d = c; c = b; b = nb;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}
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

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}) });
}

// 路径不对（根路径、未知路由）时返回一个普通的 Hello World 页面作为伪装：
// 看起来像个占位站点，既不暴露路径 / UUID，也不返回 404 引人注意
function helloPage() {
  return new Response('<!doctype html><html><head><meta charset="utf-8"><title>Hello World</title></head><body><h1>Hello World !</h1></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
  const need = (n) => { if (offset + n > data.byteLength) throw new Error('VLESS 头部过短'); };
  if (atyp === 1) { // IPv4
    need(4);
    return { addr: `${view.getUint8(offset)}.${view.getUint8(offset + 1)}.${view.getUint8(offset + 2)}.${view.getUint8(offset + 3)}`, len: 4 };
  }
  if (atyp === 2) { // 域名
    need(1);
    const len = view.getUint8(offset);
    need(1 + len);
    const bytes = data.subarray(offset + 1, offset + 1 + len);
    return { addr: TD.decode(bytes), len: 1 + len };
  }
  if (atyp === 3) { // IPv6
    need(16);
    const bytes = data.subarray(offset, offset + 16);
    return { addr: formatIPv6(bytes), len: 16 };
  }
  throw new Error('无法识别的地址类型');
}

// VLESS 请求头：Version(1) | UUID(16) | AddonsLen(1) | Addons | Cmd(1) | Port(2) | Atyp(1) | Addr | [TCP]1字节User | [UDP]数据包
// 必须校验 UUID，否则任意 UUID 都能使用代理
let UUID_BYTES_CACHE = { s: null, b: null };
function uuidToBytes(u) {
  const str = String(u || '');
  if (UUID_BYTES_CACHE.s === str) return UUID_BYTES_CACHE.b;
  const h = str.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error('服务端 UUID 配置无效');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  UUID_BYTES_CACHE = { s: str, b };
  return b;
}
function parseVssProtoHeader(data, cfg) {
  if (!data || data.byteLength < 1) throw new Error('VLESS 头部过短');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  if (view.getUint8(0) !== 0) throw new Error('不支持的 VLESS 版本');
  if (data.byteLength < 17) throw new Error('VLESS 头部过短');
  const want = uuidToBytes(cfg && cfg.uuid);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= (view.getUint8(1 + i) ^ want[i]);
  if (diff !== 0) throw new Error('UUID 不匹配');
  offset += 1 + 16;                       // version + uuid
  if (offset >= data.byteLength) throw new Error('VLESS 头部过短');
  const addonsLen = view.getUint8(offset); offset += 1;
  offset += addonsLen;
  if (offset + 4 > data.byteLength) throw new Error('VLESS 头部过短');   // 命令(1) + 端口(2) + 地址类型(1)
  const command = view.getUint8(offset); offset += 1;
  const port = view.getUint16(offset); offset += 2;
  const atyp = view.getUint8(offset); offset += 1;
  const { addr, len } = readAddress(data, view, offset, atyp);
  offset += len;
  return {
    command, port, addr,
    headerLength: offset,
    earlyData: data.subarray(offset)
  };
}

// DoH 端点池（UDP/DNS → DoH 转换用，使 V2rayNG 关闭「本地 DNS」时远端 DNS 仍可用）
// Cloudflare 优先（Worker 与其同机房，延迟最低，且用户的查询不必先经过第三方境内解析器），其余按序兜底
const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
  'https://dns.alidns.com/resolve',
  'https://doh.pub/dns-query'
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
// 出站连接：直连 / SOCKS5 / HTTP CONNECT / 反代 IP 中继
// ---------------------------------------------------------------------------
// 通用超时助手：promise 超时即 reject（出站层兜底，避免目标 SYN 被静默丢弃时永久阻塞）
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg || '操作超时')), ms || 6000))
  ]);
}

// connect + opened 超时：CF 回环保护会静默丢弃对 CF 托管站点的 SYN（连接永远挂起），
// 带超时快速失败，由 openOutbound 按序走下一出站方式（反代兜底），解决「延迟有、流量 0」
async function connectWithTimeout(hostname, port, ms) {
  const socket = connect({ hostname, port });
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

// 通过 SOCKS5 代理建立到目标的连接
async function connectViaSocks5(proxy, target) {
  // 6s 超时快速失败：代理不可达时不能永久挂起
  const socket = await connectWithTimeout(proxy.host, proxy.port, 6000);
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
  const methods = proxy.user ? [5, 2, 0, 2] : [5, 1, 0];
  await writer.write(new Uint8Array(methods));
  const h1 = await readN(2);
  if (h1[0] !== 5 || h1[1] === 0xff) throw new Error('SOCKS5 握手失败');
  if (h1[1] === 2) { // 服务器选择用户名密码认证（RFC 1929）
    if (!proxy.user) throw new Error('SOCKS5 服务器要求认证但未提供凭据');
    const u = TE.encode(proxy.user), p = TE.encode(proxy.pass);
    const auth = new Uint8Array([1, u.length, ...u, p.length, ...p]);
    await writer.write(auth);
    const h2 = await readN(2);
    if (h2[1] !== 0) throw new Error('SOCKS5 认证失败');
  } else if (h1[1] !== 0) {
    throw new Error('SOCKS5 不支持的认证方法 ' + h1[1]);
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
  if (rep[1] !== 0) throw new Error('SOCKS5 连接失败 码' + rep[1]);
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
async function connectViaHttpProxy(proxy, target) {
  // 6s 超时快速失败：代理不可达时不能永久挂起
  const socket = await connectWithTimeout(proxy.host, proxy.port, 6000);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let authHeader = '';
  if (proxy.user) authHeader = 'Proxy-Authorization: Basic ' + b64FromBytes(TE.encode(`${proxy.user}:${proxy.pass}`)) + '\r\n';
  const authority = (target.hostname.indexOf(':') >= 0 ? '[' + target.hostname + ']' : target.hostname) + ':' + target.port;   // IPv6 须加方括号
  const connectReq = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authHeader}\r\n`;
  await writer.write(TE.encode(connectReq));
  // 读取响应头直到空行；空行后同包多读的字节（目标端早期数据）一并保留
  const { head, leftover } = await readUntilCRLFCRLF(reader);
  if (!/^HTTP\/\d\.\d\s+2\d\d/i.test(head)) throw new Error('HTTP 代理 CONNECT 失败: ' + head.split('\r\n')[0]);
  // 残留字节挂 socket._preamble（用法同 SOCKS5）
  if (leftover && leftover.byteLength > 0) socket._preamble = leftover;
  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

// ---------------------------------------------------------------------------
// Shadowsocks AEAD 出站代理客户端（ss://）：aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305
// 协议：客户端发随机 salt + AEAD 流（数据流以目标地址头 ATYP+地址+端口 开头）；
//       服务端回随机 salt + 同构 AEAD 流。密钥派生：masterKey=EVP_BytesToKey(MD5, password)，
//       sessionKey=HKDF-SHA1(masterKey, salt, "ss-subkey")，每 chunk 两个 AEAD 块
//       （2B 大端长度 + 负载），nonce 为 12B 小端计数器逐块 +1；单块明文 ≤ 0x3FFF；salt 长度 = 密钥长度。
// ---------------------------------------------------------------------------
function ssCipherAlgo(method) {
  const m = String(method || '').toLowerCase().replace(/_/g, '-');
  if (m === 'aes-128-gcm' || m === 'aes-128gcm') return { name: 'AES-GCM', keyLen: 16 };
  if (m === 'aes-256-gcm' || m === 'aes-256gcm') return { name: 'AES-GCM', keyLen: 32 };
  if (m === 'chacha20-ietf-poly1305' || m === 'chacha20-poly1305' || m === 'chacha20poly1305') return { name: 'CHACHA20-POLY1305', keyLen: 32 };
  return null;
}
// ---------- SS 加密原语（纯 JS，兼容 CF Workers / Node / 浏览器） ----------
// CF Workers 的 crypto.subtle 官方支持矩阵不含 CHACHA20-POLY1305（SS 最常用的 chacha20-ietf-poly1305
// 用 WebCrypto 会抛 NotSupportedError → 出站全超时），故 chacha20-poly1305（RFC 8439）与
// HKDF-SHA1 用纯 JS 实现，不依赖 WebCrypto；AES-GCM 保留 WebCrypto（CF 明确支持、性能好）。
// （rotl32 复用 utils.js 中 MD5 实现的同名函数）

// SHA-1（FIPS 180-4）
function sha1Bytes(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const ml = bytes.length, lenBits = ml * 8;
  const padded = new Uint8Array((((ml + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(lenBits / 0x100000000), false);
  dv.setUint32(padded.length - 4, lenBits >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rotl32(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl32(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20), ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false); ov.setUint32(4, h1, false); ov.setUint32(8, h2, false);
  ov.setUint32(12, h3, false); ov.setUint32(16, h4, false);
  return out;
}
// HMAC-SHA1（RFC 2104）
function hmacSha1(key, data) {
  const block = 64;
  let k = key;
  if (k.length > block) k = sha1Bytes(k);
  const ipad = new Uint8Array(block), opad = new Uint8Array(block);
  for (let i = 0; i < block; i++) { ipad[i] = (i < k.length ? k[i] : 0) ^ 0x36; opad[i] = (i < k.length ? k[i] : 0) ^ 0x5c; }
  return sha1Bytes(concatBytes(opad, sha1Bytes(concatBytes(ipad, data))));
}
// HKDF-SHA1（RFC 5869，info="ss-subkey"）：SS AEAD 会话密钥派生
function hkdfSha1(ikm, salt, keyLen) {
  const prk = hmacSha1(salt && salt.length ? salt : new Uint8Array(20), ikm);
  let t = new Uint8Array(0), okm = new Uint8Array(0);
  for (let i = 1; okm.length < keyLen; i++) {
    const ti = new Uint8Array([i]);
    t = hmacSha1(prk, concatBytes(concatBytes(t, TE.encode('ss-subkey')), ti));
    okm = concatBytes(okm, t);
  }
  return okm.slice(0, keyLen);
}

// ---------- ChaCha20-Poly1305 AEAD（RFC 8439，纯 JS） ----------
function chacha20Block(key32, counter, nonce12) {
  const st = new Uint32Array(16);
  st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
  const dv = new DataView(key32.buffer, key32.byteOffset, 32);
  for (let i = 0; i < 8; i++) st[4 + i] = dv.getUint32(i * 4, true);
  st[12] = counter >>> 0;
  const nv = new DataView(nonce12.buffer, nonce12.byteOffset, 12);
  st[13] = nv.getUint32(0, true); st[14] = nv.getUint32(4, true); st[15] = nv.getUint32(8, true);
  const w = st.slice();
  const qr = (a, b, c, d) => {
    w[a] = (w[a] + w[b]) >>> 0; w[d] = rotl32(w[d] ^ w[a], 16);
    w[c] = (w[c] + w[d]) >>> 0; w[b] = rotl32(w[b] ^ w[c], 12);
    w[a] = (w[a] + w[b]) >>> 0; w[d] = rotl32(w[d] ^ w[a], 8);
    w[c] = (w[c] + w[d]) >>> 0; w[b] = rotl32(w[b] ^ w[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = new Uint8Array(64), odv = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) { w[i] = (w[i] + st[i]) >>> 0; odv.setUint32(i * 4, w[i], true); }
  return out;
}
function chacha20Xor(key32, nonce12, counterStart, data) {
  const out = data.slice();
  const blocks = Math.ceil(data.length / 64);
  for (let b = 0; b < blocks; b++) {
    const ks = chacha20Block(key32, counterStart + b, nonce12);
    const off = b * 64, n = Math.min(64, out.length - off);
    for (let i = 0; i < n; i++) out[off + i] ^= ks[i];
  }
  return out;
}
// Poly1305（RFC 8439 §2.5，BigInt 实现，简洁可靠）
function poly1305(key32, msg) {
  let r = 0n, p = 0n;
  // RFC 8439 §2.5：r = le_bytes_to_num(key[0..16))，s = le_bytes_to_num(key[16..32))（小端）
  for (let i = 0; i < 16; i++) { r |= BigInt(key32[i]) << BigInt(8 * i); p |= BigInt(key32[16 + i]) << BigInt(8 * i); }
  r &= 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  let h = 0n;
  const MOD = (1n << 130n) - 5n;
  // RFC 8439 §2.5.1：每块 n_i = 块内容 || 0x01（小端）。完整 16B 块 → 内容 + 2^128；
  // 不足 16B 的最后一块不补齐 → 内容 + 2^(8*实际字节数)。
  for (let i = 0; i < msg.length; i += 16) {
    const n = Math.min(16, msg.length - i);
    let c = 1n;
    for (let j = n - 1; j >= 0; j--) c = (c << 8n) | BigInt(msg[i + j]);
    h = ((h + c) * r) % MOD;
  }
  h = (h + p) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = Number((h >> BigInt(8 * i)) & 0xffn);
  return tag;
}
// AEAD_CHACHA20_POLY1305（RFC 8439 §2.8）；输出 = 密文 || 16B tag
function chacha20Poly1305Seal(key32, nonce12, plaintext, aad) {
  const aadB = aad || new Uint8Array(0);
  const polyKey = chacha20Xor(key32, nonce12, 0, new Uint8Array(32));
  const ct = chacha20Xor(key32, nonce12, 1, plaintext);
  const pad16 = (len) => new Uint8Array((16 - (len % 16)) % 16);
  const le64 = (n) => {
    const b = new Uint8Array(8), dv = new DataView(b.buffer);
    dv.setUint32(0, n >>> 0, true); dv.setUint32(4, Math.floor(n / 0x100000000), true);
    return b;
  };
  const macData = concatBytes(aadB, concatBytes(pad16(aadB.length), concatBytes(ct,
    concatBytes(pad16(ct.length), concatBytes(le64(aadB.length), le64(ct.length))))));
  const tag = poly1305(polyKey, macData);
  return concatBytes(ct, tag);
}
function chacha20Poly1305Open(key32, nonce12, data, aad) {
  if (data.length < 16) throw new Error('SS AEAD 数据过短');
  const ct = data.subarray(0, data.length - 16);
  const got = data.subarray(data.length - 16);
  const aadB = aad || new Uint8Array(0);
  const polyKey = chacha20Xor(key32, nonce12, 0, new Uint8Array(32));
  const pad16 = (len) => new Uint8Array((16 - (len % 16)) % 16);
  const le64 = (n) => {
    const b = new Uint8Array(8), dv = new DataView(b.buffer);
    dv.setUint32(0, n >>> 0, true); dv.setUint32(4, Math.floor(n / 0x100000000), true);
    return b;
  };
  const macData = concatBytes(aadB, concatBytes(pad16(aadB.length), concatBytes(ct,
    concatBytes(pad16(ct.length), concatBytes(le64(aadB.length), le64(ct.length))))));
  const expect = poly1305(polyKey, macData);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= expect[i] ^ got[i];
  if (diff !== 0) return null;
  return chacha20Xor(key32, nonce12, 1, ct);
}
// 每个方向一个 AEAD 实例，nonce 是 12 字节小端计数器：每次 seal / open（即每个长度块、每个数据块各一次）后加 1。
// （此前 nonce 从未真正递增，所有块都用同一个 nonce，既违反协议也无法与任何 SS 服务器互通）
function ssNonceCounter() {
  const nonce = new Uint8Array(12);
  return () => {
    const cur = nonce.slice();
    for (let i = 0; i < 12; i++) { nonce[i]++; if (nonce[i] !== 0) break; }
    return cur;
  };
}
async function newSsAead(algoName, keyBytes) {
  const next = ssNonceCounter();
  if (algoName === 'CHACHA20-POLY1305') {
    // 纯 JS：CF Workers 的 crypto.subtle 不支持该算法
    return {
      seal(data) { return chacha20Poly1305Seal(keyBytes, next(), data); },
      open(data) {
        const plain = chacha20Poly1305Open(keyBytes, next(), data);
        if (!plain) throw new Error('SS AEAD 解密失败（密码/加密方式与服务器不匹配）');
        return plain;
      }
    };
  }
  // AES-GCM：WebCrypto（CF 明确支持）
  const ck = await crypto.subtle.importKey('raw', keyBytes, { name: algoName }, false, ['encrypt', 'decrypt']);
  return {
    async seal(data) { return new Uint8Array(await crypto.subtle.encrypt({ name: algoName, iv: next() }, ck, data)); },
    async open(data) {
      try { return new Uint8Array(await crypto.subtle.decrypt({ name: algoName, iv: next() }, ck, data)); }
      catch (e) { throw new Error('SS AEAD 解密失败（密码/加密方式与服务器不匹配）'); }
    }
  };
}
// 主密钥：传统 AEAD 方式用 OpenSSL EVP_BytesToKey(MD5, 无盐, 1 轮) 由密码派生，长度等于密钥长度
// （此前误用 SHA-256(密码)，派生出的密钥与服务器不一致）
function ssMasterKey(password, keyLen) {
  const pw = TE.encode(password);
  let key = new Uint8Array(0), prev = new Uint8Array(0);
  while (key.length < keyLen) {
    prev = md5Bytes(concatBytes(prev, pw));
    key = concatBytes(key, prev);
  }
  return key.slice(0, keyLen);
}
// 目标地址头：ATYP(1=IPv4 / 3=域名 / 4=IPv6) + 地址 + 端口(2 字节大端)，作为客户端数据流的开头
function ssAddressHeader(hostname, port) {
  let head;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) head = new Uint8Array([1, ...hostname.split('.').map(Number)]);
  else if (hostname.indexOf(':') >= 0 && isValidIp(hostname)) head = new Uint8Array([4, ...ipv6ToBytes(hostname)]);
  else {
    const name = TE.encode(hostname);
    if (name.length > 255) throw new Error('SS 目标域名过长');
    head = new Uint8Array([3, name.length, ...name]);
  }
  return concatBytes(head, new Uint8Array([(port >> 8) & 255, port & 255]));
}
const SS_MAX_PAYLOAD = 0x3fff;   // AEAD 单块明文上限 16383 字节（长度字段高两位必须为 0）

async function ssSealChunk(aead, data) {
  const len = new Uint8Array([(data.length >> 8) & 255, data.length & 255]);
  return concatBytes(await aead.seal(len), await aead.seal(data));
}


// 通过 SS 出站代理建立到目标的加密隧道；返回兼容 socket 语义的包装（readable 已解密 / writable 自动加密）
async function connectViaShadowsocks(proxy, target) {
  const algo = ssCipherAlgo(proxy.method);
  if (!algo) throw new Error('不支持的 SS 加密方式: ' + (proxy.method || '（未指定）'));
  if (!proxy.password) throw new Error('SS 出站缺少密码');
  const raw = await connectWithTimeout(proxy.host, proxy.port, 6000);
  const rawWriter = raw.writable.getWriter();
  const rawReader = raw.readable.getReader();
  let pending = new Uint8Array(0);
  const readN = async (n) => {
    while (pending.length < n) {
      const { done, value } = await rawReader.read();
      if (done) throw new Error('SS 连接被关闭');
      pending = concatBytes(pending, value);
    }
    const out = pending.slice(0, n);
    pending = pending.subarray(n);
    return out;
  };
  const masterKey = ssMasterKey(proxy.password, algo.keyLen);
  // 客户端方向：随机 salt（长度 = 密钥长度：AES-128 为 16，AES-256 / ChaCha20 为 32）→ 会话子密钥；
  // 数据流以目标地址头开始（首个数据块即携带目标地址），之后才是转发的数据
  const clientSalt = crypto.getRandomValues(new Uint8Array(algo.keyLen));
  const clientAead = await newSsAead(algo.name, hkdfSha1(masterKey, clientSalt, algo.keyLen));
  await rawWriter.write(concatBytes(clientSalt, await ssSealChunk(clientAead, ssAddressHeader(target.hostname, target.port))));

  // 读方向：先收服务端 salt → 派生服务端子密钥 → 逐块解密（长度块 2+16 字节，数据块 len+16 字节；空块跳过）
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const serverSalt = await readN(algo.keyLen);
        const serverAead = await newSsAead(algo.name, hkdfSha1(masterKey, serverSalt, algo.keyLen));
        while (true) {
          const lb = await serverAead.open(await readN(18));
          const len = (lb[0] << 8) | lb[1];
          if (len > SS_MAX_PAYLOAD) throw new Error('SS 分片长度非法 ' + len);
          const pb = await serverAead.open(await readN(len + 16));
          if (len > 0) controller.enqueue(pb);
        }
      } catch (e) {
        try { controller.error(e); } catch (e2) { /* 忽略 */ }
      }
    }
  });

  // 写方向：明文按 ≤ 0x3FFF 分块加密写入底层
  const writable = new WritableStream({
    async write(chunk) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      for (let off = 0; off < data.length; off += SS_MAX_PAYLOAD) {
        await rawWriter.write(await ssSealChunk(clientAead, data.subarray(off, Math.min(data.length, off + SS_MAX_PAYLOAD))));
      }
    },
    close() { try { rawWriter.close(); } catch (e) { /* 忽略 */ } },
    abort() { try { rawWriter.abort(); } catch (e) { /* 忽略 */ } }
  });

  return {
    readable,
    writable,
    close() { try { raw.close(); } catch (e) { /* 忽略 */ } }
  };
}


async function readUntilCRLFCRLF(reader) {
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

// 出站代理地址解析：socks5:// / http(s):// / ss:// 或 host:port，可带 user:pass@
function parseProxyAddress(addr) {
  if (!addr) return null;
  let type = 'socks5', rest = String(addr).trim();
  const m = rest.match(/^(socks5|http|https|ss):\/\/(.+)$/i);
  if (m) { type = m[1].toLowerCase(); rest = m[2]; }
  if (type === 'ss') return parseSsProxy(rest);
  let user = '', pass = '';
  if (rest.includes('@')) {
    // 以最后一个 @ 分隔凭据与主机：密码中未编码的 @ 不会把主机名截断
    const at = rest.lastIndexOf('@');
    const u = rest.slice(0, at), h = rest.slice(at + 1);
    // 用户名/密码可能经 URL 编码（含 %40/@、%28/() 等特殊字符时），需解码后再用于认证，
    // 否则 socks5 用户名密码 / HTTP Basic 认证会失败
    const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
    const idx = u.indexOf(':');
    if (idx >= 0) { user = dec(u.slice(0, idx)); pass = dec(u.slice(idx + 1)); }
    else user = dec(u);
    rest = h;
  }
  const defaultPort = type === 'http' ? 80 : type === 'https' ? 443 : 1080;
  const { host, port } = parseHostPort(rest, defaultPort);
  return { type, host, port, user, pass };
}

// SS 出站解析：SIP002（ss://method:password@host:port#name 或 ss://BASE64(method:password)@host:port#name）
// 及旧格式 ss://BASE64(method:password@host:port)（整段无 @）。密码支持 percent-encoding。
function parseSsProxy(rest) {
  let hostPort = rest, userinfo = '';
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) hostPort = rest.slice(0, hashIdx);
  const atIdx = hostPort.lastIndexOf('@');
  if (atIdx >= 0) { userinfo = hostPort.slice(0, atIdx); hostPort = hostPort.slice(atIdx + 1); }
  else {
    const dec = b64ToUtf8(hostPort);   // 旧格式：整段 BASE64(method:password@host:port)
    if (dec && dec.includes('@')) {
      const at2 = dec.lastIndexOf('@');
      userinfo = dec.slice(0, at2); hostPort = dec.slice(at2 + 1);
    }
  }
  let method = '', password = '';
  if (userinfo) {
    let ui = b64ToUtf8(userinfo) || userinfo;   // SIP002 userinfo 可为 BASE64(method:password) 或明文
    try { ui = decodeURIComponent(ui); } catch (e) { /* 保持原样 */ }
    const ci = ui.indexOf(':');
    if (ci > 0) { method = ui.slice(0, ci); password = ui.slice(ci + 1); }
    else method = ui;
  }
  const { host, port } = parseHostPort(hostPort, 8388);
  return { type: 'ss', host, port, method, password };
}
function b64ToUtf8(s) {
  try {
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) { return null; }
}
// ---------------------------------------------------------------------------
// 出站兜底：直连与自定义反代均失败后使用，透明代理模式发送去掉 VLESS 头部的原始
// TLS 数据，由对端按 SNI 路由到目标
// ---------------------------------------------------------------------------
// 内置地区反代域名池：proxyip.<地区>.cmliussss.net 社区反代服务（解析为非 Cloudflare IP）
const RELAY_DOMAINS = {
  HK: 'proxyip.hk.cmliussss.net',
  US: 'proxyip.us.cmliussss.net',
  SG: 'proxyip.sg.cmliussss.net',
  JP: 'proxyip.jp.cmliussss.net',
  KR: 'proxyip.kr.cmliussss.net',
  DE: 'proxyip.de.cmliussss.net',
  SE: 'proxyip.se.cmliussss.net',
  NL: 'proxyip.nl.cmliussss.net',
  FI: 'proxyip.fi.cmliussss.net',
  GB: 'proxyip.gb.cmliussss.net',
  Oracle: 'proxyip.oracle.cmliussss.net',
  DigitalOcean: 'proxyip.digitalocean.cmliussss.net',
  Vultr: 'proxyip.vultr.cmliussss.net',
  Multacom: 'proxyip.multacom.cmliussss.net'
};
// 根据 Worker 所在机房 colo（IATA 代码）选择最近的中继地区
function selectRelayRegion(colo) {
  const c = (colo || '').toUpperCase();
  // 亚洲
  if (c.startsWith('HKG') || c.startsWith('HK')) return 'HK';
  if (c.startsWith('SIN') || c.startsWith('SG')) return 'SG';
  if (c.startsWith('NRT') || c.startsWith('KIX') || c.startsWith('TYO') || c.startsWith('OSA') || c.startsWith('JP')) return 'JP';
  if (c.startsWith('ICN') || c.startsWith('SEL') || c.startsWith('KR')) return 'KR';
  if (/^(HKG|SIN|NRT|KIX|ICN|TYO|OSA|SEL|HK|SG|JP|KR|SJC)/.test(c)) return 'HK';
  // 欧洲
  if (c.startsWith('FRA') || c.startsWith('BER') || c.startsWith('MUC') || c.startsWith('DUS') || c.startsWith('HAM') || c.startsWith('STR') || c.startsWith('DE')) return 'DE';
  if (c.startsWith('ARN') || c.startsWith('SE')) return 'SE';
  if (c.startsWith('AMS') || c.startsWith('NL')) return 'NL';
  if (c.startsWith('HEL') || c.startsWith('FI')) return 'FI';
  if (c.startsWith('LHR') || c.startsWith('MAN') || c.startsWith('GB') || c.startsWith('UK')) return 'GB';
  if (/^(FRA|ARN|AMS|HEL|LHR|MAN|CDG|MAD|VIE|ZRH|MXP|PRG|WAW|BER|MUC|DUS|HAM|STR|DE|SE|NL|FI|GB|UK|FR|ES|AT|CH|IT|CZ|PL)/.test(c)) return 'DE';
  // 北美及其他默认 US
  return 'US';
}

// PROXYIP 反代 IP 解析缓存（TTL 5 分钟：域名 → DoH TXT/A 解析结果）
const PROXYIP_CACHE = new Map();

// 解析反代域名为 IP 候选列表：
//   - IP 字面量直接返回
//   - 域名先查 TXT：TXT 含逗号/换行分隔的 IP 列表则解析为多候选；
//     TXT 为 @edtunnel 标记（反代服务约定）或无有效 TXT 时查 A 记录
//   - 结果缓存 5 分钟，避免每次连接都触发 DoH
//   - opts.txt === false：只查 A 记录（内置地区反代域名没有 TXT 记录，已实测全部 14 个地区，查 TXT 只是白白多一次 DoH）
// 注意：不能把「进行中的解析」（Promise）跨请求共享——Workers 中 fetch 归属发起它的请求，该请求结束（客户端断开）时
// fetch 被取消，共享这个 Promise 的其它请求会永远等不到结果，且之后同一域名的解析全部卡死（已在 workerd 中复现）。
// 只缓存解析完成的结果（普通数据可以跨请求共享）
const PROXYIP_TTL = 5 * 60 * 1000, PROXYIP_NEG_TTL = 30 * 1000;   // 成功缓存 5 分钟；失败 / 无记录缓存 30 秒（避免每个连接都重新查 DoH）
const PROXYIP_DOHS = ['https://cloudflare-dns.com/dns-query', 'https://dns.alidns.com/resolve', 'https://doh.pub/dns-query'];
async function resolveProxyIPs(host, port, opts) {
  port = port || 443;
  if (isValidIp(host)) return [{ hostname: host, port }];
  const txt = !(opts && opts.txt === false);
  const cacheKey = host + ':' + port + (txt ? '' : ':a');
  const hit = PROXYIP_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.t < (hit.ips.length ? PROXYIP_TTL : PROXYIP_NEG_TTL)) return hit.ips;
  const ips = await resolveProxyIPsUncached(host, port, txt);
  PROXYIP_CACHE.set(cacheKey, { t: Date.now(), ips });
  capMap(PROXYIP_CACHE, 200);
  return ips;
}
async function resolveProxyIPsUncached(host, port, txt) {
  // 每种记录类型按端点顺序查询：前一个端点失败才换下一个（正常只占 1 个子请求）；
  // SERVFAIL 等视为失败换端点，NOERROR / NXDOMAIN 视为确定结果
  const dohQuery = async (type, filterType) => {
    const r = await dohFirst(PROXYIP_DOHS, (url) => url + '?name=' + encodeURIComponent(host) + '&type=' + type, (j) => {
      if (!j || (j.Status !== 0 && j.Status !== 3)) return null;
      return (j.Answer || []).filter(a => a.type === filterType).map(a => a.data);
    });
    return r || [];
  };

  // 并发查询 TXT 与 A 记录（TXT 优先，无有效 TXT 用 A）
  const [txtRecords, aRecords] = await Promise.all([txt ? dohQuery('TXT', 16) : [], dohQuery('A', 1)]);

  let targets = [];
  // 1) TXT 记录：反代服务约定——TXT 存逗号/换行分隔的 IP 列表（支持 ip:port），或 @edtunnel 标记
  for (const raw of txtRecords) {
    // DNS TXT 转义：\010 是八进制换行符，需还原为分隔符；去掉首尾引号
    const val = String(raw).replace(/^"|"$/g, '').replace(/\\010/g, ',').replace(/\n/g, ',').trim();
    if (!val) continue;
    if (val === '@edtunnel') {
      // @edtunnel 是反代服务标记：实际反代 IP 在 A 记录中
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
const RELAY_HOSTS = new Map();
const RELAY_HOST_TTL = 30 * 60 * 1000;
function relayHostKnown(host) {
  const t = RELAY_HOSTS.get(host);
  if (t === undefined) return false;
  if (Date.now() - t > RELAY_HOST_TTL) { RELAY_HOSTS.delete(host); return false; }
  return true;
}
function markRelayHost(host) { RELAY_HOSTS.delete(host); RELAY_HOSTS.set(host, Date.now()); capMap(RELAY_HOSTS, 1000); }

// 直连优先竞速：直连与反代并发发起，但优先采用直连——
//   · 直连在 graceMs 内成功 → 用直连（反代是第三方 SNI 中转，多一跳且可能误路由）
//   · 直连失败（立即）/ 窗口到期 → 用已就绪的反代（反代并发建立，不额外等待）
//   · 反代也不可用          → 继续等直连
// 若不设窗口，就近反代的握手普遍比跨境直连快，几乎所有 TLS 流量都会被反代抢走。
// graceMs = 0：不等直连（目标确定在 CF 段，直连必被回环保护拦截）；onDirectFail：直连最终失败时回调（学习型路由）
// 反代整体等待上限 RELAY_WAIT_MAX：任何情况下都不会无限等待
async function racePreferDirect(directJob, relayJobs, graceMs, onDirectFail) {
  let used = null;
  const recycle = (s) => { if (s && s !== used) { try { s.close(); } catch (e) { /* 忽略 */ } } };
  const directP = directJob
    ? Promise.resolve().then(directJob).then((s) => (s && s.readable ? s : null), () => null)
    : Promise.resolve(null);
  // 直连最终失败且这次由反代接通：回调 onDirectFail（两件事先后顺序不定，都发生时调用一次）
  let directFailed = false, relayUsed = false;
  const learnIfBoth = () => { if (directFailed && relayUsed && onDirectFail) { onDirectFail(); onDirectFail = null; } };
  if (directJob) directP.then((s) => { if (!s) { directFailed = true; learnIfBoth(); } });
  const relayP = (relayJobs && relayJobs.length)
    ? nullAfter(raceConnect(relayJobs).then((s) => (s && s.readable ? s : null), () => null), RELAY_WAIT_MAX, recycle)
    : Promise.resolve(null);
  let graceTimer = null;
  const first = await Promise.race([
    directP,
    new Promise((r) => { graceTimer = setTimeout(() => r(GRACE_EXPIRED), graceMs); }),
  ]);
  clearTimeout(graceTimer);
  if (first && first !== GRACE_EXPIRED) { used = first; relayP.then(recycle); return used; }   // 直连胜出
  const relay = await relayP;
  if (relay) { used = relay; relayUsed = true; learnIfBoth(); directP.then(recycle); return used; }   // 反代接管
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
const RELAY_TIMEOUT = 4000;    // 单个反代 IP 连接超时
const MAX_RACERS = 4;          // 单次竞速最多并发路数（CF 单请求同时出站连接上限 6，留余量给 DoH 等）
const SNIFF_WAIT_MS = 80;      // 头部已完整但尚无数据时，等首包判定协议的上限（不能拖慢建连）
const RELAY_WAIT_MAX = 10000;  // 反代整体等待上限（DoH 解析 + 连接）
const DIRECT_GRACE_MS = 1500;  // 直连优先窗口（直连失败会立即换反代，窗口只管「慢但能通」的直连；过短会让反代抢走正常站点的流量，如 YouTube 视频）

// 首包协议判定：自定义反代与内置地区反代都是 SNI 型透明代理，只能搬运 TLS 流量（按 ClientHello 的 SNI 路由）。
// 非 TLS 流量（Telegram MTProto / 明文 HTTP / 裸 TCP）经反代能握手但转发不出任何数据 → 客户端无限重连，
// 因此非 TLS 只走直连与用户配置的出站代理（SOCKS5 / HTTP / SS 是真代理，可承载任意协议）。
// TLS 记录头固定为 0x16 0x03；数据不足 3 字节为 unknown（按可走反代处理，保持原行为）
function sniffPayloadKind(bytes) {
  if (!bytes || bytes.byteLength < 3) return 'unknown';
  return (bytes[0] === 0x16 && bytes[1] === 0x03) ? 'tls' : 'nontls';
}

// 按面板「内置地区反代」设置得出要竞速的反代：[{ host, port, take }]（take = 取该域名解析结果的前几个 IP）
//   off     → 空（不使用地区反代）
//   custom  → 自定义列表（最多 3 个，第一个取 2 个 IP，其余各 1 个）
//   builtin → 首选地区（relay.region，留空按机房自动选）取 2 个 IP + 次选地区（relay.region2，留空取默认的另一地区，'none' 不用）取 1 个 IP
function relayPlan(cfg, colo) {
  const rl = cfg.relay || {};
  const mode = rl.mode || 'builtin';
  if (mode === 'off') return [];
  if (mode === 'custom') {
    return String(rl.custom || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, RELAY_CUSTOM_MAX).map((entry, i) => {
      const { host, port } = parseHostPort(entry, 443);
      return { host, port, take: i === 0 ? 2 : 1 };
    });
  }
  const primary = RELAY_DOMAINS[rl.region] ? rl.region : selectRelayRegion(colo);
  const plan = [{ host: RELAY_DOMAINS[primary], port: 443, take: 2, txt: false }];   // 内置域名只有 A 记录
  if (rl.region2 !== 'none') {
    const second = (RELAY_DOMAINS[rl.region2] && rl.region2 !== primary) ? rl.region2 : Object.keys(RELAY_DOMAINS).find(r => r !== primary);
    plan.push({ host: RELAY_DOMAINS[second], port: 443, take: 1, txt: false });
  }
  return plan;
}

// 打开到目标的出站连接（自定义反代 / 出站代理 / 直连 / 地区反代）
// 反代均为透明代理：发送去掉 VLESS 头部的原始 TLS 数据，对端按 SNI 路由到目标。
// 出站模式语义：only = 仅走出站代理（失败用地区反代兜底，地区反代设为 off 时不兜底）；'' 默认 = 出站代理优先，失败后直连 ∥ 反代；
// no = 直连 ∥ 反代优先，都不通时最后用出站代理
async function openOutbound(parsed, cfg, colo, payloadKind) {
  const proxy = parseProxyAddress(cfg.outboundProxy);
  const mode = cfg.outboundMode || '';
  const allowSniRelay = payloadKind !== 'nontls';

  const viaProxy = proxy ? (proxy.type === 'http' || proxy.type === 'https'
    ? (t) => connectViaHttpProxy(proxy, t)
    : proxy.type === 'ss'
      ? (t) => connectViaShadowsocks(proxy, t)
      : (t) => connectViaSocks5(proxy, t)) : null;

  let lastErr;
  const attempt = async (fn) => { try { const r = await fn(); if (r) return r; } catch (e) { lastErr = e; } return null; };
  const fail = () => { throw lastErr || new Error('所有出站方式均失败'); };

  // 1) 用户填写的「反代 / 落地 IP」：作为固定出口优先使用（多个解析结果并发竞速），失败再走下面的流程
  const relay = cfg.proxyIP ? parseHostPort(cfg.proxyIP, 443) : null;
  if (relay && relay.host && allowSniRelay) {
    let customTargets = await resolveProxyIPs(relay.host, relay.port);
    if (!customTargets.length) customTargets = [{ hostname: relay.host, port: relay.port }];
    const r = await raceConnect(customTargets.slice(0, MAX_RACERS).map(t => () => attempt(() => connectDirect(t, RELAY_TIMEOUT))));
    if (r) return r;
  }

  const target = { hostname: parsed.addr, port: parsed.port };
  // 2) 地区反代（面板「内置地区反代」设置）：builtin = 首选地区（2 个 IP）+ 次选地区（1 个 IP）；custom = 自定义列表；
  //    off = 不使用。各条目的 DoH 解析（5 分钟缓存）与连接并发竞速
  const relayJobs = () => {
    if (!allowSniRelay) return [];
    return relayPlan(cfg, colo).map((p) => async () => {
      let ts = [];
      try { ts = await resolveProxyIPs(p.host, p.port, { txt: p.txt !== false }); } catch (e) { return null; }
      if (!ts.length) return null;
      return await raceConnect(ts.slice(0, p.take).map(t => () => attempt(() => connectDirect(t, RELAY_TIMEOUT))));
    });
  };
  const directJob = () => attempt(() => connectDirect(target, DIRECT_TIMEOUT));
  const proxyJob = viaProxy ? () => attempt(() => viaProxy(target)) : null;
  const hostKey = String(parsed.addr || '').toLowerCase();
  const cfIp = isCloudflareIP(hostKey);
  const learn = !isValidIp(hostKey);   // 学习型路由只针对域名目标（IP 目标按 CF 段直接判断）
  const pickBest = async () => {
    const jobs = relayJobs().slice(0, MAX_RACERS - 1);
    // 目标为 CF 段 IP，或已记录需要反代的域名：直连必被回环保护拦截，直接走反代（不发注定失败的直连）；
    // 反代不通时删除记录并回落直连（反代失效时仍能连通）
    if (jobs.length && (cfIp || (learn && relayHostKnown(hostKey)))) {
      const r = await racePreferDirect(null, jobs, 0);
      if (r) return r;
      if (learn) RELAY_HOSTS.delete(hostKey);
      return racePreferDirect(directJob, [], 0);
    }
    return racePreferDirect(directJob, jobs, DIRECT_GRACE_MS, (learn && jobs.length) ? () => markRelayHost(hostKey) : null);
  };

  if (mode === 'only') {
    if (proxyJob) {
      const r = await proxyJob(); if (r) return r;
      const r2 = await racePreferDirect(null, relayJobs(), 0); if (r2) return r2;
      return fail();
    }
    const r = await pickBest(); if (r) return r;   // 未配置出站代理：按直连处理
    return fail();
  }
  if (mode === '' && proxyJob) {
    const r = await proxyJob(); if (r) return r;
    const r2 = await pickBest(); if (r2) return r2;
    return fail();
  }
  const r = await pickBest(); if (r) return r;
  if (proxyJob) { const r2 = await proxyJob(); if (r2) return r2; }
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
  let want;
  try { want = uuidToBytes(cfg.uuid); } catch (e) { return null; }
  for (let i = 0; i < 16; i++) if (bytes[i + 1] !== want[i]) return null;
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

async function handleWebSocketProxy(request, cfg) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  try { server.accept({ allowHalfOpen: true }); } catch (e) { server.accept(); }
  // 关键：必须声明二进制类型，否则 CF 将二进制帧按 UTF-8 解码成 string，VLESS 头（含 16 字节原始 UUID）会被损坏导致隧道失败
  server.binaryType = 'arraybuffer';
  let socket = null, writer = null, headerSent = false, pending = null, protoWait = null, respSent = false;
  let closed = false, pumped = false, wsClosed = false;   // closed：WS 已关闭（之后建好的出站连接要立即释放）；pumped：已开始把目标数据转给客户端（由它负责在结束时关闭 WS）

  const send = (data) => { try { server.send(data); } catch (e) { /* 忽略 */ } };
  // 只发一次关闭帧（重复 close 在运行时会抛异常，也会覆盖先发出的关闭码）
  const closeWs = (code, reason) => { if (wsClosed) return; wsClosed = true; try { server.close(code, reason); } catch (e) { /* 忽略 */ } };
  const fail = (err) => { closeWs(1011, closeReason(err && err.message || err)); cleanup(); };

  // 首包处理：WS 数据帧与 0-RTT 早数据共用。headerSent 在任何 await 之前置位，
  // 解析期间到达的后续帧走下方「暂存 / 直写」分支，不会重复解析
  const handleFirstChunk = async (chunk, forced) => {
    // 累积缓冲：WS 消息可能分片到达，不足头部长度时等待后续数据
    if (chunk && chunk.byteLength) pending = pending ? concatBytes(pending, chunk) : chunk;
    if (!pending || headerSent) return;
    // 握手头正常仅数十字节；持续收到不完整分片（异常 / 恶意）时限制缓冲，防内存膨胀
    if (pending.byteLength > 65536) throw new Error('握手头超过 64KB');
    let parsed;
    try {
      parsed = parseVssProtoHeader(pending, cfg);
    } catch (err) {
      if (/头部过短/.test(err.message || '')) return;   // 等下一个分片
      throw err;
    }
    // 仅支持 TCP（0x01）与 UDP-DNS（0x02）；VLESS MUX 等其它命令
    // 此前会被当成 TCP 连接目标地址，现在明确拒绝，客户端据此回退
    if (parsed.command !== 1 && parsed.command !== 2) {
      throw new Error('不支持的命令 ' + parsed.command);
    }
    // 头部解析成功立即回 VLESS 响应头（version=0 + addonsLen=0），早于首包判定与出站建连：
    // 部分客户端（mihomo 等）收到这 2 字节才发送首个数据包，晚发会与服务端互相等待
    if (!respSent && parsed.command !== 2) { respSent = true; send(new Uint8Array([0, 0])); }
    // 首包判定出站方式（非 TLS 不走 SNI 型反代，见 sniffPayloadKind）；头部完整但暂无数据时短暂等待首包，
    // 超时（SNIFF_WAIT_MS）仍无数据按 unknown 放行，不让连接悬挂
    const payload = pending.byteLength > parsed.headerLength ? pending.subarray(parsed.headerLength) : null;
    const payloadKind = sniffPayloadKind(payload);
    if (payloadKind === 'unknown' && !forced) {
      if (!protoWait) protoWait = setTimeout(() => { protoWait = null; handleFirstChunk(null, true).catch(fail); }, SNIFF_WAIT_MS);
      return;
    }
    if (protoWait) { clearTimeout(protoWait); protoWait = null; }
    headerSent = true;
    // UDP 请求（command=0x02）：CF Workers 无 UDP socket 无法原生转发数据报，
    // DNS(53) 查询 → DoH(HTTPS) 转换后回标准 DNS 响应（使 V2rayNG 关闭「本地 DNS」时远端 DNS 仍可用）；
    // 其余 UDP 快速失败关闭连接（客户端自动回退），TCP（VLESS WS/XHTTP）路径零影响
    if (parsed.command === 2) {
      try {
        if (parsed.port === 53 && payload && payload.byteLength >= 12) {
          const resp = await dnsToDoH(payload);
          if (resp) send(resp);
        }
      } catch (e) { /* UDP 处理失败不响应，客户端按超时/回退处理 */ }
      closeWs(1000);
      return;
    }
    const conn = await openOutbound(parsed, cfg, request.cf && request.cf.colo, payloadKind);
    // 建连期间客户端已断开：立即释放刚建好的出站连接，否则它会一直挂到目标端关闭
    if (closed) { try { conn.close(); } catch (e) { /* 忽略 */ } return; }
    socket = conn;
    writer = conn.writable.getWriter();
    // 透明代理：去掉 VLESS 头部，发送原始 TLS 数据，由对端按 SNI 路由
    // 补发 SOCKS5/HTTP 代理握手残留字节（目标端早期数据），避免 TLS 握手中途被截断
    if (conn._preamble && conn._preamble.byteLength > 0) send(conn._preamble);
    if (pending && pending.byteLength > parsed.headerLength) await writer.write(pending.subarray(parsed.headerLength));
    pending = null;   // 出站就绪后清空缓冲，后续消息直接写出站
    pumped = true;
    pumpReadable(conn.readable, send, () => closeWs(1000));
  };

  // WS 0-RTT：先处理握手头中预发的首包，再处理数据帧；校验不通过时 earlyBytes 为 null，走原流程
  const earlyBytes = decodeEarlyData(request.headers.get('sec-websocket-protocol'), cfg);
  if (earlyBytes) handleFirstChunk(earlyBytes).catch(fail);

  server.addEventListener('message', async (ev) => {
    try {
      const chunk = typeof ev.data === 'string' ? TE.encode(ev.data) : new Uint8Array(ev.data);
      if (!headerSent) await handleFirstChunk(chunk);
      // 出站未就绪时暂存，避免头部之后的早期数据帧被丢弃（否则 TLS 握手不完整 → 连接通但流量为 0）
      else if (writer) await writer.write(chunk);
      else pending = pending ? concatBytes(pending, chunk) : chunk;
    } catch (err) { fail(err); }
  });
  // accept({ allowHalfOpen: true }) 下收到客户端的关闭帧不会自动回应：这里必须自己收尾。
  // 已有数据转发时，目标连接被关闭后由 pumpReadable 结束并关闭 WS；还没开始转发（握手 / 等首包 / 建连中）时直接关闭，避免连接悬挂
  function cleanup() {
    closed = true;
    if (protoWait) { clearTimeout(protoWait); protoWait = null; }
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
async function handleXhttpProxy(request, cfg) {
  const bodyReader = request.body.getReader();
  // 首个数据块可能短于 VLESS 头部（分块到达）：累积到能完整解析为止（上限 64KB，与 WS 路径一致）
  let buf = new Uint8Array(0), parsed = null;
  while (!parsed) {
    const chunk = await bodyReader.read();
    if (chunk.done) return new Response('empty', { status: 400 });
    buf = buf.byteLength ? concatBytes(buf, chunk.value) : chunk.value;
    try { parsed = parseVssProtoHeader(buf, cfg); }
    catch (err) {
      if (!/头部过短/.test(err.message || '')) throw err;
      if (buf.byteLength > 65536) throw new Error('握手头超过 64KB');
    }
  }
  if (parsed.command !== 1) throw new Error('XHTTP 仅支持 TCP 命令');
  const firstPayload = buf.subarray(parsed.headerLength);
  const conn = await openOutbound(parsed, cfg, request.cf && request.cf.colo, sniffPayloadKind(firstPayload));
  // 数据面全部交给运行时原生管道（pipeTo），不经过 JS 逐块搬运：
  // 免费版每个请求只有 10ms CPU，XHTTP 每条代理连接就是一个长请求；若每个数据块都在 JS 里 read → enqueue / write，
  // 看视频时几 MB 数据就超出 CPU 上限（日志 Worker exceeded CPU time limit），连接被限流变得极慢。
  // 原生流之间的 pipeTo 由运行时内部完成，几乎不计 JS CPU；背压与断开传播也由管道自动处理
  const writer = conn.writable.getWriter();
  if (firstPayload.byteLength) await writer.write(firstPayload);
  writer.releaseLock();
  bodyReader.releaseLock();
  // 上行：请求体 → 目标（请求体结束时关闭目标写端，即 TCP 半关闭）
  request.body.pipeTo(conn.writable).catch(() => {});

  // 下行：先写 2 字节 VLESS 响应头（version=0 + addonsLen=0，否则 xhttp 客户端报 unexpected response version）
  // 与 SOCKS5/HTTP 代理握手残留字节（目标端早期数据），再把目标连接原生管道接到响应体
  const ts = typeof IdentityTransformStream === 'function' ? new IdentityTransformStream() : new TransformStream();
  (async () => {
    try {
      const w = ts.writable.getWriter();
      await w.write(new Uint8Array([0, 0]));
      if (conn._preamble && conn._preamble.byteLength > 0) await w.write(conn._preamble);
      w.releaseLock();
      await conn.readable.pipeTo(ts.writable);   // 客户端断开 → 取消目标读取；目标结束 → 响应结束
    } catch (e) { /* 忽略 */ }
    try { conn.close(); } catch (e) { /* 忽略 */ }
  })();
  return new Response(ts.readable, { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-accel-buffering': 'no', 'cache-control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// 代理配置：来自环境变量（代理脚本没有面板；可选的 PROXY_KV 在线覆盖见 proxy-settings.js，UUID 与 PATH 永远只来自环境变量）
// 变量名与含义同原先的一体版；原先只能在面板里改的出站 / 地区反代设置现在用环境变量（也可由面板经 ProxyControl 在线覆盖）：
//   UUID             【必填】VLESS 用户 ID
//   PATH             【必填】节点路径（WebSocket / XHTTP 共用）
//   PROXYIP          反代 / 落地 IP（host 或 host:port）
//   OUTBOUND_PROXY   出站代理（socks5:// / http(s):// / ss:// 或 host:port）
//   OUTBOUND_MODE    出站方式：留空 = 出站代理优先；no = 直连优先；only = 仅走出站代理
//   RELAY_MODE       地区反代：builtin（默认，按机房自动选地区）/ custom / off
//   RELAY_REGION     builtin 的首选地区（留空按机房自动选）
//   RELAY_REGION2    builtin 的次选地区（留空自动；none = 不用）
//   RELAY_CUSTOM     custom 的反代列表（最多 3 个 host[:port]，换行 / 逗号分隔）
// 无效取值按默认值处理（与原先面板里的枚举校验一致）。
// ---------------------------------------------------------------------------
const PROXY_PATH_RE = /^[A-Za-z0-9._~-]+$/;
const RELAY_CUSTOM_MAX = 3;   // 自定义反代最多 3 个：与直连并发竞速，受 Workers 6 个同时出站连接的限制

function proxyConfig(env) {
  const str = (k) => (env && env[k] != null ? String(env[k]).trim() : '');
  const cfg = {
    uuid: '', path: '', proxyIP: str('PROXYIP'), outboundProxy: str('OUTBOUND_PROXY'), outboundMode: '',
    relay: { mode: 'builtin', region: '', region2: '', custom: '' },
    _problems: [],
  };
  const uuid = str('UUID').toLowerCase();
  if (isUUID(uuid)) cfg.uuid = uuid;
  else cfg._problems.push(uuid ? '环境变量 UUID 的值不正确（应为 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）。' : '请设置环境变量 UUID（节点用户 ID）。');
  const path = str('PATH').replace(/^\/+/, '').replace(/\/+$/, '');
  if (path && PROXY_PATH_RE.test(path) && path.length <= 128) cfg.path = path;
  else cfg._problems.push(path ? '环境变量 PATH 的值不正确：只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位。' : '请设置环境变量 PATH（节点的访问路径，如 mynode）。');
  const mode = str('OUTBOUND_MODE').toLowerCase();
  if (mode === 'no' || mode === 'only') cfg.outboundMode = mode;
  const rmode = str('RELAY_MODE').toLowerCase();
  if (rmode === 'custom' || rmode === 'off') cfg.relay.mode = rmode;
  const regionOf = (v, extra) => {
    const k = Object.keys(RELAY_DOMAINS).find(x => x.toLowerCase() === v.toLowerCase());
    return k || (extra && v.toLowerCase() === extra ? extra : '');
  };
  cfg.relay.region = regionOf(str('RELAY_REGION'));
  cfg.relay.region2 = regionOf(str('RELAY_REGION2'), 'none');
  cfg.relay.custom = str('RELAY_CUSTOM').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).slice(0, RELAY_CUSTOM_MAX).join('\n');
  return cfg;
}
// ---------------------------------------------------------------------------
// 代理设置的在线修改（可选）：面板通过服务绑定（入口 ProxyControl）读写代理的运行设置
// ---------------------------------------------------------------------------
// 代理自己的 KV（绑定变量名 PROXY_KV，建议单独建一个命名空间，只有代理绑定它）里保存一份 settings，
// 优先级：KV 里的设置 > 环境变量 > 默认值（与原先面板里的规则一致）。只有这 7 项运行设置可以在线修改，
// UUID 与 PATH（节点身份与路径）永远只来自环境变量，面板改不了。
// 没有绑定 PROXY_KV 时代理完全按环境变量工作，面板里的这些设置只读。
//
// 与环境变量相同的值不会写进 KV（只保存与环境变量不同的覆盖项），之后改环境变量立即生效。
// 读取走 isolate 内存缓存（SETTINGS_MEM_TTL）+ KV 边缘缓存，每个 isolate 约每 20 秒读一次 KV；只有节点路径上的连接才会触发读取。
// KV 读取失败时沿用上一次读到的设置（没有就用环境变量），绝不因此阻断代理。
const SETTINGS_KEY = 'settings';
const SETTINGS_MEM_TTL = 20 * 1000;
const SETTINGS_FIELDS = ['proxyIP', 'outboundProxy', 'outboundMode', 'relay.mode', 'relay.region', 'relay.region2', 'relay.custom'];
const SS_METHODS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'];
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function proxyKv(env) {
  const kv = env && env.PROXY_KV;
  return kv && typeof kv === 'object' && typeof kv.get === 'function' ? kv : null;
}

// cfg ↔ 扁平的设置对象（键为 SETTINGS_FIELDS）
function flatSettings(cfg) {
  return {
    proxyIP: cfg.proxyIP, outboundProxy: cfg.outboundProxy, outboundMode: cfg.outboundMode,
    'relay.mode': cfg.relay.mode, 'relay.region': cfg.relay.region, 'relay.region2': cfg.relay.region2, 'relay.custom': cfg.relay.custom,
  };
}
function applySettings(cfg, flat) {
  for (const k of SETTINGS_FIELDS) {
    if (!(k in flat)) continue;
    if (k.startsWith('relay.')) cfg.relay[k.slice(6)] = flat[k];
    else cfg[k] = flat[k];
  }
  return cfg;
}
const DEFAULT_SETTINGS = flatSettings({ proxyIP: '', outboundProxy: '', outboundMode: '', relay: { mode: 'builtin', region: '', region2: '', custom: '' } });

// 单项校验与规范化：返回 { value } 或 { error }（规则与原先面板里的字段校验一致）
function checkSetting(key, v) {
  if (v == null) v = '';
  if (typeof v !== 'string') return { error: '格式不正确' };
  v = v.trim();
  const oneOf = (list, label) => (list.includes(v) ? { value: v } : { error: label + '：不支持的选项「' + v.slice(0, 40) + '」' });
  const regions = Object.keys(RELAY_DOMAINS);
  switch (key) {
    case 'proxyIP': {
      if (!v) return { value: '' };
      if (v.length > 256) return { error: '长度不能超过 256' };
      if (!/^[^\s/]+$/.test(v)) return { error: '格式为 host 或 host:port' };
      const { host, port } = parseHostPort(v, 443);
      if (!host) return { error: '缺少主机名' };
      if (!(port >= 1 && port <= 65535)) return { error: '端口须为 1 - 65535' };
      return { value: v };
    }
    case 'outboundProxy': {
      if (!v) return { value: '' };
      if (v.length > 1024) return { error: '长度不能超过 1024' };
      if (!/^\S+$/.test(v)) return { error: '出站代理不能包含空格' };
      const p = parseProxyAddress(v);
      if (!p || !p.host) return { error: '无法解析出站代理地址（格式如 socks5://user:pass@1.2.3.4:1080）' };
      if (!(p.port >= 1 && p.port <= 65535)) return { error: '出站代理端口须为 1 - 65535' };
      if (p.type === 'ss') {
        if (!ssCipherAlgo(p.method)) return { error: 'SS 加密方式仅支持 ' + SS_METHODS.join(' / ') };
        if (!p.password) return { error: 'SS 缺少密码' };
      }
      return { value: v };
    }
    case 'outboundMode': return oneOf(['', 'no', 'only'], '出站方式');
    case 'relay.mode': return oneOf(['builtin', 'custom', 'off'], '地区反代模式');
    case 'relay.region': case 'relay.region2': {
      const extra = key === 'relay.region2' ? ['', 'none'] : [''];
      const hit = regions.find(r => r.toLowerCase() === v.toLowerCase());
      if (hit) return { value: hit };
      return oneOf(extra, key === 'relay.region' ? '首选反代地区' : '次选反代地区');
    }
    case 'relay.custom': {
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
      if (out.length > RELAY_CUSTOM_MAX) return { error: '最多 ' + RELAY_CUSTOM_MAX + ' 个自定义反代（当前 ' + out.length + ' 个）' };
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
  if (flat['relay.mode'] === 'custom' && !flat['relay.custom']) {
    errors.push({ field: 'relay.custom', msg: '已选择「仅使用自定义反代」，请至少填写一个反代地址（或改回内置 / 关闭）' });
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

// 代理运行时使用的配置：环境变量 + KV 覆盖项（没有 PROXY_KV 或环境变量有问题时就是环境变量本身）
async function loadProxyConfig(env, base) {
  const cfg = base || proxyConfig(env);
  const kv = proxyKv(env);
  if (!kv || cfg._problems.length) return cfg;
  const { stored } = await readStoredSettings(kv);
  return applySettings(cfg, stored);
}

// getSettings 的返回值：生效值、环境变量值、每项的来源、可选地区
function describeSettings(env, stored, error) {
  const envFlat = flatSettings(proxyConfig(env));
  const settings = Object.assign({}, envFlat, stored);
  const source = {};
  for (const k of SETTINGS_FIELDS) source[k] = k in stored ? 'kv' : (envFlat[k] !== DEFAULT_SETTINGS[k] ? 'env' : 'default');
  const kv = proxyKv(env);
  return { ok: true, storage: !!(kv && typeof kv.put === 'function'), settings, env: envFlat, source, regions: Object.keys(RELAY_DOMAINS), error: error || '' };
}
async function getProxySettings(env) {
  const kv = proxyKv(env);
  if (!kv) return describeSettings(env, {}, '');
  const { stored, error } = await readStoredSettings(kv);
  return describeSettings(env, stored, error);
}
// 保存：patch 里出现的项逐项校验（任何一项出错整批都不保存），与环境变量相同的值不落盘
async function saveProxySettings(env, patch) {
  const kv = proxyKv(env);
  if (!kv || typeof kv.put !== 'function') return { ok: false, error: '代理没有绑定 KV（变量名 PROXY_KV），无法保存设置；这些设置仍可以通过环境变量修改' };
  const { values, errors, ignored } = sanitizeSettings(patch);
  if (errors.length) return { ok: false, error: errors.map(e => e.msg).join('；'), errors, ignored };
  const cur = await readStoredSettings(kv, true);
  if (cur.error === 'unavailable') return { ok: false, error: 'KV 暂时无法读取，为避免覆盖已有设置，已禁止保存' };   // 内容损坏（corrupt）时允许保存来修复
  const envFlat = flatSettings(proxyConfig(env));
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
async function resetProxySettings(env) {
  const kv = proxyKv(env);
  if (!kv || typeof kv.delete !== 'function') return { ok: false, error: '代理没有绑定 KV（变量名 PROXY_KV），没有需要重置的设置' };
  try { await kv.delete(SETTINGS_KEY); }
  catch (e) { return { ok: false, error: 'KV 删除失败：' + ((e && e.message) || e) }; }
  SETTINGS_MEM.set(kv, { t: Date.now(), stored: {}, error: '' });
  return describeSettings(env, {}, '');
}
// ---------------------------------------------------------------------------
// 路由：只有节点路径上的 WebSocket 升级与 XHTTP POST 会进入代理，其余一律返回伪装页
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    // HTTP → HTTPS（WebSocket 升级除外：明文端口节点 80/8080 等以 http 到达，重定向会让其永远无法连接）
    if (url.protocol === 'http:' && upgrade !== 'websocket') {
      return Response.redirect(url.href.replace('http://', 'https://'), 301);
    }
    const cfg = proxyConfig(env);
    // 必填项缺失或非法：没有 UUID / 路径就无法工作，统一返回设置说明
    if (cfg._problems.length) {
      return new Response(cfg._problems.join('\n'), { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path === cfg.path) {
      // 只有节点路径上的连接才会读 PROXY_KV 里的在线设置（伪装页请求不触发任何 KV 读取）
      const live = await loadProxyConfig(env, cfg);
      if (upgrade === 'websocket') return handleWebSocketProxy(request, live);
      if (request.method === 'POST') {
        try { return await handleXhttpProxy(request, live); }
        catch (e) { return json({ ok: false, msg: 'xhttp 代理错误: ' + (e.message || e) }, 500); }
      }
    }
    return helloPage();
  }
};

// 面板 Worker 通过服务绑定调用的 RPC 入口，没有 HTTP 路由，公网访问不到：
//   ProxyStatus   只读：status() 返回是否在线 / 版本 / 配置问题 / 非敏感的设置摘要（不含 UUID、路径、反代地址与出站代理的主机和密码）
//   ProxyControl  在 ProxyStatus 之上再加 getSettings() / setSettings() / resetSettings()：读写 7 项运行设置（见 proxy-settings.js）。
//                 getSettings() 会返回完整的设置值，包括出站代理里的用户名与密码——面板里需要显示并编辑它们；
//                 UUID 与 PATH 永远不在其中，也改不了。想让面板只读时，服务绑定的入口选 ProxyStatus 即可
export class ProxyStatus extends WorkerEntrypoint {
  async status() {
    const cfg = await loadProxyConfig(this.env);
    const out = cfg.outboundProxy ? parseProxyAddress(cfg.outboundProxy) : null;
    return {
      ok: cfg._problems.length === 0,
      version: VERSION,
      problems: cfg._problems,
      control: this instanceof ProxyControl,
      storage: !!proxyKv(this.env),
      settings: {
        proxyIP: !!cfg.proxyIP,
        outboundProxy: out ? out.type : '',
        outboundMode: cfg.outboundMode,
        relayMode: cfg.relay.mode,
        relayRegion: cfg.relay.region,
        relayRegion2: cfg.relay.region2,
        relayCustom: cfg.relay.custom ? cfg.relay.custom.split('\n').length : 0,
      },
    };
  }
}
export class ProxyControl extends ProxyStatus {
  getSettings() { return getProxySettings(this.env); }
  setSettings(patch) { return saveProxySettings(this.env, patch); }
  resetSettings() { return resetProxySettings(this.env); }
}
