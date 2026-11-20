# 架构

## 四层

| 层 | 位置 | 谁读 | 说明 |
|---|---|---|---|
| 身份 | `SOUL.md` | 全部宿主 | 只读，人改 |
| 画像 | `memories/USER.md` | 全部宿主 | 用户是谁，≤200 字/条 |
| 索引 | `memories/MEMORY.md` | 全部宿主 | 环境/项目/决策，一行一条，≤150 字 |
| 详情 | `skills/<name>/SKILL.md` | 按需加载 | 流程、坑、命令、代码 |

记忆只放"指针"，正文进 skill。原因：索引全量注入约 1.2K token，比检索便宜；技能库几百 MB，必须按需。

## 写入协议

```
brain.js append
  ├─ mkdir .brain/lock          # 目录锁，跨语言（Node/Python 都能用）
  ├─ 读 rules.yaml（唯一契约）
  ├─ policy.checkPolicy()        # 索引级 / 结构 / 多点 / 项目细节 / 长度
  ├─ policy.findDuplicate()      # 精确 + 主题 + bigram 相似度
  ├─ FORBID 正则                 # 密钥/令牌扫描
  ├─ 超限 → archiveOldest()      # 移最老条目到 memories/archive/
  └─ atomicWrite + audit.jsonl   # 临时文件 + rename，再追加审计
```

锁：`mkdir` 原子，`stale_seconds` 到期自动接管，5s 拿不到就报错（不无限等）。

## 审计格式

```json
{"ts":"2026-11-20T08:44:19.548Z","agent":"dsh","action":"append","file":"MEMORY.md","chars":54,"total":1686,"archived":0}
```

`agent` 区分 `hermes` / `dsh` / `cli`；`action` 有 `append` `replace` `remove` `archive` `resolve_force` `resolve_drop`。

## 为什么不用数据库

- 记忆量小（几千字），文件够了；
- 用户要能 `cat`、能 `git diff`、能自己手改；
- 数据库会引入"谁是真身"的问题，文件不会。

## 失败模式

| 场景 | 行为 |
|---|---|
| 锁残留 | `stale_seconds` 后接管 |
| 脑目录不存在 | 报错退出，不静默创建（避免写错地方） |
| 规则文件损坏 | 启动即报错，不猜默认值 |
| 违规写入 | 拒绝 + 给三个可选动作 + 落 pending |
| 预算已满 | 归档最老一条再写；单条就超限才拒 |
