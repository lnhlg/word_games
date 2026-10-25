import { useEffect, useState } from 'react'
import { getMaterial, updateMaterial } from './api.ts'
import { activateEntries, parseLorebook } from '../tavern/lorebook.ts'
import type { LoreEntry } from '../shared/types.ts'

interface Props {
  lorebookId: string
  onClose: () => void
  onSaved: () => void
}

const LOGIC_OPTIONS = [
  { value: 0, label: '任一命中' },
  { value: 1, label: '非全部命中' },
  { value: 2, label: '全部不命中' },
  { value: 3, label: '全部命中' },
]

const POSITION_OPTIONS = [
  { value: 'before', label: '角色定义前' },
  { value: 'after', label: '角色定义后' },
  { value: 'depth', label: '按深度注入' },
]

function splitKeys(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function emptyEntry(): LoreEntry {
  return {
    id: crypto.randomUUID(),
    keys: [],
    secondaryKeys: [],
    content: '',
    comment: '',
    constant: false,
    selective: false,
    selectiveLogic: 0,
    position: 'before',
    depth: 4,
    order: 100,
    enabled: true,
  }
}

export default function LorebookEditor({ lorebookId, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [entries, setEntries] = useState<LoreEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [testText, setTestText] = useState('')
  const [tested, setTested] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setTested(false)
    setTestText('')
    getMaterial(lorebookId)
      .then((material) => {
        const book = parseLorebook(material.body)
        setName(book.name)
        setEntries(book.entries)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [lorebookId])

  function update(id: string, patch: Partial<LoreEntry>) {
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  }

  function addEntry() {
    setEntries((prev) => [...prev, { ...emptyEntry(), order: (prev.length + 1) * 10 }])
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((entry) => entry.id !== id))
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const finalName = name.trim() || '未命名世界书'
      await updateMaterial(lorebookId, { name: finalName, body: { name: finalName, entries } })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const results = tested ? activateEntries(entries, testText) : null
  const hitCount = results?.filter((r) => r.matched).length ?? 0

  return (
    <div className="backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>世界书</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        {error && <p className="notice error">{error}</p>}

        {loading ? (
          <p className="muted">载入中…</p>
        ) : (
          <>
            <label>
              名称
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <div className="lore-test">
              <label>
                激活测试
                <textarea
                  rows={3}
                  value={testText}
                  onChange={(e) => {
                    setTestText(e.target.value)
                    setTested(false)
                  }}
                  placeholder="贴一段可能的对话或场景，看哪些条目会命中"
                />
              </label>
              <button className="ghost" onClick={() => setTested(true)}>
                测试
              </button>

              {results && (
                <div className="lore-results">
                  <p className="lore-summary">
                    {hitCount} / {results.length} 条命中
                  </p>
                  <ul>
                    {results.map((r) => (
                      <li key={r.entry.id} className={r.matched ? 'hit' : 'miss'}>
                        <span className="lore-mark">{r.matched ? '命中' : '未中'}</span>
                        <strong>{r.entry.comment || r.entry.keys[0] || '未命名条目'}</strong>
                        <span className="lore-reason">{r.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="lore-entries-head">
              <span>条目（{entries.length}）</span>
              <button className="link" onClick={addEntry}>
                + 添加条目
              </button>
            </div>

            <div className="lore-entries">
              {entries.length === 0 && (
                <p className="muted small">还没有条目。点「添加条目」，或者从 JSON 导入。</p>
              )}

              {entries.map((entry, index) => (
                <details key={entry.id} className="lore-entry">
                  <summary>
                    <span className="lore-entry-title">
                      {entry.comment || entry.keys[0] || `条目 ${index + 1}`}
                    </span>
                    {entry.constant && <span className="badge">常驻</span>}
                    {!entry.enabled && <span className="badge">已禁用</span>}
                  </summary>

                  <label>
                    标题
                    <input
                      value={entry.comment}
                      onChange={(e) => update(entry.id, { comment: e.target.value })}
                      placeholder="给自己的备忘，不参与触发"
                    />
                  </label>

                  <label>
                    主关键词（顿号或逗号分隔）
                    <input
                      value={entry.keys.join('、')}
                      onChange={(e) => update(entry.id, { keys: splitKeys(e.target.value) })}
                      placeholder="码头、卸货"
                    />
                  </label>

                  <div className="two-col">
                    <label>
                      次级关键词
                      <input
                        value={entry.secondaryKeys.join('、')}
                        onChange={(e) =>
                          update(entry.id, { secondaryKeys: splitKeys(e.target.value) })
                        }
                        disabled={!entry.selective}
                      />
                    </label>
                    <label>
                      次级逻辑
                      <select
                        value={entry.selectiveLogic}
                        onChange={(e) =>
                          update(entry.id, { selectiveLogic: Number(e.target.value) })
                        }
                        disabled={!entry.selective}
                      >
                        {LOGIC_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label>
                    内容
                    <textarea
                      rows={4}
                      value={entry.content}
                      onChange={(e) => update(entry.id, { content: e.target.value })}
                    />
                  </label>

                  <div className="two-col">
                    <label>
                      注入位置
                      <select
                        value={entry.position}
                        onChange={(e) =>
                          update(entry.id, { position: e.target.value as LoreEntry['position'] })
                        }
                      >
                        {POSITION_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      顺序（越大越靠后）
                      <input
                        type="number"
                        value={entry.order}
                        onChange={(e) => update(entry.id, { order: Number(e.target.value) })}
                      />
                    </label>
                  </div>

                  {entry.position === 'depth' && (
                    <label>
                      深度（倒数第几层）
                      <input
                        type="number"
                        value={entry.depth}
                        onChange={(e) => update(entry.id, { depth: Number(e.target.value) })}
                      />
                    </label>
                  )}

                  <div className="lore-flags">
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={entry.constant}
                        onChange={(e) => update(entry.id, { constant: e.target.checked })}
                      />
                      常驻（不看关键词）
                    </label>
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={entry.selective}
                        onChange={(e) => update(entry.id, { selective: e.target.checked })}
                      />
                      启用次级过滤
                    </label>
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(e) => update(entry.id, { enabled: e.target.checked })}
                      />
                      启用该条
                    </label>
                  </div>

                  <button className="link danger" onClick={() => removeEntry(entry.id)}>
                    删除条目
                  </button>
                </details>
              ))}
            </div>

            <div className="actions">
              <button className="primary" onClick={save} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button className="ghost" onClick={onClose}>
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
