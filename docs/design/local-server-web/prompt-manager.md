# Pi Better Harness · Prompt Manager 页面设计

从控制台的 **Prompts** 或 `pi-better-harness instructions web` 打开同一工作区。Prompts 只有 **Edit** 和 **Replay** 两个导航入口。工作流为 **Edit → Save → Replay（可选）**。用户可以离线保存后结束工作，稍后打开 Replay 选择两个固定版本比较。[设计稿 PDF](prompt-manager.pdf) · [ADR 0033](../../adr/0033-modular-prompts-and-replay.md#web-workspace-for-a-selected-revision)

## Edit · 编辑与保存

![Edit 页面，模块列表、Markdown 编辑器和完整 prompt 预览并排显示，Communication 的本地覆盖在全文中高亮](prompt-editor.webp)

左栏先按包内顺序列出 Bundled，再列出 User。同名条目显示带来源的身份。选择 Bundled 后可以直接编辑当前有效 Markdown。第一次修改即显示 **Local override**，模块保留原槽位和顺序。展开 **Package original** 可对照该版本随包发布的原文；**Reset to original** 仅移除当前模块的本地覆盖，立即恢复该草稿所用包版本的原文。启用开关独立：关闭时保留覆盖，重新打开继续使用覆盖；关闭时 Reset 也不会开启模块。包的验证记录始终指向原文。选择 User 后在大编辑区编辑 Markdown；Add module、移动和删除作用于该用户草稿。删除最后一个用户模块时仍能预览剩余组合。

编辑器保留未保存标识。**Full prompt preview** 常驻编辑页，包含所有启用的 Bundled 模块的有效正文（有覆盖取覆盖，否则取包原文，按包内顺序），接着是全部 User 正文（用户顺序）。选模块时，预览区内自动滚到并高亮该模块的实际文本范围；输入、粘贴或清空正文时即时更新全文，保留编辑器焦点与光标。高亮和来源提示不进入 prompt 内容。定位按来源和模块身份匹配，能区分同名或同文模块。关闭的 Bundled 模块只显示排除提示；重新启用后恢复原位置并高亮。草稿在切换视图、模块或连接失败时保留。离开并丢弃输入前询问。

编辑器中的 **Review changes** 可展开，按父版本显示 Bundled 开关、有效文本覆盖或 Reset、User 正文与顺序变化。包原文随时可查。用户可以直接点 **Save revision**，无需展开差异，也无需连接会话、配置模型或运行实验。

![Edit 中展开差异](prompt-review.webp)

保存成功后停留在 Edit，显示新版本号、**Untested** 和当前活动版本。**Replay saved revision** 会带入刚保存的候选。用户也可以继续编辑或结束。启用候选需要另行确认，已打开的会话在 reload 后采用新版本。发生活动基线冲突时保留候选，历史支持回滚。

![Edit 中的保存回执，显示 r19 已保存、未测试，当前活动版本仍为 r17](prompt-save.webp)

## Replay · 选择一次对比的范围

**Single response** 适合检查引发修改的那条请求；**Case suite** 适合确认修改对其他案例的影响。一次可以只选一种，也可以对同一对已保存版本分别运行两种。可从历史版本直接开始；若编辑器有未保存的修改，回放页标明这一点并保留草稿。

### Single response

![Replay 页面，共享问题在上方，两个响应在下方并排显示，评判在底部](prompt-replay.webp)

选择已保存的 baseline 和 candidate，选择持有 capture 的 Pi 会话，显式连接后通过可读描述选择请求。显示这次实际使用的两个版本、模型和样本数。**Run replay** 重建同一份输入并分别生成两份响应。原回答如可用可单独展开，明确标记为参考。实际运行时展示进度；无需复制 capture、revision 或 run ID。

结果将待评问题只展示一次，baseline 与 candidate 各有固定标签。底部展示 rubric，用户可记录偏好、持平或无法判断，并写下原因。结果详情能展开两端的 bundled 原文版本、开关、覆盖及实际生效文本摘要、按顺序的 user 版本，以及提供方与模型设置。实验在运行时冻结实际输入。调整文字、开关或覆盖之后，旧实验仍属于原来的版本对。未连接、会话关闭、capture 缺失、prompt 被 shadow、provider 不支持分别就地说明，并保留草稿和可用编辑操作。

### Case suite

![Replay 的 Case suite 模式，左侧为逐例结果，右侧选中一条退化案例并显示双方响应](prompt-evaluation.webp)

选择已审阅用例集、支持的模型和每例样本数。示例中有四例，三例可评分，分别改进、持平、退化各一例，一例不受支持。用户可先看退化或未评分的 case。选择某例后读双方响应、rubric、样本与评语。未评分项给出具体原因，不计入通过或退化。运行不改变源会话和活动版本。

**Record judgment** 将判断关联到该运行及确切输入对。**Promote evaluated revision** 放在已评估结果的发布确认中，校验候选、证据和活动基线。保存后的版本可另行确认启用。修改模块或开关后，旧结论仍可从历史查看，不能为新版本对背书。包内上游证据在 Bundled 详情中查看，和本机组合实验分别标明来源。

## 窄屏与验收

- 窄屏以模块选择器切换正文，完整预览排在编辑器下方。自动定位只滚动预览区域。比较区按 baseline、candidate 顺序堆叠，各保留版本标签；套件先列 case，再进入选中项。返回保留筛选、样本与焦点。
- 键盘可选择模块、编辑、保存、发起实验、切换结果和记录判断。On / Off、增减、退化、未评分均有文字标签；长正文只在相应编辑或对照区滚动。
- 用一个离线场景在 Edit 直接保存，核对候选版本号、未测试状态和仍在使用的活动版本；另行验证显式启用和回滚；再用同一候选分别走完一次会话 capture replay 和一次带未评分项的 suite evaluation。重新打开结果后可以找回两端版本、输入或用例、模型、样本数和判断；保存新候选后仍可打开旧结果。
