import { z } from "zod";
import type { PowerZoneSeconds } from "../physiology/metrics.js";

export const STRENGTH_WORKOUT_CATEGORIES = [
  "full_body",
  "lower_body",
  "upper_body",
  "core_stability",
  "power_plyo",
  "mobility_prehab",
  "custom",
] as const;

export type StrengthWorkoutCategory = (typeof STRENGTH_WORKOUT_CATEGORIES)[number];

export const STRENGTH_MOVEMENT_PATTERNS = [
  "squat",
  "hinge",
  "lunge",
  "push",
  "pull",
  "core",
  "plyo",
  "carry",
  "full_body",
  "mobility",
] as const;

export type StrengthMovementPattern = (typeof STRENGTH_MOVEMENT_PATTERNS)[number];

export const StrengthExerciseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  movement_pattern: z.enum(STRENGTH_MOVEMENT_PATTERNS).default("full_body"),
  sets: z.number().int().min(1).max(20),
  reps: z.union([z.number().int().min(1).max(200), z.string().trim().min(1).max(40)]),
  target_rpe_or_rir: z.string().trim().min(1).max(40).optional(),
  load_notes: z.string().trim().max(120).optional(),
  rest_s: z.number().int().min(0).max(600).default(90),
  tempo: z.string().trim().max(24).optional(),
  notes: z.string().trim().max(240).optional(),
});

export const StrengthBlockSchema = z.object({
  label: z.string().trim().min(1).max(80),
  block_type: z
    .enum(["warmup", "main", "superset", "circuit", "accessory", "mobility"])
    .default("main"),
  exercises: z.array(StrengthExerciseSchema).min(1).max(20),
});

export const StrengthWorkoutSpecSchema = z.object({
  schema_version: z.literal(1),
  sport: z.literal("strength"),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  category: z.enum(STRENGTH_WORKOUT_CATEGORIES).default("custom"),
  estimated_duration_min: z.number().int().min(10).max(180).optional(),
  blocks: z.array(StrengthBlockSchema).min(1).max(12),
});

export type StrengthExercise = z.infer<typeof StrengthExerciseSchema>;
export type StrengthBlock = z.infer<typeof StrengthBlockSchema>;
export type StrengthWorkoutSpec = z.infer<typeof StrengthWorkoutSpecSchema>;
export type StrengthWorkoutSpecInput = z.input<typeof StrengthWorkoutSpecSchema>;

export interface StrengthWorkoutLoadPrediction {
  duration_s: number;
  np_watts: null;
  intensity_factor: number;
  tss: number;
  total_sets: number;
  is_heavy_lower_body: boolean;
  zone_seconds: PowerZoneSeconds;
}

function parseRpeIntensity(target?: string): number {
  if (!target) return 7;
  const rpeMatch = /rpe\s*(\d+(?:\.\d+)?)/i.exec(target);
  if (rpeMatch?.[1]) {
    return Math.min(10, Math.max(1, Number(rpeMatch[1])));
  }
  const rirMatch = /(\d+(?:\.\d+)?)\s*rir/i.exec(target);
  if (rirMatch?.[1]) {
    return Math.min(10, Math.max(1, 10 - Number(rirMatch[1])));
  }
  return 7;
}

const LOWER_BODY_PATTERNS = new Set<StrengthMovementPattern>(["squat", "hinge", "lunge", "plyo"]);

export function isHeavyLowerBodyStrength(spec: StrengthWorkoutSpec): boolean {
  if (spec.category === "mobility_prehab" || spec.category === "upper_body") {
    return false;
  }
  let lowerBodyWorkingSets = 0;
  let highRpeLower = false;

  for (const block of spec.blocks) {
    if (block.block_type === "warmup" || block.block_type === "mobility") continue;
    for (const ex of block.exercises) {
      if (LOWER_BODY_PATTERNS.has(ex.movement_pattern)) {
        lowerBodyWorkingSets += ex.sets;
        if (parseRpeIntensity(ex.target_rpe_or_rir) >= 7.5 || ex.movement_pattern === "plyo") {
          highRpeLower = true;
        }
      }
    }
  }

  return (
    spec.category === "lower_body" ||
    spec.category === "power_plyo" ||
    (lowerBodyWorkingSets >= 6 && highRpeLower) ||
    lowerBodyWorkingSets >= 9
  );
}

export function predictStrengthWorkoutLoad(
  spec: StrengthWorkoutSpec
): StrengthWorkoutLoadPrediction {
  let totalSets = 0;
  let workingSets = 0;
  let rpeSum = 0;
  let estimatedSec = 0;

  for (const block of spec.blocks) {
    for (const ex of block.exercises) {
      totalSets += ex.sets;
      const isWarmup = block.block_type === "warmup" || block.block_type === "mobility";
      const workSecPerSet = isWarmup ? 35 : 45;
      estimatedSec += ex.sets * (workSecPerSet + ex.rest_s);
      if (!isWarmup) {
        workingSets += ex.sets;
        rpeSum += parseRpeIntensity(ex.target_rpe_or_rir) * ex.sets;
      }
    }
  }

  const durationS =
    spec.estimated_duration_min !== undefined
      ? spec.estimated_duration_min * 60
      : Math.max(600, Math.round(estimatedSec));

  const avgRpe = workingSets > 0 ? rpeSum / workingSets : 5.5;
  // Session-RPE style load scaled into TSS-equivalent range (~25-65/hr)
  const intensityFactor = Number(Math.max(0.5, Math.min(0.85, 0.45 + avgRpe * 0.04)).toFixed(3));
  const tss = Number(((durationS / 3600) * intensityFactor * intensityFactor * 90).toFixed(1));

  return {
    duration_s: durationS,
    np_watts: null,
    intensity_factor: intensityFactor,
    tss,
    total_sets: totalSets,
    is_heavy_lower_body: isHeavyLowerBodyStrength(spec),
    zone_seconds: { z1: durationS, z2: 0, z3: 0, z4: 0, z5: 0, z6: 0, z7: 0 },
  };
}
