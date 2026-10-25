import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildForest, buildPath, forkCounts } from './tree.ts'

interface Msg {
  id: string
  parentId: string | null
}

const linear: Msg[] = [
  { id: 'a', parentId: null },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'b' },
]

const forked: Msg[] = [
  { id: 'a', parentId: null },
  { id: 'b1', parentId: 'a' },
  { id: 'c1', parentId: 'b1' },
  { id: 'b2', parentId: 'a' },
  { id: 'c2', parentId: 'b2' },
]

test('线性历史：路径就是从根到叶', () => {
  assert.deepEqual(
    buildPath(linear, 'c').map((m) => m.id),
    ['a', 'b', 'c'],
  )
})

test('分叉时路径只包含当前那一枝', () => {
  assert.deepEqual(
    buildPath(forked, 'c1').map((m) => m.id),
    ['a', 'b1', 'c1'],
  )
  assert.deepEqual(
    buildPath(forked, 'c2').map((m) => m.id),
    ['a', 'b2', 'c2'],
  )
})

test('叶子为空或不存在时返回空路径', () => {
  assert.deepEqual(buildPath(linear, null), [])
  assert.deepEqual(buildPath(linear, '不存在'), [])
})

test('父指针成环时不会死循环', () => {
  const cyclic: Msg[] = [
    { id: 'x', parentId: 'y' },
    { id: 'y', parentId: 'x' },
  ]
  const path = buildPath(cyclic, 'x')
  assert.ok(path.length <= 2)
})

test('树视图保留两条分支，不丢节点', () => {
  const forest = buildForest(forked, 'c1')
  assert.equal(forest.length, 1)
  const root = forest[0]
  assert.equal(root.message.id, 'a')
  assert.equal(root.children.length, 2)

  const ids: string[] = []
  const walk = (nodes: typeof forest) => {
    for (const node of nodes) {
      ids.push(node.message.id)
      walk(node.children)
    }
  }
  walk(forest)
  assert.deepEqual(ids.sort(), ['a', 'b1', 'b2', 'c1', 'c2'])
})

test('树视图标记当前分支', () => {
  const forest = buildForest(forked, 'c2')
  const root = forest[0]
  assert.equal(root.onCurrentPath, true)

  const b1 = root.children.find((n) => n.message.id === 'b1')!
  const b2 = root.children.find((n) => n.message.id === 'b2')!
  assert.equal(b1.onCurrentPath, false)
  assert.equal(b2.onCurrentPath, true)
})

test('depth 反映层级', () => {
  const forest = buildForest(linear, 'c')
  assert.equal(forest[0].depth, 0)
  assert.equal(forest[0].children[0].depth, 1)
  assert.equal(forest[0].children[0].children[0].depth, 2)
})

test('岔口计数标出哪些节点有多个后继', () => {
  const counts = forkCounts(forked)
  assert.equal(counts.get('a'), 2)
  assert.equal(counts.get('b1'), 1)
  assert.equal(counts.get('c1'), undefined)
})
