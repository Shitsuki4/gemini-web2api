# gemini-web2api (Cloudflare Worker)

[Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/) 的 Cloudflare Workers 移植版(单文件 `worker.js`)。已对齐上游 **2026-08-15 (`2bb988b`)** 的功能。

将 Google Gemini 网页端转换为 OpenAI / Google 原生兼容 API。

## 特性

- **可选密钥**: `API_KEYS` 为空时免密,填入密钥后按 OpenAI Bearer Key 校验
- **OpenAI 兼容**: `/v1/chat/completions`、`/v1/models`
- **Responses API**: `/v1/responses`(完整事件序列,兼容 Codex CLI 等严格客户端)
- **Google 原生 API**: `/v1beta/models/{model}:generateContent` / `:streamGenerateContent`
- **工具调用**: Function Calling(OpenAI 格式);大工具列表自动裁剪参数防静默截断
- **多模型**: `gemini-3.7-flash`、`gemini-3.6-flash`、3.5-flash、Thinking、Pro、Auto、Lite 等
- **思考深度**: 模型名加 `@think=N` 后缀调节
- **多模态输入**: 支持 OpenAI `image_url` / `input_image` / Anthropic `image` 风格(base64 data: URL、URL-encoded data: URL、http(s) 链接);需配置 `GEMINI_COOKIE`,经 Scotty 续传上传到 Gemini
- **多 Google 账号**: `AUTH_USER` 指定非默认账号(`/u/{n}` 前缀 + `X-Goog-AuthUser` 头)
- **XSRF token**: 可选 `XSRF_TOKEN`(SNlM0e),payload 自动带 `at=` 参数
- **临时会话**: `TEMPORARY_CHATS=true` 时按 Gemini Web 临时会话发送(不落历史)
- **BL 自动更新**: 上游 405(BL 过期)时自动抓取最新构建号并重试一次
- **错误透传**: `BardErrorInfo[code]` 拒绝时返回明确错误,不再静默空白
- **流式可靠性**: 重试时校验已输出前缀一致,防止内容错乱
- **出口 IP 规避**: 上游请求优先走 `cloudflare:sockets` 裸 TCP,绕开 fetch 的 429 限流
- **调试端点**: `GET /debug` 从部署环境实地探测上游(状态/片段/BL)
- **客户端 IP 日志**: 访问日志携带 `cf-connecting-ip`

## 快速开始

1. 复制 `worker.js` 全部内容
2. Cloudflare 后台 → Workers & Pages → Create → 粘贴 → Deploy
3. (推荐)在 Worker Settings → Variables and Secrets 里配置:
   - `GEMINI_COOKIE`(secret):Gemini 登录 cookie,解锁 Pro 路由和图片输入
   - `API_KEYS`(secret):调用方密钥,留空则任何人可调用

也可以直接编辑 `worker.js` 顶部的 `CONFIG` 对象,无需任何环境变量。

## 配置项

| 键 | 说明 |
|---|---|
| `API_KEYS` | 逗号分隔或 JSON 数组;空 = 不鉴权 |
| `GEMINI_COOKIE` / `SAPISID` | 完整 cookie 字符串(或 JSON `{"cookie","sapisid"}`) |
| `GEMINI_BL` | Gemini 网页构建号(过期后请求会被 405 拒绝;`AUTO_UPDATE_BL=true` 时自动更新) |
| `GEMINI_ORIGIN` | 上游源站;部署 IP 被 Google 429 时指向干净 IP 的反向代理 |
| `UPSTREAM_SOCKET` | `true`=上游优先裸 socket(绕 fetch 429) |
| `AUTH_USER` | Google 多账号序号,留空 = 默认账号 |
| `XSRF_TOKEN` | 可选 SNlM0e at-token,风控严格环境需要 |
| `TEMPORARY_CHATS` | `true` = 临时会话,不保存历史 |
| `AUTO_UPDATE_BL` | `true` = 405 时自动抓最新 BL 重试 |
| `DEFAULT_MODEL` | 默认模型(默认 `gemini-3.6-flash`) |
| `RETRY_ATTEMPTS` / `RETRY_DELAY_SEC` / `REQUEST_TIMEOUT_SEC` | 重试与超时 |
| `LOG_REQUESTS` | 访问日志开关 |

每个键都可以用同名 Worker 环境变量 / secret 覆盖。

## 已知限制

- **上游风控**:Google 会按出口 IP 拒绝部分数据中心流量(`BardErrorInfo[1060]`)。在 Cloudflare 部署若遇此问题,把 `GEMINI_ORIGIN` 指向一个住宅/干净 IP 的反向代理。
- **单轮对话**: 每次请求是独立对话,多轮上下文通过在 prompt 中包含历史消息模拟。
- **图片需登录态**: 未配置 `GEMINI_COOKIE` 时图片会被忽略并在 prompt 中提示。

## 工作原理

逆向 Google Gemini 网页端的 StreamGenerate 协议,将 OpenAI API 格式与 Gemini 内部 protobuf-like 格式互转。模型选择通过请求 payload 的 `[79]` 字段控制,映射自 Gemini 前端 JS 的 `MODE_CATEGORY` 枚举。

## 致谢
- [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/)(上游,功能基准)
- [one880808/gemini-web2api](https://github.com/one880808/gemini-web2api)(本 fork 的源)
- [linux.do](https://linux.do) 社区

## License
MIT
