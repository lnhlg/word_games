import type { Lorebook, LoreEntry, LorePosition } from '../shared/types.ts'

export type { Lorebook, LoreEntry, LorePosition }

export interface ActivationResult {
  entry: LoreEntry
  matched: boolean
  reason: string
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => v.trim()).filter(Boolean)
  }
  return []
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 数值 position → 语义：0 角色前、4 深度注入、其余按角色后处理 */
export function mapNumericPosition(value: number): LorePosition {
  if (value === 0) return 'before'
  if (value === 4) return 'depth'
  return 'after'
}

/** 卡内世界书的 entry（entries 是数组，字段名是 keys / insertion_order / enabled） */
function normalizeCardBookEntry(raw: Record<string, unknown>, index: number): LoreEntry {
  const extensions = (raw.extensions ?? {}) as Record<string, unknown>
  const position = raw.position === 'before_char' ? 'before' : 'after'

  return {
    id: String(raw.id ?? index),
    keys: asStringArray(raw.keys),
    secondaryKeys: asStringArray(raw.secondary_keys),
    content: typeof raw.content === 'string' ? raw.content : '',
    comment:
      typeof raw.name === 'string' ? raw.name : typeof raw.comment === 'string' ? raw.comment : '',
    constant: raw.constant === true,
    selective: raw.selective === true,
    selectiveLogic: asNumber(raw.selectiveLogic, 0),
    position,
    depth: asNumber(extensions['depth'], 4),
    order: asNumber(raw.insertion_order, 100),
    enabled: raw.enabled !== false,
  }
}

/** 独立世界书的 entry（entries 是对象 map，字段名是 key / order / disable） */
function normalizeStandaloneEntry(raw: Record<string, unknown>, index: number): LoreEntry {
  return {
    id: String(raw.uid ?? index),
    keys: asStringArray(raw.key),
    secondaryKeys: asStringArray(raw.keysecondary),
    content: typeof raw.content === 'string' ? raw.content : '',
    comment: typeof raw.comment === 'string' ? raw.comment : '',
    constant: raw.constant === true,
    selective: raw.selective === true,
    selectiveLogic: asNumber(raw.selectiveLogic, 0),
    position: mapNumericPosition(asNumber(raw.position, 0)),
    depth: asNumber(raw.depth, 4),
    order: asNumber(raw.order, 100),
    enabled: raw.disable !== true,
  }
}

/** 已经是本项目的内部形状 */
function isInternalEntry(raw: Record<string, unknown>): boolean {
  return (
    Array.isArray(raw.keys) &&
    typeof raw.position === 'string' &&
    (raw.position === 'before' || raw.position === 'after' || raw.position === 'depth')
  )
}

function isCardBookEntry(raw: Record<string, unknown>): boolean {
  return 'keys' in raw || 'secondary_keys' in raw || 'insertion_order' in raw || 'enabled' in raw
}

/**
 * 解析三种来源：本项目内部格式、卡内 character_book、独立世界书文件。
 * 两套命名的差异在这里一次性收敛，之后全项目只认 LoreEntry。
 */
export function parseLorebook(raw: unknown, fallbackName = '未命名世界书'): Lorebook {
  if (!raw || typeof raw !== 'object') {
    throw new Error('世界书内容不是一个 JSON 对象。')
  }

  const book = raw as Record<string, unknown>
  const name = typeof book.name === 'string' && book.name.trim() ? book.name.trim() : fallbackName

  const entriesRaw = book.entries
  if (!entriesRaw || typeof entriesRaw !== 'object') {
    throw new Error('世界书缺少 entries 字段。')
  }

  const list: Array<Record<string, unknown>> = Array.isArray(entriesRaw)
    ? (entriesRaw as Array<Record<string, unknown>>)
    : Object.values(entriesRaw as Record<string, Record<string, unknown>>)

  const entries = list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item, index) => {
      if (isInternalEntry(item)) {
        return {
          id: String(item.id ?? index),
          keys: asStringArray(item.keys),
          secondaryKeys: asStringArray(item.secondaryKeys),
          content: typeof item.content === 'string' ? item.content : '',
          comment: typeof item.comment === 'string' ? item.comment : '',
          constant: item.constant === true,
          selective: item.selective === true,
          selectiveLogic: asNumber(item.selectiveLogic, 0),
          position: item.position as LorePosition,
          depth: asNumber(item.depth, 4),
          order: asNumber(item.order, 100),
          enabled: item.enabled !== false,
        }
      }
      return isCardBookEntry(item)
        ? normalizeCardBookEntry(item, index)
        : normalizeStandaloneEntry(item, index)
    })

  return { name, entries }
}

function contains(haystack: string, needle: string, caseSensitive: boolean): boolean {
  if (!needle) return false
  return caseSensitive
    ? haystack.includes(needle)
    : haystack.toLowerCase().includes(needle.toLowerCase())
}

const LOGIC_LABEL: Record<number, string> = {
  0: '任一',
  1: '非全部',
  2: '全部不',
  3: '全部',
}

/**
 * 判断哪些条目会在给定文本下被激活。
 * 每次都返回全部条目与理由——「为什么没命中」和「为什么命中」一样重要。
 */
export function activateEntries(
  entries: LoreEntry[],
  text: string,
  options: { caseSensitive?: boolean } = {},
): ActivationResult[] {
  const caseSensitive = options.caseSensitive === true

  return entries.map((entry) => {
    if (!entry.enabled) {
      return { entry, matched: false, reason: '已禁用' }
    }

    if (entry.constant) {
      return { entry, matched: true, reason: '常驻条目，不看关键词' }
    }

    const primaryHits = entry.keys.filter((k) => contains(text, k, caseSensitive))
    if (primaryHits.length === 0) {
      const shown = entry.keys.length > 0 ? entry.keys.join('、') : '（没有设置关键词）'
      return { entry, matched: false, reason: `主关键词未命中：${shown}` }
    }

    if (!entry.selective || entry.secondaryKeys.length === 0) {
      return { entry, matched: true, reason: `主关键词命中：${primaryHits.join('、')}` }
    }

    const secondaryHits = entry.secondaryKeys.filter((k) => contains(text, k, caseSensitive))
    const allHit = secondaryHits.length === entry.secondaryKeys.length
    const noneHit = secondaryHits.length === 0
    const logic = entry.selectiveLogic

    const pass =
      logic === 1 ? !allHit : logic === 2 ? noneHit : logic === 3 ? allHit : secondaryHits.length > 0

    const label = LOGIC_LABEL[logic] ?? '任一'
    const detail =
      secondaryHits.length > 0 ? `次级命中：${secondaryHits.join('、')}` : '次级一个都没命中'

    return pass
      ? {
          entry,
          matched: true,
          reason: `主关键词命中：${primaryHits.join('、')}；次级「${label}」满足（${detail}）`,
        }
      : {
          entry,
          matched: false,
          reason: `主关键词命中：${primaryHits.join('、')}；但次级「${label}」不满足（${detail}）`,
        }
  })
}
