import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/auth.js";

async function mintMcpToken(userId: string, rawToken: string): Promise<void> {
  const hash = await sha256Hex(rawToken);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO user_device_tokens (token_hash, user_id, label, scope)
     VALUES (?, ?, 'test-mcp', 'mcp')`
  )
    .bind(hash, userId)
    .run();
}

async function callMcp<T>(
  token: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const res = await exports.default.fetch("https://paincave.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json<{
    result?: { isError: boolean; structuredContent?: T; content?: { text: string }[] };
    error?: { message: string };
  }>();
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).toBe(false);
  return body.result?.structuredContent as T;
}

function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, (d ?? 1) + deltaDays));
  return dt.toISOString().slice(0, 10);
}

describe("Unified Health & Training Brief, Multi-Sport Workouts, and Memory MCP Tools", () => {
  it("returns one compact health/training brief with HRV deltas, running ACWR, laps, memory notes, and multi-sport workouts isolated per user", async () => {
    const runnerId = "user-runner-brief-1";
    const cyclistId = "user-cyclist-brief-2";
    const runnerToken = "mcp_runner_brief_token_1234567890abcdef";
    const cyclistToken = "mcp_cyclist_brief_token_1234567890abcdef";

    await Promise.all([
      mintMcpToken(runnerId, runnerToken),
      mintMcpToken(cyclistId, cyclistToken),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = shiftDay(today, 1);
    const dayAfter = shiftDay(today, 2);

    // Seed runner thresholds
    await callMcp(runnerToken, "log_threshold_update", {
      effective_from: shiftDay(today, -30),
      threshold_pace_s_per_km: 270,
      lthr_bpm: 174,
      hrmax_bpm: 192,
      weight_kg: 58,
    });

    // Seed 20 days of biometrics: 13 baseline days (HRV ~68) + 7 recent days (HRV ~58 -> negative delta)
    for (let i = 19; i >= 0; i--) {
      const day = shiftDay(today, -i);
      const isRecent = i < 7;
      await env.DB.prepare(
        `INSERT OR REPLACE INTO daily_biometrics
          (user_id, day, hrv_rmssd_ms, hrv_status, resting_hr_bpm, sleep_duration_s, sleep_score, body_battery_high, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'garmin_personal')`
      )
        .bind(
          runnerId,
          day,
          isRecent ? 58 : 68,
          isRecent ? "LOW" : "BALANCED",
          isRecent ? 52 : 48,
          isRecent ? 25200 : 28800,
          isRecent ? 74 : 86,
          isRecent ? 76 : 92
        )
        .run();
    }

    // Seed trailing 28d running sessions (3 prior weeks @ 20km/wk + 1 recent week @ 30km) + laps on latest run
    const latestRunUuid = "550e8400-e29b-41d4-a716-446655449101";
    const runDays = [
      { uuid: "550e8400-e29b-41d4-a716-446655449104", day: shiftDay(today, -24), dist: 20000 },
      { uuid: "550e8400-e29b-41d4-a716-446655449103", day: shiftDay(today, -17), dist: 20000 },
      { uuid: "550e8400-e29b-41d4-a716-446655449102", day: shiftDay(today, -10), dist: 20000 },
      { uuid: latestRunUuid, day: shiftDay(today, -1), dist: 30000 },
    ];
    for (const r of runDays) {
      await env.DB.prepare(
        `INSERT INTO rides
          (ride_uuid, user_id, sport, name, source, started_at, ride_day, duration_s, elapsed_s,
           distance_m, avg_pace_s_per_km, gap_s_per_km, tss, avg_hr, ftp_snapshot, r2_fit_key, fit_bytes)
         VALUES (?, ?, 'running', 'Threshold Progression Run', 'external_sync', ?, ?, 5400, 5400, ?, 285, 280, 95, 162, 250, ?, 0)`
      )
        .bind(r.uuid, runnerId, `${r.day}T07:00:00Z`, r.day, r.dist, `users/${runnerId}/fit/${r.uuid}.fit`)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO activity_laps
        (ride_uuid, user_id, lap_index, duration_s, distance_m, avg_pace_s_per_km, avg_hr)
       VALUES (?, ?, 0, 285, 1000, 285, 158),
              (?, ?, 1, 280, 1000, 280, 165)`
    )
      .bind(latestRunUuid, runnerId, latestRunUuid, runnerId)
      .run();

    // Save, update, and verify LLM memory note (no manual UI form needed)
    const savedNote = await callMcp<{ note: { id: string; content: string } }>(
      runnerToken,
      "save_memory_note",
      {
        category: "injury",
        sport: "running",
        content: "Mild left Achilles stiffness on cold mornings",
      }
    );
    expect(savedNote.note.id).toBeTruthy();

    const updatedNote = await callMcp<{ note: { id: string; content: string } }>(
      runnerToken,
      "update_memory_note",
      {
        note_id: savedNote.note.id,
        content: "Mild left Achilles stiffness resolving; keep morning warmups easy",
      }
    );
    expect(updatedNote.note.content).toContain("resolving");

    // Create a running workout AND a heavy lower-body strength workout via MCP
    const createdRun = await callMcp<{ workout_id: string; sport: string }>(
      runnerToken,
      "create_workout",
      {
        spec: {
          schema_version: 1,
          sport: "running",
          name: "4x1k Threshold Intervals",
          category: "threshold",
          steps: [
            { type: "warmup", duration_s: 600, pace_zone: "easy" },
            {
              type: "repeat",
              count: 4,
              steps: [
                { type: "interval", distance_m: 1000, pace_zone: "threshold" },
                { type: "recovery", duration_s: 90, pace_zone: "recovery" },
              ],
            },
            { type: "cooldown", duration_s: 600, pace_zone: "easy" },
          ],
        },
      }
    );
    expect(createdRun.sport).toBe("running");

    const createdStrength = await callMcp<{ workout_id: string; sport: string }>(
      runnerToken,
      "create_workout",
      {
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
                  name: "Romanian Deadlift",
                  movement_pattern: "hinge",
                  sets: 4,
                  reps: "6",
                  target_rpe_or_rir: "2 RIR",
                  rest_s: 150,
                },
                {
                  name: "Split Squat",
                  movement_pattern: "lunge",
                  sets: 3,
                  reps: "8/side",
                  target_rpe_or_rir: "RPE 8",
                  rest_s: 120,
                },
              ],
            },
          ],
        },
      }
    );
    expect(createdStrength.sport).toBe("strength");

    // Schedule key threshold run tomorrow and heavy lower strength day after -> triggers interference warning!
    await callMcp(runnerToken, "schedule_workout", {
      scheduled_date: tomorrow,
      workout_id: createdRun.workout_id,
    });
    const scheduledStrength = await callMcp<{ warnings: string[] }>(
      runnerToken,
      "schedule_workout",
      {
        scheduled_date: dayAfter,
        workout_id: createdStrength.workout_id,
      }
    );
    expect(scheduledStrength.warnings.some((w) => w.includes("Heavy lower-body strength"))).toBe(
      true
    );

    // Call unified get_health_and_training_brief
    const brief = await callMcp<{
      readiness: {
        hrv_7d_avg: number;
        hrv_baseline_avg: number;
        hrv_delta_pct: number;
        body_battery_7d_avg: number;
      };
      training_load: {
        running_7d_km: number;
        running_28d_weekly_avg_km: number;
        running_acwr: number;
      };
      active_memory_notes: { id: string; content: string }[];
      recent_activities: { ride_uuid: string; sport: string }[];
      upcoming_calendar: { workout_name: string; workout_sport: string }[];
    }>(runnerToken, "get_health_and_training_brief", { days: 14 });

    expect(brief.readiness.hrv_7d_avg).toBe(58);
    expect(brief.readiness.hrv_delta_pct).toBeLessThan(0);
    expect(brief.readiness.body_battery_7d_avg).toBe(76);
    expect(brief.training_load.running_7d_km).toBe(30);
    expect(brief.training_load.running_28d_weekly_avg_km).toBe(22.5);
    expect(brief.training_load.running_acwr).toBe(1.33);
    expect(brief.active_memory_notes).toHaveLength(1);
    expect(brief.active_memory_notes[0]?.content).toContain("Achilles");
    expect(brief.recent_activities.some((a) => a.ride_uuid === latestRunUuid)).toBe(true);
    expect(brief.upcoming_calendar.length).toBeGreaterThanOrEqual(2);

    // Check get_biometrics_history, list_activities, and get_activity_detail (with laps!)
    const bioHist = await callMcp<{ biometrics: unknown[]; summary: { hrv_7d_avg: number } }>(
      runnerToken,
      "get_biometrics_history",
      { days: 30 }
    );
    expect(bioHist.biometrics.length).toBe(20);
    expect(bioHist.summary.hrv_7d_avg).toBe(58);

    const acts = await callMcp<{ activities: { ride_uuid: string; sport: string }[] }>(
      runnerToken,
      "list_activities",
      { sport: "running", days: 30 }
    );
    expect(acts.activities.length).toBe(4);

    const actDetail = await callMcp<{ laps: { lap_index: number; avg_pace_s_per_km: number }[] }>(
      runnerToken,
      "get_activity_detail",
      { activity_uuid: latestRunUuid }
    );
    expect(actDetail.laps).toHaveLength(2);
    expect(actDetail.laps[1]?.avg_pace_s_per_km).toBe(280);

    // Archive memory note and confirm it disappears from brief
    await callMcp(runnerToken, "archive_memory_note", { note_id: savedNote.note.id });
    const briefAfterArchive = await callMcp<{ active_memory_notes: unknown[] }>(
      runnerToken,
      "get_health_and_training_brief"
    );
    expect(briefAfterArchive.active_memory_notes).toHaveLength(0);

    // Verify User B (Cyclist) sees ZERO of User A's biometrics, runs, calendar, or memory notes
    const cyclistBrief = await callMcp<{
      readiness: { biometrics_days_available: number };
      training_load: { running_7d_km: number };
      recent_activities: unknown[];
      upcoming_calendar: unknown[];
      active_memory_notes: unknown[];
    }>(cyclistToken, "get_health_and_training_brief");

    expect(cyclistBrief.readiness.biometrics_days_available).toBe(0);
    expect(cyclistBrief.training_load.running_7d_km).toBe(0);
    expect(cyclistBrief.recent_activities).toHaveLength(0);
    expect(cyclistBrief.upcoming_calendar).toHaveLength(0);
    expect(cyclistBrief.active_memory_notes).toHaveLength(0);
  });
});
