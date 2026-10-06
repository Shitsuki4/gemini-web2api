export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export const now = () => Math.floor(Date.now() / 1000);
export const uid = (prefix = "") =>
  prefix + crypto.randomUUID().replaceAll("-", "");
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
export function errorResponse(error: unknown) {
  const e =
    error instanceof ApiError
      ? error
      : new ApiError(500, "internal_error", "Internal server error");
  return json(
    {
      error: {
        message: e.message,
        type: e.status < 500 ? "invalid_request_error" : "api_error",
        code: e.code,
      },
    },
    e.status,
    e.status === 429 || e.retryAfter
      ? { "Retry-After": String(e.retryAfter ?? 60) }
      : {},
  );
}
export async function readLimited(response: Response | Request, max: number) {
  if (Number(response.headers.get("content-length")) > max)
    throw new ApiError(
      413,
      "body_too_large",
      "Request or upstream response exceeds the size limit",
    );
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max)
        throw new ApiError(
          413,
          "body_too_large",
          "Body exceeds the size limit",
        );
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return all;
}
export async function readJson(request: Request, max = 1048576): Promise<any> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ApiError(415, "content_type", "Use application/json");
  try {
    const v = JSON.parse(
      new TextDecoder().decode(await readLimited(request, max)),
    );
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error();
    return v;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, "invalid_json", "Invalid JSON object");
  }
}
export const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
export const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
export function fromBase64(s: string) {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    throw new ApiError(400, "invalid_base64", "Invalid base64 data");
  }
}
export function toBase64(v: Uint8Array) {
  let s = "";
  for (let i = 0; i < v.length; i += 8192)
    s += String.fromCharCode(...v.subarray(i, i + 8192));
  return btoa(s);
}
export async function seal(
  value: unknown,
  secret: string,
  aad: string,
): Promise<string> {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}
export async function unseal<T>(
  value: string,
  secret: string,
  aad: string,
): Promise<T> {
  const [version, iv, data] = value.split(".");
  if (version !== "v1") throw Error("Invalid ciphertext version");
  const key = await encryptionKey(secret);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(iv),
      additionalData: new TextEncoder().encode(aad),
    },
    key,
    fromBase64(data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
async function encryptionKey(secret: string) {
  if (!secret)
    throw new ApiError(
      503,
      "not_configured",
      "ENCRYPTION_KEY is not configured",
    );
  const bytes = fromBase64(secret);
  if (bytes.length !== 32)
    throw new ApiError(
      503,
      "not_configured",
      "ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function constantEqual(a: string, b: string) {
  const x = await sha256(a),
    y = await sha256(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
export function token(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth) return auth.replace(/^Bearer\s+/i, "");
  return request.headers.get("x-api-key") || "";
}
export function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.max(min, Math.min(max, Math.trunc(n)))
    : fallback;
}
