export type MaterialKind = 'card' | 'lorebook' | 'preset'

export type MaterialOrigin = 'imported' | 'authored'

/** 角色卡的内容体。01 只用到最少字段，后续票会逐步补齐。 */
export interface CardBody {
  name: string
  description: string
  /** 登场引子：模型写这个角色首次登场时的参考片段，可为空 */
  firstMes: string
  personality?: string
  scenario?: string
  mesExample?: string
  alternateGreetings?: string[]
  systemPrompt?: string
  postHistoryInstructions?: string
  creatorNotes?: string
  tags?: string[]
  creator?: string
  characterVersion?: string
  /** 卡内世界书原样保留，交给世界书票处理 */
  characterBook?: unknown
}

/** 一次导入的保真度报告：说清哪些生效、哪些没有 */
export interface Fidelity {
  specVersion: string
  read: string[]
  mapped: Record<string, string>
  ignored: string[]
  degraded: Array<{ field: string; reason: string }>
  warnings: string[]
}

export interface CardImportResult {
  draft: CardBody
  fidelity: Fidelity
  avatarDataUrl?: string
  sourceName: string
}

/* ── 世界书 ── */

export type LorePosition = 'before' | 'after' | 'depth'

export interface LoreEntry {
  id: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  /** 条目标题/备忘，不参与触发 */
  comment: string
  constant: boolean
  selective: boolean
  /** 0=AND ANY, 1=NOT ALL, 2=NOT ANY, 3=AND ALL */
  selectiveLogic: number
  position: LorePosition
  depth: number
  order: number
  enabled: boolean
}

export interface Lorebook {
  name: string
  entries: LoreEntry[]
}

/* ── 预设 ── */

export type PresetRole = 'system' | 'user' | 'assistant'

export interface PresetPrompt {
  identifier: string
  name: string
  content: string
  role: PresetRole
  systemPrompt: boolean
  /** true = 占位符，运行时由实际内容替换（角色描述、聊天记录等） */
  marker: boolean
  enabled: boolean
}

export interface PresetParams {
  temperature: number
  topP: number
  topK: number
  repetitionPenalty: number
  frequencyPenalty: number
  presencePenalty: number
  maxContext: number
  maxTokens: number
}

export interface Preset {
  name: string
  params: PresetParams
  prompts: PresetPrompt[]
}

/* ── 对局 ── */

export interface PlaythroughSummary {
  id: string
  title: string
  castNames: string[]
  messageCount: number
  createdAt: number
  updatedAt: number
}

export interface PlayMessage {
  id: string
  parentId: string | null
  kind: 'narration' | 'director'
  content: string
  meta: {
    promptChars?: number
    estimatedTokens?: number
    usage?: { prompt: number; completion: number } | null
    warnings?: string[]
    prompt?: string
    state?: GameState | null
    forks?: Fork[] | null
    /** 重写正文时保留了上一版的岔路 */
    forksFromEarlierVersion?: boolean
    parseWarnings?: string[]
  } | null
  createdAt: number
}

export interface PlayMemory {
  summary: string
  /** 摘要覆盖到这一条为止（含） */
  coveredUntil: string
}

export interface PlaythroughDetail {
  id: string
  title: string
  currentLeafId: string | null
  memory: PlayMemory | null
  templates: CastTemplates
  /** 本局自己的规则或提示词 */
  extraRules: string
  /** 这一局固定用的供应商；空表示跟随全局 */
  providerId: string
  /** 这一局固定用的模型名；空表示用供应商自己的 */
  modelOverride: string
  /** 思考力度：low / medium / high，空表示默认 */
  reasoningEffort: string
  /** 破甲提示词：放在 system 最前 */
  jailbreak: string
  cast: Array<{ id: string; name: string; materialId: string | null; body: CardBody }>
  messages: PlayMessage[]
}

/* ── 一拍的产物 ── */

export interface GameState {
  scene: { location: string; time: string }
  present: string[]
  relations: Array<{ a: string; b: string; note: string }>
  notes: string[]
  /** 按模板给出的角色状态：角色名 → 字段 → 值 */
  characters: Record<string, Record<string, string>>
}

/** 一个角色状态字段：字段名 + 给模型的填写提示 */
export interface StateField {
  key: string
  hint?: string
}

/** 对局级别的角色状态模板：角色名 → 字段列表 */
export type CastTemplates = Record<string, StateField[]>

export interface Fork {
  /** 触发条件：如果让什么事发生 */
  trigger: string
  /** 引向的方向：会把局面推向哪一类处境 */
  toward: string
}

export interface ParsedBeat {
  narration: string
  state?: GameState
  forks?: Fork[]
  warnings: string[]
}

export interface MaterialMeta {
  id: string
  kind: MaterialKind
  name: string
  origin: MaterialOrigin
  createdAt: number
  updatedAt: number
  /** 有头像时指向 /api/materials/<id>/avatar */
  avatarUrl?: string
}

export interface Material extends MaterialMeta {
  body: unknown
}

export interface CreateMaterialInput {
  kind: MaterialKind
  name: string
  body: unknown
  origin?: MaterialOrigin
  /** 导入 PNG 卡或用户选择的图片，服务端落盘；PUT 时传 null 表示移除头像 */
  avatarDataUrl?: string | null
}

/** 起草结果：模型给出的角色卡字段，填进表单但尚未入库。
 *  与导入卡保持同一厚度——不该因为是 AI 写的就更薄。 */
export interface CardDraft {
  name: string
  description: string
  firstMes: string
  personality?: string
  scenario?: string
  mesExample?: string
  tags?: string[]
}

/** 回传给前端的设置，永不包含密钥本体 */
export interface PublicProvider {
  id: string
  name: string
  apiBase: string
  model: string
  models: string[]
  hasApiKey: boolean
}

export interface PublicSettings {
  providers: PublicProvider[]
  activeId: string
}
