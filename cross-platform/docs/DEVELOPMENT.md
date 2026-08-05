# 开发与构建准备

当前工作区按要求未在本机执行构建。本机没有 Rust/Cargo、Windows SDK 或 Android SDK。
`Cargo.lock` 由通过质量检查的 GitHub Linux runner 解析生成并提交；质量检查与发布构建
一律使用 `--locked`，避免不同平台或不同时间解析出不一致的依赖版本。

## GitHub 仓库准备后

基础工具：

- Rust stable 1.81+
- Node.js 20+（仅用于现有 Web 测试和辅助脚本）
- Windows：Microsoft WebView2、Visual Studio Build Tools 2022（C++ workload）
- Android：JDK 17、Android SDK 35、NDK 27、Rust Android targets

GitHub 原生构建在客户端目录固定安装预编译的 `@tauri-apps/cli@2.11.4` 并通过 `npx`
调用，避免每次 runner 都从源码编译 Tauri CLI，同时让 Android Gradle 任务能够解析稳定的
本地 CLI 路径；应用自身的 Rust 依赖仍严格按工作区 `Cargo.lock` 构建。

首次生成 Android 工程：

```bash
cargo install tauri-cli --version "^2" --locked
cd cross-platform/apps/client
cargo tauri android init
```

质量检查：

```bash
node --check public/platform.js
node --check public/app.js
node --check server.js
cargo test --locked --manifest-path cross-platform/Cargo.toml --workspace
```

Windows 构建：

```powershell
cd cross-platform/apps/client
cargo metadata --locked --manifest-path ../../Cargo.toml --no-deps
cargo tauri build
```

Android 构建：

```bash
cd cross-platform/apps/client
cargo metadata --locked --manifest-path ../../Cargo.toml --no-deps
cargo tauri android build --apk
```

发布构建不得把同步地址、JWT secret、签名密码或对象存储密钥写进仓库。Android keystore
和 Windows 代码签名证书只通过 GitHub Environments secrets 注入。
