import { test } from "node:test";
import assert from "node:assert/strict";

import { UI_HTML } from "../ui.js";

test("UI_HTML is a self-contained page with no template holes", () => {
  assert.ok(UI_HTML.length > 5000, "UI should be a real page");
  assert.match(UI_HTML, /^<!doctype html>/i);
  assert.ok(UI_HTML.trimEnd().endsWith("</html>"));
  // 整段是模板字符串,里面混进反引号或 ${ 会把 worker 一起弄坏
  assert.ok(!UI_HTML.includes("`"), "UI must not contain a backtick");
  assert.ok(!UI_HTML.includes("${"), "UI must not contain a template placeholder");
});

test("UI_HTML ships every console tab and wires the admin endpoints", () => {
  for (const tab of ["chat", "sessions", "memory", "egress", "status"]) {
    assert.ok(UI_HTML.includes('data-tab="' + tab + '"'), "missing tab " + tab);
    assert.ok(UI_HTML.includes('id="tab-' + tab + '"'), "missing panel " + tab);
  }
  // 前端依赖的接口必须在页面里被真正调用,否则页面是死的
  for (const path of ["/v1/chat/completions", "/v1/memories", "/admin/sessions", "/admin/egress", "/health", "/admin/state"]) {
    assert.ok(UI_HTML.includes(path), "UI never calls " + path);
  }
});

test("UI_HTML escapes its script block correctly", () => {
  // 模板字符串里的 \\n 求值后是「一个反斜杠 + n」,浏览器侧正好是换行转义。
  // 这里锁住它,免得以后有人把转义改坏、导致 SSE 逐行解析静默失效。
  assert.ok(UI_HTML.includes('split("\\n")'), "SSE line splitting must survive the template literal");
  assert.ok(UI_HTML.includes('join("\\n")'), "pool textarea must survive the template literal");
  assert.ok(!UI_HTML.includes("\\\\"), "double backslashes would reach the browser literally");
});
