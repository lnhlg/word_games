import type { CardBody, Fidelity } from '../shared/types.ts'

interface RawCard {
  spec?: unknown
  spec_version?: unknown
  data?: Record<string, unknown>
  [key: string]: unknown
}

export interface NormalizedCard {
  body: CardBody
  fidelity: Fidelity
}

const KNOWN_V3_IGNORED = [
  'assets',
  'nickname',
  'creator_notes_multilingual',
  'source',
  'group_only_greetings',
  'creation_date',
  'modification_date',
]

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * 把 V1 / V2 / V3 三种形状归一成 CardBody，并生成保真度报告。
 * 不丢字段：认不出的东西进 ignored，有损的进 degraded。
 */
export function normalizeCard(raw: unknown): NormalizedCard {
  if (!raw || typeof raw !== 'object') {
    throw new Error('角色卡内容不是一个 JSON 对象。')
  }

  const card = raw as RawCard
  const looksV2 = card.spec === 'chara_card_v2'
  const looksV3 = card.spec === 'chara_card_v3'

  let data: Record<string, unknown>
  let specVersion: string

  if (looksV2 || looksV3) {
    if (!card.data || typeof card.data !== 'object') {
      throw new Error('角色卡缺少 data 字段，文件可能不完整。')
    }
    data = card.data as Record<string, unknown>
    specVersion = looksV3 ? '3.0' : '2.0'
  } else if (typeof card.name === 'string') {
    // V1：字段直接在顶层
    data = card as Record<string, unknown>
    specVersion = '1.0'
  } else {
    throw new Error(
      '认不出这张卡的格式：既没有 spec 标记（V2/V3），也没有顶层的 name 字段（V1）。',
    )
  }

  const name = str(data.name).trim()
  if (!name) {
    throw new Error('这张卡没有名字，无法导入。')
  }

  const body: CardBody = {
    name,
    description: str(data.description),
    firstMes: str(data.first_mes),
    personality: str(data.personality) || undefined,
    scenario: str(data.scenario) || undefined,
    mesExample: str(data.mes_example) || undefined,
    alternateGreetings: strArray(data.alternate_greetings),
    systemPrompt: str(data.system_prompt) || undefined,
    postHistoryInstructions: str(data.post_history_instructions) || undefined,
    creatorNotes: str(data.creator_notes) || undefined,
    tags: strArray(data.tags),
    creator: str(data.creator) || undefined,
    characterVersion: str(data.character_version) || undefined,
  }

  if (data.character_book && typeof data.character_book === 'object') {
    body.characterBook = data.character_book
  }

  const read: string[] = []
  for (const key of [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'alternate_greetings',
    'system_prompt',
    'post_history_instructions',
    'tags',
    'creator',
    'character_version',
    'creator_notes',
  ]) {
    if (key in data) read.push(key)
  }

  const mapped: Record<string, string> = {}
  const ignored: string[] = []
  const degraded: Fidelity['degraded'] = []
  const warnings: string[] = []

  if (body.characterBook) {
    mapped.character_book = '保留在卡内，由世界书功能单独处理'
  }

  if ('extensions' in data) {
    ignored.push('extensions（扩展数据，本项目不使用）')
  }
  for (const key of KNOWN_V3_IGNORED) {
    if (key in data) ignored.push(key)
  }
  for (const key of ['creator_notes_multilingual', 'source']) {
    if (key in data && !ignored.some((i) => i.startsWith(key))) ignored.push(key)
  }

  if (looksV3 && !('group_only_greetings' in data)) {
    degraded.push({
      field: 'group_only_greetings',
      reason:
        '标了 V3 却没有这个必填字段。这是酒馆写卡时的常见形态（V2 内容套 V3 标记），不影响使用。',
    })
  }

  const allText = [body.description, body.personality, body.scenario, body.firstMes]
    .filter(Boolean)
    .join('\n')
  const macros = Array.from(allText.matchAll(/\{\{([a-zA-Z_]+)(?::[^}]*)?\}\}/g)).map((m) => m[1])
  const unsupported = Array.from(new Set(macros.filter((m) => !['char', 'user'].includes(m))))
  if (unsupported.length > 0) {
    warnings.push(`卡里用了暂不支持的宏：${unsupported.map((m) => `{{${m}}}`).join('、')}`)
  }

  if (body.alternateGreetings && body.alternateGreetings.length > 0) {
    warnings.push(
      `有 ${body.alternateGreetings.length} 条备选开场白，已保存但本版不会用到（导演模式由你决定开场）`,
    )
  }

  return {
    body,
    fidelity: { specVersion, read, mapped, ignored, degraded, warnings },
  }
}
