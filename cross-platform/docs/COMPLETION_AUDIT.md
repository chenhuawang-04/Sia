# 开发完成度审计

审计日期：2026-08-05。这里把“源码已实现”和“已在目标平台构建验证”分开记录，避免
用静态检查冒充 Windows/Android 运行证据。

| 明确要求 | 权威实现证据 | 当前结论 |
|---|---|---|
| Windows + Android | Tauri 2 配置、共享 UI、Android minSdk 28、原生构建 workflow | 源码完成；目标平台构建按要求等待 GitHub |
| 与当前项目功能一致 | `public/app.js` 原样承载块、关系、标注、图片、切分、重归属、搜索、撤销等；`platform.js` 只替换存储边界 | 已实现；Web 基线在 7860 实际运行 |
| 低占用 | 系统 WebView 而非 Electron；二进制图片 IPC；单并发图片；复用 HTTP 连接池；SQLite/图片分离 | 已实现；数值基准等待目标设备 |
| 本地自动持久化 | SQLite WAL/FULL 事务、450ms 合并保存、隐藏前强制刷新、最多每 5 秒物理备份 | 已实现；Rust 恢复测试已写，等待 CI 执行 |
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

## GitHub 阶段必须取得的证据

以下项目不能在当前缺少工具链的主机上伪造，`native-build.yml` 和 `quality.yml` 已准备：

1. `cargo test` 执行共享核心、SQLite 损坏恢复、凭据加密和图片测试。
2. Windows unsigned bundle 构建、启动、WebView2 真机交互和性能预算。
3. Android APK 构建、Android 9/当前版本安装、触控/返回键/文件选择和后台恢复。
4. PostgreSQL + 对象存储的双设备离线、重试、冲突和灾难恢复集成测试。
5. 注入正式签名后生成可分发的 Windows installer 与 Android release artifact。

在这些 GitHub/目标平台证据出现前，只能称为“开发源码完成并等待构建验证”，不能称为
“已发布”或“已通过跨平台验收”。
