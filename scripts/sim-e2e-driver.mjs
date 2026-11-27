#!/usr/bin/env node
import assert from "node:assert/strict";

function parseArgs(argv) {
  const opts = {
    workerUrl: "http://127.0.0.1:18787",
    bridgeUrl: "http://127.0.0.1:18765",
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

function shiftIsoDay(day, deltaDays) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function extractBetterAuthCookie(headers) {
  const cookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("Set-Cookie") ?? ""];
  return cookies
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("better-auth.session_token="))
    .join("; ");
}

async function signUpBetterAuth(workerUrl, name, email, password) {
  const res = await fetch(`${workerUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: workerUrl,
    },
    body: JSON.stringify({ name, email, password }),
  });
  return { res, cookie: extractBetterAuthCookie(res.headers) };
}

async function callMcpTool(workerUrl, mcpToken, toolName, args, expectError = false) {
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
  if (expectError) {
    assert.equal(payload.result.isError, true, `Expected MCP tool ${toolName} to return error`);
    return payload.result;
  }
  assert.equal(
    payload.result.isError,
    false,
    `MCP tool ${toolName} returned error: ${JSON.stringify(payload.result)}`
  );
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
      reject(
        new Error(
          `Timed out waiting for bridge workout completion (sawRunning=${sawRunning}, sentFault=${sentFault}, sentStop=${sentStop})`
        )
      );
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
  const bridgeToken = requireEnv("E2E_BRIDGE_TOKEN");
  const mcpTokenA = requireEnv("E2E_MCP_TOKEN");
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = shiftIsoDay(today, 1);
  const dayAfter = shiftIsoDay(today, 2);

  console.log("[e2e] 1. Verifying Worker & Bridge health endpoints...");
  const [workerHealth, bridgeHealth] = await Promise.all([
    fetch(`${workerUrl}/api/health`),
    fetch(`${bridgeUrl}/health`),
  ]);
  assert.equal(workerHealth.status, 200);
  assert.equal(bridgeHealth.status, 200);

  console.log("[e2e] 2. Signing up User A (Cyclist) via Better Auth allowlist...");
  const userASignUp = await signUpBetterAuth(
    workerUrl,
    "Cyclist E2E",
    "cyclist-e2e@example.com",
    "cyclist-strong-password-123"
  );
  assert.equal(userASignUp.res.status, 200, "Expected User A Better Auth signup to succeed");
  const cookieA = userASignUp.cookie;
  assert.ok(cookieA.includes("better-auth.session_token="), "Expected Better Auth session cookie");

  const profARes = await fetch(`${workerUrl}/api/athlete/profile`, {
    headers: { Cookie: cookieA },
  });
  assert.equal(profARes.status, 200);
  const profA = await profARes.json();
  assert.equal(profA.profile.features.indoor_trainer, true, "Primary user defaults to indoor_trainer=true");

  const thresholdRes = await fetch(`${workerUrl}/api/athlete/thresholds`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({
      effective_from: today,
      ftp_watts: 260,
      lthr_bpm: 172,
      hrmax_bpm: 190,
      weight_kg: 72,
    }),
  });
  assert.equal(thresholdRes.status, 201);

  console.log("[e2e] 3. Creating & scheduling User A cycling workout via MCP...");
  const createdA = await callMcpTool(workerUrl, mcpTokenA, "create_workout", {
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
  assert.ok(createdA.workout_id, "MCP create_workout returned workout_id");

  const scheduledA = await callMcpTool(workerUrl, mcpTokenA, "schedule_workout", {
    scheduled_date: today,
    workout_id: createdA.workout_id,
    coach_rationale: "E2E automated session",
  });
  const plannedSessionId = scheduledA.session?.id ?? scheduledA.session_id;
  assert.ok(plannedSessionId, "MCP schedule_workout returned session.id");

  console.log("[e2e] 4. Fetching flattened workout steps for Rust trainer-bridge...");
  const flatRes = await fetch(`${workerUrl}/api/workouts/${createdA.workout_id}/flattened`, {
    headers: { Cookie: cookieA },
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
  let detailA = null;
  for (let i = 0; i < 60; i += 1) {
    const res = await fetch(`${workerUrl}/api/rides/${bridgeOutcome.ride_uuid}`, {
      headers: { Cookie: cookieA },
    });
    if (res.status === 200) {
      detailA = await res.json();
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(detailA, "Timed out waiting for Rust trainer-bridge uploader to POST ride to Worker");
  assert.ok(detailA.ride.fit_bytes > 50);
  assert.ok(detailA.ride.np_watts > 100);
  assert.ok(detailA.ride.tss > 0);
  assert.ok(detailA.intervals.length >= 1, "Expected persisted ride_intervals rows");
  assert.ok(detailA.peaks.length >= 1, "Expected persisted ride_peaks rows");

  console.log("[e2e] 7. Downloading User A .fit binary from R2 and verifying .FIT header...");
  const fitRes = await fetch(`${workerUrl}/api/rides/${bridgeOutcome.ride_uuid}/fit`, {
    headers: { Cookie: cookieA },
  });
  assert.equal(fitRes.status, 200);
  const fitBuf = new Uint8Array(await fitRes.arrayBuffer());
  assert.equal(fitBuf.byteLength, detailA.ride.fit_bytes);
  assert.equal(String.fromCharCode(fitBuf[8], fitBuf[9], fitBuf[10], fitBuf[11]), ".FIT");

  console.log("[e2e] 8. Verifying idempotent duplicate upload handling...");
  const dupForm = new FormData();
  dupForm.append(
    "summary",
    JSON.stringify({
      ride_uuid: detailA.ride.ride_uuid,
      name: detailA.ride.name,
      source: "indoor_bridge",
      workout_id: detailA.ride.workout_id,
      planned_session_id: detailA.ride.planned_session_id,
      started_at: detailA.ride.started_at,
      ride_day: detailA.ride.ride_day,
      duration_s: detailA.ride.duration_s,
      elapsed_s: detailA.ride.elapsed_s,
      work_kj: detailA.ride.work_kj,
      avg_power: detailA.ride.avg_power,
      np_watts: detailA.ride.np_watts,
      intensity_factor: detailA.ride.intensity_factor,
      tss: detailA.ride.tss,
      variability_index: detailA.ride.variability_index,
      avg_hr: detailA.ride.avg_hr,
      max_hr: detailA.ride.max_hr,
      efficiency_factor: detailA.ride.efficiency_factor,
      pw_hr_decoupling: detailA.ride.pw_hr_decoupling,
      hrr_60s: detailA.ride.hrr_60s,
      time_gt_90_hrmax_s: detailA.ride.time_gt_90_hrmax_s,
      avg_cadence: detailA.ride.avg_cadence,
      compliance_pct: detailA.ride.compliance_pct,
      power_zones: JSON.parse(detailA.ride.power_zones_json),
      hr_zones: JSON.parse(detailA.ride.hr_zones_json),
      quality_flags: JSON.parse(detailA.ride.quality_flags_json),
      ftp_snapshot: detailA.ride.ftp_snapshot,
      lthr_snapshot: detailA.ride.lthr_snapshot,
      hrmax_snapshot: detailA.ride.hrmax_snapshot,
      weight_kg_snapshot: detailA.ride.weight_kg_snapshot,
      rpe: detailA.ride.rpe,
      feel: detailA.ride.feel,
      notes: detailA.ride.notes,
      intervals: detailA.intervals.map((iv) => ({
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
      peaks: detailA.peaks.map((p) => ({
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
  assert.equal(JSON.parse(dupText).idempotent, true);

  console.log("[e2e] 9. Verifying User A MCP read tools & OAuth 2.1 metadata...");
  const [mcpRideA, mcpTsA, mcpFitnessA, oauthMeta] = await Promise.all([
    callMcpTool(workerUrl, mcpTokenA, "get_ride_detail", { ride_uuid: bridgeOutcome.ride_uuid }),
    callMcpTool(workerUrl, mcpTokenA, "get_ride_timeseries", {
      ride_uuid: bridgeOutcome.ride_uuid,
      bucket_seconds: 30,
    }),
    callMcpTool(workerUrl, mcpTokenA, "get_fitness_overview", { days: 14 }),
    fetch(`${workerUrl}/.well-known/oauth-protected-resource`),
  ]);
  assert.equal(mcpRideA.ride.ride_uuid, bridgeOutcome.ride_uuid);
  assert.ok(mcpRideA.intervals.length >= 1);
  assert.ok(Array.isArray(mcpTsA.points) && mcpTsA.points.length >= 5);
  assert.ok(mcpFitnessA.current_pmc && mcpFitnessA.current_pmc.atl > 0);
  assert.equal(oauthMeta.status, 200);

  console.log("[e2e] 10. Enforcing allowlist rejection & onboarding User B (Garmin Runner)...");
  const intruder = await signUpBetterAuth(
    workerUrl,
    "Intruder",
    "intruder-e2e@example.com",
    "intruder-password-123"
  );
  assert.equal(intruder.res.status, 403, "Unlisted email must be blocked with 403");

  const userBSignUp = await signUpBetterAuth(
    workerUrl,
    "Runner E2E",
    "runner-e2e@example.com",
    "runner-strong-password-456"
  );
  assert.equal(userBSignUp.res.status, 200, "Allowlisted User B signup must succeed");
  const cookieB = userBSignUp.cookie;
  assert.ok(cookieB.includes("better-auth.session_token="));

  const profBRes = await fetch(`${workerUrl}/api/athlete/profile`, {
    headers: { Cookie: cookieB },
  });
  assert.equal(profBRes.status, 200);
  const profB = await profBRes.json();
  assert.equal(
    profB.profile.features.indoor_trainer,
    false,
    "Secondary user defaults to indoor_trainer=false"
  );

  console.log("[e2e] 11. Minting User B per-user importer & MCP device tokens...");
  const [impTokRes, mcpTokRes] = await Promise.all([
    fetch(`${workerUrl}/api/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ label: "Runner Importer", scope: "importer" }),
    }),
    fetch(`${workerUrl}/api/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ label: "Runner MCP", scope: "mcp" }),
    }),
  ]);
  assert.equal(impTokRes.status, 201);
  assert.equal(mcpTokRes.status, 201);
  const { token: importerTokenB } = await impTokRes.json();
  const { token: mcpTokenB } = await mcpTokRes.json();

  console.log("[e2e] 12. Ingesting User B Garmin run + laps + 7d HRV/sleep biometrics via batch import...");
  const runnerRideUuid = "550e8400-e29b-41d4-a716-44665544b001";
  const biometricsB = Array.from({ length: 7 }, (_, idx) => ({
    day: shiftIsoDay(today, -idx),
    hrv_rmssd_ms: idx === 0 ? 64 : 68,
    hrv_status: "BALANCED",
    resting_hr_bpm: 49,
    sleep_duration_s: 27900,
    sleep_score: 84,
    body_battery_high: 88,
  }));

  const batchRes = await fetch(`${workerUrl}/api/import/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Importer-Token": importerTokenB,
    },
    body: JSON.stringify({
      source: "garmin_archive",
      activities: [
        {
          sport: "running",
          sub_sport: "street",
          external_provider: "garmin_archive",
          external_id: "garmin-run-e2e-1",
          distance_m: 10000,
          elevation_gain_m: 85,
          avg_pace_s_per_km: 285,
          gap_s_per_km: 279,
          pa_hr_decoupling: 2.1,
          threshold_pace_snapshot: 270,
          laps: [
            { lap_index: 0, duration_s: 1425, distance_m: 5000, avg_pace_s_per_km: 285, avg_hr: 158 },
            { lap_index: 1, duration_s: 1425, distance_m: 5000, avg_pace_s_per_km: 285, avg_hr: 164 },
          ],
          summary: {
            ride_uuid: runnerRideUuid,
            name: "Garmin Morning 10k Tempo",
            source: "external_sync",
            started_at: `${today}T06:30:00Z`,
            ride_day: today,
            duration_s: 2850,
            elapsed_s: 2850,
            work_kj: 0,
            avg_power: null,
            np_watts: null,
            intensity_factor: 0.94,
            tss: 70,
            variability_index: null,
            avg_hr: 161,
            max_hr: 176,
            efficiency_factor: null,
            pw_hr_decoupling: null,
            hrr_60s: null,
            time_gt_90_hrmax_s: 180,
            avg_cadence: 174,
            compliance_pct: null,
            power_zones: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, z6: 0, z7: 0 },
            hr_zones: { z1: 100, z2: 600, z3: 900, z4: 1100, z5: 150 },
            quality_flags: {
              power_dropouts_s: 0,
              hr_dropouts_s: 0,
              erg_smoothing_detected: false,
            },
            ftp_snapshot: 250,
            notes: "Felt smooth on hills",
            intervals: [],
            peaks: [],
          },
        },
      ],
      biometrics: biometricsB,
    }),
  });
  assert.equal(batchRes.status, 200);
  const batchBody = await batchRes.json();
  assert.equal(batchBody.imported, 1);
  assert.equal(batchBody.biometrics_upserted, 7);

  const rebuildRes = await fetch(`${workerUrl}/api/import/rebuild-pmc`, {
    method: "POST",
    headers: { "X-Importer-Token": importerTokenB },
  });
  assert.equal(rebuildRes.status, 200);

  console.log("[e2e] 13. Running User B LLM workflow (memory note, run + strength workouts, unified health brief)...");
  await callMcpTool(workerUrl, mcpTokenB, "save_memory_note", {
    category: "injury",
    sport: "running",
    content: "Right calf slightly tight on hills; keep warmups easy",
  });

  const runWktB = await callMcpTool(workerUrl, mcpTokenB, "create_workout", {
    spec: {
      schema_version: 1,
      sport: "running",
      name: "5x1k Threshold Intervals",
      category: "threshold",
      steps: [
        { type: "warmup", duration_s: 600, pace_zone: "easy", label: "Easy WU" },
        {
          type: "repeat",
          count: 5,
          steps: [
            { type: "interval", distance_m: 1000, pace_zone: "threshold", label: "1k T" },
            { type: "recovery", duration_s: 90, open_target: true, label: "Jog" },
          ],
        },
        { type: "cooldown", duration_s: 600, pace_zone: "easy", label: "Easy CD" },
      ],
    },
  });
  assert.equal(runWktB.sport, "running");

  const strWktB = await callMcpTool(workerUrl, mcpTokenB, "create_workout", {
    spec: {
      schema_version: 1,
      sport: "strength",
      name: "Runner Lower Force",
      category: "lower_body",
      blocks: [
        {
          label: "Main",
          block_type: "main",
          exercises: [
            {
              name: "Trap Bar Deadlift",
              movement_pattern: "hinge",
              sets: 4,
              reps: 5,
              target_rpe_or_rir: "2 RIR",
              rest_s: 180,
            },
          ],
        },
      ],
    },
  });
  assert.equal(strWktB.sport, "strength");

  await callMcpTool(workerUrl, mcpTokenB, "schedule_workout", {
    scheduled_date: tomorrow,
    workout_id: runWktB.workout_id,
  });
  const schedStrB = await callMcpTool(workerUrl, mcpTokenB, "schedule_workout", {
    scheduled_date: dayAfter,
    workout_id: strWktB.workout_id,
  });
  assert.ok(
    schedStrB.warnings.some((w) => w.includes("Heavy lower-body strength")),
    "Expected lower-body interference warning when scheduled after threshold run"
  );

  const [briefB, actDetailB] = await Promise.all([
    callMcpTool(workerUrl, mcpTokenB, "get_health_and_training_brief", { days: 14 }),
    callMcpTool(workerUrl, mcpTokenB, "get_activity_detail", { activity_uuid: runnerRideUuid }),
  ]);
  assert.equal(briefB.readiness.biometrics_days_available, 7);
  assert.ok(briefB.readiness.hrv_7d_avg > 60);
  assert.equal(briefB.training_load.running_7d_km, 10);
  assert.equal(briefB.active_memory_notes.length, 1);
  assert.equal(briefB.upcoming_calendar.length, 2);
  assert.equal(actDetailB.laps.length, 2);

  console.log("[e2e] 14. Downloading Garmin binary .FIT workout files for User B (run & strength)...");
  for (const wId of [runWktB.workout_id, strWktB.workout_id]) {
    const expRes = await fetch(`${workerUrl}/api/workouts/${wId}/export.fit`, {
      headers: { Cookie: cookieB },
    });
    assert.equal(expRes.status, 200);
    assert.ok((expRes.headers.get("Content-Type") ?? "").includes("application/vnd.ant.fit"));
    const bytes = new Uint8Array(await expRes.arrayBuffer());
    assert.ok(bytes.byteLength > 60, "Expected non-trivial FIT workout file");
    assert.equal(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]), ".FIT");
  }

  console.log("[e2e] 15. Asserting strict zero cross-user leakage across REST and MCP...");
  const [bSeesARide, bSeesAWorkout, briefA] = await Promise.all([
    fetch(`${workerUrl}/api/rides/${bridgeOutcome.ride_uuid}`, { headers: { Cookie: cookieB } }),
    fetch(`${workerUrl}/api/workouts/${createdA.workout_id}/export.fit`, {
      headers: { Cookie: cookieB },
    }),
    callMcpTool(workerUrl, mcpTokenA, "get_health_and_training_brief", { days: 14 }),
  ]);
  assert.equal(bSeesARide.status, 404, "User B must NOT access User A ride");
  assert.equal(bSeesAWorkout.status, 404, "User B must NOT export User A workout");
  assert.equal(briefA.readiness.biometrics_days_available, 0, "User A must NOT see User B biometrics");
  assert.equal(briefA.active_memory_notes.length, 0, "User A must NOT see User B memory notes");
  assert.ok(
    !briefA.recent_activities.some((a) => a.ride_uuid === runnerRideUuid),
    "User A must NOT see User B running activity"
  );
  assert.ok(
    !briefB.recent_activities.some((a) => a.ride_uuid === bridgeOutcome.ride_uuid),
    "User B must NOT see User A cycling activity"
  );
  await callMcpTool(
    workerUrl,
    mcpTokenB,
    "get_activity_detail",
    { activity_uuid: bridgeOutcome.ride_uuid },
    true
  );

  console.log("[e2e] All 15 two-user vertical E2E assertions PASSED!");
}

main().catch((err) => {
  console.error("[e2e] FAILED:", err);
  process.exit(1);
});
