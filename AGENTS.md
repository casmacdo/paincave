# PainCave — Agent Guide & Engineering Invariants

PainCave is a single-user indoor/outdoor cycling training system built for a **Linux basement trainer PC** (Wahoo KICKR v5 + Polar H10), a **Cloudflare Free Tier hub** (REST API + Stateless MCP Server + D1 + R2 + Hosted PWA), and a **Rust `trainer-bridge` daemon**.

## Architectural Invariants (Never Violate)

1. **Zero Basement Development / Zero LLM Keys in the Basement**
   - The basement Linux PC only runs `trainer-bridge` (a single Rust binary managed by `systemd`) and opens the Cloudflare-hosted Chrome PWA.
   - All LLM interactions happen via the Cloudflare Worker's remote `/mcp` endpoint from any client.

2. **Daemon Owns Real-Time Control & Local Recording**
   - `crates/trainer-bridge` MUST own the 1Hz workout clock, ERG/SIM control loop, ERG spiral-of-death protection, local crash-safe SQLite/JSONL recording, `.fit` encoding, and retryable upload queue.
   - `apps/web` is strictly a stateless live display, workout/calendar manager, and remote control over `ws://127.0.0.1:8765/ws`. Never move the 1Hz control loop or authoritative ride recorder into browser tab timers (Chrome throttles background tabs).

3. **Hardware Abstraction (`TrainerTransport` Trait)**
   - Every hardware backend in `crates/trainer-bridge` implements `TrainerTransport`:
     - `MockTransport` (mandatory — powers autonomous E2E simulation without physical hardware)
     - `BleTransport` (`btleplug` + `ftms` for KICKR v5 FTMS `0x1826` & Polar H10 HR `0x180D`)
     - `AntTransport` (optional phase-2 ANT+ FE-C + HR backend behind the exact same trait)

4. **Cloudflare Workers Best Practices (Free Tier Safe)**
   - Use `wrangler.jsonc` with current `compatibility_date`, `compatibility_flags: ["nodejs_compat"]`, and `observability.enabled = true`.
   - Never hand-write `Env` interfaces; generate via `wrangler types` and use `satisfies ExportedHandler<Env>`.
   - Respect the **10ms Workers Free Tier CPU limit**: run ride summary + $O(N)$ prefix-sum MMP computation in `trainer-bridge` / browser prior to upload; keep Worker handlers fast, streaming, and stateless.
   - Never store request-scoped state in module-level variables.
   - Never leave floating promises; always `await`, `return`, or pass to `ctx.waitUntil(...)` (never destructure `ctx`).
   - Use Web Crypto (`crypto.randomUUID()`, `crypto.getRandomValues()`, `crypto.subtle.timingSafeEqual` on SHA-256 hashes) for all tokens/secrets. Never commit secrets or `.dev.vars`.
   - Never blanket-wrap `/mcp` or device upload endpoints in Cloudflare Access.

5. **Deterministic Physiology & LLM Guardrails**
   - All physiological metrics (NP, IF, TSS, VI, EF, Pw:HR, MMP, CP/W', CTL/ATL/TSB, interval compliance) are computed deterministically in code—never rely on LLM arithmetic.
   - Every ride upload MUST carry a client-generated `ride_uuid` enforced as `UNIQUE` in D1 for idempotency.
   - Historical rides snapshot `ftp_snapshot` / `lthr_snapshot` from `athlete_thresholds` effective on the ride date.
   - Strava is an **outbound sink only** (upload `.fit` via `POST /api/v3/uploads`); never depend on Strava API streams as source-of-truth for LLM analysis.

## Autonomous Workflow Protocol

When working autonomously on this repository:

1. Check the next unblocked task:
   ```bash
   node scripts/next-task.mjs
   ```
2. Read the task's `acceptance_criteria`, `files_expected`, and `verify_cmd` in `automation/tasks.json`, plus the relevant sections of `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, and `docs/MCP_SPEC.md`.
3. Mark the task `in_progress`:
   ```bash
   node scripts/update-task.mjs <TASK_ID> in_progress --note "Starting implementation"
   ```
4. Implement cleanly with tight, focused changes and unit/integration tests.
5. Run both the task verification command and the repo verification gate:
   ```bash
   ./scripts/verify-task.sh <TASK_ID>
   ./scripts/verify.sh
   ```
6. Mark the task `done` (the script automatically re-runs `verify_cmd` before allowing `done`):
   ```bash
   node scripts/update-task.mjs <TASK_ID> done --note "Concise summary of what was implemented and verified"
   ```
7. Never weaken tests, disable lint rules, or bypass verification gates to make a task pass. If genuinely blocked (e.g., missing credentials or physical hardware), mark `blocked` with a clear explanation in `automation/progress.md`.
