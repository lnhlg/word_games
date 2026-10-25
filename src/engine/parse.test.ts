import { test } from 'node:test'
import assert from 'node:assert/strict'
import { narrationOnly, parseBeat, detectRefusal } from './parse.ts'

const FULL = `【正文】
雨打在瓦上，密得像有人在天上撒豆子。黄蓉坐在灯下核账。

【状态】
{"scene":{"location":"郭府前厅","time":"雨夜"},"present":["黄蓉","郭靖"],"relations":[{"a":"黄蓉","b":"郭靖","note":"相知多年"}],"notes":["军粮只够二十日"]}

【岔路】
1. 如果吕文德当众提起议和 → 会把场面推向官面与江湖的对峙
2. 如果郭靖决定亲自去催粮 → 会把叙事转向城外的险路
3. 如果账册上少了一笔 → 会把故事从守城拉向内鬼`

test('标准三段：正文、状态、岔路都能拆出来', () => {
  const beat = parseBeat(FULL)

  assert.match(beat.narration, /雨打在瓦上/)
  assert.ok(!beat.narration.includes('【状态】'))
  assert.equal(beat.state?.scene.location, '郭府前厅')
  assert.deepEqual(beat.state?.present, ['黄蓉', '郭靖'])
  assert.equal(beat.state?.relations[0].note, '相知多年')
  assert.equal(beat.forks?.length, 3)
  assert.equal(beat.forks?.[0].trigger, '如果吕文德当众提起议和')
  assert.match(beat.forks?.[0].toward ?? '', /官面与江湖的对峙/)
  assert.equal(beat.warnings.length, 0)
})

test('缺状态段：正文照常，警告可见', () => {
  const beat = parseBeat('【正文】\n只有正文。\n\n【岔路】\n1. 甲 → 乙')
  assert.equal(beat.narration, '只有正文。')
  assert.equal(beat.state, undefined)
  assert.ok(beat.warnings.some((w) => w.includes('没有给出状态段')))
})

test('状态 JSON 损坏：正文不受影响', () => {
  const beat = parseBeat('【正文】\n正文在。\n\n【状态】\n{这不是 JSON')
  assert.equal(beat.narration, '正文在。')
  assert.equal(beat.state, undefined)
  assert.ok(beat.warnings.some((w) => w.includes('不是合法 JSON')))
})

test('完全没有三段标记时，整段当正文', () => {
  const beat = parseBeat('模型直接写了一段小说，没有分段。')
  assert.equal(beat.narration, '模型直接写了一段小说，没有分段。')
  assert.ok(beat.warnings.some((w) => w.includes('没有按三段格式')))
})

test('岔路支持多种箭头写法', () => {
  const beat = parseBeat('【正文】\n正文\n\n【岔路】\n1. 甲 → 乙\n2. 丙 -> 丁\n3. 戊 => 己')
  assert.equal(beat.forks?.length, 3)
  assert.equal(beat.forks?.[1].trigger, '丙')
  assert.equal(beat.forks?.[2].toward, '己')
})

test('岔路最多取三条', () => {
  const lines = Array.from({ length: 5 }, (_, i) => `${i + 1}. 甲${i} → 乙${i}`).join('\n')
  const beat = parseBeat(`【正文】\n正文\n\n【岔路】\n${lines}`)
  assert.equal(beat.forks?.length, 3)
})

test('空输入被当成错误而不是静默通过', () => {
  const beat = parseBeat('   ')
  assert.equal(beat.narration, '')
  assert.ok(beat.warnings.length > 0)
})

test('状态里带角色状态时能拆出来', () => {
  const raw = `【正文】\n正文。\n\n【状态】\n{"scene":{"location":"前厅","time":"夜"},"present":["黄蓉"],"relations":[],"notes":[],"characters":{"黄蓉":{"心情":"疲惫但镇定","对郭靖":"心疼"},"郭靖":{"心情":"沉默"}}}\n\n【岔路】\n1. 甲 → 乙`

  const beat = parseBeat(raw)
  assert.equal(beat.state?.characters['黄蓉']?.['心情'], '疲惫但镇定')
  assert.equal(beat.state?.characters['郭靖']?.['心情'], '沉默')
})

test('没有角色状态时，characters 是空对象而不是 undefined', () => {
  const beat = parseBeat('【正文】\n正文\n\n【状态】\n{"scene":{},"present":[],"relations":[],"notes":[]}')
  assert.deepEqual(beat.state?.characters, {})
})

test('角色状态里的数字与空值被正确归一', () => {
  const raw = `【正文】\n正文\n\n【状态】\n{"characters":{"黄蓉":{"好感":3,"备注":""}}}`
  const beat = parseBeat(raw)
  assert.equal(beat.state?.characters['黄蓉']?.['好感'], '3')
  assert.equal(beat.state?.characters['黄蓉']?.['备注'], undefined, '空值不该留下空字符串')
})

test('流式显示只保留正文', () => {
  assert.equal(narrationOnly('雨落在瓦上。\n【状态】{'), '雨落在瓦上。\n')
  assert.equal(narrationOnly('还没有标记的中间态'), '还没有标记的中间态')
})

test('英文拒答能被认出来', () => {
  const text =
    'I cannot fulfill this request. I am programmed to be a helpful and harmless AI assistant.'
  assert.ok(detectRefusal(text))
})

test('中文拒答能被认出来', () => {
  assert.ok(detectRefusal('抱歉，我无法生成这类内容。'))
  assert.ok(detectRefusal('作为一个 AI，我不能继续这个场景。'))
})

test('长正文里角色说「我不能」不会被误判成拒答', () => {
  const narration = `「我不能。」她说。${'雨落在瓦上，檐下的灯笼晃了一晃。'.repeat(40)}`
  assert.equal(detectRefusal(narration), null)
})

test('正常正文不会被当成拒答', () => {
  assert.equal(detectRefusal('黄蓉立在书房门外，手已经抬到一半，却又停住了。'), null)
})
