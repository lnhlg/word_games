import type { Fork, GameState, ParsedBeat } from '../shared/types.ts'

const SECTION_RE = /【(正文|状态|岔路)】/g

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeState(raw: unknown): GameState {
  const source = (raw ?? {}) as Record<string, unknown>
  const scene = (source.scene ?? {}) as Record<string, unknown>

  const relations = Array.isArray(source.relations)
    ? source.relations
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          a: asString(item.a),
          b: asString(item.b),
          note: asString(item.note),
        }))
        .filter((item) => item.a || item.b || item.note)
    : []

  // 角色状态：{ "黄蓉": { "心情": "...", "身体": "..." } }
  const characters: Record<string, Record<string, string>> = {}
  if (source.characters && typeof source.characters === 'object' && !Array.isArray(source.characters)) {
    for (const [name, fields] of Object.entries(source.characters as Record<string, unknown>)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue
      const normalized: Record<string, string> = {}
      for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) normalized[key] = value.trim()
        else if (typeof value === 'number') normalized[key] = String(value)
      }
      if (Object.keys(normalized).length > 0) characters[name] = normalized
    }
  }

  return {
    scene: { location: asString(scene.location), time: asString(scene.time) },
    present: Array.isArray(source.present)
      ? source.present.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [],
    relations,
    notes: Array.isArray(source.notes)
      ? source.notes.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [],
    characters,
  }
}

/** 只解析岔路段（「换一批走向」时模型只输出这一段）。 */
export function parseForksFromText(text: string): Fork[] {
  return parseForks(text)
}

function parseForks(text: string): Fork[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const forks: Fork[] = []
  for (const line of lines.slice(0, 6)) {
    const cleaned = line.replace(/^\d+\s*[.、)）]\s*/, '').replace(/^[-*·]\s*/, '')
    if (!cleaned) continue

    const parts = cleaned.split(/\s*(?:→|->|=>|—>)\s*/)
    if (parts.length >= 2) {
      forks.push({ trigger: parts[0].trim(), toward: parts.slice(1).join(' ').trim() })
    } else {
      forks.push({ trigger: cleaned, toward: '' })
    }
    if (forks.length === 3) break
  }

  return forks
}

/**
 * 把一次模型输出拆成正文 / 状态 / 岔路。
 * 任意一段缺失或损坏都只降级那一段——正文永远保留。
 */
export function parseBeat(raw: string): ParsedBeat {
  const warnings: string[] = []
  const text = raw.trim()

  if (!text) {
    return { narration: '', warnings: ['模型返回了空内容。'] }
  }

  const marks: Array<{ key: string; index: number }> = []
  for (const match of text.matchAll(SECTION_RE)) {
    marks.push({ key: match[1], index: match.index ?? 0 })
  }

  if (marks.length === 0) {
    return {
      narration: text,
      warnings: ['模型没有按三段格式输出，整段当作正文。'],
    }
  }

  const sections: Record<string, string> = {}
  marks.forEach((mark, i) => {
    const start = mark.index + `【${mark.key}】`.length
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length
    sections[mark.key] = text.slice(start, end).trim()
  })

  const narration = sections['正文'] ?? ''
  if (!narration) warnings.push('这一拍没有正文段。')

  let state: GameState | undefined
  const stateRaw = sections['状态']
  if (stateRaw) {
    try {
      state = normalizeState(JSON.parse(stateRaw))
    } catch {
      warnings.push('状态段不是合法 JSON，这一拍状态未记录。')
    }
  } else {
    warnings.push('模型没有给出状态段。')
  }

  let forks: Fork[] | undefined
  const forksRaw = sections['岔路']
  if (forksRaw) {
    const parsed = parseForks(forksRaw)
    if (parsed.length > 0) forks = parsed
    else warnings.push('岔路段没有解析出有效条目。')
  }

  return { narration: narration || text, state, forks, warnings }
}

/** 流式显示时只要正文：把后面的状态与岔路切掉。 */
export function narrationOnly(raw: string): string {
  const cut = raw.search(/【(状态|岔路)】/)
  return cut >= 0 ? raw.slice(0, cut) : raw
}

const REFUSAL_PATTERNS = [
  /I cannot fulfill/i,
  /I can(?:'|')t (?:help|assist|fulfill|comply|create|generate)/i,
  /I(?:'|')m sorry,? but I (?:can|cannot|won)/i,
  /I am programmed to be/i,
  /my safety guidelines/i,
  /As an AI (?:language )?model/i,
  /我无法(?:满足|提供|协助|生成|继续)/,
  /作为(?:一个)?\s*AI/,
  /抱歉[，,]?\s*我(?:不能|无法)/,
]

/**
 * 认出「模型拒答」。拒答不是正文，绝不该当成一拍存下来。
 * 只在内容够短时判定，避免把正文里角色说的「我不能」误杀。
 */
export function detectRefusal(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // 正常一拍是 400–900 字；拒答通常很短
  if (trimmed.length > 600) return null

  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(trimmed)) return trimmed
  }
  return null
}
