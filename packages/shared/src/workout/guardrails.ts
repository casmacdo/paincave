import { z } from "zod";
import { flattenWorkout, predictWorkoutLoad, type WorkoutLoadPrediction } from "./flatten.js";
import {
  DEFAULT_THRESHOLD_PACE_S_PER_KM,
  RunWorkoutSpecSchema,
  predictRunWorkoutLoad,
  type RunWorkoutLoadPrediction,
  type RunWorkoutSpec,
} from "./run-schema.js";
import { WorkoutSpecSchema, type AtomicStep, type WorkoutSpec } from "./schema.js";
import {
  StrengthWorkoutSpecSchema,
  predictStrengthWorkoutLoad,
  type StrengthWorkoutLoadPrediction,
  type StrengthWorkoutSpec,
} from "./strength-schema.js";

export const AnyWorkoutSpecSchema = z.union([
  RunWorkoutSpecSchema,
  StrengthWorkoutSpecSchema,
  WorkoutSpecSchema,
]);

export type AnyWorkoutSpec = RunWorkoutSpec | StrengthWorkoutSpec | WorkoutSpec;
export type WorkoutSport = "cycling" | "running" | "strength";

export function getWorkoutSpecSport(spec: AnyWorkoutSpec): WorkoutSport {
  if (spec.sport === "running") return "running";
  if (spec.sport === "strength") return "strength";
  return "cycling";
}

export interface GuardrailResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  predicted: WorkoutLoadPrediction;
}

export interface RunGuardrailContext {
  thresholdPaceSPerKm?: number | null;
  recentWeeklyKm?: number | null;
  plannedWeekKmBeforeThis?: number | null;
  adjacentQualityRun?: boolean;
}

export interface RunGuardrailResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  predicted: RunWorkoutLoadPrediction;
}

export interface StrengthGuardrailContext {
  adjacentKeyEnduranceSession?: string | null;
}

export interface StrengthGuardrailResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  predicted: StrengthWorkoutLoadPrediction;
}

export interface MultiSportGuardrailResult {
  valid: boolean;
  sport: WorkoutSport;
  errors: string[];
  warnings: string[];
  predicted: {
    duration_s: number;
    distance_m?: number;
    np_watts: number | null;
    intensity_factor: number;
    tss: number;
    zone_seconds: WorkoutLoadPrediction["zone_seconds"];
    avg_pace_s_per_km?: number;
    is_quality_session?: boolean;
    total_sets?: number;
    is_heavy_lower_body?: boolean;
  };
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

const MAX_RUN_DISTANCE_M = 60_000;

export function validateRunWorkoutGuardrails(
  spec: RunWorkoutSpec,
  ctx: RunGuardrailContext = {}
): RunGuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const thresholdPace =
    ctx.thresholdPaceSPerKm && ctx.thresholdPaceSPerKm >= 150 && ctx.thresholdPaceSPerKm <= 720
      ? ctx.thresholdPaceSPerKm
      : DEFAULT_THRESHOLD_PACE_S_PER_KM;

  const predicted = predictRunWorkoutLoad(spec, thresholdPace);

  if (predicted.duration_s < MIN_TOTAL_DURATION_S) {
    errors.push(
      `Total running workout duration ${predicted.duration_s}s is below minimum 300s (5 minutes)`
    );
  }
  if (predicted.duration_s > MAX_TOTAL_DURATION_S) {
    errors.push(
      `Total running workout duration ${predicted.duration_s}s exceeds maximum 21600s (6 hours)`
    );
  }
  if (predicted.distance_m > MAX_RUN_DISTANCE_M) {
    errors.push(
      `Estimated running distance ${(predicted.distance_m / 1000).toFixed(1)} km exceeds single-session cap (60 km)`
    );
  }

  if (predicted.tss > 130) {
    warnings.push(`High predicted single-session running load (rTSS ${predicted.tss})`);
  }
  if (predicted.duration_s > 9000) {
    warnings.push(`Long running session (${Math.round(predicted.duration_s / 60)} minutes)`);
  }

  const sessionKm = predicted.distance_m / 1000;
  if (
    ctx.recentWeeklyKm !== undefined &&
    ctx.recentWeeklyKm !== null &&
    ctx.recentWeeklyKm > 5
  ) {
    const projectedWeekKm = (ctx.plannedWeekKmBeforeThis ?? 0) + sessionKm;
    const pctJump = ((projectedWeekKm - ctx.recentWeeklyKm) / ctx.recentWeeklyKm) * 100;
    if (pctJump > 15) {
      warnings.push(
        `Weekly running volume would jump +${pctJump.toFixed(0)}% (${projectedWeekKm.toFixed(1)} km vs ${ctx.recentWeeklyKm.toFixed(1)} km 4-week avg, >15% guideline)`
      );
    }
  }

  if (predicted.is_quality_session && ctx.adjacentQualityRun) {
    warnings.push(
      "Back-to-back quality running sessions scheduled within 24 hours; consider separating hard run days."
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    predicted,
  };
}

const MIN_STRENGTH_DURATION_S = 600; // 10 minutes
const MAX_STRENGTH_DURATION_S = 10800; // 3 hours
const MAX_STRENGTH_TOTAL_SETS = 60;

export function validateStrengthWorkoutGuardrails(
  spec: StrengthWorkoutSpec,
  ctx: StrengthGuardrailContext = {}
): StrengthGuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const predicted = predictStrengthWorkoutLoad(spec);

  if (predicted.duration_s < MIN_STRENGTH_DURATION_S) {
    errors.push(
      `Strength workout duration ${Math.round(predicted.duration_s / 60)}m is below minimum 10 minutes`
    );
  }
  if (predicted.duration_s > MAX_STRENGTH_DURATION_S) {
    errors.push(
      `Strength workout duration ${Math.round(predicted.duration_s / 60)}m exceeds maximum 180 minutes`
    );
  }
  if (predicted.total_sets > MAX_STRENGTH_TOTAL_SETS) {
    errors.push(`Strength workout total sets (${predicted.total_sets}) exceeds maximum ${MAX_STRENGTH_TOTAL_SETS}`);
  }

  if (predicted.total_sets > 30) {
    warnings.push(`High strength volume (${predicted.total_sets} total sets)`);
  }

  if (predicted.is_heavy_lower_body && ctx.adjacentKeyEnduranceSession) {
    warnings.push(
      `Heavy lower-body strength within 24 hours of key endurance session (${ctx.adjacentKeyEnduranceSession}); consider spacing by >=24h.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    predicted,
  };
}

export function validateAnyWorkoutGuardrails(
  spec: AnyWorkoutSpec,
  ctx: {
    ftpWatts: number;
    thresholdPaceSPerKm?: number | null;
    recentWeeklyKm?: number | null;
    plannedWeekKmBeforeThis?: number | null;
    adjacentQualityRun?: boolean;
    adjacentKeyEnduranceSession?: string | null;
  }
): MultiSportGuardrailResult {
  const sport = getWorkoutSpecSport(spec);
  if (sport === "running") {
    const res = validateRunWorkoutGuardrails(spec as RunWorkoutSpec, {
      thresholdPaceSPerKm: ctx.thresholdPaceSPerKm,
      recentWeeklyKm: ctx.recentWeeklyKm,
      plannedWeekKmBeforeThis: ctx.plannedWeekKmBeforeThis,
      adjacentQualityRun: ctx.adjacentQualityRun,
    });
    return {
      valid: res.valid,
      sport: "running",
      errors: res.errors,
      warnings: res.warnings,
      predicted: res.predicted,
    };
  }
  if (sport === "strength") {
    const res = validateStrengthWorkoutGuardrails(spec as StrengthWorkoutSpec, {
      adjacentKeyEnduranceSession: ctx.adjacentKeyEnduranceSession,
    });
    return {
      valid: res.valid,
      sport: "strength",
      errors: res.errors,
      warnings: res.warnings,
      predicted: res.predicted,
    };
  }
  const res = validateWorkoutGuardrails(spec as WorkoutSpec, ctx.ftpWatts);
  return {
    valid: res.valid,
    sport: "cycling",
    errors: res.errors,
    warnings: res.warnings,
    predicted: res.predicted,
  };
}
