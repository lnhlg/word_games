import type { CardBody, Lorebook, Preset, PresetPrompt } from '../shared/types.ts'
import { activateEntries } from '../tavern/lorebook.ts'

export interface Actor {
  name: string
  body: CardBody
}

export interface HistoryMessage {
  kind: 'director' | 'narration'
  content: string
}

export interface AssemblyInput {
  actors: Actor[]
  /** 这一拍在场的人；不在场的只在名单里占一行 */
  presentNames: string[]
  lorebook?: Lorebook
  preset: Preset
  /** 用于世界书激活的文本（最近对话 + 本轮指令） */
  scanText: string
  history?: HistoryMessage[]
  /** 压缩过的前情提要，插在最近对话之前 */
  memory?: string
  /** 本局自己的规则或提示词，排在导演补丁之前 */
  extraRules?: string
  /** {{user}} 的映射名。导演不在场，这里给一个视角名 */
  perspectiveName?: string
  budgetChars?: number
  /** 每拍字数区间，写进导演补丁 */
  beatRange?: { min: number; max: number }
}

export interface Section {
  identifier: string
  label: string
  source: string
  content: string
}

export interface AssemblyResult {
  sections: Section[]
  prompt: string
  charCount: number
  estimatedTokens: number
  budgetChars: number
  warnings: string[]
}

export const DEFAULT_BUDGET_CHARS = 24_000

/** 导演补丁：固定追加，不随预设变动。理由见 ADR 0003。 */
export function directorPatch(beatMin: number, beatMax: number): string {
  return [
    '【导演模式】',
    '你不是在扮演某一个角色，而是这部小说的叙述者：所有角色的对白与旁白都由你演出。',
    '- 不要写“你”。这部小说没有玩家角色，导演不在故事里。',
    '- 不要替导演做决定，也不要让角色知道剧外的事。',
    '- 禁止轮流发言式的流水账：谁说话由戏剧需要决定，不需要每个在场角色都开口。',
    `- 每段 ${beatMin}–${beatMax} 字，以小说笔法写，不总结、不跳场。`,
    '',
    '输出格式（三段，用方括号标记）：',
    '【正文】',
    '……',
    '【状态】',
    '{ "scene": {"location": "", "time": ""}, "present": [], "relations": [{"a":"","b":"","note":""}], "notes": [] }',
    '【岔路】',
    '1. 如果…… → 会把局面引向……',
    '2. ……',
    '3. ……',
  ].join('\n')
}

function applyMacros(text: string, charName: string, userName: string): string {
  return text.replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName)
}

function charField(prompt: PresetPrompt): keyof CardBody | null {
  if (prompt.identifier === 'charDescription') return 'description'
  if (prompt.identifier === 'charPersonality') return 'personality'
  if (prompt.identifier === 'scenario') return 'scenario'
  return null
}

/**
 * 把素材装配成最终 prompt。
 * 顺序完全由预设的排布决定；导演补丁永远在最后一段。
 */
export function assemble(input: AssemblyInput): AssemblyResult {
  const userName = input.perspectiveName?.trim() || '旅人'
  const budgetChars = input.budgetChars ?? DEFAULT_BUDGET_CHARS
  const beat = input.beatRange ?? { min: 400, max: 900 }

  const present = input.actors.filter((a) => input.presentNames.includes(a.name))
  const absent = input.actors.filter((a) => !input.presentNames.includes(a.name))
  const leadName = present[0]?.name ?? input.actors[0]?.name ?? ''

  const sections: Section[] = []
  const warnings: string[] = []

  const activation = input.lorebook
    ? activateEntries(input.lorebook.entries, input.scanText)
    : []
  const before = activation.filter((r) => r.matched && r.entry.position === 'before')
  const after = activation.filter((r) => r.matched && r.entry.position === 'after')

  if (activation.length > 0) {
    const matched = activation.filter((r) => r.matched).length
    if (matched === 0) {
      warnings.push(`世界书「${input.lorebook?.name}」一条都没命中。检查关键词，或者把关键条目设为常驻。`)
    }
  }

  for (const prompt of input.preset.prompts) {
    if (!prompt.enabled) continue

    const field = charField(prompt)

    if (field) {
      const parts: string[] = []
      for (const actor of present) {
        const value = actor.body[field]
        if (typeof value === 'string' && value.trim()) {
          parts.push(`【${actor.name}】\n${applyMacros(value, actor.name, userName)}`)
        }
      }
      if (absent.length > 0) {
        parts.push(`（不在场）${absent.map((a) => a.name).join('、')}`)
      }
      if (parts.length > 0) {
        sections.push({
          identifier: prompt.identifier,
          label: prompt.name,
          source: `演员表（${present.length} 人在场 / ${absent.length} 人不在场）`,
          content: parts.join('\n\n'),
        })
      }
      continue
    }

    if (prompt.identifier === 'worldInfoBefore' || prompt.identifier === 'worldInfoAfter') {
      const list = prompt.identifier === 'worldInfoBefore' ? before : after
      if (list.length === 0) continue
      sections.push({
        identifier: prompt.identifier,
        label: prompt.name,
        source: `世界书「${input.lorebook?.name ?? ''}」命中 ${list.length} 条`,
        content: list
          .map((r) => `〔${r.entry.comment || r.entry.keys[0] || '条目'}〕\n${r.entry.content}`)
          .join('\n\n'),
      })
      continue
    }

    if (prompt.identifier === 'dialogueExamples') {
      const examples = present
        .map((a) => a.body.mesExample)
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      if (examples.length > 0) {
        sections.push({
          identifier: prompt.identifier,
          label: prompt.name,
          source: '演员表示例对话',
          content: examples.map((ex) => applyMacros(ex, leadName, userName)).join('\n\n'),
        })
      }
      continue
    }

    if (prompt.identifier === 'chatHistory') {
      const history = input.history ?? []
      const parts: string[] = []

      if (input.memory?.trim()) {
        parts.push(`【前情】\n${input.memory.trim()}`)
      }
      if (history.length > 0) {
        parts.push(
          history.map((m) => (m.kind === 'director' ? `导演：${m.content}` : m.content)).join('\n\n'),
        )
      }

      if (parts.length > 0) {
        sections.push({
          identifier: prompt.identifier,
          label: prompt.name,
          source: input.memory ? `前情提要 + 最近 ${history.length} 条` : `最近 ${history.length} 条`,
          content: parts.join('\n\n'),
        })
      }
      continue
    }

    if (prompt.identifier === 'personaDescription') {
      warnings.push('「用户人设」槽位在导演模式下为空——导演不在故事里，没有可注入的人设。')
      continue
    }

    // main / jailbreak / nsfw / 自定义
    if (prompt.content.trim()) {
      sections.push({
        identifier: prompt.identifier,
        label: prompt.name,
        source: prompt.marker ? '占位（无静态文本）' : '预设文本',
        content: applyMacros(prompt.content, leadName, userName),
      })
    }
  }

  // 本局规则：排在导演补丁之前，导演补丁仍然收尾
  if (input.extraRules?.trim()) {
    sections.push({
      identifier: 'extra-rules',
      label: '本局规则',
      source: '对局设置',
      content: input.extraRules.trim(),
    })
  }

  // 永远最后一段
  sections.push({
    identifier: 'director-patch',
    label: '导演模式补丁',
    source: '内置 · 不可关闭',
    content: directorPatch(beat.min, beat.max),
  })

  const promptText = sections.map((s) => `### ${s.label}\n${s.content}`).join('\n\n')
  const charCount = promptText.length

  if (charCount > budgetChars) {
    warnings.push(
      `装配结果 ${charCount} 字，超出预算 ${budgetChars} 字。演出时会从最老的消息开始裁。`,
    )
  }

  return {
    sections,
    prompt: promptText,
    charCount,
    // 中文实测约 0.45–0.5 token/字（DeepSeek 上 17053 字 → 7787 prompt tokens）。
    // 早先按 0.7 估会高估一半，预算判断反而失真。
    estimatedTokens: Math.ceil(charCount * 0.5),
    budgetChars,
    warnings,
  }
}
