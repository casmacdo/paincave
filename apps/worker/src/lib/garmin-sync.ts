import {
  computeRideMetrics,
  computeRunningMetrics,
  parseFitRecords,
  type RideUploadSummary,
} from "@paincave/shared";
import type { AppEnv } from "../types.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  GarminRateLimitError,
  downloadGarminActivityFit,
  exchangeGarminPersonalToken,
  fetchGarminActivities,
  fetchGarminDailyBiometrics,
  type DailyBiometricsInput,
} from "./garmin-client.js";
import { logJson } from "./logger.js";
import { recomputePmcFromDay, todayUtcDay } from "./pmc-store.js";
import { ingestRide, type ActivityLapInput } from "./rides-service.js";
import { getLatestThresholds } from "../routes/athlete.js";

function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function getMasterEncryptionSecret(env: AppEnv): string {
  const secret = env.SESSION_SIGNING_SECRET || env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SIGNING_SECRET is required to store encrypted Garmin keys");
  }
  return secret;
}

export interface GarminConnectionStatus {
  connected: boolean;
  last_sync_at: string | null;
  last_error: string | null;
  token_expires_at: number | null;
}

export async function getGarminStatus(
  env: AppEnv,
  userId: string
): Promise<GarminConnectionStatus> {
  const row = await env.DB.prepare(
    `SELECT expires_at, last_sync_at, last_error
     FROM provider_connections
     WHERE user_id = ? AND provider = 'garmin_personal'`
  )
    .bind(userId)
    .first<{
      expires_at: number | null;
      last_sync_at: string | null;
      last_error: string | null;
    }>();

  return {
    connected: Boolean(row),
    last_sync_at: row?.last_sync_at ?? null,
    last_error: row?.last_error ?? null,
    token_expires_at: row?.expires_at ?? null,
  };
}

export async function connectGarminPersonalApi(
  env: AppEnv,
  userId: string,
  apiKey: string
): Promise<GarminConnectionStatus> {
  const master = getMasterEncryptionSecret(env);
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length < 12) {
    throw new Error("Garmin Personal API key is too short");
  }

  // Validate key immediately by exchanging it for a 24h Bearer JWT
  const token = await exchangeGarminPersonalToken(trimmedKey);
  const encrypted = await encryptSecret(trimmedKey, master);
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO provider_connections
       (user_id, provider, credentials_encrypted, access_token, expires_at, last_error, updated_at)
     VALUES (?, 'garmin_personal', ?, ?, ?, NULL, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       credentials_encrypted = excluded.credentials_encrypted,
       access_token = excluded.access_token,
       expires_at = excluded.expires_at,
       last_error = NULL,
       updated_at = excluded.updated_at`
  )
    .bind(userId, encrypted, token.access_token, token.expires_at, nowIso)
    .run();

  return getGarminStatus(env, userId);
}

export async function disconnectGarminPersonalApi(env: AppEnv, userId: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM provider_connections WHERE user_id = ? AND provider = 'garmin_personal'"
  )
    .bind(userId)
    .run();
}

export async function upsertDailyBiometrics(
  db: D1Database,
  userId: string,
  rows: readonly DailyBiometricsInput[],
  source = "garmin_personal"
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = `INSERT INTO daily_biometrics (
      user_id, day, hrv_rmssd_ms, hrv_status, resting_hr_bpm,
      sleep_duration_s, sleep_deep_s, sleep_rem_s, sleep_light_s, sleep_awake_s, sleep_score,
      body_battery_high, body_battery_low, body_battery_charged,
      stress_avg, steps, spo2_avg, weight_kg, cycle_phase, raw_json, source, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    )
    ON CONFLICT(user_id, day) DO UPDATE SET
      hrv_rmssd_ms = COALESCE(excluded.hrv_rmssd_ms, daily_biometrics.hrv_rmssd_ms),
      hrv_status = COALESCE(excluded.hrv_status, daily_biometrics.hrv_status),
      resting_hr_bpm = COALESCE(excluded.resting_hr_bpm, daily_biometrics.resting_hr_bpm),
      sleep_duration_s = COALESCE(excluded.sleep_duration_s, daily_biometrics.sleep_duration_s),
      sleep_deep_s = COALESCE(excluded.sleep_deep_s, daily_biometrics.sleep_deep_s),
      sleep_rem_s = COALESCE(excluded.sleep_rem_s, daily_biometrics.sleep_rem_s),
      sleep_light_s = COALESCE(excluded.sleep_light_s, daily_biometrics.sleep_light_s),
      sleep_awake_s = COALESCE(excluded.sleep_awake_s, daily_biometrics.sleep_awake_s),
      sleep_score = COALESCE(excluded.sleep_score, daily_biometrics.sleep_score),
      body_battery_high = COALESCE(excluded.body_battery_high, daily_biometrics.body_battery_high),
      body_battery_low = COALESCE(excluded.body_battery_low, daily_biometrics.body_battery_low),
      body_battery_charged = COALESCE(excluded.body_battery_charged, daily_biometrics.body_battery_charged),
      stress_avg = COALESCE(excluded.stress_avg, daily_biometrics.stress_avg),
      steps = COALESCE(excluded.steps, daily_biometrics.steps),
      spo2_avg = COALESCE(excluded.spo2_avg, daily_biometrics.spo2_avg),
      weight_kg = COALESCE(excluded.weight_kg, daily_biometrics.weight_kg),
      cycle_phase = COALESCE(excluded.cycle_phase, daily_biometrics.cycle_phase),
      source = excluded.source,
      updated_at = excluded.updated_at`;

  const stmts = rows.map((r) =>
    db
      .prepare(sql)
      .bind(
        userId,
        r.day,
        r.hrv_rmssd_ms ?? null,
        r.hrv_status ?? null,
        r.resting_hr_bpm ?? null,
        r.sleep_duration_s ?? null,
        r.sleep_deep_s ?? null,
        r.sleep_rem_s ?? null,
        r.sleep_light_s ?? null,
        r.sleep_awake_s ?? null,
        r.sleep_score ?? null,
        r.body_battery_high ?? null,
        r.body_battery_low ?? null,
        r.body_battery_charged ?? null,
        r.stress_avg ?? null,
        r.steps ?? null,
        r.spo2_avg ?? null,
        r.weight_kg ?? null,
        r.cycle_phase ?? null,
        JSON.stringify(r.raw_json ?? {}),
        source
      )
  );

  for (let i = 0; i < stmts.length; i += 200) {
    await db.batch(stmts.slice(i, i + 200));
  }
  return rows.length;
}

async function getValidGarminJwt(env: AppEnv, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT credentials_encrypted, access_token, expires_at
     FROM provider_connections
     WHERE user_id = ? AND provider = 'garmin_personal'`
  )
    .bind(userId)
    .first<{
      credentials_encrypted: string | null;
      access_token: string | null;
      expires_at: number | null;
    }>();

  if (!row || !row.credentials_encrypted) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (row.access_token && row.expires_at && row.expires_at > nowSec + 120) {
    return row.access_token;
  }

  const master = getMasterEncryptionSecret(env);
  const apiKey = await decryptSecret(row.credentials_encrypted, master);
  const refreshed = await exchangeGarminPersonalToken(apiKey);
  await env.DB.prepare(
    `UPDATE provider_connections
     SET access_token = ?, expires_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE user_id = ? AND provider = 'garmin_personal'`
  )
    .bind(refreshed.access_token, refreshed.expires_at, userId)
    .run();

  return refreshed.access_token;
}

export interface GarminSyncResult {
  ok: boolean;
  rate_limited: boolean;
  retry_after_s: number | null;
  start_date: string;
  end_date: string;
  activities_imported: number;
  activities_skipped: number;
  biometrics_upserted: number;
  error: string | null;
}

function diffDaysInclusive(startDay: string, endDay: string): number {
  const s = Date.parse(`${startDay}T00:00:00Z`);
  const e = Date.parse(`${endDay}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
  return Math.floor((e - s) / 86_400_000) + 1;
}

export async function syncGarminUser(
  env: AppEnv,
  userId: string,
  opts: {
    days?: number;
    startDate?: string;
    endDate?: string;
    skipPmcRecompute?: boolean;
  } = {}
): Promise<GarminSyncResult> {
  const today = todayUtcDay();
  const status = await getGarminStatus(env, userId);
  if (!status.connected) {
    return {
      ok: false,
      rate_limited: false,
      retry_after_s: null,
      start_date: today,
      end_date: today,
      activities_imported: 0,
      activities_skipped: 0,
      biometrics_upserted: 0,
      error: "Garmin Personal API is not connected",
    };
  }

  let startDay: string;
  let endDay: string;
  if (opts.startDate && opts.endDate) {
    startDay = opts.startDate <= opts.endDate ? opts.startDate : opts.endDate;
    endDay = opts.endDate >= opts.startDate ? opts.endDate : opts.startDate;
    if (endDay > today) endDay = today;
    if (startDay > endDay) startDay = endDay;
    const span = diffDaysInclusive(startDay, endDay);
    if (span > 31) {
      startDay = shiftDay(endDay, -30);
    }
  } else {
    const lookbackDays = Math.min(31, Math.max(1, opts.days ?? (status.last_sync_at ? 3 : 14)));
    endDay = today;
    startDay = shiftDay(today, -(lookbackDays - 1));
  }

  let imported = 0;
  let skipped = 0;
  let biometricsCount = 0;
  let earliestNewDay: string | null = null;

  try {
    const jwt = await getValidGarminJwt(env, userId);
    if (!jwt) {
      return {
        ok: false,
        rate_limited: false,
        retry_after_s: null,
        start_date: startDay,
        end_date: endDay,
        activities_imported: 0,
        activities_skipped: 0,
        biometrics_upserted: 0,
        error: "Garmin Personal API credentials missing",
      };
    }

    const activities = await fetchGarminActivities(jwt, startDay, endDay);

    for (const act of activities) {
      // Skip already imported activities before downloading FIT
      const exists = await env.DB.prepare(
        `SELECT ride_uuid FROM rides
         WHERE user_id = ? AND external_provider = 'garmin_personal' AND external_id = ?`
      )
        .bind(userId, act.activityId)
        .first<{ ride_uuid: string }>();

      if (exists) {
        skipped++;
        continue;
      }

      const fitBytes = await downloadGarminActivityFit(jwt, act.activityId);
      const thresholds = await getLatestThresholds(env.DB, userId, act.rideDay);
      const ftp = thresholds?.ftp_watts ?? 250;
      const rideUuid = crypto.randomUUID();

      let sport = act.sport;
      let subSport = act.subSport;
      let distanceM = act.distanceM;
      let elevationGainM = act.elevationGainM;
      let elevationLossM: number | null = null;
      let avgPaceSPerKm: number | null = null;
      let gapSPerKm: number | null = null;
      let paHrDecoupling: number | null = null;
      let laps: ActivityLapInput[] = [];

      let summary: RideUploadSummary = {
        ride_uuid: rideUuid,
        name: act.activityName,
        source: "external_sync",
        started_at: act.startTimeIso,
        ride_day: act.rideDay,
        duration_s: act.durationS,
        elapsed_s: act.durationS,
        work_kj: 0,
        avg_power: act.avgPower,
        np_watts: null,
        intensity_factor: null,
        tss: Number(((act.durationS / 3600) * 50).toFixed(1)),
        variability_index: null,
        avg_hr: act.avgHr,
        max_hr: act.maxHr,
        efficiency_factor: null,
        pw_hr_decoupling: null,
        hrr_60s: null,
        time_gt_90_hrmax_s: 0,
        avg_cadence: act.avgCadence,
        compliance_pct: null,
        power_zones: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, z6: 0, z7: 0 },
        hr_zones: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
        quality_flags: { power_dropouts_s: 0, hr_dropouts_s: 0, erg_smoothing_detected: false },
        ftp_snapshot: ftp,
        lthr_snapshot: thresholds?.lthr_bpm ?? null,
        hrmax_snapshot: thresholds?.hrmax_bpm ?? null,
        weight_kg_snapshot: thresholds?.weight_kg ?? null,
        notes: "",
        intervals: [],
        peaks: [],
      };

      if (fitBytes) {
        try {
          const parsedFit = parseFitRecords(fitBytes);
          if (parsedFit.sport !== "other") {
            sport = parsedFit.sport;
          }
          if (parsedFit.subSportName) {
            subSport = parsedFit.subSportName;
          }

          if (sport === "running") {
            const runMetrics = computeRunningMetrics(
              parsedFit.samples,
              {
                threshold_pace_s_per_km: thresholds?.threshold_pace_s_per_km ?? null,
                lthr_bpm: thresholds?.lthr_bpm ?? null,
                hrmax_bpm: thresholds?.hrmax_bpm ?? null,
                hrrest_bpm: thresholds?.hrrest_bpm ?? null,
              },
              {
                sessionDistanceM: parsedFit.totalDistanceM ?? act.distanceM,
                sessionDurationS: parsedFit.totalTimerTimeS ?? act.durationS,
                sessionElapsedS: parsedFit.totalElapsedTimeS ?? act.durationS,
                sessionAscentM: parsedFit.totalAscentM ?? act.elevationGainM,
                sessionDescentM: parsedFit.totalDescentM,
                fitLaps: parsedFit.laps,
              }
            );
            distanceM = runMetrics.distance_m;
            elevationGainM = runMetrics.elevation_gain_m;
            elevationLossM = runMetrics.elevation_loss_m;
            avgPaceSPerKm = runMetrics.avg_pace_s_per_km;
            gapSPerKm = runMetrics.gap_s_per_km;
            paHrDecoupling = runMetrics.pa_hr_decoupling;
            laps = runMetrics.laps;
            summary = {
              ...summary,
              duration_s: runMetrics.duration_s,
              elapsed_s: runMetrics.elapsed_s,
              tss: runMetrics.tss,
              avg_hr: runMetrics.avg_hr ?? act.avgHr,
              max_hr: runMetrics.max_hr ?? act.maxHr,
              avg_cadence: runMetrics.avg_cadence_spm ?? act.avgCadence,
              hr_zones: runMetrics.hr_zones,
            };
          } else if (sport === "cycling" && parsedFit.samples.length > 0) {
            const rideMetrics = computeRideMetrics(parsedFit.samples, {
              ftp_watts: ftp,
              lthr_bpm: thresholds?.lthr_bpm ?? null,
              hrmax_bpm: thresholds?.hrmax_bpm ?? null,
              weight_kg: thresholds?.weight_kg ?? null,
            });
            distanceM = parsedFit.totalDistanceM ?? act.distanceM;
            elevationGainM = parsedFit.totalAscentM ?? act.elevationGainM;
            elevationLossM = parsedFit.totalDescentM;
            laps = parsedFit.laps.map((l) => ({
              lap_index: l.lap_index,
              duration_s: l.duration_s,
              distance_m: l.distance_m,
              avg_pace_s_per_km: l.avg_pace_s_per_km,
              avg_power: l.avg_power,
              avg_hr: l.avg_hr,
              max_hr: l.max_hr,
              avg_cadence: l.avg_cadence,
              elevation_gain_m: l.elevation_gain_m,
              elevation_loss_m: l.elevation_loss_m,
            }));
            summary = {
              ...summary,
              duration_s: rideMetrics.duration_s,
              elapsed_s: rideMetrics.elapsed_s,
              work_kj: rideMetrics.work_kj,
              avg_power: rideMetrics.avg_power,
              np_watts: rideMetrics.np_watts,
              intensity_factor: rideMetrics.intensity_factor,
              tss: rideMetrics.tss,
              variability_index: rideMetrics.variability_index,
              avg_hr: rideMetrics.avg_hr,
              max_hr: rideMetrics.max_hr,
              efficiency_factor: rideMetrics.efficiency_factor,
              pw_hr_decoupling: rideMetrics.pw_hr_decoupling,
              hrr_60s: rideMetrics.hrr_60s,
              time_gt_90_hrmax_s: rideMetrics.time_gt_90_hrmax_s,
              avg_cadence: rideMetrics.avg_cadence,
              power_zones: rideMetrics.power_zones,
              hr_zones: rideMetrics.hr_zones,
              quality_flags: rideMetrics.quality_flags,
              peaks: rideMetrics.peaks,
            };
          }
        } catch {
          // Keep metadata summary if FIT file is non-standard
        }
      } else if (sport === "running" && act.distanceM && act.durationS > 0) {
        avgPaceSPerKm = Number(((act.durationS / act.distanceM) * 1000).toFixed(1));
      }

      const res = await ingestRide(env, {
        userId,
        summary,
        fitBytes,
        sport,
        subSport,
        externalProvider: "garmin_personal",
        externalId: act.activityId,
        distanceM,
        elevationGainM,
        elevationLossM,
        avgPaceSPerKm,
        gapSPerKm,
        paHrDecoupling,
        thresholdPaceSnapshot: thresholds?.threshold_pace_s_per_km ?? null,
        laps,
        skipPmcRecompute: true,
      });

      if (res.idempotent) {
        skipped++;
      } else {
        imported++;
        if (!earliestNewDay || act.rideDay < earliestNewDay) {
          earliestNewDay = act.rideDay;
        }
      }
    }

    if (earliestNewDay && !opts.skipPmcRecompute) {
      await recomputePmcFromDay(env.DB, earliestNewDay, userId);
    }

    const bioStart = opts.startDate ? startDay : shiftDay(endDay, -Math.min(diffDaysInclusive(startDay, endDay) - 1, 6));
    const bioRows = await fetchGarminDailyBiometrics(jwt, bioStart, endDay);
    biometricsCount = await upsertDailyBiometrics(env.DB, userId, bioRows, "garmin_personal");

    await env.DB.prepare(
      `UPDATE provider_connections
       SET last_sync_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
           last_error = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE user_id = ? AND provider = 'garmin_personal'`
    )
      .bind(userId)
      .run();

    return {
      ok: true,
      rate_limited: false,
      retry_after_s: null,
      start_date: startDay,
      end_date: endDay,
      activities_imported: imported,
      activities_skipped: skipped,
      biometrics_upserted: biometricsCount,
      error: null,
    };
  } catch (err) {
    const isRateLimit = err instanceof GarminRateLimitError;
    const retryAfterS = err instanceof GarminRateLimitError ? err.retryAfterSeconds : null;
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    await env.DB.prepare(
      `UPDATE provider_connections
       SET last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE user_id = ? AND provider = 'garmin_personal'`
    )
      .bind(msg, userId)
      .run()
      .catch(() => {});

    logJson("warn", "Garmin sync did not complete", {
      user_id: userId,
      rate_limited: isRateLimit,
      error: msg,
    });

    return {
      ok: false,
      rate_limited: isRateLimit,
      retry_after_s: retryAfterS,
      start_date: startDay,
      end_date: endDay,
      activities_imported: imported,
      activities_skipped: skipped,
      biometrics_upserted: biometricsCount,
      error: msg,
    };
  }
}

export async function syncAllConnectedGarminUsers(env: AppEnv): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT user_id FROM provider_connections WHERE provider = 'garmin_personal'"
  ).all<{ user_id: string }>();

  for (const row of results) {
    try {
      await syncGarminUser(env, row.user_id, { days: 3 });
    } catch (err) {
      logJson("error", "Unhandled error in Garmin cron sync", {
        user_id: row.user_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
