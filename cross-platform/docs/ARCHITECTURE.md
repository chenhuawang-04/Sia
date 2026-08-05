# 架构说明

## 进程与数据流

```text
块视图 UI（原生 HTML/CSS/JS）
        │ Tauri invoke
        ▼
客户端应用服务（Rust commands）
   ├── 文档校验（branchly-core）
   ├── SQLite WAL：当前文档、快照、outbox、设置
   ├── 本地图片目录：内容哈希、回收站
   └── 同步执行器：拉取 → 合并 → 条件推送
                         │ HTTPS
                         ▼
              Axum 同步 API
                 ├── PostgreSQL（版本、设备、文档）
                 └── 对象存储（图片）
```

## 边界划分

1. `branchly-core` 不依赖 Tauri、SQLite 或 HTTP。客户端和服务端必须共同使用它校验
   文档与同步消息。
2. UI 只调用 `BranchlyPlatform`，不能直接依赖 HTTP 或 Tauri。Web 版适配器继续调用
   现有 Node API，原生适配器调用 Rust command。
3. SQLite 是客户端本地事实源。云端不可用不阻塞保存、图片查看或任何编辑。
4. 同步服务不理解画布布局，只管理经过共享核心校验的版本化文档和资源清单。
5. Web、Windows WebView2 与 Android WebView 共用 `clipboard-images.js` 解析系统粘贴事件；
   UI 只把提取出的 `File` 交给 `BranchlyPlatform`。Web 通过 Node 图片 API 写入，原生端
   继续通过限流的二进制 IPC 写入本地图片仓库，不在 JSON 中嵌入图片字节。

## 可靠性约束

- 每次文档变更在一个 SQLite 事务内写入文档和 outbox。
- 数据库启用 `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、5 秒 busy timeout。
- 应用启动执行迁移和 `quick_check`；失败时不覆盖文件，进入只读恢复流程。
- 保留最近 30 个事务前本地快照，并维护最新、上一份两个独立 SQLite 物理备份。
- 图片先写同目录临时文件，校验签名与 SHA-256 后原子重命名。
- 删除图片先进入回收站；只有云端确认删除且超过保留期后才清理。
- outbox 可重复执行，服务端请求使用 operation ID 保证幂等。
- 任何同步冲突都不能静默覆盖本地内容；无法自动合并时生成“冲突副本”。

## 性能约束

- UI 不引入大型框架，延续当前按可见层级渲染和语义缩放。
- JSON 文档上限保持 5000 节点、80 层、500 关系；解析和校验在线程池执行。
- 已保存图片不回读进 WebView JS 堆，使用 Tauri asset protocol 直接读取本地文件。
- 剪贴板图片仅在上传时短暂以 `File`/二进制 IPC 传递；同一原生客户端串行写图，Web
  最多三并发，并为每个目标块预留容量，避免并发突破 200 张上限。
- 同步传输启用压缩、ETag 和增量资源清单；图片按哈希去重且并发上限为 2。
- SQLite 连接数保持很小；前台保存优先于后台同步。
- Windows 使用单实例插件，第二次启动只唤醒现有窗口，避免两个编辑进程竞争同一本地文档。

## 安全模型

- 本地工作空间保留固定访问密码 `xrune1123459`，只在内存中保持解锁态。
- 云令牌不进入 SQLite；本地工作空间密码经 Argon2id 与设备随机盐派生密钥，令牌使用
  XChaCha20-Poly1305 认证加密并以双文件原子轮换保存。
- 服务端只保存 Argon2id 密码哈希和刷新令牌哈希。
- 所有云接口只允许 TLS；客户端拒绝明文云端地址（开发模式除外）。
- 图片按实际文件签名和声明 MIME 双重校验，文件名永远由应用生成。
