import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

async function loginCookie(): Promise<string> {
  const res = await exports.default.fetch("https://paincave.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "paincave-test-pw" }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

const VALID_WORKOUT = {
  schema_version: 1,
  name: "Tuesday Sweet Spot 2x15",
  description: "Steady aerobic threshold development",
  category: "sweet_spot",
  steps: [
    { type: "ramp", label: "Warmup", duration_s: 600, start_ftp: 0.5, end_ftp: 0.72 },
    {
      type: "repeat",
      count: 2,
      label: "SS",
      steps: [
        { type: "steady", label: "Work", duration_s: 900, target_ftp: 0.9, cadence_rpm: 90 },
        { type: "steady", label: "Rest", duration_s: 300, target_ftp: 0.55 },
      ],
    },
    { type: "ramp", label: "Cooldown", duration_s: 300, start_ftp: 0.55, end_ftp: 0.4 },
  ],
};

describe("Workouts & Calendar API", () => {
  it("validates guardrails, saves workouts, exports ZWO/ERG/flattened, and checks calendar day constraints", async () => {
    const cookie = await loginCookie();

    // Seed athlete threshold and active block with Tuesday 45m constraint
    await exports.default.fetch("https://paincave.test/api/athlete/thresholds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ effective_from: "2026-11-01", ftp_watts: 260 }),
    });
    await exports.default.fetch("https://paincave.test/api/athlete/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Base Block",
        phase: "base",
        start_date: "2026-11-01",
        weekly_hours_target: 7,
        constraints: { tue_max_min: 45 },
        active: true,
      }),
    });

    // Reject unsafe workout (>150% FTP for >120s)
    const badRes = await exports.default.fetch("https://paincave.test/api/workouts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        schema_version: 1,
        name: "Unsafe",
        steps: [{ type: "steady", duration_s: 300, target_ftp: 1.8 }],
      }),
    });
    expect(badRes.status).toBe(400);

    // Create valid workout (duration 3300s = 55m)
    const createRes = await exports.default.fetch("https://paincave.test/api/workouts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(VALID_WORKOUT),
    });
    expect(createRes.status).toBe(201);
    const { workout, predicted } = await createRes.json<{
      workout: { id: string; duration_s: number };
      predicted: { duration_s: number; tss: number };
    }>();
    expect(workout.duration_s).toBe(3300);
    expect(predicted.tss).toBeGreaterThan(50);

    // Exports (.zwo, .erg, flattened)
    const zwoRes = await exports.default.fetch(
      `https://paincave.test/api/workouts/${workout.id}/export.zwo`,
      { headers: { Cookie: cookie } }
    );
    expect(zwoRes.status).toBe(200);
    expect(await zwoRes.text()).toContain("<workout_file>");

    const ergRes = await exports.default.fetch(
      `https://paincave.test/api/workouts/${workout.id}/export.erg`,
      { headers: { Cookie: cookie } }
    );
    expect(ergRes.status).toBe(200);
    expect(await ergRes.text()).toContain("FTP = 260");

    const flatRes = await exports.default.fetch(
      `https://paincave.test/api/workouts/${workout.id}/flattened`,
      { headers: { Cookie: cookie } }
    );
    expect(flatRes.status).toBe(200);
    const flatJson = await flatRes.json<{ steps: unknown[] }>();
    expect(flatJson.steps).toHaveLength(6);

    // Schedule on a Tuesday (2026-11-24 is Tuesday) -> returns duration warning
    const schedRes = await exports.default.fetch("https://paincave.test/api/calendar/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        scheduled_date: "2026-11-24",
        workout_id: workout.id,
        coach_rationale: "Testing constraint check",
      }),
    });
    expect(schedRes.status).toBe(201);
    const schedData = await schedRes.json<{ warnings: string[]; session: { id: string } }>();
    expect(schedData.warnings).toHaveLength(1);
    expect(schedData.warnings[0]).toContain("tue_max_min");

    // Fetch calendar range
    const calRes = await exports.default.fetch(
      "https://paincave.test/api/calendar?start=2026-11-23&end=2026-11-29",
      { headers: { Cookie: cookie } }
    );
    expect(calRes.status).toBe(200);
    const calData = await calRes.json<{ planned_sessions: { workout_name: string }[] }>();
    expect(calData.planned_sessions[0]?.workout_name).toBe("Tuesday Sweet Spot 2x15");

    // Archiving removes it from the workout library but preserves ride/calendar history.
    const deleteRes = await exports.default.fetch(
      `https://paincave.test/api/workouts/${workout.id}`,
      { method: "DELETE", headers: { Cookie: cookie } }
    );
    expect(deleteRes.status).toBe(200);

    const libraryRes = await exports.default.fetch("https://paincave.test/api/workouts", {
      headers: { Cookie: cookie },
    });
    expect(libraryRes.status).toBe(200);
    const libraryData = await libraryRes.json<{ workouts: { id: string }[] }>();
    expect(libraryData.workouts.some((item) => item.id === workout.id)).toBe(false);
  });
});
