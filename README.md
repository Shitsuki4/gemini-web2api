# gemini-web2api (Cloudflare Worker)

> **独立项目**:本仓库不是 GitHub fork,而是一个独立维护的仓库(历史来自早期 fork,现已脱离 fork 关系)。参考上游 Python 版 [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/) 的能力,已在 Cloudflare Workers 上对齐到 **2026-09-25(`codex/openai-multimodal-support`, `4c934286`)** 并做了 Workers 侧增强(区域出口池、KV/D1 状态、SSRF 防护等)。

把 Google Gemini 网页端转换为 OpenAI / Google 原生兼容 API 的单文件 Cloudflare Worker(`worker.js`)。

## 特性

- **可选密钥**: `API_KEYS` 为空时免密,填入密钥后按 OpenAI Bearer Key 校验
- **OpenAI 兼容**: `/v1/chat/completions`、`/v1/models`
- **Responses API**: `/v1/responses`(完整事件序列,兼容 Codex CLI 等严格客户端)
- **Google 原生 API**: `/v1beta/models/{model}:generateContent` / `:streamGenerateContent`
- **工具调用**: Function Calling(OpenAI 格式);大工具列表自动裁剪参数防静默截断
- **图片生成**: 输出图片链接,同时以 `message.images[]` 返回;流式同样支持
- **图片自建中转**: 生成图链接改写成 `<PUBLIC_ORIGIN>/img/<key>`,由本 worker 回源并按 key 缓存(Cloudflare 边缘缓存 + R2)。不再把 `googleusercontent.com` 直链交给客户端 —— 那个域名部分地区被墙,且 `gg-dl` 是带签名会过期的下载链
- **服务端会话续聊**: 把 Gemini 的会话标识(`cid`/`rid`/`rcid`)存进 D1,下一轮回填 `inner[2]` 并**只发新增内容**,历史留在 Gemini 侧(省 token、真记忆)。客户端照样发整段历史也能命中 —— 用「条数 + 渲染指纹」校验前缀,对不上就当新会话,不会串话;显式声明 `X-Session-Mode: delta` 时可只发增量
- **跨会话长期记忆**: 事实存 D1,开新会话时注入 prompt;`/v1/memories` 增删查,`X-Memory-Scope` 做分组隔离,可选每轮自动提炼
- **R2 免费额度保护**: 单张体积上限 + 月度写入预算,超出后不再写 R2(图片仍能正常显示,只是不缓存);桶上配 7 天生命周期规则自动回收
- **可切换出口池 + 纯净度排序**: 出口支持三种写法(`direct` / `colo:weur` Cloudflare 机房 / `socks5://`·`http://` 外部代理),每个出口实测打分后按分数择优使用,失败自动轮换。代理隧道建好后一律 `startTls` 到目标域名,不把 cookie 明文交给代理
- **网页控制台**: `/ui`(根路径对浏览器自动返回它),含对话、会话管理、长期记忆、出口池测试与状态面板
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

## 出口池与纯净度排序

Google 会按**出口 IP** 区别对待请求:有的直接 `BardErrorInfo[1060]`,有的 429/reCAPTCHA,图片生成更是普遍被拒。出口池把「出口」抽象成可切换、可打分、可排序的一等公民。

三种出口:

```ini
direct                                   # 直接用 Worker 自带出口
colo:weur                                # 经 EgressRelay Durable Object,落在该 Cloudflare 机房
proxy:socks5://user:pass@1.2.3.4:1080    # 外部代理(也支持 http:// 与 https://)
```

- 配置走 `EGRESS_POOL`,运行时可经 `/admin/egress` 热改(存 D1,强一致)。
- **打分**:文本通 40 / 通但空 10 / 429(能连上、只是被限流)4 / 5xx 2 / 1060 或超时 0;能出图再 **+50**(图片才是真正卡人的指标);按延迟加 0~10 分。
- 请求时按分数从高到低轮换,失败自动换下一个;`EGRESS_FORCE` 或前端「强制」可钉死某个出口。
- cron 每 6h 自动跑一轮测试,前端也能手动触发。

**代理隧道的实现**:`cloudflare:sockets` 的 `connect()` 建 TCP → HTTP 代理发 `CONNECT`(带 `Proxy-Authorization: Basic`)/ SOCKS5 做握手(支持用户名密码与域名 ATYP)→ `socket.startTls()` 到目标域名 → 复用同一套 HTTP/1.1 收发逻辑。隧道建成前不发送任何业务数据,所以 Gemini 的 cookie 不会明文暴露给代理。

> **实测结论(2026-09-25,本部署)**:把 `wnam/enam/sam/weur/eeur/apac/me` 七个 Cloudflare 机房逐个测过 —— 文本全部正常(1.9–2.7s),但**图片生成全部被拒**;`oc`/`afr` 直接 302。也就是说**换 Cloudflare 机房解决不了图片生成**,要拿到能出图的出口得接真正的外部代理 IP。这正是出口池支持 `proxy:` 的原因。

## HTTP 端点

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions(支持 `stream`) |
| `POST /v1/responses` | OpenAI Responses API |
| `GET /v1/models` | 模型列表 |
| `POST /v1beta/models/{model}:generateContent` | Google 原生(非流式) |
| `POST /v1beta/models/{model}:streamGenerateContent` | Google 原生(流式,`?alt=sse`) |
| `GET /health` · `GET /healthz` | 健康检查(版本、模型数、cookie 状态、出口提示、限流参数) |
| `GET /img/<key>` | 生成图片中转(**公开**,不带鉴权 —— `<img>` 标签发不出 Authorization 头;以不可猜的 key 当凭据,只允许 `googleusercontent.com` 白名单) |
| `GET /v1/memories` | 列出长期记忆(`X-Memory-Scope` 指定分组) |
| `POST /v1/memories` | 新增记忆:`{"memories":["..."]}` 或 `{"content":"..."}` |
| `DELETE /v1/memories` | 删除:`{"id":"..."}` 删一条,空 body 清空该 scope |
| `GET /admin/state` | 运行状态(加 `?live=1` 实地探测上游) |
| `POST /admin/cookie` | 热更新 cookie/state(写入 KV) |
| `GET /ui` | 网页控制台(根路径 `GET /` 在 `Accept: text/html` 时也返回它;探针拿到的仍是健康检查 JSON) |
| `GET /admin/egress` | 出口池 + 纯净度评分排序(代理 URL 的密码打码) |
| `POST /admin/egress` | `{"action":"test"\|"pool"\|"force"\|"probe_image", ...}` |
| `GET /admin/sessions` | 会话列表(`?limit=`) |
| `POST /admin/sessions` | `{"sid":"..."}` 删一个,`{"all":true}` 清空 |
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
- `[[d1_databases]]` 绑定 `DB`:会话表 `chat_sessions`、记忆表 `memories`、图片映射 `img_map`、R2 写入预算 `img_budget`,以及图片文件引用缓存表 `file_cache`(表会自动创建)
- `[[durable_objects.bindings]]` 绑定 `EGRESS`(`EgressRelay`):区域出口池
- `[[r2_buckets]]` 绑定 `FILECACHE`:生成图片的字节缓存(**图片中转需要**;未绑时保持上游直链)
- `[vars]` `PUBLIC_ORIGIN`:对外真正可达的源(如 `https://api.example.org`)。**必须显式配置** —— 若入口是另一个中转 Worker,从 `request.url` 推导出来的是 `*.workers.dev`,客户端访问不到
- `[triggers]` cron:定期抓 Gemini 首页刷新滚动 token(`__Secure-1PSIDTS` / `SNlM0e` / `bl`)

> 建议给 R2 桶配一条生命周期规则(前缀 `img/`,7 天过期),存储自动回收,永远逼近不了免费额度。

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
| `SESSION_MEMORY` | `true`(默认)= 服务端会话续聊;`false` = 退回「每轮重发整段历史」的旧行为 |
| `SESSION_TTL_SEC` | 会话映射保留时长(默认 604800 = 7 天),超时按新会话处理 |
| `SESSION_DELTA_DEFAULT` | `true` = 默认认为客户端只发增量(需显式给会话 id) |
| `MEMORY_ENABLED` | 长期记忆开关(需要 D1) |
| `MEMORY_AUTO_EXTRACT` | `true` = 每轮结束后额外调一次上游提炼事实(会让每轮多一次上游请求),默认关 |
| `MEMORY_MAX_ITEMS` / `MEMORY_INJECT_MAX_BYTES` | 每个 scope 的记忆条数上限 / 注入 prompt 的字节上限 |
| `IMAGE_PROXY` | `true`(默认)= 生成图经本域名中转;`false` = 透传上游直链 |
| `PUBLIC_ORIGIN` | 对外可达的源(图片链接前缀)。不配则保持直链 |
| `IMAGE_R2_STORE` / `IMAGE_R2_MONTHLY_MAX_BYTES` | 是否写 R2 / 月度写入上限(默认 4 GiB,留足 10 GB-月免费额度余量) |
| `IMAGE_OBJECT_MAX_BYTES` | 单张超过此体积不落 R2(默认 12 MiB) |
| `IMAGE_CACHE_TTL_SEC` / `IMAGE_PROXY_RATE_MAX` | 图片缓存时长(默认与 7 天生命周期对齐)/ `/img` 每 IP 每分钟限流 |
| `EGRESS_POOL` | 出口池,逗号分隔:`colo:weur`、`proxy:socks5://user:pass@host:1080`、`direct`。留空则沿用 `EGRESS_HINT*`。运行时可经 `/admin/egress` 热改(存 D1) |
| `EGRESS_FORCE` | 强制走某个出口(id 或 target);空 = 按纯净度分数自动择优 |
| `EGRESS_PROBE_IMAGE` | 纯净度探测是否顺带试一次图片生成(会真的调上游) |

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
- **图片生成受账号/出口限制**:上游可能直接回「Are you signed in? ... image creation isn't available in your location yet.」。这是 Gemini 侧对账号资格或出口 IP 的判断,与本仓库无关。已实测:七个 Cloudflare 机房**全部**被拒(见上一节),所以换机房没用 —— 需要接外部代理 IP,或用 `/admin/egress` 逐个试出一个能出图的出口。中转链路(`/img/<key>`)只负责转发与缓存,不解决这一点。
- **会话绑在 Gemini 侧**:续聊依赖上游返回的 `cid`/`rid` 仍然有效;上游会话被清理或 cookie 换号后会退回新会话(不会报错)。
- **隐式会话键可能撞车**:不显式给会话 id 时,键 = `API key + 首条用户消息`。若同时开着**两个第一句完全相同**的对话并交叉发消息,理论上会互相串上下文。多会话客户端请显式带 `X-Session-Id`(或 body 的 `session_id`)——单条消息的新请求永远不会误续,所以只影响"同开头 + 并发"这一种情况。
- **`/img` 是公开端点**:靠不可猜的 key 当凭据(`<img>` 标签发不出 Authorization 头)。key 只由白名单内的 `googleusercontent.com` URL 生成,不构成任意 URL 代理;另有每 IP 限流。
- **图片缓存 7 天后失效**:R2 生命周期到期删除后,若上游签名链也已过期,该图将无法再取回。
- **图片需登录态**:未配置 `GEMINI_COOKIE` 时图片会被忽略并在 prompt 中提示。
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

`tests/worker.test.mjs`(多模态/MIME/SSRF/工具调用)、`tests/session.test.mjs`(会话续聊/记忆/图片中转)、`tests/egress.test.mjs`(出口解析/评分/SOCKS5 握手字节)、`tests/ui.test.mjs`(控制台页面完整性)都直接 import 纯函数,不联网、不需要 cookie;代理握手用假 socket 按字节校验。
GitHub Actions(`.github/workflows/ci.yml`)在 push / PR 时跑 Node 20 与 22 的语法检查与单元测试。

## 致谢
- [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/)(上游 Python 版,功能基准)
- [one880808/gemini-web2api](https://github.com/one880808/gemini-web2api)(本仓库的早期 fork 来源)
- [linux.do](https://linux.do) 社区

## License
MIT
