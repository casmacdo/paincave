import { Hono } from "hono";
import type { HonoAppContext } from "./types.js";
import { DEFAULT_OWNER_USER_ID } from "./lib/better-auth.js";
import { logJson } from "./lib/logger.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAthleteRoutes } from "./routes/athlete.js";
import { createWorkoutRoutes } from "./routes/workouts.js";
import { createCalendarRoutes } from "./routes/calendar.js";
import { createRideRoutes } from "./routes/rides.js";
import { createFitnessRoutes } from "./routes/fitness.js";
import { createRouteRoutes } from "./routes/routes.js";
import { createStravaRoutes } from "./routes/strava.js";
import { createGarminRoutes } from "./routes/garmin.js";
import { createMcpRoutes } from "./mcp/server.js";
import { createMcpOAuthRoutes } from "./mcp/oauth.js";

export function createApp(): Hono<HonoAppContext> {
  const app = new Hono<HonoAppContext>();

  // Security headers and per-request context initialization
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.set("authMethod", "none");
    c.set("userId", DEFAULT_OWNER_USER_ID);

    await next();

    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/oauth/")) {
      c.header("Cache-Control", "no-store");
    }
  });

  app.onError((err, c) => {
    logJson("error", "unhandled request error", {
      request_id: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      service: "paincave-worker",
      env: c.env.APP_ENV,
      build_sha: c.env.BUILD_SHA,
    });
  });

  app.get("/api/version", (c) => {
    return c.json({
      build_sha: c.env.BUILD_SHA,
      app_env: c.env.APP_ENV,
    });
  });

  app.route("/api/auth", createAuthRoutes());
  app.route("/api/athlete", createAthleteRoutes());
  app.route("/api/workouts", createWorkoutRoutes());
  app.route("/api/calendar", createCalendarRoutes());
  app.route("/api/rides", createRideRoutes());
  app.route("/api/fitness", createFitnessRoutes());
  app.route("/api/routes", createRouteRoutes());
  app.route("/api/strava", createStravaRoutes());
  app.route("/api/garmin", createGarminRoutes());
  app.route("/mcp", createMcpRoutes());
  app.route("/", createMcpOAuthRoutes());

  // Fallback to Static Assets (SPA) for non-API routes
  app.all("*", async (c) => {
    if (
      c.req.path.startsWith("/api/") ||
      c.req.path === "/mcp" ||
      c.req.path.startsWith("/mcp/") ||
      c.req.path.startsWith("/oauth/") ||
      c.req.path.startsWith("/.well-known/")
    ) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return app;
}
