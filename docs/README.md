# Nexum 使用手册

本目录是 Nexum 面向用户使用文档的唯一真源。公开发布仓库中的 README 和使用说明由这里生成或同步，不在 `Nexum-Releases` 单独维护。

## 当前发布状态

Phase 10：End-to-End Hardening 与 Release Readiness 已完成。当前 latest GitHub Release 同时提供 Universal Runtime、macOS arm64 DMG 与 Windows x64 NSIS installer；macOS arm64、Windows x64、Linux x64 CLI/headless 都使用同一个 Universal Runtime tarball。

CLI / Headless 使用 latest GitHub Release tarball：

```bash
npm install -g https://github.com/bYiyLi/Nexum-Releases/releases/latest/download/nexum-runtime.tgz
nexum help
nexum start
```

`npm` 在这里仅作为本机 tarball installer。Nexum 不通过 npm registry 发布自身 package。

Desktop 用户从 `bYiyLi/Nexum-Releases` latest Release 获取对应 installer：

- macOS arm64：`Nexum_<version>_aarch64.dmg`；
- Windows x64：`Nexum_<version>_x64-setup.exe`。

当前 macOS DMG 未使用 Developer ID 签名，也未完成 Apple notarization；它已经通过 Nexum 自身的 source-free installer / Runtime bootstrap gate，但仍可能需要用户按 macOS Gatekeeper 提示手工确认。Windows installer 当前使用 per-user NSIS 安装模型。

## 使用形态

- **Desktop**：目标平台为 macOS 与 Windows。Desktop Shell 负责系统壳、Runtime bootstrap 和本地管理入口；业务能力由同一个 Nexum Runtime 提供。
- **CLI / Headless**：macOS、Windows 与 Linux 共享同一个 Universal Runtime tarball；Linux / server / SSH 是主要 headless 使用路径。
- **AI Host**：ChatGPT、Claude、Gemini 等支持 MCP 的 Host 通过 Nexum 访问受控的本地 Project、Files 与 Process 能力。

## 用户状态

程序升级和 Runtime replacement 不应覆盖用户状态：

```text
~/.nexum/config.toml
~/.nexum/auth.json
~/.nexum/nexum.db
```

production 与 development 使用独立 state / Runtime / port / identity；开发 Nexum 时不要用开发实例覆盖正式实例的数据或系统集成状态。

## 文档维护边界

用户文档只在 private `bYiyLi/Nexum` 中维护。`bYiyLi/Nexum-Releases` 是可重建的公开分发表面；其 README、使用手册、固定 qualification workflow templates、临时 qualification harness 和 Release assets 的维护真源都在 `Nexum`。qualification harness 只用于 public-safe prerelease candidate 验证，不进入正式 Release；失败 candidate 即使暂时保留也必须从上传前就满足公开安全边界，清理不承担保密职责。

公开 CI 的 workflow 与日志按公开信息设计：它们不得依赖隐藏源码或隐藏日志来保证安全。任何不能公开的源码、credential、开发目录、source map、测试源码或内部诊断数据都不能进入 public release boundary。
