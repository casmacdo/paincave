# PainCave Deployment Runbook

This guide takes PainCave from verified source code to production across:
1. **Cloudflare Free Tier Hub** (Workers + D1 + R2 + Hosted PWA + Outbound Strava + Mobile OAuth 2.1 MCP)
2. **Remote MCP Clients for Planning & Analysis** (Claude Mobile/Web, ChatGPT Mobile, Gemini, or CLI MCP clients)
3. **Basement Linux Trainer PC** (Rust `trainer-bridge` daemon talking to Wahoo KICKR v5 & Polar H10 over BlueZ BLE)

---

## 1. Prerequisites

- Node.js 22+ and npm
- Rust toolchain (`cargo` 1.85+)
- Cloudflare account + Wrangler CLI (`npx wrangler login`)
- Linux trainer PC with BlueZ 5 (`bluetoothd` active)
- Optional: Personal Strava API application for automatic `.fit` uploads

---

## 2. Cloudflare Free Tier Provisioning

All commands below assume you run them from the repository root unless noted otherwise.

### 2.1 Authenticate Wrangler

```bash
cd apps/worker
npx wrangler login
```

### 2.2 Create D1 Database and R2 Bucket

```bash
npx wrangler d1 create paincave-db
npx wrangler r2 bucket create paincave-rides
```

Copy the UUID returned by `wrangler d1 create paincave-db` into `apps/worker/wrangler.jsonc` under `d1_databases[0].database_id`.

### 2.3 Apply Production D1 Schema Migrations

```bash
npx wrangler d1 migrations apply paincave-db --remote
```

---

## 3. Generate & Provision Worker Secrets

Generate strong random secrets locally (do **not** commit them or save them in tracked files):

```bash
# Generate 256-bit random tokens for sessions, trainer bridge, and static MCP CLI access
openssl rand -hex 32   # use as SESSION_SIGNING_SECRET
openssl rand -hex 32   # use as BRIDGE_DEVICE_TOKEN (save for bridge.env too)
openssl rand -hex 32   # use as MCP_BEARER_TOKEN
```

Upload the required secrets to Cloudflare Workers:

```bash
cd apps/worker
npx wrangler secret put SESSION_SIGNING_SECRET
npx wrangler secret put BRIDGE_DEVICE_TOKEN
npx wrangler secret put MCP_BEARER_TOKEN
```

### Google Sign-In Secrets

Create a Google OAuth 2.0 Web application and add this authorized redirect URI:

```text
https://<your-worker-subdomain>.workers.dev/api/auth/callback/google
```

Then add the OAuth credentials as Worker secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put PUBLIC_APP_URL
```

Set `PUBLIC_APP_URL` to `https://<your-worker-subdomain>.workers.dev` when prompted.

### Optional: Strava Automatic Upload Secrets

If you want indoor `.fit` rides automatically uploaded to Strava after finishing:

1. In Strava Settings -> **My API Application**, set **Authorization Callback Domain** to `<your-worker-subdomain>.workers.dev` (hostname only, no `https://`).
2. Add the credentials as Worker secrets:

```bash
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
```

---

## 4. Build & Deploy Web PWA + Worker

From the repository root:

```bash
npm run build
cd apps/worker
npx wrangler deploy
```

Once deployed:

1. Open `https://<your-worker-subdomain>.workers.dev` in Chrome.
2. Sign in with Google.
3. Open **Settings**:
   - Save your baseline **FTP / LTHR / HRmax / Weight** snapshot.
   - If Strava secrets were configured, click **Connect Strava** to complete the OAuth consent flow.

### GitHub Actions auto-deploy

The `Deploy to Cloudflare` workflow runs for pushes to `main` and supports manual
dispatch. Configure these repository secrets before enabling the workflow:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `PAINCAVE_D1_DATABASE_ID`

Make sure `CLOUDFLARE_API_TOKEN` is created as a **Custom Token** scoped to the same
account as `CLOUDFLARE_ACCOUNT_ID` with **all** of these permissions (note that
Cloudflare's built-in "Edit Cloudflare Workers" template omits `D1: Edit` and will fail
`wrangler d1 migrations apply` with API error `7403` unless added):

- `Account → D1: Edit`
- `Account → Workers Scripts: Edit`
- `Account → Workers R2 Storage: Edit`
- `Account → Account Settings: Read`

The workflow runs strict verification and the production build, generates an
ignored Wrangler production config from the tracked base config, applies D1
migrations, deploys the Worker and web assets, and verifies the live build SHA.

---

## 5. Connect Remote MCP Clients for Planning & Analysis (Mobile & Desktop)

PainCave exposes a stateless MCP endpoint at:

```text
https://<your-worker-subdomain>.workers.dev/mcp
```

### Option A: Claude Mobile / Claude Web / ChatGPT Mobile (OAuth 2.1 + PKCE + DCR)

1. Open Custom Connectors / Remote MCP Settings in your AI app.
2. Add connector URL: `https://<your-worker-subdomain>.workers.dev/mcp`.
3. The client automatically discovers `/.well-known/oauth-protected-resource`, registers via `POST /oauth/register`, and opens the PainCave OAuth approval page.
4. Sign in with Google and approve access. Issued access & refresh tokens are stored SHA-256 hashed in D1 with automatic refresh rotation.

### Option B: CLI / Desktop MCP Clients (Static Bearer Token)

Pass:

```text
Authorization: Bearer <MCP_BEARER_TOKEN>
```

Available planning, analysis & telemetry tools include `get_athlete_context`, `get_fitness_overview`, `list_recent_rides`, `get_ride_detail`, `get_ride_timeseries`, `get_calendar`, `list_workouts`, `get_workout`, `create_workout`, `update_workout`, `schedule_workout`, `move_or_cancel_session`, `log_threshold_update`, `save_coaching_note`, `archive_coaching_note`, and `upsert_training_block`.

---

## 6. Basement Linux Trainer PC Setup

`crates/trainer-bridge` talks directly to BlueZ over system D-Bus (`zbus` + `ftms`) — no extra C Bluetooth header packages are required.

### 6.1 Verify Bluetooth Hardware

On the basement Linux machine:

```bash
systemctl status bluetooth
bluetoothctl show
```

Wake up your Wahoo KICKR v5 (spin pedals) and wear your Polar H10 strap, then verify discovery:

```bash
~/.local/bin/trainer-bridge probe-ble --seconds 10
```

You should see both an `FTMS` device (`0x1826`) and an `HR` device (`0x180D`).

### 6.2 Configure `~/.config/paincave/bridge.env`

Create `$HOME/.config/paincave/bridge.env` on the basement PC with strict permissions (`chmod 600`):

```ini
PAINCAVE_API_URL=https://<your-worker-subdomain>.workers.dev
PAINCAVE_BRIDGE_TOKEN=<same value as BRIDGE_DEVICE_TOKEN>
PAINCAVE_BRIDGE_PORT=8765
PAINCAVE_ALLOWED_ORIGIN=https://<your-worker-subdomain>.workers.dev
PAINCAVE_DATA_DIR=$HOME/.local/share/paincave
```

> Never put real tokens inside the Git repository. Store `bridge.env` only on the basement machine with `chmod 600`.

### 6.3 Deploy Binary & Systemd User Service

From the Linux build workstation, use an SSH destination that accepts key-based login:

```bash
BASEMENT_HOST=user@basement-pc ./scripts/deploy-basement.sh
```

For development, keep this running on the laptop:

```bash
BASEMENT_HOST=user@basement-pc ./scripts/deploy-basement.sh --watch
```

The watcher deploys the current checkout on startup and after bridge files change,
including uncommitted edits. It runs the bridge tests on the laptop, builds a release
binary for the remote host, and sends the binary and systemd unit over SSH. It checks
the running bridge's workout state before switching versions and retries deferred or
failed updates. Ctrl-C stops the watcher. Web and Worker edits use the Cloudflare
deployment in section 4.

For a Raspberry Pi with a 64-bit OS, install the `aarch64-unknown-linux-gnu` Rust
target and `aarch64-linux-gnu-gcc` cross-compiler on the laptop. A 32-bit hard-float
OS on an ARMv7-capable Pi uses `armv7-unknown-linux-gnueabihf` and
`arm-linux-gnueabihf-gcc`. The target system must support the runtime libraries used
by the build. Deployment checks that the binary can launch before replacing the old
version. The trainer PC needs the configuration from section 6.2 and a running systemd
user manager. Open the hosted PWA on that same computer to reach its loopback bridge.

Enable lingering so the user service keeps running across logins (optional):

```bash
loginctl enable-linger "$USER"
```

Verify the bridge daemon is healthy:

```bash
curl -fsS http://127.0.0.1:8765/health
```

### 6.4 Install Chrome PWA on Basement PC

1. Open Google Chrome on the basement PC and navigate to `https://<your-worker-subdomain>.workers.dev`.
2. Verify **Settings -> Local Linux Trainer Bridge** shows **Connected** (transport `ble`).
3. Click Chrome's **Install PainCave** icon in the address bar for full-screen kiosk-style trainer sessions.
4. Chrome automatically polls `/api/version` every 5 minutes (while idle) and applies new web deployments seamlessly.

---

## 7. Pre-Release & Regression Checks

Before pushing changes or deploying an update:

```bash
# Static checks + Rust tests + TypeScript/Worker/Web suites + secret/PII scan
./scripts/verify.sh --strict

# Full vertical E2E simulation (Wrangler D1/R2 + Rust 60x mock bridge + MCP + FIT round-trip)
./scripts/sim-e2e.sh

# Release binary + production web bundle + Wrangler dry-run bundle check
cargo build --release --manifest-path crates/trainer-bridge/Cargo.toml
npm run build
CI=1 npm --workspace @paincave/worker run deploy:dry-run </dev/null
```
