import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";
import { GARMIN_PERSONAL_API_BASE } from "../src/lib/garmin-client.js";
import { syncGarminUser } from "../src/lib/garmin-sync.js";
import { unwrapFitZipBytes } from "../src/lib/zip-fit.js";
import { createTestSession } from "./auth-helper.js";

const testEnv = env as typeof env & { ALLOWED_USER_EMAILS?: string };

function buildRunFitBytes(): Uint8Array {
  const bytes: number[] = [];
  const pushU16 = (v: number) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  const pushU32 = (v: number) =>
    bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  for (let i = 0; i < 14; i++) bytes.push(0);

  // Session msg 18: start_time(2,4), sport(5,1)=1(running), total_timer_time(8,4), total_distance(9,4), total_ascent(22,2)
  bytes.push(0x40, 0, 0);
  pushU16(18);
  bytes.push(5);
  bytes.push(2, 4, 0x86, 5, 1, 0x00, 8, 4, 0x86, 9, 4, 0x86, 22, 2, 0x84);
  bytes.push(0x00);
  pushU32(1_150_000_000);
  bytes.push(1);
  pushU32(1_500_000);
  pushU32(500_000);
  pushU16(45);

  // Lap msg 19: total_timer_time(8,4), total_distance(9,4), avg_heart_rate(15,1)
  bytes.push(0x41, 0, 0);
  pushU16(19);
  bytes.push(3);
  bytes.push(8, 4, 0x86, 9, 4, 0x86, 15, 1, 0x02);
  bytes.push(0x01);
  pushU32(300_000);
  pushU32(100_000);
  bytes.push(158);

  const dataSize = bytes.length - 14;
  bytes[0] = 14;
  bytes[1] = 0x20;
  bytes[4] = dataSize & 0xff;
  bytes[5] = (dataSize >> 8) & 0xff;
  bytes[6] = (dataSize >> 16) & 0xff;
  bytes[7] = (dataSize >>> 24) & 0xff;
  bytes[8] = 0x2e;
  bytes[9] = 0x46;
  bytes[10] = 0x49;
  bytes[11] = 0x54;
  bytes.push(0, 0);
  return new Uint8Array(bytes);
}

describe("Garmin Connect Personal API Sync & Encrypted Credentials", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    testEnv.ALLOWED_USER_EMAILS = undefined;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM daily_biometrics"),
      env.DB.prepare("DELETE FROM provider_connections WHERE provider = 'garmin_personal'"),
      env.DB.prepare("DELETE FROM activity_laps"),
      env.DB.prepare("DELETE FROM rides WHERE external_provider = 'garmin_personal'"),
      env.DB.prepare("DELETE FROM daily_pmc"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ]);
  });

  it("unwraps Garmin streaming bit-3 data-descriptor ZIP archives (local compSize = 0)", async () => {
    const fitBytes = buildRunFitBytes();
    const cs = new CompressionStream("deflate-raw");
    const w = cs.writable.getWriter();
    void w.write(fitBytes).then(() => w.close());
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());

    const fileName = new TextEncoder().encode("24992576207_ACTIVITY.fit");
    const parts: number[] = [];
    const pushU16 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff);
    const pushU32 = (v: number) =>
      parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);

    // Local File Header with bit-3 data descriptor flag (0x0808) and compSize = 0
    pushU32(0x04034b50);
    pushU16(20);
    pushU16(0x0808);
    pushU16(8); // deflate
    pushU16(0);
    pushU16(0);
    pushU32(0); // crc in descriptor
    pushU32(0); // compSize = 0 in local header!
    pushU32(0); // uncompSize = 0 in local header!
    pushU16(fileName.length);
    pushU16(0);
    parts.push(...fileName, ...compressed);
    // Data descriptor
    pushU32(0x08074b50);
    pushU32(0);
    pushU32(compressed.length);
    pushU32(fitBytes.length);

    const cdOffset = parts.length;
    // Central Directory Header (has real compressed & uncompressed sizes)
    pushU32(0x02014b50);
    pushU16(20);
    pushU16(20);
    pushU16(0x0808);
    pushU16(8);
    pushU16(0);
    pushU16(0);
    pushU32(0);
    pushU32(compressed.length);
    pushU32(fitBytes.length);
    pushU16(fileName.length);
    pushU16(0);
    pushU16(0);
    pushU16(0);
    pushU16(0);
    pushU32(0);
    pushU32(0); // local header offset
    parts.push(...fileName);
    const cdSize = parts.length - cdOffset;

    // End of Central Directory
    pushU32(0x06054b50);
    pushU16(0);
    pushU16(0);
    pushU16(1);
    pushU16(1);
    pushU32(cdSize);
    pushU32(cdOffset);
    pushU16(0);

    const extracted = await unwrapFitZipBytes(new Uint8Array(parts));
    expect(extracted).toEqual(fitBytes);
  });

  it("encrypts and decrypts Garmin Personal API keys with AES-256-GCM", async () => {
    const secret = "test-master-secret-0123456789abcdef";
    const enc = await encryptSecret("garmin-personal-key-xyz-9999", secret);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain("garmin-personal-key");
    expect(await decryptSecret(enc, secret)).toBe("garmin-personal-key-xyz-9999");
  });

  it("connects Garmin key, caches 24h JWT, imports running FIT + laps + daily HRV/sleep idempotently, and handles 429 cleanly", async () => {
    testEnv.ALLOWED_USER_EMAILS = "runner@example.com";
    const cookie = await createTestSession("Runner", "runner@example.com");

    const today = new Date().toISOString().slice(0, 10);
    let tokenCalls = 0;
    let fitCalls = 0;
    let simulateRateLimit = false;

    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === `${GARMIN_PERSONAL_API_BASE}/personalapitoken-service/personal-api/personal-api-key/token`) {
        tokenCalls++;
        const hdrs = new Headers(init?.headers);
        expect(hdrs.get("Authorization")).toBe("ApiKey garmin-live-test-key-123456");
        // Regression guard: Garmin Personal API rejects Accept: application/json with HTTP 406
        if (hdrs.get("Accept") === "application/json") {
          return new Response('{"error":"NotAcceptableException"}', { status: 406 });
        }
        const exp = Math.floor(Date.now() / 1000) + 86400;
        const payloadB64 = btoa(JSON.stringify({ sub: "garmin-user", exp })).replace(/=/g, "");
        return new Response(`eyJhbGciOiJSUzI1NiJ9.${payloadB64}.sig`, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/activitylist-service/activities/search/activities`)) {
        if (simulateRateLimit) {
          return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "60" } });
        }
        return Response.json([
          {
            activityId: 90012345,
            activityName: "Morning 5K Progression",
            activityType: { typeKey: "running" },
            startTimeGMT: `${today} 07:30:00`,
            duration: 1500,
            distance: 5000,
            elevationGain: 45,
            averageHR: 158,
            maxHR: 176,
            averageRunningCadenceInStepsPerMinute: 176,
          },
        ]);
      }

      if (url === `${GARMIN_PERSONAL_API_BASE}/download-service/files/activity/90012345`) {
        fitCalls++;
        return new Response(buildRunFitBytes(), { status: 200 });
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/usersummary-service/v2/dailysummaries`)) {
        return Response.json([
          {
            calendarDate: today,
            restingHeartRate: 48,
            totalSteps: 11200,
            averageStressLevel: 24,
            bodyBatteryHighestValue: 94,
            bodyBatteryLowestValue: 41,
          },
        ]);
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/hrv-service/hrv/daily/`)) {
        return Response.json({
          hrvSummaries: [{ calendarDate: today, lastNightAvg: 66, status: "BALANCED" }],
        });
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/sleep-service/sleep/dailySleepSummariesByDate`)) {
        return Response.json([
          {
            calendarDate: today,
            sleepTimeSeconds: 28800,
            deepSleepSeconds: 5400,
            remSleepSeconds: 6600,
            sleepScores: { overall: { value: 88 } },
          },
        ]);
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/wellness-service/wellness/bodyBattery/reports/daily`)) {
        return Response.json([
          {
            date: today,
            charged: 62,
            bodyBatteryValuesArray: [
              [1700000000000, 41],
              [1700028800000, 94],
            ],
          },
        ]);
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/weight-service/weight/range/`)) {
        return Response.json({
          dailyWeightSummaries: [{ summaryDate: today, latestWeight: { weight: 64500 } }],
        });
      }

      return originalFetch(input, init);
    });

    // 1. Connect Garmin Personal API key
    const connRes = await exports.default.fetch("https://paincave.test/api/garmin/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ api_key: "garmin-live-test-key-123456" }),
    });
    expect(connRes.status).toBe(200);
    expect(tokenCalls).toBe(1);

    // 2. First sync reuses cached 24h JWT, downloads FIT once, stores run + laps + biometrics
    const sync1 = await (
      await exports.default.fetch("https://paincave.test/api/garmin/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ days: 2 }),
      })
    ).json<{ ok: boolean; activities_imported: number; biometrics_upserted: number }>();
    expect(sync1.ok).toBe(true);
    expect(sync1.activities_imported).toBe(1);
    expect(sync1.biometrics_upserted).toBe(1);
    expect(tokenCalls).toBe(1); // JWT cached!
    expect(fitCalls).toBe(1);

    // 3. Second sync skips duplicate without re-downloading FIT
    const sync2 = await (
      await exports.default.fetch("https://paincave.test/api/garmin/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ days: 2 }),
      })
    ).json<{ ok: boolean; activities_imported: number; activities_skipped: number }>();
    expect(sync2.ok).toBe(true);
    expect(sync2.activities_imported).toBe(0);
    expect(sync2.activities_skipped).toBe(1);
    expect(fitCalls).toBe(1);

    // 4. Verify run + lap + biometrics endpoints
    const ridesBody = await (
      await exports.default.fetch("https://paincave.test/api/rides?sport=running", {
        headers: { Cookie: cookie },
      })
    ).json<{ rides: { ride_uuid: string; sport: string; distance_m: number }[] }>();
    expect(ridesBody.rides).toHaveLength(1);
    expect(ridesBody.rides[0]?.sport).toBe("running");
    expect(ridesBody.rides[0]?.distance_m).toBe(5000);

    const detailBody = await (
      await exports.default.fetch(
        `https://paincave.test/api/rides/${ridesBody.rides[0]!.ride_uuid}`,
        { headers: { Cookie: cookie } }
      )
    ).json<{ laps: { lap_index: number; avg_hr: number }[] }>();
    expect(detailBody.laps).toHaveLength(1);
    expect(detailBody.laps[0]?.avg_hr).toBe(158);

    const bioBody = await (
      await exports.default.fetch("https://paincave.test/api/fitness/biometrics?days=14", {
        headers: { Cookie: cookie },
      })
    ).json<{
      biometrics: { day: string; hrv_rmssd_ms: number; sleep_score: number; resting_hr_bpm: number }[];
    }>();
    expect(bioBody.biometrics).toHaveLength(1);
    expect(bioBody.biometrics[0]?.hrv_rmssd_ms).toBe(66);
    expect(bioBody.biometrics[0]?.sleep_score).toBe(88);
    expect(bioBody.biometrics[0]?.resting_hr_bpm).toBe(48);

    // 5. Explicit historical date-range sync works for chunked backfill
    const rangeRes = await exports.default.fetch("https://paincave.test/api/garmin/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        start_date: today,
        end_date: today,
        skip_pmc_recompute: true,
      }),
    });
    expect(rangeRes.status).toBe(200);
    const rangeBody = await rangeRes.json<{
      ok: boolean;
      start_date: string;
      end_date: string;
      activities_skipped: number;
    }>();
    expect(rangeBody.ok).toBe(true);
    expect(rangeBody.start_date).toBe(today);
    expect(rangeBody.end_date).toBe(today);
    expect(rangeBody.activities_skipped).toBe(1);

    // 6. Graceful 429 rate-limit handling
    simulateRateLimit = true;
    const sync429 = await exports.default.fetch("https://paincave.test/api/garmin/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ days: 2 }),
    });
    expect(sync429.status).toBe(429);
    const statusAfter = await (
      await exports.default.fetch("https://paincave.test/api/garmin/status", {
        headers: { Cookie: cookie },
      })
    ).json<{ connected: boolean; last_error: string | null }>();
    expect(statusAfter.connected).toBe(true);
    expect(statusAfter.last_error).toContain("429");
  });

  it("parses Garmin v2 nested dailysummaries, skips redundant bodyBattery and empty rows, and paginates max_activities", async () => {
    testEnv.ALLOWED_USER_EMAILS = "v2-athlete@example.com";
    const cookie = await createTestSession("V2 Athlete", "v2-athlete@example.com");

    const today = new Date().toISOString().slice(0, 10);
    const yesterdayDt = new Date();
    yesterdayDt.setUTCDate(yesterdayDt.getUTCDate() - 1);
    const yesterday = yesterdayDt.toISOString().slice(0, 10);

    let bodyBatteryCalls = 0;
    let hrvCalls = 0;
    let sleepCalls = 0;

    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === `${GARMIN_PERSONAL_API_BASE}/personalapitoken-service/personal-api/personal-api-key/token`) {
        const exp = Math.floor(Date.now() / 1000) + 86400;
        const payloadB64 = btoa(JSON.stringify({ sub: "garmin-v2", exp })).replace(/=/g, "");
        return new Response(`eyJhbGciOiJSUzI1NiJ9.${payloadB64}.sig`, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/activitylist-service/activities/search/activities`)) {
        return Response.json([
          {
            activityId: 9100001,
            activityName: "Morning Run 1",
            activityType: { typeKey: "running" },
            startTimeGMT: `${today} 07:00:00`,
            duration: 1500,
            distance: 5000,
          },
          {
            activityId: 9100002,
            activityName: "Afternoon Run 2",
            activityType: { typeKey: "running" },
            startTimeGMT: `${today} 16:00:00`,
            duration: 1500,
            distance: 5000,
          },
        ]);
      }

      if (
        url === `${GARMIN_PERSONAL_API_BASE}/download-service/files/activity/9100001` ||
        url === `${GARMIN_PERSONAL_API_BASE}/download-service/files/activity/9100002`
      ) {
        return new Response(buildRunFitBytes(), { status: 200 });
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/usersummary-service/v2/dailysummaries`)) {
        return Response.json({
          data: [
            {
              calendarDate: yesterday,
              heartRate: { restingValue: 49 },
              movement: { steps: 9850 },
              stress: { avgLevel: 26 },
              bodyBattery: { maxValue: 91, minValue: 22, chargedValue: 64 },
            },
            {
              // Empty skeleton row without any metric values must be ignored
              calendarDate: today,
            },
          ],
        });
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/hrv-service/hrv/daily/`)) {
        hrvCalls++;
        return Response.json({ hrvSummaries: [] });
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/sleep-service/sleep/dailySleepSummariesByDate`)) {
        sleepCalls++;
        return Response.json({
          dailySleepDTO: {
            calendarDate: yesterday,
            sleepTimeSeconds: 27000,
            sleepScores: { overall: { value: 83 } },
          },
        });
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/wellness-service/wellness/bodyBattery/reports/daily`)) {
        bodyBatteryCalls++;
        return Response.json([]);
      }

      if (url.startsWith(`${GARMIN_PERSONAL_API_BASE}/weight-service/weight/range/`)) {
        return Response.json({ dailyWeightSummaries: [] });
      }

      return originalFetch(input, init);
    });

    await exports.default.fetch("https://paincave.test/api/garmin/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ api_key: "garmin-v2-test-key-123456" }),
    });

    const userRow = await env.DB.prepare("SELECT id FROM user ORDER BY createdAt DESC LIMIT 1").first<{
      id: string;
    }>();
    const userId = userRow!.id;

    // Pre-insert a legacy all-null row for today (simulating prior buggy import)
    await env.DB.prepare(
      `INSERT INTO daily_biometrics (user_id, day, source) VALUES (?, ?, 'garmin_personal')`
    )
      .bind(userId, today)
      .run();

    // Page 1: cap at maxActivities = 1
    const page1 = await syncGarminUser(testEnv, userId, {
      startDate: yesterday,
      endDate: today,
      maxActivities: 1,
      includeBiometrics: true,
      skipPmcRecompute: true,
      requestDelayMs: 0,
    });

    expect(page1.ok).toBe(true);
    expect(page1.activities_imported).toBe(1);
    expect(page1.has_more).toBe(true);
    expect(page1.remaining_activities).toBe(1);
    expect(page1.biometrics_upserted).toBe(1); // Only yesterday; empty today skeleton was filtered out
    expect(bodyBatteryCalls).toBe(0); // Skipped because v2 dailysummaries supplied bodyBattery.maxValue

    // Page 2: import remaining activity without re-calling biometrics
    const page2 = await syncGarminUser(testEnv, userId, {
      startDate: yesterday,
      endDate: today,
      maxActivities: 1,
      includeBiometrics: false,
      skipPmcRecompute: true,
      requestDelayMs: 0,
    });
    expect(page2.ok).toBe(true);
    expect(page2.activities_imported).toBe(1);
    expect(page2.activities_skipped).toBe(1);
    expect(page2.has_more).toBe(false);
    expect(page2.remaining_activities).toBe(0);
    expect(hrvCalls).toBe(1);
    expect(sleepCalls).toBe(1);

    // Biometrics baseline ignores the pre-existing all-null row for today and surfaces yesterday's populated values
    const bioRes = await exports.default.fetch("https://paincave.test/api/fitness/biometrics?days=14", {
      headers: { Cookie: cookie },
    });
    const bioBody = await bioRes.json<{
      summary: {
        latest: { day: string; resting_hr_bpm: number; body_battery_high: number; sleep_score: number } | null;
        resting_hr_7d_avg: number | null;
        sleep_score_7d_avg: number | null;
      };
    }>();
    expect(bioBody.summary.latest?.day).toBe(yesterday);
    expect(bioBody.summary.latest?.resting_hr_bpm).toBe(49);
    expect(bioBody.summary.latest?.body_battery_high).toBe(91);
    expect(bioBody.summary.latest?.sleep_score).toBe(83);
    expect(bioBody.summary.resting_hr_7d_avg).toBe(49);
    expect(bioBody.summary.sleep_score_7d_avg).toBe(83);
  });
});
