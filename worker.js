/**
 * gemini-web2api — Cloudflare Worker(单文件)
 *
 * 把 Google Gemini 网页版的 StreamGenerate 协议转换成 OpenAI 兼容的 API。
 * 这是 Python 版 `gemini_web2api` 包的 JS 移植,改写为 Cloudflare Workers /
 * Web Fetch 运行时(不依赖 Node,不依赖标准库)。
 *
 * 接口:
 *   OpenAI:      GET  /v1/models
 *                POST /v1/chat/completions
 *                POST /v1/responses                       (Codex CLI)
 *   Google CLI:  GET  /v1beta/models
 *                POST /v1beta/models/{model}:generateContent
 *                POST /v1beta/models/{model}:streamGenerateContent
 *
 * 部署:把这个单文件粘贴到 Cloudflare 后台
 * (Workers & Pages → Create → 粘贴 → Deploy),或执行 `wrangler deploy`。
 * 不需要 wrangler.toml 的 [vars] 或 secrets —— 改下面的 CONFIG 即可。
 *
 * 配置:编辑本文件顶部的 CONFIG 对象。每个键也都可以用同名的 Worker
 * 环境变量 / secret 覆盖(GEMINI_COOKIE / API_KEYS 建议用 secret,避免提交进仓库):
 *   GEMINI_COOKIE        完整 cookie 字符串,或 JSON {"cookie": "...", "sapisid": "..."}
 *   SAPISID              可选,显式指定 SAPISID(否则从 cookie 自动提取)
 *   API_KEYS             逗号分隔的列表或 JSON 数组;为空 = 不鉴权
 *   GEMINI_BL            Gemini 网页版构建号(会随时间变化)
 *   GEMINI_ORIGIN        上游源站;部署被 Google 429 限流时,指向干净 IP 的反向代理
 *   UPSTREAM_SOCKET      true/false;true=上游优先用裸 socket(绕开 fetch 的 429)
 *   DEFAULT_MODEL        默认模型名
 *   RETRY_ATTEMPTS / RETRY_DELAY_SEC / REQUEST_TIMEOUT_SEC   整数
 *   LOG_REQUESTS         true/false
 *   AUTH_USER            Google 多账号序号;留空=默认账号,否则走 /u/{n} 前缀
 *   XSRF_TOKEN           可选,SNlM0e at-token;payload 加 at= 参数
 *   TEMPORARY_CHATS      true/false;true=临时会话(不落历史)
 *   AUTO_UPDATE_BL       true/false;上游 405 时自动抓最新 GEMINI_BL 重试
 *
 * 限制:图片/多模态输入需要登录态 —— 设置了 GEMINI_COOKIE 时,图片会经 Scotty
 * 上传到 Gemini 再绑进会话;未设置 cookie 时图片会被忽略(匿名带图会被后端以
 * 1100 拒绝),并在 prompt 里加一句提示。`gemini-3.1-pro` 也只有带付费账号 cookie
 * 时才会真正路由到 Pro,否则回退到 Flash。
 */
// 控制台前端(单页)。放在独立文件里便于维护,wrangler 会把它打包进来。
import { UI_HTML } from "./ui.js";

const VERSION = "2.0.0-worker";
// ════════════════════════════════════════════════════════════════════════════
//  CONFIG —— 改这些值,然后直接部署本文件。
//  若设置了同名的 Worker 环境变量 / secret,会覆盖这里的值;不设则用此处的值。
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // 调用方必须携带的密钥(Authorization: Bearer <key> 或 x-api-key: <key>)。
  // 空数组 = 不鉴权(任何知道地址的人都能调用)。
  API_KEYS: [],
  // Gemini cookie。匿名访问对所有模型都可用,唯独真正的 Pro 路由需要它。
  // 原始 cookie 字符串,例如:
  //   "SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=..."
  // 匿名就留空 ""。(出于安全考虑,建议把它设为 Worker secret。)
  GEMINI_COOKIE: "",
  // 兼容上游 COOKIE_STRING:支持用 | 分隔多个账号,每个请求随机选一组。
  GEMINI_COOKIES: "",
  // 可选;与 cookie 数量一致时按下标配对,也支持 | 分隔。
  SAPISID: "",
  // Gemini 网页版构建号。如果返回开始变空,去 gemini.google.com 页面源码里
  // 找一个新的值("boq_assistant-bard-web-server_...")。
  GEMINI_BL: "boq_assistant-bard-web-server_20260716.08_p0",
  // 上游源站。默认直连 gemini.google.com。若部署在 Cloudflare/无服务器平台
  // 被 Google 以 429 限流(出口 IP 被拦),把它指向一个跑在“干净 IP”上的反向
  // 代理(转发到 gemini.google.com 并保留 Host/Origin),即可绕开。例:
  //   GEMINI_ORIGIN = "https://your-relay.example.com"
  GEMINI_ORIGIN: "https://gemini.google.com",
  // 上游请求是否优先用裸 socket(cloudflare:sockets)绕开 fetch 的 429 限流。
  // true=优先 socket,不可用/失败再回退 fetch;false=只用 fetch。
  UPSTREAM_SOCKET: true,
  // Google 多账号:留空用默认账号;填序号(如 "1")走 /u/1 路径前缀。
  AUTH_USER: "",
  // 可选的 XSRF token(页面源码 "SNlM0e":"...");设置后 payload 带 at= 参数,
  // 某些风控严格的环境需要。
  XSRF_TOKEN: "",
  // Gemini Web f.sid session id, copied from a browser StreamGenerate URL.
  GEMINI_FSID: "",
  // true=所有请求按“临时会话”发送(Gemini 不保存历史)。
  TEMPORARY_CHATS: false,
  // 上游返回 405(常见于 BL 过期)时,自动抓取最新构建号并重试一次。
  AUTO_UPDATE_BL: true,
  DEFAULT_MODEL: "gemini-3.8-flash",
  RETRY_ATTEMPTS: 3,
  // BardErrorInfo[1060](出口 IP 风控)时的跨出口重试次数
  BARD_RETRY_ATTEMPTS: 8,
  // 重试中交替切换出口路径(fetch <-> cloudflare:sockets 裸 TCP):
  // 两条路径的出口 IP 池不同,一条被限时另一条常还能用。默认开。
  ALT_TRANSPORT: true,
  // 备用入口(逗号分隔)。本 worker 多次被 1060 拒绝后,回源到这些地址重发,
  // 利用不同入口的出口 IP 池互补。例:"https://your.workers.dev"
  ALT_EGRESS: "",
  // Route Gemini calls through regional Durable Objects. Requires EGRESS binding.
  DO_EGRESS: true,
  EGRESS_HINT: "weur",
  EGRESS_FALLBACK_HINTS: "weur,eeur,wnam",
  // 运维接口(/admin/*)的密钥。留空则复用 API_KEYS。
  ADMIN_KEY: "",
  // 「网页端对齐」:补齐真实 Web 客户端会带的 payload 字段与 x-goog-ext-*-jspb 请求头。
  // 不带时后端会退化到基础配置(实测拿不到图片生成等新能力)。可用 env WEB_PARITY=false 关掉。
  WEB_PARITY: true,
  RETRY_DELAY_SEC: 2,
  REQUEST_TIMEOUT_SEC: 180,
  LOG_REQUESTS: true,
  // 请求前随机抖动(毫秒),模拟真实用户节奏;0 = 关闭。
  FINGERPRINT_JITTER_MS: 1500,
  // 每个客户端 IP 的滑动窗口速率限制(每个 isolate 内近似)。
  RATE_LIMIT_ENABLED: true,
  RATE_LIMIT_MAX: 3000,
  RATE_LIMIT_WINDOW: 60,
  // ── 服务端会话(续聊)──────────────────────────────────────────────────
  // 把历史留在 Gemini 侧:命中会话时上游只收到「新增的那一条」,
  // 而不是每轮都把整段对话重拼一遍。详见 sessionPlanTurn()。
  SESSION_MEMORY: true,
  // 会话映射(cid/rid/rcid)保留多久;超时按新会话处理。
  SESSION_TTL_SEC: 604800,
  // 客户端「只发增量、不发历史」时必须显式声明会话(X-Session-Mode: delta)。
  SESSION_DELTA_DEFAULT: false,
  // ── 长期记忆(跨会话)──────────────────────────────────────────────────
  MEMORY_ENABLED: true,
  // 每轮结束后额外调一次上游提炼事实(会让每轮多一次上游请求),默认关。
  MEMORY_AUTO_EXTRACT: false,
  MEMORY_MAX_ITEMS: 200,
  // 注入到 prompt 里的记忆块字节上限(超了按更新时间截断)。
  MEMORY_INJECT_MAX_BYTES: 8000,
  // ── 生成图片:经本 worker 的域名中转 ────────────────────────────────
  // 上游返回的 googleusercontent 直链会改写成 <PUBLIC_ORIGIN>/img/<key>。
  IMAGE_PROXY: true,
  // 对外真正可达的源(必须显式配置:生产入口是 gemini-proxy 中转,
  // worker 从 request.url 推导出来的是 workers.dev,用户访问不到)。
  PUBLIC_ORIGIN: "",
  IMAGE_R2_STORE: true,
  // R2 月度写入上限(字节)。R2 免费额度 10 GB-月,默认 4 GiB 留足余量;
  // 超了就不再写 R2,图片仍走边缘缓存/实时回源,功能不受影响。
  IMAGE_R2_MONTHLY_MAX_BYTES: 4294967296,
  // 单张超过这个大小不落 R2。
  IMAGE_OBJECT_MAX_BYTES: 12582912,
  // 图片缓存时间(秒),与 R2 的 7 天生命周期规则对齐。
  IMAGE_CACHE_TTL_SEC: 604800,
  IMAGE_PROXY_RATE_MAX: 600,
  // ── 出口池(换掉 Google 看到的 IP)──────────────────────────────────────
  // 逗号分隔,三种写法混用:
  //   colo:weur                              Cloudflare 机房(经 EgressRelay DO)
  //   proxy:socks5://user:pass@1.2.3.4:1080  外部代理(也支持 http:// / https://)
  //   direct                                 直接用 Worker 自带出口
  // 留空则沿用 EGRESS_HINT / EGRESS_FALLBACK_HINTS。运行时可经 /admin/egress 热改(存 KV)。
  EGRESS_POOL: "",
  // 强制使用某个出口(id 如 proxy:ab12cd34ef56 或 colo:weur);空 = 按纯净度评分自动择优
  EGRESS_FORCE: "",
  // 纯净度探测是否顺带测「图片生成能不能出图」。
  // 默认关:实测**没有任何 Cloudflare 出口能出图**(图片生成受客户端指纹限制),
  // 开着只会白烧请求,而请求量本身可能就是触发 Google 异常流量判定的因素之一。
  // 接入了真正能出图的出口(外部代理/浏览器桥)之后再打开。
  EGRESS_PROBE_IMAGE: false,
  // ── 图片生成后端 ────────────────────────────────────────────────────────────
  // 网页端出图卡在「客户端 TLS/HTTP2 指纹」上(见 README),Worker 的 TLS 栈
  // 伪装不了 Chrome。所以图片生成必须走独立后端;两条路都能拿到「Gemini 生的图」:
  //   google       官方 Gemini API(`gemini-3.1-flash-image` = Nano Banana 2,
  //                就是 Gemini 自己的图片模型)。**图片模型免费档配额为 0,需开计费。**
  //   browser      本机浏览器桥:驱动真 Chrome 走网页端出图,是真 Gemini 的图,免费,
  //                但依赖那台机器在线。
  // 另注:workers-ai(CF 的 flux)**不是 Gemini 的模型**,除非明确只想要"有张图",
  // 否则不要用。
  IMAGE_BACKEND: "google",
  GEMINI_API_KEY: "",
  GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
  // 浏览器桥(见 bridge/README):Worker 落任务,本机桥轮询并回传图片字节
  BRIDGE_SECRET: "",
  BRIDGE_WAIT_MS: 60000,
  // CF Workers AI(非 Gemini 模型,仅在明确想要"任意图"时启用)
  CF_ACCOUNT_ID: "",
  CF_AI_TOKEN: "",
  CF_IMAGE_MODEL: "@cf/black-forest-labs/flux-1-schnell",
  // 图片生成自动回退:网页端拒绝出图时,改用上面的后端重试
  IMAGE_FALLBACK_API: true,
  // ── SSE 心跳 ────────────────────────────────────────────────────────────
  // 生成期间定期发 SSE 注释行,避免客户端(尤其 Android OkHttp,默认读超时 10s)
  // 在静默期判定连接已死、报 "unexpected end of stream"。0 = 关闭。
  // 默认 5s:必须明显小于常见的 10s 读超时,否则就是和超时赛跑。
  SSE_HEARTBEAT_MS: 5000,
};
// ─── 模型 ────────────────────────────────────────────────────────────────
// MODE_CATEGORY 枚举(来自 Gemini 前端 JS):
//   1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE
//
// 2026-09-25 实测:网页端的模式选择器为
//   3.5 Flash-Lite / 3.8 Flash / 3.1 Pro / 扩展思考
// 抓下网页真实 payload 后确认:网页端「3.8 Flash」用的就是 inner[79]=1,
// 与本表 mode:1 一致 —— 即后端已经把这档升到 3.8,只是名字要跟着改。
// 注意网页端 Flash 的 inner[17] 是 [[1]](我们用 [[4]]),见下方 THINK 说明。
const MODELS = {
  "gemini-3.8-flash": { mode: 1, think: 4, desc: "Latest all-around model (Gemini 3.8 Flash)" },
  "gemini-3.7-flash": { mode: 1, think: 4, desc: "Alias for gemini-3.8-flash (backend upgraded)" },
  "gemini-3.6-flash": { mode: 1, think: 4, desc: "Alias for gemini-3.8-flash (backend upgraded)" },
  "gemini-3.5-flash": { mode: 1, think: 4, desc: "Alias for gemini-3.8-flash (backend upgraded)" },
  "gemini-3.8-flash-thinking": { mode: 2, think: 0, desc: "Extended thinking mode, longest output (~20k chars)" },
  "gemini-3.5-flash-thinking": { mode: 2, think: 0, desc: "Alias for gemini-3.8-flash-thinking" },
  "gemini-3.1-pro": { mode: 3, think: 4, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced": { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto": { mode: 4, think: 4, desc: "Auto model selection" },
  "gemini-3.5-flash-thinking-lite": { mode: 5, think: 0, desc: "Dynamic thinking with adaptive depth" },
  "gemini-flash-lite": { mode: 6, think: 4, desc: "3.5 Flash-Lite, fastest responses" },
};
/**
 * 把模型名解析成路由参数。
 * 未知名称会回退到 `def` 而不是报错(客户端可能传任意 id)。
 * 支持 `@think=N` 后缀来覆盖思考深度。
 * 返回 { name, modeId, thinkMode, extra },或 { error }。
 */
function resolveModel(modelName, def) {
  let thinkOverride = null;
  if (modelName.includes("@think=")) {
    const idx = modelName.lastIndexOf("@think=");
    const thinkStr = modelName.slice(idx + "@think=".length);
    modelName = modelName.slice(0, idx);
    if (!/^-?\d+$/.test(thinkStr)) return { error: `Invalid think level: ${thinkStr}` };
    thinkOverride = parseInt(thinkStr, 10);
  }
  let cfg = MODELS[modelName];
  if (!cfg) {
    modelName = def;
    cfg = MODELS[def];
  }
  return {
    name: modelName,
    modeId: cfg.mode,
    thinkMode: thinkOverride !== null ? thinkOverride : cfg.think,
    extra: cfg.extra || null,
  };
}
// ─── 配置 ──────────────────────────────────────────────────────────────────
function parseBool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function parseIntDefault(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function parseApiKeys(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  v = String(v).trim();
  if (v.startsWith("[")) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map(String);
    } catch (_) { /* 继续往下走 */ }
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
// 当 env[key] 设置了非空值时返回它,否则返回内嵌的默认值。
function envOr(env, key, fallback) {
  const v = env[key];
  return v !== undefined && v !== null && v !== "" ? v : fallback;
}
function splitEnvList(v) {
  return String(v || "").split("|").map((x) => x.trim()).filter(Boolean);
}
function parseCookieEntry(entry) {
  let cookie = String(entry || "").trim();
  let sapisid = "";
  if (cookie.startsWith("{")) {
    try {
      const o = JSON.parse(cookie);
      cookie = String(o.cookie || "").trim();
      sapisid = String(o.sapisid || "").trim();
    } catch (_) { /* 当作原始 cookie */ }
  }
  if (!sapisid) {
    const m = /(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie);
    if (m) sapisid = m[1].trim();
  }
  return { cookie, sapisid };
}
function getConfig(env) {
  env = env || {};
  // 多账号池用 `|` 分隔;但**单个 cookie 里也可能含 `|`**(Google 的
  // LSID=s.GB|s.youtube:… 就是),拿它当分隔符会把 cookie 从中间切断 —— 表现为
  // 鉴权莫名其妙失效(cookie 只剩一百多字符)。所以只有 GEMINI_COOKIES 按 `|` 切,
  // 其余按行切(cookie 不可能含换行)。
  let cookieRaw = "";
  let multi = false;
  if (env.GEMINI_COOKIES) { cookieRaw = env.GEMINI_COOKIES; multi = true; }
  else if (env.GEMINI_COOKIE) cookieRaw = env.GEMINI_COOKIE;
  else if (env.COOKIE_STRING) cookieRaw = env.COOKIE_STRING;
  else if (CONFIG.GEMINI_COOKIES) { cookieRaw = CONFIG.GEMINI_COOKIES; multi = true; }
  else if (CONFIG.GEMINI_COOKIE) cookieRaw = CONFIG.GEMINI_COOKIE;
  const cookieEntries = (multi ? splitEnvList(cookieRaw) : String(cookieRaw).split(/\r?\n/).map((x) => x.trim()).filter(Boolean))
    .map(parseCookieEntry).filter((x) => x.cookie);
  const cookieIndex = cookieEntries.length ? Math.floor(Math.random() * cookieEntries.length) : 0;
  let cookie = (cookieEntries[cookieIndex] && cookieEntries[cookieIndex].cookie) || "";
  let sapisid = (cookieEntries[cookieIndex] && cookieEntries[cookieIndex].sapisid) || "";
  const sapisidList = splitEnvList(env.SAPISID || CONFIG.SAPISID || "");
  if (sapisidList.length === cookieEntries.length && cookieEntries.length) sapisid = sapisidList[cookieIndex] || sapisid;
  else if (sapisidList.length) sapisid = sapisidList[Math.floor(Math.random() * sapisidList.length)] || sapisid;
  if (cookie && !sapisid) {
    const m = /(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie);
    if (m) sapisid = m[1].trim();
  }
  return {
    gemini_bl: envOr(env, "GEMINI_BL", CONFIG.GEMINI_BL),
    gemini_origin: String(envOr(env, "GEMINI_ORIGIN", CONFIG.GEMINI_ORIGIN)).replace(/\/$/, ""),
    upstream_socket: parseBool(envOr(env, "UPSTREAM_SOCKET", CONFIG.UPSTREAM_SOCKET), true),
    default_model: envOr(env, "DEFAULT_MODEL", CONFIG.DEFAULT_MODEL),
    retry_attempts: parseIntDefault(envOr(env, "RETRY_ATTEMPTS", CONFIG.RETRY_ATTEMPTS), 3),
    retry_delay_sec: parseIntDefault(envOr(env, "RETRY_DELAY_SEC", CONFIG.RETRY_DELAY_SEC), 2),
    request_timeout_sec: parseIntDefault(envOr(env, "REQUEST_TIMEOUT_SEC", CONFIG.REQUEST_TIMEOUT_SEC), 180),
    log_requests: parseBool(envOr(env, "LOG_REQUESTS", CONFIG.LOG_REQUESTS), true),
    auth_user: String(envOr(env, "AUTH_USER", CONFIG.AUTH_USER) || "").replace(/^\/+|\/+$/g, ""),
    xsrf_token: envOr(env, "XSRF_TOKEN", CONFIG.XSRF_TOKEN) || "",
    gemini_fsid: String(envOr(env, "GEMINI_FSID", CONFIG.GEMINI_FSID) || ""),
    temporary_chats: parseBool(envOr(env, "TEMPORARY_CHATS", CONFIG.TEMPORARY_CHATS), false),
    auto_update_bl: parseBool(envOr(env, "AUTO_UPDATE_BL", CONFIG.AUTO_UPDATE_BL), true),
    api_keys: parseApiKeys(envOr(env, "API_KEYS", CONFIG.API_KEYS)),
    bard_retry_attempts: parseIntDefault(envOr(env, "BARD_RETRY_ATTEMPTS", CONFIG.BARD_RETRY_ATTEMPTS), 8),
    alt_transport: parseBool(envOr(env, "ALT_TRANSPORT", CONFIG.ALT_TRANSPORT), true),
    alt_egress: String(envOr(env, "ALT_EGRESS", CONFIG.ALT_EGRESS) || "").split(",").map((x) => x.trim()).filter(Boolean),
    do_egress: parseBool(envOr(env, "DO_EGRESS", CONFIG.DO_EGRESS), true),
    egress_hint: String(envOr(env, "EGRESS_HINT", CONFIG.EGRESS_HINT) || "weur"),
    egress_fallback_hints: String(envOr(env, "EGRESS_FALLBACK_HINTS", CONFIG.EGRESS_FALLBACK_HINTS) || "").split(",").map((x) => x.trim()).filter(Boolean),
    admin_key: envOr(env, "ADMIN_KEY", CONFIG.ADMIN_KEY) || "",
    web_parity: parseBool(envOr(env, "WEB_PARITY", CONFIG.WEB_PARITY), true),
    fingerprint_jitter_ms: Math.max(0, parseIntDefault(envOr(env, "FINGERPRINT_JITTER_MS", CONFIG.FINGERPRINT_JITTER_MS), 1500)),
    rate_limit_enabled: parseBool(envOr(env, "RATE_LIMIT_ENABLED", CONFIG.RATE_LIMIT_ENABLED), true),
    rate_limit_max: Math.max(1, parseIntDefault(envOr(env, "RATE_LIMIT_MAX", CONFIG.RATE_LIMIT_MAX), 3000)),
    rate_limit_window: Math.max(1, parseIntDefault(envOr(env, "RATE_LIMIT_WINDOW", CONFIG.RATE_LIMIT_WINDOW), 60)),
    session_memory: parseBool(envOr(env, "SESSION_MEMORY", CONFIG.SESSION_MEMORY), true),
    session_ttl_sec: Math.max(60, parseIntDefault(envOr(env, "SESSION_TTL_SEC", CONFIG.SESSION_TTL_SEC), 604800)),
    session_delta_default: parseBool(envOr(env, "SESSION_DELTA_DEFAULT", CONFIG.SESSION_DELTA_DEFAULT), false),
    memory_enabled: parseBool(envOr(env, "MEMORY_ENABLED", CONFIG.MEMORY_ENABLED), true),
    memory_auto_extract: parseBool(envOr(env, "MEMORY_AUTO_EXTRACT", CONFIG.MEMORY_AUTO_EXTRACT), false),
    memory_max_items: Math.max(1, parseIntDefault(envOr(env, "MEMORY_MAX_ITEMS", CONFIG.MEMORY_MAX_ITEMS), 200)),
    memory_inject_max_bytes: Math.max(0, parseIntDefault(envOr(env, "MEMORY_INJECT_MAX_BYTES", CONFIG.MEMORY_INJECT_MAX_BYTES), 8000)),
    image_proxy: parseBool(envOr(env, "IMAGE_PROXY", CONFIG.IMAGE_PROXY), true),
    public_origin: String(envOr(env, "PUBLIC_ORIGIN", CONFIG.PUBLIC_ORIGIN) || "").replace(/\/+$/, ""),
    image_r2_store: parseBool(envOr(env, "IMAGE_R2_STORE", CONFIG.IMAGE_R2_STORE), true),
    image_r2_monthly_max_bytes: Math.max(0, parseIntDefault(envOr(env, "IMAGE_R2_MONTHLY_MAX_BYTES", CONFIG.IMAGE_R2_MONTHLY_MAX_BYTES), 4294967296)),
    image_object_max_bytes: Math.max(1024, parseIntDefault(envOr(env, "IMAGE_OBJECT_MAX_BYTES", CONFIG.IMAGE_OBJECT_MAX_BYTES), 12582912)),
    image_cache_ttl_sec: Math.max(60, parseIntDefault(envOr(env, "IMAGE_CACHE_TTL_SEC", CONFIG.IMAGE_CACHE_TTL_SEC), 604800)),
    image_proxy_rate_max: Math.max(1, parseIntDefault(envOr(env, "IMAGE_PROXY_RATE_MAX", CONFIG.IMAGE_PROXY_RATE_MAX), 600)),
    egress_pool: String(envOr(env, "EGRESS_POOL", CONFIG.EGRESS_POOL) || ""),
    egress_force: String(envOr(env, "EGRESS_FORCE", CONFIG.EGRESS_FORCE) || "").trim(),
    egress_probe_image: parseBool(envOr(env, "EGRESS_PROBE_IMAGE", CONFIG.EGRESS_PROBE_IMAGE), false),
    sse_heartbeat_ms: Math.max(0, parseIntDefault(envOr(env, "SSE_HEARTBEAT_MS", CONFIG.SSE_HEARTBEAT_MS), 5000)),
    gemini_api_key: String(envOr(env, "GEMINI_API_KEY", CONFIG.GEMINI_API_KEY) || "").trim(),
    gemini_image_model: String(envOr(env, "GEMINI_IMAGE_MODEL", CONFIG.GEMINI_IMAGE_MODEL) || "gemini-3.1-flash-image"),
    image_backend: String(envOr(env, "IMAGE_BACKEND", CONFIG.IMAGE_BACKEND) || "google").trim().toLowerCase(),
    bridge_secret: String(envOr(env, "BRIDGE_SECRET", CONFIG.BRIDGE_SECRET) || "").trim(),
    bridge_wait_ms: Math.max(0, parseIntDefault(envOr(env, "BRIDGE_WAIT_MS", CONFIG.BRIDGE_WAIT_MS), 60000)),
    cf_account_id: String(envOr(env, "CF_ACCOUNT_ID", CONFIG.CF_ACCOUNT_ID) || "").trim(),
    cf_ai_token: String(envOr(env, "CF_AI_TOKEN", CONFIG.CF_AI_TOKEN) || "").trim(),
    cf_image_model: String(envOr(env, "CF_IMAGE_MODEL", CONFIG.CF_IMAGE_MODEL) || "@cf/black-forest-labs/flux-1-schnell"),
    image_fallback_api: parseBool(envOr(env, "IMAGE_FALLBACK_API", CONFIG.IMAGE_FALLBACK_API), true),
    _env: env,
    _ctx: null,
    _cookieSource: cookieEntries.length > 1 ? "env-pool" : (env.GEMINI_COOKIE || env.GEMINI_COOKIES || env.COOKIE_STRING ? "env" : (CONFIG.GEMINI_COOKIE ? "builtin" : "none")),
    _cookieIndex: cookieIndex,
    cookie_pool: cookieEntries.map((x) => x.cookie),
    cookie,
    sapisid,
  };
}
// ─── 小工具 ──────────────────────────────────────────────────────────────────
function log(cfg, msg) {
  if (cfg && cfg.log_requests) {
    try { console.error(`[gemini-web2api] ${msg}`); } catch (_) {}
  }
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// 上游请求前随机抖动(对齐 Sophomoresty cloudflare worker 的多指纹策略)。
async function applyFingerprintJitter(cfg) {
  const maxMs = Math.max(0, Number(cfg && cfg.fingerprint_jitter_ms) || 0);
  if (maxMs > 0) await sleep(Math.random() * maxMs);
}
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}
function randomBytes(n) {
  const arr = new Uint8Array(n);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return arr;
}
/** 生成 `n` 个十六进制字符的随机串(n/2 个随机字节)。 */
function randHex(n) {
  const bytes = randomBytes(Math.ceil(n / 2));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s.slice(0, n);
}
function uuid() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}
/** SAPISIDHASH 鉴权头(对 "<ts> <sapisid> <origin>" 做 SHA-1)。 */
async function makeSapisidHash(sapisid) {
  const ts = nowSec();
  const data = new TextEncoder().encode(`${ts} ${sapisid} https://gemini.google.com`);
  const buf = await globalThis.crypto.subtle.digest("SHA-1", data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `SAPISIDHASH ${ts}_${hex}`;
}
function tokenEst(s) {
  return Math.floor((s ? s.length : 0) / 4);
}
// ─── Gemini StreamGenerate 协议 ────────────────────────────────────────────
/**
 * 构造 f.req 表单体。`inner` 是一个 102 槽的数组,对应 Gemini 网页前端发送的
 * 字段;字段 [79] 用于选择模型(MODE_CATEGORY)。
 */
// 非默认 Google 账号的路径前缀("" 或 "/u/1" 等)。
function accountPrefix(cfg) {
  return cfg.auth_user ? `/u/${cfg.auth_user}` : "";
}
function buildPayload(prompt, modelId, thinkMode, fileRefs, extra, cfg) {
  const inner = new Array(102).fill(null);
  if (fileRefs && fileRefs.length) {
    // 每个上传文件表示为 [[fileRef, 1], filename](格式来自 gemini_webapi,
    // 已实测能被后端接受 —— 详见 test/live-image.mjs 的诊断)。
    const files = fileRefs.map((ref) => [[ref, 1], "image.png"]);
    inner[0] = [prompt, 0, null, files, null, null, 0];
  } else {
    inner[0] = [prompt, 0, null, null, null, null, 0];
  }
  inner[1] = ["en"];
  // 会话续聊:Gemini 靠 inner[2] 的前三个槽认出「这是同一会话的下一轮」。
  // 槽位形状由抓包实测确认(imgraw2.txt):
  //   响应里 inner[1] = ["c_…","r_…"],inner[4][0][0] = "rc_…";
  //   而新会话时 inner[2] 恰好是三个空串打头,故续聊填 [cid, rid, rcid]。
  // 带上它 + 只发新增内容,Gemini 侧的历史就不用每轮重传。
  const smeta = cfg && cfg._session_meta;
  if (Array.isArray(smeta) && smeta[0] && smeta[1]) {
    inner[2] = [String(smeta[0]), String(smeta[1]), smeta[2] ? String(smeta[2]) : "", null, null, null, null, null, null, ""];
  } else {
    inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  }
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[thinkMode]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  // 会话持久化标志(对齐上游):临时会话 inner[41]=[1], inner[45]=1;否则 [2]。
  if (cfg && cfg.temporary_chats) {
    inner[41] = [1];
    inner[45] = 1;
  } else {
    inner[41] = [2];
  }
  inner[53] = 0;
  inner[59] = uuid();
  if (cfg) cfg._req_uuid = inner[59];
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelId;
  // 真实 Web 客户端固定带的几个字段(缺了会被后端当成「老客户端」)。
  if (!cfg || cfg.web_parity !== false) {
    inner[67] = 0;
    inner[80] = 1;
    inner[91] = 0;
    inner[96] = 0;
    inner[98] = 1;
  }
  if (extra) {
    for (const k of Object.keys(extra)) inner[Number(k)] = extra[k];
  }
  const outer = [null, JSON.stringify(inner)];
  const form = { "f.req": JSON.stringify(outer) };
  if (cfg && cfg.xsrf_token) form.at = cfg.xsrf_token;
  return new URLSearchParams(form).toString();
}
function getUrl(cfg) {
  const reqid = nowSec() % 1000000;
  const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
  const fsid = cfg.gemini_fsid ? `&f.sid=${encodeURIComponent(cfg.gemini_fsid)}` : "";
  return (
    origin + accountPrefix(cfg) +
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${encodeURIComponent(cfg.gemini_bl)}${fsid}&hl=en&_reqid=${reqid}&rt=c`
  );
}
// 浏览器指纹池:每次请求随机挑一组(UA + Accept-Language + sec-ch-ua 保持一致),
// 让上游看到的客户端特征不像「同一个脚本反复敲」。对齐上游 getRequestConfig 的思路。
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
];
const LANG_POOL = ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en-US,en;q=0.9,zh-CN;q=0.8", "en-US,en;q=0.8,ja;q=0.7"];
const CH_UA_POOL = ["\"Chromium\";v=\"139\", \"Not:A-Brand\";v=\"24\", \"Google Chrome\";v=\"139\"",
                    "\"Chromium\";v=\"140\", \"Not:A-Brand\";v=\"24\", \"Google Chrome\";v=\"140\""];
function pickFingerprint() {
  const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  const platform = /Windows/.test(ua) ? "\"Windows\"" : (/Macintosh/.test(ua) ? "\"macOS\"" : "\"Linux\"");
  return {
    ua,
    lang: LANG_POOL[Math.floor(Math.random() * LANG_POOL.length)],
    chUa: CH_UA_POOL[Math.floor(Math.random() * CH_UA_POOL.length)],
    platform,
  };
}
async function buildHeaders(cfg) {
  const fp = pickFingerprint();
  cfg._fp = fp;
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://gemini.google.com",
    "Referer": `https://gemini.google.com${accountPrefix(cfg)}/app`,
    "X-Same-Domain": "1",
    "User-Agent": fp.ua,
    "Accept-Language": fp.lang,
    "sec-ch-ua": fp.chUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": fp.platform,
  };
  if (cfg.web_parity !== false) {
    // 这几个头是 Web 端用来声明「客户端能力/模型配置」的,服务端据此选功能集。
    const guid = (cfg._req_uuid || uuid()).toUpperCase();
    // 能力列表要跟真实网页一致:网页是 [4,5,6,8,16, 4,5,6,8,16],我们原来少了 16。
    // 这个列表是客户端向服务端声明「我支持哪些能力」的,缺项会被当成能力不足。
    headers["x-goog-ext-525001261-jspb"] =
      '[1,null,null,null,"56fdd199312815e2",null,null,0,[4,5,6,8,16,4,5,6,8,16],null,null,2,null,null,1,1,"' +
      guid + '",null,null,[[1,55200000],[' + nowSec() + "," + (Date.now() % 1000) * 1000000 + "]]]";
    headers["x-goog-ext-525005358-jspb"] = '["' + guid + '",1]';
    headers["x-goog-ext-73010989-jspb"] = "[0]";
    headers["x-goog-ext-73010990-jspb"] = "[0,0,0]";
  }
  if (cfg.auth_user) headers["X-Goog-AuthUser"] = cfg.auth_user;
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
  return headers;
}
// ─── Socket 上游(绕开 fetch)──────────────────────────────────────────────────
// Cloudflare Workers 的 fetch 子请求走共享出口、易被 Google 429。改用
// cloudflare:sockets 的 connect() 裸 TCP+TLS 自行拼 HTTP/1.1,出口路径不同,
// 常能避开限流。Node(测试)拿不到该模块 -> resolveConnect() 返回 null -> 回退 fetch。
let _connect; // undefined=未解析, null=不可用, function=可用
async function resolveConnect() {
  if (_connect !== undefined) return _connect;
  try {
    const mod = await import("cloudflare:sockets");
    _connect = mod.connect || null;
  } catch (_) {
    _connect = null;
  }
  return _connect;
}
// 测试注入(Node 用 tls 模拟 connect();传 null 可强制走 fetch)。
function __setConnect(fn) { _connect = fn === undefined ? null : fn; }
function _concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function _findCRLF(buf, from) {
  for (let i = from; i + 1 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10) return i;
  return -1;
}
function _findDoubleCRLF(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}
// 用裸 socket 发一个 HTTP/1.1 请求,返回类 Response 对象:{status, ok, headers, body, text()}。
// body 是已解码(去 chunked、identity 编码)的 ReadableStream<Uint8Array>,支持流式。
async function socketHttp(connect, url, { method = "GET", headers = {}, body, timeoutMs = 180000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol !== "http:";
  const port = u.port ? Number(u.port) : (secure ? 443 : 80);
  const socket = connect({ hostname: u.hostname, port }, { secureTransport: secure ? "on" : "off", allowHalfOpen: false });
  return httpOverSocket(socket, url, { method, headers, body, timeoutMs });
}
// 在「已建立好的」socket 上跑一次 HTTP/1.1 往返。抽出来是为了让代理隧道
// (CONNECT / SOCKS5 之后再 startTls)复用同一套收发与分块解码逻辑。
async function httpOverSocket(socket, url, { method = "GET", headers = {}, body, timeoutMs = 180000 } = {}) {
  const u = new URL(url);
  let timer = null;
  if (timeoutMs) timer = setTimeout(() => { try { socket.close(); } catch (_) {} }, timeoutMs);
  const enc = new TextEncoder();
  const bodyBytes = body == null ? null : (typeof body === "string" ? enc.encode(body) : new Uint8Array(body));
  // 自管 Host/Connection/Accept-Encoding(identity 避免 gzip)/Content-Length
  const reqHeaders = { Host: u.hostname, "Accept-Encoding": "identity", Connection: "close" };
  for (const [k, v] of Object.entries(headers)) {
    if (/^(host|connection|accept-encoding|content-length)$/i.test(k)) continue;
    reqHeaders[k] = v;
  }
  if (bodyBytes) reqHeaders["Content-Length"] = String(bodyBytes.length);
  let head = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(reqHeaders)) head += `${k}: ${v}\r\n`;
  head += "\r\n";
  const writer = socket.writable.getWriter();
  await writer.write(enc.encode(head));
  if (bodyBytes) await writer.write(bodyBytes);
  try { writer.releaseLock(); } catch (_) {}
  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  let he = -1;
  while (he < 0) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = _concatBytes(buf, value);
    he = _findDoubleCRLF(buf);
  }
  if (he < 0) { if (timer) clearTimeout(timer); throw new Error("socket: incomplete HTTP response headers"); }
  const headerText = new TextDecoder().decode(buf.slice(0, he));
  let pending = buf.slice(he + 4);
  const hlines = headerText.split("\r\n");
  const status = parseInt((hlines[0] || "").split(" ")[1], 10) || 0;
  const respHeaders = new Headers();
  for (let i = 1; i < hlines.length; i++) {
    const c = hlines[i].indexOf(":");
    if (c > 0) { try { respHeaders.append(hlines[i].slice(0, c).trim(), hlines[i].slice(c + 1).trim()); } catch (_) {} }
  }
  const chunked = /chunked/i.test(respHeaders.get("transfer-encoding") || "");
  const clen = respHeaders.has("content-length") ? parseInt(respHeaders.get("content-length"), 10) : null;
  const stream = new ReadableStream({
    async start(controller) {
      const pull = async () => {
        const { done, value } = await reader.read();
        if (done) return false;
        pending = _concatBytes(pending, value);
        return true;
      };
      try {
        if (chunked) {
          for (;;) {
            let nl = _findCRLF(pending, 0);
            while (nl < 0) { if (!(await pull())) { controller.close(); return; } nl = _findCRLF(pending, 0); }
            const size = parseInt(new TextDecoder().decode(pending.slice(0, nl)).trim().split(";")[0], 16);
            pending = pending.slice(nl + 2);
            if (!size || Number.isNaN(size)) { controller.close(); return; } // 末块 0
            while (pending.length < size + 2) { if (!(await pull())) break; }
            controller.enqueue(pending.slice(0, size));
            pending = pending.slice(size + 2); // 跳过块尾 \r\n
          }
        } else if (clen != null) {
          let got = 0;
          if (pending.length) { const t = pending.slice(0, clen); controller.enqueue(t); got += t.length; pending = pending.slice(t.length); }
          while (got < clen) { const { done, value } = await reader.read(); if (done) break; const need = clen - got; const t = value.length > need ? value.slice(0, need) : value; controller.enqueue(t); got += t.length; }
          controller.close();
        } else {
          if (pending.length) controller.enqueue(pending);
          for (;;) { const { done, value } = await reader.read(); if (done) break; controller.enqueue(value); }
          controller.close();
        }
      } catch (e) {
        controller.error(e);
      } finally {
        if (timer) clearTimeout(timer);
        try { reader.releaseLock(); } catch (_) {}
        try { socket.close(); } catch (_) {}
      }
    },
    cancel() { if (timer) clearTimeout(timer); try { socket.close(); } catch (_) {} },
  });
  const res = { status, ok: status >= 200 && status < 300, headers: respHeaders, body: stream };
  res.text = async () => {
    const r = stream.getReader();
    let acc = new Uint8Array(0);
    for (;;) { const { done, value } = await r.read(); if (done) break; acc = _concatBytes(acc, value); }
    return new TextDecoder().decode(acc);
  };
  return res;
}
// ─── 出口隧道(经外部代理换掉 Google 看到的 IP)─────────────────────────────
// 两种代理都支持,且隧道建好后一律 startTls() 到目标域名 —— 全程加密,
// 不会把 Gemini 的 cookie 明文交给代理。
/** 给 socket 的 readable 套一层缓冲,支持「按需精确读 n 字节」。
 *  真实 socket 一次 read 可能返回比需要的更多字节,所以必须缓冲而不是丢弃。 */
function streamSource(reader) {
  let buf = new Uint8Array(0);
  return {
    async need(n) {
      while (buf.length < n) {
        const { done, value } = await reader.read();
        if (done) throw new Error("proxy: socket closed mid-handshake");
        buf = _concatBytes(buf, value);
      }
      const out = buf.slice(0, n);
      buf = buf.slice(n);
      return out;
    },
    leftover() { return buf; },
  };
}
/** 读 HTTP 响应头直到空行(逐字节,CONNECT 响应只有几十字节)。 */
async function readHttpHead(src) {
  let text = "";
  for (let i = 0; i < 8192; i++) {
    text += String.fromCharCode((await src.need(1))[0]);
    if (text.endsWith("\r\n\r\n")) return text.slice(0, -4);
  }
  throw new Error("proxy: no CONNECT response");
}
/** SOCKS5 握手 + CONNECT(用户名/密码认证按需,支持域名地址)。 */
async function socks5Connect(writer, src, host, port, user, pass) {
  const enc = new TextEncoder();
  const wantAuth = !!(user || pass);
  await writer.write(new Uint8Array(wantAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const greeting = await src.need(2);
  if (greeting[0] !== 5) throw new Error("socks5: bad version reply");
  if (greeting[1] === 2) {
    const ub = enc.encode(user || "");
    const pb = enc.encode(pass || "");
    const msg = new Uint8Array(3 + ub.length + pb.length);
    let o = 0;
    msg[o++] = 1; msg[o++] = ub.length; msg.set(ub, o); o += ub.length;
    msg[o++] = pb.length; msg.set(pb, o);
    await writer.write(msg);
    const auth = await src.need(2);
    if (auth[1] !== 0) throw new Error("socks5: auth rejected");
  } else if (greeting[1] !== 0) {
    throw new Error("socks5: no acceptable auth method");
  }
  const hb = enc.encode(host);
  const req = new Uint8Array(7 + hb.length);
  let i = 0;
  req[i++] = 5; req[i++] = 1; req[i++] = 0; req[i++] = 3; req[i++] = hb.length;
  req.set(hb, i); i += hb.length;
  req[i++] = (port >> 8) & 0xff; req[i++] = port & 0xff;
  await writer.write(req);
  const rep = await src.need(4);
  if (rep[1] !== 0) throw new Error("socks5: connect failed (code " + rep[1] + ")");
  let skip = 0;
  if (rep[3] === 1) skip = 6;
  else if (rep[3] === 4) skip = 18;
  else if (rep[3] === 3) skip = (await src.need(1))[0] + 2;
  if (skip) await src.need(skip);
}
/**
 * 经代理发一次请求。http(s):// 走 CONNECT 隧道,socks5(h):// 走 SOCKS5。
 * 两者都在隧道建立后 startTls 到目标域名,再复用 httpOverSocket 的收发逻辑。
 */
async function proxyHttpFetch(cfg, entry, url, opts) {
  const connect = await resolveConnect();
  if (!connect) throw new Error("proxy egress requires cloudflare:sockets (unavailable in this runtime)");
  const p = entry.proxy || (parseEgressSpec(entry.target) || {}).proxy;
  if (!p) throw new Error("proxy egress: bad spec");
  const u = new URL(url);
  const secure = u.protocol !== "http:";
  const targetPort = u.port ? Number(u.port) : (secure ? 443 : 80);
  // 必须先以 starttls 打开,否则 socket.startTls() 会直接报
  // "secureTransport must be set to 'starttls'"。
  // 注意:https:// 代理这里也按明文连接处理(Workers 的 socket 不支持在已加密的
  // 连接上再 startTls,即无法做双层 TLS);隧道内的业务数据仍然是端到端 TLS,
  // 只有 CONNECT 行与代理凭据会以明文经过这一跳。
  if (p.scheme === "https") log(cfg, `代理 ${p.host}:${p.port} 用 https:// 声明,按明文 HTTP 代理处理(不支持双层 TLS)`);
  const socket = connect(
    { hostname: p.host, port: p.port },
    { secureTransport: "starttls", allowHalfOpen: false }
  );
  let writer = null;
  let reader = null;
  try {
    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();
    const src = streamSource(reader);
    if (p.scheme === "http" || p.scheme === "https") {
      let head = `CONNECT ${u.hostname}:${targetPort} HTTP/1.1\r\nHost: ${u.hostname}:${targetPort}\r\n`;
      if (p.user || p.pass) {
        head += "Proxy-Authorization: Basic " + bytesToBase64(new TextEncoder().encode(p.user + ":" + p.pass)) + "\r\n";
      }
      head += "\r\n";
      await writer.write(new TextEncoder().encode(head));
      const statusLine = (await readHttpHead(src)).split("\r\n")[0] || "";
      if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) throw new Error("proxy CONNECT refused: " + statusLine.trim());
    } else {
      await socks5Connect(writer, src, u.hostname, targetPort, p.user, p.pass);
    }
    reader.releaseLock();
    writer.releaseLock();
    reader = null;
    writer = null;
    let finalSocket = socket;
    if (secure) {
      if (typeof socket.startTls !== "function") throw new Error("socket.startTls unavailable: cannot TLS over proxy");
      // _proxyTlsMode 只用于排障(诊断接口可传),默认走正常路径
      const tlsMode = (cfg && cfg._proxyTlsMode) || "release";
      finalSocket = tlsMode === "noopts"
        ? socket.startTls()
        : socket.startTls({ expectedServerHostname: u.hostname });
    }
    return await httpOverSocket(finalSocket, url, opts);
  } catch (e) {
    try { if (reader) reader.releaseLock(); } catch (_) {}
    try { if (writer) writer.releaseLock(); } catch (_) {}
    try { socket.close(); } catch (_) {}
    throw e;
  }
}

/**
 * 经「盲转发中继」发一次请求(edgetunnel 的 PROXYIP 就是这类)。
 * 中继按 SNI 决定往哪转,所以不需要 CONNECT/SOCKS 握手:
 * 连上中继 → 直接 startTls 到目标域名(SNI 就是目标)→ 说 HTTPS。
 */
async function relayHttpFetch(cfg, entry, url, opts) {
  const connect = await resolveConnect();
  if (!connect) throw new Error("relay egress requires cloudflare:sockets");
  const r = entry.relay || {};
  if (!r.host || !r.port) throw new Error("relay egress: bad spec");
  const u = new URL(url);
  const secure = u.protocol !== "http:";
  const socket = connect({ hostname: r.host, port: r.port }, { secureTransport: "starttls", allowHalfOpen: false });
  try {
    const finalSocket = secure ? socket.startTls({ expectedServerHostname: u.hostname }) : socket;
    return await httpOverSocket(finalSocket, url, opts);
  } catch (e) {
    try { socket.close(); } catch (_) {}
    throw e;
  }
}

// ─── 出口池 ─────────────────────────────────────────────────────────────────
// 出口有三种,统一成同一套「打分 + 排序 + 择优」:
//   direct        直接用 Worker 自带出口
//   colo:<hint>   经 EgressRelay Durable Object,落在指定 Cloudflare 机房
//   proxy:<url>   经外部代理(http/https/socks5),真正换掉 Google 看到的 IP
const EGRESS_PROXY_RE = /^(https?|socks5h?):\/\/(?:([^:@/]+):([^@/]*)@)?([^:/@\s]+):(\d+)$/i;
/** 解析一条出口规格;无法识别返回 null。 */
function parseEgressSpec(spec) {
  const s = String(spec || "").trim();
  if (!s) return null;
  if (s.toLowerCase() === "direct") return { id: "direct", kind: "direct", target: "", label: "direct" };
  const m = /^colo:([a-z]{2,4})$/i.exec(s);
  if (m) {
    const hint = m[1].toLowerCase();
    if (!EGRESS_HINTS.has(hint)) return null;
    return { id: "colo:" + hint, kind: "colo", target: hint, label: hint.toUpperCase() };
  }
  const p = EGRESS_PROXY_RE.exec(s);
  if (p) {
    const scheme = p[1].toLowerCase();
    const user = p[2] ? decodeURIComponent(p[2]) : "";
    const pass = p[3] != null && p[3] !== "" ? decodeURIComponent(p[3]) : "";
    const host = p[4];
    const port = Number(p[5]);
    const target = `${scheme}://${user ? encodeURIComponent(user) + ":" + encodeURIComponent(pass) + "@" : ""}${host}:${port}`;
    return {
      id: "proxy:" + syncHash(target).slice(0, 12),
      kind: "proxy",
      target,
      label: `${scheme}://${host}:${port}`,
      proxy: { scheme, host, port, user, pass },
    };
  }
  // relay:host:port —— 盲转发中继(edgetunnel 的 PROXYIP 就是这种):连上之后
  // 它按 SNI 把流量原样转给目标,不需要 CONNECT/SOCKS 握手。
  const r = /^(?:relay:\/\/|relay:)([^:/@\s]+):(\d+)$/i.exec(s);
  if (r) {
    const host = r[1];
    const port = Number(r[2]);
    return {
      id: "relay:" + syncHash(host + ":" + port).slice(0, 12),
      kind: "relay",
      target: `${host}:${port}`,
      label: "relay://" + host + ":" + port,
      relay: { host, port },
    };
  }
  return null;
}
/** 默认出口池:沿用 EGRESS_HINT / EGRESS_FALLBACK_HINTS 配的机房。 */
function defaultEgressPool(cfg) {
  const hints = [cfg.egress_hint, ...(cfg.egress_fallback_hints || [])]
    .map((x) => String(x || "").trim()).filter(Boolean);
  return [...new Set(hints)].map((h) => parseEgressSpec("colo:" + h)).filter(Boolean);
}
/** 出口条目 → 规格字符串(存 D1 / 回显给前端都用它,保证往返一致)。 */
function entryToSpec(e) {
  if (!e) return "";
  if (e.kind === "direct") return "direct";
  if (e.kind === "colo") return "colo:" + (e.target || "");
  if (e.kind === "relay") return "relay:" + (e.target || "");
  return e.target || "";
}
/** 出口池:优先用 D1 里存的那份(可在前端热改),没有就用配置默认值。 */
async function loadEgressPool(cfg, env) {
  if (env && env.DB) {
    try {
      await ensureSchema(env);
      const r = await env.DB.prepare("SELECT id, kind, target, label FROM egress_pool ORDER BY ord").all();
      const rows = (r && r.results) || [];
      const out = rows.map((x) => parseEgressSpec(entryToSpec(x))).filter(Boolean);
      if (out.length) return out;
    } catch (_) { /* 退回配置默认 */ }
  }
  return defaultEgressPool(cfg);
}
async function saveEgressPool(env, specs) {
  if (!env || !env.DB) return false;
  let prev = [];
  try {
    await ensureSchema(env);
    const r = await env.DB.prepare("SELECT target FROM egress_pool").all();
    prev = ((r && r.results) || []).map((x) => x.target).filter(Boolean);
  } catch (_) { /* 读不到就当没有 */ }
  const parsed = (specs || [])
    .map((s) => {
      const spec = typeof s === "string" ? s : (s && s.target) || "";
      let e = parseEgressSpec(spec);
      // GET 接口回显时密码是 ***。前端把打码后的池原样存回来的话,得把真密码找回来,
      // 否则「在页面上点一次保存」就把代理凭据抹成 *** 了。
      if (e && e.kind === "proxy" && e.proxy.pass === "***") {
        const match = prev
          .map((t) => parseEgressSpec(t))
          .find((p) => p && p.kind === "proxy" && p.proxy.scheme === e.proxy.scheme &&
            p.proxy.host === e.proxy.host && p.proxy.port === e.proxy.port && p.proxy.user === e.proxy.user);
        if (match) e = match;
      }
      return e;
    })
    .filter(Boolean);
  try {
    await ensureSchema(env);
    const stmts = [env.DB.prepare("DELETE FROM egress_pool")];
    parsed.forEach((e, i) => {
      stmts.push(env.DB.prepare(
        "INSERT INTO egress_pool (id, kind, target, label, ord) VALUES (?1,?2,?3,?4,?5)"
      ).bind(e.id, e.kind, e.target || "", e.label || e.id, i));
    });
    await env.DB.batch(stmts);
    return parsed;
  } catch (_) { return false; }
}
/** 出口相关设置(强制出口 / 图片探针开关)。存 D1 是为了写完立刻能读到。 */
async function loadEgressSettings(env) {
  const out = {};
  if (!env || !env.DB) return out;
  try {
    await ensureSchema(env);
    const r = await env.DB.prepare("SELECT k, v FROM egress_settings").all();
    for (const row of (r && r.results) || []) out[row.k] = row.v;
  } catch (_) { /* ignore */ }
  return out;
}
async function saveEgressSetting(env, k, v) {
  if (!env || !env.DB) return false;
  try {
    await ensureSchema(env);
    if (v === "" || v == null) {
      await env.DB.prepare("DELETE FROM egress_settings WHERE k = ?1").bind(k).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO egress_settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
      ).bind(k, String(v)).run();
    }
    return true;
  } catch (_) { return false; }
}

// ── 纯净度评分 ──────────────────────────────────────────────────────────────
// 分数只反映「这个出口对 Gemini 有多干净」,不看带宽。基准:
//   文本通 40 / 通但空 10 / 429(能连上、只是被限流)4 / 5xx 2 / 1060 或超时 0
//   图片能出图再 +50 —— 图片才是真正卡人的指标
//   拿到过响应再按延迟加 0~10 分
const TEXT_SCORE = { ok: 40, empty: 10, "429": 4, http500: 2, http502: 2, http503: 2, html: 0, timeout: 0, error: 0, "1060": 0 };
function scoreEgress(row) {
  if (!row) return 0;
  let s = TEXT_SCORE[row.text_status] != null ? TEXT_SCORE[row.text_status] : (row.text_status ? 1 : 0);
  if (row.image_status === "ok") s += 50;
  const lat = Number(row.latency_ms || 0);
  if (lat > 0) s += Math.max(0, 10 - Math.min(10, lat / 1200));
  return Math.max(0, Math.min(100, Math.round(s)));
}
async function egressStatsAll(env) {
  const out = new Map();
  if (!env || !env.DB) return out;
  try {
    await ensureSchema(env);
    const r = await env.DB.prepare("SELECT * FROM egress_stats").all();
    for (const row of (r && r.results) || []) out.set(row.id, row);
  } catch (_) { /* ignore */ }
  return out;
}
async function egressStatPut(env, entry, patch) {
  if (!env || !env.DB) return null;
  try {
    await ensureSchema(env);
    const prev = await env.DB.prepare("SELECT * FROM egress_stats WHERE id = ?1").bind(entry.id).first();
    const row = Object.assign(
      { runs: 0, ok_runs: 0, image_ok_runs: 0, fails: 0, latency_ms: 0, text_status: "", image_status: "" },
      prev || {}, patch || {}
    );
    row.kind = entry.kind;
    row.target = entry.target || "";
    row.label = entry.label || entry.id;
    row.runs = Number(row.runs || 0);
    row.score = scoreEgress(row);
    row.updated_ts = Date.now();
    await env.DB.prepare(
      "INSERT INTO egress_stats (id, kind, target, label, text_status, image_status, latency_ms, runs, ok_runs, " +
      "image_ok_runs, fails, score, detail, updated_ts) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) " +
      "ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, target=excluded.target, label=excluded.label, " +
      "text_status=excluded.text_status, image_status=excluded.image_status, latency_ms=excluded.latency_ms, " +
      "runs=excluded.runs, ok_runs=excluded.ok_runs, image_ok_runs=excluded.image_ok_runs, fails=excluded.fails, " +
      "score=excluded.score, detail=excluded.detail, updated_ts=excluded.updated_ts"
    ).bind(
      entry.id, row.kind, row.target, row.label, row.text_status || "", row.image_status || "",
      Number(row.latency_ms || 0) | 0, row.runs | 0, Number(row.ok_runs || 0) | 0,
      Number(row.image_ok_runs || 0) | 0, Number(row.fails || 0) | 0, row.score,
      row.detail == null ? null : String(row.detail).slice(0, 400), row.updated_ts
    ).run();
    return row;
  } catch (e) {
    log({ log_requests: true }, `egress 统计写入失败: ${e}`);
    return null;
  }
}
/** 出口按分数从高到低排序;强制指定的出口排最前。 */
function orderEgress(pool, stats, force) {
  const forced = force ? String(force) : "";
  const withScore = pool.map((e, i) => ({ e, i, score: (stats.get(e.id) || {}).score || 0 }));
  withScore.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  if (!forced) return withScore.map((x) => x.e);
  const idx = withScore.findIndex((x) => x.e.id === forced || x.e.target === forced);
  if (idx <= 0) return withScore.map((x) => x.e);
  const arr = withScore.map((x) => x.e);
  const [pick] = arr.splice(idx, 1);
  return [pick, ...arr];
}

/** 从上游响应里取「它认为你的出口在哪」。这是判断机房落点的唯一可靠依据。
 *  注意:响应是 JSON 套 JSON,引号是转义的(\"),所以先去掉反斜杠再匹配。 */
function extractEgressLocation(raw) {
  const flat = String(raw || "").replace(/\\/g, "");
  const m = /"([^"]{2,40})","SWML_DESCRIPTION_FROM_YOUR_INTERNET_ADDRESS"/.exec(flat);
  return m ? m[1] : "";
}
/** 一次纯净度探测:先文本探针,再(可选)图片探针 —— 图片才是真正卡人的指标。 */
async function probeEgress(cfg, env, entry, opts) {
  const probeCfg = Object.assign({}, cfg, {
    _env: env, _egress: entry, do_egress: false, alt_transport: false,
    fingerprint_jitter_ms: 0, retry_attempts: 1, log_requests: false,
  });
  const m = resolveModel("gemini-flash-lite", cfg.default_model);
  let textStatus = "error";
  let latency = 0;
  let detail = "";
  let location = "";
  try {
    const body = buildPayload("Reply with exactly one word: PONG", m.modeId, m.thinkMode, null, m.extra, probeCfg);
    const headers = await buildHeaders(probeCfg);
    const t0 = Date.now();
    const resp = await httpFetch(getUrl(probeCfg), { method: "POST", headers, body, timeoutMs: 60000, socket: true, cfg: probeCfg });
    const raw = await resp.text();
    latency = Date.now() - t0;
    // 上游会回报它认定的出口位置,这是判断「这个机房到底落在哪」的唯一可靠依据。
    location = extractEgressLocation(raw);
    const bard = /BardErrorInfo[^0-9]{0,20}(\d{3,5})/.exec(raw);
    if (bard) textStatus = bard[1];
    else if (resp.status === 429 || /recaptcha|unusual traffic/i.test(raw)) textStatus = "429";
    else if (!resp.ok) textStatus = "http" + resp.status;
    else if (/<!doctype html|sorry\/index/i.test(raw)) textStatus = "html";
    else textStatus = extractResponseText(raw, null) ? "ok" : "empty";
  } catch (e) {
    textStatus = /timeout|abort/i.test(String((e && e.message) || e)) ? "timeout" : "error";
    detail = String((e && e.message) || e).slice(0, 200);
  }
  let imageStatus = "skipped";
  if (opts && opts.image) {
    try {
      const ibody = buildPayload("Generate a small image of a red apple.", m.modeId, m.thinkMode, null, m.extra, probeCfg);
      const iheaders = await buildHeaders(probeCfg);
      const iresp = await httpFetch(getUrl(probeCfg), { method: "POST", headers: iheaders, body: ibody, timeoutMs: 90000, socket: true, cfg: probeCfg });
      const iraw = await iresp.text();
      // 位置块通常只出现在「带内容」的响应里,极简回答没有 —— 从图片探针再取一次
      if (!location) location = extractEgressLocation(iraw);
      if (/BardErrorInfo[^0-9]{0,20}(\d{3,5})/.test(iraw) || !iresp.ok) imageStatus = "error";
      else if (IMAGE_REGION_RE.test(iraw)) imageStatus = "blocked";
      else {
        const imgs = [];
        for (const line of iraw.split("\n")) {
          for (const im of extractPartsFromLine(line).images) {
            if (!imgs.some((x) => x.url === im.url)) imgs.push(im);
          }
        }
        imageStatus = imgs.length ? "ok" : "blocked";
      }
    } catch (_) {
      imageStatus = "error";
    }
  }
  const prev = (await egressStatsAll(env)).get(entry.id) || {};
  return egressStatPut(env, entry, {
    text_status: textStatus,
    image_status: imageStatus,
    latency_ms: latency,
    detail: [location ? "loc=" + location : "", detail].filter(Boolean).join(" "),
    runs: Number(prev.runs || 0) + 1,
    ok_runs: Number(prev.ok_runs || 0) + (textStatus === "ok" ? 1 : 0),
    image_ok_runs: Number(prev.image_ok_runs || 0) + (imageStatus === "ok" ? 1 : 0),
    fails: Number(prev.fails || 0) + (textStatus === "ok" ? 0 : 1),
  });
}
/** 跑一轮出口纯净度测试,返回排序后的结果。 */
async function runEgressTests(cfg, env, ids, opts) {
  const pool = await loadEgressPool(cfg, env);
  const want = Array.isArray(ids) && ids.length ? pool.filter((e) => ids.includes(e.id)) : pool;
  const results = [];
  for (const entry of want) {
    try {
      results.push(await probeEgress(cfg, env, entry, opts));
    } catch (e) {
      results.push({ id: entry.id, label: entry.label, error: String((e && e.message) || e) });
    }
  }
  return results;
}

/** 出口排序结果按 isolate 缓存 60s,避免每个请求都多一次 D1 读。 */
let _egressCache = { data: null, ts: 0 };
async function egressOrderCached(cfg, env) {
  const now = Date.now();
  if (_egressCache.data && now - _egressCache.ts < 60000) return _egressCache.data;
  const pool = await loadEgressPool(cfg, env);
  if (!pool.length) { _egressCache = { data: [], ts: now }; return []; }
  const [stats, settings] = await Promise.all([egressStatsAll(env), loadEgressSettings(env)]);
  const force = settings.force || cfg.egress_force || "";
  cfg._egressForce = force;
  if (settings.probe_image !== undefined) cfg.egress_probe_image = settings.probe_image === "1";
  const order = orderEgress(pool, stats, force);
  _egressCache = { data: order, ts: now };
  return order;
}
/** 出口冷却:某出口刚被 Google 判异常(1060 / 429 / 302 验证码页)时,
 *  短时间内别再轮到它 —— 否则重试预算会被同一个坏出口连续吃掉,
 *  最后把原始的 302 直接抛给调用方。冷却是有时效的,不会永久拉黑。 */
const EGRESS_COOLDOWN_MS = 90000;
const _egressCooldown = new Map(); // id -> 冷却截止时间
function egressCooling(id) {
  const until = _egressCooldown.get(id);
  if (!until) return false;
  if (Date.now() >= until) { _egressCooldown.delete(id); return false; }
  return true;
}
function markEgressBad(cfg, ms) {
  const e = cfg && cfg._egress;
  if (!e || !e.id) return;
  const w = ms || EGRESS_COOLDOWN_MS;
  _egressCooldown.set(e.id, Date.now() + w);
  log(cfg, `出口 ${e.label || e.id} 被上游判异常,冷却 ${Math.round(w / 1000)}s`);
}
function markEgressGood(cfg) {
  const e = cfg && cfg._egress;
  if (e && e.id) _egressCooldown.delete(e.id);
}
/** 第 attempt 次尝试用池里第几个出口(按分数排序,跳过正在冷却的)。 */
function applyEgressAttempt(cfg, attempt) {
  const order = cfg && cfg._egressOrder;
  if (!order || !order.length) return;
  const usable = order.filter((e) => !egressCooling(e.id));
  const list = usable.length ? usable : order; // 全在冷却才退回去硬试
  const e = list[attempt % list.length];
  cfg._egress = e;
  if (e.kind === "colo" && e.target) cfg._egressHint = e.target;
}

// 统一上游入口:socket 优先,失败/不可用则回退 fetch。返回类 Response 对象。
// roundRobin>1 时:每次请求在多个 socket 连接间轮换,利用 CF 出口 IP 池
// (不同 TCP 连接常落到不同出口),降低被 Google 单点风控(1060)的概率。
async function httpFetch(url, { method = "GET", headers = {}, body, timeoutMs = 180000, socket = true, redirect, cfg } = {}) {
  const gemini = isGeminiOrigin(url, cfg);
  // ① 显式指定的出口优先(出口池调度、纯净度探测都从这条路走)。
  //    正常情况下只作用于 Gemini 源站;诊断用 _forceEgress 绕过该限制。
  if (cfg && cfg._egress && (gemini || cfg._forceEgress)) {
    const e = cfg._egress;
    if (e.kind === "proxy") {
      return await proxyHttpFetch(cfg, e, url, { method, headers, body, timeoutMs });
    }
    if (e.kind === "relay") {
      return await relayHttpFetch(cfg, e, url, { method, headers, body, timeoutMs });
    }
    if (e.kind === "colo" && cfg._env && cfg._env.EGRESS) {
      const relayed = await doEgressFetch(cfg, url, { method, headers, body, redirect }, [e.target]);
      if (relayed) return relayed;
    }
    // direct:落到下面的普通路径
  }
  // ② 老行为:优先走区域 Durable Object(Gemini 源站调用)
  if (cfg && cfg.do_egress !== false && cfg._env && cfg._env.EGRESS && gemini) {
    try {
      const relayed = await doEgressFetch(cfg, url, { method, headers, body, redirect });
      if (relayed) return relayed;
    } catch (e) {
      // Actual upstream rejection must reach berrRetry() so it can rotate exits.
      if (isRetryableUpstream(e)) throw e;
      log(cfg, `DO egress unavailable, falling back to local transport: ${(e && e.message) || e}`);
    }
  }
  if (socket) {
    const connect = await resolveConnect();
    if (connect) {
      try {
        return await socketHttp(connect, url, { method, headers, body, timeoutMs });
      } catch (e) {
        // socket 连接层失败(非 HTTP 错误)-> 回退 fetch
      }
    }
  }
  const init = { method, headers, body, signal: timeoutSignal(timeoutMs) };
  if (redirect) init.redirect = redirect;
  return fetch(url, init);
}
// ─── BL 自动更新(405 过期时兜底)─────────────────────────────────────────
// 从 /app 页面源码抓最新 boq 构建号;成功且不同则更新 cfg.gemini_bl 并返回 true。
async function fetchLatestBl(cfg) {
  try {
    const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
    const headers = { "User-Agent": _UA };
    if (cfg.cookie) headers["Cookie"] = cfg.cookie;
    const resp = await httpFetch(`${origin}${accountPrefix(cfg)}/app`, { headers, timeoutMs: 15000, socket: cfg.upstream_socket, cfg });
    const html = await resp.text();
    const m = /(boq_assistant-bard-web-server_\d+\.\d+_p\d+)/.exec(html);
    return m ? m[1] : null;
  } catch (e) {
    log(cfg, `BL auto-update fetch failed: ${e}`);
    return null;
  }
}
async function updateBlIfNeeded(cfg) {
  if (!cfg.auto_update_bl) return false;
  const newBl = await fetchLatestBl(cfg);
  if (newBl && newBl !== cfg.gemini_bl) {
    log(cfg, `BL auto-updated: ${cfg.gemini_bl} -> ${newBl}`);
    cfg.gemini_bl = newBl;
    return true;
  }
  return false;
}
// ─── 多模态:图片上传(Scotty 续传)───────────────────────────────────────────
// 说明:图片输入需要登录态(GEMINI_COOKIE)。匿名会话上传文件能成功,但带图
// 生成会被后端以 BardErrorInfo[1100] 拒绝(权限门)。无 cookie 时不上传,
// 改为在 prompt 里追加一句提示,降级为纯文本。详见 test/live-image.mjs。
const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let _pageTokens = { tokens: null, ts: 0 };
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function normalizeMimeType(mime, fallback = "image/png") {
  const m = String(mime || "").split(";")[0].trim().toLowerCase();
  if (m === "image/jpg" || m === "image/pjpeg") return "image/jpeg";
  return m || fallback;
}
function detectImageMime(bytes, fallback = "image/png") {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...b.subarray(0, 6)))) return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return "image/tiff";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...b.subarray(8, 12)).toLowerCase();
    if (["avif", "avis"].includes(brand)) return "image/avif";
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
  }
  return fallback;
}
function decodeDataUrl(url) {
  if (typeof url !== "string" || !url.toLowerCase().startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const metaParts = url.slice(5, comma).split(";");
  const mime = normalizeMimeType(metaParts[0], "image/png");
  const data = url.slice(comma + 1);
  const isBase64 = metaParts.slice(1).some((x) => x.trim().toLowerCase() === "base64");
  try {
    if (isBase64) return { b64: data.replace(/\s+/g, ""), mime };
    return { b64: bytesToBase64(percentDecodeBytes(data)), mime };
  } catch (_) { return null; }
}
// 按字节解码 percent-encoding:%XX 直接取字节,其余字符按 UTF-8 编码。
// 不能用 decodeURIComponent:它会按 UTF-8 解析 %89 之类的原始二进制字节并抛错。
function percentDecodeBytes(str) {
  const out = [];
  const enc = new TextEncoder();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "%" && i + 2 < str.length + 1) {
      const hex = str.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; continue; }
    }
    for (const b of enc.encode(ch)) out.push(b);
  }
  return new Uint8Array(out);
}
// 解析 image_url:data:URL 或 http(s) URL。MIME 参数仅作兜底,
// 真正上传前会按 magic bytes 修正。
function parseImageUrl(url, mime) {
  if (!url || typeof url !== "string") return null;
  const fallbackMime = normalizeMimeType(mime, "");
  if (url.toLowerCase().startsWith("data:")) {
    const out = decodeDataUrl(url);
    if (out && fallbackMime) out.mime = fallbackMime;
    return out;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { url: parsed.href, mime: fallbackMime };
  } catch (_) { return null; }
}
// 兼容 OpenAI Chat Completions / Responses 与 Anthropic image part 形态。
function imageFromPart(part) {
  if (!part || typeof part !== "object") return null;
  const type = part.type;
  if (type === "image_url") {
    const imageUrl = part.image_url;
    if (typeof imageUrl === "string") return parseImageUrl(imageUrl, part.mime_type);
    if (imageUrl && typeof imageUrl === "object") {
      return parseImageUrl(imageUrl.url, imageUrl.mime_type || part.mime_type);
    }
    return null;
  }
  if (type === "input_image" || type === "image") {
    if (part.source && typeof part.source === "object") {
      if (part.source.type === "base64" && part.source.data) {
        return { b64: String(part.source.data), mime: normalizeMimeType(part.source.media_type, "image/png") };
      }
      if (part.source.url) return parseImageUrl(String(part.source.url), part.source.media_type);
    }
    const imageUrl = part.image_url || part.url;
    if (typeof imageUrl === "string") return parseImageUrl(imageUrl, part.mime_type || part.media_type);
    if (imageUrl && typeof imageUrl === "object") {
      return parseImageUrl(imageUrl.url || imageUrl.image_url, imageUrl.mime_type || part.mime_type || part.media_type);
    }
    const data = part.data || part.base64 || part.b64;
    if (typeof data === "string") {
      if (data.toLowerCase().startsWith("data:")) return decodeDataUrl(data);
      return { b64: data, mime: normalizeMimeType(part.mime_type || part.media_type, "image/png") };
    }
  }
  return null;
}
// 抓取 gemini.google.com/app 页面里的上传 token(带 10 分钟缓存)。
async function getPageTokens(cfg) {
  const now = Date.now();
  if (_pageTokens.tokens && now - _pageTokens.ts < 600000) return _pageTokens.tokens;
  const headers = { "User-Agent": _UA };
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  const tokens = {};
  try {
    const resp = await httpFetch(`${cfg.gemini_origin || "https://gemini.google.com"}/app`, { headers, timeoutMs: 30000, socket: cfg.upstream_socket, cfg });
    const html = await resp.text();
    for (const [k, re] of [["push_id", /"qKIAYe":"([^"]+)"/], ["pctx", /"Ylro7b":"([^"]+)"/]]) {
      const mm = re.exec(html);
      if (mm) tokens[k] = mm[1];
    }
  } catch (e) {
    /* 用默认值兜底 */
  }
  _pageTokens = { tokens, ts: now };
  return tokens;
}
// Scotty 续传上传一张图,返回文件引用(形如 "/contrib_service/ttl_1d/...")。
async function uploadImage(cfg, bytes, mime) {
  const tokens = await getPageTokens(cfg);
  const pushId = tokens.push_id || "feeds/mcudyrk2a4khkz";
  const pctx = tokens.pctx || "CgcSBWjK7pYx";
  const startHeaders = {
    "Push-ID": pushId,
    "X-Tenant-Id": "bard-storage",
    "X-Client-Pctx": pctx,
    "X-Goog-Upload-Header-Content-Length": String(bytes.length),
    "X-Goog-Upload-Header-Content-Type": mime,
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "User-Agent": _UA,
  };
  if (cfg.cookie) startHeaders["Cookie"] = cfg.cookie;
  if (cfg.sapisid) startHeaders["Authorization"] = await makeSapisidHash(cfg.sapisid);
  const r1 = await httpFetch("https://content-push.googleapis.com/upload/", { method: "POST", headers: startHeaders, body: "", timeoutMs: 30000, socket: cfg.upstream_socket, cfg });
  const uploadUrl = r1.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`no upload URL (status ${r1.status})`);
  const r2 = await httpFetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Type": "application/octet-stream", "User-Agent": _UA },
    body: bytes,
    timeoutMs: 60000,
    socket: cfg.upstream_socket,
    cfg,
  });
  const fileRef = (await r2.text()).trim();
  if (!fileRef.startsWith("/")) throw new Error(`invalid file ref: ${fileRef.slice(0, 120)}`);
  return fileRef;
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 5;
function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c <= 2) || (b === 88 && c === 99) ||
      (b === 51 && c === 100))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}
function isPrivateHostname(hostname) {
  let host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".home.arpa") || host === "metadata.google.internal" ||
      host === "metadata" || host === "instance-data") return true;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.includes(":")) {
    const h = host.split("%")[0].toLowerCase();
    if (h === "::" || h === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
    if (h.startsWith("::ffff:")) {
      const mapped = h.slice(7);
      return mapped.includes(".") ? isPrivateIpv4(mapped) : mapped === "7f00:1";
    }
    return false;
  }
  return isPrivateIpv4(host);
}
function validateImageUrl(value) {
  const parsed = value instanceof URL ? value : new URL(String(value || ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported image URL scheme");
  if (parsed.username || parsed.password) throw new Error("image URL credentials are not allowed");
  if (isPrivateHostname(parsed.hostname)) throw new Error(`blocked private/internal image host ${parsed.hostname}`);
  return parsed;
}
const _dnsPrivateCache = new Map();
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;

function isIpLiteral(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  return isPrivateIpv4(h) || h.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h);
}

async function assertPublicImageHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHostname(host)) throw new Error(`blocked private/internal image host ${host}`);
  if (isIpLiteral(host)) return;
  const cached = _dnsPrivateCache.get(host);
  if (cached && Date.now() - cached.ts < DNS_CACHE_TTL_MS) {
    if (cached.private) throw new Error(`blocked private/internal image host ${host}`);
    return;
  }
  const resolvers = [
    (t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${t}`,
    (t) => `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${t}`,
  ];
  let isPrivate = false;
  let lastErr = null;
  let resolved = false;
  for (const type of ["A", "AAAA"]) {
    for (const buildUrl of resolvers) {
      try {
        const resp = await fetch(buildUrl(type), {
          headers: { Accept: "application/dns-json" },
          signal: timeoutSignal(4000),
        });
        if (!resp.ok) throw new Error(`DNS ${resp.status}`);
        const data = await resp.json();
        const answers = Array.isArray(data.Answer) ? data.Answer : [];
        if (answers.some((a) => (a.type === 1 || a.type === 28) && isPrivateHostname(String(a.data || "")))) {
          isPrivate = true;
        }
        resolved = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (isPrivate) break;
  }
  if (!resolved) throw new Error(`image host DNS validation failed: ${(lastErr && lastErr.message) || lastErr}`);
  _dnsPrivateCache.set(host, { private: isPrivate, ts: Date.now() });
  if (isPrivate) throw new Error(`blocked private/internal image host ${host}`);
}

async function fetchRemoteImage(cfg, rawUrl) {
  let current = validateImageUrl(rawUrl);
  await assertPublicImageHost(current.hostname);
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const resp = await fetch(current.href, {
      headers: {
        "User-Agent": _UA,
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1",
      },
      redirect: "manual",
      signal: timeoutSignal(Math.min((cfg.request_timeout_sec || 180) * 1000, 45000)),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (resp.body) { try { await resp.body.cancel(); } catch (_) {} }
      if (!loc) throw new Error(`image redirect ${resp.status} without Location`);
      current = validateImageUrl(new URL(loc, current));
      await assertPublicImageHost(current.hostname);
      continue;
    }
    if (!resp.ok) {
      if (resp.body) { try { await resp.body.cancel(); } catch (_) {} }
      throw new Error(`image fetch HTTP ${resp.status}`);
    }
    const declaredLength = Number(resp.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) throw new Error(`image too large (${declaredLength} bytes)`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large (${buf.byteLength} bytes)`);
    const bytes = new Uint8Array(buf);
    const declaredMime = normalizeMimeType(resp.headers.get("content-type"), "");
    const detectedMime = detectImageMime(bytes, "");
    const mime = detectedMime || declaredMime || "image/png";
    if (!mime.startsWith("image/") && declaredMime &&
        !/^(application\/octet-stream|binary\/octet-stream)$/.test(declaredMime)) {
      throw new Error(`remote resource is not an image (${declaredMime})`);
    }
    return { bytes, mime };
  }
  throw new Error("too many image redirects");
}
// 把收集到的图片解析/上传成文件引用。返回 { fileRefs, droppedNote }。
// 无 cookie 时不上传(会被 1100 拒),改为返回一段提示文字追加到 prompt。
async function resolveImages(cfg, images) {
  if (!images || !images.length) return { fileRefs: null, droppedNote: "" };
  if (!cfg.cookie) {
    return { fileRefs: null, droppedNote: `

[Note: ${images.length} image(s) were provided but ignored - image input requires a configured GEMINI_COOKIE.]` };
  }
  const refs = [];
  const failures = [];
  for (let idx = 0; idx < images.length; idx++) {
    const img = images[idx];
    try {
      if (!img || typeof img !== "object") throw new Error("malformed image item");
      let bytes;
      let mime;
      if (img.url) {
        const remote = await fetchRemoteImage(cfg, img.url);
        bytes = remote.bytes;
        mime = detectImageMime(bytes, img.mime || remote.mime || "image/png");
      } else {
        if (!img.b64) throw new Error("missing image data");
        bytes = base64ToBytes(img.b64);
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${bytes.length} bytes)`);
        mime = detectImageMime(bytes, normalizeMimeType(img.mime, "image/png"));
      }
      const ck = await fileRefCacheKey(cfg, bytes, mime);
      let ref = ck ? await cacheGetRef(cfg, ck.key) : null;
      if (ref) {
        log(cfg, `image cache hit (${mime}, ${bytes.length}B)`);
      } else {
        ref = await uploadImage(cfg, bytes, mime);
        if (ck) await cachePutRef(cfg, ck.key, ref, mime, bytes.length);
      }
      refs.push(ref);
    } catch (e) {
      const msg = `image ${idx + 1}: ${(e && e.message) || e}`;
      failures.push(msg);
      log(cfg, `image upload failed: ${msg}`);
    }
  }
  if (failures.length && !refs.length) throw new Error(`all image uploads failed: ${failures.join("; ")}`);
  if (failures.length) log(cfg, `Warning: partial image upload success, ${failures.length} failed: ${failures.join("; ")}`);
  return { fileRefs: refs.length ? refs : null, droppedNote: "" };
}
// 同一张图重复上传很浪费(还要占用 Gemini 文件配额),按内容 sha256 缓存文件引用。
// 优先用 R2(binding FILECACHE),没配 R2 时退回 D1 的 file_cache 表。
async function fileRefCacheKey(cfg, bytes, mime) {
  try {
    const acct = await shortHash(cfg.sapisid || cfg.cookie || "anon", 16);
    const m = new TextEncoder().encode(String(mime || ""));
    const buf = new Uint8Array(bytes.length + m.length);
    buf.set(bytes, 0);
    buf.set(m, bytes.length);
    const d = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { key: `img:${acct}:${hex}` };
  } catch (_) {
    return null;
  }
}
const FILE_REF_TTL_MS = 6 * 3600 * 1000; // 上游文件引用 TTL 只有 1 天,保守取 6 小时
async function cacheGetRef(cfg, key) {
  const env = cfg._env;
  if (!env) return null;
  try {
    if (env.FILECACHE) {
      const obj = await env.FILECACHE.get(key);
      if (!obj) return null;
      const j = JSON.parse(await obj.text());
      return j && j.ref && Date.now() - j.ts < FILE_REF_TTL_MS ? j.ref : null;
    }
    if (env.DB) {
      const row = await env.DB.prepare("SELECT ref, ts FROM file_cache WHERE hash = ?1").bind(key).first();
      return row && row.ref && Date.now() - row.ts < FILE_REF_TTL_MS ? row.ref : null;
    }
  } catch (_) { /* 缓存失败不影响主流程 */ }
  return null;
}
async function cachePutRef(cfg, key, ref, mime, size) {
  const env = cfg._env;
  if (!env || !ref) return;
  try {
    if (env.FILECACHE) {
      await env.FILECACHE.put(key, JSON.stringify({ ref, ts: Date.now(), mime, size }));
      return;
    }
    if (env.DB) {
      await env.DB.prepare(
        "INSERT INTO file_cache (hash, ref, ts, mime, size) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(hash) DO UPDATE SET ref = excluded.ref, ts = excluded.ts"
      ).bind(key, ref, Date.now(), String(mime || ""), size | 0).run();
    }
  } catch (_) { /* ignore */ }
}
function stripArtifacts(text) {
  if (!text) return "";
  text = text.replace(
    /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
    ""
  );
  text = text.replace(/https?:\/\/googleusercontent\.com\/(?:card_content|image_generation_content)\/[\d_]+\n?/g, "");
  return text;
}
// 整段清理:去掉残留标记并裁剪首尾空白。
function cleanText(text) {
  return stripArtifacts(text).trim();
}
/**
 * 上游「生成图片」的附件 URL 埋得很深。实测结构(2026-09,从真机浏览器抓取):
 *   ["rc_xxx",["\n\nhttp://googleusercontent.com/image_generation_content/0_621\n\n"],
 *     null,null,null,null,null,null,[1],null,null,null,
 *     [null,...,
 *       [[[[null,null,null,[null,1,"watermarked_img_123.jpg",
 *                          "https://lh3.googleusercontent.com/gg-dl/AAQ...",null]]]]]]]
 * 也就是说:同一数组里同时出现「*.(jpg|png|webp) 文件名」和「lh3.googleusercontent 图片链接」。
 */
const IMG_NAME_RE = /\.(?:jpe?g|png|webp|gif|heic|avif)$/i;
const IMG_URL_RE = /https?:\/\/(?:lh\d+\.)?googleusercontent\.com\/(?:gg|gg-dl|rd-ogw|rd-gg-dl)\//;
function looksLikeImageUrl(s) {
  return typeof s === "string" && s.length >= 24 && s.length <= 4000 && IMG_URL_RE.test(s);
}
function collectGenImages(node, out, depth) {
  if (!node || out.length >= 8 || depth > 14) return;
  if (Array.isArray(node)) {
    let url = null;
    let name = null;
    for (const el of node) {
      if (typeof el !== "string") continue;
      if (!url && looksLikeImageUrl(el)) url = el;
      else if (!name && IMG_NAME_RE.test(el) && el.length < 200 && !/^https?:/.test(el)) name = el;
    }
    if (url) {
      if (!out.some((x) => x.url === url)) out.push({ url, name: name || "generated-image" });
      return;
    }
    for (const el of node) collectGenImages(el, out, depth + 1);
    return;
  }
  if (typeof node === "object") for (const k of Object.keys(node)) collectGenImages(node[k], out, depth + 1);
}
/**
 * 解析单行 `wrb.fr`,返回 { texts, images, meta }。
 * meta = [cid, rid, rcid] —— Gemini 的会话标识。下一轮把它放进 inner[2]
 * 就能接着同一个会话聊,不需要重传历史。槽位见 buildPayload() 的注释。
 * 注意:承载会话 id 的那几行往往没有内容体(inner[4] 为空),所以 meta
 * 必须在 inner[4] 判断之前先取出来。
 */
function extractPartsFromLine(line) {
  const empty = { texts: [], images: [], meta: null };
  if (!line.includes('"wrb.fr"') || line.length < 40) return empty;
  try {
    const arr = JSON.parse(line);
    const innerStr = arr[0][2];
    if (!innerStr || innerStr.length < 50) return empty;
    const inner = JSON.parse(innerStr);
    if (!Array.isArray(inner)) return empty;
    const meta = extractSessionMeta(inner);
    if (!(inner.length > 4 && inner[4])) return { texts: [], images: [], meta };
    const texts = [];
    for (const part of inner[4]) {
      if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
        for (const t of part[1]) {
          if (typeof t === "string" && t) texts.push(t);
        }
      }
    }
    const images = [];
    collectGenImages(inner, images, 0);
    return { texts, images, meta };
  } catch (_) {
    return empty;
  }
}
/** 从已解析的 inner 里取 [cid, rid, rcid];取不到返回 null。 */
function extractSessionMeta(inner) {
  const ids = Array.isArray(inner[1]) ? inner[1] : null;
  const cid = ids && typeof ids[0] === "string" && ids[0].indexOf("c_") === 0 ? ids[0] : "";
  const rid = ids && typeof ids[1] === "string" && ids[1].indexOf("r_") === 0 ? ids[1] : "";
  if (!cid || !rid) return null;
  let rcid = "";
  const first = Array.isArray(inner[4]) && Array.isArray(inner[4][0]) ? inner[4][0][0] : "";
  if (typeof first === "string" && first.indexOf("rc_") === 0) rcid = first;
  return [cid, rid, rcid];
}
/** 兼容旧签名:只要文本。 */
function extractTextsFromLine(line) {
  return extractPartsFromLine(line).texts;
}
/** 把生成图片拼成 Markdown(OpenAI 兼容客户端基本都能渲染)。 */
function withImages(text, images, cfg) {
  if (!images || !images.length) return text || "";
  const md = images.map((im) => `![${im.name || "generated image"}](${imageProxyUrl(cfg, im.url)})`).join("\n");
  return text ? `${text}\n\n${md}` : md;
}
function extractMarkdownImageUrls(text) {
  const out = [];
  if (!text) return out;
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
// 上游以 BardErrorInfo[code] 拒绝时直接抛错,不再静默返回空。
// BardError 带 code,便于调用方识别 1060(IP 风控)做跨出口池重试。
class BardError extends Error {
  constructor(code) {
    super(`Gemini upstream rejected request: BardErrorInfo [${code}]`);
    this.name = "BardError";
    this.code = Number(code);
    this.retryable = this.code === 1060 || this.code === 1049; // 出口 IP 风控类错误,重试有意义
  }
}
function isBardError(e) {
  return e instanceof BardError || (e && /BardErrorInfo \[(\d+)\]/.test(String(e.message || e)));
}
// HTTP 层的出口风控:Google 对机房 IP 常回 429 + reCAPTCHA 页、403、或 302→/sorry/。
// 这些和 1060 是同一类问题(出口 IP 不可信),换出口重试有意义。
class UpstreamHttpError extends Error {
  constructor(status, snippet) {
    const bot = /recaptcha|unusual traffic|sorry\/index|<!doctype html/i.test(snippet || "");
    super(`Gemini upstream HTTP ${status}${bot ? " (bot-check / reCAPTCHA page)" : ""}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.code = status;
    this.retryable = bot || [302, 303, 307, 308, 400, 403, 408, 429, 500, 502, 503, 504].includes(status);
  }
}
function isUpstreamHttpError(e) {
  return e instanceof UpstreamHttpError || (e && e.name === "UpstreamHttpError");
}
function isRetryableUpstream(e) {
  if (isBardError(e)) return e.retryable !== false;
  if (isUpstreamHttpError(e)) return e.retryable !== false;
  return false;
}
// 出口被限流时不要固定间隔猛敲:指数 + 抖动,重试之间换出口。
function retryDelayMs(cfg, attempt) {
  const base = Math.max(100, (cfg.retry_delay_sec || 1) * 1000);
  const capped = Math.min(2500, base * Math.pow(2, Math.min(attempt, 2)));
  return Math.round(capped * (0.6 + Math.random() * 0.8));
}
// 第 0/1 次用配置的默认传输,之后交替 fetch / 裸 socket(出口池不同)
function useSocket(cfg, attempt) {
  const base = !!cfg.upstream_socket;
  if (!cfg.alt_transport || attempt < 2) return base;
  return attempt % 2 === 0 ? !base : base;
}
// Gemini returns HTTP 200 with a natural-language "image creation isn't
// available in your location" message when the egress country is unsuitable.
// Treat that as a retryable upstream error so berrRetry() rotates DO region.
const IMAGE_REGION_RE = /can(?:'|’)?t create (?:it|any).{0,180}(?:signed out|image creation|location)|image creation isn(?:'|’)?t available|image creation may not be available/i;
function checkBardError(raw) {
  const m = /BardErrorInfo[^0-9]{0,20}(\d{3,5})/.exec(raw);
  if (m) throw new BardError(m[1]);
}
function extractResponseText(raw, cfg) {
  checkBardError(raw);
  let lastText = "";
  let meta = null;
  const images = [];
  for (const line of raw.split("\n")) {
    const parsed = extractPartsFromLine(line);
    if (parsed.meta) meta = parsed.meta;
    for (const t of parsed.texts) {
      if (t.length > lastText.length) lastText = t;
    }
    for (const im of parsed.images) {
      if (!images.some((x) => x.url === im.url)) images.push(im);
    }
  }
  // 回传给路由层,由它落库(下一轮拿它做续聊)。
  if (cfg && meta) { cfg._session_meta = meta; cfg._metaFresh = true; }
  return withImages(cleanText(lastText), images, cfg);
}
/** 非流式生成(带重试)。返回最终的响应文本。 */
async function generate(cfg, prompt, modelId, thinkMode, extra, fileRefs) {
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs || null, extra, cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      applyEgressAttempt(cfg, attempt);
      await applyFingerprintJitter(cfg);
      if (cfg.client_ip) log(cfg, `client_ip=${cfg.client_ip} model generate request`);
      let resp = await httpFetch(getUrl(cfg), {
        method: "POST",
        headers,
        body,
        timeoutMs: cfg.request_timeout_sec * 1000,
        socket: useSocket(cfg, attempt),
        cfg,
      });
      if (resp.status === 405 && (await updateBlIfNeeded(cfg))) {
        log(cfg, "Retrying with updated BL...");
        resp = await httpFetch(getUrl(cfg), {
          method: "POST",
          headers,
          body,
          timeoutMs: cfg.request_timeout_sec * 1000,
          socket: useSocket(cfg, attempt),
          cfg,
        });
      }
      const raw = await resp.text();
      if (IMAGE_REGION_RE.test(raw)) {
        throw new UpstreamHttpError(502, raw.slice(0, 400));
      }
      const text = extractResponseText(raw, cfg);
      // 非 2xx / 机器人校验页:一律当成「出口不可信」,交给上层换出口重试
      if (!resp.ok) throw new UpstreamHttpError(resp.status, raw.slice(0, 400));
      if (!text) {
        if (/recaptcha|sorry\/index|unusual traffic|<!doctype html/i.test(raw)) {
          throw new UpstreamHttpError(resp.status, raw.slice(0, 400));
        }
        log(cfg, `upstream status=${resp.status} rawLen=${raw.length} parsedLen=0 snippet=${JSON.stringify(raw.slice(0, 200))}`);
      }
      markEgressGood(cfg);
      return text;
    } catch (e) {
      lastErr = e;
      // 1060 / 429 这类出口问题不在本函数里死磕:立刻上抛,由 berrRetry 换出口。
      // 同时把这个出口标记为冷却,避免下一轮又轮到它。
      if (isRetryableUpstream(e)) { markEgressBad(cfg); throw e; }
      if (attempt < cfg.retry_attempts - 1) {
        log(cfg, `Retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        await sleep(retryDelayMs(cfg, attempt));
      }
    }
  }
  throw lastErr;
}
/**
 * 流式生成。每步 yield 一段文本增量(本次新追加的后缀)。
 * 只在尚未 yield 过任何内容时才重试,以避免重复输出。
 */
async function* generateStream(cfg, prompt, modelId, thinkMode, extra, fileRefs) {
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs || null, extra, cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  let yielded = false;
  let emittedRawText = ""; // 跨重试追踪已输出的原始文本,保证重试前缀一致
  let loggedStart = false;
  const logStart = () => {
    if (!loggedStart && cfg.client_ip) {
      loggedStart = true;
      log(cfg, `client_ip=${cfg.client_ip} model stream request`);
    }
  };
  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      applyEgressAttempt(cfg, attempt);
      await applyFingerprintJitter(cfg);
      let resp = await httpFetch(getUrl(cfg), {
        method: "POST",
        headers,
        body,
        timeoutMs: cfg.request_timeout_sec * 1000,
        socket: useSocket(cfg, attempt),
        cfg,
      });
      logStart();
      if (resp.status === 405 && (await updateBlIfNeeded(cfg))) {
        // BL 过期:更新后回退非流式拿完整文本
        log(cfg, "BL updated on 405, falling back to non-streaming for this request");
        const text = await generate(cfg, prompt, modelId, thinkMode, extra, fileRefs);
        if (text) {
          yielded = true;
          yield text;
        }
        return;
      }
      if (!resp.ok) {
        const rawErr = await resp.text();
        throw new UpstreamHttpError(resp.status, rawErr.slice(0, 400));
      }
      if (!resp.body) {
        const text = extractResponseText(await resp.text(), cfg);
        if (text) {
          yielded = true;
          yield text;
        }
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let prev = "";
      let started = false; // 是否已 yield 过非空内容(用于裁掉开头的空白)
      const emittedImages = new Set();
      const consumeLine = function* (line) {
        const parsed = extractPartsFromLine(line);
        if (parsed.meta) { cfg._session_meta = parsed.meta; cfg._metaFresh = true; }
        for (const im of parsed.images) {
          if (emittedImages.has(im.url)) continue;
          emittedImages.add(im.url);
          const md = `![${im.name || "generated image"}](${imageProxyUrl(cfg, im.url)})`;
          yield started ? `\n\n${md}` : md;
          started = true;
        }
        for (const t of parsed.texts) {
          // 跨重试一致性:若与已输出文本不构成前缀关系,说明重试换了内容,直接报错。
          if (t === emittedRawText || emittedRawText.startsWith(t)) continue;
          if (!t.startsWith(emittedRawText)) throw new Error("Gemini stream content changed during retry");
          if (t.length > prev.length) {
            // 每段增量:去掉残留标记,但流式过程中不裁剪内部空白,
            // 以保留分块之间的空格(比如 "1, 2, 3" 而不是 "1, 2,3")。
            // 在首个可见内容出现前,持续裁掉前导空白(避免开头空行)。
            let delta = stripArtifacts(t.slice(prev.length));
            prev = t;
            emittedRawText = t;
            if (!started) delta = delta.replace(/^\s+/, "");
            if (delta) {
              started = true;
              yield delta;
            }
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (!yielded && IMAGE_REGION_RE.test(buf)) {
          throw new UpstreamHttpError(502, buf.slice(-800));
        }
        if (buf.includes("BardErrorInfo")) checkBardError(buf);
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          for (const delta of consumeLine(line)) {
            yielded = true;
            yield delta;
          }
        }
      }
      buf += decoder.decode();
      if (buf) {
        for (const delta of consumeLine(buf)) {
          yielded = true;
          yield delta;
        }
      }
      if (!yielded) log(cfg, `stream upstream produced no text (status=${resp.status})`);
      return;
    } catch (e) {
      lastErr = e;
      if (!yielded && attempt < cfg.retry_attempts - 1) {
        log(cfg, `Stream retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        if (isRetryableUpstream(e)) markEgressBad(cfg);
        await sleep(retryDelayMs(cfg, attempt));
        continue;
      }
      if (isRetryableUpstream(e)) markEgressBad(cfg);
      throw e;
    }
  }
  if (lastErr) throw lastErr;
}
// ─── 工具调用 / 消息转换 ─────────────────────────────────────────────────────
function buildToolChoiceInstruction(toolChoice) {
  if (toolChoice === "none") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (toolChoice === "required") return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  if (toolChoice && typeof toolChoice === "object") {
    const fn = (toolChoice.function || {}).name || "";
    if (fn) return `\n\nIMPORTANT: You MUST call the tool "${fn}". Do not call other tools.`;
  }
  return "";
}
// Gemini 网页端 payload 上限约 60KB;工具块超过一半时裁剪 parameters,
// 防止 100+ 工具的框架请求把用户消息静默截掉(上游 issue #74)。
const PROMPT_MAX_BYTES = 60000;
/** OpenAI messages -> [promptString, images]。 */
function messagesToPrompt(messages, tools, toolChoice) {
  const parts = [];
  const images = [];
  if (tools && toolChoice !== "none") {
    const toolDefs = [];
    for (const tool of tools) {
      const fn = tool.type === "function" ? (tool.function || tool) : tool;
      toolDefs.push({
        name: fn.name != null ? fn.name : (tool.name || ""),
        description: fn.description != null ? fn.description : (tool.description || ""),
        parameters: fn.parameters != null ? fn.parameters : (tool.parameters || {}),
      });
    }
    if (toolDefs.length) {
      let toolsJson = JSON.stringify(toolDefs, null, 2);
      if (toolsJson.length > PROMPT_MAX_BYTES / 2) {
        const slim = toolDefs.map((t) => ({ name: t.name, description: t.description }));
        toolsJson = JSON.stringify(slim, null, 2);
      }
      const constraint = buildToolChoiceInstruction(toolChoice);
      parts.push(
        "# Tool Use\n\n" +
          "You can call the following tools. Call format:\n" +
          '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
          "When calling tools, output ONLY the tool_call block(s).\n\n" +
          `Available tools:\n${toolsJson}` +
          constraint
      );
    }
  }
  for (const p of renderMessageParts(messages, images)) parts.push(p);
  return [parts.filter((p) => p).join("\n\n"), images];
}
/** 逐条消息渲染成 prompt 片段(不含工具前言)。会话续聊要靠它单独渲染增量。 */
function renderMessageParts(messages, images) {
  const parts = [];
  for (const msg of messages) {
    const role = msg.role || "user";
    let content = msg.content != null ? msg.content : "";
    if (Array.isArray(content)) {
      const textParts = [];
      for (const c of content) {
        const t = c && c.type;
        if (t === "text" || t === "input_text") {
          textParts.push(c.text || "");
        } else {
          const img = imageFromPart(c);
          if (img) {
            if (images) images.push(img);
            textParts.push("[Image attached]");
          }
        }
      }
      content = textParts.join(" ");
    }
    if (role === "system") {
      parts.push(`[System instruction]: ${content}`);
    } else if (role === "assistant") {
      if (msg.tool_calls) {
        const tcStrs = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return '```tool_call\n{"name": "' + fn.name + '", "arguments": ' + (fn.arguments || "{}") + "}\n```";
        });
        parts.push(`[Assistant]: ${content || ""}\n` + tcStrs.join("\n"));
      } else {
        parts.push(`[Assistant]: ${content}`);
      }
    } else if (role === "tool") {
      parts.push(`[Tool result for ${msg.name || ""}]: ${content}`);
    } else {
      parts.push(content ? content : "");
    }
  }
  return parts;
}
/** 提取 ```tool_call``` 代码块 -> [cleanText, toolCalls]。 */
function parseToolCalls(text) {
  const toolCalls = [];
  const re = /```tool_call\s*\n([\s\S]*?)\n```/g;
  const cleanParts = [];
  let lastEnd = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    cleanParts.push(text.slice(lastEnd, m.index));
    lastEnd = m.index + m[0].length;
    try {
      const data = JSON.parse(m[1].trim());
      if (data.name === undefined) throw new Error("no name");
      toolCalls.push({
        id: `call_${randHex(8)}`,
        type: "function",
        function: {
          name: data.name,
          arguments: JSON.stringify(data.arguments != null ? data.arguments : {}),
        },
      });
    } catch (_) { /* 跳过格式错误的块 */ }
  }
  cleanParts.push(text.slice(lastEnd));
  return [cleanParts.join("").trim(), toolCalls];
}
// ─── Google 原生 API 辅助函数 ────────────────────────────────────────────────
function buildToolPrompt(toolDefs) {
  const spec = JSON.stringify(toolDefs, null, 2);
  return (
    "# Tool Use\n\n" +
    "You can call the following tools to help accomplish tasks. " +
    "These tools connect to the user's local environment and will execute when called.\n\n" +
    "Call format (use this exact format):\n" +
    "```function_call\n" +
    '{"name": "<tool_name>", "args": {<arguments>}}\n' +
    "```\n\n" +
    "When calling tools:\n" +
    "- Output ONLY the function_call block(s), nothing else\n" +
    "- You may call multiple tools with multiple blocks\n" +
    "- After receiving a [Tool result for ...], use that data to answer the user\n\n" +
    `Available tools:\n${spec}`
  );
}
function googleToolChoiceInstruction(req) {
  const fc = (req.toolConfig || {}).functionCallingConfig || {};
  const mode = fc.mode || "AUTO";
  const allowed = fc.allowedFunctionNames || [];
  if (mode === "NONE") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (mode === "ANY") {
    if (allowed.length) {
      const names = allowed.map((n) => `"${n}"`).join(", ");
      return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
    }
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  return "";
}
/** Google 的 contents/tools/systemInstruction -> [promptString, images]。 */
function googleContentsToPrompt(req) {
  const parts = [];
  const images = [];
  const fcMode = ((req.toolConfig || {}).functionCallingConfig || {}).mode || "AUTO";
  const tools = req.tools;
  const toolDefs = [];
  if (tools && fcMode !== "NONE") {
    for (const group of tools) {
      for (const fn of group.functionDeclarations || []) {
        const td = { name: fn.name || "", description: fn.description || "" };
        const params = fn.parameters || fn.parametersJsonSchema;
        if (params) td.parameters = params;
        toolDefs.push(td);
      }
    }
  }
  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysText = (sysInst.parts || []).filter((p) => p.text).map((p) => p.text).join(" ");
    if (sysText) {
      if (toolDefs.length) {
        parts.push(sysText + "\n\n" + buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length) {
    parts.push(buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
  }
  for (const content of req.contents || []) {
    const role = content.role || "user";
    const msgParts = [];
    for (const p of content.parts || []) {
      if (p.text) {
        msgParts.push(p.text);
      } else if (p.inlineData) {
        try {
          const raw = String(p.inlineData.data || "");
          const bytes = base64ToBytes(raw);
          const mime = detectImageMime(bytes, normalizeMimeType(p.inlineData.mimeType, "image/png"));
          images.push({ b64: raw, mime });
          msgParts.push("[Image attached]");
        } catch (_) { /* ignore malformed inlineData */ }
      } else if (p.fileData) {
        const uri = p.fileData.fileUri || p.fileData.file_uri;
        if (uri) {
          images.push({ url: String(uri), mime: normalizeMimeType(p.fileData.mimeType, "") });
          msgParts.push("[Image attached]");
        }
      } else if (p.functionCall) {
        const fc = p.functionCall;
        msgParts.push("```function_call\n" + JSON.stringify({ name: fc.name, args: fc.args || {} }) + "\n```");
      } else if (p.functionResponse) {
        const fr = p.functionResponse;
        msgParts.push(`[Tool result for ${fr.name || ""}]: ${JSON.stringify(fr.response || {})}`);
      }
    }
    const text = msgParts.join("\n");
    if (role === "model") parts.push(`[Assistant]: ${text}`);
    else parts.push(text);
  }
  return [parts.filter((p) => p).join("\n\n"), images];
}
/** 提取 ```function_call``` 代码块(3 种格式)-> [cleanText, functionCalls]。 */
function parseGoogleFunctionCalls(text) {
  const functionCalls = [];
  const patterns = [
    /```function_call\s*\n([\s\S]*?)\n```/g,
    /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g,
  ];
  let clean = text;
  for (const pat of patterns) {
    for (const m of clean.matchAll(new RegExp(pat.source, pat.flags))) {
      try {
        const data = JSON.parse(m[1].trim());
        if (data && "name" in data) {
          functionCalls.push({ name: data.name, args: data.args != null ? data.args : (data.arguments != null ? data.arguments : {}) });
        }
      } catch (_) { /* 跳过 */ }
    }
    clean = clean.replace(new RegExp(pat.source, pat.flags), "").trim();
  }
  if (!functionCalls.length && clean.trim().startsWith("{")) {
    try {
      const data = JSON.parse(clean.trim());
      if (data && "name" in data && ("args" in data || "arguments" in data)) {
        functionCalls.push({ name: data.name, args: data.args != null ? data.args : data.arguments });
        clean = "";
      }
    } catch (_) { /* skip */ }
  }
  return [clean, functionCalls];
}
// ─── HTTP 辅助函数 ──────────────────────────────────────────────────────────────
function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*" };
}
function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}
function uiResponse() {
  return new Response(UI_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}
// 从多种来源取调用方 key:Bearer / x-api-key / x-goog-api-key / ?key=
// (分别兼容 OpenAI 客户端、Anthropic 风格、Gemini CLI)。任一匹配即放行。
function authorized(request, url, cfg) {
  const keys = cfg.api_keys || [];
  if (!keys.length) return true;
  const h = request.headers;
  const auth = h.get("authorization") || "";
  const candidates = [
    auth.startsWith("Bearer ") ? auth.slice(7) : null,
    h.get("x-api-key"),
    h.get("x-goog-api-key"),
    url ? url.searchParams.get("key") : null,
  ];
  return candidates.some((k) => k && keys.includes(k));
}
/**
 * 构造一个 SSE 响应,响应体由 `producer(write)` 生成。
 * `write(str)` 会入队一个 UTF-8 分块。producer 结束后流会自动关闭。
 *
 * heartbeatMs > 0 时,生成期间会定期发一个 SSE 注释行(`: ping`)。长回答动辄
 * 几十秒,而不少客户端(典型是 Android 内置 OkHttp,默认读超时 10s)会在静默期
 * 判定连接已死,报 "unexpected end of stream"。心跳能让它们持续拿到数据、
 * 不断重置读超时;注释行以 `:` 开头,按 SSE 规范会被客户端忽略。
 */
function sseResponse(producer, extra, heartbeatMs) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let hb = null;
      let closed = false;
      const write = (s) => { if (!closed) controller.enqueue(encoder.encode(s)); };
      if (heartbeatMs > 0) {
        hb = setInterval(() => { try { write(": ping\n"); } catch (_) {} }, heartbeatMs);
      }
      try {
        await producer(write);
      } catch (e) {
        // 上游被风控/网络失败时,不要静默关流:发一个 OpenAI 风格的错误块,
        // 客户端(Codex/Cherry Studio 等)才能显示原因而不是「空回复」。
        try {
          write(`data: ${JSON.stringify({ error: { message: String((e && e.message) || e), type: "upstream_error", code: (e && e.code) || null } })}\n\n`);
          write("data: [DONE]\n\n");
        } catch (_) { /* ignore */ }
      } finally {
        if (hb) { clearInterval(hb); hb = null; }
        closed = true;
        try { controller.close(); } catch (_) {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders(),
      ...(extra || {}),
    },
  });
}
// ─── 处理函数 ──────────────────────────────────────────────────────────────────
// 上游返回为空时给客户端的可见提示(否则像 Cherry 这类客户端会“无返回”)。
// 线上常见原因:部署在 Cloudflare/无服务器平台时,出口 IP 被 Google 区别对待
// (本地能跑、线上空);其次是 GEMINI_BL 过期。用 `wrangler tail` 看上游状态。
const EMPTY_UPSTREAM_MSG =
  "⚠️ Upstream Gemini returned an empty response. " +
  "Cloudflare 出口 IP 被 Google 限流时常见(表现为 BardErrorInfo[1060] 或 HTTP 429+reCAPTCHA)。" +
  "可选处理:多配几个入口(ALT_EGRESS / gemini-router 多通道)换出口;确认 GEMINI_BL 与 cookie 是否过期;" +
  "用 `wrangler tail` 或 GET /debug 看上游真实状态码。";
/**
 * 把上游异常翻译成对调用方有用的报错。
 * 机器人校验类(302→google.com/sorry、reCAPTCHA)是**出口侧、且往往是间歇的**,
 * 直接抛原始状态码会让人以为是自己请求错了,所以这里说清原因与建议。
 */
function upstreamErrorMessage(e) {
  const s = String((e && e.message) || e);
  if (/bot-check|recaptcha|sorry\/index|unusual traffic/i.test(s)) {
    return "upstream error: " + s +
      " —— 该出口 IP 被 Google 判为异常流量(通常是间歇的,过一会儿或换个出口即可)。" +
      "可在 /admin/egress 看到每个出口的状态并手动测试/指定。";
  }
  if (isBardError(e)) {
    return "upstream error: " + s + "(Gemini 侧风控;可换出口重试)";
  }
  return "upstream error: " + s;
}
// POST /v1/chat/completions
async function handleChat(req, cfg, request) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);
  const tools = req.tools;
  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const [promptFull, imagesFull] = messagesToPrompt(messages, tools, toolChoice);

  // 会话:命中续聊时只把新增内容发上去(历史留在 Gemini 侧)
  const sctx = await prepareSession(cfg, request, req, messages, rm.modeId);
  const cont = sctx.plan.mode === "continue";
  // 把本轮会话状态回给调用方(前端要显示「这轮是续聊还是新开」)。走响应头而不是
  // body,免得污染 OpenAI 兼容格式;用 curl -i 也能直接看到。
  const turnHeaders = {
    "X-Gemini-Session": sctx.sid ? sctx.sid.slice(0, 12) : "",
    "X-Gemini-Session-Mode": `${sctx.plan.mode}:${sctx.plan.reason}`,
    "Access-Control-Expose-Headers": "X-Gemini-Session, X-Gemini-Session-Mode, X-Gemini-Cid, X-Gemini-Egress",
  };
  // Gemini 的会话 id(网页地址栏 /app/<cid> 里的那个)。只有生成完才知道新会话的 cid,
  // 所以非流式在最后补进响应头,流式用 SSE 注释回传。
  const cidHeaders = () => ({ "X-Gemini-Cid": (cfg._session_meta && cfg._session_meta[0]) || "" });
  const deltaImages = [];
  let promptBody = promptFull;
  let images = imagesFull;
  if (cont) {
    promptBody = renderSlice(messages, sctx.plan.startIndex, deltaImages);
    images = deltaImages;
  }
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);

  // 长期记忆:只在开新会话时注入(续聊时 Gemini 的上下文里已经有)
  let memNote = "";
  if (!cont && cfg.memory_enabled) {
    try {
      const blk = await memoryBlock(cfg, cfg._env, memoryScope(request, req));
      if (blk) memNote = blk + "\n\n";
    } catch (_) { /* 记忆读失败不影响主流程 */ }
  }
  const prompt = memNote + promptBody + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty prompt" } }, 400);
  const stream = req.stream || false;
  const cid = `chatcmpl-${randHex(12)}`;
  const finishTurn = async (ok, answer) => {
    try { await endTurn(cfg, sctx, ok, messages, rm.modeId); } catch (_) { /* ignore */ }
    if (ok && cfg.memory_auto_extract && cfg._ctx && cfg._env && cfg._env.DB) {
      const scope = memoryScope(request, req);
      const userText = firstUserText(messages);
      try { cfg._ctx.waitUntil(autoExtractMemory(cfg, cfg._env, scope, userText, answer)); } catch (_) { /* ignore */ }
    }
  };
  if (stream && (!tools || toolChoice === "none")) {
    return sseResponse(async (write) => {
      let got = false;
      let errMsg = "";
      let acc = "";
      const chunk = (delta, finish) => write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      chunk({ role: "assistant" }, null); // 严格 OpenAI SDK 兼容:首块带 role
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs)) {
          got = true;
          acc += delta;
          chunk({ content: delta }, null);
        }
      } catch (e) {
        errMsg = `⚠️ upstream error: ${upstreamErrorMessage(e)}`;
      } finally {
        if (!got) {
          const note = errMsg || EMPTY_UPSTREAM_MSG;
          log(cfg, `chat stream produced no content -> ${note}`);
          chunk({ content: note }, null); // 让客户端看到原因,而非空白
        }
        // 网页端拒绝出图时,用官方 API 补一张
        if (acc) {
          const imgUrl = await imageFallbackViaApi(cfg, cfg._env, promptBody || prompt, acc);
          if (imgUrl) chunk({ content: `\n\n![generated image](${imgUrl})` }, null);
        }
        await finishTurn(got, acc);
        chunk({}, "stop");
        // 流式响应头在开始时就固定了,新会话那时还没有 cid —— 用 SSE 注释回传。
        // OpenAI 客户端会忽略 ':' 开头的行,不影响兼容性。
        const cidOut = (cfg._session_meta && cfg._session_meta[0]) || "";
        if (cidOut) write(": gemini-cid=" + cidOut + "\n\n");
        write("data: [DONE]\n\n");
      }
    }, turnHeaders, cfg.sse_heartbeat_ms);
  }
  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
  } catch (e) {
    await finishTurn(false, "");
    return jsonResponse({ error: { message: upstreamErrorMessage(e) } }, 502);
  }
  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const [clean, tc] = parseToolCalls(text);
    text = clean;
    toolCalls = tc.length ? tc : null;
  }
  if (!text && !toolCalls) {
    log(cfg, "chat non-stream produced no content (empty upstream)");
    text = EMPTY_UPSTREAM_MSG; // 可见提示,避免客户端“无返回”
  }
  // 网页端拒绝出图时,用官方 API 补一张(客户端无需改动)
  if (text && !toolCalls) {
    const imgUrl = await imageFallbackViaApi(cfg, cfg._env, promptBody || prompt, text);
    if (imgUrl) text = `${text}\n\n![generated image](${imgUrl})`;
  }
  await finishTurn(true, text);
  const msg = { role: "assistant", content: text || null };
  if (toolCalls) msg.tool_calls = toolCalls;
  // 生成图片:正文里已经是 Markdown;再挂一份结构化 images[](兼容 Cherry Studio 之类的客户端)
  const genImages = extractMarkdownImageUrls(text);
  if (genImages.length) msg.images = genImages.map((u) => ({ type: "image_url", image_url: { url: u } }));
  const finish = toolCalls ? "tool_calls" : "stop";
  if (stream) {
    return sseResponse(async (write) => {
      write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        choices: [{ index: 0, delta: msg, finish_reason: finish }],
      })}\n\n`);
      write("data: [DONE]\n\n");
    }, turnHeaders, cfg.sse_heartbeat_ms);
  }
  return jsonResponse({
    id: cid, object: "chat.completion", created: nowSec(), model: rm.name,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: {
      prompt_tokens: tokenEst(prompt),
      completion_tokens: tokenEst(text),
      total_tokens: tokenEst(prompt) + tokenEst(text),
    },
  }, 200, { ...turnHeaders, ...cidHeaders() });
}
// 从请求头提取客户端 IP(Cloudflare 环境用 cf-connecting-ip)。
function clientIp(request) {
  if (!request || !request.headers) return "";
  return request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "";
}
// 每个 isolate 内的滑动窗口限流。Cloudflare 会在多个 isolate 间分担请求,
// 因此它是近似限流,不依赖 KV/D1,避免每个 API 调用都增加一次存储写入。
const RATE_LIMIT_STORE = new Map();
const IMG_RATE_STORE = new Map();
/** 通用滑动窗口计数。低频清理冷 key,防止 isolate 长生命周期内 Map 无限增长。 */
function slidingLimit(store, clientIP, max, windowMs) {
  const now = Date.now();
  const key = clientIP || "0.0.0.0";
  const hits = (store.get(key) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= Math.max(1, max)) return false;
  hits.push(now);
  store.set(key, hits);
  if (Math.random() < 0.05) {
    for (const [k, values] of store) {
      const valid = values.filter((ts) => now - ts < windowMs);
      if (valid.length) store.set(k, valid);
      else store.delete(k);
    }
  }
  return true;
}
function checkRateLimit(clientIP, cfg) {
  if (!cfg || !cfg.rate_limit_enabled) return true;
  return slidingLimit(RATE_LIMIT_STORE, clientIP, cfg.rate_limit_max, Math.max(1, cfg.rate_limit_window) * 1000);
}
/** /img 是公开端点(不带 API key),单独限流,防止被刷爆 R2 读次数。 */
function checkImgRate(clientIP, cfg) {
  return slidingLimit(IMG_RATE_STORE, clientIP, cfg.image_proxy_rate_max || 600, 60000);
}
// POST /v1/responses(Codex CLI 用)
async function handleResponses(req, cfg, request) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);
  const inputItems = req.input != null ? req.input : [];
  let tools = req.tools;
  const messages = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });
  if (typeof inputItems === "string") {
    messages.push({ role: "user", content: inputItems });
  } else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item && typeof item === "object") {
        if (item.type === "function_call_output") {
          messages.push({ role: "tool", tool_call_id: item.call_id || "", name: item.name || "", content: item.output || "" });
        } else if (["input_text", "input_image", "image"].includes(item.type)) {
          messages.push({ role: "user", content: [item] });
        } else if (item.role === "assistant" || (item.type === "message" && item.role === "assistant")) {
          const cp = item.content != null ? item.content : [];
          let textAcc = "";
          const tcList = [];
          if (Array.isArray(cp)) {
            for (const c of cp) {
              if (c && typeof c === "object") {
                if (c.type === "output_text") textAcc += c.text || "";
                else if (c.type === "function_call") tcList.push(c);
              }
            }
          } else if (typeof cp === "string") {
            textAcc = cp;
          }
          const m = { role: "assistant", content: textAcc || null };
          if (tcList.length) {
            m.tool_calls = tcList.map((tc, i) => ({
              id: tc.call_id || `call_${i}`, type: "function",
              function: { name: tc.name || "", arguments: tc.arguments || "{}" },
            }));
          }
          messages.push(m);
        } else {
          const role = item.role || "user";
          let content = item.content != null ? item.content : "";
          if (Array.isArray(content)) {
            content = content.filter((c) => c.type === "text" || c.type === "input_text").map((c) => c.text || "").join(" ");
          }
          messages.push({ role, content });
        }
      }
    }
  }
  if (tools) {
    tools = tools.map((t) =>
      t.type === "function" && !("function" in t)
        ? { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } }
        : t
    );
  }
  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const [promptFull, imagesFull] = messagesToPrompt(messages, tools, toolChoice);

  // 与 /v1/chat/completions 同一套会话/记忆逻辑
  const sctx = await prepareSession(cfg, request, req, messages, rm.modeId);
  const cont = sctx.plan.mode === "continue";
  // 把本轮会话状态回给调用方(前端要显示「这轮是续聊还是新开」)。走响应头而不是
  // body,免得污染 OpenAI 兼容格式;用 curl -i 也能直接看到。
  const turnHeaders = {
    "X-Gemini-Session": sctx.sid ? sctx.sid.slice(0, 12) : "",
    "X-Gemini-Session-Mode": `${sctx.plan.mode}:${sctx.plan.reason}`,
    "Access-Control-Expose-Headers": "X-Gemini-Session, X-Gemini-Session-Mode, X-Gemini-Cid, X-Gemini-Egress",
  };
  // Gemini 的会话 id(网页地址栏 /app/<cid> 里的那个)。只有生成完才知道新会话的 cid,
  // 所以非流式在最后补进响应头,流式用 SSE 注释回传。
  const cidHeaders = () => ({ "X-Gemini-Cid": (cfg._session_meta && cfg._session_meta[0]) || "" });
  const deltaImages = [];
  let promptBody = promptFull;
  let images = imagesFull;
  if (cont) {
    promptBody = renderSlice(messages, sctx.plan.startIndex, deltaImages);
    images = deltaImages;
  }
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  let memNote = "";
  if (!cont && cfg.memory_enabled) {
    try {
      const blk = await memoryBlock(cfg, cfg._env, memoryScope(request, req));
      if (blk) memNote = blk + "\n\n";
    } catch (_) { /* ignore */ }
  }
  const prompt = memNote + promptBody + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty input" } }, 400);
  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
  } catch (e) {
    try { await endTurn(cfg, sctx, false, messages, rm.modeId); } catch (_) { /* ignore */ }
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }
  try { await endTurn(cfg, sctx, true, messages, rm.modeId); } catch (_) { /* ignore */ }
  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const [clean, tc] = parseToolCalls(text);
    text = clean;
    toolCalls = tc.length ? tc : null;
  }
  const rid = `resp_${randHex(16)}`;
  const mid = `msg_${randHex(12)}`;
  const output = [];
  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
    }
  }
  if (text || !toolCalls) {
    output.push({ type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text: text || "", annotations: [] }] });
  }
  const usage = { input_tokens: tokenEst(prompt), output_tokens: tokenEst(text), total_tokens: tokenEst(prompt) + tokenEst(text) };
  if (req.stream) {
    return sseResponse(async (write) => {
      // 完整 OpenAI Responses 事件序列(对齐上游,兼容 Codex CLI 等严格客户端)
      let seq = 0;
      const emit = (type, fields) =>
        write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++seq, ...fields })}\n\n`);
      const baseResponse = { id: rid, object: "response", created_at: nowSec(), model: rm.name };
      emit("response.created", { response: { ...baseResponse, status: "in_progress", output: [], usage: null } });
      emit("response.in_progress", { response: { ...baseResponse, status: "in_progress", output: [], usage: null } });
      output.forEach((item, outputIndex) => {
        if (item.type === "function_call") {
          emit("response.output_item.added", { output_index: outputIndex, item: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name, arguments: "", status: "in_progress" } });
          emit("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: item.arguments });
          emit("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: item.arguments });
          emit("response.output_item.done", { output_index: outputIndex, item });
        } else if (item.type === "message") {
          emit("response.output_item.added", { output_index: outputIndex, item: { type: "message", id: item.id, role: "assistant", status: "in_progress", content: [] } });
          item.content.forEach((cp, ci) => {
            const ef = { item_id: item.id, output_index: outputIndex, content_index: ci };
            emit("response.content_part.added", { ...ef, part: { type: "output_text", text: "", annotations: [] } });
            emit("response.output_text.delta", { ...ef, delta: cp.text });
            emit("response.output_text.done", { ...ef, text: cp.text });
            emit("response.content_part.done", { ...ef, part: cp });
          });
          emit("response.output_item.done", { output_index: outputIndex, item });
        }
      });
      emit("response.completed", { response: { ...baseResponse, status: "completed", output, usage } });
    }, { ...turnHeaders, ...cidHeaders() }, cfg.sse_heartbeat_ms);
  }
  return jsonResponse({ id: rid, object: "response", created_at: nowSec(), status: "completed", model: rm.name, output, usage }, 200, { ...turnHeaders, ...cidHeaders() });
}
// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
async function handleGoogleGenerate(req, cfg, path, stream, request) {
  const m = /\/v1beta\/models\/([^:?]+)/.exec(path);
  const rm = resolveModel(m ? m[1] : cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);
  const fcMode = ((req.toolConfig || {}).functionCallingConfig || {}).mode || "AUTO";
  const hasTools = !!req.tools && fcMode !== "NONE";
  const [prompt0, images] = googleContentsToPrompt(req);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty content" } }, 400);
  log(cfg, `Google API: model=${rm.name} stream=${stream} tools=${hasTools} prompt_len=${prompt.length}`);
  if (stream && !hasTools) {
    return sseResponse(async (write) => {
      let fullText = "";
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs)) {
          if (!delta) continue;
          fullText += delta;
          write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: delta }], role: "model" }, index: 0 }], modelVersion: rm.name })}\n\n`);
        }
      } finally {
        write(`data: ${JSON.stringify({
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: tokenEst(prompt), candidatesTokenCount: tokenEst(fullText), totalTokenCount: tokenEst(prompt) + tokenEst(fullText) },
          modelVersion: rm.name,
        })}\n\n`);
      }
    }, null, cfg.sse_heartbeat_ms);
  }
  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }
  if (!text) log(cfg, "Warning: empty response from Gemini");
  const responseParts = [];
  if (hasTools && text) {
    const [clean, fcs] = parseGoogleFunctionCalls(text);
    if (fcs.length) {
      if (clean) responseParts.push({ text: clean });
      for (const fc of fcs) responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
    } else {
      responseParts.push({ text });
    }
  } else {
    responseParts.push({ text: text || "I apologize, but I was unable to generate a response. Please try again." });
  }
  const responseObj = {
    candidates: [{ content: { parts: responseParts, role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: tokenEst(prompt), candidatesTokenCount: tokenEst(text), totalTokenCount: tokenEst(prompt) + tokenEst(text) },
    modelVersion: rm.name,
  };
  if (stream) {
    return sseResponse(async (write) => { write(`data: ${JSON.stringify(responseObj)}\n\n`); }, null, cfg.sse_heartbeat_ms);
  }
  return jsonResponse(responseObj);
}
// GET /debug — 排查上游为何为空。从【当前部署环境】实地探测,回显原始状态/片段。
// 探针 A:裸请求(现行做法);探针 B:先抓访客 cookie + at token 再请求。
// 对比两者即可判断:是 IP 被拦(都空)、还是缺会话(B 能通 → 可自动修)。
async function handleDebug(cfg, request) {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  async function probe(guest) {
    try {
      let cookie = cfg.cookie || "";
      let at = "";
      let bl = cfg.gemini_bl;
      let pageStatus = null;
      let setCookieCount = 0;
      if (guest && !cookie) {
        const pr = await httpFetch(`${cfg.gemini_origin}/app`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, timeoutMs: 30000, socket: cfg.upstream_socket });
        pageStatus = pr.status;
        const sc = pr.headers.getSetCookie ? pr.headers.getSetCookie() : [];
        setCookieCount = sc.length;
        cookie = sc.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
        const html = await pr.text();
        at = (/"SNlM0e":"([^"]+)"/.exec(html) || [])[1] || "";
        const blm = /"cfb2h":"([^"]+)"/.exec(html);
        if (blm) bl = blm[1];
      }
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://gemini.google.com",
        "Referer": "https://gemini.google.com/app",
        "X-Same-Domain": "1",
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
      };
      if (cookie) headers["Cookie"] = cookie;
      if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
      let body = buildPayload("Reply with one word: PONG", 1, 4, null, null);
      if (at) body += "&at=" + encodeURIComponent(at);
      const resp = await httpFetch(getUrl({ gemini_bl: bl, gemini_origin: cfg.gemini_origin }), { method: "POST", headers, body, timeoutMs: 60000, socket: cfg.upstream_socket });
      const raw = await resp.text();
      return {
        status: resp.status,
        contentType: resp.headers.get("content-type"),
        rawLength: raw.length,
        parsed: extractResponseText(raw).slice(0, 160),
        rawSnippet: raw.slice(0, 500),
        usedCookie: !!cookie,
        usedAt: !!at,
        blUsed: bl,
        pageStatus,
        setCookieCount,
      };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }
  return jsonResponse({
    note: "上游已改用 socket(cloudflare:sockets)优先、fetch 兜底。socket.available=false 表示运行时没有该模块、退回 fetch。A=bare, B=guest. 若 status 仍是 429,说明 socket 出口同样被 Google 限流 -> 用 GEMINI_ORIGIN 中转或换非数据中心 IP。",
    bl: cfg.gemini_bl,
    geminiOrigin: cfg.gemini_origin,
    hasCookie: !!cfg.cookie,
    socket: { configEnabled: cfg.upstream_socket, available: !!(await resolveConnect()) },
    A_bare: await probe(false),
    B_guest: await probe(true),
  });
}
// ─── 运行时状态(KV)─────────────────────────────────────────────────────────
// 把会「过期」的东西放到 KV,不用重新部署就能更新:
//   cookie(Gemini 登录态,__Secure-1PSIDTS 会滚动) / bl(前端构建号) / xsrf(SNlM0e)
// 优先级:KV > 环境变量。可用 POST /admin/cookie 覆盖或清除。
const STATE_KEY = "state:cfg";
let _stateCache = { data: null, ts: 0 };
async function readState(env, force) {
  if (!env || !env.STATE) return null;
  const now = Date.now();
  if (!force && _stateCache.data && now - _stateCache.ts < 30000) return _stateCache.data;
  try {
    const data = await env.STATE.get(STATE_KEY, { type: "json" });
    _stateCache = { data: data || {}, ts: now };
    return _stateCache.data;
  } catch (_) {
    return _stateCache.data || null;
  }
}
async function saveState(env, patch) {
  if (!env || !env.STATE) return false;
  const cur = (await readState(env, true)) || {};
  const next = { ...cur, ...patch };
  try {
    await env.STATE.put(STATE_KEY, JSON.stringify(next));
    _stateCache = { data: next, ts: Date.now() };
    return true;
  } catch (_) {
    return false;
  }
}
// 用 KV 里的最新会话状态覆盖 cfg(KV 为准,便于热更新 cookie)
async function hydrateState(cfg, env) {
  const st = await readState(env);
  if (!st) return cfg;
  if (st.cookie && (!cfg.cookie_pool || cfg.cookie_pool.length <= 1) && st.cookie !== cfg.cookie) {
    cfg.cookie = st.cookie;
    cfg._cookieSource = "kv";
    const m = /(?:^|;\s*)SAPISID=([^;]+)/.exec(st.cookie);
    cfg.sapisid = st.sapisid || (m ? m[1] : cfg.sapisid);
  }
  if (st.bl) cfg.gemini_bl = st.bl;
  if (st.xsrf) cfg.xsrf_token = st.xsrf;
  if (st.fsid) cfg.gemini_fsid = String(st.fsid);
  cfg._state = st;
  return cfg;
}
function extractSapisid(cookie) {
  const m = /(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie || "");
  return m ? m[1] : "";
}
// 把 Set-Cookie 里的键值合并进现有 cookie 串(覆盖同名键)
function mergeSetCookies(cookieStr, setCookies) {
  const map = new Map();
  for (const part of String(cookieStr || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const sc of setCookies || []) {
    const first = String(sc).split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function shortHash(text, hexLen) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, hexLen || 12);
}
// 拉一次 /app 页面:既校验会话是否还活着,又顺手把滚动的
// __Secure-1PSIDTS / SNlM0e / bl 抓回来(这是 cookie 能长期不掉的关键)。
async function refreshSession(cfg, origin) {
  const base = (origin || cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
  const fp = pickFingerprint();
  const headers = {
    "User-Agent": fp.ua,
    "Accept-Language": fp.lang,
    "sec-ch-ua": fp.chUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": fp.platform,
  };
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  const r = await httpFetch(`${base}${accountPrefix(cfg)}/app`, { headers, timeoutMs: 25000, socket: cfg.upstream_socket, redirect: "manual", cfg });
  const location = r.headers.get("location") || "";
  const setCookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  let html = "";
  try { html = await r.text(); } catch (_) { /* 3xx 无正文 */ }
  const xsrf = (/"SNlM0e":"([^"]+)"/.exec(html) || [])[1] || "";
  const bl = (/"cfb2h":"([^"]+)"/.exec(html) || [])[1] || "";
  const cookie = mergeSetCookies(cfg.cookie || "", setCookies);
  // Google 对机房 IP 的 HTML 页面会插「unusual traffic」拦截(/sorry/ 或
  // accounts.google.com 跳转),这是 IP 层的,不是 cookie 失效。
  const blocked = /\/sorry\/|accounts\.google\.com|consent\.google\.com/.test(location) || /unusual traffic|system detected/i.test(html);
  return {
    status: r.status,
    alive: !!xsrf,
    blocked,
    location: location.slice(0, 120),
    setCookieCount: setCookies.length,
    setCookieNames: setCookies.map((c) => String(c).split("=")[0]),
    rotated: cookie !== (cfg.cookie || ""),
    cookie, xsrf, bl,
  };
}
// ════════════════════════════════════════════════════════════════════════════
//  会话记忆(服务端续聊)+ 长期记忆 + 生成图片中转
//
//  设计要点:
//   · 会话:把 [cid, rid, rcid] 存进 D1,下一轮塞回 inner[2],只发增量。
//     客户端仍然可以整段历史照发 —— 我们用 [渲染指纹 + 条数] 校验前缀,
//     对得上就只把「新增的那几条」发上去,对不上就当新会话(不会串话)。
//   · 记忆:跨会话的事实,存 D1,开新会话时注入 prompt;续聊不重复注入
//     (Gemini 侧上下文里已经有了)。
//   · 图片:上游直链改写成 <PUBLIC_ORIGIN>/img/<key>,自己回源 + 缓存。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 128 位同步哈希。必须是同步的 —— 图片 URL 重写发生在拼装文本的同步路径里,
 * 而 crypto.subtle.digest 是异步的。仅用于指纹 / 缓存键,不做安全用途。
 */
function syncHash(str) {
  const s = String(str == null ? "" : str);
  let a = 0x811c9dc5, b = 0x1000193, c = 0xcbf29ce4, d = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const lo = ch & 0xff, hi = ch >>> 8;
    a = Math.imul(a ^ lo, 0x01000193) >>> 0;
    b = Math.imul(b ^ hi, 0x01000193) >>> 0;
    c = (c + Math.imul(lo + i, 0x27d4eb2f)) >>> 0;
    d = (d ^ Math.imul(hi + i + 1, 0x165667b1)) >>> 0;
  }
  const hx = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return hx(a) + hx(b) + hx(c) + hx(d);
}
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 ? "=".repeat(4 - (t.length % 4)) : "";
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(out);
}

// ── D1 schema ───────────────────────────────────────────────────────────────
// 会话/记忆优先落 D1(免费额度 10 万行写/天);没绑 D1 时会话退回 KV(只有
// 1000 写/天,够单机自用,记忆则整体关闭)。
const DDL = [
  "CREATE TABLE IF NOT EXISTS chat_sessions (sid TEXT PRIMARY KEY, cid TEXT NOT NULL, rid TEXT NOT NULL, " +
    "rcid TEXT, model TEXT, nmsgs INTEGER DEFAULT 0, phash TEXT, delta_mode INTEGER DEFAULT 0, " +
    "turns INTEGER DEFAULT 0, created_ts INTEGER, updated_ts INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_ts)",
  "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL, " +
    "source TEXT, created_ts INTEGER, updated_ts INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, updated_ts)",
  "CREATE TABLE IF NOT EXISTS img_map (hash TEXT PRIMARY KEY, url TEXT NOT NULL, ts INTEGER)",
  "CREATE TABLE IF NOT EXISTS img_budget (k TEXT PRIMARY KEY, v INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS egress_stats (id TEXT PRIMARY KEY, kind TEXT, target TEXT, label TEXT, " +
    "text_status TEXT, image_status TEXT, latency_ms INTEGER, runs INTEGER DEFAULT 0, ok_runs INTEGER DEFAULT 0, " +
    "image_ok_runs INTEGER DEFAULT 0, fails INTEGER DEFAULT 0, score REAL DEFAULT 0, detail TEXT, updated_ts INTEGER)",
  // 出口池存 D1 而不是 KV:KV 是最终一致的,写完立刻读会读不到,前端会以为没保存上。
  "CREATE TABLE IF NOT EXISTS egress_pool (id TEXT PRIMARY KEY, kind TEXT, target TEXT, label TEXT, ord INTEGER)",
  "CREATE TABLE IF NOT EXISTS egress_settings (k TEXT PRIMARY KEY, v TEXT)",
];
let _schemaReady = false;
let _schemaPromise = null;
/** 幂等建表(每个 isolate 只做一次)。 */
async function ensureSchema(env) {
  if (!env || !env.DB) return false;
  if (_schemaReady) return true;
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      for (const stmt of DDL) {
        try { await env.DB.prepare(stmt).run(); } catch (_) { /* 已存在 / 并发建表 */ }
      }
      _schemaReady = true;
      return true;
    })().catch(() => { _schemaPromise = null; return false; });
  }
  return _schemaPromise;
}

// ── 会话读写 ───────────────────────────────────────────────────────────────
async function sessionGet(env, sid) {
  if (!env || !sid) return null;
  if (env.DB) {
    try {
      await ensureSchema(env);
      const row = await env.DB.prepare("SELECT * FROM chat_sessions WHERE sid = ?1").bind(sid).first();
      if (row) return row;
    } catch (_) { /* 退回 KV */ }
  }
  if (env.STATE) {
    try { return (await env.STATE.get("sess:" + sid, "json")) || null; } catch (_) { /* ignore */ }
  }
  return null;
}
const SESSION_UPSERT =
  "INSERT INTO chat_sessions (sid, cid, rid, rcid, model, nmsgs, phash, delta_mode, turns, created_ts, updated_ts) " +
  "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) " +
  "ON CONFLICT(sid) DO UPDATE SET cid=excluded.cid, rid=excluded.rid, rcid=excluded.rcid, " +
  "model=excluded.model, nmsgs=excluded.nmsgs, phash=excluded.phash, delta_mode=excluded.delta_mode, " +
  "turns=excluded.turns, updated_ts=excluded.updated_ts";
async function sessionPut(env, sid, row, ttlSec) {
  if (!env || !sid || !row) return false;
  if (env.DB) {
    try {
      await ensureSchema(env);
      await env.DB.prepare(SESSION_UPSERT).bind(
        sid, String(row.cid), String(row.rid), row.rcid ? String(row.rcid) : null,
        row.model != null ? String(row.model) : null, row.nmsgs | 0, row.phash || "",
        row.delta_mode ? 1 : 0, row.turns | 0, row.created_ts || Date.now(), Date.now()
      ).run();
      return true;
    } catch (e) { log({ log_requests: true }, `会话写入 D1 失败: ${e}`); }
  }
  if (env.STATE) {
    try {
      await env.STATE.put("sess:" + sid, JSON.stringify(row), { expirationTtl: Math.max(60, ttlSec || 604800) });
      return true;
    } catch (_) { /* ignore */ }
  }
  return false;
}

// ── 会话键:显式 > user 字段 > 隐式(同一 key + 同一首条用户消息)──────────
function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role && m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string" && c.trim()) return c.trim();
    if (Array.isArray(c)) {
      const t = c.map((x) => (x && typeof x === "object" ? (x.text || x.input_text || "") : ""))
                 .filter(Boolean).join(" ").trim();
      if (t) return t;
    }
  }
  return "";
}
// Gemini 的会话 id(网页地址栏 /app/<cid> 里的那个),16 位十六进制。
const GEMINI_CID_RE = /^c_[0-9a-f]{8,}$/i;
/** 用 Gemini 会话 id 直接找会话 —— 客户端可以拿它当会话标识用。 */
async function sessionGetByCid(env, cid) {
  if (!env || !cid || !env.DB) return null;
  try {
    await ensureSchema(env);
    return await env.DB.prepare(
      "SELECT * FROM chat_sessions WHERE cid = ?1 ORDER BY updated_ts DESC LIMIT 1"
    ).bind(cid).first() || null;
  } catch (_) { return null; }
}
function sessionKey(cfg, request, req, messages) {
  let h = null;
  try { h = request && request.headers; } catch (_) { h = null; }
  const explicit = (value, source) => {
    const v = String(value || "").trim();
    if (!v) return null;
    // 直接给 Gemini 会话 id 时按 cid 找,这样「会话 = gemini.google.com/app/<cid>」是一一对应的
    if (GEMINI_CID_RE.test(v)) return { raw: "cid:" + v, explicit: true, source, cid: v };
    return { raw: "h:" + v, explicit: true, source };
  };
  const hdr = (h && (h.get("x-session-id") || h.get("x-conversation-id") || h.get("x-chat-id"))) || "";
  const fromHdr = explicit(hdr, "header");
  if (fromHdr) return fromHdr;
  for (const k of ["session_id", "conversation_id", "chat_id"]) {
    if (req && typeof req[k] === "string") {
      const got = explicit(req[k], k);
      if (got) return got;
    }
  }
  if (req && typeof req.user === "string" && req.user.trim()) {
    return { raw: "u:" + req.user.trim(), explicit: true, source: "user" };
  }
  const first = firstUserText(messages);
  if (!first) return { raw: "", explicit: false, source: "" };
  let auth = "";
  try {
    auth = String((h && (h.get("authorization") || h.get("x-api-key"))) || "");
  } catch (_) { auth = ""; }
  auth = auth.replace(/^Bearer\s+/i, "");
  return { raw: "i:" + syncHash(auth).slice(0, 12) + ":" + first.slice(0, 2000), explicit: false, source: "implicit" };
}
/** 客户端声明「只发增量」时必须显式给会话 id,否则无法校验。 */
function deltaModeRequested(cfg, request, req) {
  let v = "";
  try { v = (request && request.headers && request.headers.get("x-session-mode")) || ""; } catch (_) { v = ""; }
  if (!v && req && typeof req.session_mode === "string") v = req.session_mode;
  v = String(v || "").toLowerCase();
  if (v === "delta" || v === "incremental") return true;
  if (v === "full" || v === "history") return false;
  return !!cfg.session_delta_default;
}
/** 渲染一段消息数组 → prompt 字符串(不含工具前言),用于指纹与增量。 */
function renderSlice(messages, from, images) {
  return renderMessageParts(messages.slice(from), images).filter((p) => p).join("\n\n");
}
/**
 * 对「前 count 条消息」的渲染结果取指纹。续聊时用同一函数算客户端前缀,
 * 对得上才说明客户端发来的历史和我们上次发出去的是一致的。
 */
function messageHash(messages, count) {
  const list = Array.isArray(messages) ? messages : [];
  const n = Math.max(0, Math.min(count == null ? list.length : count, list.length));
  return syncHash(renderMessageParts(list.slice(0, n), null).filter((p) => p).join("\n\n"));
}

/**
 * 决定这一轮怎么发。
 *   mode="continue":只把 messages.slice(startIndex) 发上去,inner[2] 带会话 id
 *   mode="new"     :整段历史照发,开新会话
 */
function planTurn(cfg, sess, messages, modelId, deltaOK, trusted) {
  const out = { mode: "new", startIndex: 0, reason: "" };
  if (!sess || !sess.cid || !sess.rid) { out.reason = "no-session"; return out; }
  const ttlMs = Math.max(60, cfg.session_ttl_sec || 604800) * 1000;
  if (Date.now() - Number(sess.updated_ts || 0) > ttlMs) { out.reason = "expired"; return out; }
  if (sess.model && modelId != null && String(sess.model) !== String(modelId)) { out.reason = "model-changed"; return out; }
  // ① 本次请求显式声明「只发增量」:收到的整段就是增量,不用校验。
  //    必须在最前面判断 —— 此时 messages 里没有历史,前缀校验必然对不上。
  if (deltaOK) {
    out.mode = "continue";
    out.startIndex = 0;
    out.reason = "delta-mode";
    return out;
  }
  // ② 客户端照发整段历史:用 [条数 + 渲染指纹] 校验前缀,对得上只发新增部分。
  const sent = Number(sess.nmsgs || 0);
  if (sent > 0 && sent < messages.length && sess.phash && messageHash(messages, sent) === sess.phash) {
    // 跳过客户端回显的那条 assistant 回复,其余(新的 user / tool 结果)发上去
    let i = sent;
    while (i < messages.length) {
      const m = messages[i] || {};
      if (m.role === "assistant" && !m.tool_calls) { i++; continue; }
      break;
    }
    if (i < messages.length) {
      out.mode = "continue";
      out.startIndex = i;
      out.reason = "prefix-match";
      return out;
    }
    out.reason = "nothing-new";
    return out;
  }
  // ③ 客户端点名了 Gemini 会话(c_…)但本地历史对不上 —— 常见于客户端截断旧消息、
  //    每轮换 system prompt(时间戳之类)、或本来就只发新消息。会话主体在上游,
  //    没理由因为本地前缀对不上就重发全量(那才是长对话发几条就爆的原因)。
  //    只把最后一条用户消息发上去。
  if (trusted) {
    let j = messages.length - 1;
    while (j >= 0 && (messages[j] || {}).role !== "user") j--;
    if (j < 0) j = messages.length - 1;
    if (j >= 0) {
      out.mode = "continue";
      out.startIndex = j;
      out.reason = "trusted-last-user";
      return out;
    }
  }
  out.reason = sent === 0 ? "no-prefix" : "history-diverged";
  return out;
}

/** 开聊前:取会话、定本轮怎么发。命中续聊时把 cfg._session_meta 设好。 */
async function prepareSession(cfg, request, req, messages, modelId) {
  const off = { sid: "", sess: null, explicit: false, source: "", model: modelId,
                plan: { mode: "new", startIndex: 0, reason: "off" } };
  if (!cfg.session_memory) return off;
  const env = cfg._env;
  if (!env || (!env.DB && !env.STATE)) return Object.assign(off, { plan: { mode: "new", startIndex: 0, reason: "no-storage" } });
  const key = sessionKey(cfg, request, req, messages);
  if (!key.raw) return Object.assign(off, { plan: { mode: "new", startIndex: 0, reason: "no-key" } });
  cfg._metaFresh = false;
  let sid;
  let sess = null;
  if (key.cid) {
    // 客户端直接给了 Gemini 会话 id:按 cid 找(会话 = gemini.google.com/app/<cid>)
    sess = await sessionGetByCid(env, key.cid);
    sid = sess ? sess.sid : syncHash(key.raw);
    if (!sess) log(cfg, `会话 ${key.cid} 本地没有记录(已过期或换了实例),按新会话处理`);
  } else {
    sid = syncHash(key.raw);
    try { sess = await sessionGet(env, sid); } catch (_) { sess = null; }
  }
  const deltaOK = key.explicit && deltaModeRequested(cfg, request, req);
  // 点名了 Gemini 会话 => 以上游会话为准,前缀对不上也照样续(见 planTurn ③)
  const trusted = !!key.cid;
  const plan = planTurn(cfg, sess, messages, modelId, deltaOK, trusted);
  if (plan.mode === "continue" && sess) cfg._session_meta = [sess.cid, sess.rid, sess.rcid || ""];
  return { sid, sess, explicit: key.explicit, source: key.source, cid: key.cid || "", model: modelId, plan, deltaOK };
}

/** 一轮结束后:落库会话 + 把本轮图片 URL→key 映射写进 D1。 */
async function endTurn(cfg, sctx, ok, messages, modelId) {
  try { await flushImageMap(cfg); } catch (_) { /* ignore */ }
  if (!ok || !sctx || !sctx.sid) return;
  const env = cfg._env;
  if (!env || (!env.DB && !env.STATE)) return;
  const meta = cfg._session_meta;
  // 只有「响应里确实带回新会话 id」才推进会话状态。否则保持原样 ——
  // 免得把 nmsgs/phash 推进了、Gemini 侧其实没接上,下一轮增量就丢内容。
  if (!cfg._metaFresh) return;
  if (!meta || !meta[0] || !meta[1]) return;
  const deltaMode = !!sctx.deltaOK;
  const row = {
    sid: sctx.sid,
    cid: String(meta[0]),
    rid: String(meta[1]),
    rcid: meta[2] ? String(meta[2]) : "",
    model: modelId != null ? String(modelId) : null,
    nmsgs: deltaMode ? 0 : (Array.isArray(messages) ? messages.length : 0),
    phash: deltaMode ? "" : messageHash(messages, Array.isArray(messages) ? messages.length : 0),
    delta_mode: deltaMode,
    turns: Number((sctx.sess && sctx.sess.turns) || 0) + 1,
    created_ts: Number((sctx.sess && sctx.sess.created_ts) || 0) || Date.now(),
  };
  sctx.sess = row;
  try { await sessionPut(env, sctx.sid, row, cfg.session_ttl_sec); } catch (_) { /* ignore */ }
  log(cfg, `session ${sctx.sid.slice(0, 8)} ${sctx.plan.mode}/${sctx.plan.reason} turns=${row.turns} msgs=${row.nmsgs}`);
}

// ── 长期记忆 ───────────────────────────────────────────────────────────────
function memoryScope(request, req) {
  try {
    const h = request && request.headers && request.headers.get("x-memory-scope");
    if (h && h.trim()) return h.trim().slice(0, 200);
  } catch (_) { /* ignore */ }
  if (req && typeof req.memory_scope === "string" && req.memory_scope.trim()) return req.memory_scope.trim().slice(0, 200);
  if (req && typeof req.user === "string" && req.user.trim()) return req.user.trim().slice(0, 200);
  return "default";
}
async function memoryList(env, scope, limit) {
  if (!env || !env.DB) return [];
  try {
    await ensureSchema(env);
    const r = await env.DB.prepare(
      "SELECT id, content, source, created_ts, updated_ts FROM memories WHERE scope = ?1 ORDER BY updated_ts DESC LIMIT ?2"
    ).bind(scope, limit || 500).all();
    return (r && r.results) || [];
  } catch (_) { return []; }
}
async function memoryAdd(env, scope, content, source) {
  const text = String(content || "").trim();
  if (!env || !env.DB || !text) return null;
  await ensureSchema(env);
  const id = randHex(16);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO memories (id, scope, content, source, created_ts, updated_ts) VALUES (?1,?2,?3,?4,?5,?6)"
  ).bind(id, scope, text, source || "api", now, now).run();
  return id;
}
async function memoryGc(env, scope, maxItems) {
  if (!env || !env.DB || !maxItems) return;
  try {
    await env.DB.prepare(
      "DELETE FROM memories WHERE scope = ?1 AND id NOT IN (" +
      "SELECT id FROM memories WHERE scope = ?1 ORDER BY updated_ts DESC LIMIT ?2)"
    ).bind(scope, maxItems).run();
  } catch (_) { /* ignore */ }
}
/** 记忆块 —— 只在开新会话时注入。 */
async function memoryBlock(cfg, env, scope) {
  if (!cfg.memory_enabled || !env || !env.DB) return "";
  const rows = await memoryList(env, scope, cfg.memory_max_items);
  if (!rows.length) return "";
  const cap = cfg.memory_inject_max_bytes || 0;
  const lines = [];
  let bytes = 0;
  for (const r of rows) {
    const line = "- " + String(r.content).replace(/\s+/g, " ").trim();
    const len = new TextEncoder().encode(line).length + 1;
    if (cap && bytes + len > cap) break;
    bytes += len;
    lines.push(line);
  }
  if (!lines.length) return "";
  return "[长期记忆 · 请在后续回答中遵循]\n" + lines.join("\n") + "\n[/长期记忆]";
}

// ── 生成图片中转 ───────────────────────────────────────────────────────────
// 上游直链(googleusercontent.com,而且 gg-dl 带签名会过期)用户那边往往加载
// 不出来。这里改写成自家域名,自己回源并缓存到 R2 + 边缘。
const IMG_KEY_RE = /^[0-9a-f]{16,64}$/;
function imgKeyOf(cfg, url) {
  return syncHash((cfg && cfg.public_origin ? cfg.public_origin : "") + "|" + url).slice(0, 24);
}
/** 同步路径:把 googleusercontent 直链换成 <PUBLIC_ORIGIN>/img/<key>。 */
function imageProxyUrl(cfg, url) {
  if (!cfg || cfg.image_proxy === false) return url;
  if (!url || !IMG_URL_RE.test(url)) return url;
  const env = cfg._env;
  if (!env || (!env.DB && !env.FILECACHE)) return url;
  if (!cfg.public_origin) return url; // 没配对外域名就保持直链,免得给个打不开的地址
  const key = imgKeyOf(cfg, url);
  if (!cfg._imgPending) cfg._imgPending = new Map();
  if (!cfg._imgPending.has(key)) cfg._imgPending.set(key, url);
  return cfg.public_origin + "/img/" + key;
}
/** 把本轮 URL→key 映射落进 D1(/img/<key> 靠它反查原图)。 */
async function flushImageMap(cfg) {
  const pend = cfg && cfg._imgPending;
  if (!pend || !pend.size) return;
  cfg._imgPending = null;
  const env = cfg._env;
  if (!env || !env.DB) return;
  try {
    await ensureSchema(env);
    const ts = Date.now();
    const stmts = [];
    for (const [k, u] of pend) {
      stmts.push(env.DB.prepare(
        "INSERT INTO img_map (hash, url, ts) VALUES (?1, ?2, ?3) ON CONFLICT(hash) DO UPDATE SET url = excluded.url, ts = excluded.ts"
      ).bind(k, u, ts));
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch (e) { log(cfg, `img_map 写入失败(不影响出图): ${e}`); }
}
function monthKey() {
  const d = new Date();
  return "b:" + d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
/** R2 月度写入预算:超额就不再落 R2(图照常显示,只是不缓存)。 */
async function r2BudgetAllow(cfg, env, size) {
  const cap = Number(cfg.image_r2_monthly_max_bytes || 0);
  if (!cap) return false;
  if (!env.DB) return true;
  try {
    const row = await env.DB.prepare("SELECT v FROM img_budget WHERE k = ?1").bind(monthKey()).first();
    return Number((row && row.v) || 0) + size <= cap;
  } catch (_) { return true; }
}
async function r2BytesAdd(env, size) {
  if (!env || !env.DB) return;
  try {
    await env.DB.prepare(
      "INSERT INTO img_budget (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v"
    ).bind(monthKey(), size).run();
  } catch (_) { /* ignore */ }
}
async function storeImageR2(cfg, env, key, bytes, mime) {
  if (!env || !env.FILECACHE) return false;
  if (cfg.image_r2_store === false) return false;
  if (bytes.byteLength > Number(cfg.image_object_max_bytes || 12582912)) return false;
  if (!(await r2BudgetAllow(cfg, env, bytes.byteLength))) {
    log(cfg, "R2 图片月度预算已用尽,本次只走边缘缓存");
    return false;
  }
  try {
    await env.FILECACHE.put("img/" + key, bytes, {
      httpMetadata: { contentType: mime || "image/png", cacheControl: `public, max-age=${cfg.image_cache_ttl_sec || 604800}` },
    });
    await r2BytesAdd(env, bytes.byteLength);
    return true;
  } catch (e) { log(cfg, `R2 写入失败: ${e}`); return false; }
}
const IMG_UPSTREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  "Referer": "https://gemini.google.com/",
};
/**
 * GET /img/<key> —— 公开端点。<img> 标签发不出 Authorization 头,所以用
 * 「不可猜的 key」当凭据;key 只由 googleusercontent 白名单 URL 生成,
 * 不构成任意 URL 代理(SSRF)。
 */
async function handleImageProxy(key, request, cfg, env) {
  const base = {
    ...corsHeaders(),
    "Cache-Control": `public, max-age=${Math.max(60, cfg.image_cache_ttl_sec || 604800)}`,
    "X-Content-Type-Options": "nosniff",
  };
  if (!IMG_KEY_RE.test(String(key || ""))) return new Response("bad image key", { status: 400, headers: base });
  const cache = (typeof caches !== "undefined" && caches && caches.default) ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });
  if (cache) { try { const hit = await cache.match(cacheKey); if (hit) return hit; } catch (_) { /* ignore */ } }

  // ① R2(持久层)
  if (env.FILECACHE) {
    try {
      const obj = await env.FILECACHE.get("img/" + key);
      if (obj) {
        const mime = (obj.httpMetadata && obj.httpMetadata.contentType) || "image/png";
        const res = new Response(obj.body, { status: 200, headers: { ...base, "Content-Type": mime } });
        if (cache) { try { await cache.put(cacheKey, res.clone()); } catch (_) { /* ignore */ } }
        return res;
      }
    } catch (_) { /* ignore */ }
  }

  // ② D1 反查原图(丢了映射还能用 ?s=<base64url> 兜底)
  let src = "";
  if (env.DB) {
    try {
      await ensureSchema(env);
      const row = await env.DB.prepare("SELECT url FROM img_map WHERE hash = ?1").bind(key).first();
      src = (row && row.url) || "";
    } catch (_) { /* ignore */ }
  }
  if (!src) {
    const q = new URL(request.url).searchParams.get("s");
    if (q) { try { const d = b64urlDecode(q); if (IMG_URL_RE.test(d)) src = d; } catch (_) { /* ignore */ } }
  }
  if (!src || !IMG_URL_RE.test(src)) return new Response("image not found", { status: 404, headers: base });

  // ③ 回源 + 回填
  let up;
  try {
    up = await fetch(src, { headers: IMG_UPSTREAM_HEADERS, redirect: "follow" });
  } catch (e) {
    return new Response("upstream fetch failed: " + String((e && e.message) || e), { status: 502, headers: base });
  }
  if (!up.ok) return new Response("upstream " + up.status, { status: 502, headers: base });
  const ctype = String(up.headers.get("content-type") || "image/png").split(";")[0].trim();
  if (!ctype.startsWith("image/")) return new Response("upstream is not an image", { status: 502, headers: base });
  const bytes = new Uint8Array(await up.arrayBuffer());
  if (!bytes.byteLength) return new Response("empty upstream body", { status: 502, headers: base });
  const res = new Response(bytes, { status: 200, headers: { ...base, "Content-Type": ctype, "Content-Length": String(bytes.byteLength) } });
  if (cache) { try { await cache.put(cacheKey, res.clone()); } catch (_) { /* ignore */ } }
  try { await storeImageR2(cfg, env, key, bytes, ctype); } catch (_) { /* ignore */ }
  return res;
}

// ── 官方 Gemini API 出图 ───────────────────────────────────────────────────
const OFFICIAL_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
/**
 * 用官方 Gemini API 生成图片。返回 { bytes, mime }。
 * 这是「网页端出图被指纹卡住」的补充通道:走正规 API,没有客户端指纹校验。
 */
async function officialImageGenerate(cfg, prompt, opts) {
  const key = cfg && cfg.gemini_api_key;
  if (!key) throw new Error("GEMINI_API_KEY 未配置,无法使用官方出图通道");
  const model = (opts && opts.model) || cfg.gemini_image_model || "gemini-3.1-flash-image";
  const url = `${OFFICIAL_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: String(prompt || "").slice(0, 4000) }] }],
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: timeoutSignal(120000),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`官方 API ${r.status}: ${text.slice(0, 1200)}`);
  }
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error("官方 API 返回非 JSON: " + text.slice(0, 200)); }
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const mime = inline.mimeType || inline.mime_type || "image/png";
      return { bytes: base64ToBytes(inline.data), mime };
    }
  }
  const reason = (j.candidates && j.candidates[0] && j.candidates[0].finishReason) || "";
  const said = parts.map((p) => p.text || "").join(" ").trim();
  throw new Error("官方 API 未返回图片" + (reason ? ` (finishReason=${reason})` : "") + (said ? ": " + said.slice(0, 200) : ""));
}
/** 把生成的图片字节存进 R2(键沿用 img/<key>),返回可对外访问的 URL。 */
async function publishImageBytes(cfg, env, bytes, mime, seed) {
  const key = syncHash(String(seed || "") + "|" + bytes.byteLength + "|" + Date.now()).slice(0, 24);
  if (env && env.FILECACHE) {
    try {
      await env.FILECACHE.put("img/" + key, bytes, {
        httpMetadata: { contentType: mime || "image/png", cacheControl: `public, max-age=${cfg.image_cache_ttl_sec || 604800}` },
      });
    } catch (e) { log(cfg, `官方出图写 R2 失败: ${e}`); }
  }
  const origin = cfg.public_origin || "";
  return origin ? `${origin}/img/${key}` : "";
}
/**
 * 官方 API 诊断:列出该 key 可用的模型(不消耗生成额度),或试跑一次生成。
 * 用来在配 key 前先看清额度/可用性。
 */
async function handleOfficialDiag(req, cfg) {
  const key = cfg && cfg.gemini_api_key;
  if (!key) return jsonResponse({ error: { message: "GEMINI_API_KEY 未配置" } }, 503);
  const action = String(req.action || "models").toLowerCase();
  if (action === "models") {
    try {
      const r = await fetch(`${OFFICIAL_API_BASE}/models?pageSize=200`, {
        headers: { "x-goog-api-key": key }, signal: timeoutSignal(30000),
      });
      const text = await r.text();
      if (!r.ok) return jsonResponse({ ok: false, status: r.status, body: text.slice(0, 1500) }, 200);
      let j;
      try { j = JSON.parse(text); } catch (_) { return jsonResponse({ ok: false, body: text.slice(0, 500) }, 200); }
      const all = (j.models || []).map((m) => ({
        name: String(m.name || "").replace(/^models\//, ""),
        methods: m.supportedGenerationMethods || [],
      }));
      const imageish = all.filter((m) => /image/i.test(m.name));
      return jsonResponse({
        ok: true, total: all.length,
        image_models: imageish,
        configured_model_available: all.some((m) => m.name === cfg.gemini_image_model),
        sample: all.slice(0, 40).map((m) => m.name),
      });
    } catch (e) {
      return jsonResponse({ ok: false, error: String((e && e.message) || e) }, 200);
    }
  }
  if (action === "generate") {
    const model = String(req.model || cfg.gemini_image_model);
    const prompt = String(req.prompt || "a red apple");
    const t0 = Date.now();
    try {
      const r = await fetch(`${OFFICIAL_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
        signal: timeoutSignal(120000),
      });
      const text = await r.text();
      let got = 0, mime = "";
      try {
        const j = JSON.parse(text);
        const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        for (const p of parts) {
          const inl = p.inlineData || p.inline_data;
          if (inl && inl.data) { got++; mime = inl.mimeType || inl.mime_type || ""; }
        }
      } catch (_) { /* 不是 JSON */ }
      return jsonResponse({ ok: r.ok, status: r.status, ms: Date.now() - t0, model, images: got, mime, body: r.ok && got ? "" : text.slice(0, 1500) }, 200);
    } catch (e) {
      return jsonResponse({ ok: false, model, ms: Date.now() - t0, error: String((e && e.message) || e) }, 200);
    }
  }
  return jsonResponse({ error: { message: "action 需为 models 或 generate" } }, 400);
}
/** POST /v1/images/generations —— OpenAI 兼容的图片生成端点。 */
async function handleImagesGenerations(req, cfg, env) {
  if (!cfg.gemini_api_key) {
    return jsonResponse({
      error: { message: "图片生成需要配置 GEMINI_API_KEY(网页端出图受客户端指纹限制,见 README)", type: "image_backend_unavailable" },
    }, 503);
  }
  const prompt = String(req.prompt || "").trim();
  if (!prompt) return jsonResponse({ error: { message: "prompt is required" } }, 400);
  const n = Math.min(Math.max(Number(req.n) || 1, 1), 4);
  const out = [];
  try {
    for (let i = 0; i < n; i++) {
      const { bytes, mime } = await officialImageGenerate(cfg, prompt, { model: req.model && !/^gemini-3\.(7|6|5|8)-flash/.test(req.model) ? req.model : null });
      const url = await publishImageBytes(cfg, env, bytes, mime, prompt + "#" + i);
      out.push(url ? { url } : { b64_json: bytesToBase64(bytes), revised_prompt: prompt });
    }
  } catch (e) {
    return jsonResponse({ error: { message: String((e && e.message) || e) } }, 502);
  }
  return jsonResponse({ created: nowSec(), data: out });
}
/**
 * 聊天里被网页端拒绝出图时的回退:改用官方 API 生成,把图片接到回复里。
 * 找不到图片意图就原样返回,不改变行为。
 */
async function imageFallbackViaApi(cfg, env, prompt, text) {
  if (!cfg.gemini_api_key || cfg.image_fallback_api === false) return null;
  if (!IMAGE_REGION_RE.test(String(text || ""))) return null;
  try {
    const { bytes, mime } = await officialImageGenerate(cfg, prompt);
    const url = await publishImageBytes(cfg, env, bytes, mime, prompt);
    if (!url) return null;
    log(cfg, "网页端拒绝出图,已用官方 API 回退成功");
    return url;
  } catch (e) {
    log(cfg, `官方 API 出图回退失败: ${(e && e.message) || e}`);
    return null;
  }
}

// ── 记忆 HTTP 接口 ─────────────────────────────────────────────────────────
async function handleMemories(request, cfg, env, url, method, req) {
  const scope = memoryScope(request, req);
  if (!env || !env.DB) return jsonResponse({ error: { message: "memory requires the D1 binding" } }, 503);
  try {
    if (method === "GET") {
      const rows = await memoryList(env, scope, cfg.memory_max_items);
      return jsonResponse({ object: "list", scope, data: rows.map((r) => ({ id: r.id, content: r.content, source: r.source, updated_at: r.updated_ts })) });
    }
    if (req === null || req === undefined) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
    if (method === "POST") {
      const items = Array.isArray(req.memories) ? req.memories : [req];
      const ids = [];
      for (const it of items) {
        const content = typeof it === "string" ? it : (it && (it.content || it.text)) || "";
        if (!String(content).trim()) continue;
        const id = await memoryAdd(env, scope, content, (it && it.source) || "api");
        if (id) ids.push(id);
      }
      await memoryGc(env, scope, cfg.memory_max_items);
      return jsonResponse({ object: "list", scope, created: ids });
    }
    if (method === "DELETE") {
      const id = req.id || url.searchParams.get("id") || "";
      if (id) {
        await env.DB.prepare("DELETE FROM memories WHERE id = ?1 AND scope = ?2").bind(String(id), scope).run();
        return jsonResponse({ deleted: 1, id });
      }
      const r = await env.DB.prepare("DELETE FROM memories WHERE scope = ?1").bind(scope).run();
      return jsonResponse({ deleted: (r && r.meta && r.meta.changes) || 0, scope });
    }
  } catch (e) {
    return jsonResponse({ error: { message: String((e && e.message) || e) } }, 500);
  }
  return jsonResponse({ error: "method not allowed" }, 405);
}
/**
 * 自动提炼记忆(默认关)。每轮结束后台跑一次,让上游从这轮对话里挑出
 * 「值得长期记住」的事实。会多消耗一次上游请求。
 */
async function autoExtractMemory(cfg, env, scope, userText, assistantText) {
  try {
    const ask =
      "从下面这轮对话里提取值得长期记住的用户信息(偏好、身份、长期目标、约定)。\n" +
      "只输出 JSON 数组,每项一行字符串;没有值得记的就输出 []。不要解释。\n\n" +
      "[用户]: " + String(userText || "").slice(0, 4000) + "\n" +
      "[助手]: " + String(assistantText || "").slice(0, 4000);
    const text = await generate(cfg, ask, 1, 1, null, null);
    const m = /\[[\s\S]*\]/.exec(text || "");
    if (!m) return;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || !arr.length) return;
    for (const item of arr.slice(0, 5)) {
      if (typeof item === "string" && item.trim()) await memoryAdd(env, scope, item, "auto");
    }
    await memoryGc(env, scope, cfg.memory_max_items);
  } catch (_) { /* 记忆提炼失败不影响主流程 */ }
}

// ─── 路由 ────────────────────────────────────────────────────────────────────
// Durable Object regional relay. locationHint selects the egress region.
const EGRESS_HINTS = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"]);
export class EgressRelay {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const target = request.headers.get("x-egress-target");
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response(JSON.stringify({ error: "invalid egress target" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const headers = new Headers(request.headers);
    for (const name of ["host", "cf-connecting-ip", "cf-ipcountry", "x-forwarded-for", "x-real-ip", "x-egress-target", "content-length"]) headers.delete(name);
    const init = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
    const upstream = await fetch(target, init);
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    out.set("x-do-egress", "1");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  }
}
function egressHints(cfg) {
  const all = [cfg.egress_hint, ...(cfg.egress_fallback_hints || [])].map((x) => String(x || "").trim()).filter((x) => EGRESS_HINTS.has(x));
  return [...new Set(all)];
}
function isGeminiOrigin(url, cfg) {
  try {
    const target = new URL(url);
    const origin = new URL(cfg.gemini_origin || "https://gemini.google.com");
    return target.hostname === origin.hostname || target.hostname.endsWith(".gemini.google.com");
  } catch (_) { return false; }
}
async function doEgressFetch(cfg, url, init, hintsOverride) {
  const env = cfg && cfg._env;
  if (!env || !env.EGRESS) return null;
  const hints = (hintsOverride && hintsOverride.length) ? hintsOverride : egressHints(cfg);
  if (!hints.length) return null;
  let lastErr = null;
  const start = Number(cfg._egressHintIndex || 0);
  for (let i = 0; i < hints.length; i++) {
    const hint = hints[(start + i) % hints.length];
    try {
      const id = env.EGRESS.idFromName("gemini-v1:" + hint);
      const stub = env.EGRESS.get(id, { locationHint: hint });
      const headers = new Headers(init.headers || {});
      headers.set("x-egress-target", url);
      const reqInit = { method: init.method || "GET", headers, redirect: "manual" };
      if (init.body !== undefined && init.body !== null) reqInit.body = init.body;
      const req = new Request("https://egress.internal/fetch", reqInit);
      const resp = await stub.fetch(req);
      cfg._egressHintIndex = (start + i + 1) % hints.length;
      cfg._lastEgressHint = hint;
      if ([429, 500, 502, 503, 504].includes(resp.status) && i < hints.length - 1) {
        try { if (resp.body) await resp.body.cancel(); } catch (_) {}
        lastErr = new UpstreamHttpError(resp.status, "durable object egress");
        continue;
      }
      log(cfg, "do egress " + hint + " -> " + resp.status);
      return resp;
    } catch (e) {
      lastErr = e;
      log(cfg, "do egress " + hint + " failed: " + ((e && e.message) || e));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}
export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    await hydrateState(cfg, env);
    cfg._ctx = ctx;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders(), "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "*" },
      });
    }
    cfg.client_ip = clientIp(request);
    // 控制台前端。根路径做内容协商:浏览器(Accept 带 text/html)拿页面,
    // 探针/监控拿原来的健康检查 JSON,互不影响。
    if (method === "GET" && (path === "/ui" || path === "/ui/")) return uiResponse();
    if (method === "GET" && path === "/" && String(request.headers.get("accept") || "").indexOf("text/html") >= 0) {
      return uiResponse();
    }
    // 生成图片中转:公开端点 —— <img> 标签发不出 Authorization 头,
    // 所以以「不可猜的 key」当凭据,并单独限流防刷。
    if (method === "GET" && path.indexOf("/img/") === 0) {
      if (!checkImgRate(cfg.client_ip, cfg)) {
        return new Response("too many requests", { status: 429, headers: corsHeaders() });
      }
      return await handleImageProxy(path.slice(5), request, cfg, env);
    }
    // 出口池按纯净度评分排序(缓存 60s,不给每次请求都加一次存储读)。
    // 池为空(没配任何出口)时保持旧行为。
    cfg._egressOrder = await egressOrderCached(cfg, env);
    const isHealthPath = path === "/" || path === "/health" || path === "/healthz";
    if (!isHealthPath && !checkRateLimit(cfg.client_ip, cfg)) {
      log(cfg, `rate limit exceeded: ${cfg.client_ip || "0.0.0.0"}`);
      return jsonResponse({
        error: { message: "请求过于频繁，请稍后再试", type: "rate_limit_exceeded" },
      }, 429, { "Retry-After": String(cfg.rate_limit_window || 60) });
    }
    // 请求体只能消费一次:失败回源时还要复用,所以先克隆一份 RAW body。
    const rawBody = method === "POST" || method === "PUT" ? await request.clone().text() : null;
    // 1060(出口 IP 风控)时的自愈:先在本 worker 内抖动重试(每次 fetch 子请求
    // 可能落到不同出口 IP),多次仍失败且配置了 ALT_EGRESS,则回源到备用入口
    // (另一组出口池)。X-Egress-Fallback 头防止多入口互相回跳成环。
    const berrRetry = async (fn) => {
      const maxAttempts = Math.max(1, cfg.bard_retry_attempts);
      const deadline = Date.now() + 60000; // 总预算:再糟也别让客户端干等超过 1 分钟
      let lastErr;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
          if (!isRetryableUpstream(e)) throw e;
          log(cfg, `${e.name || "error"} ${e.code || ""} (attempt ${i + 1}/${maxAttempts}) ${String(e.message || "")}`);
          if (i >= Math.max(1, cfg.bard_retry_attempts - 3)) cfg.alt_transport = false; // 最后一搏别换路径了
          if (i >= 1) {
            const alt = await tryAltEgress(cfg, request, url, rawBody);
            if (alt) { log(cfg, "served by alt egress"); return alt; }
          }
          if (Date.now() > deadline) break;
          await sleep(150 + Math.floor(Math.random() * 350));
        }
      }
      throw lastErr;
    };
    // 鉴权:配置了 API_KEYS 时,健康检查接口以外的所有接口都需要有效 key
    // (含 /v1/* 与 /v1beta/*,防止 Google 原生端点被绕过白嫖)。
    if (!isHealthPath && !authorized(request, url, cfg)) {
      return jsonResponse({ error: { message: "invalid api key" } }, 401);
    }
    try {
      if (method === "GET") {
        if (path === "/v1/models") {
          return jsonResponse({
            object: "list",
            data: Object.entries(MODELS).map(([n, c]) => ({ id: n, object: "model", created: 1700000000, owned_by: "google", description: c.desc })),
          });
        }
        if (path.startsWith("/v1beta/models")) {
          return jsonResponse({
            models: Object.entries(MODELS).map(([n, c]) => ({ name: `models/${n}`, displayName: n, description: c.desc, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] })),
          });
        }
        if (isHealthPath) {
          return jsonResponse({
            status: "ok",
            version: VERSION,
            platform: "Cloudflare Workers",
            defaultModel: cfg.default_model,
            models: Object.keys(MODELS),
            model_count: Object.keys(MODELS).length,
            bl: cfg.gemini_bl,
            cookie: !!cfg.cookie,
            cookie_pool: (cfg.cookie_pool || []).length,
            fsid: !!cfg.gemini_fsid,
            do_egress: !!cfg.do_egress,
            egress_hint: cfg.egress_hint || "",
            rate_limit: cfg.rate_limit_enabled ? { max: cfg.rate_limit_max, window_sec: cfg.rate_limit_window } : { enabled: false },
            fingerprint_jitter_ms: cfg.fingerprint_jitter_ms,
            session_memory: !!cfg.session_memory,
            session_ttl_sec: cfg.session_ttl_sec,
            memory: !!cfg.memory_enabled,
            memory_auto_extract: !!cfg.memory_auto_extract,
            image_proxy: !!cfg.image_proxy,
            public_origin: cfg.public_origin || "",
            r2_bound: !!env.FILECACHE,
            image_api_fallback: !!cfg.gemini_api_key && cfg.image_fallback_api !== false,
            image_api_model: cfg.gemini_api_key ? cfg.gemini_image_model : "",
            egress_pool: (cfg._egressOrder || []).map((e) => e.id),
            egress_force: cfg.egress_force || "",
            ts: Date.now(),
          });
        }
        if (path === "/debug") {
          return await handleDebug(cfg, request);
        }
        if (path === "/v1/memories") {
          return await handleMemories(request, cfg, env, url, "GET");
        }
        if (path === "/admin/state") {
          if (!adminOk(request, url, cfg)) return jsonResponse({ error: { message: "admin key required" } }, 401);
          return await handleAdminState(cfg, env, url);
        }
        if (path === "/admin/egress") {
          if (!adminOk(request, url, cfg)) return jsonResponse({ error: { message: "admin key required" } }, 401);
          return await handleAdminEgress(null, cfg, env, url, "GET");
        }
        if (path === "/admin/sessions") {
          if (!adminOk(request, url, cfg)) return jsonResponse({ error: { message: "admin key required" } }, 401);
          return await handleAdminSessions(null, cfg, env, url, "GET");
        }
        return jsonResponse({ error: "not found" }, 404);
      }
      if (method === "POST") {
        const bodyText = await request.text();
        const req = parseJson(bodyText);
        if (path === "/admin/cookie") {
          if (!adminOk(request, url, cfg)) return jsonResponse({ error: { message: "admin key required" } }, 401);
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleAdminCookie(req, cfg, env);
        }
        if (path === "/admin/egress") {
          if (!adminOk(request, url, cfg)) return jsonResponse({ error: { message: "admin key required" } }, 401);
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleAdminEgress(req, cfg, env, url, "POST");
        }
        if (path === "/admin/sessions") {
          if (!adminOk(request, url, cfg)) return jsonResponse({ error: { message: "admin key required" } }, 401);
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleAdminSessions(req, cfg, env, url, "POST");
        }
        if (path === "/v1/debug/raw") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleRawDebug(req, cfg);
        }
        if (path === "/v1/debug/egress") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleEgressDiag(req, cfg);
        }
        if (path === "/v1/debug/official") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleOfficialDiag(req, cfg);
        }
        if (path === "/v1/memories") {
          return await handleMemories(request, cfg, env, url, "POST", req);
        }
        if (path === "/v1/chat/completions") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await berrRetry(() => handleChat(req, cfg, request));
        }
        if (path === "/v1/images/generations") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleImagesGenerations(req, cfg, env);
        }
        if (path === "/v1/responses") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await berrRetry(() => handleResponses(req, cfg, request));
        }
        // 注意:先匹配 :streamGenerateContent,避免含两个子串的路径被误判(对齐上游)
        if (path.includes(":streamGenerateContent")) {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await berrRetry(() => handleGoogleGenerate(req, cfg, path, true, request));
        }
        if (path.includes(":generateContent")) {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await berrRetry(() => handleGoogleGenerate(req, cfg, path, false, request));
        }
        return jsonResponse({ error: "not found" }, 404);
      }
      if (method === "DELETE") {
        if (path === "/v1/memories") {
          const bodyText = await request.text().catch(() => "");
          return await handleMemories(request, cfg, env, url, "DELETE", parseJson(bodyText));
        }
        return jsonResponse({ error: "not found" }, 404);
      }
      if (method === "HEAD") {
        return jsonResponse({ status: "ok", version: VERSION });
      }
      return jsonResponse({ error: "not found" }, 404);
    } catch (e) {
      log(cfg, `error: ${(e && e.stack) || e}`);
      const message = String((e && e.message) || e);
      const status = /all image uploads failed/i.test(message) ? 502 : 500;
      return jsonResponse({ error: { message } }, status);
    }
  },
  // 定时任务(见 wrangler.toml 的 crons):拉一次 Gemini 首页,把滚动更新的
  // __Secure-1PSIDTS / SNlM0e / bl 写回 KV,让 cookie 长时间不掉线。
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const cfg = getConfig(env);
      await hydrateState(cfg, env);
      const live = await refreshSession(cfg);
      const patch = { updated_ts: Date.now(), source: "cron" };
      if (live.cookie && live.rotated) { patch.cookie = live.cookie; patch.sapisid = extractSapisid(live.cookie) || cfg.sapisid; }
      if (live.bl) patch.bl = live.bl;
      if (live.xsrf) patch.xsrf = live.xsrf;
      if (cfg.gemini_fsid) patch.fsid = cfg.gemini_fsid;
      if (live.alive || patch.cookie) await saveState(env, patch);
      log(cfg, `cron refresh: status=${live.status} alive=${live.alive} set-cookie=${live.setCookieCount} rotated=${live.rotated}`);
      // 顺带跑一轮出口纯净度测试(每 6h 一次,和 cron 同频)。
      // 图片探针会真的调一次生成,所以受 EGRESS_PROBE_IMAGE 控制。
      try {
        cfg._egressOrder = await egressOrderCached(cfg, env);
        const results = await runEgressTests(cfg, env, null, { image: !!cfg.egress_probe_image });
        log(cfg, "egress probe: " + results.map((r) => `${r.label || r.id}=${r.text_status}/${r.image_status}:${r.score}`).join(" "));
      } catch (e) {
        log(cfg, `egress probe failed: ${(e && e.message) || e}`);
      }
    })());
  },
};
// 1060 兜底:把同一个请求原样发到备用入口(另一组出口 IP 池)。
// X-Egress-Fallback 标记避免多入口互相回跳。
async function tryAltEgress(cfg, request, url, rawBody) {
  if (request.headers.get("x-egress-fallback")) return null;
  if (!cfg.alt_egress || !cfg.alt_egress.length) return null;
  for (const base of cfg.alt_egress) {
    let origin;
    try { origin = new URL(base); } catch (_) { continue; }
    if (origin.host === url.host) continue;
    try {
      const headers = new Headers();
      // 和白名单一样转发,否则回退时 X-Session-Id / X-Memory-Scope 会被吃掉。
      for (const [n, v] of request.headers) {
        const lower = n.toLowerCase();
        if (["host", "content-length", "connection", "accept-encoding"].includes(lower) || lower.startsWith("cf-")) continue;
        try { headers.set(n, v); } catch (_) { /* ignore */ }
      }
      headers.set("x-egress-fallback", "1");
      const resp = await fetch(base.replace(/\/$/, "") + url.pathname + url.search, {
        method: request.method,
        headers,
        body: rawBody == null ? undefined : rawBody,
      });
      if (resp.ok) return resp;
      log(cfg, `alt egress ${origin.host} -> ${resp.status}`);
    } catch (e) {
      log(cfg, `alt egress ${origin.host} failed: ${e}`);
    }
  }
  return null;
}
// ─── 运维:会话状态 / 原始响应调试 ──────────────────────────────────────────
// /admin/* 需要 ADMIN_KEY(未配置时回落到 API_KEYS)
function adminOk(request, url, cfg) {
  const auth = request.headers.get("authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "") || request.headers.get("x-api-key") || url.searchParams.get("key") || "";
  if (cfg.admin_key) return key === cfg.admin_key;
  return authorized(request, url, cfg);
}
async function handleAdminState(cfg, env, url) {
  const st = (await readState(env, true)) || {};
  const out = {
    version: VERSION,
    ts: Date.now(),
    cookie_present: !!cfg.cookie,
    cookie_len: cfg.cookie ? cfg.cookie.length : 0,
    cookie_fp: cfg.cookie ? await shortHash(cfg.cookie, 12) : null,
    cookie_source: cfg._cookieSource || (cfg.cookie ? "env" : "none"),
    has_sapisid: !!cfg.sapisid,
    has_xsrf: !!cfg.xsrf_token,
    has_fsid: !!cfg.gemini_fsid,
    bl: cfg.gemini_bl,
    upstream_socket: cfg.upstream_socket,
    alt_egress: cfg.alt_egress,
    cookie_pool_size: (cfg.cookie_pool || []).length,
    rate_limit: cfg.rate_limit_enabled ? { enabled: true, max: cfg.rate_limit_max, window_sec: cfg.rate_limit_window } : { enabled: false },
    fingerprint_jitter_ms: cfg.fingerprint_jitter_ms,
    kv_bound: !!env.STATE,
    d1_bound: !!env.DB,
    r2_bound: !!env.FILECACHE,
    state_updated_ts: st.updated_ts || 0,
    state_source: st.source || null,
    state_bl: st.bl || null,
    files_cached: null,
  };
  try {
    if (env.DB) {
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM file_cache").first();
      out.files_cached = r ? r.n : 0;
    }
  } catch (_) { /* ignore */ }
  const budget = (url && url.searchParams.get("live")) === "1";
  if (budget) {
    try {
      const live = await refreshSession(cfg);
      out.live = {
        status: live.status, alive: live.alive, blocked: !!live.blocked, location: live.location || "",
        set_cookie: live.setCookieCount, set_cookie_names: live.setCookieNames || [],
        rotated: live.rotated, bl: live.bl || null,
      };
      if (live.alive && (live.rotated || live.bl || live.xsrf)) {
        await saveState(env, {
          cookie: live.cookie || cfg.cookie,
          sapisid: extractSapisid(live.cookie) || cfg.sapisid,
          bl: live.bl || cfg.gemini_bl,
          xsrf: live.xsrf || cfg.xsrf_token,
          fsid: cfg.gemini_fsid || "",
          updated_ts: Date.now(),
          source: "admin-state-refresh",
        });
        _stateCache = { data: null, ts: 0 };
      }
    } catch (e) {
      out.live = { error: String((e && e.message) || e) };
    }
  }
  return jsonResponse(out);
}
// 写入 / 刷新 Gemini 会话 cookie:
//   {"cookie":"SID=...; __Secure-1PSIDTS=...", "xsrf":"...", "bl":"...", "source":"manual"}
//   {"mode":"refresh"}  用当前 cookie 去 /app 页面换一份新的(含滚动 PSIDTS)
//   {"mode":"clear"}    清掉 KV 里的 cookie(回到环境变量)
async function handleAdminCookie(req, cfg, env) {
  const mode = String(req.mode || "set");
  if (mode === "clear") {
    const st = (await readState(env, true)) || {};
    delete st.cookie;
    delete st.sapisid;
    delete st.fsid;
    await saveState(env, { cookie: null, sapisid: null, updated_ts: Date.now(), source: "cleared" });
    _stateCache = { data: null, ts: 0 };
    return jsonResponse({ ok: true, mode, note: "KV cookie cleared, falling back to env", had: !!st.cookie });
  }
  if (mode === "refresh") {
    const live = await refreshSession(cfg);
    if (!live.alive) return jsonResponse({ ok: false, mode, live: { status: live.status, alive: live.alive }, error: "session not alive (cookie expired?)" }, 400);
    const saved = await saveState(env, {
      cookie: live.cookie || cfg.cookie,
      sapisid: extractSapisid(live.cookie) || cfg.sapisid,
      bl: live.bl || cfg.gemini_bl,
      xsrf: live.xsrf || cfg.xsrf_token,
      fsid: cfg.gemini_fsid || "",
      updated_ts: Date.now(),
      source: "admin-refresh",
    });
    return jsonResponse({ ok: saved, mode, alive: true, set_cookie: live.setCookieCount, rotated: live.rotated, bl: live.bl || null });
  }
  let cookie = req.cookie || req.cookies || "";
  if (Array.isArray(cookie)) cookie = cookie.map((c) => String(c).split(";")[0]).join("; ");
  if (req.raw && !cookie) cookie = String(req.raw);
  cookie = String(cookie || "").trim();
  if (!cookie) return jsonResponse({ error: { message: "cookie required" } }, 400);
  const patch = {
    cookie,
    sapisid: req.sapisid || extractSapisid(cookie) || cfg.sapisid,
    updated_ts: Date.now(),
    source: String(req.source || "manual"),
  };
  if (req.bl) patch.bl = String(req.bl);
  if (req.xsrf) patch.xsrf = String(req.xsrf);
  if (req.fsid || req.f_sid) patch.fsid = String(req.fsid || req.f_sid);
  const ok = await saveState(env, patch);
  _stateCache = { data: null, ts: 0 };
  const parts = cookie.split(";").map((x) => x.split("=")[0].trim()).filter(Boolean);
  return jsonResponse({ ok, cookie_len: cookie.length, cookie_fp: await shortHash(cookie, 12), names: parts, has_sapisid: !!patch.sapisid });
}
// ─── 运维:出口池 ────────────────────────────────────────────────────────────
/** 代理 URL 带账号密码,回显时打码,别把凭据发到前端。 */
function maskProxySpec(target) {
  return String(target || "").replace(/:\/\/([^:@/]+):([^@/]*)@/, "://$1:***@");
}
function egressRow(entry, stat, forced) {
  const s = stat || {};
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label || entry.id,
    target: entry.kind === "proxy" ? maskProxySpec(entry.target) : (entry.target || entry.kind),
    forced: forced === entry.id || forced === entry.target,
    text_status: s.text_status || "",
    image_status: s.image_status || "",
    latency_ms: Number(s.latency_ms || 0),
    score: Number(s.score || 0),
    runs: Number(s.runs || 0),
    image_ok_runs: Number(s.image_ok_runs || 0),
    updated_ts: Number(s.updated_ts || 0),
    detail: s.detail || "",
  };
}
async function handleAdminEgress(req, cfg, env, url, method) {
  if (method === "GET") {
    const [pool, stats, settings] = await Promise.all([
      loadEgressPool(cfg, env), egressStatsAll(env), loadEgressSettings(env),
    ]);
    const forced = settings.force || cfg.egress_force || "";
    const rows = pool.map((e) => egressRow(e, stats.get(e.id), forced)).sort((a, b) => b.score - a.score);
    const order = (await egressOrderCached(cfg, env)).map((e) => e.id);
    let stored = 0;
    try {
      await ensureSchema(env);
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM egress_pool").first();
      stored = Number((c && c.n) || 0);
    } catch (_) { /* ignore */ }
    return jsonResponse({
      object: "list",
      forced,
      probe_image: settings.probe_image === undefined ? !!cfg.egress_probe_image : settings.probe_image === "1",
      order,
      source: stored ? "stored" : "default",
      data: rows,
    });
  }
  if (method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const body = req || {};
  const action = String(body.action || "").toLowerCase();
  if (action === "test") {
    const ids = Array.isArray(body.ids) ? body.ids : null;
    const settings = await loadEgressSettings(env);
    const withImage = body.image === undefined
      ? (settings.probe_image === undefined ? !!cfg.egress_probe_image : settings.probe_image === "1")
      : !!body.image;
    const results = await runEgressTests(cfg, env, ids, { image: withImage });
    _egressCache = { data: null, ts: 0 };
    return jsonResponse({ ok: true, tested: results.length, results });
  }
  if (action === "pool") {
    const saved = await saveEgressPool(env, body.pool || []);
    _egressCache = { data: null, ts: 0 };
    if (!saved) return jsonResponse({ error: { message: "出口池格式不合法(或 D1 未绑定)" } }, 400);
    return jsonResponse({ ok: true, count: saved.length, pool: saved.map(entryToSpec) });
  }
  if (action === "force") {
    const id = String(body.id || "").trim();
    await saveEgressSetting(env, "force", id);
    _egressCache = { data: null, ts: 0 };
    return jsonResponse({ ok: true, forced: id });
  }
  if (action === "probe_image") {
    await saveEgressSetting(env, "probe_image", body.enabled ? "1" : "");
    return jsonResponse({ ok: true, probe_image: !!body.enabled });
  }
  return jsonResponse({ error: { message: "unknown action" } }, 400);
}
// ─── 运维:会话列表 ──────────────────────────────────────────────────────────
async function handleAdminSessions(req, cfg, env, url, method) {
  if (!env || !env.DB) return jsonResponse({ error: { message: "requires the D1 binding" } }, 503);
  try {
    await ensureSchema(env);
    if (method === "GET") {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 500);
      const r = await env.DB.prepare(
        "SELECT sid, cid, rid, model, turns, nmsgs, delta_mode, updated_ts FROM chat_sessions ORDER BY updated_ts DESC LIMIT ?1"
      ).bind(limit).all();
      const rows = ((r && r.results) || []).map((x) => ({
        sid: x.sid,
        cid: x.cid,
        rid: x.rid,
        model: x.model || "",
        turns: Number(x.turns || 0),
        messages: Number(x.nmsgs || 0),
        delta_mode: !!x.delta_mode,
        updated_ts: Number(x.updated_ts || 0),
      }));
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_sessions").first();
      return jsonResponse({ object: "list", total: Number((c && c.n) || 0), data: rows });
    }
    if (method === "POST") {
      const body = req || {};
      if (body.all) {
        const r = await env.DB.prepare("DELETE FROM chat_sessions").run();
        return jsonResponse({ ok: true, deleted: Number((r && r.meta && r.meta.changes) || 0) });
      }
      const sid = String(body.sid || "").trim();
      if (!sid) return jsonResponse({ error: { message: "sid required" } }, 400);
      const r = await env.DB.prepare("DELETE FROM chat_sessions WHERE sid = ?1").bind(sid).run();
      return jsonResponse({ ok: true, deleted: Number((r && r.meta && r.meta.changes) || 0) });
    }
  } catch (e) {
    return jsonResponse({ error: { message: String((e && e.message) || e) } }, 500);
  }
  return jsonResponse({ error: "method not allowed" }, 405);
}
// 原样返回上游 StreamGenerate 响应(排查 1060 / 图片结构时用)
async function handleRawDebug(req, cfg) {
  const prompt = String(req.prompt || "Reply with one word: PONG");
  const modelName = String(req.model || cfg.default_model);
  const m = resolveModel(modelName, cfg.default_model);
  if (m.error) return jsonResponse({ error: m.error }, 400);
  // 强制走指定出口(排查某个机房/代理到底返回什么时用)
  let dcfg = cfg;
  if (req.egress) {
    const e = parseEgressSpec(String(req.egress));
    if (!e) return jsonResponse({ error: { message: "bad egress spec" } }, 400);
    dcfg = Object.assign({}, cfg, { _egress: e, _forceEgress: true, do_egress: false, fingerprint_jitter_ms: 0 });
  }
  // 传了 inner 就原样下发(只换掉每次请求都该变的 [59] 请求 uuid)。
  // 用来把「真实网页客户端发的 payload」搬过来逐槽位复现上游行为。
  let body;
  if (Array.isArray(req.inner)) {
    const inner = req.inner.slice();
    inner[59] = uuid();
    const outer = [null, JSON.stringify(inner)];
    const form = { "f.req": JSON.stringify(outer) };
    if (dcfg.xsrf_token) form.at = dcfg.xsrf_token;
    body = new URLSearchParams(form).toString();
  } else {
    body = buildPayload(prompt, m.modeId, m.thinkMode, null, m.extra, dcfg);
  }
  const headers = await buildHeaders(dcfg);
  const r = await httpFetch(getUrl(dcfg), { method: "POST", headers, body, timeoutMs: Number(req.timeout_ms) || 120000, socket: dcfg.upstream_socket, cfg: dcfg });
  const raw = await r.text();
  const limit = Math.min(Number(req.limit) || 400000, 2000000);
  const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  return jsonResponse({
    status: r.status,
    length: raw.length,
    model: m.name,
    bl: cfg.gemini_bl,
    setCookieNames: sc.map((c) => String(c).split("=")[0]),
    contentType: r.headers.get("content-type"),
    raw: raw.slice(0, limit),
  });
}
// 出口连通性诊断:用指定出口去取一个白名单里的网址,看隧道到底通不通。
// 目标域名做了白名单限制 —— 否则它就是一个带鉴权的任意 URL 抓取(SSRF)入口。
const EGRESS_DIAG_HOSTS = new Set(["gemini.google.com", "www.google.com", "api.ipify.org", "ipinfo.io", "www.cloudflare.com", "smtp.gmail.com"]);
async function handleEgressDiag(req, cfg) {
  // 决定性实验:SMTP STARTTLS 天生就是「先明文收发、再升级 TLS」。
  // 如果这里能升级成功,说明运行时支持 I/O 之后 startTls —— 那代理隧道失败就是代理的问题;
  // 如果这里也失败,说明该运行时根本不能在明文 I/O 之后升级(代理隧道这条路走不通)。
  if (String(req.egress || "") === "smtp-starttls") {
    const host = "smtp.gmail.com";
    const connect = await resolveConnect();
    if (!connect) return jsonResponse({ ok: false, error: "cloudflare:sockets unavailable" }, 502);
    const t0 = Date.now();
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    try {
      const s = connect({ hostname: host, port: 587 }, { secureTransport: "starttls", allowHalfOpen: false });
      let w = s.writable.getWriter();
      let r = s.readable.getReader();
      const src = streamSource(r);
      const readLine = async () => {
        let out = "";
        for (let i = 0; i < 4096; i++) {
          const b = (await src.need(1))[0];
          out += String.fromCharCode(b);
          if (out.endsWith("\r\n")) return out.trim();
        }
        throw new Error("no line");
      };
      // 读问候,可能多行(250-xxx)。读到最后一行为止。
      let greeting = await readLine();
      while (/^\d{3}-/.test(greeting)) greeting = await readLine();
      await w.write(enc.encode("EHLO cf-worker-test\r\n"));
      let ehlo = await readLine();
      while (/^\d{3}-/.test(ehlo)) ehlo = await readLine();
      const tlsCapable = /STARTTLS/i.test(ehlo) || true;
      await w.write(enc.encode("STARTTLS\r\n"));
      const ready = await readLine();
      if (!/^220/.test(ready)) throw new Error("STARTTLS refused: " + ready);
      r.releaseLock();
      w.releaseLock();
      r = null;
      w = null;
      const tls = s.startTls({ expectedServerHostname: host });
      const w2 = tls.writable.getWriter();
      const src2 = streamSource(tls.readable.getReader());
      await w2.write(enc.encode("EHLO cf-worker-test\r\n"));
      let after = "";
      for (let i = 0; i < 4096; i++) {
        const b = (await src2.need(1))[0];
        after += String.fromCharCode(b);
        if (after.includes("\r\n")) break;
      }
      return jsonResponse({
        ok: true, mode: "smtp-starttls", ms: Date.now() - t0,
        greeting, ehloCapable: tlsCapable, starttlsReply: ready,
        afterUpgrade: after.trim(),
        verdict: "运行时支持「明文 I/O 之后再 startTls」",
      });
    } catch (e) {
      return jsonResponse({ ok: false, mode: "smtp-starttls", ms: Date.now() - t0, error: String((e && e.message) || e) }, 502);
    }
  }
  // 隔离测试:不经代理,直接以 secureTransport:"starttls" 连 443 再升级。
  // 用来把「我们的 startTls 用法不对」和「代理不支持隧道」区分开。
  if (String(req.egress || "") === "raw-starttls") {
    const host = "gemini.google.com";
    const connect = await resolveConnect();
    if (!connect) return jsonResponse({ ok: false, error: "cloudflare:sockets unavailable" }, 502);
    const t0 = Date.now();
    try {
      const s = connect({ hostname: host, port: 443 }, { secureTransport: "starttls", allowHalfOpen: false });
      const t = s.startTls({ expectedServerHostname: host });
      const r = await httpOverSocket(t, "https://" + host + "/", { method: "GET", headers: { "User-Agent": _UA }, timeoutMs: 25000 });
      const text = (await r.text()).slice(0, 200);
      return jsonResponse({ ok: true, mode: "raw-starttls", status: r.status, ms: Date.now() - t0, body: text });
    } catch (e) {
      return jsonResponse({ ok: false, mode: "raw-starttls", ms: Date.now() - t0, error: String((e && e.message) || e) }, 502);
    }
  }
  const entry = parseEgressSpec(String(req.egress || "").trim());
  if (!entry) return jsonResponse({ error: { message: "bad egress spec" } }, 400);
  let u;
  try { u = new URL(String(req.url || "https://api.ipify.org?format=json")); }
  catch (_) { return jsonResponse({ error: { message: "bad url" } }, 400); }
  // 允许 http:// 是有意的:纯 HTTP 穿过代理隧道(不 startTls),用来把
  // 「隧道本身不通」和「隧道能通但 TLS 阶段失败」这两件事分开。
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !EGRESS_DIAG_HOSTS.has(u.hostname)) {
    return jsonResponse({ error: { message: "url must be https:// and one of: " + [...EGRESS_DIAG_HOSTS].join(", ") } }, 400);
  }
  const c = Object.assign({}, cfg, {
    _egress: entry, _forceEgress: true, do_egress: false, fingerprint_jitter_ms: 0, retry_attempts: 1, log_requests: false,
    _proxyTlsMode: String(req.tls_mode || ""),
  });
  const t0 = Date.now();
  try {
    const r = await httpFetch(u.toString(), { method: "GET", headers: { "User-Agent": _UA }, timeoutMs: 30000, socket: true, cfg: c });
    const text = (await r.text()).slice(0, 600);
    return jsonResponse({ ok: true, egress: entry.label, url: u.toString(), status: r.status, ms: Date.now() - t0, body: text });
  } catch (e) {
    return jsonResponse({ ok: false, egress: entry.label, url: u.toString(), ms: Date.now() - t0, error: String((e && e.message) || e) }, 502);
  }
}
// 导出给本地测试用(Workers 运行时会忽略)。
export {
  MODELS, resolveModel, getConfig, buildPayload, getUrl, buildHeaders, cleanText,
  extractTextsFromLine, extractPartsFromLine, extractResponseText, withImages, extractMarkdownImageUrls, collectGenImages, generate, generateStream,
  messagesToPrompt, parseToolCalls, googleContentsToPrompt, parseGoogleFunctionCalls,
  makeSapisidHash, parseImageUrl, decodeDataUrl, normalizeMimeType, detectImageMime, imageFromPart,
  isPrivateIpv4, isPrivateHostname, validateImageUrl, assertPublicImageHost, fetchRemoteImage, getPageTokens, uploadImage, resolveImages,
  accountPrefix, checkBardError, fetchLatestBl, updateBlIfNeeded, bytesToBase64, clientIp,
  __setConnect, httpFetch, socketHttp, BardError, isBardError,
  refreshSession, readState, saveState, hydrateState, mergeSetCookies, extractSapisid,
  UpstreamHttpError, isUpstreamHttpError, isRetryableUpstream, retryDelayMs, useSocket,
  fileRefCacheKey, pickFingerprint, handleRawDebug,
  syncHash, extractSessionMeta, sessionKey, planTurn, messageHash, renderSlice, renderMessageParts,
  memoryBlock, memoryList, memoryAdd, memoryScope, imageProxyUrl, imgKeyOf, handleImageProxy,
  sseResponse, extractEgressLocation,
  egressCooling, markEgressBad, markEgressGood, upstreamErrorMessage,
  officialImageGenerate, publishImageBytes, imageFallbackViaApi, handleImagesGenerations,
  parseEgressSpec, entryToSpec, defaultEgressPool, scoreEgress, orderEgress, maskProxySpec, socks5Connect, streamSource,
  httpOverSocket, proxyHttpFetch, applyEgressAttempt,
};
