import { useState } from "react";
import type { FitnessOverviewResponse } from "../lib/api.js";

export interface RideTimeseriesPoint {
  t_s: number;
  watts: number | null;
  hr_bpm: number | null;
  cadence_rpm: number | null;
  speed_kph: number | null;
}

function formatDurationTick(durationS: number): string {
  if (durationS < 60) return `${durationS}s`;
  return `${durationS / 60}m`;
}

function formatClockShort(totalS: number): string {
  const mins = Math.floor(totalS / 60);
  const secs = totalS % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function PmcChart({ data }: { data: FitnessOverviewResponse["daily_pmc"] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center rounded-xl bg-zinc-950/70 text-xs text-zinc-500">
        Record or upload rides to plot CTL / ATL / TSB trends.
      </div>
    );
  }

  const width = 760;
  const height = 210;
  const pad = { top: 16, right: 16, bottom: 26, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const allVals = data.flatMap((d) => [d.ctl, d.atl, d.tsb, 0]);
  const minY = Math.min(-15, Math.floor(Math.min(...allVals) / 10) * 10);
  const maxY = Math.max(20, Math.ceil(Math.max(...allVals) / 10) * 10);
  const spanY = Math.max(1, maxY - minY);

  const xOf = (idx: number) =>
    data.length === 1 ? pad.left + plotW / 2 : pad.left + (idx / (data.length - 1)) * plotW;
  const yOf = (val: number) => pad.top + ((maxY - val) / spanY) * plotH;
  const zeroY = yOf(0);

  const toPath = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");

  const ctlPath = toPath(data.map((d) => d.ctl));
  const atlPath = toPath(data.map((d) => d.atl));
  const tsbPath = toPath(data.map((d) => d.tsb));
  const tsbArea =
    data.length > 1
      ? `${tsbPath} L${xOf(data.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${xOf(0).toFixed(1)},${zeroY.toFixed(1)} Z`
      : "";

  const active = hoverIdx !== null ? (data[hoverIdx] ?? null) : null;

  return (
    <div className="space-y-2" data-testid="pmc-chart">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-4 text-zinc-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-sky-400" /> CTL (Fitness)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-rose-400" /> ATL (Fatigue)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400" /> TSB (Form)
          </span>
        </div>
        {active && (
          <div className="font-mono text-[11px] text-zinc-200">
            {active.day} · TSS {Math.round(active.total_tss)} · CTL {active.ctl.toFixed(1)} · ATL{" "}
            {active.atl.toFixed(1)} · TSB {active.tsb.toFixed(1)}
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90"
        onMouseLeave={() => setHoverIdx(null)}
        aria-label="Performance Management Chart"
      >
        {[minY, 0, maxY].map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              y1={yOf(tick)}
              x2={width - pad.right}
              y2={yOf(tick)}
              stroke={tick === 0 ? "var(--pc-chart-zero)" : "var(--pc-chart-grid)"}
              strokeDasharray={tick === 0 ? "4 4" : undefined}
            />
            <text x={pad.left - 6} y={yOf(tick) + 4} textAnchor="end" fontSize="10" fill="var(--pc-chart-axis)">
              {tick}
            </text>
          </g>
        ))}

        {tsbArea && <path d={tsbArea} fill="#10b981" fillOpacity={0.14} />}
        <path d={tsbPath} fill="none" stroke="#10b981" strokeWidth={1.6} />
        <path d={atlPath} fill="none" stroke="#fb7185" strokeWidth={1.8} />
        <path d={ctlPath} fill="none" stroke="#38bdf8" strokeWidth={2.4} />

        {active && hoverIdx !== null && (
          <line
            x1={xOf(hoverIdx)}
            y1={pad.top}
            x2={xOf(hoverIdx)}
            y2={height - pad.bottom}
            stroke="var(--pc-chart-cursor)"
            strokeDasharray="3 3"
          />
        )}

        {/* X axis labels */}
        {[0, Math.floor((data.length - 1) / 2), data.length - 1]
          .filter((idx, i, arr) => arr.indexOf(idx) === i)
          .map((idx) => (
            <text
              key={idx}
              x={xOf(idx)}
              y={height - 8}
              textAnchor={idx === 0 ? "start" : idx === data.length - 1 ? "end" : "middle"}
              fontSize="10"
              fill="var(--pc-chart-axis)"
            >
              {data[idx]?.day.slice(5)}
            </text>
          ))}

        {/* Hover hit targets */}
        {data.map((pt, idx) => {
          const sliceW = plotW / Math.max(1, data.length);
          return (
            <rect
              key={pt.day}
              x={xOf(idx) - sliceW / 2}
              y={pad.top}
              width={Math.max(6, sliceW)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(idx)}
            />
          );
        })}
      </svg>
    </div>
  );
}

export function MmpCurveChart({
  mmp42,
  mmp90,
}: {
  mmp42: FitnessOverviewResponse["mmp_42d"];
  mmp90: FitnessOverviewResponse["mmp_90d"];
}) {
  const [hoverDuration, setHoverDuration] = useState<number | null>(null);

  const durations = [...new Set([...mmp42, ...mmp90].map((p) => p.duration_s))].sort(
    (a, b) => a - b
  );
  if (durations.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl bg-zinc-950/70 text-xs text-zinc-500">
        No peak power data recorded yet.
      </div>
    );
  }

  const width = 560;
  const height = 200;
  const pad = { top: 16, right: 18, bottom: 26, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const map42 = new Map(mmp42.map((p) => [p.duration_s, p]));
  const map90 = new Map(mmp90.map((p) => [p.duration_s, p]));
  const minLog = Math.log(durations[0] ?? 5);
  const maxLog = Math.log(durations.at(-1) ?? 3600);
  const logSpan = Math.max(0.01, maxLog - minLog);
  const maxW = Math.max(250, ...mmp42.map((p) => p.watts), ...mmp90.map((p) => p.watts));
  const yCeiling = Math.ceil(maxW / 50) * 50;

  const xOf = (dur: number) => pad.left + ((Math.log(dur) - minLog) / logSpan) * plotW;
  const yOf = (watts: number) => pad.top + ((yCeiling - watts) / yCeiling) * plotH;

  const buildPath = (series: typeof mmp42) =>
    series
      .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.duration_s).toFixed(1)},${yOf(p.watts).toFixed(1)}`)
      .join(" ");

  const p42 = hoverDuration !== null ? map42.get(hoverDuration) : undefined;
  const p90 = hoverDuration !== null ? map90.get(hoverDuration) : undefined;

  return (
    <div className="space-y-2" data-testid="mmp-chart">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-4 text-zinc-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-orange-400" /> 42-day Peak
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-zinc-400" /> 90-day Peak
          </span>
        </div>
        {hoverDuration !== null && (
          <div className="font-mono text-[11px] text-zinc-200">
            {formatDurationTick(hoverDuration)}: 42d {p42 ? `${p42.watts}W` : "--"}
            {p42?.w_per_kg ? ` (${p42.w_per_kg} W/kg)` : ""} · 90d {p90 ? `${p90.watts}W` : "--"}
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90"
        onMouseLeave={() => setHoverDuration(null)}
        aria-label="Mean Maximal Power Curve"
      >
        {[0, Math.round(yCeiling / 2), yCeiling].map((tick) => (
          <g key={tick}>
            <line x1={pad.left} y1={yOf(tick)} x2={width - pad.right} y2={yOf(tick)} stroke="var(--pc-chart-grid)" />
            <text x={pad.left - 6} y={yOf(tick) + 4} textAnchor="end" fontSize="10" fill="var(--pc-chart-axis)">
              {tick}W
            </text>
          </g>
        ))}

        {mmp90.length > 0 && (
          <path d={buildPath(mmp90)} fill="none" stroke="var(--pc-chart-cursor)" strokeWidth={1.6} strokeDasharray="4 4" />
        )}
        {mmp42.length > 0 && (
          <path d={buildPath(mmp42)} fill="none" stroke="#f97316" strokeWidth={2.5} />
        )}

        {durations.map((dur) => {
          const x = xOf(dur);
          const pt42 = map42.get(dur);
          const active = hoverDuration === dur;
          return (
            <g key={dur} onMouseEnter={() => setHoverDuration(dur)} className="cursor-pointer">
              <rect x={x - 14} y={pad.top} width={28} height={plotH} fill="transparent" />
              {pt42 && (
                <circle
                  cx={x}
                  cy={yOf(pt42.watts)}
                  r={active ? 5 : 3}
                  fill="#f97316"
                  stroke="var(--pc-chart-dot-stroke)"
                  strokeWidth={1.5}
                />
              )}
              <text x={x} y={height - 8} textAnchor="middle" fontSize="9.5" fill="var(--pc-chart-axis)">
                {formatDurationTick(dur)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function WeeklyLoadChart({
  weeks,
}: {
  weeks: FitnessOverviewResponse["weekly_rollups"];
}) {
  if (weeks.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl bg-zinc-950/70 text-xs text-zinc-500">
        No weekly training volume recorded yet.
      </div>
    );
  }

  const maxTss = Math.max(100, ...weeks.map((w) => w.tss));
  return (
    <div className="space-y-2" data-testid="weekly-load-chart">
      <div className="flex items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 pb-3 pt-5">
        {weeks.slice(-10).map((w) => {
          const pct = Math.max(6, Math.round((w.tss / maxTss) * 100));
          return (
            <div key={w.week_start} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-[10px] font-semibold tabular-nums text-orange-300">
                {Math.round(w.tss)}
              </span>
              <div className="flex h-28 w-full items-end justify-center">
                <div
                  className="w-full max-w-[36px] rounded-t-md bg-orange-500/80 transition hover:bg-orange-400"
                  style={{ height: `${pct}%` }}
                  title={`Week of ${w.week_start}: ${Math.round(w.tss)} TSS · ${w.hours}h · ${w.rides} ride(s)`}
                />
              </div>
              <span className="text-[10px] tabular-nums text-zinc-500">{w.hours}h</span>
              <span className="text-[9px] font-mono text-zinc-500">{w.week_start.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RideTimeseriesChart({ points }: { points: readonly RideTimeseriesPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className="flex h-36 items-center justify-center rounded-xl bg-zinc-950/70 text-xs text-zinc-500">
        No 1Hz FIT samples available for this ride.
      </div>
    );
  }

  const width = 620;
  const height = 165;
  const pad = { top: 12, right: 34, bottom: 22, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxT = Math.max(1, points.at(-1)?.t_s ?? 1);
  const maxW = Math.max(250, ...points.map((p) => p.watts ?? 0));
  const wCeil = Math.ceil(maxW / 50) * 50;
  const minHr = 70;
  const maxHr = Math.max(195, ...points.map((p) => p.hr_bpm ?? 0));

  const xOf = (t: number) => pad.left + (t / maxT) * plotW;
  const yW = (w: number) => pad.top + ((wCeil - w) / wCeil) * plotH;
  const yHr = (hr: number) => pad.top + ((maxHr - hr) / Math.max(1, maxHr - minHr)) * plotH;

  const powerPoints = points.filter((p) => p.watts !== null);
  const powerLine = powerPoints
    .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.t_s).toFixed(1)},${yW(p.watts ?? 0).toFixed(1)}`)
    .join(" ");
  const powerArea =
    powerPoints.length > 1
      ? `${powerLine} L${xOf(powerPoints.at(-1)?.t_s ?? 0).toFixed(1)},${(pad.top + plotH).toFixed(1)} L${xOf(powerPoints[0]?.t_s ?? 0).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`
      : "";

  const hrPoints = points.filter((p) => p.hr_bpm !== null);
  const hrLine = hrPoints
    .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.t_s).toFixed(1)},${yHr(p.hr_bpm ?? minHr).toFixed(1)}`)
    .join(" ");

  const active = hoverIdx !== null ? (points[hoverIdx] ?? null) : null;

  return (
    <div className="space-y-1.5" data-testid="ride-timeseries-chart">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-3 text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-orange-400" /> Power (W)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-rose-400" /> Heart Rate (bpm)
          </span>
        </div>
        {active && (
          <span className="font-mono text-zinc-200">
            {formatClockShort(active.t_s)} · {active.watts ?? "--"}W · {active.hr_bpm ?? "--"} bpm
            {active.cadence_rpm !== null ? ` · ${active.cadence_rpm} rpm` : ""}
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90"
        onMouseLeave={() => setHoverIdx(null)}
        aria-label="Ride power and heart rate chart"
      >
        {[0, Math.round(wCeil / 2), wCeil].map((tick) => (
          <g key={tick}>
            <line x1={pad.left} y1={yW(tick)} x2={width - pad.right} y2={yW(tick)} stroke="var(--pc-chart-grid)" />
            <text x={pad.left - 5} y={yW(tick) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--pc-chart-axis)">
              {tick}
            </text>
          </g>
        ))}

        {powerArea && <path d={powerArea} fill="#f97316" fillOpacity={0.2} />}
        {powerLine && <path d={powerLine} fill="none" stroke="#f97316" strokeWidth={1.8} />}
        {hrLine && <path d={hrLine} fill="none" stroke="#fb7185" strokeWidth={1.6} />}

        {active && (
          <line
            x1={xOf(active.t_s)}
            y1={pad.top}
            x2={xOf(active.t_s)}
            y2={pad.top + plotH}
            stroke="var(--pc-chart-cursor)"
            strokeDasharray="3 3"
          />
        )}

        <text x={pad.left} y={height - 6} fontSize="9.5" fill="var(--pc-chart-axis)">
          0:00
        </text>
        <text x={width - pad.right} y={height - 6} textAnchor="end" fontSize="9.5" fill="var(--pc-chart-axis)">
          {formatClockShort(maxT)}
        </text>

        {points.map((pt, idx) => {
          const w = plotW / Math.max(1, points.length);
          return (
            <rect
              key={`${pt.t_s}-${idx}`}
              x={xOf(pt.t_s) - w / 2}
              y={pad.top}
              width={Math.max(4, w)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(idx)}
            />
          );
        })}
      </svg>
    </div>
  );
}
