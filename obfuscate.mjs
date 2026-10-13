#!/usr/bin/env node
// 在构建产物 Hopline-proxy.js 基础上做进一步混淆，生成 obf_Hopline-proxy.js（供不想直接公开可读源码的代理部署使用）。
//
//   node obfuscate.mjs      生成 obf_Hopline-proxy.js
//
// 说明：
//   - 只混淆代理脚本；面板脚本（Hopline-panel.js）不提供混淆版。
//   - 代理脚本整个就是 WebSocket / XHTTP 数据面（帧收发、出站读写循环、出站 SS 协议的 AEAD 实现），按请求 / 按帧反复执行；
//     字符串数组查表解密、控制流状态机分发等变换会直接体现为每次执行的 CPU 开销，在持续的代理连接下会触发
//     "Worker exceeded CPU time limit"。因此整份脚本只做零运行时成本的处理：压缩空白、局部变量 / 参数改名，
//     不加字符串数组、控制流平坦化、死代码注入等（不再有强度档位）。
//   - target 固定为 service-worker，selfDefending / debugProtection 固定关闭：
//     这两个特性依赖 `Function(...)` 构造动态代码来获取全局对象引用或反调试，
//     Cloudflare Workers 运行时默认禁止动态生成代码执行，开启会导致部署后直接报错或请求失败。
//   - 顶层函数 / 变量名一并改名（renameGlobals 开启；整份脚本一次处理，没有分段）；保留的只有 export default 与服务绑定入口类名 NodeStatus / NodeControl。
//   - 通过 npx 调用（与 `npm run lint` 使用 eslint 的方式一致），版本固定以保证可复现。
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OBFUSCATOR = 'javascript-obfuscator@4.2.2';   // 固定版本：保证不同机器 / CI 产出一致
const SRC = 'Hopline-proxy.js';
const OUT = 'obf_Hopline-proxy.js';

const OPTIONS = {
  compact: true,
  seed: 20260101,                           // 固定种子：同一份源码每次产出完全相同的混淆文件（CI 自动重新生成时不会产生无意义的差异提交）
  target: 'service-worker',
  identifierNamesGenerator: 'mangled-shuffled',
  renameGlobals: true,                      // 单文件处理：顶层函数 / 变量名一并改名
  reservedNames: ['^NodeStatus$', '^NodeControl$'],   // 服务绑定按名字找入口，导出的类名必须保留（default 导出不受影响）
  selfDefending: false,
  debugProtection: false,
  stringArray: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  splitStrings: false,
  numbersToExpressions: false,
  transformObjectKeys: false,
};

function runObfuscator(code, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'hopline-obf-'));
  try {
    const inp = join(dir, 'in.js');
    const cfg = join(dir, 'opts.json');
    const out = join(dir, 'out.js');
    writeFileSync(inp, code);
    writeFileSync(cfg, JSON.stringify(opts));
    execFileSync('npx', ['--yes', OBFUSCATOR, inp, '--config', cfg, '--output', out],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`未找到源文件：${SRC}（请先运行 node build.mjs）`);
    process.exit(1);
  }
  const code = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  if (!code.trim()) {
    console.error(`${SRC} 为空文件`);
    process.exit(1);
  }
  // 不加版本横幅：混淆版里没有任何明文标识（版本号只通过服务绑定的 status() 报告）
  writeFileSync(OUT, runObfuscator(code, OPTIONS), 'utf8');
  console.log(`已生成 ${OUT}（源：${SRC}）`);
}

main();
