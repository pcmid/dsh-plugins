# @pcmid/dsh-remote-relay

通过自建的 [OpenChamber relay](https://github.com/openchamber/openchamber-relay)，从手机或其他电脑使用这个 DSH。relay 原样部署，不需要修改；它只看得到密文。DSH 的 Web GUI 继续只监听本机，不需要开放端口、配置 `trustedHosts` 或 TLS。

**已配对设备拥有你在本机的全部权限**，包括执行命令和读写文件。只配对自己的设备，不用时在设置里移除。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| Host 插件 | `index.js` | 连接 relay，验证设备，把请求转发给本机 Web GUI |
| 设置页 | `client.js` | “设置 → 远程访问”：开关、relay 地址、配对二维码、设备列表 |
| 手机启动页 | `launcher/` | 静态网页，部署到任意 HTTPS 站点；手机扫码后在里面打开 DSH |
| 电脑连接器 | `launcher/dsh-remote.mjs` | 单文件 Node 脚本（Node 22+），在远程电脑上把 DSH 映射到 `http://127.0.0.1:7878` |

## 使用

1. 部署 relay（Cloudflare Workers、Docker 或 Node，见 relay 仓库的 README），得到 `wss://relay.example.com/ws`。
2. 把 `launcher/` 目录部署到一个 HTTPS 静态站点，例如 Cloudflare Pages、GitHub Pages，或在 Docker 部署的 Caddy 里加一个 `file_server`。**这个源只放启动页**：同源的其他脚本可以使用浏览器里保存的设备密钥。
3. 在 DSH 中打开“设置 → 远程访问”，开启远程访问，填写 relay 地址和启动页地址。状态变为“在线”后点“配对新设备”。
4. 手机：用相机扫描二维码，在启动页里点“配对”。之后打开启动页会自动连接上次的 DSH；iOS 可以“添加到主屏幕”。
5. 电脑：复制设置页里的连接器命令到远程电脑执行，例如：

   ```sh
   curl -fsSLO https://remote.example.com/dsh-remote.mjs && node dsh-remote.mjs pair '<配对码>'
   node dsh-remote.mjs connect --open
   ```

   `connect` 打印一个带一次性令牌的本机地址；只有带令牌打开过的浏览器能访问，其他网站和 Host 头不对的请求会被拒绝。

配对码只能用一次，默认 10 分钟内有效（`pairingMinutes`）。

## 配置

都在设置页里修改，保存到本插件行 `remote-relay` 的配置中，修改后立即生效，不需要重启。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否保持与 relay 的连接 |
| `relayUrl` | 空 | relay 的 WebSocket 地址；只写域名时补全为 `wss://<域名>/ws` |
| `launcherUrl` | 空 | 启动页地址；为空时没有手机二维码，只能用电脑连接器 |
| `hostName` | 计算机名 | 设备上显示的名称 |
| `pairingMinutes` | `10` | 配对码有效分钟数 |

本机身份密钥和已配对设备保存在 DSH 凭据存储中（`remote-relay/identity`、`remote-relay/devices`）。删除身份记录会换一个新的 `serverId`，所有设备需要重新配对。

## 工作方式

```
手机启动页 / 电脑连接器 ─wss─► relay（只转发）◄─wss─ DSH Host 插件 ─► 127.0.0.1 上的 Web GUI
```

- **relay 协议**：插件实现 openchamber-relay v1 的 host 端。DSH 用一把 ECDSA P-256 密钥签名 `host-control` 和每个 `host-data` 连接；`serverId` 是公钥的 SHA-256。relay 每个 `serverId` 最多 16 个并发设备、每分钟 60 次新连接，所以每台设备的所有 HTTP 请求和 WebSocket 都复用同一条连接。
- **端到端加密**：设备发送临时 ECDH 公钥和设备公钥；DSH 回复自己的临时公钥、身份公钥和对握手记录的签名，设备检查身份公钥的哈希等于 `serverId`，因此 relay 无法冒充 DSH。双方用 HKDF 派生每个方向各一把 AES-256-GCM 密钥，配对时再混入一次性配对密钥；设备在第一帧里用设备私钥签名握手记录。帧按方向计数，丢失、重放或乱序的帧会导致连接关闭。
- **转发**：DSH 用自己的浏览器 cookie 登录本机 Web GUI，再把设备的请求和 WebSocket 原样转发过去；cookie 不会发给设备，设备送来的 cookie、Origin 和 `Sec-Fetch-*` 头会被丢弃。
- **手机启动页**：Service Worker 把 iframe 里 DSH 页面的请求交给启动页窗口，经隧道转发；页面最前面注入一段脚本，把 DSH 的 `__DSH_TRANSPORT__.createWebSocket` 指向隧道，所以 `/api/remote.mux` 也走隧道。gzip 响应在浏览器里解压。

## 开发

```sh
npm run build:connector   # 由 bin/dsh-remote.mjs 和 launcher/tunnel.js 生成 launcher/dsh-remote.mjs
# 先在本地启动 relay：git clone openchamber-relay && npm install && PORT=18788 npm start
RELAY_URL=ws://127.0.0.1:18788/ws npm test
RELAY_URL=ws://127.0.0.1:18788/ws node --import ./test/hooks.mjs test/launcher.e2e.mjs   # 需要 Chrome 和 playwright-core
```

测试使用 DSH 源码检出中的 schemastery（见 `test/hooks.mjs`），以及 relay 依赖里的 `ws` 包（`WS_MODULE`）。

## 已知限制

- 远程设备是 owner 身份，没有只读或受限模式。需要把会话分享给别人时，请使用 DSH 的 Liveshare。
- 手机启动页依赖 Service Worker；无痕模式或禁用 Service Worker 的浏览器无法使用。DSH 的 HMR 事件流在 Service Worker 被系统回收后会重连。
- 本机 Web GUI 使用自签名 TLS 证书时，WebSocket 转发不可用（HTTP 转发可用）。
- relay 协议版本由 OpenChamber 维护；请固定 relay 的版本。relay 使用 FSL-1.1-ALv2 许可：可以自建自用，不能拿它对外提供商业中转服务。
