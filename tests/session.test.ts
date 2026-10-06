import { describe, expect, it } from "vitest";
import { resolveSession } from "../src/session";

const account = "acc_" + "a".repeat(32),
  session = "s_" + "b".repeat(32);
const id = account + "." + session;
const other = account + ".s_" + "c".repeat(32);
const fields = [
  "gemini_session_id",
  "X-Gemini-Session-Id",
  "session_id",
  "X-Session-Id",
];
function resolve(field: string, value: any) {
  return resolveSession(
    field.startsWith("X-") ? {} : { [field]: value },
    new Headers(field.startsWith("X-") ? { [field]: value } : {}),
  );
}
describe("gateway session routing versus client metadata", () => {
  it("does not infer a remote session from opaque client IDs", () => {
    expect(resolveSession({}, new Headers())).toEqual({});
    for (const value of [
      "client-abc",
      "6d3b06f5-70ad-4138-a1f4-79145cf7fbdd",
      "conversation_123",
      "x".repeat(512),
      "会话一",
      "",
    ]) {
      expect(resolve("session_id", value)).toEqual({});
      if (/^[\x20-\x7e]*$/.test(value))
        expect(resolve("X-Session-Id", value)).toEqual({});
    }
    expect(resolve("session_id", null)).toEqual({});
  });
  it.each(fields)("recognizes full gateway IDs in %s", (field) => {
    expect(resolve(field, id)).toEqual({ account, session });
  });
  it("accepts matching aliases and independent client metadata", () => {
    expect(
      resolveSession(
        { gemini_session_id: id, session_id: id },
        new Headers({ "X-Gemini-Session-Id": id, "X-Session-Id": id }),
      ),
    ).toEqual({ account, session });
    expect(
      resolveSession(
        { gemini_session_id: id, session_id: "client-id" },
        new Headers({ "X-Session-Id": "trace-id" }),
      ),
    ).toEqual({ account, session });
  });
  it.each(fields)(
    "rejects corrupted locators in %s rather than starting over",
    (field) => {
      for (const value of [
        "acc_incomplete",
        "s_incomplete",
        id.toUpperCase(),
        " " + id + " suffix",
        "other.s_incomplete",
      ]) {
        expect(() => resolve(field, value)).toThrowError(
          expect.objectContaining({ code: "invalid_session_id" }),
        );
        try {
          resolve(field, value);
        } catch (e: any) {
          expect(e.message).toContain(field);
          expect(e.message).not.toContain(value);
        }
      }
    },
  );
  it.each([null, "", "client-id", false, 0, [], {}, [id], "x".repeat(513)])(
    "validates explicit field types and format (%j)",
    (value) => {
      expect(() => resolve("gemini_session_id", value)).toThrowError(
        expect.objectContaining({ code: "invalid_session_id" }),
      );
    },
  );
  it.each([false, 0, 12, [], {}, [id], " ", "x".repeat(513), "client\nID"])(
    "validates legacy field types and bounds (%j)",
    (value) => {
      expect(() => resolve("session_id", value)).toThrowError(
        expect.objectContaining({ code: "invalid_session_id" }),
      );
    },
  );
  it("rejects explicit header emptiness and client IDs", () => {
    for (const value of ["", "client-id"])
      expect(() => resolve("X-Gemini-Session-Id", value)).toThrowError(
        expect.objectContaining({ code: "invalid_session_id" }),
      );
  });
  it("rejects conflicts across any alias instead of choosing precedence", () => {
    for (let i = 0; i < fields.length; i++)
      for (let j = i + 1; j < fields.length; j++) {
        const body: any = {},
          headers = new Headers();
        for (const [field, value] of [
          [fields[i], id],
          [fields[j], other],
        ]) {
          if (field.startsWith("X-")) headers.set(field, value);
          else body[field] = value;
        }
        expect(() => resolveSession(body, headers)).toThrowError(
          expect.objectContaining({ code: "conflicting_session_ids" }),
        );
      }
  });
});
