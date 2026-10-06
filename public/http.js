const contexts = {
  read: "读取失败：浏览器未获得可读响应。请检查网络、网关地址或跨域配置；这不等于 Gemini 登录失效。可稍后刷新。",
  write:
    "操作连接失败：浏览器未获得可读响应，操作可能已经生效。请先刷新状态确认，不要重复提交。",
  generate:
    "生成连接失败：浏览器未获得完整可读响应。请检查网络、网关地址或跨域配置；请求可能已到达服务器，未自动重发。请先查看请求记录。",
  download:
    "下载连接失败：浏览器未获得完整媒体响应。请检查网络或跨域配置；不要因此重新提交生成。",
};
export function browserError(error, context = "read") {
  if (error?.name === "AbortError") return "请求已取消。";
  if (error?.name === "TimeoutError") return contexts[context];
  if (
    error?.name === "TypeError" &&
    /failed to fetch|fetch failed|load failed|networkerror|network error|network request failed|terminated/i.test(
      error.message,
    )
  )
    return contexts[context];
  return error?.message || "请求失败";
}
// Exactly one attempt, especially for generation and admin writes. A rejected
// browser fetch cannot establish whether the server already accepted a POST.
export async function fetchOnce(path, options, context = "read") {
  try {
    return await fetch(path, { ...options, redirect: "error" });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw Error(contexts[context]);
  }
}
export async function responseJson(response, context = "read") {
  try {
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error?.name === "SyntaxError")
      throw Error(
        `网关返回了非 JSON 响应（HTTP ${response.status}）；请检查服务地址或网关状态。`,
      );
    throw Error(contexts[context]);
  }
}
