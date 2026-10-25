import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assemble, directorPatch } from './assembly.ts'
import { defaultPreset } from '../tavern/preset.ts'
import type { CardBody, Lorebook, Preset } from '../shared/types.ts'

function actor(name: string, body: Partial<CardBody> = {}) {
  return {
    name,
    body: {
      name,
      description: `${name}的描述，说话慢。`,
      firstMes: '',
      personality: `${name}的性格。`,
      scenario: `${name}所处场景。`,
      mesExample: `<START>\n{{char}}: 我是${name}。`,
      ...body,
    } as CardBody,
  }
}

const lorebook: Lorebook = {
  name: '城南旧事',
  entries: [
    {
      id: '1',
      keys: ['码头'],
      secondaryKeys: [],
      content: '码头夜里最忙。',
      comment: '码头规矩',
      constant: false,
      selective: false,
      selectiveLogic: 0,
      position: 'before',
      depth: 4,
      order: 10,
      enabled: true,
    },
    {
      id: '2',
      keys: ['码头'],
      secondaryKeys: [],
      content: '结尾处的补充。',
      comment: '码头后注',
      constant: false,
      selective: false,
      selectiveLogic: 0,
      position: 'after',
      depth: 4,
      order: 20,
      enabled: true,
    },
    {
      id: '3',
      keys: ['从没出现的词'],
      secondaryKeys: [],
      content: '不该出现。',
      comment: '未命中条目',
      constant: false,
      selective: false,
      selectiveLogic: 0,
      position: 'before',
      depth: 4,
      order: 30,
      enabled: true,
    },
  ],
}

function baseInput(overrides: Partial<Parameters<typeof assemble>[0]> = {}) {
  return {
    actors: [actor('沈砚'), actor('阿棠')],
    presentNames: ['沈砚', '阿棠'],
    preset: defaultPreset(),
    scanText: '码头',
    ...overrides,
  }
}

test('段落顺序与预设排布一致', () => {
  const result = assemble(
    baseInput({
      lorebook,
      history: [{ kind: 'narration', content: '雨落在瓦上。' }],
    }),
  )
  const ids = result.sections.map((s) => s.identifier)

  // worldInfoAfter 在 dialogueExamples 之前；chatHistory 在其后
  const order = ids.filter((id) => id !== 'director-patch')
  assert.deepEqual(order, [
    'main',
    'worldInfoBefore',
    'charDescription',
    'charPersonality',
    'scenario',
    'worldInfoAfter',
    'dialogueExamples',
    'chatHistory',
  ])
})

test('导演补丁永远在最后一段', () => {
  const result = assemble(baseInput())
  const last = result.sections[result.sections.length - 1]
  assert.equal(last.identifier, 'director-patch')
  assert.match(last.content, /导演模式/)
  assert.match(last.content, /不要写/)
})

test('禁用的排布槽位不出现', () => {
  const preset = defaultPreset()
  // 默认 enhanceDefinitions 是关的；这里把 scenario 也关掉
  preset.prompts = preset.prompts.map((p) =>
    p.identifier === 'scenario' ? { ...p, enabled: false } : p,
  )

  const result = assemble(baseInput({ preset }))
  assert.ok(!result.sections.some((s) => s.identifier === 'scenario'))
})

test('多张卡时角色描述按每人一段展开', () => {
  const result = assemble(baseInput())
  const desc = result.sections.find((s) => s.identifier === 'charDescription')
  assert.ok(desc)
  assert.match(desc.content, /【沈砚】/)
  assert.match(desc.content, /【阿棠】/)
})

test('不在场角色只占一行，不展开描述', () => {
  const result = assemble(baseInput({ presentNames: ['沈砚'] }))
  const desc = result.sections.find((s) => s.identifier === 'charDescription')

  assert.ok(desc)
  assert.match(desc.content, /【沈砚】/)
  assert.ok(!desc.content.includes('【阿棠】'), '不在场角色不该有描述段')
  assert.match(desc.content, /（不在场）阿棠/)
})

test('世界书只注入命中的条目，并按 before/after 分流', () => {
  const result = assemble(baseInput({ lorebook }))

  const before = result.sections.find((s) => s.identifier === 'worldInfoBefore')
  const after = result.sections.find((s) => s.identifier === 'worldInfoAfter')

  assert.ok(before)
  assert.match(before.content, /码头夜里最忙/)
  assert.ok(!before.content.includes('不该出现'))

  assert.ok(after)
  assert.match(after.content, /结尾处的补充/)
})

test('世界书一条都没命中时给出警告', () => {
  const result = assemble(baseInput({ lorebook, scanText: '完全无关的文本' }))
  assert.ok(result.warnings.some((w) => w.includes('一条都没命中')))
})

test('用户人设槽位在导演模式下为空并给出说明', () => {
  const result = assemble(baseInput())
  assert.ok(!result.sections.some((s) => s.identifier === 'personaDescription'))
  assert.ok(result.warnings.some((w) => w.includes('用户人设')))
})

test('宏被替换成角色名与视角名', () => {
  const result = assemble(baseInput({ perspectiveName: '旅人' }))
  const main = result.sections.find((s) => s.identifier === 'main')
  assert.ok(main)
  assert.ok(!result.prompt.includes('{{user}}'), '不该留下裸宏')
  assert.ok(!result.prompt.includes('{{char}}'), '不该留下裸宏')

  const examples = result.sections.find((s) => s.identifier === 'dialogueExamples')
  assert.ok(examples)
  assert.match(examples.content, /我是沈砚/)
})

test('历史消息带上导演前缀', () => {
  const result = assemble(
    baseInput({
      history: [
        { kind: 'narration', content: '雨落在瓦上。' },
        { kind: 'director', content: '让阿棠进门' },
      ],
    }),
  )
  const chat = result.sections.find((s) => s.identifier === 'chatHistory')
  assert.ok(chat)
  assert.match(chat.content, /雨落在瓦上/)
  assert.match(chat.content, /导演：让阿棠进门/)
})

test('本局规则排在导演补丁之前，补丁仍然收尾', () => {
  const result = assemble(baseInput({ extraRules: '本局不要出现现代词汇。' }))

  const rulesAt = result.sections.findIndex((s) => s.identifier === 'extra-rules')
  const patchAt = result.sections.findIndex((s) => s.identifier === 'director-patch')

  assert.ok(rulesAt >= 0, '应该有本局规则这一节')
  assert.ok(patchAt > rulesAt, '导演补丁必须在规则之后')
  assert.equal(patchAt, result.sections.length - 1, '导演补丁必须是最后一节')
})

test('没有本局规则时不产生空节', () => {
  const result = assemble(baseInput())
  assert.ok(!result.sections.some((s) => s.identifier === 'extra-rules'))
})

test('prompt 里包含各段标题，便于阅读', () => {
  const result = assemble(baseInput({ lorebook }))
  assert.match(result.prompt, /### 主提示/)
  assert.match(result.prompt, /### 导演模式补丁/)
})

test('有了前情提要时，它排在最近对话之前', () => {
  const result = assemble(
    baseInput({
      memory: '郭靖与黄蓉已议定明日去守备府。',
      history: [{ kind: 'narration', content: '雨还在下。' }],
    }),
  )

  const chat = result.sections.find((s) => s.identifier === 'chatHistory')
  assert.ok(chat)
  const memoryAt = chat.content.indexOf('【前情】')
  const historyAt = chat.content.indexOf('雨还在下')
  assert.ok(memoryAt >= 0, '应该包含前情')
  assert.ok(memoryAt < historyAt, '前情应该在最近对话之前')
  assert.match(chat.source, /前情提要/)
})

test('超出预算时给出警告并报告估算', () => {
  const result = assemble(baseInput({ budgetChars: 100 }))
  assert.ok(result.warnings.some((w) => w.includes('超出预算')))
  assert.ok(result.charCount > 100)
  assert.ok(result.estimatedTokens > 0)
})

test('自定义槽位原样进入装配', () => {
  const preset = defaultPreset()
  preset.prompts.splice(1, 0, {
    identifier: 'writingRules',
    name: '写作规矩',
    content: '每段不超过三百字。',
    role: 'system',
    systemPrompt: true,
    marker: false,
    enabled: true,
  })

  const result = assemble(baseInput({ preset }))
  const custom = result.sections.find((s) => s.identifier === 'writingRules')
  assert.ok(custom)
  assert.equal(custom.content, '每段不超过三百字。')
})

test('导演补丁可以按字数区间生成', () => {
  assert.match(directorPatch(300, 600), /300–600 字/)
})
