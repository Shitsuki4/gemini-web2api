// 控制台前端(单页,无构建步骤)。作为字符串导出,由 worker.js 在 /ui 提供。
// 注意:这里整段是一个模板字符串,内部不要出现反引号或 ${,否则会破坏解析。
export const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gemini-web2api 控制台</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel2: #1c2230; --line: #2a3241;
    --fg: #e6edf3; --dim: #8b98a9; --accent: #4f8cff; --ok: #3fb950;
    --warn: #d29922; --bad: #f85149; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  header .grow { flex: 1; }
  input, select, textarea, button { font: inherit; color: var(--fg); background: var(--panel2);
    border: 1px solid var(--line); border-radius: 7px; padding: 6px 9px; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  button { cursor: pointer; background: var(--panel2); }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.danger:hover { border-color: var(--bad); color: var(--bad); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  nav { display: flex; gap: 4px; padding: 8px 18px 0; border-bottom: 1px solid var(--line); background: var(--panel); }
  nav button { border: 0; border-radius: 7px 7px 0 0; background: transparent; color: var(--dim); padding: 8px 14px; }
  nav button.on { background: var(--bg); color: var(--fg); font-weight: 600; }
  main { padding: 18px; max-width: 1180px; margin: 0 auto; }
  section { display: none; }
  section.on { display: block; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 14px; }
  .card h2 { margin: 0 0 10px; font-size: 13px; color: var(--dim); font-weight: 600;
    text-transform: uppercase; letter-spacing: .6px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .muted { color: var(--dim); }
  .mono { font-family: var(--mono); font-size: 12px; }
  .chip { display: inline-flex; gap: 6px; align-items: center; font-size: 12px;
    background: var(--panel2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); } .dot.warn { background: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--dim); font-weight: 600; font-size: 12px; }
  tr:last-child td { border-bottom: 0; }
  #log { display: flex; flex-direction: column; gap: 12px; height: 52vh; overflow-y: auto;
    padding: 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  .msg { max-width: 84%; border-radius: 12px; padding: 9px 13px; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #23405f; }
  .msg.bot { align-self: flex-start; background: var(--panel2); }
  .msg.sys { align-self: center; background: transparent; color: var(--dim); font-size: 12px; }
  .msg img { max-width: 100%; border-radius: 8px; margin-top: 8px; display: block; }
  .composer { display: flex; gap: 8px; margin-top: 12px; align-items: flex-end; }
  .composer textarea { flex: 1; resize: vertical; min-height: 44px; max-height: 200px; }
  .bar { height: 6px; border-radius: 3px; background: var(--panel2); overflow: hidden; min-width: 64px; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .bar > i.ok { background: var(--ok); } .bar > i.warn { background: var(--warn); } .bar > i.bad { background: var(--bad); }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 13px; }
  .kv b { color: var(--dim); font-weight: 500; }
  .scroll { max-height: 46vh; overflow-y: auto; }
  .err { color: var(--bad); font-size: 13px; }
  .hint { color: var(--dim); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>gemini-web2api</h1>
  <span class="chip"><span class="dot" id="liveDot"></span><span id="liveTxt">未连接</span></span>
  <input id="key" type="password" placeholder="API Key" style="width:190px">
  <button id="saveKey">保存</button>
  <span class="grow"></span>
  <span class="chip" id="verChip">版本 —</span>
</header>

<nav>
  <button data-tab="chat" class="on">对话</button>
  <button data-tab="sessions">会话</button>
  <button data-tab="memory">记忆</button>
  <button data-tab="egress">出口</button>
  <button data-tab="status">状态</button>
</nav>

<main>
  <section id="tab-chat" class="on">
    <div class="card">
      <div class="row">
        <label class="muted">会话</label>
        <input id="sid" class="mono" style="width:200px" placeholder="会话 id">
        <button id="newSid">新会话</button>
        <span class="hint">留空则按「API Key + 首条消息」自动归组</span>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="muted">模型</label>
        <select id="model"></select>
        <label class="muted">记忆域</label>
        <input id="scope" style="width:130px" value="default">
        <label class="chip"><input type="checkbox" id="delta"> 只发增量</label>
        <span class="chip" id="turnChip">—</span>
      </div>
    </div>
    <div id="log"></div>
    <div class="composer">
      <textarea id="input" placeholder="输入消息,Enter 发送 / Shift+Enter 换行"></textarea>
      <button class="primary" id="send">发送</button>
      <button id="clear">清空</button>
    </div>
    <div class="err" id="chatErr"></div>
  </section>

  <section id="tab-sessions">
    <div class="card">
      <div class="row">
        <h2 style="margin:0">会话列表</h2>
        <span class="grow" style="flex:1"></span>
        <button id="reloadSessions">刷新</button>
        <button class="danger" id="purgeSessions">全部删除</button>
      </div>
      <div class="hint" id="sessHint" style="margin:8px 0"></div>
      <div class="scroll"><table><thead><tr>
        <th>Gemini 会话 (cid)</th><th>轮次</th><th>模型</th><th>模式</th><th>更新时间</th><th></th>
      </tr></thead><tbody id="sessBody"></tbody></table></div>
    </div>
  </section>

  <section id="tab-memory">
    <div class="card">
      <div class="row">
        <label class="muted">记忆域</label>
        <input id="memScope" style="width:160px" value="default">
        <button id="loadMem">加载</button>
        <span class="grow" style="flex:1"></span>
        <button class="danger" id="purgeMem">清空该域</button>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="memNew" style="flex:1;min-width:220px" placeholder="新增一条记忆,例如:用户偏好简洁回答">
        <button class="primary" id="addMem">添加</button>
      </div>
      <div class="hint" style="margin-top:8px">开新会话时这些内容会注入 prompt;续聊时不再重复注入(上游上下文里已经有了)。</div>
    </div>
    <div class="card"><div class="scroll"><table><thead><tr>
      <th>内容</th><th>来源</th><th>更新时间</th><th></th>
    </tr></thead><tbody id="memBody"></tbody></table></div></div>
  </section>

  <section id="tab-egress">
    <div class="card">
      <div class="row">
        <h2 style="margin:0">出口池 · 纯净度排序</h2>
        <span class="grow" style="flex:1"></span>
        <label class="chip"><input type="checkbox" id="probeImg" checked> 图片探针</label>
        <button id="testEgress">测试全部</button>
        <button id="reloadEgress">刷新</button>
      </div>
      <div class="hint" id="egressHint" style="margin:8px 0"></div>
      <div class="scroll"><table><thead><tr>
        <th>出口</th><th>分数</th><th>文本</th><th>图片</th><th>延迟</th><th>最近</th><th></th>
      </tr></thead><tbody id="egressBody"></tbody></table></div>
    </div>
    <div class="card">
      <h2>出口池配置</h2>
      <div class="hint" style="margin-bottom:8px">每行一条。支持 <span class="mono">direct</span>、
        <span class="mono">colo:weur</span>(Cloudflare 机房)、
        <span class="mono">socks5://user:pass@host:1080</span> 或 <span class="mono">http://host:3128</span>(外部代理)。</div>
      <textarea id="poolText" class="mono" style="width:100%;min-height:130px"></textarea>
      <div class="row" style="margin-top:8px">
        <button class="primary" id="savePool">保存出口池</button>
        <button id="resetPool">恢复默认</button>
        <span class="err" id="poolErr"></span>
      </div>
    </div>
  </section>

  <section id="tab-status">
    <div class="card"><div class="row">
      <h2 style="margin:0">运行状态</h2><span class="grow" style="flex:1"></span>
      <button id="reloadStatus">刷新</button>
    </div><div class="kv" id="statusKv"></div></div>
    <div class="card"><h2>图片缓存预算</h2><div class="kv" id="imgKv"></div></div>
  </section>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var key = localStorage.getItem("g2a_key") || "";
  $("key").value = key;

  function auth() { return key ? { Authorization: "Bearer " + key } : {}; }
  function api(path, opts) {
    opts = opts || {};
    var h = Object.assign({}, auth(), opts.headers || {});
    if (opts.body) h["Content-Type"] = "application/json";
    return fetch(path, { method: opts.method || "GET", headers: h, body: opts.body });
  }
  function fmtTime(ms) {
    if (!ms) return "—";
    var d = new Date(ms), p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function statusClass(s) {
    if (s === "ok") return "ok";
    if (!s) return "";
    if (s === "empty") return "warn";
    return "bad";
  }

  // ── 标签切换 ──────────────────────────────────────────────
  var tabs = document.querySelectorAll("nav button");
  Array.prototype.forEach.call(tabs, function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(tabs, function (x) { x.classList.remove("on"); });
      b.classList.add("on");
      var name = b.getAttribute("data-tab");
      Array.prototype.forEach.call(document.querySelectorAll("section"), function (s) {
        s.classList.toggle("on", s.id === "tab-" + name);
      });
      if (name === "sessions") loadSessions();
      if (name === "memory") loadMem();
      if (name === "egress") loadEgress();
      if (name === "status") loadStatus();
    };
  });

  // ── 连接 / 状态 ────────────────────────────────────────────
  function setLive(ok, txt) {
    $("liveDot").className = "dot " + (ok ? "ok" : "bad");
    $("liveTxt").textContent = txt;
  }
  function loadHealth() {
    return api("/health").then(function (r) { return r.json(); }).then(function (h) {
      setLive(true, "已连接");
      $("verChip").textContent = "版本 " + h.version;
      if (!$("model").options.length) {
        (h.models || []).forEach(function (m) {
          var o = el("option", null, m); o.value = m; $("model").appendChild(o);
        });
        $("model").value = h.defaultModel || (h.models || [])[0] || "";
      }
      return h;
    }).catch(function () { setLive(false, "连接失败"); });
  }
  $("saveKey").onclick = function () {
    key = $("key").value.trim();
    localStorage.setItem("g2a_key", key);
    loadHealth();
  };

  // ── 对话 ──────────────────────────────────────────────────
  var history = [];
  function addMsg(role, text) {
    var n = el("div", "msg " + (role === "user" ? "user" : role === "sys" ? "sys" : "bot"));
    n.textContent = text;
    $("log").appendChild(n);
    $("log").scrollTop = $("log").scrollHeight;
    return n;
  }
  $("newSid").onclick = function () {
    $("sid").value = "web-" + Math.random().toString(36).slice(2, 10);
    history = [];
    clear($("log"));
    addMsg("sys", "已开始新会话");
  };
  $("clear").onclick = function () { history = []; clear($("log")); };

  function send() {
    var text = $("input").value.trim();
    if (!text) return;
    var sid = $("sid").value.trim();
    if (!sid) { sid = "web-" + Math.random().toString(36).slice(2, 10); $("sid").value = sid; }
    $("input").value = "";
    addMsg("user", text);
    history.push({ role: "user", content: text });

    var h = Object.assign({}, auth(), {
      "Content-Type": "application/json",
      "X-Session-Id": sid,
      "X-Memory-Scope": $("scope").value.trim() || "default"
    });
    if ($("delta").checked) h["X-Session-Mode"] = "delta";
    // 增量模式和完整模式发的历史不同:增量模式只发最新一条
    var msgs = $("delta").checked ? [history[history.length - 1]] : history.slice();

    $("send").disabled = true;
    $("chatErr").textContent = "";
    var bubble = addMsg("bot", "");
    var acc = "";
    fetch("/v1/chat/completions", {
      method: "POST", headers: h,
      body: JSON.stringify({ model: $("model").value, messages: msgs, stream: true })
    }).then(function (res) {
      var mode = res.headers.get("X-Gemini-Session-Mode");
      if (mode) {
        $("turnChip").textContent = mode;
        $("turnChip").style.color = mode.indexOf("continue") === 0 ? "var(--ok)" : "var(--warn)";
      }
      if (!res.ok) return res.text().then(function (t) { throw new Error(t); });
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split("\\n");
          buf = lines.pop();
          lines.forEach(function (line) {
            // 流式响应头一开始就固定了,新会话的 cid 只能靠 SSE 注释回传
            if (line.indexOf(": gemini-cid=") === 0) {
              var got = line.slice(13).trim();
              if (got) { $("sid").value = got; addMsg("sys", "本会话 Gemini cid = " + got); }
              return;
            }
            if (line.indexOf("data: ") !== 0) return;
            var payload = line.slice(6);
            if (payload === "[DONE]") return;
            try {
              var j = JSON.parse(payload);
              if (j.error) { acc += "\\n[" + j.error.message + "]"; }
              var d = j.choices && j.choices[0] && j.choices[0].delta;
              if (d && d.content) acc += d.content;
            } catch (e) { /* 忽略半截 JSON */ }
            render();
          });
          return pump();
        });
      })();
    }).catch(function (e) {
      $("chatErr").textContent = String(e && e.message || e);
    }).then(function () {
      $("send").disabled = false;
      history.push({ role: "assistant", content: acc });
      renderFinal();
    });

    function render() {
      clear(bubble);
      bubble.textContent = acc;
      // 图片链接渲染成真图(走本服务的 /img 中转)
      var re = /!\\[[^\\]]*\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, m;
      while ((m = re.exec(acc)) !== null) {
        var img = document.createElement("img");
        img.src = m[1]; img.loading = "lazy";
        bubble.appendChild(img);
      }
      $("log").scrollTop = $("log").scrollHeight;
    }
    function renderFinal() { render(); }
  }
  $("send").onclick = send;
  $("input").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ── 会话 ──────────────────────────────────────────────────
  function loadSessions() {
    return api("/admin/sessions?limit=200").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) throw new Error(d.error.message);
      $("sessHint").textContent = "共 " + d.total + " 个会话(最多显示 200)";
      var tb = $("sessBody"); clear(tb);
      (d.data || []).forEach(function (s) {
        var tr = el("tr");
        var tdId = el("td");
        var a = document.createElement("a");
        a.href = "https://gemini.google.com/app/" + s.cid;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.className = "mono";
        a.textContent = s.cid;
        a.style.color = "var(--accent)";
        tdId.appendChild(a);
        var sub = el("div", "mono muted", s.sid.slice(0, 10));
        sub.style.fontSize = "11px";
        tdId.appendChild(sub);
        tr.appendChild(tdId);
        tr.appendChild(el("td", null, String(s.turns)));
        tr.appendChild(el("td", "muted", s.model || "—"));
        tr.appendChild(el("td", null, s.delta_mode ? "增量" : "前缀"));
        tr.appendChild(el("td", "muted", fmtTime(s.updated_ts)));
        var td = el("td");
        var use = el("button", null, "使用");
        use.title = "把这条 Gemini 会话当作会话 id 继续聊";
        use.onclick = function () {
          $("sid").value = s.cid;
          history = []; clear($("log"));
          addMsg("sys", "已切到 Gemini 会话 " + s.cid + "(拿这个 id 继续聊即可,不必重发历史)");
        };
        var del = el("button", "danger", "删除");
        del.onclick = function () {
          api("/admin/sessions", { method: "POST", body: JSON.stringify({ sid: s.sid }) }).then(loadSessions);
        };
        td.appendChild(use); td.appendChild(document.createTextNode(" ")); td.appendChild(del);
        tr.appendChild(td);
        tb.appendChild(tr);
      });
    }).catch(function (e) { $("sessHint").textContent = String(e.message || e); });
  }
  $("reloadSessions").onclick = loadSessions;
  $("purgeSessions").onclick = function () {
    if (!confirm("删除全部会话记录?下次对话会重新开始(不会删记忆)")) return;
    api("/admin/sessions", { method: "POST", body: JSON.stringify({ all: true }) }).then(loadSessions);
  };

  // ── 记忆 ──────────────────────────────────────────────────
  function memHeaders() { return { "X-Memory-Scope": $("memScope").value.trim() || "default" }; }
  function loadMem() {
    return api("/v1/memories", { headers: memHeaders() }).then(function (r) { return r.json(); }).then(function (d) {
      var tb = $("memBody"); clear(tb);
      if (d.error) { tb.appendChild(el("tr")).appendChild(el("td", "err", d.error.message)); return; }
      (d.data || []).forEach(function (m) {
        var tr = el("tr");
        tr.appendChild(el("td", null, m.content));
        tr.appendChild(el("td", "muted", m.source || ""));
        tr.appendChild(el("td", "muted", fmtTime(m.updated_at)));
        var td = el("td");
        var del = el("button", "danger", "删除");
        del.onclick = function () {
          api("/v1/memories", {
            method: "DELETE",
            headers: memHeaders(),
            body: JSON.stringify({ id: m.id })
          }).then(loadMem);
        };
        td.appendChild(del);
        tr.appendChild(td);
        tb.appendChild(tr);
      });
    });
  }
  $("loadMem").onclick = loadMem;
  $("addMem").onclick = function () {
    var v = $("memNew").value.trim();
    if (!v) return;
    api("/v1/memories", {
      method: "POST", headers: memHeaders(), body: JSON.stringify({ memories: [v] })
    }).then(function () { $("memNew").value = ""; loadMem(); });
  };
  $("purgeMem").onclick = function () {
    if (!confirm("清空该记忆域的全部内容?")) return;
    api("/v1/memories", { method: "DELETE", headers: memHeaders(), body: "{}" }).then(loadMem);
  };

  // ── 出口池 ────────────────────────────────────────────────
  function scoreBar(score) {
    var wrap = el("div", "row");
    var bar = el("div", "bar");
    var fill = el("i");
    fill.style.width = Math.max(0, Math.min(100, score)) + "%";
    fill.className = score >= 70 ? "ok" : score >= 30 ? "" : "bad";
    bar.appendChild(fill);
    wrap.appendChild(bar);
    wrap.appendChild(el("span", "mono", String(score)));
    return wrap;
  }
  function loadEgress() {
    return api("/admin/egress").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) throw new Error(d.error.message);
      $("egressHint").textContent = "共 " + d.data.length + " 个出口,来源:" +
        (d.source === "stored" ? "已保存配置" : "默认配置") +
        (d.forced ? " · 已强制 " + d.forced : " · 按分数自动择优");
      $("probeImg").checked = !!d.probe_image;
      $("poolText").value = d.data.map(function (e) { return e.kind === "proxy" ? e.target : e.target === "direct" ? "direct" : "colo:" + e.target; }).join("\\n");
      var tb = $("egressBody"); clear(tb);
      d.data.forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", "mono", e.label + (e.forced ? " ★" : "")));
        var sc = el("td"); sc.appendChild(scoreBar(e.score)); tr.appendChild(sc);
        tr.appendChild(el("td", null, textStatus(e.text_status)));
        tr.appendChild(el("td", null, imgStatus(e.image_status)));
        tr.appendChild(el("td", "mono", e.latency_ms ? e.latency_ms + "ms" : "—"));
        tr.appendChild(el("td", "muted", fmtTime(e.updated_ts)));
        var td = el("td");
        var force = el("button", null, e.forced ? "取消强制" : "强制");
        force.onclick = function () {
          api("/admin/egress", {
            method: "POST",
            body: JSON.stringify({ action: "force", id: e.forced ? "" : e.id })
          }).then(loadEgress);
        };
        var one = el("button", null, "测试");
        one.onclick = function () {
          one.disabled = true; one.textContent = "测试中";
          api("/admin/egress", {
            method: "POST",
            body: JSON.stringify({ action: "test", ids: [e.id], image: $("probeImg").checked })
          }).then(function () { loadEgress(); });
        };
        td.appendChild(force); td.appendChild(document.createTextNode(" ")); td.appendChild(one);
        tr.appendChild(td);
        tb.appendChild(tr);
      });
    }).catch(function (e) { $("egressHint").textContent = String(e.message || e); });
  }
  function textStatus(s) {
    if (!s) return "未测";
    if (s === "ok") return "正常";
    if (s === "empty") return "空响应";
    if (s === "timeout") return "超时";
    if (s === "1060") return "1060 风控";
    if (s === "429") return "429 限流";
    if (s === "error") return "错误";
    return s;
  }
  function imgStatus(s) {
    if (!s || s === "skipped") return "未测";
    if (s === "ok") return "可出图";
    if (s === "blocked") return "被拒";
    return "错误";
  }
  $("reloadEgress").onclick = loadEgress;
  $("testEgress").onclick = function () {
    var b = $("testEgress"); b.disabled = true; b.textContent = "测试中…";
    $("egressHint").textContent = "正在逐个探测(含图片生成,可能要几分钟)…";
    api("/admin/egress", {
      method: "POST", body: JSON.stringify({ action: "test", image: $("probeImg").checked })
    }).then(function () { b.disabled = false; b.textContent = "测试全部"; loadEgress(); })
      .catch(function () { b.disabled = false; b.textContent = "测试全部"; loadEgress(); });
  };
  $("probeImg").onchange = function () {
    api("/admin/egress", {
      method: "POST", body: JSON.stringify({ action: "probe_image", enabled: $("probeImg").checked })
    });
  };
  $("savePool").onclick = function () {
    var list = $("poolText").value.split("\\n").map(function (s) { return s.trim(); }).filter(Boolean);
    $("poolErr").textContent = "";
    api("/admin/egress", { method: "POST", body: JSON.stringify({ action: "pool", pool: list }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { $("poolErr").textContent = d.error.message; return; }
        loadEgress();
      });
  };
  $("resetPool").onclick = function () {
    api("/admin/egress", { method: "POST", body: JSON.stringify({ action: "pool", pool: [] }) })
      .then(function () { loadEgress(); });
  };

  // ── 状态 ──────────────────────────────────────────────────
  function kv(container, pairs) {
    clear(container);
    pairs.forEach(function (p) {
      container.appendChild(el("b", null, p[0]));
      container.appendChild(el("span", "mono", String(p[1])));
    });
  }
  function loadStatus() {
    return Promise.all([
      api("/health").then(function (r) { return r.json(); }),
      api("/admin/state").then(function (r) { return r.json(); }),
      api("/admin/egress").then(function (r) { return r.json(); })
    ]).then(function (a) {
      var h = a[0], s = a[1], eg = a[2];
      kv($("statusKv"), [
        ["版本", h.version], ["默认模型", h.defaultModel],
        ["模型数", h.model_count], ["cookie", h.cookie ? "已配置" : "缺失"],
        ["cookie 来源", s.cookie_source || "—"], ["构建号 BL", h.bl || "—"],
        ["出口池", (h.egress_pool || []).join(", ") || "—"],
        ["强制出口", h.egress_force || "自动"],
        ["会话续聊", h.session_memory ? "开" : "关"], ["长期记忆", h.memory ? "开" : "关"],
        ["记忆自动提炼", h.memory_auto_extract ? "开" : "关"],
        ["图片中转", h.image_proxy ? "开" : "关"], ["对外域名", h.public_origin || "未配置"],
        ["R2", h.r2_bound ? "已绑定" : "未绑定"],
        ["出口探测", s.egress_probe_image === undefined ? "—" : String(s.egress_probe_image)]
      ]);
      var rows = (eg && eg.data) || [];
      var imageCapable = rows.filter(function (r) { return r.image_status === "ok"; });
      kv($("imgKv"), [
        ["可出图出口", imageCapable.length ? imageCapable.map(function (r) { return r.label; }).join(", ") : "暂无(受上游账号/出口限制)"],
        ["当前择优顺序", (eg && eg.order || []).join(" → ") || "—"]
      ]);
    }).catch(function (e) { kv($("statusKv"), [["错误", String(e.message || e)]]); });
  }
  $("reloadStatus").onclick = loadStatus;

  // 启动
  if (key) loadHealth().then(function () { loadStatus(); });
  else setLive(false, "请填 API Key");
})();
</script>
</body>
</html>
`;
