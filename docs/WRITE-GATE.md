# 写闸：四个失败方案与一个可行方案

给后来者省时间。这一页记录的是**实测**结论，不是推断。

## 背景

Hermes 的 `memory` 工具是 agent-loop 内联工具：

```python
# model_tools.py
_AGENT_LOOP_TOOLS = {"todo_list", "memory", "session_search", "delegate_task"}
```

它不走常规工具分发，因此下面三种"看起来该有效"的拦截方式全部失效。

## 失败的四个方案

### 1. `pre_tool_call` 插件钩子

```python
def register(ctx):
    ctx.register_hook("pre_tool_call", _blocker)
```

结果：**一次都没触发**。`memory` 在 `_AGENT_LOOP_TOOLS` 里，钩子链不覆盖。

### 2. 让 provider 暴露同名 `memory` schema

```python
class MyProvider(MemoryProvider):
    def get_tool_schemas(self):
        return [{"name": "memory", ...}]
```

结果：被过滤。`MemoryManager.get_all_tool_schemas()` 明确跳过核心工具名：

```python
elif schema["name"] not in _HERMES_CORE_TOOLS and schema["name"] not in seen:
```

### 3. `ctx.register_tool(override=True)`

即便配置了 `plugins.entries.<id>.allow_tool_override: true`，也没用——
`pre_registry_route()` 会告诉你 `memory` 被路由到 `inline`，registry 里的 handler 永远不会跑。

### 4. `MemoryProvider.on_memory_write`

这是写后回调，签名 `(action, target, content, metadata)`，没有返回值能阻止写入。
而且实测只在个别路径触发（网关会话偶发，CLI / API 会话 0 次）。

## 可行方案：包 Store

内联执行器最终一定落到 store：

```python
# agent/inline_tool_executors.py
memory_tool(..., store=agent._memory_store)
```

而 `memory_tool` 的两条路径分别是：

```python
_STORE_ACTIONS = {"add": lambda store, target, content, old_text, entry=None: store.add(target, content), ...}
# 批量：
store.apply_batch(target, operations)
```

所以在这两个方法上做类级幂等包装即可：

```python
_orig_add = MemoryStore.add

def gated_add(self, target, content):
    verdict = brain_check(content, target)      # node brain.js check
    if verdict and verdict.get("ok") is False:
        return {"success": False, "error": f"[brain] {verdict['reason']}: {verdict['detail']}",
                "reason": verdict["reason"], "suggestions": verdict.get("suggestions", [])}
    return _orig_add(self, target, content)

MemoryStore.add = gated_add
```

要点：

- **两条路径都要包**（`add` 与 `apply_batch`），模型经常用 `operations[]` 批量形状；
- **幂等标记**，避免模块被重复导入时包成多层；
- **失败即放行**：node 不在、超时、任何异常 → 走原逻辑，闸门不能拖垮会话；
- **不要在 Python 里重写规则**，否则又回到"两份实现会漂移"。

## 验证方法

不要只测"能不能拦"，要测三件事：

1. 违规能拦（死引用、结构化批量）
2. 合法能写（正常索引条）
3. 拦完文件没污染（`grep` 目标文件应为 0）

```bash
grep -c "不存在的skill" ~/agent-brain/memories/MEMORY.md   # 期望 0
```

## 附：DSH 侧为什么简单

DSH 的 `MemoryProvider.applyBatch` 本身就是写入口，没有内联快路径，
所以 provider 里直接 `check → 拒绝/放行` 就够了，不需要包装任何 Store。
