import type { ActivitySport } from "./rides-service.js";
import { unwrapFitZipBytes } from "./zip-fit.js";

export const GARMIN_PERSONAL_API_BASE = "https://personal.connectapi.garmin.com";

export class GarminRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "GarminRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GarminTokenResult {
  access_token: string;
  expires_at: number; // Unix epoch seconds
}

export interface GarminActivityMeta {
  activityId: string;
  activityName: string;
  sport: ActivitySport;
  subSport: string | null;
  startTimeIso: string;
  rideDay: string;
  durationS: number;
  distanceM: number | null;
  elevationGainM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  avgCadence: number | null;
}

export interface DailyBiometricsInput {
  day: string;
  hrv_rmssd_ms?: number | null;
  hrv_status?: string | null;
  resting_hr_bpm?: number | null;
  sleep_duration_s?: number | null;
  sleep_deep_s?: number | null;
  sleep_rem_s?: number | null;
  sleep_light_s?: number | null;
  sleep_awake_s?: number | null;
  sleep_score?: number | null;
  body_battery_high?: number | null;
  body_battery_low?: number | null;
  body_battery_charged?: number | null;
  stress_avg?: number | null;
  steps?: number | null;
  spo2_avg?: number | null;
  weight_kg?: number | null;
  cycle_phase?: string | null;
  raw_json?: Record<string, unknown>;
}

function addDaysUtc(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function splitDateRangeChunks(
  startDay: string,
  endDay: string,
  maxChunkDays = 28
): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  let cur = startDay;
  const step = Math.max(1, maxChunkDays - 1);
  while (cur <= endDay) {
    const candidateEnd = addDaysUtc(cur, step);
    const chunkEnd = candidateEnd < endDay ? candidateEnd : endDay;
    chunks.push({ start: cur, end: chunkEnd });
    cur = addDaysUtc(chunkEnd, 1);
  }
  return chunks;
}

export function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hasAnyBiometricValue(row: DailyBiometricsInput): boolean {
  return (
    row.hrv_rmssd_ms != null ||
    row.resting_hr_bpm != null ||
    row.sleep_duration_s != null ||
    row.sleep_score != null ||
    row.body_battery_high != null ||
    row.body_battery_low != null ||
    row.body_battery_charged != null ||
    row.stress_avg != null ||
    row.steps != null ||
    row.spo2_avg != null ||
    row.weight_kg != null
  );
}

export function normalizeGarminSportType(rawType: string | undefined): {
  sport: ActivitySport;
  subSport: string | null;
} {
  const key = (rawType ?? "").toLowerCase();
  if (key.includes("run") || key.includes("jog")) {
    const sub = key.includes("trail")
      ? "trail"
      : key.includes("treadmill")
        ? "treadmill"
        : key.includes("track")
          ? "track"
          : "road";
    return { sport: "running", subSport: sub };
  }
  if (key.includes("cycl") || key.includes("bik") || key.includes("ride")) {
    const sub = key.includes("virtual")
      ? "virtual_activity"
      : key.includes("indoor")
        ? "indoor_cycling"
        : key.includes("mountain") || key.includes("mtb")
          ? "mountain"
          : "road";
    return { sport: "cycling", subSport: sub };
  }
  if (key.includes("strength") || key.includes("weight") || key.includes("hiit")) {
    return { sport: "strength", subSport: "strength_training" };
  }
  if (key.includes("yoga") || key.includes("pilates") || key.includes("mobility") || key.includes("stretch")) {
    return { sport: "mobility", subSport: "mobility" };
  }
  return { sport: "other", subSport: key || null };
}

function checkRateLimit(resp: Response, context: string): void {
  if (resp.status === 429) {
    const retryHeader = resp.headers.get("Retry-After");
    const retrySec = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
    throw new GarminRateLimitError(`Garmin Personal API rate limited (429) during ${context}`, retrySec);
  }
}

function parseJwtExpSeconds(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof json.exp === "number" && Number.isFinite(json.exp) && json.exp > 1_000_000_000) {
      return Math.floor(json.exp);
    }
  } catch {
    // non-JWT or unparseable payload
  }
  return null;
}

export async function exchangeGarminPersonalToken(apiKey: string): Promise<GarminTokenResult> {
  // Garmin's personalapitoken-service returns the JWT as text/plain and rejects Accept: application/json with HTTP 406.
  const resp = await globalThis.fetch(
    `${GARMIN_PERSONAL_API_BASE}/personalapitoken-service/personal-api/personal-api-key/token`,
    {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${apiKey.trim()}`,
        Accept: "text/plain, */*",
      },
    }
  );

  checkRateLimit(resp, "token exchange");
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Garmin token exchange failed (${resp.status}): ${errText.slice(0, 200)}`);
  }

  const rawBody = (await resp.text()).trim();
  if (!rawBody) {
    throw new Error("Garmin Personal API returned an empty access token");
  }

  let accessToken: string | undefined;
  let expiresInSec: number | null = null;

  if (rawBody.startsWith("{")) {
    const data = JSON.parse(rawBody) as {
      access_token?: string;
      token?: string;
      expires_in?: number;
    };
    accessToken = data.access_token ?? data.token;
    if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in)) {
      expiresInSec = data.expires_in;
    }
  } else {
    accessToken = rawBody.replace(/^"+|"+$/g, "").trim();
  }

  if (!accessToken) {
    throw new Error("Garmin Personal API returned no access token");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const jwtExp = parseJwtExpSeconds(accessToken);
  const expiresAt =
    jwtExp && jwtExp > nowSec + 300
      ? jwtExp - 300
      : nowSec + (expiresInSec && expiresInSec > 300 ? Math.min(expiresInSec, 86_400) : 82_800);

  return {
    access_token: accessToken,
    expires_at: expiresAt,
  };
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function fetchGarminActivities(
  jwt: string,
  startDay: string,
  endDay: string,
  opts?: { requestDelayMs?: number }
): Promise<GarminActivityMeta[]> {
  const chunks = splitDateRangeChunks(startDay, endDay, 28);
  const delayMs = opts?.requestDelayMs ?? 300;
  const out: GarminActivityMeta[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && delayMs > 0) {
      await sleepMs(delayMs);
    }
    const chunk = chunks[i]!;
    const url = new URL(`${GARMIN_PERSONAL_API_BASE}/activitylist-service/activities/search/activities`);
    url.searchParams.set("startDate", chunk.start);
    url.searchParams.set("endDate", chunk.end);
    url.searchParams.set("limit", "100");

    const resp = await globalThis.fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });
    checkRateLimit(resp, "activity search");
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Garmin activity list failed (${resp.status}): ${errText.slice(0, 200)}`);
    }

    const raw = await resp.json<unknown>();
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { activities?: unknown[] }).activities)
        ? (raw as { activities: unknown[] }).activities
        : [];

    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const idRaw = rec["activityId"] ?? rec["id"];
      if (typeof idRaw !== "string" && typeof idRaw !== "number") continue;
      const activityId = String(idRaw);
      if (seen.has(activityId)) continue;
      seen.add(activityId);

      const typeObj = rec["activityType"] as { typeKey?: string } | undefined;
      const typeKey = typeObj?.typeKey ?? asStr(rec["activityType"]) ?? asStr(rec["sportType"]) ?? "";
      const { sport, subSport } = normalizeGarminSportType(typeKey);

      const startRaw =
        asStr(rec["startTimeGMT"]) ??
        asStr(rec["startTimeLocal"]) ??
        asStr(rec["startTime"]) ??
        `${chunk.start}T12:00:00Z`;
      const startTimeIso = startRaw.includes("T")
        ? startRaw.endsWith("Z")
          ? startRaw
          : `${startRaw}Z`
        : startRaw.replace(" ", "T") + "Z";
      const rideDay = startTimeIso.slice(0, 10);

      out.push({
        activityId,
        activityName: asStr(rec["activityName"]) ?? `${sport[0]!.toUpperCase()}${sport.slice(1)} Activity`,
        sport,
        subSport,
        startTimeIso,
        rideDay,
        durationS: Math.max(0, Math.round(asNum(rec["duration"]) ?? asNum(rec["movingDuration"]) ?? 0)),
        distanceM: asNum(rec["distance"]),
        elevationGainM: asNum(rec["elevationGain"]),
        avgHr: asNum(rec["averageHR"]) !== null ? Math.round(asNum(rec["averageHR"])!) : null,
        maxHr: asNum(rec["maxHR"]) !== null ? Math.round(asNum(rec["maxHR"])!) : null,
        avgPower: asNum(rec["avgPower"]) !== null ? Math.round(asNum(rec["avgPower"])!) : null,
        avgCadence:
          asNum(rec["averageRunningCadenceInStepsPerMinute"]) !== null
            ? Math.round(asNum(rec["averageRunningCadenceInStepsPerMinute"])!)
            : asNum(rec["averageBikingCadenceInRevPerMinute"]) !== null
              ? Math.round(asNum(rec["averageBikingCadenceInRevPerMinute"])!)
              : null,
      });
    }
  }

  return out;
}

export async function downloadGarminActivityFit(
  jwt: string,
  activityId: string
): Promise<Uint8Array | null> {
  const resp = await globalThis.fetch(
    `${GARMIN_PERSONAL_API_BASE}/download-service/files/activity/${encodeURIComponent(activityId)}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    }
  );

  checkRateLimit(resp, `activity ${activityId} FIT download`);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Garmin FIT download failed (${resp.status}): ${errText.slice(0, 200)}`);
  }

  const rawBytes = new Uint8Array(await resp.arrayBuffer());
  if (rawBytes.byteLength < 14) return null;
  return unwrapFitZipBytes(rawBytes);
}

async function fetchOptionalJson(jwt: string, url: string, context: string): Promise<unknown> {
  const resp = await globalThis.fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json",
    },
  });
  checkRateLimit(resp, context);
  if (resp.status === 404 || resp.status === 204) return null;
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

function extractArray(raw: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(obj[k])) return obj[k] as unknown[];
    }
  }
  return [];
}

export async function fetchGarminDailyBiometrics(
  jwt: string,
  startDay: string,
  endDay: string,
  opts?: { requestDelayMs?: number }
): Promise<DailyBiometricsInput[]> {
  const byDay = new Map<string, DailyBiometricsInput>();
  const ensure = (day: string): DailyBiometricsInput => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const fresh: DailyBiometricsInput = { day, raw_json: {} };
    byDay.set(day, fresh);
    return fresh;
  };

  const delayMs = opts?.requestDelayMs ?? 300;
  const chunks = splitDateRangeChunks(startDay, endDay, 28);
  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    const chunk = chunks[cIdx]!;
    if (cIdx > 0 && delayMs > 0) {
      await sleepMs(delayMs);
    }

    const dailiesRaw = await fetchOptionalJson(
      jwt,
      `${GARMIN_PERSONAL_API_BASE}/usersummary-service/v2/dailysummaries?startDate=${chunk.start}&endDate=${chunk.end}`,
      "dailysummaries"
    );

    let chunkHasBodyBattery = false;
    for (const item of extractArray(dailiesRaw, ["data", "dailySummaries", "summaries"])) {
      const r = asRecord(item);
      if (!r) continue;
      const day = asStr(r["calendarDate"]) ?? asStr(r["day"]);
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const entry = ensure(day);

      // Garmin Personal API v2 returns nested objects (heartRate, movement, stress, bodyBattery, spo2),
      // while older summary schemas use flat camelCase fields; accept both.
      const hrObj = asRecord(r["heartRate"]);
      const mvObj = asRecord(r["movement"]);
      const mvStepsObj = asRecord(mvObj?.["steps"]);
      const stressObj = asRecord(r["stress"]);
      const bbObj = asRecord(r["bodyBattery"]);
      const spo2Obj = asRecord(r["spo2"]);

      entry.resting_hr_bpm =
        asNum(hrObj?.["restingValue"]) ??
        asNum(r["restingHeartRate"]) ??
        asNum(r["restingHeartRateInBeatsPerMinute"]) ??
        entry.resting_hr_bpm ??
        null;
      entry.steps =
        asNum(mvObj?.["steps"]) ??
        asNum(mvStepsObj?.["value"]) ??
        asNum(r["totalSteps"]) ??
        asNum(r["steps"]) ??
        entry.steps ??
        null;
      entry.stress_avg =
        asNum(stressObj?.["avgLevel"]) ??
        asNum(r["averageStressLevel"]) ??
        asNum(r["stressAvg"]) ??
        entry.stress_avg ??
        null;
      entry.body_battery_high =
        asNum(bbObj?.["maxValue"]) ??
        asNum(r["bodyBatteryHighestValue"]) ??
        entry.body_battery_high ??
        null;
      entry.body_battery_low =
        asNum(bbObj?.["minValue"]) ??
        asNum(r["bodyBatteryLowestValue"]) ??
        entry.body_battery_low ??
        null;
      entry.body_battery_charged =
        asNum(bbObj?.["chargedValue"]) ??
        asNum(r["bodyBatteryChargedValue"]) ??
        entry.body_battery_charged ??
        null;
      entry.spo2_avg =
        asNum(spo2Obj?.["avgValue"]) ?? asNum(r["averageSpo2"]) ?? entry.spo2_avg ?? null;
      if (asNum(r["weightInGrams"]) !== null) {
        entry.weight_kg = Number((asNum(r["weightInGrams"])! / 1000).toFixed(2));
      } else if (asNum(r["weightKg"]) !== null) {
        entry.weight_kg = Number(asNum(r["weightKg"])!.toFixed(2));
      }
      if (entry.body_battery_high != null) {
        chunkHasBodyBattery = true;
      }
    }

    await sleepMs(delayMs);
    const hrvRaw = await fetchOptionalJson(
      jwt,
      `${GARMIN_PERSONAL_API_BASE}/hrv-service/hrv/daily/${chunk.start}/${chunk.end}`,
      "hrv"
    );
    for (const item of extractArray(hrvRaw, ["hrvSummaries", "summaries", "data"])) {
      const r = asRecord(item);
      if (!r) continue;
      const day = asStr(r["calendarDate"]) ?? asStr(r["day"]);
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const entry = ensure(day);
      entry.hrv_rmssd_ms =
        asNum(r["lastNightAvg"]) ??
        asNum(r["weeklyAvg"]) ??
        asNum(r["hrvRmssdMs"]) ??
        entry.hrv_rmssd_ms ??
        null;
      entry.hrv_status = asStr(r["status"]) ?? asStr(r["hrvStatus"]) ?? entry.hrv_status ?? null;
    }

    await sleepMs(delayMs);
    const sleepRaw = await fetchOptionalJson(
      jwt,
      `${GARMIN_PERSONAL_API_BASE}/sleep-service/sleep/dailySleepSummariesByDate?startDate=${chunk.start}&endDate=${chunk.end}`,
      "sleeps"
    );
    const extractedSleeps = extractArray(sleepRaw, ["dailySleepDTOs", "sleepSummaries", "data"]);
    const sleepItems =
      extractedSleeps.length > 0
        ? extractedSleeps
        : asRecord(sleepRaw)
          ? [sleepRaw]
          : [];
    for (const item of sleepItems) {
      const rawRec = asRecord(item);
      if (!rawRec) continue;
      const r = asRecord(rawRec["dailySleepDTO"]) ?? rawRec;
      const day = asStr(r["calendarDate"]) ?? asStr(r["day"]);
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const entry = ensure(day);
      entry.sleep_duration_s =
        asNum(r["sleepTimeSeconds"]) ?? asNum(r["durationInSeconds"]) ?? entry.sleep_duration_s ?? null;
      entry.sleep_deep_s =
        asNum(r["deepSleepSeconds"]) ?? asNum(r["deepSleepDurationInSeconds"]) ?? entry.sleep_deep_s ?? null;
      entry.sleep_rem_s =
        asNum(r["remSleepSeconds"]) ?? asNum(r["remSleepInSeconds"]) ?? entry.sleep_rem_s ?? null;
      entry.sleep_light_s =
        asNum(r["lightSleepSeconds"]) ?? asNum(r["lightSleepDurationInSeconds"]) ?? entry.sleep_light_s ?? null;
      entry.sleep_awake_s =
        asNum(r["awakeSleepSeconds"]) ?? asNum(r["awakeDurationInSeconds"]) ?? entry.sleep_awake_s ?? null;
      const sleepScoresObj = asRecord(r["sleepScores"]);
      const overallObj = asRecord(sleepScoresObj?.["overall"]);
      const overallLegacyObj = asRecord(r["overallSleepScore"]);
      entry.sleep_score =
        asNum(overallObj?.["value"]) ??
        asNum(sleepScoresObj?.["overallScore"]) ??
        asNum(overallLegacyObj?.["value"]) ??
        asNum(r["sleepScore"]) ??
        entry.sleep_score ??
        null;
    }

    // Skip redundant Body Battery request when v2 dailysummaries already supplied daily peak values.
    if (!chunkHasBodyBattery) {
      await sleepMs(delayMs);
      const bodyBatteryRaw = await fetchOptionalJson(
        jwt,
        `${GARMIN_PERSONAL_API_BASE}/wellness-service/wellness/bodyBattery/reports/daily?startDate=${chunk.start}&endDate=${chunk.end}`,
        "bodyBattery"
      );
      const extractedBb = extractArray(bodyBatteryRaw, [
        "dailies",
        "bodyBatteryValues",
        "reports",
        "data",
      ]);
      const bbItems =
        extractedBb.length > 0
          ? extractedBb
          : asRecord(bodyBatteryRaw)
            ? [bodyBatteryRaw]
            : [];
      for (const item of bbItems) {
        const r = asRecord(item);
        if (!r) continue;
        const day =
          asStr(r["date"]) ??
          asStr(r["calendarDate"]) ??
          asStr(r["day"]) ??
          (chunk.start === chunk.end ? chunk.start : null);
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const entry = ensure(day);
        entry.body_battery_high =
          entry.body_battery_high ??
          asNum(r["highestValue"]) ??
          asNum(r["bodyBatteryHighestValue"]) ??
          null;
        entry.body_battery_low =
          entry.body_battery_low ??
          asNum(r["lowestValue"]) ??
          asNum(r["bodyBatteryLowestValue"]) ??
          null;
        entry.body_battery_charged =
          entry.body_battery_charged ??
          asNum(r["chargedValue"]) ??
          asNum(r["charged"]) ??
          asNum(r["bodyBatteryChargedValue"]) ??
          null;
        const valuesArr = r["bodyBatteryValuesArray"];
        if (Array.isArray(valuesArr) && valuesArr.length > 0) {
          const levels: number[] = [];
          for (const pair of valuesArr) {
            if (Array.isArray(pair) && typeof pair[1] === "number" && Number.isFinite(pair[1])) {
              levels.push(pair[1]);
            }
          }
          if (levels.length > 0) {
            entry.body_battery_high = entry.body_battery_high ?? Math.max(...levels);
            entry.body_battery_low = entry.body_battery_low ?? Math.min(...levels);
          }
        }
      }
    }

    await sleepMs(delayMs);
    const weightRaw = await fetchOptionalJson(
      jwt,
      `${GARMIN_PERSONAL_API_BASE}/weight-service/weight/range/${chunk.start}/${chunk.end}?includeAll=true`,
      "weight"
    );
    for (const item of extractArray(weightRaw, ["dailyWeightSummaries", "dateWeightList", "data"])) {
      const r = asRecord(item);
      if (!r) continue;
      const day = asStr(r["summaryDate"]) ?? asStr(r["calendarDate"]) ?? asStr(r["day"]);
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const latest = asRecord(r["latestWeight"]) ?? r;
      const grams = asNum(latest["weight"]) ?? asNum(r["weightInGrams"]);
      if (grams !== null && grams > 20_000) {
        ensure(day).weight_kg = Number((grams / 1000).toFixed(2));
      } else if (asNum(latest["weightKg"]) !== null) {
        ensure(day).weight_kg = Number(asNum(latest["weightKg"])!.toFixed(2));
      }
    }
  }

  return [...byDay.values()]
    .filter(hasAnyBiometricValue)
    .sort((a, b) => a.day.localeCompare(b.day));
}
