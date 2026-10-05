import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { seal, unseal } from "../src/util";
let mf: Miniflare;
let account = "";
let calls = 0;
let maintenanceCalls = 0;
let rejectRotation = false;
let rejectPage = false;
let lastPrompt = "";
let lastPayload: any[] = [];
let rejectUpstream = false;
let returnMedia = false;
let upstreamGate: Promise<void> | undefined;
const admin = "admin_" + "a".repeat(48),
  apiKey = "sk-" + "b".repeat(48);
const headers = (key = apiKey) => ({
  "Content-Type": "application/json",
  Authorization: "Bearer " + key,
});
async function req(
  path: string,
  body?: any,
  key = apiKey,
  method = body === undefined ? "GET" : "POST",
) {
  return mf.dispatchFetch("https://gateway.test" + path, {
    method,
    headers: headers(key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function wire(text: string) {
  const inner: any[] = Array(43).fill(null);
  inner[1] = ["c_runtime", "r_runtime"];
  inner[4] = [["rc_runtime", [text]]];
  if (returnMedia)
    inner[10] = [
      "https://lh3.googleusercontent.com/gg/fake",
      "https://contribution.usercontent.google.com/download?c=" +
        btoa("response_data"),
    ];
  inner[42] = ["fbb127bbb056c959", null, null, "3.6 Flash", true];
  return (
    JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify(inner)]]) + "\n"
  );
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["tests/harness.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:sockets"],
  });
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-01",
    durableObjects: {
      ACCOUNTS: { className: "TestAccount", useSQLite: true },
    },
    d1Databases: { DB: "db" },
    bindings: {
      UPSTREAM_TRANSPORT: "fetch",
      ADMIN_KEY: admin,
      API_KEY: apiKey,
      ENCRYPTION_KEY: btoa("k".repeat(32)),
      ACCOUNT_LOCATION_HINT: "auto",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/RotateCookies") {
        maintenanceCalls++;
        if (rejectRotation)
          return new Response("unauthorized", { status: 401 });
        const ticket = (await request.text()).startsWith("[000,");
        return new Response("[]", {
          headers: {
            "set-cookie": `${ticket ? "__Secure-1PSIDTS" : "SIDCC"}=PRIVATE_RENEWED; Domain=.google.com; Path=/; Secure`,
          },
        });
      }
      if (url.pathname === "/RotateCookiesPage")
        return new Response("init('123456789123',658.0,0.0,0.0,600.0)");
      if (["/app", "/spark"].includes(url.pathname) && rejectPage)
        return new Response(null, {
          status: 302,
          headers: { location: "https://accounts.google.com/ServiceLogin" },
        });
      if (["/app", "/spark"].includes(url.pathname))
        return new Response(
          '"SNlM0e":"xsrf_test","cfb2h":"boq_test","qKIAYe":"push_test","Ylro7b":"pctx_test"',
        );
      if (url.pathname.includes("StreamGenerate")) {
        calls++;
        if (upstreamGate) await upstreamGate;
        if (rejectUpstream) return new Response("blocked", { status: 429 });
        const b = new URLSearchParams(await request.text());
        lastPayload = JSON.parse(JSON.parse(b.get("f.req")!)[1]);
        lastPrompt = lastPayload[0][0];
        if (lastPayload[49] === 40) {
          const event = (obj: any) =>
            JSON.stringify([
              [
                "wrb.fr",
                "StreamGenerate",
                JSON.stringify([
                  null,
                  ["c_runtime", "r_runtime"],
                  { 44: true, ...obj },
                ]),
              ],
            ]) + "\n";
          return new Response(
            event({ 7: ["PRIVATE_SPARK_PLAN"] }) +
              wire("SPARK_OK") +
              event({ 26: "PRIVATE_SPARK_CURSOR" }) +
              event({ 46: ["c_runtime", ""] }),
          );
        }
        return new Response(
          ")]}'\n42\n" + wire("Hello") + wire("Hello runtime"),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.includes("batchexecute"))
        return new Response(wire("history"));
      if (url.hostname === "lh3.googleusercontent.com")
        return new Response("IMAGE_BYTES", {
          headers: { "content-type": "image/png" },
        });
      return new Response("not mocked", { status: 404 });
    },
  });
  const db = await mf.getD1Database("DB");
  const schema = (
    await readFile("migrations/0001_initial.sql", "utf8")
  ).replace(/^\uFEFF/, "");
  for (const s of schema
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean))
    await db.prepare(s).run();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
describe("actual workerd + SQLite DO + D1 integration", () => {
  it("fails closed without authentication", async () => {
    const r = await mf.dispatchFetch("https://gateway.test/v1/models");
    expect(r.status).toBe(401);
  });
  it("keeps the Worker and static-asset CSP aligned for blob media previews", async () => {
    const r = await mf.dispatchFetch("https://gateway.test/v1/models");
    const staticHeaders = await readFile("public/_headers", "utf8");
    const csp = staticHeaders.match(/Content-Security-Policy: (.+)/)![1].trim();
    expect(r.headers.get("content-security-policy")).toBe(csp);
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
  });
  it("separates admin and inference credentials", async () => {
    expect((await req("/admin/accounts")).status).toBe(401);
    expect((await req("/v1/models", undefined, admin)).status).toBe(401);
  });
  it("creates an encrypted account and lists only metadata", async () => {
    const r = await req(
      "/admin/accounts",
      {
        label: "test account",
        cookie: "__Secure-1PSID=PRIVATE_COOKIE",
        xsrf: "x",
        bl: "boq_test",
      },
      admin,
    );
    expect(r.status).toBe(201);
    account = ((await r.json()) as any).id;
    const list = await (await req("/admin/accounts", undefined, admin)).text();
    expect(list).toContain("test account");
    expect(list).not.toContain("PRIVATE_COOKIE");
    const state = (await (
      await req(`/admin/accounts/${account}/status`, undefined, admin)
    ).json()) as any;
    expect(state.configured).toBe(true);
  });
  it("creates and revokes independent API keys", async () => {
    const create = (await (
      await req("/admin/keys", { name: "client" }, admin)
    ).json()) as any;
    expect(create.key).toMatch(/^sk-/);
    expect((await req("/v1/models", undefined, create.key)).status).toBe(200);
    const list = await (await req("/admin/keys", undefined, admin)).text();
    expect(list).not.toContain(create.key);
    await req("/admin/keys/" + create.id, undefined, admin, "DELETE");
    expect((await req("/v1/models", undefined, create.key)).status).toBe(401);
  });
  it("generates, persists metadata, and isolates sessions by API key", async () => {
    const r = await req("/v1/chat/completions", {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.choices[0].message.content).toBe("Hello runtime");
    expect(body.gemini.actual_model).toBe("3.6 Flash");
    const session = r.headers.get("x-session-id");
    expect(session).toMatch(/^acc_.*\.s_/);
    const other = (await (
      await req("/admin/keys", { name: "other" }, admin)
    ).json()) as any;
    const wrong = await req(
      "/v1/chat/completions",
      {
        model: "gemini-3.6-flash",
        session_id: session,
        messages: [{ role: "user", content: "steal" }],
      },
      other.key,
    );
    expect(wrong.status).toBe(404);
    const next = await req("/v1/chat/completions", {
      model: "gemini-3.6-flash",
      session_id: session,
      messages: [{ role: "user", content: "only new turn" }],
    });
    expect(next.status).toBe(200);
    await next.text();
    expect(lastPrompt).toContain("only new turn");
    expect(lastPrompt).not.toContain("PRIVATE_PROMPT");
    const logs = await (await req("/admin/requests", undefined, admin)).text();
    expect(logs).not.toContain("PRIVATE_PROMPT");
    expect(logs).not.toContain("Hello runtime");
  });
  it("streams true cumulative deltas and terminal DONE", async () => {
    const r = await req("/v1/chat/completions", {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const s = await r.text();
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(s).toContain('"content":"Hello"');
    expect(s).toContain('"content":" runtime"');
    expect(s).toContain("data: [DONE]");
    expect(s).not.toContain("PRIVATE_COOKIE");
  });
  it("emits a complete Responses lifecycle", async () => {
    const r = await req("/v1/responses", {
      model: "gemini-3.6-flash",
      input: "hello",
      stream: true,
    });
    const s = await r.text();
    for (const type of [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
      expect(s).toContain("event: " + type);
  });
  it("never turns an upstream rejection into a successful answer", async () => {
    rejectUpstream = true;
    const r = await req("/v1/chat/completions", {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "fail" }],
    });
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error.code).toBe("upstream_http_429");
    rejectUpstream = false;
  });
});

async function freshAccount() {
  const db = await mf.getD1Database("DB");
  const existing = await db.prepare("SELECT id FROM accounts").all();
  for (const row of existing.results)
    await req("/admin/accounts/" + row.id, undefined, admin, "DELETE");
  const r = await req(
    "/admin/accounts",
    {
      label: "isolated",
      cookie: "__Secure-1PSID=PRIVATE_COOKIE",
      xsrf: "x",
      bl: "b",
    },
    admin,
  );
  expect(r.status).toBe(201);
  const id = ((await r.json()) as any).id;
  const ns = await mf.getDurableObjectNamespace("ACCOUNTS");
  return {
    id,
    stub: ns.get(ns.idFromName(id)),
    objectId: ns.idFromName(id).toString(),
    db,
  };
}
async function storage(stub: any, body: any = {}) {
  return (await (
    await stub.fetch("https://test/test/storage", {
      method: "POST",
      body: JSON.stringify(body),
    })
  ).json()) as any;
}
describe("state lifecycle in workerd", () => {
  it("counts daily statistics atomically without any Cron trigger", async () => {
    const db = await mf.getD1Database("DB");
    const count = await db
      .prepare("SELECT COUNT(*) AS count FROM requests")
      .first();
    const stats = await db
      .prepare("SELECT SUM(requests) AS count FROM daily_stats")
      .first();
    expect(stats?.count).toBe(count?.count);
    expect(Number(stats?.count)).toBeGreaterThan(0);
  });
  it("emits response.failed rather than a false completion on SSE rejection", async () => {
    await freshAccount();
    rejectUpstream = true;
    try {
      const r = await req("/v1/responses", { input: "fail", stream: true });
      const text = await r.text();
      expect(text).toContain("event: response.failed");
      expect(text).not.toContain("event: response.completed");
    } finally {
      rejectUpstream = false;
    }
  });
  it("rejects forged resumptions, encrypts session state, and cleans old rows using alarms", async () => {
    const { id, stub, db } = await freshAccount();
    const forged = await req("/v1/chat/completions", {
      messages: [{ role: "user", content: "x" }],
      session_id: id + ".s_" + "f".repeat(32),
    });
    expect(forged.status).toBe(404);
    const r = await req("/v1/chat/completions", {
      messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
    });
    await r.text();
    const rows = await storage(stub);
    expect(rows.credentials).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_COOKIE");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_PROMPT");
    expect(Object.keys(rows).some((k) => k.startsWith("session:"))).toBe(true);
    expect(Object.keys(rows).some((k) => k.startsWith("known:"))).toBe(false);
    await db
      .prepare(
        "INSERT INTO requests(id,created_at,key_id,endpoint,model,status,duration_ms) VALUES('expired',1,'k','chat','m',200,1)",
      )
      .run();
    await storage(stub, {
      put: { "known:legacy": true },
      delete: "maintenanceDay",
    });
    await stub.fetch("https://test/test/alarm");
    expect(
      await db.prepare("SELECT id FROM requests WHERE id='expired'").first(),
    ).toBeNull();
    expect((await storage(stub))["known:legacy"]).toBeUndefined();
  });
  it("returns actual visible media failure in SSE, without claiming success", async () => {
    await freshAccount();
    const r = await req("/v1/chat/completions", {
      model: "gemini-image",
      stream: true,
      messages: [{ role: "user", content: "draw" }],
    });
    const text = await r.text();
    expect(text).toContain("event: error");
    expect(text).toContain("media_unavailable");
    expect(text).toContain("Upstream reply: Hello runtime");
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain('"finish_reason":"stop"');
  });
  it("returns downloadable artifacts for the chat SSE image route", async () => {
    await freshAccount();
    returnMedia = true;
    try {
      const r = await req("/v1/chat/completions", {
        model: "gemini-image",
        stream: true,
        messages: [{ role: "user", content: "画一只可爱小猫" }],
      });
      const text = await r.text();
      expect(lastPayload[49]).toBe(14);
      expect(text).toContain("[DONE]");
      expect(text).toContain('"artifacts":[{"id":"acc_');
      expect(text).not.toContain("https://lh3.googleusercontent.com");
      const id = JSON.parse(
        text
          .split("\n")
          .find((line) => line.includes('"artifacts"'))!
          .slice(6),
      ).gemini.artifacts[0].id;
      expect(await (await req(`/v1/files/${id}/content`)).text()).toBe(
        "IMAGE_BYTES",
      );
    } finally {
      returnMedia = false;
    }
  });
  it("isolates artifact access and drives video completion with a DO alarm", async () => {
    const { stub } = await freshAccount();
    returnMedia = true;
    try {
      const image = await req("/v1/images/generations", { prompt: "draw" });
      expect(image.status).toBe(200);
      const url = ((await image.json()) as any).data[0].url;
      const path = new URL(url).pathname;
      const stranger = (await (
        await req("/admin/keys", { name: "stranger" }, admin)
      ).json()) as any;
      expect((await req(path, undefined, stranger.key)).status).toBe(404);
      expect(await (await req(path)).text()).toBe("IMAGE_BYTES");
      const v = await req("/v1/videos", { prompt: "PRIVATE_VIDEO_PROMPT" });
      expect(v.status).toBe(202);
      const job = (await v.json()) as any;
      expect(
        (await req("/v1/videos/" + job.id, undefined, stranger.key)).status,
      ).toBe(404);
      const before = await storage(stub);
      expect(JSON.stringify(before)).not.toContain("PRIVATE_VIDEO_PROMPT");
      await stub.fetch("https://test/test/alarm");
      const state = (await (await req("/v1/videos/" + job.id)).json()) as any;
      expect(state.status).toBe("completed");
      expect((await storage(stub)).activeVideo).toBeUndefined();
    } finally {
      returnMedia = false;
    }
  });
});

describe("concurrency and ambiguous jobs", () => {
  it("does not partially disable an account while a generation is in flight", async () => {
    const { id, db } = await freshAccount();
    let release!: () => void;
    upstreamGate = new Promise<void>((r) => {
      release = r;
    });
    const before = calls;
    const pending = req("/v1/chat/completions", {
      messages: [{ role: "user", content: "slow" }],
    });
    try {
      for (let i = 0; i < 100 && calls === before; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(before + 1);
      const disabled = await req(
        "/admin/accounts/" + id,
        { enabled: false },
        admin,
        "PUT",
      );
      expect(disabled.status).toBe(429);
      expect(
        (
          await db
            .prepare("SELECT enabled FROM accounts WHERE id=?")
            .bind(id)
            .first()
        )?.enabled,
      ).toBe(1);
      const busy = await req("/v1/chat/completions", {
        messages: [{ role: "user", content: "overlap" }],
      });
      expect(busy.status).toBe(429);
    } finally {
      upstreamGate = undefined;
      release();
      await (await pending).text();
    }
  });
  it.each(["submitting", "expired"])(
    "never resubmits a %s video job",
    async (kind) => {
      const { stub, objectId } = await freshAccount();
      const r = await req("/v1/videos", { prompt: "PRIVATE_VIDEO" });
      const video = (await r.json()) as any;
      const jobKey = "video:" + video.id.split(".")[1];
      const rows = await storage(stub);
      const secret = btoa("k".repeat(32));
      const aad = objectId + ":" + jobKey;
      const job = await unseal<any>(rows[jobKey], secret, aad);
      if (kind === "submitting") job.stage = "submitting";
      else job.created_at = Math.floor(Date.now() / 1000) - 601;
      await storage(stub, { put: { [jobKey]: await seal(job, secret, aad) } });
      const before = calls;
      await stub.fetch("https://test/test/alarm");
      expect(calls).toBe(before);
      const state = (await (await req("/v1/videos/" + video.id)).json()) as any;
      expect(state.status).toBe("failed");
      expect(state.error.code).toBe(
        kind === "submitting" ? "submission_uncertain" : "video_timeout",
      );
      const after = await storage(stub);
      const stored = await unseal<any>(after[jobKey], secret, aad);
      expect(stored.input).toBeUndefined();
      expect(after.activeVideo).toBeUndefined();
    },
  );
});

describe("Spark persisted sessions in workerd", () => {
  it("encrypts task cursor, resumes slot 71 and never exposes control events", async () => {
    const { stub, objectId } = await freshAccount();
    const body = {
      model: "gemini-spark",
      messages: [{ role: "user", content: "SPARK_OK" }],
    };
    const first = await req("/v1/chat/completions", body);
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(JSON.parse(firstText).choices[0].message.content).toBe("SPARK_OK");
    expect(firstText).not.toContain("PRIVATE_SPARK");
    expect(lastPayload[71]).toBeNull();
    const rows = await storage(stub);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_SPARK");
    const sessionKey = Object.keys(rows).find((k) => k.startsWith("session:"))!;
    const saved = await unseal<any>(
      rows[sessionKey],
      btoa("k".repeat(32)),
      objectId + ":" + sessionKey,
    );
    expect(saved.sparkContext).toEqual({
      conversationId: "c_runtime",
      cursor: "PRIVATE_SPARK_CURSOR",
    });
    expect(saved.metadata[2]).toBe("rc_runtime");
    const second = await req("/v1/chat/completions", {
      ...body,
      session_id: first.headers.get("x-session-id"),
      stream: true,
    });
    const stream = await second.text();
    expect(stream).toContain('"content":"SPARK_OK"');
    expect(stream).toContain("data: [DONE]");
    expect(stream).not.toContain("PRIVATE_SPARK");
    expect(lastPayload[71]).toEqual([
      "c_runtime",
      null,
      null,
      null,
      null,
      null,
      null,
      "PRIVATE_SPARK_CURSOR",
    ]);
    expect(lastPayload[2]).toBeNull();
    expect(lastPayload[83]).toBeNull();
    const before = calls;
    const wrong = await req("/v1/chat/completions", {
      ...body,
      model: "gemini-3.8-flash",
      session_id: first.headers.get("x-session-id"),
    });
    expect(wrong.status).toBe(400);
    expect(calls).toBe(before);
  });
});

describe("login maintenance alarm lifecycle", () => {
  it("schedules first import promptly, keeps inference health separate, honors persisted due time", async () => {
    const { id, stub, db, objectId } = await freshAccount();
    const alarm = async () =>
      ((await (await stub.fetch("https://test/test/alarm-at")).json()) as any)
        .at;
    expect(await alarm()).toBeLessThanOrEqual(Date.now() + 16000);
    await db
      .prepare(
        "UPDATE accounts SET health='inference_error',cooldown_until=123 WHERE id=?",
      )
      .bind(id)
      .run();
    const before = maintenanceCalls;
    await stub.fetch("https://test/test/alarm");
    const status = (await (
      await req(`/admin/accounts/${id}/status`, undefined, admin)
    ).json()) as any;
    expect(status.maintenance.status).toBe("healthy");
    expect(
      status.maintenance.nextAttemptAt - status.maintenance.lastCompletedAt,
    ).toBe(600);
    expect(await alarm()).toBeGreaterThan(Date.now() + 590000);
    expect(await alarm()).toBeLessThan(Date.now() + 601000);
    const row = await db
      .prepare(
        "SELECT health,cooldown_until,last_refresh FROM accounts WHERE id=?",
      )
      .bind(id)
      .first();
    expect(row?.health).toBe("inference_error");
    expect(row?.cooldown_until).toBe(123);
    expect(row?.last_refresh).toBe(status.refreshed_at);
    const raw = await storage(stub);
    expect(JSON.stringify(raw)).not.toContain("PRIVATE_RENEWED");
    const creds = await unseal<any>(
      raw.credentials,
      btoa("k".repeat(32)),
      objectId,
    );
    expect(creds.maintenance.nextAttemptAt).toBe(
      status.maintenance.nextAttemptAt,
    );
    await stub.fetch("https://test/test/alarm");
    expect(maintenanceCalls - before).toBe(2);
    const retry = await req(`/admin/accounts/${id}/refresh`, {}, admin);
    expect(retry.status).toBe(429);
    expect(Number(retry.headers.get("retry-after"))).toBeGreaterThan(590);
    expect(await retry.text()).toContain("refresh_backoff");
    expect(maintenanceCalls - before).toBe(2);
  });
  it("reports manual failure honestly, schedules durable backoff and clears stale token age", async () => {
    const { id, stub } = await freshAccount();
    rejectRotation = true;
    rejectPage = true;
    try {
      const r = (await (
        await req(`/admin/accounts/${id}/refresh`, {}, admin)
      ).json()) as any;
      expect(r.ok).toBe(false);
      expect(r.renewed).toBe(false);
      expect(r.maintenance.status).toBe("reimport_required");
      expect(r.maintenance.nextAttemptAt - r.maintenance.lastCompletedAt).toBe(
        1800,
      );
      const state = (await (
        await req(`/admin/accounts/${id}/status`, undefined, admin)
      ).json()) as any;
      expect(state.tokens_at).toBe(0);
      const before = maintenanceCalls;
      await stub.fetch("https://test/test/alarm");
      expect(maintenanceCalls).toBe(before);
      const alarm = (await (
        await stub.fetch("https://test/test/alarm-at")
      ).json()) as any;
      expect(alarm.at).toBeGreaterThan(Date.now() + 1790000);
    } finally {
      rejectRotation = false;
      rejectPage = false;
    }
  });
  it("disabled account makes no maintenance requests and keeps daily cleanup alarm", async () => {
    const { id, stub } = await freshAccount();
    await req(`/admin/accounts/${id}`, { enabled: false }, admin, "PUT");
    const before = maintenanceCalls;
    await stub.fetch("https://test/test/alarm");
    expect((await req(`/admin/accounts/${id}/refresh`, {}, admin)).status).toBe(
      503,
    );
    expect(maintenanceCalls).toBe(before);
    const alarm = (await (
      await stub.fetch("https://test/test/alarm-at")
    ).json()) as any;
    expect(alarm.at).toBeGreaterThan(Date.now() + 86390000);
  });
});
