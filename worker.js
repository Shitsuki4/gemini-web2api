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
const VERSION = "1.5.0-worker";
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
  DEFAULT_MODEL: "gemini-3.6-flash",
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
};
// ─── 模型 ────────────────────────────────────────────────────────────────
// MODE_CATEGORY 枚举(来自 Gemini 前端 JS):
//   1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE
const MODELS = {
  "gemini-3.7-flash": { mode: 1, think: 4, desc: "Latest all-around model (Gemini 3.7 Flash)" },
  "gemini-3.6-flash": { mode: 1, think: 4, desc: "All-around model (Gemini 3.6 Flash)" },
  "gemini-3.5-flash": { mode: 1, think: 4, desc: "Alias for gemini-3.6-flash (backend upgraded)" },
  "gemini-3.5-flash-thinking": { mode: 2, think: 0, desc: "Deep thinking mode, longest output (~20k chars)" },
  "gemini-3.1-pro": { mode: 3, think: 4, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced": { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto": { mode: 4, think: 4, desc: "Auto model selection" },
  "gemini-3.5-flash-thinking-lite": { mode: 5, think: 0, desc: "Dynamic thinking with adaptive depth" },
  "gemini-flash-lite": { mode: 6, think: 4, desc: "Lightweight fast model" },
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
  const cookieRaw = env.GEMINI_COOKIES || env.COOKIE_STRING || env.GEMINI_COOKIE || CONFIG.GEMINI_COOKIES || CONFIG.GEMINI_COOKIE || "";
  const cookieEntries = splitEnvList(cookieRaw).map(parseCookieEntry).filter((x) => x.cookie);
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
    _env: env,
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
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
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
    headers["x-goog-ext-525001261-jspb"] =
      '[1,null,null,null,"56fdd199312815e2",null,null,0,[4,5,6,8,4,5,6,8],null,null,2,null,null,1,1,"' +
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
// 统一上游入口:socket 优先,失败/不可用则回退 fetch。返回类 Response 对象。
// roundRobin>1 时:每次请求在多个 socket 连接间轮换,利用 CF 出口 IP 池
// (不同 TCP 连接常落到不同出口),降低被 Google 单点风控(1060)的概率。
async function httpFetch(url, { method = "GET", headers = {}, body, timeoutMs = 180000, socket = true, redirect, cfg } = {}) {
  // Prefer a regional Durable Object for Gemini origin calls. The ordinary
  // Worker egress can land in Hong Kong, where image creation is unavailable;
  // the DO locationHint gives us a stable European/US exit.
  if (cfg && cfg.do_egress !== false && cfg._env && cfg._env.EGRESS && isGeminiOrigin(url, cfg)) {
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
    const bytes = new TextEncoder().encode(decodeURIComponent(data));
    return { b64: bytesToBase64(bytes), mime };
  } catch (_) { return null; }
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
/** 解析单行 `wrb.fr`,返回 { texts, images }。 */
function extractPartsFromLine(line) {
  const empty = { texts: [], images: [] };
  if (!line.includes('"wrb.fr"') || line.length < 200) return empty;
  try {
    const arr = JSON.parse(line);
    const innerStr = arr[0][2];
    if (!innerStr || innerStr.length < 50) return empty;
    const inner = JSON.parse(innerStr);
    if (!(Array.isArray(inner) && inner.length > 4 && inner[4])) return empty;
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
    return { texts, images };
  } catch (_) {
    return empty;
  }
}
/** 兼容旧签名:只要文本。 */
function extractTextsFromLine(line) {
  return extractPartsFromLine(line).texts;
}
/** 把生成图片拼成 Markdown(OpenAI 兼容客户端基本都能渲染)。 */
function withImages(text, images) {
  if (!images || !images.length) return text || "";
  const md = images.map((im) => `![${im.name || "generated image"}](${im.url})`).join("\n");
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
function extractResponseText(raw) {
  checkBardError(raw);
  let lastText = "";
  const images = [];
  for (const line of raw.split("\n")) {
    const parsed = extractPartsFromLine(line);
    for (const t of parsed.texts) {
      if (t.length > lastText.length) lastText = t;
    }
    for (const im of parsed.images) {
      if (!images.some((x) => x.url === im.url)) images.push(im);
    }
  }
  return withImages(cleanText(lastText), images);
}
/** 非流式生成(带重试)。返回最终的响应文本。 */
async function generate(cfg, prompt, modelId, thinkMode, extra, fileRefs) {
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs || null, extra, cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
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
      const text = extractResponseText(raw);
      // 非 2xx / 机器人校验页:一律当成「出口不可信」,交给上层换出口重试
      if (!resp.ok) throw new UpstreamHttpError(resp.status, raw.slice(0, 400));
      if (!text) {
        if (/recaptcha|sorry\/index|unusual traffic|<!doctype html/i.test(raw)) {
          throw new UpstreamHttpError(resp.status, raw.slice(0, 400));
        }
        log(cfg, `upstream status=${resp.status} rawLen=${raw.length} parsedLen=0 snippet=${JSON.stringify(raw.slice(0, 200))}`);
      }
      return text;
    } catch (e) {
      lastErr = e;
      // 1060 / 429 这类出口问题不在本函数里死磕:立刻上抛,由 berrRetry 换出口
      if (isRetryableUpstream(e)) throw e;
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
        const text = extractResponseText(await resp.text());
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
        for (const im of parsed.images) {
          if (emittedImages.has(im.url)) continue;
          emittedImages.add(im.url);
          const md = `![${im.name || "generated image"}](${im.url})`;
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
        await sleep(retryDelayMs(cfg, attempt));
        continue;
      }
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
            images.push(img);
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
  return [parts.filter((p) => p).join("\n\n"), images];
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
 */
function sseResponse(producer) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (s) => controller.enqueue(encoder.encode(s));
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
// POST /v1/chat/completions
async function handleChat(req, cfg, request) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);
  const tools = req.tools;
  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const [prompt0, images] = messagesToPrompt(req.messages || [], tools, toolChoice);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty prompt" } }, 400);
  const stream = req.stream || false;
  const cid = `chatcmpl-${randHex(12)}`;
  if (stream && (!tools || toolChoice === "none")) {
    return sseResponse(async (write) => {
      let got = false;
      let errMsg = "";
      const chunk = (delta, finish) => write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      chunk({ role: "assistant" }, null); // 严格 OpenAI SDK 兼容:首块带 role
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs)) {
          got = true;
          chunk({ content: delta }, null);
        }
      } catch (e) {
        errMsg = `⚠️ upstream error: ${e}`;
      } finally {
        if (!got) {
          const note = errMsg || EMPTY_UPSTREAM_MSG;
          log(cfg, `chat stream produced no content -> ${note}`);
          chunk({ content: note }, null); // 让客户端看到原因,而非空白
        }
        chunk({}, "stop");
        write("data: [DONE]\n\n");
      }
    });
  }
  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
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
    });
  }
  return jsonResponse({
    id: cid, object: "chat.completion", created: nowSec(), model: rm.name,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: {
      prompt_tokens: tokenEst(prompt),
      completion_tokens: tokenEst(text),
      total_tokens: tokenEst(prompt) + tokenEst(text),
    },
  });
}
// 从请求头提取客户端 IP(Cloudflare 环境用 cf-connecting-ip)。
function clientIp(request) {
  if (!request || !request.headers) return "";
  return request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "";
}
// 每个 isolate 内的滑动窗口限流。Cloudflare 会在多个 isolate 间分担请求,
// 因此它是近似限流,不依赖 KV/D1,避免每个 API 调用都增加一次存储写入。
const RATE_LIMIT_STORE = new Map();
function checkRateLimit(clientIP, cfg) {
  if (!cfg || !cfg.rate_limit_enabled) return true;
  const now = Date.now();
  const windowMs = Math.max(1, cfg.rate_limit_window) * 1000;
  const key = clientIP || "0.0.0.0";
  const hits = (RATE_LIMIT_STORE.get(key) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= Math.max(1, cfg.rate_limit_max)) return false;
  hits.push(now);
  RATE_LIMIT_STORE.set(key, hits);
  // 低频清理冷 IP,防止 isolate 长生命周期内 Map 无限增长。
  if (Math.random() < 0.05) {
    for (const [k, values] of RATE_LIMIT_STORE) {
      const valid = values.filter((ts) => now - ts < windowMs);
      if (valid.length) RATE_LIMIT_STORE.set(k, valid);
      else RATE_LIMIT_STORE.delete(k);
    }
  }
  return true;
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
  const [prompt0, images] = messagesToPrompt(messages, tools, toolChoice);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty input" } }, 400);
  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }
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
    });
  }
  return jsonResponse({ id: rid, object: "response", created_at: nowSec(), status: "completed", model: rm.name, output, usage });
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
    });
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
    return sseResponse(async (write) => { write(`data: ${JSON.stringify(responseObj)}\n\n`); });
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
async function doEgressFetch(cfg, url, init) {
  const env = cfg && cfg._env;
  if (!env || !env.EGRESS) return null;
  const hints = egressHints(cfg);
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
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders(), "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*" },
      });
    }
    cfg.client_ip = clientIp(request);
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
            ts: Date.now(),
          });
        }
        if (path === "/debug") {
          return await handleDebug(cfg, request);
        }
        if (path === "/admin/state") {
          if (!adminOk(request, url, cfg)) return jsonResponse({ error: { message: "admin key required" } }, 401);
          return await handleAdminState(cfg, env, url);
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
        if (path === "/v1/debug/raw") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleRawDebug(req, cfg);
        }
        if (path === "/v1/chat/completions") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await berrRetry(() => handleChat(req, cfg, request));
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
      for (const n of ["authorization", "x-api-key", "content-type", "accept", "user-agent"]) {
        const v = request.headers.get(n);
        if (v) headers.set(n, v);
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
// 原样返回上游 StreamGenerate 响应(排查 1060 / 图片结构时用)
async function handleRawDebug(req, cfg) {
  const prompt = String(req.prompt || "Reply with one word: PONG");
  const modelName = String(req.model || cfg.default_model);
  const m = resolveModel(modelName, cfg.default_model);
  if (m.error) return jsonResponse({ error: m.error }, 400);
  const body = buildPayload(prompt, m.modeId, m.thinkMode, null, m.extra, cfg);
  const headers = await buildHeaders(cfg);
  const r = await httpFetch(getUrl(cfg), { method: "POST", headers, body, timeoutMs: Number(req.timeout_ms) || 120000, socket: cfg.upstream_socket, cfg });
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
};
