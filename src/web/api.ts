import type {
  CardBody,
  CardDraft,
  CardImportResult,
  CastTemplates,
  GameState,
  CreateMaterialInput,
  Lorebook,
  Material,
  MaterialMeta,
  PlayMemory,
  PlaythroughDetail,
  PlaythroughSummary,
  Preset,
  PublicSettings,
} from '../shared/types.ts'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })

  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(payload.error ?? `请求失败（${res.status}）`)
  }

  return res.json() as Promise<T>
}

export function listMaterials(kind?: string): Promise<MaterialMeta[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return request<MaterialMeta[]>(`/api/materials${query}`)
}

export function getMaterial(id: string): Promise<Material> {
  return request<Material>(`/api/materials/${id}`)
}

export function createMaterial(input: CreateMaterialInput): Promise<MaterialMeta> {
  return request<MaterialMeta>('/api/materials', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateMaterial(
  id: string,
  input: Partial<CreateMaterialInput>,
): Promise<MaterialMeta> {
  return request<MaterialMeta>(`/api/materials/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteMaterial(id: string, force = false): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/materials/${id}${force ? '?force=1' : ''}`, {
    method: 'DELETE',
  })
}

export function getSettings(): Promise<PublicSettings> {
  return request<PublicSettings>('/api/settings')
}

export interface ProviderInput {
  id: string
  name: string
  apiBase: string
  /** 留空表示沿用服务端已存的密钥 */
  apiKey: string
  model: string
  models: string[]
}

export function saveSettingsApi(input: {
  providers: ProviderInput[]
  activeId: string
}): Promise<PublicSettings> {
  return request<PublicSettings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function testSettings(
  providerId?: string,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  return request<{ ok: boolean; reply?: string; error?: string }>('/api/settings/test', {
    method: 'POST',
    body: JSON.stringify({ providerId }),
  })
}

export function fetchModels(providerId?: string): Promise<{ models: string[] }> {
  const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : ''
  return request<{ models: string[] }>(`/api/settings/models${query}`)
}

export function draftCard(brief: string): Promise<CardDraft> {
  return request<CardDraft>('/api/assist/card', {
    method: 'POST',
    body: JSON.stringify({ brief }),
    signal: AbortSignal.timeout(120_000),
  })
}

/** 不能用 request()：multipart 需要浏览器自己带 boundary。 */
export async function importCard(file: File): Promise<CardImportResult> {
  const form = new FormData()
  form.append('file', file)

  const res = await fetch('/api/import/card', { method: 'POST', body: form })
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(payload.error ?? `导入失败（${res.status}）`)
  }

  return res.json() as Promise<CardImportResult>
}

export function reviseCard(body: CardBody, instruction: string): Promise<CardBody> {
  return request<CardBody>('/api/assist/revise-card', {
    method: 'POST',
    body: JSON.stringify({ body, instruction }),
    signal: AbortSignal.timeout(180_000),
  })
}

export async function importLorebook(
  file: File,
): Promise<{ name: string; body: Lorebook; sourceName: string }> {
  const form = new FormData()
  form.append('file', file)

  const res = await fetch('/api/import/lorebook', { method: 'POST', body: form })
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(payload.error ?? `导入失败（${res.status}）`)
  }

  return res.json() as Promise<{ name: string; body: Lorebook; sourceName: string }>
}

export function extractLorebooks(): Promise<{
  created: string[]
  skipped: string[]
  failed: Array<{ card: string; error: string }>
}> {
  return request('/api/lorebooks/extract-from-cards', { method: 'POST' })
}

/* ── 对局 ── */

export function listPlaythroughs(): Promise<PlaythroughSummary[]> {
  return request<PlaythroughSummary[]>('/api/playthroughs')
}

export function createPlaythrough(input: {
  title?: string
  cardIds: string[]
  lorebookId?: string
  presetId?: string
}): Promise<{ id: string; title: string }> {
  return request('/api/playthroughs', { method: 'POST', body: JSON.stringify(input) })
}

export function getPlaythrough(id: string): Promise<PlaythroughDetail> {
  return request<PlaythroughDetail>(`/api/playthroughs/${id}`)
}

export type BeatEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'done'
      messageId: string
      usage: { prompt: number; completion: number } | null
      promptChars: number
      estimatedTokens: number
      warnings: string[]
    }
  | { type: 'error'; error: string }

/** 演一拍：读取 SSE 流，逐块回调正文。 */
export async function streamBeat(
  id: string,
  directive: string,
  onDelta: (text: string) => void,
  options: { rewrite?: string; replaceLast?: boolean } = {},
): Promise<Extract<BeatEvent, { type: 'done' }>> {
  const res = await fetch(`/api/playthroughs/${id}/beats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      directive,
      rewrite: options.rewrite ?? '',
      replaceLast: options.replaceLast === true,
    }),
  })

  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(payload.error ?? `演出失败（${res.status}）`)
  }
  if (!res.body) throw new Error('模型没有返回内容。')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done: Extract<BeatEvent, { type: 'done' }> | null = null

  while (true) {
    const { done: finished, value } = await reader.read()
    if (finished) break

    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')

      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue
        let event: BeatEvent
        try {
          event = JSON.parse(line.slice(5).trim()) as BeatEvent
        } catch {
          continue
        }
        if (event.type === 'delta') onDelta(event.text)
        else if (event.type === 'error') throw new Error(event.error)
        else if (event.type === 'done') done = event
      }
    }
  }

  if (!done) throw new Error('流式响应断开了，这一拍没有保存。')
  return done
}

/** 只换岔路，正文不动。 */
export function regenerateForks(
  id: string,
  note: string,
  messageId?: string,
): Promise<{ forks: Array<{ trigger: string; toward: string }> }> {
  return request(`/api/playthroughs/${id}/forks/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ note, messageId }),
  })
}

/** 回退：把当前位置移到某一拍，旧枝保留。 */
export function checkout(
  id: string,
  messageId: string,
): Promise<{ ok: true; currentLeafId: string }> {
  return request(`/api/playthroughs/${id}/checkout`, {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  })
}

export function compactStory(
  id: string,
  keepRecent = 3,
): Promise<{ memory: PlayMemory; compressed: number; kept: number }> {
  return request(`/api/playthroughs/${id}/compact`, {
    method: 'POST',
    body: JSON.stringify({ keepRecent }),
  })
}

export function updateMemory(id: string, summary: string): Promise<{ memory: PlayMemory }> {
  return request(`/api/playthroughs/${id}/memory`, {
    method: 'PUT',
    body: JSON.stringify({ summary }),
  })
}

/** 导出整局并触发浏览器下载。 */
export async function exportPlaythrough(id: string): Promise<void> {
  const res = await fetch(`/api/playthroughs/${id}/export`)
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(payload.error ?? '导出失败')
  }

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `playthrough-${id.slice(0, 8)}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function importPlaythrough(
  data: unknown,
): Promise<{ id: string; title: string; messages: number }> {
  return request('/api/playthroughs/import', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function deletePlaythrough(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/playthroughs/${id}`, { method: 'DELETE' })
}

export function updateTemplates(
  id: string,
  templates: CastTemplates,
): Promise<{ templates: CastTemplates }> {
  return request(`/api/playthroughs/${id}/templates`, {
    method: 'PUT',
    body: JSON.stringify({ templates }),
  })
}

export function updateRules(id: string, extraRules: string): Promise<{ extraRules: string }> {
  return request(`/api/playthroughs/${id}/rules`, {
    method: 'PUT',
    body: JSON.stringify({ extraRules }),
  })
}

export function updatePlayModel(
  id: string,
  providerId: string,
  model: string,
  reasoningEffort = '',
): Promise<{ providerId: string; modelOverride: string; reasoningEffort: string }> {
  return request(`/api/playthroughs/${id}/model`, {
    method: 'PUT',
    body: JSON.stringify({ providerId, model, reasoningEffort }),
  })
}

export function updateJailbreak(id: string, jailbreak: string): Promise<{ jailbreak: string }> {
  return request(`/api/playthroughs/${id}/jailbreak`, {
    method: 'PUT',
    body: JSON.stringify({ jailbreak }),
  })
}

export function updateWritingStyle(
  id: string,
  writingStyle: string,
): Promise<{ writingStyle: string }> {
  return request(`/api/playthroughs/${id}/style`, {
    method: 'PUT',
    body: JSON.stringify({ writingStyle }),
  })
}

export function updateStateRules(id: string, stateRules: string): Promise<{ stateRules: string }> {
  return request(`/api/playthroughs/${id}/state-rules`, {
    method: 'PUT',
    body: JSON.stringify({ stateRules }),
  })
}

export function updateDeliveryCheck(
  id: string,
  deliveryCheck: string,
): Promise<{ deliveryCheck: string }> {
  return request(`/api/playthroughs/${id}/delivery`, {
    method: 'PUT',
    body: JSON.stringify({ deliveryCheck }),
  })
}

export function updatePrefill(id: string, prefill: string): Promise<{ prefill: string }> {
  return request(`/api/playthroughs/${id}/prefill`, {
    method: 'PUT',
    body: JSON.stringify({ prefill }),
  })
}

/** 按更改请求改写选中的那段文字，返回结果但不落库。 */
export function rewriteSelection(
  id: string,
  messageId: string,
  selected: string,
  instruction: string,
): Promise<{ rewritten: string }> {
  return request(`/api/playthroughs/${id}/messages/${messageId}/rewrite-selection`, {
    method: 'POST',
    body: JSON.stringify({ selected, instruction }),
    signal: AbortSignal.timeout(180_000),
  })
}

/** 只重算这一拍的状态栏，正文不动。 */
export function regenerateState(
  id: string,
  messageId: string,
): Promise<{ state: GameState }> {
  return request(`/api/playthroughs/${id}/messages/${messageId}/state`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
  })
}

export function updateMessageContent(
  id: string,
  messageId: string,
  content: string,
): Promise<{ ok: true; content: string }> {
  return request(`/api/playthroughs/${id}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  })
}

export async function importPreset(
  file: File,
): Promise<{ name: string; body: Preset; warnings: string[]; sourceName: string }> {
  const form = new FormData()
  form.append('file', file)

  const res = await fetch('/api/import/preset', { method: 'POST', body: form })
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(payload.error ?? `导入失败（${res.status}）`)
  }

  return res.json() as Promise<{
    name: string
    body: Preset
    warnings: string[]
    sourceName: string
  }>
}
