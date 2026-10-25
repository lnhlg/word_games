# Issue tracker: Local Markdown

本仓库的问题与规格以 markdown 文件形式存放，不依赖远端仓库或 CLI。

## 约定

- **规格**：`docs/specs/<NNNN>-<slug>.md`。规格是长期资产，跟代码一起版本化，不放进临时目录。
- **实施票**：`.scratch/<effort>/issues/<NN>-<slug>.md`，从 `01` 开始编号，**一票一文件**，绝不写成合并清单。
- **状态**：每张票顶部有一行 `Status:`，取值 `todo` / `in-progress` / `done`。本仓库未安装 triage 技能，因此不套用 `needs-triage` 之类的词表。
- **讨论**：追加在文件末尾的 `## Comments` 标题下，按时间顺序。

## 当技能要求「发布到 issue tracker」

- 发布规格：在 `docs/specs/` 下新建文件。
- 发布实施票：在 `.scratch/<effort>/issues/` 下新建文件。

## 当技能要求「取相关票」

读对应路径的文件。用户通常会直接给出路径或编号。

## Wayfinding 操作

由 `/wayfinder` 使用。**地图**是一份文件，每张子票一个文件。

- **地图**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 正文）。
- **子票**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始，正文写问题。`Type:` 行记录类型（`research` / `prototype` / `grilling` / `task`）；`Status:` 行记录 `claimed` / `resolved`。
- **阻塞**：顶部 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 时该票解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/`，取未关闭、未阻塞、未认领的票，编号最小的优先。
- **认领**：动工前先把 `Status:` 改成 `claimed` 并保存。
- **解决**：在 `## Answer` 标题下追加答案，`Status:` 改为 `resolved`，然后把上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far。

## 迁移

若将来改用 GitHub Issues：`git init`、配置 remote、确认 `gh` 已认证，然后按 `issue-tracker-github.md` 的约定替换本文件。现有 `docs/specs/` 与 `.scratch/` 内容可一次性搬过去。
