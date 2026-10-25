# 话本

本地优先的多角色小说演出器。导入酒馆（SillyTavern）的角色卡、世界书与预设，由大模型在你以**导演**身份编排下演出一部小说——你不下场，只决定让什么发生。

## 跑起来

```bash
pnpm install
pnpm dev
```

然后打开 **http://127.0.0.1:5173**。

> 用 `127.0.0.1`，不要用 `localhost`。Vite 在 Windows 上默认绑 `::1`，本项目已显式绑 IPv4；用 `localhost` 若解析到 IPv6 会连不上。

数据落在 `data/huaben.db`（SQLite，首次启动自动创建，已在 `.gitignore` 中排除）。

## 当前进度

| 票 | 状态 |
|---|---|
| 01 服务起步与素材库骨架 | ✅ |
| 12 按需求起草角色卡（含模型设置） | ✅ |
| 13 模型列表与多选 | ✅ |
| 02 导入角色卡与保真度报告 | ✅ |
| 14 角色卡详情与编辑 | ✅ |
| 03 世界书：新建、编辑与激活测试 | ✅ |
| 04 预设：新建、导入与排布编辑 | ✅ |
| 05 装配预览 | ✅ |
| 06 演出一拍 | ✅ |
| 07 状态：记录、展示与降级 | ✅ |
| 08 岔路：三个方向与选用 | ✅ |
| 20 正文与岔路分别重新生成 | ✅ |
| 09 消息树：回退与重演 | ✅ |
| 10 记忆压缩 | ✅ |
| 11 对局导出与导入 | ✅ |
| 21 对局级别的提示词与规则 | ✅ |

全部 20 张票已完成。
| 15 起草与导入同构 | ✅ |
| 16 头像设置 | ✅ |
| 17 头像编辑器（局部裁剪） | ✅ |
| 18 描述改用分节结构 | ✅ |
| 19 用 AI 对话修改角色卡 | ✅ |
| 02 导入角色卡与保真度报告 | 待做 |
| 03 世界书：新建、编辑与激活测试 | 待做 |
| 04 预设：新建、导入与排布编辑 | 待做 |
| 05–11 | 见 `.scratch/huaben-mvp/issues/` |

## 文档

- [设计规格](docs/specs/0001-话本-mvp.md)
- [术语表](GLOSSARY.md)
- [架构决策](docs/adr/)
- [酒馆格式调研](docs/research/tavern-formats.md)
- [实施票](.scratch/huaben-mvp/issues/)
- [示例素材](docs/fixtures/)：
  - `real-huangrong.png`——真实酒馆卡（851 KB），回归测试用的兜底样本
  - `card-v2.png` / `card-v3.png` / `card-v2.json`——按规范手造的对手样本
  - `lorebook-standalone.json`——独立世界书
  - `preset-sample.json`——酒馆预设（含两套 `prompt_order`）
  - `playthrough-sample.json`——一整局的导出文件，可用于试导入

## 技术栈

单进程本地 Node 服务（Hono）+ SQLite（`node:sqlite` 内置模块）+ React + Vite。无账号、无云端、无桌面壳。见 [ADR 0002](docs/adr/0002-单进程本地服务.md)。

**需要 Node 24+**：服务端直接用 `node --watch` 跑 `.ts`，依赖 Node 原生的 TypeScript 类型擦除（Node 23.6 起默认开启）。不引入 `tsx` 之类的转译层——这也是为什么源码里的相对导入都带 `.ts` / `.tsx` 扩展名：Node 的 ESM 解析器不接受省略扩展名的相对路径。

## 已知限制

1. 世界书不做递归扫描、激活概率、分组评分与定时效果（读取但不生效，导入时会说明）
2. 预设排布里自定义的 in-chat 注入不生效（只支持内置槽位与普通 prompt 项）
3. 真实卡只逐张验证过一张（黄蓉），其余四张来自同一作者同一模板
4. 上下文超过 80% 会自动压缩一次；如果压缩失败会照常演出，只给提示

## 几个容易踩的环境坑

- **必须用 `127.0.0.1`，不要用 `localhost`**：Vite 在 Windows 上默认绑 `::1`，用 `localhost` 解析到 IPv6 会连不上。本项目已显式绑 IPv4。
- **相对导入必须带扩展名**：`tsx` 能容忍省略，`node --watch` 不能。这就是去掉 `tsx` 的原因。
- **Vite 的文件监听必须避开临时文件**：agent 或编辑器写文件时会生成 `<name>.PID.UUID.tmpdir/*.tmp`，chokidar 在 Windows 上 watch 到它就会 `EBUSY` 崩溃，并把整个 dev server 一起拖死。`vite.config.ts` 已排除 `.scratch`、`docs`、`data`、`*.tmpdir`、`*.tmp`。将来新增会频繁写入的目录，记得加进 `server.watch.ignored`。
