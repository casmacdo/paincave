import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const testEnv = env as typeof env & {
  ALLOWED_OWNER_EMAIL?: string;
  ALLOWED_USER_EMAILS?: string;
};

function extractSessionCookie(headers: Headers): string {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie ? getSetCookie.call(headers) : [headers.get("Set-Cookie") ?? ""];
  return cookies
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("better-auth.session_token="))
    .join("; ");
}

describe("Single-User Better Auth (Owner Lock, Sessions, & MCP OAuth)", () => {
  afterEach(async () => {
    testEnv.ALLOWED_OWNER_EMAIL = undefined;
    testEnv.ALLOWED_USER_EMAILS = undefined;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM passkey"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM verification"),
      env.DB.prepare("DELETE FROM user"),
      env.DB.prepare("DELETE FROM athlete_profile WHERE user_id != 'default_owner'"),
    ]);
  });

  it("blocks unauthorized emails when ALLOWED_OWNER_EMAIL is set", async () => {
    testEnv.ALLOWED_OWNER_EMAIL = "owner@example.com";

    const blocked = await exports.default.fetch("https://paincave.test/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://paincave.test",
      },
      body: JSON.stringify({
        name: "Intruder",
        email: "intruder@example.com",
        password: "strong-password-123",
      }),
    });
    expect(blocked.status).toBe(403);

    const countRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM user").first<{
      cnt: number;
    }>();
    expect(countRow?.cnt).toBe(0);
  });

  it("allows claiming a single owner account, locks out second signups, accesses protected APIs, and approves MCP OAuth", async () => {
    // 1. Fresh instance reports has_owner = false
    const me0 = await exports.default.fetch("https://paincave.test/api/auth/me");
    const me0Body = await me0.json<{
      authenticated: boolean;
      has_owner: boolean;
      providers: { email_password: boolean; passkey: boolean };
    }>();
    expect(me0Body.authenticated).toBe(false);
    expect(me0Body.has_owner).toBe(false);
    expect(me0Body.providers.email_password).toBe(true);
    expect(me0Body.providers.passkey).toBe(true);

    // 2. Owner creates the single account
    const signUpRes = await exports.default.fetch("https://paincave.test/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://paincave.test",
      },
      body: JSON.stringify({
        name: "Rider Owner",
        email: "owner@example.com",
        password: "strong-password-123",
      }),
    });
    expect(signUpRes.status).toBe(200);
    const baCookie = extractSessionCookie(signUpRes.headers);
    expect(baCookie).toContain("better-auth.session_token=");

    // 3. Second user signup is strictly blocked (single-owner lock)
    const secondRes = await exports.default.fetch("https://paincave.test/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://paincave.test",
      },
      body: JSON.stringify({
        name: "Second User",
        email: "second@example.com",
        password: "another-password-123",
      }),
    });
    expect(secondRes.status).toBe(403);

    // 4. /api/auth/me and protected API accept Better Auth session
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

    // 5. Active Better Auth session approves MCP OAuth /oauth/authorize without admin password
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

    // 6. Logout revokes Better Auth session
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

  it("allows multiple invited emails via ALLOWED_USER_EMAILS while blocking uninvited accounts", async () => {
    testEnv.ALLOWED_USER_EMAILS = "cyclist@example.com, runner@example.com";

    const u1 = await exports.default.fetch("https://paincave.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://paincave.test" },
      body: JSON.stringify({
        name: "Cyclist",
        email: "cyclist@example.com",
        password: "strong-password-123",
      }),
    });
    expect(u1.status).toBe(200);

    const u2 = await exports.default.fetch("https://paincave.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://paincave.test" },
      body: JSON.stringify({
        name: "Runner",
        email: "runner@example.com",
        password: "strong-password-456",
      }),
    });
    expect(u2.status).toBe(200);

    const u3 = await exports.default.fetch("https://paincave.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://paincave.test" },
      body: JSON.stringify({
        name: "Stranger",
        email: "stranger@example.com",
        password: "strong-password-789",
      }),
    });
    expect(u3.status).toBe(403);
  });
});
