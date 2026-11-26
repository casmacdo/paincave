import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import goldenRide from "../../../packages/shared/fixtures/golden-ride.json" with { type: "json" };

function buildMinimalFit(samplesCount: number, baseTs = 1_164_640_000): Uint8Array {
  const def = [
    0x40, 0x00, 0x00, 20, 0, 5,
    253, 4, 0x86,
    3, 1, 0x02,
    4, 1, 0x02,
    7, 2, 0x84,
    6, 2, 0x84,
  ];
  const msgs: number[] = [];
  for (let i = 0; i < samplesCount; i++) {
    const buf = new ArrayBuffer(11);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x00);
    dv.setUint32(1, baseTs + i, true);
    dv.setUint8(5, 140 + (i % 15));
    dv.setUint8(6, 90);
    dv.setUint16(7, 220 + (i % 20), true);
    dv.setUint16(9, 8500, true);
    msgs.push(...new Uint8Array(buf));
  }
  const data = [...def, ...msgs];
  const header = new Uint8Array(14);
  const hv = new DataView(header.buffer);
  hv.setUint8(0, 14);
  hv.setUint8(1, 0x20);
  hv.setUint16(2, 2100, true);
  hv.setUint32(4, data.length, true);
  header[8] = 0x2e;
  header[9] = 0x46;
  header[10] = 0x49;
  header[11] = 0x54;
  return new Uint8Array([...header, ...data, 0x00, 0x00]);
}

async function mcpRpc<T>(
  method: string,
  params?: Record<string, unknown>,
  token = env.MCP_BEARER_TOKEN ?? ""
): Promise<T> {
  const res = await exports.default.fetch("https://paincave.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  const json = await res.json<{ result?: T; error?: { message: string } }>();
  expect(json.error).toBeUndefined();
  return json.result as T;
}

describe("Stateless Remote MCP Server — Read Tools", () => {
  it("challenges unauthenticated /mcp requests with RFC 9728 WWW-Authenticate metadata", async () => {
    const res = await exports.default.fetch("https://paincave.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://paincave.test/.well-known/oauth-protected-resource"'
    );
  });

  it("initializes, lists all 16 tools, and invokes all 8 read tools including R2 FIT timeseries decode", async () => {
    const init = await mcpRpc<{
      protocolVersion: string;
      serverInfo: { name: string };
    }>("initialize", { protocolVersion: "2025-03-26" });
    expect(init.serverInfo.name).toBe("paincave-mcp");
    expect(init.protocolVersion).toBe("2025-03-26");

    const newerInit = await mcpRpc<{ protocolVersion: string }>("initialize", {
      protocolVersion: "2025-06-18",
    });
    expect(newerInit.protocolVersion).toBe("2025-06-18");

    const list = await mcpRpc<{
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    }>("tools/list");
    expect(list.tools).toHaveLength(16);
    expect(list.tools.some((t) => t.name === "get_ride_timeseries")).toBe(true);
    expect(list.tools.some((t) => t.name === "create_workout")).toBe(true);

    // Seed data via MCP write tools + ride upload API
    const today = new Date().toISOString().slice(0, 10);
    await mcpRpc("tools/call", {
      name: "log_threshold_update",
      arguments: { effective_from: today, ftp_watts: 260, lthr_bpm: 172, hrmax_bpm: 190, weight_kg: 72 },
    });
    await mcpRpc("tools/call", {
      name: "save_coaching_note",
      arguments: { category: "preference", content: "Prefers 90rpm cadence" },
    });

    const createdWorkout = await mcpRpc<{ structuredContent: { workout_id: string } }>(
      "tools/call",
      {
        name: "create_workout",
        arguments: { spec: goldenRide.workout_spec },
      }
    );
    const workoutId = createdWorkout.structuredContent.workout_id;

    // Upload a ride with real FIT binary data
    const rideUuid = "550e8400-e29b-41d4-a716-446655440099";
    const fitBytes = buildMinimalFit(45);
    const form = new FormData();
    form.append(
      "summary",
      JSON.stringify({
        ride_uuid: rideUuid,
        name: goldenRide.workout_spec.name,
        source: "indoor_bridge",
        workout_id: workoutId,
        started_at: `${today}T10:00:00Z`,
        ride_day: today,
        duration_s: goldenRide.expected.duration_s,
        elapsed_s: goldenRide.expected.elapsed_s,
        work_kj: goldenRide.expected.work_kj,
        avg_power: goldenRide.expected.avg_power,
        np_watts: goldenRide.expected.np_watts,
        intensity_factor: goldenRide.expected.intensity_factor,
        tss: 62,
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
        ftp_snapshot: 260,
        lthr_snapshot: 172,
        hrmax_snapshot: 190,
        weight_kg_snapshot: 72,
        intervals: goldenRide.expected.intervals,
        peaks: goldenRide.expected.peaks,
      })
    );
    form.append("fit", new Blob([fitBytes]), "ride.fit");
    const uploadRes = await exports.default.fetch("https://paincave.test/api/rides", {
      method: "POST",
      headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" },
      body: form,
    });
    expect(uploadRes.status).toBe(201);

    // Exercise all 8 read tools
    const ctxRes = await mcpRpc<{
      structuredContent: { latest_thresholds: { ftp_watts: number }; coaching_notes: unknown[] };
    }>("tools/call", { name: "get_athlete_context", arguments: {} });
    expect(ctxRes.structuredContent.latest_thresholds.ftp_watts).toBe(260);
    expect(ctxRes.structuredContent.coaching_notes.length).toBeGreaterThanOrEqual(1);

    const fitRes = await mcpRpc<{
      structuredContent: { current_pmc: { ctl: number } };
    }>("tools/call", { name: "get_fitness_overview", arguments: { days: 42 } });
    expect(fitRes.structuredContent.current_pmc.ctl).toBeGreaterThan(0);

    const fitStringDays = await mcpRpc<{
      structuredContent: { current_pmc: { ctl: number } };
      isError: boolean;
    }>("tools/call", { name: "get_fitness_overview", arguments: { days: "42" } });
    expect(fitStringDays.isError).toBe(false);
    expect(fitStringDays.structuredContent.current_pmc.ctl).toBeGreaterThan(0);

    const recentRes = await mcpRpc<{
      structuredContent: { rides: { ride_uuid: string }[] };
    }>("tools/call", { name: "list_recent_rides", arguments: { days: 14 } });
    expect(recentRes.structuredContent.rides[0]?.ride_uuid).toBe(rideUuid);

    const detailRes = await mcpRpc<{
      structuredContent: { intervals: unknown[]; workout: { id: string } };
    }>("tools/call", { name: "get_ride_detail", arguments: { ride_uuid: rideUuid } });
    expect(detailRes.structuredContent.intervals).toHaveLength(goldenRide.expected.intervals.length);
    expect(detailRes.structuredContent.workout.id).toBe(workoutId);

    const tsRes = await mcpRpc<{
      structuredContent: { raw_samples: number; points: { t_s: number; watts: number }[] };
    }>("tools/call", {
      name: "get_ride_timeseries",
      arguments: { ride_uuid: rideUuid, bucket_seconds: 15 },
    });
    expect(tsRes.structuredContent.raw_samples).toBe(45);
    expect(tsRes.structuredContent.points).toHaveLength(3);

    const calRes = await mcpRpc<{
      structuredContent: { completed_rides: unknown[]; projected_pmc: unknown[] };
    }>("tools/call", {
      name: "get_calendar",
      arguments: { start_date: today, end_date: today },
    });
    expect(calRes.structuredContent.completed_rides.length).toBeGreaterThanOrEqual(1);

    const lwRes = await mcpRpc<{ structuredContent: { workouts: unknown[] } }>("tools/call", {
      name: "list_workouts",
      arguments: {},
    });
    expect(lwRes.structuredContent.workouts.length).toBeGreaterThanOrEqual(1);

    const gwRes = await mcpRpc<{ structuredContent: { id: string } }>("tools/call", {
      name: "get_workout",
      arguments: { workout_id: workoutId },
    });
    expect(gwRes.structuredContent.id).toBe(workoutId);
  });
});
