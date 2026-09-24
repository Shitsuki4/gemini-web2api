# gemini-web2api (Cloudflare Worker)

> **独立项目**:本仓库不是 GitHub fork,而是一个独立维护的仓库(历史来自早期 fork,现已脱离 fork 关系)。参考上游 Python 版 [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/) 的能力,已在 Cloudflare Workers 上对齐到 **2026-09-25(`codex/openai-multimodal-support`, `4c934286`)** 并做了 Workers 侧增强(区域出口池、KV/D1 状态、SSRF 防护等)。

把 Google Gemini 网页端转换为 OpenAI / Google 原生兼容 API 的单文件 Cloudflare Worker(`worker.js`)。

## 特性

- **可选密钥**: `API_KEYS` 为空时免密,填入密钥后按 OpenAI Bearer Key 校验
- **OpenAI 兼容**: `/v1/chat/completions`、`/v1/models`
- **Responses API**: `/v1/responses`(完整事件序列,兼容 Codex CLI 等严格客户端)
- **Google 原生 API**: `/v1beta/models/{model}:generateContent` / `:streamGenerateContent`
- **工具调用**: Function Calling(OpenAI 格式);大工具列表自动裁剪参数防静默截断
- **图片生成**: 输出带 `lh3.googleusercontent.com/gg-dl/...` 链接,同时以 `message.images[]` 返回;流式同样支持
- **多模型**: `gemini-3.7-flash`、`gemini-3.6-flash`、3.5-flash、Thinking、Pro、Auto、Lite 等
- **思考深度**: 模型名加 `@think=N` 后缀调节
- **多模态输入**: 支持 OpenAI `image_url` / `input_image` / Anthropic `image` 风格(base64 data: URL、URL-encoded data: URL、http(s) 链接);需配置 `GEMINI_COOKIE`,经 Scotty 续传上传到 Gemini
- **图片 MIME 嗅探**: 按 magic bytes 修正 PNG/JPEG/GIF/WebP/BMP/TIFF/AVIF/HEIC,不信任声明的 content-type
- **SSRF 防护**: http(s) 白名单 + 内网/元数据地址拦截 + Cloudflare DoH(回退 Google DoH)解析校验 + 每跳重定向复检 + 20MB 体积上限(见下)
- **图片引用缓存**: 同一张图按内容 SHA-256 缓存 Gemini 文件引用,命中则跳过重复上传(R2 优先,未绑 R2 时退 D1 `file_cache`)
- **多 Google 账号**: `AUTH_USER` 指定非默认账号(`/u/{n}` 前缀 + `X-Goog-AuthUser` 头)
- **XSRF token**: 可选 `XSRF_TOKEN`(SNlM0e),payload 自动带 `at=` 参数
- **临时会话**: `TEMPORARY_CHATS=true` 时按 Gemini Web 临时会话发送(不落历史)
- **BL 自动更新**: 上游 405(BL 过期)时自动抓取最新构建号并重试一次
- **错误透传**: `BardErrorInfo[code]` 拒绝时返回明确错误,不再静默空白
- **流式可靠性**: 重试时校验已输出前缀一致,防止内容错乱
- **出口 IP 规避**: 上游请求优先走 `cloudflare:sockets` 裸 TCP,绕开 fetch 的 429 限流
- **区域出口池**: `DO_EGRESS` + `EgressRelay` Durable Object 按 `weur/eeur/wnam` 等 locationHint 轮换出口机房(图片生成在香港机房不可用)
- **1060/429/图片地区重试**: `BardErrorInfo[1060]`、429、以及"image creation isn't available in your location"都会触发换出口重试
- **客户端 IP 日志**: 访问日志携带 `cf-connecting-ip`

## HTTP 端点

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions(支持 `stream`) |
| `POST /v1/responses` | OpenAI Responses API |
| `GET /v1/models` | 模型列表 |
| `POST /v1beta/models/{model}:generateContent` | Google 原生(非流式) |
| `POST /v1beta/models/{model}:streamGenerateContent` | Google 原生(流式,`?alt=sse`) |
| `GET /health` · `GET /healthz` | 健康检查(版本、模型数、cookie 状态、出口提示、限流参数) |
| `GET /admin/state` | 运行状态(加 `?live=1` 实地探测上游) |
| `POST /admin/cookie` | 热更新 cookie/state(写入 KV) |
| `GET /debug` | 从部署环境实地探测上游(状态/片段/BL) |

## 快速开始

1. 复制 `worker.js` 全部内容
2. Cloudflare 后台 → Workers & Pages → Create → 粘贴 → Deploy
3. (推荐)在 Worker Settings → Variables and Secrets 里配置:
   - `GEMINI_COOKIE`(secret):Gemini 登录 cookie,解锁 Pro 路由和图片输入
   - `API_KEYS`(secret):调用方密钥,留空则任何人可调用

也可以直接编辑 `worker.js` 顶部的 `CONFIG` 对象,无需任何环境变量。

## 部署配置(wrangler)

`wrangler.toml` 里可选绑定:

- `[[kv_namespaces]]` 绑定 `STATE`:热更新 cookie / bl / xsrf,无需重新部署
- `[[d1_databases]]` 绑定 `DB`:图片文件引用缓存表 `file_cache`
- `[[durable_objects.bindings]]` 绑定 `EGRESS`(`EgressRelay`):区域出口池
- `[triggers]` cron:定期抓 Gemini 首页刷新滚动 token(`__Secure-1PSIDTS` / `SNlM0e` / `bl`)
- (可选)R2 bucket 绑定 `FILECACHE`:图片引用缓存优先走 R2,未绑时退 D1

## 配置项

| 键 | 说明 |
|---|---|
| `API_KEYS` | 逗号分隔或 JSON 数组;空 = 不鉴权 |
| `GEMINI_COOKIE` / `GEMINI_COOKIES` / `COOKIE_STRING` | 完整 cookie 字符串(或 JSON `{"cookie","sapisid"}`);`GEMINI_COOKIES` 用 `\|` 分隔多个账号组成 cookie 池 |
| `GEMINI_BL` | Gemini 网页构建号(过期后请求会被 405 拒绝;`AUTO_UPDATE_BL=true` 时自动更新) |
| `GEMINI_ORIGIN` | 上游源站;部署 IP 被 Google 429 时指向干净 IP 的反向代理 |
| `UPSTREAM_SOCKET` | `true`=上游优先裸 socket(绕 fetch 429) |
| `AUTH_USER` | Google 多账号序号,留空 = 默认账号 |
| `XSRF_TOKEN` | 可选 SNlM0e at-token,风控严格环境需要 |
| `TEMPORARY_CHATS` | `true` = 临时会话,不保存历史 |
| `AUTO_UPDATE_BL` | `true` = 405 时自动抓最新 BL 重试 |
| `DEFAULT_MODEL` | 默认模型(默认 `gemini-3.6-flash`) |
| `RETRY_ATTEMPTS` / `RETRY_DELAY_SEC` / `REQUEST_TIMEOUT_SEC` | 重试与超时 |
| `DO_EGRESS` / `EGRESS_HINT` / `EGRESS_FALLBACK_HINTS` | 区域出口池开关与机房顺序(默认 `weur,eeur,wnam`) |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SEC` | 每 isolate 滑动窗口限流(默认 3000 / 60s,超出返回 429) |
| `FINGERPRINT_JITTER_MS` | 请求前随机抖动(默认 1500ms),降低风控特征 |
| `LOG_REQUESTS` | 访问日志开关 |

每个键都可以用同名 Worker 环境变量 / secret 覆盖。

## 图片输入与 SSRF 防护

图片输入支持三种形态,统一走 `imageFromPart()` 归一化:

```jsonc
// OpenAI Chat Completions
{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}   // 或 https:// 链接
// OpenAI Responses
{"type":"input_image","image_url":"https://example.com/a.png"}
// Anthropic
{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"..."}}
```

远程 URL 的防护(`fetchRemoteImage`):

- 仅允许 `http:` / `https:`,拒绝带用户名/密码的 URL
- 拒绝 `localhost` / `*.local` / `*.internal` / `*.home.arpa` / `metadata.google.internal`
- 拒绝回环、私有、链路本地、CGNAT、组播段(`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、`::1`、`fc00::/7`、`fe80::/10`、v4-mapped 等)
- 域名先经 DoH(Cloudflare,失败回退 Google)解析,命中内网 IP 即拦截;DoH 全部失败时**失败关闭**
- 手动跟跳重定向,每一跳都重新做上述校验,最多 5 跳
- 单图 20MB 上限;按 magic bytes 嗅探真实类型
- 全部图片上传失败时返回 `502 all image uploads failed: ...`;部分失败会记录日志并继续

## 已知限制

- **上游风控**:Google 会按出口 IP 拒绝部分数据中心流量(`BardErrorInfo[1060]`)。在 Cloudflare 部署若遇此问题,把 `GEMINI_ORIGIN` 指向一个住宅/干净 IP 的反向代理,或依赖 `DO_EGRESS` 出口池换机房。
- **单轮对话**: 每次请求是独立对话,多轮上下文通过在 prompt 中包含历史消息模拟。
- **图片需登录态**: 未配置 `GEMINI_COOKIE` 时图片会被忽略并在 prompt 中提示。
- **限流为 isolate 级**:`RATE_LIMIT_*` 是每 isolate 内存计数,不是全局限流。

## 工作原理

逆向 Google Gemini 网页端的 StreamGenerate 协议,将 OpenAI API 格式与 Gemini 内部 protobuf-like 格式互转。模型选择通过请求 payload 的 `[79]` 字段控制,映射自 Gemini 前端 JS 的 `MODE_CATEGORY` 枚举。图片经 Scotty 续传接口上传换取文件引用,再随 payload 一起发送。

## 开发与测试

```bash
npm test           # 单元测试(multimodal 解析 / MIME 嗅探 / SSRF 校验 / 工具调用解析)
npm run check      # 语法检查 worker.js 与 proxy/worker.js
npm run dev        # 本地 wrangler dev
npm run deploy     # wrangler deploy
```

`tests/worker.test.mjs` 直接 import `worker.js` 里的纯函数,不联网、不需要 cookie。
GitHub Actions(`.github/workflows/ci.yml`)在 push / PR 时跑 Node 20 与 22 的语法检查与单元测试。

## 致谢
- [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/)(上游 Python 版,功能基准)
- [one880808/gemini-web2api](https://github.com/one880808/gemini-web2api)(本仓库的早期 fork 来源)
- [linux.do](https://linux.do) 社区

## License
MIT
