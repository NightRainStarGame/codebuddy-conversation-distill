# 蒸馏包格式规格 `cb-distill/v1`

一份包 = **单个 UTF-8 Markdown 文件**。没有 zip、没有 sidecar、没有外部依赖，任何能读文本的地方都能用（IDE、微信、Git 仓库、另一个 AI 的上下文）。

## 1. 文件结构

```
---
<frontmatter: 扁平的 key: value>
---
# 对话蒸馏包 · <标题>

> 生成方式 / 接收方式两行说明

## 0. 一句话现状
## 1. 用户真正要什么
## 2. 决策记录
## 3. 已完成（附证据）
## 4. 未完成 / 下一步
## 5. 关键事实、约束与红线
## 6. 文件地图
## 7. 对话脉络与关键原话
## 8. 待澄清 / 风险
## 附录 A · 环境快照（自动，JSON 代码块）
## 附录 B · 本机采集的用户原话（自动，blockquote）
```

章节编号**必须保持 0–8 的连续编号**：`sin` 用正则 `## <n>.` 定位章节，`finalize` 靠占位串统计完整度。

## 2. Frontmatter

扁平 YAML（只有 `key: value`，不嵌套——解析器是 30 行的正则，不认缩进）。

| 字段 | 写入方 | 说明 |
|---|---|---|
| `pack` | 脚本 | 恒为 `cb-distill/v1`，导入端的第一道校验 |
| `id` | 脚本 | `<YYYYMMDD-HHMMSS>-<4hex>`，`index.json` 的主键 |
| `title` | 脚本 | 会话标题（通常=用户第一条消息），单行 |
| `project` | 脚本 | cwd 目录名 |
| `cwd` | 脚本 | 导出时工作目录（正斜杠、保留大小写） |
| `created_at` | 脚本 | 本地时区 ISO8601，带偏移 |
| `source_session` | 脚本 | 源会话 conversationId（回溯用，换机后无意义） |
| `git_branch` / `git_head` / `git_dirty` | 脚本 | 导出时基线；`sin` 据此算漂移 |
| `user_turns` | 脚本 | 附录 B 采集条数（0 = 未落盘，正常） |
| `status` | 脚本 | `draft`（有占位）/ `final` |
| `chars` / `body_sha256_16` / `finalized_at` | `finalize` | 正文规模与指纹，用于「这份包有没有被改过」 |
| `skill_version` | 脚本 | 产出包的技能版本，便于向后兼容 |

## 3. 占位约定

未填的章节正文固定为 `_（待蒸馏）_`（含中文全角括号），且**必须独占一行**。这是唯一的「洞」标记：

- 判定规则是「整行只有这个串」——正文里引用这个串（例如解释机制）不会误判。
- `finalize`：统计剩余行数 → 0 才写 `status: final`，否则退出码 2。
- `sin`：剩余 > 0 时明确警告「这部分信息缺失」。

改写成「略」「无」「TODO」都会让校验失效——不如老实留着。

## 4. 附录 A · 环境快照

一个 ```json 代码块，字段：

```jsonc
{
  "format": "cb-distill/v1",
  "collected_at": "…",
  "cb_root": "…",              // CodeBuddy 用户数据根，换机后可弃
  "session": { "conversationId": "…", "title": "…", "cwd": "…" },
  "git": { "branch": "…", "head": "…", "dirty": ["M path", …], "recent_commits": ["…"], "diffstat": "…" },
  "todos": { "open": [{ "id", "content", "status" }], "done": [...] },
  "plan_excerpt": "…",         // 会话 plan.md 前 3KB，可能为空
  "docs": ["AGENTS.md", …],    // 项目根的文档清单
  "rules": [".codebuddy/rules/…"],
  "memory_index": ["- [标题](file.md) — …"],  // 只放索引行，不放正文
  "redactions": 3              // 自动脱敏命中次数
}
```

**刻意不含**：模型内部思考、完整工具调用日志、文件全文。这些体积大、时效性强，接收端读仓库更快。

## 5. 附录 B · 用户原话

从本机 `message-queue` 抓到的真实用户消息，每条一个 `#### 第 N 轮` + blockquote。

- 最多 60KB，单条截断 4000 字符（末尾标「已截断」）。
- 空是正常的：当前会话的消息通常在**发送成功后被移除**，只有中断/重试的消息会残留。所以 §7 必须由 Agent 手写，附录 B 只是加分项。
- blockquote 前缀保证消息里的 `##`、``` 不会破坏文档结构。

## 6. 版本演进

- 小改（加字段、加章节 → 加在 §8 之后）：`skill_version` 递增，`v1` 不变；旧包仍可导入。
- 破坏性改（改标题编号、改占位串）：`pack` 升到 `cb-distill/v2`，`sin` 对 `v1` 保持只读兼容。
- 解析器一律「未知字段忽略、未知章节忽略、缺字段降级显示」，不允许因为缺字段直接报错崩溃。

## 7. 安全

- 导出时脚本按模式脱敏：`ssio_live_*`、`ghp_*`、`github_pat_*`、`sk-*`、`AKIA*`、`xox?-*`、私钥块、`password/secret/token/api_key = …`。
- 脚本拦不住人名、内网 IP、学号、聊天记录里的隐私。**这些由 Agent 在写正文时负责**。
- 包是明文。默认目录 `~/.codebuddy/distill/` 不进任何仓库；若要归档进 git，先确认没有密钥。
