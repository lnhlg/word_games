import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractCardFromPng } from './png.ts'
import { normalizeCard } from './card.ts'

const FIXTURE = resolve(process.cwd(), 'docs/fixtures/real-huangrong.png')
const hasFixture = existsSync(FIXTURE)

/**
 * 真实酒馆卡回归样本（851 KB，作者自用卡）。
 * 拿它兜底，是因为手造的 fixture 只能证明「按我的理解能跑」，
 * 不能证明「真实卡能跑」。
 */
test('真实酒馆卡：能解析出完整内容', { skip: !hasFixture ? '缺少 docs/fixtures/real-huangrong.png' : false }, () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const { json } = extractCardFromPng(bytes)
  const { body, fidelity } = normalizeCard(json)

  assert.equal(body.name, '黄蓉')
  assert.ok(body.description.length > 1000, '描述应该是长文（分节结构）')
  assert.match(body.description, /【身份】/)
  // 真实卡的小节名会带括号注释，例如「【称谓分寸（务必遵守）】」，所以用前缀匹配
  assert.match(body.description, /【称谓分寸/)
  assert.ok(body.firstMes.length > 100, '应该有登场引子')
  assert.ok(body.mesExample && body.mesExample.length > 300, '应该有示例对话')
  assert.ok((body.tags ?? []).length >= 5, '应该有标签')
  assert.ok((body.alternateGreetings ?? []).length >= 2, '应该有备选开场白')

  assert.equal(fidelity.specVersion, '3.0')
  assert.ok(fidelity.read.includes('first_mes'))
})

test('真实酒馆卡：内嵌世界书 10 条，条目字段完整', { skip: !hasFixture ? '缺少真实卡样本' : false }, async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const { json } = extractCardFromPng(bytes)
  const { body } = normalizeCard(json)

  assert.ok(body.characterBook, '应该有内嵌世界书')

  const { parseLorebook } = await import('./lorebook.ts')
  const book = parseLorebook(body.characterBook)

  assert.equal(book.entries.length, 10)
  const huangrong = book.entries.find((e) => e.comment === '黄蓉')
  assert.ok(huangrong, '应该有以黄蓉命名的条目')
  assert.equal(huangrong?.constant, true)
  assert.ok((huangrong?.keys ?? []).includes('蓉儿'))
  assert.equal(huangrong?.position, 'before')

  // 每一条都该有内容与关键词，不该有解析成空壳的
  for (const entry of book.entries) {
    assert.ok(entry.content.length > 0, `条目「${entry.comment}」内容为空`)
    assert.ok(entry.keys.length > 0, `条目「${entry.comment}」没有关键词`)
  }
})

test('真实酒馆卡：被识别为「V2 数据 + V3 标记」并给出说明', { skip: !hasFixture ? '缺少真实卡样本' : false }, () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const { json } = extractCardFromPng(bytes)
  const { fidelity } = normalizeCard(json)

  const degraded = fidelity.degraded.find((d) => d.field === 'group_only_greetings')
  assert.ok(degraded, '应该识别出缺 V3 必填字段')
  assert.match(degraded!.reason, /不影响使用/)
})

test('真实酒馆卡：头像剥离后不含角色卡数据', { skip: !hasFixture ? '缺少真实卡样本' : false }, async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const { stripCardTextChunks } = await import('./png.ts')

  const stripped = stripCardTextChunks(bytes)
  assert.ok(stripped.length < bytes.length, '剥离后应该变小')
  assert.ok(!Buffer.from(stripped).includes(Buffer.from('chara')), '不该残留卡数据段')
})
