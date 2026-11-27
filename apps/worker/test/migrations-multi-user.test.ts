import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

describe("Migration 0005 (Multi-User & Unified Health Schema)", () => {
  afterEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM daily_biometrics WHERE user_id IN ('u_a', 'u_b')"),
      env.DB.prepare("DELETE FROM activity_laps WHERE user_id IN ('u_a', 'u_b')"),
      env.DB.prepare("DELETE FROM user_device_tokens WHERE user_id IN ('u_a', 'u_b')"),
      env.DB.prepare("DELETE FROM provider_connections WHERE user_id IN ('u_a', 'u_b')"),
      env.DB.prepare("DELETE FROM daily_pmc WHERE user_id IN ('u_a', 'u_b')"),
      env.DB.prepare("DELETE FROM athlete_thresholds WHERE user_id IN ('u_a', 'u_b')"),
      env.DB.prepare("DELETE FROM athlete_profile WHERE user_id IN ('u_a', 'u_b')"),
      env.DB.prepare("DELETE FROM rides WHERE user_id IN ('u_a', 'u_b')"),
    ]);
  });

  it("supports isolated per-user profiles, nullable-FTP runner thresholds, daily_pmc, biometrics, laps, and external deduplication", async () => {
    // 1. Default owner profile survived migration
    const defaultProfile = await env.DB.prepare(
      "SELECT user_id, display_name, features_json FROM athlete_profile WHERE user_id = 'default_owner'"
    ).first<{ user_id: string; display_name: string; features_json: string }>();
    expect(defaultProfile?.user_id).toBe("default_owner");
    expect(defaultProfile?.features_json).toContain("indoor_trainer");

    // 2. Two independent users can coexist in athlete_profile, daily_pmc, and daily_biometrics on the same day
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO athlete_profile (user_id, display_name, primary_sports_json, features_json)
         VALUES ('u_a', 'Cyclist A', '["cycling","strength"]', '{"indoor_trainer":true}')`
      ),
      env.DB.prepare(
        `INSERT INTO athlete_profile (user_id, display_name, primary_sports_json, features_json)
         VALUES ('u_b', 'Runner B', '["running","strength"]', '{"indoor_trainer":false}')`
      ),
      env.DB.prepare(
        `INSERT INTO athlete_thresholds (id, user_id, effective_from, ftp_watts, threshold_pace_s_per_km, lthr_bpm)
         VALUES ('th_b', 'u_b', '2026-11-01', NULL, 275.0, 174)`
      ),
      env.DB.prepare(
        `INSERT INTO daily_pmc (user_id, day, total_tss, ctl, atl, tsb, ramp_rate_7d)
         VALUES ('u_a', '2026-11-20', 80, 60, 70, -10, 3.2)`
      ),
      env.DB.prepare(
        `INSERT INTO daily_pmc (user_id, day, total_tss, ctl, atl, tsb, ramp_rate_7d)
         VALUES ('u_b', '2026-11-20', 55, 42, 48, -6, 2.1)`
      ),
      env.DB.prepare(
        `INSERT INTO daily_biometrics (user_id, day, hrv_rmssd_ms, hrv_status, resting_hr_bpm, sleep_duration_s, sleep_score, body_battery_high)
         VALUES ('u_b', '2026-11-20', 62.5, 'balanced', 49, 28200, 86, 92)`
      ),
      env.DB.prepare(
        `INSERT INTO rides (
           ride_uuid, user_id, sport, sub_sport, external_provider, external_id,
           name, source, started_at, ride_day, r2_fit_key, fit_bytes,
           duration_s, elapsed_s, distance_m, elevation_gain_m, avg_pace_s_per_km, gap_s_per_km,
           pa_hr_decoupling, tss, ftp_snapshot, threshold_pace_snapshot
         ) VALUES (
           'run-uuid-1', 'u_b', 'running', 'road', 'garmin_personal', 'g-1001',
           'Morning 10K Tempo', 'external_sync', '2026-11-20T12:00:00Z', '2026-11-20',
           'users/u_b/activities/run-uuid-1.fit', 1024,
           2700, 2720, 10000, 85, 270, 266, 2.1, 68, 0, 275.0
         )`
      ),
      env.DB.prepare(
        `INSERT INTO activity_laps (user_id, ride_uuid, lap_index, duration_s, distance_m, avg_pace_s_per_km, avg_hr)
         VALUES ('u_b', 'run-uuid-1', 0, 272, 1000, 272, 158)`
      ),
      env.DB.prepare(
        `INSERT INTO provider_connections (user_id, provider, credentials_encrypted)
         VALUES ('u_b', 'garmin_personal', 'enc:v1:abc')`
      ),
      env.DB.prepare(
        `INSERT INTO user_device_tokens (token_hash, user_id, label, scope)
         VALUES ('hash-imp-1', 'u_a', 'Archive Importer', 'importer')`
      ),
    ]);

    // 3. Duplicate (user_id, external_provider, external_id) is blocked by unique index
    await expect(
      env.DB.prepare(
        `INSERT INTO rides (
           ride_uuid, user_id, sport, external_provider, external_id,
           name, source, started_at, ride_day, r2_fit_key, duration_s, elapsed_s, ftp_snapshot
         ) VALUES (
           'run-uuid-dup', 'u_b', 'running', 'garmin_personal', 'g-1001',
           'Duplicate Run', 'external_sync', '2026-11-20T12:00:00Z', '2026-11-20',
           'users/u_b/activities/dup.fit', 2700, 2700, 0
         )`
      ).run()
    ).rejects.toThrow();

    // 4. Verify runner threshold & biometrics readback
    const th = await env.DB.prepare(
      "SELECT ftp_watts, threshold_pace_s_per_km FROM athlete_thresholds WHERE id = 'th_b'"
    ).first<{ ftp_watts: number | null; threshold_pace_s_per_km: number | null }>();
    expect(th?.ftp_watts).toBeNull();
    expect(th?.threshold_pace_s_per_km).toBe(275);

    const bio = await env.DB.prepare(
      "SELECT hrv_rmssd_ms, sleep_score FROM daily_biometrics WHERE user_id = 'u_b' AND day = '2026-11-20'"
    ).first<{ hrv_rmssd_ms: number; sleep_score: number }>();
    expect(bio).toEqual({ hrv_rmssd_ms: 62.5, sleep_score: 86 });
  });
});
