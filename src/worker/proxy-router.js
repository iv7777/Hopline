// ---------------------------------------------------------------------------
// 路由：只有节点路径上的 WebSocket 升级与 XHTTP POST 会进入代理，其余一律返回伪装页
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    // HTTP → HTTPS（WebSocket 升级除外：明文端口节点 80/8080 等以 http 到达，重定向会让其永远无法连接）
    if (url.protocol === 'http:' && upgrade !== 'websocket') {
      return Response.redirect(url.href.replace('http://', 'https://'), 301);
    }
    const cfg = proxyConfig(env);
    // 必填项缺失或非法：没有 UUID / 路径就无法工作，统一返回设置说明
    if (cfg._problems.length) {
      return new Response(cfg._problems.join('\n'), { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path === cfg.path) {
      if (upgrade === 'websocket') return handleWebSocketProxy(request, cfg);
      if (request.method === 'POST') {
        try { return await handleXhttpProxy(request, cfg); }
        catch (e) { return json({ ok: false, msg: 'xhttp 代理错误: ' + (e.message || e) }, 500); }
      }
    }
    return helloPage();
  }
};

// 只读状态入口：面板 Worker 通过服务绑定（入口名 ProxyStatus）调用 status()，没有 HTTP 路由，公网访问不到。
// 只返回「是否在线 / 版本 / 配置问题 / 非敏感的设置摘要」，绝不返回 UUID、路径、反代地址或出站代理的主机与密码
export class ProxyStatus extends WorkerEntrypoint {
  async status() {
    const cfg = proxyConfig(this.env);
    const out = cfg.outboundProxy ? parseProxyAddress(cfg.outboundProxy) : null;
    return {
      ok: cfg._problems.length === 0,
      version: VERSION,
      problems: cfg._problems,
      settings: {
        proxyIP: !!cfg.proxyIP,
        outboundProxy: out ? out.type : '',
        outboundMode: cfg.outboundMode,
        relayMode: cfg.relay.mode,
        relayRegion: cfg.relay.region,
        relayRegion2: cfg.relay.region2,
        relayCustom: cfg.relay.custom ? cfg.relay.custom.split('\n').length : 0,
      },
    };
  }
}
