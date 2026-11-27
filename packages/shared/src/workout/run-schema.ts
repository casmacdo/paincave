import { z } from "zod";
import type { PowerZoneSeconds } from "../physiology/metrics.js";

export const RUN_WORKOUT_CATEGORIES = [
  "recovery",
  "easy",
  "long_run",
  "tempo",
  "threshold",
  "intervals",
  "hills",
  "strides",
  "race",
  "custom",
] as const;

export type RunWorkoutCategory = (typeof RUN_WORKOUT_CATEGORIES)[number];

export const RUN_PACE_ZONES = [
  "recovery",
  "easy",
  "marathon",
  "threshold",
  "interval",
  "repetition",
] as const;

export type RunPaceZone = (typeof RUN_PACE_ZONES)[number];

export const RUN_HR_ZONES = ["Z1", "Z2", "Z3", "Z4", "Z5"] as const;
export type RunHrZone = (typeof RUN_HR_ZONES)[number];

const PACE_ZONE_MULTIPLIER: Record<RunPaceZone, number> = {
  recovery: 1.28,
  easy: 1.18,
  marathon: 1.07,
  threshold: 1.0,
  interval: 0.92,
  repetition: 0.86,
};

const HR_ZONE_IF: Record<RunHrZone, number> = {
  Z1: 0.65,
  Z2: 0.78,
  Z3: 0.88,
  Z4: 0.98,
  Z5: 1.08,
};

export const RunAtomicStepSchema = z
  .object({
    type: z.enum(["warmup", "steady", "interval", "recovery", "cooldown"]),
    duration_s: z.number().int().min(10).max(21600).optional(),
    distance_m: z.number().int().min(50).max(100000).optional(),
    pace_zone: z.enum(RUN_PACE_ZONES).optional(),
    pace_range_s_per_km: z
      .tuple([z.number().finite().min(120).max(900), z.number().finite().min(120).max(900)])
      .optional(),
    hr_zone: z.enum(RUN_HR_ZONES).optional(),
    hr_range_bpm: z
      .tuple([z.number().int().min(60).max(230), z.number().int().min(60).max(230)])
      .optional(),
    open_target: z.boolean().optional(),
    label: z.string().trim().min(1).max(80).optional(),
    text_cue: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (s) => (s.duration_s !== undefined) !== (s.distance_m !== undefined),
    "running step must specify exactly one of duration_s or distance_m"
  );

export const RunRepeatStepSchema = z.object({
  type: z.literal("repeat"),
  label: z.string().trim().min(1).max(80).optional(),
  count: z.number().int().min(2).max(50),
  steps: z.array(RunAtomicStepSchema).min(1).max(12),
});

export const RunWorkoutStepSchema = z.union([RunAtomicStepSchema, RunRepeatStepSchema]);

export const RunWorkoutSpecSchema = z.object({
  schema_version: z.literal(1),
  sport: z.literal("running"),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  category: z.enum(RUN_WORKOUT_CATEGORIES).default("custom"),
  steps: z.array(RunWorkoutStepSchema).min(1).max(100),
});

export type RunAtomicStep = z.infer<typeof RunAtomicStepSchema>;
export type RunRepeatStep = z.infer<typeof RunRepeatStepSchema>;
export type RunWorkoutStep = z.infer<typeof RunWorkoutStepSchema>;
export type RunWorkoutSpec = z.infer<typeof RunWorkoutSpecSchema>;
export type RunWorkoutSpecInput = z.input<typeof RunWorkoutSpecSchema>;

export interface FlattenedRunStep {
  step_index: number;
  type: RunAtomicStep["type"];
  label: string;
  duration_s: number;
  distance_m: number;
  target_pace_s_per_km: number;
  pace_zone: RunPaceZone | null;
  hr_zone: RunHrZone | null;
  intensity_factor: number;
  is_work_interval: boolean;
  text_cue: string | null;
}

export interface RunWorkoutLoadPrediction {
  duration_s: number;
  distance_m: number;
  np_watts: null;
  intensity_factor: number;
  tss: number;
  avg_pace_s_per_km: number;
  is_quality_session: boolean;
  zone_seconds: PowerZoneSeconds;
}

export const DEFAULT_THRESHOLD_PACE_S_PER_KM = 270; // 4:30/km fallback

export function estimateRunStepPaceSPerKm(
  step: RunAtomicStep,
  thresholdPaceSPerKm = DEFAULT_THRESHOLD_PACE_S_PER_KM
): number {
  const tp =
    Number.isFinite(thresholdPaceSPerKm) && thresholdPaceSPerKm >= 150 && thresholdPaceSPerKm <= 720
      ? thresholdPaceSPerKm
      : DEFAULT_THRESHOLD_PACE_S_PER_KM;

  if (step.pace_range_s_per_km) {
    return (step.pace_range_s_per_km[0] + step.pace_range_s_per_km[1]) / 2;
  }
  if (step.pace_zone) {
    return tp * PACE_ZONE_MULTIPLIER[step.pace_zone];
  }
  if (step.hr_zone) {
    return tp / HR_ZONE_IF[step.hr_zone];
  }
  switch (step.type) {
    case "warmup":
    case "cooldown":
    case "recovery":
      return tp * PACE_ZONE_MULTIPLIER.easy;
    case "interval":
      return tp * PACE_ZONE_MULTIPLIER.threshold;
    case "steady":
    default:
      return tp * PACE_ZONE_MULTIPLIER.easy;
  }
}

export function flattenRunWorkout(
  spec: RunWorkoutSpec,
  thresholdPaceSPerKm = DEFAULT_THRESHOLD_PACE_S_PER_KM
): FlattenedRunStep[] {
  const tp =
    Number.isFinite(thresholdPaceSPerKm) && thresholdPaceSPerKm >= 150 && thresholdPaceSPerKm <= 720
      ? thresholdPaceSPerKm
      : DEFAULT_THRESHOLD_PACE_S_PER_KM;

  const out: FlattenedRunStep[] = [];
  let idx = 0;

  const pushAtomic = (step: RunAtomicStep, repeatPrefix?: string) => {
    const pace = estimateRunStepPaceSPerKm(step, tp);
    const durationS =
      step.duration_s !== undefined
        ? step.duration_s
        : Math.max(10, Math.round(((step.distance_m ?? 0) / 1000) * pace));
    const distanceM =
      step.distance_m !== undefined
        ? step.distance_m
        : Math.max(10, Math.round((durationS / pace) * 1000));
    const intensityFactor = Number(Math.max(0.5, Math.min(1.4, tp / pace)).toFixed(3));
    const isWork =
      step.type === "interval" ||
      step.pace_zone === "threshold" ||
      step.pace_zone === "interval" ||
      step.pace_zone === "repetition" ||
      intensityFactor >= 0.95;

    const baseLabel = step.label ?? step.pace_zone ?? step.type;
    out.push({
      step_index: idx++,
      type: step.type,
      label: repeatPrefix ? `${repeatPrefix} ${baseLabel}` : baseLabel,
      duration_s: durationS,
      distance_m: distanceM,
      target_pace_s_per_km: Number(pace.toFixed(1)),
      pace_zone: step.pace_zone ?? null,
      hr_zone: step.hr_zone ?? null,
      intensity_factor: intensityFactor,
      is_work_interval: isWork,
      text_cue: step.text_cue ?? null,
    });
  };

  for (const step of spec.steps) {
    if (step.type === "repeat") {
      for (let rep = 1; rep <= step.count; rep++) {
        const prefix = step.label ? `${step.label} ${rep}/${step.count}` : `Rep ${rep}/${step.count}`;
        for (const inner of step.steps) {
          pushAtomic(inner, prefix);
        }
      }
    } else {
      pushAtomic(step);
    }
  }

  return out;
}

export function predictRunWorkoutLoad(
  spec: RunWorkoutSpec,
  thresholdPaceSPerKm = DEFAULT_THRESHOLD_PACE_S_PER_KM
): RunWorkoutLoadPrediction {
  const flat = flattenRunWorkout(spec, thresholdPaceSPerKm);
  let totalDurationS = 0;
  let totalDistanceM = 0;
  let weightedIfSq = 0;
  let qualitySeconds = 0;
  const zones: PowerZoneSeconds = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, z6: 0, z7: 0 };

  for (const s of flat) {
    totalDurationS += s.duration_s;
    totalDistanceM += s.distance_m;
    weightedIfSq += s.duration_s * s.intensity_factor * s.intensity_factor;
    if (s.is_work_interval) {
      qualitySeconds += s.duration_s;
    }

    if (s.intensity_factor < 0.78) zones.z1 += s.duration_s;
    else if (s.intensity_factor < 0.88) zones.z2 += s.duration_s;
    else if (s.intensity_factor < 0.95) zones.z3 += s.duration_s;
    else if (s.intensity_factor < 1.03) zones.z4 += s.duration_s;
    else if (s.intensity_factor < 1.12) zones.z5 += s.duration_s;
    else zones.z6 += s.duration_s;
  }

  const effectiveIf =
    totalDurationS > 0 ? Math.sqrt(weightedIfSq / totalDurationS) : 0.75;
  const tss = (totalDurationS / 3600) * effectiveIf * effectiveIf * 100;
  const avgPace =
    totalDistanceM > 0
      ? Number((totalDurationS / (totalDistanceM / 1000)).toFixed(1))
      : thresholdPaceSPerKm * 1.15;

  const isQuality =
    spec.category === "tempo" ||
    spec.category === "threshold" ||
    spec.category === "intervals" ||
    spec.category === "hills" ||
    spec.category === "race" ||
    qualitySeconds >= 600;

  return {
    duration_s: totalDurationS,
    distance_m: totalDistanceM,
    np_watts: null,
    intensity_factor: Number(effectiveIf.toFixed(3)),
    tss: Number(tss.toFixed(1)),
    avg_pace_s_per_km: avgPace,
    is_quality_session: isQuality,
    zone_seconds: zones,
  };
}
