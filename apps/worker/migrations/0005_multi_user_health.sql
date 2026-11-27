-- PainCave D1 SQLite Migration 0005: Multi-User Isolation & Unified Multi-Sport Health Schema
-- Safe to run over both fresh databases (0001-0004) and populated single-owner databases.

-- 1. Rebuild athlete_profile with user_id as primary key + sport/feature preferences
CREATE TABLE IF NOT EXISTS athlete_profile_v2 (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Athlete',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  units TEXT NOT NULL DEFAULT 'metric' CHECK (units IN ('metric', 'imperial')),
  primary_sports_json TEXT NOT NULL DEFAULT '["cycling"]',
  features_json TEXT NOT NULL DEFAULT '{"indoor_trainer":true}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT OR IGNORE INTO athlete_profile_v2 (
  user_id, display_name, timezone, units, primary_sports_json, features_json, created_at, updated_at
)
SELECT
  COALESCE((SELECT id FROM user ORDER BY createdAt ASC LIMIT 1), 'default_owner'),
  display_name,
  timezone,
  units,
  '["cycling"]',
  '{"indoor_trainer":true}',
  created_at,
  updated_at
FROM athlete_profile;

DROP TABLE athlete_profile;
ALTER TABLE athlete_profile_v2 RENAME TO athlete_profile;

-- 2. Rebuild athlete_thresholds with user_id, nullable ftp_watts (for runners), and threshold_pace_s_per_km
CREATE TABLE IF NOT EXISTS athlete_thresholds_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default_owner',
  effective_from TEXT NOT NULL,
  ftp_watts INTEGER CHECK (ftp_watts IS NULL OR ftp_watts BETWEEN 50 AND 600),
  threshold_pace_s_per_km REAL CHECK (threshold_pace_s_per_km IS NULL OR threshold_pace_s_per_km BETWEEN 120 AND 900),
  lthr_bpm INTEGER CHECK (lthr_bpm IS NULL OR lthr_bpm BETWEEN 100 AND 230),
  hrmax_bpm INTEGER CHECK (hrmax_bpm IS NULL OR hrmax_bpm BETWEEN 120 AND 240),
  hrrest_bpm INTEGER CHECK (hrrest_bpm IS NULL OR hrrest_bpm BETWEEN 25 AND 120),
  cp_watts INTEGER CHECK (cp_watts IS NULL OR cp_watts BETWEEN 50 AND 600),
  w_prime_j INTEGER CHECK (w_prime_j IS NULL OR w_prime_j BETWEEN 2000 AND 60000),
  weight_kg REAL CHECK (weight_kg IS NULL OR weight_kg BETWEEN 35.0 AND 200.0),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO athlete_thresholds_v2 (
  id, user_id, effective_from, ftp_watts, threshold_pace_s_per_km,
  lthr_bpm, hrmax_bpm, hrrest_bpm, cp_watts, w_prime_j, weight_kg, notes, created_at
)
SELECT
  id,
  COALESCE((SELECT id FROM user ORDER BY createdAt ASC LIMIT 1), 'default_owner'),
  effective_from,
  ftp_watts,
  NULL,
  lthr_bpm,
  hrmax_bpm,
  hrrest_bpm,
  cp_watts,
  w_prime_j,
  weight_kg,
  notes,
  created_at
FROM athlete_thresholds;

DROP TABLE athlete_thresholds;
ALTER TABLE athlete_thresholds_v2 RENAME TO athlete_thresholds;

CREATE INDEX IF NOT EXISTS idx_athlete_thresholds_user_effective
  ON athlete_thresholds (user_id, effective_from DESC, created_at DESC);

-- 3. Rebuild coaching_notes (LLM memory) with user_id, optional sport, and 'health' category
CREATE TABLE IF NOT EXISTS coaching_notes_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default_owner',
  category TEXT NOT NULL CHECK (category IN ('injury', 'preference', 'response', 'equipment', 'schedule', 'health', 'general')),
  sport TEXT CHECK (sport IS NULL OR sport IN ('cycling', 'running', 'strength', 'mobility', 'other')),
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO coaching_notes_v2 (id, user_id, category, sport, content, active, created_at, updated_at)
SELECT
  id,
  COALESCE((SELECT id FROM user ORDER BY createdAt ASC LIMIT 1), 'default_owner'),
  category,
  NULL,
  content,
  active,
  created_at,
  updated_at
FROM coaching_notes;

DROP TABLE coaching_notes;
ALTER TABLE coaching_notes_v2 RENAME TO coaching_notes;

CREATE INDEX IF NOT EXISTS idx_coaching_notes_user_active
  ON coaching_notes (user_id, active, category, created_at DESC);

-- 4. Rebuild daily_pmc with composite PRIMARY KEY (user_id, day)
CREATE TABLE IF NOT EXISTS daily_pmc_v2 (
  user_id TEXT NOT NULL DEFAULT 'default_owner',
  day TEXT NOT NULL,
  total_tss REAL NOT NULL DEFAULT 0,
  ctl REAL NOT NULL DEFAULT 0,
  atl REAL NOT NULL DEFAULT 0,
  tsb REAL NOT NULL DEFAULT 0,
  ramp_rate_7d REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, day)
);

INSERT INTO daily_pmc_v2 (user_id, day, total_tss, ctl, atl, tsb, ramp_rate_7d, updated_at)
SELECT
  COALESCE((SELECT id FROM user ORDER BY createdAt ASC LIMIT 1), 'default_owner'),
  day,
  total_tss,
  ctl,
  atl,
  tsb,
  ramp_rate_7d,
  updated_at
FROM daily_pmc;

DROP TABLE daily_pmc;
ALTER TABLE daily_pmc_v2 RENAME TO daily_pmc;

-- 5. Per-user external provider connections (Strava, Garmin Personal API)
CREATE TABLE IF NOT EXISTS provider_connections (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('strava', 'garmin_personal')),
  credentials_encrypted TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  scope TEXT NOT NULL DEFAULT '',
  external_athlete_id TEXT,
  last_sync_at TEXT,
  sync_cursor TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, provider)
);

INSERT OR IGNORE INTO provider_connections (
  user_id, provider, access_token, refresh_token, expires_at, scope, external_athlete_id, updated_at
)
SELECT
  COALESCE((SELECT id FROM user ORDER BY createdAt ASC LIMIT 1), 'default_owner'),
  provider,
  access_token,
  refresh_token,
  expires_at,
  scope,
  athlete_external_id,
  updated_at
FROM oauth_tokens
WHERE provider = 'strava';

-- 6. Extend existing FK-referenced tables cleanly via ALTER TABLE
ALTER TABLE training_blocks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_owner';
ALTER TABLE training_blocks ADD COLUMN sport TEXT;
UPDATE training_blocks
SET user_id = (SELECT id FROM user ORDER BY createdAt ASC LIMIT 1)
WHERE EXISTS (SELECT 1 FROM user) AND user_id = 'default_owner';
CREATE INDEX IF NOT EXISTS idx_training_blocks_user_active
  ON training_blocks (user_id, active, start_date DESC);

ALTER TABLE workouts ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_owner';
ALTER TABLE workouts ADD COLUMN sport TEXT NOT NULL DEFAULT 'cycling';
UPDATE workouts
SET user_id = (SELECT id FROM user ORDER BY createdAt ASC LIMIT 1)
WHERE EXISTS (SELECT 1 FROM user) AND user_id = 'default_owner';
CREATE INDEX IF NOT EXISTS idx_workouts_user_sport
  ON workouts (user_id, archived, sport, category, updated_at DESC);

ALTER TABLE rides ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_owner';
ALTER TABLE rides ADD COLUMN sport TEXT NOT NULL DEFAULT 'cycling';
ALTER TABLE rides ADD COLUMN sub_sport TEXT;
ALTER TABLE rides ADD COLUMN external_provider TEXT;
ALTER TABLE rides ADD COLUMN external_id TEXT;
ALTER TABLE rides ADD COLUMN distance_m REAL;
ALTER TABLE rides ADD COLUMN elevation_gain_m REAL;
ALTER TABLE rides ADD COLUMN elevation_loss_m REAL;
ALTER TABLE rides ADD COLUMN avg_pace_s_per_km REAL;
ALTER TABLE rides ADD COLUMN gap_s_per_km REAL;
ALTER TABLE rides ADD COLUMN pa_hr_decoupling REAL;
ALTER TABLE rides ADD COLUMN running_dynamics_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE rides ADD COLUMN threshold_pace_snapshot REAL;
UPDATE rides
SET user_id = (SELECT id FROM user ORDER BY createdAt ASC LIMIT 1)
WHERE EXISTS (SELECT 1 FROM user) AND user_id = 'default_owner';

CREATE INDEX IF NOT EXISTS idx_rides_user_day ON rides (user_id, ride_day DESC, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_rides_user_sport ON rides (user_id, sport, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rides_user_external_unique
  ON rides (user_id, external_provider, external_id)
  WHERE external_provider IS NOT NULL AND external_id IS NOT NULL;

ALTER TABLE planned_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_owner';
UPDATE planned_sessions
SET user_id = (SELECT id FROM user ORDER BY createdAt ASC LIMIT 1)
WHERE EXISTS (SELECT 1 FROM user) AND user_id = 'default_owner';
CREATE INDEX IF NOT EXISTS idx_planned_sessions_user_date
  ON planned_sessions (user_id, scheduled_date ASC, status);

ALTER TABLE routes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_owner';
UPDATE routes
SET user_id = (SELECT id FROM user ORDER BY createdAt ASC LIMIT 1)
WHERE EXISTS (SELECT 1 FROM user) AND user_id = 'default_owner';
CREATE INDEX IF NOT EXISTS idx_routes_user_created_at
  ON routes (user_id, created_at DESC);

ALTER TABLE mcp_oauth_codes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_owner';
ALTER TABLE mcp_oauth_tokens ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_owner';
ALTER TABLE oauth_states ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_owner';
UPDATE mcp_oauth_tokens
SET user_id = (SELECT id FROM user ORDER BY createdAt ASC LIMIT 1)
WHERE EXISTS (SELECT 1 FROM user) AND user_id = 'default_owner';
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user ON mcp_oauth_tokens (user_id, revoked, expires_at);

-- 7. Per-activity lap / km split table (auto-parsed from FIT laps or GPS splits)
CREATE TABLE IF NOT EXISTS activity_laps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'default_owner',
  ride_uuid TEXT NOT NULL REFERENCES rides(ride_uuid) ON DELETE CASCADE,
  lap_index INTEGER NOT NULL,
  duration_s INTEGER NOT NULL CHECK (duration_s >= 0),
  distance_m REAL,
  avg_pace_s_per_km REAL,
  gap_s_per_km REAL,
  avg_power INTEGER,
  avg_hr INTEGER,
  max_hr INTEGER,
  avg_cadence INTEGER,
  elevation_gain_m REAL,
  elevation_loss_m REAL,
  UNIQUE (ride_uuid, lap_index)
);

CREATE INDEX IF NOT EXISTS idx_activity_laps_user_ride
  ON activity_laps (user_id, ride_uuid, lap_index ASC);

-- 8. Daily health & readiness biometrics (auto-ingested from Garmin Personal API or archive)
CREATE TABLE IF NOT EXISTS daily_biometrics (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  hrv_rmssd_ms REAL,
  hrv_status TEXT,
  resting_hr_bpm INTEGER,
  sleep_duration_s INTEGER,
  sleep_deep_s INTEGER,
  sleep_rem_s INTEGER,
  sleep_light_s INTEGER,
  sleep_awake_s INTEGER,
  sleep_score INTEGER,
  body_battery_high INTEGER,
  body_battery_low INTEGER,
  body_battery_charged INTEGER,
  stress_avg INTEGER,
  steps INTEGER,
  spo2_avg REAL,
  weight_kg REAL,
  cycle_phase TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'garmin_personal',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_daily_biometrics_user_day
  ON daily_biometrics (user_id, day DESC);

-- 9. Per-user device, importer, and personal CLI tokens (SHA-256 hashes only)
CREATE TABLE IF NOT EXISTS user_device_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('bridge', 'importer', 'mcp')),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_device_tokens_user
  ON user_device_tokens (user_id, scope);
