import { useEffect, useRef } from "react";
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
  return "#ef4444"; // Z6+ red
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
  const totalS = Math.max(1, steps.reduce((acc, s) => acc + s.duration_s, 0));
  const maxWatts = Math.max(
    ftpWatts * 1.25,
    ...steps.map((s) => Math.max(s.watts_start ?? ftpWatts * 0.75, s.watts_end ?? ftpWatts * 0.75))
  );
  const viewW = 800;

  return (
    <svg
      viewBox={`0 0 ${viewW} ${height}`}
      className="w-full rounded-lg bg-zinc-950/90 border border-zinc-800"
      style={{ height }}
      preserveAspectRatio="none"
    >
      {steps.map((step) => {
        const x1 = (step.start_offset_s / totalS) * viewW;
        const x2 = ((step.start_offset_s + step.duration_s) / totalS) * viewW;
        const w1 = step.watts_start ?? ftpWatts * 0.75;
        const w2 = step.watts_end ?? w1;
        const y1 = height - (w1 / maxWatts) * (height - 8);
        const y2 = height - (w2 / maxWatts) * (height - 8);
        const fill = stepColor((w1 + w2) / 2, ftpWatts);
        return (
          <polygon
            key={step.step_index}
            points={`${x1},${height} ${x1},${y1} ${x2},${y2} ${x2},${height}`}
            fill={fill}
            fillOpacity={0.78}
            stroke="#09090b"
            strokeWidth={0.8}
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
        />
      )}
    </svg>
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
