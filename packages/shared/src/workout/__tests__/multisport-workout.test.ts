import { describe, it, expect } from "vitest";
import {
  AnyWorkoutSpecSchema,
  RunWorkoutSpecSchema,
  StrengthWorkoutSpecSchema,
  WorkoutSpecSchema,
  flattenRunWorkout,
  getWorkoutSpecSport,
  isHeavyLowerBodyStrength,
  predictRunWorkoutLoad,
  predictStrengthWorkoutLoad,
  validateAnyWorkoutGuardrails,
  validateRunWorkoutGuardrails,
  validateStrengthWorkoutGuardrails,
} from "../../index.js";

describe("Multi-sport WorkoutSpec schemas and guardrails", () => {
  it("keeps legacy cycling specs (without sport field) 100% compatible", () => {
    const cycling = AnyWorkoutSpecSchema.parse({
      schema_version: 1,
      name: "Classic 2x20 SST",
      category: "sweet_spot",
      steps: [
        { type: "ramp", duration_s: 600, start_ftp: 0.5, end_ftp: 0.75 },
        {
          type: "repeat",
          count: 2,
          steps: [
            { type: "steady", duration_s: 1200, target_ftp: 0.9 },
            { type: "steady", duration_s: 300, target_ftp: 0.55 },
          ],
        },
      ],
    });

    expect(getWorkoutSpecSport(cycling)).toBe("cycling");
    expect(WorkoutSpecSchema.safeParse(cycling).success).toBe(true);
    const gr = validateAnyWorkoutGuardrails(cycling, { ftpWatts: 260 });
    expect(gr.valid).toBe(true);
    expect(gr.sport).toBe("cycling");
    expect(gr.predicted.tss).toBeGreaterThan(50);
  });

  it("validates running workouts, computes distance/duration/rTSS, and flags weekly volume jump + back-to-back quality", () => {
    const runSpec = RunWorkoutSpecSchema.parse({
      schema_version: 1,
      sport: "running",
      name: "5x1k Threshold Cruise",
      description: "Controlled threshold repeats with jog recovery",
      category: "threshold",
      steps: [
        { type: "warmup", duration_s: 600, pace_zone: "easy", label: "Easy WU" },
        {
          type: "repeat",
          label: "Cruise",
          count: 5,
          steps: [
            { type: "interval", distance_m: 1000, pace_zone: "threshold", label: "1k T" },
            { type: "recovery", duration_s: 90, pace_zone: "recovery", label: "Jog" },
          ],
        },
        { type: "cooldown", duration_s: 600, pace_zone: "easy", label: "Easy CD" },
      ],
    });

    expect(getWorkoutSpecSport(runSpec)).toBe("running");
    const flat = flattenRunWorkout(runSpec, 270);
    expect(flat).toHaveLength(12); // 1 WU + 5*2 + 1 CD

    const pred = predictRunWorkoutLoad(runSpec, 270);
    expect(pred.is_quality_session).toBe(true);
    expect(pred.distance_m).toBeGreaterThan(8500);
    expect(pred.duration_s).toBeGreaterThan(2500);
    expect(pred.tss).toBeGreaterThan(50);

    const gr = validateRunWorkoutGuardrails(runSpec, {
      thresholdPaceSPerKm: 270,
      recentWeeklyKm: 30,
      plannedWeekKmBeforeThis: 28,
      adjacentQualityRun: true,
    });
    expect(gr.valid).toBe(true);
    expect(gr.warnings.some((w) => w.includes(">15%"))).toBe(true);
    expect(gr.warnings.some((w) => w.includes("Back-to-back quality"))).toBe(true);
  });

  it("rejects running steps that specify neither or both of duration_s and distance_m", () => {
    const badBoth = RunWorkoutSpecSchema.safeParse({
      schema_version: 1,
      sport: "running",
      name: "Invalid Both",
      steps: [{ type: "steady", duration_s: 600, distance_m: 2000 }],
    });
    expect(badBoth.success).toBe(false);

    const badNeither = RunWorkoutSpecSchema.safeParse({
      schema_version: 1,
      sport: "running",
      name: "Invalid Neither",
      steps: [{ type: "steady", pace_zone: "easy" }],
    });
    expect(badNeither.success).toBe(false);
  });

  it("validates strength workouts, detects heavy lower-body sessions, and flags endurance interference", () => {
    const lowerStrength = StrengthWorkoutSpecSchema.parse({
      schema_version: 1,
      sport: "strength",
      name: "Runner & Cyclist Lower Force",
      description: "Heavy bilateral + unilateral posterior chain strength",
      category: "lower_body",
      blocks: [
        {
          label: "Activation",
          block_type: "warmup",
          exercises: [
            { name: "Glute Bridge", movement_pattern: "hinge", sets: 2, reps: 12, rest_s: 30 },
          ],
        },
        {
          label: "Main Force",
          block_type: "main",
          exercises: [
            {
              name: "Trap Bar Deadlift",
              movement_pattern: "hinge",
              sets: 4,
              reps: "5",
              target_rpe_or_rir: "2 RIR",
              rest_s: 180,
            },
            {
              name: "Bulgarian Split Squat",
              movement_pattern: "lunge",
              sets: 3,
              reps: "6/side",
              target_rpe_or_rir: "RPE 8",
              rest_s: 120,
            },
          ],
        },
      ],
    });

    expect(getWorkoutSpecSport(lowerStrength)).toBe("strength");
    expect(isHeavyLowerBodyStrength(lowerStrength)).toBe(true);
    const load = predictStrengthWorkoutLoad(lowerStrength);
    expect(load.total_sets).toBe(9);
    expect(load.duration_s).toBeGreaterThanOrEqual(1200);
    expect(load.tss).toBeGreaterThan(10);

    const gr = validateStrengthWorkoutGuardrails(lowerStrength, {
      adjacentKeyEnduranceSession: "5x1k Threshold Cruise (2026-05-12)",
    });
    expect(gr.valid).toBe(true);
    expect(gr.warnings.some((w) => w.includes("Heavy lower-body strength"))).toBe(true);
  });
});
