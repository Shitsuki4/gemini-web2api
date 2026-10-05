# gemini-web2api · Cloudflare 原生重构

使用 **Workers + SQLite Durable Objects + D1 + 静态资源**，将 Gemini 网页协议适配为 HTTP API。参考 [zexadev/gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go)，并对照 Sophomoresty、one880808 及本仓库原版传输实现，不是把 Go 服务器搬进容器，也不依赖外部代理、VPS、R2 或常驻本地浏览器。

> **当前状态：纯 Cloudflare 文本链路已通过真实验收。** 2026-10-05 在 Workers Free + SQLite DO + D1 上，原生 TLS socket 传输已完成非流式回答、只传会话 ID 的第二轮续聊、11 个文本增量的 SSE、Responses JSON、txt 附件读取及图片生成/下载。不是模拟上游，也没有经过 Roxy 中转。之前 fetch 路径遭遇 Google 验证的结论已被这个实测修正。**音乐/视频等其它媒体及长期 Cookie 续期仍须分别验收，不承诺 Go 项目全部功能等价或长期稳定。** 详见[验收报告](docs/verification.md)与[参考项目对照](docs/references.md)。

> **Spark 新增为 Beta 实验入口，不是已验收能力。** 使用 `gemini-spark`；已实现真实 Spark tool 40、任务续接和答案事件解析，但当前 Cloudflare 实测仍有 `1061` / 无答案终止，网页适配器成功不等于云端成功。普通 Gemini 与图片链路不因此改为 Spark。见 [Spark 使用范围](docs/api.md#spark-beta实验性文本适配) 和[失败记录](docs/verification.md#spark-beta-追加验收2026-10-05)。

> **登录保活已重做**：短期票据与页面检查独立调度、持久化退避，SIDCC 已随短票下发时不重复请求；管理台提供保活历史和脱敏页面诊断。首轮 35 分钟通过后曾复发，已修正页面失败拖慢续票的问题；后续 45 分钟窗口观察到 4 次新的自动换票，且同一导入约 5 小时后仍完成文本/图片实测。不同观察窗口与恢复操作分别记录，**不承诺数天或永久有效**。用 `npm run watch:login -- --account acc_ID --minutes 35 --verify-chat` 做有界验收，详见[运维说明](docs/operations.md#长期登录维护2026-10-05-修订)及[验收记录](docs/verification.md)。

> **浏览器跨域 API 已补齐**：`/v1/`、`/v1beta/` 支持预检、鉴权请求与跨域 SSE/图片下载；`/admin/` 仍只允许同源访问。遇到 `Failed to fetch` 先区分网络/CORS 与上游错误，不自动重发生成。见[浏览器客户端说明](docs/api.md#浏览器客户端与-failed-to-fetch)。

## 能做什么

| 功能             | 本实现                                                       | 验证边界                                                                  |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| OpenAI Chat、SSE | `/v1/chat/completions`，累计文本转增量、背压、心跳、取消     | 真实文本 / 多增量 SSE 已通过                                              |
| Responses        | `/v1/responses`，基本文本/函数调用事件，失败生命周期         | 非完整 OpenAI 替代；不支持 `previous_response_id`                         |
| 会话续接         | API Key 隔离、账号固定、加密元数据、默认 7 天 TTL            | 必须传 `session_id`，每轮仅新增一条 user/tool 消息                        |
| 账号池           | 每账号一个 DO，串行生成、6 次尝试/分钟、冷却、最久未使用优先 | 不提供 IP 池或地区解锁保证                                                |
| 文件输入         | base64 data URL，最多 4 个附件                               | 单文件 768 KiB，整个请求 1 MiB；拒绝远程文件 URL                          |
| 图片/音乐/Canvas | 网页工具开关和鉴权下载代理                                   | 图片已实测生成/下载；音乐、Canvas 未真实验收                              |
| Spark Beta       | `gemini-spark`，独立协议、加密任务游标、仅文本实验入口       | **Cloudflare 真实验收未通过**，不承诺可用；非调度/关联应用 API            |
| 视频             | 提交作业、DO Alarm 轮询、状态/鉴权下载                       | 实验性，10 分钟超时，不自动重放不确定的提交                               |
| 函数工具 / JSON  | 提示词模拟工具调用；JSON object 输出解析检查                 | 非原生函数协议，不执行工具，不保证遵守提示词，拒绝 strict schema          |
| Google API       | 基础非流式 `generateContent`                                 | 只做文本/inlineData 适配，不支持完整 generationConfig、安全设置或原生流式 |
| 中文管理台       | 账号、密钥、请求统计、流式调试、配置                         | ADMIN_KEY 只保存在页面内存                                                |

不会伪造 token 用量，不导出私有推理过程，不把错误包装成成功。`/healthz` 仅表示网关存活，不表示 Gemini 可用。

## 部署到自己的 Cloudflare 账号

需要 Node.js 22+、Cloudflare Workers Free 账号，以及自己有权使用的 Gemini 登录态。下列步骤适用于**新建独立实例**；旧版本升级先读[迁移与回滚](docs/operations.md)。

```powershell
npm ci
npx wrangler login
npx wrangler d1 create gemini-web2api-v3
```

默认 `UPSTREAM_TRANSPORT="socket"`；不要误改为 `fetch`，两者的 Cloudflare 出口行为不同。`ACCOUNT_LOCATION_HINT="wnam"` 是初始放置建议，不保证 IP/国家；修改后不会迁移已有 DO。

将命令返回的数据库 ID 写入 `wrangler.toml` 的 `database_id`。保留独立 Worker 名称 `gemini-web2api-native`，不要直接覆盖旧服务名称。

```powershell
npm run setup:secrets
npm run db:remote
npx wrangler secret bulk .local/secrets.json
npm run deploy
```

`setup:secrets` 生成独立的管理员密钥、API 密钥和 AES-GCM 密钥，**不会覆盖已有文件**。如果提示文件已存在，应复用/备份原密钥而不是删除重建。`.local/` 已忽略，切勿上传或分享。使用 API Token 时只授权目标账号必要的 Workers、D1 权限，不要把 Global API Key 写入项目。

## 从 Roxy 导入登录态

在 Roxy 中打开已登录的 `https://gemini.google.com/app`，取得该浏览器的 CDP 地址。仅需导入时连接本地浏览器；没有驻留脚本。登录过期或设备绑定导致续期失败时，需要再次人工登录/导入。

下面按提示填写自己的部署地址及 CDP 地址，密钥从本地文件读入内存，不打印：

```powershell
$secrets = Get-Content .local/secrets.json -Raw | ConvertFrom-Json
$env:ADMIN_KEY = $secrets.ADMIN_KEY
$env:API_KEY = $secrets.API_KEY
$env:GATEWAY_URL = Read-Host 'Worker HTTPS 地址'
$cdp = Read-Host 'Roxy CDP 地址，例如 http://127.0.0.1:15639'
node scripts/sync-roxy.mjs --origin $env:GATEWAY_URL --cdp $cdp
npm run smoke
```

脚本只输出账号 ID、Cookie 数量和页面构建号，不输出 Cookie。以后用返回的账号 ID 更新原记录，避免重复添加：

```powershell
$account = Read-Host '上次导入返回的 acc_ 账号 ID'
node scripts/sync-roxy.mjs --origin $env:GATEWAY_URL --cdp $cdp --account $account
```

打开部署根地址即可访问管理台；API 客户端 Base URL 为部署地址加 `/v1`，使用 `API_KEY`，不要使用 `ADMIN_KEY`。

## 调用示例

以下 PowerShell 命令接续上面的环境变量：

```powershell
$body = @{
  model = 'gemini-3.6-flash'
  messages = @(@{role='user'; content='只回复 OK'})
  stream = $false
} | ConvertTo-Json -Depth 8
Invoke-RestMethod "$env:GATEWAY_URL/v1/chat/completions" -Method Post `
  -Headers @{Authorization="Bearer $env:API_KEY"} `
  -ContentType 'application/json' -Body $body
```

模型列表是协议适配器清单，**不是账号权益探测或成功承诺**。响应扩展字段 `gemini.actual_model` 取自上游实际模型描述，缺失则为 null。详细端点、会话和限制见 [API 使用](docs/api.md)。

`npm run smoke:media` 可另测 txt 附件和图片生成/下载（2 次生成，会消耗图片权益）；返回的是需原 API Key 的网关下载地址，不是公开图片链接。

`npm run smoke:image-chat` 专测调试台使用的 Chat SSE 生图和鉴权下载（1 次生成，默认中文提示，可用 `IMAGE_PROMPT` 覆盖）。调试台现支持图片预览/下载；失败会显示上游的可见说明，不再一律提示检查图片权限。

## 免费额度不是无限额度

按 2026-10-05 查询的 Cloudflare 文档：

| 资源        | Free 额度 / 约束                                                  |
| ----------- | ----------------------------------------------------------------- |
| Workers     | 100,000 请求/天；每次调用 10 ms CPU；等待网络不计 CPU             |
| SQLite DO   | 100,000 请求/天、13,000 GB-s/天；流式连接和后台任务会消耗持续时间 |
| D1          | 500 万行读取/天、10 万行写入/天、总存储 5 GB                      |
| Browser Run | 10 分钟浏览器时间/天、最多 3 并发；本实现不依赖它                 |

以上额度按 Cloudflare 账号共享，不是每个 Gemini 账号独享；DO SQLite 还存在独立行读写和存储限制。清理、索引、管理接口、Cookie 续期也占额度。大请求可能先触发 CPU 限制。超限会失败；部署脚本不自动升级付费方案。Gemini 本身的使用资格和额度仍由 Google 决定。

来源：[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[DO](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[Browser Run](https://developers.cloudflare.com/browser-run/pricing/)。

## 开发与维护

```powershell
npm run check
npm test
npm run format:check
npm run build
```

`npm run smoke:spark` 消耗最多 4 次真实 Spark 生成，测试文本、续聊、SSE、Responses；任一失败非零退出。它不会用普通 Gemini 或浏览器中转伪造 Spark 成功。

`npm run build` 只打包 dry-run，不发布。CI 不需要真实 Google Cookie 或 Cloudflare 密钥。集成测试在 workerd 中运行 SQLite DO 和 D1，Google 传输为模拟响应；socket 单元测试注入模拟连接，真实连接由独立线上验收覆盖。`npm run smoke` 会消耗 4 次真实生成：非流式、续聊、SSE 和 Responses，任一失败均非零退出。`tests/harness.ts` 只用于测试，不进入部署包。

- [架构与数据保留](docs/architecture.md)
- [API 使用与兼容范围](docs/api.md)
- [部署、密钥、故障排查、迁移与回滚](docs/operations.md)
- [当前验收结果](docs/verification.md)
- [参考仓库及旧版差异](docs/references.md)

## 协议来源与许可

协议字段参考 `gemini-web2api-go` 提交 `2158ea0bce6f5ae9cd7e8e9c04d4fd58b7986195`，保留其 MIT 声明，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。本项目与 Google、Cloudflare 均无官方关系；只用于自己拥有或获授权的账号，并遵守服务条款。使用网页非公开协议存在随时失效、账号受限和数据外发给 Google 的风险。
