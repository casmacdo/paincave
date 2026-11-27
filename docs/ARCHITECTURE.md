# PainCave System Architecture

## 1. Design Goals & Constraints

1. **Zero basement development & zero LLM secrets in the basement:** All software development, deploys, and Remote MCP planning/analysis occur from the user's main computer (or any device). The basement Linux PC only runs a set-and-forget Rust daemon (`trainer-bridge`) and opens the Cloudflare-hosted Chrome PWA.
2. **Crash-proof, throttle-proof workout execution:** Watching YouTube/Netflix in the foreground on Linux throttles background Chrome tabs. Therefore, **`trainer-bridge` owns the 1Hz workout clock, trainer control loop, and crash-safe local recording**. The web UI is a stateless live display & remote control.
3. **$0/month Cloudflare hosting:** Everything on the cloud side runs within Cloudflare's Free Tier (Workers 100k req/day & 10ms CPU/request, D1 500 MB / 5M reads/day, R2 10 GB / $0 egress, Static Assets).
4. **Hardware fidelity for KICKR v5 + Polar H10:** Primary transport is Rust `btleplug` + `ftms` (BLE FTMS `0x1826` + BLE HR `0x180D`). An identical `TrainerTransport` trait enables `MockTransport` (for autonomous E2E testing) and an optional Phase-2 `AntTransport` (ANT+ FE-C + HR).
5. **Outbound-only Strava integration:** Indoor rides upload to Strava as `.fit` files via `POST /api/v3/uploads`. Outdoor rides are ingested from actual `.fit` files (never Strava streams) to preserve laps/metadata and stay clean of Strava API AI restrictions.

---

## 2. System Topology

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Remote MCP Clients (Planning & Analysis — Claude / ChatGPT / Gemini) │
│   └─ Remote MCP over Streamable HTTP (/mcp, OAuth 2.1 or Bearer)     │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ HTTPS
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Cloudflare Worker (apps/worker) — Single Deployable Unit             │
│  • Hono REST API (/api/*)                                            │
│  • Stateless Streamable HTTP MCP Server (/mcp)                       │
│  • Static Assets (apps/web/dist — React + Vite + Tailwind + uPlot)   │
│  • D1 (SQLite): thresholds, workouts, calendar, rides, PMC, memory   │
│  • R2: raw .fit files & deterministic .zwo/.erg exports              │
│  • Outbound Strava OAuth + .fit uploader (ctx.waitUntil)             │
└──────────────────────────┬───────────────────────────┬───────────────┘
                           │ HTTPS                     │ HTTPS (device token,
                           │ (session cookie)          │  idempotent ride_uuid)
                           ▼                           ▼
┌──────────────────────────────────────┐   ┌───────────────────────────────────────┐
│ Basement Chrome PWA (apps/web)       │   │ trainer-bridge (crates/trainer-bridge)│
│  • Live 1Hz uPlot power/HR/target    │◄─►│  • Rust single binary (systemd)       │
│  • Start/Pause/Skip/ERG bias +/-     │WS │  • Owns 1Hz workout engine & clock    │
│  • Calendar, Ride Analytics, Strava  │   │  • ERG spiral-of-death guard          │
│  • Auto-reloads on deploy when idle  │   │  • Crash-safe local SQLite ride log   │
│  • Offline cache via Service Worker  │   │  • rustyfit .fit encoder + summary    │
└──────────────────────────────────────┘   │  • Retryable Cloudflare uploader      │
                                           │  • TrainerTransport trait:            │
                                           │     - MockTransport (E2E/dev)         │
                                           │     - BleTransport (btleplug + ftms)  │
                                           │     - AntTransport (optional phase 2) │
                                           └───────────────────┬───────────────────┘
                                                               │ BLE / ANT+
                                                               ▼
                                                    [KICKR v5 + Polar H10]
```

---

## 3. Component Responsibilities

### 3.1 `packages/shared` (Pure TypeScript, Zero Runtime Dependencies Beyond Zod)
- Canonical Zod schemas: `WorkoutSpec`, `FlattenedStep`, `RideSummaryPayload`, `IntervalExecution`, `AthleteThresholds`, `BridgeCommand`, `BridgeEvent`.
- Deterministic compilers:
  - `flattenWorkout(spec, ftpWatts) -> FlattenedStep[]` (expands repeats, converts `%FTP` to integer watts, computes step offsets).
  - `predictWorkoutLoad(spec, ftpWatts) -> { duration_s, np, if, tss, zone_seconds }`.
  - `toZwoXml(spec)` & `toErgText(spec, ftpWatts)` for GoldenCheetah/external interoperability.
- Deterministic physiology engine:
  - Normalized Power (30s rolling 4th power), IF, TSS, VI, EF, Pw:HR aerobic decoupling, HRR-60s, time > 90% HRmax, Coggan Power Z1–Z7, HR Z1–Z5.
  - $O(N)$ prefix-sum Mean Maximal Power (MMP) across 11 durations (`5s`..`3600s`).
  - 2-parameter Critical Power (`CP`) & `W'` estimation + eFTP.
  - Daily PMC (`CTL` $\tau=42$, `ATL` $\tau=7$, `TSB`, 7-day ramp rate).

### 3.2 `apps/worker` (Cloudflare Worker)
- **Routing:**
  - `/api/auth/*` — Login, logout, session check (HttpOnly `SameSite=Lax` cookie signed with HMAC-SHA256 via Web Crypto).
  - `/api/athlete/*` — Profile, threshold history, training blocks, training notes.
  - `/api/workouts/*` — CRUD for canonical workout JSON + `/api/workouts/:id/export.zwo` & `.erg`.
  - `/api/calendar/*` — Planned sessions CRUD.
  - `/api/rides/*` — Idempotent ride ingestion (`POST /api/rides` accepting multipart `.fit` + precomputed summary JSON, authenticated via session cookie or `X-Bridge-Token`), manual `.fit` upload, ride listing, detail, interval breakdown, downsampled timeseries, and post-ride RPE/feel/notes updates.
  - `/api/fitness/*` — Daily PMC series, rolling 42d/90d power curve, weekly summaries.
  - `/api/strava/*` — OAuth connect/callback, manual retry upload, connection status.
  - `/api/version` — Returns `{ build_sha, built_at }` for PWA idle auto-reload.
  - `/mcp` — Stateless Streamable HTTP MCP endpoint protected by Bearer token (CLI/desktop) and OAuth 2.1 (`@cloudflare/workers-oauth-provider` for Claude Web/Mobile & ChatGPT).
  - `/*` — Static Assets serving `apps/web/dist` with SPA fallback to `index.html`.
- **10ms Free Tier CPU Budget:**
  - Heavy computation (FIT encoding + 1Hz analytics + MMP) happens inside `trainer-bridge` (or browser for manual `.fit` uploads) before `POST /api/rides`.
  - Worker validates summary bounds, streams `.fit` directly into R2, writes summary/intervals/peaks in one `env.DB.batch([...])`, updates `daily_pmc` from the ride date forward, and dispatches Strava upload via `ctx.waitUntil(...)`.

### 3.3 `crates/trainer-bridge` (Rust Single Binary on Basement Linux)
- **HTTP & WebSocket Server (`axum` on `127.0.0.1:8765`):**
  - `GET /health` — `{ status, version, transport, trainer_connected, hr_connected, workout_state, pending_uploads }`.
  - `GET /ws` — Bidirectional JSON WebSocket for the Chrome PWA (with CORS/Origin allowlist for configured Cloudflare origin + localhost dev).
- **Workout State Machine (`Idle` → `Armed` → `Running` ⇄ `Paused` / `AutoPaused` → `Completed`):**
  - Runs on a monotonic 1Hz `tokio::time::interval` tick.
  - Supports modes: `erg` (steady or linear ramp), `slope` (grade % for free-ride / FTP tests), `resistance` (%).
  - **ERG Spiral-of-Death Guard:** If in `erg` mode and cadence drops to `0` for >= 3 consecutive seconds while elapsed > 0, transitions to `AutoPaused` and sets safe recovery wattage (`min(100W, 0.45 * target)`). When cadence rises >= 40 RPM for 2 consecutive seconds, smoothly ramps target back to full interval watts over 3 seconds and resumes.
  - **Live Controls:** `pause`, `resume`, `skip_step`, `prev_step`, `extend_step(seconds)`, `set_erg_bias(pct)` (e.g., 85%–115%), `stop_and_save`, `discard`.
- **Crash-Safe Recording & Upload Queue:**
  - Opens a local SQLite WAL database (`$PAINCAVE_DATA_DIR/bridge.db`).
  - Generates a UUIDv4 `ride_uuid` on workout start; inserts each 1Hz sample immediately.
  - If power/process restarts mid-ride, detects an unfinished ride on startup and offers recovery/finalization.
  - On `stop_and_save`: encodes standard `.fit` using `rustyfit`, computes summary + per-interval compliance + $O(N)$ prefix-sum MMP + data quality flags in Rust (matching `packages/shared` formulas via shared golden test vectors!), queues upload, and retries with exponential backoff until Cloudflare returns `200`/`201`/`409`.
- **CLI Modes:**
  - `trainer-bridge serve` — Normal daemon mode (uses configured transport: `ble`, `mock`, or `ant`).
  - `trainer-bridge serve --mock --time-scale 60` — Accelerated simulated ride mode for autonomous E2E verification.
  - `trainer-bridge probe-ble` — 10-second BLE hardware diagnostic for KICKR v5 & Polar H10 on the basement Linux machine.

### 3.4 `apps/web` (React + Vite + Tailwind + uPlot PWA)
- **Views:**
  1. **Ride (Live Player):** Big readable Power (3s + instant), Target Power, HR, Cadence, Interval timer, Interval Cue banner, live scrolling `uPlot` chart overlaid on the workout profile, ERG +/- bias buttons, Pause/Skip/Finish, and 10-second post-ride RPE/Feel/Notes modal.
  2. **Calendar & Workouts:** Weekly calendar showing planned vs. completed sessions, workout library, workout detail/preview chart, `.zwo`/`.erg` download, "Load on Trainer" one-click handoff.
  3. **Analytics:** PMC (`CTL`/`ATL`/`TSB`) chart, 42d/90d/All-time MMP curve, recent rides table, per-ride interval compliance breakdown, manual `.fit` upload dropzone.
  4. **Settings:** Athlete thresholds (FTP/LTHR/HRmax/weight), Bridge connection URL (`ws://127.0.0.1:8765/ws`) & live sensor status, Strava connect/status, MCP endpoint info.
- **Auto-Update & Offline Behavior:**
  - Service Worker caches static bundle for offline basement startup.
  - Polls `/api/version` every 5 minutes *only when bridge workout state is `Idle`*; reloads automatically when `build_sha` changes.

---

## 4. Local WebSocket Protocol (`ws://127.0.0.1:8765/ws`)

### Client → Bridge Commands (JSON)
```json
{ "type": "scan_sensors" }
{ "type": "load_workout", "workout_id": "...", "planned_session_id": "...", "name": "4x8 Threshold", "ftp_watts": 260, "lthr_bpm": 172, "hrmax_bpm": 190, "steps": [ ... ] }
{ "type": "start" }
{ "type": "pause" }
{ "type": "resume" }
{ "type": "skip_step" }
{ "type": "prev_step" }
{ "type": "set_erg_bias", "bias_pct": 95 }
{ "type": "set_manual_target", "mode": "erg", "watts": 200 }
{ "type": "stop_and_save", "rpe": 8, "feel": 4, "notes": "Felt solid on reps 1-3" }
{ "type": "discard" }
```

### Bridge → Client Events (JSON)
```json
{
  "type": "telemetry",
  "ts_ms": 1764180000000,
  "ride_uuid": "...",
  "state": "running",
  "elapsed_s": 1245,
  "step_index": 3,
  "step_elapsed_s": 180,
  "step_remaining_s": 300,
  "mode": "erg",
  "target_watts": 260,
  "erg_bias_pct": 100,
  "watts": 258,
  "watts_3s": 261,
  "cadence_rpm": 89,
  "hr_bpm": 168,
  "speed_kph": 34.2,
  "text_cue": "Stay seated, relaxed shoulders, 90rpm",
  "sensors": { "trainer": "connected", "hr": "connected" }
}
```
```json
{ "type": "ride_saved", "ride_uuid": "...", "upload_status": "uploaded", "fit_bytes": 48210 }
{ "type": "error", "code": "TRAINER_DISCONNECTED", "message": "Reconnecting to KICKR v5..." }
```

---

## 5. Failure Modes & Resilience Matrix

| Failure Mode | Mitigation |
| :--- | :--- |
| Chrome background-tab throttling (Netflix/YouTube fullscreen) | `trainer-bridge` runs the 1Hz loop & recorder natively outside the browser. |
| Browser tab crash or accidental close mid-ride | Reopening PWA reconnects to `ws://127.0.0.1:8765/ws` and rehydrates live workout state immediately. |
| Basement Wi-Fi outage during or after ride | PWA loads from Service Worker cache; `trainer-bridge` persists `.fit` + summary in SQLite and retries upload with exponential backoff until online. |
| Duplicate upload on flaky network retry | Client-generated `ride_uuid` is `UNIQUE` in D1; repeat POST returns `200` idempotently without duplicating D1 rows or Strava uploads. |
| ERG spiral of death on sudden stop | Cadence-zero detector auto-pauses and drops resistance within 3s; ramps smoothly back over 3s once pedaling resumes. |
| Polar H10 battery drop / HR spikes | Bridge records `hr_dropouts_s` in `quality_flags_json` so LLM does not misinterpret missing HR as fitness change. |
| KICKR ERG Power Smoothing left enabled | Bridge flags `erg_smoothing_detected` if variance around steady ERG target is unrealistically flat (< 1.5W std dev for > 60s). |
| Session cookie expiry during 2h ride | `trainer-bridge` uploads using its own static `X-Bridge-Token` (not the browser's UI cookie). |
| LLM prescribing dangerous or miscalculated workout | MCP write tools validate hard physiological bounds and return deterministic predicted TSS/IF/TSB impact. |
