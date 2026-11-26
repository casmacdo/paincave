import type { FlattenedStep } from "../workout/schema.js";
import { computeIntervalExecutions, type IntervalExecution } from "./intervals.js";
import { computeMmpCurve, type MmpPoint } from "./mmp.js";

export interface TelemetrySample {
  t_s: number;
  watts: number | null;
  hr_bpm: number | null;
  cadence_rpm: number | null;
  speed_kph?: number | null;
  target_watts?: number | null;
  step_index?: number | null;
  erg_bias_pct?: number | null;
  synthetic_route?: boolean;
  lat_deg?: number | null;
  lon_deg?: number | null;
  elevation_m?: number | null;
  distance_m?: number | null;
  grade_pct?: number | null;
}

export interface AthleteThresholdsSnapshot {
  ftp_watts: number;
  lthr_bpm?: number | null;
  hrmax_bpm?: number | null;
  weight_kg?: number | null;
}

export interface PowerZoneSeconds {
  z1: number;
  z2: number;
  z3: number;
  z4: number;
  z5: number;
  z6: number;
  z7: number;
}

export interface HrZoneSeconds {
  z1: number;
  z2: number;
  z3: number;
  z4: number;
  z5: number;
}

export interface QualityFlags {
  power_dropouts_s: number;
  hr_dropouts_s: number;
  erg_smoothing_detected: boolean;
}

export interface RideMetricsResult {
  duration_s: number;
  elapsed_s: number;
  work_kj: number;
  avg_power: number | null;
  np_watts: number | null;
  intensity_factor: number | null;
  tss: number;
  variability_index: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  efficiency_factor: number | null;
  pw_hr_decoupling: number | null;
  hrr_60s: number | null;
  time_gt_90_hrmax_s: number;
  avg_cadence: number | null;
  compliance_pct: number | null;
  power_zones: PowerZoneSeconds;
  hr_zones: HrZoneSeconds;
  quality_flags: QualityFlags;
  intervals: IntervalExecution[];
  peaks: MmpPoint[];
}

export function computeNormalizedPower(powerSeries: readonly number[]): number {
  const n = powerSeries.length;
  if (n === 0) return 0;

  if (n < 30) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += Math.max(0, powerSeries[i] ?? 0);
    }
    return sum / n;
  }

  let rollingSum = 0;
  for (let i = 0; i < 30; i++) {
    rollingSum += Math.max(0, powerSeries[i] ?? 0);
  }

  let sumFourth = 0;
  let count = 0;
  const firstAvg = rollingSum / 30;
  sumFourth += firstAvg ** 4;
  count++;

  for (let i = 30; i < n; i++) {
    rollingSum += Math.max(0, powerSeries[i] ?? 0) - Math.max(0, powerSeries[i - 30] ?? 0);
    const avg = rollingSum / 30;
    sumFourth += avg ** 4;
    count++;
  }

  return (sumFourth / count) ** 0.25;
}

export function computePowerZones(
  powerSeries: readonly number[],
  ftpWatts: number
): PowerZoneSeconds {
  const zones: PowerZoneSeconds = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, z6: 0, z7: 0 };
  if (ftpWatts <= 0) return zones;

  for (let i = 0; i < powerSeries.length; i++) {
    const pct = (Math.max(0, powerSeries[i] ?? 0) / ftpWatts) * 100;
    if (pct < 55) zones.z1++;
    else if (pct <= 75) zones.z2++;
    else if (pct <= 90) zones.z3++;
    else if (pct <= 105) zones.z4++;
    else if (pct <= 120) zones.z5++;
    else if (pct <= 150) zones.z6++;
    else zones.z7++;
  }

  return zones;
}

export function computeHrZones(
  hrSeries: readonly (number | null | undefined)[],
  lthrBpm?: number | null
): HrZoneSeconds {
  const zones: HrZoneSeconds = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  if (!lthrBpm || lthrBpm <= 0) return zones;

  for (let i = 0; i < hrSeries.length; i++) {
    const hr = hrSeries[i];
    if (hr === null || hr === undefined || hr <= 0) continue;
    const pct = (hr / lthrBpm) * 100;
    if (pct < 81) zones.z1++;
    else if (pct < 90) zones.z2++;
    else if (pct < 94) zones.z3++;
    else if (pct < 100) zones.z4++;
    else zones.z5++;
  }

  return zones;
}

function computePwHrDecoupling(samples: readonly TelemetrySample[]): number | null {
  const n = samples.length;
  if (n < 1200) return null;

  let validHr = 0;
  for (let i = 0; i < n; i++) {
    const hr = samples[i]?.hr_bpm;
    if (hr !== null && hr !== undefined && hr > 0) validHr++;
  }
  if (validHr / n < 0.85) return null;

  const warmupSkip = n >= 2400 ? 600 : 0;
  const remaining = n - warmupSkip;
  const half = Math.floor(remaining / 2);
  if (half < 30) return null;

  const h1Power: number[] = new Array<number>(half);
  const h2Power: number[] = new Array<number>(half);
  let h1HrSum = 0;
  let h1HrCnt = 0;
  let h2HrSum = 0;
  let h2HrCnt = 0;

  for (let i = 0; i < half; i++) {
    const s1 = samples[warmupSkip + i];
    const s2 = samples[warmupSkip + half + i];
    h1Power[i] = Math.max(0, s1?.watts ?? 0);
    h2Power[i] = Math.max(0, s2?.watts ?? 0);

    if (s1?.hr_bpm !== null && s1?.hr_bpm !== undefined && s1.hr_bpm > 0) {
      h1HrSum += s1.hr_bpm;
      h1HrCnt++;
    }
    if (s2?.hr_bpm !== null && s2?.hr_bpm !== undefined && s2.hr_bpm > 0) {
      h2HrSum += s2.hr_bpm;
      h2HrCnt++;
    }
  }

  if (h1HrCnt === 0 || h2HrCnt === 0) return null;
  const np1 = computeNormalizedPower(h1Power);
  const np2 = computeNormalizedPower(h2Power);
  const ef1 = np1 / (h1HrSum / h1HrCnt);
  const ef2 = np2 / (h2HrSum / h2HrCnt);

  if (ef1 <= 0) return null;
  return Number((((ef1 - ef2) / ef1) * 100).toFixed(2));
}

function computeHrr60s(
  samples: readonly TelemetrySample[],
  powerSeries: readonly number[],
  ftpWatts: number
): number | null {
  const n = samples.length;
  if (n < 75 || ftpWatts <= 0) return null;

  const recoveryThreshold = 0.65 * ftpWatts;
  const pPrefix = new Float64Array(n + 1);
  const hrPrefix = new Float64Array(n + 1);
  const hrValidPrefix = new Int32Array(n + 1);

  for (let i = 0; i < n; i++) {
    pPrefix[i + 1] = (pPrefix[i] ?? 0) + (powerSeries[i] ?? 0);
    const hr = samples[i]?.hr_bpm;
    const isValid = hr !== null && hr !== undefined && hr > 0;
    hrPrefix[i + 1] = (hrPrefix[i] ?? 0) + (isValid ? hr : 0);
    hrValidPrefix[i + 1] = (hrValidPrefix[i] ?? 0) + (isValid ? 1 : 0);
  }

  let bestPeakAvg = -1;
  let bestPeakIdx = -1;

  for (let t = 14; t <= n - 61; t++) {
    const recoveryHr = samples[t + 60]?.hr_bpm;
    if (recoveryHr === null || recoveryHr === undefined || recoveryHr <= 0) continue;

    const validCount15 = (hrValidPrefix[t + 1] ?? 0) - (hrValidPrefix[t - 14] ?? 0);
    if (validCount15 < 15) continue;

    const recPowerSum = (pPrefix[t + 61] ?? 0) - (pPrefix[t + 1] ?? 0);
    if (recPowerSum / 60 >= recoveryThreshold) continue;

    const avg15 = ((hrPrefix[t + 1] ?? 0) - (hrPrefix[t - 14] ?? 0)) / 15;
    if (avg15 > bestPeakAvg) {
      bestPeakAvg = avg15;
      bestPeakIdx = t;
    }
  }

  if (bestPeakIdx < 0) return null;
  const hrLater = samples[bestPeakIdx + 60]?.hr_bpm ?? 0;
  return Math.round(bestPeakAvg - hrLater);
}

function detectErgSmoothing(
  samples: readonly TelemetrySample[],
  plannedSteps?: readonly FlattenedStep[]
): boolean {
  const stepModeMap = new Map<number, FlattenedStep>();
  if (plannedSteps) {
    for (const step of plannedSteps) {
      stepModeMap.set(step.step_index, step);
    }
  }

  let runCount = 0;
  let runSum = 0;
  let runSumSq = 0;
  let prevTarget: number | null = null;
  let prevStepIdx: number | null | undefined = undefined;

  const isSmoothedRun = (): boolean => {
    if (runCount < 60) return false;
    const mean = runSum / runCount;
    const variance = Math.max(0, runSumSq / runCount - mean * mean);
    return Math.sqrt(variance) < 1.5;
  };

  for (const s of samples) {
    const step =
      s.step_index !== null && s.step_index !== undefined
        ? stepModeMap.get(s.step_index)
        : undefined;
    const isSteadyErg = step
      ? step.mode === "erg" && step.watts_start === step.watts_end
      : s.target_watts !== null && s.target_watts !== undefined;

    const validTarget =
      isSteadyErg &&
      s.target_watts !== null &&
      s.target_watts !== undefined &&
      s.target_watts >= 100 &&
      s.watts !== null &&
      s.watts !== undefined;

    if (validTarget && s.target_watts === prevTarget && s.step_index === prevStepIdx) {
      const diff = (s.watts ?? 0) - (s.target_watts ?? 0);
      runCount++;
      runSum += diff;
      runSumSq += diff * diff;
    } else {
      if (isSmoothedRun()) return true;
      if (validTarget) {
        const diff = (s.watts ?? 0) - (s.target_watts ?? 0);
        runCount = 1;
        runSum = diff;
        runSumSq = diff * diff;
        prevTarget = s.target_watts ?? null;
        prevStepIdx = s.step_index;
      } else {
        runCount = 0;
        runSum = 0;
        runSumSq = 0;
        prevTarget = null;
        prevStepIdx = undefined;
      }
    }
  }

  return isSmoothedRun();
}

function computeCompliancePct(intervals: readonly IntervalExecution[]): number | null {
  const workErg = intervals.filter(
    (iv) => iv.is_work_interval && iv.target_watts !== null && iv.target_watts > 0
  );
  const candidates =
    workErg.length > 0
      ? workErg
      : intervals.filter((iv) => iv.target_watts !== null && iv.target_watts > 0);
  if (candidates.length === 0) return null;

  let weightedScore = 0;
  let totalPlanned = 0;

  for (const iv of candidates) {
    if (iv.planned_duration_s <= 0) continue;
    totalPlanned += iv.planned_duration_s;
    if (iv.status === "skipped" || iv.pct_of_target === null) continue;
    const accuracy = Math.max(0, 1 - Math.abs(100 - iv.pct_of_target) / 100);
    const completion = Math.min(1, iv.actual_duration_s / iv.planned_duration_s);
    weightedScore += accuracy * completion * 100 * iv.planned_duration_s;
  }

  if (totalPlanned <= 0) return null;
  return Number((weightedScore / totalPlanned).toFixed(1));
}

export function computeRideMetrics(
  samples: readonly TelemetrySample[],
  thresholds: AthleteThresholdsSnapshot,
  plannedSteps?: readonly FlattenedStep[]
): RideMetricsResult {
  const n = samples.length;
  const ftp = thresholds.ftp_watts;
  const powerSeries = new Array<number>(n);

  let totalWatts = 0;
  let validPowerCount = 0;
  let powerDropouts = 0;
  let hrSum = 0;
  let hrCount = 0;
  let maxHr = 0;
  let hrDropouts = 0;
  let timeGt90Hrmax = 0;
  let cadSum = 0;
  let cadCount = 0;

  const hrZones: HrZoneSeconds = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  const lthr = thresholds.lthr_bpm ?? null;
  const hrmaxThreshold =
    thresholds.hrmax_bpm !== null && thresholds.hrmax_bpm !== undefined
      ? 0.9 * thresholds.hrmax_bpm
      : null;

  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (!s) continue;

    if (s.watts === null || s.watts === undefined || s.watts < 0) {
      powerDropouts++;
      powerSeries[i] = 0;
    } else {
      powerSeries[i] = s.watts;
      totalWatts += s.watts;
      validPowerCount++;
    }

    if (s.hr_bpm === null || s.hr_bpm === undefined || s.hr_bpm <= 0) {
      hrDropouts++;
    } else {
      hrSum += s.hr_bpm;
      hrCount++;
      if (s.hr_bpm > maxHr) maxHr = s.hr_bpm;
      if (hrmaxThreshold !== null && s.hr_bpm >= hrmaxThreshold) {
        timeGt90Hrmax++;
      }
      if (lthr !== null && lthr > 0) {
        const pct = (s.hr_bpm / lthr) * 100;
        if (pct < 81) hrZones.z1++;
        else if (pct < 90) hrZones.z2++;
        else if (pct < 94) hrZones.z3++;
        else if (pct < 100) hrZones.z4++;
        else hrZones.z5++;
      }
    }

    if (s.cadence_rpm !== null && s.cadence_rpm !== undefined && s.cadence_rpm >= 0) {
      cadSum += s.cadence_rpm;
      cadCount++;
    }
  }

  const firstTs = samples[0]?.t_s ?? 0;
  const lastTs = samples[n - 1]?.t_s ?? 0;
  const elapsedS = n > 0 ? Math.max(n, Math.round(lastTs - firstTs + 1)) : 0;

  const workKj = Number((totalWatts / 1000).toFixed(1));
  const avgPower = validPowerCount > 0 ? Math.round(totalWatts / n) : null;
  const npRaw = validPowerCount > 0 ? computeNormalizedPower(powerSeries) : null;
  const npWatts = npRaw !== null ? Math.round(npRaw) : null;
  const intensityFactor =
    npRaw !== null && ftp > 0 ? Number((npRaw / ftp).toFixed(3)) : null;
  const tss =
    npRaw !== null && ftp > 0
      ? Number((((n * npRaw * (npRaw / ftp)) / (ftp * 3600)) * 100).toFixed(1))
      : 0;
  const variabilityIndex =
    npRaw !== null && avgPower !== null && avgPower > 0
      ? Number((npRaw / avgPower).toFixed(2))
      : null;

  const avgHr = hrCount > 0 ? Math.round(hrSum / hrCount) : null;
  const hrCoverage = n > 0 ? hrCount / n : 0;
  const efficiencyFactor =
    npRaw !== null && avgHr !== null && avgHr > 0 && hrCoverage >= 0.8
      ? Number((npRaw / avgHr).toFixed(2))
      : null;

  const pwHrDecoupling = computePwHrDecoupling(samples);
  const hrr60s = computeHrr60s(samples, powerSeries, ftp);
  const powerZones = computePowerZones(powerSeries, ftp);
  const intervals = plannedSteps ? computeIntervalExecutions(samples, plannedSteps) : [];
  const compliancePct = computeCompliancePct(intervals);
  const peaks = computeMmpCurve(powerSeries, thresholds.weight_kg);

  return {
    duration_s: n,
    elapsed_s: elapsedS,
    work_kj: workKj,
    avg_power: avgPower,
    np_watts: npWatts,
    intensity_factor: intensityFactor,
    tss,
    variability_index: variabilityIndex,
    avg_hr: avgHr,
    max_hr: hrCount > 0 ? maxHr : null,
    efficiency_factor: efficiencyFactor,
    pw_hr_decoupling: pwHrDecoupling,
    hrr_60s: hrr60s,
    time_gt_90_hrmax_s: timeGt90Hrmax,
    avg_cadence: cadCount > 0 ? Math.round(cadSum / cadCount) : null,
    compliance_pct: compliancePct,
    power_zones: powerZones,
    hr_zones: hrZones,
    quality_flags: {
      power_dropouts_s: powerDropouts,
      hr_dropouts_s: hrDropouts,
      erg_smoothing_detected: detectErgSmoothing(samples, plannedSteps),
    },
    intervals,
    peaks,
  };
}
