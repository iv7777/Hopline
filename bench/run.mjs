#!/usr/bin/env node
// Hopline 代理 CPU 基准测试
//
// 在真实的 workerd 里运行 Hopline-proxy.js（只把 DoH 地址换成本地桩），用 VLESS-over-WebSocket 与 XHTTP 客户端施加负载，
// 每个场景前后从 /proc 读取 workerd 进程的 CPU 时间。客户端与上游都在别的进程里，所以数字只含运行时 + 脚本的开销。
//
//   node run.mjs [--reps 5] [--only 场景,场景] [--profile default,obf,...] [--out results.json]
//   （默认测仓库根目录的脚本；HOPLINE_REPO=<目录> 可指定别的目录）
//
// CPU 取自 /proc/<pid>/task/*/schedstat（纳秒，所有线程）与 /proc/<pid>/stat（用户 / 内核 tick）。
// main 是 workerd 主线程，即运行 isolate 的线程：本地最接近 Cloudflare 按请求计的 CPU 时间
import { fork } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus } from 'node:os';
import { HERE, REPO, MB, sleep, PROFILE_DEFS, NODE_PATH, startWorkerd, stopProc, cpuOf, warmup,
  setupOnce, setupNoPayload, down, up, ping, dnsConn, badUuid, httpReq, controlStatus, pool, idleConns } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]]) : a), []));
const REPS = Number(args.reps || 5);
const ONLY = args.only ? String(args.only).split(',') : null;
const PROFILES = args.profile ? String(args.profile).split(',') : null;
const OUT = resolve(args.out || join(HERE, 'results.json'));
// ---------------------------------------------------------------------------- 场景
// run() 在计时窗口内执行；unit / units 用于把 CPU 折算成每请求 / 每连接 / 每 MB；setup() / teardown() 在窗口外执行
const S = [];
const sc = (profile, name, desc, units, unit, run, extra = {}) => S.push({ profile, name, desc, units, unit, run, ...extra });
const DOWN = 64 * MB, UP = 64 * MB;

sc('default', 'idle', 'workerd with the proxy loaded, no traffic, 10 s', 10, 's', () => sleep(10000));
sc('default', 'stub-get', 'GET / (decoy page, no KV read)', 2000, 'req', () => pool(2000, 8, () => httpReq('/')));
sc('default', 'node-get', 'GET /node (KV state read, then decoy page)', 2000, 'req', () => pool(2000, 8, () => httpReq('/' + NODE_PATH)));
sc('default', 'control-status', 'signed control request: op=status (HMAC verify + sign)', 500, 'req', () => pool(500, 8, controlStatus));
sc('default', 'ws-bad-uuid', 'WS probe with a wrong UUID (rejected)', 500, 'conn', () => pool(500, 10, badUuid));
sc('default', 'ws-setup-plain', 'WS connect + VLESS header + non-TLS first payload, echo, close', 500, 'conn', () => pool(500, 10, () => setupOnce('ws', {})));
sc('default', 'ws-setup-tls', 'same, first payload looks like a TLS ClientHello', 500, 'conn', () => pool(500, 10, () => setupOnce('ws', { tls: true })));
sc('default', 'ws-setup-early', 'same, header + payload as 0-RTT early data (Sec-WebSocket-Protocol)', 500, 'conn', () => pool(500, 10, () => setupOnce('ws', { early: true })));
sc('default', 'ws-setup-split', 'header frame first, payload in a second frame', 300, 'conn', () => pool(300, 10, setupNoPayload));
sc('default', 'ws-down', 'WS downlink 64 MB, one connection', DOWN / MB, 'MB', () => down('ws', DOWN));
sc('default', 'ws-down-deflate', 'WS downlink 64 MB, client offers permessage-deflate', DOWN / MB, 'MB', () => down('ws', DOWN, { deflate: true }));
sc('default', 'ws-up-16k', 'WS uplink 64 MB in 16 KB frames', UP / MB, 'MB', () => up('ws', UP, 16 * 1024));
sc('default', 'ws-up-1k', 'WS uplink 16 MB in 1 KB frames', 16, 'MB', () => up('ws', 16 * MB, 1024));
sc('default', 'ws-ping', 'WS interactive: 5000 round trips (1 B up, 512 B down)', 5000, 'rt', () => ping('ws', 5000, 512));
sc('default', 'ws-conc-down', 'WS downlink, 100 concurrent connections x 1 MB', 100, 'MB', () => pool(100, 100, () => down('ws', MB)));
sc('default', 'ws-idle-conns', '200 open, idle WS tunnels held for 10 s (setup excluded)', 200, 'conn', null, {
  setup: () => idleConns(200, 10000), runWith: (ctx) => ctx.hold(), teardown: async (ctx) => { ctx.ts.forEach((t) => t.close()); await sleep(500); } });
sc('default', 'ws-dns', 'UDP-DNS over WS: 50 connections x 20 queries via DoH', 1000, 'query', () => pool(50, 5, () => dnsConn(20)));
sc('default', 'xht-setup', 'XHTTP POST + VLESS header + payload, echo, close', 500, 'conn', () => pool(500, 10, () => setupOnce('xht', {})));
sc('default', 'xht-down', 'XHTTP downlink 64 MB', DOWN / MB, 'MB', () => down('xht', DOWN));
sc('default', 'xht-up', 'XHTTP uplink 64 MB', UP / MB, 'MB', () => up('xht', UP, 16 * 1024));
sc('default', 'xht-ping', 'XHTTP interactive: 5000 round trips (1 B up, 512 B down)', 5000, 'rt', () => ping('xht', 5000, 512));
sc('default', 'wss-setup', 'WS setup over TLS to workerd (runtime TLS; Cloudflare terminates TLS before the Worker)', 300, 'conn', () => pool(300, 10, () => setupOnce('ws', { tls: true, wss: true })));
sc('default', 'wss-down', 'WS downlink 64 MB over TLS to workerd (runtime TLS)', DOWN / MB, 'MB', () => down('ws', DOWN, { wss: true }));

sc('alt', 'alt-ws-setup-plain', 'alt lines on: non-TLS payload (alt lines skipped)', 300, 'conn', () => pool(300, 10, () => setupOnce('ws', {})));
sc('alt', 'alt-ws-setup-tls', 'alt lines on: TLS payload (direct ∥ 3 alt lines race + first-byte watchdog)', 300, 'conn', () => pool(300, 10, () => setupOnce('ws', { tls: true })));
sc('alt', 'alt-ws-down-tls', 'alt lines on: WS downlink 64 MB, TLS payload', DOWN / MB, 'MB', () => down('ws', DOWN, { tls: true }));
sc('hop', 'hop-ws-setup', 'SOCKS5 outbound: WS setup', 300, 'conn', () => pool(300, 10, () => setupOnce('ws', {})));
sc('hop', 'hop-ws-down', 'SOCKS5 outbound: WS downlink 64 MB', DOWN / MB, 'MB', () => down('ws', DOWN));
sc('edge', 'edge-ws-setup-tls', 'landing IP (edgeIP) set: WS setup, TLS payload', 300, 'conn', () => pool(300, 10, () => setupOnce('ws', { tls: true })));
sc('obf', 'obf-ws-setup-plain', 'obfuscated script: WS setup', 500, 'conn', () => pool(500, 10, () => setupOnce('ws', {})));
sc('obf', 'obf-ws-down', 'obfuscated script: WS downlink 64 MB', DOWN / MB, 'MB', () => down('ws', DOWN));
sc('obf', 'obf-ws-ping', 'obfuscated script: 5000 round trips', 5000, 'rt', () => ping('ws', 5000, 512));

// ---------------------------------------------------------------------------- 主流程
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };
async function measure(pid, s) {
  const reps = s.name === 'idle' ? 1 : REPS;
  const samples = [];
  for (let r = 0; r < reps; r++) {
    const ctx = s.setup ? await s.setup() : null;
    await sleep(300);
    const c0 = cpuOf(pid), t0 = performance.now();
    if (s.runWith) await s.runWith(ctx); else await s.run();
    const wall = performance.now() - t0;
    await sleep(150);   // 让关闭 / 清理等收尾工作计入本窗口
    const c1 = cpuOf(pid);
    if (s.teardown) await s.teardown(ctx);
    const d = { wallMs: wall, mainMs: c1.main - c0.main, totalMs: c1.total - c0.total, userMs: c1.user - c0.user, sysMs: c1.sys - c0.sys };
    samples.push(d);
  }
  const m = (k) => median(samples.map((x) => x[k]));
  const out = { profile: s.profile, name: s.name, desc: s.desc, unit: s.unit, units: s.units, reps,
    wallMs: m('wallMs'), mainMs: m('mainMs'), totalMs: m('totalMs'), userMs: m('userMs'), sysMs: m('sysMs'),
    mainPerUnit: m('mainMs') / s.units, totalPerUnit: m('totalMs') / s.units, samples };
  return out;
}

const target = fork(join(HERE, 'target.mjs'), [], { stdio: 'inherit' });
await new Promise((r) => target.once('message', r));
const results = existsSync(OUT) && (ONLY || PROFILES) ? JSON.parse(readFileSync(OUT, 'utf8')) : { env: {}, results: [] };
results.env = { node: process.version, workerd: readFileSync(join(HERE, 'node_modules/workerd/package.json'), 'utf8').match(/"version":\s*"([^"]+)"/)[1],
  cpus: cpus()[0].model + ' x' + cpus().length, date: new Date().toISOString(), reps: REPS };
try {
  for (const profile of Object.keys(PROFILE_DEFS)) {
    if (PROFILES && !PROFILES.includes(profile)) continue;
    const list = S.filter((s) => s.profile === profile && (!ONLY || ONLY.includes(s.name)));
    if (!list.length) continue;
    const wd = await startWorkerd(profile);
    try {
      // 预热：编译脚本，填好 KV 状态缓存与 DoH 缓存
      await warmup();
      for (const s of list) {
        let r;
        try { r = await measure(wd.pid, s); }
        catch (e) { r = { profile, name: s.name, desc: s.desc, error: String(e && e.message || e) }; }
        results.results = results.results.filter((x) => x.name !== s.name).concat([r]);
        console.log(r.error ? `${s.name}: ERROR ${r.error}` :
          `${s.name.padEnd(20)} main ${r.mainMs.toFixed(1).padStart(8)} ms  all ${r.totalMs.toFixed(1).padStart(8)} ms  wall ${r.wallMs.toFixed(0).padStart(6)} ms  → ${r.mainPerUnit.toFixed(3)} ms/${s.unit} (main)`);
        writeFileSync(OUT, JSON.stringify(results, null, 2));
      }
    } finally { await stopProc(wd); }
  }
} finally { target.kill(); }
