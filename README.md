# PainCave

A single-user cycling training platform connecting a **Linux basement trainer setup** (Wahoo KICKR v5 + Polar H10) to a **Cloudflare Free Tier cloud hub** and **Remote MCP for workout planning and ride analysis**.

## Architecture at a Glance

```text
[Remote MCP Clients: Planning & Analysis (Claude / ChatGPT / Gemini)]
       │  Stateless Remote MCP (OAuth 2.1 / Bearer)
       ▼
[Cloudflare Worker — $0/mo]
  ├── Hono REST API + Stateless MCP Server (/mcp)
  ├── D1 (SQLite): athlete thresholds, workouts, calendar, rides, intervals, peaks, PMC, training notes
  ├── R2: raw .fit files & exported .zwo/.erg files
  ├── Static Assets: React + Vite + Tailwind + uPlot PWA (auto-reloads when idle)
  └── Outbound Strava .fit upload
       ▲  HTTPS (idempotent ride_uuid + retry queue)
       │
[Basement Linux PC]
  ├── Chrome PWA (stateless live UI, calendar, analytics)
  │       ▲  ws://127.0.0.1:8765/ws
  └── trainer-bridge (Rust single binary via systemd)
          ├── 1Hz workout engine & ERG spiral-of-death guard
          ├── Crash-safe SQLite ride log & rustyfit .fit encoder
          └── TrainerTransport: MockTransport | BleTransport (btleplug+ftms) | AntTransport (phase 2)
                  └── KICKR v5 + Polar H10
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — System design, WebSocket/HTTP protocols, auth, hardware & failure modes
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — D1 SQLite schema, R2 layout, JSON workout spec, and physiological math
- [docs/MCP_SPEC.md](docs/MCP_SPEC.md) — MCP tools, Zod schemas, physiological guardrails, and training notes
- [docs/PLAN.md](docs/PLAN.md) — Phased implementation roadmap (M0–M7)
- [automation/LOOP_ARCHITECTURE.md](automation/LOOP_ARCHITECTURE.md) — Autonomous build, simulation, and verification loops

## Quick Commands

```bash
# View roadmap status and next unblocked task
node scripts/next-task.mjs --all
node scripts/next-task.mjs

# Run repository verification gate
./scripts/verify.sh

# Run a single task's verification command
./scripts/verify-task.sh M1-01

# Dry-run the autonomous outer loop
./scripts/autonomous-loop.sh --dry-run
```
