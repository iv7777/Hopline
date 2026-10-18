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
