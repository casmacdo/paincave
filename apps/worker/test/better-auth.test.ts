import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createBetterAuth, parseAllowedUserEmails } from "../src/lib/better-auth.js";
import { createTestSession, resetTestAuth } from "./auth-helper.js";

const testEnv = env as typeof env & {
  ALLOWED_OWNER_EMAIL?: string;
  ALLOWED_USER_EMAILS?: string;
};

describe("Google-only Better Auth (Owner Lock, Sessions, & MCP OAuth)", () => {
  afterEach(async () => {
    testEnv.ALLOWED_OWNER_EMAIL = undefined;
    testEnv.ALLOWED_USER_EMAILS = undefined;
    await resetTestAuth();
    await env.DB.prepare("DELETE FROM athlete_profile WHERE user_id != 'default_owner'").run();
    await env.DB.prepare("DELETE FROM coaching_notes").run();
  });

  it("starts Google OAuth and removes legacy password and email-password endpoints", async () => {
    const social = await exports.default.fetch(
      "https://paincave.test/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://paincave.test",
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/",
          errorCallbackURL: "/",
        }),
      }
    );
    expect(social.status).toBe(200);
    const body = await social.json<{ url: string; redirect: boolean }>();
    expect(body.redirect).toBe(true);
    expect(body.url).toContain("accounts.google.com");
    expect(decodeURIComponent(body.url)).toContain("/api/auth/callback/google");

    const legacy = await exports.default.fetch("https://paincave.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "not-valid" }),
    });
    expect(legacy.status).toBe(404);

    const emailPassword = await exports.default.fetch(
      "https://paincave.test/api/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://paincave.test",
        },
        body: JSON.stringify({
          email: "owner@example.com",
          password: "not-valid",
        }),
      }
    );
    expect(emailPassword.status).toBe(400);
  });

  it("reports Google provider state and applies owner allowlists", async () => {
    testEnv.ALLOWED_OWNER_EMAIL = "owner@example.com";
    expect(parseAllowedUserEmails(testEnv)).toEqual(["owner@example.com"]);

    testEnv.ALLOWED_OWNER_EMAIL = undefined;
    testEnv.ALLOWED_USER_EMAILS = "cyclist@example.com, runner@example.com";
    expect(parseAllowedUserEmails(testEnv)).toEqual([
      "cyclist@example.com",
      "runner@example.com",
    ]);

    const me0 = await exports.default.fetch("https://paincave.test/api/auth/me");
    const me0Body = await me0.json<{
      authenticated: boolean;
      has_owner: boolean;
      providers: { google: boolean };
    }>();
    expect(me0Body.authenticated).toBe(false);
    expect(me0Body.has_owner).toBe(false);
    expect(me0Body.providers.google).toBe(true);
  });

  it("accepts a Google-style Better Auth session and approves MCP OAuth", async () => {
    testEnv.ALLOWED_OWNER_EMAIL = "owner@example.com";
    testEnv.ALLOWED_USER_EMAILS = "owner@example.com";
    const baCookie = await createTestSession("Rider Owner", "owner@example.com");

    const me1 = await exports.default.fetch("https://paincave.test/api/auth/me", {
      headers: { Cookie: baCookie },
    });
    const me1Body = await me1.json<{
      authenticated: boolean;
      auth_mode: string;
      has_owner: boolean;
      user: { email: string; name: string } | null;
    }>();
    expect(me1Body.authenticated).toBe(true);
    expect(me1Body.auth_mode).toBe("better_auth");
    expect(me1Body.has_owner).toBe(true);
    expect(me1Body.user?.email).toBe("owner@example.com");

    const profileRes = await exports.default.fetch("https://paincave.test/api/athlete/profile", {
      headers: { Cookie: baCookie },
    });
    expect(profileRes.status).toBe(200);

    const regRes = await exports.default.fetch("https://paincave.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Mobile MCP Test",
        redirect_uris: ["https://client.example/cb"],
      }),
    });
    expect(regRes.status).toBe(201);
    const { client_id } = await regRes.json<{ client_id: string }>();

    const authGet = await exports.default.fetch(
      `https://paincave.test/oauth/authorize?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent("https://client.example/cb")}&response_type=code&code_challenge=0123456789abcdefghijklmnopqrstuvwxyz&code_challenge_method=S256&state=xyz`,
      { headers: { Cookie: baCookie } }
    );
    expect(authGet.status).toBe(200);
    expect(await authGet.text()).toContain("Signed in as <strong>owner@example.com</strong>");

    const unauthPost = await exports.default.fetch("https://paincave.test/oauth/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id,
        redirect_uri: "https://client.example/cb",
        state: "xyz",
        code_challenge: "0123456789abcdefghijklmnopqrstuvwxyz",
        code_challenge_method: "S256",
        scope: "mcp:tools",
      }),
    });
    expect(unauthPost.status).toBe(401);
    const unauthHtml = await unauthPost.text();
    expect(unauthHtml).toContain("Sign In with Google");
    expect(unauthHtml).toContain("returnTo=%2Foauth%2Fauthorize");

    const authPost = await exports.default.fetch("https://paincave.test/oauth/authorize", {
      method: "POST",
      headers: {
        Cookie: baCookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id,
        redirect_uri: "https://client.example/cb",
        state: "xyz",
        code_challenge: "0123456789abcdefghijklmnopqrstuvwxyz",
        code_challenge_method: "S256",
        scope: "mcp:tools",
        session_approve: "1",
      }),
      redirect: "manual",
    });
    expect(authPost.status).toBe(302);
    expect(authPost.headers.get("Location")).toContain("https://client.example/cb?code=");

    const logoutRes = await exports.default.fetch("https://paincave.test/api/auth/logout", {
      method: "POST",
      headers: { Cookie: baCookie },
    });
    expect(logoutRes.status).toBe(200);

    const afterLogout = await exports.default.fetch("https://paincave.test/api/athlete/profile", {
      headers: { Cookie: baCookie },
    });
    expect(afterLogout.status).toBe(401);
  });

  it("enforces ALLOWED_OWNER_EMAIL, normalizes email, adopts default_owner rows, and locks single-owner signups", async () => {
    await env.DB.prepare(
      `INSERT INTO coaching_notes (id, user_id, category, sport, content)
       VALUES ('note-legacy-1', 'default_owner', 'preference', 'cycling', 'Adopt me')`
    ).run();

    testEnv.ALLOWED_OWNER_EMAIL = "owner@example.com";
    const auth = createBetterAuth(testEnv, "https://paincave.test/api/auth/callback/google");
    const ctx = await auth.$context;

    const oauthSource = { method: "oauth" as const, oauth: { providerId: "google" } };

    await expect(
      ctx.internalAdapter.createUser(
        {
          name: "Intruder",
          email: "intruder@example.com",
          emailVerified: true,
        },
        oauthSource
      )
    ).rejects.toThrow(/invited accounts/i);

    const userCountAfterReject = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM user").first<{
      cnt: number;
    }>();
    expect(userCountAfterReject?.cnt).toBe(0);

    const owner = await ctx.internalAdapter.createUser(
      {
        name: "Rider Owner",
        email: "Owner@Example.com",
        emailVerified: true,
      },
      oauthSource
    );
    expect(owner.email).toBe("owner@example.com");

    const adoptedNote = await env.DB.prepare("SELECT user_id FROM coaching_notes WHERE id = ?")
      .bind("note-legacy-1")
      .first<{ user_id: string }>();
    expect(adoptedNote?.user_id).toBe(owner.id);

    const ownerProfile = await env.DB.prepare(
      "SELECT features_json FROM athlete_profile WHERE user_id = ?"
    )
      .bind(owner.id)
      .first<{ features_json: string }>();
    expect(JSON.parse(ownerProfile?.features_json ?? "{}")).toEqual({ indoor_trainer: true });

    // Without allowlist, single-owner lock rejects any second user
    testEnv.ALLOWED_OWNER_EMAIL = undefined;
    testEnv.ALLOWED_USER_EMAILS = undefined;
    const lockedAuth = createBetterAuth(testEnv, "https://paincave.test/api/auth/callback/google");
    const lockedCtx = await lockedAuth.$context;

    await expect(
      lockedCtx.internalAdapter.createUser(
        {
          name: "Second User",
          email: "second@example.com",
          emailVerified: true,
        },
        oauthSource
      )
    ).rejects.toThrow(/already has a registered owner account/i);
  });

  it("allows multiple allowlisted emails in ALLOWED_USER_EMAILS while blocking unlisted accounts", async () => {
    testEnv.ALLOWED_USER_EMAILS = "cyclist@example.com, runner@example.com";
    const auth = createBetterAuth(testEnv, "https://paincave.test/api/auth/callback/google");
    const ctx = await auth.$context;
    const oauthSource = { method: "oauth" as const, oauth: { providerId: "google" } };

    const u1 = await ctx.internalAdapter.createUser(
      {
        name: "Cyclist",
        email: "cyclist@example.com",
        emailVerified: true,
      },
      oauthSource
    );
    const u2 = await ctx.internalAdapter.createUser(
      {
        name: "Runner",
        email: "runner@example.com",
        emailVerified: true,
      },
      oauthSource
    );

    const p1 = await env.DB.prepare("SELECT features_json FROM athlete_profile WHERE user_id = ?")
      .bind(u1.id)
      .first<{ features_json: string }>();
    const p2 = await env.DB.prepare("SELECT features_json FROM athlete_profile WHERE user_id = ?")
      .bind(u2.id)
      .first<{ features_json: string }>();
    expect(JSON.parse(p1?.features_json ?? "{}")).toEqual({ indoor_trainer: true });
    expect(JSON.parse(p2?.features_json ?? "{}")).toEqual({ indoor_trainer: false });

    await expect(
      ctx.internalAdapter.createUser(
        {
          name: "Stranger",
          email: "stranger@example.com",
          emailVerified: true,
        },
        oauthSource
      )
    ).rejects.toThrow(/invited accounts/i);
  });
});
