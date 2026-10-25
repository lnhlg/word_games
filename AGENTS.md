# AGENTS.md

「话本」：本地优先的多角色小说演出器。用大模型演出由导演编排的叙事，可导入酒馆（SillyTavern）的角色卡、世界书与预设。

- 设计规格：`docs/specs/0001-话本-mvp.md`
- 术语表：`GLOSSARY.md`
- 架构决策：`docs/adr/`
- 格式调研：`docs/research/tavern-formats.md`

## Agent skills

### Issue tracker

规格在 `docs/specs/`，实施票在 `.scratch/<effort>/issues/`，一票一文件。详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文：根目录 `GLOSSARY.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。
