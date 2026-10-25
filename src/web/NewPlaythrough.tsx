import { useEffect, useState } from 'react'
import { createPlaythrough, listMaterials } from './api.ts'
import type { MaterialMeta } from '../shared/types.ts'

interface Props {
  onClose: () => void
  onCreated: (id: string) => void
}

export default function NewPlaythrough({ onClose, onCreated }: Props) {
  const [cards, setCards] = useState<MaterialMeta[]>([])
  const [lorebooks, setLorebooks] = useState<MaterialMeta[]>([])
  const [presets, setPresets] = useState<MaterialMeta[]>([])

  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [lorebookId, setLorebookId] = useState('')
  const [presetId, setPresetId] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([listMaterials('card'), listMaterials('lorebook'), listMaterials('preset')])
      .then(([c, l, p]) => {
        setCards(c)
        setLorebooks(l)
        setPresets(p)
        setLorebookId(l.find((x) => x.name.includes('合并版'))?.id ?? l[0]?.id ?? '')
        setPresetId(p[0]?.id ?? '')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载素材失败'))
  }, [])

  function toggle(id: string) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function create() {
    if (picked.length === 0) {
      setError('至少选一张角色卡当演员。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await createPlaythrough({
        title: title.trim() || undefined,
        cardIds: picked,
        lorebookId: lorebookId || undefined,
        presetId: presetId || undefined,
      })
      onCreated(result.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backdrop">
      <div className="modal">
        <div className="modal-head">
          <h2>新的一局</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        {error && <p className="notice error">{error}</p>}

        <label>
          标题（可留空）
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：襄阳城的第一夜"
          />
        </label>

        <div className="field">
          <div className="field-head">
            <span>演员表（已选 {picked.length} 张）</span>
          </div>
          <div className="model-list">
            {cards.length === 0 && <p className="muted small">还没有角色卡。</p>}
            {cards.map((card) => (
              <label key={card.id} className="model-item">
                <input
                  type="checkbox"
                  checked={picked.includes(card.id)}
                  onChange={() => toggle(card.id)}
                />
                <span>{card.name}</span>
              </label>
            ))}
          </div>
        </div>

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

        <p className="hint">
          开局时会把所选素材冻结进这一局：之后你再改角色卡或世界书，这一局用的仍是当时那份。
        </p>

        <div className="actions">
          <button className="primary" onClick={create} disabled={busy}>
            {busy ? '创建中…' : '开局'}
          </button>
          <button className="ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
