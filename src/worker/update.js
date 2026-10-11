const VERSION = '2.5.3';
// 本文件是否为混淆产物：obfuscate.mjs 按原文精确替换为 true（混淆后仍是这个布尔值，只是字面量的编码方式不同）。
// 据此决定更新检测拉取哪个文件、面板上怎么标注当前部署——保证拉取与当前运行的是同一种
const IS_OBFUSCATED = false;

// 更新检测：点击版本号后拉取仓库代码比对版本号；有新版本时返回最新代码供面板复制
// 版本基准与复制的代码都是仓库 main 分支根目录下与当前部署同类型的文件（Hopline.js 或 obf_Hopline.js，按 IS_OBFUSCATED）；
// obf_Hopline.js 在 Hopline.js 更新后由 CI 另行提交，会比 Hopline.js 晚几十秒，这段时间内混淆部署检测不到新版本
const UPDATE_REPO = 'iv7777/Hopline';
const UPDATE_FILE = IS_OBFUSCATED ? 'obf_Hopline.js' : 'Hopline.js';
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
  // 部署文件顶部横幅：/*!Hopline vX.Y.Z*/，混淆文件为 /*!Hopline vX.Y.Z obfuscated:medium*/（混淆后 const VERSION 的写法不再可靠）
  const b = txt.match(/Hopline v(\d+\.\d+\.\d+)/);
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

