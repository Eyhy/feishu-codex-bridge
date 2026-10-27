# 模型切换测试与验收清单

- 来源：[#8 模型切换的测试与验收清单](https://github.com/Eyhy/feishu-codex-bridge/issues/8)
- 适用范围：#2–#9 已确认的产品行为；本文只定测试与验收，不写实现代码。
- 状态：实现前基线；Q1–Q8 复核修订已并入（2026-10-27）。实现票和 PR 以本文为验收依据；产品行为有变化时先改对应决策票，再改本文。

## 1. 验收门槛

### 自动门槛

合并前必须全绿：

~~~bash
pnpm check   # pnpm typecheck && pnpm test && pnpm build
~~~

开始实现前先记录一次基线。工作区若有与本需求无关的既有改动导致失败，必须在验收记录里单独列出，不能把既有失败算进本次验收。

### 人工门槛

CI 不跑真实 `codex app-server`。以下跨进程行为只做桌面端人工验收，结果附在 #8：

- S1：桌面未持锁时，飞书切换后桌面下一轮用新模型。
- 桌面持锁时，飞书 `/model` 与普通消息都明确报占用，不 fork、不新建线程。
- Bridge 用完释放 writer 后，桌面端可以接管同一线程。
- 桌面持锁时，飞书 `/status` 仍能通过 `thread/read` 读到线程模型。
- OMP 话题的 `/model` 与 `/model default` 提示。

### 不验收

- 桌面端模型选择器实时刷新（S2 不做）。
- 共享 daemon / `codex app-server proxy` 路线。
- service tier、provider、OMP 模型切换。

## 2. 测试分层与文件

| 层 | 文件 | 职责 |
| --- | --- | --- |
| adapter / 假 app-server | `src/agent/codex/adapter.test.ts`（扩展） | 协议请求参数、模型不注入、preflight、settings/update + 回读、pending 应用、active writer、兼容失败、fork 复制、通知、释放 writer |
| SessionStore | `src/session/store.test.ts`（新增） | pendingModel / pendingEffort 的持久化、保留、清除、旧条目兼容 |
| commands / 卡片回调 | `src/commands/model.test.ts`（新增） | `/model` 管理员校验、两步卡片、无会话/OMP/运行中、就地替换、错误文案、`/model default` |
| 卡片结构 | `src/card/model-card.test.ts`（新增） | 模型卡/强度卡/结果卡的 CardKit 2.0 结构、按钮 payload、当前项标记 |
| 卡片文案 | `src/card/templates.test.ts`（扩展） | 状态卡、帮助卡、欢迎卡不显示模型；用户可见禁用词 |
| channel | `src/bot/channel.model.test.ts`（新增） | 只有 OMP 传 model；pending 在下一轮应用；active writer 普通消息不 fork；状态卡轻量读 |

`src/commands/project-workflow.test.ts` 只作为 `CommandContext` 的搭建模板，不把模型用例塞进这个文件。

## 3. 假 app-server 夹具

### 3.1 形态

扩展现有 `fakeCodex(options)`，不引入生产代码的 client 注入缝。测试通过临时可执行 `codex-fake.mjs` 启动，保持真实 JSON-RPC 线格式。

新增场景参数：

- `models`：`model/list` 返回的模型数组，可按 `includeHidden` 过滤。
- `threads`：线程初始状态，至少包含 `model`、`reasoningEffort`、`loaded`、`canAcceptDirectInput`、`missingRollout`、`activeWriter`。
- `errors`：按方法覆写错误，例如 `thread/resume` 的 active writer、`thread/settings/update` 的失败、`turn/start` 的兼容失败。
- `requests`：请求日志 JSONL 路径；每个请求写一行 `{ method, params, id }`。
- `notifications`：在指定请求后发通知，至少覆盖 `thread/settings/updated` 和 `model/rerouted`。
- `closedMarker`：进程退出/关闭时写一个标记，供“释放 writer”用例等待。

请求日志是断言请求参数的主要依据；不要通过改生产代码暴露内部状态来测这些行为。

### 3.2 必须覆盖的请求

- `initialize`
- `model/list`（`includeHidden` 真/假、错误、空列表、分页）
- `thread/start`（带 cwd、兼容失败退化）
- `thread/resume`（成功、active writer、missing rollout、历史兼容失败）
- `thread/read`（loaded/unloaded、`canAcceptDirectInput`、includeTurns、读失败）
- `thread/settings/update`（成功返回 `{}`、model+effort 同时传、失败）
- `turn/start`（记录完整 params；成功、错误、不回 model）
- `thread/fork`（不传 model、复制后 settings/update）
- `thread/loaded/list`、`thread/unsubscribe`（仅验证不会释放 writer，不作为释放手段）
- 通知：`thread/settings/updated`、`model/rerouted`、`turn/started`、`turn/completed`、`item/agentMessage/delta`

### 3.3 固定模型夹具

至少两个模型，覆盖“支持当前强度”“不支持当前强度”“隐藏模型”：

~~~ts
const models = [
  {
    id: 'gpt-6-astra',
    model: 'gpt-6-astra',
    displayName: 'Astra',
    description: '测试模型 A',
    isDefault: true,
    hidden: false,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'ultra'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
  },
  {
    id: 'gpt-6-sol',
    model: 'gpt-6-sol',
    displayName: 'Sol',
    description: '测试模型 B',
    isDefault: false,
    hidden: false,
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
    serviceTiers: [],
  },
];
~~~

### 3.4 日志断言

- 断言 `turn/start.params` 没有 `model` 字段（#6）。
- 断言 `thread/settings/update.params` 同时有 `model` 与 `effort`（#5）。
- 断言顺序：
  - 已有线程 + pending：`thread/resume` → `model/list`（校验 pending）→ `thread/settings/update` → `thread/read` → `turn/start`。
  - 新线程 + pending：`model/list`（校验 pending）→ `thread/start` → `thread/settings/update` → `thread/read` → `turn/start`。
  - 无 pending：`thread/resume` → `model/list`（校验线程设置）→ `turn/start`；新线程不预检。
- 断言 preflight 失败时没有 `turn/start`、没有 `thread/start`、没有 `thread/fork`。
- 断言 active writer 时没有 `thread/start`、没有 `thread/fork`、没有 `thread/settings/update`。
- 断言 `/model default` 没有 `thread/resume`、没有 `thread/settings/update`。
- 断言 `/session fork` 只出现一次 `thread/fork`；复制阶段只有源 `thread/read`、target `settings/update`、target `thread/read`。

## 4. adapter / run 用例

> 预检对象：无 pending 时用 resume 返回的线程 model/effort；有 pending 时先校验准备写入的 pending model/effort，通过才写。

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| A1 | 新线程 | `thread/start` 与 `turn/start` 都不带 model；system 事件的 model 为 undefined；不调用 `resolveDefaultModel` |
| A2 | 恢复已有线程 | `thread/resume` 不带 model；`turn/start` 不带 model；system 事件不带模型；线程自己的 model/effort 不被覆盖 |
| A3 | preflight 通过（无 pending） | resume 返回的 model/effort 在 `model/list(includeHidden:true)` 中且强度受支持；正常 `turn/start` |
| A4 | 无 pending，模型不在列表 | 发 error（不是 warning）；错误文案见 8.1；没有 `turn/start`、没有 `thread/start`、没有 `thread/fork`、没有 settings/update |
| A5 | 无 pending，强度不支持 | 同 A4，文案见 8.1 |
| A6 | `model/list` 失败 | 跳过 preflight，仍用线程当前模型跑完本轮；不发模型不可用错误 |
| A7 | 缓存判定失败后强制刷新 | 先返回过期列表（缺模型），再返回包含模型的列表；断言 `model/list` 调用两次后放行；若刷新也失败则跳过 preflight |
| A8 | 已有线程 + pending 写入成功 + 回读一致 | 顺序为 resume → model/list（校验 pending）→ settings/update（model+effort）→ thread/read → turn/start；回读一致后清 pending；turn/start 不带 model |
| A9 | 写入后回读不一致 | 命令立即写路径：结果卡报错，不跑 turn；下一轮 pending 应用路径：用线程当前模型跑完本轮并提示；pending 清除；不静默重试 |
| A19 | settings/update 成功但 thread/read 报错 | 先重试一次 `thread/read`；仍失败发 `model_switch unconfirmed` + ui_notice「模型设置已提交但未能确认，本轮先用会话当前设置执行；稍后重试。」；保留 pending；按会话当前设置跑完本轮；不静默重试 |
| A10 | active writer | resume 报 `thread <id> already has an active writer`；发 #7 的统一占用错误；不 fork、不新建、不清 pending、不写 settings |
| A11 | 历史兼容失败 | 命中 #6 正则时自动新建线程并提示；新线程不带 model；不命中时直接报错，不新建 |
| A12 | missing rollout | 自动新建线程并提示；新线程不带 model |
| A13 | fork 复制 | 只调用一次 `forkSession`（一次 `thread/fork`，不带 model）；复制逻辑只读源 `thread/read`，再对 target `thread/settings/update` 写 model+effort，回读 target；pending 不跨 scope；复制失败保留 fork 并提示“模型未继承，可在新话题用 /model 重选” |
| A14 | 通知 | `model/rerouted` 只产生 ui_notice（提示本轮被服务端改模型），不写 pending、不改线程；`thread/settings/updated` 不污染队列、不改 Bridge 自己维护的 pending |
| A15 | 释放 writer | run 成功、报错、停止、`/session fork` 复制完成四条路径都在 finally 后关闭 app-server；等待 1–2 秒后 fake 进程退出；没有后续请求 |
| A16 | 运行中 | 有活动 turn/审批/输入时 `/model` 不写线程，提示“任务执行中，结束后再切换” |
| A17 | pending 的 preflight（已有线程） | resume 后对 pending 的 model/effort 调 `model/list(includeHidden:true)`；通过才 settings/update → read → turn/start；不通过发 pending 专用 error、清 pending、不写 settings、不跑 turn |
| A18 | 新线程 + pending 的顺序 | `model/list`（校验 pending）在 `thread/start` 之前；通过才建线程、写 settings、回读、turn/start；不通过不建线程、不写、不跑 |
| A20 | pending 的 model/list 调用失败或为空 | 抛错/超时：跳过预检继续 settings/update，不因列表失败直接清 pending；成功但为空：`validation_failed`，保留 pending，不写 settings、不跑 turn、不新建、不 fork；已有线程与新线程都这样处理 |

## 5. SessionStore 用例

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| S1 | 默认条目 | 没有 pendingModel/pendingEffort 时 load 后仍为 undefined |
| S2 | 写 pending 保留会话 | set 写 pending 时保留现有 sessionId、cwd、idleTimeoutMinutes |
| S3 | 无线程 pending | 允许只有 pendingModel/pendingEffort 的 scope 条目；load 不丢弃 |
| S4 | 清除 pending | 只清 pending，保留 sessionId/cwd/idleTimeoutMinutes |
| S5 | 清除整条 | clear 删除整条，包括 pending |
| S6 | 旧条目兼容 | 没有 pending 字段的旧 JSON 可正常 load；没有 sessionId/cwd 但有 idleTimeout 的旧条目仍按现有规则处理 |
| S7 | 持久化 | 重新创建 SessionStore 后 pending 仍在；model/effort 只存 id + effort，不存 displayName |
| S8 | clearSession 保留 pending | `clearSession` 清 sessionId/cwd/idleTimeoutMinutes，但保留 pendingModel/pendingEffort；`/new` 走 `clearSession`，回复带「模型选择保留：B（待生效）」；`clear` 仍删除整条 |

## 6. commands / 卡片用例

使用 `src/commands/project-workflow.test.ts` 的 `CommandContext` 搭法；卡片回调通过 `fromCardAction` 路径进入同一个 handler。

### 6.1 权限与入口

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| C1 | 非管理员发 `/model` | 回复“❌ 此命令仅管理员可用。”；不打开卡片、不写线程 |
| C2 | 非管理员点卡片按钮 | 服务端重新查 `isAdmin` 后回复“仅管理员可切换模型”；不 update 卡片、不写线程 |
| C3 | 管理员 `/model` | 打开第一步模型卡；当前模型标记；不带参数不直接写线程 |
| C4 | `/model <arg>` | 不得直接绕过列表写线程；具体提示按 #4 Q9 实现，只锁定“不写线程、不绕过校验” |
| C5 | admins 为空 | 所有 allowed 用户按管理员处理；配置 admins 后只放行名单 |

### 6.2 两步选择

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| C6 | 只换模型、强度不变 | 选新模型且当前强度受支持时，提交的 settings/update 保留原 effort |
| C7 | 新模型不支持当前强度 | 自动落到新模型默认强度；结果卡明确“新模型不支持 X，已改为 Y”；不拒绝整次切换 |
| C8 | 跟随模型默认 | 选择“跟随模型默认”时提交该模型的 defaultReasoningEffort |
| C9 | 当前项标记 | 模型卡标记当前模型；强度卡标记当前强度（支持时） |
| C10 | 提交时重取列表 | 提交时重新拉 `model/list`；模型已消失或强度不再受支持时提示“模型列表已更新，请重新选择”并回到第一步；不写线程 |
| C11 | 列表失败 | 错误卡 + 重试；保留当前模型行；不写线程 |
| C12 | 空列表 | 提示 + 重试；不写线程 |

### 6.3 边界

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| C13 | 无会话 | 允许预选；卡片提示“尚未开始（发送第一条消息后才有会话模型）”；选择后存 pending，文案“已选择 B；会话创建后生效”；之后 `/new` 不改 pending |
| C14 | OMP 话题 | 提示“当前是 OMP 会话，模型切换仅支持 Codex”；不展示模型列表；不写线程；不读/清 Codex pending |
| C15 | 运行中 | 提示“任务执行中，结束后再切换”；不写线程 |
| C16 | 就地替换 | 从状态卡按钮进入时 update 原消息卡，不另发新消息；成功后结果卡带“查看状态”；取消可退回，下次 `/status` 重新生成 |
| C17 | 成功结果 | 服务端以提交时线程设置为旧值；卡片显示操作者、时间、旧模型 → 新模型、强度；不要求二次确认 |
| C18 | `/model default` | 只清 pending；不 resume、不写 settings；有线程允许一次轻量 `thread/read` 仅为文案取 X；无线程文案“已清除待生效选择，新会话跟随设备默认”，有线程文案“飞书不再设置模型，当前会话保留 X（要换请重新选择）” |
| C22 | `/new` 保留 pending | 已有 pending B 时执行 `/new`：清会话绑定、cwd、超时设置，保留 pending；回复含「模型选择保留：B（待生效）」；下一条消息建新线程仍应用 B |
| C23 | OMP 路由层拒绝两条命令 | `/model` 与 `/model default` 在打开卡片/清 pending 之前判后端；OMP 直接回复“当前是 OMP 会话，模型切换仅支持 Codex”；不调用 `model/list`、不读/清 Codex pending |
| C19 | 状态卡 | 每次用轻量 `thread/read`（不 includeTurns、不 fallback resume）现读；有线程显示模型 + 强度；无会话 + pending 显示“模型：B（待生效）”；未加载且有 pending 显示“模型：A（待生效：B）”；读失败显示“模型：未知（点刷新重试）” |
| C20 | 欢迎卡 | 不出现模型/强度行；不提供模型按钮 |
| C21 | 帮助卡 | 列出 `/model`，文案“切换本话题的模型与推理强度” |

### 6.4 用户可见文案

实现完成后，卡片与命令回复中不得出现：

- `话题独立 session`
- `当前 session`
- `session 覆盖`
- `范围：<scope>`
- 用户界面里的“线程”“覆盖”“Session”

状态卡的正常分支使用 `本话题：独立会话`；隐藏 ID 分支仍只显示标题/尚未绑定。

## 7. channel 用例

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| H1 | Codex 普通消息 | `agent.run` 不传 `model`；OMP 才传 `getOmpModel(cfg)` |
| H2 | pending 应用 | 已有线程：resume → model/list（校验 pending）→ settings/update → read → turn/start；新线程：model/list（校验 pending）→ thread/start → settings/update → read → turn/start；成功后清 pending；成功后发 ui_notice |
| H3 | pending 应用失败 | 保留 pending 的情况是 active writer、validation_failed、unconfirmed；其他失败按 #5 清 pending 并提示；不每轮静默重试 |
| H4 | active writer 普通消息 | 回复“桌面端正在使用这个会话，请在桌面端关闭该会话后重试”；不 fork、不新建、不改绑定 |
| H5 | 状态卡读模型 | 用轻量 `thread/read`（不 includeTurns、不 fallback resume）；桌面持锁时也能读到 |
| H6 | OMP | 不进入 Codex 模型卡/设置路径；不调用 `model/list`；`/model` 与 `/model default` 都不读/清 Codex pending |

## 8. 固定文案

### 8.1 错误与提示

以下字符串是验收字符串；实现不得随意改写，要改先改对应决策票。

| 场景 | 固定文案 |
| --- | --- |
| 模型不可用 | `当前会话的模型 X 在这台设备上不可用。请用 /model 重新选择模型，或 /new 新建会话。` |
| 强度不支持 | `模型 X 不支持强度 Y。请用 /model 重新选择，或 /new 新建会话。` |
| 桌面端持锁 | `桌面端正在使用这个会话，请在桌面端关闭该会话后重试` |
| 运行中切换 | `任务执行中，结束后再切换` |
| OMP 话题 | `当前是 OMP 会话，模型切换仅支持 Codex` |
| 无会话 | `尚未开始（发送第一条消息后才有会话模型）` |
| 状态卡读取失败 | `模型：未知（点刷新重试）` |
| 提交时列表变化 | `模型列表已更新，请重新选择` |
| `/model default`（无线程） | `已清除待生效选择，新会话跟随设备默认` |
| `/model default`（有线程） | `飞书不再设置模型，当前会话保留 X（要换请重新选择）` |
| 立即切换成功 | `模型已切换：A → B（强度 Y）` |
| 已选择（无线程） | `已选择 B；会话创建后生效` |
| pending 模型不可用 | `待生效的模型 X 在这台设备上不可用。请重新选择模型。` |
| pending 强度不支持 | `待生效的模型 X 不支持强度 Y。请重新选择。` |
| pending 预检列表为空 | `模型列表暂时为空，无法应用待生效模型，请稍后重试。` |
| 回读未确认 | `模型设置已提交但未能确认，本轮先用会话当前设置执行；稍后重试。` |
| `/new` 保留待生效 | `已开始新会话；模型选择保留：B（待生效）。` |
| fork 复制失败 | `模型未继承，可在新话题用 /model 重选` |
| 历史配置不兼容 | `原 Codex 会话使用了当前设备不兼容的配置，已自动新建会话并重试。` |
| 非管理员文本命令 | `❌ 此命令仅管理员可用。` |
| 非管理员卡片回调 | `仅管理员可切换模型` |

## 9. 失败路径验收矩阵

| 场景 | 触发 | 预期 | 副作用 | 覆盖层 |
| --- | --- | --- | --- | --- |
| 模型不可用（无 pending） | preflight 找不到 model | error + #6 文案 | 无 turn/start、无新建、无 fork、无 settings/update；绑定保留 | adapter A4 |
| 模型不可用（有 pending） | pending model 不在列表 | error + pending 模型不可用文案 | 清 pending；不写 settings、不跑 turn、不新建、不 fork | adapter A17/A18 |
| 强度不支持 | model 在列表但 effort 不在 supported | error + #6 或 pending 强度不支持文案 | 同上 | adapter A5/A17 |
| pending 列表为空 | model/list 成功但为空 | validation_failed + 列表为空文案 | 保留 pending；不写 settings、不跑 turn、不新建、不 fork | adapter A20 |
| pending 列表调用失败 | model/list 抛错 | 跳过预检继续写 | 仍按写入结果处理；不因列表失败清 pending | adapter A20 |
| 列表读取失败 | model/list 抛错 | 跳过 preflight，本轮继续 | 用线程当前模型；不误报 | adapter A6 |
| 缓存过期 | 缓存判定失败 | 强制刷新一次 | 刷新成功放行；刷新失败跳过 | adapter A7 |
| 回读不一致 | settings/update 返回 {} 但 thread/read 不同 | 按 #5 失败处理 | pending 清除；命令路径不跑 turn；下一轮路径用当前模型跑完并提示 | adapter A9 + C10 |
| 回读报错 | settings/update 成功但 thread/read 抛错 | unconfirmed + 未确认文案 | 保留 pending；按会话当前设置跑完本轮；不静默重试 | adapter A19 |
| 桌面持锁 | resume 报 active writer | #7 统一占用提示 | 不清 pending、不 fork、不新建、不写 settings | adapter A10 + H4 |
| 历史配置不兼容 | 命中 #6 正则 | 自动新建 + 提示 | 新线程不带 model | adapter A11 |
| missing rollout | 恢复报 no rollout | 自动新建 + 提示 | 新线程不带 model | adapter A12 |
| fork 复制失败 | 读源/写 target/回读失败 | 保留 fork + 提示重选 | 只 fork 一次；不 thread/delete 回滚；finally 释放 | adapter A13/A15 |
| 运行中切换 | 有活动 turn | “任务执行中，结束后再切换” | 不写线程 | C15/A16 |
| OMP 话题 | OMP 后端 | “仅支持 Codex” | 不展示列表；`/model` 与 `/model default` 都不读/清 Codex pending | C14/C23/H6 |

## 10. 桌面端人工验收

### M1 S1：同一线程下一轮生效

1. 桌面端新建或打开线程 T，设为模型 A、强度 Ea；退出桌面端 Codex 进程（只关窗口不算，若飞书仍报占用就退出进程重试）。
2. 在已绑定 T 的飞书话题执行 `/model`，选 B、强度 Eb；看到成功卡，并确认 Bridge 已释放 writer。
3. 重新打开桌面端，打开 T；选择器应显示 B/Eb；发一条消息，实际使用 B。
4. 飞书再发一条消息；`/status` 显示 B/Eb；`thread/read` 返回 model=B、effort=Eb。

通过标准：第 3、4 步同时满足。桌面选择器需要重新打开才刷新不算失败（S2 不验收）；桌面下一轮仍用 A 判失败。

### M2 桌面持锁：明确报错、不悄悄分叉

1. 桌面端打开线程 T 并保持加载；从飞书话题发 `/model`。
2. 期望统一占用提示“桌面端正在使用这个会话，请在桌面端关闭该会话后重试”；不打开模型卡、不暂存。
3. 从飞书发普通消息；期望同一提示，不 fork、不新建线程。
4. 对比 `/status` 的会话 id 与 `/sessions` 数量，确认没有新增/替换。
5. 状态卡仍显示 `thread/read` 读到的旧模型。

### M3 Bridge 释放后桌面接管

前置：没有其他话题在运行（Bridge 只在全部 scope 空闲时释放 writer）。

1. 飞书正常跑完一轮（或完成一次 `/model`）。
2. 等待约 1–2 秒。
3. 桌面端打开同一线程并发消息；不应出现 active writer；应能正常续聊。

### M4 OMP 提示

在 OMP 项目话题分别执行 `/model` 与 `/model default`：都应提示“当前是 OMP 会话，模型切换仅支持 Codex”，不展示模型列表，不清 Codex pending。

### M5 桌面持锁时状态卡

桌面端持有线程时，在飞书执行 `/status`：应显示线程当前模型/强度，不因写锁失败；读不到时显示“模型：未知（点刷新重试）”。

### M6 无线程 pending 与新线程

1. 在一个尚未建立会话的话题执行 `/model`，选 B、强度 Eb；应显示“已选择 B；会话创建后生效”。
2. 再执行 `/new`；回复应带“模型选择保留：B（待生效）”。
3. 发送第一条消息；状态卡应显示 B/Eb；`thread/read` 返回新线程 model=B、effort=Eb。
4. 桌面端打开这个新线程；选择器应显示 B/Eb。

### 人工记录格式

每条记录写：日期、桌面端版本、Codex 版本、线程 id、操作步骤、期望/实际、截图或 `thread/read` 关键字段、结论。附在 #8 评论里。

## 11. 现有测试改写清单

`src/agent/codex/adapter.test.ts`：

- :197 “starts a thread…”：保留 system.model 为 undefined 的期望。
- :279 “starts a replacement thread…”：把 system.model 的 `gpt-5.6-sol` 期望改为 undefined。
- :291 “resumes historical threads with the current app-server default model”：改写为“恢复历史线程不下发/不显示默认模型”；断言 `thread/resume` 与 `turn/start` 不带 model。
- :302 “replaces a historical thread when its model cannot compact”：移除第一段 system.model 期望；保留自动新建行为；断言新线程 turn/start 不带 model。
- fake 的 `model/list` 从固定 `[{ model: 'gpt-5.6-sol', isDefault: true }]` 改为可配置夹具；新增请求日志与通知场景。
- 新增 A1–A20 用例；测试名用英文，断言失败时能看出是“没有下发模型”还是“没有写设置”。

不要保留任何“Bridge 会下发设备默认模型”的旧断言；它和 #6 冲突，保留会让实现无法通过。

## 12. 验收清单

- [x] 基线 `pnpm check` 通过；既有无关失败已单独记录。
- [x] adapter A1–A20 全绿。
- [x] store S1–S8 全绿。
- [x] commands/卡片 C1–C23 全绿。
- [x] channel H1–H6 全绿。
- [x] 用户可见禁用词检查通过。
- [ ] 桌面 M1–M6 完成并附证据。
- [x] README:182、README:373-375、README:384、helpCard、docs/index.html 的文案同步（#6/#9）。
- [x] 没有为测试改动生产接口；假 app-server 仍是唯一 CI 协议替身。

## 13. 已知限制

- 桌面端选择器实时刷新（S2）不验收。
- 真实桌面与 Bridge 的写锁行为只做人工验收；CI 的 active writer 由 fake 模拟。
- 共享 daemon / proxy 不做。
- 模型列表依赖设备 `model/list`；设备默认损坏时 Bridge 不代挑（#6）。
- 同一时刻只允许一个 writer；桌面持锁时飞书只能读，不能切（#7）。
- 其他话题仍有活动 run 时 Bridge 不释放 writer，桌面端要等它们全部结束才能接管；M3 以没有其他活动 run 为前提。

## 14. 自动化验收记录

日期：2026-10-27（Asia/Shanghai）。代码基线：`0fad4c2` + #17 文案改动。

```bash
HOME=/tmp/dsh-test-home PNPM_HOME=/tmp/dsh-pnpm-home XDG_DATA_HOME=/tmp/dsh-xdg \
  npm_config_manage_package_manager_versions=false pnpm check
```

结果：typecheck 通过；38 个测试文件 / 215 个测试通过；tsup build 成功。

用户可见文案扫描：`src/card/*.ts`、`src/commands/index.ts`、README、`docs/index.html` 中不再出现 `话题独立 session`、`当前 session`、`session 覆盖`、`范围：<scope>`；卡片与命令回复中不再出现“线程”“覆盖”“Session”。README 仅保留 JSON 字段 `ompSessionDir`，docs/index.html 无用户可见 `Session`。

未完成：M1–M6 需要真实桌面端与真机写锁环境，当前会话无法代替人工操作桌面 UI；完成前 #17 不关闭。
