export default {
  async fetch(request, env) {
    const target = env.TARGET || "https://gemini-web2api.shigatsuki.workers.dev";
    const url = new URL(request.url);
    const upstream = target + url.pathname + url.search;

    const headers = new Headers();
    const pass = ["authorization", "x-api-key", "content-type", "accept", "user-agent"];
    for (const name of pass) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }

    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }
    try {
      const resp = await fetch(upstream, init);
      const out = new Headers(resp.headers);
      out.delete("content-encoding");
      out.set("cache-control", "no-store");
      return new Response(resp.body, { status: resp.status, headers: out });
    } catch (e) {
      return new Response("proxy error: " + (e && e.message || e), { status: 502 });
    }
  },
};
