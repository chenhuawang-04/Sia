# Branchly 跨平台版

本目录是现有 Branchly 块视图思维导图的 Windows / Android 产品化实现。原有
`public/` 仍是 Web 版基线；跨平台客户端通过 Tauri 2 复用同一套界面和交互，Rust
负责可靠的本地数据、图片、认证和云同步。

## 设计目标

- Windows 10/11 与 Android 9+ 共用业务模型、前端和同步协议。
- 本地优先：任何编辑先提交 SQLite，网络不可用时全部功能照常工作。
- 五秒自动持久化只是用户可见状态；真正的本地提交在每次保存命令中以事务完成。
- SQLite 使用 WAL、外键、忙等待和完整性检查；JSON 快照与图片采用原子文件替换。
- 云同步是可选能力。客户端用持久化 outbox、指数退避和条件版本提交，重启不丢任务。
- 不把图片塞进 JSON 或 SQLite；本地文件按 SHA-256 去重，云端使用对象存储。
- 不使用 Electron。Tauri 使用系统 WebView，空闲常驻和安装包体积明显更低。

## 工作区

```text
cross-platform/
├── apps/client/src-tauri/     Tauri 客户端、SQLite 和平台命令
├── crates/branchly-core/      共享文档模型、校验、同步协议
├── services/sync-server/      Axum + PostgreSQL 云同步服务
├── docs/                      架构、同步与发布说明
└── Cargo.toml                 Rust workspace
```

当前阶段按要求只编写和审查源码，不执行构建。准备好 GitHub 仓库后，由 CI 在真实的
Windows 与 Android 工具链中完成格式、测试、签名构建和安装验证。
