#!/usr/bin/env node
import assert from "node:assert/strict";

function parseArgs(argv) {
  const opts = {
    workerUrl: "http://127.0.0.1:8787",
    bridgeUrl: "http://127.0.0.1:8765",
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--worker-url" && argv[i + 1]) {
      opts.workerUrl = argv[i + 1].replace(/\/$/, "");
      i += 1;
    } else if (argv[i] === "--bridge-url" && argv[i + 1]) {
      opts.bridgeUrl = argv[i + 1].replace(/\/$/, "");
      i += 1;
    }
  }
  return opts;
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

async function callMcpTool(workerUrl, mcpToken, toolName, args) {
  const res = await fetch(`${workerUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 100000),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });
  assert.equal(res.status, 200, `MCP HTTP status for ${toolName}`);
  const payload = await res.json();
  assert.ok(payload.result, `Missing MCP result for ${toolName}`);
  assert.equal(payload.result.isError, false, `MCP tool ${toolName} returned error: ${JSON.stringify(payload.result)}`);
  if (payload.result.structuredContent) {
    return payload.result.structuredContent;
  }
  return JSON.parse(payload.result.content[0].text);
}

async function runBridgeWorkoutSession(wsUrl, loadPayload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let sentFault = false;
    let sawRunning = false;
    let sawFaultDrop = false;
    let sawPostFaultRecovery = false;
    let sentStop = false;
    let maxWatts = 0;

    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`Timed out waiting for bridge workout completion (sawRunning=${sawRunning}, sentFault=${sentFault}, sentStop=${sentStop})`));
    }, 35_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "load_workout", ...loadPayload }));
      ws.send(JSON.stringify({ type: "start" }));
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${err.message ?? "unknown"}`));
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (msg.type === "error") {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`Bridge emitted error event ${msg.code}: ${msg.message}`));
        return;
      }

      if (msg.type === "telemetry") {
        if (typeof msg.watts === "number") {
          maxWatts = Math.max(maxWatts, msg.watts);
        }
        if (msg.state === "running") {
          sawRunning = true;
        }
        if (sawRunning && !sentFault && msg.elapsed_s >= 120) {
          sentFault = true;
          ws.send(JSON.stringify({ type: "inject_mock_fault", cadence_zero_seconds: 5 }));
        }
        if (sentFault && (msg.state === "auto_paused" || msg.cadence_rpm === 0)) {
          sawFaultDrop = true;
        }
        if (sentFault && msg.state === "running" && (msg.watts ?? 0) > 100 && msg.elapsed_s >= 220) {
          sawPostFaultRecovery = true;
        }
        if (!sentStop && (msg.state === "completed" || msg.elapsed_s >= 600)) {
          sentStop = true;
          ws.send(
            JSON.stringify({
              type: "stop_and_save",
              rpe: 7,
              feel: 4,
              notes: "Vertical E2E 60x mock ride",
            })
          );
        }
      }

      if (msg.type === "ride_saved") {
        clearTimeout(timeout);
        ws.close();
        resolve({
          ride_uuid: msg.ride_uuid,
          fit_bytes: msg.fit_bytes,
          sawRunning,
          sentFault,
          sawFaultDrop,
          sawPostFaultRecovery,
          maxWatts,
        });
      }
    });
  });
}

async function main() {
  const { workerUrl, bridgeUrl } = parseArgs(process.argv.slice(2));
  const uiPassword = requireEnv("E2E_UI_PASSWORD");
  const bridgeToken = requireEnv("E2E_BRIDGE_TOKEN");
  const mcpToken = requireEnv("E2E_MCP_TOKEN");
  const today = new Date().toISOString().slice(0, 10);

  console.log("[e2e] 1. Verifying Worker & Bridge health endpoints...");
  const [workerHealth, bridgeHealth] = await Promise.all([
    fetch(`${workerUrl}/api/health`),
    fetch(`${bridgeUrl}/health`),
  ]);
  assert.equal(workerHealth.status, 200);
  assert.equal(bridgeHealth.status, 200);

  console.log("[e2e] 2. Logging in UI session & seeding athlete thresholds...");
  const loginRes = await fetch(`${workerUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: uiPassword }),
  });
  assert.equal(loginRes.status, 200);
  const rawCookie = loginRes.headers.get("Set-Cookie") ?? "";
  const cookie = rawCookie.split(";")[0];
  assert.ok(cookie && cookie.startsWith("paincave_session="), "Expected valid session cookie");

  const thresholdRes = await fetch(`${workerUrl}/api/athlete/thresholds`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      effective_from: today,
      ftp_watts: 260,
      lthr_bpm: 172,
      hrmax_bpm: 190,
      weight_kg: 72,
    }),
  });
  assert.equal(thresholdRes.status, 201);

  console.log("[e2e] 3. Creating & scheduling workout via MCP /mcp endpoint...");
  const created = await callMcpTool(workerUrl, mcpToken, "create_workout", {
    spec: {
      schema_version: 1,
      name: "E2E 10m Threshold Test",
      description: "Compact 600s ride executed at 60x mock speed",
      category: "threshold",
      steps: [
        { type: "ramp", duration_s: 180, start_ftp: 0.5, end_ftp: 0.7, label: "Warmup", cadence_rpm: 88 },
        { type: "steady", duration_s: 240, target_ftp: 1.0, label: "Threshold Block", cadence_rpm: 92 },
        { type: "steady", duration_s: 180, target_ftp: 0.5, label: "Cooldown", cadence_rpm: 85 },
      ],
    },
    dry_run: false,
  });
  assert.ok(created.workout_id, "MCP create_workout returned workout_id");

  const scheduled = await callMcpTool(workerUrl, mcpToken, "schedule_workout", {
    scheduled_date: today,
    workout_id: created.workout_id,
    coach_rationale: "E2E automated session",
  });
  const plannedSessionId = scheduled.session?.id ?? scheduled.session_id;
  assert.ok(plannedSessionId, "MCP schedule_workout returned session.id");

  console.log("[e2e] 4. Fetching flattened workout steps for Rust trainer-bridge...");
  const flatRes = await fetch(`${workerUrl}/api/workouts/${created.workout_id}/flattened`, {
    headers: { Cookie: cookie },
  });
  assert.equal(flatRes.status, 200);
  const flat = await flatRes.json();
  assert.equal(flat.steps.length, 3);

  console.log("[e2e] 5. Driving 60x mock ride over WebSocket + injecting 5s cadence=0 fault...");
  const wsUrl = `${bridgeUrl.replace(/^http/, "ws")}/ws`;
  const bridgeOutcome = await runBridgeWorkoutSession(wsUrl, {
    workout_id: flat.workout_id,
    planned_session_id: plannedSessionId,
    name: flat.name,
    ftp_watts: flat.ftp_watts,
    lthr_bpm: flat.lthr_bpm,
    hrmax_bpm: flat.hrmax_bpm,
    weight_kg: flat.weight_kg,
    steps: flat.steps,
  });
  assert.ok(bridgeOutcome.ride_uuid, "Expected ride_uuid from bridge ride_saved");
  assert.ok(bridgeOutcome.fit_bytes > 50, `Expected non-trivial FIT payload, got ${bridgeOutcome.fit_bytes}`);
  assert.ok(bridgeOutcome.sentFault, "Expected cadence=0 fault command to be dispatched");
  assert.ok(bridgeOutcome.maxWatts > 180, `Expected mock ERG power ramp, maxWatts=${bridgeOutcome.maxWatts}`);
  console.log(
    `[e2e]    Ride saved locally (${bridgeOutcome.ride_uuid}, ${bridgeOutcome.fit_bytes} bytes, sawFaultDrop=${bridgeOutcome.sawFaultDrop}, sawPostFaultRecovery=${bridgeOutcome.sawPostFaultRecovery})`
  );

  console.log("[e2e] 6. Polling Worker D1/R2 for Rust background upload arrival...");
  let detail = null;
  for (let i = 0; i < 60; i += 1) {
    const res = await fetch(`${workerUrl}/api/rides/${bridgeOutcome.ride_uuid}`, {
      headers: { Cookie: cookie },
    });
    if (res.status === 200) {
      detail = await res.json();
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(detail, "Timed out waiting for Rust trainer-bridge uploader to POST ride to Worker");
  assert.ok(detail.ride.fit_bytes > 50);
  assert.ok(detail.ride.np_watts > 100);
  assert.ok(detail.ride.tss > 0);
  assert.ok(detail.intervals.length >= 1, "Expected persisted ride_intervals rows");
  assert.ok(detail.peaks.length >= 1, "Expected persisted ride_peaks rows");

  console.log("[e2e] 7. Downloading .fit binary from R2 and verifying .FIT header...");
  const fitRes = await fetch(`${workerUrl}/api/rides/${bridgeOutcome.ride_uuid}/fit`, {
    headers: { Cookie: cookie },
  });
  assert.equal(fitRes.status, 200);
  const fitBuf = new Uint8Array(await fitRes.arrayBuffer());
  assert.equal(fitBuf.byteLength, detail.ride.fit_bytes);
  const magic = String.fromCharCode(fitBuf[8], fitBuf[9], fitBuf[10], fitBuf[11]);
  assert.equal(magic, ".FIT", `Expected .FIT magic header, got ${magic}`);

  console.log("[e2e] 8. Verifying idempotent duplicate upload handling...");
  const dupForm = new FormData();
  dupForm.append(
    "summary",
    JSON.stringify({
      ride_uuid: detail.ride.ride_uuid,
      name: detail.ride.name,
      source: "indoor_bridge",
      workout_id: detail.ride.workout_id,
      planned_session_id: detail.ride.planned_session_id,
      started_at: detail.ride.started_at,
      ride_day: detail.ride.ride_day,
      duration_s: detail.ride.duration_s,
      elapsed_s: detail.ride.elapsed_s,
      work_kj: detail.ride.work_kj,
      avg_power: detail.ride.avg_power,
      np_watts: detail.ride.np_watts,
      intensity_factor: detail.ride.intensity_factor,
      tss: detail.ride.tss,
      variability_index: detail.ride.variability_index,
      avg_hr: detail.ride.avg_hr,
      max_hr: detail.ride.max_hr,
      efficiency_factor: detail.ride.efficiency_factor,
      pw_hr_decoupling: detail.ride.pw_hr_decoupling,
      hrr_60s: detail.ride.hrr_60s,
      time_gt_90_hrmax_s: detail.ride.time_gt_90_hrmax_s,
      avg_cadence: detail.ride.avg_cadence,
      compliance_pct: detail.ride.compliance_pct,
      power_zones: JSON.parse(detail.ride.power_zones_json),
      hr_zones: JSON.parse(detail.ride.hr_zones_json),
      quality_flags: JSON.parse(detail.ride.quality_flags_json),
      ftp_snapshot: detail.ride.ftp_snapshot,
      lthr_snapshot: detail.ride.lthr_snapshot,
      hrmax_snapshot: detail.ride.hrmax_snapshot,
      weight_kg_snapshot: detail.ride.weight_kg_snapshot,
      rpe: detail.ride.rpe,
      feel: detail.ride.feel,
      notes: detail.ride.notes,
      intervals: detail.intervals.map((iv) => ({
        step_index: iv.step_index,
        label: iv.label,
        mode: iv.mode,
        is_work_interval: Boolean(iv.is_work_interval),
        planned_duration_s: iv.planned_duration_s,
        actual_duration_s: iv.actual_duration_s,
        target_watts: iv.target_watts,
        actual_avg_watts: iv.actual_avg_watts,
        pct_of_target: iv.pct_of_target,
        avg_hr: iv.avg_hr,
        max_hr: iv.max_hr,
        hr_drift_bpm: iv.hr_drift_bpm,
        avg_cadence: iv.avg_cadence,
        erg_bias_pct: iv.erg_bias_pct,
        status: iv.status,
      })),
      peaks: detail.peaks.map((p) => ({
        duration_s: p.duration_s,
        watts: p.watts,
        w_per_kg: p.w_per_kg,
      })),
    })
  );
  dupForm.append("fit", new Blob([fitBuf], { type: "application/vnd.ant.fit" }), "ride.fit");
  const dupRes = await fetch(`${workerUrl}/api/rides`, {
    method: "POST",
    headers: { "X-Bridge-Token": bridgeToken },
    body: dupForm,
  });
  const dupText = await dupRes.text();
  assert.equal(dupRes.status, 200, `Duplicate POST /api/rides failed (${dupRes.status}): ${dupText}`);
  const dupBody = JSON.parse(dupText);
  assert.equal(dupBody.idempotent, true);

  console.log("[e2e] 9. Verifying MCP read tools (get_ride_detail, get_ride_timeseries, get_fitness_overview)...");
  const [mcpRide, mcpTs, mcpFitness] = await Promise.all([
    callMcpTool(workerUrl, mcpToken, "get_ride_detail", { ride_uuid: bridgeOutcome.ride_uuid }),
    callMcpTool(workerUrl, mcpToken, "get_ride_timeseries", {
      ride_uuid: bridgeOutcome.ride_uuid,
      bucket_seconds: 30,
    }),
    callMcpTool(workerUrl, mcpToken, "get_fitness_overview", { days: 14 }),
  ]);
  assert.equal(mcpRide.ride.ride_uuid, bridgeOutcome.ride_uuid);
  assert.ok(mcpRide.intervals.length >= 1);
  assert.ok(Array.isArray(mcpTs.points) && mcpTs.points.length >= 5, "Expected FIT-decoded timeseries buckets");
  assert.ok(Array.isArray(mcpFitness.daily_pmc) && mcpFitness.daily_pmc.length >= 1, "Expected populated daily_pmc series");
  assert.ok(mcpFitness.current_pmc && mcpFitness.current_pmc.atl > 0, "Expected non-zero ATL after ride");

  console.log("[e2e] 10. Verifying Mobile MCP OAuth 2.1 Protected Resource metadata...");
  const oauthMeta = await fetch(`${workerUrl}/.well-known/oauth-protected-resource`);
  assert.equal(oauthMeta.status, 200);
  const metaJson = await oauthMeta.json();
  assert.ok(Array.isArray(metaJson.authorization_servers) && metaJson.authorization_servers.length >= 1);

  console.log("[e2e] All 10 end-to-end assertions passed!");
}

main().catch((err) => {
  console.error("[e2e] FAILED:", err);
  process.exit(1);
});
