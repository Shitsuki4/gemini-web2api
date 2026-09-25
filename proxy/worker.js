// 逐跳 / 由 fetch 自己决定的头,不能原样转发。
// 其余全部转发 —— 白名单方式会把 X-Session-Id、X-Memory-Scope 这类自定义头
// 悄悄吃掉,导致会话续聊和记忆 scope 静默失效。
const SKIP = new Set([
  "host", "content-length", "connection", "keep-alive", "transfer-encoding",
  "upgrade", "expect", "te", "trailer", "accept-encoding", "proxy-authorization",
]);

export default {
  async fetch(request, env) {
    const target = env.TARGET || "https://gemini-web2api.shigatsuki.workers.dev";
    const url = new URL(request.url);
    const upstream = target + url.pathname + url.search;

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      if (SKIP.has(lower) || lower.startsWith("cf-")) continue;
      headers.set(name, value);
    }

    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }
    try {
      const resp = await fetch(upstream, init);
      const out = new Headers(resp.headers);
      out.delete("content-encoding");
      // 默认给 API 响应打 no-store;但 /img/* 是图片,上游已经给了 Cache-Control,
      // 覆盖掉会让图片无法缓存(每次都穿透到 R2)。
      if (!out.get("cache-control")) out.set("cache-control", "no-store");
      return new Response(resp.body, { status: resp.status, headers: out });
    } catch (e) {
      return new Response("proxy error: " + (e && e.message || e), { status: 502 });
    }
  },
};
