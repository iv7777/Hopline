// 基准测试用的本地上游，单独一个进程运行，CPU 不会混进被测的 workerd 进程：
//   TCP  :9001  目标：行为由客户端经隧道发来的第一行决定（开头可带 3 字节 TLS 记录头 16 03 01，会先去掉）：
//                 DOWN <字节数>\n          发送这么多数据后关闭
//                 UP <字节数>\n            收满这么多数据后回 "OK\n" 并关闭
//                 PING <次数> <大小>\n     客户端每发 1 字节，回 <大小> 字节
//                 ECHO\n                   原样回显
//                 HOLD\n                   回 "OK\n" 后保持连接空闲
//   TCP  :9002  SOCKS5 服务器（无认证），转接到请求的 host:port
//   HTTP :9053  DoH JSON 接口：A 查询一律回 127.0.0.1，AAAA 回 ::1
import net from 'node:net';
import http from 'node:http';

const BLOCK = Buffer.alloc(64 * 1024, 0x61);

function handleTarget(sock) {
  sock.setNoDelay(true);
  let buf = Buffer.alloc(0), mode = null;
  const onData = (d) => {
    if (mode) return mode(d);
    buf = Buffer.concat([buf, d]);
    let s = buf;
    if (s[0] === 0x16 && s[1] === 0x03) s = s.subarray(3);
    const nl = s.indexOf(10);
    if (nl < 0) return;
    const [cmd, a, b] = s.subarray(0, nl).toString().trim().split(' ');
    const rest = s.subarray(nl + 1);
    if (cmd === 'DOWN') {
      mode = () => {};
      let left = Number(a);
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, BLOCK.length);
          left -= n;
          if (!sock.write(n === BLOCK.length ? BLOCK : BLOCK.subarray(0, n))) { sock.once('drain', pump); return; }
        }
        sock.end();
      };
      pump();
    } else if (cmd === 'UP') {
      let left = Number(a);
      mode = (d) => { left -= d.length; if (left <= 0) { mode = () => {}; sock.end('OK\n'); } };
      if (rest.length) mode(rest);
    } else if (cmd === 'PING') {
      const reply = BLOCK.subarray(0, Number(b));
      let left = Number(a);
      mode = (d) => { for (let i = 0; i < d.length && left > 0; i++) { left--; sock.write(reply); } if (left <= 0) { mode = () => {}; sock.end(); } };
      sock.write('OK\n');
      if (rest.length) mode(rest);
    } else if (cmd === 'ECHO') {
      mode = (d) => sock.write(d);
      if (rest.length) sock.write(rest);
      sock.write('OK\n');
    } else if (cmd === 'HOLD') {
      mode = () => {};
      sock.write('OK\n');
    } else sock.destroy();
  };
  sock.on('data', onData);
  sock.on('error', () => {});
}

function handleSocks(c) {
  c.on('error', () => {});
  let stage = 0, buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
      buf = buf.subarray(2 + buf[1]); stage = 1; c.write(Buffer.from([5, 0]));
    }
    if (stage === 1 && buf.length >= 5) {
      let host, off;
      if (buf[3] === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
      else if (buf[3] === 3) { const l = buf[4]; if (buf.length < 7 + l) return; host = buf.subarray(5, 5 + l).toString(); off = 5 + l; }
      else return c.destroy();
      const port = buf.readUInt16BE(off);
      const rest = buf.subarray(off + 2);
      stage = 2;
      c.removeListener('data', onData);
      const up = net.connect(port, host, () => {
        up.setNoDelay(true);
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) up.write(rest);
        c.pipe(up); up.pipe(c);
      });
      up.on('error', () => c.destroy());
      c.on('close', () => up.destroy());
    }
  };
  c.on('data', onData);
}

net.createServer(handleTarget).listen(9001, '127.0.0.1');
net.createServer(handleSocks).listen(9002, '127.0.0.1');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const type = Number(u.searchParams.get('type'));
  const name = u.searchParams.get('name');
  const data = type === 28 ? '::1' : '127.0.0.1';
  res.setHeader('content-type', 'application/dns-json');
  res.end(JSON.stringify({ Status: 0, Answer: [{ name, type, TTL: 300, data }] }));
}).listen(9053, '127.0.0.1');
process.send && process.send('ready');
