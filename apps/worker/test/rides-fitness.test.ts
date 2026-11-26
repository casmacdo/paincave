import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import goldenRide from "../../../packages/shared/fixtures/golden-ride.json" with { type: "json" };

async function loginCookie(): Promise<string> {
  const res = await exports.default.fetch("https://paincave.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "paincave-test-pw" }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

describe("Idempotent Ride Ingestion, PMC & Fitness Overview", () => {
  it("ingests multipart .fit + summary via X-Bridge-Token idempotently, recomputes PMC, and serves fitness overview", async () => {
    const cookie = await loginCookie();
    const rideUuid = "550e8400-e29b-41d4-a716-446655440001";
    const today = new Date().toISOString().slice(0, 10);

    // Create workout & schedule session for today
    const wRes = await exports.default.fetch("https://paincave.test/api/workouts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(goldenRide.workout_spec),
    });
    expect(wRes.status).toBe(201);
    const { workout } = await wRes.json<{ workout: { id: string } }>();

    const sRes = await exports.default.fetch("https://paincave.test/api/calendar/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scheduled_date: today, workout_id: workout.id }),
    });
    expect(sRes.status).toBe(201);
    const { session } = await sRes.json<{ session: { id: string } }>();

    const summary = {
      ride_uuid: rideUuid,
      name: goldenRide.workout_spec.name,
      source: "indoor_bridge" as const,
      workout_id: workout.id,
      planned_session_id: session.id,
      started_at: `${today}T12:00:00Z`,
      ride_day: today,
      duration_s: goldenRide.expected.duration_s,
      elapsed_s: goldenRide.expected.elapsed_s,
      work_kj: goldenRide.expected.work_kj,
      avg_power: goldenRide.expected.avg_power,
      np_watts: goldenRide.expected.np_watts,
      intensity_factor: goldenRide.expected.intensity_factor,
      tss: 84,
      variability_index: goldenRide.expected.variability_index,
      avg_hr: goldenRide.expected.avg_hr,
      max_hr: goldenRide.expected.max_hr,
      efficiency_factor: goldenRide.expected.efficiency_factor,
      pw_hr_decoupling: goldenRide.expected.pw_hr_decoupling,
      hrr_60s: goldenRide.expected.hrr_60s,
      time_gt_90_hrmax_s: goldenRide.expected.time_gt_90_hrmax_s,
      avg_cadence: goldenRide.expected.avg_cadence,
      compliance_pct: goldenRide.expected.compliance_pct,
      power_zones: goldenRide.expected.power_zones,
      hr_zones: goldenRide.expected.hr_zones,
      quality_flags: goldenRide.expected.quality_flags,
      ftp_snapshot: goldenRide.thresholds.ftp_watts,
      lthr_snapshot: goldenRide.thresholds.lthr_bpm,
      hrmax_snapshot: goldenRide.thresholds.hrmax_bpm,
      weight_kg_snapshot: goldenRide.thresholds.weight_kg,
      rpe: 7,
      feel: 4,
      notes: "Solid threshold blocks",
      intervals: goldenRide.expected.intervals,
      peaks: goldenRide.expected.peaks,
    };

    const dummyFit = new Uint8Array([14, 0x10, 0, 0, 1, 2, 3, 4, 0x2e, 0x46, 0x49, 0x54]);

    const makeForm = (): FormData => {
      const form = new FormData();
      form.append("summary", JSON.stringify(summary));
      form.append("fit", new Blob([dummyFit], { type: "application/vnd.ant.fit" }), "ride.fit");
      return form;
    };

    // Reject bad device token
    const badAuth = await exports.default.fetch("https://paincave.test/api/rides", {
      method: "POST",
      headers: { "X-Bridge-Token": "wrong-token" },
      body: makeForm(),
    });
    expect(badAuth.status).toBe(401);

    // First upload succeeds with 201
    const upload1 = await exports.default.fetch("https://paincave.test/api/rides", {
      method: "POST",
      headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" },
      body: makeForm(),
    });
    expect(upload1.status).toBe(201);
    const body1 = await upload1.json<{ idempotent: boolean; fit_bytes: number; r2_fit_key: string }>();
    expect(body1.idempotent).toBe(false);
    expect(body1.fit_bytes).toBe(dummyFit.byteLength);

    // Duplicate retry returns 200 idempotently
    const upload2 = await exports.default.fetch("https://paincave.test/api/rides", {
      method: "POST",
      headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" },
      body: makeForm(),
    });
    expect(upload2.status).toBe(200);
    const body2 = await upload2.json<{ idempotent: boolean }>();
    expect(body2.idempotent).toBe(true);

    // Verify FIT file stored in R2 and downloadable
    const fitRes = await exports.default.fetch(
      `https://paincave.test/api/rides/${rideUuid}/fit`,
      { headers: { Cookie: cookie } }
    );
    expect(fitRes.status).toBe(200);
    const fetchedFit = new Uint8Array(await fitRes.arrayBuffer());
    expect(fetchedFit).toEqual(dummyFit);

    // Verify detail + intervals + peaks + planned_session completion
    const detailRes = await exports.default.fetch(
      `https://paincave.test/api/rides/${rideUuid}`,
      { headers: { Cookie: cookie } }
    );
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json<{
      ride: { tss: number; rpe: number };
      intervals: unknown[];
      peaks: unknown[];
    }>();
    expect(detail.ride.tss).toBe(84);
    expect(detail.intervals).toHaveLength(goldenRide.expected.intervals.length);
    expect(detail.peaks).toHaveLength(goldenRide.expected.peaks.length);

    // Patch RPE & notes
    const patchRes = await exports.default.fetch(
      `https://paincave.test/api/rides/${rideUuid}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ rpe: 8, notes: "Updated RPE" }),
      }
    );
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<{ ride: { rpe: number; notes: string } }>();
    expect(patched.ride.rpe).toBe(8);
    expect(patched.ride.notes).toBe("Updated RPE");

    // Verify Fitness Overview (PMC + MMP + weekly rollup)
    const fitOverviewRes = await exports.default.fetch(
      "https://paincave.test/api/fitness/overview?days=42",
      { headers: { Cookie: cookie } }
    );
    expect(fitOverviewRes.status).toBe(200);
    const overview = await fitOverviewRes.json<{
      current_pmc: { ctl: number; atl: number };
      mmp_42d: { duration_s: number; watts: number }[];
      weekly_rollups: { rides: number; tss: number }[];
    }>();
    expect(overview.current_pmc.ctl).toBeCloseTo(84 / 42, 2);
    expect(overview.current_pmc.atl).toBeCloseTo(84 / 7, 2);
    expect(overview.mmp_42d.length).toBeGreaterThanOrEqual(8);
    expect(overview.weekly_rollups[0]?.tss).toBe(84);
  });
});
