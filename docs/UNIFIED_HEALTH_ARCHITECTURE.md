# Unified Multi-User Health & Training Hub — Architecture & Schema Spec (M8–M11)

This specification defines the evolution of PainCave from a single-user indoor cycling platform (`M0`–`M7`) into a **unified multi-user, multi-sport health & training hub** (`M8`–`M11`) running on one Cloudflare Free Tier stack (**$0/month**).

## 1. Core Design Principles

1. **Automatic Ingestion First (Zero Busywork):**
   - No manual activity entry forms or subjective check-in sliders.
   - Data ingests automatically via the official **Garmin Connect Personal API** (`personal.connectapi.garmin.com` — activities, raw `.fit` files, overnight HRV, sleep, resting HR, Body Battery, stress, weight), the existing local **Rust `trainer-bridge`** (indoor cycling KICKR + Polar H10), and a **one-time local bulk archive CLI** (for multi-year Strava/Garmin account export ZIPs).
2. **LLM-Managed Memory for Subjective & Health Context:**
   - Subjective context (niggles, soreness, travel, equipment, goals, debriefs) is captured naturally in LLM chat via MCP memory tools rather than manual UI forms.
3. **3-Layer Storage for Multi-Year LLM Reasoning (3,000+ Workouts):**
   - **Raw Vault (Cloudflare R2):** Immutable original `.fit` files keyed by `users/{user_id}/activities/{uuid}.fit`. Never store 1Hz timeseries rows in D1.
   - **Normalized Multi-Sport Warehouse (Cloudflare D1):** Compact summaries, lap/km splits, peak curves, daily biometrics, and PMC rollups scoped by `user_id`.
   - **High-Signal MCP Views (`/mcp`):** One compact briefing tool (`get_health_and_training_brief`) plus historical rollup & drill-down tools so LLMs see multi-year trends and baseline-relative HRV/readiness without blowing up context windows.
4. **Strict Multi-User Isolation with Allowlist Access:**
   - One Cloudflare Worker + one D1 database + one R2 bucket.
   - Better Auth + Google Sign-In gated by `ALLOWED_USER_EMAILS` (comma-separated allowlist; keeps single-owner lock when unset).
   - Every D1 table, R2 object prefix, MCP OAuth token, and device token is strictly bound to `user_id`.
5. **Sport-Aware UI:**
   - Users without an indoor trainer (e.g., runners) have `features.indoor_trainer = false`, hiding KICKR **Ride** and **Routes** navigation tabs cleanly while preserving calendar, analytics, workouts, readiness, and MCP settings.

---

## 2. System Data Flow

```text
[Automatic Sources]
  ├── Garmin Connect Personal API (Activities + .FIT + HRV/Sleep/RHR/Body Battery)
  │       └──► Hourly Cloudflare Worker Cron (24h JWT exchanged from per-user ApiKey)
  ├── Local Rust trainer-bridge (KICKR v5 + Polar H10)
  │       └──► HTTPS upload (per-user device token or legacy owner fallback)
  └── One-Time Bulk Archive CLI (Strava Export ZIP / Garmin Export ZIP)
          └──► Local .fit.gz/.fit parsing + idempotent batch upload

                     ▼
[Cloudflare Free Tier Stack ($0/mo)]
  ├── Better Auth (Google OAuth + ALLOWED_USER_EMAILS allowlist)
  ├── D1 SQLite (user_id isolated: rides/activities, activity_laps, daily_biometrics, daily_pmc, workouts, memory)
  ├── R2 Vault (users/{user_id}/activities/*.fit)
  ├── React PWA (Calendar, Analytics, Workouts, Settings; Trainer tabs opt-in per user)
  └── Stateless Remote MCP (/mcp, OAuth 2.1 per user_id)
          ├──► Claude / ChatGPT / Gemini (briefings, history, memory, bike/run/strength workout creation)
          └──► Outbound Workout Delivery (Garmin .FIT Workout download + optional wireless push)
```

### Cloudflare Free Tier Capacity (2 Users + 3,000 Historical Workouts)

| Resource | Backfill + Annual Growth | Free Tier Limit | Estimated Runway |
|---|---|---|---|
| **R2 Storage (`.fit`)** | ~450 MB backfill + ~100 MB/yr | **10 GB** ($0 egress) | ~95 years |
| **D1 Storage (SQLite)** | ~25 MB backfill + ~5 MB/yr | **5 GB** | ~990 years |
| **D1 Daily Writes** | ~50k backfill, <500/day steady | **100,000 / day** | <0.5% steady |
| **Worker Requests** | ~200–1,000 / day | **100,000 / day** | <1% |

---

## 3. Multi-User Security & Auth Invariants

1. **Allowlist Registration (`apps/worker/src/lib/better-auth.ts`):**
   - Support `ALLOWED_USER_EMAILS` (with `ALLOWED_OWNER_EMAIL` preserved as an alias).
   - When the allowlist is non-empty: allow account creation **only** if `email.toLowerCase()` is in the allowlist (rejecting all other signups with `403 FORBIDDEN`).
   - When the allowlist is empty: retain the strict max-1-user lock (`COUNT(*) >= 1` → `403`).
2. **Central `userId` Resolution (`HonoAppContext["Variables"]["userId"]`):**
   - Web UI Better Auth session → `session.user.id`.
   - MCP OAuth 2.1 Bearer token → `mcp_oauth_tokens.user_id` (bound at `/oauth/authorize` approval time).
   - Per-user device / importer / CLI token → `user_device_tokens.user_id` (SHA-256 hash lookup).
   - Legacy `BRIDGE_DEVICE_TOKEN` and `MCP_BEARER_TOKEN` → resolved to the primary owner `user.id` (first user created) so existing basement hardware and CLI configs continue working without interruption.
3. **Mandatory Query Scoping:**
   - Every service function requires `userId: string` explicitly; every SQL query filters `WHERE user_id = ?`.
   - Cross-user regression tests assert HTTP `404` / empty results when User B requests any resource UUID belonging to User A across REST APIs, R2 downloads, and MCP tools.

---

## 4. D1 Schema Evolution (`apps/worker/migrations/0005_multi_user_health.sql`)

### 4.1 Rebuilt & Extended Existing Tables
- **`athlete_profile` (rebuilt, `PRIMARY KEY (user_id)`):**
  - `user_id`, `display_name`, `timezone`, `units`, `primary_sports_json` (`["cycling"]` / `["running","strength"]`), `features_json` (`{"indoor_trainer":true}`), `created_at`, `updated_at`.
- **`athlete_thresholds`:**
  - Add `user_id TEXT NOT NULL`, `threshold_pace_s_per_km REAL` (running threshold pace), make `ftp_watts` nullable.
  - Index `(user_id, effective_from DESC, created_at DESC)`.
- **`daily_pmc` (rebuilt, `PRIMARY KEY (user_id, day)`):**
  - Independent systemic CTL / ATL / TSB / 7d ramp per user across all endurance sports.
- **`provider_connections` (`PRIMARY KEY (user_id, provider)`):**
  - Replaces single-tenant `oauth_tokens` (migrating existing Strava row to primary owner).
  - `provider IN ('strava', 'garmin_personal', 'intervals_icu')`.
  - Columns: `credentials_encrypted TEXT` (AES-GCM using key derived from `SESSION_SIGNING_SECRET`), `access_token`, `refresh_token`, `expires_at`, `scope`, `external_athlete_id`, `last_sync_at`, `sync_cursor`, `last_error`, `updated_at`.
- **`rides` (expanded to unified multi-sport activities; physical name preserved for compatibility):**
  - Add `user_id TEXT NOT NULL`, `sport TEXT NOT NULL DEFAULT 'cycling' CHECK (sport IN ('cycling', 'running', 'strength', 'mobility', 'other'))`, `sub_sport TEXT`, `external_provider TEXT`, `external_id TEXT`, `distance_m REAL`, `elevation_gain_m REAL`, `elevation_loss_m REAL`, `avg_pace_s_per_km REAL`, `gap_s_per_km REAL`, `pa_hr_decoupling REAL`, `running_dynamics_json TEXT NOT NULL DEFAULT '{}'`, `threshold_pace_snapshot REAL`, make `ftp_snapshot` nullable.
  - Unique idempotency index: `UNIQUE (user_id, external_provider, external_id)` (partial index `WHERE external_id IS NOT NULL`).
  - Query index: `(user_id, ride_day DESC, started_at DESC)` and `(user_id, sport, started_at DESC)`.
- **`workouts`:**
  - Add `user_id TEXT NOT NULL`, `sport TEXT NOT NULL DEFAULT 'cycling' CHECK (sport IN ('cycling', 'running', 'strength', 'mobility'))`.
- **`planned_sessions`, `training_blocks`, `coaching_notes`, `routes`, `mcp_oauth_codes`, `mcp_oauth_tokens`, `oauth_states`:**
  - Add `user_id TEXT NOT NULL` + user-prefixed indexes.
  - On `coaching_notes` (LLM memory): add nullable `sport TEXT` and widen `category` to include `'health'`.

### 4.2 New Tables
- **`activity_laps`:** `(id, user_id, ride_uuid, lap_index, duration_s, distance_m, avg_pace_s_per_km, gap_s_per_km, avg_power, avg_hr, max_hr, avg_cadence, elevation_gain_m, elevation_loss_m)` with `UNIQUE (ride_uuid, lap_index)`.
- **`daily_biometrics`:** `PRIMARY KEY (user_id, day)` holding `hrv_rmssd_ms`, `hrv_status`, `resting_hr_bpm`, `sleep_duration_s`, `sleep_deep_s`, `sleep_rem_s`, `sleep_light_s`, `sleep_awake_s`, `sleep_score`, `body_battery_high`, `body_battery_low`, `body_battery_charged`, `stress_avg`, `steps`, `spo2_avg`, `weight_kg`, `cycle_phase`, `raw_json`, `source`, `updated_at`.
- **`user_device_tokens`:** `(token_hash PRIMARY KEY, user_id, label, scope IN ('bridge', 'importer', 'mcp'), last_used_at, created_at)`.

---

## 5. Multi-Sport Physiology & FIT Engine (`packages/shared`)

- Extend `packages/shared/src/fit/reader.ts`:
  - Decode `session` (msg 18) `sport` (field 5), `sub_sport` (field 6), `total_distance` (field 9), `total_ascent` (field 22), `total_descent` (field 23).
  - Decode `lap` (msg 19) boundaries (`start_time`, `total_elapsed_time`, `total_timer_time`, `total_distance`, `avg_speed`, `avg_power`, `avg_heart_rate`, `max_heart_rate`, `avg_cadence`, `total_ascent`, `total_descent`).
  - Auto-generate 1 km splits when a GPS run `.fit` contains no manual laps.
- Add `packages/shared/src/physiology/running.ts`:
  - **Grade Adjusted Pace (GAP):** Minetti/Strava-style grade cost curve applied to smoothed elevation gradient + GPS speed.
  - **Pace:HR Aerobic Decoupling (`Pa:HR`):** Compares first-half vs. second-half `(GAP_speed / HR)` ratio for steady aerobic runs >= 30 min.
  - **Running Load (`rTSS` / `hrTSS`):** NGP/GAP relative to `threshold_pace_s_per_km`, cleanly falling back to TRIMP/`hrTSS` when pace or threshold pace is absent.
  - **Running Best Efforts:** Fastest sliding-window efforts across standard distances (`400m`, `1000m`, `5000m`, `10000m`).

---

## 6. Garmin Connect Personal API & Bulk Archive Ingestion

### Garmin Connect Personal API (`apps/worker/src/lib/garmin-client.ts`)
- **Auth:** `POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token` with `Authorization: ApiKey <user-key>` → caches returned 24-hour Bearer JWT in `provider_connections`.
- **Rate-Limit Hygiene:**
  - Chunk activity/wellness queries to `<= 7` day windows per request.
  - Respect HTTP `429` cleanly (stop current sync pass, store `last_error`, retry on next Cron tick — never spin-loop).
- **Scheduled Cron (`export default { fetch, scheduled }`):**
  - Runs hourly (`"0 * * * *"`), syncing activities (downloading raw `.fit` to R2 and parsing splits/metrics) and last 3 days of daily biometrics (HRV, sleep, resting HR, Body Battery, stress, steps, weight) for every connected user.

### Bulk Archive Importer (`scripts/import-archive.ts`)
- Runs locally on the user's workstation against an unzipped **Strava Account Export** (`activities.csv` + `activities/*.fit.gz`/`.gpx.gz`/`.tcx.gz`) or **Garmin Account Export** (`.fit` + wellness JSONs).
- Parses files in streaming batches, uploads raw `.fit` + precomputed summaries via `POST /api/import/batch` authenticated with an `importer` token from `user_device_tokens`, skips duplicates via `(user_id, external_provider, external_id)`, and triggers a single multi-year `daily_pmc` rebuild upon completion.

---

## 7. Multi-Sport Workouts, Watch Export & LLM MCP Suite

### Workout Specs (`packages/shared/src/workout/`)
- **`cycling`:** Existing `WorkoutSpecSchema` (`schema_version: 1`) unchanged for `trainer-bridge` compatibility.
- **`running`:** `RunWorkoutSpecSchema` — steps with `duration_s` OR `distance_m` and targets (`pace_zone`, `pace_range_s_per_km`, `hr_zone`, or `open`), plus guardrails (weekly mileage jump warning >15%, back-to-back quality day warning).
- **`strength`:** `StrengthWorkoutSpecSchema` — exercise blocks (`name`, `movement_pattern`, `sets`, `reps`, `target_rpe_or_rir`, `rest_s`, `notes`), plus interference warning when heavy lower-body work lands within 24h of a scheduled high-intensity run/bike session.

### Outbound Garmin Workout Delivery
- **Built-in `.FIT` Workout Encoder (`packages/shared/src/fit/workout-encoder.ts`):** Encodes running, cycling, and strength specs into valid binary Garmin `.fit` Workout files (`file_type = 5`, `workout` msg 26, `workout_step` msg 27) with 1-click download from any workout card.
- **Optional Wireless Push (`intervals_icu`):** If a user connects an optional Intervals.icu API key in Settings, scheduled running/cycling workouts can push wirelessly to their Garmin watch calendar.

### Remote MCP Tool Upgrades (`apps/worker/src/mcp/`)
- **`get_health_and_training_brief(days=14)`:** Single compact payload with profile, active goals/blocks, active LLM memory notes, **baseline-relative readiness** (7d HRV/RHR/sleep vs. 30d/60d personal baseline), multi-sport load (CTL/ATL/TSB + running weekly volume/ACWR), recent 14d activity summaries, and next 7d planned sessions.
- **`get_training_history_summary(years=3, sport?)`:** Yearly/monthly rollups + seasonal bests so 3,000+ historical sessions fit cleanly in LLM context.
- **`list_activities`, `get_activity_detail(include_laps=true)`, `get_biometrics_history(days=60)`:** Scoped drill-down queries.
- **`create_workout`, `update_workout`, `schedule_workout`:** Support `cycling`, `running`, and `strength` with sport-specific guardrails.
- **`save_memory_note`, `update_memory_note`, `archive_memory_note`:** LLM-managed subjective/injury/preference memory without manual forms.

---

## 8. Verified Task DAG & Nested Feedback Loops (`M8`–`M11`)

All 12 implementation tasks (`M8-01` through `M11-04`) are registered in `automation/tasks.json` following the 4-loop methodology in `automation/LOOP_ARCHITECTURE.md`:

- **Loop 1 (Per-Task Inner Gate):** Every task transition to `done` via `node scripts/update-task.mjs <ID> done` enforces its `verify_cmd` (targeted Vitest + TypeScript + ESLint + Rust checks).
- **Loop 2 (Multi-User Vertical E2E Loop — `M11-04`):** Extends `scripts/sim-e2e.sh` to simulate two isolated users simultaneously (User A cycling via mock `trainer-bridge`; User B running via mocked Garmin Personal API + HRV + LLM run/strength workout creation + `.FIT` workout export) verifying zero cross-user leakage.
- **Loop 3 (Outer Autonomous Task Loop):** `scripts/autonomous-loop.sh` / `scripts/next-task.mjs` executes `M8-01 → M11-04` sequentially in DAG order with circuit-breaker retries (`MAX_CONSECUTIVE_FAILURES = 3`) and strict secret/PII hygiene (`./scripts/verify.sh --strict`).
