import type { Preset, PresetParams, PresetPrompt, PresetRole } from '../shared/types.ts'

/** 内置槽位的中文显示名。identifier 是稳定键，名字只是给人看的。 */
export const BUILTIN_NAMES: Record<string, string> = {
  main: '主提示',
  worldInfoBefore: '世界书（角色定义前）',
  worldInfoAfter: '世界书（角色定义后）',
  personaDescription: '用户人设',
  charDescription: '角色描述',
  charPersonality: '角色性格',
  scenario: '场景',
  enhanceDefinitions: '强化定义',
  nsfw: '内容分级',
  dialogueExamples: '示例对话',
  chatHistory: '对话历史',
  jailbreak: '越狱提示',
  auxiliaryPrompt: '辅助提示',
}

/** 这些槽位没有静态文本，运行时由装配器填入实际内容。 */
export const BUILTIN_MARKERS = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'dialogueExamples',
  'chatHistory',
])

const DEFAULT_CONTENT: Record<string, string> = {
  main: 'Write {{char}}\'s next reply in a fictional chat between {{char}} and {{user}}.',
  jailbreak: '',
  nsfw: '',
}

/** 与酒馆默认预设一致的槽位顺序（enhanceDefinitions 默认关闭）。 */
export const DEFAULT_ORDER = [
  'main',
  'worldInfoBefore',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'enhanceDefinitions',
  'nsfw',
  'worldInfoAfter',
  'dialogueExamples',
  'chatHistory',
  'jailbreak',
]

/** 默认关掉的槽位 */
const DEFAULT_DISABLED = new Set(['enhanceDefinitions'])

export function defaultPreset(): Preset {
  return {
    name: '默认预设',
    params: {
      temperature: 1,
      topP: 1,
      topK: 0,
      repetitionPenalty: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxContext: 4095,
      maxTokens: 300,
    },
    prompts: DEFAULT_ORDER.map((identifier) => ({
      identifier,
      name: BUILTIN_NAMES[identifier] ?? identifier,
      content: DEFAULT_CONTENT[identifier] ?? '',
      role: 'system' as PresetRole,
      systemPrompt: true,
      marker: BUILTIN_MARKERS.has(identifier),
      enabled: !DEFAULT_DISABLED.has(identifier),
    })),
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

interface RawPrompt {
  identifier?: unknown
  name?: unknown
  content?: unknown
  role?: unknown
  system_prompt?: unknown
  marker?: unknown
}

interface RawOrderItem {
  identifier?: unknown
  enabled?: unknown
}

export interface ParsedPreset {
  preset: Preset
  /** 解析时遇到的不认识的东西，界面上要能看到 */
  warnings: string[]
}

/**
 * 解析酒馆的 Chat Completion 预设。
 * prompt_order 里可能有多套顺序（character_id 不同），取第一套——
 * 官方没解释这个 ID 的语义，本项目按「默认顺序」处理。
 */
export function parsePreset(raw: unknown, fallbackName = '未命名预设'): ParsedPreset {
  if (!raw || typeof raw !== 'object') {
    throw new Error('预设内容不是一个 JSON 对象。')
  }

  const source = raw as Record<string, unknown>
  const warnings: string[] = []

  const params: PresetParams = {
    temperature: num(source.temperature, 1),
    topP: num(source.top_p, 1),
    topK: num(source.top_k, 0),
    repetitionPenalty: num(source.repetition_penalty, 1),
    frequencyPenalty: num(source.frequency_penalty, 0),
    presencePenalty: num(source.presence_penalty, 0),
    maxContext: num(source.openai_max_context, num(source.max_context, 4095)),
    maxTokens: num(source.openai_max_tokens, num(source.max_tokens, 300)),
  }

  const rawPrompts = Array.isArray(source.prompts) ? (source.prompts as RawPrompt[]) : []
  const byIdentifier = new Map<string, RawPrompt>()
  for (const item of rawPrompts) {
    if (item && typeof item.identifier === 'string') {
      byIdentifier.set(item.identifier, item)
    }
  }

  let order: RawOrderItem[] = []
  if (Array.isArray(source.prompt_order) && source.prompt_order.length > 0) {
    const first = source.prompt_order[0] as { order?: unknown }
    if (Array.isArray(first?.order)) {
      order = first.order as RawOrderItem[]
    }
  } else {
    warnings.push('预设里没有 prompt_order，按 prompts 数组的原顺序装配。')
  }

  const prompts: PresetPrompt[] = []

  if (order.length > 0) {
    for (const item of order) {
      const identifier = typeof item.identifier === 'string' ? item.identifier : ''
      if (!identifier) continue
      const rawPrompt = byIdentifier.get(identifier)
      const marker = BUILTIN_MARKERS.has(identifier) || rawPrompt?.marker === true

      if (!rawPrompt && !BUILTIN_NAMES[identifier]) {
        warnings.push(`排布里有一个不认识的槽位「${identifier}」，已保留但不知道它该填什么。`)
      }

      prompts.push({
        identifier,
        name:
          typeof rawPrompt?.name === 'string' && rawPrompt.name
            ? rawPrompt.name
            : (BUILTIN_NAMES[identifier] ?? identifier),
        content: marker ? '' : typeof rawPrompt?.content === 'string' ? rawPrompt.content : '',
        role:
          rawPrompt?.role === 'user' || rawPrompt?.role === 'assistant'
            ? rawPrompt.role
            : 'system',
        systemPrompt: rawPrompt?.system_prompt !== false,
        marker,
        enabled: item.enabled !== false,
      })
    }
  } else {
    for (const identifier of byIdentifier.keys()) {
      const rawPrompt = byIdentifier.get(identifier)!
      const marker = BUILTIN_MARKERS.has(identifier) || rawPrompt.marker === true
      prompts.push({
        identifier,
        name:
          typeof rawPrompt.name === 'string' && rawPrompt.name
            ? rawPrompt.name
            : (BUILTIN_NAMES[identifier] ?? identifier),
        content: marker ? '' : typeof rawPrompt.content === 'string' ? rawPrompt.content : '',
        role: rawPrompt.role === 'user' || rawPrompt.role === 'assistant' ? rawPrompt.role : 'system',
        systemPrompt: rawPrompt.system_prompt !== false,
        marker,
        enabled: true,
      })
    }
  }

  // prompts 里有、排布里没有的，追加到末尾，不静默丢弃
  for (const [identifier, rawPrompt] of byIdentifier) {
    if (prompts.some((p) => p.identifier === identifier)) continue
    const marker = BUILTIN_MARKERS.has(identifier) || rawPrompt.marker === true
    prompts.push({
      identifier,
      name:
        typeof rawPrompt.name === 'string' && rawPrompt.name
          ? rawPrompt.name
          : (BUILTIN_NAMES[identifier] ?? identifier),
      content: marker ? '' : typeof rawPrompt.content === 'string' ? rawPrompt.content : '',
      role: rawPrompt.role === 'user' || rawPrompt.role === 'assistant' ? rawPrompt.role : 'system',
      systemPrompt: rawPrompt.system_prompt !== false,
      marker,
      enabled: true,
    })
    warnings.push(`槽位「${BUILTIN_NAMES[identifier] ?? identifier}」不在排布里，已追加到末尾。`)
  }

  const name =
    typeof source.name === 'string' && source.name.trim()
      ? source.name.trim()
      : typeof source.preset_name === 'string' && source.preset_name.trim()
        ? source.preset_name.trim()
        : fallbackName

  return { preset: { name, params, prompts }, warnings }
}

/** 本项目内部格式原样返回；酒馆格式走 parsePreset。 */
export function normalizePreset(raw: unknown, fallbackName = '未命名预设'): Preset {
  if (
    raw &&
    typeof raw === 'object' &&
    'params' in raw &&
    'prompts' in raw &&
    Array.isArray((raw as Preset).prompts)
  ) {
    return raw as Preset
  }
  return parsePreset(raw, fallbackName).preset
}

/**
 * 从预设里找出「助手已经说出口的话」——酒馆的 assistant prefill。
 *
 * 越狱预设的典型写法是在段尾放一句 `Assistant：OK，`，
 * 酒馆把它当成对话的一部分，模型接着它往下写，等于「已经同意了」。
 * 这里按 prompt 顺序扫，取最后出现的那一句。
 */
export function extractPrefill(preset: Preset): string {
  let found = ''

  for (const prompt of preset.prompts) {
    if (!prompt.content) continue
    const matches = [
      ...prompt.content.matchAll(/^[ \t]*(?:Assistant|assistant|AI)[ \t]*[:：][ \t]*(.+?)[ \t]*$/gm),
    ]
    if (matches.length === 0) continue

    const last = matches[matches.length - 1][1].trim()
    if (last) found = last
  }

  return found
}
