-- PainCave D1 SQLite Initial Schema (Migration 0001)
-- Compatible with Cloudflare D1 (SQLite)

PRAGMA foreign_keys = ON;

-- 1. Single-user athlete profile
CREATE TABLE IF NOT EXISTS athlete_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT 'Athlete',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  units TEXT NOT NULL DEFAULT 'metric' CHECK (units IN ('metric', 'imperial')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT OR IGNORE INTO athlete_profile (id, display_name, timezone, units)
VALUES (1, 'Athlete', 'UTC', 'metric');

-- 2. Dated athlete threshold history (never retroactively corrupts past TSS/IF/CTL)
CREATE TABLE IF NOT EXISTS athlete_thresholds (
  id TEXT PRIMARY KEY,
  effective_from TEXT NOT NULL, -- YYYY-MM-DD
  ftp_watts INTEGER NOT NULL CHECK (ftp_watts BETWEEN 50 AND 600),
  lthr_bpm INTEGER CHECK (lthr_bpm BETWEEN 100 AND 230),
  hrmax_bpm INTEGER CHECK (hrmax_bpm BETWEEN 120 AND 240),
  hrrest_bpm INTEGER CHECK (hrrest_bpm BETWEEN 25 AND 120),
  cp_watts INTEGER CHECK (cp_watts BETWEEN 50 AND 600),
  w_prime_j INTEGER CHECK (w_prime_j BETWEEN 2000 AND 60000),
  weight_kg REAL CHECK (weight_kg BETWEEN 35.0 AND 200.0),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_athlete_thresholds_effective
  ON athlete_thresholds (effective_from DESC, created_at DESC);

-- 3. Macro/mesocycle training blocks & weekly schedule constraints
CREATE TABLE IF NOT EXISTS training_blocks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal_event TEXT,
  target_date TEXT, -- YYYY-MM-DD
  phase TEXT NOT NULL CHECK (phase IN ('base', 'build', 'peak', 'taper', 'recovery')),
  start_date TEXT NOT NULL, -- YYYY-MM-DD
  end_date TEXT, -- YYYY-MM-DD
  weekly_hours_target REAL NOT NULL CHECK (weekly_hours_target > 0 AND weekly_hours_target <= 35),
  constraints_json TEXT NOT NULL DEFAULT '{}', -- e.g. {"tue_max_min":60,"mon":"rest"}
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_training_blocks_active
  ON training_blocks (active, start_date DESC);

-- 4. Durable LLM coaching memory across sessions
CREATE TABLE IF NOT EXISTS coaching_notes (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('injury', 'preference', 'response', 'equipment', 'schedule', 'general')),
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_coaching_notes_active
  ON coaching_notes (active, category, created_at DESC);

-- 5. Canonical workout library (Zod-validated JSON + deterministic load predictions)
CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'custom',
  spec_json TEXT NOT NULL,
  duration_s INTEGER NOT NULL CHECK (duration_s > 0),
  predicted_np INTEGER,
  predicted_if REAL,
  predicted_tss REAL,
  zone_distribution_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'llm', 'import')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workouts_category
  ON workouts (archived, category, updated_at DESC);

-- 6. Completed rides (idempotent by ride_uuid)
CREATE TABLE IF NOT EXISTS rides (
  ride_uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('indoor_bridge', 'manual_fit', 'external_sync')),
  workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL, -- ISO-8601 UTC
  ride_day TEXT NOT NULL,   -- YYYY-MM-DD in athlete timezone
  r2_fit_key TEXT NOT NULL,
  fit_bytes INTEGER NOT NULL DEFAULT 0,

  -- Core physiological metrics
  duration_s INTEGER NOT NULL CHECK (duration_s >= 0),
  elapsed_s INTEGER NOT NULL CHECK (elapsed_s >= 0),
  work_kj REAL NOT NULL DEFAULT 0,
  avg_power INTEGER,
  np_watts INTEGER,
  intensity_factor REAL,
  tss REAL NOT NULL DEFAULT 0,
  variability_index REAL,
  avg_hr INTEGER,
  max_hr INTEGER,
  efficiency_factor REAL,
  pw_hr_decoupling REAL,
  hrr_60s INTEGER,
  time_gt_90_hrmax_s INTEGER NOT NULL DEFAULT 0,
  avg_cadence INTEGER,
  compliance_pct REAL,

  -- Distributions & quality flags
  power_zones_json TEXT NOT NULL DEFAULT '{}',
  hr_zones_json TEXT NOT NULL DEFAULT '{}',
  quality_flags_json TEXT NOT NULL DEFAULT '{}',

  -- Threshold snapshots active on ride_day
  ftp_snapshot INTEGER NOT NULL,
  lthr_snapshot INTEGER,
  hrmax_snapshot INTEGER,
  weight_kg_snapshot REAL,

  -- Post-ride subjective context
  rpe INTEGER CHECK (rpe IS NULL OR rpe BETWEEN 1 AND 10),
  feel INTEGER CHECK (feel IS NULL OR feel BETWEEN 1 AND 5),
  notes TEXT NOT NULL DEFAULT '',

  -- Outbound Strava status
  strava_upload_status TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (strava_upload_status IN ('not_connected', 'pending', 'uploaded', 'failed', 'skipped')),
  strava_upload_id TEXT,
  strava_activity_id TEXT,
  strava_error TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_rides_day ON rides (ride_day DESC, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_rides_started_at ON rides (started_at DESC);

-- 7. Calendar planned sessions
CREATE TABLE IF NOT EXISTS planned_sessions (
  id TEXT PRIMARY KEY,
  scheduled_date TEXT NOT NULL, -- YYYY-MM-DD
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'completed', 'skipped')),
  coach_rationale TEXT NOT NULL DEFAULT '',
  completed_ride_uuid TEXT REFERENCES rides(ride_uuid) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_planned_sessions_date
  ON planned_sessions (scheduled_date ASC, status);

-- 8. Per-interval execution & compliance rows
CREATE TABLE IF NOT EXISTS ride_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_uuid TEXT NOT NULL REFERENCES rides(ride_uuid) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('erg', 'slope', 'resistance')),
  is_work_interval INTEGER NOT NULL DEFAULT 0 CHECK (is_work_interval IN (0, 1)),
  planned_duration_s INTEGER NOT NULL,
  actual_duration_s INTEGER NOT NULL,
  target_watts INTEGER,
  actual_avg_watts INTEGER,
  pct_of_target REAL,
  avg_hr INTEGER,
  max_hr INTEGER,
  hr_drift_bpm INTEGER,
  avg_cadence INTEGER,
  erg_bias_pct INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'skipped')),
  UNIQUE (ride_uuid, step_index)
);

CREATE INDEX IF NOT EXISTS idx_ride_intervals_ride ON ride_intervals (ride_uuid, step_index);

-- 9. Mean Maximal Power (MMP) peak curve points per ride
CREATE TABLE IF NOT EXISTS ride_peaks (
  ride_uuid TEXT NOT NULL REFERENCES rides(ride_uuid) ON DELETE CASCADE,
  duration_s INTEGER NOT NULL CHECK (duration_s IN (5, 15, 30, 60, 120, 300, 480, 720, 1200, 1800, 3600)),
  watts INTEGER NOT NULL CHECK (watts >= 0),
  w_per_kg REAL,
  PRIMARY KEY (ride_uuid, duration_s)
);

CREATE INDEX IF NOT EXISTS idx_ride_peaks_duration ON ride_peaks (duration_s, watts DESC);

-- 10. Daily Performance Management Chart (PMC) rollup
CREATE TABLE IF NOT EXISTS daily_pmc (
  day TEXT PRIMARY KEY, -- YYYY-MM-DD
  total_tss REAL NOT NULL DEFAULT 0,
  ctl REAL NOT NULL DEFAULT 0,
  atl REAL NOT NULL DEFAULT 0,
  tsb REAL NOT NULL DEFAULT 0,
  ramp_rate_7d REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 11. External OAuth tokens (e.g., Strava)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL, -- Unix epoch seconds
  scope TEXT NOT NULL DEFAULT '',
  athlete_external_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 12. Web UI sessions (stores SHA-256 token hashes only, never raw tokens)
CREATE TABLE IF NOT EXISTS ui_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL, -- Unix epoch seconds
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ui_sessions_expires ON ui_sessions (expires_at);
