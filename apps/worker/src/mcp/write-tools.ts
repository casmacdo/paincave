import { z } from "zod";
import { WorkoutSpecSchema, computeDailyPmc } from "@paincave/shared";
import { optionalCoercedBoolean, type McpToolRegistry } from "./protocol.js";
import { saveValidatedWorkout, scheduleWorkoutSession } from "../lib/workouts-service.js";
import { todayUtcDay } from "../lib/pmc-store.js";
import {
  CoachingNoteInputSchema,
  ThresholdCreateSchema,
  TrainingBlockInputSchema,
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

export function registerWriteTools(registry: McpToolRegistry): void {
  registry.register(
    "create_workout",
    {
      description:
        "Validates a canonical WorkoutSpec JSON against hard physiological guardrails, computes deterministic duration/NP/IF/TSS/zones, and persists it (unless dry_run=true).",
      inputSchema: z.object({
        spec: WorkoutSpecSchema,
        dry_run: optionalCoercedBoolean(),
      }),
    },
    async ({ spec, dry_run }, env) => {
      const res = await saveValidatedWorkout(env.DB, {
        rawSpec: spec,
        createdBy: "llm",
        dryRun: dry_run ?? false,
      });
      if (!res.ok) {
        throw new Error(`${res.error}: ${(res.details ?? []).join("; ")}`);
      }
      return {
        workout_id: res.workout_id,
        name: res.spec.name,
        dry_run: res.dry_run,
        predicted: res.predicted,
        warnings: res.warnings,
      };
    }
  );

  registry.register(
    "update_workout",
    {
      description:
        "Updates an existing saved workout with guardrail validation and deterministic load predictions.",
      inputSchema: z.object({
        workout_id: z.string().min(1),
        spec: WorkoutSpecSchema,
        dry_run: optionalCoercedBoolean(),
      }),
    },
    async ({ workout_id, spec, dry_run }, env) => {
      const res = await saveValidatedWorkout(env.DB, {
        workoutId: workout_id,
        rawSpec: spec,
        createdBy: "llm",
        dryRun: dry_run ?? false,
      });
      if (!res.ok) {
        throw new Error(`${res.error}: ${(res.details ?? []).join("; ")}`);
      }
      return {
        workout_id: res.workout_id,
        name: res.spec.name,
        dry_run: res.dry_run,
        predicted: res.predicted,
        warnings: res.warnings,
      };
    }
  );

  registry.register(
    "schedule_workout",
    {
      description:
        "Schedules a workout on YYYY-MM-DD, checks active training block day-of-week constraints, and returns projected CTL/ATL/TSB and 7-day ramp rate.",
      inputSchema: z.object({
        scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        workout_id: z.string().min(1),
        coach_rationale: z.string().max(1000).optional(),
        replace_existing: optionalCoercedBoolean(),
      }),
    },
    async ({ scheduled_date, workout_id, coach_rationale, replace_existing }, env) => {
      const res = await scheduleWorkoutSession(env.DB, {
        scheduledDate: scheduled_date,
        workoutId: workout_id,
        coachRationale: coach_rationale,
        replaceExisting: replace_existing ?? false,
      });
      if (!res.ok) {
        throw new Error(res.error);
      }

      // Compute deterministic projected PMC through scheduled_date
      const [baselineRes, plannedRes] = await Promise.all([
        env.DB.prepare("SELECT day, ctl, atl FROM daily_pmc ORDER BY day DESC LIMIT 8").all<{
          day: string;
          ctl: number;
          atl: number;
        }>(),
        env.DB.prepare(
          `SELECT ps.scheduled_date AS day, w.predicted_tss AS tss
           FROM planned_sessions ps
           JOIN workouts w ON w.id = ps.workout_id
           WHERE ps.status = 'planned' AND ps.scheduled_date <= ?`
        )
          .bind(scheduled_date)
          .all<{ day: string; tss: number | null }>(),
      ]);

      const latest = baselineRes.results[0];
      const startDay = latest ? shiftDay(latest.day, 1) : todayUtcDay();
      const projEnd = scheduled_date >= startDay ? scheduled_date : startDay;
      const inputs = plannedRes.results
        .filter((r) => r.day >= startDay)
        .map((r) => ({ day: r.day, total_tss: r.tss ?? 0 }));

      const projected = computeDailyPmc(inputs, {
        startDay,
        endDay: projEnd,
        initialCtl: latest?.ctl ?? 0,
        initialAtl: latest?.atl ?? 0,
        priorCtlWindow: baselineRes.results
          .slice(0, 7)
          .reverse()
          .map((r) => r.ctl),
      });
      const onDate = projected.find((p) => p.day === scheduled_date) ?? projected.at(-1) ?? null;

      return {
        session: res.session,
        workout_name: res.workout.name,
        predicted_tss: res.workout.predicted_tss,
        projected_pmc_on_date: onDate,
        warnings: res.warnings,
      };
    }
  );

  registry.register(
    "move_or_cancel_session",
    {
      description: "Moves a planned session to a new date, marks it skipped, or deletes it.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        action: z.enum(["move", "skip", "delete"]),
        new_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        reason: z.string().max(500).optional(),
      }),
    },
    async ({ session_id, action, new_date, reason }, env) => {
      if (action === "delete") {
        const res = await env.DB.prepare("DELETE FROM planned_sessions WHERE id = ?")
          .bind(session_id)
          .run();
        if ((res.meta.changes ?? 0) === 0) throw new Error(`Session not found: ${session_id}`);
        return { ok: true, action, session_id };
      }

      if (action === "skip") {
        const res = await env.DB.prepare(
          `UPDATE planned_sessions
           SET status = 'skipped',
               coach_rationale = CASE WHEN ? != '' THEN ? ELSE coach_rationale END,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = ?`
        )
          .bind(reason ?? "", reason ?? "", session_id)
          .run();
        if ((res.meta.changes ?? 0) === 0) throw new Error(`Session not found: ${session_id}`);
        return { ok: true, action, session_id };
      }

      if (!new_date) {
        throw new Error("new_date is required when action='move'");
      }
      const res = await env.DB.prepare(
        `UPDATE planned_sessions
         SET scheduled_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`
      )
        .bind(new_date, session_id)
        .run();
      if ((res.meta.changes ?? 0) === 0) throw new Error(`Session not found: ${session_id}`);
      const updated = await env.DB.prepare("SELECT * FROM planned_sessions WHERE id = ?")
        .bind(session_id)
        .first();
      return { ok: true, action, session: updated };
    }
  );

  registry.register(
    "upsert_training_block",
    {
      description:
        "Creates or updates a training block defining goal event, phase, weekly hours target, and day-of-week schedule constraints.",
      inputSchema: TrainingBlockInputSchema.extend({
        id: z.string().min(1).optional(),
      }),
    },
    async (args, env) => {
      const id = args.id ?? crypto.randomUUID();
      if (args.id) {
        const res = await env.DB.prepare(
          `UPDATE training_blocks
           SET name = ?, goal_event = ?, target_date = ?, phase = ?, start_date = ?, end_date = ?,
               weekly_hours_target = ?, constraints_json = ?, active = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = ?`
        )
          .bind(
            args.name,
            args.goal_event ?? null,
            args.target_date ?? null,
            args.phase,
            args.start_date,
            args.end_date ?? null,
            args.weekly_hours_target,
            JSON.stringify(args.constraints),
            args.active ? 1 : 0,
            id
          )
          .run();
        if ((res.meta.changes ?? 0) === 0) throw new Error(`Training block not found: ${id}`);
      } else {
        await env.DB.prepare(
          `INSERT INTO training_blocks
            (id, name, goal_event, target_date, phase, start_date, end_date, weekly_hours_target, constraints_json, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            id,
            args.name,
            args.goal_event ?? null,
            args.target_date ?? null,
            args.phase,
            args.start_date,
            args.end_date ?? null,
            args.weekly_hours_target,
            JSON.stringify(args.constraints),
            args.active ? 1 : 0
          )
          .run();
      }
      const block = await env.DB.prepare("SELECT * FROM training_blocks WHERE id = ?")
        .bind(id)
        .first();
      return { block };
    }
  );

  registry.register(
    "save_coaching_note",
    {
      description:
        "Stores a durable training note (injury, preference, training response, equipment, schedule) for future planning and analysis.",
      inputSchema: CoachingNoteInputSchema,
    },
    async ({ category, content }, env) => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO coaching_notes (id, category, content, active) VALUES (?, ?, ?, 1)"
      )
        .bind(id, category, content)
        .run();
      const note = await env.DB.prepare("SELECT * FROM coaching_notes WHERE id = ?")
        .bind(id)
        .first();
      return { note };
    }
  );

  registry.register(
    "archive_coaching_note",
    {
      description: "Archives an outdated training note so it no longer appears in active context.",
      inputSchema: z.object({
        note_id: z.string().min(1),
      }),
    },
    async ({ note_id }, env) => {
      const res = await env.DB.prepare(
        "UPDATE coaching_notes SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
      )
        .bind(note_id)
        .run();
      if ((res.meta.changes ?? 0) === 0) throw new Error(`Training note not found: ${note_id}`);
      return { ok: true, note_id };
    }
  );

  registry.register(
    "log_threshold_update",
    {
      description:
        "Appends a new dated athlete threshold snapshot (FTP, LTHR, HRmax, CP, W', weight) without altering historical ride snapshots.",
      inputSchema: ThresholdCreateSchema,
    },
    async (args, env) => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO athlete_thresholds
          (id, effective_from, ftp_watts, lthr_bpm, hrmax_bpm, hrrest_bpm, cp_watts, w_prime_j, weight_kg, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          args.effective_from,
          args.ftp_watts,
          args.lthr_bpm ?? null,
          args.hrmax_bpm ?? null,
          args.hrrest_bpm ?? null,
          args.cp_watts ?? null,
          args.w_prime_j ?? null,
          args.weight_kg ?? null,
          args.notes ?? null
        )
        .run();
      const threshold = await env.DB.prepare("SELECT * FROM athlete_thresholds WHERE id = ?")
        .bind(id)
        .first();
      return { threshold };
    }
  );
}
