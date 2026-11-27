import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppContext } from "../types.js";
import {
  generateSecureToken,
  sha256Bytes,
  sha256Hex,
  timingSafeCompare,
} from "../lib/auth.js";
import {
  getBetterAuthSessionUser,
  resolveBetterAuthSecret,
} from "../lib/better-auth.js";

const AUTH_CODE_TTL_S = 300; // 5 minutes
const ACCESS_TOKEN_TTL_S = 3600; // 1 hour
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60; // 30 days
const MAX_REGISTERED_CLIENTS = 50;

const RegisterClientSchema = z.object({
  client_name: z.string().trim().min(1).max(120).default("Mobile MCP Client"),
  redirect_uris: z.array(z.string().min(1).max(500)).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
});

function isAllowedRedirectUri(raw: string): boolean {
  try {
    const u = new URL(raw);
    const scheme = u.protocol.toLowerCase();
    if (scheme === "javascript:" || scheme === "data:" || scheme === "vbscript:") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function renderAuthorizePage(params: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  signedInEmail?: string | null;
  returnToUrl?: string;
  error?: string;
}): string {
  const errHtml = params.error
    ? `<p style="color:#f87171;background:#450a0a;padding:10px 12px;border-radius:8px;margin-bottom:16px;">${escapeHtml(params.error)}</p>`
    : "";

  const authBlock = params.signedInEmail
    ? `<p style="color:#86efac;background:#052e16;border:1px solid #166534;padding:10px 12px;border-radius:10px;margin:14px 0;">Signed in as <strong>${escapeHtml(params.signedInEmail)}</strong></p>
       <input type="hidden" name="session_approve" value="1" />
       <button type="submit">Approve Access</button>`
    : `${
        params.returnToUrl
          ? `<a href="/?returnTo=${encodeURIComponent(params.returnToUrl)}" style="display:block;text-align:center;text-decoration:none;margin:16px 0 8px;padding:12px;border-radius:10px;background:#f97316;color:#09090b;font-weight:700;font-size:0.95rem;">Sign In with Google</a>`
          : ""
      }`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize PainCave MCP</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background:#09090b; color:#f4f4f5; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:16px; }
    .card { width:100%; max-width:420px; background:#18181b; border:1px solid #27272a; border-radius:16px; padding:24px; box-sizing:border-box; }
    h1 { font-size:1.25rem; margin:0 0 8px; }
    p { font-size:0.9rem; color:#a1a1aa; line-height:1.4; }
    label { display:block; font-size:0.85rem; margin:16px 0 6px; color:#d4d4d8; }
    input[type=password] { width:100%; box-sizing:border-box; padding:12px; border-radius:10px; border:1px solid #3f3f46; background:#09090b; color:#fff; font-size:1rem; }
    button { width:100%; margin-top:14px; padding:12px; border:0; border-radius:10px; background:#f97316; color:#09090b; font-weight:700; font-size:1rem; cursor:pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize PainCave MCP</h1>
    <p><strong>${escapeHtml(params.clientName)}</strong> requests access to your training data, ride analysis, workouts, and calendar (<code>${escapeHtml(params.scope)}</code>).</p>
    ${errHtml}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
      <input type="hidden" name="state" value="${escapeHtml(params.state)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}" />
      <input type="hidden" name="scope" value="${escapeHtml(params.scope)}" />
      ${authBlock}
    </form>
  </div>
</body>
</html>`;
}

export function createMcpOAuthRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();

  const protectedResourceMetadata = (url: string) => {
    const origin = new URL(url).origin;
    return {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:tools"],
    };
  };

  router.get("/.well-known/oauth-protected-resource", (c) => {
    return c.json(protectedResourceMetadata(c.req.url));
  });

  // RFC 9728 path-suffixed discovery probed by MCP 2025-06-18 clients
  router.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    return c.json(protectedResourceMetadata(c.req.url));
  });

  router.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp:tools"],
    });
  });

  // RFC 7591 Dynamic Client Registration (for Claude Mobile / ChatGPT Mobile)
  router.post("/oauth/register", async (c) => {
    if (!resolveBetterAuthSecret(c.env)) {
      return c.json({ error: "server_error", error_description: "OAuth not configured" }, 503);
    }

    const body: unknown = await c.req.json().catch(() => null);
    const parsed = RegisterClientSchema.safeParse(body);
    if (!parsed.success || !parsed.data.redirect_uris.every(isAllowedRedirectUri)) {
      return c.json({ error: "invalid_client_metadata" }, 400);
    }

    // Bound stored clients to prevent D1 bloat on a public endpoint
    const countRow = await c.env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM mcp_oauth_clients"
    ).first<{ cnt: number }>();
    if ((countRow?.cnt ?? 0) >= MAX_REGISTERED_CLIENTS) {
      await c.env.DB.prepare(
        `DELETE FROM mcp_oauth_clients WHERE client_id IN (
           SELECT client_id FROM mcp_oauth_clients ORDER BY created_at ASC LIMIT 10
         )`
      ).run();
    }

    const clientId = `mcp_${crypto.randomUUID()}`;
    await c.env.DB.prepare(
      `INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris_json, token_endpoint_auth_method)
       VALUES (?, ?, ?, 'none')`
    )
      .bind(clientId, parsed.data.client_name, JSON.stringify(parsed.data.redirect_uris))
      .run();

    return c.json(
      {
        client_id: clientId,
        client_name: parsed.data.client_name,
        redirect_uris: parsed.data.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201
    );
  });

  router.get("/oauth/authorize", async (c) => {
    if (!resolveBetterAuthSecret(c.env)) {
      return c.text("Authentication not configured", 503);
    }

    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const responseType = c.req.query("response_type") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";
    const state = c.req.query("state") ?? "";
    const scope = c.req.query("scope") ?? "mcp:tools";

    if (responseType !== "code" || codeChallengeMethod !== "S256" || codeChallenge.length < 20) {
      return c.json({ error: "invalid_request", error_description: "PKCE S256 required" }, 400);
    }

    const client = await c.env.DB.prepare(
      "SELECT client_id, client_name, redirect_uris_json FROM mcp_oauth_clients WHERE client_id = ?"
    )
      .bind(clientId)
      .first<{ client_id: string; client_name: string; redirect_uris_json: string }>();

    if (!client) {
      return c.json({ error: "invalid_client" }, 400);
    }
    const allowedUris = JSON.parse(client.redirect_uris_json) as string[];
    if (!allowedUris.includes(redirectUri)) {
      return c.json({ error: "invalid_request", error_description: "Unregistered redirect_uri" }, 400);
    }

    const sessionUser = await getBetterAuthSessionUser(c.env, c.req.raw);
    const reqUrl = new URL(c.req.url);
    const returnToUrl = `${reqUrl.pathname}${reqUrl.search}`;

    return c.html(
      renderAuthorizePage({
        clientName: client.client_name,
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scope,
        signedInEmail: sessionUser?.email ?? null,
        returnToUrl,
      })
    );
  });

  router.post("/oauth/authorize", async (c) => {
    if (!resolveBetterAuthSecret(c.env)) {
      return c.json({ error: "server_error" }, 503);
    }

    const form = await c.req.parseBody();
    const clientId = typeof form["client_id"] === "string" ? form["client_id"] : "";
    const redirectUri = typeof form["redirect_uri"] === "string" ? form["redirect_uri"] : "";
    const state = typeof form["state"] === "string" ? form["state"] : "";
    const codeChallenge = typeof form["code_challenge"] === "string" ? form["code_challenge"] : "";
    const codeChallengeMethod =
      typeof form["code_challenge_method"] === "string" ? form["code_challenge_method"] : "";
    const scope = typeof form["scope"] === "string" ? form["scope"] : "mcp:tools";

    const client = await c.env.DB.prepare(
      "SELECT client_id, client_name, redirect_uris_json FROM mcp_oauth_clients WHERE client_id = ?"
    )
      .bind(clientId)
      .first<{ client_id: string; client_name: string; redirect_uris_json: string }>();

    if (!client) {
      return c.json({ error: "invalid_client" }, 400);
    }
    const allowedUris = JSON.parse(client.redirect_uris_json) as string[];
    if (!allowedUris.includes(redirectUri) || codeChallengeMethod !== "S256" || !codeChallenge) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const sessionUser = await getBetterAuthSessionUser(c.env, c.req.raw);

    if (!sessionUser) {
      return c.html(
        renderAuthorizePage({
          clientName: client.client_name,
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
          scope,
          signedInEmail: null,
          error: "Please sign in with Google before approving access.",
        }),
        401
      );
    }

    const authorizedUserId = sessionUser.id;
    const rawCode = generateSecureToken(32);
    const codeHash = await sha256Hex(rawCode);
    const nowSec = Math.floor(Date.now() / 1000);

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM mcp_oauth_codes WHERE expires_at <= ?").bind(nowSec),
      c.env.DB.prepare(
        `INSERT INTO mcp_oauth_codes
          (code_hash, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, used)
         VALUES (?, ?, ?, ?, ?, 'S256', ?, ?, 0)`
      ).bind(
        codeHash,
        authorizedUserId,
        clientId,
        redirectUri,
        codeChallenge,
        scope,
        nowSec + AUTH_CODE_TTL_S
      ),
    ]);

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", rawCode);
    if (state) redirect.searchParams.set("state", state);

    return c.redirect(redirect.toString(), 302);
  });

  router.post("/oauth/token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    let bodyRecord: Record<string, string> = {};

    if (contentType.includes("application/json")) {
      const json: unknown = await c.req.json().catch(() => null);
      if (json && typeof json === "object") {
        for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
          if (typeof v === "string") bodyRecord[k] = v;
        }
      }
    } else {
      const form = await c.req.parseBody();
      const rec: Record<string, string> = {};
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === "string") rec[k] = v;
      }
      bodyRecord = rec;
    }

    const grantType = bodyRecord["grant_type"];
    const nowSec = Math.floor(Date.now() / 1000);

    if (grantType === "authorization_code") {
      const code = bodyRecord["code"] ?? "";
      const redirectUri = bodyRecord["redirect_uri"] ?? "";
      const clientId = bodyRecord["client_id"] ?? "";
      const codeVerifier = bodyRecord["code_verifier"] ?? "";

      if (!code || !redirectUri || !clientId || !codeVerifier) {
        return c.json({ error: "invalid_request" }, 400);
      }

      const codeHash = await sha256Hex(code);
      const row = await c.env.DB.prepare(
        "SELECT * FROM mcp_oauth_codes WHERE code_hash = ? AND used = 0 AND expires_at > ?"
      )
        .bind(codeHash, nowSec)
        .first<{
          code_hash: string;
          user_id: string;
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          scope: string;
        }>();

      if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri) {
        return c.json({ error: "invalid_grant" }, 400);
      }

      const computedChallenge = toBase64Url(await sha256Bytes(codeVerifier));
      const pkceValid = await timingSafeCompare(computedChallenge, row.code_challenge);
      if (!pkceValid) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      }

      const accessToken = generateSecureToken(32);
      const refreshToken = generateSecureToken(32);
      const [accessHash, refreshHash] = await Promise.all([
        sha256Hex(accessToken),
        sha256Hex(refreshToken),
      ]);

      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE mcp_oauth_codes SET used = 1 WHERE code_hash = ?").bind(codeHash),
        c.env.DB.prepare(
          `INSERT INTO mcp_oauth_tokens
            (token_hash, refresh_token_hash, user_id, client_id, scope, expires_at, refresh_expires_at, revoked)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        ).bind(
          accessHash,
          refreshHash,
          row.user_id,
          clientId,
          row.scope,
          nowSec + ACCESS_TOKEN_TTL_S,
          nowSec + REFRESH_TOKEN_TTL_S
        ),
      ]);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_S,
        refresh_token: refreshToken,
        scope: row.scope,
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = bodyRecord["refresh_token"] ?? "";
      const clientId = bodyRecord["client_id"] ?? "";
      if (!refreshToken) {
        return c.json({ error: "invalid_request" }, 400);
      }

      const oldRefreshHash = await sha256Hex(refreshToken);
      const row = await c.env.DB.prepare(
        `SELECT token_hash, user_id, client_id, scope, refresh_expires_at
         FROM mcp_oauth_tokens
         WHERE refresh_token_hash = ? AND revoked = 0 AND refresh_expires_at > ?`
      )
        .bind(oldRefreshHash, nowSec)
        .first<{
          token_hash: string;
          user_id: string;
          client_id: string;
          scope: string;
          refresh_expires_at: number;
        }>();

      if (!row || (clientId && row.client_id !== clientId)) {
        return c.json({ error: "invalid_grant" }, 400);
      }

      const newAccess = generateSecureToken(32);
      const newRefresh = generateSecureToken(32);
      const [newAccessHash, newRefreshHash] = await Promise.all([
        sha256Hex(newAccess),
        sha256Hex(newRefresh),
      ]);

      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE mcp_oauth_tokens SET revoked = 1 WHERE token_hash = ?").bind(
          row.token_hash
        ),
        c.env.DB.prepare(
          `INSERT INTO mcp_oauth_tokens
            (token_hash, refresh_token_hash, user_id, client_id, scope, expires_at, refresh_expires_at, revoked)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        ).bind(
          newAccessHash,
          newRefreshHash,
          row.user_id,
          row.client_id,
          row.scope,
          nowSec + ACCESS_TOKEN_TTL_S,
          nowSec + REFRESH_TOKEN_TTL_S
        ),
      ]);

      return c.json({
        access_token: newAccess,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_S,
        refresh_token: newRefresh,
        scope: row.scope,
      });
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  return router;
}
