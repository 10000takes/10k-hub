PRAGMA foreign_keys = ON;

-- OAuth credentials are restricted to one intended mailbox. Only the encrypted
-- refresh token is retained; access tokens are exchanged and held in memory.
CREATE TABLE IF NOT EXISTS sales_gmail_oauth_credentials (
  mailbox_email TEXT PRIMARY KEY CHECK (lower(mailbox_email)='partnerships@10ktakesmn.com'),
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_nonce TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  connected_by TEXT NOT NULL REFERENCES sales_users(id),
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','revoked')),
  error_summary TEXT NOT NULL DEFAULT ''
);

-- OAuth state is single-use and short-lived. The PKCE verifier is encrypted.
CREATE TABLE IF NOT EXISTS sales_gmail_oauth_states (
  state_sha256 TEXT PRIMARY KEY,
  pkce_verifier_ciphertext TEXT NOT NULL,
  pkce_verifier_nonce TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES sales_users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_gmail_oauth_states_expiry ON sales_gmail_oauth_states(expires_at);

ALTER TABLE sales_gmail_sync_state ADD COLUMN initial_page_token TEXT NOT NULL DEFAULT '';
ALTER TABLE sales_gmail_sync_state ADD COLUMN initial_sync_complete INTEGER NOT NULL DEFAULT 0 CHECK (initial_sync_complete IN (0,1));
ALTER TABLE sales_gmail_sync_state ADD COLUMN initial_sync_started_at TEXT;
ALTER TABLE sales_gmail_sync_state ADD COLUMN history_page_token TEXT NOT NULL DEFAULT '';
ALTER TABLE sales_gmail_sync_state ADD COLUMN last_sync_counts_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE sales_communications ADD COLUMN gmail_label_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sales_communications ADD COLUMN deleted_at TEXT;

-- Queue provides a durable handoff between Gmail history paging and bounded
-- message metadata reads, so a retry never loses a history checkpoint.
CREATE TABLE IF NOT EXISTS sales_gmail_sync_queue (
  mailbox_email TEXT NOT NULL REFERENCES sales_gmail_sync_state(mailbox_email) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(mailbox_email,gmail_message_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_gmail_sync_queue_mailbox ON sales_gmail_sync_queue(mailbox_email,created_at);

-- Message bodies/snippets are intentionally not stored for metadata-only sync.
UPDATE sales_communications SET snippet='',body_ciphertext='',body_nonce='' WHERE provider='gmail';
