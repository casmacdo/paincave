# Autonomous Development & Feedback Loop Architecture

PainCave is engineered so an AI coding agent (or an outer unattended loop) can build, test, and verify the entire stack **without requiring the physical KICKR v5 or Polar H10 plugged in** until final hardware sign-off.

## The 4 Nested Feedback Loops

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Loop 3: Outer Autonomous Task Loop (scripts/autonomous-loop.sh)         │
│   Pick next unblocked task (tasks.json DAG)                             │
│     ──► Invoke Agent with PROMPT_AUTONOMOUS.md + Task + Progress        │
│     ──► Run verify-task.sh <id> + verify.sh                             │
│     ──► PASS: git commit + mark done in tasks.json                      │
│     ──► FAIL: feed stdout/stderr into next retry (circuit breaker = 3)  │
│                                                                         │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │ Loop 2: Vertical Simulation E2E Loop (scripts/sim-e2e.sh)        │  │
│   │   Start local Worker (Miniflare D1/R2) + trainer-bridge --mock   │  │
│   │   MCP creates workout -> Bridge runs 20m ride at 60x speed       │  │
│   │   Injects cadence=0 (ERG guard) + 503 upload failure (retry)     │  │
│   │   Verifies .fit in R2, D1 PMC/intervals, & MCP readback          │  │
│   │                                                                  │  │
│   │   ┌───────────────────────────────────────────────────────────┐  │  │
│   │   │ Loop 1: Inner Fast Verification Loop (scripts/verify.sh)  │  │  │
│   │   │   • Task DAG integrity check                              │  │  │
│   │   │   • TS typecheck + ESLint (no-floating-promises)          │  │  │
│   │   │   • Vitest (packages/shared + Worker Miniflare + Web)     │  │  │
│   │   │   • Rust cargo fmt --check + clippy -D warnings + test    │  │  │
│   │   │   • Golden fixture parity (TS math == Rust math)          │  │  │
│   │   └───────────────────────────────────────────────────────────┘  │  │
│   └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ Loop 4: Basement Hardware-in-the-Loop (HIL) Smoke Check (Manual/SSH)    │
│   scripts/deploy-basement.sh -> trainer-bridge probe-ble -> /health     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Guardrails Against Runaway Loops

1. **Verified State Transitions (`scripts/update-task.mjs`):**
   - Marking a task `done` **automatically executes** its `verify_cmd` from `automation/tasks.json`. If `verify_cmd` exits non-zero, the task *cannot* transition to `done`.
2. **DAG Enforcement (`scripts/next-task.mjs`):**
   - Validates zero circular dependencies, zero dangling references, and only hands out a task when every `depends_on` task is `done`.
3. **Circuit Breaker (`scripts/autonomous-loop.sh`):**
   - Tracks consecutive failed iterations per task (`MAX_CONSECUTIVE_FAILURES`, default `3`).
   - On failure, captures the failing verification log into `automation/logs/<task-id>-attempt-<n>.log` and passes the tail into the next iteration's context so the agent self-corrects.
   - If a task fails `MAX_CONSECUTIVE_FAILURES` times in a row, the loop halts cleanly, marks the task `blocked`, and preserves git state for human inspection—never burning unbounded tokens.
4. **Cross-Language Golden Parity:**
   - Because ride physiology runs in both TypeScript (`packages/shared`) and Rust (`crates/trainer-bridge`), both test suites assert against the exact same `packages/shared/fixtures/golden-ride.json` test vector so metrics can never drift apart.
5. **Hardware-Free End-to-End Verification:**
   - `MockTransport` inside `crates/trainer-bridge` makes real BLE/ANT+ hardware an implementation detail tested in M6/M7, rather than a blocker for autonomous development of M1–M5.
