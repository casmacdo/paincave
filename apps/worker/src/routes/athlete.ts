import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";
import { DEFAULT_OWNER_USER_ID, ensureAthleteProfile } from "../lib/better-auth.js";

export interface AthleteProfileRow {
  user_id: string;
  display_name: string;
  timezone: string;
  units: "metric" | "imperial";
  primary_sports_json: string;
  features_json: string;
  created_at: string;
  updated_at: string;
}

export interface AthleteThresholdRow {
  id: string;
  user_id: string;
  effective_from: string;
  ftp_watts: number | null;
  threshold_pace_s_per_km: number | null;
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
  user_id: string;
  name: string;
  sport: string | null;
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
  user_id: string;
  category: "injury" | "preference" | "response" | "equipment" | "schedule" | "health" | "general";
  sport: string | null;
  content: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export const ProfileUpdateSchema = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  units: z.enum(["metric", "imperial"]).optional(),
  primary_sports: z.array(z.enum(["cycling", "running", "strength", "mobility"])).min(1).max(6).optional(),
  features: z
    .object({
      indoor_trainer: z.boolean().optional(),
    })
    .optional(),
});

export const ThresholdCreateSchema = z.object({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ftp_watts: z.number().int().min(50).max(600).nullable().optional(),
  threshold_pace_s_per_km: z.number().min(120).max(900).nullable().optional(),
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
  sport: z.enum(["cycling", "running", "strength", "mobility", "other"]).nullable().optional(),
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
  category: z.enum(["injury", "preference", "response", "equipment", "schedule", "health", "general"]),
  sport: z.enum(["cycling", "running", "strength", "mobility", "other"]).nullable().optional(),
  content: z.string().trim().min(1).max(1000),
});

export async function getLatestThresholds(
  db: D1Database,
  userId = DEFAULT_OWNER_USER_ID,
  asOfDay?: string
): Promise<AthleteThresholdRow | null> {
  if (asOfDay) {
    const row = await db
      .prepare(
        "SELECT * FROM athlete_thresholds WHERE user_id = ? AND effective_from <= ? ORDER BY effective_from DESC, created_at DESC LIMIT 1"
      )
      .bind(userId, asOfDay)
      .first<AthleteThresholdRow>();
    if (row) return row;
  }
  return db
    .prepare(
      "SELECT * FROM athlete_thresholds WHERE user_id = ? ORDER BY effective_from DESC, created_at DESC LIMIT 1"
    )
    .bind(userId)
    .first<AthleteThresholdRow>();
}

export async function getEffectiveFtp(
  db: D1Database,
  userId = DEFAULT_OWNER_USER_ID,
  asOfDay?: string
): Promise<number> {
  const row = await getLatestThresholds(db, userId, asOfDay);
  return row?.ftp_watts ?? 250;
}

export async function getEffectiveThresholdPace(
  db: D1Database,
  userId = DEFAULT_OWNER_USER_ID,
  asOfDay?: string
): Promise<number | null> {
  const row = await getLatestThresholds(db, userId, asOfDay);
  return row?.threshold_pace_s_per_km ?? null;
}

function formatProfileResponse(row: AthleteProfileRow | null) {
  if (!row) return null;
  let primarySports: string[] = ["cycling"];
  let features: { indoor_trainer: boolean } = { indoor_trainer: true };
  try {
    const parsed = JSON.parse(row.primary_sports_json) as unknown;
    if (Array.isArray(parsed)) {
      primarySports = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // keep default
  }
  try {
    const parsed = JSON.parse(row.features_json) as { indoor_trainer?: unknown };
    if (typeof parsed.indoor_trainer === "boolean") {
      features = { indoor_trainer: parsed.indoor_trainer };
    }
  } catch {
    // keep default
  }
  return {
    ...row,
    primary_sports: primarySports,
    features,
  };
}

export function createAthleteRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();
  router.use("*", requireUiAuth);

  router.get("/profile", async (c) => {
    const userId = c.get("userId");
    await ensureAthleteProfile(c.env.DB, userId);
    const [profile, latestThresholds] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM athlete_profile WHERE user_id = ?")
        .bind(userId)
        .first<AthleteProfileRow>(),
      getLatestThresholds(c.env.DB, userId),
    ]);
    return c.json({
      profile: formatProfileResponse(profile),
      latest_thresholds: latestThresholds,
    });
  });

  router.put("/profile", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ProfileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid profile payload", issues: parsed.error.issues }, 400);
    }

    await ensureAthleteProfile(c.env.DB, userId);
    const current = await c.env.DB.prepare("SELECT * FROM athlete_profile WHERE user_id = ?")
      .bind(userId)
      .first<AthleteProfileRow>();

    const displayName = parsed.data.display_name ?? current?.display_name ?? "Athlete";
    const timezone = parsed.data.timezone ?? current?.timezone ?? "UTC";
    const units = parsed.data.units ?? current?.units ?? "metric";
    const primarySportsJson = parsed.data.primary_sports
      ? JSON.stringify(parsed.data.primary_sports)
      : (current?.primary_sports_json ?? '["cycling"]');

    let currentFeatures: Record<string, unknown> = { indoor_trainer: true };
    try {
      currentFeatures = JSON.parse(current?.features_json ?? '{"indoor_trainer":true}') as Record<
        string,
        unknown
      >;
    } catch {
      // keep default
    }
    const mergedFeatures = parsed.data.features
      ? { ...currentFeatures, ...parsed.data.features }
      : currentFeatures;

    await c.env.DB.prepare(
      `UPDATE athlete_profile
       SET display_name = ?, timezone = ?, units = ?, primary_sports_json = ?, features_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE user_id = ?`
    )
      .bind(
        displayName,
        timezone,
        units,
        primarySportsJson,
        JSON.stringify(mergedFeatures),
        userId
      )
      .run();

    const updated = await c.env.DB.prepare("SELECT * FROM athlete_profile WHERE user_id = ?")
      .bind(userId)
      .first<AthleteProfileRow>();
    return c.json({ profile: formatProfileResponse(updated) });
  });

  router.get("/thresholds", async (c) => {
    const userId = c.get("userId");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM athlete_thresholds WHERE user_id = ? ORDER BY effective_from DESC, created_at DESC"
    )
      .bind(userId)
      .all<AthleteThresholdRow>();
    return c.json({ thresholds: results });
  });

  router.post("/thresholds", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ThresholdCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid threshold payload", issues: parsed.error.issues }, 400);
    }
    const id = crypto.randomUUID();
    const d = parsed.data;
    await c.env.DB.prepare(
      `INSERT INTO athlete_thresholds
        (id, user_id, effective_from, ftp_watts, threshold_pace_s_per_km, lthr_bpm, hrmax_bpm, hrrest_bpm, cp_watts, w_prime_j, weight_kg, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        userId,
        d.effective_from,
        d.ftp_watts ?? null,
        d.threshold_pace_s_per_km ?? null,
        d.lthr_bpm ?? null,
        d.hrmax_bpm ?? null,
        d.hrrest_bpm ?? null,
        d.cp_watts ?? null,
        d.w_prime_j ?? null,
        d.weight_kg ?? null,
        d.notes ?? null
      )
      .run();

    const created = await c.env.DB.prepare(
      "SELECT * FROM athlete_thresholds WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .first<AthleteThresholdRow>();
    return c.json({ threshold: created }, 201);
  });

  router.get("/blocks", async (c) => {
    const userId = c.get("userId");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM training_blocks WHERE user_id = ? ORDER BY active DESC, start_date DESC"
    )
      .bind(userId)
      .all<TrainingBlockRow>();
    return c.json({ blocks: results });
  });

  router.post("/blocks", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = TrainingBlockInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid training block", issues: parsed.error.issues }, 400);
    }
    const id = crypto.randomUUID();
    const d = parsed.data;
    await c.env.DB.prepare(
      `INSERT INTO training_blocks
        (id, user_id, name, sport, goal_event, target_date, phase, start_date, end_date, weekly_hours_target, constraints_json, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        userId,
        d.name,
        d.sport ?? null,
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

    const block = await c.env.DB.prepare(
      "SELECT * FROM training_blocks WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .first<TrainingBlockRow>();
    return c.json({ block }, 201);
  });

  router.put("/blocks/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = TrainingBlockInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid training block", issues: parsed.error.issues }, 400);
    }
    const d = parsed.data;
    const res = await c.env.DB.prepare(
      `UPDATE training_blocks
       SET name = ?, sport = ?, goal_event = ?, target_date = ?, phase = ?, start_date = ?, end_date = ?,
           weekly_hours_target = ?, constraints_json = ?, active = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ? AND user_id = ?`
    )
      .bind(
        d.name,
        d.sport ?? null,
        d.goal_event ?? null,
        d.target_date ?? null,
        d.phase,
        d.start_date,
        d.end_date ?? null,
        d.weekly_hours_target,
        JSON.stringify(d.constraints),
        d.active ? 1 : 0,
        id,
        userId
      )
      .run();

    if ((res.meta.changes ?? 0) === 0) {
      return c.json({ error: "Training block not found" }, 404);
    }
    const block = await c.env.DB.prepare(
      "SELECT * FROM training_blocks WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .first<TrainingBlockRow>();
    return c.json({ block });
  });

  router.get("/notes", async (c) => {
    const userId = c.get("userId");
    const includeArchived = c.req.query("archived") === "1";
    const sql = includeArchived
      ? "SELECT * FROM coaching_notes WHERE user_id = ? ORDER BY active DESC, created_at DESC"
      : "SELECT * FROM coaching_notes WHERE user_id = ? AND active = 1 ORDER BY created_at DESC";
    const { results } = await c.env.DB.prepare(sql).bind(userId).all<CoachingNoteRow>();
    return c.json({ notes: results });
  });

  router.post("/notes", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = CoachingNoteInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid training note", issues: parsed.error.issues }, 400);
    }
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO coaching_notes (id, user_id, category, sport, content, active) VALUES (?, ?, ?, ?, ?, 1)"
    )
      .bind(id, userId, parsed.data.category, parsed.data.sport ?? null, parsed.data.content)
      .run();

    const note = await c.env.DB.prepare("SELECT * FROM coaching_notes WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<CoachingNoteRow>();
    return c.json({ note }, 201);
  });

  router.delete("/notes/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const res = await c.env.DB.prepare(
      "UPDATE coaching_notes SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      return c.json({ error: "Training note not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return router;
}
