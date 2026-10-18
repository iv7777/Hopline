# 代理 CPU 基准测试

在真实的 workerd 里运行仓库根目录的 `Hopline-proxy.js`，用 VLESS（WebSocket / XHTTP）客户端施加负载，测出每个请求、每条连接、每 MB 数据各花多少 CPU。改动数据面（`relay.js`、`proxy.js` 等）前后各跑一次，可以看出改动是否真的省了 CPU。不在 CI 里运行。

## 运行

需要 Linux（从 `/proc` 读 CPU）、Node 22 和 `openssl`。

```sh
cd bench
npm ci                                       # workerd + ws，只装在 bench/ 里
node run.mjs                                 # 全部场景，每个 5 次取中位数 → results.json
node run.mjs --only ws-down,xht-down         # 只跑部分场景
node run.mjs --profile alt,hop               # 只跑某几组状态配置
node profile.mjs ws-up-1k                    # V8 CPU 采样：按函数列出耗时
RUNS=20 node upclose.mjs                     # 全速上传，统计被「上行缓冲溢出」断开的次数
node ref/refbench.mjs                        # 参照 Worker：运行时本身的下限
HOPLINE_REPO=/某个目录 node run.mjs           # 测别的目录里的 Hopline-proxy.js（如另一个分支的构建产物）
```

## 怎么测的

- **被测脚本**：`Hopline-proxy.js`（`obf` 配置用 `obf_Hopline-proxy.js`）原样运行，只把 DoH 地址换成本地桩；`wrapper.js` 提供一个内存里的 `NODE_KV`，返回该配置的状态
- **客户端与上游**：在别的进程里运行，CPU 不会混进被测进程。`target.mjs` 提供 TCP 目标（:9001）、SOCKS5 服务器（:9002）与 DoH JSON 桩（:9053）；客户端在 `lib.mjs`
- **CPU**：每个场景前后读 `/proc/<workerd>/task/*/schedstat`。`main` 是 workerd 主线程（运行 isolate 的线程），本地最接近 Cloudflare 按请求计的 CPU；`all` 另含 V8 的辅助线程
- **状态配置**：`default`、`obf`（混淆版）、`alt`（备用线路 US / SG / JP，机房 SJC）、`hop`（SOCKS5 出站）、`edge`（落地 IP）

## 数字怎么看

只比较场景之间、改动前后的相对大小，不要当成 Cloudflare 的计费：机器不同，数字里还含本机回环网络的内核时间。客户端到边缘的 TLS 由 Cloudflare 在 Worker 之前处理，不计入 Worker，所以 `wss-*` 场景只作参照。下行场景波动最大，同一场景的多次结果可能差一倍，需要多跑几次看中位数。
