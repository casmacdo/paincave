import { useEffect, useRef, useState } from "react";
import type { BridgeCommand, FlattenedStep } from "@paincave/shared";
import { LiveWorkoutChart, type LiveDataPoint } from "../components/LiveWorkoutChart.js";
import { PostRideModal } from "../components/PostRideModal.js";
import { RouteElevationMap } from "../components/RouteElevationMap.js";
import { playIntervalCueTone } from "../lib/audio-cues.js";
import type { BridgeClientSnapshot } from "../lib/bridge-client.js";

interface RidePageProps {
  snapshot: BridgeClientSnapshot;
  ftpWatts: number;
  sendCommand: (cmd: BridgeCommand) => boolean;
}

const AUDIO_STORAGE_KEY = "paincave_audio_cues";

function formatClock(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatStepPreview(step: FlattenedStep): string {
  const mins = Math.floor(step.duration_s / 60);
  const secs = step.duration_s % 60;
  const dur = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins}m`) : `${secs}s`;
  if (step.watts_start !== null) {
    const wEnd = step.watts_end ?? step.watts_start;
    const target = wEnd === step.watts_start ? `${step.watts_start}W` : `${step.watts_start}–${wEnd}W`;
    return `${step.label} · ${dur} @ ${target}`;
  }
  if (step.mode === "slope" && step.grade_pct !== null) {
    return `${step.label} · ${dur} @ ${step.grade_pct}% grade`;
  }
  if (step.mode === "resistance" && step.resistance_pct !== null) {
    return `${step.label} · ${dur} @ ${step.resistance_pct}% res`;
  }
  return `${step.label} · ${dur}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function RidePage({ snapshot, ftpWatts, sendCommand }: RidePageProps) {
  const [history, setHistory] = useState<LiveDataPoint[]>([]);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [manualGradePct, setManualGradePct] = useState(2.0);
  const [manualResistancePct, setManualResistancePct] = useState(25);
  const [audioEnabled, setAudioEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(AUDIO_STORAGE_KEY) !== "off";
  });

  const lastCueRef = useRef<{ stepIndex: number; remaining: number | null }>({
    stepIndex: -1,
    remaining: null,
  });

  const tel = snapshot.telemetry;
  const state = tel?.state ?? "idle";
  const isActive =
    state === "running" || state === "paused" || state === "auto_paused" || state === "completed";
  const currentMode = tel?.mode ?? "erg";
  const biasPct = tel?.erg_bias_pct ?? 100;
  const activeGrade = tel?.target_grade_pct ?? manualGradePct;

  const nextStep =
    tel && snapshot.loadedSteps.length > tel.step_index + 1
      ? snapshot.loadedSteps[tel.step_index + 1] ?? null
      : null;
  const imminentTransition =
    state === "running" && tel !== null && tel.step_remaining_s > 0 && tel.step_remaining_s <= 15;

  useEffect(() => {
    if (!tel) return;
    if (tel.state === "idle") {
      setHistory([]);
      lastCueRef.current = { stepIndex: -1, remaining: null };
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

  // 3-2-1 interval countdown and step transition audio cues
  useEffect(() => {
    if (!tel || tel.state !== "running") return;
    const prev = lastCueRef.current;

    if (prev.stepIndex !== -1 && prev.stepIndex !== tel.step_index) {
      if (audioEnabled) {
        playIntervalCueTone("transition");
      }
      lastCueRef.current = { stepIndex: tel.step_index, remaining: tel.step_remaining_s };
      return;
    }

    if (
      tel.step_remaining_s >= 1 &&
      tel.step_remaining_s <= 3 &&
      prev.remaining !== tel.step_remaining_s
    ) {
      if (audioEnabled) {
        playIntervalCueTone("countdown");
      }
    }
    lastCueRef.current = { stepIndex: tel.step_index, remaining: tel.step_remaining_s };
  }, [tel, audioEnabled]);

  const toggleAudio = () => {
    setAudioEnabled((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AUDIO_STORAGE_KEY, next ? "on" : "off");
      }
      return next;
    });
  };

  const handleRescanSensors = () => {
    sendCommand({ type: "scan_sensors" });
    setRescanning(true);
    window.setTimeout(() => setRescanning(false), 2000);
  };

  const handleSwitchMode = (mode: "erg" | "slope" | "resistance") => {
    if (mode === "erg") {
      const watts = tel?.target_watts ?? Math.round(ftpWatts * 0.65);
      sendCommand({ type: "set_manual_target", mode: "erg", watts });
    } else if (mode === "slope") {
      const grade = Number(activeGrade.toFixed(1));
      setManualGradePct(grade);
      sendCommand({ type: "set_manual_target", mode: "slope", grade_pct: grade });
    } else {
      sendCommand({
        type: "set_manual_target",
        mode: "resistance",
        resistance_pct: manualResistancePct,
      });
    }
  };

  const handleAdjustGrade = (delta: number) => {
    const next = Number(clamp(activeGrade + delta, -10, 20).toFixed(1));
    setManualGradePct(next);
    sendCommand({ type: "set_manual_target", mode: "slope", grade_pct: next });
  };

  const handleAdjustResistance = (delta: number) => {
    const next = clamp(manualResistancePct + delta, 0, 100);
    setManualResistancePct(next);
    sendCommand({ type: "set_manual_target", mode: "resistance", resistance_pct: next });
  };

  return (
    <div className="space-y-5">
      {/* Header & Workout Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-orange-400">
              {state.replace("_", " ")}
            </span>
            <h1 className="text-xl font-bold text-white">
              {tel?.workout_name ?? "Free Ride / Ready"}
            </h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-400">
            {tel?.step_label && (
              <span>
                Step {tel.step_index + 1}/{Math.max(1, tel.total_steps)}: {tel.step_label}
              </span>
            )}
            {nextStep && (
              <span
                data-testid="next-step-preview"
                className={`text-xs ${
                  imminentTransition
                    ? "rounded bg-orange-500/20 px-2 py-0.5 font-semibold text-orange-200"
                    : "text-zinc-500"
                }`}
              >
                Up next: {formatStepPreview(nextStep)}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs text-zinc-400">
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
          <button
            type="button"
            onClick={handleRescanSensors}
            disabled={rescanning}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-60"
          >
            {rescanning ? "Scanning..." : "Rescan Sensors"}
          </button>
          <button
            type="button"
            onClick={toggleAudio}
            aria-pressed={audioEnabled}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
              audioEnabled
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {audioEnabled ? "Cues: On" : "Cues: Muted"}
          </button>
          {(tel?.pending_uploads ?? 0) > 0 && (
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300">
              {tel?.pending_uploads} queued upload(s)
            </span>
          )}
        </div>
      </div>

      {snapshot.lastError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-200">
          Bridge notice: {snapshot.lastError}
        </div>
      )}

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
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {currentMode === "slope"
              ? "Target Grade"
              : currentMode === "resistance"
                ? "Resistance"
                : `Target (${biasPct}%)`}
          </div>
          <div className="mt-2 text-5xl font-black tabular-nums text-white">
            {currentMode === "slope" ? (
              <>
                {activeGrade.toFixed(1)}
                <span className="ml-1 text-xl font-medium text-zinc-500">%</span>
              </>
            ) : currentMode === "resistance" ? (
              <>
                {manualResistancePct}
                <span className="ml-1 text-xl font-medium text-zinc-500">%</span>
              </>
            ) : (
              <>
                {tel?.target_watts ?? "--"}
                <span className="ml-1 text-xl font-medium text-zinc-500">W</span>
              </>
            )}
          </div>
          <div className="mt-1 text-xs text-zinc-500">Mode: {currentMode.toUpperCase()}</div>
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

        <div
          className={`col-span-2 rounded-2xl border p-5 lg:col-span-1 ${
            imminentTransition
              ? "border-orange-500/60 bg-orange-500/10"
              : "border-zinc-800 bg-zinc-900"
          }`}
        >
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
      <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
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
                  onClick={() => sendCommand({ type: "extend_step", seconds: 60 })}
                  className="rounded-xl border border-zinc-700 bg-zinc-800 px-3.5 py-3 text-sm font-semibold text-zinc-200 hover:bg-zinc-700"
                >
                  +1m
                </button>
                <button
                  type="button"
                  onClick={() => sendCommand({ type: "extend_step", seconds: 300 })}
                  className="rounded-xl border border-zinc-700 bg-zinc-800 px-3.5 py-3 text-sm font-semibold text-zinc-200 hover:bg-zinc-700"
                >
                  +5m
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
        </div>

        {/* Mode Switcher & Intensity / Grade / Resistance Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-3">
          <div
            role="group"
            aria-label="Trainer control mode"
            className="inline-flex rounded-xl border border-zinc-700 bg-zinc-950 p-1 text-xs"
          >
            {(["erg", "slope", "resistance"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => handleSwitchMode(mode)}
                aria-pressed={currentMode === mode}
                className={`rounded-lg px-3 py-1.5 font-semibold uppercase tracking-wide transition ${
                  currentMode === mode
                    ? "bg-orange-500 text-zinc-950"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          {currentMode === "erg" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => sendCommand({ type: "set_erg_bias", bias_pct: Math.max(50, biasPct - 5) })}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-700"
              >
                ERG -5%
              </button>
              <span className="min-w-[4rem] text-center text-sm font-bold tabular-nums text-zinc-200">
                {biasPct}%
              </span>
              <button
                type="button"
                onClick={() => sendCommand({ type: "set_erg_bias", bias_pct: Math.min(150, biasPct + 5) })}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-700"
              >
                ERG +5%
              </button>
              {biasPct !== 100 && (
                <button
                  type="button"
                  onClick={() => sendCommand({ type: "set_erg_bias", bias_pct: 100 })}
                  className="rounded-xl border border-zinc-700 px-3 py-2.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
                >
                  Reset
                </button>
              )}
            </div>
          )}

          {currentMode === "slope" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleAdjustGrade(-0.5)}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-700"
              >
                Grade -0.5%
              </button>
              <span className="min-w-[4.5rem] text-center text-sm font-bold tabular-nums text-zinc-200">
                {activeGrade.toFixed(1)}%
              </span>
              <button
                type="button"
                onClick={() => handleAdjustGrade(0.5)}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-700"
              >
                Grade +0.5%
              </button>
            </div>
          )}

          {currentMode === "resistance" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleAdjustResistance(-5)}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-700"
              >
                Res -5%
              </button>
              <span className="min-w-[4rem] text-center text-sm font-bold tabular-nums text-zinc-200">
                {manualResistancePct}%
              </span>
              <button
                type="button"
                onClick={() => handleAdjustResistance(5)}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-700"
              >
                Res +5%
              </button>
            </div>
          )}
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
