# 酒馆（SillyTavern）生态数据格式调研

> 调研对象：SillyTavern（中文社区俗称「酒馆」）生态中真实流通的数据格式。
> 抓取时间：2026-10-24。代码与规范取自 `SillyTavern/SillyTavern` 仓库 `release` 分支、`malfoyslastname/character-card-spec-v2` 与 `kwaroran/character-card-spec-v3` 仓库主分支、docs.SillyTavern.app 官方文档、W3C PNG 规范。
>
> **阅读约定**
> - 「**事实**」= 有实际抓取来源支撑，来源见文末。
> - 「**判断**」= 本文档作者的工程推断，不是规范事实，落地前请自行验证。
> - 「**未验证**」= 该点常见于社区讨论，但本次没有抓到一手依据，本文不把它当结论。
> - 字段名一律保留原文大小写与拼写（例如 `key` 不是 `keys`，`disable` 不是 `disabled`）。这一点在酒馆生态里极其重要：**角色卡内嵌世界书**和 **SillyTavern 独立世界书文件**是两套不同的 JSON 字段命名。

---

## 0. 速览

| # | 格式 | 顶层结构（一句话） | 典型载体 |
|---|------|------------------|----------|
| 1 | Character Card V2 | `{spec:"chara_card_v2", spec_version:"2.0", data:{...}}`，`data` 下是 V1 六字段 + V2 新增字段 | PNG `tEXt` chunk（关键字 `chara`）、`.json` |
| 2 | Character Card V3 | `{spec:"chara_card_v3", spec_version:"3.0", data:{...}}`，`data` 是 V2 的超集，新增 `assets`/`nickname`/`source` 等 | PNG/APNG `tEXt` chunk（关键字 `ccv3`）、`.json`、`.charx`（zip） |
| 3 | PNG 内嵌 | PNG 签名 + 若干 chunk；角色卡放在 `tEXt` chunk，内容为 `base64(UTF-8 JSON)` | `.png` / `.apng` |
| 4 | World Info（世界书） | `{entries: {"<uid>": {...}, "<uid>": {...}}}`——**`entries` 是对象（map），不是数组** | 独立的 `<名字>.json`，也可内嵌进角色卡 |
| 5 | Chat Completion 预设 | 扁平采样参数字段 + `prompts: [...]` + `prompt_order: [{character_id, order:[{identifier,enabled}]}]` | `OpenAI Settings/*.json` |
| 6 | 宏 / Regex / STscript | 不是数据格式，是**文本内嵌语法 + 运行时行为** | 存在于上述所有字符串字段里 |

一句话结论：**这六样里，只有 1–5 是「格式」，第 6 项是「跑在格式之上的解释器」**。读文件容易，把第 6 项跑对很难。

---

## 1. Character Card V2

### 1.1 语义

V2 是 2023 年 5 月在既有「V1 六字段卡」之上做的**向后兼容式扩写**：把 V1 的 `name`/`description`/… 原样塞进 `data`，再在 `data` 里加创作者元数据、系统提示覆盖、备选开场白、内嵌世界书。文件本身仍是同一张 PNG，只是 JSON 变胖了。

规范原文要点（V2 spec）：

- V1 类型定义是六个字符串：`name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`；
- V2 把这六个搬进 `data`，语义不变；
- 「可选属性允许编辑器不支持、前端可忽略，**但绝不能在已有数据里销毁**」；
- `extensions` 强制存在且默认 `{}`，未知键必须原样保留。

### 1.2 顶层与字段表

```ts
type TavernCardV2 = {
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: { ... }
}
```

| 字段 | 类型 | 规范必填 | 含义与典型用法 |
|------|------|----------|----------------|
| `spec` | string | **必填**，值必须为 `"chara_card_v2"` | 格式判别位。前端靠它决定走 V2 解析 |
| `spec_version` | string | **必填**，值必须为 `"2.0"` | 规范版本（2023-05-08 追加） |
| `data.name` | string | 类型必填（V1 字段） | 角色名。ST 实际放宽：**只有名字是真正必填**，其余可空 |
| `data.description` | string | 类型必填（V1） | 角色描述，恒定进入 prompt，是最重要的一段 |
| `data.personality` | string | 类型必填（V1） | 性格摘要，独立于 description 的一个槽位 |
| `data.scenario` | string | 类型必填（V1） | 场景/处境描述 |
| `data.first_mes` | string | 类型必填（V1） | 开场白，只在新对话开头发送一次 |
| `data.mes_example` | string | 类型必填（V1） | 对话示例，块之间用 `<START>` 分隔；上下文不足时会被逐块挤出 |
| `data.creator_notes` | string | 类型必填（可空串） | 作者说明。**规范明令不得进入 prompt**，只给用户看 |
| `data.system_prompt` | string | 类型必填（可空串） | 覆盖「主提示/系统提示」。空串时必须回落到用户设置；必须支持 `{{original}}` 占位符 |
| `data.post_history_instructions` | string | 类型必填（可空串） | 覆盖「越狱/ujb/PHI」，语义同上，也支持 `{{original}}` |
| `data.alternate_greetings` | string[] | 类型必填（可空数组） | 备选开场白。规范要求前端把它做成首条消息的额外「swipe」 |
| `data.character_book` | object | **可选** | 角色专属世界书（structure 见 5.6）。规范要求「默认使用角色世界书」，且「可与用户全局世界书叠加；角色书应优先」 |
| `data.tags` | string[] | 类型必填（可空数组） | 标签。不得用于 prompt，只用于排序/筛选（应大小写不敏感） |
| `data.creator` | string | 类型必填（可空串） | 作者名。不得用于 prompt |
| `data.character_version` | string | 类型必填（可空串） | 版本号。不得用于 prompt，可用于展示/排序 |
| `data.extensions` | object | **必填，默认 `{}`** | 任意扩展数据。未知键必须保留；建议用命名空间前缀避免冲突 |

> **必填性的两层含义**：上面「类型必填」来自 V2 spec 的 TypeScript 定义（除 `character_book` 外都没有 `?`）；但 spec 同时允许前端忽略不支持的属性，SillyTavern 官方文档也明确「Character Name is the only required field」。所以**解析器应当容错**，写出时按规范补齐空值。

### 1.3 最小可运行 JSON

```json
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": {
    "name": "Seraphina",
    "description": "Guardian of the Eldoria forest. Amber eyes, gown of woven light.",
    "personality": "Kind, watchful, speaks in soft measured sentences.",
    "scenario": "The user wakes wounded in her glade.",
    "first_mes": "*She leans over you.* \"Ah, you're awake at last.\"",
    "mes_example": "<START>\n{{user}}: Who are you?\n{{char}}: *She smiles.* \"A guardian.\"",
    "creator_notes": "Sample card.",
    "system_prompt": "",
    "post_history_instructions": "",
    "alternate_greetings": ["*Rain hammers the leaves.* \"You picked a bad night to wander.\""],
    "tags": ["fantasy", "guardian"],
    "creator": "example",
    "character_version": "1.0",
    "extensions": {}
  }
}
```

### 1.4 容易踩的语义点

- `system_prompt` / `post_history_instructions` 的行为在 spec 里是 **MUST 替换全局设置**，但 ST 实际是**用户开关控制**（`Prefer Char. Prompt` / `Prefer Char. Instructions`，见官方 Character Design 文档）。即「规范说必须覆盖，实现给了开关」。
- `{{original}}` 是这两个字段专属的占位符，指「原本会用但没有用的那条全局提示」。
- `alternate_greetings` 在群聊里被 ST 用于随机挑一个开场白（官方 Character Design 文档）。
- `extensions` 里 ST 会塞自己的私有键，例如 `extensions.world`（绑定的世界书名）、`extensions.talkativeness`、`extensions.fav`、`extensions.depth_prompt.{prompt,depth,role}`（源码 `characters.js` 的 `charaFormatData` 可证）。

---

## 2. Character Card V3

### 2.1 与 V2 的关系

**V3 是 V2 的超集**（spec 原话：`CharacterCard object in Character Card V3 is a superset of TavernCardV2 object ... except the fields that are changed or removed`）。

- `spec` 必须是 `"chara_card_v3"`；`spec_version` 必须是 `"3.0"`。
- 但规范**要求**：即使 `spec_version` 不是 `"3.0"` 也不能拒绝导入；判断新旧的方式是**把字符串当浮点数比较**（>3.0 视为更新版本，<3.0 视为更旧）。
- 遇到不认识的字段：**忽略但保留**（以便安全再导出），而不是报错；应用自己的私有数据必须放进 `extensions`，不许往顶层加字段。

### 2.2 V2 → V3 字段变化

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `data.creator_notes` | string | 是 | **语义变化**：若有 `creator_notes_multilingual`，它只在多语言表里没有 `en` 时才作为英文注释；否则忽略 |
| `data.character_book` | Lorebook | 否 | 类型从 V2 的 `CharacterBook` 换成 V3 的 `Lorebook`（entries 仍是**数组**，但字段变多，见 5.6） |
| `data.assets` | `{type,uri,name,ext}[]` | 否 | 新增。缺省视为 `[{type:"icon", uri:"ccdefault:", name:"main", ext:"png"}]`。`uri` 支持 `embeded://…`、`ccdefault:`、http(s)、base64 data URL |
| `data.nickname` | string | 否 | 新增。若存在，`{{char}}`/`<char>`/`<bot>` 替换成昵称而非 `name` |
| `data.creator_notes_multilingual` | `Record<string,string>` | 否 | 新增。键是 ISO 639-1 语言码（不带地区） |
| `data.source` | string[] | 否 | 新增。来源 ID 或 http(s) URL，只追加不修改 |
| `data.group_only_greetings` | string[] | **是**（可为空数组） | 新增。仅群聊使用的额外开场白 |
| `data.creation_date` | number | 否 | 新增。Unix 秒，UTC，不允许用户编辑 |
| `data.modification_date` | number | 否 | 新增。Unix 秒，导出时应写入/更新 |

V1/V2 的其余字段（`name`/`description`/`personality`/`scenario`/`first_mes`/`mes_example`/`tags`/`creator`/`character_version`/`system_prompt`/`post_history_instructions`/`alternate_greetings`/`extensions`）在 V3 中原样保留。

### 2.3 V3 的最小 JSON

```json
{
  "spec": "chara_card_v3",
  "spec_version": "3.0",
  "data": {
    "name": "Seraphina",
    "nickname": "Sera",
    "description": "Guardian of the Eldoria forest.",
    "personality": "Kind, watchful.",
    "scenario": "The user wakes wounded in her glade.",
    "first_mes": "*She leans over you.* \"Ah, you're awake at last.\"",
    "mes_example": "<START>\n{{user}}: Who are you?\n{{char}}: \"A guardian.\"",
    "creator_notes": "Sample card.",
    "creator_notes_multilingual": { "zh": "示例角色卡。" },
    "system_prompt": "",
    "post_history_instructions": "",
    "alternate_greetings": [],
    "group_only_greetings": [],
    "tags": ["fantasy"],
    "creator": "example",
    "character_version": "1.0",
    "source": ["https://example.com/card/123"],
    "creation_date": 1761264000,
    "modification_date": 1761264000,
    "assets": [{ "type": "icon", "uri": "ccdefault:", "name": "main", "ext": "png" }],
    "extensions": {}
  }
}
```

### 2.4 `ccv3` 与向后兼容

规范规定的嵌入方式是「PNG/APNG 里的 `tEXt` chunk，关键字 `ccv3`，值为 UTF-8 JSON 的 base64」。回填规则：

1. 若同时检测到 `chara` 与 `ccv3` 两个 chunk，**应当用 `ccv3`**；
2. 应用可以从 `chara`（V2）回填，但**应当**在 `creator_notes` 里加一句警告，提示用户这是 V3 卡被当 V2 加载；
3. 回填出的 `chara` chunk 在再次导入时应被裁剪。

> **一个实际生态事实（重要）**：SillyTavern 自己写卡时（源码 `src/character-card-parser.js` 的 `write()`），做法是——先删掉旧的 `chara`/`ccv3` chunk，写入 `chara`（内容是传入的 V2 JSON 的 base64），然后**尝试把这份 JSON 的 `spec`/`spec_version` 硬改成 `chara_card_v3`/`"3.0"` 后再 base64 写进 `ccv3`**，解析失败则跳过。也就是说 ST 写出的 `ccv3` chunk **不保证是一张语义完整的 V3 卡**（没有 `group_only_greetings`、没有 `assets` 等）。读取时应当把 `ccv3` 当「V2 数据 + V3 标记」来容错，而不是严格按 V3 必填校验。

### 2.5 世界书到底有没有内嵌进卡

**有，V2 和 V3 都有**，但格式不同：

- V2：`data.character_book` → `CharacterBook`（`entries` 是**数组**，entry 用 `keys`/`secondary_keys`/`insertion_order`/`enabled`，`position` 只有 `before_char`/`after_char`）。
- V3：`data.character_book` → `Lorebook`（`entries` 仍是**数组**，新增 `use_regex`，`constant` 从「可选」升为「必须实现」，另有一套 `@@decorator` 文本装饰器）。
- ST 导出时会把角色绑定的独立世界书**转成** `character_book` 塞进卡里（源码 `characters.js` 的 `convertWorldInfoToCharacterBook`，字段映射：`id←uid`、`keys←key`、`secondary_keys←keysecondary`、`insertion_order←order`、`enabled←!disable`、`position← position==0?'before_char':'after_char'`）。
- 但 ST 自己**只导出一个主世界书**；用 Shift+Click 绑定的额外世界书不会进卡（官方 World Info 文档明确「only the primary World Info file gets exported with the character」）。

---

## 3. PNG 内嵌角色卡：二进制层面

### 3.1 PNG 容器结构（W3C 规范）

PNG 文件 = 8 字节签名 + 一串 chunk。

```
签名（8 字节，十进制）：137 80 78 71 13 10 26 10
       即：89 50 4E 47 0D 0A 1A 0A（十六进制）
```

每个 chunk 四段：

| 段 | 长度 | 说明 |
|----|------|------|
| Length | 4 字节无符号大端 | **只算 data 的长度**，不含自身、type、CRC。0 合法，上限 2³¹−1 |
| Chunk Type | 4 字节 ASCII 字母 | 如 `IHDR`、`tEXt`、`IDAT`、`IEND` |
| Chunk Data | Length 字节 | 可为 0 字节 |
| CRC | 4 字节 | 对 **type + data** 计算，**不含 Length**；用 CRC-32（ISO 3309 / ITU-T V.42 多项式），始终存在 |

顺序硬约束：`IHDR` 必须第一个，`IEND` 必须最后一个；`PLTE` 在 `IDAT` 前；多个 `IDAT` 必须连续。`tEXt` 可以出现任意多个、位置不限制（这也是为什么角色卡能塞进去）。

### 3.2 `tEXt` chunk 的 data 内部格式

```
Keyword:        1-79 字节（Latin-1 可打印字符，大小写敏感）
Null separator: 1 字节 0x00
Text:           n 字节（Latin-1；非 null 结尾，靠 chunk Length 界定）
```

角色卡的 `Text` 段里放的是 **base64 文本**，解码后才是 UTF-8 的 JSON。所以完整链路是：

```
PNG 文件
  └─ chunk: type="tEXt"
       └─ data: "chara" 0x00 "<base64>"
            └─ base64 decode → UTF-8 bytes → JSON text
                 └─ JSON.parse → 角色卡对象（V2 或 V3）
```

### 3.3 关键字：`chara` 与 `ccv3`

| 关键字 | 内容 | 来源 |
|--------|------|------|
| `chara` | base64(UTF-8 JSON)，通常是 V2 卡（历史上 V1 扁平 JSON 也用过这个关键字） | ST 源码 `write()` / `read()` |
| `ccv3` | base64(UTF-8 JSON)，V3 卡 | V3 spec + ST 源码 |

ST 的读取顺序（源码事实）：取所有 `tEXt` chunk → 解码 → 先找 `keyword.toLowerCase() === 'ccv3'`，命中就返回；否则找 `'chara'`；都没有则抛 `No PNG metadata.`。注意它**比较时转小写**，但 PNG 规范本身规定关键字大小写敏感，所以自己实现时不要假设关键字一定小写。

### 3.4 二进制布局示意

```
offset 0        8 bytes   89 50 4E 47 0D 0A 1A 0A          ← PNG 签名
offset 8        4 bytes   00 00 00 0D                      ← IHDR length = 13
offset 12       4 bytes   49 48 44 52 ("IHDR")
offset 16      13 bytes   width(4) height(4) bitdepth ct cm fm im
offset 29       4 bytes   CRC
...
offset X        4 bytes   LL LL LL LL                      ← tEXt length（大端）
offset X+4      4 bytes   74 45 58 74 ("tEXt")
offset X+8      5 bytes   63 68 61 72 61 ("chara")
offset X+13     1 byte    00                               ← null 分隔符
offset X+14     N bytes    base64 文本（ASCII）
offset X+14+N   4 bytes   CRC(type+data)
...
最后 12 字节   00 00 00 00 49 45 4E 44 AE 42 60 82       ← 空 IEND
```

### 3.5 读取算法（可直接照抄的伪代码）

```js
function readCardChunks(buf) {
  // 1. 校验签名
  const SIG = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a png');

  const texts = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len  = buf.readUInt32BE(p);        // 只含 data
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      const keyword = data.subarray(0, nul).toString('latin1');
      const text    = data.subarray(nul + 1);           // 仍是 ASCII base64
      texts.push({ keyword, text });
    }
    if (type === 'IEND') break;
    p += 12 + len;                            // 4(len)+4(type)+len+4(crc)
  }

  const pick = (kw) => texts.find(t => t.keyword.toLowerCase() === kw);
  const hit = pick('ccv3') || pick('chara');
  if (!hit) throw new Error('no character data');
  const json = Buffer.from(hit.text.toString('latin1'), 'base64').toString('utf8');
  return JSON.parse(json);
}
```

要点：① **不要用「找 `chara` 字符串」的方式定位**，必须按 chunk 走；② CRC 可以校验也可以跳过（ST 用 `png-chunks-extract` 抽 chunk，不强制校验），但写文件时 CRC 必须正确；③ base64 过长时可能出现多个 `tEXt`（规范允许同关键字多次出现），实际实现按第一个命中即可。

### 3.6 其他承载方式

| 格式 | 是否承载角色卡 | 依据 |
|------|----------------|------|
| PNG | 是（`chara` / `ccv3`） | V3 spec + ST 源码 |
| APNG | 是，规范明确「PNG/APNG」；APNG 是 PNG 的超集，chunk 结构相同，只是多了 `acTL`/`fcTL`/`fdAT` | V3 spec；ST 源码 `tryReadImage` 注释也把 APNG 当 buffer 处理 |
| JSON 文件 | 是，规范要求「JSON 文件必须是一个 CharacterCardV3 对象」 | V3 spec |
| CHARX | 是，zip 包：根目录 `card.json` 存卡，资源放 `assets/{type}/...`，用 `embeded://path` 引用（注意规范里这个词就拼成 `embeded`，不是 `embedded`） | V3 spec |
| WebP | **规范未定义** | V3 spec 的 Embedding Methods 只有 PNG/APNG、JSON、CHARX |
| YAML | ST 导入支持 `yaml`/`yml`（源码 `importFromYaml`），但**不是**规范定义的卡格式 | ST 源码 `characters.js` |
| BYAF | ST 导入支持 `byaf`（第三方格式） | ST 源码 `characters.js` |

补充事实：ST 服务端的 `src/character-card-parser.js` 里 `parse()` 的 `switch` **只写了 `case 'png'`**，其他格式直接抛 `Unsupported format`；而角色入库时 `writeCharacterData` 会把任意可读图片（含 APNG）统一重编码成 PNG 再写 chunk。所以「webp 存卡」在实际 ST 里并不成立——它会被转成 png。

---

## 4. World Info / Lorebook（世界书）

### 4.1 语义

世界书是一个**关键词触发的动态字典**：扫最近 N 条消息（可含角色描述等额外来源），命中某条 entry 的 `key` 就把该 entry 的 `content` 插进 prompt 的指定位置。它同时承担了「设定集」「条件化 system prompt」「记忆库」「随机事件表」等多种用途。

### 4.2 顶层结构（关键：entries 是对象）

SillyTavern 的**独立世界书文件**是：

```json
{ "entries": { "0": { ...entry... }, "1": { ...entry... } } }
```

一手证据（三处互相印证）：

1. 服务端 `src/endpoints/worldinfo.js`：文件不存在时返回的 dummy 是 `{ entries: {} }`；导入/保存时只校验 `'entries' in worldContent`；
2. 前端 `public/scripts/world-info.js`：`Object.keys(data.entries).map(uid => data.entries[uid])`、`Object.values(data.entries)`——按对象处理；
3. 官方仓库自带的、与默认角色 Seraphina 配套的世界书 [`default/content/Eldoria.json`](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/default/content/Eldoria.json) 就是 `{"entries":{"0":{...},"1":{...}}}`。

顶层还允许出现其他键（例如 `name`、`extensions`、`originalData`），服务端不校验也不拒绝。**不要按 V2 `character_book` 的数组形态去解析独立世界书文件**——这是最常见的兼容性 bug。

> 与角色卡内嵌世界书的差异见 4.6。

### 4.3 entry 字段表

以下字段名全部来自官方默认世界书 `Eldoria.json` 的真实条目 + STscript 文档的「Valid entry fields」表 + World Info 文档的语义说明。

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `uid` | number | 是 | 条目在本文件内的唯一 ID，**同时是 `entries` 里的对象键（字符串）** |
| `key` | string[] | 是 | 主关键词。纯文本不区分大小写（可配）；**含 `/.../flags` 形式时按 JS 正则匹配**；纯文本 key 内不能有逗号（逗号是分隔符，仅正则内可用） |
| `keysecondary` | string[] | 是 | 次级关键词（UI 叫 Optional Filter），配合 `selective`/`selectiveLogic` 使用 |
| `comment` | string | 是（可空串） | 条目标题/备忘。**不参与触发、不进 prompt**；空时可被「Fill empty memos」用首个 key 回填（上限 100 字符） |
| `content` | string | 是 | 命中后插入的正文。空串即使命中也不插入 |
| `constant` | boolean | 是 | 常驻（蓝圈）：不看关键词，永远尝试插入（仍受预算约束） |
| `selective` | boolean | 是 | 是否启用次级关键词过滤。为 `false` 时 `keysecondary` 被忽略 |
| `selectiveLogic` | number | 否（缺省 `0`） | 次级过滤逻辑：`0`=AND ANY、`1`=NOT ALL、`2`=NOT ANY、`3`=AND ALL（源码 `world_info_logic`）。`Eldoria.json` 里未出现该键，推断缺省值为 `0`（判断） |
| `order` | number | 是 | 插入优先级。数值**越大越靠后**（越靠近上下文末尾、影响越强）。同 `order` 时相对次序由实现决定 |
| `position` | number | 是 | 插入位置枚举，见 4.4 |
| `disable` | boolean | 是 | 禁用该条。为 true 时**任何情况下都不激活** |
| `displayIndex` | number | 是 | 编辑器里的展示序号，不参与运行时 |
| `addMemo` | boolean | 是（样本中出现） | 官方 STscript 字段表未列出；**未验证**具体语义，判断是「自动生成标题」的 UI 开关 |
| `group` | string | 是（可空串） | 包含组（Inclusion Group）。同组多条同时命中时只取一条；可用逗号分隔加入多个组 |
| `groupOverride` | boolean | 是 | 「Prioritize Inclusion」：组内不再按 `groupWeight` 随机，而取 `order` 最大者 |
| `groupWeight` | number | 是 | 组内随机权重，默认 `100` |
| `useGroupScoring` | boolean \| null | 是 | 组内先按「命中 key 数量」打分，只留最高分子集再选；`null` 表示跟随全局 |
| `sticky` | number | 是 | 触发后继续生效 N 条消息（0=关闭）。sticky 期间忽略 probability 检查 |
| `cooldown` | number | 是 | 触发后 N 条消息内不能再触发；可与 sticky 连用（sticky 结束时进入 cooldown） |
| `delay` | number | 是 | 聊天至少有 N 条消息后才可触发（0/1/2… 见官方示例） |
| `probability` | number | 是 | 触发概率 0–100。**是「命中后再掷一次是否真的插入」**，对所有激活方式（constant/key/递归）都生效 |
| `depth` | number | 是 | 当 `position`=@D（=4）时，插入到倒数第几层（0=最后一条消息之后） |
| `useProbability` | boolean | 是 | 是否启用 `probability`。为 false 时 `probability` 被忽略 |
| `role` | number \| null | 是 | @D 位置的角色：`0`=System、`1`=User、`2`=Assistant；`null`=跟随默认 |
| `vectorized` | boolean | 是 | 允许被向量检索（🔗 链环）命中；仅替换「关键词检查」这一步，其余检查照旧 |
| `excludeRecursion` | boolean | 是 | 「Non-recursable」：不会被其他条目递归激活 |
| `preventRecursion` | boolean | 是 | 「Prevent further recursion」：本条被激活后不再去激活别人 |
| `delayUntilRecursion` | boolean | 是 | 「Delay until recursion」：只在递归扫描阶段才参与匹配（可配 Recursion Level 分层） |
| `scanDepth` | number \| null | 是 | 覆盖全局扫描深度；`null`=跟随全局 |
| `caseSensitive` | boolean \| null | 是 | 覆盖大小写敏感；`null`=跟随全局 |
| `matchWholeWords` | boolean \| null | 是 | 覆盖「全词匹配」；`null`=跟随全局。**中文/日文建议关掉**（官方明确警告） |
| `automationId` | string | 是（可空串） | 与 Quick Reply 的 Automation ID 对应；条目激活时自动执行该 QR 命令。同一 ID 多条激活只执行一次 |
| `matchCharacterDescription` 等 | boolean | 否 | 额外匹配源：`matchCharacterDescription`、`matchCharacterPersonality`、`matchScenario`、`matchPersonaDescription`、`matchCharacterDepthPrompt`、`matchCreatorNotes` |
| `characterFilter` | object | 否 | `{isExclude, names[], tags[]}`，按角色名/标签过滤 |
| `trigger`/`triggers` | ？ | — | 官方文档描述了「Triggers（Normal/Continue/Impersonate/Swipe/Regenerate/Quiet）」这一能力，但 `Eldoria.json` 未出现对应字段；**字段名未验证**，不要凭猜测写 |

### 4.4 `position` 枚举（源码为准确版本）

```
0 = before  （Before Char Defs，角色设定之前）
1 = after   （After Char Defs，角色设定之后）
2 = ANTop   （Author's Note 顶部）
3 = ANBottom（Author's Note 底部）
4 = atDepth （@D，聊天内指定 depth）
5 = EMTop   （示例对话之前）
6 = EMBottom（示例对话之后）
7 = outlet  （出口槽，用 {{outlet::Name}} 手动拉取）
```

注意：官方 STscript 文档的表格只列到 `6`；`7 = outlet` 来自源码 `world_info_position`。另外「Outlet」在 UI 里是新位置，比文档更新。

### 4.5 最小可运行 JSON

```json
{
  "entries": {
    "0": {
      "uid": 0,
      "key": ["eldoria", "forest"],
      "keysecondary": [],
      "comment": "eldoria",
      "content": "Eldoria is the whole of the woods; the glade is its sanctuary.",
      "constant": false,
      "selective": true,
      "order": 100,
      "position": 0,
      "disable": false,
      "displayIndex": 0,
      "addMemo": true,
      "group": "",
      "groupOverride": false,
      "groupWeight": 100,
      "sticky": 0,
      "cooldown": 0,
      "delay": 0,
      "probability": 100,
      "depth": 4,
      "useProbability": true,
      "role": null,
      "vectorized": false,
      "excludeRecursion": false,
      "preventRecursion": false,
      "delayUntilRecursion": false,
      "scanDepth": null,
      "caseSensitive": null,
      "matchWholeWords": null,
      "useGroupScoring": null,
      "automationId": ""
    }
  }
}
```

### 4.6 与角色卡内嵌世界书的字段对照

同一个概念，两套命名，转换时必须映射：

| 语义 | ST 独立世界书 | CCv2 `character_book` entry | CCv3 `Lorebook` entry |
|------|---------------|-----------------------------|------------------------|
| 容器 | `entries`：**对象 map** | `entries`：**数组** | `entries`：**数组** |
| 条目 ID | `uid` | `id` | `id` |
| 主关键词 | `key` | `keys` | `keys` |
| 次级关键词 | `keysecondary` | `secondary_keys` | `secondary_keys` |
| 正文 | `content` | `content` | `content` |
| 启用 | `disable`（反向） | `enabled` | `enabled` |
| 顺序 | `order` | `insertion_order` | `insertion_order` |
| 常驻 | `constant` | `constant` | `constant`（必须实现） |
| 位置 | `position: 0..7` | `position: "before_char"/"after_char"` | 同 V2，另有 `@@position` 装饰器 |
| 大小写 | `caseSensitive` | `case_sensitive` | `case_sensitive` |
| 标题 | `comment` | `comment` | `comment` |
| 正则 key | key 写成 `/.../i` | — | `use_regex: true` |
| 扩展 | （顶层/条目 `extensions`） | `extensions` | `extensions` |

转换公式（ST 源码 `convertWorldInfoToCharacterBook` 的方向）：

```
id = uid
keys = key
secondary_keys = keysecondary
comment = comment
content = content
constant = constant
selective = selective
insertion_order = order
enabled = !disable
position = (position === 0) ? "before_char" : "after_char"   // ST 只做这个二元映射，@D/AN/EM/outlet 信息在此丢失
```

> **判断**：把 ST 世界书导出成角色卡内嵌世界书是**有损**的——`position` 从 8 值枚举塌缩成 2 值，`depth`/`role`/`sticky`/`cooldown`/`delay`/`group` 等字段在 CCv2 规范里没有对应位置，只能塞 `extensions`。反过来（卡 → ST）也会丢 `@@` 装饰器语义。

### 4.7 触发、扫描与预算的运行时规则

这部分**不是数据格式，是解释器行为**，但决定了同一份 JSON 在不同实现里的输出差异。官方文档给出的事实：

- **扫描缓冲**：默认只扫最近 `scanDepth` 条消息；`0` 表示只评估递归结果和 Author's Note；`1` 表示只扫最后一条。每条消息会被加上 `角色名:` 前缀（`Include Names`，默认开），v1.12.6 之后还用 `\x01` 分隔（源码里 `MATCHER = '\x01'`，`JOINER = '\n' + '\x01'`）。这解释了为什么可以用 `/\x01{{user}}:[^\x01]*?hello/` 只匹配某角色的发言。
- **预算**：`Context %`（默认 25）或绝对 `Budget` 二选一，超过就停止插入。溢出时**先插 constant 条目，再按 `order` 从大到小**；「直接被关键词命中的条目」优先于「被其他条目内容递归命中的条目」。
- **递归**：全局开关 + 每条的 `excludeRecursion`/`preventRecursion`/`delayUntilRecursion`；`Max Recursion Steps` 限制扫描轮数（0=只受预算限制，1≈关闭递归，2=只能递一层，3=两层…）。`Min Activations`（与 Max Recursion Steps 互斥）会无视 scanDepth 一直往回翻聊天记录，直到激活数达到设定值，仍受 `Max Depth` 与预算限制。
- **概率**：`probability` 在**所有**激活路径之后掷骰，`useProbability=false` 时跳过。
- **包含组**：同组多条同时命中只留一条；默认按 `groupWeight` 随机；`groupOverride` 改为取 `order` 最大者；`useGroupScoring` 先按命中 key 数筛。
- **Timed Effects**：`sticky`/`cooldown`/`delay` 以「消息条数」计，0=无效；只在激活它的那个 chat 内有效，分支继承父状态；聊天不前进（swipe/删除最后一条）时效果被移除；改条目会强制清除效果。
- **向量**：`vectorized` 只替换关键词检查；`Scan Depth` 被向量检索的「Query messages」取代；`Max Entries` 只限条数，不影响 token 预算。
- **Automation**：条目激活后按排序策略依次执行同 `automationId` 的 QR 命令，蓝圈（constant）先处理，然后按 `order`，递归触发的排最后；同 ID 只执行一次。

---

## 5. Chat Completion Preset（聊天补全预设）

### 5.1 语义

一个预设文件同时装了三样东西：**采样参数**、**提示词片段库（`prompts`）**、**片段装配顺序（`prompt_order`）**。ST 把它存成 `OpenAI Settings/*.json`（每个预设一个文件），内置默认预设是官方仓库的 [`default/content/presets/openai/Default.json`](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/default/content/presets/openai/Default.json)。

### 5.2 采样与连接参数

以下全部来自 `Default.json` 的真实键（值也照抄，可作为默认值参考）：

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `temperature` | number | `1` | 温度 |
| `top_p` | number | `1` | 核采样 |
| `top_k` | number | `0` | top-k（0=关闭） |
| `top_a` | number | `0` | top-a |
| `min_p` | number | `0` | min-p |
| `repetition_penalty` | number | `1` | 重复惩罚 |
| `frequency_penalty` | number | `0` | 频率惩罚 |
| `presence_penalty` | number | `0` | 存在惩罚 |
| `openai_max_context` | number | `4095` | 上下文窗口 |
| `openai_max_tokens` | number | `300` | 最大回复 token |
| `max_context_unlocked` | boolean | `false` | 是否解除上下文上限 |
| `seed` | number | `-1` | 随机种子（-1=随机） |
| `n` | number | `1` | 一次生成几条 |
| `stream_openai` | boolean | `true` | 流式 |
| `names_behavior` | number | `0` | 名字前缀策略 |
| `continue_postfix` | string | `" "` | Continue 时拼接的前缀 |
| `continue_prefill` | boolean | `false` | Continue Nudge 用 assistant 角色发送 |
| `squash_system_messages` | boolean | `false` | 合并连续 system 消息（官方标注「已弃用，建议用 Prompt Post-Processing」） |
| `use_sysprompt` | boolean | `false` | 合并 system 到独立字段（仅 Gemini/Claude 后端） |
| `assistant_prefill` / `assistant_impersonation` | string | `""` | 预填充 / 扮演提示 |
| `chat_completion_source` | string | `"openai"` | 后端类型 |
| `openai_model` / `claude_model` / `google_model` / … | string | 见文件 | 各后端模型名 |

另有大量纯 UI/后端字段（`reverse_proxy`、`proxy_password`、`bias_preset_selected`、`media_inlining`、`show_external_models`、`bypass_status_check` 等），与「还原语义」无关。

> 注意：`Default.json` 里**没有** `max_tokens` 这个键，用的是 `openai_max_tokens`；不同后端（Claude/Gemini）也各有自己的字段前缀。写通用读取器时不要硬编码单一后端。

### 5.3 `prompts` 数组

每个元素是一条「提示词片段」：

```json
{
  "identifier": "main",
  "name": "Main Prompt",
  "system_prompt": true,
  "role": "system",
  "content": "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}."
}
```

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `identifier` | string | 是 | **稳定键**。`prompt_order` 用它引用；内置片段的名字不可改 |
| `name` | string | 是 | 显示名。官方明确「不发送给模型」 |
| `content` | string | 否 | 片段文本。`marker=true` 的片段没有 content（运行时由实际内容替换） |
| `role` | `"system"`/`"user"`/`"assistant"` | 否（marker 项无） | 以哪个角色发送 |
| `system_prompt` | boolean | 是 | 标记该片段属于 system-prompt 类别（ST 内部用于归类与角色卡覆盖逻辑）。**精确语义官方文档未说明——未验证** |
| `marker` | boolean | 否 | `true` 表示这是**占位符**而非静态文本：运行时替换成角色描述、示例对话、聊天记录、世界书等 |

官方 Prompt Manager 文档另描述了片段的 `Triggers`（Normal/Continue/Impersonate/Swipe/Regenerate/Quiet）、`Position`（Relative / In-Chat）、`Depth`、`Order` 这些**能力**；但 `Default.json` 的内置片段里并未出现对应字段。自定义 in-chat 片段很可能用 `injection_position`/`injection_depth`/`injection_trigger` 之类的键——**本次未抓到实例，字段名未验证**。

### 5.4 `prompt_order`

```json
"prompt_order": [
  { "character_id": 100000, "order": [ {"identifier":"main","enabled":true}, ... ] },
  { "character_id": 100001, "order": [ ... ] }
]
```

| 字段 | 类型 | 含义 |
|------|------|------|
| `character_id` | number | 顺序组的 ID。默认预设给了 `100000` 和 `100001` 两套；两套唯一的差别是**后者在 `charDescription` 之前多了一个 `personaDescription`**。官方文档没有解释这个 ID 的确切语义（推测是「单人 / 群聊」两套顺序）——**未验证** |
| `order[].identifier` | string | 引用 `prompts[].identifier` |
| `order[].enabled` | boolean | 该片段是否参与本次装配；**默认片段不能删，只能关** |

装配规则（官方 Prompt Manager 文档）：

- 数组**靠前 = 先发送**，末尾通常是 Post-History Instructions；
- `Position=Relative` 时按拖拽顺序发；
- `Position=In-Chat` + `Depth` 时**无视拖拽顺序**，插进聊天记录里（Depth 0 = 最后一条消息之后，1 = 最后一条之前，以此类推）；
- 同 Role 同 Depth 的片段按 `Order` 排序，角色组顺序是 User → AI Assistant → System；
- 官方明确列出「默认片段（pinned）」：Main Prompt、World Info (before/after)、Persona Description、Character Description、Character Personality、Scenario、Enhance Definitions、Auxiliary Prompt、Chat Examples、Chat History、Post-History Instructions。

### 5.5 内置 identifier 一览（顺序取自 `Default.json` 的 100001 组）

| identifier | 名称 | marker | 作用 / 备注 |
|------------|------|--------|-------------|
| `main` | Main Prompt | 否 | 主系统提示，默认「Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.」；通常第一条发送 |
| `worldInfoBefore` | World Info (before) | 是 | 位置 0/2/3/5/6 的世界书条目汇总（插入点在角色设定之前的那一批） |
| `personaDescription` | Persona Description | 是 | 用户 persona 描述（仅 100001 组默认启用） |
| `charDescription` | Char Description | 是 | 角色 `description` |
| `charPersonality` | Char Personality | 是 | 角色 `personality` |
| `scenario` | Scenario | 是 | 角色 `scenario` |
| `enhanceDefinitions` | Enhance Definitions | 否 | 默认**关闭**的增强指令：「If you have more knowledge of {{char}}, add to the character's lore…」 |
| `nsfw` | Auxiliary Prompt | 否 | 辅助提示（内部 identifier 叫 `nsfw`），默认空串，常被预设用来塞风格/NSFW 指令 |
| `worldInfoAfter` | World Info (after) | 是 | 位置 1 等「角色设定之后」的世界书汇总 |
| `dialogueExamples` | Chat Examples | 是 | 对话示例（`mes_example`），按 `<START>` 分块 |
| `chatHistory` | Chat History | 是 | 聊天记录本体，被它替换的位置决定了「历史从哪开始」 |
| `jailbreak` | Post-History Instructions | 否 | 最后一条指令（PHI/越狱），默认空串 |

> 这套 identifier 是**约定而非规范**：ST 代码里写死，第三方预设依赖它。要兼容，必须认识这 12 个名字并知道哪些是 marker。

### 5.6 最小可运行 JSON（精简自 `Default.json`）

```json
{
  "chat_completion_source": "openai",
  "openai_model": "gpt-4o",
  "temperature": 1,
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "top_p": 1,
  "top_k": 0,
  "repetition_penalty": 1,
  "openai_max_context": 4095,
  "openai_max_tokens": 300,
  "stream_openai": true,
  "seed": -1,
  "n": 1,
  "prompts": [
    { "identifier": "main", "name": "Main Prompt", "system_prompt": true, "role": "system",
      "content": "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}." },
    { "identifier": "worldInfoBefore", "name": "World Info (before)", "system_prompt": true, "marker": true },
    { "identifier": "charDescription", "name": "Char Description", "system_prompt": true, "marker": true },
    { "identifier": "charPersonality", "name": "Char Personality", "system_prompt": true, "marker": true },
    { "identifier": "scenario", "name": "Scenario", "system_prompt": true, "marker": true },
    { "identifier": "nsfw", "name": "Auxiliary Prompt", "system_prompt": true, "role": "system", "content": "" },
    { "identifier": "worldInfoAfter", "name": "World Info (after)", "system_prompt": true, "marker": true },
    { "identifier": "dialogueExamples", "name": "Chat Examples", "system_prompt": true, "marker": true },
    { "identifier": "chatHistory", "name": "Chat History", "system_prompt": true, "marker": true },
    { "identifier": "jailbreak", "name": "Post-History Instructions", "system_prompt": true, "role": "system", "content": "" }
  ],
  "prompt_order": [
    { "character_id": 100000, "order": [
      { "identifier": "main", "enabled": true },
      { "identifier": "worldInfoBefore", "enabled": true },
      { "identifier": "charDescription", "enabled": true },
      { "identifier": "charPersonality", "enabled": true },
      { "identifier": "scenario", "enabled": true },
      { "identifier": "nsfw", "enabled": true },
      { "identifier": "worldInfoAfter", "enabled": true },
      { "identifier": "dialogueExamples", "enabled": true },
      { "identifier": "chatHistory", "enabled": true },
      { "identifier": "jailbreak", "enabled": true }
    ]}
  ]
}
```

### 5.7 装配的隐藏语义

- `marker` 片段在最终消息里**不存在对应文本**，它只是一个「槽位」；有内容才占位，没内容（比如没有示例对话）就整段消失。
- `enabled:false` 的片段依然留在 `prompts` 里，别丢——用户随时会打开。
- 同名预设会被 ST 自动匹配到同名角色卡（官方文档警告过），这是运行时行为不是格式。
- `wi_format`/`scenario_format`/`personality_format` 这类「格式模板」也在预设里（`{0}` / `{{scenario}}` / `{{personality}}` 是插入点），它们决定世界书/场景/性格被**包成什么样子**塞进去。

---

## 6. 宏（macros）、Regex 扩展、Quick Replies、STscript

### 6.1 这是「格式」还是「运行时」？

**是运行时。** 宏、Regex、QR、STscript 都不改变文件的 JSON 结构，它们是**对字符串求值的解释器**。但它们是「格式的一部分」这句话也有一半道理：卡、世界书、预设的 `content` 字段里普遍内嵌这些语法，如果你只做「读出字符串」而不求值，语义会完全走样。所以正确说法是：

> 数据格式是**载体**，宏/Regex/STscript 是**写在载体里的程序**。只解析载体 = 拿到源码；不实现解释器 = 不执行。

### 6.2 宏语法

- 定界：`{{macroName}}`；**宏名大小写不敏感**（`{{User}}`=`{{user}}`）。
- 参数分隔：`::`（推荐）或单个空格；单个 `:` 是历史语法（如 `{{roll:1d6}}`），仍支持但不推荐。
- 空白：`{{ macro :: arg }}` 与紧凑写法等价。
- 嵌套：内层先求值，`{{getvar::{{char}}_mood}}`。
- 作用域块：`{{macro arg}} ... {{/macro}}`，块内文本作为**最后一个参数**；默认会 trim + 去缩进，`#` flag 保留空白。
- flags：`{{/name}}` 关闭块；`{{#name}}` 保留空白。`!`/`?`/`~`/`>` 官方标注为「计划中，未实现」。
- 转义：`\{\{notAMacro\}\}` 输出字面量。
- 旧语法：`<USER>`、`<BOT>`、`<CHAR>`、`<GROUP>`、`<CHARIFNOTGROUP>` 会自动转成宏。

### 6.3 常用宏清单（全部来自官方 Macros 文档）

**名字与参与者**

| 宏 | 语义 |
|----|------|
| `{{user}}` | 当前用户/persona 名 |
| `{{char}}` | 当前角色名（V3 卡有 `nickname` 时可能是昵称） |
| `{{group}}` | 群成员名（逗号分隔，含静音） |
| `{{groupNotMuted}}` | 群成员名（不含静音） |
| `{{charIfNotGroup}}` | 角色名；群聊中为空 |
| `{{notChar}}` | 除当前发言者外的所有参与者 |

**角色卡与 persona 字段**

| 宏 | 语义 |
|----|------|
| `{{description}}` | 角色 `description` |
| `{{personality}}` | 角色 `personality` |
| `{{scenario}}` | 角色 `scenario` |
| `{{persona}}` | 用户 persona 描述 |
| `{{charPrompt}}` | 角色卡里的主提示覆盖（`system_prompt`） |
| `{{charInstruction}}` | 角色卡的 PHI 覆盖（`post_history_instructions`） |
| `{{charDepthPrompt}}` | 角色的 @Depth Note |
| `{{charCreatorNotes}}` | 作者备注 |
| `{{charVersion}}` | 角色版本号 |
| `{{mesExamples}}` / `{{mesExamplesRaw}}` | 示例对话（instruct 格式化 / 原文） |
| `{{charFirstMessage}}` | 开场白；可带索引 `{{charFirstMessage::1}}` 取备选开场白 |
| `{{original}}` | 供 `system_prompt`/`post_history_instructions` 覆盖时引用「原本的全局值」 |

**消息与时间**

`{{lastMessage}}`、`{{lastMessageId}}`、`{{lastUserMessage}}`、`{{lastCharMessage}}`、`{{firstIncludedMessageId}}`、`{{firstDisplayedMessageId}}`、`{{lastSwipeId}}`、`{{currentSwipeId}}`、`{{allChatRange}}`、`{{summary}}`；`{{time}}`、`{{time::UTC±n}}`、`{{date}}`、`{{weekday}}`、`{{isotime}}`、`{{isodate}}`、`{{datetimeformat::…}}`、`{{idleDuration}}`、`{{timeDiff::a::b}}`。

**随机与工具**

| 宏 | 语义 | 备注 |
|----|------|------|
| `{{random::a::b::c}}` | 每次求值都重掷 | ST 文档写法用 `::` 分隔；V3 规范写作 `{{random:A,B,C}}`（逗号分隔，`\,` 可转义） |
| `{{pick::a::b::c}}` | **稳定**随机：同一 chat、同一位置结果一致 | 可用 `/reroll-pick` 重掷；V3 规范要求「同一 prompt 内同值」 |
| `{{roll::1d20}}` | 掷骰，droll 语法（`2d6+3` 这类表达式） | V3 规范里是 `{{roll:N}}` / `{{roll:d6}}`，只保证 1..N |
| `{{reverse::text}}` | 反转字符串 | V3 规范同样定义 |
| `{{newline}}` / `{{space}}` | 换行/空格，可带次数 | |
| `{{noop}}` | 空串（用于保留被 trim 的空白） | |
| `{{trim}}` | 去掉首尾换行 | |
| `{{input}}` | 当前输入框内容 | |
| `{{outlet::key}}` | 拉取 world info 的 outlet 槽内容 | 世界书的 position=7 与之配套 |
| `{{banned::word}}` | 文本补全后端的禁词 | |
| `{{maxPrompt}}` / `{{maxContextTokens}}` / `{{maxResponseTokens}}` / `{{model}}` | 运行时上下文信息 | |
| `{{lastGenerationType}}` / `{{hasExtension::name}}` / `{{isMobile}}` | 运行时状态 | |

**变量与条件**

`{{getvar::n}}`、`{{setvar::n::v}}`、`{{addvar::n::v}}`、`{{incvar::n}}`、`{{decvar::n}}`、`{{hasvar::n}}`、`{{deletevar::n}}`，全局版 `getglobalvar`/`setglobalvar`/… ；简写 `{{.local}}`、`{{$global}}`（支持 `=`、`++`、`--`、`+=`、`-=`、`||`、`??`、`||=`、`??=`、`==`、`!=`、`>`、`>=`、`<`、`<=`）。

条件块：

```
{{ if personality }}{{ personality }}{{ else }}No personality defined.{{ /if }}
{{ if !personality }}…{{ /if }}
```

**注释**

| 宏 | 语义 |
|----|------|
| `{{// 注释}}` | 恒替换为空串，不展示；**且不参与世界书关键词匹配** |
| `{{// }}…{{ /// }}` | 多行注释块 |
| `{{comment: 内容}}` | 发送时为空串；在消息里作为行内注释展示；不参与关键词匹配 |
| `{{hidden_key: 内容}}` | 对外为空串；但**递归扫描时**其内容可作为关键词参与匹配（V3 定义） |

### 6.4 Regex 扩展

官方 Regex 文档给出的事实：

| 能力 | 说明 |
|------|------|
| 作用对象 `Affects` | `User Input`（用户发送后）、`AI Response`（收到回复后）、`Slash Commands`（命令写入 prompt/chat 的值）、`World Info`（条目注入 prompt 时，**且必须勾选 `Alter Outgoing Prompt` 或两个 ephemerality 都不勾**）、`Reasoning`（思考块） |
| 时机 | 默认在**文本被写入 chat 的 JSONL 之后**做原地改写（不可逆）；勾选 ephemerality 后只改显示或只改发出的 prompt |
| `Find Regex` | JS 正则；可写成 `/pattern/flags`，支持 `i g s m u`；可配置是否展开其中的宏（`Don't Substitute` / `Raw` / `Escaped`） |
| `Replace With` | 支持 `{{match}}`（整段匹配）与 `$1`/`$2` 捕获组；可插入 HTML/CSS |
| `Trim Out` | 替换前先从匹配文本里剔除的子串（多行=多条） |
| Depth | `Min Depth`/`Max Depth` 限定只作用于聊天记录的第 N 层（0=最后一条）；系统/工具提示不受影响 |
| `Run on Edit` | 编辑消息后是否也跑 |
| 存储 | 全局脚本存 `settings.json`；Scoped 脚本存进角色卡数据；可导出 `.json` |
| 联动 | 脚本名可作为 `/regex name=…` 在 STscript 里调用；`{{// }}` 式「永不自动触发、只被命令调用」是常见玩法 |

### 6.5 Quick Replies（QR）

- 由内置扩展提供，**默认关闭**；每个按钮 = 「标签 + 一段 STscript」。
- 可存多套「Quick Reply 预设」，用 `/qrset 名字` 切换；预设存放在 `default/content/presets/quick-replies/`（仓库里有该目录，本次未展开具体文件格式）。
- 关键联动：世界书条目的 `automationId` 与 QR 的 Automation ID 相同 → 条目激活时自动执行该脚本；同 ID 只执行一次。
- 执行入口：点按钮、`/:QrSetName.QrButtonLabel` 或 `/run QrSetName.QrButtonLabel`。

### 6.6 STscript

STscript 是**斜杠命令 + 管道 + 闭包**的脚本语言，跑在聊天输入框/QR/命令里。核心能力边界：

| 能力 | 命令 | 说明 |
|------|------|------|
| 管道 | `a \| b` | 上一条命令的返回值自动作为下一条的匿名参数；`\|\|` 阻断注入 |
| I/O | `/echo`、`/pass`、`/input`、`/popup`、`/buttons`、`/setinput`、`/speak`、`/beep` | |
| 变量 | `/getvar`、`/setvar key=n v`、`/addvar`、`/incvar`、`/decvar`、`/flushvar`、`/getglobalvar`… | 局部变量存 chat metadata，全局存 settings.json；数组/对象以 JSON 字符串存 |
| 条件 | `/if left=A right=B rule=eq\|neq\|lt\|gt\|lte\|gte\|not\|in\|nin else={: … :} {: … :}` | 操作数求值顺序：数字 → 局部变量 → 全局变量 → 字符串 |
| 循环 | `/while`、`/times`、`/break` | 默认 100 次 guard |
| 闭包 | `{: … :}`、`{:/len foo:}()`、`/let x {: … :}`、`/:x` | 有独立作用域与 `/let`/`/var`/`{{var::}}` |
| 生成 | `/gen`、`/genraw`、`/trigger`、`/swipe`、`/regenerate`、`/continue`、`/ask` | `/trigger` 等价于点发送；`/genraw` 不带角色与聊天 |
| 消息 | `/send`、`/sendas`、`/sys`、`/comment`、`/addswipe`、`/hide`、`/unhide`、`/cut`、`/del`、`/messages` | |
| 注入 | `/inject id=… position=after\|before\|chat depth=N 文本`、`/note`、`/interval`、`/depth`、`/position` | 相当于无限个 Author's Note，存 chat metadata |
| 世界书 | `/getchatbook`、`/findentry`、`/getentryfield`、`/setentryfield`、`/createentry`、`/wi-set-timed-effect`、`/wi-get-timed-effect` | |
| 文本 | `/trimtokens`、`/trimstart`、`/trimend`、`/fuzzy`、`/regex` | |
| 数学 | `/add`、`/mul`、`/sub`、`/div`、`/mod`、`/pow`、`/sin`、`/cos`、`/log`、`/abs`、`/sqrt`、`/round`、`/rand`、`/max`、`/min` | |
| 解析器开关 | `/parser-flag STRICT_ESCAPING`、`REPLACE_GETVAR` | |

**能力边界（判断）**：STscript 能读写聊天、变量、世界书、消息，能发起生成、能弹 UI、能跑正则——它实际上是一个**有副作用的宿主脚本层**，等价于「应用内宏语言」。它没有文件系统/网络（除非对应扩展提供，如 `/imagine` 来自图像生成插件），也没有真正的函数式抽象（闭包是有限实现）。

---

## 7. 实现代价评估

> 目标：自研应用「读进来并正确还原语义」。下面把工作切成四档。**难度分档是工程判断，不是规范事实**；工作量是量级估计（单人、熟悉生态、无现成库的前提）。

### 7.1 L1 —— 纯解析（容易）

| 工作项 | 说明 | 估计 |
|--------|------|------|
| 角色卡 JSON 解析 | V2/V3 的 `data` 字段树，容错缺字段；未知字段保留 | 0.5 天 |
| PNG chunk 扫描 | 签名校验、按 length 迭代、抽 `tEXt`、取 `chara`/`ccv3`、base64 解码 | 0.5–1 天 |
| 世界书 JSON 解析 | `entries` 当**对象**处理，兼容少数导出成数组的第三方文件 | 0.5 天 |
| 预设采样参数读取 | 扁平字段，注意不同后端前缀 | 0.5 天 |
| 字符串读取（不求值） | 把 description / content / prompt content 原样取出 | 0 天（顺带） |

**特征**：输入 → 内存对象，确定性、可单测、无状态、无外部依赖。**这一档做完，你就能「打开并展示」所有酒馆资产。**

### 7.2 L2 —— 结构映射与规范化（中等）

| 工作项 | 难点 |
|--------|------|
| V2 ↔ V3 互转 | `creator_notes` 与 `creator_notes_multilingual` 的优先级、`assets` 缺省值、`spec_version` 浮点比较 |
| 卡内世界书 ↔ 独立世界书 | **两套字段名 + 数组/对象两种容器**（见 4.6 对照表）；`position` 8 值 ↔ 2 值是有损映射 |
| 预设 `prompt_order` 规范化 | 多套 `character_id` 顺序、`enabled` 开关、marker 片段识别、默认片段不可删 |
| 世界书 `position`/`selectiveLogic`/`role` 枚举 | 数值 ↔ 语义，且源码比文档多一个 `outlet: 7` |
| 编码与清洗 | 非 UTF-8 历史文件、BOM、`\r\n`、超长 base64、多个同关键字 chunk |

**特征**：仍是纯函数，但需要**领域知识表**（映射表、枚举表、缺省值表）。做错不会崩，只会「看起来对但语义错」。**估计 2–4 天。**

### 7.3 L3 —— 语义还原（困难，真正的分水岭）

| 工作项 | 为什么难 | 工作量级 |
|--------|----------|----------|
| **世界书激活引擎** | 扫描缓冲（含 `\x01` 前缀、角色名、额外匹配源）、大小写/全词/正则 key、`selectiveLogic` 四种逻辑、递归多轮 + `excludeRecursion`/`preventRecursion`/`delayUntilRecursion` 分层、`min activations` 回溯、token 预算（constant 优先 → order 降序 → 直击优先于递归命中）、概率、包含组（权重/优先/评分）、sticky/cooldown/delay 的 per-chat 状态、outlet 槽、向量命中。**任何一处偏差都会让「同一张卡」输出不同** | 1–2 周 |
| **prompt 装配器** | 12 个内置 identifier 的语义、marker 展开、`Position=Relative` 与 `In-Chat + Depth` 两条路径、同 Role/Depth 的 Order 与角色组顺序、`system_prompt`/`post_history_instructions` 覆盖与 `{{original}}`、`wi_format`/`scenario_format`/`personality_format` 包装、示例对话的分块与挤压策略 | 3–5 天 |
| **宏引擎** | 大小写不敏感、两种分隔符、嵌套求值、作用域块与 trim/去缩进、`#` flag、转义、legacy `<USER>`、`pick` 的稳定随机（按 chat+位置）、`random` 的重掷、变量读写与简写运算符、`{{if}}`/`{{else}}` 的假值集合（空串/`false`/`0`/`off`/`no`） | 1 周 |
| **Regex 管线** | 五个作用对象 × 三个时机（原文/显示/出站）× Depth 范围 × 宏展开策略；还要决定「改动是否写回」 | 2–3 天 |
| **token 计数** | 预算判定依赖 tokenizer，不同模型不同；`/trimtokens` 也依赖它 | 2–3 天 |

**特征**：**有状态、有顺序、有随机、有时间维度**。L3 不是「解析」，是「重写一个解释器」。到这里为止，才谈得上「正确还原语义」。

### 7.4 L4 —— 运行时复刻（不建议；投入产出比极低）

| 工作项 | 说明 |
|--------|------|
| STscript 解释器 | 管道、闭包、作用域、`/if` 的四种操作数解析、`/while` guard、`/parser-flag`、`/break`、`/run`、命名闭包参数…… 这是一门小语言 |
| Quick Replies 生态 | 预设切换、自动执行、与 `automationId` 的联动、按钮注入输入 |
| 扩展生态 | 向量库、Web Search、摘要、图像生成等通过 `/command` 暴露给脚本，复刻等于复刻整个宿主 |
| 会话/消息状态机 | swipe、分支继承、`/hide`、消息编辑后重跑 regex、timed effects 的「聊天不前进则移除」 |

**判断**：除非你的目标就是「做第二个酒馆」，否则**不要复刻 L4**。更划算的做法是：把 STscript 当作**不执行的字符串**保留（标注「此卡含脚本，需酒馆运行」），只在必要时支持一个极小子集（`/send`、`/setvar`、`/if` 这类）。

### 7.5 分档结论

```
读进来（L1）        ██░░░░░░░░  容易，1–3 天，可以做到 100% 保真
认得出（L2）        ████░░░░░░  中等，2–4 天，需要映射表
跑得对（L3）        ███████░░░  困难，3–5 周，世界书/装配/宏 三座山
跑得全（L4）        ██████████  不建议，按月计，且永远追不上上游
```

**一句话**：**格式是简单的，语义是昂贵的。** 如果你的自研应用只需要「导入并展示/编辑」，做到 L2 就够；如果要「自己生成 prompt」，L3 的世界书激活 + 预设装配 + 宏引擎是绕不开的三件套，其中**世界书递归扫描和 token 预算是最大的不确定性来源**（同一份 JSON，不同实现的输出可以完全不同）。

---

## 8. 未验证事项（明确列出，避免误用）

1. `prompt_order[].character_id` 的官方语义（`100000` / `100001` 分别对应什么场景）——文档未解释，本文只按「两套顺序」描述。
2. 自定义 in-chat prompt 片段在 `prompts[]` 里的字段名（推测为 `injection_position`/`injection_depth`/`injection_trigger`），`Default.json` 中无实例。
3. `prompts[].system_prompt` 布尔值的精确运行时语义。
4. 世界书 entry 的 `trigger`/`triggers` 字段名（官方文档描述了「Triggers」能力，`Eldoria.json` 中无该字段）。
5. `addMemo` 的语义（样本中有，官方字段表未列）。
6. `selectiveLogic` 的缺省值（样本缺该键，按 `0`=AND ANY 推断）。
7. Quick Replies 预设文件的内部 JSON 结构（仓库有 `default/content/presets/quick-replies/` 目录，本次未展开）。
8. V2 规范对 V1 六字段的严格必填性（本文依据的是 V2 spec 的 TS 定义；未单独抓取 `spec_v1.md`）。
9. ST 对 WebP 角色卡的具体导入路径（只确认了服务端 `parse()` 仅支持 png、入库时统一转 png）。

---

## 9. 来源

以下均为本次实际抓取并用于本文的页面/文件（Markdown 链接）：

**规范**

- [Character Card V2 Specification（`spec_v2.md`，malfoyslastname/character-card-spec-v2）](https://raw.githubusercontent.com/malfoyslastname/character-card-spec-v2/main/spec_v2.md)
- [Character Card V3 Specification（`SPEC_V3.md`，kwaroran/character-card-spec-v3）](https://raw.githubusercontent.com/kwaroran/character-card-spec-v3/main/SPEC_V3.md)
- [PNG Specification: File Structure（W3C，chunk layout / 签名 / CRC）](https://www.w3.org/TR/PNG-Structure.html)
- [PNG Specification: Chunk Specifications（W3C，tEXt / zTXt / iTXt）](https://www.w3.org/TR/PNG-Chunks.html)
- [Portable Network Graphics (PNG) Specification, Third Edition（W3C REC，2025-06-24）](https://www.w3.org/TR/png-3/)

**SillyTavern 官方文档**

- [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [Macros](https://docs.sillytavern.app/usage/core-concepts/macros/)
- [Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)
- [Prompts（主提示 / PHI）](https://docs.sillytavern.app/usage/prompts/)
- [Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)
- [Advanced Formatting](https://docs.sillytavern.app/usage/core-concepts/advancedformatting/)
- [Regex 扩展](https://docs.sillytavern.app/extensions/regex/)
- [STscript Language Reference](https://docs.sillytavern.app/usage/st-script/)

**SillyTavern 源码与官方数据文件（`release` 分支）**

- [默认 Chat Completion 预设 `default/content/presets/openai/Default.json`](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/default/content/presets/openai/Default.json)
- [默认世界书 `default/content/Eldoria.json`](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/default/content/Eldoria.json)
- [`src/character-card-parser.js`（PNG `chara`/`ccv3` 读写）](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/character-card-parser.js)
- [`src/endpoints/worldinfo.js`（世界书文件读写与校验）](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/worldinfo.js)
- [`src/endpoints/characters.js`（V1→V2 迁移、`character_book` 转换、导入格式）](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/characters.js)
- [`public/scripts/world-info.js`（`world_info_position` 枚举、扫描缓冲、递归/评分）](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/scripts/world-info.js)

**辅助（仅用于确认仓库目录结构，不作为语义依据）**

- [GitHub API：`default/content/presets`](https://api.github.com/repos/SillyTavern/SillyTavern/contents/default/content/presets)
- [GitHub API：`default/content/presets/openai`](https://api.github.com/repos/SillyTavern/SillyTavern/contents/default/content/presets/openai)
- [GitHub API：`default/content`](https://api.github.com/repos/SillyTavern/SillyTavern/contents/default/content)
