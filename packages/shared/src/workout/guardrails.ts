import { flattenWorkout, predictWorkoutLoad, type WorkoutLoadPrediction } from "./flatten.js";
import type { AtomicStep, WorkoutSpec } from "./schema.js";

export interface GuardrailResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  predicted: WorkoutLoadPrediction;
}

const MIN_TOTAL_DURATION_S = 300; // 5 minutes
const MAX_TOTAL_DURATION_S = 21600; // 6 hours
const MIN_FTP_FRACTION = 0.25;
const MAX_FTP_FRACTION = 2.5;
const MAX_SUSTAINED_2MIN_FTP = 1.5;
const MAX_SUSTAINED_20MIN_FTP = 1.1;

function checkAtomicStep(step: AtomicStep, ftpWatts: number, path: string, errors: string[]): void {
  if (step.type === "steady") {
    const frac = step.target_ftp !== undefined ? step.target_ftp : (step.target_watts ?? 0) / ftpWatts;
    if (frac < MIN_FTP_FRACTION || frac > MAX_FTP_FRACTION) {
      errors.push(
        `${path}: target intensity ${(frac * 100).toFixed(0)}% FTP is outside safe bounds [25%, 250%]`
      );
    }
    if (step.duration_s > 120 && frac > MAX_SUSTAINED_2MIN_FTP) {
      errors.push(
        `${path}: sustained block >120s (${step.duration_s}s) exceeds 150% FTP (${(frac * 100).toFixed(0)}%)`
      );
    }
    if (step.duration_s > 1200 && frac > MAX_SUSTAINED_20MIN_FTP) {
      errors.push(
        `${path}: sustained block >20m (${step.duration_s}s) exceeds 110% FTP (${(frac * 100).toFixed(0)}%)`
      );
    }
  } else if (step.type === "ramp") {
    const startFrac =
      step.start_ftp !== undefined ? step.start_ftp : (step.start_watts ?? 0) / ftpWatts;
    const endFrac = step.end_ftp !== undefined ? step.end_ftp : (step.end_watts ?? 0) / ftpWatts;
    const minFrac = Math.min(startFrac, endFrac);
    const maxFrac = Math.max(startFrac, endFrac);
    const avgFrac = (startFrac + endFrac) / 2;

    if (minFrac < MIN_FTP_FRACTION || maxFrac > MAX_FTP_FRACTION) {
      errors.push(
        `${path}: ramp intensity range [${(minFrac * 100).toFixed(0)}%, ${(maxFrac * 100).toFixed(0)}%] FTP is outside safe bounds [25%, 250%]`
      );
    }
    if (step.duration_s > 120 && avgFrac > MAX_SUSTAINED_2MIN_FTP) {
      errors.push(
        `${path}: ramp >120s average intensity (${(avgFrac * 100).toFixed(0)}% FTP) exceeds 150% FTP`
      );
    }
    if (step.duration_s > 1200 && avgFrac > MAX_SUSTAINED_20MIN_FTP) {
      errors.push(
        `${path}: ramp >20m average intensity (${(avgFrac * 100).toFixed(0)}% FTP) exceeds 110% FTP`
      );
    }
  } else if (step.type === "slope") {
    if (step.grade_pct < -10 || step.grade_pct > 20) {
      errors.push(`${path}: slope grade ${step.grade_pct}% is outside [-10%, 20%]`);
    }
  }
}

export function validateWorkoutGuardrails(spec: WorkoutSpec, ftpWatts: number): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isFinite(ftpWatts) || ftpWatts < 50 || ftpWatts > 600) {
    errors.push(`Invalid athlete FTP (${ftpWatts}W); expected 50-600W`);
  }

  spec.steps.forEach((step, idx) => {
    if (step.type === "repeat") {
      step.steps.forEach((inner, innerIdx) => {
        checkAtomicStep(inner, ftpWatts, `steps[${idx}].steps[${innerIdx}]`, errors);
      });
    } else {
      checkAtomicStep(step, ftpWatts, `steps[${idx}]`, errors);
    }
  });

  const flattened = flattenWorkout(spec, Math.max(50, ftpWatts));
  const totalDuration = flattened.reduce((acc, s) => acc + s.duration_s, 0);

  if (totalDuration < MIN_TOTAL_DURATION_S) {
    errors.push(`Total workout duration ${totalDuration}s is below minimum 300s (5 minutes)`);
  }
  if (totalDuration > MAX_TOTAL_DURATION_S) {
    errors.push(`Total workout duration ${totalDuration}s exceeds maximum 21600s (6 hours)`);
  }

  const predicted = predictWorkoutLoad(spec, Math.max(50, ftpWatts));

  if (predicted.tss > 120) {
    warnings.push(`High predicted single-session TSS (${predicted.tss})`);
  }
  if (predicted.intensity_factor > 1.02) {
    warnings.push(`High predicted Intensity Factor (IF ${predicted.intensity_factor})`);
  }
  if (predicted.duration_s > 10800) {
    warnings.push(`Long indoor session (${Math.round(predicted.duration_s / 60)} minutes)`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    predicted,
  };
}
