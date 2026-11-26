import { describe, it, expect } from "vitest";
import goldenRide from "../../../fixtures/golden-ride.json" with { type: "json" };
import {
  computeNormalizedPower,
  computePowerZones,
  computeHrZones,
  computeMmpCurve,
  estimateCriticalPower,
  computeDailyPmc,
  computeRideMetrics,
  BridgeCommandSchema,
  BridgeEventSchema,
  RideUploadSummarySchema,
  type TelemetrySample,
  type FlattenedStep,
} from "../../index.js";

describe("Normalized Power & Zones", () => {
  it("computes constant NP equal to power and handles <30s fallback", () => {
    expect(computeNormalizedPower(new Array<number>(60).fill(200))).toBeCloseTo(200, 6);
    expect(computeNormalizedPower(new Array<number>(10).fill(250))).toBeCloseTo(250, 6);
    expect(computeNormalizedPower([])).toBe(0);
  });

  it("classifies Coggan power zones Z1-Z7 and LTHR zones Z1-Z5 accurately", () => {
    // FTP = 200W: Z1 <110, Z2 110..150, Z3 151..180, Z4 181..210, Z5 211..240, Z6 241..300, Z7 >300
    const watts = [100, 130, 170, 200, 230, 270, 350];
    expect(computePowerZones(watts, 200)).toEqual({
      z1: 1,
      z2: 1,
      z3: 1,
      z4: 1,
      z5: 1,
      z6: 1,
      z7: 1,
    });

    // LTHR = 170: <81% (<137.7), <90% (<153), <94% (<159.8), <100% (<170), >=100% (>=170)
    const hrs = [130, 145, 156, 165, 175, null, 0];
    expect(computeHrZones(hrs, 170)).toEqual({
      z1: 1,
      z2: 1,
      z3: 1,
      z4: 1,
      z5: 1,
    });
  });
});

describe("O(N) Mean Maximal Power & Critical Power", () => {
  it("computes exact MMP across windows and meets <15ms budget on 4-hour rides", () => {
    const simple = [
      ...new Array<number>(5).fill(400),
      ...new Array<number>(10).fill(300),
      ...new Array<number>(15).fill(200),
    ];
    const peaks = computeMmpCurve(simple, 75);
    expect(peaks.find((p) => p.duration_s === 5)?.watts).toBe(400);
    expect(peaks.find((p) => p.duration_s === 15)?.watts).toBe(333);
    expect(peaks.find((p) => p.duration_s === 30)?.watts).toBe(267);
    expect(peaks.find((p) => p.duration_s === 60)).toBeUndefined();

    // 4-hour (14,400 samples) full ride analytics performance check
    const fourHourSamples: TelemetrySample[] = new Array<TelemetrySample>(14400);
    for (let i = 0; i < 14400; i++) {
      fourHourSamples[i] = {
        t_s: i,
        watts: 180 + ((i * 13) % 60),
        hr_bpm: 138 + ((i * 7) % 24),
        cadence_rpm: 88,
      };
    }

    // Warm V8 JIT across all code paths (including decoupling + long MMP windows)
    computeRideMetrics(fourHourSamples, {
      ftp_watts: 260,
      lthr_bpm: 172,
      hrmax_bpm: 190,
      weight_kg: 72,
    });

    const t0 = performance.now();
    const res = computeRideMetrics(fourHourSamples, {
      ftp_watts: 260,
      lthr_bpm: 172,
      hrmax_bpm: 190,
      weight_kg: 72,
    });
    const elapsedMs = performance.now() - t0;

    expect(res.duration_s).toBe(14400);
    expect(res.peaks.some((p) => p.duration_s === 3600)).toBe(true);
    expect(elapsedMs).toBeLessThan(15);
  });

  it("recovers exact 2-parameter CP and W' and rejects insufficient/noisy curves", () => {
    const trueCp = 280;
    const trueWPrime = 20000;
    const synthetic = [120, 300, 480, 720, 1200].map((d) => ({
      duration_s: d as 120 | 300 | 480 | 720 | 1200,
      watts: Math.round(trueCp + trueWPrime / d),
      w_per_kg: null,
    }));

    const cp = estimateCriticalPower(synthetic);
    expect(cp).not.toBeNull();
    expect(cp?.cp_watts).toBe(280);
    expect(cp?.w_prime_j).toBeGreaterThan(19800);
    expect(cp?.w_prime_j).toBeLessThan(20200);
    expect(cp?.r_squared).toBeGreaterThanOrEqual(0.999);

    expect(estimateCriticalPower(synthetic.slice(0, 2))).toBeNull();
  });
});

describe("Daily PMC (CTL / ATL / TSB)", () => {
  it("computes exponential load decay and pre-ride TSB freshness across rest days", () => {
    const pmc = computeDailyPmc(
      [{ day: "2026-11-01", total_tss: 100 }],
      { startDay: "2026-11-01", endDay: "2026-11-08" }
    );
    expect(pmc).toHaveLength(8);
    expect(pmc[0]?.tsb).toBe(0);
    expect(pmc[0]?.ctl).toBeCloseTo(100 / 42, 2);
    expect(pmc[0]?.atl).toBeCloseTo(100 / 7, 2);

    // Day 2 pre-ride TSB = CTL_1 - ATL_1
    const day1 = pmc[0];
    const day2 = pmc[1];
    if (day1 && day2) {
      expect(day2.tsb).toBeCloseTo(day1.ctl - day1.atl, 1);
      expect(day2.total_tss).toBe(0);
    }
    expect(pmc[7]?.ramp_rate_7d).toBeCloseTo((pmc[7]?.ctl ?? 0) - (pmc[0]?.ctl ?? 0), 2);
  });
});

describe("Quality Flags & ERG Smoothing Detection", () => {
  it("flags unrealistically flat steady ERG output over >=60s", () => {
    const smoothed: TelemetrySample[] = [];
    for (let i = 0; i < 90; i++) {
      smoothed.push({
        t_s: i,
        watts: 220,
        hr_bpm: 145,
        cadence_rpm: 90,
        target_watts: 220,
        step_index: 0,
      });
    }
    const res = computeRideMetrics(smoothed, { ftp_watts: 250 });
    expect(res.quality_flags.erg_smoothing_detected).toBe(true);
  });
});

describe("Golden Ride Fixture Parity", () => {
  it("matches packages/shared/fixtures/golden-ride.json exactly", () => {
    const actual = computeRideMetrics(
      goldenRide.samples,
      goldenRide.thresholds,
      goldenRide.planned_steps as FlattenedStep[]
    );
    const cp = estimateCriticalPower(actual.peaks);

    expect({ ...actual, cp_estimate: cp }).toEqual(goldenRide.expected);
  });
});

describe("Bridge Protocol Schemas", () => {
  it("validates BridgeCommand, BridgeEvent, and RideUploadSummary payloads", () => {
    expect(
      BridgeCommandSchema.safeParse({ type: "set_erg_bias", bias_pct: 95 }).success
    ).toBe(true);
    expect(
      BridgeCommandSchema.safeParse({ type: "set_erg_bias", bias_pct: 200 }).success
    ).toBe(false);
    expect(
      BridgeEventSchema.safeParse({
        type: "ride_saved",
        ride_uuid: "550e8400-e29b-41d4-a716-446655440000",
        upload_status: "uploaded",
        fit_bytes: 12345,
      }).success
    ).toBe(true);

    const summaryCandidate = {
      ride_uuid: "550e8400-e29b-41d4-a716-446655440000",
      name: goldenRide.workout_spec.name,
      source: "indoor_bridge" as const,
      started_at: "2026-11-26T14:00:00Z",
      ride_day: "2026-11-26",
      duration_s: goldenRide.expected.duration_s,
      elapsed_s: goldenRide.expected.elapsed_s,
      work_kj: goldenRide.expected.work_kj,
      avg_power: goldenRide.expected.avg_power,
      np_watts: goldenRide.expected.np_watts,
      intensity_factor: goldenRide.expected.intensity_factor,
      tss: goldenRide.expected.tss,
      variability_index: goldenRide.expected.variability_index,
      avg_hr: goldenRide.expected.avg_hr,
      max_hr: goldenRide.expected.max_hr,
      efficiency_factor: goldenRide.expected.efficiency_factor,
      pw_hr_decoupling: goldenRide.expected.pw_hr_decoupling,
      hrr_60s: goldenRide.expected.hrr_60s,
      time_gt_90_hrmax_s: goldenRide.expected.time_gt_90_hrmax_s,
      avg_cadence: goldenRide.expected.avg_cadence,
      compliance_pct: goldenRide.expected.compliance_pct,
      power_zones: goldenRide.expected.power_zones,
      hr_zones: goldenRide.expected.hr_zones,
      quality_flags: goldenRide.expected.quality_flags,
      ftp_snapshot: goldenRide.thresholds.ftp_watts,
      lthr_snapshot: goldenRide.thresholds.lthr_bpm,
      hrmax_snapshot: goldenRide.thresholds.hrmax_bpm,
      weight_kg_snapshot: goldenRide.thresholds.weight_kg,
      rpe: 7,
      feel: 4,
      notes: "Strong finish",
      intervals: goldenRide.expected.intervals,
      peaks: goldenRide.expected.peaks,
    };
    expect(RideUploadSummarySchema.safeParse(summaryCandidate).success).toBe(true);
  });
});
