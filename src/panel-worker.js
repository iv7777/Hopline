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
// @include worker/version-panel.js
// @include worker/update.js
// @include worker/constants.js
// @include worker/cf-ranges.js
// @include worker/config-schema.js
// @include worker/utils.js
// @include worker/hashes.js
// @include worker/hmac.js
// @include worker/doh.js
// @include worker/config.js
// @include worker/proxy-client.js
// @include worker/proxies.js
// @include worker/proxies-api.js
// @include worker/ip-sources.js
// @include worker/nodes.js
// @include worker/formats.js
// @include worker/subscription.js
// @include worker/pages.js
// @include worker/router.js
