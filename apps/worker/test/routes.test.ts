import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * Builds a minimal valid FIT binary containing a session message (sub_sport=58 virtual_activity)
 * and 3 GPS record messages so FIT GPS extraction & VirtualRide Strava tagging can be tested end-to-end.
 */
function buildVirtualGpsFitBytes(): Uint8Array {
  const data: number[] = [];
  const pushU16 = (v: number) => {
    data.push(v & 0xff, (v >> 8) & 0xff);
  };
  const pushU32 = (v: number) => {
    data.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const pushI32 = (v: number) => {
    pushU32(v >>> 0);
  };
  const degToSemi = (deg: number) => Math.round((deg / 180) * 2_147_483_648);

  // Definition local 0 -> global 20 (record): timestamp(253,4), lat(0,4), lon(1,4), alt(2,2), power(7,2)
  data.push(0x40, 0x00, 0x00);
  pushU16(20);
  data.push(5);
  data.push(253, 4, 0x86);
  data.push(0, 4, 0x85);
  data.push(1, 4, 0x85);
  data.push(2, 2, 0x84);
  data.push(7, 2, 0x84);

  const pts: [number, number, number][] = [
    [45.0, 6.0, 500],
    [45.001, 6.0, 508],
    [45.002, 6.0, 516],
  ];
  pts.forEach(([lat, lon, ele], idx) => {
    data.push(0x00);
    pushU32(1_100_000_000 + idx);
    pushI32(degToSemi(lat));
    pushI32(degToSemi(lon));
    pushU16(Math.round((ele + 500) * 5));
    pushU16(230);
  });

  // Definition local 1 -> global 18 (session): start_time(2,4), sub_sport(6,1)
  data.push(0x41, 0x00, 0x00);
  pushU16(18);
  data.push(2);
  data.push(2, 4, 0x86);
  data.push(6, 1, 0x00);

  data.push(0x01);
  pushU32(1_100_000_000);
  data.push(58); // virtual_activity

  const header = new Uint8Array(14);
  const hv = new DataView(header.buffer);
  header[0] = 14;
  header[1] = 0x20;
  hv.setUint16(2, 21126, true);
  hv.setUint32(4, data.length, true);
  header[8] = 0x2e;
  header[9] = 0x46;
  header[10] = 0x49;
  header[11] = 0x54;

  const out = new Uint8Array(14 + data.length + 2);
  out.set(header, 0);
  out.set(data, 14);
  return out;
}

describe("Routes API, FIT GPS Extraction, and Strava VirtualRide Tagging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires UI auth, lists presets, imports GPX to R2/D1, fetches geometry, and deletes user routes", async () => {
    const unauth = await exports.default.fetch("https://paincave.test/api/routes");
    expect(unauth.status).toBe(401);

    const cookie = await loginCookie();

    // Presets present initially
    const list0 = await exports.default.fetch("https://paincave.test/api/routes", {
      headers: { Cookie: cookie },
    });
    expect(list0.status).toBe(200);
    const list0Body = await list0.json<{ routes: { id: string; is_preset: boolean }[] }>();
    expect(list0Body.routes.some((r) => r.id === "preset-alpine-climb" && r.is_preset)).toBe(true);

    // Preset geometry fetch
    const presetRes = await exports.default.fetch(
      "https://paincave.test/api/routes/preset-alpine-climb",
      { headers: { Cookie: cookie } }
    );
    expect(presetRes.status).toBe(200);
    const presetBody = await presetRes.json<{ points: { lat_deg: number }[] }>();
    expect(presetBody.points.length).toBeGreaterThan(20);

    // Upload GPX
    const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk><name>Col du Test</name><trkseg>
    <trkpt lat="45.1000" lon="6.1000"><ele>900</ele></trkpt>
    <trkpt lat="45.1010" lon="6.1000"><ele>909</ele></trkpt>
    <trkpt lat="45.1020" lon="6.1000"><ele>918</ele></trkpt>
  </trkseg></trk>
</gpx>`;

    const createRes = await exports.default.fetch("https://paincave.test/api/routes/gpx", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ gpx_xml: gpxXml }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json<{
      route: { id: string; name: string; distance_m: number; total_ascent_m: number };
      points: { lat_deg: number; lon_deg: number; elevation_m: number }[];
    }>();
    expect(created.route.name).toBe("Col du Test");
    expect(created.route.distance_m).toBeGreaterThan(200);
    expect(created.points).toHaveLength(3);

    // Fetch saved route back
    const getRes = await exports.default.fetch(
      `https://paincave.test/api/routes/${created.route.id}`,
      { headers: { Cookie: cookie } }
    );
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json<{ points: { lat_deg: number }[] }>();
    expect(fetched.points).toHaveLength(3);

    // Cannot delete preset
    const delPreset = await exports.default.fetch(
      "https://paincave.test/api/routes/preset-alpine-climb",
      { method: "DELETE", headers: { Cookie: cookie } }
    );
    expect(delPreset.status).toBe(400);

    // Delete user route
    const delRes = await exports.default.fetch(
      `https://paincave.test/api/routes/${created.route.id}`,
      { method: "DELETE", headers: { Cookie: cookie } }
    );
    expect(delRes.status).toBe(200);
  });

  it("extracts a route from an uploaded FIT ride and tags virtual FIT uploads as VirtualRide on Strava", async () => {
    const cookie = await loginCookie();

    // Seed valid Strava OAuth token so uploadFitToStrava triggers
    const futureExp = Math.floor(Date.now() / 1000) + 7200;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, athlete_external_id, updated_at)
       VALUES ('strava', 'strava-virtual-token', 'ref-1', ?, 'activity:write,read', '12345', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
    )
      .bind(futureExp)
      .run();

    let capturedSportType: string | null = null;
    let capturedTrainer: string | null = null;
    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://www.strava.com/api/v3/uploads") {
        if (init?.body instanceof FormData) {
          const st = init.body.get("sport_type");
          const tr = init.body.get("trainer");
          capturedSportType = typeof st === "string" ? st : null;
          capturedTrainer = typeof tr === "string" ? tr : null;
        }
        return Response.json({ id_str: "7777", activity_id: 8888, status: "ready", error: null });
      }
      return originalFetch(input, init);
    });

    const rideUuid = "550e8400-e29b-41d4-a716-446655440777";
    const today = new Date().toISOString().slice(0, 10);
    const summary = {
      ride_uuid: rideUuid,
      name: "HC Virtual Climb",
      source: "indoor_bridge" as const,
      started_at: `${today}T12:00:00Z`,
      ride_day: today,
      duration_s: goldenRide.expected.duration_s,
      elapsed_s: goldenRide.expected.elapsed_s,
      work_kj: goldenRide.expected.work_kj,
      avg_power: goldenRide.expected.avg_power,
      np_watts: goldenRide.expected.np_watts,
      intensity_factor: goldenRide.expected.intensity_factor,
      tss: goldenRide.expected.tss,
      variability_index: goldenRide.expected.variability_index,
      avg_hr: goldenRide.expected.avg_hr,
      max_hr: goldenRide.expected.max_hr,
      efficiency_factor: goldenRide.expected.efficiency_factor,
      pw_hr_decoupling: goldenRide.expected.pw_hr_decoupling,
      hrr_60s: goldenRide.expected.hrr_60s,
      time_gt_90_hrmax_s: goldenRide.expected.time_gt_90_hrmax_s,
      avg_cadence: goldenRide.expected.avg_cadence,
      compliance_pct: 95,
      power_zones: goldenRide.expected.power_zones,
      hr_zones: goldenRide.expected.hr_zones,
      quality_flags: goldenRide.expected.quality_flags,
      ftp_snapshot: goldenRide.thresholds.ftp_watts,
      notes: "SIM climb test",
      intervals: [],
      peaks: [],
    };

    const form = new FormData();
    form.append("summary", JSON.stringify(summary));
    form.append(
      "fit",
      new Blob([buildVirtualGpsFitBytes()], { type: "application/vnd.ant.fit" }),
      "virtual.fit"
    );

    const upRes = await exports.default.fetch("https://paincave.test/api/rides", {
      method: "POST",
      headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" },
      body: form,
    });
    expect(upRes.status).toBe(201);

    // Retry synchronously so Strava upload runs deterministically
    const retryRes = await exports.default.fetch(
      `https://paincave.test/api/strava/retry/${rideUuid}`,
      { method: "POST", headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" } }
    );
    expect(retryRes.status).toBe(200);
    expect(capturedSportType).toBe("VirtualRide");
    expect(capturedTrainer).toBe("1");

    // Extract GPS track into reusable route
    const extractRes = await exports.default.fetch(
      `https://paincave.test/api/routes/from-ride/${rideUuid}`,
      { method: "POST", headers: { Cookie: cookie } }
    );
    expect(extractRes.status).toBe(201);
    const extracted = await extractRes.json<{
      route: { source: string; total_ascent_m: number };
      points: { lat_deg: number }[];
    }>();
    expect(extracted.route.source).toBe("fit_extract");
    expect(extracted.points).toHaveLength(3);
    expect(extracted.route.total_ascent_m).toBeGreaterThan(10);
  });
});
