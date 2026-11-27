import { useEffect, useId, useRef, useState } from "react";
import type uPlot from "uplot";
import type { FlattenedStep } from "@paincave/shared";

export interface LiveDataPoint {
  t_s: number;
  watts: number | null;
  target_watts: number | null;
  hr_bpm: number | null;
}

interface LiveWorkoutChartProps {
  steps: readonly FlattenedStep[];
  ftpWatts: number;
  liveHistory: readonly LiveDataPoint[];
  elapsedS: number;
}

function powerZone(
  watts: number,
  ftpWatts: number
): { label: string; range: string; color: string } {
  const pct = (watts / Math.max(1, ftpWatts)) * 100;
  if (pct < 55) return { label: "Z1", range: "<55% FTP", color: "#52525b" };
  if (pct <= 75) return { label: "Z2", range: "55–75% FTP", color: "#3b82f6" };
  if (pct <= 90) return { label: "Z3", range: "76–90% FTP", color: "#22c55e" };
  if (pct <= 105) return { label: "Z4", range: "91–105% FTP", color: "#eab308" };
  if (pct <= 120) return { label: "Z5", range: "106–120% FTP", color: "#f97316" };
  if (pct <= 150) return { label: "Z6", range: "121–150% FTP", color: "#ef4444" };
  return { label: "Z7", range: ">150% FTP", color: "#dc2626" };
}

function stepColor(step: FlattenedStep, ftp: number): string {
  if (step.watts_start === null && step.watts_end === null) {
    return "#6366f1"; // Non-ERG slope / resistance / free-ride accent
  }
  const w1 = step.watts_start ?? step.watts_end ?? ftp * 0.75;
  const w2 = step.watts_end ?? w1;
  return powerZone((w1 + w2) / 2, ftp).color;
}

function formatProfileTime(totalSeconds: number): string {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(totalSeconds: number): string {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

function describeNonErgTarget(step: FlattenedStep): { label: string; value: string } {
  if (step.mode === "slope" && step.grade_pct !== null) {
    return { label: "Grade", value: `${step.grade_pct}%` };
  }
  if (step.mode === "resistance" && step.resistance_pct !== null) {
    return { label: "Resistance", value: `${step.resistance_pct}%` };
  }
  return { label: "Target", value: "Free ride" };
}

export function WorkoutProfileSvg({
  steps,
  ftpWatts,
  elapsedS = 0,
  height = 84,
}: {
  steps: readonly FlattenedStep[];
  ftpWatts: number;
  elapsedS?: number;
  height?: number;
}) {
  const tooltipId = useId();
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null);
  const totalS = Math.max(1, steps.reduce((acc, s) => acc + s.duration_s, 0));
  const maxWatts = Math.max(
    ftpWatts * 1.25,
    ...steps.map((s) => Math.max(s.watts_start ?? ftpWatts * 0.75, s.watts_end ?? ftpWatts * 0.75))
  );
  const viewW = 800;
  const tooltipStep =
    activeStepIndex === null
      ? null
      : (steps.find((s) => s.step_index === activeStepIndex) ?? null);
  const activeMidPct =
    tooltipStep === null
      ? null
      : ((tooltipStep.start_offset_s + tooltipStep.duration_s / 2) / totalS) * 100;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${viewW} ${height}`}
        className="w-full rounded-lg bg-zinc-950/90 border border-zinc-800"
        style={{ height }}
        preserveAspectRatio="none"
        aria-label="Workout power profile"
      >
        {steps.map((step) => {
          const x1 = (step.start_offset_s / totalS) * viewW;
          const x2 = ((step.start_offset_s + step.duration_s) / totalS) * viewW;
          const hasPowerTarget = step.watts_start !== null || step.watts_end !== null;
          const w1 = step.watts_start ?? step.watts_end ?? ftpWatts * 0.75;
          const w2 = step.watts_end ?? w1;
          const y1 = height - (w1 / maxWatts) * (height - 8);
          const y2 = height - (w2 / maxWatts) * (height - 8);
          const fill = stepColor(step, ftpWatts);
          const startLabel = formatProfileTime(step.start_offset_s);
          const endLabel = formatProfileTime(step.start_offset_s + step.duration_s);
          const isActive = tooltipStep?.step_index === step.step_index;

          let targetSummary: string;
          if (hasPowerTarget) {
            const averageWatts = Math.round((w1 + w2) / 2);
            const zone = powerZone(averageWatts, ftpWatts);
            const ftpPct = Math.round((averageWatts / Math.max(1, ftpWatts)) * 100);
            targetSummary = `average ${averageWatts} watts, ${ftpPct} percent FTP, ${zone.label}`;
          } else {
            const nonErg = describeNonErgTarget(step);
            targetSummary = `${nonErg.label.toLowerCase()} ${nonErg.value}`;
          }
          const ariaLabel = `${step.label}, ${startLabel} to ${endLabel}, ${formatDuration(step.duration_s)}, ${step.mode.toUpperCase()}, ${targetSummary}`;

          return (
            <polygon
              key={step.step_index}
              points={`${x1},${height} ${x1},${y1} ${x2},${y2} ${x2},${height}`}
              fill={fill}
              fillOpacity={isActive ? 0.96 : 0.78}
              stroke={isActive ? "#fafafa" : "#09090b"}
              strokeWidth={isActive ? 2 : 0.8}
              tabIndex={0}
              role="img"
              aria-label={ariaLabel}
              aria-describedby={isActive ? tooltipId : undefined}
              data-testid={`workout-profile-step-${step.step_index}`}
              className="cursor-crosshair outline-none"
              onMouseEnter={() => setActiveStepIndex(step.step_index)}
              onMouseLeave={() => setActiveStepIndex(null)}
              onFocus={() => setActiveStepIndex(step.step_index)}
              onBlur={() => setActiveStepIndex(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setActiveStepIndex(null);
              }}
            />
          );
        })}
        {elapsedS > 0 && (
          <line
            x1={Math.min(viewW, (elapsedS / totalS) * viewW)}
            y1={0}
            x2={Math.min(viewW, (elapsedS / totalS) * viewW)}
            y2={height}
            stroke="#ffffff"
            strokeWidth={2}
            aria-hidden="true"
            pointerEvents="none"
          />
        )}
      </svg>
      {tooltipStep !== null && (
        <div
          id={tooltipId}
          role="tooltip"
          data-testid="workout-profile-tooltip"
          className="pointer-events-none absolute bottom-full z-20 mb-2 w-[220px] rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-left shadow-xl"
          style={{
            left: `${Math.max(25, Math.min(75, activeMidPct ?? 50))}%`,
            transform: "translateX(-50%)",
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="truncate text-sm font-bold text-white">{tooltipStep.label}</div>
            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-300">
              {tooltipStep.mode.toUpperCase()}
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-300">
            {formatProfileTime(tooltipStep.start_offset_s)}–
            {formatProfileTime(tooltipStep.start_offset_s + tooltipStep.duration_s)}
            <span className="mx-1 text-zinc-600">·</span>
            <span>Duration {formatDuration(tooltipStep.duration_s)} ({tooltipStep.duration_s}s)</span>
          </div>
          {tooltipStep.watts_start !== null || tooltipStep.watts_end !== null ? (
            (() => {
              const w1 = tooltipStep.watts_start ?? tooltipStep.watts_end ?? 0;
              const w2 = tooltipStep.watts_end ?? w1;
              const averageWatts = Math.round((w1 + w2) / 2);
              const targetWatts =
                w1 === w2 ? `${Math.round(w1)} W` : `${Math.round(w1)}–${Math.round(w2)} W`;
              const zone = powerZone(averageWatts, ftpWatts);
              return (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500">Average</div>
                      <div className="font-semibold text-orange-300">{averageWatts} W</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500">Target</div>
                      <div className="font-semibold text-white">{targetWatts}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-zinc-200">
                      {Math.round((averageWatts / Math.max(1, ftpWatts)) * 100)}% FTP
                    </span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-semibold text-zinc-100">
                      {zone.label} · {zone.range}
                    </span>
                  </div>
                </>
              );
            })()
          ) : (
            (() => {
              const nonErg = describeNonErgTarget(tooltipStep);
              return (
                <div className="mt-2 text-xs">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                    {nonErg.label}
                  </div>
                  <div className="font-semibold text-indigo-300">{nonErg.value}</div>
                </div>
              );
            })()
          )}
          {tooltipStep.cadence_rpm !== null && (
            <div className="mt-2 text-xs text-sky-300">Cadence {tooltipStep.cadence_rpm} rpm</div>
          )}
          {tooltipStep.text_cue && (
            <div className="mt-2 border-t border-zinc-800 pt-2 text-xs text-zinc-300">
              {tooltipStep.text_cue}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LiveWorkoutChart({
  steps,
  ftpWatts,
  liveHistory,
  elapsedS,
}: LiveWorkoutChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof window === "undefined") return;
    // Skip Canvas uPlot creation in minimal jsdom environments lacking matchMedia/2D canvas
    if (typeof window.matchMedia !== "function") return;

    let cancelled = false;
    let onResize: (() => void) | null = null;

    void import("uplot")
      .then(({ default: UPlotCtor }) => {
        if (cancelled || !containerRef.current) return;

        const plot = new UPlotCtor(
          {
            width: Math.max(320, containerRef.current.clientWidth || 640),
            height: 200,
            cursor: { show: false },
            legend: { show: true },
            scales: {
              x: { time: false },
              y: { auto: true, range: (_u, _min, max) => [0, Math.max(300, max + 30)] },
              hr: { auto: true, range: () => [60, 210] },
            },
            axes: [
              {
                stroke: "#a1a1aa",
                grid: { stroke: "#27272a" },
                values: (_u, vals) => vals.map((v) => `${Math.round(v / 60)}m`),
              },
              {
                stroke: "#f97316",
                grid: { stroke: "#27272a" },
                label: "Watts",
              },
              {
                side: 1,
                scale: "hr",
                stroke: "#ef4444",
                grid: { show: false },
                label: "BPM",
              },
            ],
            series: [
              { label: "Time" },
              { label: "Target W", stroke: "#52525b", width: 2, dash: [4, 4] },
              { label: "Power W", stroke: "#f97316", width: 2.5 },
              { label: "HR bpm", stroke: "#ef4444", width: 2, scale: "hr" },
            ],
          },
          [[0], [null], [null], [null]],
          containerRef.current
        );
        plotRef.current = plot;

        onResize = () => {
          if (containerRef.current && plotRef.current) {
            plotRef.current.setSize({ width: Math.max(320, containerRef.current.clientWidth), height: 200 });
          }
        };
        window.addEventListener("resize", onResize);
      })
      .catch((err: unknown) => {
        console.error("Failed to initialize uPlot chart", err);
      });

    return () => {
      cancelled = true;
      if (onResize) {
        window.removeEventListener("resize", onResize);
      }
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || liveHistory.length === 0) return;

    const xs: number[] = [];
    const targets: (number | null)[] = [];
    const watts: (number | null)[] = [];
    const hrs: (number | null)[] = [];

    for (const pt of liveHistory) {
      xs.push(pt.t_s);
      targets.push(pt.target_watts);
      watts.push(pt.watts);
      hrs.push(pt.hr_bpm);
    }
    plot.setData([xs, targets, watts, hrs]);
  }, [liveHistory]);

  return (
    <div className="space-y-3">
      {steps.length > 0 && (
        <WorkoutProfileSvg steps={steps} ftpWatts={ftpWatts} elapsedS={elapsedS} height={84} />
      )}
      <div
        ref={containerRef}
        className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 p-2 min-h-[216px]"
        data-testid="live-uplot-container"
      />
    </div>
  );
}
