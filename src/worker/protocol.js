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
function parseVlessHeader(data, cfg) {
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

// SHA-224（用于由 UUID 派生 Clash 配置的密钥）——Cloudflare WebCrypto 不支持 SHA-224，手写实现（SHA-256 结构 + SHA-224 初始值）
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
function sha224hex(str) {
  const bytes = TE.encode(String(str));
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const data = new Uint8Array(paddedLen);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const dv = new DataView(data.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);   // SHA-2 大端 64 位长度
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
  let h0 = 0xc1059ed8, h1 = 0x367cd507, h2 = 0x3070dd17, h3 = 0xf70e5939,
      h4 = 0xffc00b31, h5 = 0x68581511, h6 = 0x64f98fa7, h7 = 0xbefa4fa4;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < paddedLen; i += 64) {
    const w = new Uint32Array(64);
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);  // 大端读消息字
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[j] + w[j]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  let hex = '';
  for (const v of [h0, h1, h2, h3, h4, h5, h6]) {
    hex += (v >>> 24 & 255).toString(16).padStart(2, '0');
    hex += (v >>> 16 & 255).toString(16).padStart(2, '0');
    hex += (v >>> 8 & 255).toString(16).padStart(2, '0');
    hex += (v & 255).toString(16).padStart(2, '0');
  }
  return hex;
}

// DoH 端点池（UDP/DNS → DoH 转换用，使 V2rayNG 关闭「本地 DNS」时远端 DNS 仍可用）
// Cloudflare 优先（Worker 与其同机房，延迟最低，且用户的查询不必先经过第三方境内解析器），其余按序兜底
const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
  'https://dns.alidns.com/resolve',
  'https://doh.pub/dns-query'
];
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

