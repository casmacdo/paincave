import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROUTE_PRESETS,
  extractRouteFromSamples,
  parseGpxRoute,
} from "../gpx.js";

describe("GPX & FIT Route Parsing", () => {
  it("parses GPX track points, computes haversine distance, ascent, and max grade", () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PainCaveTest">
  <trk>
    <name>Local Hill Climb</name>
    <trkseg>
      <trkpt lat="45.0000" lon="6.0000"><ele>500.0</ele></trkpt>
      <trkpt lat="45.0010" lon="6.0000"><ele>509.0</ele></trkpt>
      <trkpt lat="45.0020" lon="6.0000"><ele>518.0</ele></trkpt>
      <trkpt lat="45.0030" lon="6.0000"><ele>510.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const route = parseGpxRoute(gpx, "fallback.gpx");
    expect(route.name).toBe("Local Hill Climb");
    expect(route.points).toHaveLength(4);
    expect(route.distance_m).toBeGreaterThan(320);
    expect(route.distance_m).toBeLessThan(350);
    expect(route.total_ascent_m).toBeGreaterThan(12);
    expect(route.total_descent_m).toBeGreaterThan(3);
    expect(route.max_grade_pct).toBeGreaterThan(6.0);
  });

  it("extracts a GPS route from FIT telemetry samples and validates presets", () => {
    const samples = [
      { t_s: 0, watts: 200, hr_bpm: 140, cadence_rpm: 90, lat_deg: 46.0, lon_deg: 7.0, elevation_m: 800 },
      { t_s: 1, watts: 210, hr_bpm: 142, cadence_rpm: 90, lat_deg: 46.001, lon_deg: 7.0, elevation_m: 808 },
      { t_s: 2, watts: 215, hr_bpm: 145, cadence_rpm: 88, lat_deg: 46.002, lon_deg: 7.0, elevation_m: 816 },
    ];
    const extracted = extractRouteFromSamples(samples, "Outdoor Climb");
    expect(extracted.name).toBe("Outdoor Climb");
    expect(extracted.points.length).toBe(3);
    expect(extracted.total_ascent_m).toBeCloseTo(16, 0);

    expect(BUILT_IN_ROUTE_PRESETS.length).toBeGreaterThanOrEqual(4);
    const alpine = BUILT_IN_ROUTE_PRESETS.find((p) => p.id === "preset-alpine-climb");
    expect(alpine).toBeDefined();
    expect(alpine?.total_ascent_m).toBeGreaterThan(600);
    expect(alpine?.distance_m).toBeGreaterThan(8000);
  });
});
