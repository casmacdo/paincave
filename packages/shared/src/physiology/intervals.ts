import type { FlattenedStep } from "../workout/schema.js";
import type { TelemetrySample } from "./metrics.js";

export interface IntervalExecution {
  step_index: number;
  label: string;
  mode: "erg" | "slope" | "resistance";
  is_work_interval: boolean;
  planned_duration_s: number;
  actual_duration_s: number;
  target_watts: number | null;
  actual_avg_watts: number | null;
  pct_of_target: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  hr_drift_bpm: number | null;
  avg_cadence: number | null;
  erg_bias_pct: number;
  status: "completed" | "partial" | "skipped";
}

function plannedTargetWatts(step: FlattenedStep): number | null {
  if (step.mode !== "erg" || step.watts_start === null || step.watts_end === null) {
    return null;
  }
  return Math.round((step.watts_start + step.watts_end) / 2);
}

/**
 * Computes per-interval execution and compliance by pairing 1Hz telemetry samples
 * (tagged with step_index) against the planned FlattenedStep list.
 */
export function computeIntervalExecutions(
  samples: readonly TelemetrySample[],
  plannedSteps: readonly FlattenedStep[]
): IntervalExecution[] {
  const byStep = new Map<number, TelemetrySample[]>();
  for (const sample of samples) {
    if (sample.step_index === null || sample.step_index === undefined) continue;
    const list = byStep.get(sample.step_index);
    if (list) {
      list.push(sample);
    } else {
      byStep.set(sample.step_index, [sample]);
    }
  }

  return plannedSteps.map((step) => {
    const stepSamples = byStep.get(step.step_index) ?? [];
    const actualDuration = stepSamples.length;
    const targetW = plannedTargetWatts(step);

    if (actualDuration === 0) {
      return {
        step_index: step.step_index,
        label: step.label,
        mode: step.mode,
        is_work_interval: step.is_work_interval,
        planned_duration_s: step.duration_s,
        actual_duration_s: 0,
        target_watts: targetW,
        actual_avg_watts: null,
        pct_of_target: null,
        avg_hr: null,
        max_hr: null,
        hr_drift_bpm: null,
        avg_cadence: null,
        erg_bias_pct: 100,
        status: "skipped",
      };
    }

    let powerSum = 0;
    let powerCount = 0;
    let hrSum = 0;
    let hrCount = 0;
    let maxHr = 0;
    let cadSum = 0;
    let cadCount = 0;
    let biasSum = 0;
    let biasCount = 0;

    const validHrs: number[] = [];
    for (const s of stepSamples) {
      if (s.watts !== null && s.watts !== undefined && s.watts >= 0) {
        powerSum += s.watts;
        powerCount++;
      }
      if (s.hr_bpm !== null && s.hr_bpm !== undefined && s.hr_bpm > 0) {
        hrSum += s.hr_bpm;
        hrCount++;
        if (s.hr_bpm > maxHr) maxHr = s.hr_bpm;
        validHrs.push(s.hr_bpm);
      }
      if (s.cadence_rpm !== null && s.cadence_rpm !== undefined && s.cadence_rpm >= 0) {
        cadSum += s.cadence_rpm;
        cadCount++;
      }
      if (s.erg_bias_pct !== null && s.erg_bias_pct !== undefined && s.erg_bias_pct > 0) {
        biasSum += s.erg_bias_pct;
        biasCount++;
      }
    }

    const actualAvgWatts = powerCount > 0 ? Math.round(powerSum / powerCount) : null;
    const pctOfTarget =
      actualAvgWatts !== null && targetW !== null && targetW > 0
        ? Number(((actualAvgWatts / targetW) * 100).toFixed(1))
        : null;

    let hrDriftBpm: number | null = null;
    if (actualDuration >= 60 && validHrs.length >= 30) {
      const third = Math.max(1, Math.floor(validHrs.length / 3));
      let firstSum = 0;
      let lastSum = 0;
      for (let i = 0; i < third; i++) {
        firstSum += validHrs[i] ?? 0;
        lastSum += validHrs[validHrs.length - third + i] ?? 0;
      }
      hrDriftBpm = Math.round(lastSum / third - firstSum / third);
    }

    const status: "completed" | "partial" | "skipped" =
      actualDuration >= Math.floor(step.duration_s * 0.9) ? "completed" : "partial";

    return {
      step_index: step.step_index,
      label: step.label,
      mode: step.mode,
      is_work_interval: step.is_work_interval,
      planned_duration_s: step.duration_s,
      actual_duration_s: actualDuration,
      target_watts: targetW,
      actual_avg_watts: actualAvgWatts,
      pct_of_target: pctOfTarget,
      avg_hr: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
      max_hr: hrCount > 0 ? maxHr : null,
      hr_drift_bpm: hrDriftBpm,
      avg_cadence: cadCount > 0 ? Math.round(cadSum / cadCount) : null,
      erg_bias_pct: biasCount > 0 ? Math.round(biasSum / biasCount) : 100,
      status,
    };
  });
}
