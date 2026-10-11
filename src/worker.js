// ============================================================================
//  Hopline —— 代理订阅面板 · 全新独立编写
//  ----------------------------------------------------------------------------
//  环境变量（必填 2 项，其余可选；旧版短变量名 U / D / S / K / ECH 仍然兼容）：
//    PATH            【必填】面板、订阅与节点（WebSocket / XHTTP）共用的访问路径，如 mypanel（旧名 D）
//    ADMIN           【必填】面板管理密码：未设置时面板与管理 API 一律禁用
//    UUID            VLESS 用户 ID（旧名 U）：留空则首次访问时随机生成并保存到 KV（未绑定 KV 时必须设置）
//    ADMIN_USER      面板管理用户名（默认 admin；登录时与密码一起校验）
//    HOST            自定义 SNI/Host（默认使用访问所用的域名）
//    PROXYIP         自定义反代/落地 IP（填写后作为固定出口优先使用；留空则直连失败时由地区反代兜底（面板可配置），格式 host 或 host:port）
//    OUTBOUND_PROXY  出站代理（socks5:// / http:// / ss:// 或 host:port；旧名 OUTBOUND、S）
//    ENABLE_ECH      设为 true/1 开启 ECH 加密（旧名 ECH）
//    ALPN            自定义 ALPN 协商
//    CONFIG_KV       KV 命名空间的绑定变量名（旧名 K）：绑定后读取 / 保存图形化配置
// ============================================================================
import { connect } from 'cloudflare:sockets';

// @include worker/update.js
// @include worker/constants.js
// @include worker/config-schema.js
// @include worker/utils.js
// @include worker/config.js
// @include worker/protocol.js
// @include worker/outbound-proxies.js
// @include worker/relay.js
// @include worker/proxy.js
// @include worker/ip-sources.js
// @include worker/nodes.js
// @include worker/formats.js
// @include worker/subscription.js
// @include worker/pages.js
// @include worker/asset-loader.js
// @include worker/router.js
