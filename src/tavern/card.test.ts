import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCardFromPng, isPng, readPngTextChunks, stripCardTextChunks } from './png.ts'
import { normalizeCard } from './card.ts'

/* ── 构造 PNG 的帮助函数 ── */

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)))
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length, false)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(concat(typeBytes, data)), false)
  return out
}

function textChunk(keyword: string, text: string): Uint8Array {
  const head = Buffer.from(keyword, 'latin1')
  const body = Buffer.from(text, 'latin1')
  const data = new Uint8Array(head.length + 1 + body.length)
  data.set(head, 0)
  data[head.length] = 0
  data.set(body, head.length + 1)
  return chunk('tEXt', data)
}

function makePng(texts: Array<{ keyword: string; text: string }>): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = chunk('IHDR', new Uint8Array(13))
  const iend = chunk('IEND', new Uint8Array(0))
  return concat(signature, ihdr, ...texts.map((t) => textChunk(t.keyword, t.text)), iend)
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '李四',
    description: '落魄的账房先生，说话慢。',
    personality: '谨慎',
    scenario: '雨夜的当铺',
    first_mes: '他抱着木匣子站在门口。',
    mes_example: '<START>\n{{user}}: 你来做什么？\n{{char}}: 借钱。',
    creator_notes: '示例卡',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['另一段开场。'],
    tags: ['古风'],
    creator: 'tester',
    character_version: '1.0',
    extensions: { world: '江湖' },
  },
}

const V3_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '王五',
    description: '刀客。',
    personality: '沉默',
    scenario: '渡口',
    first_mes: '风起。',
    mes_example: '',
    creator_notes: '示例',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    group_only_greetings: [],
    tags: [],
    creator: '',
    character_version: '1.0',
    extensions: {},
    assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
    nickname: '老五',
    source: ['https://example.com'],
  },
}

/* ── PNG 层 ── */

test('识别 PNG 签名', () => {
  assert.equal(isPng(makePng([])), true)
  assert.equal(isPng(new Uint8Array([1, 2, 3])), false)
})

test('按 chunk 取出 tEXt 内容', () => {
  const png = makePng([{ keyword: 'chara', text: 'hello' }])
  const chunks = readPngTextChunks(png)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].keyword, 'chara')
  assert.equal(chunks[0].text, 'hello')
})

test('从 PNG 里取出 V2 卡', () => {
  const png = makePng([{ keyword: 'chara', text: b64(V2_CARD) }])
  const { json, keyword } = extractCardFromPng(png)
  assert.equal(keyword, 'chara')
  assert.equal((json as typeof V2_CARD).data.name, '李四')
})

test('ccv3 与 chara 并存时优先 ccv3', () => {
  const png = makePng([
    { keyword: 'chara', text: b64(V2_CARD) },
    { keyword: 'ccv3', text: b64(V3_CARD) },
  ])
  const { json, keyword } = extractCardFromPng(png)
  assert.equal(keyword, 'ccv3')
  assert.equal((json as typeof V3_CARD).data.name, '王五')
})

test('关键字大小写不敏感', () => {
  const png = makePng([{ keyword: 'CCV3', text: b64(V3_CARD) }])
  assert.equal(extractCardFromPng(png).keyword, 'CCV3')
})

test('普通 PNG（没有角色卡段）给出可读错误', () => {
  const png = makePng([{ keyword: 'Software', text: 'photoshop' }])
  assert.throws(() => extractCardFromPng(png), /没有角色卡数据/)
})

test('非 PNG 字节被拒绝', () => {
  assert.throws(() => extractCardFromPng(new Uint8Array([1, 2, 3, 4])), /不是一个 PNG/)
})

test('base64 解出来不是 JSON 时报错', () => {
  const png = makePng([{ keyword: 'chara', text: 'bm90IGpzb24=' }]) // "not json"
  assert.throws(() => extractCardFromPng(png), /不是合法 JSON/)
})

test('剥离卡数据后仍是合法 PNG，但不再含角色卡', () => {
  const png = makePng([
    { keyword: 'chara', text: b64(V2_CARD) },
    { keyword: 'Software', text: 'keep-me' },
  ])
  const stripped = stripCardTextChunks(png)

  assert.equal(isPng(stripped), true)
  assert.throws(() => extractCardFromPng(stripped), /没有角色卡数据/)

  const kept = readPngTextChunks(stripped)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].keyword, 'Software')
  assert.ok(stripped.length < png.length)
})

/* ── 归一与保真度 ── */

test('V2 卡归一成卡体，并记录读到的字段', () => {
  const { body, fidelity } = normalizeCard(V2_CARD)
  assert.equal(body.name, '李四')
  assert.equal(body.firstMes, '他抱着木匣子站在门口。')
  assert.equal(body.personality, '谨慎')
  assert.deepEqual(body.tags, ['古风'])
  assert.equal(fidelity.specVersion, '2.0')
  assert.ok(fidelity.read.includes('first_mes'))
  assert.ok(fidelity.ignored.some((i) => i.startsWith('extensions')))
})

test('V3 卡归一，V3 专属字段进 ignored', () => {
  const { body, fidelity } = normalizeCard(V3_CARD)
  assert.equal(body.name, '王五')
  assert.equal(fidelity.specVersion, '3.0')
  for (const key of ['assets', 'nickname', 'source']) {
    assert.ok(fidelity.ignored.includes(key), `${key} 应该被记为 ignored`)
  }
})

test('V1 扁平卡也能导入', () => {
  const v1 = { name: '赵六', description: '盐商', personality: '精明', scenario: '', first_mes: '', mes_example: '' }
  const { body, fidelity } = normalizeCard(v1)
  assert.equal(body.name, '赵六')
  assert.equal(fidelity.specVersion, '1.0')
})

test('标了 V3 却缺 group_only_greetings 记为降级（酒馆实际产出的形态）', () => {
  const halfV3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { ...V2_CARD.data } }
  const { fidelity } = normalizeCard(halfV3)
  assert.equal(fidelity.specVersion, '3.0')
  assert.ok(fidelity.degraded.some((d) => d.field === 'group_only_greetings'))
})

test('认不出的格式给出可读错误', () => {
  assert.throws(() => normalizeCard({ foo: 'bar' }), /认不出/)
})

test('缺名字时拒绝导入', () => {
  assert.throws(
    () => normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { description: 'x' } }),
    /没有名字/,
  )
})

test('卡内世界书被保留并标记为已映射', () => {
  const withBook = {
    ...V2_CARD,
    data: { ...V2_CARD.data, character_book: { entries: [] } },
  }
  const { body, fidelity } = normalizeCard(withBook)
  assert.ok(body.characterBook)
  assert.ok(fidelity.mapped.character_book)
})

test('不支持的宏给出警告', () => {
  const card = {
    ...V2_CARD,
    data: { ...V2_CARD.data, description: '{{random::甲,乙}} 出现，{{char}} 笑了。' },
  }
  const { fidelity } = normalizeCard(card)
  assert.ok(fidelity.warnings.some((w) => w.includes('{{random}}')))
})
