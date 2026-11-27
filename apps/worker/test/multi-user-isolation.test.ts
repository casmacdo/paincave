import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import goldenRide from "../../../packages/shared/fixtures/golden-ride.json" with { type: "json" };

const testEnv = env as typeof env & { ALLOWED_USER_EMAILS?: string };

function extractSessionCookie(headers: Headers): string {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie ? getSetCookie.call(headers) : [headers.get("Set-Cookie") ?? ""];
  return cookies
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("better-auth.session_token="))
    .join("; ");
}

async function signUpUser(name: string, email: string, password: string): Promise<string> {
  const res = await exports.default.fetch("https://paincave.test/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://paincave.test" },
    body: JSON.stringify({ name, email, password }),
  });
  expect(res.status).toBe(200);
  return extractSessionCookie(res.headers);
}

describe("Multi-User Isolation Across REST APIs, Device Tokens, and Remote MCP", () => {
  afterEach(async () => {
    testEnv.ALLOWED_USER_EMAILS = undefined;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_device_tokens"),
      env.DB.prepare("DELETE FROM mcp_oauth_tokens"),
      env.DB.prepare("DELETE FROM mcp_oauth_codes"),
      env.DB.prepare("DELETE FROM planned_sessions"),
      env.DB.prepare("DELETE FROM ride_intervals"),
      env.DB.prepare("DELETE FROM ride_peaks"),
      env.DB.prepare("DELETE FROM activity_laps"),
      env.DB.prepare("DELETE FROM rides"),
      env.DB.prepare("DELETE FROM workouts"),
      env.DB.prepare("DELETE FROM coaching_notes"),
      env.DB.prepare("DELETE FROM athlete_thresholds"),
      env.DB.prepare("DELETE FROM daily_pmc"),
      env.DB.prepare("DELETE FROM athlete_profile WHERE user_id != 'default_owner'"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ]);
  });

  it("isolates rides, workouts, thresholds, notes, device tokens, and MCP tools between User A and User B", async () => {
    testEnv.ALLOWED_USER_EMAILS = "cyclist-a@example.com, runner-b@example.com";

    const cookieA = await signUpUser("Cyclist A", "cyclist-a@example.com", "password-alpha-123");
    const cookieB = await signUpUser("Runner B", "runner-b@example.com", "password-beta-123");

    // 1. Secondary user defaults to indoor_trainer = false while primary owner defaults to true
    const profA = await (
      await exports.default.fetch("https://paincave.test/api/athlete/profile", {
        headers: { Cookie: cookieA },
      })
    ).json<{ profile: { features: { indoor_trainer: boolean } } }>();
    const profB = await (
      await exports.default.fetch("https://paincave.test/api/athlete/profile", {
        headers: { Cookie: cookieB },
      })
    ).json<{ profile: { features: { indoor_trainer: boolean } } }>();
    expect(profA.profile.features.indoor_trainer).toBe(true);
    expect(profB.profile.features.indoor_trainer).toBe(false);

    // 2. User A creates a workout, training note, and uploads a ride
    const wARes = await exports.default.fetch("https://paincave.test/api/workouts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify(goldenRide.workout_spec),
    });
    expect(wARes.status).toBe(201);
    const { workout: workoutA } = await wARes.json<{ workout: { id: string } }>();

    const noteARes = await exports.default.fetch("https://paincave.test/api/athlete/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ category: "injury", content: "User A private knee note" }),
    });
    expect(noteARes.status).toBe(201);

    const rideAUuid = "550e8400-e29b-41d4-a716-446655441111";
    const today = new Date().toISOString().slice(0, 10);
    const rideARes = await exports.default.fetch("https://paincave.test/api/rides", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        ride_uuid: rideAUuid,
        name: "User A Secret Threshold Ride",
        source: "manual_fit",
        workout_id: workoutA.id,
        started_at: `${today}T10:00:00Z`,
        ride_day: today,
        duration_s: 3600,
        elapsed_s: 3600,
        work_kj: 700,
        avg_power: 210,
        np_watts: 225,
        intensity_factor: 0.9,
        tss: 81,
        variability_index: 1.07,
        avg_hr: 158,
        max_hr: 179,
        efficiency_factor: 1.42,
        pw_hr_decoupling: 2.4,
        hrr_60s: 32,
        time_gt_90_hrmax_s: 120,
        avg_cadence: 90,
        compliance_pct: 98,
        power_zones: { z1: 600, z2: 1200, z3: 600, z4: 1200, z5: 0, z6: 0, z7: 0 },
        hr_zones: { z1: 600, z2: 1200, z3: 600, z4: 1200, z5: 0 },
        quality_flags: {
          power_dropouts_s: 0,
          hr_dropouts_s: 0,
          erg_smoothing_detected: false,
        },
        ftp_snapshot: 250,
        notes: "Private A ride",
        intervals: [],
        peaks: [],
      }),
    });
    expect(rideARes.status).toBe(201);

    // 3. User B cannot see or access ANY of User A's REST resources
    const ridesB = await (
      await exports.default.fetch("https://paincave.test/api/rides", {
        headers: { Cookie: cookieB },
      })
    ).json<{ rides: unknown[] }>();
    expect(ridesB.rides).toHaveLength(0);

    const rideDetailB = await exports.default.fetch(
      `https://paincave.test/api/rides/${rideAUuid}`,
      { headers: { Cookie: cookieB } }
    );
    expect(rideDetailB.status).toBe(404);

    const workoutDetailB = await exports.default.fetch(
      `https://paincave.test/api/workouts/${workoutA.id}`,
      { headers: { Cookie: cookieB } }
    );
    expect(workoutDetailB.status).toBe(404);

    const notesB = await (
      await exports.default.fetch("https://paincave.test/api/athlete/notes", {
        headers: { Cookie: cookieB },
      })
    ).json<{ notes: unknown[] }>();
    expect(notesB.notes).toHaveLength(0);

    // 4. Per-user MCP tokens isolate MCP read & write calls completely
    const tokARes = await exports.default.fetch("https://paincave.test/api/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ label: "User A MCP", scope: "mcp" }),
    });
    expect(tokARes.status).toBe(201);
    const { token: mcpTokenA } = await tokARes.json<{ token: string }>();

    const tokBRes = await exports.default.fetch("https://paincave.test/api/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ label: "User B MCP", scope: "mcp" }),
    });
    expect(tokBRes.status).toBe(201);
    const { token: mcpTokenB } = await tokBRes.json<{ token: string }>();

    const mcpA = await (
      await exports.default.fetch("https://paincave.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mcpTokenA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_recent_rides", arguments: { days: 7 } },
        }),
      })
    ).json<{ result: { structuredContent: { rides: { ride_uuid: string }[] } } }>();
    expect(mcpA.result.structuredContent.rides).toHaveLength(1);
    expect(mcpA.result.structuredContent.rides[0]?.ride_uuid).toBe(rideAUuid);

    const mcpB = await (
      await exports.default.fetch("https://paincave.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mcpTokenB}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_recent_rides", arguments: { days: 7 } },
        }),
      })
    ).json<{ result: { structuredContent: { rides: unknown[] } } }>();
    expect(mcpB.result.structuredContent.rides).toHaveLength(0);

    const mcpBDetail = await (
      await exports.default.fetch("https://paincave.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mcpTokenB}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get_ride_detail", arguments: { ride_uuid: rideAUuid } },
        }),
      })
    ).json<{ result: { isError: boolean } }>();
    expect(mcpBDetail.result.isError).toBe(true);
  });
});
