import { useEffect, useRef, useState } from 'react'
import {
  createMaterial,
  deleteMaterial,
  deletePlaythrough,
  extractLorebooks,
  importLorebook,
  importPlaythrough,
  importPreset,
  listMaterials,
  listPlaythroughs,
} from './api.ts'
import CardComposer from './CardComposer.tsx'
import CardDetail from './CardDetail.tsx'
import AssemblyPreview from './AssemblyPreview.tsx'
import LorebookEditor from './LorebookEditor.tsx'
import PresetEditor from './PresetEditor.tsx'
import SettingsPanel from './SettingsPanel.tsx'
import PlayView from './PlayView.tsx'
import NewPlaythrough from './NewPlaythrough.tsx'
import { defaultPreset } from '../tavern/preset.ts'
import type { MaterialKind, MaterialMeta, PlaythroughSummary } from '../shared/types.ts'

type TabKind = MaterialKind | 'play'

const TABS: Array<{ kind: TabKind; label: string }> = [
  { kind: 'card', label: '角色卡' },
  { kind: 'lorebook', label: '世界书' },
  { kind: 'preset', label: '预设' },
  { kind: 'play', label: '对局' },
]

export default function App() {
  const [tab, setTab] = useState<TabKind>('card')
  const [items, setItems] = useState<MaterialMeta[]>([])
  const [plays, setPlays] = useState<PlaythroughSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [composing, setComposing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [newPlayOpen, setNewPlayOpen] = useState(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ id: string; kind: MaterialKind } | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)

  async function refresh(target: MaterialKind) {
    try {
      setError(null)
      setItems(await listMaterials(target))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  async function loadPlays() {
    try {
      setError(null)
      setPlays(await listPlaythroughs())
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载对局失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    setComposing(false)
    if (tab === 'play') void loadPlays()
    else void refresh(tab)
  }, [tab])

  async function remove(id: string, name: string) {
    if (!window.confirm(`删除「${name}」？此操作不可撤销。`)) return
    try {
      await deleteMaterial(id)
    } catch (e) {
      const message = e instanceof Error ? e.message : '删除失败'
      // 被对局引用时返回 409，问清楚再强制删
      if (!message.includes('局用到')) {
        setError(message)
        return
      }
      if (!window.confirm(`${message}\n\n仍然删除？`)) return
      try {
        await deleteMaterial(id, true)
      } catch (again) {
        setError(again instanceof Error ? again.message : '删除失败')
        return
      }
    }

    if (tab !== 'play') await refresh(tab)
  }

  async function removePlay(id: string, title: string, messageCount: number) {
    const hint =
      messageCount > 0
        ? `\n\n这一局有 ${messageCount} 条消息，删掉后消息树和状态一起消失，不能恢复。`
        : ''
    if (!window.confirm(`删除对局「${title}」？${hint}`)) return

    try {
      await deletePlaythrough(id)
      await loadPlays()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  async function newLorebook() {
    try {
      const meta = await createMaterial({
        kind: 'lorebook',
        name: '未命名世界书',
        body: { name: '未命名世界书', entries: [] },
      })
      await refresh('lorebook')
      setSelected({ id: meta.id, kind: 'lorebook' })
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建失败')
    }
  }

  async function newPreset() {
    try {
      const preset = defaultPreset()
      const meta = await createMaterial({ kind: 'preset', name: preset.name, body: preset })
      await refresh('preset')
      setSelected({ id: meta.id, kind: 'preset' })
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建失败')
    }
  }

  async function handleLorebookFile(file: File) {
    try {
      const result = await importLorebook(file)
      const meta = await createMaterial({
        kind: 'lorebook',
        name: result.name,
        body: result.body,
        origin: 'imported',
      })
      await refresh('lorebook')
      setSelected({ id: meta.id, kind: 'lorebook' })
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    }
  }

  async function handlePresetFile(file: File) {
    try {
      const result = await importPreset(file)
      const meta = await createMaterial({
        kind: 'preset',
        name: result.name,
        body: result.body,
        origin: 'imported',
      })
      await refresh('preset')
      setSelected({ id: meta.id, kind: 'preset' })
      if (result.warnings.length > 0) {
        window.alert(`导入时注意到：\n\n${result.warnings.join('\n')}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    }
  }

  async function handlePlayFile(file: File) {
    try {
      const text = await file.text()
      const data = JSON.parse(text) as unknown
      const result = await importPlaythrough(data)
      await loadPlays()
      setPlayingId(result.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入对局失败')
    }
  }

  async function extractAllLorebooks() {
    try {
      const result = await extractLorebooks()
      await refresh('lorebook')

      if (result.created.length === 0 && result.skipped.length === 0 && result.failed.length === 0) {
        setError('手上的角色卡都没有内嵌世界书。')
        return
      }

      const parts = [
        result.created.length > 0 ? `拆出 ${result.created.length} 份` : '',
        result.skipped.length > 0 ? `${result.skipped.length} 份已存在、已跳过` : '',
        result.failed.length > 0 ? `${result.failed.length} 份解析失败` : '',
      ].filter(Boolean)

      window.alert(parts.join('；') + '。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '拆解失败')
    }
  }

  if (playingId) {
    return (
      <PlayView
        playthroughId={playingId}
        onBack={() => {
          setPlayingId(null)
          void loadPlays()
        }}
      />
    )
  }

  const isCard = tab === 'card'
  const isLorebook = tab === 'lorebook'
  const isPlay = tab === 'play'

  const emptyTitle = isCard
    ? '这里还没有角色卡'
    : isLorebook
      ? '这里还没有世界书'
      : isPlay
        ? '还没有对局'
        : '这里还没有预设'

  const emptyHint = isCard
    ? '手写一张、导入酒馆导出的卡，或者写一句需求让模型起草。'
    : isLorebook
      ? '新建一份、导入酒馆导出的世界书 JSON，或者从角色卡里拆。'
      : isPlay
        ? '选几张卡当演员，开一局。'
        : '新建一份（内置酒馆默认排布），或者导入你调好的预设 JSON。'

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1>话本</h1>
          <p className="tagline">素材库</p>
        </div>
        <div className="head-actions">
          <button className="ghost" onClick={() => setPreviewOpen(true)}>
            装配预览
          </button>
          <button className="ghost" onClick={() => setSettingsOpen(true)}>
            设置
          </button>

          {isCard ? (
            !composing && (
              <button className="primary" onClick={() => setComposing(true)}>
                新建角色卡
              </button>
            )
          ) : isPlay ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void handlePlayFile(file)
                  e.target.value = ''
                }}
              />
              <button className="ghost" onClick={() => fileRef.current?.click()}>
                导入对局
              </button>
              <button className="primary" onClick={() => setNewPlayOpen(true)}>
                新的一局
              </button>
            </>
          ) : (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) {
                    if (isLorebook) void handleLorebookFile(file)
                    else void handlePresetFile(file)
                  }
                  e.target.value = ''
                }}
              />
              <button className="ghost" onClick={() => fileRef.current?.click()}>
                {isLorebook ? '导入世界书' : '导入预设'}
              </button>
              {isLorebook ? (
                <>
                  <button className="ghost" onClick={extractAllLorebooks}>
                    从角色卡拆解
                  </button>
                  <button className="primary" onClick={newLorebook}>
                    新建世界书
                  </button>
                </>
              ) : (
                <button className="primary" onClick={newPreset}>
                  新建预设
                </button>
              )}
            </>
          )}
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((item) => (
          <button
            key={item.kind}
            className={tab === item.kind ? 'tab active' : 'tab'}
            onClick={() => {
              setSelected(null)
              setTab(item.kind)
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="banner" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      )}

      {composing && isCard && (
        <CardComposer
          onSaved={async () => {
            setComposing(false)
            await refresh('card')
          }}
          onCancel={() => setComposing(false)}
        />
      )}

      {loading ? (
        <p className="muted">载入中…</p>
      ) : (isPlay ? plays.length : items.length) === 0 && !composing ? (
        <section className="empty">
          <p className="empty-title">{emptyTitle}</p>
          <p className="muted">{emptyHint}</p>
          <button
            className="primary"
            onClick={() => {
              if (isCard) setComposing(true)
              else if (isLorebook) void newLorebook()
              else if (isPlay) setNewPlayOpen(true)
              else void newPreset()
            }}
          >
            {isCard
              ? '新建第一张角色卡'
              : isLorebook
                ? '新建第一份世界书'
                : isPlay
                  ? '开第一局'
                  : '新建第一份预设'}
          </button>
        </section>
      ) : isPlay ? (
        <ul className="grid">
          {plays.map((play) => (
            <li key={play.id} className="card clickable" onClick={() => setPlayingId(play.id)}>
              <div className="card-head">
                <h3>{play.title}</h3>
                <span className="badge">{play.messageCount} 拍</span>
              </div>
              <p className="muted small">演员：{play.castNames.join('、')}</p>
              <p className="muted small">{new Date(play.updatedAt).toLocaleString('zh-CN')}</p>
              <button
                className="link danger"
                onClick={(e) => {
                  e.stopPropagation()
                  void removePlay(play.id, play.title, play.messageCount)
                }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="grid">
          {items.map((item) => (
            <li
              key={item.id}
              className="card clickable"
              onClick={() => setSelected({ id: item.id, kind: item.kind })}
            >
              <div className="card-head">
                {item.avatarUrl && (
                  <img className="avatar" src={item.avatarUrl} alt="" loading="lazy" />
                )}
                <h3>{item.name}</h3>
                <span className="badge">{item.origin === 'imported' ? '导入' : '手写'}</span>
              </div>
              <p className="muted small">{new Date(item.createdAt).toLocaleString('zh-CN')}</p>
              <button
                className="link danger"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(item.id, item.name)
                }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {previewOpen && <AssemblyPreview onClose={() => setPreviewOpen(false)} />}

      {newPlayOpen && (
        <NewPlaythrough
          onClose={() => setNewPlayOpen(false)}
          onCreated={(id) => {
            setNewPlayOpen(false)
            setPlayingId(id)
          }}
        />
      )}

      {selected?.kind === 'card' && (
        <CardDetail
          cardId={selected.id}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            setSelected(null)
            await refresh('card')
          }}
        />
      )}

      {selected?.kind === 'lorebook' && (
        <LorebookEditor
          lorebookId={selected.id}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            setSelected(null)
            await refresh('lorebook')
          }}
        />
      )}

      {selected?.kind === 'preset' && (
        <PresetEditor
          presetId={selected.id}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            setSelected(null)
            await refresh('preset')
          }}
        />
      )}
    </div>
  )
}
