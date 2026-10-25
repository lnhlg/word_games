import { Hono } from 'hono'
import { isPng, extractCardFromPng, stripCardTextChunks } from '../tavern/png.ts'
import { normalizeCard } from '../tavern/card.ts'
import { parseLorebook } from '../tavern/lorebook.ts'
import { parsePreset } from '../tavern/preset.ts'

const MAX_BYTES = 8 * 1024 * 1024

export const importRoutes = new Hono()

importRoutes.post('/card', async (c) => {
  const form = await c.req.parseBody().catch(() => null)
  if (!form) return c.json({ error: '读不出上传内容，请重新选择文件。' }, 400)

  const file = form['file']
  if (!(file instanceof File)) {
    return c.json({ error: '没有收到文件。' }, 400)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length === 0) return c.json({ error: '文件是空的。' }, 400)
  if (bytes.length > MAX_BYTES) return c.json({ error: '文件超过 8MB，太大了。' }, 400)

  try {
    if (isPng(bytes)) {
      const { json } = extractCardFromPng(bytes)
      const { body, fidelity } = normalizeCard(json)
      // 头像只留像素：卡数据已经进 body 了，不必在图片里再存一份
      const avatar = stripCardTextChunks(bytes)
      return c.json({
        draft: body,
        fidelity,
        avatarDataUrl: `data:image/png;base64,${Buffer.from(avatar).toString('base64')}`,
        sourceName: file.name,
      })
    }

    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return c.json({ error: '文件既不是 PNG，也不是 UTF-8 文本。' }, 400)
    }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return c.json({ error: '这个文件不是合法的 JSON。' }, 400)
    }

    const { body, fidelity } = normalizeCard(json)
    return c.json({ draft: body, fidelity, sourceName: file.name })
  } catch (error) {
    const message = error instanceof Error ? error.message : '导入失败。'
    return c.json({ error: message }, 400)
  }
})

importRoutes.post('/lorebook', async (c) => {
  const form = await c.req.parseBody().catch(() => null)
  if (!form) return c.json({ error: '读不出上传内容，请重新选择文件。' }, 400)

  const file = form['file']
  if (!(file instanceof File)) {
    return c.json({ error: '没有收到文件。' }, 400)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length === 0) return c.json({ error: '文件是空的。' }, 400)
  if (bytes.length > MAX_BYTES) return c.json({ error: '文件超过 8MB，太大了。' }, 400)

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return c.json({ error: '世界书应该是 UTF-8 的 JSON 文件。' }, 400)
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return c.json({ error: '这个文件不是合法的 JSON。' }, 400)
  }

  try {
    const fallbackName = file.name.replace(/\.json$/i, '')
    const book = parseLorebook(json, fallbackName)
    return c.json({ name: book.name, body: book, sourceName: file.name })
  } catch (error) {
    const message = error instanceof Error ? error.message : '解析世界书失败。'
    return c.json({ error: message }, 400)
  }
})

importRoutes.post('/preset', async (c) => {
  const form = await c.req.parseBody().catch(() => null)
  if (!form) return c.json({ error: '读不出上传内容，请重新选择文件。' }, 400)

  const file = form['file']
  if (!(file instanceof File)) {
    return c.json({ error: '没有收到文件。' }, 400)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length === 0) return c.json({ error: '文件是空的。' }, 400)
  if (bytes.length > MAX_BYTES) return c.json({ error: '文件超过 8MB，太大了。' }, 400)

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return c.json({ error: '预设应该是 UTF-8 的 JSON 文件。' }, 400)
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return c.json({ error: '这个文件不是合法的 JSON。' }, 400)
  }

  try {
    const fallbackName = file.name.replace(/\.json$/i, '')
    const { preset, warnings } = parsePreset(json, fallbackName)
    return c.json({ name: preset.name, body: preset, warnings, sourceName: file.name })
  } catch (error) {
    const message = error instanceof Error ? error.message : '解析预设失败。'
    return c.json({ error: message }, 400)
  }
})
