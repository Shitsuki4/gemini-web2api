# 运维、迁移与回滚

## 首先判断是否真的可用

`/healthz`、模型清单和成功导入 Cookie 都不能证明生成可用。用 `npm run smoke` 发出 4 次真实生成，验证固定答案、随机标记记忆续聊、多增量 SSE 和 Responses。每个请求独立超时；成功必须满足内容及协议断言。失败时脚本以非零退出，输出状态/错误码，不打印 Cookie 或密钥。不要批量重试验证页，也不要把模型列表当验收结果。

| 错误码 / 情况                             | 含义与处理                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `egress_blocked`                          | Google 返回 `/sorry` 跳转或明确的流量验证页；页面单独退避，停止盲目重试。这不是 Cookie 导入成功即可解决的问题 |
| `login_expired`                           | 跳到登录页或明确的未登录页面；在 Roxy 人工确认登录后更新原账号                                                |
| `page_tokens_missing`                     | 页面缺少可识别令牌但原因未确认；查看 `page_diagnostic`，不能直接断定过期或设备绑定                            |
| `consent_required`                        | Google 要求交互确认；在浏览器完成后再更新原账号                                                               |
| `refresh_no_ticket`                       | 轮换没有下发有效票据；检查各步骤状态，不能仅凭这一项认定设备绑定                                              |
| `upstream_redirect`                       | 未被允许自动跟随的跳转；只报告目标主机，不泄漏查询参数                                                        |
| `upstream_http_429`                       | 上游限流；不要立即重放生成                                                                                    |
| `account_busy` / `pool_busy`              | 账号串行锁占用，客户端应退避                                                                                  |
| `account_rate_limit`                      | 每账号每分钟 6 次尝试的本地保护；失败尝试也计数                                                               |
| `session_expired` / 404                   | 会话过期、不存在或不是当前 Key 的资源；新开会话                                                               |
| `submission_uncertain`                    | 视频提交中断，可能已消耗上游额度；不自动重复提交                                                              |
| `invalid_json_response` / `tool_required` | Gemini 未遵守提示词模拟的输出要求，不伪造结果                                                                 |
| Cloudflare 1102 / D1/DO quota error       | 可能触发免费 CPU/读写/持续时间等限制，不能用自动升级付费解决                                                  |

位置 hint 只是 Cloudflare 的放置建议，不保证国家/IP，也不是绕过 Google 拦截的能力。Browser Run 也会标识为机器人，免费 10 分钟/天，本项目不将其作为已验证后备方案。

### `gemini-image` 返回 `media_unavailable`

先看错误中的 `Upstream reply`，不要仅凭“无下载产物”就认定账号没有生图权限。若同时出现 `login_expired`，在 Roxy 确认登录后，用 `sync-roxy --account 原账号ID` 更新原账号，避免新增重复账号/旧会话失配。之后用 `npm run smoke:image-chat` 验证一次真实 Chat SSE 生图和下载；不要连续无界重试。

调试台更新后需刷新网页。如果接口已返回图片而页面不显示，检查图片文件请求的状态及静态资源 `_headers` 中的 `img-src ... blob:`。Worker 头和静态资源头必须一致，已有回归测试。自动 Cookie 续期仍是最佳努力，不承诺永久有效。

## 传输配置

`UPSTREAM_TRANSPORT=socket` 是实际已验收的默认链路，使用 Cloudflare 原生 TLS sockets，不依赖外部中转。`fetch` 仅供明确切换进行诊断，没有自动 fallback。协议层仅在 HTTP 400 时刷新页面令牌并重试一次；429、验证页和不确定提交不自动重放。

`1060` 不能仅凭错误码断定为 Cookie 失效或地区问题。本次旧 DO 失败、新建 DO 成功；修改 `ACCOUNT_LOCATION_HINT` 不会迁移旧对象。不要循环创建对象/刷 IP，保留固定实例并进行有界诊断。新建账号会得到新的本地会话空间，旧会话 ID 不能迁移。

Cookie 轮换本次返回过 HTTP 429，而随后生成仍成功；轮换失败不等于当前 Cookie 立即失效，也不代表永久有效。Alarm 最佳努力续期，遇到 429 不要连续手动刷新；如果实际生成失效，在 Roxy 重新确认登录再更新同一账号。

## 密钥管理

- `ADMIN_KEY`：至少 24 字符，仅管理端使用。
- `API_KEY`：可选初始客户端密钥；也可在管理台创建独立 Key。
- `ENCRYPTION_KEY`：base64 编码的 32 字节随机数；不是普通密码。
- `.local/secrets.json` 是本机私密文件。Windows 下 Node 的 mode 位不能替代 NTFS ACL，使用者应限制目录访问；不要将文件放入公开同步目录、截图或附件。
- 用户此前在聊天中明文粘贴过的 GitHub/Cloudflare 凭据应撤销并重发。项目不需要把这些部署凭据存为运行时秘密。

**不能直接替换 ENCRYPTION_KEY。** 旧 DO 密文将无法解密，连账号加载都可能失败。当前无自动重加密迁移：先备份旧密钥，在旧密钥仍有效时删除导入账号，再替换密钥并重新导入；或部署独立新实例，验收后再切换。这样会丢失本地会话/媒体/任务元数据，不删除 Google 侧会话。

## 无 Cron 的维护

启用账号通过 DO Alarm 正常约每 10 分钟尝试轮换 Cookie并清理状态；视频期间更频繁轮询。停用账号不生成/续期，低频维护数据。Alarm 时机不是精确计时 SLA，平台重试或繁忙会延迟。默认配置没有 Cron，因此不会删除或占用账号已有的 Cron 任务。

请求元数据 30 天、统计 365 天。若已删除最后一个账号，无 Alarm 继续清理 D1，可手动执行以下**明确删除过期日志**的命令：

```powershell
npx wrangler d1 execute DB --remote --command "DELETE FROM requests WHERE created_at < unixepoch() - 2592000; DELETE FROM daily_stats WHERE day < date('now','-365 days');"
```

请求日志不含正文；计数涵盖进入生成阶段的完成尝试和完成/失败的视频任务，不是所有 HTTP 请求。鉴权、验证、忙碌拒绝和异常中断未完成的日志可能不计入，监控不可据此计费。

## 旧版迁移

这是破坏性代码重构，不是旧 `worker.js` 的兼容补丁。

1. 保留旧 main、旧 Worker、旧 D1/KV/R2 和旧秘密。不要把旧 `.dev.vars` 当新配置使用。
2. 新建 `gemini-web2api-native` 和单独的 `gemini-web2api-v3` D1；配置中的 v1/v2 DO 迁移历史与旧项目保持一致。
3. 新建三类秘密、应用新 D1 schema、导入 Roxy 账号；不自动复制旧 plaintext Cookie/会话/记忆。
4. 真实文本/流式/连续会话/目标媒体能力全部验证后，才由维护者决定切换客户端 Base URL。
5. **当前真实生成失败，因此没有执行旧线上服务替换。** 本次代码留在独立重构分支。

不要随意把新配置的 Worker 名称改回旧名称后 deploy：v2 迁移包含退役 `EgressRelay`，可能删除旧 DO 数据。代码回滚不能恢复已删除的 DO 类和数据。

删除的旧功能包括外部代理/出口池、R2 路径、自动归组、长期记忆和旧版假定兼容接口。新旧配置、会话 ID 及 API 参数不是直接兼容的。

## 回滚

由于新部署完全独立，回滚是让客户端继续指向旧 Base URL；旧 Worker 与资源未改动。重构分支可保留，原 main 的 `cf94c7d` 是此次工作的起点。不执行 force-push 或重写旧历史。

如果要停用测试实例，先在管理台停用/删除导入账号，避免后台 Alarm 继续尝试续期；再按自己的资源保留要求删除新 Worker 和新 D1。不要删除名称相近的旧资源。

## 本地开发

建立 `.dev.vars`，只放 ADMIN_KEY、API_KEY、ENCRYPTION_KEY；具体值使用开发专用密钥，不要复制生产 Cookie 到测试夹具。然后执行 `npm run db:local` 和 `npm run dev`。已有 `.dev.vars` 不会被初始化脚本覆盖，需要自行确认它属于新版本。

`npm test` 使用独立内存数据库和假的 Google 响应，不需要 `.dev.vars`。不要将 `tests/harness.ts` 设为生产入口；`wrangler.toml` 始终指向 `src/index.ts`。

## 长期登录维护（2026-10-05 修订）

仅在 Cloudflare 内运行：导入后约 15 秒首次维护，正常每 600 秒一次；视频轮询、持续生成不会永久饿死维护。每次维护分开记录三项：

1. **短期票据**：`POST accounts.google.com/RotateCookies`，保留 JSPB 哨兵字面量 `[000,"-0000000000000000000"]`，只发送 `__Secure-1PSID` / `__Secure-1PSIDTS`。必须实际收到有效的 `__Secure-1PSIDTS` 才更新 `refreshed_at` / D1 `last_refresh`。
2. **SIDCC**：如果第一步已换发 `SIDCC` 或 `__Secure-1PSIDCC`，直接复用，避免重复 POST 触发 429；否则在 SIDCC 到期时 GET `RotateCookiesPage` 解析产品 658 的会话参数，再 POST `[658,"会话ID"]`。不保存或公开该参数。
3. **页面检查**：独立 GET `/app` 更新页面令牌。前两步 401/429 不会直接跳过页面检查；页面能打开并不证明短期票据已换发。

SIDCC 页面建议的间隔独立保留；即使 SIDCC 建议一小时后检查，短票仍正常每 10 分钟维护，未到期的 SIDCC 显示 `skipped / refresh_not_due`。

已取得的 Cookie 逐步加密保存；失败不会丢弃其他步骤的成功结果。只接受 accounts 响应里 `.google.com` 共享域、允许的 Cookie 名称，不把 accounts 的 host-only Cookie 发给 Gemini。删除/负 Max-Age/已过期 Cookie 不计为续期，Cookie 改变或强制页面检查时使旧令牌缓存失效。

### 状态和重试

管理台的“保活状态”读取 `/admin/accounts/{id}/status`；“检测/续期”执行一次受退避约束的维护。

- `healthy`：本轮票据与页面成功，SIDCC 已更新或仍在上次成功后的建议维护间隔内，**不表示永久登录**。
- `blocked`：最近的页面检查遇到 Google 流量验证；重新导入不一定解决，不换账号/出口绕过。
- `degraded`：部分成功；查看 `ticket`、`sidcc`、`page` 各自的结果。
- `reimport_required`：票据认证失败且页面登录已失效；先在浏览器确认登录，再更新原账号。
- `running`：维护进行中或上次在处理中断；后续由 Alarm 按持久化时间恢复。

**票据轮换与页面检查使用两个独立时钟**：`nextRotationAt` / `nextPageAt`，Alarm 的 `nextAttemptAt` 取二者最早值。票据仍成功时，无论页面是否失败，轮换保持正常约 10 分钟；页面的失败只延长页面检查间隔，不会再把票据一起拖到 20/40/80 分钟后。反之，轮换失败/退避也不阻止到期的页面检查。SIDCC 已随短票下发时仍不额外 POST。

每个时钟首次一般错误等待 10 分钟，认证错误等待 30 分钟，连续失败指数退避最多 6 小时。`Retry-After` 优先（解析上限 24 小时），作用于对应服务：accounts 的限流约束轮换两条流程，Gemini 页面的限流约束页面请求。不在页面受阻时用高频 GET、重放生成或更换 DO 绕过。

`page_diagnostic` 仅含时间、surface、HTTP 状态（可取得时）、字节数、令牌有无、账号标记有无、固定分类/错误码。**不保存页面正文、账号身份、Cookie、令牌值或重定向查询**。普通生成的重复预检也尊重该页面的持久退避，返回原错误类别与 `Retry-After`；到期维护仍可独立恢复。最近 24 次维护摘要保存在 `maintenance.history`，跳过的步骤保留原步骤时间，不伪装成新成功。`/refresh` 的 `renewed` 只有本次真的收到票据时才为 true。

`lastAttemptAt`、`lastCompletedAt`、`nextAttemptAt`、失败次数和各步骤时间都在 DO 加密凭据中持久化。部署/对象重建不清空退避；手动过早重试返回 `429 refresh_backoff` 和准确的 `Retry-After` 秒数。停用账号不发起登录维护，只做每日清理；重新导入凭据才重置维护状态。

D1 的 `health` / `cooldown_until` 仍表示生成健康度，不被后台部分失败覆盖。维护异常也会重新安排 Alarm。生成开始前可执行到期维护；如首次获取页面令牌明确登录失效，最多补一次尚未处于退避期的维护；这不会新增对已提交生成的重放（原有显式 HTTP 400 令牌纠正重试保持不变）。

### 可重复的无人值守验收

```powershell
# 事先设置 GATEWAY_URL、ADMIN_KEY；额外设置 API_KEY 才能加 --verify-chat
npm run watch:login -- --account acc_你的账号ID --minutes 35 --verify-chat
```

此脚本只每分钟读取状态，**不调用 refresh、不导入 Cookie、不连接 Roxy**。必须观察到至少两次新的自动票据换发且导入时间未改变才算通过；`--verify-chat` 最后额外发出一次真实文本生成。脚本有 1–120 分钟边界，失败非零退出。它只是验收工具，不需要常驻，也不是运行时依赖。

新浏览器会话可能采用设备绑定；401 也可能来自普通过期或其他认证原因，不能仅凭一个状态码断定 DBSC。本项目不会提取设备私钥、绕过验证或隐式切换出口。若重新导入后仍持续 401，可参考 Go 项目的说明，在 Firefox 手动重新登录并导出兼容会话再验证；不保证换浏览器必然解决。多个 10 分钟周期的成功只能证明观察窗口内有效，不能替代数天稳定性验证。

观察脚本只对本机到网关的状态 GET 连接错误做最多 3 次有界重试，并输出 `status_read_retry`；HTTP 错误不重试。不会重试最终生成，更不会调用刷新/导入来造出通过结果。输出中的 `status_read_retries` 用于审计本机网络中断。

如果反复在短时间后失效，Go 参考 README 还提示同一个浏览器继续轮换可能影响导出的会话，并建议使用独立的 Firefox 登录会话。可人工建立专供网关的会话、确认登录后更新原账号；不要持续在浏览器和网关两端同时使用同一复制会话。**这是后续排查建议，不是本账号已确认的根因，也不是 Firefox 能解决 Google 出口拦截或保证永久登录的承诺。** 本项目不会自动关闭用户的 Roxy/Chrome 或获取设备私钥。
