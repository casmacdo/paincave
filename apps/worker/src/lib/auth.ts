import type { Context, Next } from "hono";
import type { AppEnv, HonoAppContext } from "../types.js";
import {
  getBetterAuthSessionUser,
  resolveBetterAuthSecret,
  resolvePrimaryOwnerUserId,
  type BetterAuthUserSummary,
} from "./better-auth.js";

const LEGACY_SESSION_COOKIE_NAME = "paincave_session";

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

export async function sha256Bytes(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await sha256Bytes(input));
}

export function generateSecureToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Constant-time secret comparison by hashing both inputs with SHA-256 first
 * so mismatched lengths never leak via timing.
 */
export async function timingSafeCompare(provided: string, expected: string): Promise<boolean> {
  if (provided.length === 0 || expected.length === 0) {
    return false;
  }
  const [aHash, bHash] = await Promise.all([sha256Bytes(provided), sha256Bytes(expected)]);
  return crypto.subtle.timingSafeEqual(aHash, bHash);
}

export function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key === name) {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return null;
}

export function clearUiSessionCookie(requestUrl: string): string {
  const isHttps = new URL(requestUrl).protocol === "https:";
  const secureFlag = isHttps ? "; Secure" : "";
  return `${LEGACY_SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag}`;
}

export async function verifyUiSessionRequest(
  c: Context<HonoAppContext>
): Promise<
  | {
      ok: true;
      authMode: "better_auth";
      userId: string;
      user: BetterAuthUserSummary | null;
    }
  | { ok: false; status: 401 | 503; error: string }
> {
  if (!resolveBetterAuthSecret(c.env)) {
    return { ok: false, status: 503, error: "Authentication secrets are not configured" };
  }

  const baUser = await getBetterAuthSessionUser(c.env, c.req.raw);
  if (baUser) {
    return { ok: true, authMode: "better_auth", userId: baUser.id, user: baUser };
  }

  return { ok: false, status: 401, error: "Authentication required" };
}

export async function lookupDeviceTokenUser(
  db: D1Database,
  rawToken: string,
  allowedScopes: readonly ("bridge" | "importer" | "mcp")[]
): Promise<string | null> {
  if (!rawToken || rawToken.length < 16) return null;
  const tokenHash = await sha256Hex(rawToken);
  const row = await db
    .prepare("SELECT user_id, scope FROM user_device_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ user_id: string; scope: "bridge" | "importer" | "mcp" }>();
  if (!row || !allowedScopes.includes(row.scope)) return null;
  await db
    .prepare(
      "UPDATE user_device_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE token_hash = ?"
    )
    .bind(tokenHash)
    .run();
  return row.user_id;
}

export async function requireUiAuth(
  c: Context<HonoAppContext>,
  next: Next
): Promise<Response | void> {
  const check = await verifyUiSessionRequest(c);
  if (!check.ok) {
    return c.json({ error: check.error }, check.status);
  }
  c.set("authMethod", "session");
  c.set("userId", check.userId);
  await next();
}

export async function requireBridgeOrUiAuth(
  c: Context<HonoAppContext>,
  next: Next
): Promise<Response | void> {
  const bridgeToken = c.req.header("X-Bridge-Token");
  if (bridgeToken !== undefined) {
    const dbUserId = await lookupDeviceTokenUser(c.env.DB, bridgeToken, ["bridge"]);
    if (dbUserId) {
      c.set("authMethod", "bridge");
      c.set("userId", dbUserId);
      await next();
      return;
    }

    const expected = c.env.BRIDGE_DEVICE_TOKEN;
    if (!expected || expected.length < 16) {
      return c.json({ error: "BRIDGE_DEVICE_TOKEN is not configured" }, 503);
    }
    const valid = await timingSafeCompare(bridgeToken, expected);
    if (!valid) {
      return c.json({ error: "Invalid bridge device token" }, 401);
    }
    const ownerId = await resolvePrimaryOwnerUserId(c.env.DB);
    c.set("authMethod", "bridge");
    c.set("userId", ownerId);
    await next();
    return;
  }

  const check = await verifyUiSessionRequest(c);
  if (!check.ok) {
    return c.json({ error: check.error }, check.status);
  }
  c.set("authMethod", "session");
  c.set("userId", check.userId);
  await next();
}

export async function requireImporterOrUiAuth(
  c: Context<HonoAppContext>,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header("Authorization");
  const headerToken =
    c.req.header("X-Importer-Token") ??
    (authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : undefined);

  if (headerToken) {
    const tokenUserId = await lookupDeviceTokenUser(c.env.DB, headerToken, ["importer", "bridge"]);
    if (!tokenUserId) {
      return c.json({ error: "Invalid importer token" }, 401);
    }
    c.set("authMethod", "bearer");
    c.set("userId", tokenUserId);
    await next();
    return;
  }

  const check = await verifyUiSessionRequest(c);
  if (!check.ok) {
    return c.json({ error: check.error }, check.status);
  }
  c.set("authMethod", "session");
  c.set("userId", check.userId);
  await next();
}

export async function verifyMcpAuth(
  request: Request,
  env: AppEnv
): Promise<
  | { ok: true; method: "bearer" | "oauth"; userId: string }
  | { ok: false; status: 401 | 503; error: string }
> {
  const hasBearer = Boolean(env.MCP_BEARER_TOKEN && env.MCP_BEARER_TOKEN.length >= 16);
  const hasOAuth = Boolean(resolveBetterAuthSecret(env));
  if (!hasBearer && !hasOAuth) {
    return { ok: false, status: 503, error: "MCP authentication is not configured" };
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Bearer token required" };
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return { ok: false, status: 401, error: "Bearer token required" };
  }

  if (hasBearer && env.MCP_BEARER_TOKEN) {
    const matchesStatic = await timingSafeCompare(token, env.MCP_BEARER_TOKEN);
    if (matchesStatic) {
      const ownerId = await resolvePrimaryOwnerUserId(env.DB);
      return { ok: true, method: "bearer", userId: ownerId };
    }
  }

  const personalMcpUser = await lookupDeviceTokenUser(env.DB, token, ["mcp"]);
  if (personalMcpUser) {
    return { ok: true, method: "bearer", userId: personalMcpUser };
  }

  const tokenHash = await sha256Hex(token);
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT token_hash, user_id FROM mcp_oauth_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > ?"
  )
    .bind(tokenHash, nowSec)
    .first<{ token_hash: string; user_id: string }>();

  if (row) {
    return { ok: true, method: "oauth", userId: row.user_id };
  }

  return { ok: false, status: 401, error: "Invalid or expired MCP token" };
}
