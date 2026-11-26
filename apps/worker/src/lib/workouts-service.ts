import {
  WorkoutSpecSchema,
  flattenWorkout,
  toErgText,
  toZwoXml,
  validateWorkoutGuardrails,
  type FlattenedStep,
  type WorkoutLoadPrediction,
  type WorkoutSpec,
} from "@paincave/shared";
import { getEffectiveFtp, type TrainingBlockRow } from "../routes/athlete.js";

export interface WorkoutRow {
  id: string;
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
      spec: WorkoutSpec;
      predicted: WorkoutLoadPrediction;
      warnings: string[];
      dry_run: boolean;
    }
  | { ok: false; status: 400 | 404; error: string; details?: string[] }
> {
  const parsed = WorkoutSpecSchema.safeParse(params.rawSpec);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: "Invalid workout specification",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const spec = parsed.data;
  const ftp = await getEffectiveFtp(db);
  const guardrails = validateWorkoutGuardrails(spec, ftp);
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
         SET name = ?, description = ?, category = ?, spec_json = ?, duration_s = ?,
             predicted_np = ?, predicted_if = ?, predicted_tss = ?, zone_distribution_json = ?,
             version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND archived = 0`
      )
      .bind(
        spec.name,
        spec.description,
        spec.category,
        JSON.stringify(spec),
        guardrails.predicted.duration_s,
        guardrails.predicted.np_watts,
        guardrails.predicted.intensity_factor,
        guardrails.predicted.tss,
        JSON.stringify(guardrails.predicted.zone_seconds),
        workoutId
      )
      .run();

    if ((res.meta.changes ?? 0) === 0) {
      return { ok: false, status: 404, error: "Workout not found" };
    }
  } else {
    await db
      .prepare(
        `INSERT INTO workouts
          (id, name, description, category, spec_json, duration_s, predicted_np, predicted_if, predicted_tss, zone_distribution_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        workoutId,
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
    .prepare("SELECT * FROM workouts WHERE id = ?")
    .bind(workoutId)
    .first<WorkoutRow>();

  return {
    ok: true,
    workout: row,
    workout_id: workoutId,
    spec,
    predicted: guardrails.predicted,
    warnings: guardrails.warnings,
    dry_run: false,
  };
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export async function checkDayConstraints(
  db: D1Database,
  scheduledDate: string,
  workoutDurationS: number
): Promise<string[]> {
  const warnings: string[] = [];
  const [y, m, d] = scheduledDate.split("-").map(Number);
  if (!y || !m || !d) return warnings;

  const dayKey = DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  if (!dayKey) return warnings;

  const block = await db
    .prepare(
      `SELECT * FROM training_blocks
       WHERE active = 1 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       ORDER BY start_date DESC LIMIT 1`
    )
    .bind(scheduledDate, scheduledDate)
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

export async function scheduleWorkoutSession(
  db: D1Database,
  params: {
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
  const workout = await db
    .prepare("SELECT * FROM workouts WHERE id = ? AND archived = 0")
    .bind(params.workoutId)
    .first<WorkoutRow>();

  if (!workout) {
    return { ok: false, status: 404, error: "Workout not found" };
  }

  const existing = await db
    .prepare(
      "SELECT * FROM planned_sessions WHERE scheduled_date = ? AND status = 'planned' LIMIT 1"
    )
    .bind(params.scheduledDate)
    .first<PlannedSessionRow>();

  if (existing && !params.replaceExisting) {
    return {
      ok: false,
      status: 409,
      error: `A planned session already exists on ${params.scheduledDate}. Set replace_existing=true to replace it.`,
    };
  }

  const warnings = await checkDayConstraints(db, params.scheduledDate, workout.duration_s);
  const id = crypto.randomUUID();

  if (existing && params.replaceExisting) {
    await db
      .prepare(
        `UPDATE planned_sessions
         SET workout_id = ?, coach_rationale = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`
      )
      .bind(workout.id, params.coachRationale ?? "", existing.id)
      .run();
    const updated = await db
      .prepare("SELECT * FROM planned_sessions WHERE id = ?")
      .bind(existing.id)
      .first<PlannedSessionRow>();
    return { ok: true, session: updated, workout, warnings };
  }

  await db
    .prepare(
      `INSERT INTO planned_sessions (id, scheduled_date, workout_id, status, coach_rationale)
       VALUES (?, ?, ?, 'planned', ?)`
    )
    .bind(id, params.scheduledDate, workout.id, params.coachRationale ?? "")
    .run();

  const created = await db
    .prepare("SELECT * FROM planned_sessions WHERE id = ?")
    .bind(id)
    .first<PlannedSessionRow>();

  return { ok: true, session: created, workout, warnings };
}

export async function getWorkoutExport(
  db: D1Database,
  workoutId: string,
  format: "zwo" | "erg" | "flattened"
): Promise<{
  workout: WorkoutRow;
  ftp_watts: number;
  content: string | FlattenedStep[];
} | null> {
  const workout = await db
    .prepare("SELECT * FROM workouts WHERE id = ?")
    .bind(workoutId)
    .first<WorkoutRow>();
  if (!workout) return null;

  const spec = WorkoutSpecSchema.parse(JSON.parse(workout.spec_json));
  const ftp = await getEffectiveFtp(db);
  if (format === "zwo") {
    return { workout, ftp_watts: ftp, content: toZwoXml(spec, ftp) };
  }
  if (format === "erg") {
    return { workout, ftp_watts: ftp, content: toErgText(spec, ftp) };
  }
  return { workout, ftp_watts: ftp, content: flattenWorkout(spec, ftp) };
}
