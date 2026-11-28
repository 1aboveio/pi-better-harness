# Pi Better Harness 本地控制台

用户从总览确认当前 agent 目录运行的 build、哪几个托管会话正在工作、升级为何尚未生效。三项信息来自同一目录下的 Server。界面沿用现有英文产品术语，以及 Pi Better Harness 的标志、薄荷绿和炭色。对应决策见 [ADR 0023](../../adr/0023-unified-server-runtime.md#本地-web-管理页)。

![Server 总览示意；示例数据](overview.png)

[交互原型](index.html) 使用示例数据。在本地浏览器打开 HTML 即可体验；右上角 **Prototype state** 用于切换设计场景。原型中的启动、刷新和时间戳仅用于演示。

## 页面与操作

| 入口 | 用户先看到什么 | 用户下一步能做什么 |
| --- | --- | --- |
| Server 总览 | 当前目录、daemon 状态及运行中的 build、Pi SDK 和协议；升级卡显示观测到的延期原因 | 刷新观测，查看会话，展开连接详情；确认已停止时可显式启动 |
| Sessions | 按完整工作目录分组的托管会话，显示名字、活动状态和更新时间 | 用 Needs input 筛选，打开具体会话，阅读当前问题及选项。Escape 返回原来的会话行。首版保留只读交互 |
| Prompts | 同一 agent 目录的 Bundled 与 User 模块 | 正式产品进入 ADR 0033 管理器，可离线编辑。原型用本地目录示例展示这个交接点 |
| 会话详情 | 名称、工作目录、分支、session ID、更新时间和待答问题 | 关闭后保留筛选及焦点；浏览详情不取得控制权 |

总览的首屏保留状态卡和会话列表。列表优先展示待答、运行和空闲的会话；同组按最近活动排序。Sessions 使用完整目录分组，以便区分同名项目。较窄的窗口将导航移至顶部、状态卡纵向排列，保留名称和状态，路径与时间可在详情中查看。所有状态都有文字，键盘可以操作导航、筛选、启动及详情。

## 连接与升级的显示规则

| 观测结果 | 显示 | 页面操作 |
| --- | --- | --- |
| 新鲜且兼容的握手 | Connected，显示实际 build、SDK、协议和 daemon 实例 | Refresh、会话与升级详情 |
| 启动层确认无活动所有者且已停止 | Stopped，会话与升级状态暂不可用 | Start server 调用同一 managed ensure。等待期间显示 Starting，再次握手后才显示 Connected |
| 超时、socket 暂不可达或所有者身份不明 | Unknown，显示最近观测时间和具体原因；不把不可观测的列表算成零个会话 | Retry observation。重新连接成功前不提供启动操作 |
| 协议不兼容 | Incompatible，显示握手差异；需要时标明旧数据的时间 | Retry observation；本地 Prompts 仍可使用 |
| 已连接但升级等待中 | 在 Runtime upgrade 区域显示 activation journal 的阶段和 blocker。示意图采用 “Waiting for idle” | 只有 blocker 与具体会话身份匹配才直达该会话，否则进入会话列表 |
| 已连接且没有升级记录、能力不可用或读取失败 | 分别显示 “No upgrade recorded”、“Unavailable” 或错误原因 | 保持已取得的连接状态和会话信息 |

## 数据归属

- `hello` 提供当前进程的身份、协议、构建与 SDK 信息。页面只显示可用字段。启动探测与显式 `ensure` 复用管理启动路径。[握手和协议](../../../packages/pi-better-server/src/protocol.ts) · [启动入口](../../../packages/pi-better-server/src/cli.ts)
- `list_sessions` 提供托管会话的 ID、cwd、活动、待答问题及更新时间。Needs input、Running、Idle 为展示标签，优先识别待答对话。未托管的轻量客户端不在这份会话清单里。[会话语义](../../../packages/pi-better-server/README.md#protocol)
- `runtime_upgrade_status` 返回升级日志与 blockers。页面不根据会话列表推测升级原因。[状态读取](../../../packages/pi-better-server/src/server.ts)
- Prompts 复用已选 agent 目录、现有模块权限和显式 capture 连接。总览页不触发回放、模型请求或 prompt 更改。[ADR 0033](../../adr/0033-modular-prompts-and-replay.md)

## 评审走查

1. 在 Connected 场景核对 build 和升级原因，筛选 Needs input，打开 “Review prompt changes”，阅读具体问题，用 Escape 返回。
2. 切到 Stopped，先刷新再进入 Prompts。回到 Server，仍应是 Stopped。点击 Start server 后经过 Starting 到 Connected。
3. 切到 Unknown，点击 Retry observation；确认页面没有启动动作。切到 Incompatible 验证协议差异与本地 Prompts 的可用性。
4. 在窄屏及仅用键盘重复上述导航。正式实现另用真实 daemon 验证被动观测不启动服务、不创建会话、不延长空闲生命周期。
