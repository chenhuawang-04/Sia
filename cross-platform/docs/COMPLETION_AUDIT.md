# 开发与正式发布完成度审计

审计日期：2026-08-05。本文件把源码实现、自动化测试、目标平台运行证据和公开发布证据
分开记录，不以静态检查代替签名、安装或运行验证。

## 结论

Branchly `v2.0.0` 已作为非草稿、非预发布的正式 GitHub Release 公开发布：

- Release：<https://github.com/chenhuawang-04/Sia/releases/tag/v2.0.0>
- 签名发布流水线：<https://github.com/chenhuawang-04/Sia/actions/runs/30982988934>
- 发布提交：`40e1c9f86a81e027047ace1add7cb68342f49a62`
- 流水线结论：`windows-release`、`android-release`、`android-release-smoke`、
  `publish` 四个 job 全部成功。

Android APK 使用项目长期 release keystore 签名，并在 Android 9/API 28 模拟器完成验签、
安装、Launcher 启动和启动 12 秒后的进程存活检查。Windows MSI 与 NSIS 安装包使用
Authenticode 签名并核对发布证书指纹；Windows 应用完成 12 秒启动存活检查。

Windows 当前使用项目自签名代码签名证书，签名本身真实且可验证，但不具备商业 CA 公共
信任链，Windows SmartScreen 仍可能显示“未知发布者”或信誉警告。不得将其描述为商业
CA 签名。公开 `.cer` 只包含公钥，不包含私钥。

## `2.1.0` 后续功能与三端验证

当前 `main` 源码版本已提升为 `2.1.0`，加入“选中块后粘贴剪贴板图片”。这一版本尚未
创建新的正式签名 GitHub Release；下列证据针对当前源码和 CI artifacts，最近正式公开
版本仍是上文记录的 `v2.0.0`。

- 权威提交：`02e85fcdee72c683f9601f5328c61c95526063ce`。
- Web：`clipboard-images.js` 从 `ClipboardEvent.clipboardData` 提取图片；工具栏按钮还可在
  用户手势中调用 Clipboard API。文本框、文本域和 contenteditable 保持普通粘贴行为。
- Windows/Android：同一前端经 `BranchlyPlatform` Native adapter 接收 WebView 系统剪贴板
  图片，并复用已有二进制 Tauri IPC、本地原子图片仓库和 SQLite 文档保存路径。
- 交互可靠性：上传期间按目标块预留容量；同一块不会并发突破 200 张；目标块中途删除时
  自动清理未挂载文件；只接受不超过 12 MB 的 JPG/PNG/WebP/GIF/AVIF。
- 7860 实际服务：密码登录、首页、剪贴板模块、平台适配器和应用脚本均返回 HTTP 200，
  三个脚本加载顺序及粘贴监听已核对。
- Quality run `31021445821`：成功：
  <https://github.com/chenhuawang-04/Sia/actions/runs/31021445821>。
- Native Builds run `31021476021`：Windows、Android、Android 9 smoke 全部成功：
  <https://github.com/chenhuawang-04/Sia/actions/runs/31021476021>。
- Windows artifact `branchly-windows-unsigned`：ID `8937121583`，12,230,537 字节；构建后
  实际启动并保持 12 秒。
- Android artifact `branchly-android-unsigned`：ID `8937260366`，24,932,735 字节；APK
  badging 为 `versionName='2.1.0'`、`versionCode='2001000'`，包名为
  `io.branchly.mindmap`。
- Android 9/API 28：临时 CI key 签名副本通过 `apksigner verify`；runner 的流式安装超时
  后，门禁按设计重启 ADB 并切换非流式安装，返回 `Success`；Launcher 注入成功，等待
  12 秒后进程仍存活。该临时签名只用于安装门禁，不冒充正式 release key。

## 功能与架构审计

| 明确要求 | 权威实现证据 | 当前结论 |
|---|---|---|
| Windows + Android | Tauri 2、共享 UI、Android minSdk 28、正式签名构建 | Windows MSI/NSIS 与 Android signed APK 已发布 |
| 与原项目功能一致 | `public/app.js` 承载块视图、关系、标注、图片、切分、重归属、搜索、撤销等；`platform.js` 替换存储边界 | 已实现；Web 基线仍在 7860 运行 |
| 低占用 | 系统 WebView、二进制图片 IPC、单并发图片、HTTP 连接池、SQLite/图片分离 | 已实现；数值性能基准仍需目标真机测量 |
| 本地自动持久化 | SQLite WAL/FULL 事务、450ms 合并保存、隐藏前强制刷新、最多每 5 秒物理备份 | 已实现并通过 Rust 原生测试 |
| 损坏恢复 | `quick_check`、损坏现场保留、最新/上一物理备份三级恢复、30 个事务前快照、恢复 UI | 已实现 |
| 图片可靠性 | 文件签名、大小限制、原子写入、SHA-256、七天回收站、首次资源迁移 | 已实现 |
| 云同步 | HTTPS、PostgreSQL CAS、持久化 outbox、幂等 operation、指数退避、资源对象存储 | 已实现并通过真实 PostgreSQL HTTP 端到端测试 |
| 多设备冲突 | 保存 local/remote 双副本、重基、用户选择本机或云端、采用前再次快照 | 已实现；CAS 冲突路径已通过端到端测试 |
| 云账户安全 | Argon2id、账户限流、JWT 15 分钟、刷新令牌原子轮换/撤销、token version | 已实现；重复注册、错误登录、旧 refresh token 重用等已测试 |
| 本地凭据安全 | Argon2id 设备盐派生、XChaCha20-Poly1305、双文件原子轮换、锁定时密钥清零 | 已实现 |
| 高可用云服务 | 无状态 Axum 副本、PostgreSQL 行锁、S3 兼容存储、健康探针、优雅关闭、维护任务 | 已实现；多副本故障演练仍需生产部署环境 |
| 导入/导出 | 原 JSON 导入；原生导出到系统文档目录并原子命名 | 已实现 |
| 可维护架构 | 共享 `branchly-core`、平台适配器、客户端/服务端边界、SQL migrations、固定 `Cargo.lock`、文档和 CI | 已实现 |

## 正式发布资产

| 资产 | 字节数 | SHA-256 |
|---|---:|---|
| `Branchly-v2.0.0-android.apk` | 66,877,274 | `48ad73528281b818c417e46cbec6bc4a660897016bfedd7aac575bd6c007f815` |
| `Branchly_2.0.0_x64-setup.exe` | 5,504,640 | `38c7288eedeef1a8ecc5037829a4a83735ac13452b186041999cd3ad91dc7ba2` |
| `Branchly_2.0.0_x64_en-US.msi` | 7,016,448 | `652f7306a344f82655f21ae12a87cf705b2dc5e319ffb64273cd5c4ada97c76f` |
| `Branchly-self-signed-release.cer` | 1,470 | `aa403e9763ff708185838e4acbe7caab589b8d40c11f8af2930e19777d3fcfa4` |
| `SHA256SUMS.txt` | 383 | 包含上述四项发布资产的校验值 |

资产大小取自 GitHub Release API，哈希由发布 job 在合并后的签名 artifact 上生成并随
Release 发布。服务器本地独立下载副本位于被 `.gitignore` 排除的 `releases/v2.0.0/`，
完整下载后使用 `sha256sum -c SHA256SUMS.txt` 再次复核。

## 签名与运行证据

### Android

- 签名证书主题：`CN=Branchly Release, O=Branchly, OU=Software, C=CN`
- 证书 SHA-256：`e6114df0e05e8f26b21e5e9744f23f34305ec42ba4ab239f416b06e4d06d3c32`
- 公钥：RSA 4096 bit。
- `apksigner verify --verbose --print-certs`：`Verifies`，1 个 signer，APK Signature
  Scheme v3 验证成功。
- Android 9/API 28 x86_64 模拟器：`adb install -r` 返回 `Success`；Launcher 事件注入
  成功；等待 12 秒后 `pidof io.branchly.mindmap` 非空。

### Windows

- Authenticode 证书指纹：`7CA10CA87728B49B9FC94BC0FF361BB3B57FF00D`。
- 摘要算法：SHA-256；时间戳服务：`http://timestamp.digicert.com`。
- Tauri/SignTool 分别报告 MSI、NSIS installer 和应用 EXE `Successfully signed`。
- 发布前以 PowerShell `Get-AuthenticodeSignature` 核对 MSI/NSIS 均存在 signer，且 signer
  指纹与导入的 release 证书一致；不一致会直接使流水线失败。
- Windows runner 启动应用后等待 12 秒，进程未提前退出，冒烟测试成功。
- 限制：证书是自签名证书，不能提供商业 CA 的系统默认信任或 SmartScreen 信誉。

## 自动化质量与云端端到端证据

- Quality run `30977709549`：成功：
  <https://github.com/chenhuawang-04/Sia/actions/runs/30977709549>。
- `web-and-rust` job `92215195050` 与 `native-client-tests` job `92215195091` 均通过。
- 云同步测试使用真实 PostgreSQL 17 service、真实 Axum HTTP server 和本地对象存储，覆盖
  readiness/liveness、注册/登录、refresh token 原子轮换、旧 token 禁止重用、图片哈希、
  用户隔离、文档隔离、首次推送、operation 幂等、拉取、CAS 冲突、revision 更新和退出撤销。
- Native Builds run `30976343398` 同时成功生成 Windows 与 Android 原生构建，随后正式
  Signed Release run `30982988934` 重新执行优化 release 构建、签名和平台运行门禁。
- Rust 依赖固定在提交的 `Cargo.lock`；CI 以 `--locked`/`cargo metadata --locked` 检查
  构建依赖图。

## 本机直接证据

- `node --check public/clipboard-images.js public/platform.js public/app.js server.js`：通过。
- `npm test`：19/19 通过，覆盖剪贴板提取/格式/命名/输入区隔离/显式读取、三端适配契约、
  版本一致性、当前文档、服务端安全校验、DOM/IPC 契约和资源路径。
- 7860：密码登录、导图读取、静态资源一致性和监听状态已验证。
- 2026-08-05 本轮核验时真实文档：48 个块、8 条独立关系、6 张被引用图片；测试未改写
  内容，用户在开发期间新增的数据文件也未混入源码提交。

## 仍需线下/生产环境验收的边界

以下事项不阻碍 `v2.0.0` 作为签名正式版本发布，但不能用 CI 模拟器或启动冒烟替代：

1. Windows 10/11 实体设备上的完整安装/卸载、WebView2 交互、SmartScreen 呈现和性能预算。
2. Android 实体设备上的触控、系统返回键、文件选择、后台恢复和厂商 ROM 兼容性。
3. 生产多副本 PostgreSQL/S3 环境的故障切换、对象存储灾难恢复和长期压力测试。
4. 若要求 Windows 默认公共信任与更少 SmartScreen 警告，需要另行购买/接入受信任商业
   代码签名证书，再生成后续 release；当前版本不冒充具备该信任链。
