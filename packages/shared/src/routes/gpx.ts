import type { TelemetrySample } from "../physiology/metrics.js";
import type { RoutePoint } from "../protocol/bridge.js";

export interface AnalyzedRoute {
  name: string;
  points: RoutePoint[];
  distance_m: number;
  total_ascent_m: number;
  total_descent_m: number;
  max_grade_pct: number;
  min_elevation_m: number;
  max_elevation_m: number;
}

export interface BuiltInRoutePreset extends AnalyzedRoute {
  id: string;
  description: string;
  loop_route: boolean;
}

export function haversineMeters(a: RoutePoint, b: RoutePoint): number {
  const EARTH_RADIUS_M = 6_371_000;
  const lat1 = (a.lat_deg * Math.PI) / 180;
  const lat2 = (b.lat_deg * Math.PI) / 180;
  const dLat = ((b.lat_deg - a.lat_deg) * Math.PI) / 180;
  const dLon = ((b.lon_deg - a.lon_deg) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function smoothElevations(points: readonly RoutePoint[]): RoutePoint[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  const out = points.map((p) => ({ ...p }));
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const target = out[i];
    if (prev && cur && next && target) {
      target.elevation_m = Number(
        (0.25 * prev.elevation_m + 0.5 * cur.elevation_m + 0.25 * next.elevation_m).toFixed(2)
      );
    }
  }
  return out;
}

function downsamplePoints(points: readonly RoutePoint[], maxPoints: number): RoutePoint[] {
  if (points.length <= maxPoints) return points.map((p) => ({ ...p }));
  const out: RoutePoint[] = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(points.length - 1, Math.round(i * step));
    const pt = points[idx];
    if (pt) out.push({ ...pt });
  }
  return out;
}

export function analyzeRoutePoints(
  rawPoints: readonly RoutePoint[],
  name: string,
  maxPoints = 900
): AnalyzedRoute {
  const filtered: RoutePoint[] = [];
  for (const pt of rawPoints) {
    if (
      !Number.isFinite(pt.lat_deg) ||
      !Number.isFinite(pt.lon_deg) ||
      !Number.isFinite(pt.elevation_m) ||
      pt.lat_deg < -90 ||
      pt.lat_deg > 90 ||
      pt.lon_deg < -180 ||
      pt.lon_deg > 180 ||
      pt.elevation_m < -500 ||
      pt.elevation_m > 9000
    ) {
      continue;
    }
    const prev = filtered.at(-1);
    if (prev && haversineMeters(prev, pt) < 1.0) {
      continue;
    }
    filtered.push({
      lat_deg: Number(pt.lat_deg.toFixed(6)),
      lon_deg: Number(pt.lon_deg.toFixed(6)),
      elevation_m: Number(pt.elevation_m.toFixed(2)),
    });
  }

  if (filtered.length < 2) {
    throw new Error("Route must contain at least 2 distinct GPS points");
  }

  const downsampled = downsamplePoints(filtered, maxPoints);
  const smoothed = smoothElevations(downsampled);

  let distanceM = 0;
  let totalAscentM = 0;
  let totalDescentM = 0;
  let maxGradePct = 0;
  let minElev = smoothed[0]?.elevation_m ?? 0;
  let maxElev = smoothed[0]?.elevation_m ?? 0;

  for (let i = 0; i < smoothed.length; i++) {
    const cur = smoothed[i];
    if (!cur) continue;
    minElev = Math.min(minElev, cur.elevation_m);
    maxElev = Math.max(maxElev, cur.elevation_m);
    if (i === 0) continue;
    const prev = smoothed[i - 1];
    if (!prev) continue;
    const segM = haversineMeters(prev, cur);
    if (segM < 0.5) continue;
    distanceM += segM;
    const dElev = cur.elevation_m - prev.elevation_m;
    if (dElev > 0) totalAscentM += dElev;
    else if (dElev < 0) totalDescentM += -dElev;
    const grade = Math.min(22, Math.max(-15, (dElev / segM) * 100));
    if (grade > maxGradePct) maxGradePct = grade;
  }

  if (distanceM <= 0) {
    throw new Error("Route has zero horizontal distance");
  }

  return {
    name: name.trim().slice(0, 140) || "Imported Route",
    points: smoothed,
    distance_m: Number(distanceM.toFixed(1)),
    total_ascent_m: Number(totalAscentM.toFixed(1)),
    total_descent_m: Number(totalDescentM.toFixed(1)),
    max_grade_pct: Number(maxGradePct.toFixed(1)),
    min_elevation_m: Number(minElev.toFixed(1)),
    max_elevation_m: Number(maxElev.toFixed(1)),
  };
}

/**
 * Parses a standard `.gpx` XML file (`<trkpt>` or `<rtept>`) into a smoothed, resampled route.
 */
export function parseGpxRoute(gpxXml: string, fallbackName = "Imported GPX Route"): AnalyzedRoute {
  const nameMatch = /<trk\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i.exec(gpxXml)
    ?? /<metadata\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i.exec(gpxXml)
    ?? /<name\b[^>]*>([\s\S]*?)<\/name>/i.exec(gpxXml);
  const parsedName = nameMatch?.[1] ? unescapeXml(nameMatch[1].trim()) : "";
  const resolvedName = parsedName || fallbackName.replace(/\.gpx$/i, "").replace(/[_-]+/g, " ").trim() || "Imported GPX Route";

  const rawPoints: RoutePoint[] = [];
  const ptRe = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  let match: RegExpExecArray | null;
  while ((match = ptRe.exec(gpxXml)) !== null) {
    const attrStr = match[2] ?? "";
    const inner = match[3] ?? "";
    const latMatch = /\blat\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrStr);
    const lonMatch = /\blon\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrStr);
    const lat = Number(latMatch?.[1] ?? latMatch?.[2]);
    const lon = Number(lonMatch?.[1] ?? lonMatch?.[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const eleMatch = /<ele\b[^>]*>([\s\S]*?)<\/ele>/i.exec(inner);
    const ele = eleMatch?.[1] ? Number(eleMatch[1].trim()) : 0;
    rawPoints.push({
      lat_deg: lat,
      lon_deg: lon,
      elevation_m: Number.isFinite(ele) ? ele : 0,
    });
  }

  if (rawPoints.length < 2) {
    throw new Error("GPX file contains fewer than 2 valid track points");
  }

  return analyzeRoutePoints(rawPoints, resolvedName);
}

/**
 * Extracts a reusable route from parsed FIT telemetry samples containing GPS coordinates.
 */
export function extractRouteFromSamples(
  samples: readonly TelemetrySample[],
  name: string
): AnalyzedRoute {
  const rawPoints: RoutePoint[] = [];
  for (const s of samples) {
    if (
      typeof s.lat_deg === "number" &&
      typeof s.lon_deg === "number" &&
      Number.isFinite(s.lat_deg) &&
      Number.isFinite(s.lon_deg)
    ) {
      rawPoints.push({
        lat_deg: s.lat_deg,
        lon_deg: s.lon_deg,
        elevation_m: typeof s.elevation_m === "number" && Number.isFinite(s.elevation_m) ? s.elevation_m : 0,
      });
    }
  }
  if (rawPoints.length < 2) {
    throw new Error("Ride FIT file does not contain a GPS track");
  }
  return analyzeRoutePoints(rawPoints, name);
}

function buildOvalPreset(
  id: string,
  name: string,
  description: string,
  radiusLatDeg: number,
  radiusLonDeg: number,
  steps: number,
  elevationFn: (frac: number) => number
): BuiltInRoutePreset {
  const points: RoutePoint[] = [];
  const centerLat = 0.05;
  const centerLon = 0.05;
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const angle = frac * Math.PI * 2;
    points.push({
      lat_deg: centerLat + Math.sin(angle) * radiusLatDeg,
      lon_deg: centerLon + Math.cos(angle) * radiusLonDeg,
      elevation_m: elevationFn(frac),
    });
  }
  const analyzed = analyzeRoutePoints(points, name);
  return {
    id,
    description,
    loop_route: true,
    ...analyzed,
  };
}

function buildSwitchbackClimbPreset(): BuiltInRoutePreset {
  const points: RoutePoint[] = [];
  const steps = 120;
  let lat = 0.08;
  let lon = 0.08;
  let elev = 420;
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    // 10km climb with gentle switchback bends and realistic 6.5–10.5% ramps
    const switchback = Math.sin(frac * Math.PI * 10) * 0.0022;
    lat = 0.08 + frac * 0.085;
    lon = 0.08 + switchback;
    const gradePct = 7.2 + 2.4 * Math.sin(frac * Math.PI * 6) + (frac > 0.78 ? 1.8 : 0);
    if (i > 0) {
      const prev = points[i - 1];
      if (prev) {
        const segM = haversineMeters(prev, { lat_deg: lat, lon_deg: lon, elevation_m: elev });
        elev += (segM * gradePct) / 100;
      }
    }
    points.push({ lat_deg: lat, lon_deg: lon, elevation_m: elev });
  }
  const analyzed = analyzeRoutePoints(points, "HC Alpine Switchbacks");
  return {
    id: "preset-alpine-climb",
    description: "Sustained Hors Catégorie mountain climb with 7–11% switchbacks (~800 m gain).",
    loop_route: false,
    ...analyzed,
  };
}

export const BUILT_IN_ROUTE_PRESETS: readonly BuiltInRoutePreset[] = [
  buildOvalPreset(
    "preset-flat-tt",
    "Flat Tempo Loop",
    "Fast 10 km circuit with gentle <1.5% false flats for tempo, sweet spot, and TT pacing.",
    0.0145,
    0.0145,
    96,
    (f) => 50 + 8 * Math.sin(f * Math.PI * 2) + 3 * Math.sin(f * Math.PI * 6)
  ),
  buildOvalPreset(
    "preset-rolling-hills",
    "Rolling Punchers Circuit",
    "12 km undulating circuit with punchy 4–6% rises and fast descents.",
    0.0175,
    0.0175,
    120,
    (f) =>
      120 +
      42 * Math.sin(f * Math.PI * 2) +
      26 * Math.sin(f * Math.PI * 6) +
      14 * Math.cos(f * Math.PI * 10)
  ),
  buildSwitchbackClimbPreset(),
  {
    id: "preset-neutral-loop",
    description: "Compact 2 km neutral synthetic loop matching the default bridge route.",
    loop_route: true,
    ...analyzeRoutePoints(
      [
        { lat_deg: 0.01, lon_deg: 0.01, elevation_m: 100 },
        { lat_deg: 0.0145, lon_deg: 0.01, elevation_m: 118 },
        { lat_deg: 0.0145, lon_deg: 0.0145, elevation_m: 128 },
        { lat_deg: 0.01, lon_deg: 0.0145, elevation_m: 112 },
        { lat_deg: 0.01, lon_deg: 0.01, elevation_m: 100 },
      ],
      "Neutral Test Loop"
    ),
  },
];

export function getBuiltInRoutePreset(id: string): BuiltInRoutePreset | undefined {
  return BUILT_IN_ROUTE_PRESETS.find((preset) => preset.id === id);
}
