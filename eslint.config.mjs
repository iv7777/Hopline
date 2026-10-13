// 零依赖项目的轻量静态检查（只抓真正的错误：未定义变量、重复键、不可达代码等），CI 与 `npm run lint` 使用
const common = {
  ecmaVersion: 2022,
  sourceType: 'script',
};
const rules = {
  'no-undef': 'error', 'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-redeclare': 'error', 'no-unreachable': 'error',
  'no-const-assign': 'error', 'no-func-assign': 'error', 'no-self-assign': 'error', 'no-unsafe-finally': 'error',
  'no-cond-assign': ['error', 'except-parens'], 'no-dupe-else-if': 'error', 'no-duplicate-case': 'error', 'no-fallthrough': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
};
const workerGlobals = {
  crypto: 'readonly', fetch: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly', URL: 'readonly',
  URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
  caches: 'readonly', ReadableStream: 'readonly', WritableStream: 'readonly', TransformStream: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', atob: 'readonly', btoa: 'readonly',
};
export default [
  {   // 构建产物：Cloudflare Workers 运行时（分别检查：任一脚本引用了另一个脚本才有的名字都会报 no-undef）
    files: ['Hopline-proxy.js'],
    languageOptions: { ...common, sourceType: 'module', globals: { ...workerGlobals, WebSocketPair: 'readonly', IdentityTransformStream: 'readonly' } },
    rules,
  },
  {
    files: ['Hopline-panel.js'],
    languageOptions: { ...common, sourceType: 'module', globals: workerGlobals },
    rules,
  },
  {   // 面板脚本：浏览器环境（SCHEMA / sharedCheck 由服务端下发页面时注入，qrcode 来自 CDN 脚本）
    files: ['src/panel/panel.js'],
    languageOptions: { ...common, globals: {
      window: 'readonly', document: 'readonly', location: 'readonly', navigator: 'readonly', localStorage: 'readonly',
      fetch: 'readonly', confirm: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', FileReader: 'readonly',
      crypto: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', atob: 'readonly', qrcode: 'readonly',
    } },
    rules: { ...rules, 'no-unused-vars': 'off' },   // 面板函数由 HTML 内联事件调用，无法静态判断是否使用
  },
];
