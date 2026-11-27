import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";
import {
  connectGarminPersonalApi,
  disconnectGarminPersonalApi,
  getGarminStatus,
  syncGarminUser,
} from "../lib/garmin-sync.js";

const ConnectGarminSchema = z.object({
  api_key: z.string().trim().min(12).max(512),
});

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const SyncGarminSchema = z.object({
  days: z.number().int().min(1).max(31).optional(),
  start_date: z.string().regex(ISO_DAY_RE).optional(),
  end_date: z.string().regex(ISO_DAY_RE).optional(),
  skip_pmc_recompute: z.boolean().optional(),
});

export function createGarminRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();
  router.use("*", requireUiAuth);

  router.get("/status", async (c) => {
    const userId = c.get("userId");
    const status = await getGarminStatus(c.env, userId);
    return c.json(status);
  });

  router.post("/connect", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ConnectGarminSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid Garmin Personal API key", issues: parsed.error.issues }, 400);
    }

    try {
      const status = await connectGarminPersonalApi(c.env, userId, parsed.data.api_key);
      return c.json({ ok: true, status });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Could not verify Garmin Personal API key" },
        400
      );
    }
  });

  router.post("/sync", async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => ({}));
    const parsed = SyncGarminSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "Invalid Garmin sync range", issues: parsed.error.issues }, 400);
    }
    const result = await syncGarminUser(c.env, userId, {
      days: parsed.data.days,
      startDate: parsed.data.start_date,
      endDate: parsed.data.end_date,
      skipPmcRecompute: parsed.data.skip_pmc_recompute,
    });
    return c.json(result, result.ok ? 200 : result.rate_limited ? 429 : 400);
  });

  router.delete("/disconnect", async (c) => {
    const userId = c.get("userId");
    await disconnectGarminPersonalApi(c.env, userId);
    return c.json({ ok: true });
  });

  return router;
}
