export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class LlmError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface ChatOptions {
  apiBase: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** 思考力度；空表示不传，由服务端默认决定 */
  reasoningEffort?: ReasoningEffort | ''
}

export interface ChatResult {
  content: string
  /** 模型侧结束原因，'length' 表示被 max_tokens 截断 */
  finishReason?: string
  usage?: { prompt: number; completion: number }
}

/**
 * 流式调用。每收到一段正文调用一次 onDelta。
 * 结束时返回完整内容与用量。SSE 解析容忍空行与心跳。
 */
export async function chatCompletionStream(
  opts: ChatOptions,
  onDelta: (text: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResult> {
  const base = opts.apiBase.replace(/\/+$/, '')
  const url = `${base}/chat/completions`

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.9,
        max_tokens: opts.maxTokens ?? 4000,
        stream: true,
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 4),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new LlmError(`连不上 ${url}（${reason}）。`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new LlmError('API 密钥无效，或这个密钥没有调用权限。', res.status)
    }
    if (res.status === 404) {
      throw new LlmError(`地址或模型名可能不对（404）。请求地址：${url}`, res.status)
    }
    if (res.status === 429) {
      throw new LlmError('被限流了，稍等一下再试。', res.status)
    }
    throw new LlmError(`模型服务返回 ${res.status}：${body.slice(0, 200)}`, res.status)
  }

  if (!res.body) {
    throw new LlmError('模型没有返回流式内容。')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoningChars = 0
  let finishReason: string | undefined
  let usage: ChatResult['usage']

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // SSE 以空行分隔事件
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')

      for (const line of rawEvent.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: unknown; reasoning_content?: unknown }
              finish_reason?: unknown
            }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }

          const deltaObj = parsed.choices?.[0]?.delta
          const reasoning = deltaObj?.reasoning_content
          if (typeof reasoning === 'string' && reasoning) reasoningChars += reasoning.length

          const delta = deltaObj?.content
          if (typeof delta === 'string' && delta) {
            content += delta
            onDelta(delta)
          }
          const finish = parsed.choices?.[0]?.finish_reason
          if (typeof finish === 'string') finishReason = finish
          if (parsed.usage) {
            usage = {
              prompt: parsed.usage.prompt_tokens ?? 0,
              completion: parsed.usage.completion_tokens ?? 0,
            }
          }
        } catch {
          // 单条事件坏了就跳过，不影响整体
        }
      }
    }
  }

  if (!content.trim()) {
    const detail =
      `finish_reason = ${finishReason ?? '未提供'}，` +
      `completion tokens = ${usage?.completion ?? 0}，` +
      `reasoning tokens = ${reasoningChars > 0 ? '有（约 ' + reasoningChars + ' 字）' : '无'}`

    if (finishReason === 'length') {
      throw new LlmError(
        `模型输出被截断（${detail}）。额度可能全花在思考上了——调大 max_tokens，或换个不思考的模型。`,
      )
    }
    throw new LlmError(
      `模型返回了空内容（${detail}）。` +
        (reasoningChars > 0
          ? '它只输出了思考过程，正文被吃掉了。调大 max_tokens 再试。'
          : '这个模型这一次什么都没给，重试或换模型。'),
    )
  }

  return { content, finishReason, usage }
}
export async function listModels(
  apiBase: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const base = apiBase.replace(/\/+$/, '')
  const url = `${base}/models`

  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new LlmError(`连不上 ${url}（${reason}）。检查 API 地址是否正确、网络是否可达。`)
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new LlmError('API 密钥无效，或这个密钥没有列出模型的权限。', res.status)
    }
    if (res.status === 404) {
      throw new LlmError(
        '这个地址没有 /models 接口（404）。有些服务不提供模型列表，可以直接手动输入模型名。',
        res.status,
      )
    }
    throw new LlmError(`获取模型列表失败：${res.status}`, res.status)
  }

  const data = (await res.json()) as unknown
  const raw: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { data?: unknown[] })?.data)
      ? (data as { data: unknown[] }).data
      : []

  const ids: string[] = []
  for (const item of raw) {
    const id =
      typeof item === 'string'
        ? item
        : typeof (item as { id?: unknown })?.id === 'string'
          ? (item as { id: string }).id
          : ''
    if (id.trim()) ids.push(id.trim())
  }

  return Array.from(new Set(ids)).sort()
}

const TIMEOUT_MS = 90_000

/**
 * OpenAI 兼容的单轮调用。
 * fetchImpl 可注入，测试里用假实现断言请求构造与错误映射。
 */
export async function chatCompletion(
  opts: ChatOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResult> {
  const base = opts.apiBase.replace(/\/+$/, '')
  const url = `${base}/chat/completions`

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 1200,
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new LlmError(`连不上 ${url}（${reason}）。检查 API 地址是否正确、网络是否可达。`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')

    if (res.status === 401 || res.status === 403) {
      throw new LlmError('API 密钥无效，或这个密钥没有调用权限。', res.status)
    }
    if (res.status === 404) {
      throw new LlmError(`地址或模型名可能不对（404）。请求地址：${url}`, res.status)
    }
    if (res.status === 429) {
      throw new LlmError('被限流了，稍等一下再试。', res.status)
    }

    throw new LlmError(`模型服务返回 ${res.status}：${body.slice(0, 200)}`, res.status)
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: unknown; reasoning_content?: unknown }
      finish_reason?: unknown
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }

  const choice = data.choices?.[0]
  const content = choice?.message?.content
  const reasoning = choice?.message?.reasoning_content
  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined

  if (typeof content !== 'string' || !content.trim()) {
    if (finish === 'length') {
      throw new LlmError(
        '模型输出被截断了（finish_reason = length）。通常是 max_tokens 太小，或者这个模型会先把额度用在思考上。换一个普通对话模型，或调大 max_tokens 再试。',
      )
    }
    if (typeof reasoning === 'string' && reasoning.trim()) {
      throw new LlmError(
        '模型只返回了思考内容，没有正文。这是推理模型（reasoner）在额度很小时的典型表现，测试连接请换一个普通对话模型。',
      )
    }
    throw new LlmError(`模型返回了空内容（finish_reason = ${finish ?? '未提供'}）。`)
  }

  return {
    content,
    finishReason: finish,
    usage: data.usage
      ? {
          prompt: data.usage.prompt_tokens ?? 0,
          completion: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  }
}
