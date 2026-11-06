PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS revenue_entries (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES sales_records(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month GLOB '????-??'),
  amount REAL NOT NULL CHECK (amount >= 0),
  entry_type TEXT NOT NULL DEFAULT 'received' CHECK (entry_type IN ('received','contracted','adjustment')),
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revenue_entries_month ON revenue_entries(month, client_id);

CREATE TABLE IF NOT EXISTS deliverable_definitions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES sales_records(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  monthly_commitment INTEGER NOT NULL DEFAULT 1 CHECK (monthly_commitment >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(client_id, name)
);
CREATE INDEX IF NOT EXISTS idx_deliverable_definitions_client ON deliverable_definitions(client_id, active);

CREATE TABLE IF NOT EXISTS deliverable_monthly (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES deliverable_definitions(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month GLOB '????-??'),
  completed_units INTEGER NOT NULL DEFAULT 0 CHECK (completed_units >= 0),
  completed_at TEXT,
  published_url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(definition_id, month)
);
CREATE INDEX IF NOT EXISTS idx_deliverable_monthly_month ON deliverable_monthly(month, definition_id);

CREATE TABLE IF NOT EXISTS outreach_log (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES sales_records(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_log_sent ON outreach_log(sent_at DESC);
