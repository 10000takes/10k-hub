PRAGMA foreign_keys = ON;

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
CREATE INDEX IF NOT EXISTS idx_clip_transcript_job_start ON clip_transcript_segments(job_id, start_ms);

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
CREATE INDEX IF NOT EXISTS idx_clip_candidates_job_rank ON clip_candidates(job_id, rank);

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
