import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import goldenRide from "../../../packages/shared/fixtures/golden-ride.json" with { type: "json" };

const testEnv = env as typeof env & { PUBLIC_APP_URL?: string };

async function loginCookie(): Promise<string> {
  const res = await exports.default.fetch("https://paincave.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "paincave-test-pw" }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

describe("Strava Outbound OAuth & Background FIT Upload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enforces single-use CSRF state on /connect -> /callback, refreshes expired tokens, and uploads FIT idempotently", async () => {
    const cookie = await loginCookie();

    // 1. Initial status shows configured=true, connected=false
    const status0 = await exports.default.fetch("https://paincave.test/api/strava/status", {
      headers: { Cookie: cookie },
    });
    expect(status0.status).toBe(200);
    const status0Body = await status0.json<{ configured: boolean; connected: boolean }>();
    expect(status0Body.configured).toBe(true);
    expect(status0Body.connected).toBe(false);

    // 2. Connect issues 302 with single-use CSRF state
    const connectRes = await exports.default.fetch("https://paincave.test/api/strava/connect", {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    expect(connectRes.status).toBe(302);
    const location = connectRes.headers.get("Location");
    expect(location).toBeTruthy();
    const authUrl = new URL(location ?? "");
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://www.strava.com/oauth/authorize");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "https://paincave.test/api/strava/callback"
    );
    const stateNonce = authUrl.searchParams.get("state") ?? "";
    expect(stateNonce.length).toBeGreaterThanOrEqual(24);

    // Reject forged state
    const badState = await exports.default.fetch(
      "https://paincave.test/api/strava/callback?code=fake-code&state=forged-state",
      { redirect: "manual" }
    );
    expect(badState.status).toBe(400);

    // Mock Strava API fetch endpoints (token exchange, refresh, upload)
    let tokenCalls = 0;
    let refreshCalls = 0;
    let uploadCalls = 0;
    let lastUploadAuth = "";
    let lastUploadFormType = "";

    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://www.strava.com/oauth/token") {
        tokenCalls += 1;
        const params =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        const grantType = params.get("grant_type");

        if (grantType === "authorization_code") {
          return Response.json({
            access_token: "strava-expired-access",
            refresh_token: "strava-refresh-1",
            // Expired already to exercise auto-refresh path during ride upload
            expires_at: Math.floor(Date.now() / 1000) - 10,
            scope: "activity:write,read",
            athlete: { id: 987654 },
          });
        }

        if (grantType === "refresh_token") {
          refreshCalls += 1;
          return Response.json({
            access_token: "strava-fresh-access-2",
            refresh_token: "strava-refresh-2",
            expires_at: Math.floor(Date.now() / 1000) + 21600,
            scope: "activity:write,read",
          });
        }
      }

      if (url === "https://www.strava.com/api/v3/uploads") {
        uploadCalls += 1;
        const headers = new Headers(init?.headers);
        lastUploadAuth = headers.get("Authorization") ?? "";
        if (init?.body instanceof FormData) {
          const dt = init.body.get("data_type");
          lastUploadFormType = typeof dt === "string" ? dt : "";
        }
        return Response.json({
          id: 424242,
          id_str: "424242",
          activity_id: 999888,
          status: "Your activity is ready.",
          error: null,
        });
      }

      return originalFetch(input, init);
    });

    // 3. Valid callback exchanges code and redirects to /?strava=connected
    const cbRes = await exports.default.fetch(
      `https://paincave.test/api/strava/callback?code=auth-code-123&state=${encodeURIComponent(stateNonce)}`,
      { redirect: "manual" }
    );
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("Location")).toBe("/?strava=connected");
    expect(tokenCalls).toBe(1);

    // Replaying the same CSRF state fails (400)
    const replayCb = await exports.default.fetch(
      `https://paincave.test/api/strava/callback?code=auth-code-123&state=${encodeURIComponent(stateNonce)}`,
      { redirect: "manual" }
    );
    expect(replayCb.status).toBe(400);

    // Status now reports connected
    const status1 = await exports.default.fetch("https://paincave.test/api/strava/status", {
      headers: { Cookie: cookie },
    });
    const status1Body = await status1.json<{
      connected: boolean;
      athlete_external_id: string | null;
    }>();
    expect(status1Body.connected).toBe(true);
    expect(status1Body.athlete_external_id).toBe("987654");

    // 4. Ride upload triggers background token refresh + multipart .fit upload via waitUntil
    const rideUuid = "550e8400-e29b-41d4-a716-446655440099";
    const today = new Date().toISOString().slice(0, 10);
    const summary = {
      ride_uuid: rideUuid,
      name: "Strava Auto Upload Verification Ride",
      source: "indoor_bridge" as const,
      started_at: `${today}T14:00:00Z`,
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
      compliance_pct: 98.2,
      power_zones: goldenRide.expected.power_zones,
      hr_zones: goldenRide.expected.hr_zones,
      quality_flags: goldenRide.expected.quality_flags,
      ftp_snapshot: goldenRide.thresholds.ftp_watts,
      lthr_snapshot: goldenRide.thresholds.lthr_bpm,
      hrmax_snapshot: goldenRide.thresholds.hrmax_bpm,
      weight_kg_snapshot: goldenRide.thresholds.weight_kg,
      notes: "Uploaded by automated Strava test",
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

    const upRes = await exports.default.fetch("https://paincave.test/api/rides", {
      method: "POST",
      headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" },
      body: makeForm(),
    });
    expect(upRes.status).toBe(201);

    // Wait for ctx.waitUntil(uploadFitToStrava(...)) to flush in D1
    let rideDetail: {
      strava_upload_status: string;
      strava_upload_id: string | null;
      strava_activity_id: string | null;
    } | null = null;
    for (let i = 0; i < 40; i += 1) {
      const detailRes = await exports.default.fetch(`https://paincave.test/api/rides/${rideUuid}`, {
        headers: { Cookie: cookie },
      });
      if (detailRes.ok) {
        const body = await detailRes.json<{
          ride: {
            strava_upload_status: string;
            strava_upload_id: string | null;
            strava_activity_id: string | null;
          };
        }>();
        if (body.ride.strava_upload_status === "uploaded") {
          rideDetail = body.ride;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(refreshCalls).toBe(1);
    expect(uploadCalls).toBe(1);
    expect(lastUploadAuth).toBe("Bearer strava-fresh-access-2");
    expect(lastUploadFormType).toBe("fit");
    expect(rideDetail?.strava_upload_status).toBe("uploaded");
    expect(rideDetail?.strava_upload_id).toBe("424242");
    expect(rideDetail?.strava_activity_id).toBe("999888");

    // Duplicate idempotent POST /api/rides must NOT trigger another Strava upload
    const dupRes = await exports.default.fetch("https://paincave.test/api/rides", {
      method: "POST",
      headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" },
      body: makeForm(),
    });
    expect(dupRes.status).toBe(200);
    expect(uploadCalls).toBe(1);

    // Explicit manual retry endpoint triggers Strava upload synchronously without extra refresh
    const retryRes = await exports.default.fetch(
      `https://paincave.test/api/strava/retry/${rideUuid}`,
      {
        method: "POST",
        headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" },
      }
    );
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json<{ status: string; upload_id: string | null }>();
    expect(retryBody.status).toBe("uploaded");
    expect(retryBody.upload_id).toBe("424242");
    expect(refreshCalls).toBe(1);
    expect(uploadCalls).toBe(2);
  });

  it("uses the configured public app URL for the Strava callback", async () => {
    const cookie = await loginCookie();
    const previousPublicAppUrl = testEnv.PUBLIC_APP_URL;
    testEnv.PUBLIC_APP_URL = "https://paincave.example.workers.dev";

    try {
      const connectRes = await exports.default.fetch(
        "http://127.0.0.1:8787/api/strava/connect",
        { headers: { Cookie: cookie }, redirect: "manual" }
      );
      expect(connectRes.status).toBe(302);
      const authUrl = new URL(connectRes.headers.get("Location") ?? "");
      expect(authUrl.searchParams.get("redirect_uri")).toBe(
        "https://paincave.example.workers.dev/api/strava/callback"
      );
    } finally {
      testEnv.PUBLIC_APP_URL = previousPublicAppUrl;
    }
  });

  it("returns 500 if PUBLIC_APP_URL is malformed", async () => {
    const cookie = await loginCookie();
    const previousPublicAppUrl = testEnv.PUBLIC_APP_URL;
    testEnv.PUBLIC_APP_URL = "not-a-valid-url";

    try {
      const connectRes = await exports.default.fetch(
        "https://paincave.test/api/strava/connect",
        { headers: { Cookie: cookie }, redirect: "manual" }
      );
      expect(connectRes.status).toBe(500);
    } finally {
      testEnv.PUBLIC_APP_URL = previousPublicAppUrl;
    }
  });

  it("allows the trainer bridge to start Strava OAuth", async () => {
    const res = await exports.default.fetch(
      "https://paincave.test/api/strava/connect?mode=json",
      { headers: { "X-Bridge-Token": env.BRIDGE_DEVICE_TOKEN ?? "" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ authorize_url: string }>();
    const authUrl = new URL(body.authorize_url);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
      "https://www.strava.com/oauth/authorize"
    );
  });
});
