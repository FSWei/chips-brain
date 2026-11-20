# DSH 适配器（DeepSeek Harness）

`index.js` 是一个 `MemoryProvider`：`read / applyBatch / snapshot / renderContext` 全部委托 `brain.js`，
不自己存任何状态。配合社区外壳 `@lmzhen/dsh-evolution-all` 使用（仅作 UI/工具壳，记忆后端仍是这里）。

## 安装

```bash
# 1. 把整个适配器目录 link 进 DSH profile
dsh plugin --profile desktop add link:/path/to/chips-brain/adapters/dsh
dsh plugin --profile headless add link:/path/to/chips-brain/adapters/dsh
```

2. 在两个 profile 的 `cordis.patch.yml` 里钉住 provider：

```yaml
- id: memory
  config:
    provider: chips-brain
- insert:
    - id: chips-memory
      name: '@chips/dsh-memory-provider'
```

3. 环境变量（可选）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `BRAIN_ROOT` | `D:\\agent-brain` | 脑目录 |
| `BRAIN_AGENT` | `dsh` | 审计里的来源标记 |

## 为什么是 provider 而不是插件

DSH 的 `memory` 工具最终调 `provider.applyBatch`，是**唯一**写入口，所以在这里拦就够了，
不需要像 Hermes 那样包 Store。

## 技能可见性

DSH 的技能发现只扫一层（`<root>/<name>/SKILL.md`）。脑里的 skills 按分类嵌套时，
用 `scripts/mkflat.ps1` 生成一层 junction 目录，再把 `skill-filesystem.customSkillDirs` 指过去。
