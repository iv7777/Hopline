# Hopline · 代理订阅面板

> **Hopline —— 部署在 Cloudflare Workers / Pages 的代理订阅面板**，单文件同时实现 VLESS / XHTTP 多协议代理与图形化配置：`/<PATH>` 进入面板，`/sub` 输出订阅；内置优选域名与在线优选 IP 来源、ECH 加密、落地与出站代理（含可配置的地区反代）及地区 / 运营商 / IP 版本多维筛选，只需设置 `PATH` 与 `ADMIN` 两个环境变量即可部署（UUID 等其余均可选），绑定 KV 后改完即生效。

---

## 一、功能概览

| 功能 | 说明 |
|---|---|
| **多协议** | VLESS / XHTTP 两协议独立开关，可同时启用 |
| **图形化面板** | 仪表盘 / 节点配置 / 优选配置 / 面板设置 / 关于项目，保存即生效，主题默认跟随系统，也可一键切换日间 / 夜间（见「四、面板使用」） |
| **地址来源** | 原生地址、优选域名、在线优选 IP（HostMonit / uouin / 微测网 / 自定义 API），各自独立开关（见「五、地址来源与优选」） |
| **地区与筛选** | 地区（全部 / 香港 / 台湾 / 美国 / 新加坡 / 日本 / 韩国 / 德国）+ IP 版本（IPv4 / IPv6）+ 运营商（移动 / 联通 / 电信）组合筛选；只剔除名称明确标记为未选项的节点，通用节点保留；筛选后为空时按 运营商 → IP 类型 → 地区 逐级放宽 |
| **落地与出站** | 反代 / 落地 IP（填写后作为固定出口优先使用）+ 出站代理（SOCKS5 / HTTP(S) / Shadowsocks）+ 出站模式（默认 / 直连优先 / 仅走代理）；直连与出站都不通时由地区反代兜底 |
| **地区反代** | 直连不通时使用：内置（按 Worker 机房自动选，可固定首选 / 次选地区）/ 仅使用自己的反代列表 / 关闭 |
| **ECH 加密** | 自定义 ECH 域名 / ECH DNS（DoH），开启后自动进入仅 TLS 节点模式；链接类订阅与 Clash 订阅带 ECH 参数，Sing-box / Surge / Loon / Quantumult X 订阅不含 ECH |
| **多客户端** | Clash / Mihomo、Sing-box、Surge、Loon、Quantumult X、v2rayN / Shadowrocket / Nekoray 等链接类客户端、Stash，按 UA 自动识别；订阅地址追加 `/clash`、`/stash`（同为 Clash 配置）、`/singbox`、`/surge`、`/loon`、`/quanx`、`/v2ray`、`/plain` 等后缀可强制指定格式 |
| **安全** | 加盐摘要的管理密码、登录限速、会话自动失效、安全响应头、路径伪装（见「六、性能与安全」） |

### 节点下发规则

- **来源**：节点全部来自「原生地址（默认关）+ 优选域名 + 在线优选 IP」，IP 一律只保留 Cloudflare 段地址，不生成随机 IP，也不内置静态 IP 池
- **端口**：默认只下发 TLS 端口节点（「节点配置 → 仅 TLS 端口」）；关闭后每个 443 节点另追加一个 80 明文节点（名称带「·80」），来源自带的 8080 / 2052 等明文端口原样下发；自定义域名使用明文节点需在 Cloudflare 关闭「始终使用 HTTPS」；开启 ECH 时始终只下发 TLS 端口节点
- **XHTTP**：只出现在链接类与 Clash 订阅中；Sing-box / Surge / Loon / Quantumult X 没有 XHTTP 传输，一律不含。官方 sing-box 内核同样不支持 XHTTP
- **Sing-box**：生成 sing-box 1.12+ 格式配置（二进制 .srs 规则集经 jsDelivr 下载）；GUI.for.SingBox 请用其「导入 sing-box 配置」插件导入订阅
- **数量**：单次订阅最多 500 个节点（按免费计划 10ms CPU 限制设定），来源不足时按实际数量下发，不补足；不做轮询换新，来源数据不变时每次下发相同的节点

---

## 二、快速部署

> 全程约 5 分钟，只需要 **`Hopline.js`** 一个文件（仓库根目录，已是构建好的成品，直接使用：[raw 链接](https://raw.githubusercontent.com/iv7777/Hopline/main/Hopline.js)）。管理面板的页面（约 80KB）不在这个文件里：Worker 首次打开面板时在服务端按版本标签从 jsDelivr / GitHub 拉取、校验 SHA-256 并缓存，所以部署文件更小，浏览器也不需要访问 GitHub。

> **Fork 后部署**：面板页面与 Clash 配置模板（`/sub/clash`、`/sub/stash`）都是这样按版本标签从仓库拉取的，拉取地址固定写在 `src/worker/update.js` 的 `UPDATE_REPO`（默认即本仓库 `iv7777/Hopline`）。**Fork 后直接部署未经修改的 `Hopline.js` 可以正常使用**——此时拉取的是本仓库里与之匹配的版本，不受影响；但这也意味着长期依赖本仓库继续存在、保留对应版本标签。如果你改动了面板（`src/panel/`）或 Clash 模板（`src/worker/clash-template.yaml`）并重新构建，必须先把 `UPDATE_REPO` 改成自己的仓库再推送到自己仓库的 `main`（`tag.yml` 会自动打上匹配的版本标签），否则 Worker 仍会从本仓库拉取未经你修改的版本，看不到你的改动（哈希校验保证不会显示错的内容，只会报错或维持旧版本）。

### 2.1 准备

- 一个 Cloudflare 账号（Workers / Pages）
- （推荐）一个自己的域名：`*.workers.dev` 域名可能被限制访问，且 XHTTP 协议要求绑定自定义域名

### 2.2 Worker 部署（推荐）

1. 登录 Cloudflare 控制台 → **Workers 和 Pages** → **新建 Worker**，先用默认模板部署
2. 点「编辑代码」，**删除全部默认内容**，把 `Hopline.js` 全文粘贴进去，点「部署」
3. 进入该 Worker 的 **设置 → 变量**，添加两个**必填**变量：

   | 变量 | 填什么 |
   |---|---|
   | `PATH` | 面板、订阅、节点共用的访问路径，如 `mypanel`（只能含字母、数字及 `. _ ~ -`，不能是 `login`、`version`） |
   | `ADMIN` | 管理密码（建议设为加密 / Secret 类型） |

4. 创建一个 **KV 命名空间**，在 Worker 设置里绑定，**变量名必须是 `CONFIG_KV`**。不绑定 KV 的话面板无法保存配置，且必须手动设置 `UUID` 变量
5. （推荐）在该 Worker 的 **Domains & Routes**（域和路由）里添加你的自定义域名（DNS 由 Cloudflare 托管时证书自动签发）
6. 重新部署后访问 `https://你的域名/<PATH>`，用用户名 `admin`（默认）和 `ADMIN` 密码登录

### 2.3 Pages 部署（可选）

1. 控制台 → Workers 和 Pages → 新建 **Pages 项目**（直接上传）
2. 上传目录里放入 `Hopline.js`，框架选「无」；Pages 的高级模式要求文件名为 **`_worker.js`**，上传时请改名
3. 在 Pages 设置里添加同样的 `PATH`、`ADMIN` 环境变量，并绑定 KV（变量名 `CONFIG_KV`）

### 2.4 首次使用与访问入口

1. 登录后在 **仪表盘 → 订阅地址** 复制对应客户端的订阅链接并导入
2. `UUID` 没有设置时，首次访问会自动随机生成并保存到 KV，可在面板里查看或修改
3. 在 **优选配置** 里按需开关优选 IP 来源、编辑优选域名；改完点「保存全部」，其它机房约 1 分钟内同步

| 入口 | 地址 | 说明 |
|---|---|---|
| 面板 | `https://你的域名/<PATH>` | 需登录（用户名 + 密码）；`PATH` 未设置或格式不对时所有请求返回设置说明（503）；未设置 `ADMIN` 时面板提示「已禁用」 |
| 订阅 | `https://你的域名/<UUID>/sub` | 按客户端 UA 自动识别格式；追加后缀强制指定，如 `/sub/clash`、`/sub/singbox` |
| 配置 API | `https://你的域名/<PATH>/api/config` | GET 读取 / POST 保存，支持只提交部分字段；需登录 |

### 2.5 更新

1. 取最新的 `Hopline.js`，**覆盖粘贴**到原来的 Worker 里并部署；环境变量与 KV 里的配置原样保留，无需重新设置
2. 也可以在面板里点击版本号检测更新：自动按当前部署的类型读取仓库 `main` 分支下同类型的文件（部署的是 `Hopline.js` 就读 `Hopline.js`，是 `obf_Hopline.js` 就读 `obf_Hopline.js`）比对版本号，有新版本时把它的内容复制到剪贴板。`obf_Hopline.js` 由 CI 在 `Hopline.js` 更新后另行提交，发版后可能要等几十秒才检测到；版本号旁会标注「· 混淆版」表明当前部署的类型
3. **注意**：V2.4.3 恢复了 V2.2.x 及以前的长字段名（见更新日志），保存在 KV 里的 V2.3.0 – V2.4.2 配置（短字段名）不再识别，需要重新配置，那几个版本导出的备份也不能再导入

### 2.6 常见问题

| 现象 | 原因与处理 |
|---|---|
| 页面只显示 `Hello World !` | 访问路径不对。面板入口必须是 `https://你的域名/<PATH>`，根路径和任何未知路径都会显示这个页面 |
| 所有请求返回「设置说明」（503） | `PATH` 没设置或格式不对，按提示修改后重新访问 |
| 面板提示「已禁用」 | 没有设置 `ADMIN` |
| 保存时报错 / 无法保存 | 没有绑定 KV，变量名必须是 `CONFIG_KV` |
| 打开面板提示「面板页面暂时无法加载」（503） | Worker 没能从 jsDelivr / GitHub 拉到当前版本（`v<版本号>` 标签）的面板页面。稍后刷新即可；一直如此请确认仓库里存在对应版本标签（自己 fork 的需把 `src/worker/update.js` 里的 `UPDATE_REPO` 改成自己的仓库）。代理与订阅不受影响 |
| Clash / Stash 更新订阅失败（503，提示「Clash 配置模板暂时无法加载」） | 与上一条同理：Worker 没能拉到当前版本标签下的 `dist/clash-template.yaml`。稍后重试；一直如此请确认仓库存在对应版本标签（自己 fork 的需改 `UPDATE_REPO`）。其它格式的订阅不受影响 |
| 客户端更新订阅提示「无效订阅」 | `*.workers.dev` 域名可能被限制，绑定自定义域名，或让客户端通过代理更新订阅 |
| 登录后过一段时间被退出 | 24 小时未使用面板自动退出，最长 7 天需重新登录 |
| 改了 `PATH` 后节点连不上 | 节点路径随 `PATH` 改变，客户端需要重新更新订阅 |

---

## 三、环境变量与配置项

> 优先级：**KV 配置 > 环境变量 > 默认值**。环境变量只在面板里没有改成别的值时生效：面板保存时，与环境变量相同的值不会写入 KV（之后修改环境变量立即生效），改成不同的值才保存为覆盖。`PATH`、`ADMIN`、`ADMIN_USER` 设置后在面板中只读。
>
> **必填只有 `PATH` 与 `ADMIN` 两项**，其余全部可选。旧版的短变量名（`U`、`D`、`S`、`K`、`ECH`）仍然兼容；新旧名称同时存在时新名称优先。

### 3.1 环境变量

| 变量 | 值 | 说明 |
|---|---|---|
| `PATH`（旧名 `D`） | 访问路径 | **必需**。面板、订阅（`/<PATH>/sub`）与节点（WebSocket / XHTTP）共用此路径；只能含字母、数字及 `. _ ~ -`，不能是 `login`、`version`；首尾的 `/` 自动去掉。修改后节点路径随之改变，客户端需重新更新订阅 |
| `ADMIN`（旧名 `admin`） | 管理密码 | **必需**，未设置时面板与管理接口一律禁用 |
| `UUID`（旧名 `U`） | 你的 UUID | 可选，VLESS 用户 ID（节点身份）。**留空则首次访问时随机生成并保存到 KV**，之后一直沿用，可在面板查看与修改；未绑定 KV 时没有地方保存，必须手动设置。面板里修改后以面板为准 |
| `ADMIN_USER` | 管理用户名 | 可选，登录时与密码一起校验（区分大小写），默认 `admin` |
| `HOST` | 自定义 SNI / Host | 可选，节点的 SNI 与 WS Host；留空用访问所用的域名 |
| `CONFIG_KV`（旧名 `K`） | KV 命名空间绑定 | 可选（推荐），在 Worker / Pages 设置里绑定 KV 命名空间时使用的变量名；绑定后面板配置才能保存 |
| `ENABLE_ECH`（旧名 `ECH`） | true / 1 | 启用 ECH 加密客户端握手（开启后自动仅 TLS 端口） |
| `ALPN` | h2 / http/1.1 | ALPN 协商（逗号分隔），VLESS / XHTTP 链接、Clash、Sing-box 均按此下发；留空时 ws 用 http/1.1、XHTTP 用 h2 |
| `PROXYIP` | host 或 host:port | 反代 / 落地 IP：填写后作为固定出口优先使用；留空则直连失败后由地区反代兜底 |
| `OUTBOUND_PROXY`（旧名 `OUTBOUND`、`S`） | `socks5://` / `http(s)://` / `ss://` 地址，或 `user:pass@host:port` | 出站代理（SOCKS5 / HTTP(S) / Shadowsocks） |

### 3.2 面板配置项（保存于 KV，也是 `/api/config` 的字段名）

> 完整字段、默认值与校验规则以 `src/worker/config-schema.js` 中的 `CONFIG_SCHEMA` 为准。保存时逐项校验，未登记的字段会被忽略。嵌套字段用 `a.b` 表示，接口里是 `{ "a": { "b": … } }`。

| 配置项 | 说明 |
|---|---|
| `uuid` / `adminUser` / `admin` / `host` | UUID / 管理用户名 / 管理密码 / 自定义 SNI·Host（同环境变量，面板可视化编辑；`admin` 只写不回显） |
| `subUrl` | 自定义订阅路径：`/<别名>/sub` 输出订阅（别名下不开放面板与管理接口）；留空为 `/<UUID>/sub`。面板路径下的 `/sub` 始终可用 |
| `enableVless` / `enableXhttp` | 协议开关 VLESS / XHTTP（默认均开） |
| `alpn` / `tlsOnly` | ALPN 协商 / 仅 TLS 端口节点（默认开启；关闭后 443 节点追加 80 明文节点） |
| `ech` / `echHost` / `echDns` | ECH 开关 / 自定义 ECH 域名 / ECH DoH |
| `filter.region` | 地区（多选数组）：`['all']` 或 HK / TW / US / SG / JP / KR / DE 的组合 |
| `filter.ipType` | IP 版本：IPv4 / IPv6（默认只有 IPv4） |
| `filter.isp` | 运营商：移动 / 联通 / 电信 |
| `src.native` / `src.prefDomain` / `src.prefIp` | 地址来源：原生地址 / 优选域名 / 优选 IP |
| `ipsrc.hostmonit` / `ipsrc.uouin` / `ipsrc.wetest` / `ipsrc.api1` / `ipsrc.api1Url` / `ipsrc.api2` / `ipsrc.api2Url` | 优选 IP 来源开关（HostMonit / uouin / 微测网 / 自定义 API 1 / 2）与两个自定义 API 地址（默认：HostMonit 开、uouin 开、微测网关、自定义 API 关；开启 API 但未填地址时保存会报错） |
| `prefDomains` | 优选域名：每行一个纯主机名（最多 30 个），**整体替换**内置的 14 个域名；留空使用内置列表 |
| `relay.mode` / `relay.region` / `relay.region2` / `relay.custom` | 地区反代：`builtin`（默认，按 Worker 机房自动选地区，可固定首选 / 次选，次选 `none` 表示不使用）/ `custom`（只用 `relay.custom` 中最多 3 个 `host[:port]`）/ `off`（不使用，只直连 / 出站代理） |
| `proxyIP` / `outboundProxy` / `outboundMode` | 反代落地 IP / 出站代理 / 出站模式（`''` 默认、`no` 直连优先、`only` 仅代理） |

---

## 四、面板使用

| 视图 | 说明 |
|---|---|
| **仪表盘** | 快速开始、订阅地址（格式选择 / 复制 / 二维码 / 下载 / 预览）、地区与线路筛选、运行状态 |
| **节点配置** | 协议开关（VLESS / XHTTP）、TLS 与 ALPN、ECH、落地与出站、内置地区反代 |
| **优选配置** | 优选域名（自定义 / 内置列表、测试）、优选 IP 来源（HostMonit / uouin / 微测网 / 自定义优选 API 1 / 2）及各来源的「测试」按钮 |
| **面板设置** | UUID / 面板路径（由环境变量 `PATH` 提供，只读）/ 订阅路径别名 / 管理用户名 / 管理密码 / 绑定域名、配置导出导入、退出登录、重置 |
| **关于项目** | 调用的外部接口清单 |

- 所有修改点右下角「保存全部」后写入 KV；保存前后都会逐项校验，出错的字段就地标红并给出原因
- 修改 UUID / 管理密码 / 管理用户名后当前浏览器保持登录
- 订阅预览与客户端实际订阅走同一流程，显示真实节点数；预览分「节点列表」（逐个节点可单独复制链接或查看二维码，单个节点不随订阅更新）与「原始内容」
- 「绑定域名」仅用于订阅节点的主机名（XHTTP 要求绑定自定义域名），不负责域名解析；自定义域名访问面板需先在 Cloudflare 控制台为该 Worker 添加

---

## 五、地址来源与优选

### 5.1 地址来源

默认节点池由「仪表盘 → 地址来源」三项组装：

| 来源 | 说明 |
|---|---|
| **原生地址**（默认关） | 工作器域名直接作为节点下发 |
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
- **DoH 与子请求预算**：优选域名解析 Cloudflare DoH 优先，仅当请求失败时降级阿里 DNS，正常每次解析只计 1 个子请求（反代域名与 UDP DNS 解析同样 Cloudflare 优先、逐个降级，超过 0.7 秒未响应会提前并发下一个）；IPv4+IPv6 混合时只对前 12 个优选域名查询 AAAA。实测单次订阅约 14–20 个子请求，最坏（仅 IPv6、30 个自定义域名、全部来源开启）约 31 个，低于免费版上限 50
- **出站并发竞速**：直连与地区反代（内置或自定义，可在面板关闭）同时发起，取先握手成功的一路，败者连接立即释放；直连有 1.5s 优先窗口（可直连的站点不绕第三方反代）；目标为 Cloudflare IP 时不发直连、直接用反代；直连失败、由反代接通的站点会被记住 30 分钟，之后直接走反代（不再发直连、不查 DNS）。目标站在 Cloudflare 上时不再白等约 6 秒；出站模式（默认 / 直连优先 / 仅走代理）决定出站代理与直连、反代的先后
- **首包判定**：地区反代与「反代 / 落地 IP」只能转发 TLS 流量（按 SNI 路由），非 TLS 首包（Telegram MTProto、明文 HTTP 等）只走直连与出站代理
- **WS 0-RTT 早数据**：TLS WebSocket 节点带 `?ed=2048`（Sing-box 用 `max_early_data`），客户端把首包放进握手请求头，服务端握手时即建连，省约 1 个往返；早数据校验不通过时按普通连接处理
- **VLESS 响应头提前下发**：头部解析成功即回 2 字节响应头，首包等待上限 80ms，避免与部分客户端（mihomo 等）互相等待
- **SWR 容灾缓存**：外部优选源拉取失败时沿用上一轮有效结果（10 分钟缓存；绑定自定义域名时同一机房共享）

### 6.2 安全

- **管理登录**：必须设置 `ADMIN`，以用户名 + 密码登录（任一错误都只提示「用户名或密码错误」）；KV 中的密码保存为加盐 PBKDF2 摘要（环境变量 `ADMIN` 本身是明文）；登录失败 15 分钟内最多 5 次，IPv6 按 /64 计数
- **会话**：24 小时无操作失效（使用时自动顺延，最长 7 天），可在「面板设置」退出；修改密码、用户名或 UUID 会使其它浏览器的登录状态全部失效
- **页面安全头**：面板与登录页带 CSP、`X-Frame-Options`、`nosniff`、`Referrer-Policy`；二维码脚本带 SRI 校验
- **面板页面完整性**：面板页面只从不可变的版本标签 `v<版本号>` 拉取（绝不拉 `main`），Worker 用构建时写入的 SHA-256 校验，不符一律丢弃；缓存键就是这个哈希，升级后自动换新键，旧缓存无需清理（读取顺序：内存 → Cache API → KV → 网络；Cache API 在 `*.workers.dev` 下不生效，会直接用 KV 或网络）
- **路径与 UUID 鉴权**：请求路径与 `PATH` 一致才进入面板 / 代理，VLESS 头部的 UUID 与配置一致才转发；订阅别名路径只输出订阅
- **路径伪装**：路径不对（根路径、未知路由）时返回 200 的 `Hello World !` 页面，不暴露部署；`/login`、`/version` 只对知道面板路径的人可用，否则返回 404
- **Clash 本地凭据**：订阅里的 Shadowsocks 入站密码、认证与 API secret 按 UUID 为每个部署派生，不使用公开的默认密码
- **配置存储保护**：配置读取走 KV 边缘缓存（30 秒）；KV 读取失败或配置损坏时拒绝保存，且没有环境变量 UUID 时返回 503，避免用默认值覆盖已有配置或重新生成 UUID

---

## 七、开发与构建

`Hopline.js` 是构建产物（部署时直接粘贴它即可），源码位于 `src/`：

| 路径 | 内容 |
|---|---|
| `src/worker.js` | 入口：环境变量说明与 `// @include worker/xxx.js` 清单，构建时按顺序拼接 |
| `src/worker/*.js` | 服务端逻辑，按主题拆分：`config-schema`（字段表 `CONFIG_SCHEMA`）、`config`（加载 / 保存）、`protocol`（VLESS 头、DoH）、`outbound-proxies` / `relay`（出站与反代）、`proxy`（WS / XHTTP）、`ip-sources` / `nodes`（优选来源与节点生成）、`formats`（各客户端格式）、`subscription`、`router`（鉴权、路由、管理 API）等 |
| `src/panel/panel.html` | 管理面板页面结构（`@include` 引入样式与脚本） |
| `src/panel/panel.css` | 面板样式（日间 / 夜间主题） |
| `src/panel/panel.js` | 面板前端脚本（由字段表驱动的表单回填、收集、校验与错误提示） |
| `src/panel/login.html` | 登录页（内嵌进 Worker，不依赖网络） |
| `src/worker/asset-loader.js` | 固定版本资源加载器：按版本标签拉取 `dist/panel.html`（面板）与 `dist/clash-template.yaml`（Clash 模板）、校验哈希、分层缓存；面板页面另外在这里注入字段表 |
| `dist/panel.html` | 构建产物：面板 HTML + CSS + JS 合并去注释后的成品，按版本标签发布，**需提交** |
| `src/worker/clash-template.yaml` | Clash / Stash 订阅的配置模板（锚点、监听器、DNS、策略组与规则），**不内嵌进 `Hopline.js`**，运行时按版本标签拉取 |
| `dist/clash-template.yaml` | 构建产物：模板原样复制，按版本标签发布，**需提交** |
| `build.mjs` | 构建脚本：拼接 `src/worker/*.js`、内联登录页（去注释），把面板合并为 `dist/panel.html`、把 Clash 模板复制为 `dist/clash-template.yaml`，并把两者的 SHA-256 写进 worker，顶部加版本横幅后原样输出为 `Hopline.js`（不压缩、不重命名；如需混淆发布见下面的 `obfuscate.mjs`） |
| `eslint.config.mjs` | 静态检查配置（`npm run lint`） |
| `test/` | `node:test` 测试（模拟 KV 与 Workers 运行时，无需安装依赖） |
| `.github/workflows/ci.yml` | 每次推送运行：`Hopline.js` / `dist/` 与 `src/` 同步检查 → 语法检查 → lint → 测试 |
| `.github/workflows/tag.yml` | 推送到 `main` 后，若 `Hopline.js` 里的版本号还没有对应的 `v<版本号>` 标签就自动创建；标签已存在但其中的 `dist/panel.html` 或 `dist/clash-template.yaml` 内容不同（改了面板 / Clash 模板却没升版本号）则失败 |
| `obfuscate.mjs` | 在 `Hopline.js` 基础上用 javascript-obfuscator 再混淆一层，产出 `obf_Hopline.js`（非部署必需，供不想公开可读源码的场景用）；light / medium / heavy 三档，通过 npx 获取（版本固定）。WebSocket / XHTTP 数据面（`proxy.js` / `relay.js` / `outbound-proxies.js`）单独处理：只做改名与压缩空白，不加字符串数组 / 控制流平坦化等有运行时开销的变换，避免持续代理连接下触发 Worker CPU 时间超限 |
| `.github/workflows/obfuscate.yml` | 推送到 `main` 且 `Hopline.js` 有变化时自动重新生成并提交 `obf_Hopline.js`（默认 medium 档）；也可手动触发并选择强度 |

```bash
node build.mjs          # 修改 src/ 后重新生成 Hopline.js（需 Node.js 20.6+，CI 使用 22）
npm test                # 校验 Hopline.js 与 src/ 同步，并运行测试
npm run lint            # eslint 静态检查（通过 npx 获取，仓库本身仍无依赖）
```

**新增一个面板配置项**：在 `src/worker/config-schema.js` 的 `CONFIG_SCHEMA` 中加一行（字段路径、类型、默认值、面板控件 id、校验规则），再在 `src/panel/panel.html` 放一个同 id 的控件即可——默认值、KV 读写白名单、保存校验、面板回填 / 收集 / 未保存标记 / 字段级错误提示都会自动生效；服务端通过 `cfg.<字段>` 读取。

> 请勿直接编辑 `Hopline.js` 与 `dist/` 下的文件：CI 会检查它们是否与 `src/` 同步。
>
> **发版流程**：改动后在 `src/worker/update.js` 升 `VERSION` → `node build.mjs` → 提交（`Hopline.js` 与 `dist/` 下的文件一起）→ 合并到 `main`，`tag.yml` 会自动打上 `v<版本号>` 标签。Worker 按这个标签拉面板页面，所以**只改面板或 Clash 模板（哪怕一个字）也必须升版本号**，否则新 `Hopline.js` 里的哈希对不上旧标签里的页面。

---

## 八、致谢

- 隧道与代理思路参考 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 公开项目（仅借鉴原理，代码独立实现）
- 优选数据源：HostMonit、uouin、微测网等社区服务；自定义优选 API 的解析兼容 WeTest 等常见格式
- 本项目的图形化配置、优选来源、多客户端订阅等功能均为独立实现

---

## 更新日志

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
