import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { db } from './db.ts'
import { activateEntries, parseLorebook } from '../tavern/lorebook.ts'
import type { CardBody } from '../shared/types.ts'

export const lorebookRoutes = new Hono()

interface MaterialRow {
  id: string
  name: string
  body_json: string
}

/**
 * 把所有角色卡的内嵌世界书一次性拆成独立世界书。
 * 同名的已经存在就跳过，不覆盖用户改过的内容。
 */
lorebookRoutes.post('/extract-from-cards', (c) => {
  const cardRows = db
    .prepare("SELECT * FROM materials WHERE kind = 'card' ORDER BY created_at")
    .all() as unknown as MaterialRow[]

  const bookRows = db
    .prepare("SELECT name FROM materials WHERE kind = 'lorebook'")
    .all() as unknown as Array<{ name: string }>

  const existing = new Set(bookRows.map((row) => row.name))
  const created: string[] = []
  const skipped: string[] = []
  const failed: Array<{ card: string; error: string }> = []

  const insert = db.prepare(
    `INSERT INTO materials (id, kind, name, origin, body_json, origin_json, fidelity_json, avatar_path, created_at, updated_at)
     VALUES (?, 'lorebook', ?, 'imported', ?, NULL, NULL, NULL, ?, ?)`,
  )

  for (const row of cardRows) {
    let body: CardBody
    try {
      body = JSON.parse(row.body_json) as CardBody
    } catch {
      continue
    }
    if (!body.characterBook) continue

    try {
      const book = parseLorebook(body.characterBook, `${body.name} · 世界书`)
      if (existing.has(book.name)) {
        skipped.push(book.name)
        continue
      }
      const now = Date.now()
      insert.run(randomUUID(), book.name, JSON.stringify(book), now, now)
      existing.add(book.name)
      created.push(book.name)
    } catch (error) {
      failed.push({
        card: body.name,
        error: error instanceof Error ? error.message : '解析失败',
      })
    }
  }

  return c.json({ created, skipped, failed })
})

/** 贴一段文本，看哪些条目会命中、以及为什么。 */
lorebookRoutes.post('/test-activation', async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as {
    book?: unknown
    text?: unknown
  }

  const text = typeof payload.text === 'string' ? payload.text : ''

  try {
    const book = parseLorebook(payload.book)
    const results = activateEntries(book.entries, text)
    return c.json({
      total: results.length,
      matched: results.filter((r) => r.matched).length,
      results: results.map((r) => ({
        id: r.entry.id,
        comment: r.entry.comment,
        keys: r.entry.keys,
        matched: r.matched,
        reason: r.reason,
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '解析世界书失败。'
    return c.json({ error: message }, 400)
  }
})
