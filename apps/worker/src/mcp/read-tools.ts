import { z } from "zod";
import { computeDailyPmc, downsampleRecords, parseFitRecords } from "@paincave/shared";
import type { McpToolRegistry } from "./protocol.js";
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

export function registerReadTools(registry: McpToolRegistry): void {
  registry.register(
    "get_athlete_context",
    {
      description:
        "Returns athlete profile, current and historical thresholds (FTP, LTHR, HRmax, CP, W', weight), active training blocks with schedule constraints, and active coaching notes.",
      inputSchema: z.object({}),
    },
    async (_args, env) => {
      const [profile, latestThresholds, thresholdsHistory, blocksRes, notesRes] =
        await Promise.all([
          env.DB.prepare("SELECT * FROM athlete_profile WHERE id = 1").first(),
          getLatestThresholds(env.DB),
          env.DB.prepare(
            "SELECT * FROM athlete_thresholds ORDER BY effective_from DESC, created_at DESC LIMIT 10"
          ).all<AthleteThresholdRow>(),
          env.DB.prepare(
            "SELECT * FROM training_blocks WHERE active = 1 ORDER BY start_date DESC"
          ).all<TrainingBlockRow>(),
          env.DB.prepare(
            "SELECT * FROM coaching_notes WHERE active = 1 ORDER BY created_at DESC"
          ).all<CoachingNoteRow>(),
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
        "Returns current CTL/ATL/TSB/7d ramp rate, daily PMC series, weekly hours/TSS/zone rollups, and rolling 42d/90d MMP peak power curves + CP/W' estimate.",
      inputSchema: z.object({
        days: z.coerce.number().int().min(7).max(365).optional(),
      }),
    },
    async ({ days }, env) => {
      return getFitnessOverview(env.DB, days ?? 42);
    }
  );

  registry.register(
    "list_recent_rides",
    {
      description:
        "Lists recent completed rides with compact physiological summaries (NP, IF, TSS, avg/max HR, EF, Pw:HR decoupling, time >90% HRmax, compliance %, RPE/feel/notes, quality flags).",
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).default(28),
        limit: z.number().int().min(1).max(100).default(20),
        source: z.enum(["all", "indoor_bridge", "manual_fit", "external_sync"]).default("all"),
      }),
    },
    async ({ days, limit, source }, env) => {
      const sinceDay = shiftDay(todayUtcDay(), -(days - 1));
      const sql =
        source === "all"
          ? "SELECT * FROM rides WHERE ride_day >= ? ORDER BY started_at DESC LIMIT ?"
          : "SELECT * FROM rides WHERE ride_day >= ? AND source = ? ORDER BY started_at DESC LIMIT ?";
      const stmt =
        source === "all"
          ? env.DB.prepare(sql).bind(sinceDay, limit)
          : env.DB.prepare(sql).bind(sinceDay, source, limit);

      const { results } = await stmt.all<RideRow>();
      return {
        since_day: sinceDay,
        rides: results.map((r) => ({
          ride_uuid: r.ride_uuid,
          name: r.name,
          source: r.source,
          workout_id: r.workout_id,
          started_at: r.started_at,
          ride_day: r.ride_day,
          duration_s: r.duration_s,
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
        })),
      };
    }
  );

  registry.register(
    "get_ride_detail",
    {
      description:
        "Returns full metrics, power & HR zones, quality flags, MMP peaks, per-interval compliance breakdown, and linked workout spec for a ride.",
      inputSchema: z.object({
        ride_uuid: z.string().uuid(),
      }),
    },
    async ({ ride_uuid }, env) => {
      const [ride, intervalsRes, peaksRes] = await Promise.all([
        env.DB.prepare("SELECT * FROM rides WHERE ride_uuid = ?")
          .bind(ride_uuid)
          .first<RideRow>(),
        env.DB.prepare(
          "SELECT * FROM ride_intervals WHERE ride_uuid = ? ORDER BY step_index ASC"
        )
          .bind(ride_uuid)
          .all(),
        env.DB.prepare("SELECT * FROM ride_peaks WHERE ride_uuid = ? ORDER BY duration_s ASC")
          .bind(ride_uuid)
          .all(),
      ]);

      if (!ride) {
        throw new Error(`Ride not found: ${ride_uuid}`);
      }

      const linkedWorkout = ride.workout_id
        ? await env.DB.prepare("SELECT id, name, category, spec_json FROM workouts WHERE id = ?")
            .bind(ride.workout_id)
            .first<{ id: string; name: string; category: string; spec_json: string }>()
        : null;

      return {
        ride: {
          ...ride,
          power_zones: safeJsonParse(ride.power_zones_json, {}),
          hr_zones: safeJsonParse(ride.hr_zones_json, {}),
          quality_flags: safeJsonParse(ride.quality_flags_json, {}),
        },
        intervals: intervalsRes.results,
        peaks: peaksRes.results,
        workout: linkedWorkout
          ? {
              id: linkedWorkout.id,
              name: linkedWorkout.name,
              category: linkedWorkout.category,
              spec: safeJsonParse(linkedWorkout.spec_json, null),
            }
          : null,
      };
    }
  );

  registry.register(
    "get_ride_timeseries",
    {
      description:
        "Drill-down tool that decodes the stored .fit file from R2 and returns downsampled time-series points (power, HR, cadence, speed) at the requested bucket resolution.",
      inputSchema: z.object({
        ride_uuid: z.string().uuid(),
        bucket_seconds: z.number().int().min(5).max(300).default(30),
      }),
    },
    async ({ ride_uuid, bucket_seconds }, env) => {
      const ride = await env.DB.prepare(
        "SELECT ride_uuid, name, r2_fit_key FROM rides WHERE ride_uuid = ?"
      )
        .bind(ride_uuid)
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
      const points = downsampleRecords(parsed.samples, bucket_seconds);

      return {
        ride_uuid: ride.ride_uuid,
        name: ride.name,
        bucket_seconds,
        raw_samples: parsed.samples.length,
        points,
      };
    }
  );

  registry.register(
    "get_calendar",
    {
      description:
        "Returns planned sessions and completed rides within [start_date, end_date], plus projected CTL/ATL/TSB if upcoming planned sessions are completed.",
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    },
    async ({ start_date, end_date }, env) => {
      const [sessionsRes, ridesRes, baselinePmc] = await Promise.all([
        env.DB.prepare(
          `SELECT ps.*, w.name AS workout_name, w.category AS workout_category,
                  w.duration_s AS planned_duration_s, w.predicted_if, w.predicted_tss
           FROM planned_sessions ps
           JOIN workouts w ON w.id = ps.workout_id
           WHERE ps.scheduled_date >= ? AND ps.scheduled_date <= ?
           ORDER BY ps.scheduled_date ASC`
        )
          .bind(start_date, end_date)
          .all<{
            id: string;
            scheduled_date: string;
            workout_id: string;
            status: string;
            coach_rationale: string;
            completed_ride_uuid: string | null;
            workout_name: string;
            workout_category: string;
            planned_duration_s: number;
            predicted_if: number | null;
            predicted_tss: number | null;
          }>(),
        env.DB.prepare(
          `SELECT ride_uuid, name, source, ride_day, duration_s, np_watts, intensity_factor, tss, compliance_pct, rpe, feel
           FROM rides
           WHERE ride_day >= ? AND ride_day <= ?
           ORDER BY started_at ASC`
        )
          .bind(start_date, end_date)
          .all(),
        env.DB.prepare(
          "SELECT day, ctl, atl FROM daily_pmc ORDER BY day DESC LIMIT 8"
        ).all<{ day: string; ctl: number; atl: number }>(),
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
      description: "Lists workouts in the saved library filtered by category or search query.",
      inputSchema: z.object({
        category: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    },
    async ({ category, query, limit }, env) => {
      const clauses = ["archived = 0"];
      const binds: (string | number)[] = [];
      if (category) {
        clauses.push("category = ?");
        binds.push(category);
      }
      if (query) {
        clauses.push("(name LIKE ? OR description LIKE ?)");
        binds.push(`%${query}%`, `%${query}%`);
      }
      binds.push(limit);

      const sql = `SELECT id, name, description, category, duration_s, predicted_np, predicted_if, predicted_tss, version, created_by, updated_at
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
    async ({ workout_id }, env) => {
      const row = await env.DB.prepare("SELECT * FROM workouts WHERE id = ? AND archived = 0")
        .bind(workout_id)
        .first<WorkoutRow>();
      if (!row) {
        throw new Error(`Workout not found: ${workout_id}`);
      }
      return {
        id: row.id,
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
}
