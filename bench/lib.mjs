// 代理 CPU 基准测试的公共部分：启动 workerd、从 /proc 读 CPU、VLESS-over-WebSocket 与 XHTTP 客户端。run.mjs / profile.mjs / upclose.mjs 共用
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import WebSocket from 'ws';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(process.env.HOPLINE_REPO || join(HERE, '..'));
const WORKERD = join(HERE, 'node_modules/@cloudflare/workerd-linux-64/bin/workerd');
export const MB = 1024 * 1024;
const HTTP_PORT = 8787, HTTPS_PORT = 8443, TARGET_PORT = 9001;
const UUID = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const NODE_KEY = 'bench-node-key-0123456789abcdef';
export const NODE_PATH = 'node';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK_MS = 1000 / 100;   // /proc/<pid>/stat 的时间单位（USER_HZ = 100）

// ---------------------------------------------------------------------------- 状态配置（面板会下发的几种状态）
const baseState = { uuids: [[UUID, 0]], enabled: true, edgeIP: '', hop: null, hopMode: '', altTable: {}, altPick: [] };
export const PROFILE_DEFS = {
  default: { script: 'Hopline-proxy.js', state: baseState },
  obf: { script: 'obf_Hopline-proxy.js', state: baseState },
  // 接近面板默认：开启备用线路，按机房选（cf.colo = SJC → US，再补 SG / JP / KR）
  alt: { script: 'Hopline-proxy.js', state: { ...baseState, altTable: { US: { host: 'alt-us.test', port: TARGET_PORT }, SG: { host: 'alt-sg.test', port: TARGET_PORT }, JP: { host: 'alt-jp.test', port: TARGET_PORT } }, altPick: ['auto'] } },
  hop: { script: 'Hopline-proxy.js', state: { ...baseState, hop: { type: 'socks5', host: '127.0.0.1', port: 9002 } } },
  edge: { script: 'Hopline-proxy.js', state: { ...baseState, edgeIP: '127.0.0.1:' + TARGET_PORT } },
};

// ---------------------------------------------------------------------------- workerd
function capnp(state) {
  const q = (s) => JSON.stringify(s);
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .w),
    (name = "net", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${HTTP_PORT}", http = (forwardedProtoHeader = "X-Forwarded-Proto", cfBlobHeader = "CF-Blob"), service = "main"),
    (name = "https", address = "127.0.0.1:${HTTPS_PORT}", https = (options = (cfBlobHeader = "CF-Blob"), tlsOptions = (keypair = (privateKey = embed "../key.pem", certificateChain = embed "../cert.pem"))), service = "main"),
  ],
);
const w :Workerd.Worker = (
  modules = [
    (name = "wrapper.js", esModule = embed "../wrapper.js"),
    (name = "proxy.js", esModule = embed "proxy.js"),
  ],
  compatibilityDate = "2025-09-01",
  bindings = [
    (name = "PATH", text = ${q(NODE_PATH)}),
    (name = "NODE_KEY", text = ${q(NODE_KEY)}),
    (name = "STATE_JSON", text = ${q(JSON.stringify(state))}),
  ],
  globalOutbound = "net",
);
`;
}

export async function startWorkerd(profile, extraArgs = []) {
  const def = PROFILE_DEFS[profile];
  mkdirSync(join(HERE, 'gen'), { recursive: true });
  // https 监听用的自签证书（wss-* 场景）
  if (!existsSync(join(HERE, 'key.pem'))) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '365', '-subj', '/CN=localhost'], { cwd: HERE, stdio: 'ignore' });
  let src = readFileSync(resolve(REPO, def.script), 'utf8');
  for (const u of ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve', 'https://dns.alidns.com/resolve', 'https://doh.pub/dns-query']) {
    src = src.split(u).join('http://127.0.0.1:9053/dns-query');
  }
  writeFileSync(join(HERE, 'gen/proxy.js'), src);
  writeFileSync(join(HERE, 'gen/config.capnp'), capnp(def.state));
  const proc = spawn(WORKERD, ['serve', 'gen/config.capnp', '--experimental', ...extraArgs], { cwd: HERE, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 100; i++) {
    if (await portOpen(HTTP_PORT)) return proc;
    if (proc.exitCode != null) throw new Error('workerd exited: ' + err);
    await sleep(100);
  }
  throw new Error('workerd did not start: ' + err);
}
const portOpen = (port) => new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
export async function stopProc(p) { if (!p || p.exitCode != null) return; p.kill('SIGTERM'); for (let i = 0; i < 30 && p.exitCode == null; i++) await sleep(50); if (p.exitCode == null) p.kill('SIGKILL'); }

// ---------------------------------------------------------------------------- CPU 采样
export function cpuOf(pid) {
  let total = 0, main = 0;
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const ns = Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, 'utf8').split(' ')[0]);
      total += ns; if (Number(tid) === pid) main = ns;
    } catch (e) { /* thread exited */ }
  }
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return { total: total / 1e6, main: main / 1e6, user: Number(f[11]) * TICK_MS, sys: Number(f[12]) * TICK_MS };
}

// ---------------------------------------------------------------------------- VLESS 客户端
const UUID_BYTES = Buffer.from(UUID.replace(/-/g, ''), 'hex');
function vlessHeader(cmd = 1, port = TARGET_PORT, uuid = UUID_BYTES) {
  return Buffer.concat([Buffer.from([0]), uuid, Buffer.from([0, cmd, port >> 8, port & 255, 1, 127, 0, 0, 1])]);
}
const TLS_PREFIX = Buffer.from([0x16, 0x03, 0x01]);
const cmdPayload = (line, tls) => Buffer.concat([tls ? TLS_PREFIX : Buffer.alloc(0), Buffer.from(line + '\n')]);

// 一条隧道：{ send(buf), recv(n)（收满 n 字节后返回）, waitClose(), close() }；只计数据字节（跳过 2 字节 VLESS 响应头）
function tunnelState() {
  let got = 0, skip = 2, waiters = [], closed = false, closeWaiters = [];
  return {
    get got() { return got; },
    push(buf) {
      let n = buf.length;
      if (skip) { const s = Math.min(skip, n); skip -= s; n -= s; }
      got += n;
      waiters = waiters.filter((w) => { if (got >= w.n) { w.r(); return false; } return true; });
    },
    recv(n) { return got >= n || closed ? Promise.resolve() : new Promise((r) => waiters.push({ n, r })); },
    end() { closed = true; waiters.forEach((w) => w.r()); waiters = []; closeWaiters.forEach((r) => r()); },
    waitClose() { return closed ? Promise.resolve() : new Promise((r) => closeWaiters.push(r)); },
  };
}

function openWs({ first, early = false, deflate = false, wss = false, protocols } = {}) {
  return new Promise((resolve, reject) => {
    const st = tunnelState();
    const url = (wss ? 'wss' : 'ws') + `://127.0.0.1:${wss ? HTTPS_PORT : HTTP_PORT}/${NODE_PATH}`;
    const headers = { 'CF-Blob': '{"colo":"SJC"}' };
    // 0-RTT：手动设置请求头。若作为子协议传入，ws 客户端会要求服务端回显，而代理（与 xray 一样）不回显
    if (early && first) headers['Sec-WebSocket-Protocol'] = first.toString('base64url');
    const ws = new WebSocket(url, protocols, { perMessageDeflate: deflate, headers, rejectUnauthorized: false, maxPayload: 0 });
    ws.binaryType = 'nodebuffer';
    ws.on('message', (d) => st.push(d));
    ws.on('close', () => st.end());
    ws.on('error', (e) => { st.end(); reject(e); });
    ws.on('open', () => {
      if (first && !early) ws.send(first);
      resolve({
        st,
        send: (b) => ws.send(b),
        drain: async () => { while (ws.bufferedAmount > 1 * MB) await sleep(1); },
        close: () => { try { ws.close(); } catch (e) { /* ignore */ } },
        ws,
      });
    });
  });
}

const xhtAgent = new http.Agent({ keepAlive: false });
function openXht({ first }) {
  return new Promise((resolve, reject) => {
    const st = tunnelState();
    const req = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: '/' + NODE_PATH, method: 'POST', agent: xhtAgent,
      headers: { 'X-Forwarded-Proto': 'https', 'content-type': 'application/grpc', 'CF-Blob': '{"colo":"SJC"}' } });
    req.on('error', (e) => { st.end(); reject(e); });
    req.on('response', (res) => {
      res.on('data', (d) => st.push(d));
      res.on('end', () => st.end());
      res.on('error', () => st.end());
    });
    req.flushHeaders();
    req.write(first);
    resolve({
      st,
      send: (b) => req.write(b),
      drain: () => (req.writableNeedDrain ? new Promise((r) => req.once('drain', r)) : Promise.resolve()),
      close: () => { try { req.end(); } catch (e) { /* ignore */ } try { req.destroy(); } catch (e) { /* ignore */ } },
    });
  });
}

const open = (kind, first, opts = {}) => (kind === 'xht' ? openXht({ first, ...opts }) : openWs({ first, ...opts }));

export async function setupOnce(kind, opts) {
  const t = await open(kind, Buffer.concat([vlessHeader(), cmdPayload('ECHO', opts.tls)]), opts);
  await t.st.recv(3);
  if (t.st.got < 3) throw new Error('setup: no reply');
  t.close();
  await t.st.waitClose();
}
export async function setupNoPayload() {
  const t = await openWs({ first: vlessHeader() });
  await sleep(0);
  t.send(cmdPayload('ECHO'));   // 作为第二帧到达，通常落在 80ms 的首包等待窗口内
  await t.st.recv(3);
  t.close(); await t.st.waitClose();
}
export async function down(kind, bytes, opts = {}) {
  const t = await open(kind, Buffer.concat([vlessHeader(), cmdPayload('DOWN ' + bytes, opts.tls)]), opts);
  await t.st.recv(bytes);
  if (t.st.got < bytes) throw new Error(`down: got ${t.st.got} of ${bytes}`);
  t.close(); await t.st.waitClose();
}
export async function up(kind, bytes, frame, opts = {}) {
  const t = await open(kind, Buffer.concat([vlessHeader(), cmdPayload('UP ' + bytes)]), opts);
  const chunk = Buffer.alloc(frame, 0x62);
  for (let sent = 0; sent < bytes; sent += frame) { t.send(chunk); await t.drain(); }
  await t.st.recv(3);
  if (t.st.got < 3) throw new Error('up: no OK');
  t.close(); await t.st.waitClose();
}
export async function ping(kind, count, size, opts = {}) {
  const t = await open(kind, Buffer.concat([vlessHeader(), cmdPayload(`PING ${count} ${size}`)]), opts);
  await t.st.recv(3);
  const one = Buffer.from([1]);
  for (let i = 1; i <= count; i++) { t.send(one); await t.st.recv(3 + i * size); }
  if (t.st.got < 3 + count * size) throw new Error('ping: short');
  t.close(); await t.st.waitClose();
}
export async function dnsConn(queries) {
  const frames = [];
  for (let i = 0; i < queries; i++) {
    const name = `host${i}.example.com`;
    const q = [Buffer.from([0x12, i, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])];
    for (const l of name.split('.')) q.push(Buffer.from([l.length]), Buffer.from(l));
    q.push(Buffer.from([0, 0, 1, 0, 1]));
    const pkt = Buffer.concat(q);
    frames.push(Buffer.from([pkt.length >> 8, pkt.length & 255]), pkt);
  }
  const t = await openWs({ first: Buffer.concat([vlessHeader(2, 53), ...frames]) });
  await t.st.waitClose();   // 代理应答满 DNS_PER_CONN 个后关闭连接
  if (t.st.got < queries * 20) throw new Error('dns: only ' + t.st.got + ' bytes');
}
export async function badUuid() {
  const t = await openWs({ first: Buffer.concat([vlessHeader(1, TARGET_PORT, randomBytes(16)), cmdPayload('ECHO')]) });
  await t.st.waitClose();
}
export async function httpReq(path, { method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${path}`, { method, body, headers: { 'X-Forwarded-Proto': 'https' } });
  return res.text();
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (msg) => b64u(createHmac('sha256', NODE_KEY).update(msg).digest());
const ROUTE_TAG = hmac('route').slice(0, 16);
export async function controlStatus() {
  const ts = Date.now(), n = randomUUID(), op = 'status', a = '';
  const out = await httpReq(`/${NODE_PATH}/${ROUTE_TAG}`, { method: 'POST', body: JSON.stringify({ ts, n, op, a, s: hmac(`${ts}.${n}.${op}.${a}`) }) });
  if (!out.includes('"d"')) throw new Error('control: ' + out.slice(0, 80));
}
export async function pool(n, conc, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (next < n) { next++; await fn(); } }));
}
export async function idleConns(n, ms) {
  const ts = [];
  await pool(n, 20, async () => { const t = await openWs({ first: Buffer.concat([vlessHeader(), cmdPayload('HOLD')]) }); await t.st.recv(3); ts.push(t); });
  return { ts, hold: () => sleep(ms) };
}


export async function warmup() {
  await httpReq('/' + NODE_PATH);
  await pool(20, 5, () => setupOnce('ws', { tls: true }));
  await down('ws', 4 * MB);
}
export const WORKLOADS = {
  'ws-setup': () => pool(500, 10, () => setupOnce('ws', {})),
  'ws-setup-tls': () => pool(500, 10, () => setupOnce('ws', { tls: true })),
  'ws-down': () => down('ws', 64 * MB),
  'ws-up': () => up('ws', 64 * MB, 16 * 1024),
  'ws-up-1k': () => up('ws', 16 * MB, 1024),
  'ws-ping': () => ping('ws', 5000, 512),
  'xht-setup': () => pool(500, 10, () => setupOnce('xht', {})),
  'xht-up': () => up('xht', 64 * MB, 16 * 1024),
  stub: () => pool(2000, 8, () => httpReq('/')),
  control: () => pool(500, 8, controlStatus),
  dns: () => pool(50, 5, () => dnsConn(20)),
};
