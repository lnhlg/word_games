import { useEffect, useState } from 'react'
import { fetchModels, getSettings, saveSettingsApi, testSettings } from './api.ts'
import type { ProviderInput } from './api.ts'

interface Props {
  open: boolean
  onClose: () => void
}

type Notice = { kind: 'ok' | 'error'; text: string } | null

interface DraftProvider extends ProviderInput {
  hasApiKey: boolean
}

const PRESETS: Array<{ name: string; apiBase: string }> = [
  { name: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1' },
  { name: 'OpenAI', apiBase: 'https://api.openai.com/v1' },
  { name: '本地 Ollama', apiBase: 'http://127.0.0.1:11434/v1' },
]

export default function SettingsPanel({ open, onClose }: Props) {
  const [providers, setProviders] = useState<DraftProvider[]>([])
  const [activeId, setActiveId] = useState('')
  const [editingId, setEditingId] = useState('')

  const [keyDraft, setKeyDraft] = useState('')
  const [available, setAvailable] = useState<string[]>([])
  const [query, setQuery] = useState('')

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  useEffect(() => {
    if (!open) return
    setNotice(null)
    setKeyDraft('')
    setQuery('')
    getSettings()
      .then((s) => {
        const list: DraftProvider[] = s.providers.map((p) => ({
          id: p.id,
          name: p.name,
          apiBase: p.apiBase,
          apiKey: '',
          model: p.model,
          models: p.models,
          hasApiKey: p.hasApiKey,
        }))
        setProviders(list)
        setActiveId(s.activeId)
        const first = s.activeId || list[0]?.id || ''
        setEditingId(first)
        setAvailable(list.find((p) => p.id === first)?.models ?? [])
      })
      .catch((e: unknown) => {
        setNotice({ kind: 'error', text: e instanceof Error ? e.message : '读取设置失败' })
      })
  }, [open])

  if (!open) return null

  const editing = providers.find((p) => p.id === editingId) ?? null

  function patchEditing(patch: Partial<DraftProvider>) {
    if (!editing) return
    setProviders((prev) => prev.map((p) => (p.id === editing.id ? { ...p, ...patch } : p)))
  }

  function selectProvider(id: string) {
    setEditingId(id)
    setKeyDraft('')
    setQuery('')
    setNotice(null)
    setAvailable(providers.find((p) => p.id === id)?.models ?? [])
  }

  function addProvider(preset?: { name: string; apiBase: string }) {
    const draft: DraftProvider = {
      id: crypto.randomUUID(),
      name: preset?.name ?? `供应商 ${providers.length + 1}`,
      apiBase: preset?.apiBase ?? 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      models: [],
      hasApiKey: false,
    }
    setProviders((prev) => [...prev, draft])
    setEditingId(draft.id)
    setActiveId(draft.id)
    setAvailable([])
    setKeyDraft('')
    setNotice(null)
  }

  function removeProvider(id: string) {
    if (!window.confirm('删掉这个供应商？已经保存的密钥也会一起消失。')) return
    const next = providers.filter((p) => p.id !== id)
    setProviders(next)
    if (editingId === id) setEditingId(next[0]?.id ?? '')
    if (activeId === id) setActiveId(next[0]?.id ?? '')
  }

  /** 把本地草稿变成可提交的结构。 */
  function toPayload() {
    return {
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        apiBase: p.apiBase,
        apiKey: p.id === editingId ? keyDraft : '',
        model: p.model,
        models: p.models,
      })),
      activeId,
    }
  }

  async function persist() {
    const next = await saveSettingsApi(toPayload())
    setProviders(
      next.providers.map((p) => ({
        id: p.id,
        name: p.name,
        apiBase: p.apiBase,
        apiKey: '',
        model: p.model,
        models: p.models,
        hasApiKey: p.hasApiKey,
      })),
    )
    setActiveId(next.activeId)
    setKeyDraft('')
    return next
  }

  async function save() {
    setBusy(true)
    setNotice(null)
    try {
      await persist()
      onClose()
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setBusy(false)
    }
  }

  async function refreshList() {
    if (!editing) return
    setBusy(true)
    setNotice(null)
    try {
      await persist()
      const { models } = await fetchModels(editing.id)
      setAvailable(Array.from(new Set([...models, ...editing.models])))
      setNotice(
        models.length > 0
          ? { kind: 'ok', text: `取回 ${models.length} 个模型` }
          : { kind: 'error', text: '服务返回了空列表，可以手动输入模型名。' },
      )
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : '获取模型列表失败' })
    } finally {
      setBusy(false)
    }
  }

  async function testConnection() {
    if (!editing) return
    setBusy(true)
    setNotice(null)
    try {
      await persist()
      const result = await testSettings(editing.id)
      setNotice(
        result.ok
          ? { kind: 'ok', text: `连接成功，模型回复：${result.reply ?? '（空）'}` }
          : { kind: 'error', text: result.error ?? '连接失败' },
      )
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : '测试失败' })
    } finally {
      setBusy(false)
    }
  }

  function toggleModel(model: string) {
    if (!editing) return
    const next = editing.models.includes(model)
      ? editing.models.filter((m) => m !== model)
      : [...editing.models, model]
    patchEditing({
      models: next,
      model: next.includes(editing.model) ? editing.model : (next[0] ?? ''),
    })
  }

  function addManual() {
    const value = query.trim()
    if (!value || !editing) return
    if (!available.includes(value)) setAvailable([value, ...available])
    if (!editing.models.includes(value)) {
      patchEditing({ models: [...editing.models, value], model: editing.model || value })
    }
    setQuery('')
  }

  const keyword = query.trim().toLowerCase()
  const filtered = keyword ? available.filter((m) => m.toLowerCase().includes(keyword)) : available

  return (
    <div className="backdrop">
      <div className="modal">
        <div className="modal-head">
          <h2>模型设置</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        <p className="hint">
          兼容 OpenAI 的 <code>/v1/chat/completions</code>。密钥只存在本机，不会回传给浏览器。
        </p>

        <div className="field">
          <div className="field-head">
            <span>供应商{providers.length > 0 ? `（${providers.length} 个）` : ''}</span>
            <button className="link" onClick={() => addProvider()} disabled={busy}>
              新增
            </button>
          </div>

          {providers.length === 0 ? (
            <p className="muted small">还没有供应商。下面挑一个预设，或者点「新增」。</p>
          ) : (
            <div className="provider-tabs">
              {providers.map((p) => (
                <button
                  key={p.id}
                  className={
                    p.id === editingId
                      ? 'provider-tab active'
                      : p.id === activeId
                        ? 'provider-tab current'
                        : 'provider-tab'
                  }
                  onClick={() => selectProvider(p.id)}
                >
                  {p.name}
                  {p.id === activeId && <span className="provider-dot" title="当前使用" />}
                </button>
              ))}
            </div>
          )}

          {providers.length === 0 && (
            <div className="provider-presets">
              {PRESETS.map((preset) => (
                <button key={preset.name} onClick={() => addProvider(preset)}>
                  {preset.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {editing && (
          <>
            <label>
              名称
              <input
                value={editing.name}
                onChange={(e) => patchEditing({ name: e.target.value })}
                placeholder="例如 DeepSeek"
              />
            </label>

            <label>
              API 地址
              <input
                value={editing.apiBase}
                onChange={(e) => patchEditing({ apiBase: e.target.value })}
                placeholder="https://api.deepseek.com/v1"
              />
            </label>

            <label>
              API 密钥
              <input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder={editing.hasApiKey ? '已配置（留空则不修改）' : '未配置'}
              />
            </label>

            <div className="field">
              <div className="field-head">
                <span>模型</span>
                <button className="link" onClick={refreshList} disabled={busy}>
                  刷新列表
                </button>
              </div>

              <input
                className="model-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addManual()
                  }
                }}
                placeholder="搜索；输入模型名后回车加入"
              />

              <div className="model-list">
                {filtered.length === 0 ? (
                  <p className="muted small">
                    还没有模型。先保存密钥再点「刷新列表」，或者直接输入模型名后回车。
                  </p>
                ) : (
                  filtered.map((m) => (
                    <label key={m} className="model-item">
                      <input
                        type="checkbox"
                        checked={editing.models.includes(m)}
                        onChange={() => toggleModel(m)}
                      />
                      <span>{m}</span>
                    </label>
                  ))
                )}
              </div>

              {editing.models.length > 0 && (
                <label className="active-model">
                  这个供应商用的模型（已选 {editing.models.length} 个）
                  <select
                    value={editing.model}
                    onChange={(e) => patchEditing({ model: e.target.value })}
                  >
                    {editing.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {providers.length > 1 && (
              <div className="field">
                <label className="active-model">
                  当前使用哪个供应商
                  <select value={activeId} onChange={(e) => setActiveId(e.target.value)}>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </>
        )}

        {notice && (
          <p className={notice.kind === 'ok' ? 'notice ok' : 'notice error'}>{notice.text}</p>
        )}

        <div className="actions">
          <button className="primary" onClick={save} disabled={busy || providers.length === 0}>
            {busy ? '处理中…' : '保存'}
          </button>
          <button className="ghost" onClick={testConnection} disabled={busy || !editing}>
            测试连接
          </button>
          {editing && providers.length > 1 && (
            <button className="ghost danger" onClick={() => removeProvider(editing.id)} disabled={busy}>
              删除这个供应商
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
