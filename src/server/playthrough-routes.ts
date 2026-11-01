import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { db } from './db.ts'
import { activeProvider, loadSettings } from './settings.ts'
import type { LlmProvider } from './settings.ts'
import { chatCompletion, chatCompletionStream, LlmError } from './llm.ts'
import type { ReasoningEffort } from './llm.ts'
import { assemble, DEFAULT_BUDGET_CHARS, type HistoryMessage } from '../engine/assembly.ts'
import {
  detectRefusal,
  normalizeState,
  parseBeat,
  parseForksFromText,
  parseStateJson,
} from '../engine/parse.ts'
import { buildPath, collectDescendants } from '../engine/tree.ts'
import { extractPrefill, normalizePreset } from '../tavern/preset.ts'
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
  prefill: string | null
  delivery_check: string | null
  state_rules: string | null
  writing_style: string | null
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


/**
 * 内置的交付检查文案；对局里可以整段覆盖。
 * wantsFirstPerson 由本局规则里是否出现「第一人称」自动决定。
 */
function defaultDeliveryCheck(hasTemplates: boolean, wantsFirstPerson: boolean): string {
  return [
    '【交付检查（最后读一遍）】',
    '你的回复必须同时包含【正文】【状态】【岔路】三段，一段都不能少。',
    '如果只写了正文，这次回复就是不合格的。',
    '写完后自己确认一遍：【状态】里是不是合法 JSON？【岔路】是不是恰好三条？',
    ...(hasTemplates ? ['【状态】里每个勾选的角色都要回报，即使不在场也要给值，一个都不能漏。'] : []),
    ...(wantsFirstPerson
      ? [
          '本局规定用第一人称：正文必须以「我」为叙述者。',
          '禁止出现「黄蓉把…」「黄蓉说…」这类第三人称叙述句，那是错的。',
          '写完检查第一句：如果主语是「黄蓉」而不是「我」，就重写。',
        ]
      : []),
  ].join('\n')
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
    .prepare(
      'SELECT * FROM messages WHERE playthrough_id = ? AND replaced_by IS NULL ORDER BY created_at',
    )
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
    prefill: row.prefill ?? '',
    deliveryCheck: row.delivery_check ?? '',
    stateRules: row.state_rules ?? '',
    writingStyle: row.writing_style ?? '',
    autoPrefill: extractPrefill(normalizePreset(JSON.parse(row.preset_json))),
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

  // 回退后重演时，这一拍原来的后续要被替换掉（不是留成第二条枝）。
  // 重写这一拍（replaceLast）不算：那是同一拍的多个候选，要并存。
  const oldDescendants =
    !replaceLast && parentId
      ? collectDescendants(
          allMessages.map((m) => ({ ...m, parentId: m.parent_id })),
          parentId,
        )
      : []

  const preset = normalizePreset(JSON.parse(row.preset_json))
  const lorebook = row.lorebook_json ? parseLorebook(JSON.parse(row.lorebook_json)) : undefined
  const presentNames = cast.map((m) => m.name)

  // 导演指令先占好 id 当父节点，但**等演出成功才落库**：
  // 否则模型拒答或报错时，会留下一条没有正文的孤儿指令。
  const directorId = directive && !replaceLast ? randomUUID() : null
  const insertParentId = directorId ?? parentId

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

  // 这一拍对应的导演指令：重写时是 target 的父节点，
  // 普通演出时是刚插入的那条。混在 chatHistory 里模型会当成「过去的记录」，
  // 所以单独拎出来放进 system 当硬要求。
  let thisBeatDirective = ''
  if (replaceLast && target) {
    const parent = currentPath.find((m) => m.id === target!.parent_id)
    if (parent?.kind === 'director') thisBeatDirective = parent.content
  } else if (directive) {
    thisBeatDirective = directive
  }

  // 上一拍结束时的状态：模型必须拿它当基准，否则每拍都在重新编数字
  let prevCharacters: Record<string, Record<string, string>> = {}
  for (const m of [...history].reverse()) {
    if (m.kind !== 'narration' || !m.meta_json) continue
    try {
      const meta = JSON.parse(m.meta_json) as { state?: { characters?: Record<string, Record<string, string>> } }
      if (meta.state?.characters && Object.keys(meta.state.characters).length > 0) {
        prevCharacters = meta.state.characters
        break
      }
    } catch {
      // 这一拍没有可用的状态，继续往前找
    }
  }

  // 续写引导只用手填的。
  // 预设里自动提取的那些（OK，/ [Understood.]）只对支持 prefill 的端点有用，
  // 而 DeepSeek 这类端点会直接回 400「ending with a model turn」，
  // 所以默认不发，免得每次白跑一轮。
  const autoPrefill = extractPrefill(preset)
  const effectivePrefill = (row.prefill ?? '').trim() || autoPrefill

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

        // 交付检查：对局可整段覆盖，否则用内置文案
        const deliveryCheck =
          (row.delivery_check ?? '').trim() ||
          defaultDeliveryCheck(
            templateLines.length > 0,
            /第一人称/.test(row.extra_rules ?? ''),
          )

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
                          '名单里的角色即使不在场也必须给值（写「不在场」或不写具体动作），不要省略。',
                          '括号里的文字是填写要求，必须照它来填。',
                          ...(Object.keys(prevCharacters).length > 0
                            ? [
                                '【上一拍结束时的数值（必须以此为基准，不要重新编）】',
                                ...Object.entries(prevCharacters).map(
                                  ([name, fields]) =>
                                    `- ${name}：${Object.entries(fields)
                                      .map(([k, v]) => `${k}=${v}`)
                                      .join('、')}`,
                                ),
                                ...(row.state_rules
                                  ? row.state_rules.split('\n').filter((l) => l.trim())
                                  : [
                                      '不在场的角色，所有数值必须与上一拍完全相同，一个字都不能变。',
                                      '在场的角色，数值每拍最多变化 5（除非发生了实质性的重大事件）。',
                                      '数值只能小幅波动，不要跳变。',
                                    ]),
                                // 下面两条不可关闭：自定义规则里写「最多变 2」时，
                                // 模型会理解成「最好别变」，数值就卡住了。
                                '在场的角色，每拍至少有 1 个字段要变。',
                                '不许连续三拍给同一个数字：剧情在推进，数值就该有反应。',
                                '',
                              ]
                            : []),
                          '如果字段名或要求里出现「数值」「值」「指数」「度」「分数」这类字眼，',
                          '就只写一个阿拉伯数字（例如 35），不要写形容词、不要加括号注释、不要写「极高」这种词。',
                          '只有明确是描述性字段（如身体状态、心情）才写短句，15 字以内。',
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
                    ...(row.writing_style
                      ? ['【写作风格（整篇统一）】', row.writing_style, '']
                      : []),
                    ...(thisBeatDirective
                      ? [
                          '【这一拍必须写的事（导演要求，不得改写）】',
                          thisBeatDirective,
                          '这一拍就写这件事。不要切到别的地点、别的人物，也不要跳过它先写前因。',
                          '',
                        ]
                      : []),
                    patch.content,
                    rewrite ? `\n【本次重写要求（优先满足）】\n${rewrite}` : '',
                    '',
                    // 放在最末尾：模型对最后的指令最敏感。对局可以整段覆盖。
                    deliveryCheck,
                  ].join('\n'),
                },
              ]
            : []),
          {
            role: 'user' as const,
            content:
              material.map((s) => `### ${s.label}\n${s.content}`).join('\n\n') +
              (effectivePrefill
                ? `\n\n【你已经开始这样写了】\n${effectivePrefill}\n（接着这句往下续写，不要重复它，也不要重新开头。）`
                : '') +
              (/第一人称/.test(row.extra_rules ?? '')
                ? '\n\n【最后提醒】本局用第一人称，叙述者只能是「我」。'
                : '') +
              (row.writing_style
                ? `\n\n【文风要求（这一拍必须照此写）】\n${row.writing_style}`
                : ''),
          },
          // 续写引导：Gemini 这类端点会接着这句写（酒馆就是靠这个破限）。
          // Ollama / DeepSeek 会回 400「ending with a model turn」，下面会降级重试。
          ...(effectivePrefill
            ? [{ role: 'assistant' as const, content: effectivePrefill }]
            : []),
        ]

        const baseRequest = {
          apiBase: provider.apiBase,
          apiKey: provider.apiKey,
          model: provider.model,
          temperature: preset.params.temperature,
          maxTokens: Math.max(4000, Math.min(preset.params.maxTokens, 8000)),
          reasoningEffort: (row.reasoning_effort as ReasoningEffort) || undefined,
        }

        const wantsPrefill = messages.some((m) => m.role === 'assistant')
        const withoutPrefill = messages.filter((m) => m.role !== 'assistant')

        let result
        try {
          result = await chatCompletionStream(
            { ...baseRequest, messages },
            (delta) => send({ type: 'delta', text: delta }),
          )
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          // Ollama / 部分中转不支持以 assistant 结尾，去掉重试一次
          if (wantsPrefill && /ending with a model turn|model turn are not supported/i.test(text)) {
            autoWarnings.push('这个模型不支持续写引导（结尾不能是助手消息），本次已跳过。')
            result = await chatCompletionStream(
              { ...baseRequest, messages: withoutPrefill },
              (delta) => send({ type: 'delta', text: delta }),
            )
          } else {
            throw error
          }
        }

        const messageId = randomUUID()
        const now = Date.now()
        // 三段拆开：正文入库，状态与岔路进 meta，解析警告也留着
        const parsed = parseBeat(result.content)

        // Gemini 遇到 assistant prefill 时会「重新生成整段」，开头照抄上一拍。
        // 去掉与上一拍重复的前缀，否则同一段话会连着出现两遍。
        const prevNarration = [...history]
          .reverse()
          .find((m) => m.kind === 'narration')?.content
        if (prevNarration) {
          const a = prevNarration.trim()
          const b = parsed.narration.trim()
          let common = 0
          while (common < a.length && common < b.length && a[common] === b[common]) common++
          if (common >= 20) {
            parsed.narration = b.slice(common).trimStart()
            parsed.warnings.push(`去掉了与上一拍重复的 ${common} 字开头。`)
          }
        }

        // 空内容不是正文：直接报错，不落库、不推进位置
        if (!parsed.narration.trim()) {
          send({
            type: 'error',
            error:
              `模型返回了空内容（finish_reason = ${result.finishReason ?? '未知'}，` +
              `completion tokens = ${result.usage?.completion ?? 0}）。` +
              '多半是额度全花在思考上、或模型直接截断了。调大 max_tokens 或换个模型再试。',
          })
          controller.close()
          return
        }

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
          stateRaw: parsed.state ? undefined : parsed.stateRaw,
          forks: parsed.forks ?? null,
          prompt: assembly.prompt,
          // 实际发给模型的消息：system（破甲词/格式/补丁）+ user（素材）。
          // 破甲词在 system 里，光看 assembly.prompt 是看不到的。
          sentMessages: messages,
          rawHead: result.content.slice(0, 120),
        })

        if (directorId) {
          // 必须用同一个 now：导演指令的时间要早于它引发的正文，
          // 否则按 created_at 排序时正文会排到指令前面。
          db.prepare(
            `INSERT INTO messages (id, playthrough_id, parent_id, kind, content, meta_json, created_at)
             VALUES (?, ?, ?, 'director', ?, NULL, ?)`,
          ).run(directorId, id, parentId, directive, now)
        }

        db.prepare(
          `INSERT INTO messages (id, playthrough_id, parent_id, kind, content, meta_json, created_at)
           VALUES (?, ?, ?, 'narration', ?, ?, ?)`,
        ).run(messageId, id, insertParentId, parsed.narration, metaJson, now)

        // 新的这一拍已经落库，再把旧的后续删掉：用新步骤代替旧步骤
        if (oldDescendants.length > 0) {
          // 软删除：只标记「被哪一条替换了」，内容原样留着，随时能翻出来
          const mark = db.prepare('UPDATE messages SET replaced_by = ? WHERE id = ?')
          for (const stale of oldDescendants) mark.run(messageId, stale.id)
        }

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

  // 增量压缩：如果已经有摘要，只压它覆盖之后、到保留线之前的那几拍，
  // 否则会把最早那批重新压一遍，旧摘要里的细节就丢了。
  const existing = row.memory_json ? (JSON.parse(row.memory_json) as Memory) : null

  let toCompress = narrations.slice(0, narrations.length - keepRecent)
  if (existing?.coveredUntil) {
    const cutoff = narrations.findIndex((m) => m.id === existing.coveredUntil)
    if (cutoff >= 0) toCompress = narrations.slice(cutoff + 1, narrations.length - keepRecent)
  }

  if (toCompress.length === 0) {
    throw new LlmError('没有新的内容需要压缩。')
  }

  const freshText = toCompress.map((m) => m.content).join('\n\n')

  const result = await chatCompletion({
    apiBase: provider.apiBase,
    apiKey: provider.apiKey,
    model: provider.model,
    messages: [
      {
        role: 'system',
        content: [
          existing?.summary
            ? '把「已有前情提要」和「新增剧情」合并成一份新的前情提要。'
            : '把下面这段小说剧情压缩成「前情提要」。',
          '要求：200–300 字；保留人物、地点、已经做出的承诺与决定、尚未解决的隐患与误会；',
          '不要分点、不要评价、不要续写、不要写“本段讲述了”这类废话，直接叙述。',
          ...(existing?.summary
            ? ['合并时不要丢掉旧提要里仍然有效的线索，也不要重复叙述。']
            : []),
        ].join('\n'),
      },
      {
        role: 'user',
        content: existing?.summary
          ? `【已有前情提要】\n${existing.summary}\n\n【新增剧情】\n${freshText}`
          : freshText,
      },
    ],
    temperature: 0.3,
    // 推理型模型会先花一大笔额度在思考上，摘要本身只要 300 字
    maxTokens: 8000,
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
      // 三条岔路本身只要一百来字，但推理模型会先把额度花在思考上
      maxTokens: 6000,
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

/** 按用户的更改请求改写选中的那段文字，返回改写结果，不动正文。 */
playthroughRoutes.post('/:id/messages/:messageId/rewrite-selection', async (c) => {
  const id = c.req.param('id')
  const messageId = c.req.param('messageId')

  const play = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined
  if (!play) return c.json({ error: '对局不存在' }, 404)

  const msg = db
    .prepare('SELECT * FROM messages WHERE id = ? AND playthrough_id = ?')
    .get(messageId, id) as unknown as MessageRow | undefined
  if (!msg) return c.json({ error: '这一拍不属于当前对局。' }, 404)

  const provider = providerFor(play)
  if (!provider?.apiKey || !provider.model) {
    return c.json({ error: '还没有可用的模型。' }, 400)
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    selected?: unknown
    instruction?: unknown
  }
  const selected = typeof body.selected === 'string' ? body.selected : ''
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''

  if (!selected.trim()) return c.json({ error: '没有选中任何文字。' }, 400)
  if (!instruction) return c.json({ error: '请写出要改什么。' }, 400)

  try {
    const result = await chatCompletion({
      apiBase: provider.apiBase,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [
        {
          role: 'system',
          content: [
            '你在帮一位作者改稿。',
            '下面会给出「整段正文」和「要改的那一小段」，以及作者的更改要求。',
            '只输出改写后的那一小段，不要输出整段，不要解释，不要加引号或标记。',
            '保持与原文一致的人称、时态与文风；只改作者要求的地方，其余原样保留。',
            '改完的长度应与原文相近，除非作者要求增删。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            '【整段正文（仅供理解上下文，不要改写它）】',
            msg.content,
            '',
            '【要改的这一小段】',
            selected,
            '',
            '【更改要求】',
            instruction,
          ].join('\n'),
        },
      ],
      temperature: play.model_override ? 0.8 : 0.7,
      maxTokens: 4000,
    })

    const rewritten = result.content.trim()
    if (!rewritten) return c.json({ error: '模型返回了空内容。' }, 400)

    return c.json({ rewritten })
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '改写失败'
    return c.json({ error: message }, 400)
  }
})

/** 只重算这一拍的状态栏，正文一个字不动。 */
playthroughRoutes.post('/:id/messages/:messageId/state', async (c) => {
  const id = c.req.param('id')
  const messageId = c.req.param('messageId')

  const play = db
    .prepare('SELECT * FROM playthroughs WHERE id = ?')
    .get(id) as unknown as PlaythroughRow | undefined
  if (!play) return c.json({ error: '对局不存在' }, 404)

  const msg = db
    .prepare('SELECT * FROM messages WHERE id = ? AND playthrough_id = ?')
    .get(messageId, id) as unknown as MessageRow | undefined
  if (!msg) return c.json({ error: '这一拍不属于当前对局。' }, 404)
  if (msg.kind !== 'narration') return c.json({ error: '只有正文能算状态。' }, 400)

  const provider = providerFor(play)
  if (!provider?.apiKey || !provider.model) {
    return c.json({ error: '还没有可用的模型。' }, 400)
  }

  const templates = JSON.parse(play.cast_templates_json || '{}') as Record<
    string,
    Array<{ key: string; hint?: string }>
  >
  const cast = loadCast(id)

  const templateLines = cast
    .filter((m) => (templates[m.name] ?? []).length > 0)
    .map((m) => {
      const fields = templates[m.name]
        .map((f) => (f.hint ? `${f.key}（${f.hint}）` : f.key))
        .join('、')
      return `- ${m.name}：${fields}`
    })

  if (templateLines.length === 0) {
    return c.json({ error: '这一局还没有角色状态模板。' }, 400)
  }

  // 上一拍的数值作基准
  const all = loadMessages(id)
  const mine = all.find((m) => m.id === messageId)
  let prevCharacters: Record<string, Record<string, string>> = {}
  if (mine) {
    for (const m of [...all].reverse()) {
      if (m.created_at >= mine.created_at) continue
      if (m.kind !== 'narration' || !m.meta_json) continue
      try {
        const meta = JSON.parse(m.meta_json) as {
          state?: { characters?: Record<string, Record<string, string>> }
        }
        if (meta.state?.characters && Object.keys(meta.state.characters).length > 0) {
          prevCharacters = meta.state.characters
          break
        }
      } catch {
        // 跳过坏的
      }
    }
  }

  try {
    const result = await chatCompletion({
      apiBase: provider.apiBase,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [
        {
          role: 'system',
          content: '你在按模板记录小说角色状态。只输出一个 JSON 对象，不要解释、不要代码块。',
        },
        {
          role: 'user',
          content: [
            '【这一拍的正文】',
            msg.content,
            '',
            '【角色状态模板】',
            ...templateLines,
            '',
            '【输出格式】',
            '{"characters": {"角色名": {"字段名": "值"}}}',
            '只写模板里列出的角色与字段，一个都不能少；名单里不在场的也要给值。',
            '字段名或说明里出现「数值」「指数」「度」的，只写阿拉伯数字。',
            '',
            ...(Object.keys(prevCharacters).length > 0
              ? [
                  '【上一拍的数值（以此为基准）】',
                  ...Object.entries(prevCharacters).map(
                    ([name, fields]) =>
                      `- ${name}：${Object.entries(fields)
                        .map(([k, v]) => `${k}=${v}`)
                        .join('、')}`,
                  ),
                  '',
                ]
              : []),
          ].join('\n'),
        },
      ],
      temperature: 0.3,
      maxTokens: 4000,
    })

    const stateResult = parseStateJson(result.content)
    if (!stateResult) {
      return c.json({ error: '模型没有给出可解析的 JSON。' }, 400)
    }

    const meta = msg.meta_json ? (JSON.parse(msg.meta_json) as Record<string, unknown>) : {}
    const state = normalizeState(stateResult.value)
    meta.state = state
    delete meta.stateRaw
    // 状态已经重算过，之前那条「状态段不是合法 JSON」的警告就过期了
    if (Array.isArray(meta.parseWarnings)) {
      meta.parseWarnings = (meta.parseWarnings as string[]).filter(
        (w) => !w.includes('状态'),
      )
    }

    db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(
      JSON.stringify(meta),
      messageId,
    )

    return c.json({ state })
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '重算状态失败'
    return c.json({ error: message }, 400)
  }
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

/** 写作风格提示词：整篇统一的文风要求。 */
playthroughRoutes.put('/:id/style', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT id FROM playthroughs WHERE id = ?')
    .get(id) as unknown as { id: string } | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { writingStyle?: unknown }
  const text = typeof body.writingStyle === 'string' ? body.writingStyle : ''

  db.prepare('UPDATE playthroughs SET writing_style = ?, updated_at = ? WHERE id = ?').run(
    text.trim() || null,
    Date.now(),
    id,
  )

  return c.json({ writingStyle: text.trim() })
})

/** 状态累积规则：数值怎么变，可整段覆盖。 */
playthroughRoutes.put('/:id/state-rules', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT id FROM playthroughs WHERE id = ?')
    .get(id) as unknown as { id: string } | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { stateRules?: unknown }
  const text = typeof body.stateRules === 'string' ? body.stateRules : ''

  db.prepare('UPDATE playthroughs SET state_rules = ?, updated_at = ? WHERE id = ?').run(
    text.trim() || null,
    Date.now(),
    id,
  )

  return c.json({ stateRules: text.trim() })
})

/** 交付检查：追加在 system 最末的那段要求，可整段覆盖。 */
playthroughRoutes.put('/:id/delivery', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT id FROM playthroughs WHERE id = ?')
    .get(id) as unknown as { id: string } | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { deliveryCheck?: unknown }
  const text = typeof body.deliveryCheck === 'string' ? body.deliveryCheck : ''

  db.prepare('UPDATE playthroughs SET delivery_check = ?, updated_at = ? WHERE id = ?').run(
    text.trim() || null,
    Date.now(),
    id,
  )

  return c.json({ deliveryCheck: text.trim() })
})

/** 助手预填：模型会接着这句话继续写，而不是从零开始。 */
playthroughRoutes.put('/:id/prefill', async (c) => {
  const id = c.req.param('id')
  const row = db
    .prepare('SELECT id FROM playthroughs WHERE id = ?')
    .get(id) as unknown as { id: string } | undefined

  if (!row) return c.json({ error: '对局不存在' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { prefill?: unknown }
  const text = typeof body.prefill === 'string' ? body.prefill : ''

  db.prepare('UPDATE playthroughs SET prefill = ?, updated_at = ? WHERE id = ?').run(
    text || null,
    Date.now(),
    id,
  )

  return c.json({ prefill: text })
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
  // 导出带上被替换掉的旧内容（软删除的），否则备份不完整
  const messages = db
    .prepare('SELECT * FROM messages WHERE playthrough_id = ? ORDER BY created_at')
    .all(id) as unknown as MessageRow[]

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
