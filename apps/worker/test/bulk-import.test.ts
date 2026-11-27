import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { buildArchiveActivityItem } from "@paincave/shared";

const testEnv = env as typeof env & { ALLOWED_USER_EMAILS?: string };

function extractSessionCookie(headers: Headers): string {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie ? getSetCookie.call(headers) : [headers.get("Set-Cookie") ?? ""];
  return cookies
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("better-auth.session_token="))
    .join("; ");
}

describe("Bulk Archive Import API, Multi-Year PMC Rebuild & History MCP Tool", () => {
  afterEach(async () => {
    testEnv.ALLOWED_USER_EMAILS = undefined;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_device_tokens"),
      env.DB.prepare("DELETE FROM daily_biometrics"),
      env.DB.prepare("DELETE FROM daily_pmc"),
      env.DB.prepare("DELETE FROM activity_laps"),
      env.DB.prepare("DELETE FROM ride_peaks"),
      env.DB.prepare("DELETE FROM rides"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ]);
  });

  it("imports multi-year archive batches idempotently via importer token, rebuilds PMC, and serves get_training_history_summary", async () => {
    testEnv.ALLOWED_USER_EMAILS = "owner@example.com";
    const signUp = await exports.default.fetch("https://paincave.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://paincave.test" },
      body: JSON.stringify({
        name: "Owner",
        email: "owner@example.com",
        password: "strong-password-123",
      }),
    });
    expect(signUp.status).toBe(200);
    const cookie = extractSessionCookie(signUp.headers);

    // Mint per-user importer token & MCP token
    const impTokRes = await exports.default.fetch("https://paincave.test/api/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ label: "Local Archive CLI", scope: "importer" }),
    });
    expect(impTokRes.status).toBe(201);
    const { token: importerToken } = await impTokRes.json<{ token: string }>();

    const mcpTokRes = await exports.default.fetch("https://paincave.test/api/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ label: "MCP", scope: "mcp" }),
    });
    const { token: mcpToken } = await mcpTokRes.json<{ token: string }>();

    const batchPayload = {
      source: "strava_archive",
      activities: [
        buildArchiveActivityItem({
          rideUuid: "550e8400-e29b-41d4-a716-446655442024",
          externalProvider: "strava_archive",
          externalId: "strava-2024-1",
          name: "2024 Base Ride",
          startedAt: "2024-06-15T12:00:00Z",
          sport: "cycling",
          durationS: 5400,
          distanceM: 48000,
          avgPower: 215,
          avgHr: 148,
        }),
        buildArchiveActivityItem({
          rideUuid: "550e8400-e29b-41d4-a716-446655442026",
          externalProvider: "strava_archive",
          externalId: "strava-2026-1",
          name: "2026 Tempo 10K",
          startedAt: "2026-09-10T11:00:00Z",
          sport: "running",
          durationS: 2700,
          distanceM: 10000,
          avgHr: 162,
          thresholdPaceSPerKm: 270,
        }),
      ],
      biometrics: [
        { day: "2026-09-10", hrv_rmssd_ms: 58, resting_hr_bpm: 50, sleep_score: 82 },
      ],
    };

    // 1. First import succeeds
    const imp1 = await (
      await exports.default.fetch("https://paincave.test/api/import/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Importer-Token": importerToken },
        body: JSON.stringify(batchPayload),
      })
    ).json<{ ok: boolean; imported: number; skipped: number; biometrics_upserted: number }>();
    expect(imp1).toEqual({ ok: true, imported: 2, skipped: 0, biometrics_upserted: 1 });

    // 2. Re-sending same external_ids with fresh ride_uuids skips duplicates idempotently
    const dupPayload = {
      ...batchPayload,
      activities: batchPayload.activities.map((a, idx) => ({
        ...a,
        summary: {
          ...a.summary,
          ride_uuid: `550e8400-e29b-41d4-a716-44665544990${idx}`,
        },
      })),
    };
    const imp2 = await (
      await exports.default.fetch("https://paincave.test/api/import/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Importer-Token": importerToken },
        body: JSON.stringify(dupPayload),
      })
    ).json<{ ok: boolean; imported: number; skipped: number }>();
    expect(imp2.imported).toBe(0);
    expect(imp2.skipped).toBe(2);

    // 3. Multi-year PMC rebuild succeeds
    const pmcRes = await (
      await exports.default.fetch("https://paincave.test/api/import/rebuild-pmc", {
        method: "POST",
        headers: { "X-Importer-Token": importerToken },
      })
    ).json<{ ok: boolean; days_computed: number; earliest_day: string }>();
    expect(pmcRes.ok).toBe(true);
    expect(pmcRes.earliest_day).toBe("2024-06-15");
    expect(pmcRes.days_computed).toBeGreaterThan(100);

    // 4. MCP get_training_history_summary returns compact multi-year rollups
    const histRes = await (
      await exports.default.fetch("https://paincave.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_training_history_summary", arguments: { years: 5 } },
        }),
      })
    ).json<{
      result: {
        isError: boolean;
        structuredContent: {
          total_activities: number;
          yearly_rollups: { year: string; sport: string; sessions: number }[];
        };
      };
    }>();
    expect(histRes.result.isError).toBe(false);
    expect(histRes.result.structuredContent.total_activities).toBe(2);
    expect(histRes.result.structuredContent.yearly_rollups.length).toBe(2);
  });
});
