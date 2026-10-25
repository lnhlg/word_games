import type { CardBody, CardDraft } from '../shared/types.ts'
import { LlmError, type ChatMessage } from './llm.ts'

export function buildCardDraftMessages(brief: string): ChatMessage[] {  return [
    {
      role: 'system',
      content: [
        '你是一位角色设定作者，正在为一部多角色小说写角色卡。',
        '只输出一个 JSON 对象，不要任何解释，不要 Markdown 围栏。',
        'JSON 结构：',
        '{"name": string, "description": string, "personality": string, "scenario": string, "firstMes": string, "mesExample": string, "tags": string[]}',
        '各项要求：',
        '- name：角色名字，2–4 个汉字为佳',
        '- description：600–1000 字，用【】分节。必须包含下列小节，并按此顺序：',
        '  【姓名】【身份】【年龄】【外貌】【能力】【性格】【喜好与习惯】【人际关系】【称谓分寸】【现状】【说话方式】',
        '  各节写法：',
        '  · 身份：地位、职业、与谁有关，一句话说清他在故事里的位置',
        '  · 外貌：具体可感，不堆形容词；必须有一个能透露性格的细节',
        '  · 能力：武人写武学，其他人写本事与专长',
        '  · 性格：写透，包括矛盾面与软处，不要只写优点',
        '  · 喜好与习惯：列 4–6 条具体的小动作、口头禅或怪癖',
        '  · 人际关系：逐条列出重要的人与对他的态度，每条一句',
        '  · 称谓分寸：他如何称呼别人，什么情况下会改口，什么称呼会让他不快',
        '  · 现状：故事开始时他正处在什么局面里',
        '  · 说话方式：语速、用词习惯、句长，以及情绪变化时语气怎么变',
        '- personality：20–50 字的性格摘要（与描述里的性格不重复啰嗦，只做速览）',
        '- scenario：40–80 字，他通常处在什么处境里',
        '- firstMes：120–200 字的一段登场片段，像小说里的一个镜头；不要写“你好”这类搭话，也不要让角色直接对某人说话',
        '- mesExample：3 轮示例对白，以 <START> 开头，用 {{char}} 指代本人、{{user}} 指代对话方；要能听出他的说话方式',
        '- tags：3–5 个标签',
        '全篇不要出现“你”，这部小说没有玩家角色。',
      ].join('\n'),
    },
    { role: 'user', content: brief },
  ]
}

/**
 * 宽容解析：模型可能给纯 JSON、带围栏的 JSON、或前后夹着说明文字。
 * 三种候选依次尝试，全失败才报错。缺字段不算失败。
 */
export function parseCardDraft(raw: string): CardDraft {
  const trimmed = raw.trim()
  const candidates: string[] = [trimmed]

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
      if (!name) continue

      // 模型有时会写成 first_mes，兼容一下
      const firstMesRaw = parsed.firstMes ?? parsed.first_mes
      const tagsRaw = parsed.tags

      return {
        name,
        description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
        firstMes: typeof firstMesRaw === 'string' ? firstMesRaw.trim() : '',
        personality: typeof parsed.personality === 'string' ? parsed.personality.trim() : '',
        scenario: typeof parsed.scenario === 'string' ? parsed.scenario.trim() : '',
        mesExample:
          typeof (parsed.mesExample ?? parsed.mes_example) === 'string'
            ? String(parsed.mesExample ?? parsed.mes_example).trim()
            : '',
        tags: Array.isArray(tagsRaw)
          ? tagsRaw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          : [],
      }
    } catch {
      // 试下一个候选
    }
  }

  const head = raw.trim().slice(0, 140).replace(/\s+/g, ' ')
  throw new LlmError(
    `模型的回复里没有可解析的角色卡（它返回的开头是：${head || '（空）'}）。可以重试一次，或者直接在表单里自己写。`,
  )
}

/** 在文本里找第一个能解析的 JSON 对象。 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const candidates: string[] = [trimmed]

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 试下一个候选
    }
  }

  return null
}

/** 不交给模型的部分：体积大、结构复杂，改卡时不该被重写。 */
export function stripForRevision(body: CardBody): CardBody {
  const { characterBook, alternateGreetings, ...rest } = body
  void characterBook
  void alternateGreetings
  return rest
}

export function buildRevisionMessages(body: CardBody, instruction: string): ChatMessage[] {
  const editable = stripForRevision(body)

  return [
    {
      role: 'system',
      content: [
        '你在修改一张小说角色卡。用户会用一句话说明要改成什么样。',
        '只输出修改后的完整 JSON 对象，不要解释，不要 Markdown 围栏。',
        'JSON 结构与输入完全相同。',
        '规则：',
        '- 用户没有提到的字段，必须原样保留，一个字都不要改',
        '- 若改动 description，保持它原有的【】分节结构与大致篇幅',
        '- 不要新增输入里没有的字段',
        '- 全篇不要出现“你”',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `当前角色卡：\n${JSON.stringify(editable, null, 2)}\n\n修改指令：${instruction}`,
    },
  ]
}

/**
 * 以原卡为底，只接受模型明确返回的字段。
 * 漏掉的字段保持原值——改卡不该把没提到的内容清空；
 * characterBook 与 alternateGreetings 永远取原卡，因为它们没发给模型。
 */
export function parseCardRevision(raw: string, base: CardBody): CardBody {
  const parsed = extractJsonObject(raw)
  if (!parsed) {
    const head = raw.trim().slice(0, 140).replace(/\s+/g, ' ')
    throw new LlmError(
      `模型的回复里没有可解析的角色卡（它返回的开头是：${head || '（空）'}）。可以再试一次。`,
    )
  }

  const merged: CardBody = { ...base }

  const stringFields = ['name', 'description', 'firstMes', 'personality', 'scenario', 'mesExample'] as const
  for (const field of stringFields) {
    const value = parsed[field] ?? (field === 'firstMes' ? parsed['first_mes'] : undefined)
    if (typeof value === 'string' && value.trim()) {
      merged[field] = value.trim()
    }
  }

  if (Array.isArray(parsed.tags)) {
    merged.tags = parsed.tags.filter(
      (t): t is string => typeof t === 'string' && t.trim().length > 0,
    )
  }

  return merged
}
