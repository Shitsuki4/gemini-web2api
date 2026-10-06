// Only call with the user-visible answer, never raw protocol frames or reasoning.
// Signed upstream URLs are credentials: redact before truncating the excerpt.
export function missingArtifactMessage(model: string, text: string) {
  const kind = model === "gemini-image" ? "image" : "audio";
  const reply = text
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    `Gemini returned no downloadable ${kind}.` +
    (reply
      ? ` Upstream reply: ${reply.slice(0, 600)}${reply.length > 600 ? "…" : ""}`
      : " No user-visible explanation was returned. This alone does not establish a quota or entitlement issue.")
  );
}

// Gemini uses this non-downloadable placeholder in the visible answer. The
// real file arrives in a separate candidate field and gets a gateway URL.
export function cleanMediaText(text: string) {
  return text
    .replace(
      /https?:\/\/googleusercontent\.com\/(?:image_generation_content|card_content)\/[\d_]+/g,
      "",
    )
    .trim();
}
