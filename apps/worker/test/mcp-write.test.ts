import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function callMcpTool<T>(
  name: string,
  args: Record<string, unknown>,
  token = env.MCP_BEARER_TOKEN ?? ""
): Promise<{ isError: boolean; structuredContent?: T; content: { text: string }[] }> {
  const res = await exports.default.fetch("https://paincave.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const json = await res.json<{
    result: { isError: boolean; structuredContent?: T; content: { text: string }[] };
  }>();
  return json.result;
}

describe("MCP Write Tools Guardrails & Mobile OAuth 2.1 (PKCE + DCR)", () => {
  it("enforces physiological guardrails, dry_run, block constraints, and projected TSB on schedule", async () => {
    // Reject unsafe workout
    const unsafe = await callMcpTool("create_workout", {
      spec: {
        schema_version: 1,
        name: "Dangerous Workout",
        steps: [{ type: "steady", duration_s: 360, target_ftp: 1.75 }],
      },
    });
    expect(unsafe.isError).toBe(true);
    expect(unsafe.content[0]?.text).toContain("guardrails");

    // Dry run returns predicted TSS without persisting
    const validSpec = {
      schema_version: 1,
      name: "Z2 Endurance",
      category: "endurance",
      steps: [
        { type: "steady", duration_s: 2700, target_ftp: 0.68, label: "Aerobic" },
      ],
    };
    const dryRes = await callMcpTool<{
      dry_run: boolean;
      predicted: { duration_s: number; tss: number };
    }>("create_workout", { spec: validSpec, dry_run: true });
    expect(dryRes.isError).toBe(false);
    expect(dryRes.structuredContent?.dry_run).toBe(true);
    expect(dryRes.structuredContent?.predicted.duration_s).toBe(2700);

    const listBefore = await callMcpTool<{ workouts: unknown[] }>("list_workouts", {
      query: "Z2 Endurance",
    });
    expect(listBefore.structuredContent?.workouts).toHaveLength(0);

    // Persist workout + training block + schedule on a rest day to verify constraint warnings & projected TSB
    const saveRes = await callMcpTool<{ workout_id: string }>("create_workout", {
      spec: validSpec,
      dry_run: false,
    });
    expect(saveRes.isError).toBe(false);
    const workoutId = saveRes.structuredContent?.workout_id ?? "";

    await callMcpTool("upsert_training_block", {
      name: "Winter Build",
      phase: "build",
      start_date: "2026-11-01",
      weekly_hours_target: 8,
      constraints: { mon: "rest" },
      active: true,
    });

    // 2026-11-30 is Monday
    const schedRes = await callMcpTool<{
      session: { id: string };
      warnings: string[];
      projected_pmc_on_date: { ctl: number; atl: number; tsb: number };
    }>("schedule_workout", {
      scheduled_date: "2026-11-30",
      workout_id: workoutId,
      coach_rationale: "Schedule Z2 ride",
    });
    expect(schedRes.isError).toBe(false);
    expect(schedRes.structuredContent?.warnings[0]).toContain("mon");
    expect(schedRes.structuredContent?.projected_pmc_on_date.atl).toBeGreaterThan(0);

    const moveRes = await callMcpTool("move_or_cancel_session", {
      session_id: schedRes.structuredContent?.session.id ?? "",
      action: "move",
      new_date: "2026-12-01",
    });
    expect(moveRes.isError).toBe(false);

    const noteRes = await callMcpTool<{ note: { id: string } }>("save_coaching_note", {
      category: "injury",
      content: "Left knee prefers >85rpm",
    });
    const archRes = await callMcpTool("archive_coaching_note", {
      note_id: noteRes.structuredContent?.note.id ?? "",
    });
    expect(archRes.isError).toBe(false);
  });

  it("completes full Mobile OAuth 2.1 + PKCE S256 + DCR + refresh rotation flow for /mcp", async () => {
    // 1. Discovery endpoints
    const prmRes = await exports.default.fetch(
      "https://paincave.test/.well-known/oauth-protected-resource"
    );
    expect(prmRes.status).toBe(200);
    expect(await prmRes.json()).toMatchObject({
      resource: "https://paincave.test/mcp",
      authorization_servers: ["https://paincave.test"],
    });

    const asmRes = await exports.default.fetch(
      "https://paincave.test/.well-known/oauth-authorization-server"
    );
    expect(asmRes.status).toBe(200);
    expect(await asmRes.json()).toMatchObject({
      registration_endpoint: "https://paincave.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
    });

    // 2. Dynamic Client Registration
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const regRes = await exports.default.fetch("https://paincave.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Mobile",
        redirect_uris: [redirectUri],
      }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = await regRes.json<{ client_id: string }>();

    // 3. Reject unregistered redirect_uri
    const verifier = "mobile-pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const challenge = await pkceChallenge(verifier);
    const badAuthz = await exports.default.fetch(
      `https://paincave.test/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${challenge}&code_challenge_method=S256`
    );
    expect(badAuthz.status).toBe(400);

    // 4. GET authorize renders consent form
    const authzGet = await exports.default.fetch(
      `https://paincave.test/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz123`
    );
    expect(authzGet.status).toBe(200);
    expect(await authzGet.text()).toContain("Claude Mobile");

    // 5. POST authorize rejects wrong password, approves right password
    const makeForm = (pw: string): URLSearchParams =>
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state: "xyz123",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp:tools",
        password: pw,
      });

    const badPwRes = await exports.default.fetch("https://paincave.test/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: makeForm("wrong-pw").toString(),
    });
    expect(badPwRes.status).toBe(401);

    const approveRes = await exports.default.fetch("https://paincave.test/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: makeForm("paincave-test-pw").toString(),
      redirect: "manual",
    });
    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get("Location") ?? "");
    const authCode = location.searchParams.get("code") ?? "";
    expect(authCode.length).toBeGreaterThan(20);
    expect(location.searchParams.get("state")).toBe("xyz123");

    // 6. Token exchange rejects wrong PKCE verifier, accepts valid verifier
    const badTokenRes = await exports.default.fetch("https://paincave.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: "wrong-verifier",
      }).toString(),
    });
    expect(badTokenRes.status).toBe(400);

    const tokenRes = await exports.default.fetch("https://paincave.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json<{
      access_token: string;
      refresh_token: string;
      token_type: string;
    }>();
    expect(tokens.token_type).toBe("Bearer");

    // 7. Single-use code cannot be replayed
    const replayRes = await exports.default.fetch("https://paincave.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    expect(replayRes.status).toBe(400);

    // 8. Access token works on /mcp
    const mcpRes = await callMcpTool("get_athlete_context", {}, tokens.access_token);
    expect(mcpRes.isError).toBe(false);

    // 9. Refresh token rotation revokes old access token and mints new pair
    const refreshRes = await exports.default.fetch("https://paincave.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const rotated = await refreshRes.json<{ access_token: string }>();
    expect(rotated.access_token).not.toBe(tokens.access_token);

    const oldAfterRefresh = await exports.default.fetch("https://paincave.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(oldAfterRefresh.status).toBe(401);

    const newMcpRes = await callMcpTool("get_athlete_context", {}, rotated.access_token);
    expect(newMcpRes.isError).toBe(false);
  });
});
