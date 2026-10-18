// 全速上传复现：按固定帧大小上传，报告每次隧道如何结束（关闭码 / 原因、目标是否收全）
//   RUNS=20 FRAMES=1024,16384 node upclose.mjs   （HOPLINE_REPO 同 run.mjs）
import { fork } from 'node:child_process';
import WebSocket from 'ws';
import * as h from './lib.mjs';
const wd = await h.startWorkerd('default');
const t = fork(new URL('./target.mjs', import.meta.url).pathname); await new Promise(r => t.once('message', r));
const uuid = Buffer.from('6f1c2a8e3b4d4e5f8a9b0c1d2e3f4a5b', 'hex');
for (const frame of (process.env.FRAMES || '1024,16384').split(',').map(Number)) for (let rep = 0; rep < Number(process.env.RUNS || 5); rep++) {
  const N = (frame === 1024 ? 16 : 64) * 1048576;
  const ws = new WebSocket('ws://127.0.0.1:8787/node', { perMessageDeflate: false });
  let sent = 0, got = 0;
  const closed = new Promise(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('message', d => got += d.length);
  await new Promise(r => ws.on('open', r));
  ws.send(Buffer.concat([Buffer.from([0]), uuid, Buffer.from([0, 1, 9001 >> 8, 9001 & 255, 1, 127, 0, 0, 1]), Buffer.from('UP ' + N + '\n')]));
  const c = Buffer.alloc(frame);
  for (; sent < N && ws.readyState === 1; sent += frame) { ws.send(c); while (ws.bufferedAmount > 1048576) await h.sleep(1); }
  const to = setTimeout(() => ws.terminate(), 5000);
  const res = await closed; clearTimeout(to);
  console.log(frame, rep, JSON.stringify({ ...res, sentMB: (sent / 1048576).toFixed(1), ok: got >= 5 }));
}
t.kill(); await h.stopProc(wd);
