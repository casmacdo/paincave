import { Hono } from "hono";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";
import { getFitnessOverview } from "../lib/fitness-service.js";

export function createFitnessRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();
  router.use("*", requireUiAuth);

  router.get("/overview", async (c) => {
    const daysParam = Number(c.req.query("days") ?? 42);
    const days = Number.isFinite(daysParam) ? daysParam : 42;
    const overview = await getFitnessOverview(c.env.DB, days);
    return c.json(overview);
  });

  return router;
}
