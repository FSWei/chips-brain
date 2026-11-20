# Hermes 适配器

两个文件：

- `brain_gate.py` — 独立插件：包装 `MemoryStore.add` / `apply_batch`，写前调 `brain.js check`
- `plugin.yaml` — 插件清单

## 安装

```bash
mkdir -p ~/.hermes/profiles/<profile>/plugins/brain-gate
cp brain_gate.py ~/.hermes/profiles/<profile>/plugins/brain-gate/__init__.py
cp plugin.yaml    ~/.hermes/profiles/<profile>/plugins/brain-gate/
hermes -p <profile> plugins enable brain-gate
```

路径通过环境变量指定（默认 `~/agent-brain/.brain/bin/brain.js`）：

```bash
export BRAIN_BIN=/path/to/agent-brain/.brain/bin/brain.js
```

## 生效条件

`MemoryStore` 是进程内类，`reload-plugins` 不会重新导入它——**改完必须重启网关进程**，
否则旧类还在内存里，闸门看起来"装了但没拦"。

## 验证

```bash
# 违规应被拒，且文件不应多出这一条
# 在任意会话里让 agent 写入："说明见 skill 不存在的名字"
grep -c "不存在的名字" ~/agent-brain/memories/MEMORY.md   # 期望 0
```

## 别踩的坑

见 [`../../docs/WRITE-GATE.md`](../../docs/WRITE-GATE.md)：`pre_tool_call` 钩子、provider 同名 schema、
`register_tool(override=True)`、`on_memory_write` 四种方式在这里全部无效。
