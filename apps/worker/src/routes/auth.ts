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
import {
  createBetterAuth,
  getConfiguredProviders,
  hasBetterAuthSessionCookie,
  hasRegisteredOwner,
  parseAllowedOwnerEmails,
  resolveBetterAuthSecret,
} from "../lib/better-auth.js";

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
    const cookieHeader = c.req.header("Cookie");
    const cookieVal = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (cookieVal) {
      const dot = cookieVal.indexOf(".");
      const rawToken = dot > 0 ? cookieVal.slice(0, dot) : cookieVal;
      const tokenHash = await sha256Hex(rawToken);
      await c.env.DB.prepare("DELETE FROM ui_sessions WHERE token_hash = ?").bind(tokenHash).run();
    }

    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", clearUiSessionCookie(c.req.url));

    if (resolveBetterAuthSecret(c.env) && hasBetterAuthSessionCookie(cookieHeader)) {
      try {
        const auth = createBetterAuth(c.env, c.req.url);
        const signOutUrl = new URL("/api/auth/sign-out", c.req.url);
        const baRes = await auth.handler(
          new Request(signOutUrl.toString(), {
            method: "POST",
            headers: {
              Cookie: cookieHeader ?? "",
              Origin: new URL(c.req.url).origin,
              "Content-Type": "application/json",
            },
            body: "{}",
          })
        );
        const setCookies =
          typeof baRes.headers.getSetCookie === "function"
            ? baRes.headers.getSetCookie()
            : [baRes.headers.get("Set-Cookie")].filter((v): v is string => Boolean(v));
        for (const cookie of setCookies) {
          headers.append("Set-Cookie", cookie);
        }
      } catch {
        // Ignore Better Auth sign-out errors during fallback logout
      }
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  });

  router.get("/me", async (c) => {
    const [check, hasOwner] = await Promise.all([
      verifyUiSessionRequest(c),
      hasRegisteredOwner(c.env.DB),
    ]);
    const providers = getConfiguredProviders(c.env);
    const ownerEmailRestricted = parseAllowedOwnerEmails(c.env.ALLOWED_OWNER_EMAIL).length > 0;

    if (!check.ok) {
      return c.json(
        {
          authenticated: false,
          configured: check.status !== 503,
          auth_mode: null,
          user: null,
          has_owner: hasOwner,
          owner_email_restricted: ownerEmailRestricted,
          providers,
        },
        200
      );
    }

    return c.json({
      authenticated: true,
      configured: true,
      auth_mode: check.authMode,
      user: check.user,
      has_owner: hasOwner,
      owner_email_restricted: ownerEmailRestricted,
      providers,
    });
  });

  // Mount Better Auth endpoints: /api/auth/sign-up/*, /api/auth/sign-in/*, /api/auth/callback/*, /api/auth/passkey/*, etc.
  router.all("/*", async (c) => {
    if (!resolveBetterAuthSecret(c.env)) {
      return c.json({ error: "Better Auth secret is not configured" }, 503);
    }
    const auth = createBetterAuth(c.env, c.req.url);
    return auth.handler(c.req.raw);
  });

  return router;
}
