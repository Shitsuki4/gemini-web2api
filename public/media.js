import { browserError, fetchOnce, responseJson } from "./http.js";
// Never navigate directly to an authenticated file URL or put a key in a URL.
export function artifactPath(id) {
  if (
    typeof id !== "string" ||
    !/^acc_[a-f0-9]{32}\.file_[a-f0-9]{32}$/.test(id)
  )
    throw Error("无效的图片/媒体文件标识");
  return `/v1/files/${id}/content`;
}
export async function fetchArtifact(id, key, signal) {
  const r = await fetchOnce(
    artifactPath(id),
    {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal,
    },
    "download",
  );
  if (!r.ok) {
    const error = await responseJson(r, "download");
    throw Error(error.error?.message || `下载失败：HTTP ${r.status}`);
  }
  const mime = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (
    !/^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|wav|x-wav|ogg|mp4|webm))$/.test(
      mime,
    )
  ) {
    await r.body?.cancel();
    throw Error("下载响应不是支持的图片或音频");
  }
  const limit = 20 * 1024 * 1024;
  if (Number(r.headers.get("content-length")) > limit) {
    await r.body?.cancel();
    throw Error("媒体超过网页预览的 20 MiB 限制，请使用 API 下载");
  }
  const reader = r.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("媒体超过网页预览的 20 MiB 限制");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new Blob(chunks, { type: mime });
}
export function artifactGallery(container) {
  const urls = new Set();
  const seen = new Set();
  let generation = 0;
  const clear = () => {
    generation++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    seen.clear();
    container.replaceChildren();
  };
  const show = async (artifacts, key, signal) => {
    const current = generation;
    for (const artifact of artifacts.slice(0, 4)) {
      if (current !== generation || signal?.aborted) return;
      const id = artifact?.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const card = document.createElement("section");
      card.className = "artifact";
      const status = document.createElement("p");
      status.textContent = "已生成，正在安全下载预览…";
      card.append(status);
      container.append(card);
      try {
        const blob = await fetchArtifact(id, key, signal);
        if (current !== generation || signal?.aborted) return;
        const url = URL.createObjectURL(blob);
        urls.add(url);
        const image = blob.type.startsWith("image/");
        const preview = document.createElement(image ? "img" : "audio");
        if (image) preview.alt = "Gemini 生成的图片";
        else preview.controls = true;
        preview.src = url;
        const link = document.createElement("a");
        link.href = url;
        const ext =
          { "image/jpeg": "jpg", "audio/mpeg": "mp3" }[blob.type] ||
          blob.type.split("/")[1];
        link.download = `gemini-${id.split(".file_")[1]}.${ext}`;
        link.textContent = image ? "下载图片" : "下载音频";
        status.textContent = `${blob.type} · ${Math.ceil(blob.size / 1024)} KiB · 上游链接约一小时后过期`;
        card.append(preview, link);
        if (image) await preview.decode();
      } catch (error) {
        if (current !== generation) return;
        status.textContent = `生成已完成，但预览/下载失败：${browserError(error, "download")}`;
      }
    }
  };
  return { clear, show };
}
