// ---------------------------------------------------------------------------
// 代理配置：环境变量只有两项，其余（UUID、启用开关、落地 / 出站 / 备用线路）全部由面板通过控制接口下发
//   PATH       【必填】节点路径（WebSocket / XHTTP 共用）
//   NODE_KEY   【必填】控制密钥（至少 24 位随机字符）：面板用它给控制请求签名，也决定控制入口的路径
// 面板下发的状态保存在 NODE_KV 里（见 proxy-settings.js）；还没下发 UUID（或代理被停用）时，节点路径上的请求和其它任何路径一样只返回伪装页。
// ---------------------------------------------------------------------------
const NODE_PATH_RE = /^[A-Za-z0-9._~-]+$/;
const NODE_KEY_MIN = 24;
const ALT_MAX = 3;   // 备用线路最多 3 条：与直连并发竞速，受 Workers 6 个同时出站连接的限制

function nodeConfig(env) {
  const str = (k) => (env && env[k] != null ? String(env[k]).trim() : '');
  const cfg = Object.assign({ path: '', key: '', _problems: [] }, emptyState());
  const path = str('PATH').replace(/^\/+/, '').replace(/\/+$/, '');
  if (path && NODE_PATH_RE.test(path) && path.length <= 128) cfg.path = path;
  else cfg._problems.push(path ? '环境变量 PATH 的值不正确：只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位。' : '请设置环境变量 PATH（节点的访问路径，如 mynode）。');
  const key = str('NODE_KEY');
  if (key.length >= NODE_KEY_MIN && key.length <= 256 && /^[\x21-\x7e]+$/.test(key)) cfg.key = key;
  else cfg._problems.push(key ? '环境变量 NODE_KEY 的值不正确：至少 ' + NODE_KEY_MIN + ' 位，只能是可见的 ASCII 字符（面板里可以点「生成密钥」）。' : '请设置环境变量 NODE_KEY（控制密钥，至少 ' + NODE_KEY_MIN + ' 位随机字符，与面板里填写的密钥一致）。');
  return cfg;
}
