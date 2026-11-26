# PainCave Remote MCP Server Specification

Endpoint: `POST /mcp` (Stateless Streamable HTTP via `@modelcontextprotocol/sdk`).

Authentication:
- CLI / Desktop clients (Antigravity, Claude Code, Cursor): `Authorization: Bearer <MCP_BEARER_TOKEN>` (validated with SHA-256 + `crypto.subtle.timingSafeEqual`).
- Web / Mobile clients (Claude Web, ChatGPT Connectors): OAuth 2.1 via `@cloudflare/workers-oauth-provider` (Phase M3/M7).

---

## 1. Read Tools (Coaching Context & Analysis)

### `get_athlete_context`
Returns complete baseline context in one call:
- Latest `athlete_thresholds` (FTP, LTHR, HRmax, CP, W', weight, effective date) + recent threshold history
- Active `training_blocks` (goal event, target date, phase, weekly hours budget, day-of-week constraints)
- Active `coaching_notes` (injuries, preferences, equipment, training response observations)

### `get_fitness_overview`
- Input: `{ days?: number (default 42, max 365) }`
- Returns:
  - Current `CTL`, `ATL`, `TSB`, `ramp_rate_7d`
  - Daily PMC series for the requested range
  - Weekly aggregates (hours, TSS, rides count, Z1–Z7 power distribution %)
  - Rolling 42-day and 90-day MMP power curves + estimated `eFTP`, `CP`, `W'`

### `list_recent_rides`
- Input: `{ days?: number (default 28), limit?: number (default 20, max 100), source?: "all" | "indoor_bridge" | "manual_fit" }`
- Returns compact ride summaries: `ride_uuid`, `started_at`, `name`, `source`, `duration_s`, `np_watts`, `if`, `tss`, `avg_hr`, `ef`, `pw_hr_decoupling`, `time_gt_90_hrmax_s`, `compliance_pct`, `rpe`, `feel`, `notes`, `quality_flags`.

### `get_ride_detail`
- Input: `{ ride_uuid: string }`
- Returns full ride metrics, zone distributions, peak power curve (`ride_peaks`), **per-interval execution breakdown (`ride_intervals`)**, and linked workout spec if applicable.

### `get_ride_timeseries` *(On-demand drill-down)*
- Input: `{ ride_uuid: string, bucket_seconds?: number (default 30, min 5, max 300) }`
- Reads `.fit` from R2 and returns downsampled `[{ t_s, watts, hr_bpm, cadence_rpm, target_watts }]` so the LLM can inspect a specific fade or anomaly without blowing context limits.

### `get_calendar`
- Input: `{ start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD" }`
- Returns all `planned_sessions` (with embedded workout summary & predicted TSS/IF) and completed `rides` in that date window, plus projected CTL/ATL/TSB if all planned sessions are completed.

### `list_workouts` / `get_workout`
- Lists saved library workouts (filtered by category or search query) or fetches full `WorkoutSpec` JSON + predicted load.

---

## 2. Write Tools (Workout Authoring, Planning & Memory)

Every write tool validates strict Zod schemas + physiological guardrails and returns deterministic computed metrics so the LLM can self-verify.

### `create_workout` & `update_workout`
- Input: `{ workout_id?: string, spec: WorkoutSpec, dry_run?: boolean }`
- **Physiological Guardrails (Hard Rejects):**
  - Total duration must be between `300s` (5 min) and `21600s` (6 hours).
  - Steady/ramp target `%FTP` must be within `[0.25, 2.50]`; sustained blocks > 120s cannot exceed `1.50` FTP; sustained blocks > 1200s cannot exceed `1.10` FTP.
  - Slope grades must be within `[-10.0, 20.0]` %.
  - Repeat counts must be `2..50` and non-nested.
- **Deterministic Response:**
  - Returns `{ workout_id, dry_run, predicted: { duration_s, np_watts, if, tss, zone_seconds }, warnings: string[] }` (e.g., warning if predicted TSS > 120 or IF > 1.02).

### `schedule_workout`
- Input: `{ scheduled_date: "YYYY-MM-DD", workout_id: string, coach_rationale?: string, replace_existing?: boolean }`
- Checks day-of-week constraints from active `training_blocks` and returns any soft warnings (e.g., *"Scheduled 90m workout on Tuesday, which has a 60m constraint"*), plus projected `TSB` and `ramp_rate_7d` impact!

### `move_or_cancel_session`
- Input: `{ session_id: string, action: "move" | "skip" | "delete", new_date?: "YYYY-MM-DD", reason?: string }`

### `upsert_training_block`
- Input: `{ id?: string, name: string, goal_event?: string, target_date?: "YYYY-MM-DD", phase: "base"|"build"|"peak"|"taper"|"recovery", weekly_hours_target: number, constraints_json: Record<string, unknown>, active: boolean }`

### `save_coaching_note` / `archive_coaching_note`
- Lets the LLM persist durable athlete insights (`injury`, `preference`, `response`, `equipment`, `schedule`) across chat sessions.

### `log_threshold_update`
- Input: `{ effective_from: "YYYY-MM-DD", ftp_watts: number, lthr_bpm?: number, hrmax_bpm?: number, weight_kg?: number, notes?: string }`
- Appends a new dated row to `athlete_thresholds` without mutating historical ride snapshots.
