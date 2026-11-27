import { parseFitRecords } from "@paincave/shared";
import type { AppEnv } from "../types.js";
import { logJson } from "./logger.js";

const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_UPLOAD_URL = "https://www.strava.com/api/v3/uploads";

export interface StravaTokenRow {
  provider: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  athlete_external_id: string | null;
  updated_at: string;
}

interface StravaTokenApiResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  athlete?: {
    id?: number | string;
  };
}

interface StravaUploadApiResponse {
  id?: number;
  id_str?: string | null;
  activity_id?: number | null;
  status?: string;
  error?: string | null;
  message?: string;
}

export function isStravaConfigured(env: AppEnv): boolean {
  return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET);
}

export function buildStravaAuthorizeUrl(env: AppEnv, redirectUri: string, state: string): string {
  if (!env.STRAVA_CLIENT_ID) {
    throw new Error("STRAVA_CLIENT_ID is not configured");
  }
  const url = new URL(STRAVA_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", "activity:write,read");
  url.searchParams.set("state", state);
  return url.toString();
}

async function upsertStravaToken(
  env: AppEnv,
  token: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope: string;
    athlete_external_id: string | null;
  }
): Promise<StravaTokenRow> {
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, athlete_external_id, updated_at)
     VALUES ('strava', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       athlete_external_id = COALESCE(excluded.athlete_external_id, oauth_tokens.athlete_external_id),
       updated_at = excluded.updated_at`
  )
    .bind(
      token.access_token,
      token.refresh_token,
      token.expires_at,
      token.scope,
      token.athlete_external_id,
      nowIso
    )
    .run();

  return {
    provider: "strava",
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: token.expires_at,
    scope: token.scope,
    athlete_external_id: token.athlete_external_id,
    updated_at: nowIso,
  };
}

export async function exchangeStravaCode(
  env: AppEnv,
  code: string
): Promise<StravaTokenRow> {
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) {
    throw new Error("Strava client credentials are not configured");
  }

  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
  });

  const resp = await globalThis.fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Strava token exchange failed (${resp.status}): ${errText.slice(0, 200)}`);
  }

  const payload = await resp.json<StravaTokenApiResponse>();
  if (!payload.access_token || !payload.refresh_token || !payload.expires_at) {
    throw new Error("Invalid Strava token response payload");
  }

  return upsertStravaToken(env, {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: payload.expires_at,
    scope: payload.scope ?? "activity:write,read",
    athlete_external_id: payload.athlete?.id !== undefined ? String(payload.athlete.id) : null,
  });
}

export async function getStravaTokenRow(env: AppEnv): Promise<StravaTokenRow | null> {
  return env.DB.prepare(
    "SELECT provider, access_token, refresh_token, expires_at, scope, athlete_external_id, updated_at FROM oauth_tokens WHERE provider = 'strava'"
  ).first<StravaTokenRow>();
}

export async function getValidStravaAccessToken(env: AppEnv): Promise<string | null> {
  const row = await getStravaTokenRow(env);
  if (!row) {
    return null;
  }

  const nowS = Math.floor(Date.now() / 1000);
  if (row.expires_at > nowS + 60) {
    return row.access_token;
  }

  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) {
    throw new Error("Strava token expired and Strava client secrets are missing");
  }

  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
  });

  const resp = await globalThis.fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Strava token refresh failed (${resp.status}): ${errText.slice(0, 200)}`);
  }

  const payload = await resp.json<StravaTokenApiResponse>();
  if (!payload.access_token || !payload.refresh_token || !payload.expires_at) {
    throw new Error("Invalid Strava refresh response payload");
  }

  const updated = await upsertStravaToken(env, {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: payload.expires_at,
    scope: payload.scope ?? row.scope,
    athlete_external_id:
      payload.athlete?.id !== undefined ? String(payload.athlete.id) : row.athlete_external_id,
  });

  return updated.access_token;
}

async function markStravaStatus(
  env: AppEnv,
  rideUuid: string,
  status: "not_connected" | "pending" | "uploaded" | "failed" | "skipped",
  uploadId: string | null,
  activityId: string | null,
  errorMsg: string | null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE rides
     SET strava_upload_status = ?,
         strava_upload_id = COALESCE(?, strava_upload_id),
         strava_activity_id = COALESCE(?, strava_activity_id),
         strava_error = ?,
         updated_at = ?
     WHERE ride_uuid = ?`
  )
    .bind(status, uploadId, activityId, errorMsg, new Date().toISOString(), rideUuid)
    .run();
}

export async function uploadFitToStrava(
  env: AppEnv,
  rideUuid: string
): Promise<{ status: string; upload_id: string | null; error: string | null }> {
  try {
    const ride = await env.DB.prepare(
      "SELECT ride_uuid, name, source, notes, r2_fit_key FROM rides WHERE ride_uuid = ?"
    )
      .bind(rideUuid)
      .first<{
        ride_uuid: string;
        name: string;
        source: string;
        notes: string;
        r2_fit_key: string;
      }>();

    if (!ride) {
      return { status: "failed", upload_id: null, error: "Ride not found" };
    }

    const accessToken = await getValidStravaAccessToken(env);
    if (!accessToken) {
      await markStravaStatus(env, rideUuid, "not_connected", null, null, null);
      return { status: "not_connected", upload_id: null, error: "Strava is not connected" };
    }

    const fitObj = await env.RIDES_BUCKET.get(ride.r2_fit_key);
    if (!fitObj) {
      const msg = `Missing FIT object in R2: ${ride.r2_fit_key}`;
      await markStravaStatus(env, rideUuid, "failed", null, null, msg);
      return { status: "failed", upload_id: null, error: msg };
    }

    const fitBuffer = await fitObj.arrayBuffer();
    let isVirtualRouteRide = false;
    try {
      const parsedFit = parseFitRecords(new Uint8Array(fitBuffer));
      // FIT SubSport 58 = virtual_activity, or indoor_bridge ride carrying synthetic/GPX GPS track
      isVirtualRouteRide =
        parsedFit.subSport === 58 || (ride.source === "indoor_bridge" && parsedFit.hasGps);
    } catch {
      isVirtualRouteRide = false;
    }

    const form = new FormData();
    form.set("file", new Blob([fitBuffer], { type: "application/octet-stream" }), `${rideUuid}.fit`);
    form.set("data_type", "fit");
    form.set("name", ride.name);
    if (ride.notes) {
      form.set("description", ride.notes);
    }
    if (isVirtualRouteRide) {
      form.set("sport_type", "VirtualRide");
      form.set("trainer", "1");
    }
    form.set("external_id", rideUuid);

    const resp = await globalThis.fetch(STRAVA_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    });

    const data = await resp
      .json<StravaUploadApiResponse>()
      .catch((): StravaUploadApiResponse => ({}));

    if (!resp.ok) {
      const msg = (data.error ?? data.message ?? `Strava HTTP ${resp.status}`).slice(0, 400);
      await markStravaStatus(env, rideUuid, "failed", null, null, msg);
      return { status: "failed", upload_id: null, error: msg };
    }

    if (data.error) {
      const msg = data.error.slice(0, 400);
      await markStravaStatus(env, rideUuid, "failed", null, null, msg);
      return { status: "failed", upload_id: null, error: msg };
    }

    const uploadId = data.id_str ?? (data.id !== undefined ? String(data.id) : null);
    const activityId = data.activity_id !== undefined && data.activity_id !== null ? String(data.activity_id) : null;
    await markStravaStatus(env, rideUuid, "uploaded", uploadId, activityId, null);
    logJson("info", "Strava FIT upload succeeded", { ride_uuid: rideUuid, upload_id: uploadId });
    return { status: "uploaded", upload_id: uploadId, error: null };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    await markStravaStatus(env, rideUuid, "failed", null, null, msg).catch(() => {});
    logJson("error", "Strava FIT upload failed", { ride_uuid: rideUuid, error: msg });
    return { status: "failed", upload_id: null, error: msg };
  }
}
