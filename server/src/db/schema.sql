-- Mindex core schema v1
-- Design notes: docs/architecture.md
-- documents = URL identity; snapshots = immutable fetched content (grounding target);
-- evidence = verbatim spans inside snapshots (quote MUST be re-findable in snapshot.text);
-- claims = atomic, decontextualized statements with explainable confidence.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  -- 2026-07 起产品只服务手游买量，kind 收缩为 game。存量库不做表重建迁移（SQLite 改 CHECK 需重建表），写入面已由 API zod 约束
  kind           TEXT NOT NULL DEFAULT 'game' CHECK (kind IN ('game')),
  description    TEXT NOT NULL DEFAULT '',
  aliases        TEXT NOT NULL DEFAULT '[]',   -- JSON: alternative names, zh/en
  competitors    TEXT NOT NULL DEFAULT '[]',   -- JSON: 竞品名清单(用户登记),用于采集竞品负面口碑 → ammo 卖点
  official_urls  TEXT NOT NULL DEFAULT '[]',   -- JSON: user-provided official links
  platform_hints TEXT NOT NULL DEFAULT '{}',   -- JSON: {itunes_cn_id, taptap_id, bilibili_uid, ...}
  current_version TEXT,
  demo           INTEGER NOT NULL DEFAULT 0,   -- 1 = seeded demo project, clearly labeled in UI
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_runs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('queued','running','done','failed','cancelled')),
  llm_provider   TEXT NOT NULL DEFAULT 'none',
  model_id       TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT 'v1',
  plan           TEXT NOT NULL DEFAULT '{}',   -- JSON: research questions, keywords, connector picks
  stats          TEXT NOT NULL DEFAULT '{}',
  error          TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  phase   TEXT NOT NULL,   -- plan | discover | fetch | extract | consolidate | score | review | done
  level   TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  message TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '{}',
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connector       TEXT NOT NULL,               -- itunes_app | taptap | bilibili | xiaohongshu | baobaomi | web | rss | upload | manual
  source_type     TEXT NOT NULL CHECK (source_type IN
    ('official','store_metadata','store_review','wiki','press','community','video','internal_doc','user_note','other')),
  name            TEXT NOT NULL,
  url             TEXT,
  platform        TEXT NOT NULL DEFAULT '',    -- appstore | taptap | bilibili | xiaohongshu | douyin | web | internal
  owner_key       TEXT NOT NULL DEFAULT '',    -- normalized owner (company/domain/handle); same owner = not independent
  authority_prior REAL NOT NULL DEFAULT 0.5,   -- [0,1] prior reliability of this source class
  robots_status   TEXT NOT NULL DEFAULT 'n/a', -- allowed | disallowed | n/a | unknown
  license_note    TEXT NOT NULL DEFAULT '',
  first_seen_at   TEXT NOT NULL,
  last_fetched_at TEXT,
  fetch_status    TEXT NOT NULL DEFAULT 'pending', -- pending | ok | error | skipped
  fetch_error     TEXT,
  meta            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id);

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL,
  url           TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL DEFAULT '',      -- normalized; per-review pseudo-URLs for review items
  doc_type      TEXT NOT NULL DEFAULT 'page',  -- page | api_record | review | patch_note | wiki_page | rss_item | upload
  title         TEXT NOT NULL DEFAULT '',
  author_handle TEXT,
  author_meta   TEXT NOT NULL DEFAULT '{}',
  published_at  TEXT,
  version_tag   TEXT,                          -- app/game version the content refers to, if known
  first_seen_at TEXT NOT NULL,
  UNIQUE (project_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);

CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  run_id       TEXT,
  fetched_at   TEXT NOT NULL,
  http_status  INTEGER,
  content_hash TEXT NOT NULL,                  -- sha256(normalized text)
  simhash64    TEXT,                           -- hex, near-dup detection
  dup_cluster  TEXT,                           -- syndication cluster id; same cluster = one independent source
  text         TEXT NOT NULL,                  -- normalized extracted text; grounding target for quotes
  raw_path     TEXT,                           -- raw payload archived under data/snapshots
  lang         TEXT NOT NULL DEFAULT 'zh',
  meta         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_document ON snapshots(document_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_hash ON snapshots(project_id, content_hash);

CREATE TABLE IF NOT EXISTS evidence (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  snapshot_id     TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL,
  run_id          TEXT,
  quote           TEXT NOT NULL,               -- verbatim; enforced substring of snapshot.text
  quote_hash      TEXT NOT NULL,
  char_start      INTEGER,
  char_end        INTEGER,
  context_before  TEXT NOT NULL DEFAULT '',
  context_after   TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'statement', -- statement | review | announcement | patch_note | description | metric
  lang            TEXT NOT NULL DEFAULT 'zh',
  rating          REAL,                        -- star rating for reviews
  helpful_votes   INTEGER,                     -- recorded for display; NEVER a truth signal
  published_at    TEXT,
  author_handle   TEXT,
  suspected_promo INTEGER NOT NULL DEFAULT 0,  -- astroturf heuristic flag
  dup_of          TEXT,                        -- near-duplicate of another evidence id
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_snapshot ON evidence(snapshot_id);

CREATE TABLE IF NOT EXISTS entities (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL,                -- product | company | character | feature | platform | competitor | audience_segment | term
  canonical_name TEXT NOT NULL,
  aliases        TEXT NOT NULL DEFAULT '[]',
  meta           TEXT NOT NULL DEFAULT '{}',
  UNIQUE (project_id, entity_type, canonical_name)
);

CREATE TABLE IF NOT EXISTS claims (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq                  INTEGER NOT NULL,       -- per-project display number (001, 002 ...)
  claim_type           TEXT NOT NULL CHECK (claim_type IN
    ('official_fact','player_opinion','system_inference','creative_insight')),
  topic                TEXT NOT NULL DEFAULT 'other',
  text                 TEXT NOT NULL,          -- atomic, decontextualized statement
  text_hash            TEXT NOT NULL,
  subject_entity_id    TEXT,
  predicate            TEXT,                   -- normalized predicate; join key for rule-based conflict scan
  value_json           TEXT,                   -- JSON {value, unit} for numeric claims
  qualifiers           TEXT NOT NULL DEFAULT '{}', -- JSON {region, platform, ...} — part of claim semantics
  observed_at          TEXT NOT NULL,
  valid_from           TEXT,
  valid_until          TEXT,                   -- closed by supersession; NULL = still valid
  version_min          TEXT,
  version_max          TEXT,
  rank                 TEXT NOT NULL DEFAULT 'normal' CHECK (rank IN ('preferred','normal','deprecated')),
  deprecated_reason    TEXT,
  superseded_by        TEXT,
  merged_into          TEXT,
  review_state         TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN
    ('auto_accepted','pending','approved','rejected','merged','expired','quarantined')),
  confidence           REAL,                   -- NULL when band = insufficient (honest "don't know")
  confidence_band      TEXT NOT NULL DEFAULT 'insufficient' CHECK (confidence_band IN
    ('verified','likely','uncertain','disputed','insufficient')),
  confidence_breakdown TEXT NOT NULL DEFAULT '{}', -- JSON: per-factor explanation
  opinion_stats        TEXT,                   -- JSON for player_opinion: prevalence, ci_low, sample_size, sentiment, window
  ad_role              TEXT,                   -- 获客视角投影(只对 player_opinion): ammo=可反转卖点(行业通病/骂竞品) | landmine=本产品当前短板(广告别碰); NULL=未分类或非负面
  derived_from         TEXT NOT NULL DEFAULT '[]', -- claim ids (inference/insight premises)
  extraction_provider  TEXT NOT NULL DEFAULT 'heuristic', -- heuristic | anthropic | claude-cli — honesty about origin
  run_id               TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id, review_state);
CREATE INDEX IF NOT EXISTS idx_claims_slot ON claims(project_id, subject_entity_id, predicate);
CREATE INDEX IF NOT EXISTS idx_claims_texthash ON claims(project_id, text_hash);

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id             TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_id          TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  stance               TEXT NOT NULL DEFAULT 'supports' CHECK (stance IN ('supports','refutes','mentions')),
  directness           TEXT NOT NULL DEFAULT 'direct' CHECK (directness IN ('direct','indirect','interpretive')),
  extractor_confidence REAL,
  PRIMARY KEY (claim_id, evidence_id)
);

-- ============ 获客卖点投影层 ============
-- 合成的广告角度。这是 claims 的投影,不存新事实 —— 每次 scorePhase 后重算
-- (先删该项目旧行再写入)。继承到源 claim,可追溯。landmine 闸门保证不踩雷。
CREATE TABLE IF NOT EXISTS selling_angles (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dimension     TEXT NOT NULL,          -- monetization|grind|performance|content|fairness|art|story|music|brand|timeliness
  tactic        TEXT NOT NULL,          -- pain_reverse|fact_amplify|opinion_endorse|competitor_position|timely_hook
  angle         TEXT NOT NULL,          -- 给创意 Agent 的角度描述
  hooks         TEXT NOT NULL DEFAULT '[]', -- JSON: 候选 punchline(自由修辞)
  strength      TEXT NOT NULL DEFAULT 'low' CHECK (strength IN ('high','medium','low')),
  derived_from  TEXT NOT NULL DEFAULT '[]', -- JSON: 源 claim id 数组
  rationale     TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_selling_angles_project ON selling_angles(project_id, strength);

CREATE TABLE IF NOT EXISTS claim_entities (
  claim_id  TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'mentions',
  PRIMARY KEY (claim_id, entity_id)
);

CREATE TABLE IF NOT EXISTS conflicts (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  claim_a         TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  claim_b         TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  conflict_type   TEXT NOT NULL CHECK (conflict_type IN ('numeric','version_temporal','semantic','opinion_split')),
  detected_by     TEXT NOT NULL,               -- rule:numeric_mismatch | llm:semantic | ...
  detector_note   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN
    ('open','resolved_a','resolved_b','both_valid_scoped','dismissed')),
  resolution_note TEXT NOT NULL DEFAULT '',
  resolved_by     TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_project ON conflicts(project_id, status);

CREATE TABLE IF NOT EXISTS revisions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  actor    TEXT NOT NULL,                      -- system:<component> | human:admin | agent:<key name>
  action   TEXT NOT NULL,                      -- create | rescore | approve | reject | merge | supersede | expire | edit
  before_json TEXT,
  after_json  TEXT,
  reason   TEXT NOT NULL DEFAULT '',
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_claim ON revisions(claim_id, id);

CREATE TABLE IF NOT EXISTS review_queue (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  item_type  TEXT NOT NULL CHECK (item_type IN ('claim','conflict','source')),
  item_id    TEXT NOT NULL,
  reason     TEXT NOT NULL,                    -- low_confidence | conflict_open | astroturf_suspect | patch_invalidation | citation_check_failed | manual
  priority   INTEGER NOT NULL DEFAULT 3,      -- 1 highest
  state      TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','in_review','done','skipped')),
  decision   TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (item_type, item_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_review_queue_state ON review_queue(project_id, state, priority);

-- ============ Agent access plane ============

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,           -- sha256 of full token; plaintext shown once at creation
  last4        TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '["read"]', -- read | context | admin
  project_ids  TEXT NOT NULL DEFAULT '[]',     -- JSON array; ["*"] = all projects
  rate_limit_rpm INTEGER NOT NULL DEFAULT 120,
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  revoked_at   TEXT,
  rotated_from TEXT,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS api_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id      TEXT,                            -- NULL for anonymous/rejected
  method      TEXT NOT NULL,
  route       TEXT NOT NULL,
  status      INTEGER NOT NULL,
  duration_ms REAL NOT NULL DEFAULT 0,
  ip          TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_logs_key ON api_logs(key_id, id);

-- ============ Full-text search ============
-- Chinese FTS: default tokenizers can't segment CJK, and trigram misses 2-char words
-- (最高频查询单元). Text is pre-segmented with jieba in the app layer and stored in a
-- contentless-delete FTS table (seg column). Sync happens in Store methods, not triggers.

CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
  seg, content='', contentless_delete=1, tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  seg, content='', contentless_delete=1, tokenize='porter unicode61'
);
