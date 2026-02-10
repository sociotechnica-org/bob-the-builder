PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  config_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner, name)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  goal TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  current_station TEXT CHECK (
    current_station IS NULL OR
    current_station IN ('intake', 'plan', 'implement', 'verify', 'create_pr')
  ),
  requestor TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  work_branch TEXT,
  pr_mode TEXT NOT NULL CHECK (pr_mode IN ('draft', 'ready')),
  pr_url TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  failure_reason TEXT,
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS station_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  station TEXT NOT NULL CHECK (station IN ('intake', 'plan', 'implement', 'verify', 'create_pr')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  summary TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('inline', 'r2')),
  payload TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_created_at ON runs(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_created_at ON runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_station_executions_run_station ON station_executions(run_id, station);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_created_at ON artifacts(run_id, created_at DESC);
