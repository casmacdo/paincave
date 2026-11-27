import { Hono } from "hono";
import { z } from "zod";
import { RideUploadSummarySchema, downsampleRecords, parseFitRecords } from "@paincave/shared";
import type { HonoAppContext } from "../types.js";
import { requireBridgeOrUiAuth, requireUiAuth } from "../lib/auth.js";
import { ingestRide, type RideRow } from "../lib/rides-service.js";
import { recomputePmcFromDay } from "../lib/pmc-store.js";
import { uploadFitToStrava } from "../lib/strava-client.js";

const PatchRideSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  rpe: z.number().int().min(1).max(10).nullable().optional(),
  feel: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createRideRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();

  // POST /api/rides allows either trainer-bridge (X-Bridge-Token) or UI session
  router.post("/", requireBridgeOrUiAuth, async (c) => {
    const userId = c.get("userId");
    const contentType = c.req.header("Content-Type") ?? "";
    let rawSummary: unknown = null;
    let fitBytes: Uint8Array | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const summaryEntry = form.get("summary");
      if (typeof summaryEntry !== "string") {
        return c.json({ error: "Missing 'summary' JSON field in multipart form" }, 400);
      }
      try {
        rawSummary = JSON.parse(summaryEntry);
      } catch {
        return c.json({ error: "Invalid JSON in 'summary' field" }, 400);
      }
      const fitEntry = form.get("fit");
      if (fitEntry instanceof File || (fitEntry && typeof fitEntry === "object" && "arrayBuffer" in fitEntry)) {
        const buf = await (fitEntry as Blob).arrayBuffer();
        fitBytes = new Uint8Array(buf);
      }
    } else {
      const body: unknown = await c.req.json().catch(() => null);
      if (body && typeof body === "object" && "summary" in body) {
        const obj = body as { summary: unknown; fit_base64?: unknown };
        rawSummary = obj.summary;
        if (typeof obj.fit_base64 === "string" && obj.fit_base64.length > 0) {
          fitBytes = decodeBase64Bytes(obj.fit_base64);
        }
      } else {
        rawSummary = body;
      }
    }

    const parsed = RideUploadSummarySchema.safeParse(rawSummary);
    if (!parsed.success) {
      return c.json({ error: "Invalid ride summary", issues: parsed.error.issues }, 400);
    }

    const res = await ingestRide(c.env, {
      userId,
      summary: parsed.data,
      fitBytes,
    });

    if (!res.idempotent && res.strava_upload_status === "pending") {
      try {
        c.executionCtx.waitUntil(uploadFitToStrava(c.env, res.ride_uuid, userId));
      } catch {
        await uploadFitToStrava(c.env, res.ride_uuid, userId);
      }
    }

    return c.json(res, res.idempotent ? 200 : 201);
  });

  router.get("/", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25)));
    const source = c.req.query("source");
    const sport = c.req.query("sport");

    const clauses = ["user_id = ?"];
    const binds: (string | number)[] = [userId];
    if (source && source !== "all") {
      clauses.push("source = ?");
      binds.push(source);
    }
    if (sport && sport !== "all") {
      clauses.push("sport = ?");
      binds.push(sport);
    }
    binds.push(limit);

    const sql = `SELECT * FROM rides WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT ?`;
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<RideRow>();
    return c.json({ rides: results });
  });

  router.get("/:ride_uuid", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const uuid = c.req.param("ride_uuid");
    const ride = await c.env.DB.prepare(
      "SELECT * FROM rides WHERE ride_uuid = ? AND user_id = ?"
    )
      .bind(uuid, userId)
      .first<RideRow>();

    if (!ride) {
      return c.json({ error: "Ride not found" }, 404);
    }

    const [intervalsRes, peaksRes, lapsRes] = await Promise.all([
      c.env.DB.prepare(
        "SELECT * FROM ride_intervals WHERE ride_uuid = ? ORDER BY step_index ASC"
      )
        .bind(uuid)
        .all(),
      c.env.DB.prepare("SELECT * FROM ride_peaks WHERE ride_uuid = ? ORDER BY duration_s ASC")
        .bind(uuid)
        .all(),
      c.env.DB.prepare(
        "SELECT * FROM activity_laps WHERE ride_uuid = ? AND user_id = ? ORDER BY lap_index ASC"
      )
        .bind(uuid, userId)
        .all(),
    ]);

    return c.json({
      ride,
      intervals: intervalsRes.results,
      peaks: peaksRes.results,
      laps: lapsRes.results,
    });
  });

  router.patch("/:ride_uuid", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const uuid = c.req.param("ride_uuid");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = PatchRideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid ride update", issues: parsed.error.issues }, 400);
    }

    const current = await c.env.DB.prepare(
      "SELECT * FROM rides WHERE ride_uuid = ? AND user_id = ?"
    )
      .bind(uuid, userId)
      .first<RideRow>();
    if (!current) {
      return c.json({ error: "Ride not found" }, 404);
    }

    await c.env.DB.prepare(
      `UPDATE rides
       SET name = ?, rpe = ?, feel = ?, notes = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE ride_uuid = ? AND user_id = ?`
    )
      .bind(
        parsed.data.name ?? current.name,
        parsed.data.rpe !== undefined ? parsed.data.rpe : current.rpe,
        parsed.data.feel !== undefined ? parsed.data.feel : current.feel,
        parsed.data.notes !== undefined ? parsed.data.notes : current.notes,
        uuid,
        userId
      )
      .run();

    const updated = await c.env.DB.prepare(
      "SELECT * FROM rides WHERE ride_uuid = ? AND user_id = ?"
    )
      .bind(uuid, userId)
      .first<RideRow>();
    return c.json({ ride: updated });
  });

  router.delete("/:ride_uuid", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const uuid = c.req.param("ride_uuid");
    const ride = await c.env.DB.prepare(
      "SELECT ride_uuid, ride_day, r2_fit_key FROM rides WHERE ride_uuid = ? AND user_id = ?"
    )
      .bind(uuid, userId)
      .first<{ ride_uuid: string; ride_day: string; r2_fit_key: string }>();
    if (!ride) {
      return c.json({ error: "Ride not found" }, 404);
    }

    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE planned_sessions
         SET completed_ride_uuid = NULL,
             status = 'planned',
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE completed_ride_uuid = ? AND user_id = ?`
      ).bind(uuid, userId),
      c.env.DB.prepare("DELETE FROM rides WHERE ride_uuid = ? AND user_id = ?").bind(uuid, userId),
    ]);
    await c.env.RIDES_BUCKET.delete(ride.r2_fit_key);
    await recomputePmcFromDay(c.env.DB, ride.ride_day, userId);

    return c.json({ ok: true });
  });

  router.get("/:ride_uuid/timeseries", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const uuid = c.req.param("ride_uuid");
    const rawBucket = Number(c.req.query("bucket_seconds") ?? 15);
    const bucketSeconds = Number.isFinite(rawBucket)
      ? Math.min(300, Math.max(5, Math.round(rawBucket)))
      : 15;

    const ride = await c.env.DB.prepare(
      "SELECT ride_uuid, name, r2_fit_key FROM rides WHERE ride_uuid = ? AND user_id = ?"
    )
      .bind(uuid, userId)
      .first<{ ride_uuid: string; name: string; r2_fit_key: string }>();

    if (!ride) {
      return c.json({ error: "Ride not found" }, 404);
    }

    const obj = await c.env.RIDES_BUCKET.get(ride.r2_fit_key);
    if (!obj) {
      return c.json({ error: "FIT file not found in R2" }, 404);
    }

    try {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const parsed = parseFitRecords(bytes);
      const points = downsampleRecords(parsed.samples, bucketSeconds);
      return c.json({
        ride_uuid: ride.ride_uuid,
        name: ride.name,
        bucket_seconds: bucketSeconds,
        raw_samples: parsed.samples.length,
        points,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unable to decode FIT timeseries" },
        422
      );
    }
  });

  router.get("/:ride_uuid/fit", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const uuid = c.req.param("ride_uuid");
    const ride = await c.env.DB.prepare(
      "SELECT r2_fit_key, name FROM rides WHERE ride_uuid = ? AND user_id = ?"
    )
      .bind(uuid, userId)
      .first<{ r2_fit_key: string; name: string }>();

    if (!ride) {
      return c.json({ error: "Ride not found" }, 404);
    }
    const obj = await c.env.RIDES_BUCKET.get(ride.r2_fit_key);
    if (!obj) {
      return c.json({ error: "FIT file not found in R2" }, 404);
    }

    return new Response(obj.body, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.ant.fit",
        "Content-Disposition": `attachment; filename="${uuid}.fit"`,
      },
    });
  });

  return router;
}
