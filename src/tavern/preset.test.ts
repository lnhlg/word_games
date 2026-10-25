import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultPreset, parsePreset, BUILTIN_MARKERS } from './preset.ts'

test('解析标准预设：参数、片段、排布顺序', () => {
  const raw = {
    name: '我的预设',
    temperature: 0.8,
    top_p: 0.9,
    top_k: 40,
    repetition_penalty: 1.1,
    openai_max_context: 8192,
    openai_max_tokens: 600,
    prompts: [
      { identifier: 'main', name: 'Main Prompt', content: '主提示内容', role: 'system' },
      { identifier: 'charDescription', name: 'Char Description', marker: true },
      { identifier: 'jailbreak', name: 'Jailbreak', content: '结尾要求', role: 'system' },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'charDescription', enabled: true },
          { identifier: 'main', enabled: true },
          { identifier: 'jailbreak', enabled: false },
        ],
      },
    ],
  }

  const { preset, warnings } = parsePreset(raw)

  assert.equal(preset.name, '我的预设')
  assert.equal(preset.params.temperature, 0.8)
  assert.equal(preset.params.maxContext, 8192)
  assert.equal(preset.params.maxTokens, 600)
  assert.equal(warnings.length, 0)

  // 顺序必须按 prompt_order，而不是 prompts 数组
  assert.deepEqual(
    preset.prompts.map((p) => p.identifier),
    ['charDescription', 'main', 'jailbreak'],
  )
  assert.equal(preset.prompts[0].marker, true)
  assert.equal(preset.prompts[0].content, '', 'marker 槽位不该有静态文本')
  assert.equal(preset.prompts[2].enabled, false, 'enabled:false 要保留')
})

test('prompts 里有、排布里没有的槽位会被追加而不是丢弃', () => {
  const raw = {
    prompts: [
      { identifier: 'main', content: 'a' },
      { identifier: 'customNote', content: '自定义片段' },
    ],
    prompt_order: [{ character_id: 1, order: [{ identifier: 'main', enabled: true }] }],
  }

  const { preset, warnings } = parsePreset(raw)
  assert.deepEqual(
    preset.prompts.map((p) => p.identifier),
    ['main', 'customNote'],
  )
  assert.ok(warnings.some((w) => w.includes('不在排布里')))
})

test('排布里有不认识的槽位时保留并给出警告', () => {
  const raw = {
    prompts: [],
    prompt_order: [{ character_id: 1, order: [{ identifier: 'mysterySlot', enabled: true }] }],
  }

  const { preset, warnings } = parsePreset(raw)
  assert.equal(preset.prompts.length, 1)
  assert.equal(preset.prompts[0].identifier, 'mysterySlot')
  assert.equal(preset.prompts[0].name, 'mysterySlot')
  assert.ok(warnings.some((w) => w.includes('mysterySlot')))
})

test('没有 prompt_order 时按 prompts 原顺序并给出提示', () => {
  const raw = {
    prompts: [
      { identifier: 'main', content: 'a' },
      { identifier: 'jailbreak', content: 'b' },
    ],
  }
  const { preset, warnings } = parsePreset(raw)
  assert.deepEqual(
    preset.prompts.map((p) => p.identifier),
    ['main', 'jailbreak'],
  )
  assert.ok(warnings.some((w) => w.includes('prompt_order')))
})

test('缺参数时用酒馆默认值', () => {
  const { preset } = parsePreset({ prompts: [] })
  assert.equal(preset.params.temperature, 1)
  assert.equal(preset.params.maxContext, 4095)
  assert.equal(preset.params.maxTokens, 300)
})

test('不是对象时报可读错误', () => {
  assert.throws(() => parsePreset('nope'), /不是一个 JSON 对象/)
})

test('默认预设有 12 个槽位，enhanceDefinitions 默认关闭', () => {
  const preset = defaultPreset()
  assert.equal(preset.prompts.length, 12)
  assert.equal(
    preset.prompts.filter((p) => !p.enabled).map((p) => p.identifier).join(','),
    'enhanceDefinitions',
  )
  assert.equal(preset.prompts[0].identifier, 'main')
  assert.ok(BUILTIN_MARKERS.has('chatHistory'))
})
