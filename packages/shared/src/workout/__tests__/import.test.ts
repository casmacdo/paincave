import { describe, expect, it } from "vitest";
import { toErgText, toZwoXml } from "../export.js";
import { importErgOrMrcText, importWorkoutFile, importZwoXml } from "../import.js";
import type { WorkoutSpec } from "../schema.js";

describe("Workout Importers (.zwo / .erg / .mrc)", () => {
  it("round-trips PainCave .zwo XML and parses Zwift IntervalsT blocks", () => {
    const original: WorkoutSpec = {
      schema_version: 1,
      name: "Sweet Spot 2x15",
      description: "Steady aerobic threshold",
      category: "sweet_spot",
      steps: [
        { type: "ramp", duration_s: 300, start_ftp: 0.5, end_ftp: 0.75, label: "Warmup" },
        { type: "steady", duration_s: 900, target_ftp: 0.9, cadence_rpm: 90, text_cue: "Hold smooth" },
        { type: "ramp", duration_s: 300, start_ftp: 0.65, end_ftp: 0.45, label: "Cooldown" },
      ],
    };

    const xml = toZwoXml(original, 260);
    const imported = importZwoXml(xml);
    expect(imported.name).toBe("Sweet Spot 2x15");
    expect(imported.category).toBe("sweet_spot");
    expect(imported.steps).toHaveLength(3);
    expect(imported.steps[1]).toMatchObject({
      type: "steady",
      duration_s: 900,
      cadence_rpm: 90,
      text_cue: "Hold smooth",
    });

    const zwiftIntervals = `
      <workout_file>
        <name>5x3m VO2</name>
        <description>Hard aerobic intervals</description>
        <workout>
          <Warmup Duration="300" PowerLow="0.50" PowerHigh="0.75"/>
          <IntervalsT Repeat="5" OnDuration="180" OffDuration="180" OnPower="1.15" OffPower="0.55" Cadence="95"/>
          <FreeRide Duration="300" FlatRoad="1"/>
        </workout>
      </workout_file>
    `;
    const parsed = importWorkoutFile("5x3_vo2.zwo", zwiftIntervals, 260);
    expect(parsed.category).toBe("vo2max");
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[1]).toMatchObject({ type: "repeat", count: 5 });
    expect(parsed.steps[2]).toMatchObject({ type: "free_ride", duration_s: 300 });
  });

  it("round-trips .erg and parses .mrc percentage workouts", () => {
    const original: WorkoutSpec = {
      schema_version: 1,
      name: "Tempo Cruise",
      description: "Sustained Z3",
      category: "tempo",
      steps: [
        { type: "steady", duration_s: 600, target_ftp: 0.6 },
        { type: "steady", duration_s: 1200, target_ftp: 0.82 },
      ],
    };
    const erg = toErgText(original, 250);
    const fromErg = importErgOrMrcText(erg, { fallbackName: "Tempo Cruise.erg" });
    expect(fromErg.name).toBe("Tempo Cruise");
    expect(fromErg.category).toBe("tempo");
    expect(fromErg.steps).toHaveLength(2);

    const mrc = `[COURSE HEADER]
VERSION = 2
DESCRIPTION = Threshold Ramp Test
MINUTES PERCENT
[END COURSE HEADER]
[COURSE DATA]
0.0\t50
5.0\t75
5.0\t100
15.0\t100
[END COURSE DATA]`;
    const fromMrc = importWorkoutFile("threshold_session.mrc", mrc, 260);
    expect(fromMrc.category).toBe("threshold");
    expect(fromMrc.steps).toHaveLength(2);
    expect(fromMrc.steps[0]).toMatchObject({
      type: "ramp",
      duration_s: 300,
      start_ftp: 0.5,
      end_ftp: 0.75,
    });
    expect(fromMrc.steps[1]).toMatchObject({
      type: "steady",
      duration_s: 600,
      target_ftp: 1,
    });
  });
});
