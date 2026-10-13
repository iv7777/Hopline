// ---------------------------------------------------------------------------
// 路由：节点路径上（已被面板配置好且启用时）的 WebSocket 升级与 XHTTP POST 进入代理；
// 控制入口（路径含由密钥派生的标记）交给 handleControl；其余一律返回伪装页
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    // HTTP → HTTPS（WebSocket 升级除外：明文端口节点 80/8080 等以 http 到达，重定向会让其永远无法连接）
    if (url.protocol === 'http:' && upgrade !== 'websocket') {
      return Response.redirect(url.href.replace('http://', 'https://'), 301);
    }
    const cfg = nodeConfig(env);
    // 必填的环境变量（PATH、NODE_KEY）缺失或非法：统一返回设置说明
    if (cfg._problems.length) {
      return new Response(cfg._problems.join('\n'), { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path === cfg.path) {
      // 只有节点路径上的连接才会读 NODE_KV 里的状态（伪装页请求不触发任何 KV 读取）
      const live = await loadNodeConfig(env, cfg);
      // 还没下发 UUID 或已被停用：和其它路径一样是伪装页
      if (!live.enabled || !live.uuids.length) return stubPage();
      if (upgrade === 'websocket') return handleWsProto(request, live);
      if (request.method === 'POST') {
        try { return await handleXhtProto(request, live); }
        catch (e) { return json({ ok: false, msg: 'xht 错误: ' + (e.message || e) }, 500); }
      }
    } else if (path.startsWith(cfg.path + '/') && path.slice(cfg.path.length + 1) === await routeTag(cfg.key)) {
      return handleControl(request, env, cfg);
    }
    return stubPage();
  }
};
