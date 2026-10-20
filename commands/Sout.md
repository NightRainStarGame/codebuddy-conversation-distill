---
description: 导出当前对话为可迁移的蒸馏包（对话蒸馏 / 交接）
argument-hint: "[--session <id>] [--out <目录>]"
---

使用 `conversation-distill` 技能执行 **Sout（导出）**，参数：`$ARGUMENTS`

严格按该技能 SKILL.md 的「/Sout 导出流程」四步走，不要简化：

1. 运行 `node "<skill_dir>/scripts/distill.mjs" sout $ARGUMENTS`（`<skill_dir>` 为该技能目录的绝对路径）。
2. 用 read_file 读完产物，重点看附录 A 的 git 状态、待办、规则清单。
3. 用 replace_in_file 逐节替换 9 处 `_（待蒸馏）_`，按 SKILL.md 的质量标准写 §0–§8；附录 B 为空属正常，§7 必须手写。
4. 运行 `finalize <包路径>`，确认占位清零、status 变 final。

最后只回四行：包路径、字数、哪些节是空的（若有）、一句「可直接发给别人或换机 /Sin」。
