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

function stepColor(watts: number, ftp: number): string {
  const pct = watts / Math.max(1, ftp);
  if (pct < 0.56) return "#52525b"; // Z1 zinc
  if (pct < 0.76) return "#3b82f6"; // Z2 blue
  if (pct < 0.91) return "#22c55e"; // Z3 green
  if (pct < 1.06) return "#eab308"; // Z4 yellow
  if (pct < 1.21) return "#f97316"; // Z5 orange
  if (pct < 1.51) return "#ef4444"; // Z6 red
  return "#dc2626"; // Z7 red
}

function formatProfileTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

function powerZone(watts: number, ftpWatts: number): { label: string; range: string } {
  const pct = (watts / Math.max(1, ftpWatts)) * 100;
  if (pct < 55) return { label: "Z1", range: "<55% FTP" };
  if (pct <= 75) return { label: "Z2", range: "55–75% FTP" };
  if (pct <= 90) return { label: "Z3", range: "76–90% FTP" };
  if (pct <= 105) return { label: "Z4", range: "91–105% FTP" };
  if (pct <= 120) return { label: "Z5", range: "106–120% FTP" };
  if (pct <= 150) return { label: "Z6", range: "121–150% FTP" };
  return { label: "Z7", range: ">150% FTP" };
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
  const [activeStep, setActiveStep] = useState<FlattenedStep | null>(null);
  const totalS = Math.max(1, steps.reduce((acc, s) => acc + s.duration_s, 0));
  const maxWatts = Math.max(
    ftpWatts * 1.25,
    ...steps.map((s) => Math.max(s.watts_start ?? ftpWatts * 0.75, s.watts_end ?? ftpWatts * 0.75))
  );
  const viewW = 800;
  const activeIndex =
    activeStep === null
      ? null
      : ((activeStep.start_offset_s + activeStep.duration_s / 2) / totalS) * 100;
  const tooltipStep = activeStep;

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
          const w1 = step.watts_start ?? ftpWatts * 0.75;
          const w2 = step.watts_end ?? w1;
          const y1 = height - (w1 / maxWatts) * (height - 8);
          const y2 = height - (w2 / maxWatts) * (height - 8);
          const fill = stepColor((w1 + w2) / 2, ftpWatts);
          const startLabel = formatProfileTime(step.start_offset_s);
          const endLabel = formatProfileTime(step.start_offset_s + step.duration_s);
          const averageWatts = Math.round((w1 + w2) / 2);
          const zone = powerZone(averageWatts, ftpWatts);
          const isActive = activeStep?.step_index === step.step_index;
          const ftpPct = Math.round((averageWatts / Math.max(1, ftpWatts)) * 100);
          const ariaLabel = `${step.label}, ${startLabel} to ${endLabel}, ${formatDuration(step.duration_s)}, ${step.mode.toUpperCase()}, average ${averageWatts} watts, ${ftpPct} percent FTP, ${zone.label}`;

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
              onMouseEnter={() => setActiveStep(step)}
              onMouseLeave={() => setActiveStep(null)}
              onFocus={() => setActiveStep(step)}
              onBlur={() => setActiveStep(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setActiveStep(null);
              }}
            >
              <title>{ariaLabel}</title>
            </polygon>
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
          className="pointer-events-none absolute z-20 w-[220px] rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-left shadow-xl"
          style={{
            left: `${Math.max(35, Math.min(65, activeIndex ?? 50))}%`,
            top: 6,
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
          {(() => {
            const w1 = tooltipStep.watts_start ?? ftpWatts * 0.75;
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
          })()}
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
