# 验收记录 · 2026-10-05

## 当前结论

**已在 Cloudflare Workers Free + SQLite Durable Objects + D1 上打通真实文本与图片链路。** 默认传输为平台原生 TLS socket；运行时不需要 Roxy、本地常驻程序、外部代理/VPS、Browser Run 或 R2。Roxy 只用于首次导入或登录失效后重新导入。

这是可使用的网页协议网关，但不是参考 Go 项目全部能力等价、永久稳定或全部模型权益的承诺。没有切换付费套餐，也没有覆盖原 main 对应的旧 Worker。

## 正式部署的真实验收

测试实例：`gemini-web2api-native`。文本/图片首次验收部署版本：`a6d70869-4dea-4ff9-ae89-863f1be9dd6f`。

| 项目             | 真实结果                                                    | 边界                                                                                                   |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 非流式 Chat      | HTTP 200，精确返回要求的 `CF_NATIVE_OK`                     | 不是只有模型清单或健康检查成功                                                                         |
| 第二轮续聊       | 先记住随机标记，再只发问题及 `X-Session-Id`，准确回答标记   | 第二个请求没有重发标记或完整对话历史                                                                   |
| Chat SSE         | 11 个非空文本增量，正常 stop 和 `[DONE]`，无 error 事件     | 首个文本增量约 2.8 秒，总约 5.8 秒；单次测量，不是性能 SLA                                             |
| Responses JSON   | HTTP 200，精确返回 `RESPONSES_NATIVE_OK`                    | 不是完整 Responses API 兼容证明                                                                        |
| 文本附件         | 上传 txt 后准确读出仅存在于文件中的标记                     | Gemini 可附加 `[cite: 1]` 引用；不能把严格全文相等失败误诊为上传失败                                   |
| 图片生成         | 返回 1 个鉴权产物地址                                       | 尚未证明所有图片提示词、尺寸或格式                                                                     |
| 图片下载         | HTTP 200，`image/jpeg`，8125 字节，视觉确认白底红圆符合提示 | 初版下载 403；补齐合法下载 Cookie 的票据字段后，同一个产物下载成功。该样本是 512×279，不宣称原始分辨率 |
| 手动 Cookie 轮换 | 上游 HTTP 429                                               | **未验收成功**。同一账号随后生成仍成功，不代表长期免登录续期成功                                       |
| 请求模型 ID      | `gemini-3.6-flash`、`gemini-3.8-flash` 均取得文本           | 本次 `actual_model` 未由上游给出，返回 null；不凭请求名推断真实模型版本                                |

最终部署后再次顺序执行 `npm run smoke` 和 `npm run smoke:media`，6 次真实生成全部通过：续聊标记精确匹配；SSE 为 10 个文本增量，首增量 3135 ms、总 5117 ms；附件标记读取成功；图片下载 JPEG 7913 字节。该回归使用同一固定启用账号，没有重新导入 Cookie 或连接 Roxy。

首次正式网关使用旧账号 DO 时返回 `1060`，新建账号 DO 后成功。同一凭据在诊断 DO 的严格 socket 实现中也成功。旧对象保留为停用；新对象固定使用，没有自动循环创建对象或切换出口。`ACCOUNT_LOCATION_HINT` 不会迁移已有对象；本次不足以确定旧对象失败的唯一原因。

## 为什么之前的结论被修正

之前只验收了 Workers fetch / Cloudflare Browser Run：

- Roxy 网页真实发送成功，证明登录态在浏览器中可用。
- Workers fetch 即使使用刚捕获的网页请求，仍得到 302 → Google `/sorry/index`。
- Cloudflare Chromium 能打开 example.com，但访问 Gemini 返回 `net::ERR_CONNECTION_RESET`。

这些是相应路径的真实失败证据，**不足以得出所有纯 Cloudflare 路径均不可行**。按用户要求重新对照 Sophomoresty、one880808 和原 main 后，发现被遗漏的原生 socket 传输。同一个诊断 DO 中 fetch 失败、socket 成功；随后严格重写 HTTP framing/超时/取消，并把它接入正式网关，取得上表结果。完整固定版本与对照见[参考记录](references.md)。

临时鉴权诊断 Worker `gemini-native-transport-check` 已删除。原始 Cookie、XSRF、跳转查询串、Google 页面 HTML、上游签名媒体地址不作为仓库内容或报告附件。没有终止用户 Roxy 浏览器。

## 可复现检查

```powershell
npm ci
npm run check
npm test
npm run format:check
npm run build
```

本轮本地测试：**112 项通过**，包含 workerd/SQLite DO/D1 集成测试和 28 个 socket 传输测试。TypeScript、Prettier 检查和 Wrangler dry-run 打包通过。模拟测试不替代上面的真实验收。

按 README 导入自己的账号并设置 `GATEWAY_URL` / `API_KEY` 后：

```powershell
npm run smoke        # 4 次生成：文本、真实上下文、SSE、Responses
npm run smoke:media  # 2 次生成：txt 附件、图片及鉴权下载
```

脚本任一断言失败即非零退出；每次请求独立超时，不把 SSE HTTP 200 当作最终成功，不打印 API Key/Cookie。受每账号每分钟 6 次尝试保护，已有其它调用时应等待下个时间窗，不要盲目重试。媒体测试还会消耗 Google 账号图片权益。

## 自动化测试覆盖

- 模型头/UUID/97 槽位、XSSI 包络、UTF-8 分片、实际模型字段、不导出私有推理。
- Socket 的 TLS 开启、UTF-8 请求长度、chunked/Content-Length/EOF、Set-Cookie、gzip、1xx/204。
- 逐字节边界、截断、冲突长度、异常头、头大小限制、背压、客户端取消、握手超时、错误脱敏、无隐式重放。
- 下载 Cookie 票据跨合法重定向保留，拒绝 host-only Cookie 和非白名单目的地。
- 加密认证数据、鉴权/API Key 撤销、会话和媒体所有者隔离、D1/DO 状态、显式参数拒绝。
- Chat/Responses 流生命周期、失败事件、Alarm/清理、媒体/视频模拟状态流转。
- 上一轮桌面/390px 管理台检查通过，未观察到 JS 异常；本轮没有改动页面布局。

## 尚未通过或尚未实测

1. 长期 Cookie 自动轮换；本次手动轮换返回 429。失效后仍需人工重新登录/导入。
2. 音乐、Canvas、视频生成/下载，PDF 和图片附件等其它输入形式的完整真实验收。
3. Responses SSE、函数工具、JSON 模式、Google 适配器的完整真实上游测试；目前有模拟测试。
4. 24 小时稳定性、Free 额度持续时间/CPU/并发压测、任意地区和其它账号成功率。
5. 全部模型权益、原图尺寸、全部 OpenAI/Google 客户端兼容性。

网页非公开协议和 Google 出口策略随时可能改变。遇到验证页/限流时返回真实错误，不绕过验证、不伪造成功、不无界重放。

## Spark Beta 追加验收（2026-10-05）

最终 Spark 实验入口部署版本：`c695dbce-d774-4b5c-acff-05e2dbf3c06b`。

**结论：已加入实验适配与管理台选项，但 Cloudflare Spark 尚未通过可用验收。** 不把 `/v1/models` 出现 `gemini-spark` 或浏览器成功当作云端成功；未采用普通 Flash 回退或 Roxy 代理来掩盖失败。

| 路径 / 检查                                            | 实际结果                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Roxy 网页 Spark 新任务与续聊                           | 精确返回独立测试标记；观察到真实答案帧与终止事件                                                           |
| Roxy 中运行同一 TypeScript 适配器，缩短的 Spark 模型头 | 5 个帧后无答案终止                                                                                         |
| Roxy 中同适配器，完整 capability/时间戳头              | 返回预期标记；Cookie + SAPISIDHASH 模式也通过；没有复制浏览器挑战字段                                      |
| Cloudflare 首次尝试                                    | `invalid_upstream_framing`；页面 CSP 头约 21 KiB，大于旧单行 8 KiB。已修复并加入回归测试，仍限制总头部大小 |
| 修复传输后 Cloudflare Spark                            | 一次 34.5 秒后 `no_content`，之后观察到 `gemini_1061`；没有把错误码武断解释成某种唯一原因                  |
| 独立 `/spark` 页面令牌、同一个固定账号 DO              | 曾出现页面缺少登录令牌；一次性重新导入 Roxy 登录态后能进入任务，但仍未取得答案                             |
| 最新 Cloudflare Spark 文本测试                         | 36 秒后 `no_content`；5 帧，已有任务和终止事件，却没有答案。字段 7 进度事件不冒充输出                      |

因此，**Cloudflare Spark 的真实续聊、SSE 成功生命周期、Responses 均未验收**，没有用模拟测试补写为成功。`npm run smoke:spark` 正确地在首个真实失败处非零退出。仅 Spark 的 payload、事件解析、拒绝未支持参数、DO 游标加密与续接有合成测试覆盖。

普通模型在本轮传输修复后的回归通过：4 次生成（非流式、只传 session ID 的随机标记续聊、SSE、Responses），SSE 11 个增量、首增量 1944 ms、总 3256 ms。Spark 不替换普通模型的请求体/默认模型。

与用户原任务分开的测试标签页用于取证；没有操作其已有任务、计划或关联应用。测试会在 Gemini 中留下少量明确的协议测试对话。Cloudflare 测试直接访问 Workers，不经过 Roxy；Roxy 只用于网页对照和一次性更新登录态。没有启用额外付费资源或创建新的出口池。

后续排查应保留这些失败证据；不能通过无界重试、复制挑战材料、伪造答案或简单给 Flash 加别名来宣称 Spark 可用。实验能力随时可能被 Google 改动，需要账号授权和独立真实验收。

最终部署后，再顺序运行普通 `smoke` 与 `smoke:media`：**6 次真实生成全部通过**。SSE 12 个增量，首增量 2667 ms、总 5600 ms；TXT 标记读取成功，图片鉴权下载返回 `image/jpeg`、7124 字节。没有再导入登录态或借助 Roxy 转发。这证明本轮 Spark 实验没有破坏已验收的普通能力，不证明 Spark 本身可用。

管理台实浏览器检查确认模型选项为“gemini-spark · Beta 未验收”，切换时显示未通过云端验收及禁止用于关联应用操作的说明。随后仅关闭独立测试标签页，保留用户原 Roxy 窗口/标签页。

## 2026-10-05：聊天生图错误与调试台图片显示

用户报告 `gemini-image` 的 `media_unavailable`。日志中最近三次用户失败都来自 Chat，约 6 秒；旧验收只覆盖 Images API，不能据此认定调试台也正常。本轮以“画一只可爱小猫”在同一 Cloudflare 账号复现了相同错误。

后续生成明确返回 `login_expired`。一次性从已登录 Roxy 更新**原账号**后，中文/英文两次 Chat 非流式生图成功。旧错误未保留具体上游回复，故不能断言那三次原始失败的唯一原因；也没有证据证明是图片权限不足。新增错误摘要只取用户可见回复，脱敏并限长，保持请求日志不记录正文。

已完成的线上检查（直接访问原 Worker、无 Roxy 运行时转发）：

- 新增 `smoke:image-chat`：真实 Chat SSE 成功终止 + 原 Key 下载，HTTP 200、`image/jpeg`、54,754 字节，约 19.3 秒。
- 调试台首轮：图片已生成并下载，但浏览器未显示；查明静态资源 `_headers` CSP 仍禁止 Blob。修正静态资源及 Worker 两处 CSP，并增加一致性回归测试。
- 修正后调试台：同一中文提示经实际表单发起生图，显示 **512×279** 小猫图片（JPEG，约 45 KiB），下载按钮采用正确 `.jpg` 扩展名。用独立测试标签页完成，随后关闭该页，未关闭用户原标签页。
- 不再把 `googleusercontent.com/image_generation_content/...` 显示占位地址当成用户可用链接。
- **124 项测试通过**，覆盖缺失媒体的 SSE 错误、Chat 媒体成功、错误摘要脱敏、鉴权下载、拒绝外部文件标识/HTML/SVG、预览体积上限及 CSP；类型检查、格式、构建通过。

这次恢复不等于已证明 Cookie 长期自动续期稳定，也不保证任意提示或任何账号都可生图。原始三次失败若需精确归因，仍需要当时的提示及可见上游说明；不会靠猜测限制原因或隐式更换模型宣称解决。

最终版本普通回归再次通过：Chat 非流式、随机标记远端续聊、真实 SSE（9 个增量，首增量 3093 ms、总计 5826 ms）、Responses 共 4 次真实生成。期间没有再次导入 Cookie。
