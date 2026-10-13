// ---------------------------------------------------------------------------
// 控制接口：面板通过签名的 HTTPS 请求读写代理的状态（取代原来的服务绑定，面板与代理可以在不同账号里）
// ---------------------------------------------------------------------------
// 入口：POST /<PATH>/<标记>，标记由 NODE_KEY 派生（不知道密钥就找不到入口）。请求体是 JSON：
//   { ts, n, op, a, s }   ts 毫秒时间戳，n 一次性随机串，op 操作名，a 参数的 JSON 文本，s = HMAC-SHA256(NODE_KEY, ts.n.op.a)
// 任何一步不符（方法、体积、JSON、时间偏差、重放、签名）都返回与其它路径完全相同的伪装页，不泄露这里有入口。
// 操作只有两个：status（读状态摘要）与 setState（整份覆盖状态，a 就是状态的 JSON 原文）。
// 验证通过后返回 { ts, d, s }：d 是结果的 JSON 文本，s = HMAC-SHA256(NODE_KEY, ts.n.d)（绑定了请求的 n，面板据此确认回应来自持有密钥的一方）。
// 重放：时间偏差 CONTROL_SKEW_MS 内同一个 n 只接受一次（isolate 内存里记）；各操作都是幂等的，跨 isolate 的重放最多重复一次相同的写入。
const CONTROL_SKEW_MS = 30 * 1000;
const CONTROL_BODY_MAX = 16 * 1024;
const SEEN_NONCES = new Map();   // n → 过期时间

function seenNonce(n, now) {
  for (const [k, exp] of SEEN_NONCES) { if (exp > now) break; SEEN_NONCES.delete(k); }   // Map 按插入顺序，最先插入的最先过期
  if (SEEN_NONCES.has(n)) return true;
  SEEN_NONCES.set(n, now + 2 * CONTROL_SKEW_MS);
  while (SEEN_NONCES.size > 1000) SEEN_NONCES.delete(SEEN_NONCES.keys().next().value);
  return false;
}
async function runControlOp(env, op, raw) {
  switch (op) {
    case 'status': return nodeStatus(env);
    case 'setState': return setNodeState(env, raw);
  }
  return { ok: false, error: '未知操作' };
}
async function handleControl(request, env, base) {
  try {
    if (request.method !== 'POST') return stubPage();
    const raw = await request.text();
    if (raw.length > CONTROL_BODY_MAX) return stubPage();
    const m = JSON.parse(raw);
    if (!m || typeof m.ts !== 'number' || typeof m.n !== 'string' || typeof m.op !== 'string' || typeof m.a !== 'string' || typeof m.s !== 'string') return stubPage();
    if (m.n.length < 8 || m.n.length > 64 || m.op.length > 32) return stubPage();
    const now = Date.now();
    if (Math.abs(now - m.ts) > CONTROL_SKEW_MS) return stubPage();
    if (!timingSafeEqual(await hmacB64u(base.key, m.ts + '.' + m.n + '.' + m.op + '.' + m.a), m.s)) return stubPage();
    if (seenNonce(m.n, now)) return stubPage();
    const result = await runControlOp(env, m.op, m.a);
    const d = JSON.stringify(result), ts = Date.now();
    return new Response(JSON.stringify({ ts, d, s: await hmacB64u(base.key, ts + '.' + m.n + '.' + d) }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (e) { return stubPage(); }
}
