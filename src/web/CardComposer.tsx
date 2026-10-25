import { useRef, useState } from 'react'
import { createMaterial, draftCard, importCard, listMaterials, updateMaterial } from './api.ts'
import type { CardBody, Fidelity } from '../shared/types.ts'
import { formatTags, parseTags } from '../shared/tags.ts'
import AvatarPicker from './AvatarPicker.tsx'

const emptyCard: CardBody = { name: '', description: '', firstMes: '' }

interface Props {
  onSaved: () => void
  onCancel: () => void
}

function FidelityNote({ fidelity }: { fidelity: Fidelity }) {
  const hasProblems = fidelity.degraded.length > 0 || fidelity.warnings.length > 0

  return (
    <details className={hasProblems ? 'fidelity has-warning' : 'fidelity'} open={hasProblems}>
      <summary>
        导入报告 · 规范 {fidelity.specVersion}
        {hasProblems ? ' · 有需要注意的地方' : ''}
      </summary>
      <ul>
        <li>读到 {fidelity.read.length} 个字段：{fidelity.read.join('、')}</li>
        {Object.entries(fidelity.mapped).map(([key, value]) => (
          <li key={key}>
            {key}：{value}
          </li>
        ))}
        {fidelity.ignored.length > 0 && <li>未使用：{fidelity.ignored.join('、')}</li>}
        {fidelity.degraded.map((item) => (
          <li key={item.field}>
            降级 {item.field}：{item.reason}
          </li>
        ))}
        {fidelity.warnings.map((warning) => (
          <li key={warning} className="warn-line">
            {warning}
          </li>
        ))}
      </ul>
    </details>
  )
}

export default function CardComposer({ onSaved, onCancel }: Props) {
  const [brief, setBrief] = useState('')
  const [draft, setDraft] = useState<CardBody>(emptyCard)
  const [tagsText, setTagsText] = useState('')
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | undefined>()
  const [fidelity, setFidelity] = useState<Fidelity | null>(null)
  const [sourceName, setSourceName] = useState('')

  const [drafting, setDrafting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setImporting(true)
    setError(null)
    try {
      const result = await importCard(file)
      setDraft(result.draft)
      setTagsText(formatTags(result.draft.tags))
      setFidelity(result.fidelity)
      // 卡自带头像才覆盖；没有头像时保留用户已经选好的那张
      if (result.avatarDataUrl) setAvatarDataUrl(result.avatarDataUrl)
      setSourceName(result.sourceName)
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  async function draftWithAi() {
    if (!brief.trim()) {
      setError('先写一句你想要的角色')
      return
    }
    setDrafting(true)
    setError(null)
    try {
      const result = await draftCard(brief.trim())
      // 起草与导入同构：填满同一套字段，不产出更薄的卡
      setDraft({
        name: result.name,
        description: result.description,
        firstMes: result.firstMes,
        personality: result.personality,
        scenario: result.scenario,
        mesExample: result.mesExample,
        tags: result.tags,
      })
      setTagsText(formatTags(result.tags))
      setFidelity(null)
      setSourceName('')
      // 刻意不动 avatarDataUrl：头像与正文是两件事，
      // 起草不该把用户已经选好的头像抹掉
    } catch (e) {
      setError(e instanceof Error ? e.message : '起草失败')
    } finally {
      setDrafting(false)
    }
  }

  async function save() {
    const name = draft.name.trim()
    if (!name) {
      setError('角色卡需要一个名字')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const body: CardBody = { ...draft, name, tags: parseTags(tagsText) }
      const origin = fidelity ? 'imported' : 'authored'
      const existing = (await listMaterials('card')).find((m) => m.name === name)

      let saved
      if (existing) {
        const overwrite = window.confirm(
          `已经有一张同名角色卡「${existing.name}」。\n\n确定 = 覆盖它\n取消 = 另存为「${name}（2）」`,
        )
        if (overwrite) {
          saved = await updateMaterial(existing.id, { name, body, origin, avatarDataUrl })
        } else {
          saved = await createMaterial({
            kind: 'card',
            name: `${name}（2）`,
            body: { ...body, name: `${name}（2）` },
            origin,
            avatarDataUrl,
          })
        }
      } else {
        saved = await createMaterial({ kind: 'card', name, body, origin, avatarDataUrl })
      }

      // 选了图但没落盘：明确说出来，不要假装保存成功
      if (avatarDataUrl && !saved.avatarUrl) {
        setError('角色卡已保存，但头像没能写进去。请再选一次头像，或换一张图片试试。')
        return
      }

      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="composer">
      <h2>新建角色卡</h2>

      <div
        className={dragging ? 'drop-zone dragging' : 'drop-zone'}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files[0]
          if (file) void handleFile(file)
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".png,.json,application/json,image/png"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleFile(file)
            e.target.value = ''
          }}
        />
        <button className="ghost" onClick={() => fileRef.current?.click()} disabled={importing}>
          {importing ? '读取中…' : '从酒馆导入'}
        </button>
        <span className="hint">或把导出的 .png 角色卡、.json 卡拖到这里</span>
      </div>

      {fidelity && <FidelityNote fidelity={fidelity} />}

      <div className="draft-bar">
        <label>
          一句话需求
          <textarea
            rows={2}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="例如：一个落魄的账房先生，说话慢，心里算得比谁都快"
            disabled={drafting}
          />
        </label>
        <button className="ghost" onClick={draftWithAi} disabled={drafting}>
          {drafting ? '起草中…' : '让 AI 起草'}
        </button>
        <p className="hint">起草会写满下面的字段，和导入的卡一样完整；你可以随意修改后再保存。</p>
      </div>

      {error && <p className="notice error">{error}</p>}

      <div className="composer-main">
        <AvatarPicker
          value={avatarDataUrl}
          onChange={(value) => {
            setAvatarDataUrl(value ?? undefined)
            if (value === null) {
              setFidelity(null)
              setSourceName('')
            }
          }}
        />

        <div className="composer-fields">
          <label>
            名字
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="例如：李四"
            />
          </label>

          <label>
            描述
            <textarea
              rows={6}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="这个人是谁、怎么说话、在意什么、有什么秘密"
            />
          </label>

          <label>
            登场引子
            <textarea
              rows={3}
              value={draft.firstMes}
              onChange={(e) => setDraft({ ...draft, firstMes: e.target.value })}
              placeholder="可选：这个角色第一次出场时的参考片段"
            />
          </label>

          <div className="two-col">
            <label>
              性格
              <textarea
                rows={3}
                value={draft.personality ?? ''}
                onChange={(e) => setDraft({ ...draft, personality: e.target.value })}
                placeholder="性格摘要"
              />
            </label>
            <label>
              场景
              <textarea
                rows={3}
                value={draft.scenario ?? ''}
                onChange={(e) => setDraft({ ...draft, scenario: e.target.value })}
                placeholder="他通常处在什么处境"
              />
            </label>
          </div>

          <label>
            示例对话
            <textarea
              rows={5}
              value={draft.mesExample ?? ''}
              onChange={(e) => setDraft({ ...draft, mesExample: e.target.value })}
              placeholder="可选：2–3 轮示例对白"
            />
          </label>

          <label>
            标签（用顿号或逗号分隔）
            <input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="例如：民国、书店、悬疑"
            />
          </label>
        </div>
      </div>

      {sourceName && <p className="hint">来源：{sourceName}</p>}

      <div className="actions">
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button className="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  )
}
