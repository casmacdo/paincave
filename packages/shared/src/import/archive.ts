import { parseFitRecords } from "../fit/reader.js";
import { computeRideMetrics } from "../physiology/metrics.js";
import { computeRunningMetrics } from "../physiology/running.js";
import type { RideUploadSummary } from "../protocol/bridge.js";
import { parseGpxRoute } from "../routes/gpx.js";

export type ArchiveSport = "cycling" | "running" | "strength" | "mobility" | "other";

export interface StravaCsvActivityRow {
  external_id: string;
  started_at: string;
  ride_day: string;
  name: string;
  raw_type: string;
  sport: ArchiveSport;
  sub_sport: string | null;
  duration_s: number;
  elapsed_s: number;
  distance_m: number | null;
  elevation_gain_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power: number | null;
  filename: string | null;
  description: string;
}

export interface ArchiveBiometricsRow {
  day: string;
  hrv_rmssd_ms?: number | null;
  hrv_status?: string | null;
  resting_hr_bpm?: number | null;
  sleep_duration_s?: number | null;
  sleep_score?: number | null;
  body_battery_high?: number | null;
  body_battery_low?: number | null;
  stress_avg?: number | null;
  steps?: number | null;
  weight_kg?: number | null;
}

export function mapArchiveSportName(rawType: string): {
  sport: ArchiveSport;
  subSport: string | null;
} {
  const s = rawType.trim().toLowerCase();
  if (s.includes("run") || s.includes("jog")) {
    const sub = s.includes("trail")
      ? "trail"
      : s.includes("treadmill")
        ? "treadmill"
        : s.includes("virtual")
          ? "virtual_activity"
          : "road";
    return { sport: "running", subSport: sub };
  }
  if (s.includes("ride") || s.includes("cycl") || s.includes("bik") || s.includes("velomobile")) {
    const sub = s.includes("virtual")
      ? "virtual_activity"
      : s.includes("mountain") || s.includes("mtb")
        ? "mountain"
        : s.includes("gravel")
          ? "gravel"
          : "road";
    return { sport: "cycling", subSport: sub };
  }
  if (s.includes("weight") || s.includes("strength") || s.includes("crossfit") || s.includes("workout")) {
    return { sport: "strength", subSport: "strength_training" };
  }
  if (s.includes("yoga") || s.includes("pilates") || s.includes("stretch") || s.includes("mobility")) {
    return { sport: "mobility", subSport: "mobility" };
  }
  return { sport: "other", subSport: s || null };
}

/**
 * RFC 4180 compliant CSV parser supporting quoted commas, escaped double quotes, and CRLF.
 */
export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const text = csvText.replace(/^\uFEFF/, "");

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseOptionalNum(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().replaceAll(",", "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseStravaDateIso(raw: string | undefined): string {
  if (!raw || !raw.trim()) return new Date().toISOString();
  const parsed = Date.parse(raw.trim());
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

export function parseStravaActivitiesCsv(csvText: string): StravaCsvActivityRow[] {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const colIdx = (candidates: string[]): number => {
    for (const c of candidates) {
      const idx = header.indexOf(c);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const iId = colIdx(["activity id"]);
  const iDate = colIdx(["activity date"]);
  const iName = colIdx(["activity name"]);
  const iType = colIdx(["activity type"]);
  const iDesc = colIdx(["activity description"]);
  const iElapsed = colIdx(["elapsed time"]);
  const iMoving = colIdx(["moving time"]);
  const iDist = colIdx(["distance"]);
  const iElev = colIdx(["elevation gain"]);
  const iAvgHr = colIdx(["average heart rate"]);
  const iMaxHr = colIdx(["max heart rate"]);
  const iAvgWatts = colIdx(["average watts"]);
  const iFile = colIdx(["filename"]);

  const out: StravaCsvActivityRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r]!;
    const id = iId >= 0 ? (cols[iId]?.trim() ?? "") : "";
    if (!id) continue;

    const startedAt = parseStravaDateIso(iDate >= 0 ? cols[iDate] : undefined);
    const rawType = iType >= 0 ? (cols[iType]?.trim() ?? "Other") : "Other";
    const { sport, subSport } = mapArchiveSportName(rawType);
    const elapsedS = Math.max(0, Math.round(parseOptionalNum(iElapsed >= 0 ? cols[iElapsed] : undefined) ?? 0));
    const movingS = Math.max(0, Math.round(parseOptionalNum(iMoving >= 0 ? cols[iMoving] : undefined) ?? elapsedS));

    // Strava CSV exports Distance in km in older exports or meters in newer exports;
    // when a second "Distance" column exists in meters or value < 500 assume km for endurance rides/runs
    const rawDist = parseOptionalNum(iDist >= 0 ? cols[iDist] : undefined);
    let distanceM: number | null = null;
    if (rawDist !== null && rawDist > 0) {
      distanceM = rawDist < 400 ? Number((rawDist * 1000).toFixed(1)) : Number(rawDist.toFixed(1));
    }

    const filename = iFile >= 0 ? (cols[iFile]?.trim() || null) : null;
    out.push({
      external_id: id,
      started_at: startedAt,
      ride_day: startedAt.slice(0, 10),
      name: (iName >= 0 ? cols[iName]?.trim() : "") || `${rawType} ${startedAt.slice(0, 10)}`,
      raw_type: rawType,
      sport,
      sub_sport: subSport,
      duration_s: movingS > 0 ? movingS : elapsedS,
      elapsed_s: elapsedS > 0 ? elapsedS : movingS,
      distance_m: distanceM,
      elevation_gain_m: parseOptionalNum(iElev >= 0 ? cols[iElev] : undefined),
      avg_hr: parseOptionalNum(iAvgHr >= 0 ? cols[iAvgHr] : undefined) !== null
        ? Math.round(parseOptionalNum(iAvgHr >= 0 ? cols[iAvgHr] : undefined)!)
        : null,
      max_hr: parseOptionalNum(iMaxHr >= 0 ? cols[iMaxHr] : undefined) !== null
        ? Math.round(parseOptionalNum(iMaxHr >= 0 ? cols[iMaxHr] : undefined)!)
        : null,
      avg_power: parseOptionalNum(iAvgWatts >= 0 ? cols[iAvgWatts] : undefined) !== null
        ? Math.round(parseOptionalNum(iAvgWatts >= 0 ? cols[iAvgWatts] : undefined)!)
        : null,
      filename,
      description: iDesc >= 0 ? (cols[iDesc]?.trim() ?? "") : "",
    });
  }

  return out;
}

export function parseGarminWellnessExportJson(payload: unknown): ArchiveBiometricsRow[] {
  const list = Array.isArray(payload) ? payload : payload && typeof payload === "object" ? [payload] : [];
  const out: ArchiveBiometricsRow[] = [];

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const day = str(r["calendarDate"]) ?? str(r["date"]) ?? str(r["day"]);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

    const sleepScoreObj = r["sleepScores"] as { overallScore?: unknown } | undefined;
    const weightGrams = num(r["weight"]) ?? num(r["weightInGrams"]);
    out.push({
      day,
      hrv_rmssd_ms: num(r["lastNightAvg"]) ?? num(r["hrvRmssdMs"]) ?? num(r["weeklyAvg"]),
      hrv_status: str(r["status"]) ?? str(r["hrvStatus"]),
      resting_hr_bpm:
        num(r["restingHeartRate"]) ?? num(r["restingHeartRateInBeatsPerMinute"]),
      sleep_duration_s:
        num(r["sleepTimeSeconds"]) ?? num(r["durationInSeconds"]),
      sleep_score: num(sleepScoreObj?.overallScore) ?? num(r["sleepScore"]),
      body_battery_high: num(r["bodyBatteryHighestValue"]) ?? num(r["highestBodyBattery"]),
      body_battery_low: num(r["bodyBatteryLowestValue"]) ?? num(r["lowestBodyBattery"]),
      stress_avg: num(r["averageStressLevel"]),
      steps: num(r["totalSteps"]) ?? num(r["steps"]),
      weight_kg:
        weightGrams !== null
          ? weightGrams > 400
            ? Number((weightGrams / 1000).toFixed(2))
            : Number(weightGrams.toFixed(2))
          : null,
    });
  }

  return out;
}

export interface NormalizedArchiveBatchItem {
  summary: RideUploadSummary;
  sport: ArchiveSport;
  sub_sport: string | null;
  external_provider: "strava_archive" | "garmin_archive";
  external_id: string;
  distance_m: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  avg_pace_s_per_km: number | null;
  gap_s_per_km: number | null;
  pa_hr_decoupling: number | null;
  threshold_pace_snapshot: number | null;
  laps: {
    lap_index: number;
    duration_s: number;
    distance_m: number | null;
    avg_pace_s_per_km: number | null;
    gap_s_per_km: number | null;
    avg_power: number | null;
    avg_hr: number | null;
    max_hr: number | null;
    avg_cadence: number | null;
    elevation_gain_m: number | null;
    elevation_loss_m: number | null;
  }[];
}

export function buildArchiveActivityItem(params: {
  rideUuid: string;
  externalProvider: "strava_archive" | "garmin_archive";
  externalId: string;
  name: string;
  startedAt: string;
  sport: ArchiveSport;
  subSport?: string | null;
  durationS?: number;
  elapsedS?: number;
  distanceM?: number | null;
  elevationGainM?: number | null;
  avgHr?: number | null;
  maxHr?: number | null;
  avgPower?: number | null;
  notes?: string;
  ftpWatts?: number;
  thresholdPaceSPerKm?: number | null;
  lthrBpm?: number | null;
  hrmaxBpm?: number | null;
  weightKg?: number | null;
  fitBytes?: Uint8Array | null;
  gpxXml?: string | null;
}): NormalizedArchiveBatchItem {
  const ftp = params.ftpWatts ?? 250;
  let sport = params.sport;
  let subSport = params.subSport ?? null;
  let startedAt = params.startedAt;
  let distanceM = params.distanceM ?? null;
  let elevationGainM = params.elevationGainM ?? null;
  let elevationLossM: number | null = null;
  let avgPaceSPerKm: number | null = null;
  let gapSPerKm: number | null = null;
  let paHrDecoupling: number | null = null;
  let laps: NormalizedArchiveBatchItem["laps"] = [];

  const baseDuration = Math.max(0, Math.round(params.durationS ?? 0));
  const baseElapsed = Math.max(baseDuration, Math.round(params.elapsedS ?? baseDuration));

  let summary: RideUploadSummary = {
    ride_uuid: params.rideUuid,
    name: params.name.slice(0, 200) || "Archived Activity",
    source: "external_sync",
    started_at: startedAt,
    ride_day: startedAt.slice(0, 10),
    duration_s: baseDuration,
    elapsed_s: baseElapsed,
    work_kj: params.avgPower && baseDuration > 0 ? Number(((params.avgPower * baseDuration) / 1000).toFixed(1)) : 0,
    avg_power: params.avgPower ?? null,
    np_watts: null,
    intensity_factor: null,
    tss: Number(((baseDuration / 3600) * 50).toFixed(1)),
    variability_index: null,
    avg_hr: params.avgHr ?? null,
    max_hr: params.maxHr ?? null,
    efficiency_factor: null,
    pw_hr_decoupling: null,
    hrr_60s: null,
    time_gt_90_hrmax_s: 0,
    avg_cadence: null,
    compliance_pct: null,
    power_zones: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, z6: 0, z7: 0 },
    hr_zones: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    quality_flags: { power_dropouts_s: 0, hr_dropouts_s: 0, erg_smoothing_detected: false },
    ftp_snapshot: ftp,
    lthr_snapshot: params.lthrBpm ?? null,
    hrmax_snapshot: params.hrmaxBpm ?? null,
    weight_kg_snapshot: params.weightKg ?? null,
    notes: (params.notes ?? "").slice(0, 2000),
    intervals: [],
    peaks: [],
  };

  if (params.fitBytes && params.fitBytes.byteLength >= 14) {
    const parsedFit = parseFitRecords(params.fitBytes);
    if (parsedFit.startTimeIso) {
      startedAt = parsedFit.startTimeIso;
      summary.started_at = startedAt;
      summary.ride_day = startedAt.slice(0, 10);
    }
    if (parsedFit.sport !== "other") sport = parsedFit.sport;
    if (parsedFit.subSportName) subSport = parsedFit.subSportName;

    if (sport === "running") {
      const rm = computeRunningMetrics(
        parsedFit.samples,
        {
          threshold_pace_s_per_km: params.thresholdPaceSPerKm ?? null,
          lthr_bpm: params.lthrBpm ?? null,
          hrmax_bpm: params.hrmaxBpm ?? null,
        },
        {
          sessionDistanceM: parsedFit.totalDistanceM ?? distanceM,
          sessionDurationS: parsedFit.totalTimerTimeS ?? baseDuration,
          sessionElapsedS: parsedFit.totalElapsedTimeS ?? baseElapsed,
          sessionAscentM: parsedFit.totalAscentM ?? elevationGainM,
          sessionDescentM: parsedFit.totalDescentM,
          fitLaps: parsedFit.laps,
        }
      );
      distanceM = rm.distance_m;
      elevationGainM = rm.elevation_gain_m;
      elevationLossM = rm.elevation_loss_m;
      avgPaceSPerKm = rm.avg_pace_s_per_km;
      gapSPerKm = rm.gap_s_per_km;
      paHrDecoupling = rm.pa_hr_decoupling;
      laps = rm.laps;
      summary = {
        ...summary,
        duration_s: rm.duration_s,
        elapsed_s: rm.elapsed_s,
        tss: rm.tss,
        avg_hr: rm.avg_hr ?? summary.avg_hr,
        max_hr: rm.max_hr ?? summary.max_hr,
        avg_cadence: rm.avg_cadence_spm,
        hr_zones: rm.hr_zones,
      };
    } else if (sport === "cycling" && parsedFit.samples.length > 0) {
      const cm = computeRideMetrics(parsedFit.samples, {
        ftp_watts: ftp,
        lthr_bpm: params.lthrBpm ?? null,
        hrmax_bpm: params.hrmaxBpm ?? null,
        weight_kg: params.weightKg ?? null,
      });
      distanceM = parsedFit.totalDistanceM ?? distanceM;
      elevationGainM = parsedFit.totalAscentM ?? elevationGainM;
      elevationLossM = parsedFit.totalDescentM;
      laps = parsedFit.laps.map((l) => ({
        lap_index: l.lap_index,
        duration_s: l.duration_s,
        distance_m: l.distance_m,
        avg_pace_s_per_km: l.avg_pace_s_per_km,
        gap_s_per_km: null,
        avg_power: l.avg_power,
        avg_hr: l.avg_hr,
        max_hr: l.max_hr,
        avg_cadence: l.avg_cadence,
        elevation_gain_m: l.elevation_gain_m,
        elevation_loss_m: l.elevation_loss_m,
      }));
      summary = {
        ...summary,
        duration_s: cm.duration_s,
        elapsed_s: cm.elapsed_s,
        work_kj: cm.work_kj,
        avg_power: cm.avg_power,
        np_watts: cm.np_watts,
        intensity_factor: cm.intensity_factor,
        tss: cm.tss,
        variability_index: cm.variability_index,
        avg_hr: cm.avg_hr,
        max_hr: cm.max_hr,
        efficiency_factor: cm.efficiency_factor,
        pw_hr_decoupling: cm.pw_hr_decoupling,
        hrr_60s: cm.hrr_60s,
        time_gt_90_hrmax_s: cm.time_gt_90_hrmax_s,
        avg_cadence: cm.avg_cadence,
        power_zones: cm.power_zones,
        hr_zones: cm.hr_zones,
        quality_flags: cm.quality_flags,
        peaks: cm.peaks,
      };
    }
  } else if (params.gpxXml) {
    try {
      const route = parseGpxRoute(params.gpxXml, params.name);
      distanceM = route.distance_m;
      elevationGainM = route.total_ascent_m;
    } catch {
      // keep CSV metadata
    }
  }

  if (sport === "running" && avgPaceSPerKm === null && distanceM && distanceM > 50 && summary.duration_s > 0) {
    avgPaceSPerKm = Number(((summary.duration_s / distanceM) * 1000).toFixed(1));
  }

  return {
    summary,
    sport,
    sub_sport: subSport,
    external_provider: params.externalProvider,
    external_id: params.externalId,
    distance_m: distanceM,
    elevation_gain_m: elevationGainM,
    elevation_loss_m: elevationLossM,
    avg_pace_s_per_km: avgPaceSPerKm,
    gap_s_per_km: gapSPerKm,
    pa_hr_decoupling: paHrDecoupling,
    threshold_pace_snapshot: params.thresholdPaceSPerKm ?? null,
    laps,
  };
}
