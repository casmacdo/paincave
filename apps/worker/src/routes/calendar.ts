import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";
import { scheduleWorkoutSession } from "../lib/workouts-service.js";

const ScheduleBodySchema = z.object({
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  workout_id: z.string().min(1),
  coach_rationale: z.string().max(1000).optional(),
  replace_existing: z.boolean().optional(),
});

const PatchSessionSchema = z.object({
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["planned", "completed", "skipped"]).optional(),
  coach_rationale: z.string().max(1000).optional(),
});

export function createCalendarRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();
  router.use("*", requireUiAuth);

  router.get("/", async (c) => {
    const userId = c.get("userId");
    const start = c.req.query("start") ?? "1970-01-01";
    const end = c.req.query("end") ?? "2999-12-31";

    const [sessionsRes, ridesRes] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ps.*, w.name AS workout_name, w.sport AS workout_sport, w.category AS workout_category,
                w.duration_s AS planned_duration_s, w.predicted_if, w.predicted_tss
         FROM planned_sessions ps
         JOIN workouts w ON w.id = ps.workout_id AND w.user_id = ps.user_id
         WHERE ps.user_id = ? AND ps.scheduled_date >= ? AND ps.scheduled_date <= ?
         ORDER BY ps.scheduled_date ASC`
      )
        .bind(userId, start, end)
        .all(),
      c.env.DB.prepare(
        `SELECT ride_uuid, sport, name, source, workout_id, started_at, ride_day, duration_s,
                distance_m, avg_pace_s_per_km, np_watts, intensity_factor, tss, avg_hr, compliance_pct, rpe, feel
         FROM rides
         WHERE user_id = ? AND ride_day >= ? AND ride_day <= ?
         ORDER BY started_at ASC`
      )
        .bind(userId, start, end)
        .all(),
    ]);

    return c.json({
      planned_sessions: sessionsRes.results,
      completed_rides: ridesRes.results,
    });
  });

  router.post("/sessions", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ScheduleBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid schedule payload", issues: parsed.error.issues }, 400);
    }

    const res = await scheduleWorkoutSession(c.env.DB, {
      userId,
      scheduledDate: parsed.data.scheduled_date,
      workoutId: parsed.data.workout_id,
      coachRationale: parsed.data.coach_rationale,
      replaceExisting: parsed.data.replace_existing,
    });

    if (!res.ok) {
      return c.json({ error: res.error }, res.status);
    }
    return c.json({ session: res.session, warnings: res.warnings }, 201);
  });

  router.patch("/sessions/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = PatchSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid session update", issues: parsed.error.issues }, 400);
    }

    const current = await c.env.DB.prepare(
      "SELECT * FROM planned_sessions WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .first<{ scheduled_date: string; status: string; coach_rationale: string }>();
    if (!current) {
      return c.json({ error: "Planned session not found" }, 404);
    }

    await c.env.DB.prepare(
      `UPDATE planned_sessions
       SET scheduled_date = ?, status = ?, coach_rationale = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ? AND user_id = ?`
    )
      .bind(
        parsed.data.scheduled_date ?? current.scheduled_date,
        parsed.data.status ?? current.status,
        parsed.data.coach_rationale ?? current.coach_rationale,
        id,
        userId
      )
      .run();

    const updated = await c.env.DB.prepare(
      "SELECT * FROM planned_sessions WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .first();
    return c.json({ session: updated });
  });

  router.delete("/sessions/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const res = await c.env.DB.prepare(
      "DELETE FROM planned_sessions WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      return c.json({ error: "Planned session not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return router;
}
