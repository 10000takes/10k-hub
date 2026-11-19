PRAGMA foreign_keys = ON;

-- The normalized company layer is additive. sales_records remains intact and
-- continues to hold client/lead/prospect pipeline records, including leads as
-- opportunities. Each legacy record is mapped to a canonical company.
CREATE TABLE IF NOT EXISTS sales_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  website TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales_record_companies (
  record_id TEXT PRIMARY KEY REFERENCES sales_records(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES sales_companies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_record_companies_company ON sales_record_companies(company_id, record_id);

INSERT OR IGNORE INTO sales_companies (id,name,normalized_name,industry,created_at,updated_at)
SELECT 'legacy-company:' || lower(hex(randomblob(16))),
       MIN(trim(name)), lower(trim(name)), MIN(industry), datetime('now'), datetime('now')
FROM sales_records
WHERE trim(name) <> ''
GROUP BY lower(trim(name));
INSERT OR IGNORE INTO sales_record_companies (record_id,company_id,created_at)
SELECT r.id,c.id,datetime('now')
FROM sales_records r JOIN sales_companies c ON c.normalized_name=lower(trim(r.name));

CREATE TABLE IF NOT EXISTS sales_contacts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales_contact_emails (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES sales_contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  verification_source_url TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'unverified' CHECK (confidence IN ('unverified','low','medium','high')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_contact_emails_contact ON sales_contact_emails(contact_id,is_primary DESC);
CREATE TABLE IF NOT EXISTS sales_company_contacts (
  company_id TEXT NOT NULL REFERENCES sales_companies(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES sales_contacts(id) ON DELETE CASCADE,
  relationship_role TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(company_id,contact_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_company_contacts_contact ON sales_company_contacts(contact_id,company_id);

-- Backfill current primary and additional contacts; existing JSON and CRM
-- records remain untouched. Email-based IDs unify the same known person across
-- multiple records/companies, while contacts without email stay record-specific.
WITH candidates AS (
  SELECT c.id AS company_id,r.id AS record_id,
         trim(COALESCE(json_extract(r.data_json,'$.primary_contact'),'')) AS display_name,
         lower(trim(COALESCE(json_extract(r.data_json,'$.contact_email'),''))) AS email,
         1 AS is_primary,
         CASE WHEN trim(COALESCE(json_extract(r.data_json,'$.contact_email'),''))<>''
              THEN 'legacy:email:'||lower(trim(json_extract(r.data_json,'$.contact_email')))
              ELSE 'legacy:record:'||r.id||':primary' END AS contact_id
  FROM sales_records r JOIN sales_record_companies rc ON rc.record_id=r.id JOIN sales_companies c ON c.id=rc.company_id
  WHERE json_valid(r.data_json) AND trim(COALESCE(json_extract(r.data_json,'$.primary_contact'),''))<>''
  UNION ALL
  SELECT c.id,r.id,
         trim(COALESCE(json_extract(j.value,'$.name'),json_extract(j.value,'$.full_name'),'')),
         lower(trim(COALESCE(json_extract(j.value,'$.email'),''))),0,
         CASE WHEN trim(COALESCE(json_extract(j.value,'$.email'),''))<>''
              THEN 'legacy:email:'||lower(trim(json_extract(j.value,'$.email')))
              ELSE 'legacy:record:'||r.id||':additional:'||j.key END
  FROM sales_records r JOIN sales_record_companies rc ON rc.record_id=r.id JOIN sales_companies c ON c.id=rc.company_id,
       json_each(CASE WHEN json_valid(json_extract(r.data_json,'$.additional_contacts'))
                      THEN json_extract(r.data_json,'$.additional_contacts') ELSE '[]' END) j
  WHERE json_valid(r.data_json) AND j.type='object'
    AND trim(COALESCE(json_extract(j.value,'$.name'),json_extract(j.value,'$.full_name'),''))<>''
)
INSERT OR IGNORE INTO sales_contacts (id,display_name,created_at,updated_at)
SELECT contact_id,MIN(display_name),datetime('now'),datetime('now') FROM candidates GROUP BY contact_id;

WITH candidates AS (
  SELECT c.id AS company_id,r.id AS record_id,
         trim(COALESCE(json_extract(r.data_json,'$.primary_contact'),'')) AS display_name,
         lower(trim(COALESCE(json_extract(r.data_json,'$.contact_email'),''))) AS email,
         1 AS is_primary,
         CASE WHEN trim(COALESCE(json_extract(r.data_json,'$.contact_email'),''))<>''
              THEN 'legacy:email:'||lower(trim(json_extract(r.data_json,'$.contact_email')))
              ELSE 'legacy:record:'||r.id||':primary' END AS contact_id
  FROM sales_records r JOIN sales_record_companies rc ON rc.record_id=r.id JOIN sales_companies c ON c.id=rc.company_id
  WHERE json_valid(r.data_json) AND trim(COALESCE(json_extract(r.data_json,'$.primary_contact'),''))<>''
  UNION ALL
  SELECT c.id,r.id,
         trim(COALESCE(json_extract(j.value,'$.name'),json_extract(j.value,'$.full_name'),'')),
         lower(trim(COALESCE(json_extract(j.value,'$.email'),''))),0,
         CASE WHEN trim(COALESCE(json_extract(j.value,'$.email'),''))<>''
              THEN 'legacy:email:'||lower(trim(json_extract(j.value,'$.email')))
              ELSE 'legacy:record:'||r.id||':additional:'||j.key END
  FROM sales_records r JOIN sales_record_companies rc ON rc.record_id=r.id JOIN sales_companies c ON c.id=rc.company_id,
       json_each(CASE WHEN json_valid(json_extract(r.data_json,'$.additional_contacts'))
                      THEN json_extract(r.data_json,'$.additional_contacts') ELSE '[]' END) j
  WHERE json_valid(r.data_json) AND j.type='object'
    AND trim(COALESCE(json_extract(j.value,'$.name'),json_extract(j.value,'$.full_name'),''))<>''
)
INSERT OR IGNORE INTO sales_contact_emails (id,contact_id,email,normalized_email,is_primary,confidence,created_at)
SELECT 'legacy-email:'||lower(hex(randomblob(16))),contact_id,email,email,MAX(is_primary),'unverified',datetime('now')
FROM candidates WHERE instr(email,'@')>1 AND instr(substr(email,instr(email,'@')+1),'.')>1
GROUP BY contact_id,email;

WITH candidates AS (
  SELECT c.id AS company_id,r.id AS record_id,
         trim(COALESCE(json_extract(r.data_json,'$.primary_contact'),'')) AS display_name,
         lower(trim(COALESCE(json_extract(r.data_json,'$.contact_email'),''))) AS email,
         1 AS is_primary,
         CASE WHEN trim(COALESCE(json_extract(r.data_json,'$.contact_email'),''))<>''
              THEN 'legacy:email:'||lower(trim(json_extract(r.data_json,'$.contact_email')))
              ELSE 'legacy:record:'||r.id||':primary' END AS contact_id
  FROM sales_records r JOIN sales_record_companies rc ON rc.record_id=r.id JOIN sales_companies c ON c.id=rc.company_id
  WHERE json_valid(r.data_json) AND trim(COALESCE(json_extract(r.data_json,'$.primary_contact'),''))<>''
  UNION ALL
  SELECT c.id,r.id,
         trim(COALESCE(json_extract(j.value,'$.name'),json_extract(j.value,'$.full_name'),'')),
         lower(trim(COALESCE(json_extract(j.value,'$.email'),''))),0,
         CASE WHEN trim(COALESCE(json_extract(j.value,'$.email'),''))<>''
              THEN 'legacy:email:'||lower(trim(json_extract(j.value,'$.email')))
              ELSE 'legacy:record:'||r.id||':additional:'||j.key END
  FROM sales_records r JOIN sales_record_companies rc ON rc.record_id=r.id JOIN sales_companies c ON c.id=rc.company_id,
       json_each(CASE WHEN json_valid(json_extract(r.data_json,'$.additional_contacts'))
                      THEN json_extract(r.data_json,'$.additional_contacts') ELSE '[]' END) j
  WHERE json_valid(r.data_json) AND j.type='object'
    AND trim(COALESCE(json_extract(j.value,'$.name'),json_extract(j.value,'$.full_name'),''))<>''
)
INSERT OR IGNORE INTO sales_company_contacts (company_id,contact_id,relationship_role,is_primary,created_at)
SELECT company_id,contact_id,'',is_primary,datetime('now') FROM candidates;

CREATE TABLE IF NOT EXISTS sales_company_research_notes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES sales_companies(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'unverified' CHECK (confidence IN ('unverified','low','medium','high')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_company_research_notes ON sales_company_research_notes(company_id,created_at DESC);

CREATE TABLE IF NOT EXISTS sales_communications (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('gmail')),
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  gmail_draft_id TEXT NOT NULL DEFAULT '',
  company_id TEXT REFERENCES sales_companies(id) ON DELETE SET NULL,
  record_id TEXT REFERENCES sales_records(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES sales_contacts(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('sent','received','draft')),
  from_email TEXT NOT NULL DEFAULT '',
  to_emails_json TEXT NOT NULL DEFAULT '[]',
  cc_emails_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  body_ciphertext TEXT NOT NULL DEFAULT '',
  body_nonce TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  UNIQUE(provider,gmail_message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_communications_draft ON sales_communications(provider,gmail_draft_id) WHERE gmail_draft_id<>'';
CREATE INDEX IF NOT EXISTS idx_sales_communications_company_time ON sales_communications(company_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_communications_record_time ON sales_communications(record_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_communications_contact_time ON sales_communications(contact_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_communications_thread ON sales_communications(gmail_thread_id,occurred_at);

CREATE TABLE IF NOT EXISTS sales_gmail_sync_state (
  mailbox_email TEXT PRIMARY KEY,
  history_id TEXT NOT NULL DEFAULT '',
  last_success_at TEXT,
  last_attempt_at TEXT,
  status TEXT NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected','connected','syncing','error')),
  error_summary TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_follow_up_tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES sales_companies(id) ON DELETE CASCADE,
  record_id TEXT REFERENCES sales_records(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES sales_contacts(id) ON DELETE SET NULL,
  source_communication_id TEXT REFERENCES sales_communications(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL DEFAULT 'follow_up',
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  assigned_to TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  generated_by TEXT NOT NULL DEFAULT 'manual' CHECK (generated_by IN ('manual','gmail_sync')),
  dedupe_key TEXT UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_follow_up_tasks_status_due ON sales_follow_up_tasks(status,due_at);
CREATE INDEX IF NOT EXISTS idx_sales_follow_up_tasks_company ON sales_follow_up_tasks(company_id,status,due_at);
CREATE INDEX IF NOT EXISTS idx_sales_follow_up_tasks_record ON sales_follow_up_tasks(record_id,status,due_at);

-- ChatGPT/API integration credentials are high-entropy bearer-token hashes;
-- raw keys are never kept in D1. No key is created by this migration.
CREATE TABLE IF NOT EXISTS sales_crm_api_credentials (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
  created_by TEXT NOT NULL REFERENCES sales_users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sales_crm_rate_limits (
  principal_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (principal_id, window_start)
);

CREATE TABLE IF NOT EXISTS sales_crm_idempotency (
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  route_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing','complete')),
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sales_crm_idempotency_expiry ON sales_crm_idempotency(expires_at);
