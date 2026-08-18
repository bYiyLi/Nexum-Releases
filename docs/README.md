# Nexum 使用手册

本目录是 Nexum 面向用户使用文档的唯一真源。公开发布仓库中的 README 和使用说明由这里生成或同步，不在 `Nexum-Releases` 单独维护。

## 当前发布状态

Nexum 当前处于 Phase 10：End-to-End Hardening 与 Release Readiness。Runtime / CLI 已进入 Universal Runtime 与跨平台发布验证阶段；Desktop Shell 仍处于发布边界收敛和平台 installer hardening 阶段。

当前公开 Runtime 测试 / 预发布入口使用 GitHub Release tarball：

```bash
npm install -g https://github.com/bYiyLi/Nexum-Releases/releases/latest/download/nexum-runtime.tgz
nexum help
nexum start
```

`npm` 在这里仅作为本机 tarball installer。Nexum 不通过 npm registry 发布自身 package。

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

用户文档只在 private `bYiyLi/Nexum` 中维护。`bYiyLi/Nexum-Releases` 是可删除、可重建的公开分发表面；其 README、使用手册、公开 qualification workflow、临时 qualification harness 和 Release assets 都由 `Nexum` 的受控源生成。qualification harness 只用于 draft candidate 验证，不进入正式 Release。

公开 CI 的 workflow 与日志按公开信息设计：它们不得依赖隐藏源码或隐藏日志来保证安全。任何不能公开的源码、credential、开发目录、source map、测试源码或内部诊断数据都不能进入 public release boundary。
