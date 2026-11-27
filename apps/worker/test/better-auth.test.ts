import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { parseAllowedUserEmails } from "../src/lib/better-auth.js";
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
});
