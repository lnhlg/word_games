import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { activeProvider, loadSettings, newProvider, publicSettings, saveSettings } from './settings.ts'
import type { LlmProvider } from './settings.ts'
import { chatCompletion, listModels, LlmError } from './llm.ts'

export const settingsRoutes = new Hono()

settingsRoutes.get('/', (c) => c.json(publicSettings()))

/** 全量保存供应商列表。密钥留空表示"沿用原来的"，避免掩码覆盖真值。 */
settingsRoutes.put('/', async (c) => {
  const input = (await c.req.json().catch(() => ({}))) as {
    providers?: unknown
    activeId?: unknown
  }

  const current = loadSettings()
  const incoming = Array.isArray(input.providers) ? input.providers : []

  const providers: LlmProvider[] = incoming
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
    .map((p) => {
      const id = typeof p.id === 'string' && p.id ? p.id : randomUUID()
      const existing = current.providers.find((x) => x.id === id)
      const typedKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : ''

      return {
        id,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : '未命名',
        apiBase:
          typeof p.apiBase === 'string' && p.apiBase.trim()
            ? p.apiBase.trim()
            : 'https://api.openai.com/v1',
        apiKey: typedKey || existing?.apiKey || '',
        model: typeof p.model === 'string' ? p.model.trim() : '',
        models: Array.isArray(p.models)
          ? p.models.filter((m): m is string => typeof m === 'string').slice(0, 200)
          : [],
      }
    })

  saveSettings({
    providers,
    activeId: typeof input.activeId === 'string' ? input.activeId : '',
  })

  return c.json(publicSettings())
})

function pickProvider(id: string | undefined): LlmProvider | null {
  if (id) {
    const found = loadSettings().providers.find((p) => p.id === id)
    if (found) return found
  }
  return activeProvider()
}

/** 拉某个供应商的模型列表（默认当前在用的那个）。 */
settingsRoutes.get('/models', async (c) => {
  const provider = pickProvider(c.req.query('providerId') ?? undefined)

  if (!provider) return c.json({ error: '还没有配置任何供应商。' }, 400)
  if (!provider.apiKey) {
    return c.json({ error: `「${provider.name}」还没有填 API 密钥。` }, 400)
  }

  try {
    const models = await listModels(provider.apiBase, provider.apiKey)
    return c.json({ models })
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '获取模型列表失败'
    return c.json({ error: message }, 400)
  }
})

/** 用某个供应商发一个极小的请求，把错误分类讲清楚。 */
settingsRoutes.post('/test', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { providerId?: unknown }
  const provider = pickProvider(
    typeof body.providerId === 'string' ? body.providerId : undefined,
  )

  if (!provider) return c.json({ ok: false, error: '还没有配置任何供应商。' }, 400)
  if (!provider.apiKey) {
    return c.json({ ok: false, error: `「${provider.name}」还没有填 API 密钥。` }, 400)
  }
  if (!provider.model) {
    return c.json({ ok: false, error: `「${provider.name}」还没有选模型。` }, 400)
  }

  try {
    const result = await chatCompletion({
      apiBase: provider.apiBase,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [{ role: 'user', content: '回复一个词：收到' }],
      maxTokens: 200,
    })
    return c.json({ ok: true, reply: result.content.slice(0, 40) })
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '连接失败'
    return c.json({ ok: false, error: message }, 400)
  }
})

/** 给前端一个空白的供应商模板。 */
settingsRoutes.get('/new', (c) => c.json(newProvider()))
