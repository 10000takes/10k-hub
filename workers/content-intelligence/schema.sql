PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS content_items (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  format TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  hashtags_json TEXT NOT NULL DEFAULT '[]',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE (platform, url)
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  UNIQUE (content_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_content_date
  ON metric_snapshots(content_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_content_platform_format
  ON content_items(platform, format, posted_at DESC);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  snapshot_as_of TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'insufficient_history', 'failed')),
  posts_analyzed INTEGER NOT NULL DEFAULT 0,
  recommendations_created INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  platform TEXT NOT NULL,
  format TEXT NOT NULL,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  evidence_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recommendations_created
  ON recommendations(created_at DESC);
