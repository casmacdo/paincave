import { z } from "zod";

export const WORKOUT_CATEGORIES = [
  "recovery",
  "endurance",
  "tempo",
  "sweet_spot",
  "threshold",
  "vo2max",
  "anaerobic",
  "sprint",
  "test",
  "custom",
] as const;

export type WorkoutCategory = (typeof WORKOUT_CATEGORIES)[number];

const CommonStepFields = {
  label: z.string().trim().min(1).max(80).optional(),
  cadence_rpm: z.number().int().min(40).max(140).optional(),
  text_cue: z.string().trim().min(1).max(200).optional(),
};

export const SteadyStepSchema = z
  .object({
    type: z.literal("steady"),
    duration_s: z.number().int().min(5).max(14400),
    target_ftp: z.number().finite().positive().optional(),
    target_watts: z.number().int().positive().max(2500).optional(),
    ...CommonStepFields,
  })
  .refine(
    (s) => (s.target_ftp !== undefined) !== (s.target_watts !== undefined),
    "steady step must specify exactly one of target_ftp or target_watts"
  );

export const RampStepSchema = z
  .object({
    type: z.literal("ramp"),
    duration_s: z.number().int().min(10).max(7200),
    start_ftp: z.number().finite().positive().optional(),
    end_ftp: z.number().finite().positive().optional(),
    start_watts: z.number().int().positive().max(2500).optional(),
    end_watts: z.number().int().positive().max(2500).optional(),
    ...CommonStepFields,
  })
  .refine((s) => {
    const hasFtp = s.start_ftp !== undefined && s.end_ftp !== undefined;
    const hasWatts = s.start_watts !== undefined && s.end_watts !== undefined;
    const partialFtp = (s.start_ftp !== undefined) !== (s.end_ftp !== undefined);
    const partialWatts = (s.start_watts !== undefined) !== (s.end_watts !== undefined);
    return !partialFtp && !partialWatts && hasFtp !== hasWatts;
  }, "ramp step must specify either (start_ftp & end_ftp) or (start_watts & end_watts)");

export const SlopeStepSchema = z.object({
  type: z.literal("slope"),
  duration_s: z.number().int().min(5).max(14400),
  grade_pct: z.number().finite().min(-10).max(20),
  ...CommonStepFields,
});

export const FreeRideStepSchema = z.object({
  type: z.literal("free_ride"),
  duration_s: z.number().int().min(5).max(14400),
  resistance_pct: z.number().finite().min(0).max(100).optional(),
  ...CommonStepFields,
});

export const AtomicStepSchema = z.discriminatedUnion("type", [
  SteadyStepSchema,
  RampStepSchema,
  SlopeStepSchema,
  FreeRideStepSchema,
]);

export const RepeatStepSchema = z.object({
  type: z.literal("repeat"),
  label: z.string().trim().min(1).max(80).optional(),
  count: z.number().int().min(2).max(50),
  steps: z.array(AtomicStepSchema).min(1).max(20),
});

export const WorkoutStepSchema = z.union([AtomicStepSchema, RepeatStepSchema]);

export const WorkoutSpecSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  category: z.enum(WORKOUT_CATEGORIES).default("custom"),
  steps: z.array(WorkoutStepSchema).min(1).max(100),
});

export type SteadyStep = z.infer<typeof SteadyStepSchema>;
export type RampStep = z.infer<typeof RampStepSchema>;
export type SlopeStep = z.infer<typeof SlopeStepSchema>;
export type FreeRideStep = z.infer<typeof FreeRideStepSchema>;
export type AtomicStep = z.infer<typeof AtomicStepSchema>;
export type RepeatStep = z.infer<typeof RepeatStepSchema>;
export type WorkoutStep = z.infer<typeof WorkoutStepSchema>;
export type WorkoutSpec = z.infer<typeof WorkoutSpecSchema>;
export type WorkoutSpecInput = z.input<typeof WorkoutSpecSchema>;

export const FlattenedStepSchema = z.object({
  step_index: z.number().int().nonnegative(),
  label: z.string().min(1),
  start_offset_s: z.number().int().nonnegative(),
  duration_s: z.number().int().positive(),
  mode: z.enum(["erg", "slope", "resistance"]),
  watts_start: z.number().int().nonnegative().nullable(),
  watts_end: z.number().int().nonnegative().nullable(),
  grade_pct: z.number().finite().nullable(),
  resistance_pct: z.number().finite().nullable(),
  cadence_rpm: z.number().int().nullable(),
  text_cue: z.string().nullable(),
  is_work_interval: z.boolean(),
});

export type FlattenedStep = z.infer<typeof FlattenedStepSchema>;
