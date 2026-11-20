# chips-brain

> 一个宿主无关的 agent 记忆内核。Hermes、DeepSeek Harness、Claude Code、Codex 都只是壳，记忆是共用的那一份。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![deps](https://img.shields.io/badge/dependencies-0-blue)

## 问题

每个 agent 都有自己的记忆：Hermes 有 `MEMORY.md`，DSH 抄了一份，Claude Code 用 `CLAUDE.md`，Codex 用另一个文件。
结果是同一个你，在四个地方被记成四个人；规则也各写一遍，慢慢漂移。

提示词约束不住这件事——模型会"合理化"绕过。规则必须在代码里，而且只能有一份。

## 做法

```
                  文件即唯一真相
        ┌──────────────────────────────┐
        │  <brain>/memories/MEMORY.md  │  一行索引，≤150 字
        │  <brain>/memories/USER.md    │  用户画像
        │  <brain>/SOUL.md             │  身份（只读）
        │  <brain>/memories/archive/   │  超限自动归档
        └──────────────┬───────────────┘
                       │  唯一写入路径
                 ┌─────▼─────┐
                 │  brain.js │  锁 + 规则 + 审计 + 归档
                 │ policy.js │  索引级 / 结构 / 相似度 / 死引用
                 └─────┬─────┘
        ┌──────────────┴──────────────┐
   adapters/hermes              adapters/dsh
   MemoryStore 写闸              MemoryProvider 写闸
```

三个不变式：

1. **文件是唯一真相**——没有数据库、没有中间层，`cat MEMORY.md` 就是全部。
2. **规则只有一份**——`kernel/policy.js`，两个宿主都调它，谁也不能自己发明一套。
3. **写入必须过闸**——不合规的写入进不去，而不是"写进去再告警"。

## 快速开始

```bash
# 1. 建一个脑目录
mkdir -p ~/agent-brain/.brain/bin ~/agent-brain/memories
cp kernel/bin/*.js ~/agent-brain/.brain/bin/
cp kernel/rules.example.yaml ~/agent-brain/.brain/rules.yaml

# 2. 写第一条（默认读 $BRAIN_ROOT，未设置时按 bin/ 上两级推断）
export BRAIN_ROOT=~/agent-brain
node ~/agent-brain/.brain/bin/brain.js append --file MEMORY \
  --text "记忆规则：一行索引、详情进 skill，见 skill chips-brain"

# 3. 看看状态
node ~/agent-brain/.brain/bin/brain.js status
```

不合规的写入会被拒，并告诉你为什么：

```json
{
  "ok": false,
  "error": "structured_content",
  "message": "结构化内容（bullet list）应写进 skill｜可选：shorten/create_skill/force",
  "suggestions": [
    { "action": "shorten", "hint": "压到一行索引（≤150 字），细节写进 skill" },
    { "action": "create_skill", "hint": "用 skill_manage 建 skill 放细节" },
    { "action": "force", "hint": "确认必须留在记忆里→强写（不推荐）" }
  ],
  "pending_id": 3
}
```

## CLI

| 命令 | 作用 |
|---|---|
| `status` | 各文件字符数 / 条数 / 余量 |
| `check` | 只判定不写，返回 `{ok, reason, detail, suggestions}` |
| `append` | 追加一条（超限自动归档最老条目，而非拒写） |
| `replace` / `remove` | 按 `--match` 片段替换 / 删除 |
| `list` / `search` | 列出 / 检索（含归档层） |
| `pending` | 查看被拒的写入（落盘，不随进程丢失） |
| `resolve --id N --choice force\|drop` | 处理待定违规 |

所有命令输出 JSON，`--file MEMORY|USER` 指定目标，`--force` 跳过策略（仍绕不过密钥与预算）。

## 规则（`rules.yaml`）

```yaml
files:
  MEMORY.md: { char_limit: 2200, entry_max: 150 }
  USER.md:   { char_limit: 1375, entry_max: 200 }
  SOUL.md:   { char_limit: 4000, writable: false }   # 人格文件只由人改
separator: "\n§\n"
forbid_patterns: [ "sk-[A-Za-z0-9]{20,}", "ghp_[A-Za-z0-9]{30,}", ... ]
lock:  { dir: .brain/lock, stale_seconds: 60 }
audit: .brain/audit.jsonl
```

改这一份，两个宿主同时生效。

## 适配器

### DSH（DeepSeek Harness）

`adapters/dsh` 是一个 `MemoryProvider`：`read / applyBatch / snapshot / renderContext` 全部委托 `brain.js`。
配合社区的 `@lmzhen/dsh-evolution-all` 外壳，在 `cordis.patch.yml` 里把 `memory.provider` 钉到 `chips-brain`。
细节见 [`adapters/dsh/README.md`](adapters/dsh/README.md)。

### Hermes

`adapters/hermes` 是一个小插件：包装 `MemoryStore.add` / `apply_batch`，写前调 `brain.js check`，
不合规直接返回错误。**不能**用 `pre_tool_call` 钩子——`memory` 是 agent-loop 内联工具，钩子不触发；
也不能靠 provider 注册同名工具——会被 `_HERMES_CORE_TOOLS` 过滤。踩坑记录见
[`docs/WRITE-GATE.md`](docs/WRITE-GATE.md)。

## 为什么是"索引级"

实测：一个 1800 字符的记忆文件约 1.3K token，全量注入比"先检索再注入"更便宜；真正贵的是技能库
（几百个 `SKILL.md`，几 MB）。所以策略是：

- **记忆层**：一行索引 + 指针，永远全量注入；
- **技能层**：按需加载；
- **细节**：`SKILL.md` 里，记忆只留"见 skill X"。

这也是 MIS（Memory-Index-Skill）的核心，chips-brain 把它从 Hermes 插件里抽成了宿主无关的内核。

## 实测

| 项目 | 结果 |
|---|---|
| 并发写 | 20 进程同写，零丢失，0.5s |
| 规则单测 | 9/9（结构/多点/细节/长度/死引用/相似度） |
| 跨语言锁 | 20 Python + 20 Node 同写，40/40 |
| 写闸 | Hermes / DSH 两侧均真机验证：违规被拒，合法放行 |
| 真实记忆开销 | 1628 字符 / 19 条，约 1.2K token |

## 已知边界

- **Hermes 侧的写不进 `audit.jsonl`**（只过 `check`），审计完整的是 DSH 与 CLI 路径。
- 每次写会起一个 node 进程（约 80ms）。
- 归档策略是"最老优先"，还没有访问频率加权。
- 没有内置加密；脑目录该放私有盘，别提交到公开仓库。

## 路线图

- [ ] 访问日志 + stale 检测（哪些索引长期没被读）
- [ ] 写闸放行时补 audit（补齐 Hermes 审计）
- [ ] npm 发包 `@chips/brain`，`npx chips-brain init`
- [ ] 适配器：Claude Code（`CLAUDE.md` 桥）、Codex

## License

MIT © FSWei
