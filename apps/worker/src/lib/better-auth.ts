import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { passkey } from "@better-auth/passkey";
import type { AppEnv } from "../types.js";
import { hashPasswordPbkdf2, verifyPasswordPbkdf2 } from "./auth.js";

export interface AuthProvidersInfo {
  email_password: boolean;
  passkey: boolean;
  google: boolean;
  github: boolean;
  apple: boolean;
  legacy_password: boolean;
}

export interface BetterAuthUserSummary {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export function resolveBetterAuthSecret(env: AppEnv): string | null {
  const secret = env.BETTER_AUTH_SECRET || env.SESSION_SIGNING_SECRET;
  return secret && secret.length >= 16 ? secret : null;
}

export function parseAllowedOwnerEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && entry.includes("@"));
}

export function resolveAuthBaseUrl(env: AppEnv, requestUrl: string): string {
  const configured = env.PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fallback to request origin if PUBLIC_APP_URL is malformed
    }
  }
  return new URL(requestUrl).origin;
}

export function getConfiguredProviders(env: AppEnv): AuthProvidersInfo {
  const hasSecret = resolveBetterAuthSecret(env) !== null;
  return {
    email_password: hasSecret,
    passkey: hasSecret,
    google: Boolean(hasSecret && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: Boolean(hasSecret && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    apple: Boolean(hasSecret && env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET),
    legacy_password: Boolean(env.UI_ADMIN_PASSWORD_HASH && env.SESSION_SIGNING_SECRET && env.SESSION_SIGNING_SECRET.length >= 16),
  };
}

export async function hasRegisteredOwner(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS cnt FROM user").first<{ cnt: number }>();
    return (row?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}

export function hasBetterAuthSessionCookie(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  return (
    cookieHeader.includes("better-auth.session_token=") ||
    cookieHeader.includes("__Secure-better-auth.session_token=")
  );
}

/**
 * Creates a request-scoped Better Auth instance bound directly to Cloudflare D1.
 * Enforces strict single-user instance ownership via `databaseHooks.user.create.before`.
 */
export function createBetterAuth(env: AppEnv, requestUrl: string) {
  const secret = resolveBetterAuthSecret(env);
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET or SESSION_SIGNING_SECRET is not configured");
  }

  const baseURL = resolveAuthBaseUrl(env, requestUrl);
  const requestOrigin = new URL(requestUrl).origin;
  const trustedOrigins = Array.from(new Set([baseURL, requestOrigin]));
  const allowedEmails = parseAllowedOwnerEmails(env.ALLOWED_OWNER_EMAIL);

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders["google"] = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    socialProviders["github"] = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }
  if (env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET) {
    socialProviders["apple"] = {
      clientId: env.APPLE_CLIENT_ID,
      clientSecret: env.APPLE_CLIENT_SECRET,
    };
  }

  return betterAuth({
    appName: "PainCave",
    baseURL,
    basePath: "/api/auth",
    secret,
    trustedOrigins,
    // Better Auth 1.7 natively detects Cloudflare D1 bindings via Kysely D1SqliteDialect
    database: env.DB,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Use native WebCrypto PBKDF2 so hashing stays well within Cloudflare Workers CPU budgets
      password: {
        hash: (password) => hashPasswordPbkdf2(password),
        verify: ({ hash, password }) => verifyPasswordPbkdf2(password, hash),
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "github", "apple"],
      },
    },
    socialProviders,
    plugins: [
      passkey({
        rpName: "PainCave",
      }),
    ],
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const normalized = user.email.trim().toLowerCase();
            if (allowedEmails.length > 0 && !allowedEmails.includes(normalized)) {
              throw new APIError("FORBIDDEN", {
                message: "Signups are restricted to the configured instance owner.",
              });
            }

            const countRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM user").first<{
              cnt: number;
            }>();
            if ((countRow?.cnt ?? 0) >= 1) {
              throw new APIError("FORBIDDEN", {
                message: "This PainCave instance already has a registered owner account.",
              });
            }

            return {
              data: {
                ...user,
                email: normalized,
              },
            };
          },
        },
      },
    },
  });
}

export async function getBetterAuthSessionUser(
  env: AppEnv,
  request: Request
): Promise<BetterAuthUserSummary | null> {
  if (!resolveBetterAuthSecret(env)) return null;
  if (!hasBetterAuthSessionCookie(request.headers.get("Cookie") ?? undefined)) {
    return null;
  }
  try {
    const auth = createBetterAuth(env, request.url);
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    return {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    };
  } catch {
    return null;
  }
}
