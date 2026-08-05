# 功能与验收矩阵

| 能力 | 复用/实现位置 | 验收证据 |
|---|---|---|
| 嵌套块视图、智能关系边 | `public/app.js`, `public/styles.css` | UI 回归用例与平台截图 |
| 主题、描述、`+++重点+++` | Web UI + shared model | 文档校验测试、编辑回归 |
| 图片、数量角标、图库 | UI + native image store | 签名/大小/回收测试 |
| 多条标注 | UI + shared model | 上限与 CRUD 回归 |
| 竖直/水平切分 | UI | 树结构用例 |
| 子树重新归属 | UI | 环检测与后代保持用例 |
| 四类独立关系边 | UI + shared model | 类型、端点、重复关系用例 |
| 精确平移/拖拽 | UI | 鼠标与触控阈值回归 |
| 密码锁 | native auth command | 限流、锁定、恢复测试 |
| 五秒自动保存 | UI 状态 + SQLite | 崩溃重启恢复测试 |
| 本地自动持久化 | SQLite + snapshots | 事务/损坏恢复测试 |
| 云同步 | client outbox + sync service | 离线、重试、双设备冲突测试 |
| Windows / Android | Tauri 2 | GitHub CI 真机构建与安装测试 |
| 低占用 | 系统 WebView + Rust | 发布构建的内存、CPU、包体基准 |
