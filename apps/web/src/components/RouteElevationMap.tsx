import { useMemo } from "react";
import { haversineMeters, type RoutePoint } from "@paincave/shared";

export interface RouteElevationMapProps {
  name: string;
  points: readonly RoutePoint[];
  loopRoute?: boolean;
  simMode?: boolean;
  trainerDifficultyPct?: number;
  currentDistanceM?: number | null;
  currentGradePct?: number | null;
  currentElevationM?: number | null;
  speedKph?: number | null;
  compact?: boolean;
}

function gradeColor(gradePct: number): string {
  if (gradePct >= 10) return "#ef4444"; // red-500
  if (gradePct >= 7) return "#f97316"; // orange-500
  if (gradePct >= 5) return "#eab308"; // yellow-500
  if (gradePct >= 3) return "#84cc16"; // lime-500
  if (gradePct >= -1) return "#10b981"; // emerald-500
  return "#38bdf8"; // sky-400 descent
}

function gradeBadgeClass(gradePct: number): string {
  if (gradePct >= 10) return "bg-red-500/20 text-red-300 border-red-500/40";
  if (gradePct >= 7) return "bg-orange-500/20 text-orange-300 border-orange-500/40";
  if (gradePct >= 5) return "bg-yellow-500/20 text-yellow-200 border-yellow-500/40";
  if (gradePct >= 3) return "bg-lime-500/20 text-lime-300 border-lime-500/40";
  if (gradePct >= -1) return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  return "bg-sky-500/20 text-sky-300 border-sky-500/40";
}

interface ComputedProfile {
  cumDistM: number[];
  totalDistM: number;
  totalAscentM: number;
  minElevM: number;
  maxElevM: number;
  grades: number[];
}

function computeProfile(points: readonly RoutePoint[]): ComputedProfile {
  const cumDistM: number[] = [0];
  const grades: number[] = [];
  let totalDistM = 0;
  let totalAscentM = 0;
  let minElevM = points[0]?.elevation_m ?? 0;
  let maxElevM = points[0]?.elevation_m ?? 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) continue;
    const segM = Math.max(0.5, haversineMeters(prev, cur));
    totalDistM += segM;
    cumDistM.push(totalDistM);
    const dElev = cur.elevation_m - prev.elevation_m;
    if (dElev > 0) totalAscentM += dElev;
    minElevM = Math.min(minElevM, cur.elevation_m);
    maxElevM = Math.max(maxElevM, cur.elevation_m);
    grades.push(Math.max(-15, Math.min(22, (dElev / segM) * 100)));
  }

  return { cumDistM, totalDistM, totalAscentM, minElevM, maxElevM, grades };
}

export function RouteElevationMap({
  name,
  points,
  loopRoute = false,
  simMode = false,
  trainerDifficultyPct,
  currentDistanceM = null,
  currentGradePct = null,
  currentElevationM = null,
  speedKph = null,
  compact = false,
}: RouteElevationMapProps) {
  const profile = useMemo(() => computeProfile(points), [points]);

  const { elevWidth, elevHeight, mapWidth, mapHeight } = compact
    ? { elevWidth: 520, elevHeight: 110, mapWidth: 160, mapHeight: 110 }
    : { elevWidth: 640, elevHeight: 150, mapWidth: 210, mapHeight: 150 };

  const mappedDistM = useMemo(() => {
    if (currentDistanceM === null || profile.totalDistM <= 0) return null;
    if (loopRoute) {
      return ((currentDistanceM % profile.totalDistM) + profile.totalDistM) % profile.totalDistM;
    }
    return Math.max(0, Math.min(profile.totalDistM, currentDistanceM));
  }, [currentDistanceM, loopRoute, profile.totalDistM]);

  // Interpolate rider lat/lon/elev along polyline
  const riderPoint = useMemo(() => {
    if (mappedDistM === null || points.length < 2) return null;
    for (let i = 1; i < profile.cumDistM.length; i++) {
      const d0 = profile.cumDistM[i - 1] ?? 0;
      const d1 = profile.cumDistM[i] ?? d0;
      if (mappedDistM <= d1 || i === profile.cumDistM.length - 1) {
        const p0 = points[i - 1];
        const p1 = points[i];
        if (!p0 || !p1) return null;
        const frac = d1 > d0 ? Math.max(0, Math.min(1, (mappedDistM - d0) / (d1 - d0))) : 0;
        return {
          lat_deg: p0.lat_deg + (p1.lat_deg - p0.lat_deg) * frac,
          lon_deg: p0.lon_deg + (p1.lon_deg - p0.lon_deg) * frac,
          elevation_m: p0.elevation_m + (p1.elevation_m - p0.elevation_m) * frac,
          distM: mappedDistM,
        };
      }
    }
    return null;
  }, [mappedDistM, points, profile.cumDistM]);

  // Compute elevation SVG coordinates
  const padX = 8;
  const padTop = 14;
  const padBottom = 18;
  const plotW = elevWidth - padX * 2;
  const plotH = elevHeight - padTop - padBottom;
  const elevSpan = Math.max(20, profile.maxElevM - profile.minElevM);
  const elevMin = profile.minElevM - elevSpan * 0.08;
  const elevMax = profile.maxElevM + elevSpan * 0.12;

  const xForDist = (d: number) =>
    profile.totalDistM > 0 ? padX + (d / profile.totalDistM) * plotW : padX;
  const yForElev = (e: number) =>
    padTop + plotH - ((e - elevMin) / Math.max(1, elevMax - elevMin)) * plotH;

  // Compute 2D GPS map projection
  const mapProjection = useMemo(() => {
    if (points.length < 2) return null;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const p of points) {
      minLat = Math.min(minLat, p.lat_deg);
      maxLat = Math.max(maxLat, p.lat_deg);
      minLon = Math.min(minLon, p.lon_deg);
      maxLon = Math.max(maxLon, p.lon_deg);
    }
    const meanLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
    const cosLat = Math.max(0.2, Math.cos(meanLatRad));
    const spanLon = Math.max(1e-5, (maxLon - minLon) * cosLat);
    const spanLat = Math.max(1e-5, maxLat - minLat);
    const mPad = 14;
    const availW = mapWidth - mPad * 2;
    const availH = mapHeight - mPad * 2;
    const scale = Math.min(availW / spanLon, availH / spanLat);
    const drawnW = spanLon * scale;
    const drawnH = spanLat * scale;
    const offsetX = mPad + (availW - drawnW) / 2;
    const offsetY = mPad + (availH - drawnH) / 2;

    const project = (pt: { lat_deg: number; lon_deg: number }) => ({
      x: offsetX + (pt.lon_deg - minLon) * cosLat * scale,
      y: offsetY + (maxLat - pt.lat_deg) * scale,
    });

    const polyline = points
      .map((p) => {
        const xy = project(p);
        return `${xy.x.toFixed(1)},${xy.y.toFixed(1)}`;
      })
      .join(" ");

    return { project, polyline, start: project(points[0]!) };
  }, [points, mapWidth, mapHeight]);

  if (points.length < 2) {
    return null;
  }

  const displayGrade = currentGradePct;
  const displayElev = currentElevationM ?? riderPoint?.elevation_m ?? null;

  return (
    <div
      data-testid="route-elevation-map"
      className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold text-white">{name}</h3>
          <span
            className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
              simMode
                ? "border-orange-500/40 bg-orange-500/15 text-orange-300"
                : "border-sky-500/40 bg-sky-500/15 text-sky-300"
            }`}
          >
            {simMode
              ? `SIM${trainerDifficultyPct ? ` · ${trainerDifficultyPct}%` : ""}`
              : "Virtual Route"}
          </span>
          {loopRoute && (
            <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
              Loop
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-zinc-300">
          <span>
            {(profile.totalDistM / 1000).toFixed(1)} km · +{Math.round(profile.totalAscentM)} m
          </span>
          {currentDistanceM !== null && (
            <span className="text-zinc-400">
              Ridden: <strong className="text-white">{(currentDistanceM / 1000).toFixed(2)} km</strong>
            </span>
          )}
          {speedKph !== null && (
            <span className="text-zinc-400">
              Speed: <strong className="text-white">{speedKph.toFixed(1)} kph</strong>
            </span>
          )}
          {displayElev !== null && (
            <span className="text-zinc-400">
              Elev: <strong className="text-white">{Math.round(displayElev)} m</strong>
            </span>
          )}
          {displayGrade !== null && (
            <span
              className={`rounded-md border px-2 py-0.5 font-bold ${gradeBadgeClass(displayGrade)}`}
            >
              {displayGrade >= 0 ? "+" : ""}
              {displayGrade.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        {/* Grade-colored Elevation Profile */}
        <svg
          viewBox={`0 0 ${elevWidth} ${elevHeight}`}
          aria-label={`Elevation profile for ${name}`}
          className="w-full rounded-xl bg-zinc-950/80"
        >
          {profile.grades.map((grade, idx) => {
            const p0 = points[idx];
            const p1 = points[idx + 1];
            const d0 = profile.cumDistM[idx];
            const d1 = profile.cumDistM[idx + 1];
            if (!p0 || !p1 || d0 === undefined || d1 === undefined) return null;
            const x0 = xForDist(d0);
            const x1 = xForDist(d1);
            const y0 = yForElev(p0.elevation_m);
            const y1 = yForElev(p1.elevation_m);
            const baseY = padTop + plotH;
            const color = gradeColor(grade);
            return (
              <g key={idx}>
                <polygon
                  points={`${x0.toFixed(1)},${baseY.toFixed(1)} ${x0.toFixed(1)},${y0.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${baseY.toFixed(1)}`}
                  fill={color}
                  fillOpacity={0.28}
                />
                <line
                  x1={x0}
                  y1={y0}
                  x2={x1}
                  y2={y1}
                  stroke={color}
                  strokeWidth={2.2}
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          {/* Axis labels */}
          <text x={padX} y={elevHeight - 4} fill="#71717a" fontSize={10}>
            0 km · {Math.round(profile.minElevM)}m–{Math.round(profile.maxElevM)}m
          </text>
          <text
            x={elevWidth - padX}
            y={elevHeight - 4}
            fill="#71717a"
            fontSize={10}
            textAnchor="end"
          >
            {(profile.totalDistM / 1000).toFixed(1)} km
          </text>

          {/* Live Rider Position */}
          {riderPoint && (
            <g data-testid="route-rider-marker">
              <line
                x1={xForDist(riderPoint.distM)}
                y1={padTop}
                x2={xForDist(riderPoint.distM)}
                y2={padTop + plotH}
                stroke="#ffffff"
                strokeWidth={1.2}
                strokeDasharray="3 3"
                strokeOpacity={0.7}
              />
              <circle
                cx={xForDist(riderPoint.distM)}
                cy={yForElev(riderPoint.elevation_m)}
                r={5}
                fill="#f97316"
                stroke="#ffffff"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>

        {/* 2D GPS Route Trace */}
        {mapProjection && (
          <svg
            viewBox={`0 0 ${mapWidth} ${mapHeight}`}
            aria-label={`Route map for ${name}`}
            className="w-full rounded-xl bg-zinc-950/80 md:w-52"
          >
            <polyline
              points={mapProjection.polyline}
              fill="none"
              stroke="#52525b"
              strokeWidth={3}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle
              cx={mapProjection.start.x}
              cy={mapProjection.start.y}
              r={3.5}
              fill="#10b981"
            />
            {riderPoint && (() => {
              const xy = mapProjection.project(riderPoint);
              return (
                <circle
                  cx={xy.x}
                  cy={xy.y}
                  r={5}
                  fill="#f97316"
                  stroke="#ffffff"
                  strokeWidth={2}
                />
              );
            })()}
          </svg>
        )}
      </div>
    </div>
  );
}
