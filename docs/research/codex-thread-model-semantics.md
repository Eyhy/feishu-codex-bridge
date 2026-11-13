# Codex thread 的模型状态语义（桌面端 ↔ Bridge）

> 研究问题来源：GitHub issue [#2 桌面端与 Bridge 对同一 Codex thread 的模型状态语义](https://github.com/Eyhy/feishu-codex-bridge/issues/2)
> 目标：确定「线程当前模型/effort」由谁持有、存在哪里、Bridge 能否不改动会话地读到它，以及飞书侧切换模型后桌面端下一轮会不会用新模型（S1）。

## 背景

Bridge 与 Codex 桌面端操作同一批 Codex thread。两边要回答同一类问题：这个线程现在用哪个模型？如果我改了，另一侧什么时候知道？

本地环境存在一个关键的**版本分裂**，它决定了下面所有结论的边界：

```
$ codex --version                      # /home/lyt/.local/bin/codex
codex-cli 0.153.4

$ codex app-server daemon version      # 用 0.153.4 CLI 查询
{"socketPath":"/home/lyt/.codex/app-server-control/app-server-control.sock",
 "cliVersion":"0.153.4","appServerVersion":"0.153.4","transport":"socket"}

$ /usr/lib/chatgpt/resources/codex app-server daemon version   # 桌面自带 0.162.0-alpha.2
{"socketPath":"/home/lyt/.codex/app-server-control/app-server-control.sock",
 "cliVersion":"0.162.0-alpha.2","appServerVersion":"0.153.4",
 "managedCodexPath":"/home/lyt/.codex/packages/app-server-daemon/current/bin/codex"}
```

即：桌面 UI 是 0.162.0-alpha.2 的客户端，但它经 unix socket 连的是 **0.153.4 的共享 daemon**；Bridge 则完全另起一个 `codex app-server --listen stdio://` 子进程（[src/agent/codex/app-server.ts:106](src/agent/codex/app-server.ts#L106)）。两侧**不是同一个进程**，这是本笔记最重要的前提。

## 方法与来源

一手来源分四类，全部在本机可复现：

1. **0.153.4 的协议 schema**（与 daemon 同版本）：`codex app-server generate-json-schema --experimental --out <dir>`，现代协议在 `v2/` 下（引用 `ThreadReadResponse.json`、`ThreadResumeParams.json`、`TurnStartParams.json`、`ThreadSettingsUpdateParams.json`、`ThreadSettingsUpdatedNotification.json`、`ModelReroutedNotification.json` 等字段）。schema 是临时生成物，正文引用字段路径而不是临时目录。
2. **实际 rollout 与状态库**：`~/.codex/sessions/**/rollout-*.jsonl`、`~/.codex/state_5.sqlite`、`~/.codex/thread_history_1.sqlite`（只读打开）。
3. **桌面端 Electron bundle**：`/usr/lib/chatgpt/resources/app.asar`（解包后读 main / app-shared / bootstrap）。
4. **隔离实验**：把 `~/.codex` 复制到工作区临时目录，仅把副本里那一行 `threads.rollout_path` 改指向副本内的 rollout，再以 `CODEX_HOME` 与 `HOME` 指向副本启动 `codex app-server`，用 JSON-RPC 调 `thread/read`、`thread/resume`、`thread/settings/update`。**没有执行任何 `turn/start`，没有修改真实 `~/.codex` 里的文件**。脚本见附录 A。

> 网络受限：`https://developers.openai.com/codex/app-server/` 与 `/codex/local-config/` 均 fetch failed，官方在线文档无法作为引用来源；所有结论以本机 0.153.4 的 schema、二进制、rollout 与实测输出为准。

## 结论速览

| # | 问题 | 结论 |
|---|---|---|
| Q1 | `thread/resume`/`thread/read` 是否暴露线程当前 model/effort？不跑 turn 能读到吗？ | **能**。`thread/read` 的 `thread.model`/`thread.reasoningEffort` 就是线程当前设置（未加载时为最新持久值）；`thread/resume` 响应顶层也直接给出。都不需要跑 turn。 |
| Q2 | Bridge 自起的 app-server 与桌面共享 daemon 是否共享线程状态？桌面下一轮模型来自哪里？ | **不共享内存状态，只共享磁盘**。同一 thread 同时只能有一个 writer，第二个进程 `thread/resume` 直接报 `already has an active writer`。桌面下一轮用**线程设置**（会话快照里的 `latestThreadSettings.model`），不是设备配置；设备配置只在新线程时作默认。 |
| Q3 | `turn/start.model` 写入后如何持久化？桌面会收到 `ThreadSettingsUpdatedNotification` 吗？ | 通过 rollout 的 `thread_settings_applied` 快照 + `state_5.sqlite` 的 `threads.model/effort` 持久化；`thread/settings/update` 会**立即**落盘并发 `thread/settings/updated` 通知。桌面**只有**当修改发生在它所连的那个 daemon 进程、且该会话已加载时才会收到。 |
| Q4 | `thread/resume` 传 `model` 是仅本次覆盖还是持久化？ | **仅本次（进程内）覆盖，不落盘**：实测 resume 传 `model=gpt-6-sol` 后响应与进程内 read 都是新值，但 `state_5.sqlite` 与另一进程的 read 仍是旧值。 |
| Q5 | `model/rerouted` 的触发条件 | 0.153.4 只有一个原因枚举 `highRiskCyberActivity`；桌面只把它渲染成该 turn 里的一条提示项，不改线程设置、不持久化。 |

---

## Q1：`thread/resume`/`thread/read` 是否暴露线程当前 model/effort，不跑 turn 能否读到

**能，而且不需要跑 turn。**

`thread/read` 的参数只有 `threadId`（必填）和 `includeTurns`（可选）：

> ThreadReadParams.json：`threadId`（required）、`includeTurns`（"When true, include turns and their items from rollout history. Full-history hydration is deprecated for paginated threads; prefer a metadata-only read and page with thread/turns/list and thread/items/list."）

返回的 `Thread` 直接带两个字段，schema 里的语义写得很明确：

> ThreadReadResponse.json → `definitions.Thread.model`："Current configured model when loaded, otherwise the latest persisted model. Null when unavailable. This is not per-turn execution telemetry."
> ThreadReadResponse.json → `definitions.Thread.reasoningEffort`："Current configured reasoning effort when loaded, otherwise the latest persisted effort. Null when unset or unavailable. This is not per-turn execution telemetry."

同一份 schema 还给出「未加载」的判据：

> `Thread.canAcceptDirectInput`："Whether the app server accepts direct turn input for this loaded thread. `None` means the capability is unavailable, such as for an unloaded stored thread."

实测（隔离副本，只发 `initialize` 与 `thread/read`，无 turn）：

```
thread/read {threadId}                    → model=gpt-6-astra effort=ultra canAcceptDirectInput=null turns=0
thread/read {threadId,includeTurns:true}  → 返回 turns（本文不需要）
```

`thread/resume` 也直接给：`ThreadResumeResponse.json` 的**顶层**就带 `model`（string）、`reasoningEffort`、`serviceTier`、`modelProvider` 等，不必翻 `thread.turns`。实测 resume 返回 `model=gpt-5.6-sol effort=high turns=2`，与 `thread/read` 同源。

差别只有一个：**`thread/read` 只读，`thread/resume` 会把线程加载进来并持有写锁**（见 Q2）。所以「读线程当前模型」不需要 resume。

## Q2：Bridge 的 app-server 与桌面共享 daemon 是否共享线程状态；桌面下一轮模型来自哪里

### 2.1 进程模型：不共享内存，只共享磁盘

Bridge 每次拉起自己的子进程：

- [src/agent/codex/app-server.ts:106](src/agent/codex/app-server.ts#L106)：`spawn(this.binary, ['app-server','--listen','stdio://'], ...)`
- 桌面连的是 `/home/lyt/.codex/app-server-control/app-server-control.sock` 上的共享 daemon（0.153.4，见上面的 `daemon version` 输出）。

两者对同一个 thread 存在**跨进程写者互斥**。隔离实验（两个独立 app-server 进程，同一个副本 CODEX_HOME）：

```
1 B resume（先加载）                    → ok model=gpt-5.6-sol
2 A resume 同一 thread                 → 错误 -32600 "thread 01a17b27-... already has an active writer"
3 A 未加载时 thread/settings/update    → 错误 -32600 "thread not found: 01a17b27-..."
4 A 被 kill 后 C resume                → ok（进程退出即释放锁）
5 A 存活但空闲 12s，B resume           → 仍然 "already has an active writer"
```

跨进程读只能看到**持久值**，看不到对方内存里的覆盖：

```
1 A thread/resume {threadId, model:'gpt-6-sol'}  → A 内存中 model=gpt-6-sol effort=ultra
2 D（另一进程）thread/read {threadId}            → model=gpt-5.6-sol effort=high canAccept=null
3 state_5.sqlite threads 行                      → 仍是 gpt-5.6-sol|high（A 的覆盖没落盘）
```

所以「线程状态共享」的准确说法是：**同一时刻只允许一个进程加载（写）某 thread；状态通过 `state_5.sqlite` 的 `threads` 行和 rollout 文件在磁盘上交接，不通过任何内存或通知通道同步。**

### 2.2 桌面端下一轮发消息时，模型来自哪里

桌面端（app-shared bundle，`async function Gon(...)`，约索引 3009521）计算本轮模型的优先级是：

```js
c = context.inheritThreadSettings            // 默认 true
D = c ? a.latestThreadSettings : null
M = D?.model ?? (c ? a.latestModel : null)
N = D?.effort === void 0 ? (c ? a.latestReasoningEffort : null) : D.effort
P = j ? null : (s.model ?? M)?.trim() || null   // j = 本轮指定了 collaborationMode
```

即：**本轮显式选择 ?? 线程当前设置（`latestThreadSettings.model`） ?? 会话快照里的 `latestModel`**。算出的值会真的放进 `turn/start` 参数（同一 bundle 中 `turn/start` 请求体含 `model:F, ..., effort:ee`）。

`latestThreadSettings` 由三处刷新：`thread/start` 响应、`thread/resume` 响应、以及 `thread/settings/updated` 通知。bootstrap bundle 里的应用函数是：

```js
function wv(e,t){ ... e.latestThreadSettings=t, ... e.latestModel=t.model,
  e.modelProvider=t.modelProvider, e.latestReasoningEffort=t.effort,
  e.latestCollaborationMode=t.collaborationMode, e.cwd=t.cwd, ... }
```

而「设备配置」只在没有线程时才是模型来源：main bundle 里无 `conversationId` 时走 `config/batchWrite` 把默认模型写回设备配置，有 `conversationId` 时改走 `thread/settings/update`：

```js
j = {model:y.model, reasoningEffort:w, daybreakEnabled:e.enabled}
if (t!=null && e.conversationId!=null && j.model!==t.model)
  await c.sendAppServerRequest('thread/settings/update', {threadId:e.conversationId, model:j.model, effort:j.reasoningEffort})
// 没有线程时才: config/batchWrite(...p.zi(x.model,...), filePath, expectedVersion)
```

**结论**：桌面下一轮用的是「线程设置」（在它自己的内存快照里），设备配置只是新建线程/无覆盖时的默认。由于线程设置缓存在桌面所连 daemon 的客户端内存里，Bridge 另一个进程改的设置不会自动出现在桌面的下一轮里——除非桌面在发送前重新 `thread/resume` 过该线程。

### 2.3 对 Bridge 的直接后果

[src/agent/codex/adapter.ts:560-563](src/agent/codex/adapter.ts#L560-L563) 对历史线程先 `thread/resume {threadId, cwd}`。若该线程正被桌面 daemon 持有，这一步会失败，错误文本是 `thread <id> already has an active writer`——Bridge 目前只识别 `/thread not loaded/`（[adapter.ts:687-690](src/agent/codex/adapter.ts#L687-L690)），源码里没有任何 `active writer` 处理（`grep -rn 'active writer' src docs` 无结果）。


## Q3：`turn/start.model` 如何持久化；桌面是否收到 `ThreadSettingsUpdatedNotification`

### 3.1 语义

> TurnStartParams.json → `model`："Override the model for this turn and subsequent turns."
> TurnStartParams.json → `effort`：同样的句式（this turn and subsequent turns）。
> TurnStartParams.json → `collaborationMode`："EXPERIMENTAL - Set a pre-set collaboration mode. Takes precedence over model, reasoning_effort, and developer instructions if set."

也就是 `turn/start` 上的模型**不是一次性覆盖**，而是「本轮 + 后续轮」的线程级设置。这与 rollout 的观察一致：同一线程在某轮切到 `gpt-6-astra` 之后，后续所有 `turn_context` 都沿用新模型。

### 3.2 持久化落点

两处，都在磁盘上：

1. **rollout 里的 `thread_settings_applied` 快照**（`event_msg` 的 payload 带一份完整 `thread_settings`：model / reasoning_effort / approval / sandbox / collaboration_mode 等）。
   例：`~/.codex/sessions/2026/09/30/rollout-2026-09-30T17-40-47-01a0f1b0-2325-7760-84dd-0921fe9f23cf.jsonl`
   - 第 105 行（ordinal 104）：`thread_settings.model = gpt-5.6-sol`
   - 第 347 行（ordinal 346）：`thread_settings.model = gpt-6-astra`（模型切换点）
   - 第 348 行（ordinal 347）：紧随其后又一次 `thread_settings_applied`，同为 `gpt-6-astra`
   - 第 427 行（ordinal 426）的 `turn_context`：`model = gpt-6-astra, effort = xhigh`
   - 第 8 行（ordinal 7）的 `turn_context`：`model = gpt-5.6-sol`
2. **`state_5.sqlite` 的 `threads` 行**：`model TEXT`、`reasoning_effort TEXT` 存「最后应用的设置」。该线程对应行是 `model = gpt-6-astra, reasoning_effort = xhigh, source = vscode, cli_version = 0.153.4`；全库 344 个线程每行只有一个 model（gpt-6-astra 192 / gpt-6.1-sol 82 / gpt-5.6-sol 55 / gpt-5.6-terra 9 / gpt-reserve 2 / NULL 2 / gpt-6-sol 1 / gpt-5.6-luna 1），与「每线程单一当前模型」一致。

注意 `~/.codex/thread_history_1.sqlite` 的 `thread_turns` 表**没有 model 列**（只有 thread_id/turn_id/rollout_ordinal/status/时间/字节偏移等）；「每轮用了哪个模型」只能从 rollout 的 `turn_context` 读。

### 3.3 `thread/settings/update` 立即持久化（实测，不需要 turn）

隔离实验对已加载线程发一条 `thread/settings/update {threadId, model:'gpt-5.6-sol', effort:'high'}`：

```
5 SETTINGS-UPDATE: {"id":5,"result":{}}                 ← 响应是空对象
6 NOTES: thread/settings/updated,mcpServer/startupStatus/updated
7 NOTIF: {"model":"gpt-5.6-sol","effort":"high","modelProvider":"openai", ...}
8 READ(after update): model=gpt-5.6-sol effort=high
== DB after ==  gpt-5.6-sol|high                        ← 已经落盘
== rollout thread_settings_applied count: 1 → 2         ← 追加了一行快照
```

两点值得记住：
- `ThreadSettingsUpdateResponse` 是空对象（`{"type":"object"}`），改完必须自行重读；
- 未加载的线程上调用会失败：`thread not found: <id>`（同一天第一次实验的输出）。要改设置，必须先 `thread/resume`。

### 3.4 桌面端会不会收到 `thread/settings/updated`

**只有改动发生在桌面所连的那个 daemon 进程时才收得到。** 依据有两条：

1. 通知是进程内广播：实测同一个 app-server 进程里，`thread/settings/update` 之后 1.2s 内收到 `thread/settings/updated`（上面第 6/7 行）；跨进程根本轮不到广播——第二个进程连加载都做不到（`already has an active writer`）。
2. 桌面端收到后也不是无条件应用。bundle 里：

```js
case 'thread/settings/updated': {
  const {threadId:i, threadSettings:a} = n.params, o = r.vs(i);
  t.threadStore.conversations.has(o) && e.updateConversationState(o, e => { wv(e,a) });
  return
}
```

`conversations.has(threadId)` 不满足（该会话没在本客户端加载）就直接丢弃。

所以 Bridge 的独立 app-server 改了线程设置后：rollout/DB 变了，桌面端的 `latestThreadSettings` 没变，桌面也不会收到通知。


## Q4：`thread/resume` 传 `model` 是仅本次覆盖还是持久化

**仅进程内覆盖，不持久化。**

schema 的措辞是「覆盖」而不是「设置」：

> ThreadResumeParams.json → `model`："Configuration overrides for the resumed thread, if any."（type 为 string 或 null；`ThreadResumeParams` 里没有 `effort` 字段，只有 approvalPolicy / cwd / sandbox / permissions / serviceTier 等）

实测（全新进程，线程未被任何进程加载，直接 resume 并带 model）：

```
DB BEFORE: gpt-5.6-sol|high
1 A thread/resume {threadId, model:'gpt-6-sol'} → model=gpt-6-sol effort=ultra threadModel=gpt-6-sol
3 A thread/read                                → model=gpt-6-sol effort=ultra
DB AFTER : gpt-5.6-sol|high                    ← 完全没有变
另一进程 D thread/read                          → model=gpt-5.6-sol effort=high
```

两个额外观察：
- 只传 `model` 时，`effort` 会被重置成**设备默认**（副本里的 config.toml 是 model_reasoning_effort='ultra'），而不是保留线程原来的 high。所以 resume 带 model 可能顺手改掉 effort。
- 同一进程里对**已加载**的线程再次 resume 并传 `model`，参数被忽略（该次响应仍是 gpt-5.6-sol，走的是 rejoin 路径）。

结论：要让「切模型」对另一侧、对下一轮生效，**不能只靠 `thread/resume` 的 model 参数**——它只影响当前进程加载出来的那份内存状态。真正落盘的是 `thread/settings/update`（立即）或 `turn/start.model`（在该轮应用设置时写 `thread_settings_applied`）。


## Q5：`model/rerouted` 的触发条件

0.153.4 的 schema 里，原因只有一个值：

> ModelReroutedNotification.json：required = fromModel / reason / threadId / toModel / turnId；definitions.ModelRerouteReason = 单值枚举 highRiskCyberActivity。

二进制里的枚举也是单变体（`variant index 0 <= i < 1`），没有第二个原因。所以在本地可得的证据范围内，触发条件是：**服务端在某个 turn 里判定为高风险网络活动（high-risk cyber activity）时，把该 turn 的模型从 fromModel 改判到 toModel**，并通过带 threadId / turnId 的通知告知客户端。具体判定阈值在服务端策略里，本地不可见。

桌面端对这个通知的处理**只是展示**，不影响模型语义：

```js
case 'model/rerouted': {
  const {threadId:e, turnId:n, fromModel:r, toModel:i, reason:a} = t.params;
  o.updateTurnState(Z(e), n, e => { e.items.push({id:s(), type:'modelRerouted', fromModel:r, toModel:i, reason:a}) });
  break
}
```

即：往该 turn 的 items 里插一条 `modelRerouted` 展示项，**不改 latestModel、不改线程设置、不落盘**。rollout 里也没有对应写入：本机那条混合模型线程的 `thread_settings_applied` 中出现的模型变化都发生在相邻的 turn 之间，且伴随同线程后续轮次沿用新模型，符合用户切换语义，未出现 rerouted 的痕迹。

Bridge 侧目前把它翻译成一条 ui_notice（见 [adapter.ts:419-422](src/agent/codex/adapter.ts#L419-L422)），与桌面端「只提示、不改状态」的语义一致。

补充一条相关的版本门控事实：桌面 bundle 里 `daybreakEnabled` 的能力门槛是 `0.154.0-alpha.6`（`daybreakModelAccess` 是 `0.155.0-alpha.6`），而本机 daemon 是 0.153.4，所以桌面不会往 daemon 发 daybreak 相关字段。这与「桌面按 daemon 版本裁剪字段」的整体设计一致。

---

## 对 S1 的结论

S1（飞书侧切换模型后，桌面端下一轮是否会用新模型）：**有条件成立。**

成立的部分：线程设置是**线程级、持久化**的，桌面端每轮 turn/start 的模型取自线程设置（`latestThreadSettings.model`），而不是每次重新取设备默认值。所以 Bridge 把新模型写进线程设置之后，桌面端下一次该线程的请求会带上新模型——**前提是下面两个条件都满足**。

条件 1：**切换必须落到持久化的线程设置上**，即用 `thread/settings/update`（立即写 state_5.sqlite 的 threads 行 + rollout 追加快照）或 `turn/start.model`（该轮应用时写）。只发 `thread/resume{model}` 不满足：那只改当前进程内存，DB 与另一进程都看不到（Q4 实测）。

条件 2：**桌面端没有持有该线程的写锁，且切换后桌面尚未用旧设置跑过一轮。** 实测跨进程互斥 `thread <id> already has an active writer`，且锁在进程存活期间不因空闲释放。因此：

- 桌面未打开该线程 → Bridge 可以 resume + settings/update，写盘成功；桌面下次打开/发消息时 resume 读到的是新模型 → **成立**。
- 桌面已经加载该线程 → Bridge 连 resume 都做不到，只能读（`thread/read`）；此时桌面端的 `latestThreadSettings` 仍是旧值，并且它会**显式**把旧模型放进 turn/start 请求（`P=(s.model??M)?.trim()||null`，M 来自通知更新的 latestThreadSettings）→ **不成立**，而且桌面这一轮还会把旧模型写回线程设置，把 Bridge 的意图覆盖掉。
- 即使桌面没抢到锁但已经缓存了旧设置（例如同进程内先加载、Bridge 后来通过别的方式写了 DB），桌面仍会用缓存值，此时同样不成立，直到它重新 resume 或收到 thread/settings/updated。

另有一个独立于锁的坑：Bridge 现状是**每轮都显式覆盖模型**。`effectiveModel = opts.model ?? (opts.sessionId ? await this.resolveDefaultModel() : undefined)`（[adapter.ts:555](src/agent/codex/adapter.ts#L555)）配 `turn/start` 里的 `...(opts.sessionId && effectiveModel && !replacementStarted ? {model: effectiveModel} : {})`（[adapter.ts:580-587](src/agent/codex/adapter.ts#L580-L587)）。也就是说，Bridge 对历史线程的每一轮都会把模型重置成**设备默认**（model/list 的 isDefault），既会覆盖用户在桌面端选的模型，也会覆盖 Bridge 自己在上一轮切过去的模型。要让 S1 成立，这一处必须改成「未显式指定就不发 model」。

---

## 读线程当前模型的可行路径

**推荐：`thread/read {threadId}`（不带 `includeTurns`），取 `result.thread.model` 与 `result.thread.reasoningEffort`。**

- 不需要 load，不需要跑 turn：实测 `READ(unloaded): model=gpt-6-astra effort=ultra canAccept=null turns=0`。
- 不需要写锁：别的进程（哪怕正持有写锁）也能读；读到的是**持久化值**，不是别的进程的内存覆盖值（Q4 实验里 D 进程读到的始终是 DB 值）。
- 字段语义：Thread.model = "Current configured model when loaded, otherwise the latest persisted model. Null when unavailable. This is not per-turn execution telemetry."；reasoningEffort 同理。

**回退：`thread/resume {threadId}`，取响应**顶层**的 `model` / `reasoningEffort`（ThreadResumeResponse 顶层就有这两个字段，不必解析 thread.turns）。代价是会尝试取得写锁：桌面开着该线程时会报 `already has an active writer`；好处是返回的是该进程里「现在生效」的值，并在需要改设置时本来就得先 resume。

**列表场景：`thread/list`（可加 `useStateDbOnly: true`）返回的每个 Thread 也带 model / reasoningEffort**，实测 `model=gpt-6-astra effort=ultra`——适合一次排多个线程而不逐个 read。

**改设置：`thread/settings/update {threadId, model?, effort?}`（必须先已加载）**；响应是空对象，改完请重读。只改本轮用 `turn/settings/update {threadId, turnId, model?, effort?}`（"Omission or null leaves the model unchanged."）。

**反面提醒：不要把 `turn/start.model` 当切模型手段**，也不要依赖 `thread/resume{model}`。前者要跑一轮才落盘，后者根本不落盘。

Bridge 侧具体改动点（供后续实现参考，本次未改代码）：[adapter.ts:148-169](src/agent/codex/adapter.ts#L148-L169) 的 `readSession` 已经在走 `thread/read` → 失败回退 `thread/resume`，把响应里的 model / reasoningEffort 往上带即可；[adapter.ts:555](src/agent/codex/adapter.ts#L555) 的默认模型回落与新线程路径需要分开处理。


---

## 仍不确定 / 待验证

1. **桌面 daemon 何时释放写锁。** 已确认：进程退出会释放；空闲 12s 不会释放。未知：桌面关闭线程视图、切换项目、系统休眠后是否释放，以及是否有超时回收。这决定了「Bridge 何时抢得到 resume」。
2. **桌面持有写锁时 Bridge 的现实表现。** 实验里 Bridge 只能读（`thread/read` 成功）。Bridge 线上代码没有处理 active writer 分支（`grep -rn 'active writer' src docs` 无结果），真实触发频率未测（避免对真实 `~/.codex` 做压力实验）。
3. **`turn/start.model` 是否必然在 rollout 写 `thread_settings_applied`。** 因为约束禁止执行真实 turn，只能用历史 rollout 间接推断（混合模型线程里每次 turn_context 的模型变化前都伴随一条 thread_settings_applied）；「带 model 的 turn/start 若与线程当前设置相同是否仍写一条」未验证。
4. **`thread/read` 何时报 `thread not loaded`。** 未加载线程的 read 实测成功，所以 Bridge 里那段 `isThreadNotLoadedError` 回退路径（[adapter.ts:687-690](src/agent/codex/adapter.ts#L687-L690)）的触发条件没有复现出来；可能是更早版本或特定线程状态（rollout 缺失、正在被别的进程 resume）下的行为。
5. **`model/rerouted` 的服务端判定边界。** 只有枚举值可读，触发阈值与是否可能对同一 turn 反复 reroute 都不可见。
6. **daemon 升级到 0.162 之后。** 桌面 0.162 客户端已经会发 `ifModelEquals`/`ifEffortEquals` 做乐观并发，而 0.153.4 的 `ThreadSettingsUpdateParams` 没有这两个字段；升级后并发语义与「静默丢弃 vs 报错」的行为需要重测。
7. **桌面端多窗口（thread-follower）。** app-shared 里存在 `thread-follower-start-turn`/`thread-follower-read-model-settings`/`thread-follower-update-thread-settings` 一套协作协议，只有 owner 能 startTurn；这等于第三种状态持有者，未做实验。
8. **桌面 UI 的实际生效时机。** 代码路径显示收到 `thread/settings/updated` 后 `latestThreadSettings` 会被整体替换、下一轮立即使用，但没有在真实 UI 里端到端验证过。

## 附录 A：隔离实验的复现步骤

全部在工作区内进行，**不动真实 `~/.codex`**。`/tmp` 不可用（codex 会拒绝在临时目录建 helper 二进制，且 resume 报 `Read-only file system (os error 30)`），必须放在工作区。

```bash
cd /home/lyt/apps/feishu-codex-bridge
mkdir -p .tmp-cxhome/sessions/2026/10/27
cp ~/.codex/config.toml             .tmp-cxhome/
cp ~/.codex/state_5.sqlite          .tmp-cxhome/
cp ~/.codex/thread_history_1.sqlite .tmp-cxhome/
cp ~/.codex/sessions/2026/10/27/rollout-2026-10-27T10-18-49-01a17b27-3626-7e80-87ed-4dad8e13f518.jsonl .tmp-cxhome/sessions/2026/10/27/
# 关键一步：DB 里存的是绝对路径，必须改成副本内路径，否则 resume 会去开真实文件（EROFS）
/home/lyt/anaconda3/bin/sqlite3 .tmp-cxhome/state_5.sqlite "update threads set rollout_path='/home/lyt/apps/feishu-codex-bridge/.tmp-cxhome/sessions/2026/10/27/rollout-2026-10-27T10-18-49-01a17b27-3626-7e80-87ed-4dad8e13f518.jsonl' where id='01a17b27-3626-7e80-87ed-4dad8e13f518';"

TID=01a17b27-3626-7e80-87ed-4dad8e13f518 CXH=/home/lyt/apps/feishu-codex-bridge/.tmp-cxhome node .tmp-cxhome/probe.cjs
```

探针脚本（实验时实际执行的那份 `.tmp-cxhome/probe.cjs`，环境变量 TID 指定线程、CXH 指定 CODEX_HOME 副本）：


```js
const { spawn } = require('child_process');
const THREAD=process.env.TID, HOME=process.env.CXH;
const child=spawn('/home/lyt/.local/bin/codex',['app-server','--listen','stdio://'],{env:{...process.env,CODEX_HOME:HOME},stdio:['pipe','pipe','pipe']});
let id=0;const pending=new Map();const notes=[];let buf='';
child.stdout.on('data',d=>{buf+=d.toString();let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{continue}
 if(m.id!==undefined&&(m.result||m.error)){const p=pending.get(m.id);pending.delete(m.id);p&&p(m);}else if(m.method){notes.push(m);}}});
child.stderr.on('data',d=>{});
function req(method,params,ms=20000){return new Promise(res=>{const i=++id;const t=setTimeout(()=>{pending.delete(i);res({error:{message:'timeout:'+method}})},ms);pending.set(i,m=>{clearTimeout(t);res(m)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n');});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const init=await req('initialize',{clientInfo:{name:'feishu_codex_bridge',version:'0.1.0'},capabilities:{experimentalApi:true}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}})+'\n');
 console.log('1 INIT', init.error?'ERR':'ok');
 const rd1=await req('thread/read',{threadId:THREAD});
 console.log('2 READ(unloaded):', rd1.error?JSON.stringify(rd1.error).slice(0,160):'model='+rd1.result.thread.model+' effort='+rd1.result.thread.reasoningEffort+' canAccept='+rd1.result.thread.canAcceptDirectInput);
 const rs=await req('thread/resume',{threadId:THREAD});
 console.log('3 RESUME:', rs.error?JSON.stringify(rs.error).slice(0,200):'model='+rs.result.model+' effort='+rs.result.reasoningEffort+' threadModel='+(rs.result.thread&&rs.result.thread.model)+' turns='+(rs.result.thread&&rs.result.thread.turns&&rs.result.thread.turns.length));
 const rd2=await req('thread/read',{threadId:THREAD});
 console.log('4 READ(loaded):', rd2.error?JSON.stringify(rd2.error).slice(0,160):'model='+rd2.result.thread.model+' canAccept='+rd2.result.thread.canAcceptDirectInput);
 notes.length=0;
 const su=await req('thread/settings/update',{threadId:THREAD,model:'gpt-5.6-sol',effort:'high'});
 console.log('5 SETTINGS-UPDATE:', JSON.stringify(su).slice(0,240));
 await sleep(1500);
 console.log('6 NOTES:', notes.map(n=>n.method).join(',')||'(none)');
 const sn=notes.find(n=>n.method==='thread/settings/updated');
 if(sn)console.log('7 NOTIF:', JSON.stringify(sn.params.threadSettings).slice(0,420));
 const rd3=await req('thread/read',{threadId:THREAD});
 console.log('8 READ(after update):', rd3.error?JSON.stringify(rd3.error).slice(0,160):'model='+rd3.result.thread.model+' effort='+rd3.result.thread.reasoningEffort);
 const rs2=await req('thread/resume',{threadId:THREAD,model:'gpt-6-sol'});
 console.log('9 RESUME(model=gpt-6-sol):', rs2.error?JSON.stringify(rs2.error).slice(0,200):'model='+rs2.result.model+' threadModel='+(rs2.result.thread&&rs2.result.thread.model));
 const rd4=await req('thread/read',{threadId:THREAD});
 console.log('10 READ(after resume-model):', rd4.error?JSON.stringify(rd4.error).slice(0,160):'model='+rd4.result.thread.model);
 await sleep(600);
 child.kill('SIGKILL');process.exit(0);
})();
```

## 附录 B：本次用到的命令

```bash
codex --version                                              # codex-cli 0.153.4
codex app-server daemon version                              # 0.153.4 daemon + unix socket 路径
/usr/lib/chatgpt/resources/codex app-server daemon version    # 桌面 0.162 客户端看到的 daemon（仍是 0.153.4）
codex app-server generate-json-schema --experimental --out .tmp-codex-schema
ls .tmp-codex-schema/v2 | head                               # ThreadRead / ThreadResume / TurnStart / ThreadSettingsUpdate / ...
/home/lyt/anaconda3/bin/jq . .tmp-codex-schema/v2/TurnStartParams.json
cat /usr/lib/chatgpt/linux-package-metadata.json             # {'codexAppBrand':'chatgpt','version':'26.1002.52244'}
grep -n 'thread_settings_applied' ~/.codex/sessions/2026/09/30/rollout-2026-09-30T17-40-47-01a0f1b0-2325-7760-84dd-0921fe9f23cf.jsonl
/home/lyt/anaconda3/bin/sqlite3 'file:/home/lyt/.codex/state_5.sqlite?immutable=1' "select id,model,reasoning_effort from threads limit 5;"
# app.asar（558MB）解包：Node 解析 asar 头（bytes[12..16]=jsonSize，条目表起点 16+jsonSize，按 4 字节对齐），
# 只导出前缀匹配 webview/assets/{main,app-shared,app-initial,bootstrap} 的条目再 grep。
# 直接 grep app.asar 每次 4-6 分钟且易超时——务必先解包。
```

> 说明：schema 目录 `.tmp-codex-schema`、解包产物 `.tmp-js*` / `.tmp-asar*`、实验副本 `.tmp-cxhome` 都是本次研究的临时产物，已在研究结束后删除，不进入仓库。
