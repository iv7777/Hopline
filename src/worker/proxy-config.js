// ---------------------------------------------------------------------------
// 代理配置：环境变量只有两项必填，其余全部由面板在线下发
//   PATH       【必填】节点路径（WebSocket / XHTTP 共用）
//   NODE_KEY   【必填】控制密钥（至少 24 位随机字符）：面板用它给控制请求签名，也决定控制入口的路径
// UUID 不再来自环境变量：由面板生成并通过控制接口下发，保存在 NODE_KV 里（见 proxy-settings.js）；
// 面板还没下发 UUID（或代理被停用）时，节点路径上的请求和其它任何路径一样只返回伪装页。
// 下面这些运行设置也可以用环境变量给出默认值（面板里在线保存的设置优先于它们）：
//   EDGEIP      反代 / 落地 IP（host 或 host:port）
//   HOP_ADDR    出站代理（socks5:// / http(s):// / ss:// 或 host:port）
//   HOP_MODE    出站方式：留空 = 出站代理优先；no = 直连优先；only = 仅走出站代理
//   ALT_MODE    地区反代：builtin（默认，按机房自动选地区）/ custom / off
//   ALT_REGION  builtin 的首选地区（留空按机房自动选）
//   ALT_REGION2 builtin 的次选地区（留空自动；none = 不用）
//   ALT_CUSTOM  custom 的反代列表（最多 3 个 host[:port]，换行 / 逗号分隔）
// 无效取值按默认值处理。
// ---------------------------------------------------------------------------
const NODE_PATH_RE = /^[A-Za-z0-9._~-]+$/;
const NODE_KEY_MIN = 24;
const ALT_CUSTOM_MAX = 3;   // 自定义反代最多 3 个：与直连并发竞速，受 Workers 6 个同时出站连接的限制

function nodeConfig(env) {
  const str = (k) => (env && env[k] != null ? String(env[k]).trim() : '');
  const cfg = {
    path: '', key: '', uuids: [], enabled: true, edgeIP: str('EDGEIP'), hopAddr: str('HOP_ADDR'), hopMode: '',
    alt: { mode: 'builtin', region: '', region2: '', custom: '' },
    _problems: [],
  };
  const path = str('PATH').replace(/^\/+/, '').replace(/\/+$/, '');
  if (path && NODE_PATH_RE.test(path) && path.length <= 128) cfg.path = path;
  else cfg._problems.push(path ? '环境变量 PATH 的值不正确：只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位。' : '请设置环境变量 PATH（节点的访问路径，如 mynode）。');
  const key = str('NODE_KEY');
  if (key.length >= NODE_KEY_MIN && key.length <= 256 && /^[\x21-\x7e]+$/.test(key)) cfg.key = key;
  else cfg._problems.push(key ? '环境变量 NODE_KEY 的值不正确：至少 ' + NODE_KEY_MIN + ' 位，只能是可见的 ASCII 字符（面板里可以点「生成密钥」）。' : '请设置环境变量 NODE_KEY（控制密钥，至少 ' + NODE_KEY_MIN + ' 位随机字符，与面板里填写的密钥一致）。');
  const mode = str('HOP_MODE').toLowerCase();
  if (mode === 'no' || mode === 'only') cfg.hopMode = mode;
  const rmode = str('ALT_MODE').toLowerCase();
  if (rmode === 'custom' || rmode === 'off') cfg.alt.mode = rmode;
  const regionOf = (v, extra) => {
    const k = Object.keys(ALT_DOMAINS).find(x => x.toLowerCase() === v.toLowerCase());
    return k || (extra && v.toLowerCase() === extra ? extra : '');
  };
  cfg.alt.region = regionOf(str('ALT_REGION'));
  cfg.alt.region2 = regionOf(str('ALT_REGION2'), 'none');
  cfg.alt.custom = str('ALT_CUSTOM').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).slice(0, ALT_CUSTOM_MAX).join('\n');
  return cfg;
}
