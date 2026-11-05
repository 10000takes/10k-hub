PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sales_records (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('client', 'lead', 'prospect')),
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  monthly_revenue REAL NOT NULL DEFAULT 0,
  total_value REAL NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  next_follow_up TEXT,
  contract_end TEXT,
  last_contact TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_records_type_stage ON sales_records(entity_type, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_records_follow_up ON sales_records(next_follow_up);
CREATE INDEX IF NOT EXISTS idx_sales_records_contract_end ON sales_records(contract_end);

CREATE TABLE IF NOT EXISTS sales_activities (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES sales_records(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_activities_record ON sales_activities(record_id, occurred_at DESC);
