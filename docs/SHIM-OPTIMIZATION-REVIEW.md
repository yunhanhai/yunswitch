# Responses shim 优化对照

2026-11-23，按固定提交 [`560176bbb74a0bceb2dc4836e70b99f33214c1b0`](https://github.com/yunhanhai/agentrouter-responses-shim-sentry-fix/commit/560176bbb74a0bceb2dc4836e70b99f33214c1b0) 检查 AgentRouter Responses Shim 补丁。该提交包含 retry-fixes-v1 至 v7；本机从 `cf1d768` 快进更新，13 个未跟踪的本机运行文件按 SHA-256 核对保留。Gitee、GitHub 与本机 main 在核查时相同。

本次仅更新补丁仓库并评估，没有执行 `apply.ps1`，没有启动或重启个人 shim，也没有更新全局安装副本。本文中的改进建议尚未进入 YunSwitch 产品源码。

## 值得逐项推进的改进

| 优先级 | 思路                                 | YunSwitch 当前情况与采用边界                                                                                                                                                                                        |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | 按供应商设置请求预算                 | 当前首字节、流空闲与非流请求超时主要按应用配置，已区分不同阶段。可增加供应商可选覆盖及明确的恢复总预算；缺省继承已有设置。预算应贯穿实际转发、流读取、退避与诊断，切换备用不能重新获得无限总预算。                  |
| 2      | 输出后中断返回客户端可识别的安全终态 | 当前原生流透传在读取失败或超时时返回流错误，客户端可能只见解码错误。可按 Responses、Chat、Messages 分别发送固定、安全的协议终止事件，并保持诊断为失败/超时；不重放、不伪造成功，也不插入上游原始错误。              |
| 3      | 原生 Responses 的稳定缓存键补齐      | Responses→Chat 转换路径已有按会话生成稳定键的逻辑。原生路径可为明确需要的供应商增加默认关闭的选项；保留显式键，仅从受支持的稳定会话标识派生。无会话标识时不使用随机 UUID 冒充会话缓存，缓存键不能代替资源状态绑定。 |

这些能力应各自形成可测试、可回退的改动。先完成正在进行的模型目录观察修复，再选择其中一项实现；不在本次对照中一并修改重试和路由策略。

## 已有能力与不直接采用的部分

YunSwitch 已有有限的同家重试、供应商熔断和备用切换、输出前 Responses 错误识别、独立的首字节/流空闲超时、并发 429 冷却与恢复许可、取消清理，以及按本地请求标识关联的脱敏诊断。原生状态型 Codex 请求另有一次发送保护；文本、推理或工具活动后不自动重放。重复引入另一套 Node 路由或重试循环会增加维护成本。

以下结论来自静态代码检查，不能当作全部已动态验证：

- `fastFailoverWait` 可能把上游 `Retry-After` 也压到 2 秒，不能据此缩短 YunSwitch 已承诺遵守的共享冷却。
- `writeSseError` 使用原始错误消息；YunSwitch 只能输出固定安全分类，避免把密钥、上游正文或请求内容带入终态。
- 自动删除旧图片会改变上下文，不作为默认兼容行为。若以后需要，应单独启用、限制在协议图片容器内，并明确告知裁剪范围。
- shim 的主备熔断与成功记录不替代 YunSwitch 已有的逐供应商健康机制；保持用户候选顺序和偏好。

## 合成回环结果

7 个场景使用虚构密钥、合成请求和随机回环端口；没有访问个人客户端、真实会话或付费 API。

| 场景          | 观察结果                                                                                                                                          | 对 YunSwitch 的意义                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 路由超时覆盖  | `timeoutMs=25` 被解析进路由预算，但转发入口未传递 `budget`；在全局 500ms 配置下，等待约 90ms 的上游仍返回 200。一次实测总耗时 132ms，非性能基准。 | 引入预算必须验证入口到执行路径，不能只增加配置字段。 |
| 路由重试覆盖  | 路由 `retries=0`、全局额外重试 1 次；先返回 503 再成功，实际发出 2 次请求。                                                                       | 路由覆盖同样未接入；保留显式 0 的语义。              |
| 状态请求      | 带 `previous_response_id` 的请求遇 503 后实际发送 2 次。                                                                                          | 保留 YunSwitch 一次发送保护，不移植此重试行为。      |
| HTTP 鉴权分类 | 401 的 `invalid_api_key` 搭配消息 `Please retry later`，实际被重试。                                                                              | 按结构化错误码分类；正文关键词不能覆盖鉴权失败。     |
| 取消退避      | 429 后在 200ms 退避期间取消客户端，shim 仍发送第二次上游请求。                                                                                    | 取消必须同时终止计时器、排队和后续发送。             |
| 流空闲预算    | 响应头预算 50ms，流空闲预算 400ms；created 后静默 120ms，再 completed，正常完成。                                                                 | 拆分两个阶段是合理设计，YunSwitch 已有对应机制。     |
| 流内鉴权分类  | `invalid_api_key` 搭配消息 `capacity`，`classifyStreamText` 返回 `transient-error`。                                                              | 防止错误重试和错误诊断；不依据任意错误正文猜测。     |

定位入口：[server.mjs](https://github.com/yunhanhai/agentrouter-responses-shim-sentry-fix/blob/560176bbb74a0bceb2dc4836e70b99f33214c1b0/src-patched/server.mjs) 的 `forwardWithRetry` 参数组装，以及 [retry-routing.mjs](https://github.com/yunhanhai/agentrouter-responses-shim-sentry-fix/blob/560176bbb74a0bceb2dc4836e70b99f33214c1b0/src-patched/retry-routing.mjs) 中的路由预算、错误分类和退避处理。

补丁仓库未提供基础包的 `usage.mjs`。评估仅按字节提取固定提交的服务、路由和清理模块，以“调用即失败”的未使用 stub 满足导入，并明确关闭 usage 观察。因此结果覆盖所列转发路径，不等于完整 npm 安装、出站代理、用量统计或个人常驻服务验收。原仓库无网络示例的 8 项清理和 10 项图片限制检查通过，四个补丁入口的语法检查通过；这些结果也不证明上述重试问题已修复。

复现脚本：[review-responses-shim.mjs](../scripts/review-responses-shim.mjs)。提供已包含固定提交的本地补丁仓库即可运行，不会更新或应用补丁：

```powershell
node scripts/review-responses-shim.mjs 'D:\Program Files\develop\agentrouter-responses-shim-sentry-fix'
```

脚本从 Git 对象提取固定快照到临时目录；运行后输出 JSON 摘要并清理临时文件。断言确认的是该固定版本的实际行为，不能把“脚本退出成功”理解为 shim 没有缺陷。

## 来源与许可

基础包 `agentrouter-responses-shim@2.0.1` 为 MIT，通知 `Copyright (c) 2026 stevenarai`。YunSwitch 先前的历史清理改编仍固定于 `ff6277e05beff1bfc61e2a3abc0741deb0d42b3c`，许可副本继续保留在 [AgentRouter-Responses-Shim-MIT.txt](../licenses/AgentRouter-Responses-Shim-MIT.txt)。本次没有把新重试实现或资源复制进产品；后续若实际改编代码，需另行登记文件、固定来源和验证结果。见[来源台账](PROVENANCE.md)。
