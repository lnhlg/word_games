import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletionStream, listModels, LlmError } from './llm.ts'

function fakeJson(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

test('解析 OpenAI 标准的 { data: [{ id }] }', async () => {
  const models = await listModels(
    'https://example.test/v1',
    'sk-test',
    fakeJson({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
  )
  assert.deepEqual(models, ['gpt-4o', 'gpt-4o-mini'])
})

test('解析裸数组 ["model-a"]', async () => {
  const models = await listModels('https://example.test/v1', 'sk-test', fakeJson(['b-model', 'a-model']))
  assert.deepEqual(models, ['a-model', 'b-model'])
})

test('去重并忽略空项', async () => {
  const models = await listModels(
    'https://example.test/v1',
    'sk-test',
    fakeJson({ data: [{ id: 'x' }, { id: 'x' }, { id: '' }, {}, { id: 123 }] }),
  )
  assert.deepEqual(models, ['x'])
})

test('未知响应形状返回空列表而不是崩', async () => {
  const models = await listModels('https://example.test/v1', 'sk-test', fakeJson({ oops: true }))
  assert.deepEqual(models, [])
})

test('401 被翻译成密钥问题', async () => {
  await assert.rejects(
    () => listModels('https://example.test/v1', 'sk-test', fakeJson({}, 401)),
    /密钥/,
  )
})

test('404 提示可以手动填模型名', async () => {
  await assert.rejects(
    () => listModels('https://example.test/v1', 'sk-test', fakeJson({}, 404)),
    /手动输入/,
  )
})

test('请求打到 /models 并带上鉴权头', async () => {
  let capturedUrl = ''
  let capturedAuth = ''
  const spy = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  await listModels('https://example.test/v1/', 'sk-abc', spy)

  assert.equal(capturedUrl, 'https://example.test/v1/models')
  assert.equal(capturedAuth, 'Bearer sk-abc')
})

test('连接失败给出可读错误', async () => {
  const failing = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch

  await assert.rejects(() => listModels('http://127.0.0.1:1/v1', 'sk-test', failing), LlmError)
})

/* ── 流式 ── */

function sseResponse(chunks: string[]): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch
}

const STREAM_OPTS = {
  apiBase: 'https://example.test/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

test('流式：逐块回调并拼出完整正文', async () => {
  const fetchImpl = sseResponse([
    'data: {"choices":[{"delta":{"content":"雨"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"落了"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  const deltas: string[] = []
  const result = await chatCompletionStream(STREAM_OPTS, (text) => deltas.push(text), fetchImpl)

  assert.deepEqual(deltas, ['雨', '落了'])
  assert.equal(result.content, '雨落了')
  assert.equal(result.finishReason, 'stop')
})

test('流式：一个事件被拆成两个 TCP 块也能解析', async () => {
  const fetchImpl = sseResponse([
    'data: {"choices":[{"delta":{"con',
    'tent":"断点"}}]}\n\n',
    'data: [DONE]\n\n',
  ])

  const result = await chatCompletionStream(STREAM_OPTS, () => {}, fetchImpl)
  assert.equal(result.content, '断点')
})

test('流式：坏掉的事件被跳过，不影响其余内容', async () => {
  const fetchImpl = sseResponse([
    'data: 这不是 JSON\n\n',
    'data: {"choices":[{"delta":{"content":"好的"}}]}\n\n',
    'data: [DONE]\n\n',
  ])

  const result = await chatCompletionStream(STREAM_OPTS, () => {}, fetchImpl)
  assert.equal(result.content, '好的')
})

test('流式：空内容且被截断时说明是 max_tokens 问题', async () => {
  const fetchImpl = sseResponse([
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  await assert.rejects(() => chatCompletionStream(STREAM_OPTS, () => {}, fetchImpl), /截断/)
})

test('流式：KEY 无效时给出密钥错误', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
  await assert.rejects(() => chatCompletionStream(STREAM_OPTS, () => {}, fetchImpl), /密钥/)
})

test('输出被截断时提示 max_tokens 太小', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

  const { chatCompletion } = await import('./llm.ts')
  await assert.rejects(
    () =>
      chatCompletion(
        { apiBase: 'https://example.test/v1', apiKey: 'k', model: 'm', messages: [] },
        fetchImpl,
      ),
    /截断/,
  )
})

test('只返回思考内容时提示换普通模型', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { content: '', reasoning_content: '让我想想……' }, finish_reason: 'stop' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

  const { chatCompletion } = await import('./llm.ts')
  await assert.rejects(
    () =>
      chatCompletion(
        { apiBase: 'https://example.test/v1', apiKey: 'k', model: 'm', messages: [] },
        fetchImpl,
      ),
    /推理模型/,
  )
})
