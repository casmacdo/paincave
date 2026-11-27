import { Hono } from "hono";
import { z } from "zod";
import { RideUploadSummarySchema } from "@paincave/shared";
import type { HonoAppContext } from "../types.js";
import { requireImporterOrUiAuth } from "../lib/auth.js";
import { upsertDailyBiometrics } from "../lib/garmin-sync.js";
import { rebuildAllPmcForUser } from "../lib/pmc-store.js";
import { ingestRide, type ActivityLapInput } from "../lib/rides-service.js";

const LapSchema = z.object({
  lap_index: z.number().int().nonnegative(),
  duration_s: z.number().int().nonnegative(),
  distance_m: z.number().nullable().optional(),
  avg_pace_s_per_km: z.number().nullable().optional(),
  gap_s_per_km: z.number().nullable().optional(),
  avg_power: z.number().int().nullable().optional(),
  avg_hr: z.number().int().nullable().optional(),
  max_hr: z.number().int().nullable().optional(),
  avg_cadence: z.number().int().nullable().optional(),
  elevation_gain_m: z.number().nullable().optional(),
  elevation_loss_m: z.number().nullable().optional(),
});

const BatchActivitySchema = z.object({
  summary: RideUploadSummarySchema,
  sport: z.enum(["cycling", "running", "strength", "mobility", "other"]).default("cycling"),
  sub_sport: z.string().max(80).nullable().optional(),
  external_provider: z.enum(["strava_archive", "garmin_archive", "garmin_personal", "manual_fit"]),
  external_id: z.string().min(1).max(120),
  distance_m: z.number().nonnegative().nullable().optional(),
  elevation_gain_m: z.number().nonnegative().nullable().optional(),
  elevation_loss_m: z.number().nonnegative().nullable().optional(),
  avg_pace_s_per_km: z.number().positive().nullable().optional(),
  gap_s_per_km: z.number().positive().nullable().optional(),
  pa_hr_decoupling: z.number().nullable().optional(),
  threshold_pace_snapshot: z.number().positive().nullable().optional(),
  laps: z.array(LapSchema).max(200).optional(),
  fit_base64: z.string().max(4_000_000).optional(),
});

const BiometricSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hrv_rmssd_ms: z.number().nullable().optional(),
  hrv_status: z.string().max(40).nullable().optional(),
  resting_hr_bpm: z.number().int().nullable().optional(),
  sleep_duration_s: z.number().int().nullable().optional(),
  sleep_deep_s: z.number().int().nullable().optional(),
  sleep_rem_s: z.number().int().nullable().optional(),
  sleep_light_s: z.number().int().nullable().optional(),
  sleep_awake_s: z.number().int().nullable().optional(),
  sleep_score: z.number().int().nullable().optional(),
  body_battery_high: z.number().int().nullable().optional(),
  body_battery_low: z.number().int().nullable().optional(),
  body_battery_charged: z.number().int().nullable().optional(),
  stress_avg: z.number().int().nullable().optional(),
  steps: z.number().int().nullable().optional(),
  spo2_avg: z.number().nullable().optional(),
  weight_kg: z.number().nullable().optional(),
  cycle_phase: z.string().max(40).nullable().optional(),
});

const BatchImportBodySchema = z.object({
  activities: z.array(BatchActivitySchema).max(50).default([]),
  biometrics: z.array(BiometricSchema).max(120).default([]),
  source: z.string().max(60).default("archive_import"),
});

function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createImportRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();

  // Accept either per-user importer token (X-Importer-Token / Authorization: Bearer) or UI session
  router.use("*", requireImporterOrUiAuth);

  router.post("/batch", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = BatchImportBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid batch import payload", issues: parsed.error.issues }, 400);
    }

    let imported = 0;
    let skipped = 0;

    for (const item of parsed.data.activities) {
      const fitBytes =
        item.fit_base64 && item.fit_base64.length > 0 ? decodeBase64Bytes(item.fit_base64) : null;
      const laps: ActivityLapInput[] = item.laps ?? [];

      const res = await ingestRide(c.env, {
        userId,
        summary: item.summary,
        fitBytes,
        sport: item.sport,
        subSport: item.sub_sport ?? null,
        externalProvider: item.external_provider,
        externalId: item.external_id,
        distanceM: item.distance_m ?? null,
        elevationGainM: item.elevation_gain_m ?? null,
        elevationLossM: item.elevation_loss_m ?? null,
        avgPaceSPerKm: item.avg_pace_s_per_km ?? null,
        gapSPerKm: item.gap_s_per_km ?? null,
        paHrDecoupling: item.pa_hr_decoupling ?? null,
        thresholdPaceSnapshot: item.threshold_pace_snapshot ?? null,
        laps,
        skipPmcRecompute: true,
      });

      if (res.idempotent) skipped++;
      else imported++;
    }

    const biometricsUpserted = await upsertDailyBiometrics(
      c.env.DB,
      userId,
      parsed.data.biometrics,
      parsed.data.source
    );

    return c.json({
      ok: true,
      imported,
      skipped,
      biometrics_upserted: biometricsUpserted,
    });
  });

  router.post("/rebuild-pmc", async (c) => {
    const userId = c.get("userId");
    const res = await rebuildAllPmcForUser(c.env.DB, userId);
    return c.json({ ok: true, ...res });
  });

  return router;
}
