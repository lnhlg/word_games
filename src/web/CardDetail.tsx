import { useEffect, useState } from 'react'
import { createMaterial, getMaterial, reviseCard, updateMaterial } from './api.ts'
import type { CardBody } from '../shared/types.ts'
import { formatTags, parseTags } from '../shared/tags.ts'
import { parseLorebook } from '../tavern/lorebook.ts'
import AvatarPicker from './AvatarPicker.tsx'

interface Props {
  cardId: string
  onClose: () => void
  onSaved: () => void
}

const EMPTY: CardBody = { name: '', description: '', firstMes: '' }

export default function CardDetail({ cardId, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<CardBody | null>(null)
  const [tagsText, setTagsText] = useState('')
  const [greetingsText, setGreetingsText] = useState('')
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [avatarPreview, setAvatarPreview] = useState<string | undefined>()
  // undefined = 没动过；null = 要移除；string = 新选的图
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null | undefined>()

  const [instruction, setInstruction] = useState('')
  const [revising, setRevising] = useState(false)
  const [extracting, setExtracting] = useState(false)

  useEffect(() => {
    setDraft(null)
    setError(null)
    setJsonMode(false)
    setAvatarDataUrl(undefined)
    getMaterial(cardId)
      .then((material) => {
        const body = (material.body ?? EMPTY) as CardBody
        setDraft({ ...EMPTY, ...body })
        setAvatarPreview(material.avatarUrl)
        setTagsText(formatTags(body.tags))
        setGreetingsText((body.alternateGreetings ?? []).join('\n'))
        setJsonText(JSON.stringify(body, null, 2))
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : '加载失败')
      })
  }, [cardId])

  function toForm() {
    if (!draft) return
    setJsonText(JSON.stringify(draft, null, 2))
    setJsonMode(false)
  }

  function toJson() {
    setJsonMode(true)
    setNotice(null)
  }

  async function revise() {
    if (!draft) return
    const text = instruction.trim()
    if (!text) {
      setError('先写一句要改什么')
      return
    }

    setRevising(true)
    setError(null)
    setNotice(null)
    try {
      const next = await reviseCard(draft, text)
      setDraft(next)
      setTagsText(formatTags(next.tags))
      setGreetingsText((next.alternateGreetings ?? []).join('\n'))
      setJsonText(JSON.stringify(next, null, 2))
      if (jsonMode) setJsonMode(false)
      setInstruction('')
      setNotice('已按你的要求改好，检查一下再保存。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败')
    } finally {
      setRevising(false)
    }
  }

  async function extractLorebook() {
    if (!draft?.characterBook) return
    setExtracting(true)
    setError(null)
    setNotice(null)
    try {
      const book = parseLorebook(draft.characterBook, `${draft.name} · 世界书`)
      const meta = await createMaterial({
        kind: 'lorebook',
        name: book.name,
        body: book,
        origin: 'imported',
      })
      setNotice(
        `已拆成独立世界书「${meta.name}」，共 ${book.entries.length} 条。去「世界书」页签里看。`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '拆解失败')
    } finally {
      setExtracting(false)
    }
  }

  async function save() {
    if (!draft) return
    setError(null)
    setNotice(null)

    let body: CardBody
    let name: string

    if (jsonMode) {
      try {
        body = JSON.parse(jsonText) as CardBody
      } catch {
        setError('JSON 格式有误，先修好再保存。')
        return
      }
      name = typeof body.name === 'string' ? body.name.trim() : ''
    } else {
      name = draft.name.trim()
      body = {
        ...draft,
        tags: parseTags(tagsText),
        alternateGreetings: greetingsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      }
    }

    if (!name) {
      setError('名字不能为空')
      return
    }

    setSaving(true)
    try {
      const saved = await updateMaterial(cardId, { name, body, avatarDataUrl })

      // 选了新图但没落盘：明确说出来
      if (typeof avatarDataUrl === 'string' && avatarDataUrl && !saved.avatarUrl) {
        setError('已保存，但头像没能写进去。请再选一次头像，或换一张图片试试。')
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
    <div className="backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>{draft ? draft.name || '未命名' : '载入中…'}</h2>
          <div className="modal-head-actions">
            <button className="link" onClick={jsonMode ? toForm : toJson}>
              {jsonMode ? '回到表单' : 'JSON 视图'}
            </button>
            <button className="link" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        {error && <p className="notice error">{error}</p>}
        {notice && <p className="notice ok">{notice}</p>}

        {!draft ? (
          <p className="muted">载入中…</p>
        ) : jsonMode ? (
          <label>
            完整内容（JSON）
            <textarea
              className="json-editor"
              rows={22}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
            />
          </label>
        ) : (
          <>
            <AvatarPicker
              value={avatarPreview}
              onChange={(value) => {
                setAvatarDataUrl(value)
                setAvatarPreview(value ?? undefined)
              }}
            />

            <div className="ai-revise">
              <label>
                用 AI 修改
                <textarea
                  rows={2}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="例如：把她的年龄改成三十岁；再加一条她怕水的设定"
                  disabled={revising}
                />
              </label>
              <button className="ghost" onClick={revise} disabled={revising}>
                {revising ? '修改中…' : '让 AI 改'}
              </button>
              <p className="hint">
                只改文字字段；内嵌世界书与备选开场白会原样保留。改完记得保存。
              </p>
            </div>

            <label>
              名字
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>

            <label>
              描述
              <textarea
                rows={8}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>

            <label>
              登场引子
              <textarea
                rows={4}
                value={draft.firstMes}
                onChange={(e) => setDraft({ ...draft, firstMes: e.target.value })}
              />
            </label>

            <div className="two-col">
              <label>
                性格
                <textarea
                  rows={3}
                  value={draft.personality ?? ''}
                  onChange={(e) => setDraft({ ...draft, personality: e.target.value })}
                />
              </label>
              <label>
                场景
                <textarea
                  rows={3}
                  value={draft.scenario ?? ''}
                  onChange={(e) => setDraft({ ...draft, scenario: e.target.value })}
                />
              </label>
            </div>

            <label>
              示例对话
              <textarea
                rows={6}
                value={draft.mesExample ?? ''}
                onChange={(e) => setDraft({ ...draft, mesExample: e.target.value })}
              />
            </label>

            <label>
              标签（用顿号或逗号分隔）
              <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
            </label>

            <label>
              备选开场白（每行一条）
              <textarea
                rows={4}
                value={greetingsText}
                onChange={(e) => setGreetingsText(e.target.value)}
              />
            </label>

            {draft.characterBook !== undefined && (
              <div className="card-book">
                <p className="hint">这张卡带内嵌世界书。</p>
                <button className="ghost" onClick={extractLorebook} disabled={extracting}>
                  {extracting ? '拆解中…' : '拆成独立世界书'}
                </button>
              </div>
            )}
          </>
        )}

        <div className="actions">
          <button className="primary" onClick={save} disabled={saving || !draft}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
