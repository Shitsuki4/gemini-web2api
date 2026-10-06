# 架构与数据保留

## 请求路径

1. Worker 在解析大请求前校验 Bearer Key。管理员/API 密钥分离，未配置管理员密钥时 API 失败关闭。
2. D1 保存账号索引，按最久未使用顺序选择启用且不在冷却期的账号。显式会话固定路由到原账号。
3. 每个账号一个 SQLite Durable Object。DO 持有加密 Cookie、会话元数据、媒体地址和视频任务；同账号生成串行化，忙时返回 429。
4. `GeminiClient` 默认通过 Cloudflare `cloudflare:sockets` 直接连接 Google 443 端口，使用平台验证证书的 TLS + HTTP/1.1。**没有 Go TLS 指纹模拟、外部代理或浏览器伪装传输**。导入的 User-Agent 仅是普通 HTTP 头，不能改变出口 IP/TLS 指纹。
5. 网页响应按 XSSI/行包络解码，跨网络块维护 UTF-8 状态，再转成 OpenAI JSON/SSE。累计文本回退/改写会显式报错，不重复输出。
6. D1 将完成的生成尝试元数据和当日统计放入同一事务批次。DO Alarms 负责 Cookie 轮换、视频轮询和过期清理，默认不占 Cron 名额。

## 模块

| 文件                        | 职责                                             |
| --------------------------- | ------------------------------------------------ |
| `src/index.ts`              | 路由、鉴权、账号池、管理 API、适配入口           |
| `src/account.ts`            | DO 状态、并发、限流、加密存储、会话、作业、Alarm |
| `src/gemini/socket.ts`      | HTTPS 白名单、超时/取消、HTTP framing 校验和背压 |
| `src/gemini/client.ts`      | 页面令牌、生成、RPC、上传、轮换、限定主机下载    |
| `src/gemini/models.ts`      | 显式模型 ID、请求头、97 槽位请求体               |
| `src/gemini/protocol.ts`    | 包络、文本增量、实际模型、媒体地址识别           |
| `src/api.ts` / `src/sse.ts` | OpenAI 格式、输入验证、背压和心跳                |
| `public/`                   | 无构建依赖的管理台；上游返回文本不作为 HTML 执行 |

## 传输边界

`UPSTREAM_TRANSPORT=socket` 为默认路径；`fetch` 仅作显式诊断替代，**不会自动切换出口或重放失败生成**。GeminiClient 仅在 HTTP 400 时刷新页面令牌后重试一次；没有对 429、验证页或不确定提交做自动重放。每次 HTTPS 请求一个 socket，响应结束/取消/异常时关闭。禁止 HTTP、用户信息、非标准端口及任意目标主机；自管 Host、Content-Length、Connection 和压缩协商。分块、长度、头/响应大小均校验，截断不会当作正常结束。

保留 DO 而不保留旧版 `EgressRelay.fetch`：旧路径在 DO 内仍用 `fetch`，并不等同于 socket。详见[参考对照](references.md)。Cloudflare 放置 hint 只影响对象初始放置建议，不保证地点，也不会迁移已经存在的 DO。

## 持久化内容

| 内容                          | 位置            | 保留与隔离                                                 |
| ----------------------------- | --------------- | ---------------------------------------------------------- |
| Cookie、WIZ 令牌              | DO，AES-256-GCM | 到删除账号或重新导入；不对 API 返回原文                    |
| 会话 cid/rid/rcid、模型、轮次 | DO，AES-GCM     | 默认 7 天，不保存对话正文；按 API Key + 随机会话 ID 隔离   |
| 媒体上游 URL                  | DO，AES-GCM     | 1 小时；下载重新鉴权并检查资源所有者                       |
| 视频待提交输入                | DO，AES-GCM     | 提交完成或确定失败后移除输入；作业 24 小时过期             |
| 账号标签、健康/冷却状态       | D1              | 到删除账号；标签不要写敏感个人信息                         |
| API Key                       | D1 SHA-256 摘要 | 只在创建时返回明文；删除后不能继续访问旧会话/媒体          |
| 请求元数据                    | D1              | 30 天：时间、账号/key ID、模型、状态、耗时、字符数、错误码 |
| 每日请求/失败计数             | D1              | 365 天                                                     |

清理是渐进式的：每次维护每类扫描最多 25 项并保存游标，避免前 25 个未过期条目导致后续永久不清理。请求/下载接口会先检查 TTL，因此物理清理延迟不会延长访问期限。停用账号仍安排低频维护；删除账号清空其 DO 存储及 Alarm，D1 请求元数据仍按 30 天策略保留。没有任何剩余账号/Alarm 时，历史 D1 元数据需按运维文档手动清理。

AES-GCM 使用随机 IV；附加认证数据包含 DO ID 和存储键，防止密文被搬到另一个账号/记录后继续解密。它保护持久化内容，但不能防止拥有部署控制权的人读取运行时秘密。Google 仍会收到用户输入及上传文件。

## Login maintenance state machine

`src/gemini/refresh.ts` owns independent PSIDTS, SIDCC and page-token maintenance.
DO credentials persist attempt/completion times and the next allowed attempt before network I/O.
Partial cookie updates survive later failures. SIDCC already issued with the short ticket avoids a redundant rotation POST.
Alarms normally run every 600 seconds, with explicit server backoff and account serialization.
A generation can perform due maintenance before submission so sustained traffic cannot starve alarms.
Maintenance updates D1 `last_refresh` but not inference health/cooldown. No Cron, browser bridge, or new storage service is required.
See [operations](operations.md) for the state meanings and bounded observation command.

## 非等价能力

- Workers 不能复制参考 Go 项目的 Chrome TLS/HTTP2 指纹。
- 函数调用由提示词模拟，响应通过函数名/JSON 参数校验；网关从不执行函数。
- `thinking` 型号只是网页协议选项，不承诺固定思考深度，不输出私有推理过程。
- 媒体解析为实验性协议适配，返回的 MIME 为模型类别提示；下载 Content-Type 以上游真实响应为准。
- 视频提交中断时标记 `submission_uncertain`，不自动重复生成，避免消耗两次权益。
- 会话/媒体所有者以 API Key 身份标识；撤销/替换 Key 后，旧会话不会自动迁移。
