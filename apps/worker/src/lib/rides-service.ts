import type { RideUploadSummary } from "@paincave/shared";
import type { AppEnv } from "../types.js";
import { DEFAULT_OWNER_USER_ID } from "./better-auth.js";
import { recomputePmcFromDay } from "./pmc-store.js";

export interface IngestRideResult {
  ride_uuid: string;
  idempotent: boolean;
  r2_fit_key: string;
  fit_bytes: number;
  strava_upload_status: string;
}

export type ActivitySport = "cycling" | "running" | "strength" | "mobility" | "other";

export interface ActivityLapInput {
  lap_index: number;
  duration_s: number;
  distance_m?: number | null;
  avg_pace_s_per_km?: number | null;
  gap_s_per_km?: number | null;
  avg_power?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  avg_cadence?: number | null;
  elevation_gain_m?: number | null;
  elevation_loss_m?: number | null;
}

export interface RideRow {
  ride_uuid: string;
  user_id: string;
  sport: ActivitySport;
  sub_sport: string | null;
  external_provider: string | null;
  external_id: string | null;
  name: string;
  source: "indoor_bridge" | "manual_fit" | "external_sync";
  workout_id: string | null;
  started_at: string;
  ride_day: string;
  r2_fit_key: string;
  fit_bytes: number;
  duration_s: number;
  elapsed_s: number;
  distance_m: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  avg_pace_s_per_km: number | null;
  gap_s_per_km: number | null;
  pa_hr_decoupling: number | null;
  running_dynamics_json: string;
  threshold_pace_snapshot: number | null;
  work_kj: number;
  avg_power: number | null;
  np_watts: number | null;
  intensity_factor: number | null;
  tss: number;
  variability_index: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  efficiency_factor: number | null;
  pw_hr_decoupling: number | null;
  hrr_60s: number | null;
  time_gt_90_hrmax_s: number;
  avg_cadence: number | null;
  compliance_pct: number | null;
  power_zones_json: string;
  hr_zones_json: string;
  quality_flags_json: string;
  ftp_snapshot: number;
  lthr_snapshot: number | null;
  hrmax_snapshot: number | null;
  weight_kg_snapshot: number | null;
  rpe: number | null;
  feel: number | null;
  notes: string;
  strava_upload_status: string;
  strava_upload_id: string | null;
  strava_activity_id: string | null;
  strava_error: string | null;
  created_at: string;
  updated_at: string;
}

export function buildFitR2Key(rideDay: string, rideUuid: string, userId = DEFAULT_OWNER_USER_ID): string {
  const year = rideDay.slice(0, 4);
  const month = rideDay.slice(5, 7);
  return `users/${userId}/fits/${year}/${month}/${rideUuid}.fit`;
}

export async function ingestRide(
  env: AppEnv,
  params: {
    userId?: string;
    summary: RideUploadSummary;
    fitBytes: Uint8Array | null;
    sport?: ActivitySport;
    subSport?: string | null;
    externalProvider?: string | null;
    externalId?: string | null;
    distanceM?: number | null;
    elevationGainM?: number | null;
    elevationLossM?: number | null;
    avgPaceSPerKm?: number | null;
    gapSPerKm?: number | null;
    paHrDecoupling?: number | null;
    runningDynamics?: Record<string, unknown> | null;
    thresholdPaceSnapshot?: number | null;
    laps?: ActivityLapInput[];
    skipPmcRecompute?: boolean;
  }
): Promise<IngestRideResult> {
  const { summary, fitBytes } = params;
  const userId = params.userId ?? DEFAULT_OWNER_USER_ID;

  // Idempotency check by ride_uuid or (user_id, external_provider, external_id)
  const existingByUuid = await env.DB.prepare(
    "SELECT ride_uuid, r2_fit_key, fit_bytes, strava_upload_status FROM rides WHERE ride_uuid = ? AND user_id = ?"
  )
    .bind(summary.ride_uuid, userId)
    .first<{
      ride_uuid: string;
      r2_fit_key: string;
      fit_bytes: number;
      strava_upload_status: string;
    }>();

  const existingByExternal =
    !existingByUuid && params.externalProvider && params.externalId
      ? await env.DB.prepare(
          `SELECT ride_uuid, r2_fit_key, fit_bytes, strava_upload_status
           FROM rides
           WHERE user_id = ? AND external_provider = ? AND external_id = ?`
        )
          .bind(userId, params.externalProvider, params.externalId)
          .first<{
            ride_uuid: string;
            r2_fit_key: string;
            fit_bytes: number;
            strava_upload_status: string;
          }>()
      : null;

  const existing = existingByUuid ?? existingByExternal;
  if (existing) {
    return {
      ride_uuid: existing.ride_uuid,
      idempotent: true,
      r2_fit_key: existing.r2_fit_key,
      fit_bytes: existing.fit_bytes,
      strava_upload_status: existing.strava_upload_status,
    };
  }

  let workoutId: string | null = null;
  if (summary.workout_id) {
    const workout = await env.DB.prepare("SELECT id FROM workouts WHERE id = ? AND user_id = ?")
      .bind(summary.workout_id, userId)
      .first<{ id: string }>();
    workoutId = workout?.id ?? null;
  }

  let plannedSessionId: string | null = null;
  if (summary.planned_session_id) {
    const plannedSession = await env.DB.prepare(
      "SELECT id FROM planned_sessions WHERE id = ? AND user_id = ?"
    )
      .bind(summary.planned_session_id, userId)
      .first<{ id: string }>();
    plannedSessionId = plannedSession?.id ?? null;
  }

  const r2Key = buildFitR2Key(summary.ride_day, summary.ride_uuid, userId);
  const fitSize = fitBytes ? fitBytes.byteLength : 0;

  if (fitBytes && fitBytes.byteLength > 0) {
    await env.RIDES_BUCKET.put(r2Key, fitBytes, {
      httpMetadata: { contentType: "application/vnd.ant.fit" },
      customMetadata: {
        user_id: userId,
        ride_uuid: summary.ride_uuid,
        ride_day: summary.ride_day,
        source: summary.source,
        sport: params.sport ?? "cycling",
      },
    });
  }

  const stravaConnected = await env.DB.prepare(
    "SELECT provider FROM provider_connections WHERE user_id = ? AND provider = 'strava'"
  )
    .bind(userId)
    .first<{ provider: string }>();

  const stravaStatus =
    summary.source === "indoor_bridge" && stravaConnected && fitSize > 0
      ? "pending"
      : "not_connected";

  const batch: D1PreparedStatement[] = [];

  batch.push(
    env.DB.prepare(
      `INSERT INTO rides (
        ride_uuid, user_id, sport, sub_sport, external_provider, external_id,
        name, source, workout_id, started_at, ride_day, r2_fit_key, fit_bytes,
        duration_s, elapsed_s, distance_m, elevation_gain_m, elevation_loss_m,
        avg_pace_s_per_km, gap_s_per_km, pa_hr_decoupling, running_dynamics_json,
        threshold_pace_snapshot, work_kj, avg_power, np_watts, intensity_factor, tss,
        variability_index, avg_hr, max_hr, efficiency_factor, pw_hr_decoupling, hrr_60s,
        time_gt_90_hrmax_s, avg_cadence, compliance_pct, power_zones_json, hr_zones_json,
        quality_flags_json, ftp_snapshot, lthr_snapshot, hrmax_snapshot, weight_kg_snapshot,
        rpe, feel, notes, strava_upload_status
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )`
    ).bind(
      summary.ride_uuid,
      userId,
      params.sport ?? "cycling",
      params.subSport ?? null,
      params.externalProvider ?? null,
      params.externalId ?? null,
      summary.name,
      summary.source,
      workoutId,
      summary.started_at,
      summary.ride_day,
      r2Key,
      fitSize,
      summary.duration_s,
      summary.elapsed_s,
      params.distanceM ?? null,
      params.elevationGainM ?? null,
      params.elevationLossM ?? null,
      params.avgPaceSPerKm ?? null,
      params.gapSPerKm ?? null,
      params.paHrDecoupling ?? null,
      JSON.stringify(params.runningDynamics ?? {}),
      params.thresholdPaceSnapshot ?? null,
      summary.work_kj,
      summary.avg_power,
      summary.np_watts,
      summary.intensity_factor,
      summary.tss,
      summary.variability_index,
      summary.avg_hr,
      summary.max_hr,
      summary.efficiency_factor,
      summary.pw_hr_decoupling,
      summary.hrr_60s,
      summary.time_gt_90_hrmax_s,
      summary.avg_cadence,
      summary.compliance_pct,
      JSON.stringify(summary.power_zones),
      JSON.stringify(summary.hr_zones),
      JSON.stringify(summary.quality_flags),
      summary.ftp_snapshot,
      summary.lthr_snapshot ?? null,
      summary.hrmax_snapshot ?? null,
      summary.weight_kg_snapshot ?? null,
      summary.rpe ?? null,
      summary.feel ?? null,
      summary.notes,
      stravaStatus
    )
  );

  for (const iv of summary.intervals) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO ride_intervals (
          ride_uuid, step_index, label, mode, is_work_interval, planned_duration_s,
          actual_duration_s, target_watts, actual_avg_watts, pct_of_target, avg_hr,
          max_hr, hr_drift_bpm, avg_cadence, erg_bias_pct, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        summary.ride_uuid,
        iv.step_index,
        iv.label,
        iv.mode,
        iv.is_work_interval ? 1 : 0,
        iv.planned_duration_s,
        iv.actual_duration_s,
        iv.target_watts,
        iv.actual_avg_watts,
        iv.pct_of_target,
        iv.avg_hr,
        iv.max_hr,
        iv.hr_drift_bpm,
        iv.avg_cadence,
        iv.erg_bias_pct,
        iv.status
      )
    );
  }

  for (const peak of summary.peaks) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO ride_peaks (ride_uuid, duration_s, watts, w_per_kg)
         VALUES (?, ?, ?, ?)`
      ).bind(summary.ride_uuid, peak.duration_s, peak.watts, peak.w_per_kg)
    );
  }

  for (const lap of params.laps ?? []) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO activity_laps (
          user_id, ride_uuid, lap_index, duration_s, distance_m, avg_pace_s_per_km,
          gap_s_per_km, avg_power, avg_hr, max_hr, avg_cadence, elevation_gain_m, elevation_loss_m
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        userId,
        summary.ride_uuid,
        lap.lap_index,
        lap.duration_s,
        lap.distance_m ?? null,
        lap.avg_pace_s_per_km ?? null,
        lap.gap_s_per_km ?? null,
        lap.avg_power ?? null,
        lap.avg_hr ?? null,
        lap.max_hr ?? null,
        lap.avg_cadence ?? null,
        lap.elevation_gain_m ?? null,
        lap.elevation_loss_m ?? null
      )
    );
  }

  if (plannedSessionId) {
    batch.push(
      env.DB.prepare(
        `UPDATE planned_sessions
         SET status = 'completed', completed_ride_uuid = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND user_id = ?`
      ).bind(summary.ride_uuid, plannedSessionId, userId)
    );
  }

  await env.DB.batch(batch);
  if (!params.skipPmcRecompute) {
    await recomputePmcFromDay(env.DB, summary.ride_day, userId);
  }

  return {
    ride_uuid: summary.ride_uuid,
    idempotent: false,
    r2_fit_key: r2Key,
    fit_bytes: fitSize,
    strava_upload_status: stravaStatus,
  };
}
