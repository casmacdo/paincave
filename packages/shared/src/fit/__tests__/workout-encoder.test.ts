import { describe, expect, it } from "vitest";
import {
  FIT_FILE_TYPE_WORKOUT,
  FIT_INTENSITY,
  FIT_SPORT_CYCLING,
  FIT_SPORT_RUNNING,
  FIT_SPORT_TRAINING,
  FIT_SUB_SPORT_STRENGTH_TRAINING,
  FIT_WKT_STEP_DURATION,
  FIT_WKT_STEP_TARGET,
  RunWorkoutSpecSchema,
  StrengthWorkoutSpecSchema,
  WorkoutSpecSchema,
  decodeFitWorkout,
  encodeWorkoutToFit,
} from "../../index.js";

describe("Garmin .FIT Workout binary encoder", () => {
  it("encodes a running workout with distance, pace zone, HR zone, and native repeat block with valid header & file CRC-16", () => {
    const spec = RunWorkoutSpecSchema.parse({
      schema_version: 1,
      sport: "running",
      name: "5x1k Threshold Cruise",
      category: "threshold",
      steps: [
        { type: "warmup", duration_s: 600, hr_zone: "Z2", label: "Easy WU" },
        {
          type: "repeat",
          label: "5x1k",
          count: 5,
          steps: [
            { type: "interval", distance_m: 1000, pace_zone: "threshold", label: "1k T" },
            { type: "recovery", duration_s: 90, open_target: true, label: "Jog" },
          ],
        },
        { type: "cooldown", duration_s: 600, pace_range_s_per_km: [310, 340], label: "Easy CD" },
      ],
    });

    const bytes = encodeWorkoutToFit(spec, {
      thresholdPaceSPerKm: 270,
      createdAtIso: "2026-05-12T08:00:00Z",
    });

    const decoded = decodeFitWorkout(bytes);
    expect(decoded.validHeader).toBe(true);
    expect(decoded.validHeaderCrc).toBe(true);
    expect(decoded.validFileCrc).toBe(true);
    expect(decoded.fileType).toBe(FIT_FILE_TYPE_WORKOUT);
    expect(decoded.sport).toBe(FIT_SPORT_RUNNING);
    expect(decoded.workoutName).toBe("5x1k Threshold Cruise");
    expect(decoded.numValidSteps).toBe(5); // WU, 1k, Jog, Repeat(step1, x5), CD
    expect(decoded.steps).toHaveLength(5);

    // Warmup: time 600s, HR zone 2
    expect(decoded.steps[0]?.duration_type).toBe(FIT_WKT_STEP_DURATION.time);
    expect(decoded.steps[0]?.duration_value).toBe(600_000);
    expect(decoded.steps[0]?.target_type).toBe(FIT_WKT_STEP_TARGET.heart_rate);
    expect(decoded.steps[0]?.target_value).toBe(2);
    expect(decoded.steps[0]?.intensity).toBe(FIT_INTENSITY.warmup);

    // 1k threshold interval: distance 1000m (100,000cm), speed target centered at 1000/270 = 3704 mm/s
    expect(decoded.steps[1]?.duration_type).toBe(FIT_WKT_STEP_DURATION.distance);
    expect(decoded.steps[1]?.duration_value).toBe(100_000);
    expect(decoded.steps[1]?.target_type).toBe(FIT_WKT_STEP_TARGET.speed);
    expect(decoded.steps[1]?.custom_target_low).toBeGreaterThan(3500);
    expect(decoded.steps[1]?.custom_target_high).toBeLessThan(3900);

    // Repeat step points back to index 1 with count=5
    expect(decoded.steps[3]?.duration_type).toBe(FIT_WKT_STEP_DURATION.repeat_until_steps_cmplt);
    expect(decoded.steps[3]?.duration_value).toBe(1);
    expect(decoded.steps[3]?.target_value).toBe(5);
  });

  it("encodes a cycling workout with FIT +1000W power target offsets and repeat blocks", () => {
    const spec = WorkoutSpecSchema.parse({
      schema_version: 1,
      name: "3x10m Threshold",
      category: "threshold",
      steps: [
        { type: "ramp", duration_s: 300, start_ftp: 0.5, end_ftp: 0.75, label: "Warmup" },
        {
          type: "repeat",
          count: 3,
          steps: [
            { type: "steady", duration_s: 600, target_ftp: 1.0, label: "Threshold" },
            { type: "steady", duration_s: 180, target_ftp: 0.55, label: "Rest" },
          ],
        },
      ],
    });

    const bytes = encodeWorkoutToFit(spec, { ftpWatts: 260 });
    const decoded = decodeFitWorkout(bytes);

    expect(decoded.validHeader).toBe(true);
    expect(decoded.validHeaderCrc).toBe(true);
    expect(decoded.validFileCrc).toBe(true);
    expect(decoded.sport).toBe(FIT_SPORT_CYCLING);
    expect(decoded.steps).toHaveLength(4);
    // Threshold step: 260W +/- 5W -> +1000W offset = [1255, 1265]
    expect(decoded.steps[1]?.target_type).toBe(FIT_WKT_STEP_TARGET.power);
    expect(decoded.steps[1]?.custom_target_low).toBe(1255);
    expect(decoded.steps[1]?.custom_target_high).toBe(1265);
    expect(decoded.steps[3]?.duration_type).toBe(FIT_WKT_STEP_DURATION.repeat_until_steps_cmplt);
    expect(decoded.steps[3]?.target_value).toBe(3);
  });

  it("encodes a strength workout as sport=training sub_sport=strength_training with set/rest repeats", () => {
    const spec = StrengthWorkoutSpecSchema.parse({
      schema_version: 1,
      sport: "strength",
      name: "Lower Body Force",
      category: "lower_body",
      blocks: [
        {
          label: "Main",
          block_type: "main",
          exercises: [
            { name: "Trap Bar Deadlift", movement_pattern: "hinge", sets: 4, reps: 5, rest_s: 180 },
          ],
        },
      ],
    });

    const bytes = encodeWorkoutToFit(spec);
    const decoded = decodeFitWorkout(bytes);

    expect(decoded.validHeader).toBe(true);
    expect(decoded.validHeaderCrc).toBe(true);
    expect(decoded.validFileCrc).toBe(true);
    expect(decoded.sport).toBe(FIT_SPORT_TRAINING);
    expect(decoded.subSport).toBe(FIT_SUB_SPORT_STRENGTH_TRAINING);
    expect(decoded.steps).toHaveLength(3); // Exercise (open) + Rest (180s) + Repeat x4
    expect(decoded.steps[0]?.duration_type).toBe(FIT_WKT_STEP_DURATION.open);
    expect(decoded.steps[0]?.name).toContain("Trap Bar Deadlift");
    expect(decoded.steps[1]?.duration_type).toBe(FIT_WKT_STEP_DURATION.time);
    expect(decoded.steps[1]?.duration_value).toBe(180_000);
    expect(decoded.steps[2]?.duration_type).toBe(FIT_WKT_STEP_DURATION.repeat_until_steps_cmplt);
    expect(decoded.steps[2]?.target_value).toBe(4);
  });
});
