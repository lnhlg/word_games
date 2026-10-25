import { randomUUID } from 'node:crypto'
import { db } from './db.ts'
import type { PublicProvider, PublicSettings } from '../shared/types.ts'

const SETTINGS_KEY = 'llm'

export interface LlmProvider {
  id: string
  /** 显示名，例如 DeepSeek、本地 Ollama */
  name: string
  apiBase: string
  apiKey: string
  /** 这个供应商下当前选中的模型 */
  model: string
  models: string[]
}

export interface LlmSettings {
  providers: LlmProvider[]
  /** 当前使用哪个供应商 */
  activeId: string
}

const DEFAULTS: LlmSettings = { providers: [], activeId: '' }

export function newProvider(name = '新供应商'): LlmProvider {
  return {
    id: randomUUID(),
    name,
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    models: [],
  }
}

/** 老版本只有一组配置，读到就迁成一条供应商记录。 */
function migrate(parsed: Record<string, unknown>): LlmSettings {
  if (Array.isArray(parsed.providers)) {
    const providers = (parsed.providers as Array<Partial<LlmProvider>>)
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : '未命名',
        apiBase: typeof p.apiBase === 'string' ? p.apiBase : 'https://api.openai.com/v1',
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
        model: typeof p.model === 'string' ? p.model : '',
        models: Array.isArray(p.models)
          ? p.models.filter((m): m is string => typeof m === 'string')
          : [],
      }))

    const activeId =
      typeof parsed.activeId === 'string' && providers.some((p) => p.id === parsed.activeId)
        ? parsed.activeId
        : (providers[0]?.id ?? '')

    return { providers, activeId }
  }

  // 旧结构：{ apiBase, apiKey, model, models }
  if (typeof parsed.apiBase === 'string' || typeof parsed.apiKey === 'string') {
    const provider: LlmProvider = {
      id: randomUUID(),
      name: '默认供应商',
      apiBase: typeof parsed.apiBase === 'string' ? parsed.apiBase : 'https://api.openai.com/v1',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      models: Array.isArray(parsed.models)
        ? parsed.models.filter((m): m is string => typeof m === 'string')
        : [],
    }
    return { providers: [provider], activeId: provider.id }
  }

  return { ...DEFAULTS }
}

export function loadSettings(): LlmSettings {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(SETTINGS_KEY) as { value: string } | undefined

  if (!row) return { ...DEFAULTS, providers: [] }

  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>
    const migrated = migrate(parsed)

    // 老结构每次读都会生成新 id，必须迁完立刻落盘，否则 id 会一直变
    if (!Array.isArray(parsed.providers)) {
      return saveSettings(migrated)
    }

    return migrated
  } catch {
    return { ...DEFAULTS, providers: [] }
  }
}

export function saveSettings(next: LlmSettings): LlmSettings {
  const providers = next.providers.map((p) => ({
    ...p,
    name: p.name.trim() || '未命名',
    models: Array.from(new Set(p.models.filter((m) => typeof m === 'string' && m.trim()))),
  }))
  const activeId = providers.some((p) => p.id === next.activeId)
    ? next.activeId
    : (providers[0]?.id ?? '')

  const value: LlmSettings = { providers, activeId }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SETTINGS_KEY, JSON.stringify(value))

  return value
}

/** 当前在用的供应商；没配置时为 null。 */
export function activeProvider(): LlmProvider | null {
  const s = loadSettings()
  return s.providers.find((p) => p.id === s.activeId) ?? s.providers[0] ?? null
}

function toPublic(p: LlmProvider): PublicProvider {
  return {
    id: p.id,
    name: p.name,
    apiBase: p.apiBase,
    model: p.model,
    models: p.models,
    hasApiKey: p.apiKey.length > 0,
  }
}

/** 给前端看的版本：密钥只暴露"有没有配"。 */
export function publicSettings(): PublicSettings {
  const s = loadSettings()
  return {
    providers: s.providers.map(toPublic),
    activeId: s.activeId,
  }
}
