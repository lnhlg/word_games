import { useEffect, useState } from 'react'
import { getMaterial, listMaterials } from './api.ts'
import { assemble, type AssemblyResult } from '../engine/assembly.ts'
import { defaultPreset, normalizePreset } from '../tavern/preset.ts'
import type { CardBody, Lorebook, MaterialMeta, Preset } from '../shared/types.ts'

interface Props {
  onClose: () => void
}

export default function AssemblyPreview({ onClose }: Props) {
  const [cards, setCards] = useState<MaterialMeta[]>([])
  const [lorebooks, setLorebooks] = useState<MaterialMeta[]>([])
  const [presets, setPresets] = useState<MaterialMeta[]>([])

  const [picked, setPicked] = useState<string[]>([])
  const [present, setPresent] = useState<string[]>([])
  const [lorebookId, setLorebookId] = useState('')
  const [presetId, setPresetId] = useState('')
  const [scanText, setScanText] = useState('')

  const [result, setResult] = useState<AssemblyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([listMaterials('card'), listMaterials('lorebook'), listMaterials('preset')])
      .then(([c, l, p]) => {
        setCards(c)
        setLorebooks(l)
        setPresets(p)
        setLorebookId(l[0]?.id ?? '')
        setPresetId(p[0]?.id ?? '')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载素材失败'))
  }, [])

  function toggleCard(card: MaterialMeta) {
    setPicked((prev) => {
      const next = prev.includes(card.id) ? prev.filter((id) => id !== card.id) : [...prev, card.id]
      setPresent((p) => {
        if (next.includes(card.id)) return p.includes(card.name) ? p : [...p, card.name]
        return p.filter((name) => name !== card.name)
      })
      return next
    })
  }

  function togglePresent(name: string) {
    setPresent((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  async function run() {
    if (picked.length === 0) {
      setError('先在演员表里至少选一张卡。')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const actors = await Promise.all(
        picked.map(async (id) => {
          const material = await getMaterial(id)
          return { name: material.name, body: material.body as CardBody }
        }),
      )

      const lorebook = lorebookId
        ? ((await getMaterial(lorebookId)).body as Lorebook)
        : undefined

      const preset = presetId
        ? normalizePreset((await getMaterial(presetId)).body)
        : (defaultPreset() as Preset)

      setResult(assemble({ actors, presentNames: present, lorebook, preset, scanText, history: [] }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '装配失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>装配预览</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        {error && <p className="notice error">{error}</p>}

        <p className="hint">
          预览不会调用模型、不花钱。它只回答一件事：按现在的素材与排布，模型会收到什么。
        </p>

        <div className="preview-pick">
          <div className="preview-block">
            <div className="field-head">
              <span>演员表（{picked.length} 张）</span>
            </div>
            <div className="model-list">
              {cards.length === 0 && <p className="muted small">还没有角色卡。</p>}
              {cards.map((card) => {
                const on = picked.includes(card.id)
                return (
                  <label key={card.id} className="model-item">
                    <input type="checkbox" checked={on} onChange={() => toggleCard(card)} />
                    <span>{card.name}</span>
                    {on && (
                      <button
                        className="link small"
                        onClick={(e) => {
                          e.preventDefault()
                          togglePresent(card.name)
                        }}
                      >
                        {present.includes(card.name) ? '在场' : '不在场'}
                      </button>
                    )}
                  </label>
                )
              })}
            </div>
          </div>

          <div className="preview-block">
            <label>
              世界书
              <select value={lorebookId} onChange={(e) => setLorebookId(e.target.value)}>
                <option value="">（不用世界书）</option>
                {lorebooks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              预设
              <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                <option value="">（用内置默认）</option>
                {presets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              世界书激活测试文本
              <textarea
                rows={3}
                value={scanText}
                onChange={(e) => setScanText(e.target.value)}
                placeholder="贴一段剧情，看哪些世界书条目会被注入"
              />
            </label>
          </div>
        </div>

        <div className="actions">
          <button className="primary" onClick={run} disabled={busy}>
            {busy ? '装配中…' : '装配'}
          </button>
        </div>

        {result && (
          <div className="preview-result">
            <div className="preview-stats">
              <span>{result.charCount} 字</span>
              <span>≈ {result.estimatedTokens} tokens</span>
              <span>
                预算 {result.budgetChars} 字，余 {result.budgetChars - result.charCount}
              </span>
              <span>{result.sections.length} 段</span>
            </div>

            {result.warnings.length > 0 && (
              <ul className="preview-warnings">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            {result.sections.map((section, index) => (
              <details key={section.identifier} className="preview-section" open={index < 3}>
                <summary>
                  <span className="preview-index">{index + 1}</span>
                  <span className="preview-label">{section.label}</span>
                  <span className="preview-source">{section.source}</span>
                  <span className="preview-size">{section.content.length} 字</span>
                </summary>
                <pre className="preview-content">{section.content}</pre>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
