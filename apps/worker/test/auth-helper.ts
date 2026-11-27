import { env } from "cloudflare:workers";
import { makeSignature } from "better-auth/crypto";

type TestEnv = typeof env & {
  ALLOWED_OWNER_EMAIL?: string;
  ALLOWED_USER_EMAILS?: string;
  BETTER_AUTH_SECRET?: string;
  SESSION_SIGNING_SECRET?: string;
};

async function signTestCookieValue(value: string, secret: string): Promise<string> {
  return `${value}.${await makeSignature(value, secret)}`;
}

export async function resetTestAuth(): Promise<void> {
  await env.DB.prepare("DELETE FROM passkey").run();
  await env.DB.prepare("DELETE FROM session").run();
  await env.DB.prepare("DELETE FROM account").run();
  await env.DB.prepare("DELETE FROM verification").run();
  await env.DB.prepare("DELETE FROM user").run();
}

export async function createTestSession(
  name: string,
  email: string,
  reset = true,
  indoorTrainer = true
): Promise<string> {
  const testEnv = env as TestEnv;
  if (reset) {
    testEnv.ALLOWED_OWNER_EMAIL = testEnv.ALLOWED_OWNER_EMAIL ?? email;
    testEnv.ALLOWED_USER_EMAILS = testEnv.ALLOWED_USER_EMAILS ?? email;
    await resetTestAuth();
  }

  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  )
    .bind(userId, name, email, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`
  )
    .bind(sessionId, expiresAt, sessionToken, now, now, userId)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO athlete_profile
       (user_id, display_name, timezone, units, primary_sports_json, features_json)
     VALUES (?, ?, 'UTC', 'metric', '["cycling","strength"]', ?)`
  )
    .bind(userId, name, JSON.stringify({ indoor_trainer: indoorTrainer }))
    .run();

  const secret = testEnv.BETTER_AUTH_SECRET || testEnv.SESSION_SIGNING_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET or SESSION_SIGNING_SECRET is required for test sessions");
  }
  const signedToken = await signTestCookieValue(sessionToken, secret);
  return `__Secure-better-auth.session_token=${encodeURIComponent(signedToken)}`;
}
