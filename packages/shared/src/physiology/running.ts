import type { ParsedFitLap } from "../fit/reader.js";
import { computeHrZones, type HrZoneSeconds, type TelemetrySample } from "./metrics.js";

export interface RunningThresholds {
  threshold_pace_s_per_km?: number | null;
  lthr_bpm?: number | null;
  hrmax_bpm?: number | null;
  hrrest_bpm?: number | null;
}

export interface RunningLapSummary {
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
}

export interface RunningBestEffort {
  distance_m: 400 | 1000 | 5000 | 10000;
  duration_s: number;
  pace_s_per_km: number;
}

export interface RunningMetricsResult {
  duration_s: number;
  elapsed_s: number;
  distance_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  avg_pace_s_per_km: number | null;
  gap_s_per_km: number | null;
  pa_hr_decoupling: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence_spm: number | null;
  tss: number;
  tss_method: "rtss" | "hrtss" | "duration";
  hr_zones: HrZoneSeconds;
  best_efforts: RunningBestEffort[];
  laps: RunningLapSummary[];
}

const EARTH_RADIUS_M = 6_371_000;
const BEST_EFFORT_DISTANCES: readonly (400 | 1000 | 5000 | 10000)[] = [400, 1000, 5000, 10000];

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

/**
 * Minetti-calibrated running energy cost multiplier as a function of grade %.
 * - Flat (0%): 1.00
 * - Uphill (+6%): ~1.25 (equivalent flat speed is 25% faster than raw uphill speed)
 * - Gentle downhill (-6%): ~0.88 (energy savings)
 * - Steep downhill (-18%): ~1.02 (eccentric braking cost rises back up)
 */
export function computeRunningGradeFactor(gradePct: number): number {
  const g = Math.max(-25, Math.min(25, gradePct)) / 100; // fraction e.g. 0.06
  // Minetti et al. (2002) polynomial for energy cost of running C(i) normalized by C(0)=3.6 J/(kg*m)
  const cost =
    155.4 * g ** 5 -
    30.4 * g ** 4 -
    43.3 * g ** 3 +
    46.3 * g ** 2 +
    19.5 * g +
    3.6;
  const ratio = cost / 3.6;
  return Math.max(0.75, Math.min(2.6, ratio));
}

function normalizeRunningCadenceSpm(rawCadence: number | null): number | null {
  if (rawCadence === null || rawCadence <= 0) return null;
  // Garmin FIT stores running cadence as single-foot strides/min (~80-95); convert to total steps/min (~160-190)
  return rawCadence < 120 ? Math.round(rawCadence * 2) : Math.round(rawCadence);
}

interface CumulativePoint {
  t_s: number;
  dist_m: number;
  elev_m: number | null;
  hr_bpm: number | null;
  cadence_spm: number | null;
  gap_speed_mps: number | null;
}

function buildCumulativePoints(samples: readonly TelemetrySample[]): CumulativePoint[] {
  if (samples.length === 0) return [];
  const points: CumulativePoint[] = [];
  let cumDist = 0;

  // Light 3-point elevation smoothing to eliminate GPS barometer/altitude jitter
  const smoothedElev: (number | null)[] = samples.map((s, i) => {
    const cur = s.elevation_m;
    if (cur === null || cur === undefined) return null;
    const prev = samples[i - 1]?.elevation_m;
    const next = samples[i + 1]?.elevation_m;
    if (prev !== null && prev !== undefined && next !== null && next !== undefined) {
      return 0.25 * prev + 0.5 * cur + 0.25 * next;
    }
    return cur;
  });

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const prev = i > 0 ? samples[i - 1]! : null;
    let deltaDist = 0;
    const dt = prev ? Math.max(1, s.t_s - prev.t_s) : 1;

    if (s.distance_m !== null && s.distance_m !== undefined && s.distance_m >= cumDist) {
      deltaDist = s.distance_m - cumDist;
      cumDist = s.distance_m;
    } else if (
      prev &&
      s.lat_deg !== null &&
      s.lat_deg !== undefined &&
      s.lon_deg !== null &&
      s.lon_deg !== undefined &&
      prev.lat_deg !== null &&
      prev.lat_deg !== undefined &&
      prev.lon_deg !== null &&
      prev.lon_deg !== undefined
    ) {
      deltaDist = haversineM(prev.lat_deg, prev.lon_deg, s.lat_deg, s.lon_deg);
      cumDist += deltaDist;
    } else if (s.speed_kph !== null && s.speed_kph !== undefined && s.speed_kph > 0) {
      deltaDist = (s.speed_kph / 3.6) * dt;
      cumDist += deltaDist;
    }

    const rawSpeedMps =
      s.speed_kph !== null && s.speed_kph !== undefined && s.speed_kph > 0
        ? s.speed_kph / 3.6
        : dt > 0 && deltaDist > 0
          ? deltaDist / dt
          : null;

    let gradePct = 0;
    if (i > 0 && deltaDist >= 1.5) {
      const eCur = smoothedElev[i];
      const ePrev = smoothedElev[i - 1];
      if (eCur !== null && eCur !== undefined && ePrev !== null && ePrev !== undefined) {
        gradePct = ((eCur - ePrev) / deltaDist) * 100;
      }
    }

    const gapSpeedMps =
      rawSpeedMps !== null && rawSpeedMps > 0.3
        ? rawSpeedMps * computeRunningGradeFactor(gradePct)
        : null;

    points.push({
      t_s: s.t_s,
      dist_m: cumDist,
      elev_m: smoothedElev[i] ?? null,
      hr_bpm: s.hr_bpm ?? null,
      cadence_spm: normalizeRunningCadenceSpm(s.cadence_rpm),
      gap_speed_mps: gapSpeedMps,
    });
  }

  return points;
}

function computeBestEfforts(points: readonly CumulativePoint[]): RunningBestEffort[] {
  if (points.length < 2) return [];
  const totalDist = points[points.length - 1]!.dist_m;
  const results: RunningBestEffort[] = [];

  for (const targetDist of BEST_EFFORT_DISTANCES) {
    if (totalDist < targetDist) continue;
    let bestTime = Number.POSITIVE_INFINITY;
    let left = 0;

    for (let right = 1; right < points.length; right++) {
      const pRight = points[right]!;
      while (left + 1 < right && pRight.dist_m - points[left + 1]!.dist_m >= targetDist) {
        left++;
      }
      const spanDist = pRight.dist_m - points[left]!.dist_m;
      if (spanDist >= targetDist) {
        const spanTime = pRight.t_s - points[left]!.t_s;
        if (spanTime > 0) {
          // Pro-rate exact distance crossing cleanly
          const scaledTime = spanTime * (targetDist / spanDist);
          if (scaledTime < bestTime) {
            bestTime = scaledTime;
          }
        }
      }
    }

    if (Number.isFinite(bestTime) && bestTime > 0) {
      results.push({
        distance_m: targetDist,
        duration_s: Math.round(bestTime),
        pace_s_per_km: Number(((bestTime / targetDist) * 1000).toFixed(1)),
      });
    }
  }

  return results;
}

function computePaHrDecoupling(points: readonly CumulativePoint[]): number | null {
  if (points.length < 1200) return null;
  const totalDuration = points[points.length - 1]!.t_s - points[0]!.t_s;
  if (totalDuration < 1200) return null;

  const midT = points[0]!.t_s + totalDuration / 2;
  let sumSpeed1 = 0;
  let sumHr1 = 0;
  let cnt1 = 0;
  let sumSpeed2 = 0;
  let sumHr2 = 0;
  let cnt2 = 0;

  for (const p of points) {
    if (p.gap_speed_mps === null || p.gap_speed_mps <= 0.5 || !p.hr_bpm || p.hr_bpm <= 40) {
      continue;
    }
    if (p.t_s <= midT) {
      sumSpeed1 += p.gap_speed_mps;
      sumHr1 += p.hr_bpm;
      cnt1++;
    } else {
      sumSpeed2 += p.gap_speed_mps;
      sumHr2 += p.hr_bpm;
      cnt2++;
    }
  }

  if (cnt1 < 300 || cnt2 < 300) return null;
  const ef1 = (sumSpeed1 / cnt1) / (sumHr1 / cnt1);
  const ef2 = (sumSpeed2 / cnt2) / (sumHr2 / cnt2);
  if (ef1 <= 0) return null;
  return Number((((ef1 - ef2) / ef1) * 100).toFixed(1));
}

function buildAuto1KmSplits(points: readonly CumulativePoint[]): RunningLapSummary[] {
  if (points.length < 2) return [];
  const totalDist = points[points.length - 1]!.dist_m;
  if (totalDist < 400) return [];

  const splits: RunningLapSummary[] = [];
  let startIdx = 0;
  let nextKm = 1000;

  const finalizeSplit = (fromIdx: number, toIdx: number, lapIndex: number) => {
    const first = points[fromIdx]!;
    const last = points[toIdx]!;
    const dist = Math.max(0, last.dist_m - first.dist_m);
    const dur = Math.max(1, last.t_s - first.t_s);
    if (dist < 100) return;

    let hrSum = 0;
    let hrCnt = 0;
    let maxHr = 0;
    let cadSum = 0;
    let cadCnt = 0;
    let gapSpeedSum = 0;
    let gapCnt = 0;
    let gain = 0;
    let loss = 0;
    let refElev: number | null = null;

    for (let i = fromIdx; i <= toIdx; i++) {
      const p = points[i]!;
      if (p.hr_bpm && p.hr_bpm > 0) {
        hrSum += p.hr_bpm;
        hrCnt++;
        if (p.hr_bpm > maxHr) maxHr = p.hr_bpm;
      }
      if (p.cadence_spm && p.cadence_spm > 0) {
        cadSum += p.cadence_spm;
        cadCnt++;
      }
      if (p.gap_speed_mps && p.gap_speed_mps > 0.3) {
        gapSpeedSum += p.gap_speed_mps;
        gapCnt++;
      }
      if (p.elev_m !== null) {
        if (refElev === null) {
          refElev = p.elev_m;
        } else {
          const de = p.elev_m - refElev;
          if (de >= 1.0) {
            gain += de;
            refElev = p.elev_m;
          } else if (de <= -1.0) {
            loss += -de;
            refElev = p.elev_m;
          }
        }
      }
    }

    const avgPace = Number(((dur / dist) * 1000).toFixed(1));
    const avgGapSpeed = gapCnt > 0 ? gapSpeedSum / gapCnt : null;
    const gapPace = avgGapSpeed && avgGapSpeed > 0.3 ? Number((1000 / avgGapSpeed).toFixed(1)) : avgPace;

    splits.push({
      lap_index: lapIndex,
      duration_s: Math.round(dur),
      distance_m: Number(dist.toFixed(1)),
      avg_pace_s_per_km: avgPace,
      gap_s_per_km: gapPace,
      avg_power: null,
      avg_hr: hrCnt > 0 ? Math.round(hrSum / hrCnt) : null,
      max_hr: maxHr > 0 ? maxHr : null,
      avg_cadence: cadCnt > 0 ? Math.round(cadSum / cadCnt) : null,
      elevation_gain_m: Number(gain.toFixed(1)),
      elevation_loss_m: Number(loss.toFixed(1)),
    });
  };

  for (let i = 1; i < points.length; i++) {
    if (points[i]!.dist_m >= nextKm) {
      finalizeSplit(startIdx, i, splits.length);
      startIdx = i;
      nextKm += 1000;
    }
  }
  if (startIdx < points.length - 1) {
    finalizeSplit(startIdx, points.length - 1, splits.length);
  }
  return splits;
}

export function computeRunningMetrics(
  samples: readonly TelemetrySample[],
  thresholds: RunningThresholds = {},
  opts: {
    sessionDistanceM?: number | null;
    sessionDurationS?: number | null;
    sessionElapsedS?: number | null;
    sessionAscentM?: number | null;
    sessionDescentM?: number | null;
    fitLaps?: readonly ParsedFitLap[];
  } = {}
): RunningMetricsResult {
  const points = buildCumulativePoints(samples);
  const sampleDuration =
    points.length >= 2 ? Math.max(1, points[points.length - 1]!.t_s - points[0]!.t_s + 1) : points.length;
  const durationS = opts.sessionDurationS && opts.sessionDurationS > 0 ? opts.sessionDurationS : sampleDuration;
  const elapsedS = opts.sessionElapsedS && opts.sessionElapsedS > 0 ? opts.sessionElapsedS : durationS;

  const cumDist = points.length > 0 ? points[points.length - 1]!.dist_m : 0;
  const distanceM =
    opts.sessionDistanceM && opts.sessionDistanceM > 0 ? opts.sessionDistanceM : Number(cumDist.toFixed(1));

  let elevGain = 0;
  let elevLoss = 0;
  let refElev: number | null = null;
  let hrSum = 0;
  let hrCnt = 0;
  let maxHr = 0;
  let cadSum = 0;
  let cadCnt = 0;
  let gapSpeedSum = 0;
  let gapSpeedCnt = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.hr_bpm && p.hr_bpm > 0) {
      hrSum += p.hr_bpm;
      hrCnt++;
      if (p.hr_bpm > maxHr) maxHr = p.hr_bpm;
    }
    if (p.cadence_spm && p.cadence_spm > 0) {
      cadSum += p.cadence_spm;
      cadCnt++;
    }
    if (p.gap_speed_mps && p.gap_speed_mps > 0.3) {
      gapSpeedSum += p.gap_speed_mps;
      gapSpeedCnt++;
    }
    if (p.elev_m !== null) {
      if (refElev === null) {
        refElev = p.elev_m;
      } else {
        const de = p.elev_m - refElev;
        if (de >= 1.0) {
          elevGain += de;
          refElev = p.elev_m;
        } else if (de <= -1.0) {
          elevLoss += -de;
          refElev = p.elev_m;
        }
      }
    }
  }

  const elevationGainM =
    opts.sessionAscentM !== null && opts.sessionAscentM !== undefined
      ? opts.sessionAscentM
      : Number(elevGain.toFixed(1));
  const elevationLossM =
    opts.sessionDescentM !== null && opts.sessionDescentM !== undefined
      ? opts.sessionDescentM
      : Number(elevLoss.toFixed(1));

  const avgPace =
    distanceM > 50 && durationS > 0 ? Number(((durationS / distanceM) * 1000).toFixed(1)) : null;

  const avgGapSpeedMps = gapSpeedCnt > 0 ? gapSpeedSum / gapSpeedCnt : null;
  const gapPace =
    avgGapSpeedMps && avgGapSpeedMps > 0.3
      ? Number((1000 / avgGapSpeedMps).toFixed(1))
      : avgPace;

  const avgHr = hrCnt > 0 ? Math.round(hrSum / hrCnt) : null;
  const hrZones = computeHrZones(
    samples.map((s) => s.hr_bpm),
    thresholds.lthr_bpm ?? (thresholds.hrmax_bpm ? Math.round(thresholds.hrmax_bpm * 0.88) : null)
  );

  // Compute rTSS (from GAP vs threshold pace) -> fallback hrTSS (from LTHR/HRmax) -> duration fallback
  let tss = 0;
  let tssMethod: "rtss" | "hrtss" | "duration" = "duration";
  const hours = durationS / 3600;

  if (gapPace && thresholds.threshold_pace_s_per_km && thresholds.threshold_pace_s_per_km > 0) {
    // Intensity Factor for running = threshold_pace / ngp_pace (faster pace = higher IF)
    const intensityFactor = Math.min(1.35, thresholds.threshold_pace_s_per_km / gapPace);
    tss = Number((hours * intensityFactor * intensityFactor * 100).toFixed(1));
    tssMethod = "rtss";
  } else if (avgHr && (thresholds.lthr_bpm || thresholds.hrmax_bpm)) {
    const lthr = thresholds.lthr_bpm ?? Math.round((thresholds.hrmax_bpm ?? 190) * 0.88);
    const hrRest = thresholds.hrrest_bpm ?? 52;
    const hrRatio = Math.max(0.4, Math.min(1.15, (avgHr - hrRest) / Math.max(40, lthr - hrRest)));
    tss = Number((hours * hrRatio * hrRatio * 95).toFixed(1));
    tssMethod = "hrtss";
  } else {
    tss = Number((hours * 55).toFixed(1));
    tssMethod = "duration";
  }

  const normalizedFitLaps: RunningLapSummary[] =
    opts.fitLaps && opts.fitLaps.length > 0
      ? opts.fitLaps.map((l) => {
          const gradePct =
            l.distance_m && l.distance_m > 20 && l.elevation_gain_m !== null
              ? (((l.elevation_gain_m ?? 0) - (l.elevation_loss_m ?? 0)) / l.distance_m) * 100
              : 0;
          const lapGap =
            l.avg_pace_s_per_km !== null
              ? Number((l.avg_pace_s_per_km / computeRunningGradeFactor(gradePct)).toFixed(1))
              : null;
          return {
            lap_index: l.lap_index,
            duration_s: l.duration_s,
            distance_m: l.distance_m,
            avg_pace_s_per_km: l.avg_pace_s_per_km,
            gap_s_per_km: lapGap,
            avg_power: l.avg_power,
            avg_hr: l.avg_hr,
            max_hr: l.max_hr,
            avg_cadence: normalizeRunningCadenceSpm(l.avg_cadence),
            elevation_gain_m: l.elevation_gain_m,
            elevation_loss_m: l.elevation_loss_m,
          };
        })
      : buildAuto1KmSplits(points);

  return {
    duration_s: durationS,
    elapsed_s: elapsedS,
    distance_m: distanceM,
    elevation_gain_m: elevationGainM,
    elevation_loss_m: elevationLossM,
    avg_pace_s_per_km: avgPace,
    gap_s_per_km: gapPace,
    pa_hr_decoupling: computePaHrDecoupling(points),
    avg_hr: avgHr,
    max_hr: maxHr > 0 ? maxHr : null,
    avg_cadence_spm: cadCnt > 0 ? Math.round(cadSum / cadCnt) : null,
    tss,
    tss_method: tssMethod,
    hr_zones: hrZones,
    best_efforts: computeBestEfforts(points),
    laps: normalizedFitLaps,
  };
}
