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
  const kick = () => {
    if (burst) return;
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

