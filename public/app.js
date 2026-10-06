import { browserError, fetchOnce, responseJson } from "./http.js";
import { artifactGallery } from "./media.js";
import { loginStatus } from "./login-status.js";
const gallery = artifactGallery(document.getElementById("artifacts"));
const $ = (id) => document.getElementById(id);
let adminKey = "",
  page = "overview",
  session = "",
  controller;
const titles = {
  overview: "服务概览",
  accounts: "账号池",
  keys: "API 密钥",
  requests: "请求记录",
  playground: "调试台",
  settings: "运行配置",
};
function notify(message, error = false) {
  $("notice").hidden = false;
  $("notice").textContent = message;
  $("notice").className = error ? "error" : "";
}
async function api(path, method = "GET", data) {
  const context = method === "GET" ? "read" : "write";
  const r = await fetchOnce(
    "/admin/" + path,
    {
      method,
      headers: {
        Authorization: "Bearer " + adminKey,
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    },
    context,
  );
  const b = await responseJson(r, context);
  if (!r.ok) throw Error(b.error?.message || `HTTP ${r.status}`);
  return b;
}
function button(text, action, danger = false) {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = danger ? "danger" : "secondary";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await action();
    } catch (e) {
      notify(e.message, true);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
function card(title, detail, actions) {
  const row = document.createElement("article");
  row.className = "card";
  const text = document.createElement("div");
  const t = document.createElement("div");
  t.className = "title";
  t.textContent = title;
  const d = document.createElement("div");
  d.className = "muted";
  d.textContent = detail;
  text.append(t, d);
  const controls = document.createElement("div");
  controls.className = "inline";
  controls.append(...actions);
  row.append(text, controls);
  return row;
}
async function load() {
  if (!adminKey) return;
  try {
    if (page === "overview") {
      const s = await api("stats");
      $("request-count").textContent = s.last_24h.requests || 0;
      $("failure-count").textContent = s.last_24h.failures || 0;
      $("duration").textContent =
        ((s.last_24h.avg_duration_ms || 0) / 1000).toFixed(1) + "s";
    }
    if (page === "accounts") {
      const b = await api("accounts");
      $("account-list").replaceChildren(
        ...b.data.map((a) =>
          card(
            a.label,
            `${a.id} · ${a.enabled ? "已启用" : "已暂停"} · ${a.health}`,
            [
              button("检测/续期", async () => {
                const r = await api(`accounts/${a.id}/refresh`, "POST", {});
                const next = r.maintenance?.nextAttemptAt;
                notify(
                  r.message +
                    (next
                      ? ` 下次检查：${new Date(next * 1000).toLocaleString()}`
                      : ""),
                  !r.ok,
                );
                await load();
              }),
              button("保活状态", async () => {
                const r = await api(`accounts/${a.id}/status`);
                notify(
                  loginStatus(r),
                  !!r.page_diagnostic?.code ||
                    (!!r.maintenance && r.maintenance.status !== "healthy"),
                );
              }),
              button(a.enabled ? "暂停" : "启用", async () => {
                await api(`accounts/${a.id}`, "PUT", { enabled: !a.enabled });
                await load();
              }),
              button(
                "删除",
                async () => {
                  if (
                    confirm(
                      "删除账号及其加密 Cookie、会话、视频和文件引用？此操作不可撤销。",
                    )
                  ) {
                    await api(`accounts/${a.id}`, "DELETE");
                    await load();
                  }
                },
                true,
              ),
            ],
          ),
        ),
      );
    }
    if (page === "keys") {
      const b = await api("keys");
      $("key-list").replaceChildren(
        ...b.data.map((k) =>
          card(k.name, k.id, [
            button(
              "撤销",
              async () => {
                if (confirm("立即撤销此 API Key？")) {
                  await api(`keys/${k.id}`, "DELETE");
                  await load();
                }
              },
              true,
            ),
          ]),
        ),
      );
    }
    if (page === "requests") {
      const b = await api("requests");
      $("request-list").replaceChildren(
        ...b.data.map((r) => {
          const tr = document.createElement("tr");
          for (const v of [
            new Date(r.created_at * 1000).toLocaleString(),
            r.model,
            r.actual_model || "—",
            r.status,
            (r.duration_ms / 1000).toFixed(2) + "s",
            r.error_code || "—",
          ]) {
            const td = document.createElement("td");
            td.textContent = v;
            tr.append(td);
          }
          return tr;
        }),
      );
    }
    if (page === "settings")
      $("config").textContent = JSON.stringify(await api("config"), null, 2);
  } catch (e) {
    notify(e.message, true);
  }
}
for (const b of document.querySelectorAll("nav button"))
  b.onclick = () => {
    page = b.dataset.page;
    for (const p of document.querySelectorAll(".page"))
      p.hidden = p.id !== page;
    for (const n of document.querySelectorAll("nav button"))
      n.classList.toggle("active", n === b);
    $("heading").textContent = titles[page];
    load();
  };
$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  adminKey = $("admin-key").value;
  try {
    await api("config");
    $("admin-key").value = "";
    $("login").hidden = true;
    notify("已连接。管理密钥仅在本页内存中保存。");
    load();
  } catch (e) {
    adminKey = "";
    notify(e.message, true);
  }
};
$("refresh").onclick = load;
$("account-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.currentTarget,
    b = new FormData(f);
  try {
    await api("accounts", "POST", {
      label: b.get("label"),
      cookie: b.get("cookie"),
    });
    f.reset();
    notify("账号已加密导入。请点击检测/续期，或用 Roxy 同步脚本补齐页面参数。");
    load();
  } catch (e) {
    notify(e.message, true);
  }
};
$("key-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const b = await api("keys", "POST", {
      name: new FormData(e.currentTarget).get("name"),
    });
    $("new-key").hidden = false;
    $("key-value").textContent = b.key;
    e.target.reset();
    load();
  } catch (e) {
    notify(e.message, true);
  }
};
$("hide-key").onclick = () => {
  $("new-key").hidden = true;
  $("key-value").textContent = "";
};
$("base-url").textContent = location.origin + "/v1";
$("reset-session").onclick = () => {
  session = "";
  $("session-info").textContent = "新会话。后续只发送新增消息。";
};
$("model").onchange = () => {
  $("reset-session").click();
  if ($("model").value === "gemini-spark")
    notify(
      "Spark 是实验入口：Cloudflare 真实验收尚未通过，仅测试文本，不用于计划任务或关联应用操作。",
      true,
    );
};
$("stop").onclick = () => controller?.abort();
$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  controller = new AbortController();
  $("send").disabled = true;
  $("stop").disabled = false;
  $("answer").textContent = "";
  gallery.clear();
  const inferenceKey = $("chat-key").value;
  try {
    const r = await fetchOnce(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + inferenceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: $("model").value,
          messages: [{ role: "user", content: $("prompt").value }],
          stream: true,
          ...(session ? { gemini_session_id: session } : {}),
        }),
        signal: controller.signal,
      },
      "generate",
    );
    if (!r.ok) {
      const err = await responseJson(r, "generate");
      throw Error(err.error?.message || `HTTP ${r.status}`);
    }
    session =
      r.headers.get("x-gemini-session-id") ||
      r.headers.get("x-session-id") ||
      "";
    $("session-info").textContent = "会话：" + session;
    const reader = r.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let n;
      while ((n = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, n);
        buffer = buffer.slice(n + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const b = JSON.parse(data);
        if (b.error) throw Error(b.error.message);
        $("answer").textContent += b.choices?.[0]?.delta?.content || "";
        if (b.gemini?.artifacts?.length)
          await gallery.show(
            b.gemini.artifacts,
            inferenceKey,
            controller.signal,
          );
        if (b.gemini?.actual_model)
          notify("实际模型：" + b.gemini.actual_model);
      }
    }
    reader.releaseLock();
  } catch (e) {
    controller?.abort();
    session = "";
    $("session-info").textContent = "上次请求未完成；下一次将新建会话。";
    notify(
      e.name === "AbortError"
        ? "已停止请求；上游可能已开始生成。"
        : browserError(e, "generate"),
      true,
    );
  } finally {
    $("send").disabled = false;
    $("stop").disabled = true;
    controller = undefined;
  }
};
