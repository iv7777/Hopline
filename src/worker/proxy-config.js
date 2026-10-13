// ---------------------------------------------------------------------------
// 代理配置：来自环境变量（代理脚本没有面板；可选的 NODE_KV 在线覆盖见 proxy-settings.js，UUID 与 PATH 永远只来自环境变量）
// 变量名与含义同原先的一体版；原先只能在面板里改的出站 / 地区反代设置现在用环境变量（也可由面板经 NodeControl 在线覆盖）：
//   UUID             【必填】VLESS 用户 ID
//   PATH             【必填】节点路径（WebSocket / XHTTP 共用）
//   EDGEIP          反代 / 落地 IP（host 或 host:port）
//   HOP_ADDR   出站代理（socks5:// / http(s):// / ss:// 或 host:port）
//   HOP_MODE    出站方式：留空 = 出站代理优先；no = 直连优先；only = 仅走出站代理
//   ALT_MODE       地区反代：builtin（默认，按机房自动选地区）/ custom / off
//   ALT_REGION     builtin 的首选地区（留空按机房自动选）
//   ALT_REGION2    builtin 的次选地区（留空自动；none = 不用）
//   ALT_CUSTOM     custom 的反代列表（最多 3 个 host[:port]，换行 / 逗号分隔）
// 无效取值按默认值处理（与原先面板里的枚举校验一致）。
// ---------------------------------------------------------------------------
const NODE_PATH_RE = /^[A-Za-z0-9._~-]+$/;
const ALT_CUSTOM_MAX = 3;   // 自定义反代最多 3 个：与直连并发竞速，受 Workers 6 个同时出站连接的限制

function nodeConfig(env) {
  const str = (k) => (env && env[k] != null ? String(env[k]).trim() : '');
  const cfg = {
    uuid: '', path: '', edgeIP: str('EDGEIP'), hopAddr: str('HOP_ADDR'), hopMode: '',
    alt: { mode: 'builtin', region: '', region2: '', custom: '' },
    _problems: [],
  };
  const uuid = str('UUID').toLowerCase();
  if (isUUID(uuid)) cfg.uuid = uuid;
  else cfg._problems.push(uuid ? '环境变量 UUID 的值不正确（应为 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）。' : '请设置环境变量 UUID（节点用户 ID）。');
  const path = str('PATH').replace(/^\/+/, '').replace(/\/+$/, '');
  if (path && NODE_PATH_RE.test(path) && path.length <= 128) cfg.path = path;
  else cfg._problems.push(path ? '环境变量 PATH 的值不正确：只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位。' : '请设置环境变量 PATH（节点的访问路径，如 mynode）。');
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
