import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activateEntries, mapNumericPosition, parseLorebook, type LoreEntry } from './lorebook.ts'

function entry(patch: Partial<LoreEntry> = {}): LoreEntry {
  return {
    id: '1',
    keys: [],
    secondaryKeys: [],
    content: '内容',
    comment: '',
    constant: false,
    selective: false,
    selectiveLogic: 0,
    position: 'before',
    depth: 4,
    order: 100,
    enabled: true,
    ...patch,
  }
}

/* ── 解析：两套命名 ── */

test('解析独立世界书（entries 是对象 map，字段 key/order/disable）', () => {
  const raw = {
    name: '城南旧事',
    entries: {
      '0': {
        uid: 0,
        key: ['码头', '卸货'],
        keysecondary: [],
        content: '十六铺在夜里最忙。',
        comment: '码头',
        constant: false,
        selective: false,
        order: 20,
        position: 0,
        depth: 4,
        disable: false,
      },
      '1': {
        uid: 1,
        key: ['黄蓉'],
        content: '常驻设定',
        constant: true,
        order: 10,
        position: 1,
        disable: true,
      },
    },
  }

  const book = parseLorebook(raw)
  assert.equal(book.name, '城南旧事')
  assert.equal(book.entries.length, 2)
  assert.deepEqual(book.entries[0].keys, ['码头', '卸货'])
  assert.equal(book.entries[0].order, 20)
  assert.equal(book.entries[0].position, 'before')
  assert.equal(book.entries[0].enabled, true)
  assert.equal(book.entries[1].enabled, false, 'disable:true 应转成 enabled:false')
  assert.equal(book.entries[1].position, 'after')
  assert.equal(book.entries[1].constant, true)
})

test('解析卡内世界书（entries 是数组，字段 keys/insertion_order/enabled）', () => {
  const raw = {
    name: '黄蓉 · 襄阳郭府',
    entries: [
      {
        id: 0,
        keys: ['郭靖', '靖哥哥'],
        secondary_keys: [],
        content: '郭靖是她的丈夫。',
        enabled: true,
        insertion_order: 20,
        position: 'before_char',
        constant: false,
      },
      {
        id: 1,
        keys: ['郭芙'],
        content: '骄纵的长女。',
        enabled: false,
        insertion_order: 30,
        position: 'after_char',
      },
    ],
  }

  const book = parseLorebook(raw)
  assert.equal(book.entries.length, 2)
  assert.deepEqual(book.entries[0].keys, ['郭靖', '靖哥哥'])
  assert.equal(book.entries[0].order, 20)
  assert.equal(book.entries[0].position, 'before')
  assert.equal(book.entries[1].enabled, false)
  assert.equal(book.entries[1].position, 'after')
})

test('本项目内部格式可以再次读回', () => {
  const book = {
    name: '内部',
    entries: [entry({ keys: ['甲'], position: 'depth', depth: 2 })],
  }
  const parsed = parseLorebook(book)
  assert.equal(parsed.entries[0].position, 'depth')
  assert.equal(parsed.entries[0].depth, 2)
  assert.deepEqual(parsed.entries[0].keys, ['甲'])
})

test('缺 entries 或格式不对时报可读错误', () => {
  assert.throws(() => parseLorebook({}), /entries/)
  assert.throws(() => parseLorebook(null), /不是一个 JSON 对象/)
})

test('position 数值映射：0 前、4 深度、其余后', () => {
  assert.equal(mapNumericPosition(0), 'before')
  assert.equal(mapNumericPosition(4), 'depth')
  assert.equal(mapNumericPosition(1), 'after')
  assert.equal(mapNumericPosition(7), 'after')
})

/* ── 激活 ── */

test('常驻条目不看关键词就命中', () => {
  const results = activateEntries([entry({ constant: true, keys: ['不存在的词'] })], '随便一段话')
  assert.equal(results[0].matched, true)
  assert.match(results[0].reason, /常驻/)
})

test('主关键词命中即激活', () => {
  const results = activateEntries([entry({ keys: ['码头'] })], '船停在码头')
  assert.equal(results[0].matched, true)
  assert.match(results[0].reason, /码头/)
})

test('主关键词没出现时说明差在哪', () => {
  const results = activateEntries([entry({ keys: ['码头', '卸货'] })], '他在书房看书')
  assert.equal(results[0].matched, false)
  assert.match(results[0].reason, /码头、卸货/)
})

test('禁用条目永远不激活', () => {
  const results = activateEntries([entry({ enabled: false, constant: true })], '任何话')
  assert.equal(results[0].matched, false)
  assert.match(results[0].reason, /已禁用/)
})

test('大小写不敏感（默认）', () => {
  const results = activateEntries([entry({ keys: ['Eldoria'] })], 'in the eldoria forest')
  assert.equal(results[0].matched, true)
})

test('可以要求大小写敏感', () => {
  const results = activateEntries([entry({ keys: ['Eldoria'] })], 'in the eldoria forest', {
    caseSensitive: true,
  })
  assert.equal(results[0].matched, false)
})

test('次级逻辑 0=AND ANY：次级任一命中就通过', () => {
  const e = entry({ keys: ['码头'], secondaryKeys: ['夜', '早'], selective: true, selectiveLogic: 0 })
  assert.equal(activateEntries([e], '码头夜里')[0].matched, true)
  assert.equal(activateEntries([e], '码头白天')[0].matched, false)
})

test('次级逻辑 1=NOT ALL：不是全部命中就通过', () => {
  const e = entry({ keys: ['码头'], secondaryKeys: ['夜', '雨'], selective: true, selectiveLogic: 1 })
  assert.equal(activateEntries([e], '码头的夜里')[0].matched, true, '只命中一个 → 通过')
  assert.equal(activateEntries([e], '码头夜里下雨')[0].matched, false, '全部命中 → 不通过')
})

test('次级逻辑 2=NOT ANY：次级一个都不命中才通过', () => {
  const e = entry({ keys: ['码头'], secondaryKeys: ['夜', '雨'], selective: true, selectiveLogic: 2 })
  assert.equal(activateEntries([e], '码头的白天')[0].matched, true)
  assert.equal(activateEntries([e], '码头夜里')[0].matched, false)
})

test('次级逻辑 3=AND ALL：必须全部命中', () => {
  const e = entry({ keys: ['码头'], secondaryKeys: ['夜', '雨'], selective: true, selectiveLogic: 3 })
  assert.equal(activateEntries([e], '码头夜里下雨')[0].matched, true)
  assert.equal(activateEntries([e], '码头夜里')[0].matched, false)
})

test('selective 为 false 时次级关键词被忽略', () => {
  const e = entry({ keys: ['码头'], secondaryKeys: ['雨'], selective: false, selectiveLogic: 3 })
  assert.equal(activateEntries([e], '码头')[0].matched, true)
})

test('没有关键词的非常驻条目不会命中', () => {
  const results = activateEntries([entry({ keys: [] })], '任何话')
  assert.equal(results[0].matched, false)
})

test('返回结果覆盖全部条目，不只是命中的', () => {
  const results = activateEntries(
    [entry({ id: 'a', keys: ['甲'] }), entry({ id: 'b', keys: ['乙'] })],
    '甲出现了',
  )
  assert.equal(results.length, 2)
  assert.equal(results.filter((r) => r.matched).length, 1)
})
