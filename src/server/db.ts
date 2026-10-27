import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

// HUABEN_DB 可指向另一份数据库文件：跑验证或回归时用它，
// 避免测试写操作覆盖掉真实的素材与模型配置。
const DB_PATH = resolve(process.cwd(), process.env.HUABEN_DB ?? 'data/huaben.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('card','lorebook','preset')),
    name          TEXT NOT NULL,
    origin        TEXT NOT NULL CHECK (origin IN ('imported','authored')),
    body_json     TEXT NOT NULL,
    origin_json   TEXT,
    fidelity_json TEXT,
    avatar_path   TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )
`)

// 老库兼容：01 建表时还没有头像列
const materialColumns = db.prepare('PRAGMA table_info(materials)').all() as Array<{ name: string }>
if (!materialColumns.some((c) => c.name === 'avatar_path')) {
  db.exec('ALTER TABLE materials ADD COLUMN avatar_path TEXT')
}

db.exec('CREATE INDEX IF NOT EXISTS idx_materials_kind ON materials(kind)')

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`)

/* ── 对局：素材在开局时冻结进这里，之后改素材不影响已开的局 ── */

db.exec(`
  CREATE TABLE IF NOT EXISTS playthroughs (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    preset_json     TEXT NOT NULL,
    lorebook_json   TEXT,
    current_leaf_id TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS cast_members (
    id              TEXT PRIMARY KEY,
    playthrough_id  TEXT NOT NULL,
    material_id     TEXT,
    name            TEXT NOT NULL,
    body_json       TEXT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    playthrough_id  TEXT NOT NULL,
    parent_id       TEXT,
    kind            TEXT NOT NULL CHECK (kind IN ('narration','director')),
    content         TEXT NOT NULL,
    meta_json       TEXT,
    created_at      INTEGER NOT NULL
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_playthrough ON messages(playthrough_id, created_at)`)

// 软删除：回退重演时旧内容只标记、不删除
const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
if (!messageColumns.some((c) => c.name === 'replaced_by')) {
  db.exec('ALTER TABLE messages ADD COLUMN replaced_by TEXT')
}

// 老库兼容：记忆压缩是后来加的
const playthroughColumns = db.prepare('PRAGMA table_info(playthroughs)').all() as Array<{
  name: string
}>
if (!playthroughColumns.some((c) => c.name === 'memory_json')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN memory_json TEXT')
}

// 角色状态模板也是后来加的
if (!playthroughColumns.some((c) => c.name === 'cast_templates_json')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN cast_templates_json TEXT')
}

// 对局级别的规则
if (!playthroughColumns.some((c) => c.name === 'extra_rules')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN extra_rules TEXT')
}

// 对局可以固定用哪个供应商与模型
if (!playthroughColumns.some((c) => c.name === 'provider_id')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN provider_id TEXT')
}
if (!playthroughColumns.some((c) => c.name === 'model_override')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN model_override TEXT')
}
if (!playthroughColumns.some((c) => c.name === 'reasoning_effort')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN reasoning_effort TEXT')
}
if (!playthroughColumns.some((c) => c.name === 'jailbreak')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN jailbreak TEXT')
}
if (!playthroughColumns.some((c) => c.name === 'prefill')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN prefill TEXT')
}
if (!playthroughColumns.some((c) => c.name === 'delivery_check')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN delivery_check TEXT')
}
if (!playthroughColumns.some((c) => c.name === 'state_rules')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN state_rules TEXT')
}
if (!playthroughColumns.some((c) => c.name === 'writing_style')) {
  db.exec('ALTER TABLE playthroughs ADD COLUMN writing_style TEXT')
}
// 软删除：被替换掉的旧内容不真删，只标记

/**
 * 把 WAL 合并回主库。
 * 之前主库长期只有一页、全部数据躺在 -wal 里：一旦那个文件损坏或被清理，
 * 整库就没了（真实发生过一次）。启动时强制 checkpoint 一次。
 */
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
} catch {
  // checkpoint 失败不阻断启动
}

/** 每次备份前先归并 WAL，保证快照是完整的。 */
function backupDatabase(): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // 归并失败也继续备份，主库本身仍是可用的
  }

  try {
    const dir = resolve(process.cwd(), 'data', 'backups')
    mkdirSync(dir, { recursive: true })

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19)
    copyFileSync(DB_PATH, resolve(dir, `huaben-${stamp}.db`))

    const files = readdirSync(dir)
      .filter((name) => name.startsWith('huaben-') && name.endsWith('.db'))
      .sort()

    // 保留最近 12 份：半小时一次的话，能回溯 6 小时
    while (files.length > 12) {
      const oldest = files.shift()
      if (oldest) unlinkSync(resolve(dir, oldest))
    }
  } catch {
    // 备份失败不影响运行
  }
}

backupDatabase()

// 定时备份：启动时的快照挡不住「运行中把数据改坏」
const BACKUP_INTERVAL_MS = 30 * 60 * 1000
setInterval(backupDatabase, BACKUP_INTERVAL_MS).unref()
