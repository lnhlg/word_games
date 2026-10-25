import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { db } from './db.ts'
import type {
  CreateMaterialInput,
  MaterialKind,
  MaterialMeta,
  MaterialOrigin,
} from '../shared/types.ts'

const KINDS: MaterialKind[] = ['card', 'lorebook', 'preset']
const AVATAR_DIR = resolve(process.cwd(), 'data', 'avatars')
const MAX_AVATAR_BYTES = 8 * 1024 * 1024

interface MaterialRow {
  id: string
  kind: string
  name: string
  origin: string
  body_json: string
  avatar_path: string | null
  created_at: number
  updated_at: number
}

function toMeta(row: MaterialRow): MaterialMeta {
  return {
    id: row.id,
    kind: row.kind as MaterialKind,
    name: row.name,
    origin: row.origin as MaterialOrigin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 带上版本号：换头像后 URL 必须变，否则浏览器会一直显示缓存里的旧图
    avatarUrl: row.avatar_path
      ? `/api/materials/${row.id}/avatar?v=${row.updated_at}`
      : undefined,
  }
}

/** 把 data URL 落盘，返回相对 data/ 的路径；不合规就返回 null（不阻断保存）。 */
function persistAvatar(id: string, dataUrl: string | undefined): string | null {
  if (!dataUrl) return null

  const match = /^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(dataUrl)
  if (!match) return null

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) return null

  mkdirSync(AVATAR_DIR, { recursive: true })
  const relative = `avatars/${id}.${ext}`
  writeFileSync(resolve(process.cwd(), 'data', relative), buffer)
  return relative
}

export const materialsRoutes = new Hono()

materialsRoutes.get('/', (c) => {
  const kind = c.req.query('kind')
  const rows = kind
    ? (db
        .prepare('SELECT * FROM materials WHERE kind = ? ORDER BY created_at DESC')
        .all(kind) as unknown as MaterialRow[])
    : (db.prepare('SELECT * FROM materials ORDER BY created_at DESC').all() as unknown as MaterialRow[])

  return c.json(rows.map(toMeta))
})

materialsRoutes.get('/:id', (c) => {
  const row = db
    .prepare('SELECT * FROM materials WHERE id = ?')
    .get(c.req.param('id')) as unknown as MaterialRow | undefined

  if (!row) return c.json({ error: '素材不存在' }, 404)

  return c.json({ ...toMeta(row), body: JSON.parse(row.body_json) })
})

materialsRoutes.get('/:id/avatar', (c) => {
  const row = db
    .prepare('SELECT * FROM materials WHERE id = ?')
    .get(c.req.param('id')) as unknown as MaterialRow | undefined

  if (!row?.avatar_path) return c.json({ error: '没有头像' }, 404)

  const file = resolve(process.cwd(), 'data', row.avatar_path)
  if (!existsSync(file)) return c.json({ error: '头像文件丢失' }, 404)

  const ext = row.avatar_path.split('.').pop()?.toLowerCase()
  const type = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'

  return new Response(new Uint8Array(readFileSync(file)), {
    headers: {
      'Content-Type': type,
      // URL 带版本号，可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

materialsRoutes.post('/', async (c) => {
  const input = (await c.req.json()) as CreateMaterialInput

  if (!input || !KINDS.includes(input.kind)) {
    return c.json({ error: 'kind 必须是 card / lorebook / preset' }, 400)
  }
  if (!input.name || !input.name.trim()) {
    return c.json({ error: '名字不能为空' }, 400)
  }

  const now = Date.now()
  const id = randomUUID()
  const origin: MaterialOrigin = input.origin ?? 'authored'
  const avatarPath = persistAvatar(id, input.avatarDataUrl ?? undefined)

  db.prepare(
    `INSERT INTO materials (id, kind, name, origin, body_json, origin_json, fidelity_json, avatar_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(id, input.kind, input.name.trim(), origin, JSON.stringify(input.body ?? {}), avatarPath, now, now)

  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as unknown as MaterialRow

  return c.json(toMeta(row), 201)
})

materialsRoutes.put('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = db
    .prepare('SELECT * FROM materials WHERE id = ?')
    .get(id) as unknown as MaterialRow | undefined

  if (!existing) return c.json({ error: '素材不存在' }, 404)

  const input = (await c.req.json()) as Partial<CreateMaterialInput>

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : existing.name
  const body = input.body !== undefined ? input.body : JSON.parse(existing.body_json)
  const origin =
    input.origin === 'imported' || input.origin === 'authored' ? input.origin : existing.origin

  let avatarPath = existing.avatar_path
  if (input.avatarDataUrl === null) {
    // 明确要求移除
    if (existing.avatar_path) {
      try {
        rmSync(resolve(process.cwd(), 'data', existing.avatar_path), { force: true })
      } catch {
        // 删不掉不影响记录更新
      }
    }
    avatarPath = null
  } else if (typeof input.avatarDataUrl === 'string' && input.avatarDataUrl) {
    avatarPath = persistAvatar(id, input.avatarDataUrl) ?? existing.avatar_path
  }

  db.prepare(
    `UPDATE materials SET name = ?, body_json = ?, origin = ?, avatar_path = ?, updated_at = ? WHERE id = ?`,
  ).run(name, JSON.stringify(body), origin, avatarPath, Date.now(), id)

  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as unknown as MaterialRow
  return c.json(toMeta(row))
})

materialsRoutes.delete('/:id', (c) => {
  const id = c.req.param('id')
  const force = c.req.query('force') === '1'

  const row = db
    .prepare('SELECT * FROM materials WHERE id = ?')
    .get(id) as unknown as MaterialRow | undefined

  if (!row) return c.json({ error: '素材不存在' }, 404)

  // 被对局引用时先拦一下：已冻结进对局的内容不会因此消失，
  // 但用户应该知道删的是"还在用的素材"
  if (!force) {
    const refs = db
      .prepare(
        `SELECT DISTINCT p.title FROM cast_members c
         JOIN playthroughs p ON p.id = c.playthrough_id
         WHERE c.material_id = ?`,
      )
      .all(id) as unknown as Array<{ title: string }>

    if (refs.length > 0) {
      return c.json(
        {
          error: `这个素材被 ${refs.length} 局用到（${refs.map((r) => r.title).join('、')}）。已开的局用的是开局时的快照，删掉不影响它们。`,
          referencedBy: refs.map((r) => r.title),
        },
        409,
      )
    }
  }

  db.prepare('DELETE FROM materials WHERE id = ?').run(id)

  // 顺手清掉头像，别留下孤儿文件
  if (row.avatar_path) {
    try {
      rmSync(resolve(process.cwd(), 'data', row.avatar_path), { force: true })
    } catch {
      // 删不掉就算了，不影响主流程
    }
  }

  return c.json({ ok: true })
})
