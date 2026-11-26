import { z } from "zod";
import { FlattenedStepSchema } from "../workout/schema.js";

export const SensorConnectionStateSchema = z.enum([
  "disconnected",
  "scanning",
  "connecting",
  "connected",
]);

export const WorkoutExecutionStateSchema = z.enum([
  "idle",
  "armed",
  "running",
  "paused",
  "auto_paused",
  "completed",
]);

export const BridgeCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scan_sensors") }),
  z.object({
    type: z.literal("load_workout"),
    workout_id: z.string().min(1).nullable().optional(),
    planned_session_id: z.string().min(1).nullable().optional(),
    name: z.string().min(1).max(160),
    ftp_watts: z.number().int().min(50).max(600),
    lthr_bpm: z.number().int().min(100).max(230).nullable().optional(),
    hrmax_bpm: z.number().int().min(120).max(240).nullable().optional(),
    weight_kg: z.number().min(35).max(200).nullable().optional(),
    steps: z.array(FlattenedStepSchema).min(1),
  }),
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("skip_step") }),
  z.object({ type: z.literal("prev_step") }),
  z.object({
    type: z.literal("extend_step"),
    seconds: z.number().int().min(-300).max(1800),
  }),
  z.object({
    type: z.literal("set_erg_bias"),
    bias_pct: z.number().int().min(50).max(150),
  }),
  z.object({
    type: z.literal("set_manual_target"),
    mode: z.enum(["erg", "slope", "resistance"]),
    watts: z.number().int().min(0).max(2000).optional(),
    grade_pct: z.number().min(-10).max(20).optional(),
    resistance_pct: z.number().min(0).max(100).optional(),
  }),
  z.object({
    type: z.literal("stop_and_save"),
    rpe: z.number().int().min(1).max(10).nullable().optional(),
    feel: z.number().int().min(1).max(5).nullable().optional(),
    notes: z.string().max(2000).optional(),
  }),
  z.object({ type: z.literal("discard") }),
  z.object({
    type: z.literal("inject_mock_fault"),
    cadence_zero_seconds: z.number().int().min(1).max(60),
  }),
]);

export const BridgeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("telemetry"),
    ts_ms: z.number().int(),
    ride_uuid: z.string().nullable(),
    workout_name: z.string().nullable(),
    state: WorkoutExecutionStateSchema,
    elapsed_s: z.number().int().nonnegative(),
    step_index: z.number().int().nonnegative(),
    total_steps: z.number().int().nonnegative(),
    step_label: z.string().nullable(),
    step_elapsed_s: z.number().int().nonnegative(),
    step_remaining_s: z.number().int().nonnegative(),
    mode: z.enum(["erg", "slope", "resistance"]),
    target_watts: z.number().int().nullable(),
    target_grade_pct: z.number().nullable(),
    erg_bias_pct: z.number().int(),
    watts: z.number().int().nullable(),
    watts_3s: z.number().int().nullable(),
    cadence_rpm: z.number().int().nullable(),
    hr_bpm: z.number().int().nullable(),
    speed_kph: z.number().nullable(),
    synthetic_route: z.boolean().optional(),
    lat_deg: z.number().nullable().optional(),
    lon_deg: z.number().nullable().optional(),
    elevation_m: z.number().nullable().optional(),
    distance_m: z.number().nullable().optional(),
    grade_pct: z.number().nullable().optional(),
    text_cue: z.string().nullable(),
    sensors: z.object({
      trainer: SensorConnectionStateSchema,
      hr: SensorConnectionStateSchema,
      transport: z.string(),
    }),
    pending_uploads: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("ride_saved"),
    ride_uuid: z.string(),
    upload_status: z.enum(["queued", "uploaded", "failed"]),
    fit_bytes: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

export const PowerZoneSecondsSchema = z.object({
  z1: z.number().int().nonnegative(),
  z2: z.number().int().nonnegative(),
  z3: z.number().int().nonnegative(),
  z4: z.number().int().nonnegative(),
  z5: z.number().int().nonnegative(),
  z6: z.number().int().nonnegative(),
  z7: z.number().int().nonnegative(),
});

export const HrZoneSecondsSchema = z.object({
  z1: z.number().int().nonnegative(),
  z2: z.number().int().nonnegative(),
  z3: z.number().int().nonnegative(),
  z4: z.number().int().nonnegative(),
  z5: z.number().int().nonnegative(),
});

export const QualityFlagsSchema = z.object({
  power_dropouts_s: z.number().int().nonnegative(),
  hr_dropouts_s: z.number().int().nonnegative(),
  erg_smoothing_detected: z.boolean(),
});

export const IntervalExecutionSchema = z.object({
  step_index: z.number().int().nonnegative(),
  label: z.string().min(1),
  mode: z.enum(["erg", "slope", "resistance"]),
  is_work_interval: z.boolean(),
  planned_duration_s: z.number().int().positive(),
  actual_duration_s: z.number().int().nonnegative(),
  target_watts: z.number().int().nonnegative().nullable(),
  actual_avg_watts: z.number().int().nonnegative().nullable(),
  pct_of_target: z.number().nullable(),
  avg_hr: z.number().int().positive().nullable(),
  max_hr: z.number().int().positive().nullable(),
  hr_drift_bpm: z.number().int().nullable(),
  avg_cadence: z.number().int().nonnegative().nullable(),
  erg_bias_pct: z.number().int().min(50).max(150),
  status: z.enum(["completed", "partial", "skipped"]),
});

export const MmpPointSchema = z.object({
  duration_s: z.union([
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal(60),
    z.literal(120),
    z.literal(300),
    z.literal(480),
    z.literal(720),
    z.literal(1200),
    z.literal(1800),
    z.literal(3600),
  ]),
  watts: z.number().int().nonnegative(),
  w_per_kg: z.number().nonnegative().nullable(),
});

export const RideUploadSummarySchema = z.object({
  ride_uuid: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  source: z.enum(["indoor_bridge", "manual_fit", "external_sync"]),
  workout_id: z.string().min(1).nullable().optional(),
  planned_session_id: z.string().min(1).nullable().optional(),
  started_at: z.string().min(10),
  ride_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  duration_s: z.number().int().nonnegative(),
  elapsed_s: z.number().int().nonnegative(),
  work_kj: z.number().nonnegative(),
  avg_power: z.number().int().nonnegative().nullable(),
  np_watts: z.number().int().nonnegative().nullable(),
  intensity_factor: z.number().nonnegative().nullable(),
  tss: z.number().nonnegative(),
  variability_index: z.number().nonnegative().nullable(),
  avg_hr: z.number().int().positive().nullable(),
  max_hr: z.number().int().positive().nullable(),
  efficiency_factor: z.number().nonnegative().nullable(),
  pw_hr_decoupling: z.number().nullable(),
  hrr_60s: z.number().int().nullable(),
  time_gt_90_hrmax_s: z.number().int().nonnegative(),
  avg_cadence: z.number().int().nonnegative().nullable(),
  compliance_pct: z.number().min(0).max(100).nullable(),

  power_zones: PowerZoneSecondsSchema,
  hr_zones: HrZoneSecondsSchema,
  quality_flags: QualityFlagsSchema,

  ftp_snapshot: z.number().int().min(50).max(600),
  lthr_snapshot: z.number().int().min(100).max(230).nullable().optional(),
  hrmax_snapshot: z.number().int().min(120).max(240).nullable().optional(),
  weight_kg_snapshot: z.number().min(35).max(200).nullable().optional(),

  rpe: z.number().int().min(1).max(10).nullable().optional(),
  feel: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().max(2000).default(""),

  intervals: z.array(IntervalExecutionSchema).default([]),
  peaks: z.array(MmpPointSchema).default([]),
});

export type BridgeCommand = z.infer<typeof BridgeCommandSchema>;
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;
export type RideUploadSummary = z.infer<typeof RideUploadSummarySchema>;
