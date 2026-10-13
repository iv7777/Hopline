#!/usr/bin/env node
// 构建脚本：把 src/ 下的源文件合并为两个可直接粘贴部署的单文件脚本
//
//   node build.mjs          生成 Hopline-proxy.js（代理）与 Hopline-panel.js（面板 + 订阅）
//   node build.mjs --check  仅校验这两个产物是否与 src/ 同步（CI 使用，不同步时退出码 1）
//
// 两个脚本互不依赖，各自由一个入口文件按 // @include worker/xxx.js 的清单拼接而成：
//   src/proxy-worker.js  代理：环境变量配置，只处理节点路径上的 WebSocket / XHTTP，其余返回伪装页
//   src/panel-worker.js  面板：登录、管理 API、订阅生成；面板页面、登录页与 Clash 模板内嵌在脚本里
// 处理流程：
//   1. 合并入口文件中的  // @include worker/xxx.js  （保持模块级顺序，保留注释与原始名称）
//   2. /* @inline 文件 */ '' 占位符替换为 String.raw 模板字符串：登录页、面板页面（HTML / CSS / JS 合并并按语言各自去掉注释，
//      保留 @HOPLINE_ 占位注释）和 Clash 配置模板
//   3. 顶部加一行版本横幅 /*!Hopline-proxy vX.Y.Z*/ / /*!Hopline-panel vX.Y.Z*/（各取自自己的 src/worker/version-proxy.js / version-panel.js 里的 VERSION：两个脚本各自编号、各自升版本）
//
// 产物不经压缩/重命名：内容即 src/ 原样拼接。代理脚本如需混淆发布，见 obfuscate.mjs（面板脚本不提供混淆版）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
// 两个产物：入口文件（src/ 下）→ 输出文件（仓库根目录）
export const TARGETS = {
  proxy: { entry: 'proxy-worker.js', out: 'Hopline-proxy.js', banner: 'Hopline-proxy', version: 'version-proxy.js' },
  panel: { entry: 'panel-worker.js', out: 'Hopline-panel.js', banner: 'Hopline-panel', version: 'version-panel.js' },
};
const KEEP_COMMENT = /@HOPLINE_/;          // 内联面板代码时唯一保留的注释（运行时占位符）

function read(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

// --- 去注释（保留 KEEP_COMMENT，其余原样保留空白与换行，不改变代码布局） -------------

// JavaScript：逐字符扫描，正确跳过字符串与正则字面量，避免误删其中的 // 与 /*
const REGEX_KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'else', 'do', 'yield', 'case', 'await']);
export function stripJsComments(code) {
  const n = code.length;
  let out = '', i = 0, prevChar = '', prevWord = '', word = '';
  const markWord = (ch) => {
    if (/[\w$]/.test(ch)) { word += ch; } else { if (word) prevWord = word; word = ''; }
    if (!/\s/.test(ch)) prevChar = ch;
  };
  const emit = (s) => { for (const ch of s) markWord(ch); out += s; };
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') {                       // 行注释
      let j = i + 2; while (j < n && code[j] !== '\n') j++;
      const text = code.slice(i, j);
      if (KEEP_COMMENT.test(text)) out += text;
      i = j; continue;
    }
    if (c === '/' && d === '*') {                       // 块注释
      let j = i + 2; while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      const text = code.slice(i, j);
      if (KEEP_COMMENT.test(text)) out += text;         // 占位注释原样保留（含紧邻的 null）
      i = j; continue;
    }
    if (c === '"' || c === "'") {                       // 字符串
      let j = i + 1;
      while (j < n) { const e = code[j]; if (e === '\\') { j += 2; continue; } if (e === c) { j++; break; } if (e === '\n') break; j++; }
      emit(code.slice(i, j)); i = j; continue;
    }
    if (c === '`') {                                    // 模板字符串（面板无，稳妥起见仍处理）
      let j = i + 1;
      while (j < n) { const e = code[j]; if (e === '\\') { j += 2; continue; } if (e === '`') { j++; break; } j++; }
      emit(code.slice(i, j)); i = j; continue;
    }
    if (c === '/') {                                    // 正则字面量 or 除号
      let valueEnding;
      if (/[)\]}]/.test(prevChar)) valueEnding = true;
      else if (/[\w$]/.test(prevChar)) valueEnding = !REGEX_KW.has(prevWord);
      else valueEnding = false;
      if (!valueEnding) {
        let j = i + 1, inClass = false;
        while (j < n) { const e = code[j]; if (e === '\\') { j += 2; continue; } if (e === '[') inClass = true; else if (e === ']') inClass = false; else if (e === '/' && !inClass) { j++; break; } else if (e === '\n') break; j++; }
        emit(code.slice(i, j)); i = j; continue;
      }
    }
    emit(c); i++;
  }
  return out;
}
function stripCssComments(code) { return code.replace(/\/\*[\s\S]*?\*\//g, ''); }
function stripHtmlComments(code) { return code.replace(/<!--[\s\S]*?-->/g, ''); }

// --- 面板文件：按扩展名去注释，再展开其中的 @include（子文件已按自身类型去注释） ----------
function loadPanel(file) {
  const dir = dirname(file);
  let text = read(file);
  if (file.endsWith('.js')) text = stripJsComments(text);
  else if (file.endsWith('.css')) text = stripCssComments(text);
  else if (file.endsWith('.html')) text = stripHtmlComments(text);
  return text.replace(/^[ \t]*@include[ \t]+(\S+)[ \t]*\n/gm, (_, name) => {
    const inc = join(dir, name);
    if (!existsSync(inc)) throw new Error(`${file}: @include 的文件不存在：${name}`);
    const child = loadPanel(inc);
    return child.endsWith('\n') ? child : child + '\n';
  });
}

// --- worker：按出现顺序拼接 // @include worker/xxx.js（保留注释与原始名称） -------
function expandWorker(text, file) {
  const dir = dirname(file);
  return text.replace(/^\/\/ @include[ \t]+(\S+)[ \t]*\n/gm, (_, name) => {
    const inc = join(dir, name);
    if (!existsSync(inc)) throw new Error(`${file}: @include 的文件不存在：${name}`);
    const t = expandWorker(read(inc), inc);
    return t.endsWith('\n') ? t : t + '\n';
  });
}

// 合并出某个目标的完整源码（保留 import / export 与 worker 注释；@inline 的内嵌内容已去注释）。这也是产物的内容（不含版本横幅）。
// 测试用它取内部纯函数（这些函数不对外导出，无法直接 import，需借 Function() 在作用域内求值取出）。
export function assemble(kind = 'panel') {
  const t = TARGETS[kind];
  if (!t) throw new Error('未知构建目标：' + kind);
  const entry = join(SRC, t.entry);
  const out = expandWorker(read(entry), entry)
    .replace(/\/\*\s*@inline\s+(\S+)\s*\*\/\s*''/g, (_, name) => {
      const text = loadPanel(join(SRC, name));
      if (text.includes('`')) throw new Error(`${name}: 内联内容不能包含反引号 \``);
      if (text.includes('${')) throw new Error(`${name}: 内联内容不能包含 \${`);
      return 'String.raw`\n' + text + '`';
    });
  if (/@inline/.test(out.replace(/\/\/.*$/gm, ''))) throw new Error(`${t.entry}: 存在未处理的 @inline 标记`);
  return out;
}

export function versionOf(kind = 'panel') {
  const file = join(SRC, 'worker', TARGETS[kind].version);
  const m = read(file).match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error(`未在 src/worker/${TARGETS[kind].version} 中找到 VERSION`);
  return m[1];
}

// 生成部署文件（CRLF，与仓库历史一致）：src/ 原样拼接，只加版本横幅，不做压缩/重命名
export function build(kind = 'panel') {
  const src = assemble(kind);
  const code = `/*!${TARGETS[kind].banner} v${versionOf(kind)}*/\n${src}`.replace(/\n+$/, '');
  return (code + '\n').replace(/\n/g, '\r\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const kinds = Object.keys(TARGETS);
  if (process.argv.includes('--check')) {
    const stale = kinds.filter((k) => {
      const f = join(ROOT, TARGETS[k].out);
      return (existsSync(f) ? readFileSync(f, 'utf8') : '') !== build(k);
    }).map((k) => TARGETS[k].out);
    if (stale.length) {
      console.error('构建产物与 src/ 不同步：请运行 `node build.mjs` 并提交生成结果。不同步的文件：' + stale.join('、'));
      process.exit(1);
    }
    console.log(kinds.map((k) => TARGETS[k].out).join('、') + ' 与 src/ 同步。');
  } else {
    for (const k of kinds) {
      const code = build(k);
      writeFileSync(join(ROOT, TARGETS[k].out), code);
      console.log(`已生成 ${TARGETS[k].out}（${code.length} 字符）`);
    }
  }
}
