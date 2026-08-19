# Nexum 使用手册

本目录是 Nexum 面向用户使用文档的唯一真源。公开发布仓库中的 README 和使用说明由这里生成或同步，不在 `Nexum-Releases` 单独维护。

## 发布模型

Nexum 使用单一 GitHub Release surface。每个新的完整 release 只生产一份 Universal Runtime；macOS / Windows Desktop installer 在 public CI 中把这份 Runtime 原样嵌入安装包，Linux / macOS / Windows CLI/headless 则直接安装同一 `nexum-runtime.tgz`。Desktop 安装完成后不需要再次从 GitHub 下载业务 Runtime。

`runtime-0.1.0-r9` 是旧的 online Desktop bootstrap baseline；它已经证明 Universal Runtime 与三平台 CLI/headless 路径，但不作为新的 self-contained Desktop topology 的完成证据。新的 Desktop support 以对应 release 的 public installer qualification 为准。

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

在尚未配置 Apple Developer ID / notarization credential 时，macOS 测试/预发布 DMG 使用 ad-hoc bundle seal 验证 `.app` 内部完整性，但这不是 Developer ID 签名，也不是 Apple notarization；用户仍可能需要按 macOS Gatekeeper 提示手工确认。Windows installer 使用 per-user NSIS 安装模型。

## 使用形态

- **Desktop**：目标平台为 macOS 与 Windows。安装包包含 Desktop Shell、bundled Node 与本次 release 的 Universal Runtime；Shell 负责系统壳和本地 Runtime lifecycle，业务能力仍由同一个 Nexum Runtime 提供。
- **CLI / Headless**：macOS、Windows 与 Linux 共享同一个 Universal Runtime tarball；Linux / server / SSH 是主要 headless 使用路径。
- **AI Host**：ChatGPT、Claude、Gemini 等支持 MCP 的 Host 通过 Nexum 访问受控的本地 Project、Files 与 Process 能力。

## 用户状态

程序升级不应覆盖用户状态：

```text
~/.nexum/config.toml
~/.nexum/auth.json
~/.nexum/nexum.db
```

production 与 development 使用独立 state / port / Desktop identity；开发 Nexum 时不要用开发实例覆盖正式实例的数据或系统集成状态。两者各自使用对应 Desktop build 内嵌的 Runtime。

## 文档维护边界

用户文档只在 private `bYiyLi/Nexum` 中维护。`bYiyLi/Nexum-Releases` 是可重建的 generated public mirror / build / qualification / distribution surface；它包含允许公开的 Desktop source/tests/build scripts、用户文档和 public workflow，但这些内容仍由 `Nexum` 的正向 allowlist 生成，不在 public repository 独立维护。production Runtime 与 installer bytes 只作为 GitHub Release assets 分发。

公开 CI 的 workflow 与日志按公开信息设计：它们不得依赖隐藏源码或隐藏日志来保证安全。private Core / Daemon / Web / CLI source、credential、source map、private source-level tests 或内部诊断数据不能进入 public release boundary；Desktop source/tests 是明确允许公开的例外。
