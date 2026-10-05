import { ApiError } from "./util";

const gatewayId = /^(acc_[a-f0-9]{32})\.(s_[a-f0-9]{32})$/;

type SessionRoute = { account?: string; session?: string };

// OpenAI clients sometimes use the generic session_id/header for their own
// conversation or tracing IDs. Only a gateway-issued locator opts into remote
// delta-mode resumption; opaque legacy IDs do not persist or route any state.
export function resolveSession(
  body: Record<string, unknown>,
  headers: Headers,
): SessionRoute {
  const fields: [string, unknown, boolean][] = [
    ["gemini_session_id", body.gemini_session_id, true],
    [
      "X-Gemini-Session-Id",
      headers.get("x-gemini-session-id") ?? undefined,
      true,
    ],
    ["session_id", body.session_id, false],
    ["X-Session-Id", headers.get("x-session-id") ?? undefined, false],
  ];
  let selected: string | undefined;
  let route: SessionRoute = {};
  for (const [field, value, explicit] of fields) {
    if (value === undefined || (!explicit && (value === null || value === "")))
      continue;
    const invalid = () =>
      new ApiError(
        400,
        "invalid_session_id",
        `${field} must ${explicit ? "be a complete gateway session ID (acc_<32hex>.s_<32hex>)" : "be a string of at most 512 characters; gateway session IDs must be complete (acc_<32hex>.s_<32hex>)"}. Omit it for a new full-history request, or use the X-Gemini-Session-Id returned by this gateway with one new user/tool message.`,
      );
    if (
      typeof value !== "string" ||
      value.length > 512 ||
      !value.trim() ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw invalid();
    const match = gatewayId.exec(value);
    if (!match) {
      // Do not silently turn truncated/corrupted gateway locators into new chats.
      if (explicit || /^(?:acc_|s_)|\.s_/i.test(value.trim())) throw invalid();
      continue;
    }
    if (selected && selected !== value)
      throw new ApiError(
        400,
        "conflicting_session_ids",
        "Session fields refer to different gateway sessions. Send one gateway-issued ID using gemini_session_id or X-Gemini-Session-Id.",
      );
    selected = value;
    route = { account: match[1], session: match[2] };
  }
  return route;
}
