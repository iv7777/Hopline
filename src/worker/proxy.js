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
      // 面板关闭 VLESS 后服务端也不再接受 VLESS 连接（XHTTP 走独立入口，由 enableXhttp 控制）
      if (cfg.enableVless === false) throw new Error('VLESS 协议未启用');
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

