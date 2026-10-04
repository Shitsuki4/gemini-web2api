# API 使用

所有 `/v1/`、`/v1beta/` 请求均要求 `Authorization: Bearer <API_KEY>`；`/admin/` 使用独立 `ADMIN_KEY`。管理台只支持同源浏览器访问，未开放跨域 CORS。以下 JSON 中的文本和 ID 是示例，不是实际凭据。

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

响应头 `X-Session-Id` 形如 `acc_…​.s_…`。续聊通过请求头 `X-Session-Id` 或 JSON `session_id` 传回**完整原值**，只附一条新增 user/tool 消息，不要重发完整历史。不带 ID 则新建会话，没有隐式归组。会话不能切换模型，也不能跨 API Key 访问。失败/断流可能已消耗上游额度；没有幂等生成保证，不应盲目重试。

Chat SSE 为 `data: {...}`，正常完成发送 `data: [DONE]`。流建立后的错误用 `event: error` 表示，HTTP 200 不代表最终成功。Responses SSE 使用 `response.created`、增量/结束事件和 `response.completed`；失败发送 `response.failed`。工具输出及媒体输出可能缓冲后再发送，不承诺实时逐字。

## Responses

```json
{
  "model": "gemini-3.6-flash",
  "input": "解释 Durable Objects",
  "stream": true
}
```

支持基础 message、`function_call`、`function_call_output` 输入，及 `instructions`。不支持 `previous_response_id`、后台 Responses、服务端 response 查询/取消、完整 OpenAI SDK 参数集或 Codex CLI 全功能兼容承诺。续聊仍使用本项目 `session_id`。

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

- 图片：`{"prompt":"画一只猫","model":"gemini-image","response_format":"url"}`。返回下载 URL **仍需原 API Key**，不是公开永久链接，不支持 b64_json。
- 音乐/Canvas：通过 Chat 指定 `gemini-music` / `gemini-canvas`。Canvas 只作为文本返回，管理台不执行 HTML。
- 视频：`POST /v1/videos`，`{"prompt":"一段海浪视频","model":"gemini-video"}`，随后查询返回的完整 ID。状态 queued / in_progress / completed / failed。默认 10 分钟任务超时，24 小时作业 TTL；内容地址通常 1 小时过期。
- 不支持指定图片 size/quality/style/output_format 或视频 seconds/input_reference；不模拟这些参数生效。

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
