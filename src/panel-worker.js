// ============================================================================
//  Hopline 面板 —— 管理面板 + 订阅生成 · 全新独立编写
//  ----------------------------------------------------------------------------
//  只负责「怎么连」：管理面板、登录、订阅生成（vless 链接 / Clash / Sing-box 等）。
//  代理本身是另一个脚本（Hopline-proxy.js），面板只需要它的 域名、UUID 与节点路径，两者之间没有任何运行时联系。
//  环境变量（必填 2 项，其余可选）：
//    PATH            【必填】面板与订阅的访问路径，如 mypanel（与代理的节点路径互相独立）
//    ADMIN           【必填】面板管理密码：未设置时面板与管理 API 一律禁用
//    ADMIN_USER      面板管理用户名（默认 admin；登录时与密码一起校验）
//    CONFIG_KV       KV 命名空间的绑定变量名：绑定后读取 / 保存图形化配置（保存面板设置必须绑定）
//    HOST            代理域名的默认值（节点 SNI / Host）；面板里填写后以面板为准
//    UUID            代理 UUID 的默认值（须与代理脚本的 UUID 相同）；面板里填写后以面板为准
//    NODE_PATH       代理节点路径的默认值（须与代理脚本的 PATH 相同）；面板里填写后以面板为准
//    ENABLE_ECH      设为 true/1 开启 ECH 加密
//    ALPN            自定义 ALPN 协商
//  服务绑定（可选）：
//    PROXY           指向代理 Worker、入口（entrypoint）为 ProxyStatus 的服务绑定；绑定后面板的「运行状态」显示代理是否在线与版本
// ============================================================================
// @include worker/version.js
// @include worker/update.js
// @include worker/constants.js
// @include worker/cf-ranges.js
// @include worker/config-schema.js
// @include worker/utils.js
// @include worker/hashes.js
// @include worker/doh.js
// @include worker/config.js
// @include worker/ip-sources.js
// @include worker/nodes.js
// @include worker/formats.js
// @include worker/subscription.js
// @include worker/pages.js
// @include worker/router.js
