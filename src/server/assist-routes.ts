import { Hono } from 'hono'
import { buildCardDraftMessages, buildRevisionMessages, parseCardDraft, parseCardRevision } from './assist.ts'
import { chatCompletion, LlmError } from './llm.ts'
import { activeProvider } from './settings.ts'
import type { CardBody } from '../shared/types.ts'

export const assistRoutes = new Hono()

assistRoutes.post('/card', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { brief?: unknown }
  const brief = typeof body.brief === 'string' ? body.brief.trim() : ''

  if (!brief) {
    return c.json({ error: '先写一句你想要的角色。' }, 400)
  }

  const provider = activeProvider()
  if (!provider?.apiKey) {
    return c.json({ error: '还没有配置模型。先去右上角「设置」里填 API 地址、密钥与模型名。' }, 400)
  }
  if (!provider.model) {
    return c.json({ error: '还没有填模型名。去「设置」里补上。' }, 400)
  }

  try {
    const result = await chatCompletion({
      apiBase: provider.apiBase, apiKey: provider.apiKey, model: provider.model,
      messages: buildCardDraftMessages(brief),
      temperature: 0.9,
      // 描述 600–1000 字，加其余字段，需要更宽的额度
      maxTokens: 8000,
    })

    try {
      return c.json(parseCardDraft(result.content))
    } catch (parseError) {
      if (result.finishReason === 'length') {
        return c.json(
          {
            error:
              '模型的输出被截断了——它写得太长，没写完 JSON。把需求写得更聚焦一点，或者换一个输出上限更高的模型再试。',
          },
          400,
        )
      }
      throw parseError
    }
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '起草失败，请重试。'
    return c.json({ error: message }, 400)
  }
})

assistRoutes.post('/revise-card', async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as {
    body?: unknown
    instruction?: unknown
  }

  const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : ''
  if (!instruction) {
    return c.json({ error: '先写一句要改什么。' }, 400)
  }

  const body = payload.body as CardBody | undefined
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: '这张卡没有名字，先补上名字再让 AI 改。' }, 400)
  }

  const provider = activeProvider()
  if (!provider?.apiKey) {
    return c.json({ error: '还没有配置模型。先去右上角「设置」里填。' }, 400)
  }
  if (!provider.model) {
    return c.json({ error: '还没有填模型名。去「设置」里补上。' }, 400)
  }

  try {
    const result = await chatCompletion({
      apiBase: provider.apiBase, apiKey: provider.apiKey, model: provider.model,
      messages: buildRevisionMessages(body, instruction),
      temperature: 0.7,
      maxTokens: 8000,
    })

    try {
      return c.json(parseCardRevision(result.content, body))
    } catch (parseError) {
      if (result.finishReason === 'length') {
        return c.json(
          { error: '模型的输出被截断了——它写得太长。把指令说得更具体一点再试。' },
          400,
        )
      }
      throw parseError
    }
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '修改失败，请重试。'
    return c.json({ error: message }, 400)
  }
})
