// ============================================================================
//  Hopline 代理 —— 只做一件事：在节点路径上接收 VLESS（WebSocket / XHTTP）并转发
//  ----------------------------------------------------------------------------
//  没有面板、登录、KV 与订阅生成；节点链接由 Hopline 面板脚本（Hopline-panel.js）生成，
//  面板只需要本脚本的 域名、UUID 与路径，两者之间没有任何运行时联系。
//  所有设置都来自环境变量：
//    UUID             【必填】VLESS 用户 ID
//    PATH             【必填】节点路径（WebSocket / XHTTP 共用），如 mynode
//    EDGEIP          自定义反代/落地 IP（填写后作为固定出口优先使用；留空则直连失败时由地区反代兜底），格式 host 或 host:port
//    HOP_ADDR   出站代理（socks5:// / http:// / ss:// 或 host:port）
//    HOP_MODE    出站方式：留空 = 出站代理优先，失败后直连 ∥ 反代；no = 直连 ∥ 反代优先；only = 仅走出站代理
//    ALT_MODE       地区反代：builtin（默认，按 Worker 机房自动选地区）/ custom / off
//    ALT_REGION     builtin 的首选地区（HK US SG JP KR DE SE NL FI GB Oracle DigitalOcean Vultr Multacom；留空按机房自动选）
//    ALT_REGION2    builtin 的次选地区（同上；留空自动，none = 不使用）
//    ALT_CUSTOM     custom 的反代列表（最多 3 个 host[:port]，换行或逗号分隔）
//  VLESS 的 WebSocket 与 XHTTP 两种传输始终同时启用。
//  可选的服务绑定入口（RPC，不是 HTTP 路由，公网访问不到；见 proxy-router.js）：
//    NodeStatus   只读 status()：在线与否、版本、配置问题、非敏感的设置摘要
//    NodeControl  另加 getSettings() / setSettings() / resetSettings()：面板在线修改上面 7 项出站 / 地区反代设置
//  在线修改需要给代理单独绑定一个 KV 命名空间（绑定变量名 NODE_KV）；不绑定则一切只按环境变量。UUID 与 PATH 永远只来自环境变量。
// ============================================================================
import { connect } from 'cloudflare:sockets';
import { WorkerEntrypoint } from 'cloudflare:workers';

// @include worker/version-proxy.js
// @include worker/utils.js
// @include worker/cf-ranges.js
// @include worker/protocol.js
// @include worker/doh.js
// @include worker/outbound-proxies.js
// @include worker/relay.js
// @include worker/proxy.js
// @include worker/proxy-config.js
// @include worker/proxy-settings.js
// @include worker/proxy-router.js
