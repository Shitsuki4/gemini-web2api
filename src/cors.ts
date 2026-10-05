import { ApiError } from "./util";

// Only the key-authenticated inference API is public to browser clients.
// Admin and assets must never inherit these headers. No cookie credentials.
export function isPublicApi(path: string): boolean {
  return path.startsWith("/v1/") || path.startsWith("/v1beta/");
}
export function apiCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "X-Session-Id, Retry-After, Content-Disposition, Content-Length, Content-Range, Accept-Ranges",
  };
}
export function apiPreflight(request: Request): Response {
  const method = request.headers.get("Access-Control-Request-Method");
  if (method && !["GET", "POST", "OPTIONS"].includes(method))
    throw new ApiError(405, "cors_method_denied", "Unsupported API method");
  const raw = request.headers.get("Access-Control-Request-Headers") || "";
  const requested = raw
    ? raw.split(",").map((h) => h.trim().toLowerCase())
    : [];
  // Browser SDKs send version/telemetry headers as well as Authorization.
  // Echo only bounded, valid HTTP field names, never values or credentials.
  if (
    raw.length > 2048 ||
    requested.length > 32 ||
    requested.some((h) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(h))
  )
    throw new ApiError(
      400,
      "invalid_cors_headers",
      "Invalid preflight headers",
    );
  return new Response(null, {
    status: 204,
    headers: {
      ...apiCorsHeaders(),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": [
        ...new Set([
          "authorization",
          "content-type",
          "x-api-key",
          "x-session-id",
          "range",
          ...requested,
        ]),
      ].join(", "),
      "Access-Control-Max-Age": "600",
      Vary: "Access-Control-Request-Method, Access-Control-Request-Headers",
    },
  });
}
