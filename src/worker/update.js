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

