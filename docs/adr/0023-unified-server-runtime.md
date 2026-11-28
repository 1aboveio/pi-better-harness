# Pi Server 统一管理本机任务运行时

## 状态

2026-11-14 接受了将本机共享运行时并入 `pi-better-server` 的决定。本文记录架构和后续修订。迁移范围、协议和验收条件见[统一运行时设计](../plans/unified-server-runtime.md)。

## 决策

本 ADR 记录运行时架构、构建兼容与进程恢复的细节。共享 Server 的连接、任务接管、订阅恢复和通知投递遵循统一约定。[Server 与通知机制](0029-notification-delivery.md)

由每个 canonical Pi agent 目录的单个 `pi-better-server` 统一承担 Subagents 与 Background Tasks 的共享状态索引、投影、机械监督和恢复调度，并保留按需会话托管。普通本地 Pi 通过轻量客户端接入，不因此创建 HostedSession。共享 coordinator 保留领域事实；现有任务 runner、writer lease、权限和执行 token 保留各自职责。

server 内的 Catalog 管理模块统一读取、校验、解析和持久修改 Role 与 Named Agent 定义。Markdown 定义和 catalog `settings.json` 继续保存在个人或可信项目目录；内置定义随固定构建发布且只读，不把它们迁入运行状态数据库。项目、信任上下文与会话分支设置参与解析作用域，不能只按 agent ID 缓存。Pi 的 `/agents` 与 CLI 负责交互；会话临时设置仍属于原会话分支。每次 launch 冻结实际使用的 catalog snapshot 和 LaunchRecipe，定义修改不改变已执行或正在执行的 attempt，也不增加工具、sandbox 或其他权限。

选择复用 server，是因为它已有本地 socket、单实例所有权、会话与活动管理、固定构建及安全升级。另加 runtime daemon 会重复这些职责；仅扩展前台选主则仍把全局工作耦合到某个用户会话的生命周期。

server 按需启动；无客户端、托管保留或可推进后台工作时自动退出。轻量恢复守护器只负责 server 故障恢复，遵守同样的退出与重启预算，不扫描历史，不成为永久系统服务。仅有已完成历史、未读结果或证据 pin 不保活。所有恢复进程都被强杀后，等待下次显式 ensure，不承诺无进程情况下自动复活。

## 本地 Web 管理页

本地控制台的产品名为 **Pi Better Harness**。用户通过同一个 Web 入口查看 Server、托管会话、Prompts、Agent Catalog、MCP、Skills 和 Tools。Web 进程独立于所管理的 daemon，绑定到本机回环地址。建议从 `pi-better-harness web` 打开 Server 总览；ADR 0033 的 `pi-better-harness instructions web` 继续直达 Prompts。两种入口选择同一个 Pi agent 目录。页面及原型见[本地控制台设计](../design/local-server-web/README.md)。

- **读取。** Web 后端通过现有本地 socket 客户端，在握手后读取构建、协议、会话和升级状态。打开页面、刷新或查看详情均为被动观测。浏览器保留上次观测时间；超时和身份不明显示“状态未知”，握手不兼容显示具体原因。单独一次连接失败不足以判定 daemon 已停止。
- **启动。** 只有本机启动逻辑能确认该目录的 daemon 已停止时，页面才提供启动操作。用户显式点击后，Web 后端调用已有的 managed `ensure`，显示等待结果，并重新握手确认目标实例。并发点击或执行中断遵循既有单实例所有权与恢复约定。普通浏览及空闲标签页遵循 daemon 原有退出策略。
- **会话和升级。** Server 给出托管会话、活动、待答问题及升级记录。首版可查看问题，不领取 controller lease。升级延期直接呈现返回的原因；仅在服务端给出可关联身份时才指向具体阻塞会话。浏览器操作限定于约定的管理动作，写操作由已授权的本机页面发起。
- **会话 TUI。** 从总览或 Sessions 点击会话后，直接打开该 session ID 的独立详情页并订阅只读终端画面。TUI 占主区域，工作目录、分支及待答问题在侧栏。生产验收要求新输出、光标移动及行重绘在浏览器中可见。连接中、断线或缺少终端能力时显示对应状态。观察路径只接受屏幕输出，离开仅释放观察资源。现有 `pi-remote attach` 的 companion 启动会取得 controller lease；浏览器需要按会话授权的观察能力。对无现成终端的托管会话，该能力应能基于该会话建立只读 TUI 投影。接管输入、回答问题和发送命令属于后续独立授权的操作。
- **Agent Catalog。** 网页复用现有 Server 目录服务及宿主验证过的作用域，只读查看 Role、Named Agent、继承关系、有效模型和 effort、Skills、指令与来源。项目和分支数据随对应宿主授权的撤销而失效。打开详情不启动 Agent。[目录操作约定](../../packages/pi-better-subagents/docs/agent-catalog-operations.md)
- **MCP、Skills、Tools。** 各有独立的只读清单和详情。MCP 展示提供方报告的配置和连接状态；Skills 展示当前作用域可发现的技能及来源；Tools 展示注册工具和选中会话的 active 集合。由相应宿主适配器提供可用字段。没有此能力、未获授权或观测失败时显示不可用，成功读取的空清单才显示零项。只展示已授权的元数据，不传递凭据或环境变量值。浏览这些页面不会连接 MCP、读取技能以改变模型上下文、切换工具或调用工具。
- **Prompt Manager。** 本地 prompt 目录和版本继续由 ADR 0033 的管理路径读写，daemon 停止时仍可使用。回放按原约定显式连接持有 capture 的 Pi 会话。出现在托管会话列表中并不授予访问 capture 的权限。[Prompt 管理与回放](0033-modular-prompts-and-replay.md)

验收分别覆盖确认已停止后的显式启动、观测超时后的重试、会话 TUI 的只读直达与重连、目录作用域隔离、三个能力清单的只读查询，以及 daemon 离线时进入 Prompts。控制台页面和 Prompt Manager 各自验收；汇合点是共同导航与 agent 目录选择。真实运行时验收使用临时 agent 目录和本机 daemon；设计原型使用示例数据。

## 系统唤醒后的读取线程监测

系统睡眠会同时暂停 server 主线程上的 watchdog 和读取线程（read worker）。2026-11-20 的一次合盖睡眠持续了 218 秒，watchdog 在唤醒后记录到约 216 秒的心跳空档。当时没有正在执行或排队的读取请求。仅凭睡眠前的心跳时间，无法判断读取线程在唤醒后能否响应。

如果相邻两次 watchdog 检查的间隔超过配置的超时时间，server 从恢复检查时重新计时，给读取线程一个完整的超时窗口。收到线程响应或观察到新鲜的共享心跳，都能证明线程仍在运行。只有在 watchdog 持续检查满一个窗口、期间始终收不到响应且心跳也已过期或缺失时，server 才报告读取线程无响应，并按既有重启预算恢复读取服务。单个读取请求仍按自己的截止时间返回。

回归测试覆盖三种时序：主线程和读取线程同时暂停后由主线程先恢复、主线程延迟处理消息但读取线程仍更新心跳，以及主线程正常运行而读取线程持续卡死。前两种应保留原读取线程并成功返回快照，第三种应触发线程恢复。[读取线程回归测试](../../packages/pi-better-server/test/query-executor.test.ts)

## 影响

统一管理是运行位置的变化，不转移 assignment 的判断权或扩大权限。现有托管会话断开后的保留语义继续成立。配置文件、执行时冻结配方、运行状态和可重建索引分别保留自己的事实来源；server 退出不丢失定义或结果。实施必须证明多进程总工作量、无事退出、精确接管、Catalog 作用域隔离和混合版本隔离，并删除被替代的前台管理循环；仅添加一个 server 缓存不算完成迁移。

保留 ADR 0020 的 assignment 执行权与取消约束，以及 ADR 0022 的 assignment 进度投影语义。本决策改变管理宿主与共享读取位置，不改写这些领域规则。打包、平台身份和观察器预算仍需实施实验；实验不能满足契约时应修订本决策，不得静默恢复多份全局管理器。

## 子会话跨构建恢复

LaunchRecipe 保存子会话使用的 managed release 路径。server 更新后，恢复仍使用该 release 的 Node、SDK、worker、扩展和依赖声明；当前 server 重新生成权限策略，并继续持有 admission、writer lease 和结果投递职责。旧记录从必选的 `child-steer.ts` 路径恢复 release 引用，不从自定义扩展猜测版本。新任务使用当前 release。

恢复只接受同一安装目录下的已发布 release，并要求双方使用 v1 协议且 Node、SDK、平台一致。worker admission、policy 或 bridge 的不兼容变更必须提升协议版本。版本缺失、路径重定向或不兼容时，在启动前报告恢复受阻；不自动切换实现，也不自动创建替代会话。自定义扩展变更仍受原有一致性检查约束。

现有安装器保留已发布 release，只删除本次安装的 staging。将来增加 release 清理时，必须把运行中、等待中及仍可恢复的 LaunchRecipe 引用纳入回收条件。保留版本文件不创建进程，也不阻止 server 空闲退出。
