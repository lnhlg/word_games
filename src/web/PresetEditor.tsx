import { useEffect, useState } from 'react'
import { getMaterial, updateMaterial } from './api.ts'
import { normalizePreset } from '../tavern/preset.ts'
import type { Preset, PresetParams, PresetPrompt } from '../shared/types.ts'

interface Props {
  presetId: string
  onClose: () => void
  onSaved: () => void
}

const PARAM_FIELDS: Array<{
  key: keyof PresetParams
  label: string
  step: number
  min: number
  max: number
}> = [
  { key: 'temperature', label: '温度', step: 0.1, min: 0, max: 2 },
  { key: 'topP', label: 'top-p', step: 0.05, min: 0, max: 1 },
  { key: 'topK', label: 'top-k', step: 1, min: 0, max: 200 },
  { key: 'repetitionPenalty', label: '重复惩罚', step: 0.05, min: 0, max: 2 },
  { key: 'frequencyPenalty', label: '频率惩罚', step: 0.1, min: -2, max: 2 },
  { key: 'presencePenalty', label: '存在惩罚', step: 0.1, min: -2, max: 2 },
  { key: 'maxContext', label: '上下文窗口', step: 256, min: 512, max: 200000 },
  { key: 'maxTokens', label: '最大回复', step: 50, min: 16, max: 16000 },
]

export default function PresetEditor({ presetId, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [params, setParams] = useState<PresetParams | null>(null)
  const [prompts, setPrompts] = useState<PresetPrompt[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    getMaterial(presetId)
      .then((material) => {
        const preset = normalizePreset(material.body)
        setName(preset.name)
        setParams(preset.params)
        setPrompts(preset.prompts)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [presetId])

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= prompts.length) return
    const next = [...prompts]
    ;[next[index], next[target]] = [next[target], next[index]]
    setPrompts(next)
  }

  function patch(index: number, changes: Partial<PresetPrompt>) {
    setPrompts((prev) => prev.map((item, i) => (i === index ? { ...item, ...changes } : item)))
  }

  function patchParam(key: keyof PresetParams, value: number) {
    setParams((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function save() {
    if (!params) return
    setSaving(true)
    setError(null)
    try {
      const finalName = name.trim() || '未命名预设'
      const body: Preset = { name: finalName, params, prompts }
      await updateMaterial(presetId, { name: finalName, body })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>预设</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        {error && <p className="notice error">{error}</p>}

        {loading || !params ? (
          <p className="muted">载入中…</p>
        ) : (
          <>
            <label>
              名称
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <div className="param-grid">
              {PARAM_FIELDS.map((field) => (
                <label key={field.key}>
                  {field.label}
                  <input
                    type="number"
                    step={field.step}
                    min={field.min}
                    max={field.max}
                    value={params[field.key]}
                    onChange={(e) => patchParam(field.key, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>

            <div className="lore-entries-head">
              <span>排布（靠上 = 先发送）</span>
              <span className="muted small">占位槽位没有静态文本，装配时填入实际内容</span>
            </div>

            <div className="slot-list">
              {prompts.map((prompt, index) => (
                <div
                  key={prompt.identifier}
                  className={prompt.enabled ? 'slot' : 'slot disabled'}
                >
                  <div className="slot-head">
                    <span className="slot-order">{index + 1}</span>
                    <span className="slot-name">{prompt.name}</span>
                    {prompt.marker && <span className="badge">占位</span>}
                    {!prompt.enabled && <span className="badge">已禁用</span>}
                    <span className="slot-spacer" />
                    <button
                      className="ghost small-btn"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                    >
                      上移
                    </button>
                    <button
                      className="ghost small-btn"
                      onClick={() => move(index, 1)}
                      disabled={index === prompts.length - 1}
                    >
                      下移
                    </button>
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={prompt.enabled}
                        onChange={(e) => patch(index, { enabled: e.target.checked })}
                      />
                      启用
                    </label>
                  </div>

                  <p className="slot-id">{prompt.identifier}</p>

                  {!prompt.marker && (
                    <textarea
                      rows={3}
                      value={prompt.content}
                      onChange={(e) => patch(index, { content: e.target.value })}
                      placeholder="这个片段的文本"
                    />
                  )}
                </div>
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
