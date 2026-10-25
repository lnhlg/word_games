import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCardDraftMessages,
  buildRevisionMessages,
  parseCardDraft,
  parseCardRevision,
} from './assist.ts'
import { chatCompletion, LlmError } from './llm.ts'
import type { CardBody } from '../shared/types.ts'

const BASE_OPTS = {
  apiBase: 'https://example.test/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

test('起草请求把需求原样带给模型，并要求完整字段', () => {
  const messages = buildCardDraftMessages('一个落魄的账房先生')
  const system = messages[0].content

  assert.equal(messages[0].role, 'system')
  assert.match(system, /JSON/)

  // 与其他几项同构的字段
  for (const field of ['personality', 'scenario', 'mesExample', 'tags']) {
    assert.ok(system.includes(field), `提示词应该要求 ${field}`)
  }

  // 描述的分节结构
  for (const section of ['【姓名】', '【身份】', '【外貌】', '【性格】', '【人际关系】', '【称谓分寸】', '【说话方式】']) {
    assert.ok(system.includes(section), `描述结构里应该有 ${section}`)
  }

  assert.equal(messages[1].role, 'user')
  assert.equal(messages[1].content, '一个落魄的账房先生')
})

test('起草结果与导入卡同构：解析出性格、场景、示例对话、标签', () => {
  const raw = JSON.stringify({
    name: '沈砚',
    description: '旧书店主人。',
    personality: '克制',
    scenario: '梅雨天',
    firstMes: '铜铃响了一声。',
    mesExample: '<START>\n{{char}}: 坐。',
    tags: ['民国', '书店'],
  })
  const draft = parseCardDraft(raw)
  assert.equal(draft.personality, '克制')
  assert.equal(draft.scenario, '梅雨天')
  assert.equal(draft.mesExample, '<START>\n{{char}}: 坐。')
  assert.deepEqual(draft.tags, ['民国', '书店'])
})

test('起草结果缺字段时留空而不是报错', () => {
  const draft = parseCardDraft('{"name":"只有名字"}')
  assert.equal(draft.name, '只有名字')
  assert.equal(draft.personality, '')
  assert.equal(draft.scenario, '')
  assert.equal(draft.mesExample, '')
  assert.deepEqual(draft.tags, [])
})

test('纯 JSON 能被解析', () => {
  const draft = parseCardDraft('{"name":"李四","description":"账房先生","firstMes":"雨夜。"}')
  assert.equal(draft.name, '李四')
  assert.equal(draft.description, '账房先生')
  assert.equal(draft.firstMes, '雨夜。')
})

test('带 Markdown 围栏的 JSON 能被解析', () => {
  const raw = '好的，这是角色卡：\n```json\n{"name":"王五","description":"刀客","firstMes":"风起。"}\n```\n希望你喜欢。'
  const draft = parseCardDraft(raw)
  assert.equal(draft.name, '王五')
  assert.equal(draft.firstMes, '风起。')
})

test('前后夹着说明文字的 JSON 能被解析', () => {
  const draft = parseCardDraft('当然可以：{"name":"赵六","description":"","firstMes":""} 请确认。')
  assert.equal(draft.name, '赵六')
})

test('模型写成 first_mes 时也能读出来', () => {
  const draft = parseCardDraft('{"name":"钱七","description":"盐商","first_mes":"码头很吵。"}')
  assert.equal(draft.firstMes, '码头很吵。')
})

test('缺少名字时视为解析失败', () => {
  assert.throws(() => parseCardDraft('{"description":"没有名字"}'), LlmError)
})

test('完全不是 JSON 时给出可读错误', () => {
  assert.throws(() => parseCardDraft('抱歉，我无法完成这个请求。'), /可解析/)
})

test('401 被翻译成密钥问题', async () => {
  const fakeFetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
  await assert.rejects(() => chatCompletion(BASE_OPTS, fakeFetch), /密钥/)
})

test('404 提示地址或模型名不对', async () => {
  const fakeFetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
  await assert.rejects(() => chatCompletion(BASE_OPTS, fakeFetch), /404/)
})

test('正常响应解析出正文', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"孙八"}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

  const result = await chatCompletion(BASE_OPTS, fakeFetch)
  assert.equal(result.content, '{"name":"孙八"}')
})

test('空内容被拒绝而不是当成成功', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

  await assert.rejects(() => chatCompletion(BASE_OPTS, fakeFetch), /空内容/)
})

test('改卡提示词不把世界书与备选开场白发出去', () => {
  const body: CardBody = {
    name: '黄蓉',
    description: '旧描述',
    firstMes: '旧开场',
    characterBook: { entries: [{ content: '机密' }] },
    alternateGreetings: ['备选一'],
  }

  const messages = buildRevisionMessages(body, '把她的年龄改成三十岁')
  const text = messages.map((m) => m.content).join('\n')

  assert.ok(text.includes('把她的年龄改成三十岁'), '应该带上指令')
  assert.ok(text.includes('黄蓉'), '应该带上原卡')
  assert.ok(!text.includes('characterBook'), '不应该把世界书发出去')
  assert.ok(!text.includes('alternateGreetings'), '不应该把备选开场白发出去')
})

test('改卡结果只覆盖模型返回的字段，其余保持原值', () => {
  const base: CardBody = {
    name: '黄蓉',
    description: '旧描述',
    firstMes: '旧开场',
    personality: '旧性格',
    tags: ['旧标签'],
    characterBook: { entries: [1] },
  }

  const next = parseCardRevision('{"name":"黄蓉","description":"新描述"}', base)

  assert.equal(next.description, '新描述', '返回的字段应该被覆盖')
  assert.equal(next.firstMes, '旧开场', '没返回的字段保持原值')
  assert.equal(next.personality, '旧性格', '没返回的字段保持原值')
  assert.deepEqual(next.tags, ['旧标签'], '没返回的标签保持原值')
  assert.deepEqual(next.characterBook, { entries: [1] }, '世界书永远保留')
})

test('改卡结果带围栏时也能解析', () => {
  const base: CardBody = { name: '黄蓉', description: '旧', firstMes: '' }
  const next = parseCardRevision('好的：\n```json\n{"description":"新"}\n```\n完成。', base)
  assert.equal(next.description, '新')
})

test('改卡结果不是 JSON 时给出可读错误', () => {
  const base: CardBody = { name: '黄蓉', description: '旧', firstMes: '' }
  assert.throws(() => parseCardRevision('我无法完成这个修改。', base), /可解析/)
})
