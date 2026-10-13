# Hopline · 代理 + 订阅面板

> **Hopline —— 部署在 Cloudflare Workers / Pages 的 VLESS / XHTTP 代理与订阅面板，拆成两个互相独立的脚本**：
> - **`Hopline-proxy.js`（代理）**：只做一件事——在节点路径上接收 VLESS（WebSocket / XHTTP）并转发；所有设置来自环境变量，没有面板、登录、KV 与订阅；内置落地 / 出站代理与可配置的地区反代。
> - **`Hopline-panel.js`（面板 + 订阅）**：图形化面板与订阅生成——优选域名与在线优选 IP 来源、ECH 加密、地区 / 运营商 / IP 版本多维筛选，输出 Clash / Sing-box 等各客户端格式；面板页面与 Clash 模板都内嵌在脚本里。
>
> 面板与代理之间**没有任何运行时联系**：面板只需要代理的**域名、UUID 与节点路径**三项就能生成节点链接。

---

## 一、功能概览

| 脚本 | 功能 | 说明 |
|---|---|---|
| 代理 | **多协议** | VLESS 的 WebSocket 与 XHTTP 两种传输始终同时启用，没有开关 |
| 代理 | **落地与出站** | 反代 / 落地 IP（填写后作为固定出口优先使用）+ 出站代理（SOCKS5 / HTTP(S) / Shadowsocks）+ 出站模式（默认 / 直连优先 / 仅走代理）；直连与出站都不通时由地区反代兜底 |
| 代理 | **地区反代** | 直连不通时使用：内置（按 Worker 机房自动选，可固定首选 / 次选地区）/ 仅使用自己的反代列表 / 关闭 |
| 代理 | **路径伪装** | 只有节点路径上的 WebSocket 升级与 XHTTP POST 进入代理，其余一律返回 `Hello World !` 页面 |
| 面板 | **图形化面板** | 仪表盘 / 节点配置 / 优选配置 / 面板设置 / 关于项目，保存即生效，主题默认跟随系统，也可一键切换日间 / 夜间（见「四、面板使用」） |
| 面板 | **代理端点** | 在「面板设置」填入代理的域名、UUID 与节点路径，订阅里的节点就指向它 |
| 面板 | **协议下发** | VLESS / XHTTP 两种节点各自独立开关，决定订阅里下发哪些节点（代理本身始终两种都接受） |
| 面板 | **地址来源** | 原生地址、优选域名、在线优选 IP（HostMonit / uouin / 微测网 / 自定义 API），各自独立开关（见「五、地址来源与优选」） |
| 面板 | **地区与筛选** | 地区（全部 / 香港 / 台湾 / 美国 / 新加坡 / 日本 / 韩国 / 德国）+ IP 版本（IPv4 / IPv6）+ 运营商（移动 / 联通 / 电信）组合筛选；只剔除名称明确标记为未选项的节点，通用节点保留；筛选后为空时按 运营商 → IP 类型 → 地区 逐级放宽 |
| 面板 | **ECH 加密** | 自定义 ECH 域名 / ECH DNS（DoH），开启后自动进入仅 TLS 节点模式；链接类订阅与 Clash 订阅带 ECH 参数，Sing-box / Surge / Loon / Quantumult X 订阅不含 ECH |
| 面板 | **多客户端** | Clash / Mihomo、Sing-box、Surge、Loon、Quantumult X、v2rayN / Shadowrocket / Nekoray 等链接类客户端、Stash，按 UA 自动识别；订阅地址追加 `/clash`、`/stash`（同为 Clash 配置）、`/singbox`、`/surge`、`/loon`、`/quanx`、`/v2ray`、`/plain` 等后缀可强制指定格式 |
| 面板 | **安全** | 加盐摘要的管理密码、登录限速、会话自动失效、安全响应头、路径伪装（见「六、性能与安全」） |

### 节点下发规则

- **来源**：节点全部来自「原生地址（默认关）+ 优选域名 + 在线优选 IP」，IP 一律只保留 Cloudflare 段地址，不生成随机 IP，也不内置静态 IP 池
- **端口**：默认只下发 TLS 端口节点（「节点配置 → 仅 TLS 端口」）；关闭后每个 443 节点另追加一个 80 明文节点（名称带「·80」），来源自带的 8080 / 2052 等明文端口原样下发；自定义域名使用明文节点需在 Cloudflare 关闭「始终使用 HTTPS」；开启 ECH 时始终只下发 TLS 端口节点
- **XHTTP**：只出现在链接类与 Clash 订阅中；Sing-box / Surge / Loon / Quantumult X 没有 XHTTP 传输，一律不含。官方 sing-box 内核同样不支持 XHTTP
- **Sing-box**：生成 sing-box 1.12+ 格式配置（二进制 .srs 规则集经 jsDelivr 下载）；GUI.for.SingBox 请用其「导入 sing-box 配置」插件导入订阅
- **数量**：单次订阅最多 500 个节点（按免费计划 10ms CPU 限制设定），来源不足时按实际数量下发，不补足；不做轮询换新，来源数据不变时每次下发相同的节点

---

## 二、快速部署

> 全程约 10 分钟，需要两个文件（仓库根目录，已是构建好的成品，直接使用）：**[`Hopline-proxy.js`](https://raw.githubusercontent.com/iv7777/Hopline/main/Hopline-proxy.js)**（代理）和 **[`Hopline-panel.js`](https://raw.githubusercontent.com/iv7777/Hopline/main/Hopline-panel.js)**（面板）。两者各部署成一个独立的 Worker，可以放在同一个或不同的 Cloudflare 账号里。面板页面与 Clash 配置模板都内嵌在 `Hopline-panel.js` 里，运行时不需要访问 GitHub / jsDelivr。代理脚本另有混淆版 `obf_Hopline-proxy.js`（面板脚本没有混淆版）。

### 2.1 准备

- 一个 Cloudflare 账号（Workers / Pages）
- （推荐）一个自己的域名：`*.workers.dev` 域名可能被限制访问，且 XHTTP 协议要求**代理**绑定自定义域名

### 2.2 部署代理（`Hopline-proxy.js`）

1. 登录 Cloudflare 控制台 → **Workers 和 Pages** → **新建 Worker**，先用默认模板部署
2. 点「编辑代码」，**删除全部默认内容**，把 `Hopline-proxy.js` 全文粘贴进去，点「部署」
3. 进入该 Worker 的 **设置 → 变量**，添加两个**必填**变量：

   | 变量 | 填什么 |
   |---|---|
   | `UUID` | 节点用户 ID，形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`（面板里可以点「生成」得到一个） |
   | `PATH` | 节点路径，如 `mynode`（只能含字母、数字及 `. _ ~ -`） |

   落地 / 出站 / 地区反代等可选变量见「3.1 代理脚本的环境变量」。
4. （推荐）在该 Worker 的 **Domains & Routes**（域和路由）里添加你的自定义域名（DNS 由 Cloudflare 托管时证书自动签发）。**这个域名就是面板里要填的「代理域名」**
5. 代理没有任何页面：访问根路径和任何未知路径都只显示 `Hello World !`；`UUID` 或 `PATH` 缺失 / 不合法时所有请求返回 503 设置说明

### 2.3 部署面板（`Hopline-panel.js`）

1. 同样新建一个 Worker，粘贴 `Hopline-panel.js` 全文并部署
2. 在 **设置 → 变量** 添加两个**必填**变量：

   | 变量 | 填什么 |
   |---|---|
   | `PATH` | 面板与订阅的访问路径，如 `mypanel`（只能含字母、数字及 `. _ ~ -`，不能是 `login`、`version`）。与代理的节点路径互相独立 |
   | `ADMIN` | 管理密码（建议设为加密 / Secret 类型） |

3. 创建一个 **KV 命名空间**，在面板 Worker 里绑定，**变量名必须是 `CONFIG_KV`**。不绑定 KV 的话面板无法保存配置
4. （可选）给面板 Worker 也添加自定义域名
5. 访问 `https://面板域名/<PATH>`，用用户名 `admin`（默认）和 `ADMIN` 密码登录

### 2.4 填写代理端点

登录面板后，在 **面板设置 → 代理端点** 填入代理脚本的三项（也可以用面板 Worker 的环境变量 `HOST` / `UUID` / `NODE_PATH` 提供默认值）：

| 面板里的字段 | 对应代理的 | 说明 |
|---|---|---|
| 代理域名 | 代理 Worker 的自定义域名 | 节点的 SNI / Host |
| 代理 UUID | 环境变量 `UUID` | 必须一致 |
| 代理节点路径 | 环境变量 `PATH` | 必须一致 |

三项没填全时，面板顶部会提示，订阅与预览返回「请先在面板『代理端点』里填写…」。填好后点「保存全部」，在 **仪表盘 → 订阅地址** 复制对应客户端的订阅链接并导入；再到 **优选配置** 里按需开关优选 IP 来源、编辑优选域名。

| 入口 | 地址 | 说明 |
|---|---|---|
| 面板 | `https://面板域名/<PATH>` | 需登录（用户名 + 密码）；`PATH` 未设置或格式不对时所有请求返回设置说明（503）；未设置 `ADMIN` 时面板提示「已禁用」 |
| 订阅 | `https://面板域名/<代理 UUID>/sub` | 按客户端 UA 自动识别格式；追加后缀强制指定，如 `/sub/clash`、`/sub/singbox`；也可以用「自定义订阅路径」别名 |
| 配置 API | `https://面板域名/<PATH>/api/config` | GET 读取 / POST 保存，支持只提交部分字段；需登录 |
| 节点 | `wss://代理域名/<节点路径>` | 由代理处理，面板只负责生成指向它的链接 |

### 2.5 Pages 部署（可选）

1. 控制台 → Workers 和 Pages → 新建 **Pages 项目**（直接上传）
2. 上传目录里放入对应脚本，框架选「无」；Pages 的高级模式要求文件名为 **`_worker.js`**，上传时请改名
3. 在 Pages 设置里添加对应脚本的环境变量；面板还需绑定 KV（变量名 `CONFIG_KV`）

### 2.6 更新

1. 取最新的脚本，**覆盖粘贴**到对应的 Worker 里并部署；环境变量与 KV 里的配置原样保留，无需重新设置。两个脚本之间只通过 `vless://` 链接联系，没有版本兼容问题，可以分别更新；代理脚本很少需要更新
2. 面板里点击版本号可检测更新：读取仓库 `main` 分支的 `Hopline-panel.js` 比对版本号，有新版本时把它的内容复制到剪贴板（只检测面板脚本，代理脚本没有面板，也不暴露版本）

### 2.7 从 2.x（一体版）升级

2.x 的 `Hopline.js` 已不再提供。推荐的升级方式不需要客户端做任何改动：

1. **先在旧面板里记下 UUID**（如果 `UUID` 是自动生成、只存在于 KV 里，升级后就看不到了），并记下旧的出站 / 落地 / 地区反代设置
2. 把原来那个 Worker 的代码**换成 `Hopline-proxy.js`**，保留它的 `UUID`、`PATH` 和域名；把旧面板里设置过的 `proxyIP` / 出站代理 / 出站方式 / 地区反代设置改成对应的环境变量（见 3.1）。这样现有节点原样继续工作
3. **新建一个 Worker 部署 `Hopline-panel.js`**，设置 `PATH` 与 `ADMIN`；可以绑定旧的 KV 命名空间，管理密码、用户名与优选 / 筛选 / ECH 等设置会原样保留（旧 KV 里的出站 / 地区反代字段会被忽略）；旧 KV 里的 UUID 与「绑定域名」也会直接成为面板里的代理 UUID 与代理域名
4. 在新面板里补全代理端点（旧域名、旧 UUID、旧 `PATH` 作为「代理节点路径」），保存
5. 订阅地址变成了新面板的地址，客户端需要重新添加一次订阅

### 2.8 常见问题

| 现象 | 原因与处理 |
|---|---|
| 页面只显示 `Hello World !` | 访问路径不对。面板入口必须是 `https://面板域名/<PATH>`；代理上除节点路径外的任何路径都显示这个页面 |
| 所有请求返回「设置说明」（503） | 面板：`PATH` 没设置或格式不对；代理：`UUID` 或 `PATH` 没设置或格式不对，按提示修改后重新访问 |
| 面板提示「已禁用」 | 没有设置 `ADMIN` |
| 保存时报错 / 无法保存 | 面板没有绑定 KV，变量名必须是 `CONFIG_KV` |
| 面板顶部提示「尚未填写代理端点」 / 订阅返回 400 | 到「面板设置 → 代理端点」填好代理域名、UUID 与节点路径并保存 |
| 节点连不上 | 检查面板里的代理域名、代理 UUID、代理节点路径是否与代理脚本的域名、`UUID`、`PATH` 完全一致 |
| 客户端更新订阅提示「无效订阅」 | `*.workers.dev` 域名可能被限制，给面板绑定自定义域名，或让客户端通过代理更新订阅 |
| 登录后过一段时间被退出 | 24 小时未使用面板自动退出，最长 7 天需重新登录 |
| 改了代理的 `PATH` 后节点连不上 | 同步修改面板里的「代理节点路径」，客户端重新更新订阅 |

---

## 三、环境变量与配置项

### 3.1 代理脚本（`Hopline-proxy.js`）的环境变量

> 代理只读环境变量，没有 KV、没有面板：改完变量重新部署（或在控制台保存变量）即生效。**必填只有 `UUID` 与 `PATH`**。未设置的可选项取下表默认值，行为与 2.x 版面板里的默认设置完全一致；无效取值按默认值处理。VLESS 的 WebSocket 与 XHTTP 两种传输始终同时启用。

| 变量 | 值 | 说明 |
|---|---|---|
| `UUID` | 你的 UUID | **必需**，VLESS 用户 ID（节点身份），不再自动生成。面板里「代理 UUID」必须与它一致 |
| `PATH` | 节点路径 | **必需**，WebSocket / XHTTP 共用此路径；只能含字母、数字及 `. _ ~ -`，最长 128 位，首尾的 `/` 自动去掉。面板里「代理节点路径」必须与它一致 |
| `PROXYIP` | `host` 或 `host:port` | 反代 / 落地 IP：填写后作为固定出口优先使用；留空则直连失败后由地区反代兜底 |
| `OUTBOUND_PROXY` | `socks5://` / `http(s)://` / `ss://` 地址，或 `user:pass@host:port` | 出站代理（SOCKS5 / HTTP(S) / Shadowsocks）；SS 加密支持 aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305 |
| `OUTBOUND_MODE` | 留空 / `no` / `only` | 出站方式：留空（默认）= 出站代理优先，失败后直连 ∥ 反代；`no` = 直连 ∥ 反代优先，都不通时最后用出站代理；`only` = 仅走出站代理（失败用地区反代兜底，地区反代为 `off` 时不兜底）。未填出站代理时三种方式都按直连处理 |
| `RELAY_MODE` | `builtin` / `custom` / `off` | 地区反代：`builtin`（默认）= 内置 proxyip.\*.cmliussss.net，按 Worker 机房自动选地区；`custom` = 只用 `RELAY_CUSTOM`；`off` = 不使用，只直连 / 出站代理 |
| `RELAY_REGION` | `HK` `US` `SG` `JP` `KR` `DE` `SE` `NL` `FI` `GB` `Oracle` `DigitalOcean` `Vultr` `Multacom` | `builtin` 的首选地区（取 2 个 IP）；留空按机房自动选，不区分大小写 |
| `RELAY_REGION2` | 同上，或 `none` | `builtin` 的次选地区（取 1 个 IP）；留空 = 默认的另一地区（首选为 HK 时用 US，否则用 HK），`none` = 只用首选 |
| `RELAY_CUSTOM` | 最多 3 个 `host[:port]` | `custom` 的反代列表，换行或逗号分隔，IPv6 需加方括号；第一个取 2 个 IP，其余各取 1 个。「反代 / 落地 IP」仍然优先于这里 |

> 之前的 `HOST`、`ENABLE_ECH`、`ALPN`、`ADMIN`、`ADMIN_USER`、`CONFIG_KV` 等变量属于面板，代理不读取。

### 3.2 面板脚本（`Hopline-panel.js`）的环境变量

> 优先级：**KV 配置 > 环境变量 > 默认值**。环境变量只在面板里没有改成别的值时生效：面板保存时，与环境变量相同的值不会写入 KV（之后修改环境变量立即生效），改成不同的值才保存为覆盖。`PATH`、`ADMIN`、`ADMIN_USER` 设置后在面板中只读。**必填只有 `PATH` 与 `ADMIN` 两项**。

| 变量 | 值 | 说明 |
|---|---|---|
| `PATH` | 访问路径 | **必需**。面板与订阅（`/<PATH>/sub`）的访问路径；只能含字母、数字及 `. _ ~ -`，不能是 `login`、`version`；首尾的 `/` 自动去掉。**与代理的节点路径互相独立** |
| `ADMIN` | 管理密码 | **必需**，未设置时面板与管理接口一律禁用 |
| `ADMIN_USER` | 管理用户名 | 可选，登录时与密码一起校验（区分大小写），默认 `admin` |
| `CONFIG_KV` | KV 命名空间绑定 | 可选（推荐），在 Worker / Pages 设置里绑定 KV 命名空间时使用的变量名；绑定后面板配置才能保存 |
| `HOST` | 代理域名 | 可选，「代理域名」的默认值（节点 SNI / Host）；面板里填写后以面板为准，面板里留空则回退到这里 |
| `UUID` | 代理 UUID | 可选，「代理 UUID」的默认值，须与代理脚本的 `UUID` 相同；同样以面板为准、留空回退。面板不再自动生成 UUID |
| `NODE_PATH` | 代理节点路径 | 可选，「代理节点路径」的默认值，须与代理脚本的 `PATH` 相同；同样以面板为准、留空回退 |
| `ENABLE_ECH` | true / 1 | 启用 ECH 加密客户端握手（开启后自动仅 TLS 端口） |
| `ALPN` | h2 / http/1.1 | ALPN 协商（逗号分隔），VLESS / XHTTP 链接、Clash、Sing-box 均按此下发；留空时 ws 用 http/1.1、XHTTP 用 h2 |

### 3.3 面板配置项（保存于 KV，也是 `/api/config` 的字段名）

> 完整字段、默认值与校验规则以 `src/worker/config-schema.js` 中的 `CONFIG_SCHEMA` 为准。保存时逐项校验，未登记的字段会被忽略（旧版本留在 KV 里的 `proxyIP` / `outboundProxy` / `outboundMode` / `relay.*` 即属此类）。嵌套字段用 `a.b` 表示，接口里是 `{ "a": { "b": … } }`。

| 配置项 | 说明 |
|---|---|
| `host` / `uuid` / `nodePath` | 代理端点：代理域名（节点 SNI / Host）/ 代理 UUID / 代理节点路径；三项都有值（面板或环境变量）才能生成订阅，`/api/config` 返回的 `endpointMissing` 列出还缺哪几项 |
| `adminUser` / `admin` | 管理用户名 / 管理密码（同环境变量，面板可视化编辑；`admin` 只写不回显） |
| `subUrl` | 自定义订阅路径：`/<别名>/sub` 输出订阅（别名下不开放面板与管理接口）；留空为 `/<代理 UUID>/sub`。面板路径下的 `/sub` 始终可用 |
| `enableVless` / `enableXhttp` | 订阅里是否下发 VLESS / XHTTP 节点（默认均开；只是下发开关，代理始终两种都接受） |
| `alpn` / `tlsOnly` | ALPN 协商 / 仅 TLS 端口节点（默认开启；关闭后 443 节点追加 80 明文节点） |
| `ech` / `echHost` / `echDns` | ECH 开关 / 自定义 ECH 域名 / ECH DoH |
| `filter.region` | 地区（多选数组）：`['all']` 或 HK / TW / US / SG / JP / KR / DE 的组合 |
| `filter.ipType` | IP 版本：IPv4 / IPv6（默认只有 IPv4） |
| `filter.isp` | 运营商：移动 / 联通 / 电信 |
| `src.native` / `src.prefDomain` / `src.prefIp` | 地址来源：原生地址 / 优选域名 / 优选 IP |
| `ipsrc.hostmonit` / `ipsrc.uouin` / `ipsrc.wetest` / `ipsrc.api1` / `ipsrc.api1Url` / `ipsrc.api2` / `ipsrc.api2Url` | 优选 IP 来源开关（HostMonit / uouin / 微测网 / 自定义 API 1 / 2）与两个自定义 API 地址（默认：HostMonit 开、uouin 开、微测网关、自定义 API 关；开启 API 但未填地址时保存会报错） |
| `prefDomains` | 优选域名：每行一个纯主机名（最多 30 个），**整体替换**内置的 14 个域名；留空使用内置列表 |

---

## 四、面板使用

| 视图 | 说明 |
|---|---|
| **仪表盘** | 快速开始、订阅地址（格式选择 / 复制 / 二维码 / 下载 / 预览）、地区与线路筛选、运行状态 |
| **节点配置** | 下发哪些协议的节点（VLESS / XHTTP）、TLS 与 ALPN、ECH |
| **优选配置** | 优选域名（自定义 / 内置列表、测试）、优选 IP 来源（HostMonit / uouin / 微测网 / 自定义优选 API 1 / 2）及各来源的「测试」按钮 |
| **面板设置** | 代理端点（代理域名 / 代理 UUID / 代理节点路径）、面板路径（由环境变量 `PATH` 提供，只读）/ 订阅路径别名 / 管理用户名 / 管理密码、配置导出导入、退出登录、重置 |
| **关于项目** | 调用的外部接口清单 |

- 所有修改点右下角「保存全部」后写入 KV；保存前后都会逐项校验，出错的字段就地标红并给出原因
- 修改管理密码 / 管理用户名后当前浏览器保持登录；代理端点与登录无关，改了不影响登录状态
- 订阅预览与客户端实际订阅走同一流程，显示真实节点数；预览分「节点列表」（逐个节点可单独复制链接或查看二维码，单个节点不随订阅更新）与「原始内容」
- 「代理域名」仅用于订阅节点的主机名（XHTTP 要求**代理**绑定自定义域名），不负责域名解析；域名需先在 Cloudflare 控制台为对应的 Worker 添加
- 「落地与出站」「内置地区反代」不在面板里：它们属于代理脚本，用环境变量设置（见 3.1）

---

## 五、地址来源与优选

### 5.1 地址来源

默认节点池由「仪表盘 → 地址来源」三项组装：

| 来源 | 说明 |
|---|---|
| **原生地址**（默认关） | 代理域名直接作为节点下发 |
| **优选域名**（默认开） | 直接下发域名，客户端连接时自行解析到当前最优的 Cloudflare 边缘 IP；列表可在「优选配置 → 优选域名」自定义（整体替换内置列表，留空用内置的 14 个）。IPv6 解析：同时勾选 IPv4 与 IPv6 时只解析前 12 个域名，仅 IPv6 时前 25 个 |
| **优选 IP**（默认开） | 「优选配置 → 优选 IP 来源」中开启的在线来源，见下表 |

所有来源都没有产出时用官方域名（cloudflare.com 等）兜底，订阅不会为空。

### 5.2 在线优选 IP 来源

| 来源 | 默认 | 说明 | 节点名示例 |
|---|---|---|---|
| 自定义优选 API 1 / 2 | 关 | 填写返回 IP 列表的地址（纯 IP 行 / CSV / HTML 线路表 / base64 订阅 / `sub://`，行内可写 `IP:端口#名称`）；开启但未填地址时保存会报错 | 数据行里的名称原样保留 |
| HostMonit（`api.hostmonit.com`） | 开 | 分运营商实测的实时优选；接口失效时沿用上次结果，由其它来源兜底 | 移动-01 / 联通-01 / 电信-01 |
| uouin（`api.uouin.com`） | 开 | 电信 / 联通 / 移动 / 多线 / IPv6 各约 10 个 IP。使用的是对方网站的内部接口（非开放 API，签名模仿其网站前端），对方可能随时更换签名或封禁，届时静默失效 | 电信-U01 |
| 微测网（`wetest.vip` 公开页面） | 关 | IPv4 / IPv6 各一页，移动 / 联通 / 电信各 5 个 IP，约每 15 分钟更新；是 HTML 表格而非开放 API，版式变化时静默失效；只拉取所选 IP 类型对应的页面 | 移动-W01 / 移动-W6-01 |

- 排列顺序：自定义 API 1 / 2 → HostMonit → uouin → 微测网
- 结果缓存 10 分钟（绑定自定义域名时，同一机房的实例通过 Cache API 共享缓存；workers.dev 下 Cache API 不生效，各实例各自缓存），缓存未命中时每个开启的来源占用 1 个子请求
- 所有来源一律只保留 Cloudflare 段 IP，其余丢弃：非 CF 段的第三方中转 IP 可获知部署域名与连接元数据，无法作为入口

### 5.3 节点命名与地区

- 同时开启多种协议时，同一地址的 XHTTP 节点名加「.X」（VLESS 保持原名）；不同地址同名时依次加「·2」「·3」，所有格式的节点名唯一
- 优选域名节点命名为「优选域名-XX」；优选 IP 来源中无法确定地区的统一为「优选IP-XX」（IPv6 域名解析结果为「优选IP-V6-XX」）；数据源自定义名称（如 `JP-A-147`）原样保留
- 带地区标记的数据行（如「IP:端口#地区随机 \| 香港 HK」）显示中文地区名：香港 / 台湾 / 日本 / 美国 / 新加坡 / 韩国 / 德国
- 「节点地区」筛选只剔除名称明确标记为其它地区的节点。内置来源都是不带地区的 Cloudflare 任播 IP / 域名（落地机房取决于客户端网络），地区筛选通常不改变其节点构成；需要按地区挑选请让自定义优选 API 返回带地区名的来源

### 5.4 自己测速

面板不提供在线测速。请用本地测速工具在自己的网络下测速，把结果托管成一个地址（纯 IP 行 / CSV，行内可写 `IP:端口#名称`），填入「优选配置 → 优选 IP 来源」的自定义优选 API 1 / 2。

---

## 六、性能与安全

### 6.1 性能

- **低 CPU 的数据面**：XHTTP 数据由运行时原生管道转发（JS 只处理握手）；WebSocket 下行用 64KB 缓冲的 BYOB 读取，一次取走已到达的全部数据（最多 64KB）作为一条消息发出（读取次数约为默认读取的 1/16，每 MB CPU 约为原来的 1/5），并拒绝压缩，避免看视频时触发 `Worker exceeded CPU time limit`
- **DoH 与子请求预算**：优选域名解析 Cloudflare DoH 优先，仅当请求失败时降级阿里 DNS，正常每次解析只计 1 个子请求（代理侧的反代域名与 UDP DNS 解析同样 Cloudflare 优先、逐个降级，超过 0.7 秒未响应会提前并发下一个）；IPv4+IPv6 混合时只对前 12 个优选域名查询 AAAA。实测单次订阅约 14–20 个子请求，最坏（仅 IPv6、30 个自定义域名、全部来源开启）约 31 个，低于免费版上限 50
- **出站并发竞速**：直连与地区反代（内置或自定义，可用 `RELAY_MODE=off` 关闭）同时发起，取先握手成功的一路，败者连接立即释放；直连有 1.5s 优先窗口（可直连的站点不绕第三方反代）；目标为 Cloudflare IP 时不发直连、直接用反代；直连失败、由反代接通的站点会被记住 30 分钟，之后直接走反代（不再发直连、不查 DNS）。目标站在 Cloudflare 上时不再白等约 6 秒；出站模式（默认 / 直连优先 / 仅走代理）决定出站代理与直连、反代的先后
- **首包判定**：地区反代与「反代 / 落地 IP」只能转发 TLS 流量（按 SNI 路由），非 TLS 首包（Telegram MTProto、明文 HTTP 等）只走直连与出站代理
- **WS 0-RTT 早数据**：TLS WebSocket 节点带 `?ed=2048`（Sing-box 用 `max_early_data`），客户端把首包放进握手请求头，服务端握手时即建连，省约 1 个往返；早数据校验不通过时按普通连接处理
- **VLESS 响应头提前下发**：头部解析成功即回 2 字节响应头，首包等待上限 80ms，避免与部分客户端（mihomo 等）互相等待
- **SWR 容灾缓存**：外部优选源拉取失败时沿用上一轮有效结果（10 分钟缓存；绑定自定义域名时同一机房共享）

### 6.2 安全

- **管理登录**：必须设置 `ADMIN`，以用户名 + 密码登录（任一错误都只提示「用户名或密码错误」）；KV 中的密码保存为加盐 PBKDF2 摘要（环境变量 `ADMIN` 本身是明文）；登录失败 15 分钟内最多 5 次，IPv6 按 /64 计数
- **会话**：24 小时无操作失效（使用时自动顺延，最长 7 天），可在「面板设置」退出；修改管理密码或用户名会使其它浏览器的登录状态全部失效（代理端点与登录无关）
- **页面安全头**：面板与登录页带 CSP、`X-Frame-Options`、`nosniff`、`Referrer-Policy`；二维码脚本带 SRI 校验
- **内嵌页面**：面板页面、登录页与 Clash 模板都内嵌在 `Hopline-panel.js` 里，运行时不从 GitHub / jsDelivr 拉取任何代码或页面，没有第三方内容被当作页面执行（浏览器只加载带 SRI 校验的二维码脚本）
- **路径与 UUID 鉴权**：面板脚本里请求路径与 `PATH` 一致才进入面板；代理脚本里请求路径与 `PATH` 一致才进入代理，VLESS 头部的 UUID 与 `UUID` 一致才转发；订阅别名路径只输出订阅
- **路径伪装**：路径不对（根路径、未知路由）时两个脚本都返回 200 的 `Hello World !` 页面，不暴露部署；面板的 `/login`、`/version` 只对知道面板路径的人可用，否则返回 404。代理上没有 `/login`、`/api`、`/sub` 等任何路由，也看不出它和面板有关
- **拆分带来的隔离**：代理脚本不含面板、登录、订阅与管理接口的任何代码，没有 KV，也不访问 GitHub；面板脚本不含任何代理代码（没有 `cloudflare:sockets`、WebSocket 与出站连接）。两者只通过 `vless://` 链接联系
- **Clash 本地凭据**：订阅里的 Shadowsocks 入站密码、认证与 API secret 按 UUID 为每个部署派生，不使用公开的默认密码
- **配置存储保护**：配置读取走 KV 边缘缓存（30 秒）；KV 读取失败或配置损坏时拒绝保存，面板与订阅按环境变量 + 默认值工作，避免用默认值覆盖已有配置

---

## 七、开发与构建

`Hopline-proxy.js` 与 `Hopline-panel.js` 是构建产物（部署时直接粘贴即可），源码位于 `src/`：

| 路径 | 内容 |
|---|---|
| `src/proxy-worker.js` | 代理入口：环境变量说明与 `// @include worker/xxx.js` 清单，构建时按顺序拼接成 `Hopline-proxy.js` |
| `src/panel-worker.js` | 面板入口：同上，拼接成 `Hopline-panel.js` |
| `src/worker/*.js` | 按主题拆分的逻辑。**代理专用**：`protocol`（VLESS 头、UDP DNS→DoH）、`outbound-proxies` / `relay`（出站与反代）、`proxy`（WS / XHTTP）、`proxy-config`（环境变量配置）、`proxy-router`（路由）；**面板专用**：`config-schema`（字段表 `CONFIG_SCHEMA`）、`config`（加载 / 保存）、`ip-sources` / `nodes`（优选来源与节点生成）、`formats`（各客户端格式）、`subscription`、`pages`（内嵌页面）、`router`（鉴权、路由、管理 API）、`update`（版本与检测更新）、`hashes`、`constants`；**两者共用**：`utils`、`cf-ranges`（Cloudflare 地址段）、`doh` |
| `src/panel/panel.html` | 管理面板页面结构（`@include` 引入样式与脚本） |
| `src/panel/panel.css` | 面板样式（日间 / 夜间主题） |
| `src/panel/panel.js` | 面板前端脚本（由字段表驱动的表单回填、收集、校验与错误提示） |
| `src/panel/login.html` | 登录页 |
| `src/worker/clash-template.yaml` | Clash / Stash 订阅的配置模板（锚点、监听器、DNS、策略组与规则） |
| `build.mjs` | 构建脚本：按入口文件的清单拼接 `src/worker/*.js`，把登录页、面板页面（HTML + CSS + JS 合并，按语言各自去注释）与 Clash 模板以 `String.raw` 模板字符串内联进面板脚本，顶部加版本横幅后原样输出（不压缩、不重命名）。两个脚本共用 `src/worker/update.js` 里的 `VERSION` |
| `eslint.config.mjs` | 静态检查配置（`npm run lint`）：两个产物分别检查，任一脚本引用了另一个脚本才有的名字（`no-undef`）或留下用不到的代码（`no-unused-vars`）都会报错 |
| `test/` | `node:test` 测试，`proxy.test.mjs`（代理）与 `panel.test.mjs`（面板），模拟 KV 与 Workers 运行时，无需安装依赖 |
| `.github/workflows/ci.yml` | 每次推送运行：两个产物与 `src/` 同步检查 → 语法检查 → lint → 测试 |
| `obfuscate.mjs` | 在 `Hopline-proxy.js` 基础上用 javascript-obfuscator（通过 npx 获取，版本固定）做改名与压缩空白，产出 `obf_Hopline-proxy.js`（非部署必需，供不想公开可读源码的场景用）。代理整个就是 WebSocket / XHTTP 数据面，因此不加字符串数组 / 控制流平坦化等有运行时开销的变换，避免持续代理连接下触发 Worker CPU 时间超限。面板脚本没有混淆版 |
| `.github/workflows/obfuscate.yml` | 推送到 `main` 且 `Hopline-proxy.js` 有变化时自动重新生成并提交 `obf_Hopline-proxy.js`；也可手动触发 |

```bash
node build.mjs          # 修改 src/ 后重新生成两个脚本（需 Node.js 20.6+，CI 使用 22）
npm test                # 校验两个脚本与 src/ 同步，并运行测试
npm run lint            # eslint 静态检查（通过 npx 获取，仓库本身仍无依赖）
```

**新增一个面板配置项**：在 `src/worker/config-schema.js` 的 `CONFIG_SCHEMA` 中加一行（字段路径、类型、默认值、面板控件 id、校验规则），再在 `src/panel/panel.html` 放一个同 id 的控件即可——默认值、KV 读写白名单、保存校验、面板回填 / 收集 / 未保存标记 / 字段级错误提示都会自动生效；服务端通过 `cfg.<字段>` 读取。

**新增一个代理设置**：代理只读环境变量——在 `src/worker/proxy-config.js` 的 `proxyConfig()` 里解析（并在文件头与 README 3.1 记录），再在使用处读取 `cfg.<字段>`。

> 请勿直接编辑 `Hopline-proxy.js` 与 `Hopline-panel.js`：CI 会检查它们是否与 `src/` 同步。
>
> **发版流程**：改动后在 `src/worker/update.js` 升 `VERSION` → `node build.mjs` → 提交（两个脚本一起）→ 合并到 `main`。面板页面与 Clash 模板都内嵌在脚本里，不再需要版本标签；只改了面板时代理脚本的内容不变，只需更新面板。

---

## 八、致谢

- 隧道与代理思路参考 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 公开项目（仅借鉴原理，代码独立实现）
- 优选数据源：HostMonit、uouin、微测网等社区服务；自定义优选 API 的解析兼容 WeTest 等常见格式
- 本项目的图形化配置、优选来源、多客户端订阅等功能均为独立实现

---

## 更新日志

### V3.0.0

- **拆分为两个互相独立的脚本**（不兼容变更）：`Hopline.js` 不再提供，改为 `Hopline-proxy.js`（代理，环境变量配置，只处理节点路径上的 WebSocket / XHTTP）与 `Hopline-panel.js`（面板 + 订阅生成）。面板只需要代理的域名、UUID 与节点路径三项，二者之间没有任何运行时联系。升级步骤见「2.7 从 2.x（一体版）升级」
- **代理**：只读环境变量。`UUID` 与 `PATH` 必填（不再自动生成 UUID）；原先只能在面板里改的 `proxyIP` / 出站代理 / 出站方式 / 地区反代设置改用环境变量 `PROXYIP`、`OUTBOUND_PROXY`、`OUTBOUND_MODE`、`RELAY_MODE`、`RELAY_REGION`、`RELAY_REGION2`、`RELAY_CUSTOM`，未设置时的默认值与原先一致。VLESS 的 WebSocket 与 XHTTP 始终同时启用（不再有服务端协议开关）。除节点路径外的任何请求（包括原来的面板、`/login`、`/sub`）都只返回 `Hello World !`
- **面板**：新增「代理端点」（代理域名 / 代理 UUID / 代理节点路径，环境变量 `HOST` / `UUID` / `NODE_PATH` 提供默认值），三项没填全时顶部提示、订阅返回 400；面板路径（`PATH`）与代理节点路径互相独立；节点 SNI / Host 不再取访问面板的域名；面板里的 UUID 不再自动生成，也不再参与登录态签名。面板不再有「落地与出站」「内置地区反代」，也不再有 WebSocket / XHTTP 代理入口
- **面板页面与 Clash 模板内嵌进 `Hopline-panel.js`**：不再按版本标签从 jsDelivr / GitHub 拉取（移除资源加载器、`dist/`、SHA-256 校验与 `tag.yml`），也就没有「面板页面暂时无法加载」「Clash 配置模板暂时无法加载」这两类 503；发版不再要求“只改面板也必须升版本号”
- **混淆**：只为代理脚本提供 `obf_Hopline-proxy.js`（改名与压缩空白，不再有 light / medium / heavy 档位）；面板脚本不再有混淆版，检测更新只读取 `Hopline-panel.js`，面板版本号旁不再有「· 混淆版」标注
- 构建与检查：`build.mjs` 同时产出两个脚本；eslint 对两个产物分别做 `no-undef` / `no-unused-vars` 检查，防止拆分后出现遗漏或多余的代码；测试拆为 `proxy.test.mjs` 与 `panel.test.mjs`

### V2.5.3

- 内部重构：源码中 `enableVless` 配置键的读取与 `vless:` 协议名的匹配正则改为分段书写（运行结果不变）；配置字段名、`vless://` 链接与各客户端配置均保持不变

### V2.5.2

- 内部重构：函数 `vlessNode` / `parseVlessHeader` 更名为 `vssProtoNode` / `parseVssProtoHeader`，无功能变化；`vless://` 链接、各客户端配置里的协议名、配置字段 `enableVless` 均保持不变

### V2.5.1

- **不再识别旧版短环境变量名**（不兼容变更）：`U`、`D`、`S`、`K`、`ECH`、`OUTBOUND` 与小写 `admin` 不再生效，升级前请把 Worker / Pages 中的变量改为 `UUID`、`PATH`、`OUTBOUND_PROXY`、`CONFIG_KV`、`ENABLE_ECH`、`ADMIN`；否则会因缺少必填项（`PATH` / `ADMIN`）或未绑定 KV 而无法打开面板

### V2.5.0

- **移除 Trojan 协议**（不兼容变更）：服务端不再接受 Trojan 连接，订阅与所有客户端格式中不再生成 `trojan://` 节点；面板的 Trojan 开关与密码、环境变量 `ENABLE_TROJAN`（旧名 `TROJAN`）与 `TROJAN_PASSWORD`、配置字段 `enableTrojan` / `trojanPassword` 一并删除。KV 里遗留的这两个字段与这些环境变量会被忽略，无需清理；仍在使用 Trojan 节点的客户端更新订阅后需改用 VLESS（或 XHTTP）
- **移除 Surfboard 订阅格式**：该格式只能使用 Trojan 节点，没有 Trojan 后无节点可下发，因此 `/surfboard` 与 UA 自动识别一并删除（`/sub/surfboard` 与未知后缀一样回落为通用链接列表）
- 同一地址同时启用 VLESS 与 XHTTP 时，节点名规则不变（XHTTP 加「.X」）；「至少启用一种协议」的校验改为 VLESS 或 XHTTP 至少一个

### V2.4.6

- **修复：「检测更新」改按当前部署的类型自动选择**（V2.4.5 起的问题：不管实际部署的是 `Hopline.js` 还是 `obf_Hopline.js`，一律读取并复制 `obf_Hopline.js`，会把原本部署明文版的用户悄悄换成混淆版）。新增 `IS_OBFUSCATED` 标记：`Hopline.js` 里为 `false`，`obfuscate.mjs` 产出 `obf_Hopline.js` 时改写为 `true`；检测更新与面板上的版本号据此各自匹配同类型的文件
- 面板版本号旁新增「· 混淆版」标注（仪表盘侧栏与「关于项目」页），当前部署是 `obf_Hopline.js` 时才显示，一眼可辨

### V2.4.5

- **面板「检测更新」改为读取并复制 `obf_Hopline.js`**：点击面板里的版本号，比对仓库 `main` 分支 `obf_Hopline.js` 的版本号（取自文件顶部横幅 `/*!Hopline vX.Y.Z obfuscated:medium*/`），有新版本时把它的内容复制到剪贴板；此前读取的是 `Hopline.js`
- `obf_Hopline.js` 由 CI 在 `Hopline.js` 更新后另行提交，发版后可能要等几十秒才检测到新版本；版本号与复制的代码始终来自同一个文件
- 注意：之前直接部署 `Hopline.js` 的用户，检测更新后复制到的将是混淆版本

### V2.4.4

- **WebSocket 下行 CPU 约降为原来的 1/5**：目标连接改用 64KB 缓冲的 BYOB 读取，一次取走已到达的全部数据（最多 64KB）作为一条消息发出，不再按约 4KB 逐块读取、也不再用 0ms 定时器探测后续数据。workerd 实测 64MB 下行：读取次数 16522 → 1040，每 MB CPU 约 5.9ms → 1.2ms，吞吐约 2.5 倍；看视频等大流量更不容易触发 `Worker exceeded CPU time limit`
- 发出的缓冲不再交给下一次读取（`ws.send()` 不会立即复制数据，复用缓冲会损坏数据）；SS 出站的解密流不支持 BYOB，继续使用原有的合并读取
- 上行（客户端 → 目标）合并写入经实测没有收益（CPU 花在运行时逐条分发 WS 消息上），保持不变
- `obf_Hopline.js` 同样受益：数据面文件只做改名与压缩空白，实测与 `Hopline.js` 的下行 CPU、吞吐一致

### V2.4.3

- **修复：绑定域名留空时，节点链接和各客户端配置里的 SNI / Host 为空**（V2.3.0 起的问题：订阅生成时「留空则取访问域名」的回退值写错了字段，实际没有生效；所有订阅格式都受影响）。现已恢复，并新增测试覆盖 `sni` / `host` 以及 Clash、sing-box 的对应字段
- **恢复长字段名**：撤销 V2.3.0 的 KV 配置字段 / 接口字段名更名（`uuid`、`path`、`host`、`relay.mode`、`filter.region`、`ipsrc.wetest` 等回到原名），不再使用 `uid`、`hst`、`rl.md` 这类短标识
- **恢复文案**：撤销 V2.3.1 的「Cloudflare」文字中性化，面板、登录页、README 与源码注释恢复原有措辞；唯独面板名称保持「Hopline · 代理订阅面板」（不带 Cloudflare）
- **Clash 配置模板不再内嵌进 `Hopline.js`**（约 15KB，`Hopline.js` 约 208KB → 约 194KB）：模板移到 `src/worker/clash-template.yaml`，构建时复制为 `dist/clash-template.yaml`，Worker 与面板页面一样按版本标签 `v<版本号>` 并发拉取、校验 SHA-256 后缓存（内存 → Cache API → KV）；拉取失败时只有 Clash / Stash 订阅返回 503，其它格式不受影响；`tag.yml` 同时校验两个 dist 文件
- `Hopline.js` 不再经 terser 压缩，内容即 `src/` 原样拼接（保留注释与原始名称，约 208KB）；需要混淆发布时用 `obfuscate.mjs`
- **升级注意**：V2.3.0 – V2.4.2 保存在 KV 里的配置使用短字段名，升级后不再识别，需要在面板里重新配置；那几个版本导出的备份也无法导入。环境变量不受影响

### V2.4.2

- 新增 `obfuscate.mjs` 与 `.github/workflows/obfuscate.yml`：在 `Hopline.js` 基础上用 javascript-obfuscator 再做一层混淆，产出 `obf_Hopline.js`（light / medium / heavy 三档强度，默认 medium，可手动触发并选档）
- 不影响 `Hopline.js` / `dist/panel.html` 内容，仅升版本号以便发版（`obf_Hopline.js` 不是部署所需文件，仅供不想直接公开可读源码的场景使用）

### V2.4.1

- 面板与登录页主题默认跟随系统（此前默认日间）；右上角主题按钮改为三态循环：跟随系统 → 日间 → 夜间，选择保存在浏览器本地；跟随系统时，系统主题在页面打开期间变化会立即生效，页面加载时提前套用主题，避免夜间系统先闪一下白屏
- 面板页面有改动，按发版规则升级版本号（Worker 按 `v2.4.1` 标签拉取面板页面）

### V2.4.0

- 面板页面不再内嵌进 `Hopline.js`（部署文件约 195KB → 约 116KB）：Worker 在服务端按版本标签 `v<版本号>` 从 jsDelivr（含 fastly 镜像）/ GitHub 并发拉取 `dist/panel.html`，校验构建时写入的 SHA-256 后缓存（内存 → Cache API → KV），再注入字段表发给浏览器；浏览器只访问自己的域名，路径伪装、登录鉴权与 CSP 不变
- 缓存键为内容哈希：升级后自动换新键，无需清理；拉取失败时只有面板返回 503 说明页，代理与订阅不受影响，登录页仍内嵌
- 新增 `.github/workflows/tag.yml`：合并到 `main` 后自动创建 `v<版本号>` 标签；`build.mjs` 同时生成并校验 `dist/panel.html`

### V2.3.2

- 面板文字修正：「调优节点」提示与 `*.workers.dev` 域名提示的措辞
- README 重新整理：部署指南置前、合并重复内容、更新日志精简，并移除页眉外链

### V2.3.1

- 路径不对时（根路径、未匹配的未知路由）返回 HTTP 200 的 `Hello World !` 页面作为伪装，看起来像个普通占位站点；`/version`、`/login` 等因鉴权 / 未配置而拒绝的情况仍返回 404（行为不变）
- 「关于项目」精简为仅保留「调用接口」，移除「相关链接」与「特别鸣谢」

### V2.3.0

- 部署文件 `Hopline.js` 改为 terser 压缩产物（V2.4.3 起不再压缩，恢复为 `src/` 原样拼接）
- KV 配置字段 / 接口字段名全部更名为短标识（V2.4.3 已恢复长字段名）
- 环境变量名（`PATH` / `ADMIN` / `UUID` / `PROXYIP` …）、对外路径（`/<PATH>`、`/sub`）以及协议与客户端订阅格式（VLESS / Trojan / XHTTP、Clash / sing-box 等）保持不变

### 更早版本

V2.2.x 及更早版本（V1.x、V2.0.x、V2.1.x）的更新记录，大多是已移除功能（配额监控、节点测活、随机优选、自定义订阅模式等）的说明和升级迁移提示，对全新部署没有参考价值，已从本文档精简；其中仍然有效的行为都已并入上面各章节。完整记录可在 git 历史中查看（`git log -p -- README.md`）。
