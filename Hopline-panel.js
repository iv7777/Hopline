/*!Hopline-panel v3.2.3*/
// ============================================================================
//  Hopline 面板 —— 管理面板 + 订阅生成 · 全新独立编写
//  ----------------------------------------------------------------------------
//  只负责「怎么连」：管理面板、登录、订阅生成（vless 链接 / Clash / Sing-box 等）。
//  代理本身是另一个脚本（Hopline-proxy.js）：面板里保存代理列表（域名、节点路径、密钥、UUID、启停），
//  用密钥对请求签名，通过 HTTPS 联系代理的控制接口（不需要服务绑定，面板与代理可以在不同的 Cloudflare 账号）。
//  UUID 由面板生成并下发给代理；停用某个代理时，订阅里不再下发它，并通知代理对外只显示 Hello World。
//  环境变量（必填 2 项，其余可选）：
//    PATH            【必填】面板与订阅的访问路径，如 mypanel（与代理的节点路径互相独立）
//    ADMIN           【必填】面板管理密码：未设置时面板与管理 API 一律禁用
//    ADMIN_USER      面板管理用户名（默认 admin；登录时与密码一起校验）
//    CONFIG_KV       KV 命名空间的绑定变量名：绑定后读取 / 保存图形化配置与代理列表（保存必须绑定）
//    ENABLE_ECH      设为 true/1 开启 ECH 加密
//    ALPN            自定义 ALPN 协商
//  代理的域名、节点路径、密钥在面板「面板设置 → 代理」里填写（保存在 CONFIG_KV）。
// ============================================================================
// 面板脚本（Hopline-panel.js）的版本号：用于检测更新与面板里显示。与代理脚本各自编号、各自升版本
const VERSION = '3.2.3';
// 更新检测：点击版本号后拉取仓库代码比对版本号；有新版本时返回最新代码供面板复制
// 版本基准与复制的代码都是仓库 main 分支根目录下的 Hopline-panel.js（只检测面板脚本；代理脚本没有面板，它的版本通过服务绑定的 status() 查看）
const UPDATE_REPO = 'iv7777/Hopline';
const UPDATE_FILE = 'Hopline-panel.js';
let UPDATE_CACHE = null; // { t, r } 60 秒缓存

function parseVer(v){
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}
function cmpVer(a, b){
  const A = parseVer(a), B = parseVer(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i++){ if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1; }
  return 0;
}
function extractVersion(txt){
  // 部署文件顶部横幅：/*!Hopline-panel vX.Y.Z*/
  const b = txt.match(/Hopline-panel v(\d+\.\d+\.\d+)/);
  if (b) return b[1];
  // 回退：未压缩源码里的 const VERSION = 'x.y.z ...'
  const m = txt.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}
function updateFileUrl(name){
  return 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/main/' + encodeURIComponent(name);
}
// 拉取仓库文件：返回 { txt, version }，失败返回 { error }
async function fetchRepoFile(name){
  try {
    const res = await fetch(updateFileUrl(name), { headers: { 'User-Agent': 'Mozilla/5.0 (Hopline)' } });
    // 404：main 上没有这个文件——常见于新版本还没合并发布到 main，或仓库不是公开的（raw.githubusercontent.com 不带凭据，私有仓库一律 404）
    if (res.status === 404) return { error: '仓库 main 分支上没有 ' + name + '（HTTP 404）：新版本可能还没有合并发布到 main，或仓库不是公开的' };
    if (!res.ok) return { error: name + ' HTTP ' + res.status };
    const txt = await res.text();
    return { txt, version: extractVersion(txt) };
  } catch (e) { return { error: (e && e.message) || String(e) }; }
}
async function checkUpdate(){
  const now = Date.now();
  if (UPDATE_CACHE && now - UPDATE_CACHE.t < 60000) return UPDATE_CACHE.r;
  // 拉取仓库里与当前部署同类型的文件：比对版本号，有更新时直接把这次拉取的内容作为最新代码返回
  const r = await fetchRepoFile(UPDATE_FILE);
  if (!r.version) return { current: VERSION, latest: null, hasUpdate: false, code: '', error: r.error || '未在仓库中找到版本信息' };
  UPDATE_CACHE = { t: now, r: { current: VERSION, latest: r.version, hasUpdate: cmpVer(r.version, VERSION) > 0, code: r.txt, checkedAt: now } };
  return UPDATE_CACHE.r;
}

// ---------------------------------------------------------------------------
// 常量（面板）
// ---------------------------------------------------------------------------
// ISO 国家/地区码 → 中文（用于优选 API 数据源（bestcf 等 /random-region/XX/）下发的节点命名，以及按 Worker 机房标注节点地区前缀）
const REGION_CN = {
  HK: '香港', TW: '台湾', MO: '澳门', JP: '日本', SG: '新加坡', US: '美国', KR: '韩国', DE: '德国',
  FR: '法国', GB: '英国', CA: '加拿大', AU: '澳大利亚', SE: '瑞典', NL: '荷兰', FI: '芬兰',
  NO: '挪威', DK: '丹麦', CH: '瑞士', IT: '意大利', ES: '西班牙', PT: '葡萄牙', IE: '爱尔兰',
  BE: '比利时', AT: '奥地利', PL: '波兰', CZ: '捷克', RO: '罗马尼亚', HU: '匈牙利', GR: '希腊',
  RU: '俄罗斯', TR: '土耳其', UA: '乌克兰', IN: '印度', TH: '泰国', MY: '马来西亚', VN: '越南',
  PH: '菲律宾', ID: '印尼', BR: '巴西', MX: '墨西哥', AR: '阿根廷', CL: '智利', ZA: '南非',
  EG: '埃及', AE: '阿联酋', IL: '以色列', NZ: '新西兰', KZ: '哈萨克斯坦', SA: '沙特'
};

// IPv4+IPv6 混合时只对前 N 个优选域名查询 AAAA（控制子请求数，见 generateSubscription 默认模式）
const V6_DOMAIN_LIMIT = 12;
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
// ---------------------------------------------------------------------------
// 配置字段表（单一数据源）
// ---------------------------------------------------------------------------
// 以下全部由本表驱动，新增配置项只需在此加一行 + 在面板 HTML 放一个 id 与 el 对应的控件：
//   - schemaDefaults()（各字段默认值）
//   - 从 KV 读取配置时的字段合并（未登记的旧字段自动忽略）
//   - 保存接口 POST /api/config 的白名单与校验（sanitizeConfigPatch）
//   - 面板的表单回填 / 收集 / 未保存标记 / 字段级错误提示（表与 checkFieldValue 在下发面板时注入页面）
//
// 字段属性：
//   key       配置路径（支持 a.b 形式的嵌套）
//   type      bool | int | enum | list（多选胶囊）| string | secret（只写不回显）| text（多行）
//   def       默认值
//   el / els  面板控件 id；list 类型用 els：{ 选项值: 控件 id }；无 el 表示面板不展示
//   label     错误提示中的字段名
//   校验：    min / max（int）、maxLen、pattern（正则源码）、hint（pattern 不匹配时的提示）、
//             options（enum/list 可选值）、exclusive（list 中与其它选项互斥的值）、emptyValue（list 为空时的取值）、
//             required、lower（转小写）、trim（默认 true）、strip（校验前删除的正则源码数组）、
//             fillDefault（留空时取默认值）、reserved（保留字，不可使用）
//   envLock   环境变量名列表：设置任一变量后以环境变量为准，面板中该项只读、保存时忽略
//   check     仅服务端执行的附加校验（见 SERVER_CHECKS）
//   custom    面板中由专用代码回填 / 收集（通用逻辑跳过）
// ---------------------------------------------------------------------------
// 环境变量名（旧版短变量名 U / D / S / K / ECH 等已不再识别）。
// PATH 与 ADMIN 为必填；其余均可选。代理（域名、节点路径、密钥、UUID）不是面板配置项，保存在面板 KV 的 proxies 里（见 proxies.js）
const ENV_NAMES = {
  path: ['PATH'],
  admin: ['ADMIN'],
  adminUser: ['ADMIN_USER'],
  ech: ['ENABLE_ECH'],
  kv: ['CONFIG_KV'],   // KV 命名空间的绑定变量名
};
// 读取环境变量（按 ENV_NAMES 顺序取第一个非空的）；未设置返回 undefined
function envVar(env, key) {
  for (const n of ENV_NAMES[key]) if (env && env[n] != null && String(env[n]) !== '') return env[n];
  return undefined;
}
// KV 命名空间绑定对象（未绑定返回 null）
function kvStore(env) {
  for (const n of ENV_NAMES.kv) if (env && env[n] && typeof env[n] === 'object') return env[n];
  return null;
}
const PATH_SEG_PATTERN = '^[A-Za-z0-9._~-]+$';
const HOSTNAME_PATTERN = '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$';
const RESERVED_PATHS = ['login', 'version'];

const CONFIG_SCHEMA = [
  // ---- 面板设置 ----
  // 面板与订阅的访问路径：由必填的环境变量 PATH 提供（面板中只读）；与代理的节点路径互相独立
  { key: 'path', type: 'string', def: '', el: 'a-path', label: '面板路径', maxLen: 128, strip: ['^/+', '/+$'],
    pattern: PATH_SEG_PATTERN, hint: '只能包含字母、数字及 . _ ~ -（不含 /）', reserved: RESERVED_PATHS, envLock: ENV_NAMES.path },
  // 自定义订阅路径：/<别名>/sub 输出订阅（不开放面板与管理接口）；留空为 /<UUID>/sub
  { key: 'subUrl', type: 'string', def: '', el: 'a-suburl', label: '自定义订阅路径', maxLen: 128, strip: ['^/+', '/+$', '/sub$', '/+$'],
    pattern: PATH_SEG_PATTERN, hint: '只填一段别名，如 mysub（字母、数字及 . _ ~ -）', reserved: RESERVED_PATHS },
  // 管理用户名：登录时与管理密码一起校验（区分大小写）；留空取默认 admin
  { key: 'adminUser', type: 'string', def: 'admin', el: 'a-adminuser', label: '管理用户名', maxLen: 64, fillDefault: true,
    pattern: '^[^\\s\\x00-\\x1f\\x7f]+$', hint: '不能包含空格或控制字符', envLock: ENV_NAMES.adminUser },
  { key: 'admin', type: 'secret', def: '', el: 'a-admin', label: '管理密码', trim: false, maxLen: 256, envLock: ENV_NAMES.admin, check: 'adminPass' },
  // ---- 协议开关：只决定订阅里下发哪些节点（代理脚本始终同时接受两种传输） ----
  { key: 'enableVless', type: 'bool', def: true, el: 'en-vless', label: 'VLESS 协议' },
  { key: 'enableXhttp', type: 'bool', def: true, el: 'en-xhttp', label: 'XHTTP 协议' },
  // ---- 传输参数 ----
  { key: 'alpn', type: 'string', def: '', el: 'alpn', label: 'ALPN', maxLen: 64,
    pattern: '^[A-Za-z0-9./-]+(\\s*,\\s*[A-Za-z0-9./-]+)*$', hint: '以逗号分隔，如 h2,http/1.1' },
  { key: 'ech', type: 'bool', def: false, el: 'ech-on', label: 'ECH' },
  // ECH 查询域名（留空使用 cloudflare-ech.com）
  { key: 'echHost', type: 'string', def: 'cloudflare-ech.com', el: 'ech-host', label: 'ECH 域名', fillDefault: true, maxLen: 253,
    strip: ['^https?://', '[/?#].*$'], pattern: HOSTNAME_PATTERN, hint: '请填写域名，如 cloudflare-ech.com' },
  // 自定义 ECH DNS：客户端获取 ECH 配置的 DoH 地址（留空用默认 223.5.5.5）
  { key: 'echDns', type: 'string', def: '', el: 'ech-dns', label: 'ECH DNS', maxLen: 512,
    pattern: '^https://\\S+$', hint: '须为 https:// 开头的 DoH 地址' },
  // TLS 控制：默认开启，只下发 TLS 端口节点；关闭后 443 节点另追加 80 明文节点，来源自带的明文端口原样下发（开启 ECH 时强制仅 TLS）
  { key: 'tlsOnly', type: 'bool', def: true, el: 'tls-only', label: '仅 TLS 端口' },
  // ---- 优选域名：留空使用内置列表；填写后整体替换内置列表（每行一个纯主机名，最多 30 个） ----
  { key: 'prefDomains', type: 'text', def: '', el: 'o-prefdomains', label: '优选域名', maxLen: 4096, check: 'domainList' },
  // ---- 订阅筛选（按节点名称中的地区/运营商标记 + 地址 IP 类型过滤下发） ----
  { key: 'filter.region', type: 'list', def: ['all'], label: '节点地区', options: ['all', 'HK', 'TW', 'US', 'SG', 'JP', 'KR', 'DE'],
    exclusive: 'all', emptyValue: ['all'],
    els: { all: 'fl-region-all', HK: 'fl-region-HK', TW: 'fl-region-TW', US: 'fl-region-US', SG: 'fl-region-SG', JP: 'fl-region-JP', KR: 'fl-region-KR', DE: 'fl-region-DE' } },
  // 勾选的 IP 类型集合（全选或空 = 不过滤）
  { key: 'filter.ipType', type: 'list', def: ['IPv4'], label: 'IP 类型', options: ['IPv4', 'IPv6'],
    els: { IPv4: 'fl-ip4', IPv6: 'fl-ip6' } },
  // 勾选的运营商集合（全选 = 不过滤）
  { key: 'filter.isp', type: 'list', def: ['移动', '联通', '电信'], label: '运营商偏好', options: ['移动', '联通', '电信'],
    els: { '移动': 'fl-isp-m', '联通': 'fl-isp-c', '电信': 'fl-isp-t' } },
  // ---- 地址来源（订阅节点池由这三项组装） ----
  { key: 'src.native', type: 'bool', def: false, el: 'fl-native', label: '原生地址' },
  { key: 'src.prefDomain', type: 'bool', def: true, el: 'fl-pref-domain', label: '优选域名' },
  { key: 'src.prefIp', type: 'bool', def: true, el: 'fl-pref-ip', label: '优选 IP' },
  // ---- 「优选 IP」的在线来源（默认模式；均只保留 Cloudflare 段 IP，结果缓存 10 分钟） ----
  { key: 'ipsrc.hostmonit', type: 'bool', def: true, el: 'ps-hostmonit', label: 'HostMonit 实时优选' },
  // uouin 分线路优选：借用 api.uouin.com 网站内部接口（非开放 API，对方可能随时更换签名或封禁），默认开启
  { key: 'ipsrc.uouin', type: 'bool', def: true, el: 'ps-uouin', label: 'uouin 分线路优选' },
  // 微测网优选：wetest.vip 公开页面（IPv4 / IPv6 各一页，移动 / 联通 / 电信各 5 个，约每 15 分钟更新），默认关闭
  { key: 'ipsrc.wetest', type: 'bool', def: false, el: 'ps-wetest', label: '微测网优选' },
  // 两个自定义优选 API：填写返回 IP 列表的地址（纯 IP 行 / CSV / HTML 线路表 / base64 订阅 / vless 链接，支持 sub://）
  { key: 'ipsrc.api1', type: 'bool', def: false, el: 'ps-api1-on', label: '自定义优选 API 1' },
  { key: 'ipsrc.api1Url', type: 'string', def: '', el: 'ps-api1-url', label: '自定义优选 API 1 地址', maxLen: 1024,
    pattern: '^(https?|sub)://\\S+$', hint: '须为 http(s):// 或 sub:// 开头的地址' },
  { key: 'ipsrc.api2', type: 'bool', def: false, el: 'ps-api2-on', label: '自定义优选 API 2' },
  { key: 'ipsrc.api2Url', type: 'string', def: '', el: 'ps-api2-url', label: '自定义优选 API 2 地址', maxLen: 1024,
    pattern: '^(https?|sub)://\\S+$', hint: '须为 http(s):// 或 sub:// 开头的地址' },
];

// 单个字段值校验与规范化（服务端与面板共用：面板页面下发时通过 toString() 注入同一份代码，
// 因此本函数必须自包含——不得引用外部变量，且保持 ES5 语法）。返回 { value } 或 { error }
function checkFieldValue(def, v) {
  var t = def.type, i;
  if (t === 'bool') {
    if (v === true || v === 'true' || v === '1' || v === 1) return { value: true };
    if (v === false || v === 'false' || v === '0' || v === 0) return { value: false };
    return { error: '必须为开或关' };
  }
  if (t === 'int') {
    var n = typeof v === 'number' ? v : (/^\s*-?\d+\s*$/.test(String(v == null ? '' : v)) ? parseInt(v, 10) : NaN);
    if (!isFinite(n) || Math.floor(n) !== n) return { error: '必须为整数' };
    if ((def.min != null && n < def.min) || (def.max != null && n > def.max)) return { error: '取值范围为 ' + def.min + ' - ' + def.max };
    return { value: n };
  }
  if (t === 'enum') {
    v = v == null ? '' : String(v);
    if (def.options.indexOf(v) < 0) return { error: '不支持的选项：' + v };
    return { value: v };
  }
  if (t === 'list') {
    if (!Array.isArray(v)) v = (v == null || v === '') ? [] : [String(v)];
    var out = [];
    for (i = 0; i < v.length; i++) {
      var s = String(v[i]);
      if (def.options.indexOf(s) < 0) return { error: '不支持的选项：' + s };
      if (out.indexOf(s) < 0) out.push(s);
    }
    if (def.exclusive && out.indexOf(def.exclusive) >= 0) out = [def.exclusive];
    if (!out.length && def.emptyValue) out = def.emptyValue.slice();
    return { value: out };
  }
  if (t === 'string' || t === 'secret' || t === 'text') {
    if (v == null) v = '';
    if (typeof v !== 'string' && typeof v !== 'number') return { error: '格式不正确' };
    v = String(v);
    if (def.trim !== false) v = v.trim();
    if (def.strip) for (i = 0; i < def.strip.length; i++) v = v.replace(new RegExp(def.strip[i], 'i'), '');
    if (def.lower) v = v.toLowerCase();
    if (!v) {
      if (def.required) return { error: '不能为空' };
      return { value: def.fillDefault ? def.def : '' };
    }
    if (def.maxLen && v.length > def.maxLen) return { error: '长度不能超过 ' + def.maxLen };
    if (def.pattern && !new RegExp(def.pattern).test(v)) return { error: def.hint || '格式不正确' };
    if (def.reserved && def.reserved.indexOf(v.toLowerCase()) >= 0) return { error: '「' + v + '」为保留路径，请换一个' };
    return { value: v };
  }
  return { value: v };   // 其余类型仅由服务端 SERVER_CHECKS 校验
}

// 仅服务端执行的附加校验：返回错误信息字符串或 { value } 规范化结果
// 优选域名只接受纯主机名：至少一个点，每段 1-63 位字母数字或连字符，末段不能全为数字（排除 IP）；最多 30 个
const PREF_DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PREF_DOMAIN_MAX = 30;
// 经 DoH 逐个解析的上限（免费版每次请求最多 50 个子请求，需给其它来源留出余量）：超出部分仍作为域名节点下发，只是不参与解析
const PREF_DOMAIN_DOH_LIMIT = 25;
const SERVER_CHECKS = {
  domainList(v) {
    const seen = new Set(), out = [];
    for (const raw of String(v || '').split(/[\n,;\s]+/).filter(Boolean)) {
      const d = raw.toLowerCase();
      if (!PREF_DOMAIN_RE.test(d) || /^[0-9]+$/.test(d.slice(d.lastIndexOf('.') + 1))) {
        return '「' + raw.slice(0, 60) + '」不是有效的域名：只填主机名（如 cf.example.com），不含 http://、端口、路径或通配符，IP 地址不能作为优选域名';
      }
      if (!seen.has(d)) { seen.add(d); out.push(d); }
    }
    if (out.length > PREF_DOMAIN_MAX) return '最多 ' + PREF_DOMAIN_MAX + ' 个域名（当前 ' + out.length + ' 个）';
    return { value: out.join('\n') };
  },
  adminPass(v) {
    // 以摘要前缀开头的密码会被误当成已哈希的值，直接拒绝
    if (v && String(v).startsWith('hopline-pbkdf2$')) return '密码不能以 hopline-pbkdf2$ 开头';
  },
};

const SCHEMA_BY_KEY = new Map(CONFIG_SCHEMA.map(d => [d.key, d]));
function getPath(obj, key) {
  let o = obj;
  for (const k of key.split('.')) { if (o == null || typeof o !== 'object') return undefined; o = o[k]; }
  return o;
}
function setPath(obj, key, value) {
  const ks = key.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = value;
}
const cloneJSON = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function schemaDefaults() {
  const out = {};
  for (const d of CONFIG_SCHEMA) setPath(out, d.key, cloneJSON(d.def));
  return out;
}
// 仅保留字段表中登记的配置项（用于写入 KV：内部临时字段与废弃字段不落盘）
function pickSchema(cfg) {
  const out = {};
  for (const d of CONFIG_SCHEMA) {
    const v = getPath(cfg, d.key);
    if (v !== undefined) setPath(out, d.key, cloneJSON(v));
  }
  return out;
}
// 当前生效的环境变量锁定：{ 字段: 环境变量名 }
function envLockedFields(env) {
  const out = {};
  for (const d of CONFIG_SCHEMA) {
    if (!d.envLock) continue;
    const name = d.envLock.find(n => env && env[n] != null && String(env[n]) !== '');
    if (name) out[d.key] = name;
  }
  return out;
}
// 校验并规范化保存请求：只处理请求中出现的字段（支持脚本按需局部更新）。
// 返回 { patch, errors: [{ field, label, msg }], ignored: [未登记 / 环境变量锁定的字段] }
function sanitizeConfigPatch(body, env) {
  const patch = {}, errors = [], ignored = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { patch, errors: [{ field: '', label: '配置', msg: '请求体必须为 JSON 对象' }], ignored };
  }
  const locked = envLockedFields(env);
  const known = new Set();
  for (const d of CONFIG_SCHEMA) {
    const v = getPath(body, d.key);
    if (v === undefined) continue;
    known.add(d.key);
    if (locked[d.key]) { ignored.push(d.key); continue; }
    if (d.type === 'secret' && (v === '' || v == null)) continue;   // 密码 / 令牌留空 = 保持不变
    let r = checkFieldValue(d, v);
    if (!r.error && d.check) {
      const c = SERVER_CHECKS[d.check](r.value);
      if (typeof c === 'string') r = { error: c };
      else if (c && 'value' in c) r = c;
    }
    if (r.error) errors.push({ field: d.key, label: d.label || d.key, msg: r.error });
    else setPath(patch, d.key, r.value);
  }
  // 未登记字段（含 _ 开头的内部字段）一律忽略，不写入 KV
  const walk = (o, prefix) => {
    for (const k of Object.keys(o)) {
      const key = prefix ? prefix + '.' + k : k;
      if (known.has(key) || SCHEMA_BY_KEY.has(key)) continue;
      const isGroup = CONFIG_SCHEMA.some(d => d.key.startsWith(key + '.'));
      if (isGroup && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) walk(o[k], key);
      else ignored.push(key);
    }
  };
  walk(body, '');
  return { patch, errors, ignored };
}
// 跨字段校验（作用于合并后的完整配置）
function crossCheckConfig(cfg) {
  const errors = [];
  if (!cfg['enableVl' + 'ess'] && !cfg.enableXhttp) {
    errors.push({ field: 'enableVless', label: '协议开关', msg: '至少启用一种协议，否则订阅中没有任何节点' });
  }
  for (const n of [1, 2]) {
    const s = cfg.ipsrc || {};
    if (s['api' + n] && !s['api' + n + 'Url']) {
      errors.push({ field: 'ipsrc.api' + n + 'Url', label: '自定义优选 API ' + n + ' 地址', msg: '已开启该来源，请填写 API 地址（或关闭开关）' });
    }
  }
  return errors;
}
// 下发给面板的字段表（与服务端同一份，去掉仅服务端使用的属性）
function clientSchema() {
  return CONFIG_SCHEMA.map(d => { const o = Object.assign({}, d); delete o.check; return o; });
}

// 内置官方直连域名：节点池为空时的最后兜底（保证订阅不为空），以及仅勾选 IPv6 时的 AAAA 来源
const BUILTIN_OFFICIAL_DOMAINS = ['cloudflare.com', 'www.cloudflare.com', 'speed.cloudflare.com'];

// 内置默认优选域名：第三方 CNAME 域名，解析到 Cloudflare 边缘；节点 server 直接下发域名
// （客户端连接时动态 DNS 解析，拿到当前最优 CF 边缘 IP，可用性远高于静态 IP 快照）。
// 均已用面板「优选域名 → 测试」验证：能解析且落在 Cloudflare 段（解析失败或非 CF 段的域名无法作入口）。
// 面板「优选域名」填写后会整体替换本列表
const DEFAULT_PREFERRED_DOMAINS = [
  'cloudflare.182682.xyz', 'cdn.2020111.xyz', 'cf.0sm.com', 'cf.090227.xyz', 'cfip.1323123.xyz',
  'cnamefuckxxs.yuchen.icu', 'cloudflare-ip.mofashi.ltd', 'cdn.tzpro.xyz', 'cf.877771.xyz', 'xn--b6gac.eu.org',
  'bestcf.030101.xyz', 'cdns.doon.eu.org', 'fn.130519.xyz', 'saas.sin.fan'
].join('\n');
// 实际生效的优选域名：面板填写了就整体替换内置列表，留空用内置列表
function effectivePrefDomains(cfg) {
  const own = cfg && cfg.prefDomains ? String(cfg.prefDomains).trim() : '';
  return own || DEFAULT_PREFERRED_DOMAINS;
}
// 取前 PREF_DOMAIN_DOH_LIMIT 个（逐个 DoH 解析的路径使用，控制子请求数）
function dohPrefDomains(text) {
  return String(text).split('\n').slice(0, PREF_DOMAIN_DOH_LIMIT).join('\n');
}


// 明文 HTTP 端口：Cloudflare 边缘在这些端口上不支持 TLS，节点必须走明文 ws（否则握手失败连不通）
const HTTP_PORTS = new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);

// 优选器预设数据源：微测网接口 + 优选 IP 来源

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const TE = new TextEncoder();

function isUUID(str) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str || '');
}
function parseHostPort(addr, defaultPort = 443) {
  addr = String(addr || '').trim();
  if (!addr) return { host: '', port: defaultPort };
  if (addr.startsWith('[')) {
    const m = addr.match(/^\[([^\]]+)\](?::(\d+))?$/);
    return { host: m ? m[1] : addr.replace(/^\[|\]$/g, ''), port: m && m[2] ? parseInt(m[2]) : defaultPort };
  }
  const idx = addr.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(addr.slice(idx + 1))) {
    return { host: addr.slice(0, idx), port: parseInt(addr.slice(idx + 1)) };
  }
  return { host: addr, port: defaultPort };
}
// 严格校验 IPv4 / IPv6 地址
function isValidIp(str) {
  str = String(str || '').trim();
  if (!str) return false;
  const m4 = str.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) return m4.slice(1).every(n => Number(n) <= 255);
  if (!/^[0-9a-fA-F:]+$/.test(str)) return false;
  if ((str.match(/::/g) || []).length > 1) return false;
  const hasDbl = str.includes('::');
  const groups = str.replace(/::/g, ':').split(':').filter(Boolean);
  if (!hasDbl && groups.length !== 8) return false;
  if (hasDbl && (groups.length < 1 || groups.length > 7)) return false;
  return groups.every(g => /^[0-9a-fA-F]{1,4}$/.test(g));
}
// 带超时的 fetch（手动 AbortController，兼容所有运行时）；超时 / 网络错误返回 null
function fetchTimeout(url, opts, ms) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}
// 限制缓存表大小：超出时淘汰最先插入的项（Map 按插入顺序遍历），避免长期运行的实例内存无限增长
function capMap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }

// 路径不对（根路径、未知路由）时返回与 Cloudflare 默认的 Hello World Worker 完全相同的响应：
//   return new Response('Hello World!');  → 200，纯文本，没有任何多余的头；
// 看起来像个刚创建的占位 Worker，既不暴露路径 / UUID，也不返回 404 引人注意
function stubPage() {
  return new Response('Hello World!');
}
// ---------------------------------------------------------------------------
// 哈希（面板）：MD5 用于缓存键，SHA-224 用于派生 Clash 本地凭据
// ---------------------------------------------------------------------------
// MD5（纯 JS 实现，RFC 1321；WebCrypto 不支持 MD5）
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
];
function rotl32(x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; }
// 输入字节数组，返回 16 字节摘要
function md5Bytes(bytes) {
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const data = new Uint8Array(paddedLen);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const dv = new DataView(data.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < paddedLen; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(i + j * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const sum = (a + f + MD5_K[j] + M[g]) >>> 0;
      const nb = (b + rotl32(sum, MD5_S[j])) >>> 0;
      a = d; d = c; c = b; b = nb;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}
function md5hex(str) {
  return Array.from(md5Bytes(TE.encode(String(str)))).map(b => b.toString(16).padStart(2, '0')).join('');
}

// SHA-224（用于由 UUID 派生 Clash 配置的密钥）——Cloudflare WebCrypto 不支持 SHA-224，手写实现（SHA-256 结构 + SHA-224 初始值）
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
function sha224hex(str) {
  const bytes = TE.encode(String(str));
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const data = new Uint8Array(paddedLen);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const dv = new DataView(data.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);   // SHA-2 大端 64 位长度
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
  let h0 = 0xc1059ed8, h1 = 0x367cd507, h2 = 0x3070dd17, h3 = 0xf70e5939,
      h4 = 0xffc00b31, h5 = 0x68581511, h6 = 0x64f98fa7, h7 = 0xbefa4fa4;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < paddedLen; i += 64) {
    const w = new Uint32Array(64);
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);  // 大端读消息字
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[j] + w[j]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  let hex = '';
  for (const v of [h0, h1, h2, h3, h4, h5, h6]) {
    hex += (v >>> 24 & 255).toString(16).padStart(2, '0');
    hex += (v >>> 16 & 255).toString(16).padStart(2, '0');
    hex += (v >>> 8 & 255).toString(16).padStart(2, '0');
    hex += (v & 255).toString(16).padStart(2, '0');
  }
  return hex;
}
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
// ---------------------------------------------------------------------------
// DoH 查询（面板与代理共用）
// ---------------------------------------------------------------------------
// 依次尝试 DoH 端点：前一个失败（网络错误 / 非 200 / SERVFAIL 等）立即换下一个；
// 前一个超过 hedgeMs 仍未返回时提前并发发起下一个，先到先得。正常情况下每次查询只消耗 1 个子请求。
// validate(json) 返回非 null 即视为成功结果（含「确认无记录」的空数组），返回 null 则换端点。全部失败返回 null
function dohFirst(endpoints, buildUrl, validate, opts) {
  const hedgeMs = (opts && opts.hedgeMs) || 700, timeoutMs = (opts && opts.timeoutMs) || 4000;
  return new Promise((resolve) => {
    let next = 0, pending = 0, done = false, timer = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const launch = () => {
      if (done) return;
      clearTimeout(timer);
      if (next >= endpoints.length) { if (!pending) finish(null); return; }
      const ep = endpoints[next++];
      pending++;
      if (next < endpoints.length) timer = setTimeout(launch, hedgeMs);
      (async () => {
        let out = null;
        try {
          const res = await fetchTimeout(buildUrl(ep), { headers: { accept: 'application/dns-json' } }, timeoutMs);
          if (res && res.ok) out = validate(await res.json());
        } catch (e) { /* 视为失败，换下一个端点 */ }
        pending--;
        if (out != null) finish(out);
        else if (!done && pending === 0) launch();
      })();
    };
    launch();
  });
}
// ---------------------------------------------------------------------------
// 配置加载：默认值 < 环境变量 < KV 图形化配置
// KV 读取走 Cloudflare KV 内置边缘缓存 cacheTtl=30：请求/面板读配置命中边缘缓存，大幅减少 KV 读量；
// 不使用模块级内存缓存（不同 isolate 不共享且会残留陈旧值）。KV 是最终一致的：同一机房写入后随即可见，
// 其它机房最多约 1 分钟后同步（面板保存提示即此含义）。
// ---------------------------------------------------------------------------

// KV 读取失败 / 配置损坏时不能静默当作「没有配置」：否则在此状态下保存会用默认值覆盖掉真实配置。
// cfg._kvError 记录原因（unavailable：KV 读取出错；corrupt：存储内容不是合法 JSON），调用方据此拒绝写入；
// 读取不到 KV 时面板与订阅按环境变量 + 默认值工作
async function loadConfig(env) {
  let kvCfg = null, kvError = '';
  const kv = kvStore(env);
  if (kv && typeof kv.get === 'function') {
    try {
      const kvJson = await kv.get('config', { cacheTtl: 30 });
      if (kvJson) {
        try { kvCfg = JSON.parse(kvJson); if (!kvCfg || typeof kvCfg !== 'object') throw new SyntaxError('not an object'); }
        catch (e) { kvCfg = null; kvError = 'corrupt'; }
      }
    } catch (e) { kvError = 'unavailable'; }
  }
  const cfg = buildConfig(env, kvCfg);
  if (kvError) cfg._kvError = kvError;
  await attachProxies(env, cfg);
  return cfg;
}

// 面板路径（环境变量 PATH）：去掉首尾 /，只允许 字母 数字 . _ ~ -，且不能是保留路径。返回 { value, error }
function normalizePanelPath(raw) {
  const v = String(raw == null ? '' : raw).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!v) return { value: '', error: '' };
  if (!new RegExp(PATH_SEG_PATTERN).test(v) || v.length > 128) return { value: '', error: '只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位' };
  if (RESERVED_PATHS.indexOf(v.toLowerCase()) >= 0) return { value: '', error: '「' + v + '」为保留路径，请换一个' };
  return { value: v, error: '' };
}

// 由「默认值 < 环境变量 < KV 配置 < 锁定的环境变量」组装完整配置（纯函数：保存接口用刚写入的数据直接组装，
// 不经 KV 边缘缓存，避免保存后回读到旧配置）。cfg.path 为空表示 PATH 未设置 / 非法；代理列表由 loadConfig 另行读入（cfg.proxies / cfg.proxy）
function buildConfig(env, kvCfg) {
  const cfg = schemaDefaults();
  const flag = (v) => v === true || v === 'true' || v === '1' || v === 1;
  // 环境变量
  if (flag(envVar(env, 'ech'))) cfg.ech = true;
  if (env.ALPN) cfg.alpn = String(env.ALPN);
  // KV 图形化配置（更高优先级）：按字段表逐项合并，未登记的字段自动忽略
  if (kvCfg && typeof kvCfg === 'object') {
    for (const d of CONFIG_SCHEMA) {
      const v = getPath(kvCfg, d.key);
      if (v !== undefined) setPath(cfg, d.key, cloneJSON(v));
    }
  }
  // 环境变量锁定字段（PATH / ADMIN / ADMIN_USER）优先于 KV：面板中这些项只读
  const locked = envLockedFields(env);
  for (const key of Object.keys(locked)) {
    const d = SCHEMA_BY_KEY.get(key);
    let v = String(env[locked[key]]);
    if (d.lower) v = v.toLowerCase();
    setPath(cfg, key, v);
  }
  // 面板路径只认环境变量 PATH（不再回退 UUID）；非法值按未设置处理并记下原因
  const np = normalizePanelPath(locked.path ? env[locked.path] : '');
  cfg.path = np.value;
  if (np.error) cfg._pathError = np.error;
  return cfg;
}

// 写入 KV：只保存字段表登记的配置项；由环境变量锁定的字段（管理密码、面板路径）不写入
// （避免明文密码落盘，也避免与环境变量不一致）。返回实际写入的对象；未绑定 KV 返回 null
async function saveConfig(env, cfg) {
  const kv = kvStore(env);
  if (!kv || typeof kv.put !== 'function') return null;
  const stored = pickSchema(cfg);
  // 环境变量提供、且面板里没有被改动的值不写入 KV：否则一次保存就会把 HOST / ALPN 等
  // 环境变量快照进 KV（KV 优先级更高），之后再改环境变量会被静默忽略。
  // 面板中改成与环境变量不同的值才视为覆盖并保存
  const envBase = buildConfig(env, null), defaults = schemaDefaults();
  for (const d of CONFIG_SCHEMA) {
    const ev = getPath(envBase, d.key);
    if (JSON.stringify(ev) === JSON.stringify(getPath(defaults, d.key))) continue;   // 环境变量未提供该项
    if (JSON.stringify(getPath(stored, d.key)) !== JSON.stringify(ev)) continue;     // 面板中已改动：保存为覆盖值
    const ks = d.key.split('.');
    const parent = ks.length > 1 ? getPath(stored, ks.slice(0, -1).join('.')) : stored;
    if (parent) delete parent[ks[ks.length - 1]];
  }
  for (const key of Object.keys(envLockedFields(env))) {
    const ks = key.split('.');
    const parent = ks.length > 1 ? getPath(stored, ks.slice(0, -1).join('.')) : stored;
    if (parent) delete parent[ks[ks.length - 1]];
  }
  await kv.put('config', JSON.stringify(stored));
  return stored;
}


// ---------------------------------------------------------------------------
// 代理设置的解析与校验（面板里做，代理只收结构化的数据）：落地 IP、出站代理地址、备用线路表与优先顺序
// ---------------------------------------------------------------------------
const HOP_HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const ALT_TABLE_MAX = 32;
const ALT_PICK_MAX = 8;
const ALT_PICK_DEFAULT = ['auto'];   // auto = 按 Worker 机房选最近的地区，再依次补它相邻的地区（由代理展开）

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
    // SOCKS5 用 1 个字节表示长度：按 UTF-8 字节数限制（中文等每个字占 3 个字节）
    if (TE.encode(user).length > 255 || TE.encode(pass).length > 255) return { error: '用户名或密码过长（最多 255 个字节）' };
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
// ---------------------------------------------------------------------------
// 面板调用代理的控制接口（签名的 HTTPS 请求；协议见 proxy-control.js）
// ---------------------------------------------------------------------------
// 面板与代理没有任何绑定关系：只需要代理的域名、节点路径与密钥，所以可以在不同的 Cloudflare 账号里。
// 代理必须使用自定义域名（Worker 对同一 zone 内 workers.dev / 路由上的另一个 Worker 发 fetch 会被 Cloudflare 拒绝，见错误 1042 / 1024）。
const CALL_TIMEOUT = 6000;
const CALL_BODY_MAX = 64 * 1024;
const PROXY_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// 面板只会连到管理员填写的域名：必须是域名（不是 IP）、不带端口 / 路径
function proxyHostOk(host) {
  host = String(host || '');
  return host.length <= 253 && PROXY_HOST_RE.test(host) && !isValidIp(host);
}
function randomNonce() { return b64uOfBytes(crypto.getRandomValues(new Uint8Array(16))); }

// 把 Cloudflare 的错误页 / 伪装页翻译成管理员能看懂的原因
function explainControlFailure(status, text) {
  const code = (String(text).match(/error code:\s*(\d{4})/i) || [])[1];
  if (code === '1042') return 'Cloudflare 拒绝了这次请求（错误 1042）：面板与代理在同一个 zone 里，代理必须用自定义域名（Custom Domain），不能是 workers.dev 或路由';
  if (code === '1024') return 'Cloudflare 拒绝了这次请求（错误 1024）：不能向 Cloudflare 的 IP 发请求，请填写代理的域名而不是 IP';
  if (code) return 'Cloudflare 返回了错误 ' + code;
  if (status === 503 && text) return '代理返回：' + String(text).trim().slice(0, 200);
  if (/Hello World/i.test(text)) return '代理没有响应控制请求：节点路径或密钥不对、代理还没设置 NODE_KEY，或代理脚本版本过旧';
  return '代理返回了无法识别的响应（HTTP ' + status + '）';
}
// 发一次签名请求并验证回应；失败抛 Error（message 可直接显示）。proxy：{ host, nodePath, key }；args 是对象，rawArgs 给出时原样作为参数文本（setState 要让代理保存的 JSON 与面板算哈希的一致）
async function callProxy(proxy, op, args, rawArgs) {
  if (!proxy || !proxy.key) throw new Error('这个代理还没有填写密钥');
  if (!proxyHostOk(proxy.host)) throw new Error('代理域名不正确（只能是域名，不能是 IP，也不带端口或路径）');
  const ts = Date.now(), n = randomNonce(), a = rawArgs !== undefined ? rawArgs : JSON.stringify(args || {});
  const body = JSON.stringify({ ts, n, op, a, s: await hmacB64u(proxy.key, ts + '.' + n + '.' + op + '.' + a) });
  const url = 'https://' + proxy.host + '/' + proxy.nodePath + '/' + await routeTag(proxy.key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT);
  let res, text;
  try {
    res = await fetch(url, { method: 'POST', body, redirect: 'manual', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' } });
    text = (await res.text()).slice(0, CALL_BODY_MAX);
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? '调用超时（代理 ' + CALL_TIMEOUT / 1000 + ' 秒内没有响应）' : '无法连接代理：' + ((e && e.message) || e));
  } finally { clearTimeout(timer); }
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* 不是 JSON：下面按失败说明 */ }
  if (!j || typeof j.d !== 'string' || typeof j.s !== 'string' || typeof j.ts !== 'number') throw new Error(explainControlFailure(res.status, text));
  if (!timingSafeEqual(await hmacB64u(proxy.key, j.ts + '.' + n + '.' + j.d), j.s)) throw new Error('代理的回应签名不对（密钥不一致？）');
  if (Math.abs(Date.now() - j.ts) > 60000) throw new Error('代理的回应时间偏差过大');
  const d = JSON.parse(j.d);
  if (!d || typeof d !== 'object') throw new Error('代理返回的内容不正确');
  return d;
}
// 把「操作失败」的结果（ok:false）转成 Error，方便调用方统一处理
async function callProxyOk(proxy, op, args, rawArgs) {
  const d = await callProxy(proxy, op, args, rawArgs);
  if (d.ok === false) throw Object.assign(new Error(String(d.error || '代理拒绝了这次操作')), { errors: Array.isArray(d.errors) ? d.errors : [] });
  return d;
}

// 同步：把面板保存的完整状态下发给代理（UUID、启用开关、运行设置、备用线路表）。面板没有 UUID 时先生成一个。
// 先读代理的 status，状态哈希一致就什么都不做。返回 { status, actions, patch, inSync }：
// patch 是要存回面板记录的字段（新生成的 UUID、清掉已过期的旧 UUID）；代理自己的环境变量有问题（status.ok 为假）时不下发
async function syncProxy(proxy, table) {
  const actions = [];
  let st = await callProxyOk(proxy, 'status', {});
  if (!st.ok) return { status: st, actions, patch: {}, inSync: false };
  const patch = {};
  if (!proxy.uuid) { patch.uuid = crypto.randomUUID(); actions.push('已生成 UUID'); }
  if (proxy.prev && proxy.prevUntil <= Date.now()) { patch.prev = ''; patch.prevUntil = 0; }
  const next = Object.assign({}, proxy, patch);
  const state = buildState(next, table);
  const raw = JSON.stringify(state);
  const want = await shortHash(raw);
  if (st.stateHash !== want) {
    const r = await callProxyOk(proxy, 'setState', null, raw);
    actions.push(st.provisioned ? '已把设置重新下发给代理' : '已把 UUID 与设置下发给代理');
    // 以 setState 的回应为准（代理写入 KV 后返回所存内容的哈希），不再另查一次 status：
    // 那次请求可能落在代理的另一个 isolate 上，它内存里还是旧状态，会误报「没有按下发的内容更新」
    st = Object.assign({}, st, { stateHash: String(r.stateHash || ''), provisioned: state.uuids.length > 0, enabled: state.enabled, kvError: '' });
  }
  return { status: st, actions, patch, inSync: st.stateHash === want };
}
// ---------------------------------------------------------------------------
// 代理列表：面板 KV 里的 proxies（一个 JSON 数组），每项 { id, name, host, nodePath, uuid, key, enabled, prev, prevUntil, edgeIP, hop, hopMode, altMode, altCustom }
// ---------------------------------------------------------------------------
// 面板是代理全部状态的唯一权威：UUID（含轮换后限时保留的旧 UUID：prev / prevUntil）、启用开关与运行设置
// （edgeIP 落地 IP、hop 出站代理地址、hopMode 出站方式、altMode / altCustom 备用线路的选用方式）都存在这里，
// 整份下发给代理（buildState → 控制接口 setState）。密钥只写不读：接口不回传，备份不导出。
const UUID_GRACE_MS = 10 * 60 * 1000;   // 更换 UUID 后，旧 UUID 在代理上再保留 10 分钟
// 订阅合并所有可用的代理（见 readyProxies）；接口 /api/proxies 与面板的代理列表按多个代理设计。
const PROXIES_KEY = 'proxies';
const PROXIES_MAX = 8;

function publicProxy(p) {
  return {
    id: p.id, name: p.name, host: p.host, nodePath: p.nodePath, uuid: p.uuid, keySet: !!p.key, enabled: p.enabled,
    prevUntil: p.prev && p.prevUntil > Date.now() ? p.prevUntil : 0,
    edgeIP: p.edgeIP, hop: p.hop, hopMode: p.hopMode, altMode: p.altMode, altCustom: p.altCustom,
  };
}
function cleanProxyRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const id = String(r.id || '');
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) return null;
  return {
    id, name: String(r.name || '').slice(0, 40) || id,
    host: String(r.host || '').toLowerCase(), nodePath: String(r.nodePath || ''),
    uuid: isUUID(r.uuid) ? String(r.uuid).toLowerCase() : '', key: typeof r.key === 'string' ? r.key : '', enabled: r.enabled !== false,
    prev: isUUID(r.prev) ? String(r.prev).toLowerCase() : '', prevUntil: Number(r.prevUntil) > 0 ? Number(r.prevUntil) : 0,
    edgeIP: typeof r.edgeIP === 'string' ? r.edgeIP : '', hop: typeof r.hop === 'string' ? r.hop : '', hopMode: r.hopMode === 'only' ? 'only' : '',
    altMode: r.altMode === 'custom' || r.altMode === 'off' ? r.altMode : 'auto', altCustom: typeof r.altCustom === 'string' ? r.altCustom : '',
  };
}
// 读入面板配置时附带代理列表：cfg.proxies 全部，cfg.proxy 第一个启用的（面板接口没指定 id 时的默认代理）；读取失败记在 cfg._proxiesError（此时拒绝保存）
async function attachProxies(env, cfg) {
  cfg.proxies = []; cfg.proxy = null;
  const kv = kvStore(env);
  if (!kv || typeof kv.get !== 'function') return;
  try {
    const raw = await kv.get(PROXIES_KEY, { cacheTtl: 30 });
    if (raw) {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new SyntaxError('not an array');
      cfg.proxies = arr.map(cleanProxyRecord).filter(Boolean).slice(0, PROXIES_MAX);
    }
  } catch (e) { cfg._proxiesError = (e instanceof SyntaxError) ? 'corrupt' : 'unavailable'; }
  cfg.proxy = cfg.proxies.find(p => p.enabled) || null;
}
async function saveProxies(env, list) {
  const kv = kvStore(env);
  if (!kv || typeof kv.put !== 'function') throw new Error('未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存代理');
  await kv.put(PROXIES_KEY, JSON.stringify(list));
}

// 校验并规范化管理员提交的字段（partial：更新时只处理出现的项；密钥留空 = 保持不变）。返回 { value, errors }
function sanitizeProxyInput(input, { partial } = {}) {
  const value = {}, errors = [];
  const err = (field, msg) => errors.push({ field, msg });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value, errors: [{ field: '', msg: '请求体必须为 JSON 对象' }] };
  const has = (k) => input[k] !== undefined;
  const str = (k) => (input[k] == null ? '' : String(input[k]).trim());
  if (has('name')) { const v = str('name'); if (v.length > 40) err('name', '名称最长 40 个字符'); else value.name = v; }
  if (has('host') || !partial) {
    const v = str('host').replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
    if (!v) err('host', '请填写代理的域名，如 node.example.com');
    else if (!proxyHostOk(v)) err('host', '代理域名不正确：只能是域名（不是 IP），不带端口或路径');
    else value.host = v;
  }
  if (has('nodePath') || !partial) {
    const v = str('nodePath').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!v) err('nodePath', '请填写代理的节点路径（与代理的环境变量 PATH 相同）');
    else if (!new RegExp(PATH_SEG_PATTERN).test(v) || v.length > 128) err('nodePath', '只能包含字母、数字及 . _ ~ -（不含 /），最长 128 位');
    else value.nodePath = v;
  }
  if (has('uuid')) {
    const v = str('uuid').toLowerCase();
    if (v && !isUUID(v)) err('uuid', 'UUID 格式不正确（应为 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx；留空则连接时自动生成）');
    else value.uuid = v;
  }
  if (has('key') && str('key') !== '') {
    const v = String(input.key).trim();
    if (v.length < 24 || v.length > 256 || !/^[\x21-\x7e]+$/.test(v)) err('key', '密钥至少 24 位，只能是可见的 ASCII 字符（可以点「生成密钥」）');
    else value.key = v;
  } else if (!partial) err('key', '请填写密钥（与代理的环境变量 NODE_KEY 相同；可以点「生成密钥」）');
  if (has('enabled')) { if (typeof input.enabled !== 'boolean') err('enabled', '必须为开或关'); else value.enabled = input.enabled; }
  // 运行设置（落地 IP / 出站代理 / 出站方式 / 备用线路）：字符串原样保存（出站代理校验通过后才保存），下发时再解析
  if (has('edgeIP')) { const r = checkEdgeIP(input.edgeIP); if (r.error) err('edgeIP', r.error); else value.edgeIP = r.value; }
  if (has('hop')) { const v = String(input.hop == null ? '' : input.hop).trim(); const r = parseHopInput(v); if (r.error) err('hop', r.error); else value.hop = v; }
  if (has('hopMode')) { if (input.hopMode !== '' && input.hopMode !== 'only') err('hopMode', '出站方式不支持「' + String(input.hopMode).slice(0, 20) + '」'); else value.hopMode = input.hopMode; }
  if (has('altMode')) { if (!['auto', 'custom', 'off'].includes(input.altMode)) err('altMode', '备用线路方式不支持「' + String(input.altMode).slice(0, 20) + '」'); else value.altMode = input.altMode; }
  if (has('altCustom')) { const r = parseAltPick(input.altCustom); if (r.error) err('altCustom', r.error); else value.altCustom = r.pick.join(','); }
  return { value, errors };
}
// 合并后的整条记录的交叉校验（单项校验过不了的组合）：返回 [{ field, msg }]
function crossCheckProxy(r) {
  const errors = [];
  if (r.altMode === 'custom' && !r.altCustom) errors.push({ field: 'altCustom', msg: '已选择自定义顺序，请填写要用的线路标签（或改回自动 / 关闭）' });
  if (r.hopMode === 'only' && !r.hop) errors.push({ field: 'hop', msg: '出站方式选了「仅走出站代理」，请先填写出站代理' });
  return errors;
}
function newProxyId() { return b64uOfBytes(crypto.getRandomValues(new Uint8Array(6))); }

// 代理应有的完整状态（整份下发）：键的顺序固定，JSON 文本因此稳定，代理返回的 stateHash 可以与面板自己算的比较。
// table 是备用线路表（parseAltRoutes 的结果）；已经过期的旧 UUID 仍然列在里面（代理自己会忽略），避免状态哈希因时间流逝而变化，
// 下一次同步时由 syncProxy 清掉
function buildState(p, table) {
  const uuids = [[p.uuid, 0]];
  if (p.prev && p.prevUntil) uuids.push([p.prev, p.prevUntil]);
  const hop = p.hop ? parseHopInput(p.hop).hop : null;
  const pick = p.altMode === 'off' ? [] : p.altMode === 'custom' ? parseAltPick(p.altCustom).pick : ALT_PICK_DEFAULT;
  return { uuids, enabled: p.enabled, edgeIP: p.edgeIP || '', hop, hopMode: p.hopMode || '', altTable: table || {}, altPick: pick };
}

// 订阅会下发的代理：启用、且域名 / 节点路径 / UUID 都已齐全（多个时订阅合并它们的节点）
function readyProxies(cfg) {
  return (cfg.proxies || []).filter(p => p.enabled && p.host && p.nodePath && p.uuid);
}
// 订阅需要的代理端点是否齐全：返回尚未就绪的说明（空数组 = 可以生成订阅）
function endpointMissing(cfg) {
  if (cfg._proxiesError) return ['代理列表（' + (cfg._proxiesError === 'corrupt' ? 'KV 里的内容已损坏' : 'KV 暂时无法读取') + '）'];
  if (readyProxies(cfg).length) return [];
  const on = (cfg.proxies || []).filter(p => p.enabled);
  if (!on.length) return [cfg.proxies && cfg.proxies.length ? '启用中的代理（现有的都已停用）' : '代理（请先在「面板设置 → 代理」添加）'];
  const px = on[0];
  return [['host', '代理域名'], ['nodePath', '节点路径'], ['uuid', 'UUID（点「连接并同步」会自动生成并下发）']].filter(([k]) => !px[k]).map(([, label]) => label);
}
// ---------------------------------------------------------------------------
// 面板的代理管理接口（需登录）：/api/proxies（增删改、同步、启停、换 UUID）、/api/proxy-sync-all、/api/proxy-status、/api/alt-routes
// ---------------------------------------------------------------------------
const pickProxy = (cfg, id) => (id ? cfg.proxies.find(p => p.id === id) : (cfg.proxy || cfg.proxies[0])) || null;

// 备用线路表（解析后）：线路表读不到时不能下发（会把代理上的线路换成默认表），直接报错
async function loadAltTable(env) {
  const r = await readRoutes(env);
  if (r.error) throw new Error('备用线路表读取失败（KV 暂时无法读取），为避免下发错误的内容，已取消');
  return parseAltRoutes(r.text).table;
}

// 由代理的 status 回应得出面板用的状态；inSync = 代理上保存的状态与面板应下发的完全一致
async function statusFrom(p, st, table) {
  const want = p.uuid ? await shortHash(JSON.stringify(buildState(p, table))) : '';
  return {
    configured: true, id: p.id, name: p.name, enabledHere: p.enabled,
    up: true, ok: st.ok === true, version: String(st.version || ''), problems: Array.isArray(st.problems) ? st.problems.map(String) : [],
    storage: st.storage === true, kvError: String(st.kvError || ''), provisioned: st.provisioned === true, enabled: st.enabled !== false,
    inSync: !!want && st.stateHash === want,
  };
}
// 代理状态（给仪表盘）：调用失败不抛错，返回 { configured, up, error }
async function proxyStatusOf(p, table) {
  if (!p) return { configured: false };
  const base = { configured: true, id: p.id, name: p.name, enabledHere: p.enabled };
  if (!p.key) return Object.assign(base, { up: false, error: '没有填写密钥' });
  try { return await statusFrom(p, await callProxyOk(p, 'status', {}), table); }
  catch (e) { return Object.assign(base, { up: false, error: String((e && e.message) || e) }); }
}
const proxyFail = (e) => json({ ok: false, msg: String((e && e.message) || e), errors: (e && e.errors) || [] }, (e && e.errors && e.errors.length) ? 400 : 502);
const fieldErrors = (errors) => json({ ok: false, msg: errors.map(e => e.msg).join('；'), errors }, 400);

async function handleProxiesApi(apiName, request, env, cfg, segs, url) {
  const method = request.method;
  const guardWrite = () => {
    if (cfg._proxiesError) return json({ ok: false, msg: '代理列表读取失败（' + (cfg._proxiesError === 'corrupt' ? 'KV 里的内容已损坏' : 'KV 暂时无法读取') + '），为避免覆盖已有数据，已禁止保存' }, 503);
    const kv = kvStore(env);
    if (!kv || typeof kv.put !== 'function') return json({ ok: false, msg: '未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存代理；请在面板 Worker 设置中绑定 KV 后重试' }, 400);
    return null;
  };
  const readBody = async () => { try { return await request.json(); } catch (e) { return undefined; } };
  const save = async (list) => { await saveProxies(env, list); cfg.proxies = list; cfg.proxy = list.find(p => p.enabled) || null; };
  const patchOf = (id, patch) => cfg.proxies.map(x => (x.id === id ? Object.assign({}, x, patch) : x));

  // 同步一个代理并把可能新生成的 UUID 存回面板；失败不抛错，返回 { ok:false, error }
  const syncAndStore = async (id, table) => {
    const p = cfg.proxies.find(x => x.id === id);
    try {
      const r = await syncProxy(p, table);
      if (Object.keys(r.patch).length) await save(patchOf(id, r.patch));
      const cur = cfg.proxies.find(x => x.id === id);
      return { ok: r.status.ok === true && r.inSync, actions: r.actions, status: await statusFrom(cur, r.status, table), error: !r.status.ok ? (r.status.problems || []).join(' ') : (r.inSync ? '' : '代理没有按下发的内容更新状态') };
    } catch (e) { return { ok: false, error: String((e && e.message) || e), actions: [] }; }
  };
  const withTable = async (fn) => { let table; try { table = await loadAltTable(env); } catch (e) { return json({ ok: false, msg: e.message }, 503); } return fn(table); };

  if (apiName === 'alt-routes') {
    if (method === 'GET') {
      const r = await readRoutes(env);
      return json({ ok: true, data: { text: r.text, defaultText: DEFAULT_ALT_ROUTES, tags: Object.keys(parseAltRoutes(r.text).table), error: r.error } });
    }
    if (method !== 'POST') return json({ ok: false, msg: '仅支持 GET / POST' }, 405);
    const kv = kvStore(env);
    if (!kv || typeof kv.put !== 'function') return json({ ok: false, msg: '未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存线路表' }, 400);
    const body = await readBody();
    if (!body || typeof body.text !== 'string' || body.text.length > 8000) return json({ ok: false, msg: '缺少线路表文本（text，最长 8000 个字符）' }, 400);
    const { table, errors } = parseAltRoutes(body.text);
    if (errors.length) return fieldErrors(errors.map(e => ({ field: 'text', msg: e.msg })));
    await saveRoutes(env, body.text);
    return json({ ok: true, data: { tags: Object.keys(table) } });
  }
  if (apiName === 'proxy-sync-all') {
    if (method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
    const blocked = guardWrite(); if (blocked) return blocked;
    return withTable(async (table) => {
      const results = [];
      for (const p of cfg.proxies) results.push(Object.assign({ id: p.id, name: p.name }, await syncAndStore(p.id, table)));
      return json({ ok: true, data: { results } });
    });
  }
  if (apiName === 'proxy-status') {
    if (method !== 'GET') return json({ ok: false, msg: '仅支持 GET' }, 405);
    return withTable(async (table) => {
      // ?all=1：全部代理的状态（并行查询，给仪表盘与代理列表）
      if (url.searchParams.get('all') === '1') return json({ ok: true, data: { proxies: await Promise.all(cfg.proxies.map(p => proxyStatusOf(p, table))) } });
      return json({ ok: true, data: await proxyStatusOf(pickProxy(cfg, url.searchParams.get('id')), table) });
    });
  }

  // /api/proxies[/<id>[/<action>]]
  const id = segs[3] || '', action = segs[4] || '';
  if (!id) {
    if (method === 'GET') return json({ ok: true, data: { proxies: cfg.proxies.map(publicProxy), error: cfg._proxiesError || '' } });
    if (method !== 'POST') return json({ ok: false, msg: '仅支持 GET / POST' }, 405);
    const blocked = guardWrite(); if (blocked) return blocked;
    if (cfg.proxies.length >= PROXIES_MAX) return json({ ok: false, msg: '最多 ' + PROXIES_MAX + ' 个代理' }, 400);
    const body = await readBody();
    const { value, errors } = sanitizeProxyInput(body);
    const rec = cleanProxyRecord(Object.assign({ id: newProxyId(), name: '代理 ' + (cfg.proxies.length + 1), uuid: '', enabled: true }, value));
    const all = errors.concat(errors.length ? [] : crossCheckProxy(rec));
    if (all.length) return fieldErrors(all);
    return withTable(async (table) => {
      await save([...cfg.proxies, rec]);
      const sync = body.sync === false ? null : await syncAndStore(rec.id, table);
      return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === rec.id)), sync } });
    });
  }
  const p = cfg.proxies.find(x => x.id === id);
  if (!p) return (method !== 'GET' && guardWrite()) || json({ ok: false, msg: '没有这个代理' }, 404);
  if (!action) {
    const blocked = method === 'GET' ? null : guardWrite(); if (blocked) return blocked;
    if (method === 'GET') return json({ ok: true, data: { proxy: publicProxy(p) } });
    if (method === 'DELETE') {
      await save(cfg.proxies.filter(x => x.id !== id));
      return json({ ok: true, msg: '已从面板删除；代理本身没有被改动（要让它停止服务，请先「停用」再删除，或到代理上清除）' });
    }
    if (method !== 'POST') return json({ ok: false, msg: '仅支持 GET / POST / DELETE' }, 405);
    const body = await readBody();
    const { value, errors } = sanitizeProxyInput(body, { partial: true });
    const next = cleanProxyRecord(Object.assign({}, p, value));
    const all = errors.concat(errors.length ? [] : crossCheckProxy(next));
    if (all.length) return fieldErrors(all);
    return withTable(async (table) => {
      await save(cfg.proxies.map(x => (x.id === id ? next : x)));
      const sync = body.sync === false ? null : await syncAndStore(id, table);
      return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === id)), sync } });
    });
  }
  if (method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
  const blocked = guardWrite(); if (blocked) return blocked;
  return withTable(async (table) => {
    if (action === 'sync') {
      const sync = await syncAndStore(id, table);
      return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === id)), sync } });
    }
    if (action === 'enabled') {
      const body = await readBody();
      if (!body || typeof body.enabled !== 'boolean') return json({ ok: false, msg: '缺少 enabled（true / false）' }, 400);
      // 面板这边立刻生效（停用的代理不进订阅）；同时把新状态下发给代理（停用 = 代理对外只显示 Hello World），代理没响应时只给出提醒，之后可以「连接并同步」补上
      await save(patchOf(id, { enabled: body.enabled }));
      const sync = await syncAndStore(id, table);
      const warning = sync.ok ? '' : '面板已' + (body.enabled ? '启用' : '停用') + '，但没能通知代理：' + sync.error + '。代理上的状态以后可以点「连接并同步」补上';
      return json({ ok: true, data: { proxy: publicProxy(cfg.proxies.find(x => x.id === id)), synced: sync.ok, warning } });
    }
    if (action === 'rotate') {
      // 先把新 UUID 下发给代理，成功了才改面板的记录；旧 UUID 在代理上保留一段宽限期
      const next = Object.assign({}, p, { uuid: crypto.randomUUID(), prev: p.uuid, prevUntil: p.uuid ? Date.now() + UUID_GRACE_MS : 0 });
      try {
        const r = await syncProxy(next, table);
        if (!r.status.ok) throw new Error('代理的环境变量有问题：' + (r.status.problems || []).join(' '));
        if (!r.inSync) throw new Error('代理没有按下发的内容更新状态');
      } catch (e) { return proxyFail(e); }
      await save(cfg.proxies.map(x => (x.id === id ? next : x)));
      return json({ ok: true, data: { proxy: publicProxy(next), graceMs: p.uuid ? UUID_GRACE_MS : 0 } });
    }
    return json({ ok: false, msg: '未知操作：' + action }, 404);
  });
}
// ---------------------------------------------------------------------------
// 优选器：候选提取（txt / HTML 多源）+ TCP 延迟测试
// ---------------------------------------------------------------------------
// 从任意数据源文本提取 IP 候选（兼容 txt 行式、HTML 表格、JSON 文本；仅保留合法 IPv4/IPv6）
// 内容解码：优先 UTF-8（fatal 严格解码），否则按 GBK 解码（对齐 edgetunnel 请求优选API 的编码检测；
// 国内优选 API 常返回 GB2312/GBK 编码，直接 text() 会乱码导致解析不到 IP）
// 使用 TextDecoder('utf-8', { fatal: true }) 严格解码：非法字节直接抛错才落入 GBK 兜底
// （不依赖 U+FFFD 替换符判定，避免含空格等正常内容的 UTF-8 源被误判为 GBK 而乱码）
function decodeUtf8OrGbk(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) { /* 非 UTF-8（GB2312/GBK 等）→ 尝试 GBK */ }
  try { return new TextDecoder('gbk').decode(bytes); } catch (e2) { /* 兜底 */ }
  return new TextDecoder().decode(bytes);
}

// 订阅时自动拉取最新优选 IP：HostMonit 优选 API（按移动 / 联通 / 电信分线路实测的 Cloudflare IP），10 分钟缓存。
// 调用其数据接口（key 为社区项目通用的公开 key，接口失效时由其它来源兜底）。
// 节点名带运营商（如「移动-01」），面板「运营商偏好」筛选据此生效。失败时沿用上次成功结果，都没有则返回 null
// 机房内共享缓存（Cache API）：第三方优选来源的结果放进 caches.default，同一机房的所有实例共用，10 分钟内只请求一次（内存缓存则每个新实例 / 冷启动都要重新请求）。Cache API 不可用（本地测试 / 部分域名下 put 不生效）时静默退回内存缓存
const SHARED_CACHE_BASE = 'https://hopline-cache.invalid/';
async function sharedCacheGet(key) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return null;
    const res = await caches.default.match(new Request(SHARED_CACHE_BASE + key));
    return res ? await res.json() : null;
  } catch (e) { return null; }
}
async function sharedCachePut(key, value, ttlSec) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return;
    await caches.default.put(new Request(SHARED_CACHE_BASE + key), new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + (ttlSec || 600) }
    }));
  } catch (e) { /* 写入失败不影响订阅 */ }
}
const HOSTMONIT_API = 'https://api.hostmonit.com/get_optimization_ip';
const HOSTMONIT_KEY = 'iDetkOys';
const HOSTMONIT_LINE_CN = { CM: '移动', CU: '联通', CT: '电信' };
const SUBPREF_CACHE = { t: 0, ips: null };
// 分线路优选结果合并：同一 IP 常被多条线路同时选中。
// 订阅中同一 IP 只能出现一次，因此每个 IP 生成一个节点，名称包含它出现的全部线路（如「移动/联通-01」），
// 运营商筛选勾选其中任一线路即保留。
// 输入 [{ ip, line }]（按接口顺序），输出 [{ ip, label, seq }]，seq 为同一名称下的两位序号
function mergeIpLines(entries) {
  const byIp = new Map();
  for (const e of entries) {
    if (!isValidIp(e.ip)) continue;
    const g = byIp.get(e.ip);
    if (!g) byIp.set(e.ip, { ip: e.ip, lines: [e.line] });
    else if (!g.lines.includes(e.line)) g.lines.push(e.line);
  }
  const counters = {};
  return [...byIp.values()].map(g => {
    const label = g.lines.join('/');
    counters[label] = (counters[label] || 0) + 1;
    return { ip: g.ip, label, seq: String(counters[label]).padStart(2, '0') };
  });
}
// 读取响应正文（失败返回空串）
async function readText(res) { try { return await res.text(); } catch (e) { return ''; } }
// 解析 HTML 线路表（wetest 等页面）：每个 <tr> 中形如 <td data-label="线路名称">…</td><td data-label="优选地址">…</td> 的单元格。
// 返回 [{ ip, port, cells }]（cells 为 data-label → 文本）。优选地址支持 IPv4[:端口]、[IPv6]:端口 与裸 IPv6，无端口时为 443；地址无效的行跳过
function parseLineTableRows(content) {
  const out = [];
  for (const row of content.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = {};
    for (const td of row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []) {
      const lm = td.match(/data-label="([^"]*)"[^>]*>([\s\S]*?)<\/td>/);
      if (lm) cells[lm[1]] = lm[2].replace(/<[^>]+>/g, '').trim();
    }
    const addr = (cells['优选地址'] || '').trim();
    let m, ip, port;
    if (addr.indexOf(':') !== addr.lastIndexOf(':')) {   // 两个以上冒号：IPv6
      m = addr.match(/^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/) || addr.match(/^([0-9a-fA-F:]+)$/);
      if (!m || !isValidIp(m[1])) continue;
    } else {
      m = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/);
      if (!m) continue;
    }
    ip = m[1]; port = m[2] ? parseInt(m[2], 10) : 443;
    out.push({ ip, port, cells });
  }
  return out;
}
// 单次拉取 HostMonit 并解析（不读写缓存；面板「测试」按钮与订阅生成共用）。
// 返回 { status, raw, items: 保留的 CF 段节点, dropped: 丢弃的非 CF 段 IP, error }
async function hostmonitFetch(maxCount) {
  const r = { status: 0, raw: '', items: [], dropped: [], error: '' };
  const res = await fetchTimeout(HOSTMONIT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ key: HOSTMONIT_KEY }),
  }, 6000);
  if (!res) { r.error = '请求失败或超时'; return r; }
  r.status = res.status;
  r.raw = await readText(res);
  if (!res.ok) { r.error = 'HTTP ' + res.status; return r; }
  let j;
  try { j = JSON.parse(r.raw); } catch (e) { r.error = '响应不是 JSON'; return r; }
  const entries = (j && Array.isArray(j.info) ? j.info : []).map(x => ({
    ip: String((x && x.ip) || '').trim(),
    line: HOSTMONIT_LINE_CN[String((x && x.line) || '').toUpperCase()] || '优选',
  }));
  for (const g of mergeIpLines(entries)) {
    if (!isCloudflareIP(g.ip)) { r.dropped.push(g.ip); continue; }
    r.items.push({ ip: g.ip, port: 443, name: g.label + '-' + g.seq });
    if (r.items.length >= maxCount) break;
  }
  if (!r.items.length) r.error = '响应中没有 Cloudflare 段 IP';
  return r;
}
async function fetchLatestPreferredIPs(maxCount) {
  maxCount = Math.max(1, parseInt(maxCount) || 150);
  if (SUBPREF_CACHE.ips && Date.now() - SUBPREF_CACHE.t < 10 * 60 * 1000) return SUBPREF_CACHE.ips;
  const shared = await sharedCacheGet('hostmonit');
  if (shared && shared.length) { SUBPREF_CACHE.t = Date.now(); SUBPREF_CACHE.ips = shared; return shared; }
  const r = await hostmonitFetch(maxCount);
  if (r.items.length) { SUBPREF_CACHE.t = Date.now(); SUBPREF_CACHE.ips = r.items; await sharedCachePut('hostmonit', r.items); return r.items; }
  return SUBPREF_CACHE.ips;   // 本次失败：沿用上次成功结果（可能为 null）
}

// uouin 分线路优选（api.uouin.com）：电信 / 联通 / 移动 / 多线（BGP）/ IPv6 各约 10 个实测 Cloudflare IP。
// ⚠ 这不是对方的开放 API，而是其网站前端使用的内部接口：签名方式模仿网站前端
//   key = md5( md5('DdlTxtN0sUOu') + '70cloudflareapikey' + 毫秒时间戳 )，签名错误时对方会提示「请使用开放API」。
//   对方随时可能更换签名或封禁，失败时静默返回上次结果，由其它来源兜底；面板中默认关闭。
//   10 分钟缓存：每个 Worker 实例每小时最多请求约 6 次，避免给对方造成压力。
// 节点名带线路与来源后缀（如「电信-U01」「多线-U01」「IPv6-U01」），运营商筛选按线路生效
const UOUIN_API = 'https://api.uouin.com/index.php/index/Cloudflare';
const UOUIN_GROUPS = [['ctcc', '电信'], ['cucc', '联通'], ['cmcc', '移动'], ['bgp', '多线'], ['ipv6', 'IPv6']];
const UOUIN_CACHE = { t: 0, ips: null };
// 单次拉取 uouin 并解析（不读写缓存；面板「测试」按钮与订阅生成共用），返回格式同 hostmonitFetch
async function uouinFetch() {
  const r = { status: 0, raw: '', items: [], dropped: [], error: '' };
  const time = String(Date.now());
  const key = md5hex(md5hex('DdlTxtN0sUOu') + '70cloudflareapikey' + time);
  const res = await fetchTimeout(UOUIN_API + '?key=' + key + '&time=' + time, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 6000);
  if (!res) { r.error = '请求失败或超时'; return r; }
  r.status = res.status;
  r.raw = await readText(res);
  if (!res.ok) { r.error = 'HTTP ' + res.status; return r; }
  let j;
  try { j = JSON.parse(r.raw); } catch (e) { r.error = '响应不是 JSON'; return r; }
  const data = (j && j.data) || {};
  if (!j || !j.data) r.error = (j && j.msg) ? '接口返回：' + j.msg : '响应中没有 data 字段';
  const entries = [];
  for (const [grp, line] of UOUIN_GROUPS) {
    for (const x of ((data[grp] || {}).info || [])) entries.push({ ip: String((x && x.ip) || '').trim().replace(/^\[|\]$/g, ''), line });
  }
  for (const g of mergeIpLines(entries)) {
    if (!isCloudflareIP(g.ip)) { r.dropped.push(g.ip); continue; }
    r.items.push({ ip: g.ip, port: 443, name: g.label + '-U' + g.seq });
  }
  if (!r.items.length && !r.error) r.error = '响应中没有 Cloudflare 段 IP';
  return r;
}
async function fetchUouinIPs(wantV4, wantV6) {
  let list = UOUIN_CACHE.ips;
  if (!list || Date.now() - UOUIN_CACHE.t >= 10 * 60 * 1000) {
    const shared = await sharedCacheGet('uouin');
    if (shared && shared.length) { UOUIN_CACHE.t = Date.now(); UOUIN_CACHE.ips = shared; list = shared; }
    else {
      const r = await uouinFetch();
      if (r.items.length) { UOUIN_CACHE.t = Date.now(); UOUIN_CACHE.ips = r.items; list = r.items; await sharedCachePut('uouin', r.items); }
    }
  }
  // 按 IP 类型筛选取用（缓存中保留全部，v4 / v6 由调用方决定）
  return (list || []).filter(x => (x.ip.indexOf(':') >= 0 ? wantV6 : wantV4));
}

// 单次拉取自定义优选 API 并解析（不读写缓存；面板「测试」按钮用），返回格式同 hostmonitFetch。
// 与订阅生成使用同一解析器（resolvePreferredDomains），先不过滤取得全部条目，再按 CF 段拆分为保留 / 丢弃
async function customApiFetch(url) {
  const r = { status: 0, raw: '', items: [], dropped: [], error: '' };
  let seenRaw = false;
  const all = await resolvePreferredDomains(url, 200, 300, false, false, {
    fresh: true,
    onRaw: (u, status, text) => { seenRaw = true; r.status = status; r.raw = text; },
  }).catch(() => []);
  if (!seenRaw) r.error = '地址无效';
  else if (!r.status) r.error = '请求失败或超时';
  else if (r.status < 200 || r.status >= 300) r.error = 'HTTP ' + r.status;
  for (const x of all) (isValidIp(x.ip) && isCloudflareIP(x.ip) ? r.items : r.dropped).push(isValidIp(x.ip) && isCloudflareIP(x.ip) ? x : x.ip);
  if (!r.items.length && !r.error) r.error = r.dropped.length ? '解析到的地址都不是 Cloudflare 段 IP' : '未能从响应中解析出 IP';
  return r;
}

// 微测网（wetest.vip）优选：服务端渲染的公开页面，IPv4 / IPv6 各一页，移动 / 联通 / 电信各 5 个实测 Cloudflare IP，约每 15 分钟更新；
// 按线路命名并带来源后缀（IPv4「移动-W01」，IPv6「移动-W6-01」），运营商筛选按线路生效。
// 页面是 HTML 表格而非开放 API：版式变化时该来源静默失效、由其它来源兜底；10 分钟缓存，且只拉取当前 IP 类型筛选需要的页面
const WETEST_PAGES = {
  v4: { url: 'https://www.wetest.vip/page/cloudflare/address_v4.html', tag: 'W' },
  v6: { url: 'https://www.wetest.vip/page/cloudflare/address_v6.html', tag: 'W6-' },
};
const WETEST_CACHE = { v4: { t: 0, ips: null }, v6: { t: 0, ips: null } };
// 单次拉取并解析一页（不读写缓存），返回格式同 hostmonitFetch；raw 为解析出的行摘要（HTML 前部全是页头，原文没有排查价值）
async function wetestPageFetch(fam) {
  const r = { status: 0, raw: '', items: [], dropped: [], error: '' };
  const res = await fetchTimeout(WETEST_PAGES[fam].url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 6000);
  if (!res) { r.error = '请求失败或超时'; return r; }
  r.status = res.status;
  const html = await readText(res);
  if (!res.ok) { r.error = 'HTTP ' + res.status; r.raw = html; return r; }
  const rows = parseLineTableRows(html);
  if (!rows.length) { r.error = '页面中没有解析到 IP（版式可能已变化）'; r.raw = html; return r; }
  r.raw = rows.map(x => [x.cells['线路名称'], x.ip, x.cells['数据中心'], x.cells['往返延迟'], x.cells['更新时间']].filter(Boolean).join('  ')).join('\n');
  const entries = rows.map(x => ({ ip: x.ip, line: x.cells['线路名称'] || '优选' }));
  for (const g of mergeIpLines(entries)) {
    if (!isCloudflareIP(g.ip)) { r.dropped.push(g.ip); continue; }
    r.items.push({ ip: g.ip, port: 443, name: g.label + '-' + WETEST_PAGES[fam].tag + g.seq });
  }
  if (!r.items.length) r.error = '页面中没有 Cloudflare 段 IP';
  return r;
}
// 面板「测试」：两页都拉取并合并（不读写缓存）
async function wetestFetch() {
  const [a, b] = await Promise.all([wetestPageFetch('v4'), wetestPageFetch('v6')]);
  const r = { status: a.status || b.status, raw: 'IPv4 页面\n' + a.raw + '\n\nIPv6 页面\n' + b.raw, items: [...a.items, ...b.items], dropped: [...a.dropped, ...b.dropped], error: '' };
  const errs = [a.error && 'IPv4：' + a.error, b.error && 'IPv6：' + b.error].filter(Boolean);
  if (errs.length) r.error = errs.join('；');
  return r;
}
async function fetchWetestIPs(wantV4, wantV6) {
  const fams = [wantV4 && 'v4', wantV6 && 'v6'].filter(Boolean);
  const lists = await Promise.all(fams.map(async (fam) => {
    const c = WETEST_CACHE[fam];
    if (c.ips && Date.now() - c.t < 10 * 60 * 1000) return c.ips;
    const shared = await sharedCacheGet('wetest-' + fam);
    if (shared && shared.length) { c.t = Date.now(); c.ips = shared; return shared; }
    const r = await wetestPageFetch(fam);
    if (r.items.length) { c.t = Date.now(); c.ips = r.items; await sharedCachePut('wetest-' + fam, r.items); }
    return c.ips || [];   // 本次失败：沿用上次成功结果
  }));
  return lists.flat();
}

// 面板「优选域名 → 测试」：逐个解析域名的 A 记录，看是否落在 Cloudflare 段。
// 最多测前 PREF_DOMAIN_DOH_LIMIT 个（子请求预算）；返回格式同其它来源，另带 domains 明细
async function domainsFetch(list) {
  const r = { status: 200, raw: '', items: [], dropped: [], error: '', domains: [] };
  const names = list.slice(0, PREF_DOMAIN_DOH_LIMIT);
  const rows = await Promise.all(names.map(async (domain) => {
    const ips = await dohFirst(['https://cloudflare-dns.com/dns-query', 'https://dns.alidns.com/resolve'],
      (ep) => ep + '?name=' + encodeURIComponent(domain) + '&type=A',
      (j) => (!j || (j.Status !== 0 && j.Status !== 3)) ? null
        : (j.Answer || []).filter(a => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(String(a.data))).map(a => String(a.data)),
      { timeoutMs: 4000 });
    const cf = (ips || []).filter(isCloudflareIP);
    return { domain, failed: ips === null, ips: (ips || []).slice(0, 4), cf: cf.length, ok: cf.length > 0 };
  }));
  r.domains = rows;
  for (const row of rows) { if (row.ok) r.items.push({ ip: row.ips.find(isCloudflareIP), port: 443, name: row.domain }); else r.dropped.push(row.domain); }
  r.raw = rows.map(x => x.domain + ' → ' + (x.failed ? '解析失败' : (x.ips.join(', ') || '无 A 记录')) + (x.ok ? '' : '（不在 Cloudflare 段）')).join('\n');
  if (list.length > names.length) r.raw += '\n… 另有 ' + (list.length - names.length) + ' 个域名未测试（单次最多测 ' + PREF_DOMAIN_DOH_LIMIT + ' 个）';
  if (!r.items.length) r.error = '没有域名解析到 Cloudflare 段 IP';
  return r;
}
// ---------------------------------------------------------------------------
// 订阅生成
// ---------------------------------------------------------------------------
// XHTTP Padding（XHTTP Extra）参数：xPadding 混淆参数，客户端与服务端约定一致。
// header/key 两项由 UUID 内部切片派生（slice(1,7) / '_'+slice(25,31)），
// 其余三项为固定混淆策略。V2rayN（extra JSON，camelCase）与 mihomo
// （xhttp-opts，kebab-case）共用同一份派生结果。
function xhttpPadding(cfg) {
  const u = cfg.uuid || '';
  return {
    xPaddingObfsMode: true, xPaddingMethod: 'tokenish', xPaddingPlacement: 'queryInHeader',
    xPaddingHeader: u.slice(1, 7), xPaddingKey: '_' + u.slice(25, 31)
  };
}

// vless 分享链接 # 后的节点名：非 ASCII（中文等）原样输出、不做 URL 编码，仅转义 URI 特殊字符（% # ? 空格）。
// 原因：v2rayNG/AsteriskNG 对 fragment 的 %XX 按系统编码（GBK）做 URL 解码，UTF-8 编码的中文（%E9%A6...）会被误读成乱码
// （如 香港 → 棣欐腐、台湾 → 鋆版咕）；原样中文走明文 UTF-8，GBK/UTF-8 解码客户端均正常显示。
function uriFragName(name) {
  return String(name).replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/ /g, '%20');
}

// 多协议命名：同一地址同时下发 VLESS 与 XHTTP 时，XHTTP 名称加「.X」（VLESS 保持原名），
// 客户端一眼可辨协议，也避免 sing-box / Clash 因节点名重复而拒绝加载
function protoNames(name, enV, enX) {
  return enV && enX ? { v: name, x: name + '.X' } : { v: name, x: name };
}

// 订阅节点名全局去重：不同地址同名（如多个来源都叫「优选IP-01」）时依次追加「·2」「·3」，
// 所有格式（链接 / Clash / sing-box / Surge 等）统一使用去重后的名称
function uniqueNodeNames(nodes) {
  const seen = new Set();
  return nodes.map((n) => {
    const h = n.indexOf('#');
    if (h < 0) return n;
    let name;
    try { name = decodeURIComponent(n.slice(h + 1)); } catch (e) { name = n.slice(h + 1); }
    let cand = name, k = 2;
    while (seen.has(cand)) cand = name + '·' + k++;
    seen.add(cand);
    return cand === name ? n : n.slice(0, h + 1) + uriFragName(cand);
  });
}

// 多个代理合并订阅时，给节点名追加「·代理名」以区分来自哪个代理（名称里会破坏 Surge / Loon 配置语法的字符换成 -）
function tagNodeName(n, tag) {
  const h = n.indexOf('#');
  if (h < 0) return n;
  let name;
  try { name = decodeURIComponent(n.slice(h + 1)); } catch (e) { name = n.slice(h + 1); }
  const safe = String(tag || '').replace(/[,=#%?\s]+/g, '-').replace(/^-+|-+$/g, '');
  return safe ? n.slice(0, h + 1) + uriFragName(name + '·' + safe) : n;
}

// 面板 ALPN 设置（h2 / http/1.1，逗号分隔）→ 数组；未设置返回 null（各格式按协议取默认值）
function alpnList(alpn) {
  const a = String(alpn || '').split(',').map(x => x.trim()).filter(x => /^[\w./-]+$/.test(x));
  return a.length ? a : null;
}
// 分享链接中的 alpn 参数：逗号与斜杠原样输出（V2rayN 等按逗号拆分，整串编码为 %2C%2F 时部分客户端解析失败）
function alpnParam(alpn) {
  return (alpnList(alpn) || []).join(',');
}

function vssProtoNode(cfg, server, port, name, extra = {}) {
  const host = cfg.host;
  const addr = server.includes(':') && !server.startsWith('[') ? `[${server}]` : server;  // IPv6 需方括号
  const isTls = !HTTP_PORTS.has(Number(port));
  const enc = encodeURIComponent;
  let q = 'encryption=none';
  if (isTls) q += '&security=tls&sni=' + enc(host) + '&fp=chrome';
  else q += '&security=none';   // 80/8080/2052 等明文端口走明文 ws
  q += '&host=' + enc(host);
  const isXhttp = extra.type === 'xhttp' && isTls;
  if (isXhttp) {
    // XHTTP（stream-one）：仅 TLS 端口生效；必须携带 extra（JSON）作为 XHTTP Extra，否则 V2rayN 无法识别完整 xhttp 配置
    // Padding 头/键由 UUID 内部派生（切片），客户端按此发送，服务端按 VLESS 流处理 body
    q += '&type=xhttp&mode=stream-one';
    q += '&extra=' + enc(JSON.stringify(xhttpPadding(cfg)));
  }
  else q += '&type=ws';   // 明文端口与默认路径均走 ws
  // TLS 下的 ws 路径携带 ed=2048（WS 0-RTT 早数据，见 decodeEarlyData）；明文端口与 xhttp 不带
  q += '&path=' + enc('/' + cfg.nodePath + (!isXhttp && isTls ? '?ed=2048' : ''));
  // ALPN：面板设置优先；XHTTP stream-one 依赖 HTTP/2 双向流，未设置时显式指定 h2（与 Clash 输出一致），不依赖客户端内核的默认值
  if (isTls && (cfg.alpn || isXhttp)) q += '&alpn=' + (cfg.alpn ? alpnParam(cfg.alpn) : 'h2');
  if (cfg.ech && isTls) {
    // ECH：输出 "查询域名+DoH"（xray/V2rayN 客户端本地查询 ECH 配置，Worker 端拉取会与用户边缘密钥不匹配导致握手失败）
    q += '&ech=' + enc((cfg.echHost || 'cloudflare-ech.com') + '+' + (cfg.echDns || 'https://223.5.5.5/dns-query'));
  }
  return `vless://${cfg.uuid}@${addr}:${port}?${q}#${uriFragName(name)}`;
}

// 优选域名 / 优选 API 的 DNS 解析缓存（TTL 10 分钟：域名或 URL → IP 列表）
const DNH_CACHE = new Map();
// 优选 API 解析结果：写入内存缓存与机房共享缓存（10 分钟）
async function storeUrlCache(ck, rec) {
  DNH_CACHE.set(ck, { t: Date.now(), ips: rec });
  capMap(DNH_CACHE, 300);
  await sharedCachePut('url-' + md5hex(ck), rec, 600);
}
// 解析优选域名/优选API为 IP：URL 数据源与域名并发拉取（避免串行拖垮订阅墙钟）；按输入顺序均衡截断 maxTotal，保证各地区节点都有
// filterCF：true（订阅生成）只保留 Cloudflare 段 IP，保证可达；false 仅用于面板「测试」按钮，需要看到被丢弃的非 CF 段地址
// v6：默认 IPv4 模式跳过 AAAA 查询（省一半 DNS 子请求）；仅筛选含 IPv6 时传 true
// opts.fresh：不读缓存、失败不回退旧缓存（面板「测试」按钮用）；opts.onRaw(url, status, text)：回传优选 API 的原始响应
async function resolvePreferredDomains(domainsStr, limitPerDomain = 100, maxTotal = 300, filterCF = true, v6 = false, opts = {}) {
  const list = String(domainsStr || '').split(/[\n,;]+/).map(s => s.trim().replace(/^\*\./, '')).filter(Boolean);
  const now = Date.now();
  // DoH 降级链：CF 官方 1.1.1.1 优先（Worker 与 1.1.1.1 同机房，内网时延 <5ms），仅当请求本身失败（网络错误 / 非 200）
  // 才降级阿里 DNS：正常情况下每次解析只计 1 个子请求（免费版每次请求上限 50），「无该类型记录」不算失败
  const dohs = ['https://cloudflare-dns.com/dns-query', 'https://dns.alidns.com/resolve'];
  const qry = async (d, type, filter) => {
    for (const url of dohs) {
      const res = await fetchTimeout(url + '?name=' + encodeURIComponent(d) + '&type=' + type, { headers: { accept: 'application/dns-json' } }, 4000);
      if (!res || !res.ok) continue;
      try {
        const j = await res.json();
        return (j.Answer || []).filter(a => a.type === filter && (type === 'A' ? /^\d+\.\d+\.\d+\.\d+$/.test(a.data) : /^[0-9a-fA-F:]+$/.test(a.data))).map(a => a.data);
      } catch (e) { /* 响应不是 JSON：尝试下一个 DoH */ }
    }
    return [];
  };
  // 记录类型：v6=false 只查 A；v6=true 查 A + AAAA；v6='only' 只查 AAAA
  const family = v6 === 'only' ? 'v6' : (v6 ? 'v4v6' : 'v4');
  // 每个条目返回一个有序 IP 数组
  const perItem = await Promise.all(list.map(async (d) => {
    if (d.includes('://')) {
      // sub:// 子订阅前缀（与常见订阅转换器 / 优选工具的写法一致）——后面跟 base64(订阅URL) 或直接 URL
      if (d.startsWith('sub://')) {
        let real = d.slice(6);
        if (/^[A-Za-z0-9+/=]+$/.test(real) && real.length % 4 === 0) {
          try { const dec = atob(real); if (/^https?:\/\//i.test(dec)) real = dec; } catch (e) { /* 保持原样 */ }
        }
        if (!/^https?:\/\//i.test(real)) real = 'https://' + real;
        d = real;
      }
      const ck = 'url:' + d + (filterCF ? '' : '|raw');
      const cHit = DNH_CACHE.get(ck);
      if (!opts.fresh && cHit && now - cHit.t < 10 * 60 * 1000) return cHit.ips.slice(0, limitPerDomain);
      if (!opts.fresh) {
        const shared = await sharedCacheGet('url-' + md5hex(ck));
        if (Array.isArray(shared)) { DNH_CACHE.set(ck, { t: now, ips: shared }); capMap(DNH_CACHE, 300); return shared.slice(0, limitPerDomain); }
      }
      try {
        const res = await fetchTimeout(d, {}, 6000);
        if (!res) { if (opts.onRaw) opts.onRaw(d, 0, ''); throw new Error('unreachable'); }
        // edgetunnel 对齐：数组缓冲 + UTF-8/GBK 编码检测（国内优选 API 常返回 GB2312，直接 text() 会乱码）
        let txt = '';
        try { txt = decodeUtf8OrGbk(await res.arrayBuffer()); } catch (e) { /* 正文读取失败 */ }
        if (opts.onRaw) opts.onRaw(d, res.status, txt);
        if (!res.ok) throw new Error('unreachable');
        // 兼容多种数据源格式：base64 订阅 / CSV 优选表 / HTML 线路表 / vless 订阅行 / 纯 IP 行
        let content = txt;
        // base64 内容检测（子订阅常见输出）：整段可 base64 且长度对齐则解码后再解析；
        // atob 得到的是二进制串，用 decodeUtf8OrGbk 按 UTF-8/GBK 还原，避免 base64 源中文节点名乱码
        if (/^[A-Za-z0-9+/=\s]{40,}$/.test(content.slice(0, 2000)) && content.replace(/\s+/g, '').length % 4 === 0) {
          try {
            const raw = atob(content.replace(/\s+/g, ''));
            content = decodeUtf8OrGbk(Uint8Array.from(raw, c => c.charCodeAt(0)));
          } catch (e) { /* 非 base64，保持原文 */ }
        }
        const seen = new Set();
        const counters = {};
        const rec = [];
        // 追加/默认模式强制 CF 段；仅自定义模式（filterCF=false）原样下发
        const pass = (ip) => !filterCF || isCloudflareIP(ip);
        // CSV 优选表解析（对齐 edgetunnel 请求优选API）：
        // ① wetest 风格：IP地址,端口,数据中心[,TLS]（TLS 列非 true 跳过，避免明文端口无法转发）
        // ② hostmonit 风格：IP,延迟,下载速度 → 命名「CF优选 {延迟}ms {速度}MB/s」
        const csvLines = content.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (csvLines.length > 1 && csvLines[0].includes(',')) {
          const headers = csvLines[0].split(',').map(h => h.trim());
          const isWetest = headers.includes('IP地址') && headers.includes('端口');
          const isHostmonit = headers.some(h => h.includes('IP')) && headers.some(h => h.includes('延迟')) && headers.some(h => h.includes('下载速度'));
          if (isWetest || isHostmonit) {
            const ipIdx = headers.findIndex(h => h.includes('IP'));
            const portIdx = headers.indexOf('端口');
            const delayIdx = headers.findIndex(h => h.includes('延迟'));
            const speedIdx = headers.findIndex(h => h.includes('下载速度'));
            const remarkIdx = headers.indexOf('国家') > -1 ? headers.indexOf('国家') : headers.indexOf('城市') > -1 ? headers.indexOf('城市') : headers.indexOf('数据中心');
            const tlsIdx = headers.indexOf('TLS');
            for (const line of csvLines.slice(1)) {
              if (rec.length >= limitPerDomain) break;
              const cols = line.split(',').map(c => c.trim());
              if (tlsIdx !== -1 && cols[tlsIdx] && cols[tlsIdx].toLowerCase() !== 'true') continue;
              const raw = cols[ipIdx] || '';
              const ipm = raw.match(/(\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3})/);
              if (!ipm) continue;
              const ip = ipm[1].replace(/^\[|\]$/g, '');
              const port = portIdx !== -1 && cols[portIdx] ? parseInt(cols[portIdx]) : 443;
              const key = ip + ':' + port;
              if (seen.has(key)) continue;
              if (!pass(ip)) continue;
              seen.add(key);
              let nm = remarkIdx !== -1 && cols[remarkIdx] ? cols[remarkIdx] : '';
              if (!nm && delayIdx !== -1 && speedIdx !== -1) nm = 'CF优选 ' + (cols[delayIdx] || '') + 'ms ' + (cols[speedIdx] || '') + 'MB/s';
              if (nm) { counters[nm] = (counters[nm] || 0) + 1; rec.push({ ip, port, name: nm + '-' + String(counters[nm]).padStart(2, '0') }); }
              else rec.push({ ip, port, name: '' });
            }
            await storeUrlCache(ck, rec);
            return rec.slice();
          }
        }
        // HTML 线路表解析（wetest 等页面，IPv4 / IPv6 均可）：<td data-label="线路名称">…</td><td data-label="优选地址">IP[:端口]</td>…
        if (content.includes('<tr') && content.includes('data-label')) {
          for (const { ip, port, cells } of parseLineTableRows(content)) {
            if (rec.length >= limitPerDomain) break;
            const key = ip + ':' + port;
            if (seen.has(key)) continue;
            if (!pass(ip)) continue;
            seen.add(key);
            // 名称保留线路名称/数据中心（含「移动/联通/电信」时面板 isp 筛选生效）
            const nm = (cells['线路名称'] || cells['数据中心'] || '线路').trim();
            if (nm) { counters[nm] = (counters[nm] || 0) + 1; rec.push({ ip, port, name: nm + '-' + String(counters[nm]).padStart(2, '0') }); }
            else rec.push({ ip, port, name: '' });
          }
          await storeUrlCache(ck, rec);
          return rec.slice();
        }
        // vless 订阅行提取（子订阅/转换器输出）：vless://uuid@host:port#名称
        const lineRe = new RegExp('vl' + 'ess:' + '\\/\\/[^@\\s/]+@(\\[[0-9a-fA-F:]+\\]|[A-Za-z0-9.-]+)(?::(\\d{1,5}))?');
        for (const line of content.split(/\r?\n/)) {
          if (rec.length >= limitPerDomain) break;
          const vm = line.match(lineRe);
          if (!vm) continue;
          const host = vm[1].replace(/^\[|\]$/g, '');
          const port = vm[2] ? parseInt(vm[2]) : 443;
          const key = host + ':' + port;
          if (seen.has(key)) continue;
          if (!pass(host)) continue;
          seen.add(key);
          let nm = '';
          const hashIdx = line.indexOf('#');
          if (hashIdx >= 0) { try { nm = decodeURIComponent(line.slice(hashIdx + 1).trim()); } catch (e) { nm = line.slice(hashIdx + 1).trim(); } }
          if (nm) { counters[nm] = (counters[nm] || 0) + 1; rec.push({ ip: host, port, name: nm + '-' + String(counters[nm]).padStart(2, '0') }); }
          else rec.push({ ip: host, port, name: '' });
        }
        // 纯文本行：IP / IP:端口 / IP:端口#名称（如 bestcf 的 "IP:端口#地区随机 | 香港 HK | HKG | ..."）
        for (const raw of content.split(/\r?\n/)) {
          if (rec.length >= limitPerDomain) break;
          const m = raw.match(/(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:#([^\r\n]*))?/);
          if (!m) continue;
          const ip = m[1];
          const port = m[2] ? parseInt(m[2]) : 443;
          const key = ip + ':' + port;
          if (seen.has(key)) continue;   // 源内去重（同 IP 同端口只留一条）
          if (!pass(ip)) continue;
          seen.add(key);
          // 名称：优先匹配 "中文 地区码"（bestcf 格式 "地区随机 | 香港 HK"），再取纯中文段，再取地区码映射，否则留空走“优选IP-XX”兜底
          // 【新增】用户自定义名称（不含中文、不含 |）直接保留原样，例如 JP-A-147 / CF-B-163
          const rawName = (m[3] || '').trim();
          if (rawName && !/[\u4e00-\u9fa5]/.test(rawName) && !rawName.includes('|')) {
            rec.push({ ip, port, name: rawName });
            continue;
          }
          let nm = '';
          if (m[3]) {
            // 优先匹配「中文地区名 + 空格 + 地区码」（如 "澳大利亚 AU"），锚定开头避免 4 字以上地区名被截断（如"澳大利亚"误取"大利亚"）
            const zhCode = m[3].match(/^\s*[\u4e00-\u9fa5]{2,5}\s+[A-Z]{2}/);
            if (zhCode) { const cn = zhCode[0].match(/[\u4e00-\u9fa5]{2,5}/); if (cn) nm = cn[0]; }
            else {
              const segs = m[3].split('|').map(s => s.trim());
              // 优先取「中文名+空格+地区码」段（bestcf 格式 "地区随机 | 香港 HK"），避免把 "地区随机" 前缀当地区名
              const segCode = segs.find(s => /^[\u4e00-\u9fa5]{2,5}\s+[A-Z]{2}$/.test(s));
              if (segCode) { const cn = segCode.match(/[\u4e00-\u9fa5]{2,5}/); if (cn) nm = cn[0]; }
              else {
                // | 分隔的独立中文段（如 "澳大利亚"、"印度尼西亚"），放宽到 2-5 字并排除 bestcf 等前缀词
                const zh = segs.find(s => /^[\u4e00-\u9fa5]{2,5}$/.test(s) && !/^(地区随机|随机优选|官方优选|优选|CF优选)$/.test(s));
                if (zh) nm = zh;
                else { const code = m[3].match(/\b([A-Z]{2})\b/); if (code) nm = REGION_CN[code[1]] || code[1]; }
              }
            }
          }
          if (nm) { counters[nm] = (counters[nm] || 0) + 1; rec.push({ ip, port, name: nm + '-' + String(counters[nm]).padStart(2, '0') }); }
          // 提取不到地区的中文名称（如「自有-A」）原样保留（截断 40 字符）
          else rec.push({ ip, port, name: rawName.slice(0, 40) });
        }
        await storeUrlCache(ck, rec);
        return rec.slice();   // 返回副本：均衡截断的 shift() 会原地修改数组，直接返回引用会污染缓存
      } catch (e) {
        // SWR 平滑容灾：当次拉取网络异常/超时，沿用上一轮有效缓存兜底，确保外部数据源抖动时订阅永不枯竭
        const stale = DNH_CACHE.get(ck);
        if (!opts.fresh && stale && stale.ips && stale.ips.length) return stale.ips.slice(0, limitPerDomain);
        return [];   // 无历史缓存才返回空
      }
    }
    // 缓存键包含记录类型：A 与 A+AAAA 不能共用同一键，否则 IPv6 查询可能命中只含 IPv4 的缓存
    const dk = d + '|' + family;
    const hit = DNH_CACHE.get(dk);
    if (hit && now - hit.t < 10 * 60 * 1000) return hit.ips.slice(0, limitPerDomain).map((ip, i) => ({ ip, port: 443, name: d + '-' + (i + 1) }));
    // 按需解析：默认仅查 A（IPv4），筛选含 IPv6 时才查 AAAA，节省 DNS 子请求
    const aRec = family === 'v6' ? [] : await qry(d, 'A', 1);
    const aaaaRec = family === 'v4' ? [] : await qry(d, 'AAAA', 28);
    // filterCF=false（仅面板测试）：域名解析结果原样返回，不做 CF 段过滤
    let ips = [...new Set(aRec.concat(aaaaRec))].filter(ip => filterCF ? isCloudflareIP(ip) : true);
    ips = ips.slice(0, limitPerDomain);
    if (!ips.length) {
      // SWR：当次解析失败（死链/超时）但有历史缓存（无论是否过期）→ 沿用旧数据兜底
      if (hit && hit.ips && hit.ips.length) return hit.ips.slice(0, limitPerDomain).map((ip, i) => ({ ip, port: 443, name: d + '-' + (i + 1) }));
      return [];
    }
    DNH_CACHE.set(dk, { t: now, ips }); capMap(DNH_CACHE, 300);
    return ips.map((ip, i) => ({ ip, port: 443, name: d + '-' + (i + 1) }));
  }));
  // 按输入顺序均衡截断：轮流取每条目的节点，保证各地区/域名都有且总量受控
  const out = [];
  let got = 0;
  while (got < maxTotal) {
    let any = false;
    for (const arr of perItem) {
      if (got >= maxTotal) break;
      if (arr.length) { out.push(arr.shift()); got++; any = true; }
    }
    if (!any) break;
  }
  return out;
}

async function buildNodes(cfg, cap = NODE_CAP) {
  const nodes = [];
  const used = new Set();
  // 筛选含 IPv6 时才需要交替排列 v4 / v6（见下方 preferredIPs 重排）
  const ipT = (cfg.filter && cfg.filter.ipType) || [];
  const wantV6 = ipT.includes('IPv6');
  const onlyV6 = ipT.length === 1 && ipT[0] === 'IPv6';
  // 节点形态：端口原样单端口下发（固定 443、不随机 TLS 端口、不追加明文端口变体）。
  // 入口 IP 必须是 CF 段——非 CF IP 无法转发到 Worker（历史 v2rayNG 全 -1 根因），直接丢弃；域名节点由客户端解析，不在此限制
  const push = (server, port, name) => {
    if (nodes.length >= cap) return;   // 生成过程限流：避免多协议膨胀超 Worker CPU
    if (isValidIp(server) && !isCloudflareIP(server)) return;
    const key = server + ':' + port;   // 按 服务器:端口 去重（单端口机制：同 IP 同端口仅下发一次）
    if (used.has(key)) return;
    used.add(key);
    const isTls = !HTTP_PORTS.has(Number(port));
    if (cfg.tlsOnly && !isTls) return;   // TLS 控制：仅下发 TLS 端口节点，明文端口跳过
    // 节点端口按源端口原样下发（通常是 443），不做 TLS 端口随机（443 全域可达性最佳）
    const finalPort = Number(port);
    const enVss = cfg['enableVl' + 'ess'];
    const nm = protoNames(name, enVss, cfg.enableXhttp && isTls);
    if (enVss) nodes.push(vssProtoNode(cfg, server, finalPort, nm.v));
    if (cfg.enableXhttp && isTls) nodes.push(vssProtoNode(cfg, server, finalPort, nm.x, { type: 'xhttp' }));  // XHTTP 仅 TLS 端口
  };
  // 按源端口（通常 443）下发；关闭「仅 TLS 端口」时，443 节点另追加一个 80 明文端口节点（名称加「·80」）
  const multiPort = (server, port, name) => {
    port = Number(port) || 443;
    push(server, port, name);
    if (!cfg.tlsOnly && port === 443) push(server, 80, name + '·80');
  };
  const domains = String(cfg.preferredDomains || '').split(/[\n,;]+/).map(s => s.trim()).filter(s => s && !s.includes('://'));  // URL 数据源由 resolvePreferredDomains 解析，不作为服务器地址
  domains.forEach((d, i) => {
    // 内部条目格式 "主机[:端口]#名称"（原生地址带名称）：剥离 #名称 后再解析地址；优选域名不带名称，命名为「优选域名-XX」
    // （与优选 IP 的「优选IP-XX」区分，两者编号各自从 01 开始）
    const hash = d.indexOf('#');
    const addr = (hash >= 0 ? d.slice(0, hash) : d).trim();
    const nm = (hash >= 0 ? d.slice(hash + 1) : '').trim();
    const p = parseHostPort(addr, 443);
    multiPort(p.host, p.port, nm || '优选域名-' + String(i + 1).padStart(2, '0'));
  });
  // 双选（IPv4+IPv6）时把 preferredIPs 重排为 v4/v6 交替：各来源 v4 天然排前，
  // 若不做交替，节点上限（cap）截断时会先占满 v4，IPv6 被整体挤掉——
  // 交替后按顺序截断天然保持 v4/v6 混合比例（约 1:1）
  let prefIPs = cfg.preferredIPs || [];
  if (wantV6 && !onlyV6 && prefIPs.length > 1) {
    const v4l = [], v6l = [];
    for (const x of prefIPs) (String(x.ip).indexOf(':') >= 0 ? v6l : v4l).push(x);
    const mixed = [];
    const mx = Math.max(v4l.length, v6l.length);
    for (let i = 0; i < mx; i++) {
      if (i < v4l.length) mixed.push(v4l[i]);
      if (i < v6l.length) mixed.push(v6l[i]);
    }
    prefIPs = mixed;
  }
  prefIPs.forEach((x, i) => {
    multiPort(x.ip, x.port || 443, x.name || '优选IP-' + String(i + 1).padStart(2, '0'));
  });
  return nodes;
}

// 从节点链接提取服务器地址与端口（URL API 对 vless:// 等非标准 scheme 不解析 port/IPv6，需手动处理）
function parseNodeServer(n) {
  const at = n.indexOf('@');
  const q = n.indexOf('?', at);
  const auth = (q > at && at >= 0) ? n.slice(at + 1, q) : n.slice(at + 1);
  if (auth.startsWith('[')) {
    const end = auth.indexOf(']');
    const host = end > 0 ? auth.slice(1, end) : auth;
    const rest = auth.slice(end + 1);
    const port = rest.startsWith(':') ? parseInt(rest.slice(1)) : 443;
    return { host, port: isNaN(port) ? 443 : port };
  }
  const idx = auth.lastIndexOf(':');
  if (idx > 0) {
    const port = parseInt(auth.slice(idx + 1));
    return { host: auth.slice(0, idx), port: isNaN(port) ? 443 : port };
  }
  return { host: auth, port: 443 };
}

// 轻量查询参数提取：从分享链接字符串提取指定参数（替代 new URL().searchParams，避免 URL 对象开销与 GC 压力）
function getParam(n, key) {
  const q = n.indexOf('?');
  if (q < 0) return null;
  const hash = n.indexOf('#', q);
  const seg = (hash > q ? n.slice(q + 1, hash) : n.slice(q + 1));
  for (const pair of seg.split('&')) {
    const eq = pair.indexOf('=');
    const k = eq > 0 ? pair.slice(0, eq) : pair;
    if (k === key) return eq > 0 ? decodeURIComponent(pair.slice(eq + 1)) : '';
  }
  return null;
}

// 解析分享链接为统一节点信息（五个客户端生成器共用；纯字符串解析，无 new URL 对象开销）
function parseShareNode(n, i) {
  const { host: srvRaw, port: prt } = parseNodeServer(n);
  // IPv6 以裸地址传递：Clash/Sing-box/Surge/Loon 的 server 字段端口均为独立字段/逗号分隔，要求裸 IPv6；
  // 仅 vless URI（生成处单独加方括号）与 QuanX（ip:port 格式，生成处补方括号）需要 [ip] 形式
  const srv = srvRaw;
  const hashIdx = n.indexOf('#');
  let name = `节点${i + 1}`;
  if (hashIdx >= 0) { try { name = decodeURIComponent(n.slice(hashIdx + 1)) || name; } catch (e) { /* 忽略非法编码 */ } }
  const at = n.indexOf('@');
  let user = '';
  if (at >= 0) {
    const proto = n.indexOf('://');
    const start = proto >= 0 ? proto + 3 : 0;
    try { user = decodeURIComponent(n.slice(start, at)); } catch (e) { user = n.slice(start, at); }
  }
  // 明文端口节点（security=none）不启用 TLS
  const tls = (getParam(n, 'security') || 'tls') === 'tls';
  // 每个节点自带它所属代理的 SNI / Host 与节点路径（多个代理合并订阅时各不相同）；ws 路径里的 ?ed=2048 另由各格式按协议处理，这里只取路径本身
  const host = getParam(n, 'host') || '';
  const path = (getParam(n, 'path') || '').replace(/\?.*$/, '') || '/';
  return { srv, prt, name, user, tls, host, path };
}

// 地区 / 运营商标签表：按节点名称中的关键字匹配
const REGION_TAGS = { HK: ['HK', '香港'], TW: ['TW', '台湾'], US: ['US', '美国'], SG: ['SG', '新加坡'], JP: ['JP', '日本'], KR: ['KR', '韩国'], DE: ['DE', '德国'] };
const ISP_TAGS = { 移动: ['移动', 'CM', 'CHINAMOBILE'], 联通: ['联通', 'CU', 'UNICOM'], 电信: ['电信', 'CT', 'CHINATELECOM'] };
const FILTER_ISPS = ['移动', '联通', '电信'];
// 节点名中的运营商标记：中文名按子串匹配；CM / CU / CT 等英文缩写需为独立单词，避免误匹配（如 CUSTOM）
const ISP_MATCHERS = Object.keys(ISP_TAGS).map(k => [k, ISP_TAGS[k].map(t => /^[A-Z]+$/.test(t)
  ? ((re) => (up) => re.test(up))(new RegExp('(^|[^A-Z])' + t + '([^A-Z]|$)'))
  : (up) => up.includes(t))]);
// 节点名中的地区标记（返回地区码）：中文地区名（REGION_CN 全表）按子串匹配；
// 面板可选的地区码（HK / TW / US / SG / JP / KR / DE）需为独立单词（如「JP-A-147」），避免误匹配
const REGION_CODE_RES = Object.keys(REGION_TAGS).map(k => [k, new RegExp('(^|[^A-Z])' + k + '([^A-Z]|$)')]);
function nodeRegions(name, up) {
  const out = [];
  for (const [code, cn] of Object.entries(REGION_CN)) if (name.includes(cn)) out.push(code);
  for (const [code, re] of REGION_CODE_RES) if (!out.includes(code) && re.test(up)) out.push(code);
  return out;
}
function nodeIsps(up) {
  return ISP_MATCHERS.filter(([, ms]) => ms.some(f => f(up))).map(([k]) => k);
}
const FILTER_IPTYPES = ['IPv4', 'IPv6'];

// 按面板筛选配置过滤节点（region 按名称地区标记、ipType 按地址类型、isp 按名称运营商标记）
// 任何维度筛选后为空时逐级放宽（isp → ipType → region），保证订阅永不为空（避免客户端「无效订阅」）
function filterNodes(nodes, filter) {
  if (!filter || !filter.region && !filter.ipType && !filter.isp) return nodes;
  const region = Array.isArray(filter.region) && filter.region.length ? filter.region : ['all'];
  const ipType = filter.ipType || FILTER_IPTYPES;
  const isp = filter.isp || FILTER_ISPS;
  // 预解析节点（名称解析一次，供各轮过滤与池标记检查复用）
  const meta = nodes.map(n => {
    const { host } = parseNodeServer(n);
    let name = '';
    try {
      const h = n.indexOf('#');
      if (h >= 0) name = decodeURIComponent(n.slice(h + 1) || '');
    } catch (e) { name = ''; }
    const up = name.toUpperCase();
    return { host, name, up, isps: nodeIsps(up), regions: nodeRegions(name, up) };
  });
  const apply = (rg, t, s) => {
    // rg 为面板多选的地区数组（如 ['HK','SG']），含 'all' = 全部地区
    const tg = rg.includes('all') ? null : rg.flatMap(r => REGION_TAGS[r] || []);
    const partial = s.length > 0 && s.length < FILTER_ISPS.length;
    return nodes.filter((n, i) => {
      const m = meta[i];
      const isV6 = m.host.indexOf(':') >= 0;
      if (!m.name) return false;  // 跳过无法解析的非法节点
      // 地区过滤仅剔除明确标记为其它地区的节点；不带地区标记的通用节点（优选IP-XX / 优选域名-XX / 原生地址 /
      // 运营商线路节点如「移动-01」「电信-U01」等）是 CF 通用入口，任意地区可用，一律保留
      if (tg && m.regions.length && !m.regions.some(r => rg.includes(r))) return false;
      if (t.length === 1) {
        if (t[0] === 'IPv4' && isV6) return false;
        if (t[0] === 'IPv6' && !isV6) return false;
      }
      // 运营商筛选与地区筛选一致：只剔除明确标记为未勾选运营商的节点，不带运营商标记的通用节点保留
      if (partial && m.isps.length && !m.isps.some(k => s.includes(k))) return false;
      return true;
    });
  };
  let out = apply(region, ipType, isp);
  if (!out.length) out = apply(region, ipType, FILTER_ISPS);          // 放宽 isp
  if (!out.length) out = apply(region, FILTER_IPTYPES, FILTER_ISPS);  // 放宽 ipType
  if (!out.length) out = apply(['all'], FILTER_IPTYPES, FILTER_ISPS);   // 放宽 region
  return out;
}

// ---------- Clash YAML ----------
// YAML 标量值序列化（裸值或 JSON 字符串，避免特殊字符破坏 YAML）
function yamlVal(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return /^[\w.\-/\u4e00-\u9fa5]+$/.test(s) ? s : JSON.stringify(s);
}
// 单个 Clash 代理块模板化生成（固定结构，800 节点级订阅生成耗时降低一个数量级）
function clashProxyYaml(p) {
  const L = [];
  L.push('  - name: ' + yamlVal(p.name));
  L.push('    type: ' + p.type);
  L.push('    server: ' + yamlVal(p.server));
  L.push('    port: ' + p.port);
  L.push('    uuid: ' + yamlVal(p.uuid));
  L.push('    network: ' + p.network);
  L.push('    udp: true');
  if (p.tls) {
    L.push('    tls: true');
    L.push('    skip-cert-verify: false');   // 校验证书（按 servername 校验，与 server 是否为 IP 无关）
    // ALPN：ws 强制 HTTP/1.1（CF Worker 的 WebSocket 仅支持 HTTP/1.1 升级，mihomo utls(chrome) 默认 ALPN 含 h2 → WS 升级失败）；
    // xhttp 必须 h2（stream-one 依赖 HTTP/2 双向流，h1.1 请求体未发完 CF 边缘无法回传响应 → Clash Verge 节点全部超时）
    L.push('    alpn: [' + (p.alpn && p.alpn.length ? p.alpn : (p.network === 'xhttp' ? ['h2'] : ['http/1.1'])).join(', ') + ']');
    L.push('    servername: ' + yamlVal(p.servername));
    L.push('    client-fingerprint: chrome');
    if (p['ech-opts']) {
      L.push('    ech-opts:');
      L.push('      enable: ' + yamlVal(p['ech-opts'].enable));
      L.push('      query-server-name: ' + yamlVal(p['ech-opts']['query-server-name']));
    }
  }
  if (p.network === 'ws') {
    L.push('    ws-opts:');
    L.push('      path: ' + yamlVal(p['ws-opts'].path));
    L.push('      headers:');
    L.push('        Host: ' + yamlVal(p['ws-opts'].headers.Host));
  } else if (p.network === 'xhttp') {
    const xo = p['xhttp-opts'];
    L.push('    xhttp-opts:');
    L.push('      path: ' + yamlVal(xo.path));
    L.push('      mode: ' + yamlVal(xo.mode));
    // mihomo 规范中 XHTTP 请求主机字段名为 host（headers.Host 会被 Nekobox 等客户端把 'Host: 域名' 整行误导入 XHTTP 标头）
    L.push('      host: ' + yamlVal(xo.host));
    L.push('      x-padding-obfs-mode: ' + yamlVal(xo['x-padding-obfs-mode']));
    L.push('      x-padding-method: ' + yamlVal(xo['x-padding-method']));
    L.push('      x-padding-placement: ' + yamlVal(xo['x-padding-placement']));
    L.push('      x-padding-header: ' + yamlVal(xo['x-padding-header']));
    L.push('      x-padding-key: ' + yamlVal(xo['x-padding-key']));
  }
  return L.join('\n');
}
function generateClash(cfg, nodes, clashTemplate) {
  // SNI / Host 与节点路径取自每个节点（多个代理合并订阅时各不相同）
  const alpnArr = alpnList(cfg.alpn);   // 面板 ALPN 设置；未设置时 ws 用 http/1.1、xhttp 用 h2
  const seen = new Set();
  // XHTTP 节点按 mihomo xhttp-opts 规范输出（含 x-padding 混淆参数），与 WS 一并下发
  const proxies = nodes.map((n) => {
    const { user, srv, prt, name: baseName, tls, host, path } = parseShareNode(n, 0);
    // TLS 下 ws 路径携带 ed=2048：mihomo 据此启用 early data（首包预发进 Sec-WebSocket-Protocol，省 1 个 RTT）
    const wsPath = path + '?ed=2048';
    let name = baseName;
    const xType = getParam(n, 'type') || 'ws';
    // 同名去重：同一名称（同一 IP 多协议节点或不同 IP 同名优选池）追加协议后缀并保证全局唯一——
    // 若后缀仍被占用（多个同名 IP 的 XHTTP 节点），继续递增序号，避免 mihomo「duplicate name」校验失败
    if (seen.has(name)) {
      const suff = xType === 'xhttp' ? 'X' : 'W';
      let cand = name + '·' + suff;
      let k = 2;
      while (seen.has(cand)) { cand = name + '·' + suff + k; k++; }
      name = cand;
    }
    seen.add(name);
    const base = {
      name, server: srv, port: prt, udp: true,
      ...(tls ? { tls: true, 'skip-cert-verify': false, servername: host, 'client-fingerprint': 'chrome', alpn: alpnArr || ['http/1.1'] } : {}),
      ...(cfg.ech && tls ? { 'ech-opts': { enable: true, 'query-server-name': cfg.echHost || 'cloudflare-ech.com' } } : {})   // mihomo ECH 格式为顶层 ech-opts（enable + query-server-name）
    };
    if (xType === 'xhttp') {
      // 从节点链接的 extra 参数恢复 x-padding 混淆配置（由 UUID 派生，与服务端一致）
      let xo = {};
      try { xo = JSON.parse(getParam(n, 'extra') || '{}'); } catch (e) { /* extra 解析失败则用空 */ }
      return {
        ...base, type: 'vless', uuid: user, network: 'xhttp',
        alpn: alpnArr || ['h2'],   // 未设置时 xhttp stream-one 依赖 HTTP/2 双向流必须 h2（ws 节点才用 http/1.1）
        'xhttp-opts': {
          path,
          mode: 'stream-one',
          // 主机字段为 host（headers.Host 会被 Nekobox 误读为标头）
          host,
          'x-padding-obfs-mode': xo.xPaddingObfsMode !== undefined ? xo.xPaddingObfsMode : true,
          'x-padding-method': xo.xPaddingMethod || 'tokenish',
          'x-padding-placement': xo.xPaddingPlacement || 'queryInHeader',
          'x-padding-header': xo.xPaddingHeader || '',
          'x-padding-key': xo.xPaddingKey || ''
        }
      };
    }
    return { ...base, type: 'vless', uuid: user, network: 'ws', 'ws-opts': { path: tls ? wsPath : path, headers: { Host: host } } };
  });
  // 节点排序：443端口优先（非标准端口如8443在mihomo下HTTPS握手易被GFW干扰，放后面避免默认选中）
  proxies.sort((a, b) => (a.port === 443 ? 0 : 1) - (b.port === 443 ? 0 : 1));
  // 模板中的本地凭据按 UUID 派生（同一部署每次订阅结果稳定，不同部署互不相同），避免所有人共用公开的默认密码
  const derive = (purpose) => sha224hex('hopline-clash|' + purpose + '|' + cfg.uuid).slice(0, 20);
  const template = clashTemplate
    .split('__HOPLINE_SS_PASSWORD__').join(derive('ss'))
    .split('__HOPLINE_AUTH_PASSWORD__').join(derive('auth'))
    .split('__HOPLINE_API_SECRET__').join(derive('api'));
  const yaml = `# Hopline 订阅
test-url: 'http://www.gstatic.com/generate_204'
proxies:
${proxies.map(p => clashProxyYaml(p)).join('\n')}
${template}
`;
  return yaml;
}

// ---------- Sing-box JSON ----------
// sing-box 配置（1.12+ 格式）：规则集用 remote 二进制 .srs，不使用已移除的 geoip 规则 / dns 出站 / inet4_address / 入站 sniff 字段，节点 tag 保持唯一
const SINGBOX_RULE_SETS = [
  ['geosite-category-ads-all', null],   // null = 拦截（route action reject）
  ['geosite-cn', '🎯 全球直连'], ['geosite-google', '🌐 谷歌服务'], ['geosite-apple', '🍎 苹果服务'],
  ['geosite-microsoft', 'Ⓜ️ 微软服务'], ['geosite-openai', '🤖 OpenAI'], ['geosite-spotify', '🌍 国外媒体'],
  ['geosite-youtube', '🌍 国外媒体'], ['geosite-netflix', '🌍 国外媒体'], ['geosite-disney', '🌍 国外媒体'],
  ['geosite-twitter', '🌍 国外媒体'], ['geosite-telegram', '🌍 国外媒体'], ['geosite-github', '🌍 国外媒体'],
];
// MetaCubeX 规则库 sing 分支的二进制规则集（.srs），经 jsDelivr 直连下载（国内可达）
const SINGBOX_RULE_BASE = 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/';
function generateSingbox(cfg, nodes) {
  const alpnArr = alpnList(cfg.alpn);
  const seen = new Set();
  // 官方 sing-box 内核没有 xhttp 传输（仅部分第三方分支支持），含 xhttp 出站的配置整体无法加载，因此不下发 XHTTP 节点
  const outbounds = nodes.filter(n => getParam(n, 'type') !== 'xhttp').map((n, i) => {
    const { user, srv, prt, name: baseName, tls, host, path } = parseShareNode(n, i);
    // tag 必须唯一（重复时 sing-box 拒绝启动）：名称已由 uniqueNodeNames 去重，这里再兜底一次
    let name = baseName, k = 2;
    while (seen.has(name)) name = baseName + '·' + k++;
    seen.add(name);
    // insecure=false：证书按 server_name 校验，即使 server 为 IP 也能通过；关闭校验会让中间人可解密流量
    // ALPN 取面板设置；未设置时用 http/1.1（CF 边缘协商 h2 会导致 WS 升级失败）
    const tlsObj = tls
      ? { enabled: true, server_name: host, insecure: false, alpn: alpnArr || ['http/1.1'], utls: { enabled: true, fingerprint: 'chrome' } }
      : { enabled: false };
    // TLS 下的 ws 启用 early data：sing-box 由 max_early_data + early_data_header_name 控制，
    // path 中不能再写 ?ed=2048（会导致握手失败）；明文 ws 不启用
    const transport = tls
      ? { type: 'ws', path, headers: { Host: host }, max_early_data: 2048, early_data_header_name: 'Sec-WebSocket-Protocol' }
      : { type: 'ws', path, headers: { Host: host } };
    return { type: 'vless', tag: name, server: srv, server_port: prt, uuid: user, tls: tlsObj, transport };
  });
  const tags = outbounds.map(o => o.tag);
  if (!tags.length) throw new Error('sing-box 官方内核不支持 XHTTP，没有可用节点：请同时启用 VLESS 协议');
  const config = {
    log: { level: 'info' },
    // DNS：国内域名走直连 DNS（真实 IP），其余 A/AAAA 走 fakeip，兜底远程 DoH
    dns: {
      servers: [
        { type: 'https', tag: 'dns-remote', server: '1.1.1.1' },
        { type: 'udp', tag: 'dns-direct', server: '223.5.5.5' },
        { type: 'fakeip', tag: 'dns-fakeip', inet4_range: '198.18.0.0/15' }
      ],
      rules: [
        { rule_set: 'geosite-cn', server: 'dns-direct' },
        { query_type: ['A', 'AAAA'], server: 'dns-fakeip' }
      ],
      final: 'dns-remote',
      strategy: 'ipv4_only'
    },
    inbounds: [
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
      { type: 'tun', tag: 'tun-in', interface_name: 'tun0', address: ['172.19.0.1/30'], mtu: 9000, auto_route: true, strict_route: true }
    ],
    outbounds: [
      { type: 'selector', tag: '🚀 节点选择', outbounds: tags },
      { type: 'selector', tag: '🎯 全球直连', outbounds: ['direct'] },
      { type: 'selector', tag: '🐟 漏网之鱼', outbounds: ['🚀 节点选择', '🎯 全球直连'] },
      { type: 'selector', tag: '🌍 国外媒体', outbounds: ['🚀 节点选择'] },
      { type: 'selector', tag: '🌐 谷歌服务', outbounds: ['🚀 节点选择'] },
      { type: 'selector', tag: '🤖 OpenAI', outbounds: ['🚀 节点选择'] },
      { type: 'selector', tag: '🍎 苹果服务', outbounds: ['🎯 全球直连', '🚀 节点选择'] },
      { type: 'selector', tag: 'Ⓜ️ 微软服务', outbounds: ['🎯 全球直连', '🚀 节点选择'] },
      ...outbounds,
      { type: 'direct', tag: 'direct' }
    ],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' },
        ...SINGBOX_RULE_SETS.map(([rs, out]) => out ? { rule_set: rs, outbound: out } : { rule_set: rs, action: 'reject' }),
        { rule_set: 'geoip-cn', outbound: 'direct' }   // 大陆 IP 兜底直连（覆盖未收录域名 / 纯 IP 连接的大陆应用）
      ],
      rule_set: [
        ...SINGBOX_RULE_SETS.map(([rs]) => ({ type: 'remote', tag: rs, format: 'binary',
          url: SINGBOX_RULE_BASE + rs.replace('geosite-', 'geosite/') + '.srs', download_detour: 'direct' })),
        { type: 'remote', tag: 'geoip-cn', format: 'binary', url: SINGBOX_RULE_BASE + 'geoip/cn.srs', download_detour: 'direct' }
      ],
      final: '🐟 漏网之鱼',
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct'
    },
    experimental: {
      clash_api: { external_controller: '127.0.0.1:9090' },
      cache_file: { enabled: true, store_fakeip: true }   // 缓存规则集与 fakeip 映射，重启无需重新下载
    }
  };
  return JSON.stringify(config, null, 2);
}

// Surge / Loon / Quantumult X 没有 XHTTP 传输：XHTTP 节点若照常输出会被写成普通 WebSocket 节点而无法连接，因此一律剔除
// （与 Sing-box 一致）；剔除后没有节点时明确报错，而不是输出空配置
function dropXhttp(nodes, client) {
  const out = nodes.filter(n => getParam(n, 'type') !== 'xhttp');
  if (!out.length) throw new Error(client + ' 不支持 XHTTP，没有可用节点：请同时启用 VLESS 协议');
  return out;
}

// ---------- Surge ----------
function generateSurge(cfg, nodes) {
  nodes = dropXhttp(nodes, 'Surge');
  const proxies = nodes.map((n, i) => {
    const { user, srv, prt, name, tls, host, path } = parseShareNode(n, i);
    const tlsPart = tls ? ', tls=true, skip-cert-verify=false, sni=' + host : ', tls=false';
    return `${name} = vless, ${srv}, ${prt}, username=${user}, ws=true, ws-path=${path}, ws-headers=Host:${host}${tlsPart}`;
  });
  return `#!MANAGED-CONFIG
[General]
loglevel = notify
dns-server = 223.5.5.5, 119.29.29.29

[Proxy]
${proxies.join('\n')}

[Proxy Group]
🚀 节点选择 = select, ${proxies.map(p => p.split(' = ')[0]).join(', ')}
🌐 全球直连 = select, DIRECT
🐟 漏网之鱼 = select, 🚀 节点选择

[Rule]
GEOIP,CN,DIRECT
FINAL,🐟 漏网之鱼
`;
}

// ---------- Loon ----------
function generateLoon(cfg, nodes) {
  nodes = dropXhttp(nodes, 'Loon');
  const proxies = nodes.map((n, i) => {
    const { user, srv, prt, name, tls, host, path } = parseShareNode(n, i);
    const tlsPart = tls ? ', tls=true, skip-cert-verify=false, sni=' + host : ', tls=false';
    return `${name} = vless, ${srv}, ${prt}, username=${user}, ws=true, ws-path=${path}, ws-headers=Host:${host}${tlsPart}`;
  });
  const names = proxies.map(p => p.split(' = ')[0]).join(', ');
  return `[General]
dns-server = 223.5.5.5, 119.29.29.29

[Proxy]
${proxies.join('\n')}

[Proxy Group]
🚀 节点选择 = select, ${names}
🌐 全球直连 = select, DIRECT
🐟 漏网之鱼 = select, ${names}

[Rule]
GEOIP,CN,DIRECT
FINAL,🐟 漏网之鱼
`;
}

// ---------- Quantumult X ----------
function generateQuanX(cfg, nodes) {
  nodes = dropXhttp(nodes, 'Quantumult X');
  // QuanX 的 ip:port 格式中 IPv6 必须带方括号（裸 v6 与端口冒号歧义）
  const qxHost = (srv) => srv.indexOf(':') >= 0 ? '[' + srv + ']' : srv;
  const servers = nodes.map((n, i) => {
    const { user, srv, prt, name, tls, host, path } = parseShareNode(n, i);
    return `vless=${qxHost(srv)}:${prt}, method=none, password=${user}, obfs=${tls ? 'wss' : 'ws'}, obfs-host=${host}, obfs-uri=${path}${tls ? ', tls-verification=true, tls13=true' : ''}, tag=${name}`;
  });
  const names = nodes.map((n, i) => {
    const h = n.indexOf('#');
    if (h < 0) return `节点${i + 1}`;
    try { return decodeURIComponent(n.slice(h + 1)) || `节点${i + 1}`; } catch (e) { return `节点${i + 1}`; }
  }).join(', ');
  return `[general]
network_check_url=http://www.gstatic.com/generate_204
server_check_url=http://www.gstatic.com/generate_204
dns_exclusion_list=*.cmpassport.com, *.qq.com, *.weibo.com, *.icloud.com
[dns]
server=223.5.5.5
server=119.29.29.29
[server_local]
${servers.join('\n')}
[policy]
static=🚀 节点选择, ${names}, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Proxy.png
static=🌐 全球直连, direct, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Direct.png
static=🐟 漏网之鱼, 🚀 节点选择, direct, img-url=https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Final.png
[filter_local]
geoip, cn, 🌐 全球直连
final, 🐟 漏网之鱼
`;
}

// 单次订阅的节点上限（按 Workers / Pages 免费额度 10ms CPU 硬限设定）：结构化格式（Clash / Sing-box 等）
// 约 400 节点 ~8ms，行式格式拼接成本很低；统一取 500
const NODE_CAP = 500;

// 根据 UA 或指定格式生成订阅
async function generateSubscription(cfg, format, ua) {
  // 明文端口节点只由「仅 TLS 端口」控制（默认开启）；ECH 只对 TLS 生效，开启时同样只下发 TLS 端口节点。
  // 自定义域名的明文端口需在 Cloudflare 关闭「始终使用 HTTPS」，否则被 301 重定向、WebSocket 握手失败
  // 订阅合并所有「可用」的代理（启用且域名 / 节点路径 / UUID 齐全，来自面板保存的代理列表）：每个代理各生成一套节点；没有可用的代理就直接报错
  const missing = endpointMissing(cfg);
  if (missing.length) throw Object.assign(new Error('订阅还不能生成：缺少 ' + missing.join('、') + '。请到「面板设置 → 代理」处理'), { status: 400 });
  const proxies = readyProxies(cfg);
  // rc 是各格式生成器共用的配置：host / uuid / nodePath 取第一个代理（Clash 本地凭据按它的 UUID 派生）；节点自己的 SNI / Host / 路径写在各节点链接里
  const rc = Object.assign({}, cfg, { host: proxies[0].host, uuid: proxies[0].uuid, nodePath: proxies[0].nodePath });
  const prefList = effectivePrefDomains(cfg);   // 面板填写的优选域名（整体替换内置列表）或内置列表
  if (rc.ech) rc.tlsOnly = true;
  // 筛选含 IPv6 时查询 AAAA 记录并生成 IPv6 节点（默认双选 IPv4+IPv6 同样生效）；
  // 仅勾选 IPv6（单选）时全部走 IPv6 来源
  const ipT = (cfg.filter && cfg.filter.ipType) || [];
  const wantV6 = ipT.includes('IPv6');
  const onlyV6 = ipT.length === 1 && ipT[0] === 'IPv6';
  // 节点池由「地址来源」三项组装（rc.preferredDomains / rc.preferredIPs 只是本次订阅的内部中间结果，不是配置项）——
  // 1) 原生地址（src.native）：工作器域名直接作为节点 server 下发（默认关闭）；
  // 2) 优选域名（src.prefDomain）：第三方优选域名直接作为节点 server 下发（客户端连接时动态 DNS 解析，拿到当前最优 CF 边缘 IP）；
  // 3) 优选 IP（src.prefIp）：自定义优选 API / HostMonit / uouin / 微测网等在线来源（「优选配置 → 优选 IP 来源」）。
  // 这些来源都是 Cloudflare 任播 IP / 域名，大多不带地区标记（任播 IP 的落地机房取决于客户端所在网络），
  // 因此面板「节点地区」筛选通常不改变节点构成；来源一律只保留 Cloudflare 段，非 CF 段 IP 无法转发到 Worker
  const src = cfg.src || {};
  const useNative = src.native === true;            // 启用原生地址（工作器域名）
  const useDomain = src.prefDomain !== false;       // 启用优选域名（默认开）
  const useIp = src.prefIp !== false;               // 启用优选 IP（内置池 + 实时拉取，默认开）
  rc.preferredDomains = '';
  rc.preferredIPs = [];
  // 优选域名（各代理共用）。原生地址（代理自己的域名，IPv4 入口）因代理而异，在下面按代理加上：仅勾选 IPv6 时跳过，避免 v4 域名混入
  // 仅勾选 IPv6 时跳过 v4 优选域名（域名节点为 IPv4 入口，混入会占满 cap 并被 filterNodes 剔除，导致数量控制下发不足）
  let sharedDomains = '';
  if (useDomain && !onlyV6) {
    // 域名按原样下发（不预检）：客户端连接时自行解析到当前最优的 CF 边缘 IP；失效的域名可用「优选配置 → 优选域名 → 测试」找出
    sharedDomains = prefList;
  }
  // 「优选 IP」的在线来源（面板「优选配置 → 优选 IP 来源」开关控制，并行拉取，每个来源 1 个子请求、缓存 10 分钟）：
  // 自定义优选 API 1 / 2（用户自选来源排最前）→ HostMonit → uouin → 微测网。HostMonit 为纯 IPv4，仅勾选 IPv6 时跳过；微测网只拉取所选 IP 类型对应的页面
  if (useIp) {
    const ps = cfg.ipsrc || {};
    const apiSrc = (n) => (ps['api' + n] && ps['api' + n + 'Url'])
      ? resolvePreferredDomains(ps['api' + n + 'Url'], 200, 300, true, false).catch(() => [])
      : Promise.resolve([]);
    const results = await Promise.all([
      apiSrc(1),
      apiSrc(2),
      (ps.hostmonit !== false && !onlyV6) ? fetchLatestPreferredIPs(150).catch(() => null) : null,
      ps.uouin === true ? fetchUouinIPs(!onlyV6, wantV6).catch(() => []) : null,
      ps.wetest === true ? fetchWetestIPs(!onlyV6, wantV6).catch(() => []) : null,
    ]);
    for (const list of results) if (list && list.length) rc.preferredIPs.push(...list);
  }
  // IPv6 节点来源：筛选含 IPv6 时只查询优选域名的 AAAA 记录（v4 已由域名节点覆盖，不重复查 A）。
  // 子请求预算：Workers 免费版每次请求最多 50 个子请求——IPv4+IPv6 混合时只解析前 V6_DOMAIN_LIMIT 个域名；
  // 仅勾选 IPv6 时 v4 来源全部跳过，预算充足，解析全部域名并并入官方域名 AAAA
  if (wantV6 && useDomain) {
    try {
      const v6src = onlyV6
        ? dohPrefDomains(prefList) + '\n' + BUILTIN_OFFICIAL_DOMAINS.join('\n')
        : prefList.split('\n').slice(0, V6_DOMAIN_LIMIT).join('\n');
      const v6dom = await resolvePreferredDomains(v6src, 40, onlyV6 ? 800 : 240, true, 'only');
      // 解析结果名为「域名-序号」，统一改为不带地区的通用名「优选IP-V6-NN」（地区筛选时作为通用节点保留）
      if (v6dom && v6dom.length) rc.preferredIPs.push(...v6dom.map((x, i) => Object.assign({}, x, { name: '优选IP-V6-' + String(i + 1).padStart(2, '0') })));
    } catch (e) { /* AAAA 解析失败不影响其它来源 */ }
  }
  // 地址来源全部关闭时用官方域名兜底，保证订阅不为空（客户端不会收到「无效订阅」）
  if (!useNative && !useDomain && !useIp) sharedDomains = BUILTIN_OFFICIAL_DOMAINS.map((d, i) => d + '#域名-' + String(i + 1).padStart(2, '0')).join('\n');
  // 仅勾选 IPv6（单选）时清掉各来源混入的 IPv4（域名 AAAA 解析的 v4 与各在线来源中的 v4 一并剔除，
  // 避免 filterNodes 过滤空集后放宽回退全 v4）
  if (onlyV6 && rc.preferredIPs) rc.preferredIPs = rc.preferredIPs.filter(x => String(x.ip).indexOf(':') >= 0);
  ua = (ua || '').toLowerCase();
  const forced = (format || '').toLowerCase();
  const cap = NODE_CAP;
  // 不做任何测活剔除：Worker 边缘连通性 ≠ 客户端连通性，且 Workers 无法连接 CF 段 IP；全量按顺序下发由客户端自行择优
  // 每个代理各生成一套节点（来源只拉取一次，各代理共用），总数封顶 cap：多个代理时平均分配，来源不足时按实际数量下发。
  // 筛选在加代理名后缀之前做（代理名里即使含 HK 等字样，也不会影响地区 / 运营商筛选）
  const capEach = Math.max(1, Math.floor(cap / proxies.length));
  let nodes = [];
  for (const px of proxies) {
    const pc = Object.assign({}, rc, { host: px.host, uuid: px.uuid, nodePath: px.nodePath });
    pc.preferredDomains = [useNative && !onlyV6 ? px.host + '#原生地址' : '', sharedDomains].filter(Boolean).join('\n');
    let mine = filterNodes(await buildNodes(pc, capEach), cfg.filter);
    // 所有来源都没有产出节点时（如在线来源全部失败），用官方域名节点兜底，保证订阅不为空
    // （客户端不会收到「无效订阅」）；域名节点由客户端自行解析，IPv4 / IPv6 均可
    if (!mine.length) {
      const fb = Object.assign({}, pc, { preferredDomains: BUILTIN_OFFICIAL_DOMAINS.map((d, i) => d + '#域名-' + String(i + 1).padStart(2, '0')).join('\n'), preferredIPs: [], tlsOnly: true });
      mine = await buildNodes(fb, capEach);
    }
    // 严格封顶：多协议膨胀可能越过上限，统一截断
    if (mine.length > capEach) mine.length = capEach;
    if (proxies.length > 1) mine = mine.map(n => tagNodeName(n, px.name));
    nodes.push(...mine);
  }
  nodes = uniqueNodeNames(nodes);
  let type, body;
  if (forced === 'clash' || forced === 'stash') { type = 'text/yaml'; body = generateClash(rc, nodes, CLASH_TEMPLATE); }   // Stash 使用 Clash 格式（与按 UA 识别一致）
  else if (forced === 'singbox' || forced === 'sing-box') { type = 'application/json'; body = generateSingbox(rc, nodes); }
  else if (forced === 'surge') { type = 'text/plain'; body = generateSurge(rc, nodes); }
  else if (forced === 'loon') { type = 'text/plain'; body = generateLoon(rc, nodes); }
  else if (forced === 'quanx' || forced === 'quantumultx') { type = 'text/plain'; body = generateQuanX(rc, nodes); }
  else if (forced === 'plain' || forced === 'raw') { type = 'text/plain'; body = nodes.join('\n'); }
  else if (forced === 'v2ray' || forced === 'v2rayn' || forced === 'shadowrocket' || forced === 'nekoray') {
    // 明文下发（与 1.0.6 一致）：base64 订阅在 AsteriskNG / v2rayNG 中按系统编码（GBK）解码，
    // 中文节点名（UTF-8）会被误读成乱码（如 美国 → 缇庡浗）；明文按响应 charset=utf-8 读取则正常
    type = 'text/plain'; body = nodes.join('\n');
  }
  // UA 自动识别
  else if (ua.includes('clash') || ua.includes('stash')) { type = 'text/yaml'; body = generateClash(rc, nodes, CLASH_TEMPLATE); }
  else if (ua.includes('sing-box')) { type = 'application/json'; body = generateSingbox(rc, nodes); }
  else if (ua.includes('surge')) { type = 'text/plain'; body = generateSurge(rc, nodes); }
  else if (ua.includes('loon')) { type = 'text/plain'; body = generateLoon(rc, nodes); }
  else if (ua.includes('quantumult')) { type = 'text/plain'; body = generateQuanX(rc, nodes); }
  // 默认（v2rayN / Shadowrocket / 未知客户端）：返回 base64 编码订阅（V2rayN 标准格式）
  else { type = 'text/plain'; body = nodes.join('\n'); }   // 明文（同 1.0.6，避免客户端按 GBK 解码 base64 导致中文名称乱码）
  return { type, body, count: nodes.length };
}

// ---------------------------------------------------------------------------
// 内嵌页面与模板（构建时内联进脚本，运行时不依赖网络）
// ---------------------------------------------------------------------------
const loginHTML = String.raw`
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hopline · 登录</title>
<script>(function(){var t='auto';try{t=localStorage.getItem('tp_theme')||'auto'}catch(e){}if(t!=='light'&&t!=='dark')t=window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3' y='3' width='18' height='18' rx='5' fill='%232563eb'/%3E%3Cpath d='M8 15V9l8 6V9' stroke='%23ffffff' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f6f7fb;--input:#f8fafc;--card:#ffffff;--border:#e4e7ee;--text:#0f172a;--dim:#64748b;--accent:#2563eb;--accent-strong:#1d4ed8;--accent-dim:rgba(37,99,235,.12);--on-accent:#ffffff;--err:#dc2626;--err-dim:rgba(220,38,38,.08);--box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 32px rgba(15,23,42,.08)}
[data-theme="dark"]{--bg:#0b1120;--input:#0f172a;--card:#111827;--border:#243044;--text:#e5e9f0;--dim:#94a3b8;--accent:#3b82f6;--accent-strong:#2563eb;--accent-dim:rgba(59,130,246,.18);--on-accent:#ffffff;--err:#f87171;--err-dim:rgba(248,113,113,.13);--box-shadow:0 18px 50px rgba(0,0,0,.35)}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{width:340px;max-width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:30px 28px;box-shadow:var(--box-shadow)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.mark{width:38px;height:38px;border-radius:10px;background:var(--accent);display:flex;align-items:center;justify-content:center}
.mark svg{width:20px;height:20px}
.mark path{stroke:var(--on-accent)}
.brand .bt{display:flex;flex-direction:column;line-height:1.25}
.brand .bt b{font-size:16px}
.brand .bt span{font-size:11.5px;color:var(--dim)}
h1{font-size:15px;margin-bottom:4px}
p{color:var(--dim);font-size:13px;margin-bottom:18px}
input{width:100%;background:var(--input);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:10px 13px;font-size:14px;outline:none;margin-bottom:12px;font-family:inherit}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
button{width:100%;background:var(--accent);border:none;color:var(--on-accent);border-radius:9px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
button:hover{background:var(--accent-strong)}
button:disabled{opacity:.6;cursor:not-allowed}
.msg{color:var(--err);font-size:13px;margin-bottom:12px;display:none;background:var(--err-dim);padding:8px 12px;border-radius:8px}
.foot{margin-top:16px;text-align:center;font-size:11.5px;color:var(--dim)}
</style>
</head>
<body>
<div class="box">
  <div class="brand">
    <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h4l3-7 4 14 3-7h2"/></svg></div>
    <div class="bt"><b>Hopline</b><span>代理订阅面板</span></div>
  </div>
  <h1>登录</h1>
  <p>请输入管理用户名与密码以继续</p>
  <div class="msg" id="msg">用户名或密码错误，请重试</div>
  <form id="form">
    <input type="text" id="user" placeholder="用户名" autofocus autocomplete="username" autocapitalize="off" spellcheck="false">
    <input type="password" id="pwd" placeholder="管理密码" autocomplete="current-password">
    <button type="submit" id="btn">登录</button>
  </form>
  <div class="foot">配置保存在 Cloudflare KV 中，24 小时未使用面板自动退出，最长 7 天需重新登录</div>
</div>
<script>
(function(){
  var next = new URLSearchParams(location.search).get('next') || '/';
  document.getElementById('form').addEventListener('submit', function(e){
    e.preventDefault();
    var btn = document.getElementById('btn');
    var msg = document.getElementById('msg');
    btn.disabled = true; msg.style.display = 'none';
    fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=' + encodeURIComponent(document.getElementById('user').value) + '&password=' + encodeURIComponent(document.getElementById('pwd').value) + '&next=' + encodeURIComponent(next) })
      .then(function(r){ return r.json(); })
      .then(function(r){
        if (r && r.ok){ location.href = r.next || '/'; }
        else { msg.textContent = (r && r.msg) || '用户名或密码错误，请重试'; msg.style.display = 'block'; btn.disabled = false; }
      })
      .catch(function(){ msg.textContent = '网络错误，请重试'; msg.style.display = 'block'; btn.disabled = false; });
  });
})();
</script>
</body>
</html>

`;
// Clash / Stash 订阅的配置模板：生成订阅时拼在节点后面
const CLASH_TEMPLATE = String.raw`

# ==================== 锚点配置 ====================
# 代理提供者模板 - 订阅源基础配置

# 节点筛选正则表达式 - 仅保留常用地区
FilterHK: &FilterHK '^(?=.*(?i)(港|🇭🇰|HK|Hong|HKG))(?!.*5x).*$'
FilterSG: &FilterSG '^(?=.*(?i)(坡|🇸🇬|SG|Sing|SIN|XSP))(?!.*5x).*$'
FilterJP: &FilterJP '^(?=.*(?i)(日|🇯🇵|JP|Japan|NRT|HND|KIX|CTS|FUK))(?!.*(尼日利亚|5x)).*$'
FilterUS: &FilterUS '^(?=.*(?i)(美|🇺🇸|US|USA|JFK|SJC|LAX|ORD|ATL|DFW|SFO|MIA|SEA|IAD))(?!.*(Plus|Australia|5x)).*$'
# 注意：🇼🇸 是萨摩亚旗帜，不是台湾，已移除，避免误匹配
FilterTW: &FilterTW '^(?=.*(?i)(台|🇹🇼|TW|tai|TPE|TSA|KHH))(?!.*5x).*$'

# ==================== 监听器 ====================
listeners:
  # Shadowsocks监听器 - 远程连接家庭网络。密码由 Hopline 按 UUID 为本部署派生（每个部署不同），不再使用公开的默认密码；
  # 如需对外开放请自行修改端口与密码
  - {name: SS-IN,  type: shadowsocks, listen: '::', port: 10000, udp: true, password: "__HOPLINE_SS_PASSWORD__", cipher: aes-256-gcm}
  # Mixed监听器 - 分地区专用端口 玩法：本地浏览器插件或手机APP配置代理，实现分地区访问
  - {name: MIXED-SG, type: mixed, port: 50000, proxy: 新加坡节点}
  - {name: MIXED-US, type: mixed, port: 50001, proxy: 美国节点}
  - {name: MIXED-TW, type: mixed, port: 50002, proxy: 台湾节点}
  - {name: MIXED-HK, type: mixed, port: 50003, proxy: 香港节点}
  - {name: MIXED-JP, type: mixed, port: 50004, proxy: 日本节点}
  - {name: MIXED-AL, type: mixed, port: 50007, proxy: 一键连接}

# ==================== 核心配置 ====================
mode: rule
port: 7890
socks-port: 7891
redir-port: 7892
mixed-port: 7893
tproxy-port: 7895
ipv6: true
allow-lan: true
unified-delay: true
tcp-concurrent: true
log-level: warning
bind-address: '*'
find-process-mode: 'always'
keep-alive-interval: 15
keep-alive-idle: 600

# 认证配置：密码由 Hopline 按 UUID 为本部署派生（每个部署不同），不再使用公开的默认凭据
authentication:
  - "mihomo:__HOPLINE_AUTH_PASSWORD__"
skip-auth-prefixes:
  - 192.168.1.0/24
  - 192.168.31.0/24
  - 192.168.100.0/24
  - 127.0.0.1/8

# 实验性功能
experimental:
  quic-go-disable-gso: true

# 管理面板配置
external-ui-url: https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip
external-ui-name: zashboard
external-ui: ui
external-controller: 127.0.0.1:9090
secret: "__HOPLINE_API_SECRET__"    # 由 Hopline 按 UUID 为本部署派生，可自行修改
# 允许跨域访问的面板来源（不再使用 "*"：任意网页都不能借浏览器访问本机控制接口）。使用其它在线面板时在此追加其域名
external-controller-cors:
  allow-origins:
    - "http://127.0.0.1:9090"
    - "http://localhost:9090"
    - "https://board.zash.run.place"
    - "https://metacubex.github.io"
  allow-private-network: true

# 配置存储
profile:
  store-selected: true
  store-fake-ip: true

# geosite / geoip 数据源（GEOSITE 规则依赖）：MetaCubeX 规则库，经 jsDelivr 镜像下载（GitHub release 国内常不可达）
geox-url:
  geoip: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat"
  geosite: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"
  mmdb: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb"

# 流量嗅探
sniffer:
  enable: true
  force-dns-mapping: true   # 强制 DNS 映射，提高分流准确度
  parse-pure-ip: true       # 解析纯 IP 连接
  override-destination: true
  sniff:
    HTTP:
      ports: [80, 8080-8880]
    TLS:
      ports: [443, 8443]
    QUIC:
      ports: [443, 8443]
  skip-domain:
    - "+.push.apple.com"

# TUN模式配置
tun:
  enable: false
  stack: mixed
  mtu: 1480
  dns-hijack:
    - "any:53"
    - "tcp://any:53"
  udp-timeout: 300
  auto-route: true
  strict-route: true
  auto-redirect: true
  auto-detect-interface: true
  # 提示：系统级防泄露的最强手段是开启 TUN（自动劫持全部 DNS 流量）；
  # 不开 TUN 时，请把系统 / 本机应用的 DNS 指向 127.0.0.1:1053；要给 LAN 设备提供 DNS，把下方 dns.listen 改为 0.0.0.0:1053（注意不要暴露到公网）。

hosts:
  miwifi.com: 192.168.31.2
  "epdg.epc.mnc010.mcc234.pub.3gppnetwork.org": [87.194.8.8, 87.194.88.8, 87.194.89.8, 87.194.9.8]
  services.googleapis.cn: services.googleapis.com
  cn.bing.com: www4.bing.com

# ==================== DNS 配置 ====================
# 防泄露要点：
#   1) respect-rules: true：DNS 服务器连接遵循路由规则（国外 DoH 走代理隧道、国内 DoH 直连），
#      解析行为与规则分流一致，避免“规则走代理、解析却直连”的泄露。
#   2) 默认 nameserver 用国内 DoH；只有“将走代理”的规则集才用国外 DoH，
#      且其域名在 rules 中显式固定走代理。
#   3) fake-ip-filter 补齐系统连通性检测 / 时间同步 / 运营商登录等域名，防止系统误判断网而回退运营商 DNS。
dns:
  enable: true
  listen: 127.0.0.1:1053    # 仅本机监听（53 端口需要管理员权限且常被系统占用，监听 0.0.0.0 还可能成为公网开放解析器）
  ipv6: true
  prefer-h3: false          # respect-rules 下官方不推荐 DoH3；且 QUIC 已被规则拦截
  cache-algorithm: arc      # 性能更优的 ARC 缓存算法
  cache-size: 4096
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - "+.lan"
    - "+.local"
    - "+.localhost"
    - "+.home.arpa"
    - "+.internal"
    # 系统连通性检测（防止 fake-ip 导致“无网络”判断，回退 ISP DNS 造成泄露）
    - "+.msftconnecttest.com"
    - "+.msftncsi.com"          # 通配已覆盖 dns.msftncsi.com
    - "captive.apple.com"
    - "connectivitycheck.gstatic.com"
    - "detectportal.firefox.com"
    # 时间同步
    - "time.nist.gov"
    - "+.pool.ntp.org"
    - "time.*.com"              # 通配已覆盖 time.windows.com
    - "ntp.*.com"               # 通配已覆盖 ntp.ubuntu.com
    # 运营商 Wi-Fi 登录页
    - "+.cmpassport.com"
    - "id6.me"
    - "open.e.189.cn"
    - "mdn.open.wo.cn"
    - "opencloud.wostore.cn"
    - "auth.wosms.cn"
    - "+.10099.com.cn"
    # 原配置保留项
    - "+.market.xiaomi.com"
    - "+.pub.3gppnetwork.org"
    - "+.push.apple.com"
    - "+.bing.com"
    - "+.miwifi.com"
    - "+.docker.io"
    # 国内应用登录（+.qq.com 已覆盖 localhost.ptlogin2.qq.com）
    - "+.qq.com"
    # 直连 / 国内类规则集：返回真实 IP
    - rule-set:Direct
    - rule-set:Private
    - rule-set:China
    - geosite:cn                # 国内域名返回真实 IP（geosite 库兜底，防 fake-ip 干扰国内应用）
  use-hosts: true
  respect-rules: true
  # 引导用 DNS（解析 DoH/DoT 服务器自身的域名），必须是 IP
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  # 默认解析：未命中 nameserver-policy 的域名（国内 DoH，直连）
  nameserver:
    - "https://dns.alidns.com/dns-query"
    - "https://doh.pub/dns-query"
  # 直连出口的解析
  direct-nameserver:
    - "https://dns.alidns.com/dns-query"
    - "https://doh.pub/dns-query"
  # 解析代理节点域名（防套娃 / 防循环，用国内直连可达的 DoH）
  proxy-server-nameserver:
    - "https://dns.alidns.com/dns-query"
    - "https://doh.pub/dns-query"
  nameserver-policy:
    # 广告域名直接返回空应答
    "rule-set:Advertising,AWAvenueAds": rcode://success
    # 直连类：国内 DoH（微软已并入直连，微软域名走国内解析后直连）
    "rule-set:Direct,Private,China,Microsoft":
      - "https://dns.alidns.com/dns-query"
      - "https://doh.pub/dns-query"
    # 走代理类：国外 DoH（连接本身经代理隧道，不直连暴露查询）
    "rule-set:AI,Telegram,Twitter,SocialMedia,Netflix,YouTube,Spotify,TikTok,disney,Google,Proxy":
      - "https://dns.google/dns-query"
      - "https://cloudflare-dns.com/dns-query"

# ==================== 代理策略组（9 个可见 + 6 个隐藏自动子组） ====================
proxy-groups:
  # 主入口：默认自动选择，可手动切换各地区 / 故障转移 / 全部节点 / 直接连接
  - {name: 一键连接,     type: select, proxies: [自动选择, 故障转移, 香港节点, 台湾节点, 日本节点, 美国节点, 新加坡节点, 全部节点, 直接连接], icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Static.png}
  # 自动选择：隐藏（面板不可手动选择），纯自动优选延时最低节点；故障转移：按序自动切换
  - {name: 自动选择,     type: url-test, include-all: true, url: 'https://www.google.com/generate_204', interval: 200, lazy: true, hidden: true, empty-fallback: REJECT, icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Auto.png}
  - {name: 故障转移,     type: fallback, proxies: [香港节点, 台湾节点, 日本节点, 美国节点, 新加坡节点, 全部节点], url: 'https://www.google.com/generate_204', interval: 200, lazy: true, empty-fallback: REJECT, icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/ULB.png}
  # 常用地区节点组（select：默认选中“XX自动”=自动优选该地区最快节点，也可手动指定单个节点）
  - {name: 香港节点,     type: select, include-all: true, filter: *FilterHK, proxies: [香港自动], icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Hong_Kong.png}
  - {name: 台湾节点,     type: select, include-all: true, filter: *FilterTW, proxies: [台湾自动], icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Taiwan.png}
  - {name: 日本节点,     type: select, include-all: true, filter: *FilterJP, proxies: [日本自动], icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Japan.png}
  - {name: 美国节点,     type: select, include-all: true, filter: *FilterUS, proxies: [美国自动], icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/United_States.png}
  - {name: 新加坡节点,   type: select, include-all: true, filter: *FilterSG, proxies: [新加坡自动], icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Singapore.png}
  # 全部节点（手动挑选任意节点；首个选项“自动选择”=全部节点中最快）
  - {name: 全部节点,     type: select, include-all: true, proxies: [自动选择], icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Global.png}
  # 各地区自动优选子组（隐藏，作为各地区分组内的“自动选择”选项）
  - {name: 香港自动,     type: url-test, include-all: true, filter: *FilterHK, url: 'https://www.google.com/generate_204', interval: 200, lazy: true, empty-fallback: REJECT, hidden: true, icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Auto.png}
  - {name: 台湾自动,     type: url-test, include-all: true, filter: *FilterTW, url: 'https://www.google.com/generate_204', interval: 200, lazy: true, empty-fallback: REJECT, hidden: true, icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Auto.png}
  - {name: 日本自动,     type: url-test, include-all: true, filter: *FilterJP, url: 'https://www.google.com/generate_204', interval: 200, lazy: true, empty-fallback: REJECT, hidden: true, icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Auto.png}
  - {name: 美国自动,     type: url-test, include-all: true, filter: *FilterUS, url: 'https://www.google.com/generate_204', interval: 200, lazy: true, empty-fallback: REJECT, hidden: true, icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Auto.png}
  - {name: 新加坡自动,   type: url-test, include-all: true, filter: *FilterSG, url: 'https://www.google.com/generate_204', interval: 200, lazy: true, empty-fallback: REJECT, hidden: true, icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Auto.png}
  # 直连分组（放在最下方）
  - {name: 直接连接,     type: select, proxies: [DIRECT], icon: https://github.com/Koolson/Qure/raw/master/IconSet/Color/Direct.png}

# ==================== 规则路由 ====================
rules:
  # 广告拦截（常用：直接拒绝；如需临时放行可改为一键连接）
  - RULE-SET,Tracking,REJECT
  - RULE-SET,AWAvenueAds,REJECT
  - RULE-SET,Advertising,REJECT
  - GEOSITE,category-ads-all,REJECT        # geosite 广告分类兜底（覆盖规则集未收录的广告域名）

  # DNS 服务器域名：解析通道固定，避免 DNS 流量走错路径（防泄露关键）
  - DOMAIN-SUFFIX,alidns.com,直接连接
  - DOMAIN-SUFFIX,doh.pub,直接连接
  - DOMAIN,dns.google,一键连接
  - DOMAIN,cloudflare-dns.com,一键连接

  # 大陆直连优先（置于国外服务规则之前：大陆应用一律直连，不被国外服务规则集抢先命中）
  - RULE-SET,Private,直接连接
  - RULE-SET,Direct,直接连接
  - RULE-SET,Download,直接连接
  - RULE-SET,AppleCN,直接连接
  - RULE-SET,Microsoft,直接连接        # 微软全家桶直连（Office / OneDrive / Windows 更新 / Teams / Xbox 等）
  - RULE-SET,China,直接连接             # 国内域名直连
  - GEOSITE,CN,直接连接                  # geosite 国内域名兜底（覆盖规则集未收录的国内域名，先于 GEOIP 命中）
  # 阻止走代理的 QUIC（强制回退 TCP，避免 QUIC 绕过代理 / 被干扰）。
  # 放在直连规则之后：直连 QUIC（大陆 / 微软 / 苹果）不受影响。如需 Telegram 语音等 UDP，可删除此行。
  - AND,((DST-PORT,443),(NETWORK,UDP)),REJECT

  # 常用国外服务（统一走一键连接）
  - RULE-SET,AI,一键连接
  - RULE-SET,Telegram,一键连接
  - RULE-SET,Twitter,一键连接
  - RULE-SET,SocialMedia,一键连接
  - RULE-SET,Netflix,一键连接
  - RULE-SET,YouTube,一键连接
  - RULE-SET,Spotify,一键连接
  - RULE-SET,TikTok,一键连接
  - RULE-SET,disney,一键连接
  - RULE-SET,Google,一键连接
  - RULE-SET,github,一键连接
  - RULE-SET,Proxy,一键连接

  # IP规则
  - RULE-SET,PrivateIP,直接连接,no-resolve
  - RULE-SET,TelegramIP,一键连接,no-resolve
  - RULE-SET,ProxyIP,一键连接,no-resolve
  - RULE-SET,ChinaIP,直接连接,no-resolve

  # 大陆 IP 兜底直连：覆盖规则集未收录的域名 / 纯 IP 连接的大陆应用（GEOIP 库覆盖面更全）
  - GEOIP,CN,直接连接,no-resolve

  # 兜底规则：其余（国外）走一键连接
  - MATCH,一键连接

# ==================== 规则集 ====================
# 规则集行为模板
BehaviorDN: &BehaviorDN {type: http, behavior: domain, format: mrs, interval: 86400}
BehaviorDY: &BehaviorDY {type: http, behavior: domain, format: yaml, interval: 86400}
BehaviorIP: &BehaviorIP {type: http, behavior: ipcidr, format: mrs, interval: 86400}
ClassicalYaml: &ClassicalYaml {type: http, behavior: classical, interval: 3600, format: yaml, proxy: DIRECT}
BehaviorCL: &BehaviorCL {type: http, behavior: classical, interval: 86400, format: yaml, proxy: DIRECT}   # 经典规则集（blackmatrix7 等，DOMAIN/DOMAIN-SUFFIX/DOMAIN-KEYWORD/PROCESS-NAME）

# 规则提供者（仅保留常用）
rule-providers:
  # 广告
  Tracking:       {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Tracking.mrs}
  Advertising:    {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Advertising.mrs}
  AWAvenueAds:    {<<: *BehaviorDY, url: https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Clash.yaml}
  # 直连 / 国内
  Direct:         {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Direct.mrs}
  Private:        {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Private.mrs}
  Download:       {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Download.mrs}
  AppleCN:        {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/AppleCN.mrs}
  China:          {<<: *BehaviorCL, url: https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/ChinaMaxNoIP/ChinaMaxNoIP_No_Resolve.yaml}   # 大陆直连全量：ChinaMaxNoIP（11万+ 域名，含大陆可达国际服务），每日更新
  # 常用国外服务
  AI:             {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/AI.mrs}
  Telegram:       {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Telegram.mrs}
  Twitter:        {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Twitter.mrs}
  SocialMedia:    {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/SocialMedia.mrs}
  Netflix:        {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Netflix.mrs}
  YouTube:        {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/YouTube.mrs}
  Google:         {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Google.mrs}
  Microsoft:      {<<: *BehaviorCL, url: https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Microsoft/Microsoft.yaml}   # 微软全家桶全量：blackmatrix7（Office/OneDrive/Xbox/Teams/Skype/Bing/Azure 等）
  Proxy:          {<<: *BehaviorDN, url: https://github.com/666OS/rules/raw/release/mihomo/domain/Proxy.mrs}
  # 媒体（DustinWin）
  Spotify:        {<<: *BehaviorDN, url: https://github.com/DustinWin/ruleset_geodata/releases/download/mihomo-ruleset/spotify.mrs}
  TikTok:         {<<: *BehaviorDN, url: https://github.com/DustinWin/ruleset_geodata/releases/download/mihomo-ruleset/tiktok.mrs}
  disney:         {<<: *BehaviorDN, url: https://github.com/DustinWin/ruleset_geodata/releases/download/mihomo-ruleset/disney.mrs}
  # GitHub
  github:          {<<: *ClassicalYaml, url: https://rule.kelee.one/Clash/GitHub.yaml}
  # IP规则
  PrivateIP:      {<<: *BehaviorIP, url: https://github.com/666OS/rules/raw/release/mihomo/ip/Private.mrs}
  TelegramIP:     {<<: *BehaviorIP, url: https://github.com/666OS/rules/raw/release/mihomo/ip/Telegram.mrs}
  ProxyIP:        {<<: *BehaviorIP, url: https://github.com/666OS/rules/raw/release/mihomo/ip/Proxy.mrs}
  ChinaIP:        {<<: *BehaviorIP, url: https://github.com/666OS/rules/raw/release/mihomo/ip/China.mrs}

# ==================== EOF ====================

`;
// 面板页面模板（HTML + CSS + JS）：发给浏览器前注入字段表等运行时数据
const PANEL_TEMPLATE = String.raw`
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hopline · 代理订阅面板</title>
<script>(function(){var t='auto';try{t=localStorage.getItem('tp_theme')||'auto'}catch(e){}if(t!=='light'&&t!=='dark')t=window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3' y='3' width='18' height='18' rx='5' fill='%232563eb'/%3E%3Cpath d='M8 15V9l8 6V9' stroke='%23ffffff' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js" integrity="sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  
  --bg:#f6f7fb;--bg2:#eef1f6;--card:#ffffff;--card2:#f8fafc;--border:#e4e7ee;
  --text:#0f172a;--dim:#64748b;--faint:#94a3b8;
  --accent:#2563eb;--accent2:#3b82f6;--accent-dim:rgba(37,99,235,.10);
  --accent-strong:#1d4ed8;--accent-text:#1d4ed8;--on-accent:#ffffff;
  --ok:#059669;--ok-dim:rgba(5,150,105,.10);--err:#dc2626;--err-dim:rgba(220,38,38,.08);--warn:#d97706;
  --sb-bg:#ffffff;--sb-text:#475569;--sb-dim:#94a3b8;--sb-border:#e9edf3;
  --sb-active-bg:rgba(37,99,235,.08);--sb-active-text:#1d4ed8;--sb-active-bar:#2563eb;
  --topbar-bg:rgba(246,247,251,.85);
  --shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.06);
  --card-shadow:0 1px 2px rgba(15,23,42,.04),0 1px 3px rgba(15,23,42,.03);
}
[data-theme="dark"]{
  --bg:#0b1120;--bg2:#0f172a;--card:#111827;--card2:#1a2233;--border:#243044;
  --text:#e5e9f0;--dim:#94a3b8;--faint:#64748b;
  --accent:#3b82f6;--accent2:#60a5fa;--accent-dim:rgba(59,130,246,.16);
  --accent-strong:#2563eb;--accent-text:#93c5fd;--on-accent:#ffffff;
  --ok:#34d399;--ok-dim:rgba(52,211,153,.13);--err:#f87171;--err-dim:rgba(248,113,113,.13);--warn:#fbbf24;
  --sb-bg:#0d1424;--sb-text:#94a3b8;--sb-dim:#64748b;--sb-border:#1c2638;
  --sb-active-bg:rgba(59,130,246,.14);--sb-active-text:#93c5fd;--sb-active-bar:#3b82f6;
  --topbar-bg:rgba(11,17,32,.85);
  --shadow:0 10px 30px rgba(0,0,0,.35);
  --card-shadow:none;
}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:14px;line-height:1.55}
.app{display:flex;min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}


.sidebar{width:236px;flex:0 0 236px;background:var(--sb-bg);border-right:1px solid var(--sb-border);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;z-index:50;transition:background .25s,border-color .25s}
.brand{display:flex;align-items:center;gap:10px;padding:18px 18px 14px}
.mark{width:34px;height:34px;border-radius:9px;background:var(--accent);display:flex;align-items:center;justify-content:center;flex:0 0 34px;box-shadow:0 4px 12px var(--accent-dim)}
.mark svg{width:18px;height:18px}
.mark path{stroke:var(--on-accent)}
.brand .bt{display:flex;flex-direction:column;line-height:1.2}
.brand .bt b{font-size:15px;letter-spacing:.3px;color:var(--text)}
.brand .bt span{font-size:11px;color:var(--sb-dim)}
.nav{flex:1;padding:6px 10px 12px;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;margin:2px 0;border-radius:8px;color:var(--sb-text);cursor:pointer;border:none;background:transparent;width:100%;text-align:left;font-size:13.5px;position:relative;transition:background .15s,color .15s}
.nav-item svg{width:17px;height:17px;flex:0 0 17px;stroke:currentColor}
.nav-item:hover{background:var(--sb-active-bg);color:var(--sb-active-text)}
.nav-item.on{background:var(--sb-active-bg);color:var(--sb-active-text);font-weight:600}
.nav-item.on::before{content:"";position:absolute;left:-10px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--sb-active-bar)}
.side-foot{padding:12px 18px;border-top:1px solid var(--sb-border);display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--sb-dim)}
.ver-chip{font-family:ui-monospace,Consolas,monospace;background:var(--accent-dim);color:var(--sb-active-text);padding:2px 8px;border-radius:6px;font-size:11px;border:1px solid transparent;cursor:pointer;transition:border-color .15s,color .15s,background .15s}
.ver-chip:hover{color:var(--accent);border-color:var(--accent)}
.ver-chip.has-update{color:var(--accent);background:var(--accent-dim);border-color:var(--accent)}
.ver-chip.checking{opacity:.7;pointer-events:none}


.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:14px;padding:14px 26px;border-bottom:1px solid var(--border);background:var(--topbar-bg);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);position:sticky;top:0;z-index:40}
.topbar-title{flex:1;min-width:0}   
.topbar-title h1{font-size:17px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-title p{color:var(--dim);font-size:12.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;border-radius:20px;background:var(--ok-dim);color:var(--ok);white-space:nowrap}
.pill.off{background:var(--err-dim);color:var(--err)}
.pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.icon-btn{width:34px;height:34px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 34px}
.icon-btn:hover{border-color:var(--accent);color:var(--accent)}
.icon-btn svg{width:16px;height:16px;stroke:currentColor}
.hamb{display:none}
.wdwarn{display:none;background:var(--accent-dim);border-bottom:1px solid var(--border);color:var(--accent-text);padding:9px 26px;font-size:12.5px;line-height:1.6;text-align:center}

.content{padding:22px 26px 96px;max-width:1180px;width:100%;margin:0 auto}
.view{display:none}
.view.on{display:block;animation:fade .18s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}


.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}
.filter-region{display:flex;align-items:center;gap:14px;padding:2px 0 14px;border-bottom:1px solid var(--border);margin-bottom:14px;flex-wrap:wrap}
.filter-region-label{font-size:13px;font-weight:600;white-space:nowrap}
.filter-row{display:flex;flex-wrap:wrap}
.filter-group{flex:0 1 auto;min-width:180px;padding:0 14px;border-left:1px solid var(--border)}
.filter-group:first-child{border-left:none;padding-left:0}
.filter-group-title{font-size:12px;font-weight:600;color:var(--dim);margin-bottom:9px;letter-spacing:.3px}
.pills{display:flex;flex-wrap:wrap;gap:8px}
.pills.nowrap{flex-wrap:nowrap;white-space:nowrap}
.pills.nowrap .spill span{padding:5px 10px;font-size:12px}
.spill input{position:absolute;opacity:0;pointer-events:none}
.spill span{display:inline-block;padding:5px 14px;border:1px solid var(--border);border-radius:999px;font-size:12.5px;color:var(--dim);cursor:pointer;background:var(--card);transition:border-color .15s,color .15s,background .15s;user-select:none;line-height:1.5}
.spill:hover span{border-color:var(--accent);color:var(--accent)}
.spill input:checked + span{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600;border-radius:999px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:16px;box-shadow:var(--card-shadow)}
.card h3{font-size:14px;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.card h3 .tick{width:3px;height:14px;border-radius:2px;background:var(--accent)}
.card .sub{font-size:12px;color:var(--dim);font-weight:400;margin-left:auto}
.kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--border);font-size:13px}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--dim);white-space:nowrap}
.kv .v{text-align:right;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
.kv .v.ok{color:var(--ok)}.kv .v.bad{color:var(--err)}


.field{margin-bottom:12px}
.field>label{display:block;font-size:12.5px;color:var(--dim);margin-bottom:6px;font-weight:500}
input[type=text],input[type=password],input[type=number],select,textarea{
  width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:8px 11px;font-size:13.5px;outline:none;transition:border-color .15s,box-shadow .15s;
  font-family:inherit;
}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
textarea{resize:vertical;line-height:1.5;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
select{cursor:pointer;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2364748b' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:30px}
[data-theme="dark"] select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2394a3b8' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")}
input[type=checkbox]{accent-color:var(--accent);width:15px;height:15px;cursor:pointer}
.hint{font-size:12px;color:var(--dim);margin-top:6px;line-height:1.6}

input.invalid,select.invalid,textarea.invalid{border-color:var(--err)!important;box-shadow:0 0 0 3px var(--err-dim)}
.switch input.invalid+.sl,.spill input.invalid+span{outline:2px solid var(--err);outline-offset:2px}
.field-err{font-size:12px;color:var(--err);margin-top:6px;line-height:1.5}
.env-lock{color:var(--warn)}
.ipt-out{margin-top:12px;border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--card2)}
.ipt-out .ipt-head{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:13px;margin-bottom:8px}
.ipt-out .ipt-head b{font-size:13.5px}
.ipt-out .ipt-ok{color:var(--ok)}.ipt-out .ipt-err{color:var(--err)}
.ipt-out .ipt-dim{color:var(--dim);font-size:12px}
.ipt-out pre.code{margin-top:6px;max-height:240px}
.ipt-out details{margin-top:8px}
.ipt-out summary{cursor:pointer;font-size:12.5px;color:var(--dim)}
input:disabled,select:disabled,textarea:disabled{opacity:.6;cursor:not-allowed}
.inrow{display:flex;gap:8px;align-items:flex-start}
.inrow>div{flex:1}
.inrow .btn{margin-top:1px;white-space:nowrap}
.proto-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--border);font-size:13.5px}
.proto-row:last-child{border-bottom:none}


.switch{position:relative;display:inline-block;width:40px;height:22px;flex:0 0 40px}
.switch input{opacity:0;width:0;height:0}
.sl{position:absolute;inset:0;background:var(--border);border-radius:22px;cursor:pointer;transition:background .18s}
.sl::before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .18s}
.switch input:checked+.sl{background:var(--accent)}
.switch input:checked+.sl::before{transform:translateX(18px)}


.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--border);background:var(--card2);color:var(--text);border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;transition:border-color .15s,background .15s,transform .05s;font-family:inherit;white-space:nowrap}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn.primary{background:var(--accent);border-color:transparent;color:var(--on-accent);font-weight:600}
.btn.primary:hover{background:var(--accent-strong);color:var(--on-accent)}
.btn.danger{background:var(--err-dim);border-color:transparent;color:var(--err)}
.btn.danger:hover{border-color:var(--err)}
.btn.sm{padding:4px 10px;font-size:12px;border-radius:6px}
.btn .dirty-dot{display:none;width:6px;height:6px;border-radius:50%;background:var(--warn)}
.btn.dirty .dirty-dot{display:inline-block}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row .grow{flex:1;min-width:140px}


.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{text-align:left;padding:9px 10px;font-size:13px;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
th{color:var(--dim);font-weight:500;font-size:12px;background:var(--card2)}
td .ip{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}


pre.code{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11.5px;line-height:1.55;font-family:ui-monospace,Consolas,monospace;overflow:auto;max-height:260px;white-space:pre-wrap;word-break:break-all;color:var(--dim)}


.fbar{position:fixed;right:22px;bottom:22px;display:flex;gap:10px;z-index:60;align-items:center}
.fbar .btn{box-shadow:var(--shadow)}
.saved-at{font-size:11.5px;color:var(--faint);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:5px 10px;box-shadow:var(--shadow);white-space:nowrap}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(80px);background:var(--card);border:1px solid var(--border);color:var(--text);padding:10px 20px;border-radius:10px;font-size:13px;opacity:0;transition:all .25s;z-index:100;box-shadow:var(--shadow);pointer-events:none;max-width:86vw}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:var(--ok);color:var(--ok)}
.toast.err{border-color:var(--err);color:var(--err)}
.toast.warn{border-color:var(--warn);color:var(--warn)}


.danger-zone{border:1px solid var(--err);border-radius:12px;padding:16px;background:var(--err-dim)}
.qrbox{display:flex;justify-content:center;padding:12px 0 4px}
.qrbox img{width:168px;height:168px;image-rendering:pixelated;border-radius:8px}
.note-box{background:var(--card2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:12px 14px;font-size:12.5px;color:var(--dim);line-height:1.7;margin-bottom:12px}
.steps{list-style:none;counter-reset:st}
.steps li{counter-increment:st;position:relative;padding:0 0 14px 34px;font-size:13px;color:var(--dim)}
.steps li::before{content:counter(st);position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;background:var(--accent-dim);color:var(--accent-text);display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700}
.steps li b{color:var(--text)}


@media (max-width:960px){
  .sidebar{position:fixed;left:0;top:0;transform:translateX(-100%);transition:transform .22s ease;box-shadow:var(--shadow)}
  .sidebar.open{transform:translateX(0)}
  .hamb{display:flex}
  .content{padding:16px 16px 96px}
  .topbar{padding:10px 16px}
  .topbar-title h1{font-size:16px}
  .topbar-title p{font-size:12px}
  .grid2,.grid3{grid-template-columns:1fr}
}
@media (max-width:560px){
  th,td{padding:8px 8px}
}


.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:12px}
.tab{background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 12px;font:inherit;font-size:13px;color:var(--dim);cursor:pointer}
.tab:hover{color:var(--text)}
.tab.on{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.node-list{border:1px solid var(--border);border-radius:8px;max-height:420px;overflow:auto}
.node-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border)}
.node-row:last-child{border-bottom:0}
.node-row .nm{flex:1;min-width:0}
.node-row .nm b{display:block;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.node-row .nm span{display:block;font-size:11.5px;color:var(--dim);font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.node-row .btn{flex:0 0 auto}
.ptag{flex:0 0 auto;min-width:54px;text-align:center;font-size:11px;font-weight:600;padding:2px 7px;border-radius:5px;background:var(--accent-dim);color:var(--accent)}
.ptag.xhttp{background:rgba(217,119,6,.13);color:var(--warn)}
.node-empty{padding:18px;text-align:center;color:var(--dim);font-size:13px}
.modal{display:none;position:fixed;inset:0;z-index:90;background:rgba(15,23,42,.45);align-items:center;justify-content:center;padding:16px}
.modal.show{display:flex}
.modal-card{background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:16px;width:100%;max-width:360px}
.modal-head{display:flex;align-items:center;gap:10px}
.modal-head b{flex:1;min-width:0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.modal .qrbox img{width:auto;height:auto;max-width:100%;background:#fff}
.modal pre.code{max-height:96px;margin-top:8px}

.pxrow{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;cursor:pointer;background:var(--card2)}
.pxrow:hover{border-color:var(--accent)}
.pxrow.sel{border-color:var(--accent);background:var(--accent-dim)}
.pxmain{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.pxst{font-size:12px;color:var(--dim);white-space:nowrap}
.pxst.ok{color:var(--ok)}
.pxst.bad{color:var(--err)}
.pxon{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--dim);white-space:nowrap;cursor:pointer}
</style>
</head>
<body>
<div class="app">


<aside class="sidebar" id="sidebar">
  <div class="brand">
    <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h4l3-7 4 14 3-7h2"/></svg></div>
    <div class="bt"><b>Hopline</b><span>代理订阅面板</span></div>
  </div>
  <nav class="nav" id="nav"></nav>
  <div class="side-foot">
    <span>部署版本</span>
    <span class="ver-chip" id="sideVer" title="点击检测更新" onclick="checkUpdate()">v—</span>
  </div>
</aside>


<div class="main">
  <div class="topbar">
    <button class="icon-btn hamb" id="hamb" title="菜单"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <div class="topbar-title"><h1 id="pageTitle"></h1><p id="pageSub"></p></div>
    <span class="pill" id="connPill"><span class="dot"></span><span id="connText">连接中</span></span>
    <button class="icon-btn" id="themeBtn" title="切换主题：跟随系统 / 日间 / 夜间"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path id="themeIcon" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
  </div>
  <div class="wdwarn" id="wdwarn">当前运行在 *.workers.dev 域名上：面板与订阅功能正常；若客户端更新订阅失败或访问受限，建议在 Cloudflare 面板给面板 Worker 绑定自定义域名后使用。</div>
  <div class="wdwarn" id="epwarn">还不能生成订阅，缺少：<b id="epMissing"></b>。请到 <a href="#" onclick="switchView('account');return false">面板设置 → 代理</a> 添加并连接代理。</div>

  <div class="content">
    
    <section class="view" data-view="dashboard" data-title="仪表盘" data-sub="快速开始、订阅管理与运行状态">
      <div class="card">
        <h3><span class="tick"></span>快速开始</h3>
        <ol class="steps">
          <li><b>连接代理</b>：在「面板设置 → 代理」填入代理脚本（Hopline-proxy.js）的域名、节点路径（环境变量 PATH）和密钥（环境变量 NODE_KEY），点「连接并同步」，面板会自动生成 UUID 并下发给代理，客户端订阅即可获得一批 Cloudflare 优选节点（优选域名与在线优选 IP 来源）；Clash / Mihomo 与 Sing-box 订阅已内置大陆直连分流规则（大陆应用、微软、苹果直连，国外服务走代理）。</li>
          <li><b>调优节点</b>：用本地工具（如 CloudflareSpeedTest）在自己的网络下测速，把最优 IP 列表托管成一个地址（纯 IP 行 / CSV），填入「优选配置 → 优选 IP 来源」的自定义优选 API；也可以在「优选配置 → 优选域名」换成自己的优选域名。</li>
          <li><b>检查来源</b>：在「优选配置 → 优选 IP 来源」开关各在线来源，点「测试」可立即查看该来源实时拉取到的 IP；单次订阅最多下发 500 个节点，保证在免费计划 10ms CPU 限制内稳定生成。</li>
        </ol>
      </div>
      <div class="card">
        <h3><span class="tick"></span>订阅地址</h3>
        <div class="row" style="margin-bottom:12px">
          <div class="field grow" style="margin:0"><label>订阅格式</label>
            <select id="subFmt">
              <option value="auto">自动识别</option>
              <option value="clash">Clash / Mihomo</option>
              <option value="singbox">Sing-box</option>
              <option value="surge">Surge</option>
              <option value="loon">Loon</option>
              <option value="quanx">Quantumult X</option>
              <option value="v2ray">v2rayN / Shadowrocket</option>
              <option value="stash">Stash</option>
              <option value="plain">明文节点链接</option>
            </select>
          </div>
        </div>
        <div class="field"><label>订阅链接</label>
          <div class="inrow">
            <input type="text" id="subUrl" readonly onclick="this.select()">
            <button class="btn sm" onclick="copySub()">复制</button>
            <button class="btn sm" onclick="toggleQR()">二维码</button>
            <button class="btn sm" onclick="downloadSub()">下载</button>
            <button class="btn sm primary" onclick="previewSub()">预览</button>
          </div>
        </div>
        <div id="qrWrap" style="display:none"></div>
        <p class="hint" style="margin-top:12px" id="subHint"></p>
        <div id="subPrev" style="display:none;margin-top:12px">
          <div class="tabs" role="tablist">
            <button class="tab" id="prevTabList" role="tab" onclick="prevTab('list')">节点列表</button>
            <button class="tab" id="prevTabRaw" role="tab" onclick="prevTab('raw')">原始内容</button>
          </div>
          <div id="prevList">
            <input type="text" id="nodeSearch" placeholder="搜索名称 / 地址 / 协议，如 香港、XHTTP" autocomplete="off" oninput="renderNodeList()">
            <p class="hint" style="margin:8px 0 10px">单个节点可用 v2rayN / v2rayNG / Shadowrocket / NekoBox 等从剪贴板或二维码导入。单个节点不会随订阅更新（优选 IP 变化后需重新导入）；链接中含 UUID，请勿外传。</p>
            <div class="node-list" id="nodeList"></div>
          </div>
          <div id="prevRaw">
            <div class="kv"><span class="k">订阅类型</span><span class="v" id="prevType">—</span></div>
            <div class="kv"><span class="k">节点数量</span><span class="v" id="prevCount">—</span></div>
            <pre class="code" id="prevBody" style="margin-top:10px"></pre>
          </div>
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>地区与线路筛选</h3>
        <div class="filter-region">
          <span class="filter-region-label">节点地区</span>
          <div class="pills">
            <label class="spill"><input type="checkbox" id="fl-region-all" checked><span>全部地区</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-HK"><span>香港</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-TW"><span>台湾</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-US"><span>美国</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-SG"><span>新加坡</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-JP"><span>日本</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-KR"><span>韩国</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-DE"><span>德国</span></label>
          </div>
        </div>
        <div class="filter-row">
          <div class="filter-group">
            <div class="filter-group-title">IP 类型</div>
            <div class="pills">
              <label class="spill"><input type="checkbox" id="fl-ip4" checked><span>IPv4</span></label>
              <label class="spill"><input type="checkbox" id="fl-ip6"><span>IPv6</span></label>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-group-title">运营商偏好</div>
            <div class="pills">
              <label class="spill"><input type="checkbox" id="fl-isp-m" checked><span>移动</span></label>
              <label class="spill"><input type="checkbox" id="fl-isp-c" checked><span>联通</span></label>
              <label class="spill"><input type="checkbox" id="fl-isp-t" checked><span>电信</span></label>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-group-title">地址来源</div>
            <div class="pills nowrap">
              <label class="spill"><input type="checkbox" id="fl-native"><span>原生地址</span></label>
              <label class="spill"><input type="checkbox" id="fl-pref-domain" checked><span>优选域名</span></label>
              <label class="spill"><input type="checkbox" id="fl-pref-ip" checked><span>优选 IP</span></label>
            </div>
          </div>
        </div>
        <p class="hint" style="margin-top:12px">筛选后若没有节点，会按 运营商 → IP 类型 → 地区 的顺序逐级放宽条件，保证订阅始终非空。「运营商偏好」按节点名称中的运营商标记过滤（移动=移动/CM/CHINAMOBILE、联通=联通/CU/UNICOM、电信=电信/CT/CHINATELECOM），只剔除标记为未勾选运营商的节点，不带运营商标记的通用节点保留；HostMonit / uouin 实时优选节点带运营商标记（如「移动-01」）。「节点地区」支持多选，仅剔除节点名称明确标记为其它地区的节点；默认节点来源均为不带地区的 Cloudflare 任播 IP / 域名（任播 IP 的落地机房取决于你所在的网络），地区筛选通常不改变节点构成；自定义优选 API 返回的节点名带地区时才会按地区筛选。「地址来源」控制下发节点的来源：原生地址（工作器域名）、优选域名（「优选配置 → 优选域名」，留空用内置列表）、优选 IP（HostMonit / uouin / 自定义优选 API）。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>运行状态</h3>
        <div class="kv"><span class="k">协议</span><span class="v" id="stProto">—</span></div>
        <div class="kv"><span class="k">KV 持久化</span><span class="v" id="stKv">—</span></div>
        <div class="kv"><span class="k">面板入口</span><span class="v" id="stEntry">—</span></div>
        <div class="kv"><span class="k">代理状态</span><span class="v" id="stProxy">—</span></div>
        <div id="stProxyList"></div>
        <div class="inrow" style="margin-top:10px;align-items:center"><button class="btn sm" onclick="checkProxy()">检测代理</button><span class="hint" id="stProxyHint" style="margin:0"></span></div>
      </div>
    </section>

    
    <section class="view" data-view="nodes" data-title="节点配置" data-sub="订阅里下发的协议、TLS 与 ECH（保存后立即生效）">
      <div class="grid3">
        <div class="card">
          <h3><span class="tick"></span>协议开关</h3>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="en-vless" checked><span class="sl"></span></label><span>VLESS 协议（默认开启）</span></div>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="en-xhttp" checked><span class="sl"></span></label><span>XHTTP 协议（需 Mihomo / Xray 内核，Sing-box、Surge 等不支持；须绑定自定义域名并开启gRPC）</span></div>
        </div>
        <div class="card">
          <h3><span class="tick"></span>TLS 与传输</h3>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="tls-only"><span class="sl"></span></label><span>仅 TLS 端口（跳过 80/8080 等明文端口）</span></div>
          <div class="field" style="margin-top:12px"><label>ALPN 协商（h2 / http/1.1，逗号分隔）</label><input type="text" id="alpn" placeholder="留空自动，如 h2,http/1.1" autocomplete="off"></div>
          <p class="hint">默认开启：只下发 TLS 端口节点。关闭后，每个 443 节点另追加一个 80 明文端口节点（名称带「·80」），来源中自带的 8080 / 2052 等明文端口也原样下发。明文节点不加密 UUID 与 Host，更容易被识别封锁；自定义域名还需在 Cloudflare 关闭「始终使用 HTTPS」，否则明文节点无法连接。开启 ECH 时始终只下发 TLS 端口节点。</p>
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>ECH 加密（可选）</h3>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="ech-on"><span class="sl"></span></label><span>启用 ECH 加密（需绑定自定义域名）</span></div>
        <div class="grid2" style="margin-top:12px">
          <div class="field" style="margin-bottom:0"><label>ECH 域名（留空用默认 cloudflare-ech.com）</label><input type="text" id="ech-host" placeholder="cloudflare-ech.com" autocomplete="off"></div>
          <div class="field" style="margin-bottom:0"><label>自定义 ECH DNS（DoH 地址，留空使用 https://223.5.5.5/dns-query）</label><input type="text" id="ech-dns" placeholder="https://223.5.5.5/dns-query" autocomplete="off"></div>
        </div>
        <p class="hint">开启后，链接类订阅（v2rayN / Shadowrocket 等）的 TLS 节点附带 ech 参数，Clash 订阅附带 ech-opts；Sing-box、Surge、Loon、Quantumult X 订阅不含 ECH。客户端需支持 ECH 才能生效。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>保存与生效</h3>
        <div class="note-box" style="margin:0">所有配置修改后点击右下角「保存全部」才会写入 KV 并生效，保存成功后本机房立即生效，其它机房最多约 1 分钟后同步；「重置」将清空 KV 中保存的全部面板配置并还原为初始部署状态。</div>
      </div>
    </section>

    
    <section class="view" data-view="optimizer" data-title="优选配置" data-sub="优选域名与优选 IP 来源">
      <div class="card">
        <h3><span class="tick"></span>优选域名</h3>
        <div class="field"><label>优选域名列表（每行一个纯主机名；留空 = 使用内置列表）</label>
          <textarea id="o-prefdomains" rows="6" placeholder="cf.example.com&#10;cdn.example.org" autocomplete="off" spellcheck="false"></textarea>
          <div class="hint">填写后<b>整体替换</b>内置列表（不是追加）。用于「地址来源 → 优选域名」下发的域名节点和 IPv6 解析。只填主机名，不含 http://、端口、路径或通配符，最多 30 个；IP 地址请放到「优选 IP 来源」的自定义优选 API 里。</div>
        </div>
        <div class="proto-row">
          <span class="hint" id="pd-count" style="margin:0">—</span>
          <span style="flex:1"></span>
          <button type="button" class="btn sm" onclick="loadBuiltinDomains()">载入内置列表</button>
          <button type="button" class="btn sm" id="ps-test-domains" onclick="testIpSource('domains')">测试</button>
        </div>
        <p class="hint">每个域名的运营方都能通过 SNI 看到你的 Worker 主机名，只使用你信任的域名。测试会解析前 25 个域名，看它们是否落在 Cloudflare 段（占用同样数量的子请求，仅管理员手动触发）。IPv6 解析：同时勾选 IPv4 与 IPv6 时只解析前 12 个域名，仅勾选 IPv6 时解析前 25 个；其余仍作为域名节点下发。</p>
        <div id="pd-test-out" class="ipt-out" style="display:none"></div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>优选 IP 来源</h3>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="ps-hostmonit"><span class="sl"></span></label><span>HostMonit 实时优选（按移动 / 联通 / 电信分线路实测，节点名如「移动-01」）</span><span style="flex:1"></span><button type="button" class="btn sm" id="ps-test-hostmonit" onclick="testIpSource('hostmonit')">测试</button></div>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="ps-uouin"><span class="sl"></span></label><span>uouin 分线路优选（电信 / 联通 / 移动 / 多线 / IPv6，节点名如「电信-U01」）</span><span style="flex:1"></span><button type="button" class="btn sm" id="ps-test-uouin" onclick="testIpSource('uouin')">测试</button></div>
        <p class="hint" style="margin:4px 0 10px">uouin 使用的是对方网站的内部接口（非开放 API），对方可能随时更换签名或封禁，届时该来源静默失效、由其它来源兜底；默认开启，如不需要可关闭。</p>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="ps-wetest"><span class="sl"></span></label><span>微测网优选（wetest.vip：移动 / 联通 / 电信各 5 个，IPv4 与 IPv6 各一页，节点名如「移动-W01」「移动-W6-01」）</span><span style="flex:1"></span><button type="button" class="btn sm" id="ps-test-wetest" onclick="testIpSource('wetest')">测试</button></div>
        <p class="hint" style="margin:4px 0 10px">微测网读取的是对方的公开页面（HTML 表格，非开放 API），约每 15 分钟更新；版式变化或不可达时该来源静默失效、由其它来源兜底。默认关闭；只拉取当前「IP 类型」筛选需要的页面（IPv4 / IPv6 各占 1 个子请求）。</p>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="ps-api1-on"><span class="sl"></span></label><span>自定义优选 API 1</span><span style="flex:1"></span><button type="button" class="btn sm" id="ps-test-api1" onclick="testIpSource('api1')">测试</button></div>
        <div class="field"><input type="text" id="ps-api1-url" placeholder="https://example.com/ips.txt（纯 IP 行 / CSV / HTML 线路表 / base64 订阅 / sub://）" autocomplete="off"></div>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="ps-api2-on"><span class="sl"></span></label><span>自定义优选 API 2</span><span style="flex:1"></span><button type="button" class="btn sm" id="ps-test-api2" onclick="testIpSource('api2')">测试</button></div>
        <div class="field"><input type="text" id="ps-api2-url" placeholder="https://example.com/ips.csv" autocomplete="off"></div>
        <p class="hint">仅在「仪表盘 → 地址来源 → 优选 IP」开启时生效。所有来源只保留 Cloudflare 段 IP，结果缓存 10 分钟（绑定自定义域名时，同一机房的实例共享缓存），缓存未命中时每个开启的来源占用 1 个子请求。排列顺序：自定义 API 1 / 2 → HostMonit → uouin → 微测网。「测试」会立即重新拉取该来源（不影响订阅缓存，开关关闭时也可测试；自定义 API 使用输入框当前地址，无需先保存）。</p>
        <div id="ps-test-out" class="ipt-out" style="display:none"></div>
      </div>
    </section>

    
    <section class="view" data-view="proxy" data-title="代理设置" data-sub="代理的落地、出站与备用线路设置，以及所有代理共用的备用线路表（保存在面板里，面板用密钥签名后下发给代理）">
      <div class="card">
        <h3><span class="tick"></span>状态</h3>
        <div class="note-box" id="px-note" style="margin:0">读取中…</div>
        <div class="field" id="px-whichbox" style="display:none;margin:12px 0 0"><label>要修改的代理</label><select id="px-which" onchange="onProxyWhich()"></select></div>
        <div class="inrow" style="margin-top:12px">
          <button class="btn" id="px-reload" onclick="loadProxySettings()">重新读取</button>
          <button class="btn primary" id="px-save" onclick="saveProxySettings()">保存并下发</button>
          <button class="btn danger" id="px-reset" onclick="resetProxySettings()">恢复默认</button>
        </div>
        <p class="hint" style="margin-top:10px">这里的设置保存在面板里（和代理的域名、密钥一起），保存时整份下发给代理，代理约 1 分钟内生效（KV 同步与缓存）；之后哪怕代理的 KV 被清空，点「连接并同步」也能原样恢复。有多个代理时，每个代理各有一份设置。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>落地与出站</h3>
        <div class="field"><label>反代 / 落地 IP（填写后作为固定出口优先使用；留空则直连失败后由备用线路兜底，格式 host 或 host:port）</label><input type="text" id="s-proxyIP" placeholder="留空则直连失败后走备用线路" autocomplete="off"></div>
        <div class="field"><label>出站代理（可选）</label><input type="text" id="s-outbound" placeholder="socks5://user:pass@1.2.3.4:1080 或 http://1.2.3.4:8080" autocomplete="off"></div>
        <p class="hint">支持 socks5://（可带 user:pass@）、http(s)://，或 host:port（默认按 socks5，端口 1080）；不再支持 Shadowsocks。用户名与密码保存在面板的 KV 里，并随状态下发到代理的 KV。</p>
        <div class="field" style="margin-bottom:0"><label>出站方式</label>
          <select id="s-outmode">
            <option value="">默认（先走出站代理，失败后直连 / 备用线路）</option>
            <option value="only">仅走出站代理，失败后只用备用线路、不直连（only）</option>
          </select>
        </div>
        <p class="hint" style="margin-top:10px">未填写出站代理时，两种出站方式都按直连处理。选「仅走出站代理」并填写了出站代理时，上面的反代 / 落地 IP 不会被使用（它会绕过出站代理）。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>备用线路（这个代理）</h3>
        <p class="hint" style="margin-top:0">直连不通（例如目标站同在 Cloudflare 上）时，代理会把 TLS 流量交给备用线路按 SNI 转发，并与直连并发竞速。线路是第三方服务器，能看到目标域名与连接元数据；不想经第三方时选「关闭」。非 TLS 流量不会走备用线路。线路表见下方。</p>
        <div class="field"><label>选用方式</label>
          <select id="rl-mode" onchange="onRelayMode()">
            <option value="auto">自动（按 Worker 所在机房选最近的地区，再依次补它相邻的地区）</option>
            <option value="custom">自定义顺序（只用我列出的线路标签）</option>
            <option value="off">关闭（只直连 / 出站代理）</option>
          </select>
        </div>
        <div class="field" id="rl-custom-box" style="margin-bottom:0">
          <label>线路标签（按优先顺序，逗号分隔，最多 8 个；auto = 按机房自动选最近地区；第一条取 2 个 IP，其余各取 1 个，最多用 3 条）</label>
          <input type="text" id="rl-custom" placeholder="auto" autocomplete="off">
          <div class="hint" id="rl-tags"></div>
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>备用线路表（所有代理共用）</h3>
        <p class="hint" style="margin-top:0">每行「标签 域名[:端口] [txt]」，# 开头是注释。标签 <code>auto</code> 保留给自动选择；<code>HK / US / SG / JP / KR / DE / SE / NL / FI / GB</code> 是自动选择会用到的地区标签。末尾写 <code>txt</code> = 解析时先查该域名的 TXT 记录（TXT 里放 IP 列表时用），默认只查 A 记录。保存后会立即下发给所有代理。</p>
        <div class="field" style="margin-bottom:0"><textarea id="rt-text" rows="18" spellcheck="false" autocomplete="off" style="font-family:ui-monospace,Consolas,monospace;font-size:12.5px"></textarea></div>
        <div class="inrow" style="margin-top:12px">
          <button class="btn primary" id="rt-save" onclick="saveAltRoutes()">保存并下发给全部代理</button>
          <button class="btn" onclick="defaultAltRoutes()">载入默认表</button>
        </div>
      </div>
    </section>

    
    <section class="view" data-view="account" data-title="面板设置" data-sub="代理（域名、节点路径、密钥、UUID、启停）、面板路径（PATH）、管理用户名与密码">
      <div class="card">
        <h3><span class="tick"></span>代理</h3>
        <p class="hint" style="margin-top:0;margin-bottom:12px">订阅里的节点指向哪里：可以添加多个代理，订阅会<b>合并所有启用的代理</b>（每个代理各出一套节点，多个时节点名带「·代理名」后缀，总数仍受 500 的上限，平均分给各代理）。点列表里的代理进行编辑。每个代理填写代理脚本（Hopline-proxy.js）所在的域名、它的环境变量 PATH（节点路径）和 NODE_KEY（密钥）。面板用密钥签名后通过 HTTPS 联系代理：<b>UUID 由面板生成并下发给代理</b>（存在代理的 NODE_KV 里），不需要手工填写。密钥只写入、不回显；留空保持不变。</p>
        <div class="note-box" id="px-conn" style="margin:0 0 12px">读取中…</div>
        <div id="px-list"></div>
        <div class="inrow" style="margin:0 0 14px"><button class="btn sm" onclick="newProxyEntry()">＋ 添加代理</button><button class="btn sm" onclick="syncAllProxies()">同步全部代理</button></div>
        <div class="field"><label>名称（可选）</label><input type="text" id="a-pname" placeholder="代理 1" autocomplete="off"></div>
        <div class="field"><label>代理域名（节点 SNI / Host，如 node.example.com；须是代理 Worker 的自定义域名）</label><input type="text" id="a-host" placeholder="node.example.com" autocomplete="off"></div>
        <div class="field"><label>节点路径（须与代理脚本的环境变量 PATH 相同）</label><input type="text" id="a-nodepath" placeholder="mynode" autocomplete="off"></div>
        <div class="field"><label>密钥（须与代理脚本的环境变量 NODE_KEY 相同，24–256 位可见字符）</label>
          <div class="inrow">
            <input type="password" id="a-key" placeholder="" autocomplete="new-password">
            <button class="btn sm" onclick="genKey()">生成密钥</button>
            <button class="btn sm" onclick="copyKey()">复制</button>
          </div>
          <div class="hint" id="a-keyhint"></div>
        </div>
        <div class="field"><label>UUID（可留空，连接时自动生成；已有则显示在这里）</label>
          <div class="inrow">
            <input type="text" id="a-uuid" placeholder="连接并同步后自动生成" autocomplete="off">
            <button class="btn sm" onclick="genUuid()">生成</button>
          </div>
        </div>
        <div class="field" style="margin-bottom:0"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="a-penabled" checked> 启用（取消勾选 = 订阅里不再下发该代理的节点，并通知代理对外只显示 Hello World）</label></div>
        <div class="inrow" style="margin-top:12px">
          <button class="btn primary" id="px-connect" onclick="saveProxyEntry()">保存并连接</button>
          <button class="btn" id="px-sync" onclick="syncProxyEntry()">连接并同步</button>
          <button class="btn" id="px-rotate" onclick="rotateProxyUuid()">更换 UUID</button>
          <button class="btn danger" id="px-del" onclick="deleteProxyEntry()">删除</button>
        </div>
        <p class="hint" style="margin-top:10px">XHTTP 与面板联系代理都要求代理使用自定义域名（Cloudflare 面板 → Workers 与 Pages → 代理 Worker → Domains &amp; Routes 添加）；面板与代理在同一个 Cloudflare 区域（zone）时请把代理设为 Custom Domain。代理需要绑定一个 KV（变量名 NODE_KV）来保存 UUID。「更换 UUID」后旧 UUID 在代理上还会保留 10 分钟，已有客户端更新订阅即可。最多 8 个代理。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>基础配置</h3>
        <div class="field"><label>面板路径（环境变量 PATH 设置，面板中只读）</label><input type="text" id="a-path" autocomplete="off"><div class="hint">面板与订阅共用此路径（与代理的节点路径互相独立）；修改请到面板 Worker 的环境变量 PATH，修改后订阅地址随之改变，客户端需重新添加订阅。</div></div>
        <div class="field"><label>自定义订阅路径（只填一段，如 mysub → /mysub/sub；留空则使用 面板路径/sub）</label><input type="text" id="a-suburl" placeholder="mysub" autocomplete="off"></div>
        <div class="field"><label>管理用户名（登录时需要；留空为 admin，区分大小写）</label><input type="text" id="a-adminuser" placeholder="admin" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div class="field" style="margin-bottom:0"><label>管理密码（留空保持不变；未设置时面板禁用）</label><input type="password" id="a-admin" placeholder="设置后访问面板需登录" autocomplete="new-password"></div>
        <p class="hint" style="margin-top:10px">未绑定 KV（绑定变量名 CONFIG_KV）时无法保存面板配置，只有环境变量生效。自定义域名访问面板需先在 Cloudflare 面板 → Workers 与 Pages → 面板 Worker → Domains &amp; Routes 添加。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>备份与恢复</h3>
        <p class="hint" style="margin-top:0;margin-bottom:12px">以 JSON 格式导出全部面板设置（含协议、优选、筛选），可保存到本地或迁移到其他部署；导入后请点右下角「保存全部」生效。<b>备份文件不含代理的密钥与 UUID（它们保存在面板的代理列表里，不在备份范围）；管理密码也不会导出。</b></p>
        <div class="inrow">
          <button class="btn" onclick="exportConfig()">导出配置</button>
          <button class="btn" onclick="$('importFile').click()">导入配置</button>
          <input type="file" id="importFile" accept=".json,application/json" style="display:none" onchange="importConfig(this)">
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>登录会话</h3>
        <p class="hint" style="margin-top:0;margin-bottom:12px">登录状态保存在浏览器 Cookie 中：使用面板时自动顺延，24 小时未使用即失效；自登录起最长 7 天，到期需重新登录。退出只清除当前浏览器的登录状态；要让所有已签发的登录状态立即失效，请修改管理密码或管理用户名。</p>
        <button class="btn" onclick="logout()">退出登录</button>
      </div>
      <div class="card">
        <h3><span class="tick"></span>运行信息</h3>
        <div class="kv"><span class="k">面板版本</span><span class="v" id="aVer">—</span></div>
        <div class="kv"><span class="k">KV 持久化</span><span class="v" id="aKv">—</span></div>
      </div>
      <div class="danger-zone">
        <h3 style="margin-bottom:8px;color:var(--err)">危险操作</h3>
        <p style="font-size:13px;color:var(--dim);margin-bottom:12px">重置将清空 KV 中保存的全部面板配置，面板还原为初始部署状态（环境变量与「代理」列表不受影响），不可恢复。</p>
        <button class="btn danger" onclick="resetAll()">重置全部数据</button>
      </div>
    </section>

    
    <section class="view" data-view="about" data-title="关于项目" data-sub="Hopline — 代理订阅面板（独立界面 + 独立实现）">
      <div class="card">
        <h3><span class="tick"></span>调用接口</h3>
        <div class="tbl-wrap"><table>
          <colgroup><col style="width:40%"><col style="width:60%"></colgroup>
          <thead><tr><th>用途</th><th>接口</th></tr></thead>
          <tbody>
            <tr><td>HostMonit 优选（分运营商实测）</td><td class="mono">api.hostmonit.com/get_optimization_ip</td></tr>
            <tr><td>uouin 分线路优选（对方网站内部接口）</td><td class="mono">api.uouin.com/index.php/index/Cloudflare</td></tr>
            <tr><td>微测网优选（对方公开页面）</td><td class="mono">www.wetest.vip/page/cloudflare/address_v4.html · address_v6.html</td></tr>
            <tr><td>自定义优选 API 1 / 2、优选域名测试</td><td>你填写的地址 / 域名</td></tr>
            <tr><td>DoH 解析（优选域名）</td><td class="mono">cloudflare-dns.com / dns.google / dns.alidns.com / doh.pub</td></tr>
            <tr><td>版本更新检测</td><td class="mono">raw.githubusercontent.com/iv7777/Hopline/...</td></tr>
            <tr><td>面板二维码库（浏览器加载）</td><td class="mono">cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js（SRI 校验）</td></tr>
            <tr><td>订阅内的规则集与图标（由客户端下载）</td><td class="mono">cdn.jsdelivr.net（MetaCubeX、blackmatrix7）/ github.com（666OS、DustinWin）/ raw.githubusercontent.com（AWAvenue）/ rule.kelee.one</td></tr>
          </tbody>
        </table></div>
      </div>
    </section>
  </div>
</div>
</div>

<div class="fbar">
  <span class="saved-at" id="savedAt">尚未保存</span>
  <button class="btn danger" id="resetBtn" onclick="resetAll()">重置</button>
  <button class="btn primary" id="saveBtn" onclick="saveAll()"><span class="dirty-dot"></span>保存全部</button>
</div>
<div class="modal" id="nodeQr" onclick="if (event.target === this) closeNodeQr()">
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="nodeQrName">
    <div class="modal-head"><b id="nodeQrName"></b><button class="icon-btn" title="关闭" onclick="closeNodeQr()"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="qrbox" id="nodeQrImg"></div>
    <pre class="code" id="nodeQrLink"></pre>
    <button class="btn primary" style="width:100%;margin-top:10px" onclick="copyText($('nodeQrLink').textContent)">复制链接</button>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>

var APIPATH = location.pathname.replace(/\/+$/, '');
var CFG = null;
var toastTimer = null;
function $(id){ return document.getElementById(id); }
function api(p, opts){
  return fetch(APIPATH + '/api/' + p, opts).then(function(r){ return r.json(); });
}
function toast(t, ty){
  var el = $('toast');
  el.textContent = t;
  el.className = 'toast show ' + (ty || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.className = 'toast'; }, 2600);
}
function copyText(t){
  var done = false;
  function fin(ok2){
    if (done) return; done = true;
    toast(ok2 ? '已复制' : '复制失败，请手动复制', ok2 ? 'ok' : 'err');
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var p = null;
    try { p = navigator.clipboard.writeText(t); } catch (e) { fin(fallbackCopy(t)); return; }
    if (p && typeof p.then === 'function') {
      p.then(function(){ fin(true); }, function(){ fin(fallbackCopy(t)); });
      setTimeout(function(){ fin(fallbackCopy(t)); }, 600); 
    } else { fin(true); }
  } else {
    fin(fallbackCopy(t));
  }
}
function fallbackCopy(t){
  var ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  var ok2 = false;
  try { ok2 = document.execCommand('copy'); } catch (e) { ok2 = false; }
  document.body.removeChild(ta);
  return ok2;
}
function copySub(){ copyText($('subUrl').value || makeSub()); }
function markDirty(){
  $('saveBtn').classList.add('dirty');
  $('savedAt').textContent = '有未保存的修改';
}


var NAV = [
  { id:'dashboard', name:'仪表盘', icon:'<path d="M4 4h7v7H4zM13 4h7v4h-7zM4 13h7v7H4zM13 11h7v9h-7z"/>' },
  { id:'nodes', name:'节点配置', icon:'<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5"/>' },
  { id:'optimizer', name:'优选配置', icon:'<path d="M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 8v4l2.5 2.5M3 3l3 3"/>' },
  { id:'proxy', name:'代理设置', icon:'<path d="M4 7h16M4 12h16M4 17h16M8 5v4M15 10v4M10 15v4"/>' },
  { id:'account', name:'面板设置', icon:'<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-3.5 3.6-6 8-6s8 2.5 8 6"/>' },
  { id:'about', name:'关于项目', icon:'<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01"/>' }
];
var TITLES = { dashboard:'仪表盘', nodes:'节点配置', optimizer:'优选配置', proxy:'代理设置', account:'面板设置', about:'关于项目' };
function buildNav(){
  var html = '';
  NAV.forEach(function(n){
    html += '<button class="nav-item" data-v="' + n.id + '" onclick="switchView(\'' + n.id + '\')"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + n.icon + '</svg>' + n.name + '</button>';
  });
  $('nav').innerHTML = html;
}
function switchView(id){
  var fb = document.querySelector('.fbar');
  if (fb) fb.style.display = (id === 'proxy') ? 'none' : '';   
  document.querySelectorAll('.nav-item').forEach(function(b){
    b.classList.toggle('on', b.getAttribute('data-v') === id);
  });
  document.querySelectorAll('.view').forEach(function(x){
    var on = x.getAttribute('data-view') === id;
    x.classList.toggle('on', on);
    if (on){
      $('pageTitle').textContent = x.getAttribute('data-title') || '';
      $('pageSub').textContent = $('pageSub').title = x.getAttribute('data-sub') || '';
    }
  });
  $('sidebar').classList.remove('open');
}
$('hamb').addEventListener('click', function(){ $('sidebar').classList.toggle('open'); });


var THEME_MODES = ['auto', 'light', 'dark'];
var THEME_NAMES = { auto: '跟随系统', light: '日间模式', dark: '夜间模式' };
var THEME_ICONS = {
  auto: 'M3 5h18v11H3zM8 20h8M12 16v4',
  light: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4',
  dark: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'
};
var systemLightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
function systemIsLight(){ return !!(systemLightQuery && systemLightQuery.matches); }
function storedTheme(){
  var t = 'auto';
  try { t = localStorage.getItem('tp_theme') || 'auto'; } catch(e) {}
  return THEME_MODES.indexOf(t) < 0 ? 'auto' : t;
}
function resolveTheme(t){ return t === 'auto' ? (systemIsLight() ? 'light' : 'dark') : t; }
function applyTheme(){
  var mode = storedTheme();
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  var p = document.getElementById('themeIcon');
  if (p) p.setAttribute('d', THEME_ICONS[mode]);
  $('themeBtn').title = '当前：' + THEME_NAMES[mode] + '（点击切换：跟随系统 → 日间 → 夜间）';
}
function setTheme(t){
  try { localStorage.setItem('tp_theme', t); } catch(e) {}
  applyTheme();
  toast('已切换为' + THEME_NAMES[t], 'ok');
}
$('themeBtn').addEventListener('click', function(){
  setTheme(THEME_MODES[(THEME_MODES.indexOf(storedTheme()) + 1) % THEME_MODES.length]);
});

if (systemLightQuery) {
  var onSystemTheme = function(){ if (storedTheme() === 'auto') applyTheme(); };
  if (systemLightQuery.addEventListener) systemLightQuery.addEventListener('change', onSystemTheme);
  else if (systemLightQuery.addListener) systemLightQuery.addListener(onSystemTheme);
}
applyTheme();


var topVerText = 'v—';
function legacyCopy(t){
  try {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok2 = false;
    try { ok2 = document.execCommand('copy'); } catch (e) { ok2 = false; }
    document.body.removeChild(ta);
    return ok2;
  } catch (e) { return false; }
}
function copyClipboard(t){
  return new Promise(function(ok){
    var done = false;
    function finish(v){ if (done) return; done = true; ok(v); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        var p = null;
        try { p = navigator.clipboard.writeText(t); } catch (e) { finish(legacyCopy(t)); return; }
        if (p && typeof p.then === 'function') {
          p.then(function(){ finish(true); }, function(){ finish(legacyCopy(t)); });
          setTimeout(function(){ finish(legacyCopy(t)); }, 600); 
        } else { finish(true); }
      } else {
        finish(legacyCopy(t));
      }
    } catch (e) { finish(legacyCopy(t)); }
  });
}
function checkUpdate(){
  var sv = $('sideVer');
  if (sv.classList.contains('checking')) return;
  sv.classList.add('checking');
  sv.textContent = '检测中…';
  api('update').then(function(r){
    sv.classList.remove('checking');
    if (!r || !r.ok || !r.data) { sv.textContent = topVerText; toast('检测更新失败，请稍后重试', 'err'); return; }
    var d = r.data;
    topVerText = 'v' + d.current;
    sv.textContent = topVerText;
    if (d.hasUpdate && d.code) {
      sv.classList.add('has-update');
      copyClipboard(d.code).then(function(copied){
        toast(copied ? '检测到更新（v' + d.latest + '），已复制最新代码到剪贴板' : '检测到更新（v' + d.latest + '），复制失败，请前往仓库获取', copied ? 'ok' : 'err');
      });
    } else if (d.hasUpdate) {
      toast('检测到更新（v' + d.latest + '），但未能获取代码', 'err');
    } else if (d.latest) {
      sv.classList.remove('has-update');
      toast('已是最新版本（v' + d.current + '）', 'ok');
    } else {
      toast('检测更新失败：' + (d.error || '仓库暂不可达'), 'err');
    }
  }).catch(function(){
    sv.classList.remove('checking');
    sv.textContent = topVerText;
    toast('检测更新失败，请稍后重试', 'err');
  });
}


function loadAll(){
  if (/\.workers\.dev$/i.test(location.hostname)) $('wdwarn').style.display = 'block';
  api('status').then(function(r){
    if (r && r.ok) renderStatus(r.data);
  }).catch(function(){});
  checkProxy();
  loadProxySettings();
  api('config').then(function(r){
    if (r && r.ok){
      CFG = r.data;
      fillForm();
      renderAll();
      makeSub(false);
      setConn(true);
      if (CFG.kvError) toast(CFG.kvError + '；保存已被禁用', 'err');
      else toast('配置已加载', 'ok');
    } else if (r && r.status === 403) {
      location.href = '/login?next=' + encodeURIComponent(APIPATH);
    } else {
      setConn(false);
      toast('无法连接服务器', 'err');
    }
  }).catch(function(){
    setConn(false);
    toast('无法连接服务器', 'err');
  });
}
function setConn(ok){
  var p = $('connPill');
  p.className = 'pill ' + (ok ? '' : 'off');
  $('connText').textContent = ok ? '运行中' : '无法连接';
}

var PROXY_FIELDS = { 'edgeIP': 's-proxyIP', 'hop': 's-outbound', 'hopMode': 's-outmode', 'altMode': 'rl-mode', 'altCustom': 'rl-custom' };
var PROXY_DEFAULTS = { edgeIP: '', hop: '', hopMode: '', altMode: 'auto', altCustom: '' };
var PXSEL = '';   
function onProxyWhich(){ PXSEL = $('px-which').value; renderProxySettings(); }
function proxyNote(text, kind){
  var n = $('px-note');
  n.textContent = text;
  n.style.borderColor = kind === 'err' ? 'var(--err)' : '';
}
function setProxyFormEnabled(on){
  Object.keys(PROXY_FIELDS).forEach(function(k){ var el = $(PROXY_FIELDS[k]); if (el) el.disabled = !on; });
  $('px-save').disabled = !on;
  $('px-reset').disabled = !on;
}
function clearProxyErrors(){
  Object.keys(PROXY_FIELDS).forEach(function(k){ clearFieldError($(PROXY_FIELDS[k])); });
  clearFieldError($('rt-text'));
}
function showProxyErrors(errors){
  clearProxyErrors();
  var unplaced = [], first = null;
  (errors || []).forEach(function(e){
    var el = PROXY_FIELDS[e.field] ? $(PROXY_FIELDS[e.field]) : (e.field === 'text' ? $('rt-text') : null);
    if (!el){ unplaced.push(e.msg); return; }
    el.classList.add('invalid');
    if (el._errTip) el._errTip.textContent += '；' + e.msg;
    else el._errTip = attachMsg(el, 'field-err', e.msg);
    if (!first) first = el;
  });
  if (first){ try { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus({ preventScroll: true }); } catch (e) {} }
  return unplaced;
}
function onRelayMode(){
  $('rl-custom-box').style.display = ($('rl-mode').value === 'custom') ? '' : 'none';
}
var ALT_TAGS = [], ALT_DEFAULT_TEXT = '';
function pxCurrent(){
  var cur = null;
  PXLIST.forEach(function(p){ if (p.id === PXSEL) cur = p; });
  return cur;
}

function renderProxySettings(){
  var p = pxCurrent();
  clearProxyErrors();
  if (!p){
    setProxyFormEnabled(false);
    Object.keys(PROXY_FIELDS).forEach(function(k){ $(PROXY_FIELDS[k]).value = PROXY_DEFAULTS[k]; });
    onRelayMode();
    proxyNote('还没有代理：先到「面板设置 → 代理」添加一个。', 'err');
    return;
  }
  setProxyFormEnabled(true);
  Object.keys(PROXY_FIELDS).forEach(function(k){ $(PROXY_FIELDS[k]).value = p[k] != null ? p[k] : PROXY_DEFAULTS[k]; });
  onRelayMode();
  updateProxyNote(p);
  $('rl-tags').textContent = ALT_TAGS.length ? '线路表里现有的标签：' + ALT_TAGS.join('、') + '（表里没有的标签会被跳过）' : '线路表是空的：请先在下方填写备用线路表';
}
function updateProxyNote(p){
  var st = PXSTAT[p.id];
  proxyNote('正在修改「' + p.name + '」（' + p.host + '）的设置。' + (st ? (st.up ? (st.inSync ? '代理上的状态与面板一致。' : '代理上的状态与这里不一致：保存并下发，或到「面板设置 → 代理」点「连接并同步」。') : '当前连不上代理：' + (st.error || '') + '；仍可先保存，之后点「连接并同步」。') : ''), st && st.up && !st.inSync ? 'err' : '');
}
function collectProxy(){
  var out = {};
  Object.keys(PROXY_FIELDS).forEach(function(k){ out[k] = $(PROXY_FIELDS[k]).value; });
  return out;
}
function loadProxySettings(){
  proxyNote('读取中…');
  setProxyFormEnabled(false);
  api('alt-routes').then(function(r){
    if (r && r.ok && r.data){
      ALT_DEFAULT_TEXT = r.data.defaultText || '';
      ALT_TAGS = r.data.tags || [];
      $('rt-text').value = r.data.text;
      $('rt-save').disabled = false;
      if (r.data.error){ $('rt-save').disabled = true; toast('备用线路表读取失败（KV 暂时无法读取），暂时不能保存', 'err'); }
    }
  }).catch(function(){}).then(function(){ return loadProxyEntry(undefined, true); });
}
function proxySaveDone(r, okMsg){
  var d = r.data || {};
  var t = (d.sync ? pxSyncText(d.sync) : '') || okMsg;
  var bad = d.sync && !d.sync.ok;
  toast(bad ? t : okMsg + (d.sync ? '：' + t : ''), bad ? 'err' : 'ok');
  loadProxyEntry(d.proxy ? d.proxy.id : undefined, true).then(pxRefreshAll);
}
function saveProxySettings(){
  var p = pxCurrent();
  if (!p) return;
  var btn = $('px-save');
  btn.disabled = true;
  clearProxyErrors();
  api('proxies/' + p.id, { method: 'POST', headers: JSON_H, body: JSON.stringify(collectProxy()) })
    .then(function(r){
      if (r && r.ok && r.data) proxySaveDone(r, '已保存');
      else {
        var unplaced = showProxyErrors(r && r.errors);
        toast((unplaced.length ? unplaced.join('；') : (r && r.msg)) || '保存失败', 'err');
      }
    })
    .catch(function(){ toast('保存失败：无法连接服务器', 'err'); })
    .then(function(){ btn.disabled = false; });
}
function resetProxySettings(){
  var p = pxCurrent();
  if (!p || !confirm('确定恢复默认？落地 IP、出站代理清空，出站方式与备用线路回到默认（自动选择）。')) return;
  api('proxies/' + p.id, { method: 'POST', headers: JSON_H, body: JSON.stringify(PROXY_DEFAULTS) }).then(function(r){
    if (r && r.ok && r.data) proxySaveDone(r, '已恢复默认');
    else toast((r && r.msg) || '恢复失败', 'err');
  }).catch(function(){ toast('恢复失败：无法连接服务器', 'err'); });
}
function defaultAltRoutes(){
  if (ALT_DEFAULT_TEXT) $('rt-text').value = ALT_DEFAULT_TEXT;
}
function saveAltRoutes(){
  var btn = $('rt-save');
  btn.disabled = true;
  clearFieldError($('rt-text'));
  api('alt-routes', { method: 'POST', headers: JSON_H, body: JSON.stringify({ text: $('rt-text').value }) }).then(function(r){
    if (!(r && r.ok)){
      var unplaced = showProxyErrors(r && r.errors);
      toast((unplaced.length ? unplaced.join('；') : (r && r.msg)) || '保存失败', 'err');
      return;
    }
    ALT_TAGS = (r.data && r.data.tags) || [];
    return syncAllProxies('线路表已保存');
  }).catch(function(){ toast('保存失败：无法连接服务器', 'err'); }).then(function(){ btn.disabled = false; });
}

function syncAllProxies(prefix){
  return api('proxy-sync-all', { method: 'POST' }).then(function(r){
    if (!(r && r.ok && r.data)){ toast((r && r.msg) || '同步失败', 'err'); return; }
    var res = r.data.results || [], bad = res.filter(function(x){ return !x.ok; });
    if (!res.length) toast((prefix ? prefix + '，' : '') + '没有代理可同步', '');
    else if (!bad.length) toast((prefix ? prefix + '，' : '') + '已同步 ' + res.length + ' 个代理', 'ok');
    else toast((prefix ? prefix + '，' : '') + bad.map(function(x){ return x.name + '：' + (x.error || '失败'); }).join('；'), 'err');
    loadProxyEntry(undefined, true).then(pxRefreshAll);
  }).catch(function(){ toast('同步失败：无法连接服务器', 'err'); });
}


function proxySummary(p){
  var a = [];
  var m = p && p.hop ? p.hop.match(/^([A-Za-z0-9]+):\/\//) : null;
  a.push('出站代理：' + (p && p.hop ? (m ? m[1].toLowerCase() : 'socks5') : '无'));
  if (p && p.hopMode) a.push('出站方式：' + p.hopMode);
  a.push('落地 IP：' + (p && p.edgeIP ? '已设置' : '无'));
  a.push('备用线路：' + (p && p.altMode === 'off' ? '关闭' : (p && p.altMode === 'custom' ? '自定义' : '自动')));
  return a.join(' · ');
}
var PXSTAT = {};   

function pxStatusInfo(d){
  if (!d.up) return { text: '无法连接：' + (d.error || ''), ok: false };
  var tags = [];
  if (!d.provisioned) tags.push('尚未下发 UUID');
  else if (!d.inSync) tags.push('与面板的设置不一致，点「连接并同步」');
  if (!d.enabled) tags.push('代理已停用');
  if (!d.storage) tags.push('代理未绑定 NODE_KV');
  if (!d.ok) tags.push('配置有问题：' + (d.problems || []).join(' '));
  return { text: '在线 · v' + (d.version || '?') + (tags.length ? '（' + tags.join('，') + '）' : ''), ok: !tags.length };
}
function checkProxy(){
  var v = $('stProxy'), h = $('stProxyHint'), l = $('stProxyList');
  v.textContent = '检测中…'; v.className = 'v'; h.textContent = ''; l.textContent = '';
  api('proxy-status?all=1').then(function(r){
    var list = r && r.ok && r.data && r.data.proxies;
    if (!list){ v.textContent = '检测失败'; v.className = 'v bad'; return; }
    PXSTAT = {};
    list.forEach(function(d){ PXSTAT[d.id] = d; });
    pxApplyStatus();
    var cur = pxCurrent();
    if (cur) updateProxyNote(cur);
    if (!list.length){
      v.textContent = '未添加';
      h.textContent = '到「面板设置 → 代理」添加代理（域名、节点路径、密钥），面板会自动生成 UUID 并下发';
      return;
    }
    var good = 0;
    list.forEach(function(d){
      var info = pxStatusInfo(d);
      if (info.ok) good++;
      var line = document.createElement('div');
      line.className = 'hint';
      line.style.margin = '6px 0 0';
      var rec = null;
      PXLIST.forEach(function(p){ if (p.id === d.id) rec = p; });
      line.textContent = d.name + (d.enabledHere ? '' : '（面板已停用）') + '：' + info.text + (d.up && d.ok && rec ? ' · ' + proxySummary(rec) : '');
      l.appendChild(line);
    });
    v.textContent = list.length === 1 ? (good ? '在线' : '有问题') : (good + ' / ' + list.length + ' 正常');
    v.className = 'v ' + (good === list.length ? 'ok' : 'bad');
  }).catch(function(){ v.textContent = '检测失败'; v.className = 'v bad'; });
}
function renderStatus(d){
  $('stEntry').textContent = location.origin + '/' + (d.path || '');
  var wd = !!(d.workersDev) || /\.workers\.dev$/i.test(location.hostname);
  $('wdwarn').style.display = wd ? 'block' : 'none';
  $('subHint').textContent = wd
    ? '当前为 *.workers.dev 域名：Cloudflare 可能限制该域名直连，若客户端更新订阅失败（提示无效订阅），请在客户端开启系统代理或「更新订阅使用代理」后重试；节点连接不受影响（直连优选 IP）。'
    : '';
  var kv = d.kv;
  var kvTxt = kv ? '已绑定（配置持久化）' : '未绑定（无法保存配置，仅环境变量生效）';
  $('stKv').textContent = kvTxt;
  $('stKv').className = 'v ' + (kv ? 'ok' : 'bad');
  $('aKv').textContent = kvTxt;
  $('aKv').className = 'v ' + (kv ? 'ok' : 'bad');
  var v = d.version || '—';
  $('sideVer').textContent = 'v' + v;
  topVerText = 'v' + v;
  $('aVer').textContent = v;
}

function renderEndpoint(){
  var miss = (CFG && CFG.endpointMissing) || [];
  $('epwarn').style.display = miss.length ? 'block' : 'none';
  $('epMissing').textContent = miss.join('、');
}
function protoText(){
  if (!CFG) return '—';
  var a = [];
  if (CFG['enableVl' + 'ess'] !== false) a.push('VLESS');
  if (CFG.enableXhttp) a.push('XHTTP');
  return a.length ? a.join(' / ') : '未启用';
}
function renderAll(){
  $('stProto').textContent = protoText();
  renderEndpoint();
  rerenderIpTest();
}

var SCHEMA = /*@HOPLINE_SCHEMA@*/null || [];
var sharedCheck = /*@HOPLINE_CHECK@*/null;
var SCHEMA_BY_KEY = {};
SCHEMA.forEach(function(d){ SCHEMA_BY_KEY[d.key] = d; });
function checkValue(def, v){
  
  if (typeof sharedCheck !== 'function') return { value: v };
  try { return sharedCheck(def, v); } catch (e) { return { value: v }; }
}
function getPath(o, key){
  var ks = key.split('.');
  for (var i = 0; i < ks.length; i++){ if (o == null || typeof o !== 'object') return undefined; o = o[ks[i]]; }
  return o;
}
function setPath(o, key, v){
  var ks = key.split('.');
  for (var i = 0; i < ks.length - 1; i++){ if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
  o[ks[ks.length - 1]] = v;
}
function schemaEls(d){
  var ids = [];
  if (d.el) ids.push(d.el);
  if (d.els) for (var k in d.els) ids.push(d.els[k]);
  return ids;
}
function lockedEnv(key){ return (CFG && CFG.envLocked && CFG.envLocked[key]) || ''; }

function msgHost(el){ return el.closest('.field') || el.closest('.proto-row') || el.closest('.filter-group') || el.closest('.filter-region') || el; }
function attachMsg(el, cls, text){
  var host = msgHost(el);
  var div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  if (host.classList.contains('field')) host.appendChild(div);
  else host.parentNode.insertBefore(div, host.nextSibling);
  return div;
}

function fillField(d, v){
  if (d.custom) return;
  if (d.type === 'list'){
    var arr = Array.isArray(v) ? v : [];
    for (var k in d.els){ var e = $(d.els[k]); if (e) e.checked = arr.indexOf(k) >= 0; }
    return;
  }
  var el = $(d.el);
  if (!el) return;
  if (d.type === 'bool'){
    if (el.tagName === 'SELECT') el.value = v ? '1' : '0'; else el.checked = !!v;
    return;
  }
  if (d.type === 'secret'){
    
    if (el.getAttribute('data-ph') == null) el.setAttribute('data-ph', el.placeholder || '');
    el.value = '';
    el.placeholder = (CFG && CFG[d.key + 'Set']) ? '已设置（留空保持不变）' : el.getAttribute('data-ph');
    return;
  }
  el.value = v == null ? '' : v;
}
function readField(d){
  if (d.type === 'list'){
    var out = [];
    for (var k in d.els){ var e = $(d.els[k]); if (e && e.checked) out.push(k); }
    return out;
  }
  var el = $(d.el);
  if (!el) return undefined;
  if (d.type === 'bool') return el.tagName === 'SELECT' ? el.value === '1' : el.checked;
  return el.value;   
}

function applyEnvLock(d){
  var name = lockedEnv(d.key);
  schemaEls(d).forEach(function(id){
    var el = $(id);
    if (!el) return;
    el.disabled = !!name;
    if (el._lockTip){ el._lockTip.parentNode.removeChild(el._lockTip); el._lockTip = null; }
    if (name){
      el._lockTip = attachMsg(el, 'hint env-lock', '由环境变量 ' + name + ' 设置，面板中只读；如需修改请到 Worker 环境变量。');
      if (d.type === 'secret') el.placeholder = '已由环境变量 ' + name + ' 设置';
    }
  });
}
function fillForm(){
  if (!CFG) return;
  clearFieldErrors();
  SCHEMA.forEach(function(d){ fillField(d, getPath(CFG, d.key)); applyEnvLock(d); });
  updatePdCount();
}
function collectForm(){
  if (!CFG) return null;
  var body = {};
  SCHEMA.forEach(function(d){
    if (d.custom || lockedEnv(d.key)) return;
    if (!d.el && !d.els) return;
    var v = readField(d);
    if (v !== undefined) setPath(body, d.key, v);
  });
  return body;
}

function validateForm(body){
  var errors = [];
  SCHEMA.forEach(function(d){
    var v = getPath(body, d.key);
    if (v === undefined || (d.type === 'secret' && v === '')) return;
    var r = checkValue(d, v);
    if (r.error) errors.push({ field: d.key, label: d.label, msg: r.error });
    else setPath(body, d.key, r.value);
  });
  return errors;
}


function fieldEl(key){
  var d = SCHEMA_BY_KEY[key];
  if (!d) return null;
  var id = d.el || (d.els ? d.els[Object.keys(d.els)[0]] : '');
  return id ? $(id) : null;
}
function clearFieldError(el){
  if (!el) return;
  el.classList.remove('invalid');
  if (el._errTip){ el._errTip.parentNode.removeChild(el._errTip); el._errTip = null; }
}
function clearFieldErrors(){
  document.querySelectorAll('.invalid').forEach(clearFieldError);
}
function showFieldErrors(errors){
  clearFieldErrors();
  var first = null, unplaced = [];
  errors.forEach(function(e){
    var el = fieldEl(e.field);
    if (!el){ unplaced.push((e.label ? e.label + '：' : '') + e.msg); return; }
    el.classList.add('invalid');
    if (el._errTip) el._errTip.textContent += '；' + e.msg;
    else el._errTip = attachMsg(el, 'field-err', e.msg);
    if (!first) first = el;
  });
  if (first){
    var view = first.closest('.view');
    if (view) switchView(view.getAttribute('data-view'));
    try { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus({ preventScroll: true }); } catch (e) {}
  }
  return unplaced;
}


function currentPanelPath(){ return decodeURIComponent(APIPATH.replace(/^\/+/, '')); }
function saveAll(){
  if (!CFG){ toast('配置尚未加载', 'err'); return; }
  var body = collectForm();
  var errors = validateForm(body);
  if (errors.length){
    showFieldErrors(errors);
    toast('有 ' + errors.length + ' 项配置需要修正', 'err');
    return;
  }
  var btn = $('saveBtn');
  btn.disabled = true;
  api('config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){
      if (r && r.ok){
        var oldPath = currentPanelPath();
        CFG = r.data;
        btn.classList.remove('dirty');
        
        
        if (CFG.panelPath && CFG.panelPath !== oldPath){
          $('savedAt').textContent = '已保存，正在跳转到新的面板路径…';
          toast('已保存：面板路径已变更，正在跳转…', 'ok');
          setTimeout(function(){ location.replace('/' + encodeURIComponent(CFG.panelPath) + location.search); }, 900);
          return;
        }
        fillForm();
        renderAll();
        makeSub(false);
        $('savedAt').textContent = '已保存：' + new Date().toLocaleTimeString();
        toast(r.msg || '已保存', 'ok');
      } else {
        var unplaced = (r && r.errors) ? showFieldErrors(r.errors) : [];
        toast((unplaced.length ? unplaced.join('；') : (r && r.msg)) || '保存失败', 'err');
      }
    })
    .catch(function(){ toast('保存失败：无法连接服务器', 'err'); })
    .then(function(){ btn.disabled = false; });
}
function logout(){
  api('logout', { method: 'POST' })
    .then(function(){ location.href = '/login?next=' + encodeURIComponent(APIPATH); })
    .catch(function(){ toast('退出失败：无法连接服务器', 'err'); });
}
function resetAll(){
  if (!confirm('确定重置？将清空 KV 中保存的全部面板配置，面板还原为初始部署状态。此操作不可恢复！')) return;
  var btn = $('resetBtn');
  btn.disabled = true;
  api('reset', { method: 'POST' })
    .then(function(r){
      if (r && r.ok){ toast(r.msg || '已重置', 'ok'); setTimeout(function(){ location.reload(); }, 900); }
      else toast((r && r.msg) || '重置失败', 'err');
    })
    .catch(function(){ toast('重置失败：无法连接服务器', 'err'); })
    .then(function(){ btn.disabled = false; });
}
function randUuid(){
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 3 | 8);
    return v.toString(16);
  });
}
function genUuid(){
  $('a-uuid').value = randUuid();
  toast('已生成 UUID：点「保存并连接」后会下发给代理', 'ok');
}
function genKey(){
  var b = new Uint8Array(24), t = '';
  (window.crypto || window.msCrypto).getRandomValues(b);
  for (var i = 0; i < b.length; i++) t += (b[i] + 256).toString(16).slice(1);
  var k = $('a-key');
  k.type = 'text';
  k.value = t;
  toast('已生成密钥：请同时填入代理脚本的环境变量 NODE_KEY（点「复制」）', 'ok');
}
function copyKey(){
  var v = $('a-key').value;
  if (!v){ toast('密钥为空（已保存的密钥不回显，需要时请重新生成并更新代理的 NODE_KEY）', 'err'); return; }
  copyText(v);
}

var PX = null;      
var PXLIST = [];    
function pxConn(text, kind){
  var n = $('px-conn');
  n.textContent = text;
  n.style.borderColor = kind === 'err' ? 'var(--err)' : '';
}
function pxFill(p){
  PX = p || null;
  $('a-pname').value = p ? p.name : '';
  $('a-host').value = p ? p.host : '';
  $('a-nodepath').value = p ? p.nodePath : '';
  $('a-key').value = '';
  $('a-key').type = 'password';
  $('a-keyhint').textContent = p ? (p.keySet ? '已保存密钥（不回显）；留空保持不变，填新值则更新。' : '尚未保存密钥。') : '';
  $('a-uuid').value = p ? p.uuid : '';
  $('a-penabled').checked = p ? p.enabled : true;
  $('px-sync').disabled = !p;
  $('px-rotate').disabled = !p;
  $('px-del').disabled = !p;
  ['a-host', 'a-nodepath', 'a-key', 'a-uuid'].forEach(function(id){ clearFieldError($(id)); });
  pxRenderList();
}

function pxApplyStatus(){
  document.querySelectorAll('#px-list .pxst').forEach(function(el){
    var d = PXSTAT[el.getAttribute('data-id')];
    if (!d){ el.textContent = ''; return; }
    var info = pxStatusInfo(d);
    el.textContent = d.up ? (info.ok ? '正常' : '有问题') : '连不上';
    el.title = info.text;
    el.className = 'pxst ' + (info.ok ? 'ok' : 'bad');
  });
}
function pxRenderList(){
  var box = $('px-list');
  box.textContent = '';
  PXLIST.forEach(function(p){
    var row = document.createElement('div');
    row.className = 'pxrow' + (PX && PX.id === p.id ? ' sel' : '');
    var main = document.createElement('div');
    main.className = 'pxmain';
    var b = document.createElement('b'); b.textContent = p.name;
    main.appendChild(b);
    main.appendChild(document.createTextNode(' · ' + p.host + '/' + p.nodePath));
    var st = document.createElement('span');
    st.className = 'pxst'; st.setAttribute('data-id', p.id);
    var lab = document.createElement('label');
    lab.className = 'pxon';
    lab.onclick = function(e){ e.stopPropagation(); };
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = p.enabled;
    cb.onchange = function(){ toggleProxyEnabled(p.id, cb.checked); };
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode('启用'));
    row.onclick = function(){ pxFill(p); pxConn('正在编辑「' + p.name + '」。'); };
    row.appendChild(main); row.appendChild(st); row.appendChild(lab);
    box.appendChild(row);
  });
  pxApplyStatus();
}
var PX_FIELD = { host: 'a-host', nodePath: 'a-nodepath', key: 'a-key', uuid: 'a-uuid', name: 'a-pname' };
function pxErrors(errors){
  var unplaced = [], first = null;
  (errors || []).forEach(function(e){
    var el = PX_FIELD[e.field] ? $(PX_FIELD[e.field]) : null;
    if (!el){ unplaced.push(e.msg); return; }
    clearFieldError(el);
    el.classList.add('invalid');
    el._errTip = attachMsg(el, 'field-err', e.msg);
    if (!first) first = el;
  });
  if (first){ try { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus({ preventScroll: true }); } catch (e) {} }
  return unplaced;
}
function pxRefreshAll(){
  
  api('config').then(function(r){ if (r && r.ok && r.data){ if (CFG) CFG.endpointMissing = r.data.endpointMissing; renderEndpoint(); } }).catch(function(){});
  checkProxy();
}
function pxSyncText(sync){
  if (!sync) return '';
  if (sync.ok) return sync.actions && sync.actions.length ? '已连接，并完成：' + sync.actions.join('、') : '已连接，代理状态已是最新';
  return '没能同步到代理：' + (sync.error || '未知错误');
}

function loadProxyEntry(selectId, keepNote){
  if (!keepNote) pxConn('读取中…');
  var want = selectId !== undefined ? selectId : (PX && PX.id);
  return api('proxies').then(function(r){
    if (!r || !r.ok || !r.data){ pxConn((r && r.msg) || '读取失败', 'err'); return; }
    PXLIST = r.data.proxies || [];
    var cur = null;
    PXLIST.forEach(function(p){ if (p.id === want) cur = p; });
    pxFill(cur || (selectId === null ? null : PXLIST[0]) || null);
    
    var sel = $('px-which');
    sel.textContent = '';
    PXLIST.forEach(function(p){ var o = document.createElement('option'); o.value = p.id; o.textContent = p.name + '（' + p.host + '）'; sel.appendChild(o); });
    if (!PXLIST.some(function(p){ return p.id === PXSEL; })) PXSEL = PXLIST.length ? PXLIST[0].id : '';
    sel.value = PXSEL;
    $('px-whichbox').style.display = PXLIST.length > 1 ? '' : 'none';
    renderProxySettings();
    if (keepNote) return;
    if (r.data.error){ pxConn('代理列表读取失败（' + r.data.error + '）：为避免覆盖已有数据，暂时不能保存。', 'err'); return; }
    pxConn(PXLIST.length ? '已添加 ' + PXLIST.length + ' 个代理，订阅会合并其中启用的。点列表里的代理编辑，或「添加代理」。' : '还没有代理：填写下面的域名、节点路径和密钥，点「保存并连接」。');
  }).catch(function(){ pxConn('无法连接服务器', 'err'); });
}
function newProxyEntry(){
  pxFill(null);
  pxConn('添加新代理：填写下面的域名、节点路径和密钥，点「保存并连接」。');
  try { $('a-host').focus(); } catch (e) {}
}
function pxDone(r, okMsg){
  var d = r.data || {};
  var t = (d.sync ? pxSyncText(d.sync) : '') || okMsg;
  pxConn(t, d.sync && !d.sync.ok ? 'err' : '');
  toast(t, d.sync && !d.sync.ok ? 'err' : 'ok');
  loadProxyEntry(d.proxy ? d.proxy.id : undefined, true).then(pxRefreshAll);
}
function toggleProxyEnabled(id, on){
  api('proxies/' + id + '/enabled', { method: 'POST', headers: JSON_H, body: JSON.stringify({ enabled: on }) }).then(function(r){
    if (r && r.ok){
      var w = r.data && r.data.warning;
      toast(w || (on ? '已启用' : '已停用：订阅里不再下发它，代理对外只显示 Hello World'), w ? 'err' : 'ok');
      if (PX && PX.id === id) $('a-penabled').checked = on;
    } else toast((r && r.msg) || '操作失败', 'err');
    loadProxyEntry(undefined, true).then(pxRefreshAll);
  }).catch(function(){ toast('操作失败：无法连接服务器', 'err'); loadProxyEntry(undefined, true); });
}
function pxBusy(on){
  ['px-connect', 'px-sync', 'px-rotate', 'px-del'].forEach(function(id){ var b = $(id); if (b) b.disabled = on || (id !== 'px-connect' && !PX); });
}
function pxCall(path, opts, okMsg, fail){
  pxBusy(true);
  return api(path, opts).then(function(r){
    if (r && r.ok){ pxDone(r, okMsg); return; }
    var unplaced = pxErrors(r && r.errors);
    toast((unplaced.length ? unplaced.join('；') : (r && r.msg)) || fail, 'err');
    pxConn((r && r.msg) || fail, 'err');
  }).catch(function(){ toast(fail + '：无法连接服务器', 'err'); })
    .then(function(){ pxBusy(false); });
}
var JSON_H = { 'Content-Type': 'application/json' };
function saveProxyEntry(){
  var body = { name: $('a-pname').value, host: $('a-host').value, nodePath: $('a-nodepath').value, uuid: $('a-uuid').value, enabled: $('a-penabled').checked };
  var key = $('a-key').value;
  if (key) body.key = key;
  else if (!PX || !PX.keySet){ pxErrors([{ field: 'key', msg: '请填写密钥（与代理脚本的环境变量 NODE_KEY 相同）' }]); return; }
  if (!body.name) delete body.name;
  if (!body.uuid) delete body.uuid;
  pxCall(PX ? 'proxies/' + PX.id : 'proxies', { method: 'POST', headers: JSON_H, body: JSON.stringify(body) }, '已保存', '保存失败');
}
function syncProxyEntry(){
  if (!PX) return;
  pxCall('proxies/' + PX.id + '/sync', { method: 'POST' }, '已同步', '同步失败');
}
function rotateProxyUuid(){
  if (!PX) return;
  if (!confirm('确定更换 UUID？新 UUID 立即生效，旧 UUID 在代理上保留 10 分钟；之后客户端必须更新订阅才能继续使用。')) return;
  pxCall('proxies/' + PX.id + '/rotate', { method: 'POST' }, '已更换 UUID：旧 UUID 还会在代理上保留 10 分钟，请尽快更新订阅', '更换失败');
}
function deleteProxyEntry(){
  if (!PX) return;
  if (!confirm('从面板删除这个代理？代理本身不会被改动（想让它停止服务，请先取消勾选「启用」并保存，再删除）。')) return;
  pxBusy(true);
  api('proxies/' + PX.id, { method: 'DELETE' }).then(function(r){
    if (r && r.ok){ pxConn('已删除。'); toast('已从面板删除', 'ok'); loadProxyEntry(null, true).then(pxRefreshAll); }
    else toast((r && r.msg) || '删除失败', 'err');
  }).catch(function(){ toast('删除失败：无法连接服务器', 'err'); }).then(function(){ pxBusy(false); });
}

function exportConfig(){
  try {
    var data = collectForm();
    SCHEMA.forEach(function(d){ if ((d.type === 'secret' || d.noExport) && getPath(data, d.key) !== undefined) setPath(data, d.key, ''); });
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var ts = new Date();
    var pad = function(n){ return String(n).padStart(2, '0'); };
    a.download = 'hopline-backup-' + ts.getFullYear() + pad(ts.getMonth()+1) + pad(ts.getDate()) + '-' + pad(ts.getHours()) + pad(ts.getMinutes()) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
    toast('配置已导出为 JSON', 'ok');
  } catch (e) { toast('导出失败：' + e.message, 'err'); }
}

function importConfig(input){
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(){
    try {
      var data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
      var next = JSON.parse(JSON.stringify(CFG)), n = 0;
      SCHEMA.forEach(function(d){
        var v = getPath(data, d.key);
        if (v === undefined || d.type === 'secret' || d.noExport || lockedEnv(d.key)) return;
        setPath(next, d.key, v);
        n++;
      });
      CFG = next;
      fillForm();
      renderAll();
      markDirty();
      toast('已导入 ' + n + ' 项配置，请点「保存全部」生效', 'ok');
    } catch (e) { toast('导入失败：JSON 格式不正确', 'err'); }
    input.value = '';
  };
  reader.readAsText(file, 'utf-8');
}


function bindFormEvents(){
  var bound = {};
  SCHEMA.forEach(function(d){
    schemaEls(d).forEach(function(id){
      var el = $(id);
      if (!el || bound[id]) return;
      bound[id] = 1;
      var h = function(){ markDirty(); clearFieldError(fieldEl(d.key)); clearFieldError(el); };
      el.addEventListener('change', h);
      el.addEventListener('input', h);
    });
    
    if (d.type === 'list' && d.exclusive && d.els){
      var ex = $(d.els[d.exclusive]);
      var others = Object.keys(d.els).filter(function(k){ return k !== d.exclusive; }).map(function(k){ return $(d.els[k]); });
      var anyOther = function(){ return others.some(function(o){ return o && o.checked; }); };
      ex.addEventListener('change', function(){
        if (ex.checked) others.forEach(function(o){ if (o) o.checked = false; });
        else if (!anyOther()) ex.checked = true;
      });
      others.forEach(function(o){
        if (!o) return;
        o.addEventListener('change', function(){
          if (o.checked) ex.checked = false;
          if (!anyOther()) ex.checked = true;
        });
      });
    }
  });
}
bindFormEvents();

function subUrlOf(fmt){
  
  
  
  var custom = (window.CFG && CFG.subUrl) ? String(CFG.subUrl).trim().replace(/^\/+/, '').replace(/\/sub$/, '').replace(/\/+$/, '') : '';
  var seg = custom;
  var base = seg ? (location.origin + '/' + seg) : (location.origin + APIPATH);
  var u = base + '/sub';
  return fmt ? (u + '/' + fmt) : u;
}
function makeSub(showQR){
  var fmt = $('subFmt').value;
  var url = subUrlOf(fmt === 'auto' ? '' : fmt);
  $('subUrl').value = url;
  if (showQR) showQRCode(url);
}

$('subFmt').addEventListener('change', function(){ makeSub($('qrWrap').style.display === 'block'); $('subPrev').style.display = 'none'; });
function toggleQR(){
  var w = $('qrWrap');
  if (w.style.display === 'block'){ w.style.display = 'none'; return; }
  showQRCode($('subUrl').value || subUrlOf(''));
}
function showQRCode(url){
  var w = $('qrWrap');
  w.style.display = 'block';
  if (typeof qrcode === 'undefined'){ w.innerHTML = '<div class="hint">二维码库加载失败，请直接复制链接</div>'; return; }
  try {
    var fmt = ($('subFmt') && $('subFmt').value) || 'auto';
    var q = qrcode(0, 'M');
    q.addData(qrPayloadOf(fmt, url));
    q.make();
    w.innerHTML = '<div class="qrbox">' + q.createImgTag(4, 10) + '</div>';
  } catch(e) { w.textContent = ''; w.appendChild(mkEl('div', 'hint', '二维码生成失败：' + e.message)); }
}





function qrPayloadOf(fmt, url){
  var enc = encodeURIComponent(url);
  if (fmt === 'clash' || fmt === 'stash') return 'clash://install-config?url=' + enc;
  if (fmt === 'singbox') return 'sing-box://import-remote-profile?url=' + enc + '#Hopline';
  if (fmt === 'surge') return 'surge:///install-config?url=' + enc;
  return url;
}
function downloadSub(){
  var fmt = $('subFmt').value;
  var a = document.createElement('a');
  a.href = subUrlOf(fmt === 'auto' ? '' : fmt);
  a.download = 'hopline-sub.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
}


var PREV = { fmt: '', raw: false, list: false, nodes: [] };
var LINK_FMTS = { auto: 1, v2ray: 1, plain: 1 };
function previewSub(){
  var fmt = $('subFmt').value;
  PREV = { fmt: fmt, raw: false, list: false, nodes: [] };
  $('subPrev').style.display = 'block';
  $('nodeSearch').value = '';
  prevTab(LINK_FMTS[fmt] ? 'list' : 'raw');
}
function prevTab(t){
  $('prevTabList').classList.toggle('on', t === 'list');
  $('prevTabRaw').classList.toggle('on', t === 'raw');
  $('prevList').style.display = t === 'list' ? 'block' : 'none';
  $('prevRaw').style.display = t === 'raw' ? 'block' : 'none';
  if (t === 'list' && !PREV.list) loadNodeList();
  if (t === 'raw' && !PREV.raw) loadRawPreview();
}
function loadRawPreview(){
  var fmt = PREV.fmt;
  PREV.raw = true;
  $('prevType').textContent = '请求中…';
  $('prevCount').textContent = '—';
  $('prevBody').textContent = '';
  api('sub?fmt=' + encodeURIComponent(fmt === 'auto' ? '' : fmt))
    .then(function(r){
      if (PREV.fmt !== fmt) return;
      if (!r || !r.ok){ PREV.raw = false; $('prevType').textContent = '预览失败'; $('prevBody').textContent = (r && r.msg) || '未知错误'; return; }
      var body = r.body || '';
      var type = r.type || '';
      $('prevType').textContent = type || '—';
      var n = 0;
      if (typeof r.count === 'number') n = r.count;   
      else if (/clash|yaml/i.test(type)) n = (body.match(/- name:/g) || []).length;
      else if (/json/i.test(type)) n = (body.match(/"tag"/g) || []).length;
      else {
        var t = body;
        if (!NODE_LINK_ANY_M.test(t)) {
          try { t = atob(t); } catch (e) {  }
        }
        n = t.split('\n').filter(function(l){ return NODE_LINK_ANY.test(l.trim()); }).length;
      }
      $('prevCount').textContent = n + ' 个节点';
      $('prevBody').textContent = body.length > 2600 ? body.slice(0, 2600) + '\n…（已截断，完整内容请下载）' : body;
    })
    .catch(function(){ PREV.raw = false; $('prevType').textContent = '预览失败：无法连接服务器'; $('prevBody').textContent = ''; });
}

var NODE_LINK_ANY_M = new RegExp('^(vl' + 'ess|ss|xhttp):\\/\\/', 'm');
var NODE_LINK_ANY = new RegExp('^(vl' + 'ess|ss|xhttp):\\/\\/');
var NODE_LINK_ONE = new RegExp('^vl' + 'ess:' + '\\/\\/[^@]*@(\\[[^\\]]+\\]|[^:?#\\/]+):(\\d+)');

function parseNodeLink(link){
  var m = NODE_LINK_ONE.exec(link);
  if (!m) return null;
  var hash = link.indexOf('#'), name = '';
  if (hash >= 0) { try { name = decodeURIComponent(link.slice(hash + 1)); } catch (e) { name = link.slice(hash + 1); } }
  var proto = /[?&]type=xhttp(&|#|$)/.test(link) ? 'XHTTP' : 'VLESS';
  return { link: link, name: name || (m[1] + ':' + m[2]), proto: proto, addr: m[1] + ':' + m[2] };   
}
function loadNodeList(){
  var fmt = PREV.fmt;
  PREV.list = true;
  var box = $('nodeList');
  box.textContent = '';
  box.appendChild(mkEl('div', 'node-empty', '正在生成节点列表…'));
  api('sub?fmt=plain')
    .then(function(r){
      if (PREV.fmt !== fmt) return;
      if (!r || !r.ok){ PREV.list = false; box.textContent = ''; box.appendChild(mkEl('div', 'node-empty', '生成失败：' + ((r && r.msg) || '未知错误'))); return; }
      PREV.nodes = String(r.body || '').split('\n').map(function(l){ return parseNodeLink(l.trim()); }).filter(Boolean);
      $('nodeSearch').placeholder = '在 ' + PREV.nodes.length + ' 个节点中搜索名称 / 地址 / 协议，如 香港、XHTTP';
      renderNodeList();
    })
    .catch(function(){ PREV.list = false; box.textContent = ''; box.appendChild(mkEl('div', 'node-empty', '生成失败：无法连接服务器')); });
}
function renderNodeList(){
  var box = $('nodeList');
  if (!PREV.list || !PREV.nodes) return;
  var q = $('nodeSearch').value.trim().toLowerCase();
  var shown = PREV.nodes.filter(function(n){
    return !q || (n.name + ' ' + n.addr + ' ' + n.proto).toLowerCase().indexOf(q) >= 0;
  });
  box.textContent = '';
  if (!PREV.nodes.length) { box.appendChild(mkEl('div', 'node-empty', '没有节点')); return; }
  if (!shown.length) { box.appendChild(mkEl('div', 'node-empty', '没有匹配「' + q + '」的节点')); return; }
  var frag = document.createDocumentFragment();
  shown.forEach(function(n){
    var row = mkEl('div', 'node-row');
    row.appendChild(mkEl('span', 'ptag ' + n.proto.toLowerCase(), n.proto));
    var nm = mkEl('div', 'nm');
    nm.appendChild(mkEl('b', null, n.name));
    nm.appendChild(mkEl('span', null, n.addr));
    row.appendChild(nm);
    var cp = mkEl('button', 'btn sm', '复制');
    cp.onclick = function(){ copyText(n.link); };
    var qr = mkEl('button', 'btn sm', '二维码');
    qr.onclick = function(){ openNodeQr(n); };
    row.appendChild(cp); row.appendChild(qr);
    frag.appendChild(row);
  });
  box.appendChild(frag);
}
function openNodeQr(n){
  $('nodeQrName').textContent = n.name;
  $('nodeQrLink').textContent = n.link;
  var img = $('nodeQrImg');
  img.textContent = '';
  try {
    if (typeof qrcode !== 'function') throw new Error('二维码库未加载');
    
    if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    var q = qrcode(0, n.link.length > 500 ? 'L' : 'M');   
    q.addData(n.link);
    q.make();
    
    var cell = Math.max(2, Math.floor(300 / (q.getModuleCount() + 8)));
    img.innerHTML = q.createImgTag(cell, cell * 4);
  } catch (e) { img.appendChild(mkEl('div', 'hint', '二维码生成失败：' + e.message)); }
  $('nodeQr').classList.add('show');
}
function closeNodeQr(){ $('nodeQr').classList.remove('show'); }
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeNodeQr(); });


var IPSRC_LABELS = { hostmonit: 'HostMonit 实时优选', uouin: 'uouin 分线路优选', wetest: '微测网优选', api1: '自定义优选 API 1', api2: '自定义优选 API 2', domains: '优选域名' };
function testOutOf(src){ return $(src === 'domains' ? 'pd-test-out' : 'ps-test-out'); }

function mkEl(tag, cls, text){
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function testIpSource(src){
  var btn = $('ps-test-' + src), out = testOutOf(src);
  var body = { source: src };
  if (src === 'domains') body.text = $('o-prefdomains').value;
  if (src === 'api1' || src === 'api2') {
    body.url = $('ps-' + src + '-url').value.trim();
    if (!body.url) { toast('请先填写 ' + IPSRC_LABELS[src] + ' 的地址', 'err'); $('ps-' + src + '-url').focus(); return; }
  }
  btn.disabled = true;
  out.style.display = 'block';
  out.textContent = '';
  out.appendChild(mkEl('div', 'ipt-dim', '正在拉取 ' + IPSRC_LABELS[src] + ' …'));
  api('ipsrc-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ renderIpTest(src, r); })
    .catch(function(){ renderIpTest(src, { ok: false, msg: '无法连接服务器' }); })
    .then(function(){ btn.disabled = false; });
}


var HTTP_PORTS = /*@HOPLINE_HTTP_PORTS@*/null || [80, 8080, 8880, 2052, 2082, 2086, 2095];   
var LAST_IPTEST = null;
function tlsOnlyNow(){ return $('tls-only').checked || $('ech-on').checked; }
function rerenderIpTest(){ if (LAST_IPTEST) renderIpTest(LAST_IPTEST.src, LAST_IPTEST.r); }
function renderIpTest(src, r){
  LAST_IPTEST = { src: src, r: r };
  var out = testOutOf(src);
  out.textContent = '';
  var head = mkEl('div', 'ipt-head');
  head.appendChild(mkEl('b', '', IPSRC_LABELS[src] || src));
  if (!r || !r.ok) {
    head.appendChild(mkEl('span', 'ipt-err', '测试失败：' + ((r && r.msg) || '未知错误')));
    out.appendChild(head);
    return;
  }
  var d = r.data;
  if (src === 'domains') { renderDomainTest(out, head, d); return; }
  head.appendChild(mkEl('span', d.count ? 'ipt-ok' : 'ipt-err', d.count ? '✓ 可用 ' + d.count + ' 个 Cloudflare IP' : '✗ ' + (d.error || '没有可用 IP')));
  head.appendChild(mkEl('span', 'ipt-dim', 'HTTP ' + (d.status || '—') + ' · ' + d.ms + ' ms'));
  if (d.count && d.error) head.appendChild(mkEl('span', 'ipt-err', d.error));
  out.appendChild(head);
  if (d.items && d.items.length) {
    var tlsOnly = tlsOnlyNow(), lines = [], nodes = 0, skipped = 0;
    d.items.forEach(function(x){
      var host = String(x.ip).indexOf(':') >= 0 ? '[' + x.ip + ']' : x.ip;
      var name = x.name || '优选IP-NN', port = Number(x.port) || 443;
      if (tlsOnly && HTTP_PORTS.indexOf(port) >= 0) { lines.push(name + '    ' + host + ':' + port + '    （仅 TLS 端口：将跳过）'); skipped++; return; }
      lines.push(name + '    ' + host + ':' + port); nodes++;
      if (!tlsOnly && port === 443) { lines.push(name + '·80    ' + host + ':80    （明文）'); nodes++; }
    });
    if (d.count > d.items.length) lines.push('… 另有 ' + (d.count - d.items.length) + ' 个 IP');
    out.appendChild(mkEl('div', 'ipt-dim', '订阅中将使用的节点（名称 · 地址，每个启用的协议各一条）：' + nodes + ' 个'
      + (skipped ? '，跳过 ' + skipped + ' 个明文端口' : '')
      + '。按「仅 TLS 端口」当前' + (tlsOnly ? '开启' : '关闭') + '状态' + ($('ech-on').checked ? '（ECH 已开启，强制仅 TLS）' : '') + '展示，切换后即时更新'));
    out.appendChild(mkEl('pre', 'code', lines.join('\n')));
  }
  if (d.droppedCount) {
    out.appendChild(mkEl('div', 'ipt-dim', '已丢弃 ' + d.droppedCount + ' 个非 Cloudflare 段地址：' + d.dropped.join(', ') + (d.droppedCount > d.dropped.length ? ' …' : '')));
  }
  var det = mkEl('details');
  det.appendChild(mkEl('summary', '', '原始响应（' + (d.rawLength > d.raw.length ? '前 ' + d.raw.length + ' / 共 ' + d.rawLength : '共 ' + d.rawLength) + ' 字符）'));
  det.appendChild(mkEl('pre', 'code', d.raw || '(空)'));
  if (!d.count) det.open = true;   
  out.appendChild(det);
}


function renderDomainTest(out, head, d){
  var rows = d.domains || [], ok = rows.filter(function(x){ return x.ok; }).length;
  head.appendChild(mkEl('span', ok ? 'ipt-ok' : 'ipt-err', ok ? '✓ ' + ok + ' / ' + rows.length + ' 个域名解析到 Cloudflare 段' : '✗ ' + (d.error || '没有可用域名')));
  head.appendChild(mkEl('span', 'ipt-dim', d.ms + ' ms'));
  out.appendChild(head);
  if (rows.length) {
    var lines = rows.map(function(x){
      return (x.ok ? '✓ ' : '✗ ') + x.domain + '    ' + (x.failed ? '解析失败' : (x.ips.join(', ') || '无 A 记录') + (x.ok ? '' : '（不在 Cloudflare 段，不建议使用）'));
    });
    out.appendChild(mkEl('pre', 'code', lines.join('\n')));
  }
  if (d.rawLength > d.raw.length || /未测试/.test(d.raw || '')) out.appendChild(mkEl('div', 'ipt-dim', (d.raw.split('\n').pop() || '')));
}


function updatePdCount(){
  var n = $('o-prefdomains').value.split(/[\n,;\s]+/).filter(function(x){ return x; }).length;
  var builtin = (CFG && CFG.builtinPrefDomains) ? CFG.builtinPrefDomains.length : 0;
  $('pd-count').textContent = n ? ('当前自定义 ' + n + ' 个域名（上限 30），已替换内置列表') : ('留空：使用内置列表' + (builtin ? '（' + builtin + ' 个）' : ''));
}
function loadBuiltinDomains(){
  if (!CFG || !CFG.builtinPrefDomains) return;
  $('o-prefdomains').value = CFG.builtinPrefDomains.join('\n');
  updatePdCount();
  markDirty();
}
$('o-prefdomains').addEventListener('input', updatePdCount);


$('tls-only').addEventListener('change', rerenderIpTest);
$('ech-on').addEventListener('change', rerenderIpTest);

buildNav();
var initView = 'dashboard';
try {
  var qv = new URLSearchParams(location.search).get('v');
  if (qv && TITLES[qv]) initView = qv;
} catch(e) {}
switchView(initView);
loadAll();
</script>
</body>
</html>

`;

// 面板页面：在模板上注入字段表与共用校验函数（每个 isolate 只组装一次）
let PANEL_PAGE = null;
function panelPage() {
  if (PANEL_PAGE) return PANEL_PAGE;
  PANEL_PAGE = PANEL_TEMPLATE
    .replace('/*@HOPLINE_SCHEMA@*/null', () => JSON.stringify(clientSchema()).replace(/</g, '\\u003c'))
    .replace('/*@HOPLINE_CHECK@*/null', () => '(' + checkFieldValue.toString() + ')')
    .replace('/*@HOPLINE_HTTP_PORTS@*/null', () => JSON.stringify([...HTTP_PORTS]));
  return PANEL_PAGE;
}
// ---------------------------------------------------------------------------
// 路由与调度
// ---------------------------------------------------------------------------
// JSON 响应（面板的管理接口用；代理没有任何 JSON 响应，出错一律是伪装页）
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}) });
}

function isBrowserUA(ua) {
  // 任何包含 Mozilla 的 UA 视为浏览器；curl / ClashForAndroid / Sing-box 等客户端不含
  return (ua || '').toLowerCase().includes('mozilla');
}

// 鉴权：
//  - 未设置 ADMIN 时一律拒绝
//  - Cookie 为带过期时间的 HMAC-SHA256 签名令牌
//  - 常量时间比较 + 登录失败限速
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', TE.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, TE.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// 管理密码存储：KV 中保存加盐 PBKDF2-SHA256 摘要（格式 前缀 + 迭代次数 + $ + 盐 + $ + 摘要），不保存明文。
// 迭代次数写在摘要里，日后可调高而不影响已保存的密码；取 1 万次是为了控制免费版 10ms CPU 限制下的登录开销。
// 由环境变量 ADMIN 提供的密码仍是明文（环境变量本身即密钥存储），按常量时间比较。
// KV 中若存有明文密码同样可用，下次在面板保存任意配置时自动改存摘要。
const ADMIN_HASH_PREFIX = 'hopline-pbkdf2$';
const ADMIN_HASH_ITER = 10000;
const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from((String(h).match(/../g) || []).map(x => parseInt(x, 16)));
async function pbkdf2Hex(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', TE.encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)));
}
function isAdminHash(v) { return typeof v === 'string' && v.startsWith(ADMIN_HASH_PREFIX); }
async function hashAdminPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return ADMIN_HASH_PREFIX + ADMIN_HASH_ITER + '$' + toHex(salt) + '$' + await pbkdf2Hex(password, salt, ADMIN_HASH_ITER);
}
async function verifyAdminPassword(stored, password) {
  stored = String(stored || ''); password = String(password == null ? '' : password);
  if (!stored) return false;
  if (!isAdminHash(stored)) return timingSafeEqual(password, stored);   // 环境变量 / KV 中的明文
  const parts = stored.slice(ADMIN_HASH_PREFIX.length).split('$');
  const iter = parseInt(parts[0], 10);
  if (parts.length !== 3 || !(iter >= 1000 && iter <= 100000) || !parts[1] || !parts[2]) return false;
  return timingSafeEqual(await pbkdf2Hex(password, fromHex(parts[1]), iter), parts[2]);
}
// 登录会话：空闲 24 小时过期——登录后每次使用面板（打开页面 / 调用接口）都把有效期顺延为 24 小时，
// 但自登录起最长 7 天，到期必须重新登录（限制遗失或被盗的 Cookie 可用的时长）。
// 令牌格式「过期时间.登录时间.签名」，签名覆盖两个时间，无法篡改；服务端不保存会话
const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_REFRESH_MIN_MS = 10 * 60 * 1000;   // 新有效期至少比当前晚 10 分钟才重新签发（连续操作时不必每个请求都换 Cookie）
// 当前生效的管理用户名（KV 中为空等异常情况回落默认 admin）
function adminUserOf(cfg) { return String(cfg.adminUser || '') || 'admin'; }
// 会话签名密钥含用户名：修改用户名与修改密码一样，使其它浏览器的登录态失效（代理端点的 UUID 等与登录无关，不参与）
function authKey(cfg) { return 'hopline-auth|' + String(cfg.admin) + '|' + adminUserOf(cfg); }
// iat：登录时间（续期时沿用，保证 7 天上限从首次登录算起）；返回 { token, exp }
async function makeAuthToken(cfg, iat) {
  const now = Date.now();
  iat = iat || now;
  const exp = Math.min(now + AUTH_TTL_MS, iat + AUTH_MAX_MS);
  return { token: exp + '.' + iat + '.' + await hmacHex(authKey(cfg), exp + '.' + iat), exp };
}
// 校验登录 Cookie：有效时返回会话 { exp, iat }，否则 false。
// 传入 state 时顺便判断是否需要续期，需要则把新 Cookie 放到 state.setCookie（由 fetch 入口附加到响应上）
async function requireAuth(request, cfg, state) {
  if (!cfg.admin) return false;
  const cookies = request.headers.get('Cookie') || '';
  const m = cookies.match(/(?:^|;\s*)hopline_auth=([^;]+)/);
  if (!m) return false;
  const parts = m[1].split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !parts[2]) return false;
  const exp = Number(parts[0]), iat = Number(parts[1]), now = Date.now();
  if (exp < now || now - iat > AUTH_MAX_MS) return false;
  if (!timingSafeEqual(parts[2], await hmacHex(authKey(cfg), parts[0] + '.' + parts[1]))) return false;
  const session = { exp, iat };
  if (state && Math.min(now + AUTH_TTL_MS, iat + AUTH_MAX_MS) - exp >= AUTH_REFRESH_MIN_MS) {
    const t = await makeAuthToken(cfg, iat);
    state.setCookie = authCookie(t.token, t.exp);
  }
  return session;
}
// 登录失败限速（按客户端 IP，同一 Worker 实例内生效，属尽力而为）：15 分钟内最多 5 次失败。
// IPv6 按 /64 网段计数（单个用户通常拥有整个 /64，逐地址计数会被轻易绕过）；
// 表满时只淘汰最旧项，不整表清空（否则攻击者灌入大量来源即可清零所有计数）
const LOGIN_FAILS = new Map();
const LOGIN_MAX_FAILS = 5, LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_TABLE_MAX = 5000;
function loginRateKey(ip) {
  ip = String(ip || 'unknown');
  if (ip.indexOf(':') < 0) return ip;
  const dbl = ip.indexOf('::');
  let groups;
  if (dbl >= 0) {
    const left = ip.slice(0, dbl).split(':').filter(Boolean), right = ip.slice(dbl + 2).split(':').filter(Boolean);
    groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  } else groups = ip.split(':');
  return groups.slice(0, 4).map(g => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
function loginBlocked(ip) {
  const k = loginRateKey(ip), r = LOGIN_FAILS.get(k);
  if (!r) return false;
  if (Date.now() - r.t > LOGIN_WINDOW_MS) { LOGIN_FAILS.delete(k); return false; }
  return r.n >= LOGIN_MAX_FAILS;
}
function loginFail(ip) {
  const k = loginRateKey(ip), now = Date.now(), r = LOGIN_FAILS.get(k);
  if (!r || now - r.t > LOGIN_WINDOW_MS) { LOGIN_FAILS.delete(k); LOGIN_FAILS.set(k, { n: 1, t: now }); }
  else r.n++;
  // Map 按插入顺序遍历，而记录的时间戳是首次失败时间——最先插入的就是最先过期的，淘汰最旧项即可（O(1)）
  while (LOGIN_FAILS.size > LOGIN_TABLE_MAX) LOGIN_FAILS.delete(LOGIN_FAILS.keys().next().value);
}
function loginSuccess(ip) { LOGIN_FAILS.delete(loginRateKey(ip)); }
// 登录页与登录接口只对「知道面板路径」的人开放：next 必须指向面板路径（面板入口的跳转自带），
// 否则返回 404——扫描器无法凭 /login 识别部署，也无法在不知道路径的情况下爆破管理密码
function loginNextOk(next, panelPath) {
  next = String(next || '');
  if (!/^\/[^\/\\]/.test(next)) return false;
  let seg = next.slice(1).split(/[\/?#]/)[0];
  try { seg = decodeURIComponent(seg); } catch (e) { return false; }
  return seg === panelPath;
}
function safeNext(next, panelPath) {
  next = String(next || '');
  return (/^\/[^\/\\]/.test(next)) ? next : ('/' + panelPath);
}
// Cookie 有效期与令牌的过期时间一致
function authCookie(token, exp) {
  const maxAge = Math.max(0, Math.floor((exp - Date.now()) / 1000));
  return `hopline_auth=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
// 返回给面板的配置：只含字段表登记的配置项，不下发管理密码明文；附带面板需要的派生信息
function publicConfig(cfg, env) {
  const out = pickSchema(cfg);
  out.version = VERSION;
  out.adminSet = !!cfg.admin;
  delete out.admin;
  out.path = cfg.path;                              // 环境变量 PATH 提供（面板中只读）
  out.panelPath = cfg.path;                         // 当前生效的面板路径
  out.endpointMissing = endpointMissing(cfg);       // 尚未填写的代理端点字段（空数组 = 可以生成订阅）
  out.envLocked = envLockedFields(env);             // { 字段: 环境变量名 }：面板中只读
  out.kv = !!(kvStore(env) && typeof kvStore(env).put === 'function');
  out.builtinPrefDomains = DEFAULT_PREFERRED_DOMAINS.split('\n');   // 面板「载入内置列表」使用
  out.kvError = cfg._kvError ? kvErrorMessage(cfg._kvError) : '';   // 非空 = 配置存储异常，面板提示且保存被禁用
  return out;
}
function kvErrorMessage(kind) {
  return kind === 'corrupt' ? 'KV 中保存的配置已损坏（不是合法 JSON），当前使用的是环境变量与默认值' : 'KV 暂时无法读取，当前使用的是环境变量与默认值';
}
function formatConfigErrors(errors) {
  return errors.map(e => (e.label ? e.label + '：' : '') + e.msg).join('；');
}

// 生成订阅：/sub 与面板预览共用同一流程，保证预览与客户端实际拿到的一致
async function serveSubscription(request, cfg, fmt) {
  const UA = request.headers.get('User-Agent') || '';
  return generateSubscription(Object.assign({}, cfg), fmt, UA);
}

// 必填环境变量检查：返回说明文字（有问题时），否则空串。PATH 必填；ADMIN 必填（缺失时面板与管理接口禁用，见面板入口处的提示）
function setupProblems(env, cfg) {
  if (cfg.path) return '';
  return cfg._pathError
    ? '环境变量 PATH 的值不正确：' + cfg._pathError + '。'
    : 'Hopline 面板尚未完成配置：请在 Worker 环境变量中设置 PATH（面板与订阅的访问路径，如 mypanel）和 ADMIN（管理密码），然后重新访问。';
}

async function handleRequest(request, env, state) {
  const url = new URL(request.url);
  const UA = request.headers.get('User-Agent') || '';

  // HTTP → HTTPS
  if (url.protocol === 'http:') {
    return Response.redirect(url.href.replace('http://', 'https://'), 301);
  }

  const cfg = await loadConfig(env);
  // 必填项缺失：PATH（面板与订阅的访问路径）未设置或非法。没有路径就无法路由任何请求，统一返回设置说明
  const setupMsg = setupProblems(env, cfg);
  if (setupMsg) return new Response(setupMsg, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const panelPath = cfg.path;
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  const segs = path.split('/');

  // ---------- 版本接口（仅登录后可用；公开会让扫描器识别部署与版本） ----------
  if (segs[0] === 'version') {
    if (!(await requireAuth(request, cfg, state))) return new Response('Not Found', { status: 404 });
    return json({ version: VERSION });
  }

  // ---------- 登录 ----------
  if (segs[0] === 'login') {
    // 未设置 ADMIN 时登录页不存在（避免暴露面板路径）
    if (!cfg.admin) return new Response('Not Found', { status: 404 });
    if (request.method === 'POST') {
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      const body = await request.text();
      const params = new URLSearchParams(body);
      if (!loginNextOk(params.get('next'), panelPath)) return new Response('Not Found', { status: 404 });
      if (loginBlocked(clientIp)) return json({ ok: false, msg: '尝试次数过多，请 15 分钟后再试' }, 429);
      // 用户名与密码都校验完再判定（密码校验总会执行，不因用户名错误提前返回），错误提示不区分是哪一项
      const userOk = timingSafeEqual(params.get('username') || '', adminUserOf(cfg));
      const passOk = await verifyAdminPassword(cfg.admin, params.get('password') || '');
      if (userOk && passOk) {
        loginSuccess(clientIp);
        const t = await makeAuthToken(cfg);
        return new Response(JSON.stringify({ ok: true, next: safeNext(params.get('next'), panelPath) }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': authCookie(t.token, t.exp)
          }
        });
      }
      loginFail(clientIp);
      return json({ ok: false, msg: '用户名或密码错误' }, 403);
    }
    if (!loginNextOk(url.searchParams.get('next'), panelPath)) return new Response('Not Found', { status: 404 });
    return new Response(loginHTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // 订阅入口：自定义订阅路径（如 /mysub/sub）；面板路径下的 /sub 始终可用。
  // 面板入口与管理 API 只认 panelPath，订阅入口下不开放面板与管理接口
  const subAlias = String(cfg.subUrl || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const isPanelRoot = segs[0] === panelPath;
  const isSubRoot = isPanelRoot || (subAlias !== '' && segs[0] === subAlias);

  // 根路径不跳转到面板入口（否则会把面板路径 / UUID 告诉任何访问者），返回伪装页
  if (segs[0] === '') {
    return stubPage();
  }

  // ---------- 订阅 ----------
  if (isSubRoot && (segs[1] === 'sub' || (segs.length === 1 && !isBrowserUA(UA)))) {
    const fmt = segs.length >= 3 ? segs[2] : '';
    try {
      const sub = await serveSubscription(request, cfg, fmt);
      return new Response(sub.body, { status: 200, headers: { 'Content-Type': sub.type + '; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="Hopline"; filename*=utf-8\'\'Hopline' } });
    } catch (e) {
      const status = (e && e.status) || 500;
      return new Response('订阅生成失败: ' + (e && e.message || e), { status, headers: status === 503 ? { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '15' } : { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }

  // ---------- 面板（浏览器访问） ----------
  if (isPanelRoot && segs.length === 1 && isBrowserUA(UA)) {
    if (!cfg.admin) {
      return new Response('面板已禁用：请先在 Worker 环境变量中设置 ADMIN（管理密码），然后重新访问。', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (!(await requireAuth(request, cfg, state))) {
      return Response.redirect(new URL('/login?next=' + encodeURIComponent('/' + panelPath), request.url).href, 302);
    }
    return new Response(panelPage(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  // ---------- API ----------
  if (isPanelRoot && segs[1] === 'api') {
    const apiName = segs[2] || '';
    const authed = await requireAuth(request, cfg, state);
    if (!authed) {
      return json({ ok: false, status: 403, msg: '未授权（需要管理密码）' }, 403);
    }

    if (apiName === 'config') {
      if (request.method === 'GET') {
        return json({ ok: true, data: publicConfig(cfg, env) });
      }
      if (request.method === 'POST') {
        if (cfg._kvError) return json({ ok: false, msg: kvErrorMessage(cfg._kvError) + '，为避免覆盖已有配置，已禁止保存' }, 503);
        // 未绑定 KV 时保存不会持久化，必须拒绝而不是提示「已保存」
        const kv = kvStore(env);
        if (!kv || typeof kv.put !== 'function') {
          return json({ ok: false, msg: '未绑定 KV 命名空间（变量名 CONFIG_KV），无法保存面板配置；请在 Worker 设置中绑定 KV 后重试' }, 400);
        }
        let body;
        try { body = await request.json(); } catch (e) { return json({ ok: false, msg: '请求体不是合法的 JSON' }, 400); }
        try {
          // 按字段表校验：只接受登记过的字段，逐项校验并规范化；有错误时返回字段级错误列表供面板标注
          const { patch, errors, ignored } = sanitizeConfigPatch(body, env);
          if (errors.length) return json({ ok: false, msg: formatConfigErrors(errors), errors, ignored }, 400);
          const merged = pickSchema(cfg);
          for (const d of CONFIG_SCHEMA) {
            const v = getPath(patch, d.key);
            if (v !== undefined) setPath(merged, d.key, v);
          }
          const crossErrors = crossCheckConfig(merged);
          if (crossErrors.length) return json({ ok: false, msg: formatConfigErrors(crossErrors), errors: crossErrors, ignored }, 400);
          // KV 里的管理密码只存摘要：面板新设的密码（以及 KV 中已有的明文密码）都在这里转成摘要
          if (merged.admin && !isAdminHash(merged.admin) && !envLockedFields(env).admin) merged.admin = await hashAdminPassword(merged.admin);
          const stored = await saveConfig(env, merged);
          // 直接用刚写入的数据组装新配置（不回读 KV：边缘缓存可能仍是旧值）
          const fresh = buildConfig(env, stored);
          // UUID / 管理密码 / 管理用户名变更会使登录态签名失效：当前会话已通过鉴权，直接签发新令牌，面板无需重新登录
          // （沿用原登录时间，7 天上限不因此重置）
          const headers = {};
          if (fresh.admin && authKey(fresh) !== authKey(cfg)) { const t = await makeAuthToken(fresh, authed.iat); headers['Set-Cookie'] = authCookie(t.token, t.exp); }
          return json({ ok: true, data: publicConfig(fresh, env), ignored, msg: '已保存：本地区立即生效，其他地区约 1 分钟内同步' }, 200, headers);
        } catch (e) { return json({ ok: false, msg: '保存失败: ' + (e.message || e) }, 500); }
      }
      return json({ ok: false, msg: '仅支持 GET / POST' }, 405);
    }

    // 代理管理（增删改 / 同步 / 启停 / 状态 / 在线设置）：面板通过签名的 HTTPS 请求调用代理的控制接口，见 proxies-api.js
    if (apiName === 'proxies' || apiName === 'proxy-status' || apiName === 'proxy-sync-all' || apiName === 'alt-routes') return handleProxiesApi(apiName, request, env, cfg, segs, url);

    if (apiName === 'logout') {
      if (request.method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
      // 会话令牌是无状态的签名令牌，无法在服务端单独吊销：这里清除浏览器中的 Cookie。
      // 要让已签发的令牌全部失效，修改管理密码、管理用户名或 UUID 即可（签名密钥随之变化）
      return json({ ok: true, msg: '已退出登录' }, 200, { 'Set-Cookie': 'hopline_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
    }

    if (apiName === 'reset') {
      if (request.method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
      try {
        if (cfg._kvError === 'unavailable') return json({ ok: false, msg: kvErrorMessage(cfg._kvError) + '，暂时无法重置' }, 503);   // 配置损坏（corrupt）时允许重置来修复
        const kvr = kvStore(env);
        if (!kvr || typeof kvr.delete !== 'function') return json({ ok: false, msg: '未绑定 KV 命名空间，无需重置' }, 400);
        await kvr.delete('config');
        return json({ ok: true, msg: '已重置：KV 已清空，面板还原为初始部署状态' });
      } catch (e) { return json({ ok: false, msg: '重置失败: ' + (e.message || e) }, 500); }
    }

    if (apiName === 'status') {
      return json({ ok: true, data: { version: VERSION, host: url.hostname, path: panelPath, region: (request.cf && request.cf.colo) || 'unknown', kv: !!(kvStore(env) && typeof kvStore(env).get === 'function'), workersDev: /\.workers\.dev$/i.test(url.hostname) } });
    }

    if (apiName === 'update') {
      try {
        const r = await checkUpdate();
        const d = { current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, error: r.error || '' };
        if (r.hasUpdate && r.code) d.code = r.code;
        return json({ ok: true, data: d });
      } catch (e) { return json({ ok: false, msg: '检测失败: ' + (e.message || e) }, 500); }
    }

    // 优选 IP 来源测试（面板「测试」按钮）：强制重新拉取指定来源（不读写缓存），返回解析结果与原始响应片段。
    // 自定义 API 使用请求中的地址（面板输入框当前值，可在保存前测试）
    if (apiName === 'ipsrc-test') {
      if (request.method !== 'POST') return json({ ok: false, msg: '仅支持 POST' }, 405);
      let body = {};
      try { body = await request.json(); } catch (e) { /* 空请求体 */ }
      const source = String((body && body.source) || '');
      const t0 = Date.now();
      let r;
      if (source === 'hostmonit') r = await hostmonitFetch(150);
      else if (source === 'uouin') r = await uouinFetch();
      else if (source === 'wetest') r = await wetestFetch();
      else if (source === 'domains') {
        // 测试面板输入框里尚未保存的域名列表；留空则测试内置列表
        const chk = SERVER_CHECKS.domainList(String((body && body.text) || ''));
        if (typeof chk === 'string') return json({ ok: false, msg: chk }, 400);
        r = await domainsFetch(chk.value ? chk.value.split('\n') : DEFAULT_PREFERRED_DOMAINS.split('\n'));
      }
      else if (source === 'api1' || source === 'api2') {
        const chk = checkFieldValue(SCHEMA_BY_KEY.get('ipsrc.' + source + 'Url'), body.url);
        if (chk.error || !chk.value) return json({ ok: false, msg: chk.error || '请先填写 API 地址' }, 400);
        r = await customApiFetch(chk.value);
      } else return json({ ok: false, msg: '未知来源：' + source }, 400);
      const RAW_MAX = 4000;
      return json({ ok: true, data: {
        source, ms: Date.now() - t0, status: r.status, error: r.error || '',
        count: r.items.length, items: r.items.slice(0, 300),
        droppedCount: r.dropped.length, dropped: r.dropped.slice(0, 50),
        raw: r.raw.slice(0, RAW_MAX), rawLength: r.raw.length, domains: r.domains,
      } });
    }

    if (apiName === 'sub') {
      const fmt = url.searchParams.get('fmt') || '';
      try {
        const sub = await serveSubscription(request, cfg, fmt);
        return json({ ok: true, type: sub.type, body: sub.body, count: sub.count });
      } catch (e) { return json({ ok: false, msg: '订阅生成失败: ' + (e.message || e) }, (e && e.status) || 500); }
    }

    return json({ ok: false, msg: '未知 API: ' + apiName }, 404);
  }

  // 未匹配任何有效路由（路径不对）：返回伪装页，不暴露部署存在
  return stubPage();
}

// 安全响应头：只加在 HTML 页面与 JSON 接口上（订阅、WebSocket、XHTTP 流不动）。
// CSP 允许面板自带的内联脚本 / 样式与 jsDelivr 上带 SRI 的二维码库；frame-ancestors 'none' 防止面板被嵌入框架点击劫持
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function withSecurityHeaders(res) {
  if (!res || res.status === 101 || res.webSocket) return res;
  const ct = res.headers.get('Content-Type') || '';
  const isHtml = /^text\/html/i.test(ct), isJson = /^application\/json/i.test(ct);
  if (!isHtml && !isJson) return res;
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  if (isHtml) {
    h.set('Content-Security-Policy', PAGE_CSP);
    h.set('X-Frame-Options', 'DENY');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    const state = {};
    let res = await handleRequest(request, env, state);
    // 登录会话续期：已登录的请求在响应上附带新 Cookie（响应自己设置了 Cookie 时以响应为准，如退出登录、改密码）
    if (state.setCookie && res.status !== 101 && !res.headers.has('Set-Cookie')) {
      res = new Response(res.body, res);
      res.headers.set('Set-Cookie', state.setCookie);
    }
    return withSecurityHeaders(res);
  }
};
