import type {
  Env,
  Credentials,
  GenerateInput,
  Session,
  Result,
  Artifact,
} from "./types";
import {
  ApiError,
  boundedInt,
  errorResponse,
  json,
  now,
  readJson,
  seal,
  sha256,
  uid,
  unseal,
} from "./util";
import { GeminiClient, validateCookie } from "./gemini/client";
import { delta } from "./gemini/protocol";
import { chatResponse, finishResult, responsesResponse } from "./api";
import { eventStream, type EventSink } from "./sse";
interface VideoJob {
  id: string;
  owner: string;
  model: string;
  status: string;
  created_at: number;
  updated_at: number;
  stage: string;
  input?: GenerateInput;
  inputChars?: number;
  cid?: string;
  artifact?: string;
  error?: { code: string; message: string };
}
export class GeminiAccount implements DurableObject {
  private busy = false;
  private creds?: Credentials;
  private accountId = "";
  private enabled = true;
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    state.blockConcurrencyWhile(() => this.load());
  }
  private async load() {
    if (this.creds) return;
    this.accountId = (await this.state.storage.get<string>("accountId")) || "";
    this.enabled = (await this.state.storage.get<boolean>("enabled")) !== false;
    const encrypted = await this.state.storage.get<string>("credentials");
    if (encrypted)
      this.creds = await unseal<Credentials>(
        encrypted,
        this.env.ENCRYPTION_KEY,
        this.state.id.toString(),
      );
  }
  private async save() {
    if (this.creds)
      await this.state.storage.put(
        "credentials",
        await seal(
          this.creds,
          this.env.ENCRYPTION_KEY,
          this.state.id.toString(),
        ),
      );
  }
  private client(signal: AbortSignal) {
    if (!this.creds)
      throw new ApiError(
        503,
        "account_unconfigured",
        "Account has no imported cookie",
      );
    return new GeminiClient(this.creds, () => this.save(), signal);
  }
  private timeout(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(
      boundedInt(this.env.REQUEST_TIMEOUT_MS, 180000, 10000, 240000),
    );
    if (!signal) return timeout;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted || timeout.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      timeout.addEventListener("abort", abort, { once: true });
    }
    return controller.signal;
  }
  private async privatePut(key: string, value: unknown) {
    await this.state.storage.put(
      key,
      await seal(
        value,
        this.env.ENCRYPTION_KEY,
        this.state.id.toString() + ":" + key,
      ),
    );
  }
  private async privateGet<T>(key: string) {
    const s = await this.state.storage.get<string>(key);
    return s
      ? unseal<T>(
          s,
          this.env.ENCRYPTION_KEY,
          this.state.id.toString() + ":" + key,
        )
      : undefined;
  }
  private async schedule(delay = 900000) {
    const at = Date.now() + delay,
      old = await this.state.storage.getAlarm();
    if (old === null || old > at) await this.state.storage.setAlarm(at);
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      await this.load();
      if (path === "/configure") {
        if (this.busy)
          throw new ApiError(429, "account_busy", "Account is busy");
        this.busy = true;
        try {
          const b = await readJson(request, 40000);
          this.accountId = b.accountId;
          this.creds = {
            cookie: validateCookie(b.cookie),
            userAgent:
              typeof b.userAgent === "string" &&
              b.userAgent.length < 512 &&
              !/[\r\n]/.test(b.userAgent)
                ? b.userAgent
                : undefined,
            xsrf: typeof b.xsrf === "string" ? b.xsrf : undefined,
            bl: typeof b.bl === "string" ? b.bl : undefined,
            pushId: typeof b.pushId === "string" ? b.pushId : undefined,
            pctx: typeof b.pctx === "string" ? b.pctx : undefined,
            fetchedAt: b.xsrf && b.bl ? now() : 0,
          };
          await this.state.storage.put("accountId", this.accountId);
          await this.save();
          await this.schedule(60000);
          return json({ ok: true, imported: true });
        } finally {
          this.busy = false;
        }
      }
      if (path === "/enabled") {
        if (this.busy)
          throw new ApiError(429, "account_busy", "Account is busy");
        this.busy = true;
        try {
          const b = await readJson(request);
          this.enabled = b.enabled === true;
          await this.state.storage.put("enabled", this.enabled);
          await this.schedule(this.enabled ? 60000 : 86400000);
          return json({ ok: true });
        } finally {
          this.busy = false;
        }
      }
      if (path === "/delete") {
        if (this.busy)
          throw new ApiError(429, "account_busy", "Account is busy");
        this.busy = true;
        try {
          await this.state.storage.deleteAlarm();
          await this.state.storage.deleteAll();
          this.creds = undefined;
          this.enabled = false;
          this.accountId = "";
          return json({ ok: true });
        } finally {
          this.busy = false;
        }
      }
      if (path === "/status")
        return json({
          configured: !!this.creds,
          busy: this.busy,
          enabled: this.enabled,
          tokens_at: this.creds?.fetchedAt || 0,
          refreshed_at: this.creds?.refreshedAt || 0,
          cookie_names:
            this.creds?.cookie.split(";").map((x) => x.trim().split("=")[0]) ||
            [],
        });
      if (path.startsWith("/files/")) {
        const owner = request.headers.get("x-owner") || "";
        const item = await this.privateGet<Artifact>("file:" + path.slice(7));
        if (!item || item.owner !== owner || item.expiresAt < now())
          throw new ApiError(404, "not_found", "File not found or expired");
        return await this.client(this.timeout(request.signal)).download(
          item.url,
          request.headers.get("range"),
        );
      }
      if (path.startsWith("/videos/"))
        return await this.getVideo(path.slice(8), request);
      if (!this.enabled)
        throw new ApiError(503, "account_disabled", "Account is disabled");
      if (this.busy)
        throw new ApiError(
          429,
          "account_busy",
          "Account already has an active request",
        );
      this.busy = true;
      let streaming = false;
      try {
        if (path === "/refresh") {
          await this.client(this.timeout()).rotate();
          await this.health("refreshed");
          await this.schedule();
          return json({ ok: true, refreshed_at: this.creds!.refreshedAt });
        }
        if (path === "/models") {
          const frames = await this.client(this.timeout()).rpc("otAQ7b", []);
          return json({ data: frames });
        }
        if (path === "/generate" || path === "/videos") {
          const input = (await readJson(request)) as GenerateInput;
          await this.rateLimit();
          if (path === "/videos") return await this.createVideo(input);
          const sessionKey =
            "session:" + (await sha256(input.owner + ":" + input.session));
          const session = await this.privateGet<Session>(sessionKey);
          if (
            session &&
            now() - session.updatedAt >
              boundedInt(this.env.SESSION_TTL_SECONDS, 604800, 60, 2592000)
          )
            throw new ApiError(
              410,
              "session_expired",
              "Session has expired; start a new session",
            );
          if (session && session.model !== input.model)
            throw new ApiError(
              400,
              "session_model",
              "A conversation cannot switch models; start a new session",
            );
          if (input.resume && !session)
            throw new ApiError(404, "not_found", "Session not found");
          const completionId = uid(
              input.endpoint === "responses" ? "resp_" : "chatcmpl_",
            ),
            created = now();
          const work = async (sink?: EventSink, signal?: AbortSignal) => {
            const start = Date.now();
            let output = 0,
              status = 200,
              actual = "",
              errorCode: string | null = null;
            let seq = 0;
            try {
              const client = this.client(
                this.timeout(signal || request.signal),
              );
              let previous = "";
              const buffered =
                !!input.tools?.length ||
                !!input.responseFormat ||
                ["gemini-image", "gemini-music", "gemini-canvas"].includes(
                  input.model,
                );
              const messageId = uid("msg_");
              const responseEvent = async (
                type: string,
                data: Record<string, unknown>,
              ) => sink?.send({ type, sequence_number: seq++, ...data }, type);
              if (sink && input.endpoint === "responses") {
                await responseEvent("response.created", {
                  response: {
                    id: completionId,
                    object: "response",
                    created_at: created,
                    model: input.model,
                    status: "in_progress",
                    output: [],
                  },
                });
                await responseEvent("response.in_progress", {
                  response: {
                    id: completionId,
                    object: "response",
                    created_at: created,
                    model: input.model,
                    status: "in_progress",
                    output: [],
                  },
                });
                if (!buffered) {
                  await responseEvent("response.output_item.added", {
                    output_index: 0,
                    item: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      status: "in_progress",
                      content: [],
                    },
                  });
                  await responseEvent("response.content_part.added", {
                    item_id: messageId,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                  });
                }
              } else if (sink)
                await sink.send({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: input.model,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "" },
                      finish_reason: null,
                    },
                  ],
                });
              const emit = async (text: string) => {
                const part = delta(previous, text);
                if (text.startsWith(previous)) previous = text;
                if (!part) return;
                if (input.endpoint === "responses")
                  await responseEvent("response.output_text.delta", {
                    item_id: messageId,
                    output_index: 0,
                    content_index: 0,
                    delta: part,
                  });
                else
                  await sink?.send({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: input.model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: part },
                        finish_reason: null,
                      },
                    ],
                  });
              };
              const result = await client.generate(
                input,
                session,
                sink && !buffered ? emit : undefined,
              );
              await this.media(result, input, client);
              if (result.canvas && !result.text.includes(result.canvas))
                result.text += "\n\n" + result.canvas;
              finishResult(result, input);
              output = result.text.length;
              actual = result.actualModel;
              if (result.metadata[0]) {
                await this.privatePut(sessionKey, {
                  metadata: result.metadata,
                  model: input.model,
                  turn: (session?.turn || 0) + 1,
                  updatedAt: now(),
                } satisfies Session);
              }
              const body =
                input.endpoint === "responses"
                  ? responsesResponse(result, input, completionId, created)
                  : input.endpoint === "images"
                    ? {
                        created,
                        data: (result.artifacts || []).map((a) => ({
                          url:
                            request.headers.get("x-public-origin") +
                            `/v1/files/${a.id}/content`,
                        })),
                      }
                    : chatResponse(result, input, completionId, created);
              if (sink) {
                if (input.endpoint === "responses") {
                  const full = body as ReturnType<typeof responsesResponse>;
                  if (buffered) {
                    for (let i = 0; i < full.output.length; i++) {
                      const item = full.output[i];
                      await responseEvent("response.output_item.added", {
                        output_index: i,
                        item: { ...item, status: "in_progress" },
                      });
                      if (item.type === "function_call") {
                        await responseEvent(
                          "response.function_call_arguments.delta",
                          {
                            item_id: item.id,
                            output_index: i,
                            delta: item.arguments,
                          },
                        );
                        await responseEvent(
                          "response.function_call_arguments.done",
                          {
                            item_id: item.id,
                            output_index: i,
                            arguments: item.arguments,
                          },
                        );
                      } else {
                        await responseEvent("response.content_part.added", {
                          item_id: item.id,
                          output_index: i,
                          content_index: 0,
                          part: {
                            type: "output_text",
                            text: "",
                            annotations: [],
                          },
                        });
                        await responseEvent("response.output_text.delta", {
                          item_id: item.id,
                          output_index: i,
                          content_index: 0,
                          delta: result.text,
                        });
                        await responseEvent("response.output_text.done", {
                          item_id: item.id,
                          output_index: i,
                          content_index: 0,
                          text: result.text,
                        });
                        await responseEvent("response.content_part.done", {
                          item_id: item.id,
                          output_index: i,
                          content_index: 0,
                          part: item.content[0],
                        });
                      }
                      await responseEvent("response.output_item.done", {
                        output_index: i,
                        item,
                      });
                    }
                  } else {
                    await emit(result.text);
                    full.output[0].id = messageId;
                    await responseEvent("response.output_text.done", {
                      item_id: messageId,
                      output_index: 0,
                      content_index: 0,
                      text: result.text,
                    });
                    await responseEvent("response.content_part.done", {
                      item_id: messageId,
                      output_index: 0,
                      content_index: 0,
                      part: full.output[0].content[0],
                    });
                    await responseEvent("response.output_item.done", {
                      output_index: 0,
                      item: full.output[0],
                    });
                  }
                  await responseEvent("response.completed", { response: full });
                } else {
                  if (result.toolCalls)
                    await sink.send({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: input.model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: result.toolCalls.map(
                              (t: any, index) => ({ index, ...t }),
                            ),
                          },
                          finish_reason: null,
                        },
                      ],
                    });
                  else await emit(result.text);
                  await sink.send({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: input.model,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: result.toolCalls ? "tool_calls" : "stop",
                      },
                    ],
                    gemini: {
                      actual_model: actual || null,
                      artifacts: result.artifacts || [],
                    },
                  });
                  await sink.send("[DONE]");
                }
              }
              await this.health("ok");
              return body;
            } catch (e) {
              const err =
                e instanceof ApiError
                  ? e
                  : new ApiError(
                      502,
                      "upstream_error",
                      "Gemini request failed or timed out",
                    );
              status = err.status;
              errorCode = err.code;
              await this.health(
                err.code,
                err.status === 429 ? now() + 120 : 0,
              ).catch(() => {});
              if (sink && input.endpoint === "responses" && !signal?.aborted) {
                await sink.send(
                  {
                    type: "response.failed",
                    sequence_number: seq++,
                    response: {
                      id: completionId,
                      object: "response",
                      created_at: created,
                      model: input.model,
                      status: "failed",
                      output: [],
                      error: { code: err.code, message: err.message },
                    },
                  },
                  "response.failed",
                );
                return;
              }
              throw err;
            } finally {
              await this.log(
                input,
                completionId,
                start,
                status,
                output,
                actual,
                errorCode,
              ).catch(() => {});
              await this.schedule().catch(() => {});
            }
          };
          if (input.stream) {
            streaming = true;
            const stream = eventStream(
              async (sink, signal) => {
                await work(sink, signal);
              },
              () => {
                this.busy = false;
              },
              request.signal,
            );
            this.state.waitUntil(stream.done);
            stream.response.headers.set(
              "X-Session-Id",
              `${this.accountId}.${input.session}`,
            );
            return stream.response;
          }
          const body = await work();
          return json(body, 200, {
            "X-Session-Id": `${this.accountId}.${input.session}`,
          });
        }
        throw new ApiError(404, "not_found", "Not found");
      } finally {
        if (!streaming) this.busy = false;
      }
    } catch (e) {
      return errorResponse(e);
    }
  }
  private async rateLimit() {
    const minute = Math.floor(now() / 60);
    const bucket = (await this.state.storage.get<{
      minute: number;
      count: number;
    }>("rate")) || { minute, count: 0 };
    if (bucket.minute !== minute) {
      bucket.minute = minute;
      bucket.count = 0;
    }
    if (bucket.count >= 6)
      throw new ApiError(
        429,
        "account_rate_limit",
        "Account limit is six generation attempts per minute",
      );
    bucket.count++;
    await this.state.storage.put("rate", bucket);
  }
  private async health(health: string, cooldown = 0) {
    await this.env.DB.prepare(
      "UPDATE accounts SET health=?,last_refresh=?,cooldown_until=? WHERE id=?",
    )
      .bind(health, this.creds?.refreshedAt || 0, cooldown, this.accountId)
      .run();
  }
  private async log(
    input: GenerateInput,
    id: string,
    start: number,
    status: number,
    output: number,
    actual: string,
    error: string | null,
    inputChars = input.prompt.length,
  ) {
    const completedAt = now();
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO requests (id,created_at,account_id,key_id,endpoint,model,actual_model,status,duration_ms,input_chars,output_chars,error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        completedAt,
        this.accountId,
        input.owner,
        input.endpoint,
        input.model,
        actual || null,
        status,
        Date.now() - start,
        inputChars,
        output,
        error,
      ),
      this.env.DB.prepare(
        "INSERT INTO daily_stats(day,requests,failures) VALUES(date(?,'unixepoch'),1,?) ON CONFLICT(day) DO UPDATE SET requests=requests+1, failures=failures+excluded.failures",
      ).bind(completedAt, status >= 400 ? 1 : 0),
    ]);
  }
  private async media(
    result: Result,
    input: GenerateInput,
    client: GeminiClient,
  ) {
    if (!["gemini-image", "gemini-music"].includes(input.model)) return;
    const matches = (url: string) =>
      input.model === "gemini-image"
        ? /^lh[3-6]\.googleusercontent\.com$/.test(new URL(url).hostname)
        : new URL(url).hostname === "contribution.usercontent.google.com";
    result.urls = result.urls.filter(matches);
    if (!result.urls.length && typeof result.metadata[0] === "string") {
      for (let i = 0; i < 3 && !result.urls.length; i++) {
        if (i) await new Promise((r) => setTimeout(r, 2000));
        const history = await client.history(result.metadata[0]);
        result.urls = history.urls.filter(matches);
      }
    }
    if (!result.urls.length)
      throw new ApiError(
        502,
        "media_unavailable",
        "Gemini did not return a downloadable artifact. Check account entitlement and prompt restrictions.",
      );
    result.artifacts = [];
    for (const url of result.urls.slice(0, 4)) {
      const a = await this.storeArtifact(
        url,
        input.owner,
        input.model === "gemini-image" ? "image/png" : "audio/mpeg",
      );
      const resourceId = `${this.accountId}.${a.id}`;
      result.text = result.text
        .split(url)
        .join(`/v1/files/${resourceId}/content`);
      result.artifacts.push({ id: resourceId, mime: a.mime });
    }
    // Clients receive authenticated gateway paths, never upstream credential-bearing URLs.
    if (result.artifacts.length)
      result.text +=
        "\n\n" +
        result.artifacts
          .map((a) => `[Download ${a.mime}](/v1/files/${a.id}/content)`)
          .join("\n");
  }
  private async storeArtifact(url: string, owner: string, mime: string) {
    const id = uid("file_");
    if (url.includes("contribution.usercontent.google.com")) {
      const u = new URL(url);
      u.searchParams.set("opi", "103135050");
      u.searchParams.set("filename", "artifact");
      url = u.href;
    }
    const a = { id, url, owner, mime, expiresAt: now() + 3600 };
    await this.privatePut("file:" + id, a);
    return a;
  }
  private async createVideo(input: GenerateInput) {
    if (await this.state.storage.get("activeVideo"))
      throw new ApiError(
        429,
        "video_busy",
        "This account already has an unfinished video",
      );
    const id = uid("video_"),
      job: VideoJob = {
        id,
        owner: input.owner,
        model: input.model,
        status: "queued",
        created_at: now(),
        updated_at: now(),
        stage: "queued",
        input,
        inputChars: input.prompt.length,
      };
    await this.privatePut("video:" + id, job);
    await this.state.storage.put("activeVideo", id);
    await this.schedule(1000);
    return json(this.publicVideo(job), 202);
  }
  private publicVideo(job: VideoJob) {
    return {
      id: `${this.accountId}.${job.id}`,
      object: "video",
      model: job.model,
      status: job.status,
      created_at: job.created_at,
      ...(job.error ? { error: job.error } : {}),
    };
  }
  private async getVideo(path: string, request: Request) {
    const [id, action] = path.split("/");
    const j = await this.privateGet<VideoJob>("video:" + id);
    if (
      !j ||
      j.owner !== request.headers.get("x-owner") ||
      j.created_at + 86400 < now()
    )
      throw new ApiError(404, "not_found", "Video not found or expired");
    if (action === "content") {
      if (j.status !== "completed" || !j.artifact)
        throw new ApiError(409, "video_not_ready", "Video is not completed");
      const f = await this.privateGet<Artifact>("file:" + j.artifact);
      if (!f || f.expiresAt < now())
        throw new ApiError(410, "media_expired", "Video download expired");
      return this.client(this.timeout(request.signal)).download(
        f.url,
        request.headers.get("range"),
      );
    }
    return json(this.publicVideo(j));
  }
  async alarm() {
    await this.load();
    if (!this.accountId) return;
    if (this.busy) {
      await this.schedule(30000);
      return;
    }
    this.busy = true;
    try {
      if (!this.enabled) {
        await this.cleanup();
        await this.schedule(86400000);
        return;
      }
      const video = await this.state.storage.get<string>("activeVideo");
      if (video) {
        const j = await this.privateGet<VideoJob>("video:" + video);
        if (j) {
          const client = this.client(this.timeout());
          try {
            if (j.stage !== "done" && now() - j.created_at > 600)
              throw new ApiError(
                504,
                "video_timeout",
                "Video expired before completion; it will not be resubmitted",
              );
            if (j.stage === "queued") {
              const input = j.input!;
              j.status = "in_progress";
              j.stage = "submitting";
              await this.privatePut("video:" + video, j);
              await this.schedule(240000);
              const r = await client.generate(input, undefined);
              j.cid = String(r.metadata[0] || "");
              j.input = undefined;
              j.stage = "polling";
              if (!j.cid)
                throw new ApiError(
                  502,
                  "video_no_conversation",
                  "Video submission returned no conversation",
                );
            } else if (j.stage === "submitting")
              throw new ApiError(
                502,
                "submission_uncertain",
                "Video submission was interrupted. It will not be automatically resubmitted.",
              );
            if (j.stage === "polling") {
              if (now() - j.created_at > 600)
                throw new ApiError(
                  504,
                  "video_timeout",
                  "Video was not ready after ten minutes",
                );
              const r = await client.history(j.cid!);
              const url = r.urls.find((x) =>
                x.includes("contribution.usercontent.google.com"),
              );
              if (url) {
                const a = await this.storeArtifact(url, j.owner, "video/mp4");
                j.artifact = a.id;
                j.status = "completed";
                j.stage = "done";
              }
            }
          } catch (e) {
            const err =
              e instanceof ApiError
                ? e
                : new ApiError(502, "video_failed", "Video request failed");
            j.status = "failed";
            j.stage = "done";
            j.error = { code: err.code, message: err.message };
            j.input = undefined;
          }
          j.updated_at = now();
          await this.privatePut("video:" + video, j);
          if (j.stage === "done") {
            await this.log(
              {
                model: j.model,
                prompt: "",
                files: [],
                stream: false,
                owner: j.owner,
                endpoint: "videos",
              },
              j.id,
              j.created_at * 1000,
              j.status === "completed" ? 200 : 502,
              0,
              "",
              j.error?.code || null,
              j.inputChars || 0,
            ).catch(() => {});
            await this.state.storage.delete("activeVideo");
          } else {
            await this.schedule(15000);
            return;
          }
        } else await this.state.storage.delete("activeVideo");
      }
      if (this.creds && now() - (this.creds.refreshedAt || 0) >= 900) {
        try {
          await this.client(this.timeout()).rotate();
          await this.health("refreshed");
        } catch (e) {
          await this.health(e instanceof ApiError ? e.code : "refresh_failed");
        }
      }
      await this.cleanup();
      await this.schedule();
    } finally {
      this.busy = false;
    }
  }
  private async cleanup() {
    const day = Math.floor(now() / 86400);
    if ((await this.state.storage.get<number>("maintenanceDay")) !== day) {
      await this.env.DB.batch([
        this.env.DB.prepare("DELETE FROM requests WHERE created_at < ?").bind(
          now() - 30 * 86400,
        ),
        this.env.DB.prepare(
          "DELETE FROM daily_stats WHERE day < date(?,'unixepoch')",
        ).bind(now() - 365 * 86400),
      ]);
      await this.state.storage.put("maintenanceDay", day);
    }
    for (const prefix of ["file:", "video:", "session:", "known:"]) {
      const cursorKey = "cleanupCursor:" + prefix;
      const cursor = await this.state.storage.get<string>(cursorKey);
      const rows = await this.state.storage.list<string>({
        prefix,
        ...(cursor ? { startAfter: cursor } : {}),
        limit: 25,
      });
      if (rows.size === 25)
        await this.state.storage.put(cursorKey, [...rows.keys()].at(-1)!);
      else await this.state.storage.delete(cursorKey);
      for (const key of rows.keys()) {
        if (prefix === "known:") {
          await this.state.storage.delete(key);
          continue;
        }
        const v = await this.privateGet<any>(key);
        const expired =
          prefix === "file:"
            ? v.expiresAt < now()
            : prefix === "video:"
              ? v.created_at + 86400 < now()
              : v.updatedAt +
                  boundedInt(
                    this.env.SESSION_TTL_SECONDS,
                    604800,
                    60,
                    2592000,
                  ) <
                now();
        if (expired) await this.state.storage.delete(key);
      }
    }
  }
}
