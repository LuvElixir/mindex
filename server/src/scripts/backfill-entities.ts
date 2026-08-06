/**
 * 一次性回填：从存量 claims 推导实体并建立关联（幂等，可重复执行）。
 * 背景：2026-07 前启发式元数据抽取与口碑聚合不产实体，导致知识图谱缺基础节点。
 * 规则与 extract.ts / pipeline.ts 的新逻辑一致：
 *   - official_fact predicate=developer/publisher → company 实体（值取 value_json.value）
 *   - official_fact predicate=genre → term 实体（按顿号/逗号拆分）
 *   - player_opinion topic=gameplay/monetization/creative → 口碑 term 枢纽实体
 */
import { openDb } from '../db/index.js'
import { newId } from '../lib/util.js'

const db = openDb()

function upsert(projectId: string, name: string, type: string): string {
  const existing = db
    .prepare(`SELECT id FROM entities WHERE project_id = ? AND entity_type = ? AND canonical_name = ?`)
    .get(projectId, type, name) as { id: string } | undefined
  if (existing) return existing.id
  const id = newId('ent')
  db.prepare(`INSERT INTO entities (id, project_id, entity_type, canonical_name) VALUES (?, ?, ?, ?)`).run(id, projectId, type, name)
  return id
}

function link(claimId: string, entityId: string): number {
  return db.prepare(`INSERT OR IGNORE INTO claim_entities (claim_id, entity_id, role) VALUES (?, ?, 'mentions')`).run(claimId, entityId).changes
}

let linked = 0

const facts = db
  .prepare(
    `SELECT id, project_id, predicate, value_json FROM claims
     WHERE claim_type = 'official_fact' AND merged_into IS NULL AND predicate IN ('developer','publisher','genre') AND value_json IS NOT NULL`,
  )
  .all() as { id: string; project_id: string; predicate: string; value_json: string }[]
for (const f of facts) {
  let value = ''
  try {
    value = String((JSON.parse(f.value_json) as { value?: unknown }).value ?? '')
  } catch {
    continue
  }
  if (!value) continue
  if (f.predicate === 'genre') {
    for (const g of value.split(/[、,，/]/).map((s) => s.trim()).filter(Boolean).slice(0, 4)) {
      linked += link(f.id, upsert(f.project_id, g, 'term'))
    }
  } else {
    linked += link(f.id, upsert(f.project_id, value, 'company'))
  }
}

const TOPIC_LABEL: Record<string, string> = { gameplay: '玩法口碑', monetization: '付费口碑', creative: '内容表现口碑' }
const opinions = db
  .prepare(`SELECT id, project_id, topic FROM claims WHERE claim_type = 'player_opinion' AND merged_into IS NULL`)
  .all() as { id: string; project_id: string; topic: string }[]
for (const o of opinions) {
  const label = TOPIC_LABEL[o.topic]
  if (label) linked += link(o.id, upsert(o.project_id, label, 'term'))
}

console.log(`backfill 完成：处理 ${facts.length} 条事实 + ${opinions.length} 条口碑，新建关联 ${linked} 个`)
