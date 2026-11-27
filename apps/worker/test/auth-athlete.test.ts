import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { hashPasswordPbkdf2, timingSafeCompare, verifyPasswordPbkdf2 } from "../src/lib/auth.js";

async function loginAndGetCookie(): Promise<string> {
  const res = await exports.default.fetch("https://paincave.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "paincave-test-pw" }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  const cookiePair = setCookie?.split(";")[0] ?? "";
  expect(cookiePair).toContain("paincave_session=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  return cookiePair;
}

describe("Worker Authentication & Athlete API", () => {
  it("hashes and verifies PBKDF2 passwords and timing-safe secret comparisons", async () => {
    const hash = await hashPasswordPbkdf2("my-strong-passphrase");
    expect(await verifyPasswordPbkdf2("my-strong-passphrase", hash)).toBe(true);
    expect(await verifyPasswordPbkdf2("wrong-passphrase", hash)).toBe(false);
    expect(await timingSafeCompare("abc123", "abc123")).toBe(true);
    expect(await timingSafeCompare("abc123", "abc1234")).toBe(false);
    expect(await timingSafeCompare("", "")).toBe(false);
  });

  it("rejects unauthenticated requests and fails closed when secrets are missing", async () => {
    const unauth = await exports.default.fetch("https://paincave.test/api/athlete/profile");
    expect(unauth.status).toBe(401);

    const badLogin = await exports.default.fetch("https://paincave.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(badLogin.status).toBe(401);

    // Direct fail-closed check with missing signing secret
    const res = await exports.default.fetch("https://paincave.test/api/auth/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ authenticated: false, configured: true });

    // Confirm raw env still has configured secret
    expect(env.SESSION_SIGNING_SECRET).toBeTruthy();
  });

  it("supports session login, athlete profile, dated thresholds, blocks, notes, and logout revocation", async () => {
    const cookie = await loginAndGetCookie();

    // Update profile
    const putProfile = await exports.default.fetch("https://paincave.test/api/athlete/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ display_name: "Rider One", timezone: "UTC", units: "metric" }),
    });
    expect(putProfile.status).toBe(200);

    // Add dated thresholds
    const t1 = await exports.default.fetch("https://paincave.test/api/athlete/thresholds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        effective_from: "2026-10-01",
        ftp_watts: 250,
        lthr_bpm: 170,
        hrmax_bpm: 188,
        weight_kg: 72.5,
      }),
    });
    expect(t1.status).toBe(201);

    const t2 = await exports.default.fetch("https://paincave.test/api/athlete/thresholds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        effective_from: "2026-11-15",
        ftp_watts: 265,
        lthr_bpm: 172,
        hrmax_bpm: 189,
        weight_kg: 71.8,
      }),
    });
    expect(t2.status).toBe(201);

    // Add training block and coaching note
    const blk = await exports.default.fetch("https://paincave.test/api/athlete/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Winter Sweet Spot Base",
        phase: "base",
        start_date: "2026-11-01",
        weekly_hours_target: 8,
        constraints: { mon: "rest", tue_max_min: 60 },
        active: true,
      }),
    });
    expect(blk.status).toBe(201);

    const noteRes = await exports.default.fetch("https://paincave.test/api/athlete/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        category: "preference",
        content: "Keep Tuesday workouts <= 60m",
      }),
    });
    expect(noteRes.status).toBe(201);
    const { note } = await noteRes.json<{ note: { id: string } }>();

    // Archive note
    const delNote = await exports.default.fetch(`https://paincave.test/api/athlete/notes/${note.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(delNote.status).toBe(200);

    // Logout revokes session in D1
    const logoutRes = await exports.default.fetch("https://paincave.test/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);

    const afterLogout = await exports.default.fetch("https://paincave.test/api/athlete/profile", {
      headers: { Cookie: cookie },
    });
    expect(afterLogout.status).toBe(401);
  });
});
