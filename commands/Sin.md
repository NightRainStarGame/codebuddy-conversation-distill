---
description: 导入对话蒸馏包，接管之前会话的上下文继续干
argument-hint: "<包路径> | --latest"
---

使用 `conversation-distill` 技能执行 **Sin（导入）**，参数：`$ARGUMENTS`（为空则按 `--latest`）

严格按该技能 SKILL.md 的「/Sin 导入流程」三步走：

1. 运行 `node "<skill_dir>/scripts/distill.mjs" sin $ARGUMENTS`，读简报（包龄、cwd 是否一致、git 漂移、缺失路径、未填章节、§4 的下一步）。
2. 用 read_file 把整包读完，§0–§4 逐字读。
3. 接管：先 ≤8 行复述「现在什么状态 / 上一轮结论 / 下一步第一件事」，然后按 §4 直接开工；git 漂移先对账，§8 有风险先确认，包是 draft 就说明哪几节是空的。

不要问「需要我做什么」——包里写着。
