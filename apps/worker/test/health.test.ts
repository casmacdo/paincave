import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

describe("Worker Health, Migrations & Bindings", () => {
  it("serves /api/health and /api/version with security headers", async () => {
    const healthRes = await exports.default.fetch("https://paincave.test/api/health");
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(healthRes.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await healthRes.json()).toMatchObject({
      ok: true,
      service: "paincave-worker",
      build_sha: "dev",
    });

    const versionRes = await exports.default.fetch("https://paincave.test/api/version");
    expect(versionRes.status).toBe(200);
    expect(await versionRes.json()).toEqual({
      build_sha: "dev",
      app_env: "development",
    });
  });

  it("applies D1 migrations and accesses R2 bucket binding", async () => {
    const profile = await env.DB.prepare("SELECT id, display_name, timezone FROM athlete_profile WHERE id = 1")
      .first<{ id: number; display_name: string; timezone: string }>();
    expect(profile).toEqual({ id: 1, display_name: "Athlete", timezone: "UTC" });

    const { results: tables } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all<{ name: string }>();
    const names = tables.map((r) => r.name);
    expect(names).toContain("rides");
    expect(names).toContain("mcp_oauth_clients");

    await env.RIDES_BUCKET.put("test/smoke.txt", "ok");
    const obj = await env.RIDES_BUCKET.get("test/smoke.txt");
    expect(obj).not.toBeNull();
    expect(await obj?.text()).toBe("ok");
  });
});
