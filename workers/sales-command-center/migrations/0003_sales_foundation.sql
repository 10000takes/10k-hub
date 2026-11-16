PRAGMA foreign_keys = ON;

-- Named application identities. Tokens remain Worker secrets, never D1 values.
CREATE TABLE IF NOT EXISTS sales_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('sales_admin','sales_lead')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO sales_users (id, display_name, role, active, created_at, updated_at)
VALUES ('jack','Jack Leverentz','sales_admin',1,datetime('now'),datetime('now'))
ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, role=excluded.role, active=1, updated_at=excluded.updated_at;
INSERT INTO sales_users (id, display_name, role, active, created_at, updated_at)
VALUES ('cody','Cody','sales_lead',1,datetime('now'),datetime('now'))
ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, role=excluded.role, active=1, updated_at=excluded.updated_at;

CREATE TABLE IF NOT EXISTS sales_audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_audit_created ON sales_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_audit_entity ON sales_audit_log(entity_type, entity_id, created_at DESC);

-- All opt-outs and blocked recipients are checked before any later send attempt.
CREATE TABLE IF NOT EXISTS sales_suppressions (
  id TEXT PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('email','domain')),
  value TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'opt-out',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(match_type, value)
);

-- Atomic per-recipient guard: prevents simultaneous or repeated accidental sends.
CREATE TABLE IF NOT EXISTS outreach_send_guards (
  recipient TEXT PRIMARY KEY,
  locked_at TEXT NOT NULL
);

-- Source registry supports a modular scheduled discovery runner without locking
-- the product to one feed or permitting scraping of logged-in/social content.
CREATE TABLE IF NOT EXISTS sales_discovery_sources (
  source_key TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  label TEXT NOT NULL,
  configuration_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO sales_discovery_sources (source_key, source_type, label, configuration_json, enabled, priority, created_at, updated_at) VALUES
('google_news_sponsorship','rss','Sponsorship announcements','{"query":"Minnesota sports sponsorship OR brand partnership"}',1,20,datetime('now'),datetime('now')),
('sports_partnerships','public_web','Sports partnership announcements','{"query_terms":["Minnesota sports partnership","team sponsor","sports marketing partnership"]}',0,30,datetime('now'),datetime('now')),
('minnesota_expansion','public_web','Minnesota business expansion','{"query_terms":["Minnesota expansion","Twin Cities opening","Minnesota headquarters"]}',0,40,datetime('now'),datetime('now')),
('advertiser_relationships','crm','Existing advertiser relationships','{"requires_human_review":true}',0,10,datetime('now'),datetime('now')),
('agency_clients','public_web','Agency and represented-brand research','{"category":"agency","requires_source_url":true}',0,35,datetime('now'),datetime('now'));

CREATE TABLE IF NOT EXISTS sales_agent_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO sales_agent_settings (setting_key, value_json, updated_by, updated_at) VALUES
('weekly_targets','{"discovered":{"min":30,"max":50},"qualified":{"min":15,"max":25},"outreach_drafts":{"min":10,"max":20}}','system',datetime('now')),
('monthly_cost_limit_usd','50','system',datetime('now')),
('daily_review_target_minutes','15','system',datetime('now'));

CREATE TABLE IF NOT EXISTS sales_agent_runs (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  source_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','skipped')),
  discovered_count INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  draft_count INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  error_summary TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_agent_runs_recent ON sales_agent_runs(agent_key, started_at DESC);

CREATE TABLE IF NOT EXISTS sales_research_sources (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES sales_records(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'public_web',
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  fact_summary TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'unverified' CHECK (confidence IN ('unverified','low','medium','high')),
  captured_at TEXT NOT NULL,
  added_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_research_record ON sales_research_sources(record_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS sales_record_relationships (
  id TEXT PRIMARY KEY,
  from_record_id TEXT NOT NULL REFERENCES sales_records(id) ON DELETE CASCADE,
  to_record_id TEXT NOT NULL REFERENCES sales_records(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('represents','represented_by','subsidiary_of','partner_of')),
  evidence_source_id TEXT REFERENCES sales_research_sources(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(from_record_id, to_record_id, relationship_type),
  CHECK (from_record_id <> to_record_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_relationship_from ON sales_record_relationships(from_record_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_sales_relationship_to ON sales_record_relationships(to_record_id, relationship_type);
