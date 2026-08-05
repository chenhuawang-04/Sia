# 开发完成度审计

审计日期：2026-08-05。这里把“源码已实现”和“已在目标平台构建验证”分开记录，避免
用静态检查冒充 Windows/Android 运行证据。

| 明确要求 | 权威实现证据 | 当前结论 |
|---|---|---|
| Windows + Android | Tauri 2 配置、共享 UI、Android minSdk 28、GitHub 原生构建 | 同一提交已成功生成 Windows bundles 与 Android unsigned APK；真机交互仍待设备验收 |
| 与当前项目功能一致 | `public/app.js` 原样承载块、关系、标注、图片、切分、重归属、搜索、撤销等；`platform.js` 只替换存储边界 | 已实现；Web 基线在 7860 实际运行 |
| 低占用 | 系统 WebView 而非 Electron；二进制图片 IPC；单并发图片；复用 HTTP 连接池；SQLite/图片分离 | 已实现；数值基准等待目标设备 |
| 本地自动持久化 | SQLite WAL/FULL 事务、450ms 合并保存、隐藏前强制刷新、最多每 5 秒物理备份 | 已实现；Rust 原生存储/恢复测试已在 GitHub Linux runner 通过 |
| 损坏恢复 | quick_check、损坏现场保留、最新/上一物理备份三级恢复、30 个事务前快照、恢复 UI | 已实现 |
| 图片可靠性 | 实际签名、大小限制、原子写入、SHA-256、回收站七天、首次资源迁移 | 已实现 |
| 云同步 | HTTPS、PostgreSQL CAS、持久化 outbox、幂等 operation、指数退避、资源对象存储 | 已实现 |
| 多设备冲突 | 保存 local/remote 双副本、重基、用户选择保留本机或采用云端、采用前再次快照 | 已实现 |
| 云账户安全 | Argon2id、账户限流、JWT 15 分钟、刷新令牌轮换/撤销、token version | 已实现 |
| 本地凭据安全 | Argon2id 设备盐派生、XChaCha20-Poly1305、双文件原子轮换、锁定时密钥清零 | 已实现 |
| 高可用云服务 | 无状态 Axum 副本、PostgreSQL 行锁、S3 兼容存储、健康探针、优雅关闭、维护任务 | 已实现；集群演练等待部署环境 |
| 导入/导出 | 原 JSON 导入保留；原生导出到系统文档目录并原子命名 | 已实现 |
| 可维护架构 | 共享 `branchly-core`、平台适配器、客户端/服务端边界、SQL migrations、文档和 CI | 已实现 |
| 不在本机构建 | 本机没有 Cargo/Rust/Windows SDK/Android SDK；未安装或模拟构建 | 已遵守 |

## 本机已取得的直接证据

- `node --check public/platform.js public/app.js server.js`：通过。
- `npm test`：8/8 通过，覆盖真实当前文档、服务端安全校验、DOM/IPC 契约和资源路径。
- 7860：密码登录、导图读取、静态资源一致性和监听状态已验证。
- 当前真实文档：23 个块、2 条独立关系、1 张被引用图片，测试未改写内容。
- 已下载并检查 Android unsigned APK：70,977,991 字节，ZIP/APK 结构测试无错误，
  SHA-256 `4088037a3193330cbf2bff9cb6a13fadd7ab76b3b712611a0fe502d3cc29381d`。

## GitHub 已取得的直接证据

- 最终提交：`d34e43262a77918fd4525e345e9cbf7203d9b8ed`。
- Quality run `30976288930`：成功；`web-and-rust` 与 `native-client-tests` 均通过。
- Native Builds run `30976343398`：成功；Windows job `92211010499` 用时 8m25s，
  Android job `92211010502` 用时 13m55s。
- `branchly-windows-unsigned` artifact：ID `8918527632`，12,222,765 字节，未过期。
- `branchly-android-unsigned` artifact：ID `8918633450`，24,917,586 字节（artifact ZIP），未过期。
- 最终 run 页面：<https://github.com/chenhuawang-04/Sia/actions/runs/30976343398>。
- Rust 依赖已提交 `Cargo.lock`；质量检查先以 `--locked` 测试，平台工作流在打包前以
  `cargo metadata --locked` 验证依赖图，然后由 Tauri 使用同一工作区锁文件构建。

## 发布前仍需取得的证据

以下内容依赖真实部署环境、目标设备或正式签名材料，不能用 CI 编译成功替代：

1. Windows 10/11 真机安装、启动、WebView2 交互和性能预算。
2. Android 9 与当前 Android 版本真机安装、触控、返回键、文件选择和后台恢复。
3. PostgreSQL + 对象存储的双设备离线、重试、冲突和灾难恢复集成测试。
4. 注入正式签名后生成可公开分发的 Windows installer 与 Android release artifact。

当前可以称为“源码、自动化质量检查和 unsigned 跨平台构建完成”；在上述设备/部署证据
与正式签名出现前，不能称为“已公开发布”或“已通过完整跨平台真机验收”。
