# 开发与构建准备

当前工作区按要求未在本机执行构建。本机没有 Rust/Cargo、Windows SDK 或 Android SDK。
因此当前还没有由 Cargo 解析生成的 `Cargo.lock`；GitHub 第一次成功执行质量工作流后必须把
该锁文件提交进仓库，随后发布构建一律使用 `--locked`，避免依赖版本漂移。

## GitHub 仓库准备后

基础工具：

- Rust stable 1.81+
- Node.js 20+（仅用于现有 Web 测试和辅助脚本）
- Windows：Microsoft WebView2、Visual Studio Build Tools 2022（C++ workload）
- Android：JDK 17、Android SDK 35、NDK 27、Rust Android targets

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
cargo test --manifest-path cross-platform/Cargo.toml --workspace
```

Windows 构建：

```powershell
cd cross-platform/apps/client
cargo tauri build
```

Android 构建：

```bash
cd cross-platform/apps/client
cargo tauri android build --apk
```

发布构建不得把同步地址、JWT secret、签名密码或对象存储密钥写进仓库。Android keystore
和 Windows 代码签名证书只通过 GitHub Environments secrets 注入。
