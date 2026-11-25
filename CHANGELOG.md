# Changelog

## 0.2.0 — 2026-11-25

写入闸从「形状过滤」收紧成「三种合法形状 + 可解析指针」，并补齐批量化、体检与配套脚本。

- `policy.js`
  - 三种合法形状：短自包含事实（≤ `short_fact_max`）、指针行、画像（仅 USER.md）
  - 指针校验：`见 skill X` / `→ file` 必须落在 `pointer.roots` 下且文件真实存在，否则 `dead_pointer`
  - 超过 `short_fact_max` 且无指针 → `unindexed_detail`；一条最多一个指针
  - 硬规则：凭据 / IPv4 / 端口**无条件拦**，索引行也不放行（短行里的密码同样会随记忆注入模型）
  - `project_pileup`：同一全大写项目代号在同一文件已有 ≥5 条时，新条目被拒
- `brain.js`
  - `applyOps`：原子批量，同一把锁内全部校验通过才落盘，任一条失败整批不改
  - `doctor`：只读体检（预算余量、逐条形状、技能体积软/硬线）
  - 归档改为「头进先出」裁到预算内，`replace` / `applyOps` 复用同一路径
- `rules.yaml` v2：新增 `shapes` / `pointer` / `records` / `limits` 段
- 适配器
  - DSH：`applyBatch` 改走 `brain.applyOps`（旧实现逐条应用，`remove` 后 `add` 被拒会静默丢条目）
  - Hermes：写闸落在 `MemoryStore` 层（`add` + `apply_batch`），放行后补审计
- 配套脚本：`skill-log.js`（非 DSH 宿主的技能写入补记账）、`skill-split.js`（H2 拆进 references，带保真检查与 dry-run）、`churn-report.py`（技能改动体检）
- 全部脚本的脑根路径改为 `BRAIN_ROOT` / `~` 推导，不再硬编码安装路径

## 0.1.0 — 2026-11-20

首个可用版本，从私用系统抽出。

- `brain.js`：status / check / append / replace / remove / list / search / pending / resolve
- `policy.js`：索引级、结构化、多点、项目细节、长度双层、主题+相似度查重、死引用
- 目录锁（跨语言）、原子写、超限归档、审计日志
- 适配器：Hermes（Store 写闸）、DSH（MemoryProvider 写闸）
- 文档：架构、写闸踩坑记录
