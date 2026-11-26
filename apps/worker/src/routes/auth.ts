import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppContext } from "../types.js";
import {
  SESSION_COOKIE_NAME,
  clearUiSessionCookie,
  createUiSessionCookie,
  parseCookie,
  sha256Hex,
  verifyPasswordPbkdf2,
  verifyUiSessionRequest,
} from "../lib/auth.js";

const LoginBodySchema = z.object({
  password: z.string().min(1).max(256),
});

export function createAuthRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();

  router.post("/login", async (c) => {
    const expectedHash = c.env.UI_ADMIN_PASSWORD_HASH;
    const signingSecret = c.env.SESSION_SIGNING_SECRET;
    if (!expectedHash || !signingSecret || signingSecret.length < 16) {
      return c.json({ error: "Authentication secrets are not configured" }, 503);
    }

    const body: unknown = await c.req.json().catch(() => null);
    const parsed = LoginBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Password is required" }, 400);
    }

    const valid = await verifyPasswordPbkdf2(parsed.data.password, expectedHash);
    if (!valid) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const { cookieHeader, expiresAt } = await createUiSessionCookie(c.env, c.req.url);
    c.header("Set-Cookie", cookieHeader);
    return c.json({ ok: true, expires_at: expiresAt });
  });

  router.post("/logout", async (c) => {
    const cookieVal = parseCookie(c.req.header("Cookie"), SESSION_COOKIE_NAME);
    if (cookieVal) {
      const dot = cookieVal.indexOf(".");
      const rawToken = dot > 0 ? cookieVal.slice(0, dot) : cookieVal;
      const tokenHash = await sha256Hex(rawToken);
      await c.env.DB.prepare("DELETE FROM ui_sessions WHERE token_hash = ?").bind(tokenHash).run();
    }
    c.header("Set-Cookie", clearUiSessionCookie(c.req.url));
    return c.json({ ok: true });
  });

  router.get("/me", async (c) => {
    const check = await verifyUiSessionRequest(c);
    if (!check.ok) {
      if (check.status === 503) {
        return c.json({ authenticated: false, configured: false }, 200);
      }
      return c.json({ authenticated: false, configured: true }, 200);
    }
    return c.json({ authenticated: true, configured: true });
  });

  return router;
}
