import { Hono } from "hono";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";
import {
  getWorkoutExport,
  getWorkoutFitExport,
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
    const userId = c.get("userId");
    const category = c.req.query("category");
    const sport = c.req.query("sport");
    const q = c.req.query("q");

    const clauses = ["user_id = ?", "archived = 0"];
    const binds: string[] = [userId];
    if (sport && sport !== "all") {
      clauses.push("sport = ?");
      binds.push(sport);
    }
    if (category) {
      clauses.push("category = ?");
      binds.push(category);
    }
    if (q) {
      clauses.push("(name LIKE ? OR description LIKE ?)");
      binds.push(`%${q}%`, `%${q}%`);
    }

    const sql = `SELECT * FROM workouts WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`;
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<WorkoutRow>();
    return c.json({ workouts: results });
  });

  router.get("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const workout = await c.env.DB.prepare(
      "SELECT * FROM workouts WHERE id = ? AND user_id = ? AND archived = 0"
    )
      .bind(id, userId)
      .first<WorkoutRow>();
    if (!workout) {
      return c.json({ error: "Workout not found" }, 404);
    }
    return c.json({ workout });
  });

  router.post("/", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const createdBy = c.req.query("source") === "import" ? "import" : "user";
    const res = await saveValidatedWorkout(c.env.DB, {
      userId,
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
    const userId = c.get("userId");
    const id = c.req.param("id");
    const body: unknown = await c.req.json().catch(() => null);
    const res = await saveValidatedWorkout(c.env.DB, {
      userId,
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
    const userId = c.get("userId");
    const id = c.req.param("id");
    const res = await c.env.DB.prepare(
      "UPDATE workouts SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      return c.json({ error: "Workout not found" }, 404);
    }
    return c.json({ ok: true });
  });

  router.get("/:id/export.fit", async (c) => {
    const userId = c.get("userId");
    const exported = await getWorkoutFitExport(c.env.DB, c.req.param("id"), userId);
    if (!exported) {
      return c.json({ error: "Workout not found" }, 404);
    }
    return new Response(exported.fitBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.ant.fit",
        "Content-Disposition": `attachment; filename="${slugFilename(exported.workout.name, "fit")}"`,
      },
    });
  });

  router.get("/:id/export", async (c) => {
    const userId = c.get("userId");
    const format = (c.req.query("format") ?? "fit").toLowerCase();
    const id = c.req.param("id");
    if (format === "fit") {
      const exported = await getWorkoutFitExport(c.env.DB, id, userId);
      if (!exported) return c.json({ error: "Workout not found" }, 404);
      return new Response(exported.fitBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.ant.fit",
          "Content-Disposition": `attachment; filename="${slugFilename(exported.workout.name, "fit")}"`,
        },
      });
    }
    if (format === "zwo" || format === "erg") {
      const exported = await getWorkoutExport(c.env.DB, id, format, userId);
      if (!exported || typeof exported.content !== "string") {
        return c.json({ error: "Workout not found or unsupported format for sport" }, 404);
      }
      return new Response(exported.content, {
        status: 200,
        headers: {
          "Content-Type":
            format === "zwo" ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${slugFilename(exported.workout.name, format)}"`,
        },
      });
    }
    return c.json({ error: "Unsupported export format. Expected fit, zwo, or erg." }, 400);
  });

  router.get("/:id/export.zwo", async (c) => {
    const userId = c.get("userId");
    const exported = await getWorkoutExport(c.env.DB, c.req.param("id"), "zwo", userId);
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
    const userId = c.get("userId");
    const exported = await getWorkoutExport(c.env.DB, c.req.param("id"), "erg", userId);
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
    const userId = c.get("userId");
    const exported = await getWorkoutExport(c.env.DB, c.req.param("id"), "flattened", userId);
    if (!exported || typeof exported.content === "string") {
      return c.json({ error: "Workout not found" }, 404);
    }
    const thresholds = await getLatestThresholds(c.env.DB, userId);
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
