import { spawn, fork } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import WebSocket from 'ws';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cpu = (pid) => { const f = readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8').split(') ')[1].split(' '); const ns = Number(readFileSync(`/proc/${pid}/task/${pid}/schedstat`, 'utf8').split(' ')[0]); return { main: ns / 1e6, user: f[11] * 10, sys: f[12] * 10 }; };
const t = fork(new URL('../target.mjs', import.meta.url).pathname); await new Promise(r => t.once('message', r));
const wd = spawn(new URL('../node_modules/@cloudflare/workerd-linux-64/bin/workerd', import.meta.url).pathname, ['serve', 'ref.capnp'], { cwd: new URL('.', import.meta.url).pathname, stdio: 'inherit' });
await sleep(1500);
const MB = 1048576, N = 64 * MB;
async function ws(mode) { const w = new WebSocket(`ws://127.0.0.1:8788/ws?mode=${mode}&n=${N}`, { perMessageDeflate: false }); let n = 0, m = 0; w.on('message', d => { n += d.length; m++; }); await new Promise(r => w.on('close', r)); return { bytes: n, msgs: m }; }
async function pipe() { return new Promise(r => http.get(`http://127.0.0.1:8788/pipe?n=${N}`, res => { let n = 0; res.on('data', d => n += d.length); res.on('end', () => r({ bytes: n })); })); }
const runs = { 'ws-byob': () => ws('byob'), 'ws-default': () => ws('default'), 'ws-nosend': () => ws('nosend'), 'http-pipe': pipe };
await ws('byob');
for (const [k, f] of Object.entries(runs)) for (let i = 0; i < 3; i++) {
  const c0 = cpu(wd.pid), t0 = performance.now(); const r = await f(); const wall = performance.now() - t0; await sleep(150); const c1 = cpu(wd.pid);
  console.log(k.padEnd(11), `main ${(c1.main - c0.main).toFixed(0)} ms (user ${c1.user - c0.user} sys ${c1.sys - c0.sys})  wall ${wall.toFixed(0)}  ${((c1.main - c0.main) / 64).toFixed(2)} ms/MB`, JSON.stringify(r));
}
wd.kill(); t.kill();
