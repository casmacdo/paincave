import { Hono } from "hono";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";
import {
  getWorkoutExport,
  saveValidatedWorkout,
  type WorkoutRow,
} from "../lib/workouts-service.js";
import { getLatestThresholds } from "./athlete.js";

function slugFilename(name: string, ext: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `${safe || "workout"}.${ext}`;
}

export function createWorkoutRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();
  router.use("*", requireUiAuth);

  router.get("/", async (c) => {
    const category = c.req.query("category");
    const q = c.req.query("q");

    const clauses = ["archived = 0"];
    const binds: string[] = [];
    if (category) {
      clauses.push("category = ?");
      binds.push(category);
    }
    if (q) {
      clauses.push("(name LIKE ? OR description LIKE ?)");
      binds.push(`%${q}%`, `%${q}%`);
    }

    const sql = `SELECT * FROM workouts WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`;
    const stmt = binds.length > 0 ? c.env.DB.prepare(sql).bind(...binds) : c.env.DB.prepare(sql);
    const { results } = await stmt.all<WorkoutRow>();
    return c.json({ workouts: results });
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const workout = await c.env.DB.prepare("SELECT * FROM workouts WHERE id = ? AND archived = 0")
      .bind(id)
      .first<WorkoutRow>();
    if (!workout) {
      return c.json({ error: "Workout not found" }, 404);
    }
    return c.json({ workout });
  });

  router.post("/", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const createdBy = c.req.query("source") === "import" ? "import" : "user";
    const res = await saveValidatedWorkout(c.env.DB, {
      rawSpec: body,
      createdBy,
    });
    if (!res.ok) {
      return c.json({ error: res.error, details: res.details }, res.status);
    }
    return c.json(
      { workout: res.workout, predicted: res.predicted, warnings: res.warnings },
      201
    );
  });

  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body: unknown = await c.req.json().catch(() => null);
    const res = await saveValidatedWorkout(c.env.DB, {
      workoutId: id,
      rawSpec: body,
      createdBy: "user",
    });
    if (!res.ok) {
      return c.json({ error: res.error, details: res.details }, res.status);
    }
    return c.json({ workout: res.workout, predicted: res.predicted, warnings: res.warnings });
  });

  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const res = await c.env.DB.prepare(
      "UPDATE workouts SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
    )
      .bind(id)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      return c.json({ error: "Workout not found" }, 404);
    }
    return c.json({ ok: true });
  });

  router.get("/:id/export.zwo", async (c) => {
    const exported = await getWorkoutExport(c.env.DB, c.req.param("id"), "zwo");
    if (!exported || typeof exported.content !== "string") {
      return c.json({ error: "Workout not found" }, 404);
    }
    return new Response(exported.content, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slugFilename(exported.workout.name, "zwo")}"`,
      },
    });
  });

  router.get("/:id/export.erg", async (c) => {
    const exported = await getWorkoutExport(c.env.DB, c.req.param("id"), "erg");
    if (!exported || typeof exported.content !== "string") {
      return c.json({ error: "Workout not found" }, 404);
    }
    return new Response(exported.content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slugFilename(exported.workout.name, "erg")}"`,
      },
    });
  });

  router.get("/:id/flattened", async (c) => {
    const exported = await getWorkoutExport(c.env.DB, c.req.param("id"), "flattened");
    if (!exported || typeof exported.content === "string") {
      return c.json({ error: "Workout not found" }, 404);
    }
    const thresholds = await getLatestThresholds(c.env.DB);
    return c.json({
      workout_id: exported.workout.id,
      name: exported.workout.name,
      ftp_watts: exported.ftp_watts,
      lthr_bpm: thresholds?.lthr_bpm ?? null,
      hrmax_bpm: thresholds?.hrmax_bpm ?? null,
      weight_kg: thresholds?.weight_kg ?? null,
      steps: exported.content,
    });
  });

  return router;
}
