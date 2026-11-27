import { Hono } from "hono";
import { z } from "zod";
import {
  BUILT_IN_ROUTE_PRESETS,
  extractRouteFromSamples,
  getBuiltInRoutePreset,
  parseFitRecords,
  parseGpxRoute,
  type RoutePoint,
} from "@paincave/shared";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";

interface RouteRow {
  id: string;
  name: string;
  source: "gpx" | "fit_extract" | "preset";
  distance_m: number;
  total_ascent_m: number;
  max_grade_pct: number;
  point_count: number;
  r2_route_key: string;
  created_at: string;
}

export interface RouteListItem {
  id: string;
  name: string;
  source: "gpx" | "fit_extract" | "preset";
  description: string;
  distance_m: number;
  total_ascent_m: number;
  max_grade_pct: number;
  point_count: number;
  loop_route: boolean;
  is_preset: boolean;
  created_at: string | null;
}

const GpxJsonSchema = z.object({
  name: z.string().trim().min(1).max(140).optional(),
  gpx_xml: z.string().min(20).max(5_000_000),
});

function rowToItem(row: RouteRow): RouteListItem {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    description: row.source === "fit_extract" ? "Extracted from recorded FIT ride" : "Imported GPX route",
    distance_m: row.distance_m,
    total_ascent_m: row.total_ascent_m,
    max_grade_pct: row.max_grade_pct,
    point_count: row.point_count,
    loop_route: false,
    is_preset: false,
    created_at: row.created_at,
  };
}

export function createRouteRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();
  router.use("*", requireUiAuth);

  router.get("/", async (c) => {
    const userId = c.get("userId");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM routes WHERE user_id = ? ORDER BY created_at DESC"
    )
      .bind(userId)
      .all<RouteRow>();

    const userRoutes: RouteListItem[] = results.map(rowToItem);
    const presetRoutes: RouteListItem[] = BUILT_IN_ROUTE_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      source: "preset",
      description: p.description,
      distance_m: p.distance_m,
      total_ascent_m: p.total_ascent_m,
      max_grade_pct: p.max_grade_pct,
      point_count: p.points.length,
      loop_route: p.loop_route,
      is_preset: true,
      created_at: null,
    }));

    return c.json({ routes: [...userRoutes, ...presetRoutes] });
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const preset = getBuiltInRoutePreset(id);
    if (preset) {
      return c.json({
        route: {
          id: preset.id,
          name: preset.name,
          source: "preset",
          description: preset.description,
          distance_m: preset.distance_m,
          total_ascent_m: preset.total_ascent_m,
          max_grade_pct: preset.max_grade_pct,
          point_count: preset.points.length,
          loop_route: preset.loop_route,
          is_preset: true,
          created_at: null,
        } satisfies RouteListItem,
        points: preset.points,
      });
    }

    const userId = c.get("userId");
    const row = await c.env.DB.prepare("SELECT * FROM routes WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<RouteRow>();
    if (!row) {
      return c.json({ error: "Route not found" }, 404);
    }

    const obj = await c.env.RIDES_BUCKET.get(row.r2_route_key);
    if (!obj) {
      return c.json({ error: "Route geometry missing from storage" }, 404);
    }
    const data = await obj.json<{ points?: RoutePoint[] }>();
    return c.json({
      route: rowToItem(row),
      points: data.points ?? [],
    });
  });

  router.post("/gpx", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    let gpxXml = "";
    let fallbackName = "Imported GPX Route";

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      const nameField = form?.get("name");
      if (!(file instanceof File)) {
        return c.json({ error: "Missing 'file' field in multipart upload" }, 400);
      }
      if (file.size > 5_000_000) {
        return c.json({ error: "GPX file exceeds 5 MB limit" }, 400);
      }
      gpxXml = await file.text();
      fallbackName =
        typeof nameField === "string" && nameField.trim().length > 0
          ? nameField.trim()
          : file.name || fallbackName;
    } else {
      const body: unknown = await c.req.json().catch(() => null);
      const parsed = GpxJsonSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid GPX route payload", issues: parsed.error.issues }, 400);
      }
      gpxXml = parsed.data.gpx_xml;
      fallbackName = parsed.data.name ?? fallbackName;
    }

    let analyzed;
    try {
      analyzed = parseGpxRoute(gpxXml, fallbackName);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to parse GPX route" },
        400
      );
    }

    const userId = c.get("userId");
    const id = crypto.randomUUID();
    const r2Key = `users/${userId}/routes/${id}.json`;
    const createdAt = new Date().toISOString();

    await c.env.RIDES_BUCKET.put(r2Key, JSON.stringify({ points: analyzed.points }), {
      httpMetadata: { contentType: "application/json" },
    });

    await c.env.DB.prepare(
      `INSERT INTO routes (id, user_id, name, source, distance_m, total_ascent_m, max_grade_pct, point_count, r2_route_key, created_at)
       VALUES (?, ?, ?, 'gpx', ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        userId,
        analyzed.name,
        analyzed.distance_m,
        analyzed.total_ascent_m,
        analyzed.max_grade_pct,
        analyzed.points.length,
        r2Key,
        createdAt
      )
      .run();

    const row: RouteRow = {
      id,
      name: analyzed.name,
      source: "gpx",
      distance_m: analyzed.distance_m,
      total_ascent_m: analyzed.total_ascent_m,
      max_grade_pct: analyzed.max_grade_pct,
      point_count: analyzed.points.length,
      r2_route_key: r2Key,
      created_at: createdAt,
    };

    return c.json({ route: rowToItem(row), points: analyzed.points }, 201);
  });

  router.post("/from-ride/:ride_uuid", async (c) => {
    const userId = c.get("userId");
    const rideUuid = c.req.param("ride_uuid");
    const ride = await c.env.DB.prepare(
      "SELECT ride_uuid, name, r2_fit_key FROM rides WHERE ride_uuid = ? AND user_id = ?"
    )
      .bind(rideUuid, userId)
      .first<{ ride_uuid: string; name: string; r2_fit_key: string }>();
    if (!ride) {
      return c.json({ error: "Ride not found" }, 404);
    }

    const fitObj = await c.env.RIDES_BUCKET.get(ride.r2_fit_key);
    if (!fitObj) {
      return c.json({ error: "FIT file missing from storage" }, 404);
    }

    let analyzed;
    try {
      const fitBytes = new Uint8Array(await fitObj.arrayBuffer());
      const parsed = parseFitRecords(fitBytes);
      analyzed = extractRouteFromSamples(parsed.samples, `${ride.name} Route`);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Could not extract GPS route from FIT file" },
        400
      );
    }

    const id = crypto.randomUUID();
    const r2Key = `users/${userId}/routes/${id}.json`;
    const createdAt = new Date().toISOString();

    await c.env.RIDES_BUCKET.put(r2Key, JSON.stringify({ points: analyzed.points }), {
      httpMetadata: { contentType: "application/json" },
    });

    await c.env.DB.prepare(
      `INSERT INTO routes (id, user_id, name, source, distance_m, total_ascent_m, max_grade_pct, point_count, r2_route_key, created_at)
       VALUES (?, ?, ?, 'fit_extract', ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        userId,
        analyzed.name,
        analyzed.distance_m,
        analyzed.total_ascent_m,
        analyzed.max_grade_pct,
        analyzed.points.length,
        r2Key,
        createdAt
      )
      .run();

    const row: RouteRow = {
      id,
      name: analyzed.name,
      source: "fit_extract",
      distance_m: analyzed.distance_m,
      total_ascent_m: analyzed.total_ascent_m,
      max_grade_pct: analyzed.max_grade_pct,
      point_count: analyzed.points.length,
      r2_route_key: r2Key,
      created_at: createdAt,
    };

    return c.json({ route: rowToItem(row), points: analyzed.points }, 201);
  });

  router.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (getBuiltInRoutePreset(id)) {
      return c.json({ error: "Built-in route presets cannot be deleted" }, 400);
    }

    const row = await c.env.DB.prepare(
      "SELECT id, r2_route_key FROM routes WHERE id = ? AND user_id = ?"
    )
      .bind(id, userId)
      .first<{ id: string; r2_route_key: string }>();
    if (!row) {
      return c.json({ error: "Route not found" }, 404);
    }

    await c.env.DB.prepare("DELETE FROM routes WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    await c.env.RIDES_BUCKET.delete(row.r2_route_key).catch(() => {});
    return c.json({ ok: true });
  });

  return router;
}
