# dsh-update-assistant

DSH（DeepSeek Harness）桌面版的更新 / 重启助手。

它解决一个具体问题：桌面壳在安装更新前会要求 Host 进程在 **10 秒内优雅退出**，超时就 SIGTERM 并判定“停机不干净”，直接拒绝安装。而 Host 只有在事件循环清空时才退出——任何插件留下的 ref 计时器都会让这一步永远超时。本插件用**脱离宿主进程树的一次性计划任务**接管“结束进程 → 静默安装 → 校验版本 → 重启”，不依赖那条优雅停机路径。

## 功能

### 界面按钮

对话输入框上方的 dock 里有一个 **「更新插件市场」** 按钮：点击后直接调用 Host 接口把 dshmarket 升到 npm latest（pnpm overlay，不卸载市场），成功后提示“重启 DSH 后生效”。不需要 AI 参与，也不需要脚本。

该接口 `POST /dsh-update-assistant/market-update` 只接受本机（loopback）、同源、且带 `x-dsh-update-client: 1` 头的请求。

### 工具

| 工具 | 作用 |
| --- | --- |
| `update_status` | 查应用版本、已下载待安装包、更新源最新版、插件版本对比、退出阻塞补丁状态、上次执行日志 |
| `update_install` | 安装 updater 已下载的新版本：sha512 校验 → 活跃任务闸门 → 计划任务执行（结束进程 → `installer --updated /S` → 校验注册表版本 → 重启） |
| `app_restart` | 只重启（插件改动后让 Host 重新加载） |
| `plugin_update` | 插件更新：`pnpm add name@ver`（绕过市场对已装包的 `already-installed` 限制），默认自动挑选可更新项，装完可自动重启 |
| `market_update` | 升级插件市场（dshmarket）自身：pnpm overlay 安装，**不卸载**正在运行的市场 |
| `keepalive_repair` | 给 femo-plugin / meow-memory 已知的未 `unref` 计时器补 `.unref()`（按内容定位、幂等）；启动 5 秒后也会自动跑一次 |

## 安装

```powershell
dsh plugin --profile desktop add dsh-update-assistant
# 或本地开发：
dsh plugin --profile desktop add link:C:\path\to\dsh-update-assistant
```

插件是 bundle：装完/升级后需要重启 Host 才会加载新代码（重启后工具才会出现在工具表里）。

## 工作机制

1. 工具把 `runtime/config.json`、`runtime/launch.cmd` 写好，并用 `Register-ScheduledTask` 注册一次性任务 `DSHUpdateAssistant`（`-Once -At <时间>`，交互式运行）；
2. 任务由 Task Scheduler 拉起，**不在 Host 进程树里**，因此杀 Host 不会连带杀掉它；
3. `lib/helper.ps1`：
   - **先校验安装包**（存在性 + Authenticode 签名，`allowUnsigned: true` 可跳过）；
   - 结束安装目录下所有进程（以及命令行含 `dsh-desktop-host` / `dsh-subprocess-local` 的进程）；
   - 静默运行安装包 `--updated /S`，轮询注册表 `DisplayVersion` 直到目标版本（180 秒超时告警）；
   - 重新启动应用，删除自己的任务；
   - 全程写 `runtime/update.log`。

## 安全门控

- 有活跃 agent / 排队消息 / 运行中的后台任务时，默认**拒绝**执行，需要显式 `confirm: true`；
- `update_install` 只在“缓存包版本确实更高、文件存在、sha512 与 `update-info.json` 一致”时才执行；
- `plugin_update` / `market_update` 对包名与版本做严格校验，拒绝含 shell 元字符的输入；
- 强制结束进程会中断当前对话（会话已落盘，重启后可恢复）。

## 已知限制

- 仅支持 **Windows**（依赖 Task Scheduler、注册表、PowerShell 5.1+）；
- `update_install` 需要 updater 缓存里已有安装包（`%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\update-info.json`）；
- `keepalive_repair` 写盘后，**正在运行的 Host 仍使用旧模块**，需要重启才真正生效；
- 修改第三方插件（femo / meow）的文件属于热修，对应插件升级后需要重新执行（启动时与 `plugin_update` 后会自动补）；
- 一次性任务同一时间只保留一个（重复调用会覆盖）。

## 目录结构

```
lib/index.js       # 插件本体（工具注册）
lib/helper.ps1     # 计划任务实际执行的脚本
cordis.patch.yml   # bundle patch（插入插件）
runtime/           # 运行时生成：config.json / launch.cmd / register-task.ps1 / update.log（已 gitignore）
```

## License

MIT
