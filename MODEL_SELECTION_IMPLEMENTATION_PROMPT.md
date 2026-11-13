# 飞书话题内选择 Codex 模型：实施 Prompt

请在仓库 `/home/lyt/apps/feishu-codex-bridge` 中实现“飞书话题内选择 Codex 模型”功能。

先阅读现有代码和 git 状态。仓库中可能已有未提交修改，必须保留这些修改，禁止 reset、checkout 或覆盖无关文件。本次只实现模型选择功能，不修改 Codex Desktop 配置、不修改飞书凭据、不改变桥接服务部署方式。

## 功能要求

### 1. 模型选择范围

模型选择按当前飞书话题保存。

例如：

```text
chat_id:topic_id
```

每个话题可以选择不同模型。模型选择只影响该话题后续的新一轮 Codex 请求，当前正在执行的任务不切换模型。

### 2. 飞书入口

增加以下入口：

- 话题欢迎卡中增加“选择模型”按钮。
- 在飞书话题中发送 `/model`，打开模型选择卡片。
- 支持 `/model default`，清除当前话题的模型覆盖并恢复本机默认模型。

话题中的普通中文消息仍然必须发送给 Codex，不要把“模型”等普通中文词语全局拦截成桥接器命令。使用显式 `/model` 和卡片按钮即可。

### 3. 获取模型列表

通过 Codex App Server 的 `model/list` 获取可用模型。

在 `src/agent/types.ts` 中增加通用模型类型，例如：

```ts
export interface AgentModel {
  id: string;
  name?: string;
  isDefault?: boolean;
}
```

在 `AgentAdapter` 中增加可选方法：

```ts
listModels?(): Promise<AgentModel[]>;
```

在 `src/agent/codex/adapter.ts` 中实现 `listModels`：

- 调用 `model/list`。
- 解析模型 id、显示名称和 `isDefault`。
- 对异常返回可读错误。
- 不要把账号凭据或敏感信息写入日志。

OMP adapter 不要求实现该接口。当前 `agentBackend` 为 `codex` 时才显示模型选择功能。

### 4. 保存当前话题的模型

修改 `src/session/store.ts`，在 `SessionEntry` 中增加：

```ts
model?: string;
```

增加：

```ts
getModel(scope: string): string | undefined;
setModel(scope: string, model: string): void;
clearModel(scope: string): void;
```

要求：

- 模型选择可以在话题还没有 Codex session 时保存。
- `load` 时要支持只有 model、没有 `sessionId/cwd` 的条目。
- `SessionStore.set()` 更新 `sessionId/cwd` 时必须保留已有 model。
- `clearModel()` 后，后续请求使用 Codex 默认模型。
- 不同 scope 的模型选择不能互相影响。

### 5. 模型选择卡片

在 `src/card/templates.ts` 中新增类似：

```ts
modelsCard(models, currentModel)
```

卡片至少显示：

- 当前使用的模型。
- 可用模型列表。
- 每个模型的选择按钮。
- 恢复默认模型按钮。

模型按钮的 payload 使用现有卡片命令格式，例如：

```ts
{ cmd: 'model.select', arg: modelId }
```

请复用项目中已有的普通交互卡片模式和按钮辅助函数。不要在新的 Schema 2.0 CardKit 卡片中使用旧的 `tag: "action"` 容器；如果使用 Schema 2.0，按钮必须使用当前支持的结构。不要破坏现有的项目、会话和审批卡片。

模型 ID 必须通过 JSON payload 传递，并在服务端重新校验，不能只相信卡片传来的字符串。

### 6. 增加命令处理

在 `src/commands/index.ts` 中增加：

```ts
'/model': handleModel
```

支持：

```text
/model
/model select <model-id>
/model default
```

处理逻辑：

- `/model`：调用 `agent.listModels()`，发送模型选择卡片。
- `/model select <model-id>`：重新获取可用模型，验证目标模型存在，保存到当前 `ctx.scope`，返回“已切换模型，下一轮生效”。
- `/model default`：清除当前 scope 的模型覆盖，返回“已恢复默认模型”。
- 如果当前 agent 不支持模型列表，返回明确提示。
- 如果模型不存在，不保存，并重新显示模型卡片。
- 从卡片点击时，优先更新原卡片，避免重复发送消息。
- 模型卡片和反馈卡片必须尽量留在当前飞书话题中。

### 7. 让实际 Codex 请求使用选中的模型

在 `src/bot/channel.ts` 的 `runAgentBatch` 或对应 `agent.run` 调用处：

- 优先读取 `sessions.getModel(scope)`。
- 如果当前话题没有覆盖，再使用现有的 `getOmpModel(controls.cfg)`。
- 保留 OMP 模式现有行为。

调用逻辑应类似：

```ts
const selectedModel =
  getAgentBackend(controls.cfg) === 'codex'
    ? sessions.getModel(scope)
    : undefined;

model: selectedModel ?? getOmpModel(controls.cfg)
```

在 `src/agent/codex/adapter.ts` 中修改 `turn/start` 参数：

- 新建会话时，如果 `opts.model` 存在，必须传入 model。
- 恢复历史会话时，如果 `opts.model` 存在，必须传入 model。
- 历史会话兼容性失败并自动创建替代会话时，也要继续传递选中的模型。
- 没有选择模型时，保持当前默认模型解析逻辑。
- 不要影响 `turn/steer` 的现有行为。

### 8. 测试

修改或新增以下测试：

`src/agent/codex/adapter.test.ts`：

- `model/list` 能正确解析。
- 新建会话的 `turn/start` 携带选中的模型。
- 历史会话恢复的 `turn/start` 携带选中的模型。
- 兼容性替换会话仍携带选中的模型。

`src/card/templates.test.ts`：

- 模型卡片显示模型列表。
- 当前模型有明确标记。
- 按钮 payload 包含正确模型 ID。
- 恢复默认按钮存在。

新增或扩展 SessionStore 测试：

- 模型可以持久化。
- 模型可以在没有 `sessionId` 时保存。
- `set()` 会保留 model。
- `clearModel()` 后恢复默认。
- 不同 scope 相互隔离。

`src/commands/project-workflow.test.ts`：

- `/model` 会请求模型列表并发送卡片。
- `/model select <id>` 能保存合法模型。
- 非法模型不会保存。
- `/model default` 能清除覆盖。
- 卡片点击 `model.select` 能更新原卡片。

### 9. 文档

在 `README.md` 的飞书使用部分增加：

```text
/model          查看当前话题可用模型
/model default  恢复当前话题的默认模型
```

说明模型选择按飞书话题保存，并从下一轮请求生效。

### 10. 验证

完成后运行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

或者直接运行：

```bash
pnpm check
```

修复所有类型错误和测试失败。最后汇报：

- 修改了哪些文件。
- 模型选择的实际生效路径。
- 测试和构建结果。
- 是否还有兼容性限制。

不要修改 Codex Desktop 的 `config.toml`，不要重启 systemd 服务，不要提交 git commit。
