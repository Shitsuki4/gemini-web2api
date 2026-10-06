import { describe, expect, it } from "vitest";
import { cleanMediaText, missingArtifactMessage } from "../src/media";
describe("missing media diagnostics", () => {
  it("preserves the actual user-visible upstream explanation", () => {
    expect(
      missingArtifactMessage("gemini-image", "Please describe the image."),
    ).toBe(
      "Gemini returned no downloadable image. Upstream reply: Please describe the image.",
    );
  });
  it("does not diagnose entitlement without evidence", () => {
    expect(missingArtifactMessage("gemini-image", "")).toContain(
      "does not establish",
    );
  });
  it("redacts signed URLs before bounding the excerpt", () => {
    const m = missingArtifactMessage(
      "gemini-image",
      "See https://lh3.googleusercontent.com/gg/SECRET?token=SECRET\n" +
        "a".repeat(1000),
    );
    expect(m).not.toContain("SECRET");
    expect(m).toContain("[URL redacted]");
    expect(m.length).toBeLessThan(700);
  });
});

it("removes only Gemini's non-downloadable display placeholders", () => {
  expect(
    cleanMediaText(
      "\nhttp://googleusercontent.com/image_generation_content/0_700\n",
    ),
  ).toBe("");
  expect(
    cleanMediaText("https://example.com/image_generation_content/0_700"),
  ).toContain("example.com");
});
