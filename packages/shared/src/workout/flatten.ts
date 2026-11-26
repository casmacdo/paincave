import type { AtomicStep, FlattenedStep, WorkoutSpec } from "./schema.js";
import { computeNormalizedPower, computePowerZones, type PowerZoneSeconds } from "../physiology/metrics.js";

export interface WorkoutLoadPrediction {
  duration_s: number;
  np_watts: number;
  intensity_factor: number;
  tss: number;
  zone_seconds: PowerZoneSeconds;
}

function roundWatts(watts: number): number {
  return Math.max(0, Math.round(watts));
}

function flattenAtomic(
  step: AtomicStep,
  ftpWatts: number,
  stepIndex: number,
  startOffset: number,
  prefixLabel?: string
): FlattenedStep {
  const baseLabel = step.label ?? defaultLabel(step);
  const label = prefixLabel ? `${prefixLabel} - ${baseLabel}` : baseLabel;

  switch (step.type) {
    case "steady": {
      const watts =
        step.target_watts !== undefined
          ? roundWatts(step.target_watts)
          : roundWatts((step.target_ftp ?? 0) * ftpWatts);
      return {
        step_index: stepIndex,
        label,
        start_offset_s: startOffset,
        duration_s: step.duration_s,
        mode: "erg",
        watts_start: watts,
        watts_end: watts,
        grade_pct: null,
        resistance_pct: null,
        cadence_rpm: step.cadence_rpm ?? null,
        text_cue: step.text_cue ?? null,
        is_work_interval: watts >= Math.round(0.76 * ftpWatts),
      };
    }
    case "ramp": {
      const startW =
        step.start_watts !== undefined
          ? roundWatts(step.start_watts)
          : roundWatts((step.start_ftp ?? 0) * ftpWatts);
      const endW =
        step.end_watts !== undefined
          ? roundWatts(step.end_watts)
          : roundWatts((step.end_ftp ?? 0) * ftpWatts);
      const avgW = (startW + endW) / 2;
      return {
        step_index: stepIndex,
        label,
        start_offset_s: startOffset,
        duration_s: step.duration_s,
        mode: "erg",
        watts_start: startW,
        watts_end: endW,
        grade_pct: null,
        resistance_pct: null,
        cadence_rpm: step.cadence_rpm ?? null,
        text_cue: step.text_cue ?? null,
        is_work_interval: avgW >= 0.76 * ftpWatts,
      };
    }
    case "slope": {
      return {
        step_index: stepIndex,
        label,
        start_offset_s: startOffset,
        duration_s: step.duration_s,
        mode: "slope",
        watts_start: null,
        watts_end: null,
        grade_pct: step.grade_pct,
        resistance_pct: null,
        cadence_rpm: step.cadence_rpm ?? null,
        text_cue: step.text_cue ?? null,
        is_work_interval: true,
      };
    }
    case "free_ride": {
      return {
        step_index: stepIndex,
        label,
        start_offset_s: startOffset,
        duration_s: step.duration_s,
        mode: "resistance",
        watts_start: null,
        watts_end: null,
        grade_pct: null,
        resistance_pct: step.resistance_pct ?? 20,
        cadence_rpm: step.cadence_rpm ?? null,
        text_cue: step.text_cue ?? null,
        is_work_interval: true,
      };
    }
  }
}

function defaultLabel(step: AtomicStep): string {
  switch (step.type) {
    case "steady":
      return "Steady";
    case "ramp":
      return "Ramp";
    case "slope":
      return "Slope";
    case "free_ride":
      return "Free Ride";
  }
}

export function flattenWorkout(spec: WorkoutSpec, ftpWatts: number): FlattenedStep[] {
  if (!Number.isFinite(ftpWatts) || ftpWatts <= 0) {
    throw new Error("ftpWatts must be a positive number");
  }

  const flattened: FlattenedStep[] = [];
  let offset = 0;

  for (const step of spec.steps) {
    if (step.type === "repeat") {
      for (let rep = 1; rep <= step.count; rep++) {
        const repPrefix = step.label ? `${step.label} ${rep}/${step.count}` : `Rep ${rep}/${step.count}`;
        for (const inner of step.steps) {
          const flat = flattenAtomic(inner, ftpWatts, flattened.length, offset, repPrefix);
          flattened.push(flat);
          offset += flat.duration_s;
        }
      }
    } else {
      const flat = flattenAtomic(step, ftpWatts, flattened.length, offset);
      flattened.push(flat);
      offset += flat.duration_s;
    }
  }

  return flattened;
}

export function expandPlannedPowerSeries(flattened: FlattenedStep[], ftpWatts: number): number[] {
  const totalSeconds = flattened.reduce((acc, s) => acc + s.duration_s, 0);
  const series = new Array<number>(totalSeconds);
  let cursor = 0;

  for (const step of flattened) {
    if (step.mode === "erg" && step.watts_start !== null && step.watts_end !== null) {
      const denom = Math.max(1, step.duration_s - 1);
      for (let t = 0; t < step.duration_s; t++) {
        const frac = step.duration_s === 1 ? 0 : t / denom;
        series[cursor++] = Math.round(step.watts_start + (step.watts_end - step.watts_start) * frac);
      }
    } else {
      // Conservative endurance/tempo power estimate for slope/free_ride prediction
      const est = Math.round(ftpWatts * 0.75);
      for (let t = 0; t < step.duration_s; t++) {
        series[cursor++] = est;
      }
    }
  }

  return series;
}

export function predictWorkoutLoad(spec: WorkoutSpec, ftpWatts: number): WorkoutLoadPrediction {
  const flattened = flattenWorkout(spec, ftpWatts);
  const series = expandPlannedPowerSeries(flattened, ftpWatts);
  const duration_s = series.length;
  const npRaw = computeNormalizedPower(series);
  const np_watts = Math.round(npRaw);
  const intensity_factor = Number((npRaw / ftpWatts).toFixed(3));
  const tss = Number((((duration_s * npRaw * (npRaw / ftpWatts)) / (ftpWatts * 3600)) * 100).toFixed(1));
  const zone_seconds = computePowerZones(series, ftpWatts);

  return {
    duration_s,
    np_watts,
    intensity_factor,
    tss,
    zone_seconds,
  };
}
