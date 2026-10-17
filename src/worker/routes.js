// ---------------------------------------------------------------------------
// 备用线路表：面板 KV 里的 routes（纯文本），所有代理共用；整张表随代理的状态下发（见 proxies.js 的 buildState）
// ---------------------------------------------------------------------------
// 直连不通（例如目标站同在 Cloudflare 上）时，代理把 TLS 流量交给备用线路（SNI 型透明转发，解析为非 Cloudflare IP 的域名）。
// 线路是第三方服务器，能看到目标域名与连接元数据；每个代理在「代理设置」里选用哪些、按什么顺序（默认 auto）。
const ROUTES_KEY = 'routes';
const DEFAULT_ALT_ROUTES = `# 备用线路表：每行「标签 域名[:端口] [txt]」，# 开头是注释。
# 标签 auto 保留给「按 Worker 机房自动选最近的地区」；HK / US / SG / JP / KR / DE / SE / NL / FI / GB 是自动选择会用到的地区标签。
# 末尾写 txt = 解析时先查这个域名的 TXT 记录（TXT 里放 IP 列表时用），默认只查 A 记录。
# 以下是社区提供的线路域名（解析为非 Cloudflare IP）。
HK proxyip.hk.cmliussss.net
US proxyip.us.cmliussss.net
SG proxyip.sg.cmliussss.net
JP proxyip.jp.cmliussss.net
KR proxyip.kr.cmliussss.net
DE proxyip.de.cmliussss.net
SE proxyip.se.cmliussss.net
NL proxyip.nl.cmliussss.net
FI proxyip.fi.cmliussss.net
GB proxyip.gb.cmliussss.net
Oracle proxyip.oracle.cmliussss.net
DigitalOcean proxyip.digitalocean.cmliussss.net
Vultr proxyip.vultr.cmliussss.net
Multacom proxyip.multacom.cmliussss.net
`;

// 读取线路表文本：没保存过就是默认表；返回 { text, error }（error：'unavailable' 时不能保存）
async function readRoutes(env) {
  const kv = kvStore(env);
  if (!kv || typeof kv.get !== 'function') return { text: DEFAULT_ALT_ROUTES, error: '' };
  try {
    const raw = await kv.get(ROUTES_KEY, { cacheTtl: 30 });
    return { text: raw == null ? DEFAULT_ALT_ROUTES : raw, error: '' };
  } catch (e) { return { text: DEFAULT_ALT_ROUTES, error: 'unavailable' }; }
}
async function saveRoutes(env, text) {
  const kv = kvStore(env);
  if (!kv || typeof kv.put !== 'function') throw new Error('未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存线路表');
  await kv.put(ROUTES_KEY, text);
}
