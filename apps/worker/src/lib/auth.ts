import type { Context, Next } from "hono";
import type { AppEnv, HonoAppContext } from "../types.js";

export const SESSION_COOKIE_NAME = "paincave_session";
const SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
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

export async function hashPasswordPbkdf2(
  password: string,
  saltHex?: string,
  iterations = 100_000
): Promise<string> {
  const saltBytes = saltHex
    ? fromHex(saltHex)
    : (() => {
        const s = new Uint8Array(16);
        crypto.getRandomValues(s);
        return s;
      })();
  if (!saltBytes) {
    throw new Error("Invalid hex salt");
  }
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    256
  );
  return `pbkdf2_sha256$${iterations}$${toHex(saltBytes)}$${toHex(bits)}`;
}

export async function verifyPasswordPbkdf2(password: string, storedHash: string): Promise<boolean> {
  if (!password || !storedHash) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  const saltHex = parts[2];
  const expectedHex = parts[3];
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 100_000 || !saltHex || !expectedHex) {
    return false;
  }
  const saltBytes = fromHex(saltHex);
  const expectedBytes = fromHex(expectedHex);
  if (!saltBytes || !expectedBytes || expectedBytes.length !== 32) {
    return false;
  }

  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    256
  );
  return crypto.subtle.timingSafeEqual(new Uint8Array(bits), expectedBytes);
}

async function signValue(rawToken: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawToken));
  return `${rawToken}.${toHex(sig)}`;
}

async function verifySignedValue(cookieVal: string, secret: string): Promise<string | null> {
  const dot = cookieVal.indexOf(".");
  if (dot <= 0) return null;
  const rawToken = cookieVal.slice(0, dot);
  const expected = await signValue(rawToken, secret);
  const match = await timingSafeCompare(cookieVal, expected);
  return match ? rawToken : null;
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

export async function createUiSessionCookie(
  env: AppEnv,
  requestUrl: string
): Promise<{ cookieHeader: string; expiresAt: number }> {
  const signingSecret = env.SESSION_SIGNING_SECRET;
  if (!signingSecret || signingSecret.length < 16) {
    throw new Error("SESSION_SIGNING_SECRET not configured");
  }

  const rawToken = generateSecureToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + SESSION_TTL_S;

  await env.DB.batch([
    env.DB.prepare("DELETE FROM ui_sessions WHERE expires_at <= ?").bind(nowSec),
    env.DB.prepare("INSERT INTO ui_sessions (token_hash, expires_at) VALUES (?, ?)").bind(
      tokenHash,
      expiresAt
    ),
  ]);

  const signed = await signValue(rawToken, signingSecret);
  const isHttps = new URL(requestUrl).protocol === "https:";
  const secureFlag = isHttps ? "; Secure" : "";
  const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}${secureFlag}`;
  return { cookieHeader, expiresAt };
}

export function clearUiSessionCookie(requestUrl: string): string {
  const isHttps = new URL(requestUrl).protocol === "https:";
  const secureFlag = isHttps ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag}`;
}

export async function verifyUiSessionRequest(
  c: Context<HonoAppContext>
): Promise<{ ok: true } | { ok: false; status: 401 | 503; error: string }> {
  const signingSecret = c.env.SESSION_SIGNING_SECRET;
  if (!signingSecret || signingSecret.length < 16 || !c.env.UI_ADMIN_PASSWORD_HASH) {
    return { ok: false, status: 503, error: "Authentication secrets are not configured" };
  }

  const cookieVal = parseCookie(c.req.header("Cookie"), SESSION_COOKIE_NAME);
  if (!cookieVal) {
    return { ok: false, status: 401, error: "Authentication required" };
  }

  const rawToken = await verifySignedValue(cookieVal, signingSecret);
  if (!rawToken) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const tokenHash = await sha256Hex(rawToken);
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(
    "SELECT token_hash FROM ui_sessions WHERE token_hash = ? AND expires_at > ?"
  )
    .bind(tokenHash, nowSec)
    .first<{ token_hash: string }>();

  if (!row) {
    return { ok: false, status: 401, error: "Session expired or revoked" };
  }
  return { ok: true };
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
  await next();
}

export async function requireBridgeOrUiAuth(
  c: Context<HonoAppContext>,
  next: Next
): Promise<Response | void> {
  const bridgeToken = c.req.header("X-Bridge-Token");
  if (bridgeToken !== undefined) {
    const expected = c.env.BRIDGE_DEVICE_TOKEN;
    if (!expected || expected.length < 16) {
      return c.json({ error: "BRIDGE_DEVICE_TOKEN is not configured" }, 503);
    }
    const valid = await timingSafeCompare(bridgeToken, expected);
    if (!valid) {
      return c.json({ error: "Invalid bridge device token" }, 401);
    }
    c.set("authMethod", "bridge");
    await next();
    return;
  }

  const check = await verifyUiSessionRequest(c);
  if (!check.ok) {
    return c.json({ error: check.error }, check.status);
  }
  c.set("authMethod", "session");
  await next();
}

export async function verifyMcpAuth(
  request: Request,
  env: AppEnv
): Promise<{ ok: true; method: "bearer" | "oauth" } | { ok: false; status: 401 | 503; error: string }> {
  const hasBearer = Boolean(env.MCP_BEARER_TOKEN && env.MCP_BEARER_TOKEN.length >= 16);
  const hasOAuth = Boolean(env.UI_ADMIN_PASSWORD_HASH);
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
      return { ok: true, method: "bearer" };
    }
  }

  const tokenHash = await sha256Hex(token);
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT token_hash FROM mcp_oauth_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > ?"
  )
    .bind(tokenHash, nowSec)
    .first<{ token_hash: string }>();

  if (row) {
    return { ok: true, method: "oauth" };
  }

  return { ok: false, status: 401, error: "Invalid or expired MCP token" };
}
