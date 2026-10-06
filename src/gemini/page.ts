import type { PageDiagnostic } from "../types";
import { ApiError, now } from "../util";

function pageValue(html: string, key: string): string | undefined {
  const m = html.match(
    new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")'),
  );
  try {
    return m ? JSON.parse(m[1]) : undefined;
  } catch {
    return undefined;
  }
}
export function pageTokens(html: string) {
  return {
    xsrf: pageValue(html, "SNlM0e") || "",
    bl: pageValue(html, "cfb2h") || "",
    pushId: pageValue(html, "qKIAYe") || "",
    pctx: pageValue(html, "Ylro7b") || "",
    fetchedAt: now(),
  };
}
// Only fixed enums, lengths and booleans leave this function. Never persist HTML,
// account identity, token values, redirect query strings or Google response text.
export function inspectPage(
  html: string,
  surface: "app" | "spark",
  httpStatus: number,
  bytes: number,
) {
  const tokens = pageTokens(html);
  const account = pageValue(html, "oPEP7c");
  const diagnostic: PageDiagnostic = {
    at: now(),
    surface,
    httpStatus,
    bytes,
    hasXsrf: !!tokens.xsrf,
    hasBuild: !!tokens.bl,
    accountMarker:
      account === undefined ? "absent" : account ? "present" : "empty",
    kind: "unrecognized",
  };
  if (
    /our systems have detected unusual traffic|id=["']captcha-form["']|action=["'][^"']*\/sorry\//i.test(
      html,
    )
  ) {
    diagnostic.kind = "challenge";
    diagnostic.code = "egress_blocked";
  } else if (tokens.xsrf && tokens.bl) diagnostic.kind = "signed_in";
  else if (account === "" && !tokens.xsrf) {
    diagnostic.kind = "signed_out";
    diagnostic.code = "login_expired";
  } else {
    diagnostic.code = "page_tokens_missing";
  }
  return { tokens, diagnostic };
}
export function pageFailure(code: string, retryAfter?: number, status = 502) {
  const message =
    code === "egress_blocked"
      ? "Google blocked the Gemini page request with a traffic challenge. Re-importing cookies may not help; no challenge bypass is attempted."
      : code === "login_expired"
        ? "Google returned a signed-out page or account-login redirect. Check the browser login and update this account if needed; device binding is not established by this response."
        : code === "consent_required"
          ? "Google requires an interactive consent step. Complete it in your browser before updating this account."
          : code === "page_tokens_missing"
            ? "Gemini page tokens were not recognized. This alone does not prove an expired or device-bound login. Check the account page diagnostic."
            : "Gemini page verification failed; retry after the account page backoff. Check the account status for the upstream error code.";
  return new ApiError(status, code, message, retryAfter);
}
