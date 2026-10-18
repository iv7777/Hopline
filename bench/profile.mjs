#!/usr/bin/env node
// 经 workerd 的 inspector 对代理 isolate 做 V8 CPU 采样（一个负载）：
//   node profile.mjs <负载> [--profile default]
// 负载见 lib.mjs 的 WORKLOADS（ws-setup、ws-down、ws-up-1k、ws-ping、xht-setup、stub、control、dns 等）
// 打印按函数统计的自身耗时（前 25），并写出 gen/<负载>.cpuprofile（可在 Chrome DevTools 打开）
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const HERE = new URL('.', import.meta.url).pathname;
const workload = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = await import(join(HERE, 'lib.mjs'));
const wd = await h.startWorkerd(process.argv.includes('--profile') ? process.argv[process.argv.indexOf('--profile') + 1] : 'default', ['--inspector-addr=127.0.0.1:9229']);
const target = fork(join(HERE, 'target.mjs'), [], { stdio: 'inherit' });
await new Promise((r) => target.once('message', r));
try {
  await h.warmup();
  const cdp = new WebSocket('ws://127.0.0.1:9229/main');
  await new Promise((r, j) => { cdp.on('open', r); cdp.on('error', j); });
  let id = 0; const pend = new Map();
  cdp.on('message', (m) => { const o = JSON.parse(m); if (o.id && pend.has(o.id)) { pend.get(o.id)(o.result); pend.delete(o.id); } });
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); });
  await call('Profiler.enable');
  await call('Profiler.setSamplingInterval', { interval: 50 });
  await call('Profiler.start');
  await h.WORKLOADS[workload]();
  await sleep(200);
  const { profile } = await call('Profiler.stop');
  writeFileSync(join(HERE, 'gen', workload + '.cpuprofile'), JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]); const dt = (profile.timeDeltas[i] || 0) / 1000;
    const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${cf.url ? cf.url.split('/').pop() + ':' + (cf.lineNumber + 1) : ''}`.trim();
    self.set(key, (self.get(key) || 0) + dt);
    if (cf.functionName !== '(idle)') total += dt;
  }
  console.log(`${workload}: ${total.toFixed(1)} ms sampled outside (idle)`);
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(v.toFixed(1).padStart(8), 'ms', k);
  cdp.close();
} finally { target.kill(); await h.stopProc(wd); }
