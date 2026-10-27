# Feishu Codex Bridge

把飞书话题桥接到本机 Codex 会话的桥接器：一个飞书话题对应一个 Codex 会话，并可在该话题内单独指定模型与推理强度。

## Language

**话题**:
飞书聊天中的原生 topic，是消息的线程式容器；Bridge 把它映射为一个独立作用域。
_Avoid_: 主题, 帖子, 飞书 thread

**会话**:
用户在飞书里持续进行的一段 Codex 对话，技术上对应一个 Codex thread。
_Avoid_: 对话（作为正式名词）, Session, 线程（用户界面）

**线程**:
Codex thread 的技术同义词，只用于代码、协议、排障文档和 issue。
_Avoid_: 飞书话题, 会话（指协议对象时）

**作用域**:
Bridge 用来隔离会话状态的键：私聊和普通群为 chatId，项目话题为 chatId:topicId。
_Avoid_: 范围, scope（用户界面）, 会话

**覆盖**:
某个话题在设备或全局默认之上单独指定、并在该话题内生效的设置；该词只用于技术文档、代码和 issue。
_Avoid_: 用户界面中的“覆盖”；用户界面按语境说“本话题超时设置”“模型已切换”“待生效”

**模型**:
Codex 会话当前选用的模型，用户界面显示其 displayName。
_Avoid_: model（用户界面）, 引擎

**推理强度**:
模型可选的推理投入档位，由 Codex 的 effort 字段表示；用户界面简称“强度”。
_Avoid_: effort（用户界面）, reasoning level
