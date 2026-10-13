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
      // 只有节点路径上的连接才会读 PROXY_KV 里的在线设置（伪装页请求不触发任何 KV 读取）
      const live = await loadProxyConfig(env, cfg);
      if (upgrade === 'websocket') return handleWebSocketProxy(request, live);
      if (request.method === 'POST') {
        try { return await handleXhttpProxy(request, live); }
        catch (e) { return json({ ok: false, msg: 'xhttp 代理错误: ' + (e.message || e) }, 500); }
      }
    }
    return helloPage();
  }
};

// 面板 Worker 通过服务绑定调用的 RPC 入口，没有 HTTP 路由，公网访问不到：
//   ProxyStatus   只读：status() 返回是否在线 / 版本 / 配置问题 / 非敏感的设置摘要（不含 UUID、路径、反代地址与出站代理的主机和密码）
//   ProxyControl  在 ProxyStatus 之上再加 getSettings() / setSettings() / resetSettings()：读写 7 项运行设置（见 proxy-settings.js）。
//                 getSettings() 会返回完整的设置值，包括出站代理里的用户名与密码——面板里需要显示并编辑它们；
//                 UUID 与 PATH 永远不在其中，也改不了。想让面板只读时，服务绑定的入口选 ProxyStatus 即可
export class ProxyStatus extends WorkerEntrypoint {
  async status() {
    const cfg = await loadProxyConfig(this.env);
    const out = cfg.outboundProxy ? parseProxyAddress(cfg.outboundProxy) : null;
    return {
      ok: cfg._problems.length === 0,
      version: VERSION,
      problems: cfg._problems,
      control: this instanceof ProxyControl,
      storage: !!proxyKv(this.env),
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
export class ProxyControl extends ProxyStatus {
  getSettings() { return getProxySettings(this.env); }
  setSettings(patch) { return saveProxySettings(this.env, patch); }
  resetSettings() { return resetProxySettings(this.env); }
}
