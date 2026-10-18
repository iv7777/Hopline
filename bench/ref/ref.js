// 参照 Worker：最简单的数据面，用来区分运行时本身的开销与脚本的开销（node ref/refbench.mjs）
//   /ws?mode=byob|default|nosend   WS：连目标、发 "DOWN n"，把 socket 数据转给 WS
//   /pipe                           HTTP：连目标、发 "DOWN n"，把 socket.readable 直接作为响应体
import { connect } from 'cloudflare:sockets';
export default {
  async fetch(req) {
    const u = new URL(req.url);
    const n = u.searchParams.get('n') || String(64 * 1024 * 1024);
    const sock = connect({ hostname: '127.0.0.1', port: 9001 });
    const w = sock.writable.getWriter(); await w.write(new TextEncoder().encode('DOWN ' + n + '\n')); w.releaseLock();
    if (u.pathname === '/pipe') return new Response(sock.readable);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept(); server.binaryType = 'arraybuffer';
    const mode = u.searchParams.get('mode') || 'byob';
    (async () => {
      if (mode === 'default') {
        const r = sock.readable.getReader();
        for (;;) { const { done, value } = await r.read(); if (done) break; server.send(value); }
      } else {
        const r = sock.readable.getReader({ mode: 'byob' });
        let buf = new ArrayBuffer(65536);
        for (;;) {
          const { done, value } = await r.read(new Uint8Array(buf, 0, 65536)); if (done) break;
          if (mode === 'nosend') { buf = value.buffer; continue; }
          server.send(value); buf = new ArrayBuffer(65536);
        }
      }
      server.close(1000);
    })();
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Extensions': 'identity' } });
  },
};
