# 验收记录 · 2026-10-05

## 结论

**这是已经部署并做过真实失败诊断的实验性 Cloudflare 原生重构，不是已打通的 Gemini 服务。** 未获得真实文本/媒体成功响应，未替换原线上 Worker，未宣称与参考 Go 项目完全等价。

## 证据 → 发现 → 下一步

| 证据                                                                                     | 发现                                                     | 下一步                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Workers Free 上独立部署成功，D1 migration 和 secrets 上传成功                            | 运行时不需要外部服务器；资源绑定成立                     | 保留独立实例，不直接切生产                                     |
| 管理鉴权、账号导入、`/v1/models` 成功                                                    | 控制面可用，但不是生成成功证据                           | 运行真实 smoke                                                 |
| Roxy 当前登录页存在有效 WIZ 字段；脚本成功导入 Cookie，未输出原值                        | 取得了浏览器登录态                                       | 判断该登录态是否能在 Cloudflare 出口使用                       |
| 更新 Cookie 和导入 User-Agent 后，文本 smoke 仍返回 `502 / egress_blocked`               | Google 的 302 目标为 `/sorry` 验证页；不能归结为部署成功 | 不绕过验证，不盲目重试，不加入违反纯 Cloudflare 条件的外部代理 |
| Cloudflare Browser Run `/content` 两次返回 422 / code 5006，`Network connection closed.` | 原生浏览器路径未验证可用；也不能据此证明永久不可用       | 未接入生产传输；官方免费额度仅 10 分钟/天                      |
| 本地单元测试和 workerd/SQLite DO/D1 集成测试通过                                         | 覆盖协议构造、解析、鉴权、隔离、SSE、媒体模拟、Alarm 等  | 不能替代真实 Google 验收                                       |

原始 Cookie、XSRF、跳转查询串、Google 页面 HTML 均不作为报告附件或仓库内容。保留的错误仅是分类、HTTP 状态和不含凭据的描述。

## 可复现检查

```powershell
npm ci
npm run check
npm test
npm run format:check
npm run build
```

真实测试：按照 README 导入自己的 Roxy 账号后执行 `npm run smoke`。Google 出口策略会随时间、地区和账号变化，本次失败结果不代表所有未来部署必然失败，但也没有证据保证任一纯 Cloudflare 部署可稳定工作。

本地最终检查：**67 项测试通过**；TypeScript 检查、Prettier 检查、Wrangler dry-run 打包通过。桌面管理台鉴权正常、输入密钥清空、localStorage 为空；390px 移动视口无页面横向溢出，浏览器未捕获 JavaScript 异常。

## 测试范围

- 模型头/UUID/97 槽位、XSSI 包络、UTF-8 分片、实际模型、无私有推理输出。
- Cookie 合并、最小轮换 Cookie 集、加密认证数据、输入边界。
- 跳转不泄漏 token，不跟随到不可信上传/下载地址。
- Worker 真实运行时 fetch 绑定、D1 事务、SQLite DO 状态。
- API/Admin 分离、Key 撤销、会话/媒体所有者隔离、伪造会话拒绝。
- Chat 流增量、Responses 正常与失败事件，不把上游拒绝当成功。
- 无 Cron 统计、Alarm 清理、媒体/视频**模拟上游**状态流转。
- 管理台独立浏览器标签页检查与桌面截图检查。

## 仍未完成的验收

1. 从 Cloudflare 直接完成真实文本生成、第二轮续聊及正常 SSE。
2. 真实附件上传、图片、音乐、Canvas、视频及下载。
3. 24 小时以上的 Cookie 轮换可靠性、Free 额度持续时间/CPU 压测。
4. 不同 Gemini 权益和模型 ID 的实际可用性。
5. 完整 OpenAI/Google 客户端生态兼容性；本实现只提供文档列出的子集。

在这些条件未满足前，不应标记 production-ready。当前可交付的是源代码、测试、独立管理台和明确的阻断诊断。
