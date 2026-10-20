# conversation-distill

把一段对话蒸馏成**一个 Markdown 文件**，换个会话 / 换台机器 / 换个 AI 用 `/Sin` 导入，接着上次继续干。

给 [CodeBuddy](https://www.codebuddy.ai/) 用的技能（Agent Skill），不绑定项目、不依赖任何 npm 包。

```
/Sout        → 导出：采集硬事实 + 蒸馏成文 → ~/.codebuddy/distill/distill-<项目>-<时间>.md
/Sin <文件>  → 导入：校验格式、比对 git 漂移、复述结论后直接开工
/Sin --latest→ 导入收件箱最新一包
```

## 为什么不是一个「导出 transcript」的脚本

CodeBuddy 的助手回复只存在服务端。本机能拿到的只有：

- `codebuddy-sessions.vscdb` 里的会话元数据（ID / cwd / 标题）
- `message-queue/*.json` 里尚未投递成功的用户消息（通常是 0 条）
- `todos/<会话ID>.json`、`plans/<会话ID>/plan.md`

所以本技能是两段式：

| 段 | 谁做 | 内容 |
|---|---|---|
| 硬事实 | `scripts/distill.mjs` | 会话标题、本机缓存的用户原话、待办、计划、git 分支/HEAD/脏文件、项目文档与规则清单、自动脱敏 |
| 蒸馏正文 | **Agent** | 用户真实意图、决策及理由、已完成与证据、下一步、坑与红线 |

结论只有模型能给，事实不该靠模型回忆——分开做，两边都不失真。

## 安装

技能是「一个目录 + 一个 SKILL.md」的形式，放到用户级目录即可全局生效：

```bash
git clone https://github.com/NightRainStarGame/codebuddy-conversation-distill.git \
  ~/.codebuddy/skills/conversation-distill
```

Windows（PowerShell）：

```powershell
git clone https://github.com/NightRainStarGame/codebuddy-conversation-distill.git "$env:USERPROFILE\.codebuddy\skills\conversation-distill"
```

斜杠命令是可选的便捷入口，想要 `/Sout`、`/Sin` 就再拷两个文件：

```powershell
Copy-Item <仓库>\commands\Sout.md "$env:USERPROFILE\.codebuddy\commands\Sout.md"
Copy-Item <仓库>\commands\Sin.md  "$env:USERPROFILE\.codebuddy\commands\Sin.md"
```

不装命令也能用：`/conversation-distill Sout`，或者直接说「导出对话」。

要求：Node ≥ 18（脚本零依赖）；Node ≥ 22.5 才能读会话元数据（旧版本自动降级，用 `--session <id>` 手动指定）。

## 用法

```bash
node "<skill>/scripts/distill.mjs" sout [--session <id>] [--out <dir>]   # 导出骨架
node "<skill>/scripts/distill.mjs" sout --list-sessions                  # 会话选错了？先列出来
node "<skill>/scripts/distill.mjs" finalize "<包路径>"                    # 占位填满后定稿
node "<skill>/scripts/distill.mjs" sin "<包路径>" | sin --latest          # 导入
node "<skill>/scripts/distill.mjs" list                                 # 收件箱
```

`/Sout` 会留 9 个 `_（待蒸馏）_` 占位（现状 / 意图 / 决策 / 已完成 / 下一步 / 红线 / 文件地图 / 脉络 / 风险），由 Agent 逐节写，`finalize` 检查还有没有空洞——没填满就退出码 2，防止「看起来交了其实空着」。

`/Sin` 会先做四项体检再交给人：

1. 格式版本（`cb-distill/v1`）
2. cwd 是否一致（换项目/换机器）
3. git 漂移（导出时 HEAD → 当前 HEAD，领先落后几个 commit）
4. §6 文件地图里的路径现在还在不在 + 占位残留

## 目录

```
SKILL.md                 主流程：9 节质量标准、5 条红线、故障排查
scripts/distill.mjs      sout / sin / list / finalize（唯一代码，零依赖）
references/pack-spec.md  包格式规格：frontmatter 字段、附录 A/B、版本演进、脱敏清单
commands/                /Sout、/Sin 的斜杠命令文件（可选安装）
```

## 能力边界

- **不含助手逐字稿**：写不出服务端才有的东西，§7 是叙事 + 关键原话，不是 transcript。
- **正文质量取决于剩余上下文**：长会话被压缩过，早期细节可能缺失；包内会标「不确定」，接收端不要脑补。
- **脱敏只是模式匹配**：拦得住 `sk-*`、`ghp_*`、私钥块，拦不住人名、内网 IP、学号——发出去前自己看一眼。
- **包是明文**：默认落 `~/.codebuddy/distill/`，不进任何仓库；要归档进 git 请先确认没有密钥。
- **收件箱不会自动清理**：索引截断 200 条，旧 `.md` 自己删。

## 跨 AI

包就是普通 Markdown，没有专有语法。丢给 Claude Code / Codex / Cursor，说「按这个文件接着干」同样有效——格式不依赖 CodeBuddy。
