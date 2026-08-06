import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export type DB = Database.Database

let _db: DB | null = null

export function openDb(dbPath = config.dbPath): DB {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)
  migrate(db)
  return db
}

/**
 * 幂等列迁移。SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS,
 * 用 PRAGMA table_info 探测后按需补列。新库 schema.sql 已含这些列,此处跳过。
 * ponytail: 每个迁移只跑一次(探测即知),留在这里作为老库升级的安全网。
 */
function migrate(db: DB): void {
  const cols = (table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
  const claimsCols = cols('claims')
  if (!claimsCols.has('ad_role')) db.exec(`ALTER TABLE claims ADD COLUMN ad_role TEXT`) // 获客视角投影: ammo|landmine|NULL
  const projCols = cols('projects')
  if (!projCols.has('competitors')) db.exec(`ALTER TABLE projects ADD COLUMN competitors TEXT NOT NULL DEFAULT '[]'`) // 竞品名清单 → ammo 弹药
}

export function getDb(): DB {
  if (!_db) _db = openDb()
  return _db
}

/** For tests: fresh in-memory database with full schema. */
export function memoryDb(): DB {
  return openDb(':memory:')
}
