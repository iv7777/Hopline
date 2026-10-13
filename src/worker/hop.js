// ---------------------------------------------------------------------------
// 代理设置的解析与校验（面板里做，代理只收结构化的数据）：落地 IP、出站代理地址、备用线路表与优先顺序
// ---------------------------------------------------------------------------
const HOP_HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const ALT_TABLE_MAX = 32;
const ALT_PICK_MAX = 8;
const ALT_PICK_DEFAULT = ['auto', 'HK', 'US'];

const hostValid = (h) => !!h && h.length <= 253 && (isValidIp(h) || HOP_HOSTNAME_RE.test(h));
const portValid = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// 反代 / 落地 IP：host 或 host:port（IPv6 加方括号）；返回 { value } 或 { error }
function checkEdgeIP(v) {
  v = String(v == null ? '' : v).trim();
  if (!v) return { value: '' };
  if (v.length > 256) return { error: '长度不能超过 256' };
  if (!/^[^\s/]+$/.test(v)) return { error: '格式为 host 或 host:port' };
  const { host, port } = parseHostPort(v, 443);
  if (!hostValid(host)) return { error: '不是有效的域名或 IP（格式 host 或 host:port，IPv6 需加方括号）' };
  if (!portValid(port)) return { error: '端口须为 1 - 65535' };
  return { value: v };
}

// 出站代理：socks5:// / http:// / https:// 或 host:port（默认按 socks5），可带 user:pass@；返回 { hop }（空 = null）或 { error }
function parseHopInput(addr) {
  let rest = String(addr == null ? '' : addr).trim();
  if (!rest) return { hop: null };
  if (rest.length > 1024) return { error: '长度不能超过 1024' };
  if (/\s/.test(rest)) return { error: '出站代理不能包含空格' };
  let type = 'socks5';
  const m = rest.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.+)$/);
  if (m) {
    type = m[1].toLowerCase();
    rest = m[2];
    if (type === 'ss') return { error: '不再支持 Shadowsocks 出站，请改用 socks5:// 或 http(s)://' };
    if (!['socks5', 'http', 'https'].includes(type)) return { error: '不支持的出站代理类型「' + m[1] + '」（支持 socks5 / http / https）' };
  }
  let user = '', pass = '';
  const at = rest.lastIndexOf('@');   // 以最后一个 @ 分隔凭据与主机：密码中未编码的 @ 不会把主机名截断
  if (at >= 0) {
    const u = rest.slice(0, at);
    rest = rest.slice(at + 1);
    // 用户名 / 密码可能经 URL 编码（%40 等），解码后才能用于认证
    const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
    const idx = u.indexOf(':');
    if (idx >= 0) { user = dec(u.slice(0, idx)); pass = dec(u.slice(idx + 1)); } else user = dec(u);
    if (user.length > 255 || pass.length > 255) return { error: '用户名或密码过长' };
  }
  const { host, port } = parseHostPort(rest, type === 'http' ? 80 : type === 'https' ? 443 : 1080);
  if (!hostValid(host)) return { error: '无法解析出站代理地址（格式如 socks5://user:pass@1.2.3.4:1080）' };
  if (!portValid(port)) return { error: '出站代理端口须为 1 - 65535' };
  const hop = { type, host, port };
  if (user) { hop.user = user; hop.pass = pass; }
  return { hop };
}

// 备用线路表（文本，每行 `标签 域名[:端口] [txt]`，# 开头为注释）→ { table, errors }
// table: 标签 → { host, port?, txt? }；txt = 解析时先查 TXT 记录（域名的 TXT 里放 IP 列表时用），默认只查 A 记录
function parseAltRoutes(text) {
  const table = {}, errors = [];
  String(text == null ? '' : text).split(/\r?\n/).forEach((line, i) => {
    line = line.replace(/#.*$/, '').trim();
    if (!line) return;
    const err = (msg) => errors.push({ line: i + 1, msg: '第 ' + (i + 1) + ' 行：' + msg });
    const f = line.split(/\s+/);
    if (f.length < 2 || f.length > 3 || (f[2] !== undefined && f[2].toLowerCase() !== 'txt')) return err('格式为「标签 域名[:端口] [txt]」');
    if (!TAG_PATTERN.test(f[0]) || f[0].toLowerCase() === 'auto') return err('标签只能是字母、数字、_ -（最长 16 位），不能叫 auto');
    if (table[f[0]]) return err('标签「' + f[0] + '」重复');
    const { host, port } = parseHostPort(f[1], 443);
    if (!hostValid(host)) return err('「' + f[1].slice(0, 60) + '」不是有效的域名或 IP（IPv6 需加方括号）');
    if (!portValid(port)) return err('端口须为 1 - 65535');
    const e = { host };
    if (port !== 443) e.port = port;
    if (f[2]) e.txt = true;
    table[f[0]] = e;
  });
  if (Object.keys(table).length > ALT_TABLE_MAX) errors.push({ line: 0, msg: '最多 ' + ALT_TABLE_MAX + ' 条线路' });
  return { table, errors };
}

// 备用线路的优先顺序（逗号 / 空格分隔的标签，auto = 按 Worker 机房选最近的地区）→ { pick } 或 { error }
function parseAltPick(text) {
  const pick = String(text == null ? '' : text).split(/[\s,;，]+/).filter(Boolean);
  if (pick.length > ALT_PICK_MAX) return { error: '最多 ' + ALT_PICK_MAX + ' 项' };
  const bad = pick.find(t => t !== 'auto' && !TAG_PATTERN.test(t));
  if (bad) return { error: '「' + bad.slice(0, 20) + '」不是有效的标签（字母、数字、_ -，最长 16 位）' };
  return { pick };
}
