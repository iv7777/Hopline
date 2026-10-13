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
    const cfg = nodeConfig(env);
    // 必填项缺失或非法：没有 UUID / 路径就无法工作，统一返回设置说明
    if (cfg._problems.length) {
      return new Response(cfg._problems.join('\n'), { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path === cfg.path) {
      // 只有节点路径上的连接才会读 NODE_KV 里的在线设置（伪装页请求不触发任何 KV 读取）
      const live = await loadNodeConfig(env, cfg);
      if (upgrade === 'websocket') return handleWsProto(request, live);
      if (request.method === 'POST') {
        try { return await handleXhtProto(request, live); }
        catch (e) { return json({ ok: false, msg: 'xht 错误: ' + (e.message || e) }, 500); }
      }
    }
    return stubPage();
  }
};

// 面板 Worker 通过服务绑定调用的 RPC 入口，没有 HTTP 路由，公网访问不到：
//   NodeStatus   只读：status() 返回是否在线 / 版本 / 配置问题 / 非敏感的设置摘要（不含 UUID、路径、反代地址与出站代理的主机和密码）
//   NodeControl  在 NodeStatus 之上再加 getSettings() / setSettings() / resetSettings()：读写 7 项运行设置（见 proxy-settings.js）。
//                 getSettings() 会返回完整的设置值，包括出站代理里的用户名与密码——面板里需要显示并编辑它们；
//                 UUID 与 PATH 永远不在其中，也改不了。想让面板只读时，服务绑定的入口选 NodeStatus 即可
export class NodeStatus extends WorkerEntrypoint {
  async status() {
    const cfg = await loadNodeConfig(this.env);
    const out = cfg.hopAddr ? parseHopAddress(cfg.hopAddr) : null;
    return {
      ok: cfg._problems.length === 0,
      version: VERSION,
      problems: cfg._problems,
      control: this instanceof NodeControl,
      storage: !!nodeKv(this.env),
      settings: {
        edgeIP: !!cfg.edgeIP,
        hopAddr: out ? out.type : '',
        hopMode: cfg.hopMode,
        altMode: cfg.alt.mode,
        altRegion: cfg.alt.region,
        altRegion2: cfg.alt.region2,
        altCustom: cfg.alt.custom ? cfg.alt.custom.split('\n').length : 0,
      },
    };
  }
}
export class NodeControl extends NodeStatus {
  getSettings() { return getNodeSettings(this.env); }
  setSettings(patch) { return saveNodeSettings(this.env, patch); }
  resetSettings() { return resetNodeSettings(this.env); }
}
