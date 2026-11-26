# PainCave Implementation Plan (M0 – M7)

Machine-readable source of truth: [automation/tasks.json](../automation/tasks.json).

---

## Milestone M0 — Foundation, Specs & Autonomous Loop Systems ✅ (Current Bootstrap)
- Standalone monorepo initialized (npm workspaces + Cargo workspace).
- Architecture, Data Model, MCP Spec, and Loop Architecture written.
- Executable task DAG (`automation/tasks.json`), task navigator (`scripts/next-task.mjs`), verified task state updater (`scripts/update-task.mjs`), master verification gate (`scripts/verify.sh`), outer Ralph-style autonomous loop (`scripts/autonomous-loop.sh`), and vertical E2E simulation harness (`scripts/sim-e2e.sh`).
- Initial D1 SQL migration (`apps/worker/migrations/0001_initial.sql`) and `wrangler.jsonc` configured.

## Milestone M1 — Shared Domain, Workout Compiler & Physiology Engine (`packages/shared`)
- **M1-01:** Workspace dependencies setup (`zod`, `vitest`, `typescript`, `wrangler`, `hono`, `@modelcontextprotocol/sdk`, React/Vite/Tailwind/uPlot) + strict TS builds.
- **M1-02:** Canonical `WorkoutSpec` Zod schemas, physiological guardrails validator, `flattenWorkout`, `predictWorkoutLoad`, and deterministic `.zwo` / `.erg` compilers with unit tests.
- **M1-03:** Complete physiological metrics engine (NP, IF, TSS, VI, EF, Pw:HR, HRR-60s, time > 90% HRmax, Power/HR zones, $O(N)$ prefix-sum MMP, CP/W', interval compliance, PMC) + **shared golden ride fixture** (`packages/shared/fixtures/golden-ride.json`) that both TypeScript and Rust validate against!

## Milestone M2 — Cloudflare Worker, D1, R2 & Core REST API (`apps/worker`)
- **M2-01:** Worker app skeleton with Hono, `wrangler types`, structured JSON logging, health & `/api/version` endpoints, and `@cloudflare/vitest-pool-workers` test harness running real D1 migrations + R2 in Miniflare.
- **M2-02:** Auth layer (PBKDF2/scrypt password verification, HMAC-SHA256 `HttpOnly` UI session cookies, timing-safe `X-Bridge-Token` and `MCP_BEARER_TOKEN` verification) + Athlete/Threshold/Block/Memory CRUD endpoints.
- **M2-03:** Workouts CRUD + `.zwo`/`.erg` export endpoints + Calendar (`planned_sessions`) endpoints.
- **M2-04:** Idempotent ride ingestion (`POST /api/rides` with `ride_uuid` uniqueness, streaming `.fit` to R2, atomic `DB.batch` insert for `rides`/`ride_intervals`/`ride_peaks`, incremental `daily_pmc` recalculation) + Ride query/RPE update & Fitness overview endpoints.

## Milestone M3 — Stateless Remote MCP Server (`apps/worker/src/mcp`)
- **M3-01:** Stateless Streamable HTTP MCP server mounted at `/mcp` with all Read tools (`get_athlete_context`, `get_fitness_overview`, `list_recent_rides`, `get_ride_detail`, `get_ride_timeseries`, `get_calendar`, `list_workouts`, `get_workout`) + Vitest integration tests using an actual MCP client.
- **M3-02:** MCP Write tools (`create_workout`, `update_workout`, `schedule_workout`, `move_or_cancel_session`, `upsert_training_block`, `save_coaching_note`, `log_threshold_update`) with hard physiological guardrails, constraint warnings, and deterministic predicted TSS/TSB responses + OAuth 2.1 provider wiring for Claude Web/ChatGPT.

## Milestone M4 — Rust `trainer-bridge` Core (`crates/trainer-bridge`)
- **M4-01:** Core types, `TrainerTransport` trait, realistic `MockTransport` (simulates KICKR ERG response lag, HR kinetics, cadence, configurable dropout/zero-cadence faults, and `--time-scale` acceleration), and 1Hz Workout Execution Engine with ERG spiral-of-death auto-pause/ramp recovery.
- **M4-02:** Crash-safe local SQLite WAL recorder (`rusqlite`), `rustyfit` `.fit` encoder, and Rust physiology calculator verified to match `packages/shared/fixtures/golden-ride.json` within strict numerical tolerances!
- **M4-03:** `axum` HTTP `/health` + WebSocket `/ws` server + retryable Cloudflare uploader with exponential backoff and idempotent `ride_uuid` queue.

## Milestone M5 — React + Vite + uPlot Chrome PWA (`apps/web`)
- **M5-01:** App shell, login flow, PWA manifest + Service Worker offline cache + idle `/api/version` auto-reload controller, and `BridgeClient` WebSocket hook with auto-reconnect.
- **M5-02:** Live Workout Player view (big telemetry cards, workout profile + live 1Hz `uPlot` graph, interval progress + LLM coaching cue banner, Start/Pause/Skip/ERG bias +/- controls, post-ride 10-second RPE/Feel/Notes modal).
- **M5-03:** Calendar, Workout Library (with preview chart & one-click "Load on Trainer"), Analytics (PMC + MMP curves + per-interval compliance table + manual `.fit` upload dropzone), and Settings view.

## Milestone M6 — Real Hardware & Strava Integration
- **M6-01:** `BleTransport` in `crates/trainer-bridge` using `btleplug` + `ftms` (KICKR v5 FTMS `0x1826` Indoor Bike Data `0x2AD2` + Control Point `0x2AD9`, Polar H10 HR `0x180D`, auto-reconnect, `probe-ble` CLI diagnostic, KICKR smoothing detection).
- **M6-02:** Outbound Strava OAuth connect/refresh + background `.fit` upload via `ctx.waitUntil` (`POST /api/v3/uploads`) with retry endpoint and status tracking in `rides`.
- **M6-03:** *(Optional Phase 2 if desired after Linux BLE test)* `AntTransport` in Rust behind `TrainerTransport` trait (FE-C + HR).

## Milestone M7 — End-to-End Autonomous Verification & Basement Linux Deployment
- **M7-01:** Full vertical E2E simulation (`scripts/sim-e2e.sh`) passing green: starts local Worker + `trainer-bridge --mock --time-scale 60`, creates workout via MCP, executes simulated ride with a cadence-zero ERG recovery event and a simulated upload retry, verifies `.fit` in R2, verifies D1 intervals/peaks/PMC, and reads compliance back via MCP!
- **M7-02:** Basement Linux deployment package (`scripts/deploy-basement.sh`, `systemd/paincave-bridge.service`, Cloudflare production deploy checklist, and `probe-ble` live hardware verification on KICKR v5 + Polar H10).
