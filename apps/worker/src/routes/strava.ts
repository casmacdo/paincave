import { Hono } from "hono";
import type { HonoAppContext } from "../types.js";
import {
  generateSecureToken,
  requireBridgeOrUiAuth,
  requireUiAuth,
  sha256Hex,
} from "../lib/auth.js";
import {
  buildStravaAuthorizeUrl,
  exchangeStravaCode,
  getStravaTokenRow,
  isStravaConfigured,
  uploadFitToStrava,
} from "../lib/strava-client.js";

const STRAVA_STATE_TTL_S = 600;

export function createStravaRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();

  router.get("/status", requireUiAuth, async (c) => {
    const row = await getStravaTokenRow(c.env);
    return c.json({
      configured: isStravaConfigured(c.env),
      connected: Boolean(row),
      athlete_external_id: row?.athlete_external_id ?? null,
      scope: row?.scope ?? null,
      expires_at: row?.expires_at ?? null,
    });
  });

  router.get("/connect", requireBridgeOrUiAuth, async (c) => {
    if (!isStravaConfigured(c.env)) {
      return c.json(
        { error: "Strava integration unavailable: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET are not set" },
        503
      );
    }

    const nonce = generateSecureToken(24);
    const stateHash = await sha256Hex(nonce);
    const nowS = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(nowS).run();
    await c.env.DB.prepare(
      "INSERT INTO oauth_states (state_hash, provider, expires_at) VALUES (?, 'strava', ?)"
    )
      .bind(stateHash, nowS + STRAVA_STATE_TTL_S)
      .run();

    const publicAppUrl = c.env.PUBLIC_APP_URL?.trim();
    const callbackUrl = new URL(
      "/api/strava/callback",
      publicAppUrl || new URL(c.req.url).origin
    ).toString();
    const authorizeUrl = buildStravaAuthorizeUrl(c.env, callbackUrl, nonce);

    if (c.req.query("mode") === "json") {
      return c.json({ authorize_url: authorizeUrl });
    }
    return c.redirect(authorizeUrl, 302);
  });

  router.get("/callback", async (c) => {
    const oauthErr = c.req.query("error");
    if (oauthErr) {
      return c.json({ error: `Strava authorization denied: ${oauthErr}` }, 400);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return c.json({ error: "Missing OAuth code or state parameter" }, 400);
    }

    const nowS = Math.floor(Date.now() / 1000);
    const stateHash = await sha256Hex(state);
    const row = await c.env.DB.prepare(
      "SELECT state_hash, expires_at FROM oauth_states WHERE state_hash = ? AND provider = 'strava'"
    )
      .bind(stateHash)
      .first<{ state_hash: string; expires_at: number }>();

    if (!row || row.expires_at <= nowS) {
      if (row) {
        await c.env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run();
      }
      return c.json({ error: "Invalid or expired OAuth state" }, 400);
    }

    // Consume CSRF nonce atomically so replay fails
    const delRes = await c.env.DB.prepare(
      "DELETE FROM oauth_states WHERE state_hash = ? AND provider = 'strava'"
    )
      .bind(stateHash)
      .run();
    if (!delRes.meta.changes) {
      return c.json({ error: "OAuth state already consumed" }, 400);
    }

    if (!isStravaConfigured(c.env)) {
      return c.json({ error: "Strava secrets missing during callback" }, 503);
    }

    try {
      await exchangeStravaCode(c.env, code);
      return c.redirect("/?strava=connected", 302);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Strava token exchange failed" },
        502
      );
    }
  });

  router.post("/retry/:ride_uuid", requireBridgeOrUiAuth, async (c) => {
    const rideUuid = c.req.param("ride_uuid");
    if (!rideUuid) {
      return c.json({ error: "Missing ride_uuid" }, 400);
    }
    const exists = await c.env.DB.prepare("SELECT ride_uuid FROM rides WHERE ride_uuid = ?")
      .bind(rideUuid)
      .first<{ ride_uuid: string }>();
    if (!exists) {
      return c.json({ error: "Ride not found" }, 404);
    }

    const result = await uploadFitToStrava(c.env, rideUuid);
    return c.json({ ride_uuid: rideUuid, ...result });
  });

  return router;
}
