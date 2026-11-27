import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";

export interface AthleteThresholdRow {
  id: string;
  effective_from: string;
  ftp_watts: number;
  lthr_bpm: number | null;
  hrmax_bpm: number | null;
  hrrest_bpm: number | null;
  cp_watts: number | null;
  w_prime_j: number | null;
  weight_kg: number | null;
  notes: string | null;
  created_at: string;
}

export interface TrainingBlockRow {
  id: string;
  name: string;
  goal_event: string | null;
  target_date: string | null;
  phase: "base" | "build" | "peak" | "taper" | "recovery";
  start_date: string;
  end_date: string | null;
  weekly_hours_target: number;
  constraints_json: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface CoachingNoteRow {
  id: string;
  category: "injury" | "preference" | "response" | "equipment" | "schedule" | "general";
  content: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export const ProfileUpdateSchema = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  units: z.enum(["metric", "imperial"]).optional(),
});

export const ThresholdCreateSchema = z.object({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ftp_watts: z.number().int().min(50).max(600),
  lthr_bpm: z.number().int().min(100).max(230).nullable().optional(),
  hrmax_bpm: z.number().int().min(120).max(240).nullable().optional(),
  hrrest_bpm: z.number().int().min(25).max(120).nullable().optional(),
  cp_watts: z.number().int().min(50).max(600).nullable().optional(),
  w_prime_j: z.number().int().min(2000).max(60000).nullable().optional(),
  weight_kg: z.number().min(35).max(200).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const TrainingBlockInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  goal_event: z.string().trim().max(160).nullable().optional(),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  phase: z.enum(["base", "build", "peak", "taper", "recovery"]),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  weekly_hours_target: z.number().positive().max(35),
  constraints: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean().default(true),
});

export const CoachingNoteInputSchema = z.object({
  category: z.enum(["injury", "preference", "response", "equipment", "schedule", "general"]),
  content: z.string().trim().min(1).max(1000),
});

export async function getLatestThresholds(
  db: D1Database,
  asOfDay?: string
): Promise<AthleteThresholdRow | null> {
  if (asOfDay) {
    const row = await db
      .prepare(
        "SELECT * FROM athlete_thresholds WHERE effective_from <= ? ORDER BY effective_from DESC, created_at DESC LIMIT 1"
      )
      .bind(asOfDay)
      .first<AthleteThresholdRow>();
    if (row) return row;
  }
  return db
    .prepare(
      "SELECT * FROM athlete_thresholds ORDER BY effective_from DESC, created_at DESC LIMIT 1"
    )
    .first<AthleteThresholdRow>();
}

export async function getEffectiveFtp(db: D1Database, asOfDay?: string): Promise<number> {
  const row = await getLatestThresholds(db, asOfDay);
  return row?.ftp_watts ?? 250;
}

export function createAthleteRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();
  router.use("*", requireUiAuth);

  router.get("/profile", async (c) => {
    const profile = await c.env.DB.prepare("SELECT * FROM athlete_profile WHERE id = 1").first();
    const latestThresholds = await getLatestThresholds(c.env.DB);
    return c.json({ profile, latest_thresholds: latestThresholds });
  });

  router.put("/profile", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ProfileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid profile payload", issues: parsed.error.issues }, 400);
    }

    const current = await c.env.DB.prepare("SELECT * FROM athlete_profile WHERE id = 1").first<{
      display_name: string;
      timezone: string;
      units: string;
    }>();

    const displayName = parsed.data.display_name ?? current?.display_name ?? "Athlete";
    const timezone = parsed.data.timezone ?? current?.timezone ?? "UTC";
    const units = parsed.data.units ?? current?.units ?? "metric";

    await c.env.DB.prepare(
      "UPDATE athlete_profile SET display_name = ?, timezone = ?, units = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 1"
    )
      .bind(displayName, timezone, units)
      .run();

    const updated = await c.env.DB.prepare("SELECT * FROM athlete_profile WHERE id = 1").first();
    return c.json({ profile: updated });
  });

  router.get("/thresholds", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM athlete_thresholds ORDER BY effective_from DESC, created_at DESC"
    ).all<AthleteThresholdRow>();
    return c.json({ thresholds: results });
  });

  router.post("/thresholds", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ThresholdCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid threshold payload", issues: parsed.error.issues }, 400);
    }
    const id = crypto.randomUUID();
    const d = parsed.data;
    await c.env.DB.prepare(
      `INSERT INTO athlete_thresholds
        (id, effective_from, ftp_watts, lthr_bpm, hrmax_bpm, hrrest_bpm, cp_watts, w_prime_j, weight_kg, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        d.effective_from,
        d.ftp_watts,
        d.lthr_bpm ?? null,
        d.hrmax_bpm ?? null,
        d.hrrest_bpm ?? null,
        d.cp_watts ?? null,
        d.w_prime_j ?? null,
        d.weight_kg ?? null,
        d.notes ?? null
      )
      .run();

    const created = await c.env.DB.prepare("SELECT * FROM athlete_thresholds WHERE id = ?")
      .bind(id)
      .first<AthleteThresholdRow>();
    return c.json({ threshold: created }, 201);
  });

  router.get("/blocks", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM training_blocks ORDER BY active DESC, start_date DESC"
    ).all<TrainingBlockRow>();
    return c.json({ blocks: results });
  });

  router.post("/blocks", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = TrainingBlockInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid training block", issues: parsed.error.issues }, 400);
    }
    const id = crypto.randomUUID();
    const d = parsed.data;
    await c.env.DB.prepare(
      `INSERT INTO training_blocks
        (id, name, goal_event, target_date, phase, start_date, end_date, weekly_hours_target, constraints_json, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        d.name,
        d.goal_event ?? null,
        d.target_date ?? null,
        d.phase,
        d.start_date,
        d.end_date ?? null,
        d.weekly_hours_target,
        JSON.stringify(d.constraints),
        d.active ? 1 : 0
      )
      .run();

    const block = await c.env.DB.prepare("SELECT * FROM training_blocks WHERE id = ?")
      .bind(id)
      .first<TrainingBlockRow>();
    return c.json({ block }, 201);
  });

  router.put("/blocks/:id", async (c) => {
    const id = c.req.param("id");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = TrainingBlockInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid training block", issues: parsed.error.issues }, 400);
    }
    const d = parsed.data;
    const res = await c.env.DB.prepare(
      `UPDATE training_blocks
       SET name = ?, goal_event = ?, target_date = ?, phase = ?, start_date = ?, end_date = ?,
           weekly_hours_target = ?, constraints_json = ?, active = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`
    )
      .bind(
        d.name,
        d.goal_event ?? null,
        d.target_date ?? null,
        d.phase,
        d.start_date,
        d.end_date ?? null,
        d.weekly_hours_target,
        JSON.stringify(d.constraints),
        d.active ? 1 : 0,
        id
      )
      .run();

    if ((res.meta.changes ?? 0) === 0) {
      return c.json({ error: "Training block not found" }, 404);
    }
    const block = await c.env.DB.prepare("SELECT * FROM training_blocks WHERE id = ?")
      .bind(id)
      .first<TrainingBlockRow>();
    return c.json({ block });
  });

  router.get("/notes", async (c) => {
    const includeArchived = c.req.query("archived") === "1";
    const sql = includeArchived
      ? "SELECT * FROM coaching_notes ORDER BY active DESC, created_at DESC"
      : "SELECT * FROM coaching_notes WHERE active = 1 ORDER BY created_at DESC";
    const { results } = await c.env.DB.prepare(sql).all<CoachingNoteRow>();
    return c.json({ notes: results });
  });

  router.post("/notes", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = CoachingNoteInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid training note", issues: parsed.error.issues }, 400);
    }
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO coaching_notes (id, category, content, active) VALUES (?, ?, ?, 1)"
    )
      .bind(id, parsed.data.category, parsed.data.content)
      .run();

    const note = await c.env.DB.prepare("SELECT * FROM coaching_notes WHERE id = ?")
      .bind(id)
      .first<CoachingNoteRow>();
    return c.json({ note }, 201);
  });

  router.delete("/notes/:id", async (c) => {
    const id = c.req.param("id");
    const res = await c.env.DB.prepare(
      "UPDATE coaching_notes SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
    )
      .bind(id)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      return c.json({ error: "Training note not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return router;
}
