import { ApiError } from "../util";
import type { Result } from "../types";
// Google envelopes are XSSI-prefixed, length-delimited JSON lines. Never decode network chunks independently.
export async function* envelopeLines(
  stream: ReadableStream<Uint8Array>,
  maxLine = 2 * 1024 * 1024,
) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      total += value?.byteLength || 0;
      if (total > 16 * 1024 * 1024)
        throw new ApiError(
          502,
          "upstream_too_large",
          "Upstream stream exceeds 16 MiB",
        );
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > maxLine)
          throw new ApiError(
            502,
            "frame_too_large",
            "Upstream frame is too large",
          );
        if (line.startsWith("[")) yield line;
      }
      if (buffer.length > maxLine)
        throw new ApiError(
          502,
          "frame_too_large",
          "Upstream frame is too large",
        );
      if (done) {
        if (buffer.trim().startsWith("[")) yield buffer.trim();
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function decodeEnvelope(line: string): any[] {
  try {
    const rows = JSON.parse(line);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(
        (r) =>
          Array.isArray(r) && r[0] === "wrb.fr" && typeof r[2] === "string",
      )
      .flatMap((r) => {
        try {
          return [JSON.parse(r[2])];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
export function walkStrings(
  value: unknown,
  visit: (s: string) => void,
  depth = 0,
) {
  if (depth > 65) return;
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) {
    const candidate =
      typeof value[0] === "string" && value[0].startsWith("rc_");
    for (let i = 0; i < value.length; i++) {
      // Slot 37 is private reasoning, including any URLs/HTML inside that trace.
      if (candidate && i === 37) continue;
      walkStrings(value[i], visit, depth + 1);
    }
  } else if (value && typeof value === "object")
    for (const v of Object.values(value)) walkStrings(v, visit, depth + 1);
}
export function isArtifactUrl(s: string) {
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password || u.port)
      return false;
    return (
      (/^lh[3-6]\.googleusercontent\.com$/.test(u.hostname) &&
        /^\/gg(?:-dl)?\//.test(u.pathname)) ||
      (u.hostname === "contribution.usercontent.google.com" &&
        u.pathname === "/download" &&
        responseData(u.searchParams.get("c") || ""))
    );
  } catch {
    return false;
  }
}
export function absorb(result: Result, inner: any) {
  if (!Array.isArray(inner)) return;
  if (
    Array.isArray(inner[1]) &&
    typeof inner[1][0] === "string" &&
    inner[1][0].startsWith("c_")
  )
    result.metadata = [...inner[1]];
  const candidate = inner[4]?.[0];
  if (Array.isArray(candidate)) {
    const text = candidate[1]?.[0];
    if (typeof text === "string" && text) result.text = text;
    if (typeof candidate[0] === "string" && candidate[0].startsWith("rc_")) {
      result.metadata[2] = candidate[0];
    }
  }
  walkStrings(inner, (s) => {
    if (isArtifactUrl(s) && !result.urls.includes(s)) result.urls.push(s);
    if (s.includes("<!DOCTYPE") && s.length > result.canvas.length)
      result.canvas = s;
  });
  // The server-reported display name is in the model descriptor, NOT the requested model name.
  const findModel = (v: any, depth = 0) => {
    if (depth > 50 || !Array.isArray(v)) return;
    if (
      typeof v[0] === "string" &&
      /^[a-f0-9]{16}$/.test(v[0]) &&
      typeof v[3] === "string" &&
      v[3].length < 80
    )
      result.actualModel = v[3];
    for (const item of v) if (Array.isArray(item)) findModel(item, depth + 1);
  };
  findModel(inner);
}
export function emptyResult(): Result {
  return { text: "", actualModel: "", metadata: [], canvas: "", urls: [] };
}
// Traces/private reasoning are deliberately not re-exported. User-visible answer text is streamed.
export function delta(previous: string, next: string) {
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.startsWith(next)) return "";
  throw new ApiError(
    502,
    "upstream_rewrite",
    "Upstream revised previously streamed text; retry without streaming",
  );
}
export function upstreamFailure(status: number) {
  return new ApiError(
    status === 429 ? 429 : 502,
    `upstream_http_${status}`,
    `Gemini returned HTTP ${status}. Cloudflare egress or the imported login may be rejected.`,
  );
}

function responseData(c: string) {
  try {
    const b = c.replaceAll("-", "+").replaceAll("_", "/");
    return atob(b.padEnd(Math.ceil(b.length / 4) * 4, "=")).includes(
      "response_data",
    );
  } catch {
    return false;
  }
}

// Spark sends progress/control objects at slot 2 between answer frames. Do not
// recursively walk these: they may contain planning, tool inputs or app data.
export function absorbSpark(result: Result, inner: any): boolean {
  if (!Array.isArray(inner)) return false;
  const cid = inner[1]?.[0];
  if (typeof cid === "string" && /^c_[a-zA-Z0-9_-]+$/.test(cid)) {
    const previous = result.metadata;
    result.metadata = [...inner[1]];
    if (previous[0] === cid && previous[1] === inner[1][1] && previous[2])
      result.metadata[2] = previous[2];
    result.sparkContext = {
      conversationId: cid,
      ...(result.sparkContext?.conversationId === cid
        ? { cursor: result.sparkContext.cursor }
        : {}),
    };
  }
  const cursor = inner[2]?.[26];
  if (
    result.sparkContext &&
    typeof cursor === "string" &&
    cursor.length <= 4096
  )
    result.sparkContext.cursor = cursor;
  const candidate = inner[4]?.[0];
  if (
    Array.isArray(candidate) &&
    typeof candidate[0] === "string" &&
    candidate[0].startsWith("rc_")
  ) {
    result.metadata[2] = candidate[0];
    if (typeof candidate[1]?.[0] === "string" && candidate[1][0])
      result.text = candidate[1][0];
  }
  // Explicit terminal task event, distinct from a planning/completion-looking text.
  return (
    !!result.sparkContext &&
    inner[2]?.[44] === true &&
    inner[2]?.[46]?.[0] === result.sparkContext.conversationId
  );
}
