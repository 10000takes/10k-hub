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

-- AI Clip Strategist. Raw video is stored in private object storage; D1 stores
-- metadata and editorial output only.
CREATE TABLE IF NOT EXISTS clip_jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'queued', 'processing', 'completed', 'failed', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT,
  error_message TEXT,
  analysis_note TEXT
);

CREATE TABLE IF NOT EXISTS clip_transcript_segments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES clip_jobs(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker_label TEXT,
  text TEXT NOT NULL,
  confidence REAL,
  evidence_source TEXT NOT NULL DEFAULT 'speech_to_text'
);

CREATE INDEX IF NOT EXISTS idx_clip_transcript_job_start
  ON clip_transcript_segments(job_id, start_ms);

CREATE TABLE IF NOT EXISTS clip_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES clip_jobs(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  hook TEXT NOT NULL,
  rationale TEXT NOT NULL,
  editorial_score INTEGER NOT NULL CHECK (editorial_score BETWEEN 0 AND 100),
  evidence_json TEXT NOT NULL,
  edit_plan_json TEXT NOT NULL,
  platform_adaptations_json TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  model_provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, rank)
);

CREATE TABLE IF NOT EXISTS clip_publications (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  published_url TEXT,
  published_at TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  captured_at TEXT,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_clip_candidates_job_rank
  ON clip_candidates(job_id, rank);
