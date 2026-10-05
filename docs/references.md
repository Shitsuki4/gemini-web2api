# 参考项目与传输对照

本次不只读 README；对照实际请求构造、传输选择顺序、Cookie/XSRF、响应包络，并在同一 Cloudflare SQLite DO 内发起受控测试。所有测试只使用本人的已登录账号，未引入外部代理、常驻浏览器中转或付费服务。

## 固定版本

| 来源                                                                          | 固定提交                                   | 实际采用 / 未采用                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [zexadev/gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go)     | `2158ea0bce6f5ae9cd7e8e9c04d4fd58b7986195` | 网页模型头、97 槽位请求体、上传/轮换/会话等协议。没有移植 Go 服务器或 TLS 指纹库。                                              |
| [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api) | `2bb988bfcbb82a7fab5d2c99aa5560ff40d64f7e` | 对照 Python 主包及 `cloudflare/worker.js`。Cloudflare 版使用 fetch；随机 UA/CH 等 HTTP 头不会改变平台 TLS，未将它当作成功保障。 |
| [one880808/gemini-web2api](https://github.com/one880808/gemini-web2api)       | `a7cd9f6ba64631d4cdeeb4663ca0902b9f5d516a` | 确认 Cloudflare 原生 TCP/TLS socket 路径、HTTP/1.1 请求及分块。生产 transport 独立实现，未复制原有宽松解析器。                  |
| 接手前的本仓库 main                                                           | `cf94c7d`                                  | 保留其历史；对照 `socketHttp`、`httpFetch`、`EgressRelay`、at/XSRF 及较新请求字段。one880808 的上述提交已在其祖先历史中。       |
| 本仓库早期 worker                                                             | `79f0c32`                                  | 早期只有 fetch；不能把这个版本与后来带 socket 的版本混为一谈。                                                                  |

## 关键差异

旧版 `httpFetch` 优先选择 DO egress，然后才考虑 socket；但 `EgressRelay.fetch` 内部仍调用平台 `fetch`。因此“有地域 DO”并不意味着请求已经走原生 socket。首次重写保留了 DO、却使用 fetch，遗漏了真正值得复测的传输路径。

新实现由 `GeminiAccount` 为 `GeminiClient` 注入 `socketTransport()`，涵盖页面令牌、文本生成、RPC、上传、下载及 Cookie 轮换。所有数据面代码运行在 Cloudflare。Roxy 仅在导入/重新登录时使用。

没有盲目把请求体改成 102 槽：旧版、one880808、Python 包和当前网页的槽位数存在差异，但本次当前 97 槽实现已经实际完成文本、续聊、SSE。后续功能应逐项实测，不能靠槽位数推断兼容性。

## 同环境对照（2026-10-05）

| 请求                                          | 传输            | 结果                                            |
| --------------------------------------------- | --------------- | ----------------------------------------------- |
| Gemini `/app`，wnam DO                        | fetch           | 302 → Google `/sorry/index`                     |
| 同页面、同凭据、同一 DO                       | 原生 socket     | 200，有页面令牌，无验证页                       |
| Gemini `/app`，weur DO                        | fetch / socket  | fetch 重定向验证；socket 返回页面令牌           |
| one880808 原始 payload，匿名                  | socket，wnam    | HTTP 200，收到测试要求的固定答案                |
| one880808 原始 payload，登录 Cookie           | socket，wnam    | HTTP 400；其原始请求没有正确携带本次登录所需 at |
| 原 main 的 payload + XSRF                     | socket，wnam    | HTTP 200，收到固定答案                          |
| 当前 GeminiClient + 原 socket                 | socket，同一 DO | 收到固定答案                                    |
| 当前 GeminiClient + 新的严格 socket transport | socket，同一 DO | 收到固定答案；两种 Cookie 导入方式均通过        |

正式网关的旧账号 DO 仍返回 `1060`；新建账号 DO 后，同一账号登录态在正式 `/v1` 接口通过。**不能据此断言 1060 唯一由地区或 IP 导致**；旧对象不会因修改 location hint 自动迁移，本次没有掌握其确切出口。旧测试对象保留为停用，新对象固定使用，不做循环建对象、IP 池或自动重放。

完整端点验收和未通过项目见[验收记录](verification.md)。这些结果纠正了此前“纯 Cloudflare 不可行”的过度判断，但不保证 Google 永久接受任意 Cloudflare 出口或全部模型权益。

## Spark Beta 协议取证（2026-10-05）

三个参考库及原仓库均没有可采用的 Spark agent 适配；本轮来自用户授权账号的独立测试标签页，未改动其已有任务或关联应用。

- Spark 是 `/spark` 下的任务产品，仍经 `StreamGenerate` 请求；不是普通模型别名。
- 初始请求 99 槽，tool `40`，slot 6=`[1]`、30=`[4,16]`、68=`2`、83=`1`、98=`1`。正常模型仍保持 97 槽。
- 续聊保持 slot 2 为空，用 slot 71 的 conversation ID / cursor；cursor 由响应 slot 2 的字段 26 更新。终止事件为字段 44/46；进度字段 7 不当答案或媒体导出。
- 实测网页模型头 hash 为 `56fdd199312815e2`、slot 11=`2`，保留观察到的完整 capability 序列和 slot 19 时间戳结构。不凭该请求名声明真实后端模型版本。浏览器中，缩短后的模型头曾产生无答案终止；完整头的同适配器返回了测试答案，但这个对照本身不等于 Cloudflare 成功。
- 浏览器挑战字段 slot 3/4 不复制、不伪造；没有引入验证码处理、外部转发或常驻 Roxy。抓包不作为仓库附件，只保留合成协议测试。
- 同时修复 `/app` 页面 CSP 响应头约 21 KiB 超出旧 8 KiB 限制的问题：header field 上限 32 KiB、总头部 64 KiB，状态行/分块行仍 8 KiB。

## 本次登录维护对照

- Go `internal/app/rotate.go`：采用双轮换流程、JSPB 哨兵原样发送、最小 Cookie 对、产品 658 的页面参数、首次 15 秒/正常 10 分钟、独立保存成功票据。其注释明确区分 PSIDTS 短期票据与 SIDCC，且指出部分 Chrome 会话的设备绑定限制。
- 接手前本仓库 `cf94c7d` 的 `refreshSession` / `mergeSetCookies`：保留独立 GET `/app` 与响应 Cookie 持久化的原则；不能把页面令牌刷新当作票据长期续期。
- Sophomoresty 的 `gemini-cookie-sync-extension` 是 popup 手动导出/同步入口，未提供自动运行的 background 续期；没有把它误当作纯 Cloudflare 保活实现。one880808 与 Sophomoresty 的 Worker 未发现这两条 PSIDTS/SIDCC 自动轮换流程。
- 此版新增而非直接照搬的保护：跨部署持久退避、三项独立状态、SIDCC 已随短票下发时去除重复 POST、SIDCC 单项失败不拖延短票维护、正确 Cookie 删除/共享域校验、生成健康度与维护状态分离。

线上首次检查旧会话时两条轮换均 401、页面已失效；一次性更新原账号后 Cloudflare Alarm 成功换发 PSIDTS，并附带 `__Secure-1PSIDCC`。紧随其后的额外 SIDCC POST 返回 429，促成了上面的重复请求消除。后续多轮验收见 [验证记录](verification.md)，不是仅根据参考项目 README 声称可用。
