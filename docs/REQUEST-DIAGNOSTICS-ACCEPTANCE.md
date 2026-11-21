# 请求诊断源码与 Windows 验收记录

本次功能在当前 `3.20.1-yunswitch.8` 产品版本号下按 build-only 模式验收。该版本号和公开 `.8` 附件没有更改；下列 runner 包只证明当前源码的运行行为，不是可发布的新版本。

## 源码

- 最终产品源码：`36ee8c9b11c0adb50bba3311e6fb85e811df24e5`。
- [GitHub 源码 CI run 44895445672](https://github.com/yunhanhai/yunswitch/actions/runs/44895445672)：全部成功；前端检查和测试、Linux/Windows/macOS 后端、Windows+WSL2 检查通过。
- 本机 Windows：标准 Clippy（`-D warnings`）、格式、TypeScript、Prettier、renderer build 及新增前端 17 项目标测试通过。Rust `proxy::` 组串行复跑 1,574 项通过；环境曾在并发执行时使一个既有 alpha-search 本地 TCP 测试收到 Windows 连接中止，该组串行复跑后通过。runner CI 是完整跨平台套件通过的依据。

## 干净 Windows runner

[构建与安装验收 run 44895870213](https://github.com/yunhanhai/yunswitch/actions/runs/44895870213) 以相同源码 SHA 在 GitHub-hosted Windows 2022 x64 执行：

- 便携首次运行和 `.7` MSI 升级后的运行环境，各 **48 项通过，0 项失败**。
- 新增诊断界面、脱敏复制、并发冷却与队列、同供应商重试、备用切换、超时和代理停止检查均在两种安装形态下通过。合成密钥与回环上游同时检查密钥、提示/正文、Cookie、工具参数及上游错误文本未进入复制摘要。
- MSI 安装、升级、卸载和迁移数据保留的既有检查也通过。没有读取个人客户端密钥或会话，也没有调用付费 API。

run 上传的 MSI 和 ZIP：

| 文件                                                 |             大小 | SHA-256                                                            |
| ---------------------------------------------------- | ---------------: | ------------------------------------------------------------------ |
| `YunSwitch-v3.20.1-yunswitch.8-Windows.msi`          | 13,856,768 bytes | `41128558d87a34c47e861ddc1358e5ddcae14b8af89ae725cb9123365ed8ecca` |
| `YunSwitch-v3.20.1-yunswitch.8-Windows-Portable.zip` | 13,919,969 bytes | `d41fe913804eb6dd0048154465971c8851b1f9525a6cb6b8eb6244d19bdd4312` |

本机已从 workflow artifact 下载并重新计算 SHA-256；两个文件都与 artifact sidecar 及验收记录吻合。证据目录 `.git/request-diagnostics-accepted` 保存包、`results.json`、进程记录和运行截图。这里记录的包是为了验收临时构建的 `.8` 同版本文件；它们没有上传到公开 Release，不能代替下一正式版本按新版本号生成并验收的产物。

最新使用边界见[请求诊断说明](REQUEST-DIAGNOSTICS.md)。真实供应商、付费账号和长会话组合尚未通过此模拟验收。
