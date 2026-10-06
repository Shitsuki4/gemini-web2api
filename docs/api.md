# API 使用

除浏览器 `OPTIONS` 预检外，所有 `/v1/`、`/v1beta/` 请求均要求 `Authorization: Bearer <API_KEY>`；`/admin/` 使用独立 `ADMIN_KEY`。管理接口 `/admin/` 仍只支持同源浏览器访问，不开放跨域 CORS。推理 API 支持跨域浏览器客户端（`Access-Control-Allow-Origin: *`），仍需 API Key，不允许携带 Cookie 凭据。以下 JSON 中的文本和 ID 是示例，不是实际凭据。

## 浏览器客户端与 `Failed to fetch`

- Base URL 使用 `https://<你的网关>/v1`；API Key 通过 `Authorization` 或 `X-API-Key` 请求头发送，不放入 URL。
- 跨域调用使用 `credentials: "omit"`（或默认的 `same-origin`），不要设置 `include`。仅预检无需鉴权，真正的模型、生成和文件请求都需要有效 API Key。
- `/v1/` 和 `/v1beta/` 支持 `GET, POST, OPTIONS` 预检及浏览器 SDK 自定义请求头；前提是字段名合法且总长度/数量受限。成功和错误响应均带 CORS；可读取 `X-Gemini-Session-Id`、`X-Session-Id`、`Retry-After` 和下载元数据。不要把 ADMIN_KEY 填入第三方客户端，也不要把推理 API Key 交给不可信网页。
- `Failed to fetch` 是浏览器无法获得可读响应，不足以证明 Gemini 登录失效；常见原因包括网络、错误地址、浏览器跨域策略或代理断流。用开发者工具检查 OPTIONS/POST 的状态，与管理台“请求记录”对照；记录缺失不单独证明请求从未到达服务器。
- 自带管理台区分读取、写入、生成和下载的连接失败，不自动重发操作。生成 POST 失败可能已经消耗上游额度；先查记录再决定下一步。不要关闭浏览器安全检查或使用 `no-cors`（只会得到不可读响应）。

## 基础端点

| 方法 / 路径                                   | 用途                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| `GET /healthz`                                | 网关存活；`upstream_verified:false` 不得当作 Gemini 健康检查 |
| `GET /v1/models`                              | 静态协议模型清单，不验证权益                                 |
| `POST /v1/chat/completions`                   | Chat JSON 或 SSE                                             |
| `POST /v1/responses`                          | Responses 基本兼容 JSON 或 SSE                               |
| `POST /v1/images/generations`                 | 实验性图片生成；仅 n=1 和 URL 输出                           |
| `POST /v1/videos`                             | 实验性视频任务，返回 202 及任务 ID                           |
| `GET /v1/videos/{id}`                         | 视频状态                                                     |
| `GET /v1/videos/{id}/content`                 | 完成后下载视频，仍需原 API Key                               |
| `GET /v1/files/{id}/content`                  | 鉴权媒体下载，支持 Range 透传                                |
| `POST /v1beta/models/{model}:generateContent` | 基础非流式 Google 适配                                       |

模型：`gemini-3.6-flash`、`gemini-3.5-flash-lite`、`gemini-3.1-pro`、`gemini-3.8-flash`，分别提供 `-thinking` 选项；媒体为 `gemini-image`、`gemini-music`、`gemini-canvas`、`gemini-video`。名称/版本来自参考协议，不保证 Google 当前对账号开放。

## 文本与会话

```json
{
  "model": "gemini-3.6-flash",
  "messages": [{ "role": "user", "content": "介绍一下 Cloudflare Workers" }],
  "stream": true
}
```

### 客户端会话标识与 Gemini 续聊

普通 OpenAI 客户端直接发送完整 `messages` 历史即可，无需设置网关续聊参数。

- 响应头 `X-Gemini-Session-Id` 形如 `acc_<32hex>.s_<32hex>`，兼容响应头 `X-Session-Id` 返回相同值；跨域浏览器可读取两个头。
- **网关远程续聊**：通过 JSON `gemini_session_id` 或请求头 `X-Gemini-Session-Id` 传回完整原值，并且只发送一条新增 user/tool 消息，不能重发完整历史。会话不能切换模型或跨 API Key 访问；不存在或过期的会话仍报错，不会悄悄新建。
- **旧版兼容**：`session_id` / `X-Session-Id` 中的合法网关 ID 仍然按上述续聊处理。
- **客户端自定义 ID**：旧字段里的普通 UUID、追踪或会话字符串仅作为不参与路由的客户端标识忽略；必须发送完整历史。相同客户端 ID 不会自动恢复 Gemini 上下文，也不会做账号绑定或去重。旧字段 `null`/空串视为未设置。
- 显式 `gemini_session_id` / `X-Gemini-Session-Id` 只接受完整网关 ID。截断的 `acc_…`/`s_…`、非法类型、控制字符或超过 512 字符的标识返回 `400 invalid_session_id`；多个网关 ID 不一致返回 `400 conflicting_session_ids`，不按字段优先级猜测。

不带网关 ID 则新建会话，没有隐式归组。失败/断流可能已消耗上游额度；没有幂等生成保证，不应盲目重试。

Chat SSE 为 `data: {...}`，正常完成发送 `data: [DONE]`。流建立后的错误用 `event: error` 表示，HTTP 200 不代表最终成功。Responses SSE 使用 `response.created`、增量/结束事件和 `response.completed`；失败发送 `response.failed`。工具输出及媒体输出可能缓冲后再发送，不承诺实时逐字。

## Spark Beta（实验性文本适配）

请求 `"model": "gemini-spark"`，使用同样的 Chat/Responses 接口和 `X-Gemini-Session-Id` 续聊。它是网页 Spark 任务模式（tool 40），不是给普通 Flash 换名；需要账号本身能使用 Spark。模型清单不代表账号权益或上游健康。

```json
{
  "model": "gemini-spark",
  "messages": [
    {
      "role": "user",
      "content": "只用文字解释闭包，不调用工具或访问关联应用。"
    }
  ],
  "stream": true
}
```

- 独立 99 槽请求、Spark 模型头、`/spark` 页面令牌及加密任务续接游标；不能和普通模型切换同一会话。
- 当前范围是文本对话；附件、函数工具、JSON object 结构化输出直接返回 `400 spark_text_only`。显式 `response_format: {"type":"text"}` 可用。
- 只导出答案帧，不导出计划、私有推理、工具参数或关联应用的中间数据。游标只保存在加密会话内，不返回客户端。
- Spark 可能先处理任务、最后一次性给出答案。SSE 按收到的真实答案帧发送；不人为切字，不承诺逐 token、多增量或立即出首字。没有终止事件则返回 `spark_incomplete`，没有答案则返回真实上游错误或 `no_content`，不能把 HTTP 200 的事件流当作成功。
- 网关加入“仅文本、不调用工具/关联应用/计划任务”的范围提示；**提示词不是强制沙箱**，并无已验证的服务端禁用关联应用开关。不要用此入口执行外部操作或发送敏感应用数据；需要更强隔离时，使用未关联外部应用的专用账号。未提供任务管理、审批、计划、技能、关联应用或后台代理 API。
- 请求超时/断流不等于上游任务已取消。网关不自动重放任务，也不提供幂等提交承诺。实际测试结果及失败边界见[验收报告](verification.md)。

## Responses

```json
{
  "model": "gemini-3.6-flash",
  "input": "解释 Durable Objects",
  "stream": true
}
```

支持基础 message、`function_call`、`function_call_output` 输入，及 `instructions`。不支持 `previous_response_id`、后台 Responses、服务端 response 查询/取消、完整 OpenAI SDK 参数集或 Codex CLI 全功能兼容承诺。续聊使用本项目 `gemini_session_id`（兼容合法旧 `session_id`），不将 OpenAI response ID 作为会话 ID。

## 附件

消息内容可用 `text`、`input_text`、`output_text`、`image_url`、`input_image`、`input_file`。图片 URL 必须是 base64 data URL；文件使用 `file_data`（base64 data URL）和可选 `filename`。

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "总结这个附件" },
        {
          "type": "input_file",
          "filename": "hello.txt",
          "file_data": "data:text/plain;base64,SGVsbG8="
        }
      ]
    }
  ]
}
```

上限：1 MiB 整体 JSON、768 KiB 每个解码文件、4 个附件、128 条消息、10 万字符总提示词（含工具说明）。这些是保护上限，不是 Free 计划下的成功性能保证。远程 HTTP(S) 文件 URL 一律拒绝，防止 SSRF；未实现 `/v1/files` 上传/持久化文件 API。

## 工具、JSON 和不支持的参数

`tools` 仅支持函数（最多 32 个），不支持内置 web_search/code_interpreter。`tool_choice` 支持 auto/none/required/指定函数；采用提示词模拟并验证返回函数名/JSON 参数，**不执行函数**。函数 schema 的 `strict:true` 被拒绝。

JSON 模式仅 `response_format:{"type":"json_object"}`；Responses 可用 `text.format`。最终输出不是 JSON object 时返回错误。`json_schema` 不支持。

`temperature`、`top_p`、`top_k`、`max_tokens`、`max_completion_tokens`、`max_output_tokens`、`stop`、`seed`、logprobs、惩罚项、`logit_bias`、`parallel_tool_calls`、`reasoning`、`background`、`store`、`truncation` 等参数被显式拒绝，而非假装生效。Chat 不返回虚构 usage，Responses `usage:null`。

## 媒体实验接口

本次已实际验收图片生成及 JPEG 下载；音乐、Canvas、视频尚未实测成功。txt 附件已验收，其它附件格式不能仅凭相同接口推定可用。

- 图片：`{"prompt":"画一只猫","model":"gemini-image","response_format":"url"}`。返回下载 URL **仍需原 API Key**，不是公开永久链接，不支持 b64_json。
- 音乐/Canvas：通过 Chat 指定 `gemini-music` / `gemini-canvas`。Canvas 只作为文本返回，管理台不执行 HTML。
- 视频：`POST /v1/videos`，`{"prompt":"一段海浪视频","model":"gemini-video"}`，随后查询返回的完整 ID。状态 queued / in_progress / completed / failed。默认 10 分钟任务超时，24 小时作业 TTL；内容地址通常 1 小时过期。
- 不支持指定图片 size/quality/style/output_format 或视频 seconds/input_reference；不模拟这些参数生效。

### 聊天生图、预览和错误

`gemini-image` 也可通过 `/v1/chat/completions` 使用，包括 `stream:true`。媒体生成先缓冲，成功时发送下载链接和 `gemini.artifacts`，最后才发送 `[DONE]`；不能把 HTTP 200 的 SSE 握手当成图片已生成。没有媒体时发送 `event: error`，不伪造成功终止。

管理台使用原调用 API Key 的 Authorization 头获取文件，生成本地 Blob 预览和下载按钮；不把 Key 放入 URL，不把 Google 签名 URL 暴露给浏览器，也不跟随外部重定向。网页预览限 20 MiB，仅接受 PNG/JPEG/WebP/GIF 及指定音频 MIME，不执行 HTML/SVG。下载的 `Content-Type` 才是实际格式；`gemini.artifacts[].mime` 当前只是类型提示，图片实际可能是 JPEG 而非 PNG。

`media_unavailable` 仅说明未获取到可下载媒体。错误的 `Upstream reply` 保留上游可见回复摘要（最多 600 字符，URL 已移除），不会包含私有推理或整包协议数据，也不会写入请求日志。没有上游解释时不猜测原因。实际配额、提示限制、会话失效或协议变化需按证据区分；不会自动重放生成。

## 管理端点

| 路径                           | 方法                                                 |
| ------------------------------ | ---------------------------------------------------- |
| `/admin/accounts`              | GET 列表、POST 导入                                  |
| `/admin/accounts/{id}`         | PUT 更新 Cookie/标签/启停、DELETE 删除账号及 DO 数据 |
| `/admin/accounts/{id}/status`  | GET 账号元数据，绝不返回 Cookie 原值                 |
| `/admin/accounts/{id}/refresh` | POST 尝试轮换 Cookie                                 |
| `/admin/accounts/{id}/models`  | GET 上游模型 RPC，可能受同样出口限制                 |
| `/admin/keys`                  | GET 列表、POST 创建一次性显示密钥                    |
| `/admin/keys/{id}`             | DELETE 撤销                                          |
| `/admin/requests`              | GET 最近 100 条元数据；可用 before 秒级时间戳        |
| `/admin/stats`                 | GET 最近 24 小时及最近 30 天统计                     |
| `/admin/config`                | GET 不含秘密的运行配置                               |

`before` 分页以秒为粒度，同一秒多条记录可能跨页遗漏；当前管理台定位为最近请求查看，不是审计导出系统。

常见错误与处理见 [运维](operations.md)。

### 账号保活状态 API

`GET /admin/accounts/{id}/status` 新增 `imported_at` 与 `maintenance`。后者包含 `status`、`lastAttemptAt`、`lastCompletedAt`、`nextAttemptAt`、`failures`、`lastTicketAt`、`lastSidccAt`、`lastPageAt`，以及 `ticket` / `sidcc` / `page` 三个结果。各步骤只返回状态、时间、错误码和 Cookie **名称**，不返回 Cookie、页面令牌或会话参数。所有时间为 Unix 秒；尚未检查时 `maintenance:null`。

`POST /admin/accounts/{id}/refresh` 完成一轮诊断后返回 HTTP 200：

```json
{
  "ok": false,
  "renewed": false,
  "refreshed_at": 0,
  "maintenance": {
    "status": "reimport_required",
    "lastAttemptAt": 1791162350,
    "nextAttemptAt": 1791164150,
    "failures": 1,
    "ticket": {
      "status": "error",
      "at": 1791162350,
      "code": "refresh_http_401"
    },
    "sidcc": {
      "status": "error",
      "at": 1791162350,
      "code": "refresh_http_401"
    },
    "page": { "status": "error", "at": 1791162350, "code": "login_expired" }
  },
  "message": "自动续期未恢复登录，请更新原账号。"
}
```

HTTP 200 只表示诊断完成；必须检查 `ok` / `renewed` 和各步骤。`ok:true` 表示票据与页面成功，SIDCC 已更新或仍在建议有效维护间隔内；`renewed:true` 只表示本轮确实换发了短期票据。退避期内不发上游请求，返回 `429 refresh_backoff` 与 `Retry-After`；账号停用时返回 `503 account_disabled`。
