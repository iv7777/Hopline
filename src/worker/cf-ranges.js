// ---------------------------------------------------------------------------
// Cloudflare 地址段（面板与代理共用）：节点入口必须是 CF 边缘 IP；代理出站时目标为 CF IP 则不发直连
// ---------------------------------------------------------------------------
// Cloudflare 官方 IPv4 地址段（入口 IP 校验）
const CLOUDFLARE_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];

// Cloudflare 官方 IPv6 地址段（用于入口 IP 过滤）
const CLOUDFLARE_CIDRS_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
];

// IPv6 CIDR 前缀匹配（展开为 16 进制组后按位比较）
function ipInCidrV6(ip, cidr) {
  const [net, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const expand = (a) => {
    const dbl = a.indexOf('::');
    let groups;
    if (dbl >= 0) {
      const left = a.slice(0, dbl).split(':').filter(Boolean);
      const right = a.slice(dbl + 2).split(':').filter(Boolean);
      const fill = 8 - left.length - right.length;
      groups = [...left, ...Array(fill).fill('0'), ...right];
    } else groups = a.split(':');
    return groups.map(g => g.padStart(4, '0'));
  };
  const bitStr = (groups) => groups.map(g => parseInt(g, 16).toString(2).padStart(16, '0')).join('');
  return bitStr(expand(ip)).slice(0, bits) === bitStr(expand(net)).slice(0, bits);
}

// 判断 IP 是否属于 Cloudflare Anycast 段：节点入口必须是 CF 边缘 IP，
// 非 CF IP（如各地区云服务器/落地 IP）无法把客户端 TLS 转发到 Worker，下发必然连不通
function isCloudflareIP(ip) {
  ip = String(ip || '');
  if (!isValidIp(ip)) return false;
  if (ip.indexOf(':') >= 0) return CLOUDFLARE_CIDRS_V6.some(cidr => ipInCidrV6(ip, cidr));
  const p = ip.split('.').map(Number);
  const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  return CLOUDFLARE_RANGES.some(([start, end]) => n >= start && n <= end);
}

function cidrToRange(cidr) {
  const [ip, bits] = cidr.split('/');
  const b = ip.split('.').map(Number);
  const base = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const mask = bits >= 32 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const start = (base & mask) >>> 0;   // >>> 0 保证无符号：位运算结果可能为负（如 162.158.0.0），比较/加减前必须归一
  const end = (base | (~mask >>> 0)) >>> 0;
  return [start, end];
}
// CIDR 掩码表预编译：初始化时一次性把 CF 地址段编译为无符号整数区间数组，IP 校验变纯整数比较（性能提升数十倍，应对免费版 10ms CPU 硬限）
const CLOUDFLARE_RANGES = CLOUDFLARE_CIDRS.map(cidrToRange);
