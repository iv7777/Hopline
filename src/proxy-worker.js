// ============================================================================
//  Hopline 代理 —— 只做一件事：在节点路径上接收 VLESS（WebSocket / XHTTP）并转发
//  ----------------------------------------------------------------------------
//  没有面板、登录、KV 与订阅生成；节点链接由 Hopline 面板脚本（Hopline-panel.js）生成，
//  面板只需要本脚本的 域名、PATH 与 NODE_KEY：UUID 由面板生成并下发给代理。
//  环境变量只有两项必填（其余设置、UUID 与启用开关都由面板在线下发，保存在 NODE_KV 里）：
//    PATH       【必填】节点路径（WebSocket / XHTTP 共用），如 mynode
//    NODE_KEY   【必填】控制密钥（至少 24 位随机字符，面板里可以生成）：面板用它给控制请求签名
//  绑定：
//    NODE_KV    【面板配置必需】代理自己的 KV 命名空间（单独建一个，只有代理绑定）：保存 UUID、启用开关与运行设置
//  面板还没下发 UUID 或代理被停用时，节点路径与其它任何路径一样只返回伪装页。
//  运行设置也可以用环境变量给出默认值（面板里保存的设置优先）：
//    EDGEIP / HOP_ADDR / HOP_MODE / ALT_MODE / ALT_REGION / ALT_REGION2 / ALT_CUSTOM（含义见 proxy-config.js）
//  VLESS 的 WebSocket 与 XHTTP 两种传输始终同时启用。
//  控制接口是签名的 HTTPS 请求（POST /<PATH>/<由密钥派生的标记>），面板与代理可以在不同账号里；见 proxy-control.js。
// ============================================================================
import { connect } from 'cloudflare:sockets';

// @include worker/version-proxy.js
// @include worker/utils.js
// @include worker/hmac.js
// @include worker/cf-ranges.js
// @include worker/protocol.js
// @include worker/doh.js
// @include worker/outbound-proxies.js
// @include worker/relay.js
// @include worker/proxy.js
// @include worker/proxy-config.js
// @include worker/proxy-settings.js
// @include worker/proxy-control.js
// @include worker/proxy-router.js
