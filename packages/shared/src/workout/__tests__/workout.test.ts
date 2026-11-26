import { describe, it, expect } from "vitest";
import {
  WorkoutSpecSchema,
  flattenWorkout,
  predictWorkoutLoad,
  validateWorkoutGuardrails,
  toZwoXml,
  toErgText,
  type WorkoutSpec,
} from "../../index.js";

const SAMPLE_WORKOUT: WorkoutSpec = {
  schema_version: 1,
  name: "4x8m Threshold",
  description: "Sustained threshold intervals with 4m Z1 recovery.",
  category: "threshold",
  steps: [
    {
      type: "ramp",
      label: "Warmup",
      duration_s: 600,
      start_ftp: 0.5,
      end_ftp: 0.72,
      cadence_rpm: 88,
      text_cue: "Easy spin, open up the legs",
    },
    {
      type: "repeat",
      count: 4,
      label: "Threshold",
      steps: [
        {
          type: "steady",
          label: "Work",
          duration_s: 480,
          target_ftp: 0.98,
          cadence_rpm: 90,
          text_cue: "Smooth torque",
        },
        {
          type: "steady",
          label: "Recovery",
          duration_s: 240,
          target_ftp: 0.55,
        },
      ],
    },
    {
      type: "ramp",
      label: "Cooldown",
      duration_s: 300,
      start_ftp: 0.55,
      end_ftp: 0.4,
    },
  ],
};

describe("WorkoutSpec & flattening", () => {
  it("parses valid WorkoutSpec and rejects nested repeats or invalid steps", () => {
    expect(WorkoutSpecSchema.safeParse(SAMPLE_WORKOUT).success).toBe(true);

    const nestedRepeat = {
      schema_version: 1,
      name: "Bad",
      steps: [
        {
          type: "repeat",
          count: 2,
          steps: [
            {
              type: "repeat",
              count: 2,
              steps: [{ type: "steady", duration_s: 60, target_ftp: 0.8 }],
            },
          ],
        },
      ],
    };
    expect(WorkoutSpecSchema.safeParse(nestedRepeat).success).toBe(false);

    const missingTarget = {
      schema_version: 1,
      name: "Bad Steady",
      steps: [{ type: "steady", duration_s: 300 }],
    };
    expect(WorkoutSpecSchema.safeParse(missingTarget).success).toBe(false);
  });

  it("flattens repeat blocks deterministically and converts %FTP to integer watts", () => {
    const flat = flattenWorkout(SAMPLE_WORKOUT, 250);
    // Warmup (1) + 4 * 2 + Cooldown (1) = 10 steps
    expect(flat).toHaveLength(10);
    expect(flat[0]).toMatchObject({
      step_index: 0,
      label: "Warmup",
      start_offset_s: 0,
      duration_s: 600,
      mode: "erg",
      watts_start: 125,
      watts_end: 180,
      is_work_interval: false,
    });
    expect(flat[1]).toMatchObject({
      step_index: 1,
      label: "Threshold 1/4 - Work",
      start_offset_s: 600,
      duration_s: 480,
      mode: "erg",
      watts_start: 245,
      watts_end: 245,
      is_work_interval: true,
    });
    expect(flat[9]?.start_offset_s).toBe(600 + 4 * 720);
  });

  it("handles slope and free_ride modes in flattening", () => {
    const spec = WorkoutSpecSchema.parse({
      schema_version: 1,
      name: "20m FTP Test",
      category: "test",
      steps: [
        { type: "steady", duration_s: 300, target_ftp: 0.6 },
        { type: "slope", duration_s: 1200, grade_pct: 3.5, label: "All-Out 20m" },
        { type: "free_ride", duration_s: 300, resistance_pct: 15, label: "Spin Down" },
      ],
    });
    const flat = flattenWorkout(spec, 260);
    expect(flat[1]).toMatchObject({ mode: "slope", grade_pct: 3.5, watts_start: null });
    expect(flat[2]).toMatchObject({ mode: "resistance", resistance_pct: 15, watts_start: null });
  });

  it("predicts deterministic load (duration, NP, IF, TSS, zones)", () => {
    const pred = predictWorkoutLoad(SAMPLE_WORKOUT, 260);
    expect(pred.duration_s).toBe(3780);
    expect(pred.np_watts).toBeGreaterThan(215);
    expect(pred.np_watts).toBeLessThan(245);
    expect(pred.intensity_factor).toBeGreaterThan(0.8);
    expect(pred.tss).toBeGreaterThan(65);
    expect(
      pred.zone_seconds.z1 +
        pred.zone_seconds.z2 +
        pred.zone_seconds.z3 +
        pred.zone_seconds.z4 +
        pred.zone_seconds.z5 +
        pred.zone_seconds.z6 +
        pred.zone_seconds.z7
    ).toBe(3780);
  });
});

describe("Physiological Guardrails", () => {
  it("accepts safe workouts and warns on very high TSS", () => {
    const res = validateWorkoutGuardrails(SAMPLE_WORKOUT, 260);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("rejects workouts shorter than 5m, longer than 6h, or unsafe %FTP", () => {
    const tooShort = WorkoutSpecSchema.parse({
      schema_version: 1,
      name: "Too Short",
      steps: [{ type: "steady", duration_s: 120, target_ftp: 0.8 }],
    });
    expect(validateWorkoutGuardrails(tooShort, 260).valid).toBe(false);

    const tooHardSustained = WorkoutSpecSchema.parse({
      schema_version: 1,
      name: "Impossible 5m",
      steps: [{ type: "steady", duration_s: 300, target_ftp: 1.65 }],
    });
    const res = validateWorkoutGuardrails(tooHardSustained, 260);
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("exceeds 150% FTP");

    const outOfBounds = WorkoutSpecSchema.parse({
      schema_version: 1,
      name: "Extreme Sprint",
      steps: [
        { type: "steady", duration_s: 15, target_ftp: 2.8 },
        { type: "steady", duration_s: 300, target_ftp: 0.5 },
      ],
    });
    expect(validateWorkoutGuardrails(outOfBounds, 260).valid).toBe(false);
  });
});

describe("ZWO & ERG compilers", () => {
  it("emits valid XML .zwo and .erg text", () => {
    const zwo = toZwoXml(SAMPLE_WORKOUT, 250);
    expect(zwo).toContain("<workout_file>");
    expect(zwo).toContain('<Warmup Duration="600" PowerLow="0.500" PowerHigh="0.720" Cadence="88">');
    expect(zwo).toContain('<SteadyState Duration="480" Power="0.980" Cadence="90">');
    expect(zwo).toContain('<Cooldown Duration="300" PowerLow="0.552" PowerHigh="0.400"/>');

    const erg = toErgText(SAMPLE_WORKOUT, 250);
    expect(erg).toContain("[COURSE HEADER]");
    expect(erg).toContain("FTP = 250");
    expect(erg).toContain("[COURSE DATA]");
    expect(erg).toContain("0.000\t125");
    expect(erg).toContain("10.000\t180");
    expect(erg).toContain("63.000\t100");
  });
});
