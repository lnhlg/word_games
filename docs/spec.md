# 话本 · 设计规格（MVP）

## 1. 定位

把酒馆（SillyTavern）的角色卡、世界书、预设导入，让大模型在**导演**的编排下演出一部多角色的小说。

## 2. 玩家是谁

玩家是导演：**不在场、不下场**。没有"玩家角色"这个概念。导演通过两件事干预：

1. 写出导演指令（自然语言，想多具体就多具体）
2. 从模型给出的三条岔路里选一条

由此带来一条硬约束：角色卡里的 `{{user}}` 在导入时映射为一个可配置的视角名（默认"旅人"），绝不静默保留——否则正文会冒出"你推开门"，而故事里根本没有"你"。

## 3. 核心循环

```
新建对局（演员表 2–5 张卡 + 可选世界书 + 预设）
        ↓
    点「开演」→ 模型演出第一拍（400–900 字）
        ↓
  读完 → 正文下方浮出三条岔路
        ↓
  选一条 ── 或 ── 自己写导演指令
        ↓
      演出下一拍
        ↓
  不满意 → 退回这个分叉点，换一条岔路重演（原枝保留在树上）
```

**这个循环就是产品本身。** 其余功能都是为它服务的。

## 4. 数据模型（SQLite，`node:sqlite` 内置）

```sql
-- 素材：导入后只读，保留原始 JSON 以便重解析
cards(id, name, spec_version, data_json, avatar_blob, imported_at, fidelity_json)
lorebooks(id, name, raw_json, imported_at, fidelity_json)
presets(id, name, params_json, imported_at)

-- 对局
playthroughs(id, title, preset_id, lorebook_id, current_leaf_id, created_at, updated_at)

-- 演员表：一局里每个角色一张卡
cast_members(id, playthrough_id, card_id, role_label, private_notes_json, active)
-- private_notes_json = {secrets: [...], goals: [...]}，为将来"分角色调用"留的缝

-- 消息树（这是模型的核心）
messages(id, playthrough_id, parent_id, kind, content, state_json, forks_json, meta_json, created_at)
-- kind: 'narration' | 'director'
-- state_json: 该拍结束后的状态快照（小，直接存全量）
-- forks_json: 该拍附带的三条岔路
-- meta_json: 选了哪条岔路、token 用量、解析告警

-- 记忆
memories(id, playthrough_id, from_message_id, to_message_id, summary, created_at)

settings(key, value)  -- api base、key、model、字数区间、岔路开关
```

**消息树要点**：`current_leaf_id` 指向当前阅读位置。从任意历史节点生成新内容 = 建一个 `parent_id` 指向它的新消息，并移动 `current_leaf_id`。旧的枝不删。

## 5. 上下文装配（核心算法）

装配器是一个**预设解释器**，不是固定模板。

1. 读 `prompt_order`，按顺序遍历每个 `{identifier, enabled}`，`enabled=false` 跳过
2. 内置 identifier 展开为对应内容
3. 自定义 prompt 项注入其 `content`（先过宏替换）
4. `marker` 类项是占位符，决定内容落点（典型是 `chatHistory`）
5. 排布走完之后，**固定追加「导演模式补丁」**——不可关闭

| identifier | 导演模式下的展开 |
|---|---|
| `main` | 预设主系统提示（宏替换后原样） |
| `worldInfoBefore` | 世界书中位置为「角色前」的条目 |
| `worldInfoAfter` | 世界书中位置为「角色后」的条目 |
| `charDescription` / `charPersonality` / `scenario` | **按演员表逐个展开**，每个在场角色一段 |
| `personaDescription` | 清空（导演不在场） |
| `dialogueExamples` | 在场角色的示例对话 |
| `chatHistory` | 最近 N 拍正文，导演指令带 `导演：` 前缀 |
| `jailbreak` / `nsfw` / `enhanceDefinitions` / 自定义项 | 原样注入 |

**导演模式补丁**（不可关）：模型演出全部角色与旁白、不写"你"、不替导演做决定、禁止轮流发言式流水账、每拍 400–900 字、遵守三段输出协议。理由见 [ADR 0003](adr/0003-预设排布生效.md)——酒馆预设全部假设"单人 RP"，不覆盖这层假设就只会产出单人对话。

**预算**：整体按字符估算（中文 1 字 ≈ 0.7 token）。超出时按「示例对话 → 非在场角色摘要 → 记忆 → 最老的正文」顺序裁切；世界书激活条目在装配前就按预算截好。

**装配预览**：界面必须能显示最终发出的完整 prompt。排布可调而不可见，等于让人瞎调。

## 6. 世界书激活

**扫描范围**：最近 4 拍正文 + 本轮导演指令。

**规则**：

1. `constant` 条目永远注入
2. 主关键词 `key` 任一命中即候选
3. 若 `selective` 为真，用 `keysecondary` 与 `selectiveLogic` 二次筛（枚举语义以 [调研文档](research/tavern-formats.md) 为准，实现时不得凭记忆写枚举值）
4. 按 `position` 决定注入位置：角色定义前 / 后 / 指定深度
5. 按预算截断，超出时按 `order` 从低到高丢弃

**明确不做**（读取但不生效，写进保真度报告）：递归扫描、`probability`、分组评分、定时效果。

## 7. 输出协议

模型一次输出三段，用固定标记切分：

```
【正文】
……（小说正文，400–900 字）

【状态】
{ "scene": {"location": "...", "time": "..."},
  "present": ["张三", "李四"],
  "relations": [{"a":"张三","b":"李四","note":"互相试探"}],
  "notes": ["李四偷了账本，张三不知情"] }

【岔路】
1. 如果张三当众追问账本的来路 → 会把场面推向公开对峙
2. 如果李四抢先告发张三 → 会让叙事转向"诬告"的攻防
3. 如果窗外有人影一闪 → 会把故事从密室推向追查
```

**解析必须宽容**：任一段缺失或 JSON 解析失败，只降级该段（状态丢失标记为"状态未记录"，岔路丢失则隐藏岔路区），**正文永远照常显示**。静默失败是这套架构最危险的 bug，界面上必须看得见。

## 8. 导入与保真度

**支持**：PNG 内嵌卡（`ccv3` 优先于 `chara`）、JSON 卡（V2/V3）、独立世界书 JSON、卡内 `character_book`、预设 JSON。

**保真度报告**（每次导入生成，存在 `fidelity_json`，界面可见）：

```json
{
  "read": ["name", "description", "first_mes", "mes_example", "alternate_greetings"],
  "mapped": {"character_book": "拆为独立世界书"},
  "ignored": ["system_prompt", "post_history_instructions", "extensions.*"],
  "degraded": [{"field": "position", "reason": "8 值枚举塌缩为 角色前/后"}],
  "warnings": ["该卡依赖 {{random}}，每次开场不同"]
}
```

## 9. 模块与目录

```
src/
├── shared/
│   ├── types.ts          # 前后端共用类型
│   └── macros.ts         # 宏替换（纯函数）
├── tavern/               # 酒馆格式解析（无 IO 依赖，可单测）
│   ├── png.ts            # PNG chunk 读取
│   ├── card.ts           # V2 / V3 / 字段归一
│   ├── lorebook.ts       # 世界书（两套命名互转）
│   ├── preset.ts         # 预设
│   └── fidelity.ts       # 保真度报告
├── engine/               # 服务端核心
│   ├── assembly.ts       # 上下文装配
│   ├── activation.ts     # 世界书激活
│   ├── llm.ts            # OpenAI 兼容 + SSE 流式
│   ├── parse.ts          # 三段协议解析
│   └── compact.ts        # 记忆压缩（MVP 末尾）
├── server/
│   ├── index.ts          # Hono + 静态托管
│   ├── db.ts
│   ├── schema.sql
│   └── routes.ts
└── web/
    ├── App.tsx
    ├── components/
    └── styles.css
```

## 10. 界面

三区，单页：

- **中：演出版**。正文流（小说排版，非气泡）+ 每拍末尾浮出的岔路区（弱化、可折叠）+ 底部导演输入框
- **右：状态面板**。场景、在场者、关系；默认只看表面，点开某个角色才显示其秘密
- **左（可折叠）：消息树**。可回退到任意节点重演

## 11. MVP 边界

**做**：上述全部。核心是预设排布解释器、世界书激活、素材编辑器（含从零新建）、消息树与重演、岔路、导入保真度报告、装配预览。

**不做**（并且不为其预留复杂度）：世界书递归扫描、概率与分组、regex、STscript、多用户与账号、桌面壳、骰子与检定、向量记忆、导出回酒馆格式。

## 12. 已知风险

1. **一次输出负担重**：正文 + 状态 + 三条岔路，小模型或廉价中转可能只完成前一半。对策是宽容解析 + 界面可见的降级提示。
2. **多角色趋同**：单次调用演五个人，容易写成同一个人在换名字。对策是禁止流水账的硬约束 + 完整人设卡 + 每个角色独立的秘密与动机。
3. **上下文膨胀**：多卡 + 世界书 + 长篇正文很快吃满窗口。对策是不在场角色只注入摘要、滚动摘要、预算分段。
4. **枚举映射有损**：卡内世界书与独立世界书是两套命名，`position` 的 8 值会塌缩。必须显示在保真度报告里，而不是静默改写。
