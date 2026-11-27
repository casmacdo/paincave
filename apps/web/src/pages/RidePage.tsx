import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeCommand, FlattenedStep } from "@paincave/shared";
import { LiveWorkoutChart } from "../components/LiveWorkoutChart.js";
import { PostRideModal } from "../components/PostRideModal.js";
import { RouteElevationMap } from "../components/RouteElevationMap.js";
import { playIntervalCueTone } from "../lib/audio-cues.js";
import type { BridgeClientSnapshot } from "../lib/bridge-client.js";
import { useI18n } from "../lib/i18n.js";

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
  const cadenceSuffix = step.cadence_rpm !== null ? ` · ${step.cadence_rpm} rpm` : "";
  if (step.watts_start !== null) {
    const wEnd = step.watts_end ?? step.watts_start;
    const target = wEnd === step.watts_start ? `${step.watts_start}W` : `${step.watts_start}–${wEnd}W`;
    return `${step.label} · ${dur} @ ${target}${cadenceSuffix}`;
  }
  if (step.mode === "slope" && step.grade_pct !== null) {
    return `${step.label} · ${dur} @ ${step.grade_pct}% grade${cadenceSuffix}`;
  }
  if (step.mode === "resistance" && step.resistance_pct !== null) {
    return `${step.label} · ${dur} @ ${step.resistance_pct}% res${cadenceSuffix}`;
  }
  return `${step.label} · ${dur}${cadenceSuffix}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: "screen"): Promise<WakeLockSentinelLike>;
  };
}

interface CadenceTargetState {
  numberClass: string;
  dotClass: string;
  markerPct: number | null;
  feedback: string;
  bandLeftPct: number;
  bandWidthPct: number;
}

function getCadenceTargetState(
  actualRpm: number | null | undefined,
  targetRpm: number
): CadenceTargetState {
  const min = Math.max(0, targetRpm - 5);
  const max = targetRpm + 5;
  const gaugeMin = Math.max(0, targetRpm - 20);
  const gaugeMax = targetRpm + 20;
  const span = Math.max(1, gaugeMax - gaugeMin);
  const bandLeftPct = ((min - gaugeMin) / span) * 100;
  const bandWidthPct = ((max - min) / span) * 100;

  if (actualRpm == null) {
    return {
      numberClass: "text-sky-400",
      dotClass: "bg-zinc-500",
      markerPct: null,
      feedback: `Range: ${min}–${max} rpm`,
      bandLeftPct,
      bandWidthPct,
    };
  }

  const delta = actualRpm - targetRpm;
  const absDelta = Math.abs(delta);
  const markerPct = clamp(((actualRpm - gaugeMin) / span) * 100, 2, 98);
  if (absDelta <= 5) {
    return {
      numberClass: "text-emerald-400",
      dotClass: "bg-emerald-400",
      markerPct,
      feedback: `On target (${min}–${max} rpm)`,
      bandLeftPct,
      bandWidthPct,
    };
  }

  const feedback = delta < 0 ? `Spin up (+${absDelta} rpm)` : `Ease cadence (-${absDelta} rpm)`;
  if (absDelta <= 10) {
    return {
      numberClass: "text-amber-400",
      dotClass: "bg-amber-400",
      markerPct,
      feedback,
      bandLeftPct,
      bandWidthPct,
    };
  }
  return {
    numberClass: "text-rose-400",
    dotClass: "bg-rose-400",
    markerPct,
    feedback,
    bandLeftPct,
    bandWidthPct,
  };
}

function getWorkoutTextCue(rawCue: string | null | undefined, state: string): string | null {
  if (state === "idle" || !rawCue) return null;
  const trimmed = rawCue.trim();
  if (!trimmed) return null;
  if (/^SIM Mode\s*\(\d+%\s*difficulty\)$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function RidePage({ snapshot, ftpWatts, sendCommand }: RidePageProps) {
  const { t } = useI18n();
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [manualGradePct, setManualGradePct] = useState(2.0);
  const [manualResistancePct, setManualResistancePct] = useState(25);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(AUDIO_STORAGE_KEY) !== "off";
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const nativeFullscreenRef = useRef(false);
  const lastCueRef = useRef<{ stepIndex: number; remaining: number | null }>({
    stepIndex: -1,
    remaining: null,
  });

  const tel = snapshot.telemetry;
  const state = tel?.state ?? (snapshot.loadedSteps.length > 0 || snapshot.loadedRoute ? "armed" : "idle");
  const isActive =
    state === "running" || state === "paused" || state === "auto_paused" || state === "completed";
  const currentMode = tel?.mode ?? (snapshot.loadedRoute?.sim_mode ? "slope" : "erg");
  const biasPct = tel?.erg_bias_pct ?? 100;
  const activeGrade = tel?.target_grade_pct ?? manualGradePct;
  const activeCue = getWorkoutTextCue(tel?.text_cue, state);

  const currentStep =
    state === "idle"
      ? null
      : tel && snapshot.loadedSteps.length > tel.step_index
        ? snapshot.loadedSteps[tel.step_index] ?? null
        : snapshot.loadedSteps[0] ?? null;
  const targetCadenceRpm =
    state === "idle" ? null : (tel?.target_cadence_rpm ?? currentStep?.cadence_rpm ?? null);
  const cadenceStatus =
    targetCadenceRpm !== null ? getCadenceTargetState(tel?.cadence_rpm, targetCadenceRpm) : null;

  const nextStep =
    tel && snapshot.loadedSteps.length > tel.step_index + 1
      ? snapshot.loadedSteps[tel.step_index + 1] ?? null
      : null;
  const imminentTransition =
    state === "running" && tel !== null && tel.step_remaining_s > 0 && tel.step_remaining_s <= 15;

  useEffect(() => {
    if (!tel || tel.state === "idle") {
      lastCueRef.current = { stepIndex: -1, remaining: null };
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

  const toggleAudio = useCallback(() => {
    setAudioEnabled((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AUDIO_STORAGE_KEY, next ? "on" : "off");
      }
      return next;
    });
  }, []);

  const enterFullscreen = useCallback(() => {
    setIsFullscreen(true);
    const el = containerRef.current;
    if (el && typeof el.requestFullscreen === "function") {
      void el.requestFullscreen().catch(() => {});
    }
  }, []);

  const exitFullscreen = useCallback(() => {
    nativeFullscreenRef.current = false;
    setIsFullscreen(false);
    if (typeof document !== "undefined" && document.fullscreenElement) {
      if (typeof document.exitFullscreen === "function") {
        void document.exitFullscreen().catch(() => {});
      }
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onFullscreenChange = () => {
      if (document.fullscreenElement === containerRef.current) {
        nativeFullscreenRef.current = true;
        setIsFullscreen(true);
      } else if (!document.fullscreenElement && nativeFullscreenRef.current) {
        nativeFullscreenRef.current = false;
        setIsFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if ((!isFullscreen && state !== "running") || typeof navigator === "undefined") return;
    const nav = navigator as unknown as NavigatorWithWakeLock;
    if (!nav.wakeLock || typeof nav.wakeLock.request !== "function") return;

    let cancelled = false;
    let sentinel: WakeLockSentinelLike | null = null;

    const acquire = () => {
      void nav.wakeLock
        ?.request("screen")
        .then((s) => {
          if (cancelled) {
            void s.release().catch(() => {});
            return;
          }
          sentinel = s;
        })
        .catch(() => {});
    };

    acquire();

    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        acquire();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      cancelled = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (sentinel) {
        void sentinel.release().catch(() => {});
      }
    };
  }, [isFullscreen, state]);

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

  const handleAdjustGrade = useCallback(
    (delta: number) => {
      const next = Number(clamp(activeGrade + delta, -10, 20).toFixed(1));
      setManualGradePct(next);
      sendCommand({ type: "set_manual_target", mode: "slope", grade_pct: next });
    },
    [activeGrade, sendCommand]
  );

  const handleAdjustResistance = useCallback(
    (delta: number) => {
      const next = clamp(manualResistancePct + delta, 0, 100);
      setManualResistancePct(next);
      sendCommand({ type: "set_manual_target", mode: "resistance", resistance_pct: next });
    },
    [manualResistancePct, sendCommand]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (saveModalOpen || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        toggleFullscreen();
        return;
      }

      if (!isFullscreen) return;

      if (event.key === "Escape") {
        event.preventDefault();
        exitFullscreen();
        return;
      }

      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        if (state === "running") {
          sendCommand({ type: "pause" });
        } else if (state === "paused" || state === "auto_paused") {
          sendCommand({ type: "resume" });
        } else {
          sendCommand({ type: "start" });
        }
        return;
      }

      if (event.key === "ArrowUp" || event.key === "+" || event.key === "=") {
        event.preventDefault();
        if (currentMode === "erg") {
          sendCommand({ type: "set_erg_bias", bias_pct: Math.min(150, biasPct + 5) });
        } else if (currentMode === "slope") {
          handleAdjustGrade(0.5);
        } else {
          handleAdjustResistance(5);
        }
        return;
      }

      if (event.key === "ArrowDown" || event.key === "-") {
        event.preventDefault();
        if (currentMode === "erg") {
          sendCommand({ type: "set_erg_bias", bias_pct: Math.max(50, biasPct - 5) });
        } else if (currentMode === "slope") {
          handleAdjustGrade(-0.5);
        } else {
          handleAdjustResistance(-5);
        }
        return;
      }

      if (event.key === "ArrowRight") {
        if (isActive) {
          event.preventDefault();
          sendCommand({ type: "skip_step" });
        }
        return;
      }

      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        toggleAudio();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    saveModalOpen,
    isFullscreen,
    toggleFullscreen,
    exitFullscreen,
    state,
    isActive,
    currentMode,
    biasPct,
    sendCommand,
    handleAdjustGrade,
    handleAdjustResistance,
    toggleAudio,
  ]);

  const metricValueClass = isFullscreen
    ? "mt-2 text-6xl font-black tabular-nums xl:text-7xl"
    : "mt-2 text-5xl font-black tabular-nums";

  return (
    <div
      ref={containerRef}
      data-testid="ride-hud-root"
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col justify-between gap-4 overflow-y-auto bg-zinc-950 p-5"
          : "space-y-5"
      }
    >
      {/* Header & Workout Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-orange-400">
              {state.replace("_", " ")}
            </span>
            <h1 className="text-xl font-bold text-white">
              {tel?.workout_name ?? snapshot.loadedWorkoutName ?? "Free Ride / Ready"}
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
          <button
            type="button"
            data-testid="fullscreen-toggle"
            onClick={toggleFullscreen}
            aria-pressed={isFullscreen}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
              isFullscreen
                ? "border-orange-500/40 bg-orange-500/15 text-orange-300 hover:bg-orange-500/20"
                : "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            }`}
          >
            {isFullscreen ? t("ride.exit_fullscreen") : t("ride.fullscreen")}
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
      {activeCue && (
        <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 px-4 py-3 text-base font-medium text-orange-200">
          Cue: {activeCue}
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
          <div className={`${metricValueClass} text-orange-400`}>
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
          <div className={`${metricValueClass} text-white`}>
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
          <div className={`${metricValueClass} text-rose-400`}>
            {tel?.hr_bpm ?? "--"}
            <span className="ml-1 text-xl font-medium text-zinc-500">bpm</span>
          </div>
        </div>

        <div data-testid="cadence-card" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Cadence</div>
            {targetCadenceRpm !== null && (
              <span
                data-testid="cadence-target-badge"
                className="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-emerald-300"
              >
                Target {targetCadenceRpm} rpm
              </span>
            )}
          </div>
          <div className={`${metricValueClass} ${cadenceStatus ? cadenceStatus.numberClass : "text-sky-400"}`}>
            {tel?.cadence_rpm ?? "--"}
            <span className="ml-1 text-xl font-medium text-zinc-500">rpm</span>
          </div>
          {cadenceStatus && (
            <>
              <div data-testid="cadence-target-gauge" className="relative mt-2.5 flex h-3 items-center">
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="absolute inset-y-0 border-x border-emerald-500/40 bg-emerald-500/20"
                    style={{
                      left: `${cadenceStatus.bandLeftPct}%`,
                      width: `${cadenceStatus.bandWidthPct}%`,
                    }}
                  />
                </div>
                {cadenceStatus.markerPct !== null && (
                  <div
                    className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-800 ${cadenceStatus.dotClass}`}
                    style={{ left: `${cadenceStatus.markerPct}%` }}
                  />
                )}
              </div>
              <div
                data-testid="cadence-feedback"
                className={`mt-1 text-xs font-medium ${
                  cadenceStatus.markerPct === null ? "text-zinc-500" : cadenceStatus.numberClass
                }`}
              >
                {cadenceStatus.feedback}
              </div>
            </>
          )}
        </div>

        <div
          className={`col-span-2 rounded-2xl border p-5 lg:col-span-1 ${
            imminentTransition
              ? "border-orange-500/60 bg-orange-500/10"
              : "border-zinc-800 bg-zinc-900"
          }`}
        >
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Step Remaining</div>
          <div className={`${metricValueClass} text-emerald-400`}>
            {formatClock(tel?.step_remaining_s ?? 0)}
          </div>
          <div className="mt-1 text-xs text-zinc-500">Total: {formatClock(tel?.elapsed_s ?? 0)}</div>
        </div>
      </div>

      {/* Workout Profile + Live Chart */}
      <LiveWorkoutChart
        steps={snapshot.loadedSteps}
        ftpWatts={ftpWatts}
        liveHistory={snapshot.liveHistory ?? []}
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

      {isFullscreen && (
        <div data-testid="fullscreen-shortcuts-hint" className="text-center text-xs text-zinc-500">
          {t("ride.shortcuts_hint")}
        </div>
      )}

      {snapshot.lastSaved && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          Saved FIT ({snapshot.lastSaved.fit_bytes} bytes) — queued for Cloudflare upload (
          {snapshot.lastSaved.ride_uuid}).
        </div>
      )}

      <PostRideModal
        open={saveModalOpen}
        workoutName={tel?.workout_name ?? snapshot.loadedWorkoutName ?? "Ride"}
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
