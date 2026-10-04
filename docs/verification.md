# 验收记录 · 2026-10-05

## 当前结论

**已在 Cloudflare Workers Free + SQLite Durable Objects + D1 上打通真实文本与图片链路。** 默认传输为平台原生 TLS socket；运行时不需要 Roxy、本地常驻程序、外部代理/VPS、Browser Run 或 R2。Roxy 只用于首次导入或登录失效后重新导入。

这是可使用的网页协议网关，但不是参考 Go 项目全部能力等价、永久稳定或全部模型权益的承诺。没有切换付费套餐，也没有覆盖原 main 对应的旧 Worker。

## 正式部署的真实验收

测试实例：`gemini-web2api-native`。本轮功能代码部署版本：`a6d70869-4dea-4ff9-ae89-863f1be9dd6f`。

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

本轮本地测试：**95 项通过**，包含 workerd/SQLite DO/D1 集成测试和 27 个 socket 传输测试。TypeScript、Prettier 检查和 Wrangler dry-run 打包通过。模拟测试不替代上面的真实验收。

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
