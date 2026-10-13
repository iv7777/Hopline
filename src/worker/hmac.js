// ---------------------------------------------------------------------------
// HMAC-SHA256 与常量时间比较（面板与代理共用：面板签名控制请求，代理验证并签名回应）
// ---------------------------------------------------------------------------
function b64uOfBytes(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const HMAC_KEYS = new Map();   // 原始密钥字符串 → CryptoKey（至多缓存 4 个）
async function hmacB64u(keyStr, msg) {
  let k = HMAC_KEYS.get(keyStr);
  if (!k) {
    k = await crypto.subtle.importKey('raw', TE.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (HMAC_KEYS.size >= 4) HMAC_KEYS.clear();
    HMAC_KEYS.set(keyStr, k);
  }
  return b64uOfBytes(new Uint8Array(await crypto.subtle.sign('HMAC', k, TE.encode(msg))));
}
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let r = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}
// 控制请求的路径标记：由密钥派生，不知道密钥就找不到控制入口
async function routeTag(keyStr) { return (await hmacB64u(keyStr, 'route')).slice(0, 16); }
// 短哈希（SHA-256 前 4 字节的十六进制）：面板据此判断代理上保存的状态是否与自己下发的一致，而不必回传内容本身
async function shortHash(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', TE.encode(String(text))));
  return Array.from(d.subarray(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('');
}
