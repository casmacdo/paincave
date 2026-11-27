import { describe, expect, it } from "vitest";
import {
  computeRunningGradeFactor,
  computeRunningMetrics,
  parseFitRecords,
  type TelemetrySample,
} from "../../index.js";

function buildSyntheticRunFitWithLaps(): Uint8Array {
  const bytes: number[] = [];
  const pushU16 = (v: number) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  const pushU32 = (v: number) =>
    bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);

  // 14-byte header placeholder
  for (let i = 0; i < 14; i++) bytes.push(0);

  // Definition local 0 -> session (msg 18): start_time(2,4), sport(5,1), sub_sport(6,1), total_timer_time(8,4), total_distance(9,4), total_ascent(22,2)
  bytes.push(0x40, 0, 0);
  pushU16(18);
  bytes.push(6);
  bytes.push(2, 4, 0x86, 5, 1, 0x00, 6, 1, 0x00, 8, 4, 0x86, 9, 4, 0x86, 22, 2, 0x84);

  // Data local 0 -> running(1), trail(3), 1800s (1_800_000 ms), 5000m (500_000 cm), ascent 120m
  bytes.push(0x00);
  pushU32(1_150_000_000);
  bytes.push(1, 3);
  pushU32(1_800_000);
  pushU32(500_000);
  pushU16(120);

  // Definition local 1 -> lap (msg 19): total_timer_time(8,4), total_distance(9,4), avg_heart_rate(15,1), avg_cadence(17,1), total_ascent(21,2)
  bytes.push(0x41, 0, 0);
  pushU16(19);
  bytes.push(5);
  bytes.push(8, 4, 0x86, 9, 4, 0x86, 15, 1, 0x02, 17, 1, 0x02, 21, 2, 0x84);

  // Two 1km laps
  bytes.push(0x01);
  pushU32(300_000);
  pushU32(100_000);
  bytes.push(152, 86);
  pushU16(25);

  bytes.push(0x01);
  pushU32(285_000);
  pushU32(100_000);
  bytes.push(164, 89);
  pushU16(10);

  const dataSize = bytes.length - 14;
  bytes[0] = 14;
  bytes[1] = 0x20;
  bytes[2] = 0;
  bytes[3] = 0;
  bytes[4] = dataSize & 0xff;
  bytes[5] = (dataSize >> 8) & 0xff;
  bytes[6] = (dataSize >> 16) & 0xff;
  bytes[7] = (dataSize >>> 24) & 0xff;
  bytes[8] = 0x2e;
  bytes[9] = 0x46;
  bytes[10] = 0x49;
  bytes[11] = 0x54;
  bytes[12] = 0;
  bytes[13] = 0;
  bytes.push(0, 0);
  return new Uint8Array(bytes);
}

describe("Multi-Sport FIT Reader & Running Physiology Engine", () => {
  it("decodes running sport, trail sub-sport, total distance/ascent, and FIT lap splits", () => {
    const parsed = parseFitRecords(buildSyntheticRunFitWithLaps());
    expect(parsed.sport).toBe("running");
    expect(parsed.subSportName).toBe("trail");
    expect(parsed.totalDistanceM).toBe(5000);
    expect(parsed.totalAscentM).toBe(120);
    expect(parsed.totalTimerTimeS).toBe(1800);
    expect(parsed.laps).toHaveLength(2);
    expect(parsed.laps[0]?.distance_m).toBe(1000);
    expect(parsed.laps[0]?.avg_pace_s_per_km).toBeCloseTo(300, 0);
    expect(parsed.laps[1]?.avg_hr).toBe(164);
  });

  it("computes faster GAP than raw pace on climbs, cardiac drift Pa:HR, rTSS, best efforts, and auto 1km splits", () => {
    expect(computeRunningGradeFactor(0)).toBeCloseTo(1.0, 2);
    expect(computeRunningGradeFactor(6)).toBeGreaterThan(1.2);
    expect(computeRunningGradeFactor(-6)).toBeLessThan(0.95);

    // 40-minute steady uphill run (2400s @ 3.333 m/s = 8000m, +4% climb, HR drifting 148 -> 164)
    const samples: TelemetrySample[] = [];
    for (let t = 0; t < 2400; t++) {
      const dist = t * 3.3333;
      const elev = 100 + dist * 0.04;
      const hr = Math.round(148 + (t / 2400) * 16);
      samples.push({
        t_s: t,
        watts: null,
        hr_bpm: hr,
        cadence_rpm: 87, // single-foot FIT cadence -> should normalize to 174 spm
        speed_kph: 12.0, // 300 s/km raw pace
        distance_m: dist,
        elevation_m: elev,
      });
    }

    const res = computeRunningMetrics(samples, {
      threshold_pace_s_per_km: 270,
      lthr_bpm: 170,
      hrmax_bpm: 190,
    });

    expect(res.distance_m).toBeGreaterThan(7900);
    expect(res.elevation_gain_m).toBeGreaterThan(300);
    expect(res.avg_pace_s_per_km).toBeCloseTo(300, 0);
    // Climbing +4% should yield noticeably faster Grade Adjusted Pace (< 275 s/km)
    expect(res.gap_s_per_km).not.toBeNull();
    expect(res.gap_s_per_km!).toBeLessThan(275);
    // HR drifted significantly upward at constant effort -> positive Pa:HR decoupling
    expect(res.pa_hr_decoupling).not.toBeNull();
    expect(res.pa_hr_decoupling!).toBeGreaterThan(4);
    expect(res.avg_cadence_spm).toBe(174);
    expect(res.tss_method).toBe("rtss");
    expect(res.tss).toBeGreaterThan(50);
    // Auto 1km splits + best efforts (400m, 1000m, 5000m)
    expect(res.laps.length).toBeGreaterThanOrEqual(7);
    expect(res.best_efforts.map((e) => e.distance_m)).toEqual([400, 1000, 5000]);
  });

  it("falls back cleanly to hrTSS on treadmill runs without GPS or speed streams", () => {
    const samples: TelemetrySample[] = [];
    for (let t = 0; t < 1800; t++) {
      samples.push({
        t_s: t,
        watts: null,
        hr_bpm: 155,
        cadence_rpm: 172,
        speed_kph: null,
      });
    }

    const res = computeRunningMetrics(samples, {
      lthr_bpm: 170,
      hrmax_bpm: 190,
    });

    expect(res.avg_pace_s_per_km).toBeNull();
    expect(res.tss_method).toBe("hrtss");
    expect(res.tss).toBeGreaterThan(25);
    expect(res.avg_cadence_spm).toBe(172);
  });
});
