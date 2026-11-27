import {
  AnyWorkoutSpecSchema,
  RunWorkoutSpecSchema,
  StrengthWorkoutSpecSchema,
  WorkoutSpecSchema,
  encodeWorkoutToFit,
  flattenWorkout,
  getWorkoutSpecSport,
  isHeavyLowerBodyStrength,
  predictRunWorkoutLoad,
  toErgText,
  toZwoXml,
  validateAnyWorkoutGuardrails,
  type AnyWorkoutSpec,
  type FlattenedStep,
  type MultiSportGuardrailResult,
  type WorkoutSport,
} from "@paincave/shared";
import { DEFAULT_OWNER_USER_ID } from "./better-auth.js";
import {
  getEffectiveFtp,
  getEffectiveThresholdPace,
  type TrainingBlockRow,
} from "../routes/athlete.js";

export interface WorkoutRow {
  id: string;
  user_id: string;
  sport: "cycling" | "running" | "strength" | "mobility";
  name: string;
  description: string;
  category: string;
  spec_json: string;
  duration_s: number;
  predicted_np: number | null;
  predicted_if: number | null;
  predicted_tss: number | null;
  zone_distribution_json: string;
  version: number;
  archived: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PlannedSessionRow {
  id: string;
  user_id: string;
  scheduled_date: string;
  workout_id: string;
  status: "planned" | "completed" | "skipped";
  coach_rationale: string;
  completed_ride_uuid: string | null;
  created_at: string;
  updated_at: string;
}

export async function saveValidatedWorkout(
  db: D1Database,
  params: {
    userId?: string;
    workoutId?: string;
    rawSpec: unknown;
    createdBy: "user" | "llm" | "import";
    dryRun?: boolean;
  }
): Promise<
  | {
      ok: true;
      workout: WorkoutRow | null;
      workout_id: string;
      sport: WorkoutSport;
      spec: AnyWorkoutSpec;
      predicted: MultiSportGuardrailResult["predicted"];
      warnings: string[];
      dry_run: boolean;
    }
  | { ok: false; status: 400 | 404; error: string; details?: string[] }
> {
  const userId = params.userId ?? DEFAULT_OWNER_USER_ID;
  const parsed = AnyWorkoutSpecSchema.safeParse(params.rawSpec);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: "Invalid workout specification",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const spec = parsed.data;
  const sport = getWorkoutSpecSport(spec);
  const [ftp, thresholdPace] = await Promise.all([
    getEffectiveFtp(db, userId),
    getEffectiveThresholdPace(db, userId),
  ]);
  const guardrails = validateAnyWorkoutGuardrails(spec, {
    ftpWatts: ftp,
    thresholdPaceSPerKm: thresholdPace,
  });
  if (!guardrails.valid) {
    return {
      ok: false,
      status: 400,
      error: "Workout violates physiological guardrails",
      details: guardrails.errors,
    };
  }

  const workoutId = params.workoutId ?? crypto.randomUUID();
  if (params.dryRun) {
    return {
      ok: true,
      workout: null,
      workout_id: workoutId,
      sport,
      spec,
      predicted: guardrails.predicted,
      warnings: guardrails.warnings,
      dry_run: true,
    };
  }

  if (params.workoutId) {
    const res = await db
      .prepare(
        `UPDATE workouts
         SET sport = ?, name = ?, description = ?, category = ?, spec_json = ?, duration_s = ?,
             predicted_np = ?, predicted_if = ?, predicted_tss = ?, zone_distribution_json = ?,
             version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND user_id = ? AND archived = 0`
      )
      .bind(
        sport,
        spec.name,
        spec.description,
        spec.category,
        JSON.stringify(spec),
        guardrails.predicted.duration_s,
        guardrails.predicted.np_watts,
        guardrails.predicted.intensity_factor,
        guardrails.predicted.tss,
        JSON.stringify(guardrails.predicted.zone_seconds),
        workoutId,
        userId
      )
      .run();

    if ((res.meta.changes ?? 0) === 0) {
      return { ok: false, status: 404, error: "Workout not found" };
    }
  } else {
    await db
      .prepare(
        `INSERT INTO workouts
          (id, user_id, sport, name, description, category, spec_json, duration_s, predicted_np, predicted_if, predicted_tss, zone_distribution_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        workoutId,
        userId,
        sport,
        spec.name,
        spec.description,
        spec.category,
        JSON.stringify(spec),
        guardrails.predicted.duration_s,
        guardrails.predicted.np_watts,
        guardrails.predicted.intensity_factor,
        guardrails.predicted.tss,
        JSON.stringify(guardrails.predicted.zone_seconds),
        params.createdBy
      )
      .run();
  }

  const row = await db
    .prepare("SELECT * FROM workouts WHERE id = ? AND user_id = ?")
    .bind(workoutId, userId)
    .first<WorkoutRow>();

  return {
    ok: true,
    workout: row,
    workout_id: workoutId,
    sport,
    spec,
    predicted: guardrails.predicted,
    warnings: guardrails.warnings,
    dry_run: false,
  };
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const QUALITY_CATEGORIES = new Set([
  "tempo",
  "threshold",
  "vo2max",
  "anaerobic",
  "sprint",
  "intervals",
  "hills",
  "race",
]);

function shiftIsoDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function weekBoundsIso(day: string): { weekStart: string; weekEnd: string } {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return { weekStart: day, weekEnd: day };
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const offsetToMon = dow === 0 ? -6 : 1 - dow;
  return {
    weekStart: shiftIsoDay(day, offsetToMon),
    weekEnd: shiftIsoDay(day, offsetToMon + 6),
  };
}

export async function checkDayConstraints(
  db: D1Database,
  scheduledDate: string,
  workoutDurationS: number,
  userId = DEFAULT_OWNER_USER_ID
): Promise<string[]> {
  const warnings: string[] = [];
  const [y, m, d] = scheduledDate.split("-").map(Number);
  if (!y || !m || !d) return warnings;

  const dayKey = DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  if (!dayKey) return warnings;

  const block = await db
    .prepare(
      `SELECT * FROM training_blocks
       WHERE user_id = ? AND active = 1 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       ORDER BY start_date DESC LIMIT 1`
    )
    .bind(userId, scheduledDate, scheduledDate)
    .first<TrainingBlockRow>();

  if (!block) return warnings;

  let constraints: Record<string, unknown> = {};
  try {
    constraints = JSON.parse(block.constraints_json) as Record<string, unknown>;
  } catch {
    return warnings;
  }

  const dayRule = constraints[dayKey];
  if (dayRule === "rest") {
    warnings.push(`Scheduled workout on '${dayKey}', which active block '${block.name}' marks as rest.`);
  }

  const maxMinVal = constraints[`${dayKey}_max_min`];
  if (typeof maxMinVal === "number" && maxMinVal > 0) {
    const workoutMin = Math.round(workoutDurationS / 60);
    if (workoutMin > maxMinVal) {
      warnings.push(
        `Workout duration (${workoutMin}m) exceeds '${dayKey}_max_min' constraint (${maxMinVal}m) in block '${block.name}'.`
      );
    }
  }

  return warnings;
}

async function checkMultiSportScheduleGuardrails(
  db: D1Database,
  userId: string,
  scheduledDate: string,
  workout: WorkoutRow
): Promise<string[]> {
  const warnings: string[] = [];
  const prevDay = shiftIsoDay(scheduledDate, -1);
  const nextDay = shiftIsoDay(scheduledDate, 1);

  const adjacentRes = await db
    .prepare(
      `SELECT ps.scheduled_date, w.name, w.sport, w.category, w.predicted_if, w.spec_json
       FROM planned_sessions ps
       JOIN workouts w ON w.id = ps.workout_id AND w.user_id = ps.user_id
       WHERE ps.user_id = ? AND ps.status = 'planned'
         AND ps.scheduled_date >= ? AND ps.scheduled_date <= ?
         AND ps.scheduled_date != ?`
    )
    .bind(userId, prevDay, nextDay, scheduledDate)
    .all<{
      scheduled_date: string;
      name: string;
      sport: string;
      category: string;
      predicted_if: number | null;
      spec_json: string;
    }>();

  if (workout.sport === "running") {
    const parsedRun = RunWorkoutSpecSchema.safeParse(JSON.parse(workout.spec_json));
    if (parsedRun.success) {
      const tp = await getEffectiveThresholdPace(db, userId);
      const pred = predictRunWorkoutLoad(parsedRun.data, tp ?? undefined);

      // Check back-to-back quality run days
      if (pred.is_quality_session) {
        const adjQuality = adjacentRes.results.find(
          (a) =>
            a.sport === "running" &&
            (QUALITY_CATEGORIES.has(a.category) || (a.predicted_if ?? 0) >= 0.92)
        );
        if (adjQuality) {
          warnings.push(
            `Back-to-back quality running sessions (${adjQuality.name} on ${adjQuality.scheduled_date}); consider separating hard run days.`
          );
        }
      }

      // Check weekly running volume jump >15% vs trailing 4-week average
      const { weekStart, weekEnd } = weekBoundsIso(scheduledDate);
      const fourWeeksPriorStart = shiftIsoDay(weekStart, -28);
      const fourWeeksPriorEnd = shiftIsoDay(weekStart, -1);

      const [histRun, weekPlannedRuns, weekDoneRuns] = await Promise.all([
        db
          .prepare(
            `SELECT COALESCE(SUM(distance_m), 0) AS total_m
             FROM rides
             WHERE user_id = ? AND sport = 'running' AND ride_day >= ? AND ride_day <= ?`
          )
          .bind(userId, fourWeeksPriorStart, fourWeeksPriorEnd)
          .first<{ total_m: number }>(),
        db
          .prepare(
            `SELECT w.spec_json
             FROM planned_sessions ps
             JOIN workouts w ON w.id = ps.workout_id AND w.user_id = ps.user_id
             WHERE ps.user_id = ? AND ps.status = 'planned' AND w.sport = 'running'
               AND ps.scheduled_date >= ? AND ps.scheduled_date <= ? AND ps.scheduled_date != ?`
          )
          .bind(userId, weekStart, weekEnd, scheduledDate)
          .all<{ spec_json: string }>(),
        db
          .prepare(
            `SELECT COALESCE(SUM(distance_m), 0) AS total_m
             FROM rides
             WHERE user_id = ? AND sport = 'running' AND ride_day >= ? AND ride_day <= ?`
          )
          .bind(userId, weekStart, weekEnd)
          .first<{ total_m: number }>(),
      ]);

      const recentWeeklyKm = ((histRun?.total_m ?? 0) / 1000) / 4;
      if (recentWeeklyKm > 5) {
        let plannedKm = (weekDoneRuns?.total_m ?? 0) / 1000 + pred.distance_m / 1000;
        for (const r of weekPlannedRuns.results) {
          try {
            const sp = RunWorkoutSpecSchema.safeParse(JSON.parse(r.spec_json));
            if (sp.success) {
              plannedKm += predictRunWorkoutLoad(sp.data, tp ?? undefined).distance_m / 1000;
            }
          } catch {
            // ignore malformed
          }
        }
        const pctJump = ((plannedKm - recentWeeklyKm) / recentWeeklyKm) * 100;
        if (pctJump > 15) {
          warnings.push(
            `Weekly running volume would jump +${pctJump.toFixed(0)}% (${plannedKm.toFixed(1)} km vs ${recentWeeklyKm.toFixed(1)} km 4-week avg, >15% guideline).`
          );
        }
      }
    }
  } else if (workout.sport === "strength") {
    const parsedStr = StrengthWorkoutSpecSchema.safeParse(JSON.parse(workout.spec_json));
    if (parsedStr.success && isHeavyLowerBodyStrength(parsedStr.data)) {
      const keyEndurance = adjacentRes.results.find(
        (a) =>
          (a.sport === "cycling" || a.sport === "running") &&
          (QUALITY_CATEGORIES.has(a.category) || (a.predicted_if ?? 0) >= 0.88)
      );
      if (keyEndurance) {
        warnings.push(
          `Heavy lower-body strength within 24h of key endurance session (${keyEndurance.name} on ${keyEndurance.scheduled_date}); consider spacing by >=24h.`
        );
      }
    }
  }

  return warnings;
}

export async function scheduleWorkoutSession(
  db: D1Database,
  params: {
    userId?: string;
    scheduledDate: string;
    workoutId: string;
    coachRationale?: string;
    replaceExisting?: boolean;
  }
): Promise<
  | {
      ok: true;
      session: PlannedSessionRow | null;
      workout: WorkoutRow;
      warnings: string[];
    }
  | { ok: false; status: 404 | 409; error: string }
> {
  const userId = params.userId ?? DEFAULT_OWNER_USER_ID;
  const workout = await db
    .prepare("SELECT * FROM workouts WHERE id = ? AND user_id = ? AND archived = 0")
    .bind(params.workoutId, userId)
    .first<WorkoutRow>();

  if (!workout) {
    return { ok: false, status: 404, error: "Workout not found" };
  }

  const existing = await db
    .prepare(
      "SELECT * FROM planned_sessions WHERE user_id = ? AND scheduled_date = ? AND status = 'planned' LIMIT 1"
    )
    .bind(userId, params.scheduledDate)
    .first<PlannedSessionRow>();

  if (existing && !params.replaceExisting) {
    return {
      ok: false,
      status: 409,
      error: `A planned session already exists on ${params.scheduledDate}. Set replace_existing=true to replace it.`,
    };
  }

  const [blockWarnings, sportWarnings] = await Promise.all([
    checkDayConstraints(db, params.scheduledDate, workout.duration_s, userId),
    checkMultiSportScheduleGuardrails(db, userId, params.scheduledDate, workout),
  ]);
  const warnings = [...blockWarnings, ...sportWarnings];
  const id = crypto.randomUUID();

  if (existing && params.replaceExisting) {
    await db
      .prepare(
        `UPDATE planned_sessions
         SET workout_id = ?, coach_rationale = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND user_id = ?`
      )
      .bind(workout.id, params.coachRationale ?? "", existing.id, userId)
      .run();
    const updated = await db
      .prepare("SELECT * FROM planned_sessions WHERE id = ? AND user_id = ?")
      .bind(existing.id, userId)
      .first<PlannedSessionRow>();
    return { ok: true, session: updated, workout, warnings };
  }

  await db
    .prepare(
      `INSERT INTO planned_sessions (id, user_id, scheduled_date, workout_id, status, coach_rationale)
       VALUES (?, ?, ?, ?, 'planned', ?)`
    )
    .bind(id, userId, params.scheduledDate, workout.id, params.coachRationale ?? "")
    .run();

  const created = await db
    .prepare("SELECT * FROM planned_sessions WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<PlannedSessionRow>();

  return { ok: true, session: created, workout, warnings };
}

export async function getWorkoutExport(
  db: D1Database,
  workoutId: string,
  format: "zwo" | "erg" | "flattened",
  userId = DEFAULT_OWNER_USER_ID
): Promise<{
  workout: WorkoutRow;
  ftp_watts: number;
  content: string | FlattenedStep[];
} | null> {
  const workout = await db
    .prepare("SELECT * FROM workouts WHERE id = ? AND user_id = ?")
    .bind(workoutId, userId)
    .first<WorkoutRow>();
  if (!workout) return null;

  const parsed = WorkoutSpecSchema.safeParse(JSON.parse(workout.spec_json));
  if (!parsed.success) {
    return null;
  }
  const spec = parsed.data;
  const ftp = await getEffectiveFtp(db, userId);
  if (format === "zwo") {
    return { workout, ftp_watts: ftp, content: toZwoXml(spec, ftp) };
  }
  if (format === "erg") {
    return { workout, ftp_watts: ftp, content: toErgText(spec, ftp) };
  }
  return { workout, ftp_watts: ftp, content: flattenWorkout(spec, ftp) };
}

export async function getWorkoutFitExport(
  db: D1Database,
  workoutId: string,
  userId = DEFAULT_OWNER_USER_ID
): Promise<{
  workout: WorkoutRow;
  fitBytes: Uint8Array;
} | null> {
  const workout = await db
    .prepare("SELECT * FROM workouts WHERE id = ? AND user_id = ?")
    .bind(workoutId, userId)
    .first<WorkoutRow>();
  if (!workout) return null;

  const parsed = AnyWorkoutSpecSchema.safeParse(JSON.parse(workout.spec_json));
  if (!parsed.success) return null;

  const [ftp, thresholdPace] = await Promise.all([
    getEffectiveFtp(db, userId),
    getEffectiveThresholdPace(db, userId),
  ]);

  const fitBytes = encodeWorkoutToFit(parsed.data, {
    ftpWatts: ftp,
    thresholdPaceSPerKm: thresholdPace,
    createdAtIso: workout.updated_at,
  });

  return { workout, fitBytes };
}
