import { useEffect, useState } from "react";
import type { BridgeCommand } from "@paincave/shared";
import { LiveWorkoutChart, type LiveDataPoint } from "../components/LiveWorkoutChart.js";
import { PostRideModal } from "../components/PostRideModal.js";
import { RouteElevationMap } from "../components/RouteElevationMap.js";
import type { BridgeClientSnapshot } from "../lib/bridge-client.js";

interface RidePageProps {
  snapshot: BridgeClientSnapshot;
  ftpWatts: number;
  sendCommand: (cmd: BridgeCommand) => boolean;
}

function formatClock(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function RidePage({ snapshot, ftpWatts, sendCommand }: RidePageProps) {
  const [history, setHistory] = useState<LiveDataPoint[]>([]);
  const [saveModalOpen, setSaveModalOpen] = useState(false);

  const tel = snapshot.telemetry;
  const state = tel?.state ?? "idle";
  const isActive = state === "running" || state === "paused" || state === "auto_paused" || state === "completed";

  useEffect(() => {
    if (!tel) return;
    if (tel.state === "idle") {
      setHistory([]);
      return;
    }
    if (tel.state === "running" || tel.state === "auto_paused") {
      setHistory((prev) => {
        const last = prev.at(-1);
        if (last && last.t_s === tel.elapsed_s) return prev;
        const next = [
          ...prev,
          {
            t_s: tel.elapsed_s,
            watts: tel.watts,
            target_watts: tel.target_watts,
            hr_bpm: tel.hr_bpm,
          },
        ];
        return next.length > 7200 ? next.slice(-7200) : next;
      });
    }
  }, [tel]);

  const biasPct = tel?.erg_bias_pct ?? 100;

  return (
    <div className="space-y-5">
      {/* Header & Workout Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-orange-400">
              {state.replace("_", " ")}
            </span>
            <h1 className="text-xl font-bold text-white">
              {tel?.workout_name ?? "Free Ride / Ready"}
            </h1>
          </div>
          {tel?.step_label && (
            <p className="mt-1 text-sm text-zinc-400">
              Step {tel.step_index + 1}/{Math.max(1, tel.total_steps)}: {tel.step_label}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span>
            Trainer:{" "}
            <strong className={tel?.sensors.trainer === "connected" ? "text-emerald-400" : "text-zinc-300"}>
              {tel?.sensors.trainer ?? "unknown"}
            </strong>
          </span>
          <span>
            HR:{" "}
            <strong className={tel?.sensors.hr === "connected" ? "text-emerald-400" : "text-zinc-300"}>
              {tel?.sensors.hr ?? "unknown"}
            </strong>
          </span>
          {(tel?.pending_uploads ?? 0) > 0 && (
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300">
              {tel?.pending_uploads} queued upload(s)
            </span>
          )}
        </div>
      </div>

      {/* Interval Cue Banner */}
      {tel?.text_cue && (
        <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 px-4 py-3 text-base font-medium text-orange-200">
          Cue: {tel.text_cue}
        </div>
      )}

      {state === "auto_paused" && (
        <div className="rounded-xl border border-amber-500/50 bg-amber-500/15 px-4 py-3 text-sm font-semibold text-amber-200">
          ERG Guard Auto-Paused (0 RPM detected) — Spin back above 40 RPM to resume smoothly.
        </div>
      )}

      {/* High-Contrast Basement Telemetry Grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Power (3s)</div>
          <div className="mt-2 text-5xl font-black tabular-nums text-orange-400">
            {tel?.watts_3s ?? tel?.watts ?? "--"}
            <span className="ml-1 text-xl font-medium text-zinc-500">W</span>
          </div>
          <div className="mt-1 text-xs text-zinc-500">Instant: {tel?.watts ?? "--"}W</div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Target ({biasPct}%)</div>
          <div className="mt-2 text-5xl font-black tabular-nums text-white">
            {tel?.target_watts ?? "--"}
            <span className="ml-1 text-xl font-medium text-zinc-500">W</span>
          </div>
          <div className="mt-1 text-xs text-zinc-500">Mode: {tel?.mode.toUpperCase() ?? "ERG"}</div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Heart Rate</div>
          <div className="mt-2 text-5xl font-black tabular-nums text-rose-400">
            {tel?.hr_bpm ?? "--"}
            <span className="ml-1 text-xl font-medium text-zinc-500">bpm</span>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Cadence</div>
          <div className="mt-2 text-5xl font-black tabular-nums text-sky-400">
            {tel?.cadence_rpm ?? "--"}
            <span className="ml-1 text-xl font-medium text-zinc-500">rpm</span>
          </div>
        </div>

        <div className="col-span-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 lg:col-span-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Step Remaining</div>
          <div className="mt-2 text-5xl font-black tabular-nums text-emerald-400">
            {formatClock(tel?.step_remaining_s ?? 0)}
          </div>
          <div className="mt-1 text-xs text-zinc-500">Total: {formatClock(tel?.elapsed_s ?? 0)}</div>
        </div>
      </div>

      {/* Workout Profile + Live Chart */}
      <LiveWorkoutChart
        steps={snapshot.loadedSteps}
        ftpWatts={ftpWatts}
        liveHistory={history}
        elapsedS={tel?.elapsed_s ?? 0}
      />

      {/* Active Virtual / SIM Route Elevation & Map */}
      {snapshot.loadedRoute && (
        <RouteElevationMap
          name={snapshot.loadedRoute.name}
          points={snapshot.loadedRoute.points}
          loopRoute={snapshot.loadedRoute.loop_route}
          simMode={snapshot.loadedRoute.sim_mode}
          trainerDifficultyPct={snapshot.loadedRoute.trainer_difficulty_pct}
          currentDistanceM={tel?.distance_m ?? 0}
          currentGradePct={tel?.grade_pct ?? null}
          currentElevationM={tel?.elevation_m ?? null}
          speedKph={tel?.speed_kph ?? null}
          compact
        />
      )}

      {/* Trainer Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {!isActive && (
            <button
              type="button"
              onClick={() => sendCommand({ type: "start" })}
              className="rounded-xl bg-orange-500 px-6 py-3 text-base font-bold text-zinc-950 hover:bg-orange-400"
            >
              Start Ride
            </button>
          )}
          {state === "running" && (
            <button
              type="button"
              onClick={() => sendCommand({ type: "pause" })}
              className="rounded-xl bg-amber-500 px-5 py-3 text-sm font-bold text-zinc-950 hover:bg-amber-400"
            >
              Pause
            </button>
          )}
          {(state === "paused" || state === "auto_paused") && (
            <button
              type="button"
              onClick={() => sendCommand({ type: "resume" })}
              className="rounded-xl bg-emerald-500 px-5 py-3 text-sm font-bold text-zinc-950 hover:bg-emerald-400"
            >
              Resume
            </button>
          )}
          {isActive && (
            <>
              <button
                type="button"
                onClick={() => sendCommand({ type: "prev_step" })}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-700"
              >
                Prev Step
              </button>
              <button
                type="button"
                onClick={() => sendCommand({ type: "skip_step" })}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-700"
              >
                Skip Step
              </button>
              <button
                type="button"
                onClick={() => setSaveModalOpen(true)}
                className="rounded-xl bg-emerald-500 px-5 py-3 text-sm font-bold text-zinc-950 hover:bg-emerald-400"
              >
                Finish & Save
              </button>
              <button
                type="button"
                onClick={() => sendCommand({ type: "discard" })}
                className="rounded-xl border border-rose-500/40 px-4 py-3 text-sm font-semibold text-rose-300 hover:bg-rose-950/50"
              >
                Discard
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => sendCommand({ type: "set_erg_bias", bias_pct: Math.max(50, biasPct - 5) })}
            className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-bold text-white hover:bg-zinc-700"
          >
            ERG -5%
          </button>
          <span className="min-w-[4rem] text-center text-sm font-bold tabular-nums text-zinc-200">
            {biasPct}%
          </span>
          <button
            type="button"
            onClick={() => sendCommand({ type: "set_erg_bias", bias_pct: Math.min(150, biasPct + 5) })}
            className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-bold text-white hover:bg-zinc-700"
          >
            ERG +5%
          </button>
        </div>
      </div>

      {snapshot.lastSaved && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          Saved FIT ({snapshot.lastSaved.fit_bytes} bytes) — queued for Cloudflare upload (
          {snapshot.lastSaved.ride_uuid}).
        </div>
      )}

      <PostRideModal
        open={saveModalOpen}
        workoutName={tel?.workout_name ?? "Ride"}
        elapsedS={tel?.elapsed_s ?? 0}
        onCancel={() => setSaveModalOpen(false)}
        onSubmit={({ rpe, feel, notes }) => {
          sendCommand({ type: "stop_and_save", rpe, feel, notes });
          setSaveModalOpen(false);
        }}
      />
    </div>
  );
}
