# Pi Server 统一管理本机任务运行时

## 状态

已接受，待实现。2026-11-14 确认采用与 `pi-better-server` 合并的方案。本文记录目标架构，当前运行时尚未迁移或启用。详细协议、生命周期、迁移和验收见[统一运行时设计](../plans/unified-server-runtime.md)。

## 决策

由每个 canonical Pi agent 目录的单个 `pi-better-server` 统一承担 Subagents 与 Background Tasks 的共享状态索引、投影、机械监督和恢复调度，并保留按需会话托管。普通本地 Pi 通过轻量客户端接入，不因此创建 HostedSession。共享 coordinator 保留领域事实；现有任务 runner、writer lease、权限和执行 token 保留各自职责。

server 内的 Catalog 管理模块统一读取、校验、解析和持久修改 Role 与 Named Agent 定义。Markdown 定义和 catalog `settings.json` 继续保存在个人或可信项目目录；内置定义随固定构建发布且只读，不把它们迁入运行状态数据库。项目、信任上下文与会话分支设置参与解析作用域，不能只按 agent ID 缓存。Pi 的 `/agents` 与 CLI 负责交互；会话临时设置仍属于原会话分支。每次 launch 冻结实际使用的 catalog snapshot 和 LaunchRecipe，定义修改不改变已执行或正在执行的 attempt，也不增加工具、sandbox 或其他权限。

选择复用 server，是因为它已有本地 socket、单实例所有权、会话与活动管理、固定构建及安全升级。另加 runtime daemon 会重复这些职责；仅扩展前台选主则仍把全局工作耦合到某个用户会话的生命周期。

server 按需启动；无客户端、托管保留或可推进后台工作时自动退出。轻量恢复守护器只负责 server 故障恢复，遵守同样的退出与重启预算，不扫描历史，不成为永久系统服务。仅有已完成历史、未读结果或证据 pin 不保活。所有恢复进程都被强杀后，等待下次显式 ensure，不承诺无进程情况下自动复活。

## 影响

统一管理是运行位置的变化，不转移 assignment 的判断权或扩大权限。现有托管会话断开后的保留语义继续成立。配置文件、执行时冻结配方、运行状态和可重建索引分别保留自己的事实来源；server 退出不丢失定义或结果。实施必须证明多进程总工作量、无事退出、精确接管、Catalog 作用域隔离和混合版本隔离，并删除被替代的前台管理循环；仅添加一个 server 缓存不算完成迁移。

保留 ADR 0020 的 assignment 执行权与取消约束，以及 ADR 0022 的 assignment 进度投影语义。本决策改变管理宿主与共享读取位置，不改写这些领域规则。打包、平台身份和观察器预算仍需实施实验；实验不能满足契约时应修订本决策，不得静默恢复多份全局管理器。
