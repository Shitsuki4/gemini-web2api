// Pure formatter shared by the console and its regression tests.
export function loginStatus(r) {
  const m = r.maintenance;
  const d = r.page_diagnostic;
  const stamp = (t) => (t ? new Date(t * 1000).toLocaleString() : "待检查");
  const detail = `；最近页面：${d ? `${d.kind} / ${d.code || "ok"} (${stamp(d.at)})` : "暂无诊断"}；票据维护：${stamp(m?.nextRotationAt || m?.nextAttemptAt)}；页面检查：${stamp(m?.nextPageAt || m?.nextAttemptAt)}`;
  const load =
    typeof r.busy === "boolean"
      ? `；账号：${r.busy ? "处理中" : "空闲"}；排队：${r.queued ?? 0}/${r.queue_capacity ?? 4}${r.rate_limit ? `；本分钟生成：${r.rate_limit.used}/${r.rate_limit.limit}` : ""}`
      : "";
  return (
    (m
      ? `保活：${m.status}；票据：${m.ticket?.code || m.ticket?.status || "待检查"}；SIDCC：${m.sidcc?.code || m.sidcc?.status || "待检查"}；页面：${m.page?.code || m.page?.status || "待检查"}`
      : "尚未进行保活检查") +
    detail +
    load
  );
}
