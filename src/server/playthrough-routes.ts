import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { db } from './db.ts'
import { activeProvider, loadSettings } from './settings.ts'
import type { LlmProvider } from './settings.ts'
import { chatCompletion, chatCompletionStream, LlmError } from './llm.ts'
import type { ReasoningEffort } from './llm.ts'
import { assemble, DEFAULT_BUDGET_CHARS, type HistoryMessage } from '../engine/assembly.ts'
import { detectRefusal, parseBeat, parseForksFromText } from '../engine/parse.ts'
import { buildPath } from '../engine/tree.ts'
import { normalizePreset } from '../tavern/preset.ts'
import { parseLorebook } from '../tavern/lorebook.ts'
import type { CardBody, CastTemplates } from '../shared/types.ts'

export const playthroughRoutes = new Hono()

interface PlaythroughRow {
  id: string
  title: string
  preset_json: string
  lorebook_json: string | null
  current_leaf_id: string | null
  memory_json: string | null
  cast_templates_json: string | null
  extra_rules: string | null
  provider_id: string | null
  model_override: string | null
  reasoning_effort: string | null
  jailbreak: string | null
  created_at: number
  updated_at: number
}

/**
 * 这一局该用哪个供应商：对局里指了就用它，否则用全局当前在用的。
 * 对局的模型覆盖只改模型名，不改地址与密钥。
 */
function providerFor(row: PlaythroughRow): LlmProvider | null {
  if (row.provider_id) {
    const found = loadSettings().providers.find((p) => p.id === row.provider_id)
    if (found) {
      return row.model_override ? { ...found, model: row.model_override } : found
    }
  }
  return activeProvider()
}

interface Memory {
  summary: string  /** 摘要覆盖到这一条为止（含）；之后的才进入最近对话 */
  coveredUntil: string
}

interface CastRow {
  id: string
  playthrough_id: string
  material_id: string | null
  name: string
  body_json: string
  sort_order: number
}

interface MessageRow {
  id: string
  playthrough_id: string
  parent_id: string | null
  kind: string
  content: string
  meta_json: string | null
  created_at: number
}

function loadCast(playthroughId: string): CastRow[] {
  return db
    .prepare('SELECT * FROM cast_members WHERE playthrough_id = ? ORDER BY sort_order')
    .all(playthroughId) as unknown as CastRow[]
}

function loadMessages(playthroughId: string): MessageRow[] {
  return db
    .prepare('SELECT * FROM messages WHERE playthrough_id = ? ORDER BY created_at')
    .all(playthroughId) as unknown as MessageRow[]
}

playthroughRoutes.get('/', (c) => {
  const rows = db
    .prepare('SELECT * FROM playthroughs ORDER BY updated_at DESC')
    .all() as unknown as PlaythroughRow[]

  return c.json(
    rows.map((row) => {
      const cast = loadCast(row.id)
      const count = (
        db
          .prepare('SELECT COUNT(*) AS n FROM messages WHERE playthrough_id = ?')
          .get(row.id) as { n: number }
      ).n
      return {
        id: row.id,
        title: row.title,
        castNames: cast.map((m) => m.name),
        messageCount: count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    }),
  )
})

playthroughRoutes.post('/', async (c) => {
  const input = (await c.req.json().catch(() => ({}))) as {
    title?: unknown
    cardIds?: unknown
    lorebookId?: unknown
    presetId?: unknown
  }

  const cardIds = Array.isArray(input.cardIds)
    ? input.cardIds.filter((id): id is string => typeof id === 'string')
    : []

  if (cardIds.length === 0) {
    return c.json({ error: '至少选一张角色卡当演员。' }, 400)
  }

  const cards: Array<{ id: string; name: string; body: CardBody }> = []
  for (const id of cardIds) {
    const row = db
      .prepare("SELECT * FROM materials WHERE id = ? AND kind = 'card'")
      .get(id) as unknown as { id: string; name: string; body_json: string } | undefined
    if (!row) return c.json({ error: `找不到角色卡（${id}）。` }, 400)
    cards.push({ id: row.id, name: row.name, body: JSON.parse(row.body_json) as CardBody })
  }

  // 预设与世界书：读不到就用空的，不阻断开局
  let presetJson = JSON.stringify(normalizePreset({}))
  if (typeof input.presetId === 'string' && input.presetId) {
    const row = db
      .prepare("SELECT body_json FROM materials WHERE id = ? AND kind = 'preset'")
      .get(input.presetId) as unknown as { body_json: string } | undefined
    if (!row) return c.json({ error: '找不到这份预设。' }, 400)
    presetJson = JSON.stringify(normalizePreset(JSON.parse(row.body_json)))
  }

  let lorebookJson: string | null = null
  if (typeof input.lorebookId === 'string' && input.lorebookId) {
    const row = db
      .prepare("SELECT body_json FROM materials WHERE id = ? AND kind = 'lorebook'")
      .get(input.lorebookId) as unknown as { body_json: string } | undefined
    if (!row) return c.json({ error: '找不到这份世界书。' }, 400)
    lorebookJson = JSON.stringify(parseLorebook(JSON.parse(row.body_json)))
  }

  const id = randomUUID()
  const now = Date.now()
  const title =
    typeof input.title === 'string' && input.title.trim()
      ? input.title.trim()
      : `${cards.map((card) => card.name).join('、')} 的一局`

  db.prepare(
    `INSERT INTO playthroughs (id, title, preset_json, lorebook_json, current_leaf_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, title, presetJson, lorebookJson, now, now)

  const insertCast = db.prepare(
    `INSERT INTO cast_members (id, playthrough_id, material_id, name, body_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  cards.forEach((card, index) => {
    // 冻结：把卡的内容复制进来，之后改素材不影响这一局
    insertCast.run(randomUUID(), id, card.id, card.name, JSON.stringify(card.body), index)
  })

  return c.json({ id, title }, 201)
})

playthroughRoutes.get('/:id', (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  return c.json({
    id: row.id,
    title: row.title,
    currentLeafId: row.current_leaf_id,
    memory: row.memory_json ? (JSON.parse(row.memory_json) as Memory) : null,
    templates: row.cast_templates_json
      ? (JSON.parse(row.cast_templates_json) as CastTemplates)
      : {},
    extraRules: row.extra_rules ?? '',
    providerId: row.provider_id ?? '',
    modelOverride: row.model_override ?? '',
    reasoningEffort: row.reasoning_effort ?? '',
    jailbreak: row.jailbreak ?? '',
    cast: loadCast(id).map((m) => ({
      id: m.id,
      name: m.name,
      materialId: m.material_id,
      body: JSON.parse(m.body_json),
    })),
    messages: loadMessages(id).map((m) => ({
      id: m.id,
      parentId: m.parent_id,
      kind: m.kind,
      content: m.content,
      meta: m.meta_json ? JSON.parse(m.meta_json) : null,
      createdAt: m.created_at,
    })),
  })
})

/**
 * 演一拍。流式返回 SSE：
 *   {type:'delta', text}
 *   {type:'done', messageId, usage}
 *   {type:'error', error}
 */
playthroughRoutes.post('/:id/beats', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as {
    directive?: unknown
    rewrite?: unknown
    replaceLast?: unknown
  }
  const directive = typeof body.directive === 'string' ? body.directive.trim() : ''
  const rewrite = typeof body.rewrite === 'string' ? body.rewrite.trim() : ''
  const replaceLast = body.replaceLast === true

  const provider = providerFor(row)
  if (!provider) {
    return c.json({ error: '还没有配置任何供应商。去「设置」里加一个。' }, 400)
  }
  if (!provider.apiKey) {
    return c.json({ error: `「${provider.name}」还没有填 API 密钥。` }, 400)
  }
  if (!provider.model) {
    return c.json({ error: `「${provider.name}」还没有选模型。` }, 400)
  }

  const cast = loadCast(id)
  if (cast.length === 0) {
    return c.json({ error: '这一局没有演员。' }, 400)
  }

  const allMessages = loadMessages(id)

  // 演出只能沿着「当前所在的分支」走，不能把另一条枝上的内容也算进上下文
  const leafId =
    row.current_leaf_id ??
    (allMessages.length > 0 ? allMessages[allMessages.length - 1].id : null)
  const currentPath = buildPath(
    allMessages.map((m) => ({ ...m, parentId: m.parent_id })),
    leafId,
  )

  // 重写：从同一个父节点再长出一条候选，而不是覆盖原来那条。
  // 旧版本留在树上，可以来回切换比较。
  let target: MessageRow | undefined
  let history = currentPath
  let parentId = currentPath.length > 0 ? currentPath[currentPath.length - 1].id : null

  if (replaceLast) {
    target = [...currentPath].reverse().find((m) => m.kind === 'narration')
    if (!target) {
      return c.json({ error: '这一局还没有正文可以重写。' }, 400)
    }
    history = currentPath.filter((m) => m.created_at < target!.created_at)
    parentId = target.parent_id
  }

  const preset = normalizePreset(JSON.parse(row.preset_json))
  const lorebook = row.lorebook_json ? parseLorebook(JSON.parse(row.lorebook_json)) : undefined
  const presentNames = cast.map((m) => m.name)

  // 新的导演指令先落库，并成为这一拍的父节点。
  // 早先用的是插入前的旧 parent，导致导演消息和正文成了两个根。
  let insertParentId = parentId
  if (directive && !replaceLast) {
    const directorId = randomUUID()
    db.prepare(
      `INSERT INTO messages (id, playthrough_id, parent_id, kind, content, meta_json, created_at)
       VALUES (?, ?, ?, 'director', ?, NULL, ?)`,
    ).run(directorId, id, parentId, directive, Date.now())
    insertParentId = directorId
  }

  // 前情提要：被摘要覆盖过的那段不再进「最近对话」
  let memoryRow = row
  const autoWarnings: string[] = []

  // 自动压缩：路径太长就先把老剧情压成摘要。失败不阻断演出。
  const budgetChars = preset.params.maxContext * 3
  const pathChars = currentPath.reduce((sum, m) => sum + m.content.length, 0)
  if (!replaceLast && pathChars > budgetChars * 0.8) {
    try {
      const before = currentPath.filter((m) => m.kind === 'narration').length
      const compacted = await compactInternal(id, row, 3)
      memoryRow = db
        .prepare('SELECT * FROM playthroughs WHERE id = ?')
        .get(id) as unknown as PlaythroughRow
      autoWarnings.push(
        `上下文接近上限（${pathChars} 字），已自动把最早的 ${compacted.compressed} 拍压成前情提要（原有 ${before} 拍）。`,
      )
    } catch {
      autoWarnings.push(`上下文接近上限（${pathChars} 字），自动压缩没成功，这一拍会偏长。`)
    }
  }

  const memory = memoryRow.memory_json ? (JSON.parse(memoryRow.memory_json) as Memory) : null

  let pathForHistory = history
  if (memory?.coveredUntil) {
    const cutoff = history.findIndex((m) => m.id === memory.coveredUntil)
    if (cutoff >= 0) pathForHistory = history.slice(cutoff + 1)
  }

  const recent: HistoryMessage[] = [
    ...pathForHistory.map((m) => ({
      kind: (m.kind === 'director' ? 'director' : 'narration') as HistoryMessage['kind'],
      content: m.content,
    })),
    ...(directive && !replaceLast
      ? [{ kind: 'director' as const, content: directive }]
      : []),
  ].slice(-12)

  const scanText = [...recent.map((m) => m.content), directive, rewrite].join('\n')

  const assembly = assemble({
    actors: cast.map((m) => ({ name: m.name, body: JSON.parse(m.body_json) as CardBody })),
    presentNames,
    lorebook,
    preset,
    scanText,
    history: recent,
    memory: memory?.summary,
    extraRules: row.extra_rules ?? undefined,
    budgetChars,    beatRange: { min: 400, max: 900 },
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }

      try {
        // 导演补丁与本局规则都要作为 system 消息：混在一万多字的素材里等于没提。
        // 素材部分才作为 user 消息。
        const patch = assembly.sections.find((s) => s.identifier === 'director-patch')
        const rules = assembly.sections.find((s) => s.identifier === 'extra-rules')
        const material = assembly.sections.filter(
          (s) => s.identifier !== 'director-patch' && s.identifier !== 'extra-rules',
        )

        const templates = row.cast_templates_json
          ? (JSON.parse(row.cast_templates_json) as CastTemplates)
          : {}
        const templateLines: string[] = []
        for (const [name, fields] of Object.entries(templates)) {
          if (fields.length === 0) continue
          templateLines.push(
            `- ${name}：${fields.map((f) => (f.hint ? `${f.key}（${f.hint}）` : f.key)).join('、')}`,
          )
        }

        const messages = [
          ...(patch
            ? [
                {
                  role: 'system' as const,
                  content: [
                    // 破甲提示词放最前：它是整段语境的底座
                    ...(row.jailbreak ? [row.jailbreak, ''] : []),
                    '【输出格式（最高优先级，必须严格遵守）】',
                    '你的每一次回复都必须分成三段，用方括号标题标记。任何一段都不能省略，也不能只写正文。',
                    '',
                    '【正文】',
                    '（小说正文……）',
                    '',
                    '【状态】',
                    '{"scene":{"location":"","time":""},"present":[],"relations":[{"a":"","b":"","note":""}],"notes":[]}',
                    '',
                    '【岔路】',
                    '1. 如果…… → 会把局面引向……',
                    '2. ……',
                    '3. ……',
                    '',
                    ...(templateLines.length > 0
                      ? [
                          '【角色状态（必须包含）】',
                          '【状态】的 JSON 里必须加 characters 字段，按下面的模板写：',
                          ...templateLines,
                          '格式：{"characters": {"角色名": {"字段名": "值"}}}',
                          '只写模板里列出的角色与字段，多写一个都算错；不在名单里的角色不要出现。',
                          '值要短（15 字以内），写这一拍结束时的状态。',
                          '',
                        ]
                      : []),
                    '下面只示范格式，内容不要照抄：',
                    '【正文】',
                    '雨落在瓦上。她把笔搁下。',
                    '【状态】',
                    '{"scene":{"location":"郭府前厅","time":"雨夜"},"present":["黄蓉"],"relations":[],"notes":[]}',
                    '【岔路】',
                    '1. 如果门外有人叩门 → 会把叙事转向访客',
                    '2. 如果灯被风吹灭 → 会推向黑暗里的试探',
                    '3. 如果郭靖开口 → 会引向夫妻之间的交锋',
                    '',
                    ...(rules
                      ? [
                          '【本局规则（最高优先级，每一条都必须遵守）】',
                          rules.content,
                          '',
                        ]
                      : []),
                    patch.content,
                    rewrite ? `\n【本次重写要求（优先满足）】\n${rewrite}` : '',
                  ].join('\n'),
                },
              ]
            : []),
          {
            role: 'user' as const,
            content: material.map((s) => `### ${s.label}\n${s.content}`).join('\n\n'),
          },
        ]

        const result = await chatCompletionStream(
          {
            apiBase: provider.apiBase,
            apiKey: provider.apiKey,
            model: provider.model,
            messages,
            temperature: preset.params.temperature,
            maxTokens: Math.max(2000, Math.min(preset.params.maxTokens, 6000)),
            reasoningEffort: (row.reasoning_effort as ReasoningEffort) || undefined,
          },
          (delta) => send({ type: 'delta', text: delta }),
        )

        const messageId = randomUUID()
        const now = Date.now()
        // 三段拆开：正文入库，状态与岔路进 meta，解析警告也留着
        const parsed = parseBeat(result.content)

        // 模型拒答不是正文：直接报错，不落库、不推进位置
        const refusal = detectRefusal(parsed.narration)
        if (refusal) {
          send({
            type: 'error',
            error: `模型拒绝了这一拍，没有保存。原文：${refusal.slice(0, 160)}`,
          })
          controller.close()
          return
        }

        // 角色按模板收口：模型爱多写，多出来的角色一律丢掉。
        // 但字段名不按字面严格比对——模型常把「对吕文德的好感度」写成「好感度」，
        // 按字符串相等过滤会把有效信息也删掉。
        if (parsed.state) {
          const allowedCharacters = new Set(Object.keys(templates))
          const filtered: Record<string, Record<string, string>> = {}
          for (const [name, fields] of Object.entries(parsed.state.characters)) {
            if (!allowedCharacters.has(name)) continue
            const kept: Record<string, string> = {}
            for (const [key, value] of Object.entries(fields)) {
              if (value.trim()) kept[key] = value
            }
            if (Object.keys(kept).length > 0) filtered[name] = kept
          }
          parsed.state.characters = filtered
        }

        const metaJson = JSON.stringify({
          promptChars: assembly.charCount,
          estimatedTokens: assembly.estimatedTokens,
          usage: result.usage ?? null,
          finishReason: result.finishReason ?? null,
          warnings: [...assembly.warnings, ...autoWarnings],
          parseWarnings: parsed.warnings,
          model: provider.model,
          providerName: provider.name,
          reasoningEffort: row.reasoning_effort ?? '',
          jailbreak: row.jailbreak ?? '',
          state: parsed.state ?? null,
          forks: parsed.forks ?? null,
          prompt: assembly.prompt,
        })

        db.prepare(
          `INSERT INTO messages (id, playthrough_id, parent_id, kind, content, meta_json, created_at)
           VALUES (?, ?, ?, 'narration', ?, ?, ?)`,
        ).run(messageId, id, insertParentId, parsed.narration, metaJson, now)

        db.prepare('UPDATE playthroughs SET current_leaf_id = ?, updated_at = ? WHERE id = ?').run(
          messageId,
          now,
          id,
        )

        send({
          type: 'done',
          messageId,
          usage: result.usage ?? null,
          promptChars: assembly.charCount,
          estimatedTokens: assembly.estimatedTokens,
          warnings: [...assembly.warnings, ...autoWarnings],
        })
      } catch (error) {
        send({
          type: 'error',
          error: error instanceof LlmError ? error.message : '演出失败，请重试。',
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})

/** 压缩的内部实现：路由与演出前的自动检查共用。 */
async function compactInternal(
  id: string,
  row: PlaythroughRow,
  keepRecent: number,
): Promise<{ memory: Memory; compressed: number }> {
  const provider = providerFor(row)
  if (!provider) throw new LlmError('还没有配置任何供应商。')
  if (!provider.apiKey) throw new LlmError(`「${provider.name}」还没有填 API 密钥。`)
  if (!provider.model) throw new LlmError(`「${provider.name}」还没有选模型。`)

  const allMessages = loadMessages(id)
  const leafId =
    row.current_leaf_id ?? (allMessages.length > 0 ? allMessages[allMessages.length - 1].id : null)
  const path = buildPath(
    allMessages.map((m) => ({ ...m, parentId: m.parent_id })),
    leafId,
  )
  const narrations = path.filter((m) => m.kind === 'narration')

  if (narrations.length <= keepRecent + 1) {
    throw new LlmError(`至少要有 ${keepRecent + 2} 拍才值得压缩，现在只有 ${narrations.length} 拍。`)
  }

  const toCompress = narrations.slice(0, narrations.length - keepRecent)

  const result = await chatCompletion({
    apiBase: provider.apiBase,
    apiKey: provider.apiKey,
    model: provider.model,
    messages: [
      {
        role: 'system',
        content: [
          '把下面这段小说剧情压缩成「前情提要」。',
          '要求：200–300 字；保留人物、地点、已经做出的承诺与决定、尚未解决的隐患与误会；',
          '不要分点、不要评价、不要续写、不要写“本段讲述了”这类废话，直接叙述。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: toCompress.map((m) => m.content).join('\n\n'),
      },
    ],
    temperature: 0.3,
    maxTokens: 1000,
  })

  const memory: Memory = {
    summary: result.content.trim(),
    coveredUntil: toCompress[toCompress.length - 1].id,
  }

  db.prepare('UPDATE playthroughs SET memory_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(memory),
    Date.now(),
    id,
  )

  return { memory, compressed: toCompress.length }
}

/** 把较早的剧情压成一条前情提要。摘要可编辑，原文仍留在树上。 */
playthroughRoutes.post('/:id/compact', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { keepRecent?: unknown }
  const keepRecent =
    typeof body.keepRecent === 'number' && body.keepRecent >= 1 ? Math.floor(body.keepRecent) : 3

  try {
    const result = await compactInternal(id, row, keepRecent)
    return c.json({ memory: result.memory, compressed: result.compressed, kept: keepRecent })
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '压缩失败'
    return c.json({ error: message }, 400)
  }
})

/** 编辑摘要：模型压错了一个事实，人得能改回来。 */
playthroughRoutes.put('/:id/memory', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { summary?: unknown }
  const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
  if (!summary) return c.json({ error: '摘要不能为空。' }, 400)

  const existing = row.memory_json ? (JSON.parse(row.memory_json) as Memory) : null
  if (!existing) return c.json({ error: '这一局还没有前情提要。' }, 400)

  const next: Memory = { ...existing, summary }
  db.prepare('UPDATE playthroughs SET memory_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(next),
    Date.now(),
    id,
  )

  return c.json({ memory: next })
})

/** 把当前所在位置移到任意节点：这就是「回退」。旧枝不删，随时可切回。 */
playthroughRoutes.post('/:id/checkout', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { messageId?: unknown }
  const messageId = typeof body.messageId === 'string' ? body.messageId : ''

  if (!messageId) return c.json({ error: '没有指定要回到哪一拍。' }, 400)

  const exists = db
    .prepare('SELECT id FROM messages WHERE id = ? AND playthrough_id = ?')
    .get(messageId, id) as unknown as { id: string } | undefined

  if (!exists) return c.json({ error: '这一拍不属于当前对局。' }, 400)

  db.prepare('UPDATE playthroughs SET current_leaf_id = ?, updated_at = ? WHERE id = ?').run(
    messageId,
    Date.now(),
    id,
  )

  return c.json({ ok: true, currentLeafId: messageId })
})

/** 只换岔路：正文一字不动，重新生成三条走向。 */
playthroughRoutes.post('/:id/forks/regenerate', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { messageId?: unknown; note?: unknown }
  const note = typeof body.note === 'string' ? body.note.trim() : ''

  const provider = providerFor(row)
  if (!provider) return c.json({ error: '还没有配置任何供应商。' }, 400)
  if (!provider.apiKey) {
    return c.json({ error: `「${provider.name}」还没有填 API 密钥。` }, 400)
  }
  if (!provider.model) {
    return c.json({ error: `「${provider.name}」还没有选模型。` }, 400)
  }

  const messages = loadMessages(id)
  const target =
    typeof body.messageId === 'string' && body.messageId
      ? messages.find((m) => m.id === body.messageId)
      : [...messages].reverse().find((m) => m.kind === 'narration')

  if (!target) return c.json({ error: '还没有正文，先演一拍。' }, 400)

  try {
    const result = await chatCompletion({
      apiBase: provider.apiBase,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [
        {
          role: 'system',
          content: [
            '你在一部多角色小说里负责提供后续走向。',
            '只输出三条岔路，每条一行，格式严格如下：',
            '1. 如果…… → 会把局面引向……',
            '2. ……',
            '3. ……',
            '要求：三条要指向明显不同的处境，不是同义改写；只写触发条件与方向，不写具体结果；不要输出正文，不要解释。',
            note ? `\n本次要求：${note}` : '',
          ].join('\n'),
        },
        { role: 'user', content: `当前这段正文：\n\n${target.content}` },
      ],
      temperature: 0.95,
      maxTokens: 800,
    })

    const forks = parseForksFromText(result.content)
    if (forks.length === 0) {
      return c.json({ error: '模型没有给出可解析的走向，重试一次。' }, 400)
    }

    const meta = target.meta_json ? JSON.parse(target.meta_json) : {}
    meta.forks = forks
    meta.forksFromEarlierVersion = false
    db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(
      JSON.stringify(meta),
      target.id,
    )

    return c.json({ forks })
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '生成走向失败'
    return c.json({ error: message }, 400)
  }
})

/** 查看某一拍实际发出的 prompt（调试用，不消耗额度）。 */
playthroughRoutes.get('/:id/messages/:messageId/prompt', (c) => {  const row = db
    .prepare('SELECT meta_json FROM messages WHERE id = ? AND playthrough_id = ?')
    .get(c.req.param('messageId'), c.req.param('id')) as unknown as
    | { meta_json: string | null }
    | undefined

  if (!row?.meta_json) return c.json({ error: '这条消息没有记录 prompt' }, 404)
  return c.json(JSON.parse(row.meta_json))
})

/** 设置角色状态模板：每个角色要模型给出哪些字段。 */
playthroughRoutes.put('/:id/templates', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { templates?: unknown }
  const input = body.templates

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return c.json({ error: '模板格式不对。' }, 400)
  }

  const templates: CastTemplates = {}
  for (const [name, fields] of Object.entries(input as Record<string, unknown>)) {
    if (!Array.isArray(fields)) continue
    const list = fields
      .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
      .map((f) => ({
        // 兜底剥掉序号：客户端已经处理过，这里防直接调接口传脏数据
        key: typeof f.key === 'string'
          ? f.key.trim().replace(/^\s*[（(]?\s*\d+\s*[.、)）:：]\s*/, '').trim()
          : '',
        hint: typeof f.hint === 'string' ? f.hint.trim() : '',
      }))
      .filter((f) => f.key.length > 0)
      .slice(0, 8)
    if (list.length > 0) templates[name] = list
  }

  db.prepare('UPDATE playthroughs SET cast_templates_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(templates),
    Date.now(),
    id,
  )

  return c.json({ templates })
})

/** 本局自己的规则或提示词。只管这一局，不动预设与角色卡。 */
playthroughRoutes.put('/:id/rules', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { extraRules?: unknown }
  const rules = typeof body.extraRules === 'string' ? body.extraRules.trim() : ''

  db.prepare('UPDATE playthroughs SET extra_rules = ?, updated_at = ? WHERE id = ?').run(
    rules || null,
    Date.now(),
    id,
  )

  return c.json({ extraRules: rules })
})

/** 直接改某一拍的正文。状态与岔路保持原样，只动文字。 */
playthroughRoutes.patch('/:id/messages/:messageId', async (c) => {
  const id = c.req.param('id')
  const messageId = c.req.param('messageId')

  const row = db
    .prepare('SELECT id FROM messages WHERE id = ? AND playthrough_id = ?')
    .get(messageId, id) as unknown as { id: string } | undefined

  if (!row) return c.json({ error: '这一拍不属于当前对局。' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { content?: unknown }
  const content = typeof body.content === 'string' ? body.content.trim() : ''

  if (!content) return c.json({ error: '正文不能为空。' }, 400)

  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId)

  return c.json({ ok: true, content })
})

/** 破甲提示词：放在 system 消息最前，作为整段语境的底座。 */
playthroughRoutes.put('/:id/jailbreak', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { jailbreak?: unknown }
  const text = typeof body.jailbreak === 'string' ? body.jailbreak.trim() : ''

  db.prepare('UPDATE playthroughs SET jailbreak = ?, updated_at = ? WHERE id = ?').run(
    text || null,
    Date.now(),
    id,
  )

  return c.json({ jailbreak: text })
})

/** 给这一局单独指定供应商与模型；清空则跟随全局设置。 */
playthroughRoutes.put('/:id/model', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as {
    providerId?: unknown
    model?: unknown
    reasoningEffort?: unknown
  }
  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const effort =
    typeof body.reasoningEffort === 'string' &&
    ['low', 'medium', 'high'].includes(body.reasoningEffort)
      ? body.reasoningEffort
      : ''

  if (providerId && !loadSettings().providers.some((p) => p.id === providerId)) {
    return c.json({ error: '没有这个供应商。' }, 400)
  }

  db.prepare(
    `UPDATE playthroughs
     SET provider_id = ?, model_override = ?, reasoning_effort = ?, updated_at = ?
     WHERE id = ?`,
  ).run(providerId || null, model || null, effort || null, Date.now(), id)

  return c.json({ providerId, modelOverride: model, reasoningEffort: effort })
})

/** 删掉一整局：消息与演员表一起清，素材本身不受影响。 */
playthroughRoutes.delete('/:id', (c) => {
  const id = c.req.param('id')

  const exists = db
    .prepare('SELECT id FROM playthroughs WHERE id = ?')
    .get(id) as unknown as { id: string } | undefined

  if (!exists) return c.json({ error: '对局不存在' }, 404)

  db.prepare('DELETE FROM messages WHERE playthrough_id = ?').run(id)
  db.prepare('DELETE FROM cast_members WHERE playthrough_id = ?').run(id)
  db.prepare('DELETE FROM playthroughs WHERE id = ?').run(id)

  return c.json({ ok: true })
})

/** 导出整局：消息树、状态、冻结素材、预设与世界书，一个文件带走。 */
playthroughRoutes.get('/:id/export', (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const cast = loadCast(id)
  const messages = loadMessages(id)

  const bundle = {
    format: 'huaben-playthrough',
    version: 1,
    exportedAt: Date.now(),
    playthrough: {
      title: row.title,
      currentLeafId: row.current_leaf_id,
      memory: row.memory_json ? JSON.parse(row.memory_json) : null,
      createdAt: row.created_at,
    },
    preset: JSON.parse(row.preset_json),
    lorebook: row.lorebook_json ? JSON.parse(row.lorebook_json) : null,
    cast: cast.map((m) => ({
      name: m.name,
      materialId: m.material_id,
      body: JSON.parse(m.body_json),
      sortOrder: m.sort_order,
    })),
    messages: messages.map((m) => ({
      id: m.id,
      parentId: m.parent_id,
      kind: m.kind,
      content: m.content,
      meta: m.meta_json ? JSON.parse(m.meta_json) : null,
      createdAt: m.created_at,
    })),
  }

  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="playthrough-${id.slice(0, 8)}.json"`,
    },
  })
})

/** 导入一整局。消息 id 会重新生成，父子关系按原样重建。 */
playthroughRoutes.post('/import', async (c) => {
  const data = (await c.req.json().catch(() => null)) as {
    format?: unknown
    version?: unknown
    playthrough?: { title?: unknown; currentLeafId?: unknown; memory?: unknown }
    preset?: unknown
    lorebook?: unknown
    cast?: unknown
    messages?: unknown
  } | null

  if (!data) return c.json({ error: '这不是一个合法的 JSON 文件。' }, 400)
  if (data.format !== 'huaben-playthrough') {
    return c.json({ error: '这不是话本导出的对局文件。' }, 400)
  }
  if (data.version !== 1) {
    return c.json({ error: `文件版本是 ${String(data.version)}，当前只支持 1。` }, 400)
  }

  const castList = Array.isArray(data.cast) ? data.cast : []
  const messageList = Array.isArray(data.messages) ? data.messages : []

  if (castList.length === 0) return c.json({ error: '文件里没有演员表。' }, 400)
  if (messageList.length === 0) return c.json({ error: '文件里没有消息。' }, 400)

  const id = randomUUID()
  const now = Date.now()
  const title =
    typeof data.playthrough?.title === 'string' && data.playthrough.title.trim()
      ? data.playthrough.title.trim()
      : '导入的对局'

  db.prepare(
    `INSERT INTO playthroughs (id, title, preset_json, lorebook_json, current_leaf_id, memory_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    title,
    JSON.stringify(data.preset ?? normalizePreset({})),
    data.lorebook ? JSON.stringify(data.lorebook) : null,
    now,
    now,
  )

  const insertCast = db.prepare(
    `INSERT INTO cast_members (id, playthrough_id, material_id, name, body_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  castList.forEach((item, index) => {
    const entry = item as { name?: unknown; materialId?: unknown; body?: unknown; sortOrder?: unknown }
    insertCast.run(
      randomUUID(),
      id,
      typeof entry.materialId === 'string' ? entry.materialId : null,
      typeof entry.name === 'string' ? entry.name : `角色 ${index + 1}`,
      JSON.stringify(entry.body ?? {}),
      typeof entry.sortOrder === 'number' ? entry.sortOrder : index,
    )
  })

  // 重建 id 映射：不保留原 id，避免和本机已有数据打架
  const idMap = new Map<string, string>()
  for (const item of messageList) {
    const message = item as { id?: unknown }
    if (typeof message.id === 'string') idMap.set(message.id, randomUUID())
  }

  const insertMessage = db.prepare(
    `INSERT INTO messages (id, playthrough_id, parent_id, kind, content, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )

  let inserted = 0
  for (const item of messageList) {
    const message = item as {
      id?: unknown
      parentId?: unknown
      kind?: unknown
      content?: unknown
      meta?: unknown
      createdAt?: unknown
    }
    if (typeof message.id !== 'string') continue

    const newId = idMap.get(message.id)!
    const newParent =
      typeof message.parentId === 'string' ? (idMap.get(message.parentId) ?? null) : null
    const kind = message.kind === 'director' ? 'director' : 'narration'

    insertMessage.run(
      newId,
      id,
      newParent,
      kind,
      typeof message.content === 'string' ? message.content : '',
      message.meta ? JSON.stringify(message.meta) : null,
      typeof message.createdAt === 'number' ? message.createdAt : now,
    )
    inserted += 1
  }

  // 当前位置与摘要的覆盖点也要跟着换 id
  const oldLeaf = data.playthrough?.currentLeafId
  const newLeaf = typeof oldLeaf === 'string' ? (idMap.get(oldLeaf) ?? null) : null

  const memory = data.playthrough?.memory as { summary?: unknown; coveredUntil?: unknown } | null
  let memoryJson: string | null = null
  if (memory && typeof memory.summary === 'string') {
    memoryJson = JSON.stringify({
      summary: memory.summary,
      coveredUntil:
        typeof memory.coveredUntil === 'string'
          ? (idMap.get(memory.coveredUntil) ?? '')
          : '',
    })
  }

  db.prepare('UPDATE playthroughs SET current_leaf_id = ?, memory_json = ? WHERE id = ?').run(
    newLeaf ?? (inserted > 0 ? [...idMap.values()][inserted - 1] : null),
    memoryJson,
    id,
  )

  return c.json({ id, title, messages: inserted }, 201)
})

export { DEFAULT_BUDGET_CHARS }
