import { z } from "zod";
import { computeDailyPmc, downsampleRecords, parseFitRecords } from "@paincave/shared";
import { optionalCoercedInt, optionalEnum, type McpToolRegistry } from "./protocol.js";
import type { AppEnv } from "../types.js";
import { ensureAthleteProfile } from "../lib/better-auth.js";
import { getFitnessOverview } from "../lib/fitness-service.js";
import { todayUtcDay } from "../lib/pmc-store.js";
import type { RideRow } from "../lib/rides-service.js";
import type { WorkoutRow } from "../lib/workouts-service.js";
import {
  getLatestThresholds,
  type AthleteThresholdRow,
  type CoachingNoteRow,
  type TrainingBlockRow,
} from "../routes/athlete.js";
import { computeBiometricsBaseline, type DailyBiometricsRow } from "../routes/fitness.js";

function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function safeJsonParse(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function summarizeActivityRow(r: RideRow) {
  return {
    ride_uuid: r.ride_uuid,
    sport: r.sport,
    sub_sport: r.sub_sport,
    name: r.name,
    source: r.source,
    workout_id: r.workout_id,
    started_at: r.started_at,
    ride_day: r.ride_day,
    duration_s: r.duration_s,
    distance_m: r.distance_m,
    elevation_gain_m: r.elevation_gain_m,
    avg_pace_s_per_km: r.avg_pace_s_per_km,
    gap_s_per_km: r.gap_s_per_km,
    pa_hr_decoupling: r.pa_hr_decoupling,
    work_kj: r.work_kj,
    avg_power: r.avg_power,
    np_watts: r.np_watts,
    intensity_factor: r.intensity_factor,
    tss: r.tss,
    variability_index: r.variability_index,
    avg_hr: r.avg_hr,
    max_hr: r.max_hr,
    efficiency_factor: r.efficiency_factor,
    pw_hr_decoupling: r.pw_hr_decoupling,
    hrr_60s: r.hrr_60s,
    time_gt_90_hrmax_s: r.time_gt_90_hrmax_s,
    avg_cadence: r.avg_cadence,
    compliance_pct: r.compliance_pct,
    rpe: r.rpe,
    feel: r.feel,
    notes: r.notes,
    quality_flags: safeJsonParse(r.quality_flags_json, {}),
  };
}

async function fetchActivityDetail(env: AppEnv, userId: string, rideUuid: string) {
  const ride = await env.DB.prepare("SELECT * FROM rides WHERE ride_uuid = ? AND user_id = ?")
    .bind(rideUuid, userId)
    .first<RideRow>();

  if (!ride) {
    throw new Error(`Activity not found: ${rideUuid}`);
  }

  const [intervalsRes, peaksRes, lapsRes] = await Promise.all([
    env.DB.prepare("SELECT * FROM ride_intervals WHERE ride_uuid = ? ORDER BY step_index ASC")
      .bind(rideUuid)
      .all(),
    env.DB.prepare("SELECT * FROM ride_peaks WHERE ride_uuid = ? ORDER BY duration_s ASC")
      .bind(rideUuid)
      .all(),
    env.DB.prepare(
      "SELECT * FROM activity_laps WHERE ride_uuid = ? AND user_id = ? ORDER BY lap_index ASC"
    )
      .bind(rideUuid, userId)
      .all(),
  ]);

  const linkedWorkout = ride.workout_id
    ? await env.DB.prepare(
        "SELECT id, name, sport, category, spec_json FROM workouts WHERE id = ? AND user_id = ?"
      )
        .bind(ride.workout_id, userId)
        .first<{ id: string; name: string; sport: string; category: string; spec_json: string }>()
    : null;

  return {
    ride: {
      ...ride,
      power_zones: safeJsonParse(ride.power_zones_json, {}),
      hr_zones: safeJsonParse(ride.hr_zones_json, {}),
      quality_flags: safeJsonParse(ride.quality_flags_json, {}),
      running_dynamics: safeJsonParse(ride.running_dynamics_json, {}),
    },
    intervals: intervalsRes.results,
    peaks: peaksRes.results,
    laps: lapsRes.results,
    workout: linkedWorkout
      ? {
          id: linkedWorkout.id,
          name: linkedWorkout.name,
          sport: linkedWorkout.sport,
          category: linkedWorkout.category,
          spec: safeJsonParse(linkedWorkout.spec_json, null),
        }
      : null,
  };
}

export function registerReadTools(registry: McpToolRegistry): void {
  registry.register(
    "get_health_and_training_brief",
    {
      description:
        "Primary LLM briefing tool. Returns one compact JSON snapshot of athlete profile, thresholds, active training blocks, LLM memory notes, 7d HRV/RHR/sleep/Body Battery vs 60d baseline, current CTL/ATL/TSB + multi-sport weekly load & running ACWR, recent activities, and upcoming 7-day calendar.",
      inputSchema: z.object({
        days: optionalCoercedInt(7, 30),
      }),
    },
    async ({ days }, env, userId) => {
      const lookbackDays = days ?? 14;
      const today = todayUtcDay();
      const sinceRecent = shiftDay(today, -(lookbackDays - 1));
      const since7d = shiftDay(today, -6);
      const since28d = shiftDay(today, -27);
      const since60d = shiftDay(today, -59);
      const next7d = shiftDay(today, 7);

      await ensureAthleteProfile(env.DB, userId);

      const [
        profile,
        latestThresholds,
        blocksRes,
        notesRes,
        biometricsRes,
        latestPmc,
        activities28dRes,
        upcomingRes,
      ] = await Promise.all([
        env.DB.prepare("SELECT * FROM athlete_profile WHERE user_id = ?").bind(userId).first(),
        getLatestThresholds(env.DB, userId),
        env.DB.prepare(
          "SELECT * FROM training_blocks WHERE user_id = ? AND active = 1 ORDER BY start_date DESC"
        )
          .bind(userId)
          .all<TrainingBlockRow>(),
        env.DB.prepare(
          "SELECT * FROM coaching_notes WHERE user_id = ? AND active = 1 ORDER BY updated_at DESC"
        )
          .bind(userId)
          .all<CoachingNoteRow>(),
        env.DB.prepare(
          `SELECT user_id, day, hrv_rmssd_ms, hrv_status, resting_hr_bpm,
                  sleep_duration_s, sleep_deep_s, sleep_rem_s, sleep_light_s, sleep_awake_s, sleep_score,
                  body_battery_high, body_battery_low, body_battery_charged,
                  stress_avg, steps, spo2_avg, weight_kg, cycle_phase, source
           FROM daily_biometrics
           WHERE user_id = ? AND day >= ?
           ORDER BY day ASC`
        )
          .bind(userId, since60d)
          .all<DailyBiometricsRow>(),
        env.DB.prepare(
          "SELECT day, ctl, atl, tsb, ramp_rate_7d FROM daily_pmc WHERE user_id = ? ORDER BY day DESC LIMIT 1"
        )
          .bind(userId)
          .first<{ day: string; ctl: number; atl: number; tsb: number; ramp_rate_7d: number }>(),
        env.DB.prepare(
          "SELECT * FROM rides WHERE user_id = ? AND ride_day >= ? ORDER BY started_at DESC"
        )
          .bind(userId, since28d)
          .all<RideRow>(),
        env.DB.prepare(
          `SELECT ps.id, ps.scheduled_date, ps.status, ps.coach_rationale,
                  w.id AS workout_id, w.name AS workout_name, w.sport AS workout_sport,
                  w.category AS workout_category, w.duration_s, w.predicted_tss, w.predicted_if
           FROM planned_sessions ps
           JOIN workouts w ON w.id = ps.workout_id AND w.user_id = ps.user_id
           WHERE ps.user_id = ? AND ps.scheduled_date >= ? AND ps.scheduled_date <= ?
           ORDER BY ps.scheduled_date ASC`
        )
          .bind(userId, today, next7d)
          .all(),
      ]);

      const readinessBaseline = computeBiometricsBaseline(biometricsRes.results);
      const recent7Bio = [...biometricsRes.results]
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, 7);
      const bbVals = recent7Bio
        .map((r) => r.body_battery_high)
        .filter((v): v is number => v !== null && Number.isFinite(v));
      const bodyBattery7dAvg =
        bbVals.length > 0
          ? Number((bbVals.reduce((s, v) => s + v, 0) / bbVals.length).toFixed(1))
          : null;

      let run7dM = 0;
      let runPrev7dM = 0;
      let run28dM = 0;
      let bike7dS = 0;
      let bike7dTss = 0;
      let strength7dSessions = 0;
      let total7dS = 0;
      let total7dTss = 0;
      const prev7Start = shiftDay(today, -13);
      const prev7End = shiftDay(today, -7);

      for (const a of activities28dRes.results) {
        if (a.sport === "running") {
          run28dM += a.distance_m ?? 0;
          if (a.ride_day >= since7d) run7dM += a.distance_m ?? 0;
          else if (a.ride_day >= prev7Start && a.ride_day <= prev7End) {
            runPrev7dM += a.distance_m ?? 0;
          }
        }
        if (a.ride_day >= since7d) {
          total7dS += a.duration_s;
          total7dTss += a.tss;
          if (a.sport === "cycling") {
            bike7dS += a.duration_s;
            bike7dTss += a.tss;
          } else if (a.sport === "strength") {
            strength7dSessions++;
          }
        }
      }

      const run7dKm = Number((run7dM / 1000).toFixed(1));
      const runPrev7dKm = Number((runPrev7dM / 1000).toFixed(1));
      const run28dWeeklyAvgKm = Number(((run28dM / 1000) / 4).toFixed(1));
      const runWowPct =
        runPrev7dKm > 0
          ? Number((((run7dKm - runPrev7dKm) / runPrev7dKm) * 100).toFixed(1))
          : null;
      const runAcwr =
        run28dWeeklyAvgKm > 0 ? Number((run7dKm / run28dWeeklyAvgKm).toFixed(2)) : null;

      const recentActivities = activities28dRes.results
        .filter((a) => a.ride_day >= sinceRecent)
        .slice(0, 25)
        .map((r) => ({
          ride_uuid: r.ride_uuid,
          day: r.ride_day,
          sport: r.sport,
          sub_sport: r.sub_sport,
          name: r.name,
          duration_min: Math.round(r.duration_s / 60),
          distance_km: r.distance_m ? Number((r.distance_m / 1000).toFixed(2)) : null,
          elevation_gain_m: r.elevation_gain_m,
          avg_pace_s_per_km: r.avg_pace_s_per_km,
          gap_s_per_km: r.gap_s_per_km,
          pa_hr_decoupling: r.pa_hr_decoupling,
          np_watts: r.np_watts,
          tss: r.tss,
          avg_hr: r.avg_hr,
          max_hr: r.max_hr,
          compliance_pct: r.compliance_pct,
        }));

      return {
        as_of_day: today,
        profile,
        latest_thresholds: latestThresholds,
        active_training_blocks: blocksRes.results.map((b) => ({
          ...b,
          constraints: safeJsonParse(b.constraints_json, {}),
        })),
        active_memory_notes: notesRes.results,
        readiness: {
          ...readinessBaseline,
          body_battery_7d_avg: bodyBattery7dAvg,
          biometrics_days_available: biometricsRes.results.length,
        },
        training_load: {
          current_pmc: {
            day: latestPmc?.day ?? null,
            ctl: latestPmc?.ctl ?? 0,
            atl: latestPmc?.atl ?? 0,
            tsb: latestPmc?.tsb ?? 0,
            ramp_rate_7d: latestPmc?.ramp_rate_7d ?? 0,
          },
          last_7d_total_hours: Number((total7dS / 3600).toFixed(2)),
          last_7d_total_tss: Number(total7dTss.toFixed(1)),
          cycling_7d_hours: Number((bike7dS / 3600).toFixed(2)),
          cycling_7d_tss: Number(bike7dTss.toFixed(1)),
          strength_7d_sessions: strength7dSessions,
          running_7d_km: run7dKm,
          running_prev_7d_km: runPrev7dKm,
          running_28d_weekly_avg_km: run28dWeeklyAvgKm,
          running_wow_change_pct: runWowPct,
          running_acwr: runAcwr,
        },
        recent_activities: recentActivities,
        upcoming_calendar: upcomingRes.results,
      };
    }
  );

  registry.register(
    "get_biometrics_history",
    {
      description:
        "Returns daily readiness & recovery biometrics (HRV RMSSD, resting HR, sleep stages/score, Body Battery, stress, steps, weight) plus 7d vs baseline deltas.",
      inputSchema: z.object({
        days: optionalCoercedInt(7, 180),
      }),
    },
    async ({ days }, env, userId) => {
      const lookbackDays = days ?? 60;
      const sinceDay = shiftDay(todayUtcDay(), -(lookbackDays - 1));
      const { results } = await env.DB.prepare(
        `SELECT user_id, day, hrv_rmssd_ms, hrv_status, resting_hr_bpm,
                sleep_duration_s, sleep_deep_s, sleep_rem_s, sleep_light_s, sleep_awake_s, sleep_score,
                body_battery_high, body_battery_low, body_battery_charged,
                stress_avg, steps, spo2_avg, weight_kg, cycle_phase, source
         FROM daily_biometrics
         WHERE user_id = ? AND day >= ?
         ORDER BY day ASC`
      )
        .bind(userId, sinceDay)
        .all<DailyBiometricsRow>();

      return {
        days: lookbackDays,
        since_day: sinceDay,
        summary: computeBiometricsBaseline(results),
        biometrics: results,
      };
    }
  );
  registry.register(
    "get_athlete_context",
    {
      description:
        "Returns athlete profile, current and historical thresholds (FTP, threshold pace, LTHR, HRmax, CP, W', weight), active training blocks with schedule constraints, and active training notes.",
      inputSchema: z.object({}),
    },
    async (_args, env, userId) => {
      await ensureAthleteProfile(env.DB, userId);
      const [profile, latestThresholds, thresholdsHistory, blocksRes, notesRes] =
        await Promise.all([
          env.DB.prepare("SELECT * FROM athlete_profile WHERE user_id = ?").bind(userId).first(),
          getLatestThresholds(env.DB, userId),
          env.DB.prepare(
            "SELECT * FROM athlete_thresholds WHERE user_id = ? ORDER BY effective_from DESC, created_at DESC LIMIT 10"
          )
            .bind(userId)
            .all<AthleteThresholdRow>(),
          env.DB.prepare(
            "SELECT * FROM training_blocks WHERE user_id = ? AND active = 1 ORDER BY start_date DESC"
          )
            .bind(userId)
            .all<TrainingBlockRow>(),
          env.DB.prepare(
            "SELECT * FROM coaching_notes WHERE user_id = ? AND active = 1 ORDER BY created_at DESC"
          )
            .bind(userId)
            .all<CoachingNoteRow>(),
        ]);

      return {
        profile,
        latest_thresholds: latestThresholds,
        threshold_history: thresholdsHistory.results,
        active_training_blocks: blocksRes.results.map((b) => ({
          ...b,
          constraints: safeJsonParse(b.constraints_json, {}),
        })),
        coaching_notes: notesRes.results,
      };
    }
  );

  registry.register(
    "get_fitness_overview",
    {
      description:
        "Returns current CTL/ATL/TSB/7d ramp rate, daily PMC series, weekly hours/TSS/distance/zone rollups, and rolling 42d/90d MMP peak power curves + CP/W' estimate.",
      inputSchema: z.object({
        days: optionalCoercedInt(7, 365),
      }),
    },
    async ({ days }, env, userId) => {
      return getFitnessOverview(env.DB, days ?? 42, userId);
    }
  );

  registry.register(
    "list_recent_rides",
    {
      description:
        "Lists recent completed activities/rides with compact physiological summaries (sport, distance, pace/GAP, NP, IF, TSS, avg/max HR, EF, decoupling, compliance %, notes, quality flags).",
      inputSchema: z.object({
        days: optionalCoercedInt(1, 365),
        limit: optionalCoercedInt(1, 100),
        source: optionalEnum(["all", "indoor_bridge", "manual_fit", "external_sync"]),
        sport: optionalEnum(["all", "cycling", "running", "strength", "mobility", "other"]),
      }),
    },
    async ({ days, limit, source, sport }, env, userId) => {
      const effectiveDays = days ?? 28;
      const effectiveLimit = limit ?? 20;
      const sinceDay = shiftDay(todayUtcDay(), -(effectiveDays - 1));

      const clauses = ["user_id = ?", "ride_day >= ?"];
      const binds: (string | number)[] = [userId, sinceDay];
      if (source && source !== "all") {
        clauses.push("source = ?");
        binds.push(source);
      }
      if (sport && sport !== "all") {
        clauses.push("sport = ?");
        binds.push(sport);
      }
      binds.push(effectiveLimit);

      const sql = `SELECT * FROM rides WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT ?`;
      const { results } = await env.DB.prepare(sql).bind(...binds).all<RideRow>();
      return {
        since_day: sinceDay,
        rides: results.map(summarizeActivityRow),
      };
    }
  );

  registry.register(
    "list_activities",
    {
      description:
        "Lists multi-sport activities (cycling, running, strength, mobility) by date range or trailing days with compact physiological summaries.",
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        days: optionalCoercedInt(1, 365),
        limit: optionalCoercedInt(1, 100),
        sport: optionalEnum(["all", "cycling", "running", "strength", "mobility", "other"]),
        source: optionalEnum(["all", "indoor_bridge", "manual_fit", "external_sync"]),
      }),
    },
    async ({ start_date, end_date, days, limit, sport, source }, env, userId) => {
      const effectiveLimit = limit ?? 25;
      const sinceDay = start_date ?? shiftDay(todayUtcDay(), -((days ?? 28) - 1));

      const clauses = ["user_id = ?", "ride_day >= ?"];
      const binds: (string | number)[] = [userId, sinceDay];
      if (end_date) {
        clauses.push("ride_day <= ?");
        binds.push(end_date);
      }
      if (sport && sport !== "all") {
        clauses.push("sport = ?");
        binds.push(sport);
      }
      if (source && source !== "all") {
        clauses.push("source = ?");
        binds.push(source);
      }
      binds.push(effectiveLimit);

      const sql = `SELECT * FROM rides WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT ?`;
      const { results } = await env.DB.prepare(sql).bind(...binds).all<RideRow>();
      return {
        start_date: sinceDay,
        end_date: end_date ?? todayUtcDay(),
        activities: results.map(summarizeActivityRow),
      };
    }
  );

  registry.register(
    "get_ride_detail",
    {
      description:
        "Returns full metrics, power & HR zones, quality flags, MMP peaks, lap/km splits, per-interval compliance breakdown, and linked workout spec for an activity/ride.",
      inputSchema: z.object({
        ride_uuid: z.string().uuid(),
      }),
    },
    async ({ ride_uuid }, env, userId) => {
      return fetchActivityDetail(env, userId, ride_uuid);
    }
  );

  registry.register(
    "get_activity_detail",
    {
      description:
        "Multi-sport activity detail tool returning full metrics, activity_laps splits (km/lap pace, GAP, HR, cadence, elevation), intervals, peaks, and linked workout.",
      inputSchema: z.object({
        activity_uuid: z.string().uuid().optional(),
        ride_uuid: z.string().uuid().optional(),
      }),
    },
    async ({ activity_uuid, ride_uuid }, env, userId) => {
      const targetId = activity_uuid ?? ride_uuid;
      if (!targetId) {
        throw new Error("Either activity_uuid or ride_uuid is required");
      }
      return fetchActivityDetail(env, userId, targetId);
    }
  );

  registry.register(
    "get_ride_timeseries",
    {
      description:
        "Drill-down tool that decodes the stored .fit file from R2 and returns downsampled time-series points (power, HR, cadence, speed) at the requested bucket resolution.",
      inputSchema: z.object({
        ride_uuid: z.string().uuid(),
        bucket_seconds: optionalCoercedInt(5, 300),
      }),
    },
    async ({ ride_uuid, bucket_seconds }, env, userId) => {
      const effectiveBucketSeconds = bucket_seconds ?? 30;
      const ride = await env.DB.prepare(
        "SELECT ride_uuid, name, r2_fit_key FROM rides WHERE ride_uuid = ? AND user_id = ?"
      )
        .bind(ride_uuid, userId)
        .first<{ ride_uuid: string; name: string; r2_fit_key: string }>();

      if (!ride) {
        throw new Error(`Ride not found: ${ride_uuid}`);
      }

      const obj = await env.RIDES_BUCKET.get(ride.r2_fit_key);
      if (!obj) {
        throw new Error(`No FIT artifact stored in R2 at ${ride.r2_fit_key}`);
      }

      const bytes = new Uint8Array(await obj.arrayBuffer());
      const parsed = parseFitRecords(bytes);
      const points = downsampleRecords(parsed.samples, effectiveBucketSeconds);

      return {
        ride_uuid: ride.ride_uuid,
        name: ride.name,
        bucket_seconds: effectiveBucketSeconds,
        raw_samples: parsed.samples.length,
        points,
      };
    }
  );

  registry.register(
    "get_calendar",
    {
      description:
        "Returns planned sessions and completed activities within [start_date, end_date], plus projected CTL/ATL/TSB if upcoming planned sessions are completed.",
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    },
    async ({ start_date, end_date }, env, userId) => {
      const [sessionsRes, ridesRes, baselinePmc] = await Promise.all([
        env.DB.prepare(
          `SELECT ps.*, w.name AS workout_name, w.sport AS workout_sport, w.category AS workout_category,
                  w.duration_s AS planned_duration_s, w.predicted_if, w.predicted_tss
           FROM planned_sessions ps
           JOIN workouts w ON w.id = ps.workout_id AND w.user_id = ps.user_id
           WHERE ps.user_id = ? AND ps.scheduled_date >= ? AND ps.scheduled_date <= ?
           ORDER BY ps.scheduled_date ASC`
        )
          .bind(userId, start_date, end_date)
          .all<{
            id: string;
            scheduled_date: string;
            workout_id: string;
            status: string;
            coach_rationale: string;
            completed_ride_uuid: string | null;
            workout_name: string;
            workout_sport: string;
            workout_category: string;
            planned_duration_s: number;
            predicted_if: number | null;
            predicted_tss: number | null;
          }>(),
        env.DB.prepare(
          `SELECT ride_uuid, sport, name, source, ride_day, duration_s, distance_m, avg_pace_s_per_km,
                  np_watts, intensity_factor, tss, compliance_pct, rpe, feel
           FROM rides
           WHERE user_id = ? AND ride_day >= ? AND ride_day <= ?
           ORDER BY started_at ASC`
        )
          .bind(userId, start_date, end_date)
          .all(),
        env.DB.prepare(
          "SELECT day, ctl, atl FROM daily_pmc WHERE user_id = ? ORDER BY day DESC LIMIT 8"
        )
          .bind(userId)
          .all<{ day: string; ctl: number; atl: number }>(),
      ]);

      const today = todayUtcDay();
      const latest = baselinePmc.results[0];
      const projStart = latest ? shiftDay(latest.day, 1) : today;
      const projEnd = end_date >= projStart ? end_date : projStart;
      const plannedInputs = sessionsRes.results
        .filter((s) => s.status === "planned" && s.scheduled_date >= projStart)
        .map((s) => ({
          day: s.scheduled_date,
          total_tss: s.predicted_tss ?? 0,
        }));

      const projectedPmc =
        projEnd >= projStart
          ? computeDailyPmc(plannedInputs, {
              startDay: projStart,
              endDay: projEnd,
              initialCtl: latest?.ctl ?? 0,
              initialAtl: latest?.atl ?? 0,
              priorCtlWindow: baselinePmc.results
                .slice(0, 7)
                .reverse()
                .map((r) => r.ctl),
            }).filter((p) => p.day >= start_date && p.day <= end_date)
          : [];

      return {
        start_date,
        end_date,
        planned_sessions: sessionsRes.results,
        completed_rides: ridesRes.results,
        projected_pmc: projectedPmc,
      };
    }
  );

  registry.register(
    "list_workouts",
    {
      description: "Lists workouts in the saved library filtered by sport, category, or search query.",
      inputSchema: z.object({
        sport: optionalEnum(["all", "cycling", "running", "strength", "mobility"]),
        category: z.string().optional(),
        query: z.string().optional(),
        limit: optionalCoercedInt(1, 100),
      }),
    },
    async ({ sport, category, query, limit }, env, userId) => {
      const effectiveLimit = limit ?? 25;
      const clauses = ["user_id = ?", "archived = 0"];
      const binds: (string | number)[] = [userId];
      if (sport && sport !== "all") {
        clauses.push("sport = ?");
        binds.push(sport);
      }
      if (category) {
        clauses.push("category = ?");
        binds.push(category);
      }
      if (query) {
        clauses.push("(name LIKE ? OR description LIKE ?)");
        binds.push(`%${query}%`, `%${query}%`);
      }
      binds.push(effectiveLimit);

      const sql = `SELECT id, sport, name, description, category, duration_s, predicted_np, predicted_if, predicted_tss, version, created_by, updated_at
                   FROM workouts WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`;
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return { workouts: results };
    }
  );

  registry.register(
    "get_workout",
    {
      description: "Returns a single saved workout's full WorkoutSpec JSON and predicted metrics.",
      inputSchema: z.object({
        workout_id: z.string().min(1),
      }),
    },
    async ({ workout_id }, env, userId) => {
      const row = await env.DB.prepare(
        "SELECT * FROM workouts WHERE id = ? AND user_id = ? AND archived = 0"
      )
        .bind(workout_id, userId)
        .first<WorkoutRow>();
      if (!row) {
        throw new Error(`Workout not found: ${workout_id}`);
      }
      return {
        id: row.id,
        sport: row.sport,
        name: row.name,
        description: row.description,
        category: row.category,
        duration_s: row.duration_s,
        predicted_np: row.predicted_np,
        predicted_if: row.predicted_if,
        predicted_tss: row.predicted_tss,
        zone_distribution: safeJsonParse(row.zone_distribution_json, {}),
        spec: safeJsonParse(row.spec_json, null),
        version: row.version,
      };
    }
  );

  registry.register(
    "get_training_history_summary",
    {
      description:
        "Returns multi-year yearly and recent monthly volume/TSS/distance rollups plus seasonal peak CTL and power/pace bests so LLMs can analyze thousands of historical workouts compactly.",
      inputSchema: z.object({
        years: optionalCoercedInt(1, 15),
        sport: optionalEnum(["all", "cycling", "running", "strength", "mobility", "other"]),
      }),
    },
    async ({ years, sport }, env, userId) => {
      const lookbackYears = years ?? 5;
      const currentYear = Number(todayUtcDay().slice(0, 4));
      const sinceDay = `${currentYear - lookbackYears + 1}-01-01`;
      const sportFilter = sport && sport !== "all" ? sport : null;

      const sportClause = sportFilter ? "AND sport = ?" : "";
      const baseBinds = sportFilter ? [userId, sinceDay, sportFilter] : [userId, sinceDay];

      const [yearlyRes, monthlyRes, peakCtlRes, powerBestsRes] = await Promise.all([
        env.DB.prepare(
          `SELECT substr(ride_day, 1, 4) AS year,
                  sport,
                  COUNT(*) AS sessions,
                  ROUND(SUM(duration_s) / 3600.0, 1) AS hours,
                  ROUND(SUM(COALESCE(distance_m, 0)) / 1000.0, 1) AS distance_km,
                  ROUND(SUM(tss), 0) AS total_tss,
                  MIN(CASE WHEN sport = 'running' AND avg_pace_s_per_km > 120 THEN avg_pace_s_per_km END) AS fastest_run_pace_s_per_km
           FROM rides
           WHERE user_id = ? AND ride_day >= ? ${sportClause}
           GROUP BY substr(ride_day, 1, 4), sport
           ORDER BY year DESC, sessions DESC`
        )
          .bind(...baseBinds)
          .all(),
        env.DB.prepare(
          `SELECT substr(ride_day, 1, 7) AS month,
                  COUNT(*) AS sessions,
                  ROUND(SUM(duration_s) / 3600.0, 1) AS hours,
                  ROUND(SUM(COALESCE(distance_m, 0)) / 1000.0, 1) AS distance_km,
                  ROUND(SUM(tss), 0) AS total_tss
           FROM rides
           WHERE user_id = ? AND ride_day >= ? ${sportClause}
           GROUP BY substr(ride_day, 1, 7)
           ORDER BY month DESC
           LIMIT 24`
        )
          .bind(...baseBinds)
          .all(),
        env.DB.prepare(
          `SELECT substr(day, 1, 4) AS year, ROUND(MAX(ctl), 1) AS peak_ctl
           FROM daily_pmc
           WHERE user_id = ? AND day >= ?
           GROUP BY substr(day, 1, 4)
           ORDER BY year DESC`
        )
          .bind(userId, sinceDay)
          .all(),
        env.DB.prepare(
          `SELECT substr(r.ride_day, 1, 4) AS year, rp.duration_s, MAX(rp.watts) AS max_watts
           FROM ride_peaks rp
           JOIN rides r ON r.ride_uuid = rp.ride_uuid
           WHERE r.user_id = ? AND r.ride_day >= ? AND rp.duration_s IN (60, 300, 1200)
           GROUP BY substr(r.ride_day, 1, 4), rp.duration_s
           ORDER BY year DESC, rp.duration_s ASC`
        )
          .bind(userId, sinceDay)
          .all(),
      ]);

      const totalCountRow = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM rides WHERE user_id = ? AND ride_day >= ? ${sportClause}`
      )
        .bind(...baseBinds)
        .first<{ cnt: number }>();

      return {
        since_day: sinceDay,
        sport_filter: sportFilter ?? "all",
        total_activities: totalCountRow?.cnt ?? 0,
        yearly_rollups: yearlyRes.results,
        recent_monthly_rollups: monthlyRes.results,
        yearly_peak_ctl: peakCtlRes.results,
        seasonal_power_bests: powerBestsRes.results,
      };
    }
  );
}
