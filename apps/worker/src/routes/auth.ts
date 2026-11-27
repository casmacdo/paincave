import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppContext } from "../types.js";
import {
  clearUiSessionCookie,
  generateSecureToken,
  requireUiAuth,
  sha256Hex,
  verifyUiSessionRequest,
} from "../lib/auth.js";
import {
  createBetterAuth,
  getConfiguredProviders,
  hasBetterAuthSessionCookie,
  hasRegisteredOwner,
  parseAllowedUserEmails,
  resolveBetterAuthSecret,
} from "../lib/better-auth.js";

const CreateTokenSchema = z.object({
  label: z.string().trim().min(1).max(80),
  scope: z.enum(["bridge", "importer", "mcp"]),
});

export function createAuthRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();

  router.post("/logout", async (c) => {
    const cookieHeader = c.req.header("Cookie");
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
    const allowedEmails = parseAllowedUserEmails(c.env);
    const ownerEmailRestricted = allowedEmails.length > 0;
    const allowRegistration = !hasOwner || allowedEmails.length > 1;

    if (!check.ok) {
      return c.json(
        {
          authenticated: false,
          configured: check.status !== 503,
          auth_mode: null,
          user: null,
          has_owner: hasOwner,
          owner_email_restricted: ownerEmailRestricted,
          allow_registration: allowRegistration,
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
      allow_registration: allowRegistration,
      providers,
    });
  });

  // Per-user device / importer / personal MCP token management
  router.get("/tokens", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const { results } = await c.env.DB.prepare(
      "SELECT token_hash, label, scope, last_used_at, created_at FROM user_device_tokens WHERE user_id = ? ORDER BY created_at DESC"
    )
      .bind(userId)
      .all();
    return c.json({ tokens: results });
  });

  router.post("/tokens", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = CreateTokenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid token request", issues: parsed.error.issues }, 400);
    }
    const rawToken = `pc_${parsed.data.scope}_${generateSecureToken(24)}`;
    const tokenHash = await sha256Hex(rawToken);
    await c.env.DB.prepare(
      "INSERT INTO user_device_tokens (token_hash, user_id, label, scope) VALUES (?, ?, ?, ?)"
    )
      .bind(tokenHash, userId, parsed.data.label, parsed.data.scope)
      .run();
    return c.json(
      {
        token: rawToken,
        token_hash: tokenHash,
        label: parsed.data.label,
        scope: parsed.data.scope,
      },
      201
    );
  });

  router.delete("/tokens/:token_hash", requireUiAuth, async (c) => {
    const userId = c.get("userId");
    const tokenHash = c.req.param("token_hash");
    const res = await c.env.DB.prepare(
      "DELETE FROM user_device_tokens WHERE token_hash = ? AND user_id = ?"
    )
      .bind(tokenHash, userId)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      return c.json({ error: "Token not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // Mount Better Auth endpoints: /api/auth/sign-up/*, /api/auth/sign-in/*, /api/auth/callback/*, etc.
  router.all("/*", async (c) => {
    if (!resolveBetterAuthSecret(c.env)) {
      return c.json({ error: "Better Auth secret is not configured" }, 503);
    }
    const auth = createBetterAuth(c.env, c.req.url);
    return auth.handler(c.req.raw);
  });

  return router;
}
