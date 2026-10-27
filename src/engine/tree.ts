export interface TreeMessage {
  id: string
  parentId: string | null
}

export interface TreeNode<T> {
  message: T
  depth: number
  children: TreeNode<T>[]
  /** 这一条是不是当前所在的分支 */
  onCurrentPath: boolean
}

/**
 * 从根到叶的路径。叶为空或找不到时返回空数组。
 * 演出只该基于这条路径，而不是所有消息按时间排。
 */
export function buildPath<T extends TreeMessage>(messages: T[], leafId: string | null): T[] {
  if (!leafId) return []

  const byId = new Map(messages.map((m) => [m.id, m]))
  const path: T[] = []
  const seen = new Set<string>()

  let current = byId.get(leafId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }

  return path
}

/** 整棵树（可能有多个根），用于树视图。 */
export function buildForest<T extends TreeMessage>(
  messages: T[],
  currentLeafId: string | null = null,
): TreeNode<T>[] {
  const byId = new Map(messages.map((m) => [m.id, m]))
  const childrenOf = new Map<string | null, T[]>()

  for (const message of messages) {
    const key = message.parentId ?? null
    const list = childrenOf.get(key) ?? []
    list.push(message)
    childrenOf.set(key, list)
  }

  const onPath = new Set(buildPath(messages, currentLeafId).map((m) => m.id))

  function makeNode(message: T, depth: number, visited: Set<string>): TreeNode<T> {
    if (visited.has(message.id)) {
      return { message, depth, children: [], onCurrentPath: onPath.has(message.id) }
    }
    const nextVisited = new Set(visited).add(message.id)
    const children = (childrenOf.get(message.id) ?? []).map((child) =>
      makeNode(child, depth + 1, nextVisited),
    )
    return {
      message,
      depth,
      children,
      onCurrentPath: onPath.has(message.id),
    }
  }

  const roots = messages.filter((m) => !m.parentId || !byId.has(m.parentId))
  return roots.map((root) => makeNode(root, 0, new Set()))
}

/** 某个节点的直接子节点数（>1 表示这里是一个岔口）。 */
export function forkCounts<T extends TreeMessage>(messages: T[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    if (!message.parentId) continue
    counts.set(message.parentId, (counts.get(message.parentId) ?? 0) + 1)
  }
  return counts
}

/**
 * 某个节点的全部后代（不含自己）。
 * 回退后重新生成时，用它找出要被替换掉的旧后续。
 */
export function collectDescendants<T extends TreeMessage>(messages: T[], rootId: string): T[] {
  const childrenOf = new Map<string, T[]>()
  for (const message of messages) {
    if (!message.parentId) continue
    const list = childrenOf.get(message.parentId) ?? []
    list.push(message)
    childrenOf.set(message.parentId, list)
  }

  const out: T[] = []
  const seen = new Set<string>()
  const stack = [...(childrenOf.get(rootId) ?? [])]

  while (stack.length > 0) {
    const node = stack.pop()!
    if (seen.has(node.id)) continue
    seen.add(node.id)
    out.push(node)
    stack.push(...(childrenOf.get(node.id) ?? []))
  }

  return out
}
