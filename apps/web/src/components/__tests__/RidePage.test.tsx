import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { RidePage } from "../../pages/RidePage.js";
import * as audioCues from "../../lib/audio-cues.js";
import type { BridgeClientSnapshot } from "../../lib/bridge-client.js";

function makeSnapshot(overrides?: {
  step_remaining_s?: number;
  step_index?: number;
  mode?: "erg" | "slope" | "resistance";
  target_grade_pct?: number | null;
  text_cue?: string | null;
}): BridgeClientSnapshot {
  const cue = overrides && "text_cue" in overrides ? overrides.text_cue ?? null : "Hold steady 90 RPM";
  return {
    connected: true,
    lastSaved: null,
    lastError: null,
    loadedWorkoutName: "4x8m Threshold",
    liveHistory: [],
    loadedSteps: [
      {
        step_index: 0,
        label: "Threshold Rep 1",
        start_offset_s: 0,
        duration_s: 480,
        mode: "erg",
        watts_start: 260,
        watts_end: 260,
        grade_pct: null,
        resistance_pct: null,
        cadence_rpm: 90,
        text_cue: "Hold steady 90 RPM",
        is_work_interval: true,
      },
      {
        step_index: 1,
        label: "Recovery Spin",
        start_offset_s: 480,
        duration_s: 180,
        mode: "erg",
        watts_start: 140,
        watts_end: 140,
        grade_pct: null,
        resistance_pct: null,
        cadence_rpm: 85,
        text_cue: null,
        is_work_interval: false,
      },
    ],
    telemetry: {
      type: "telemetry",
      ts_ms: 1764180000000,
      ride_uuid: "550e8400-e29b-41d4-a716-446655440000",
      workout_name: "4x8m Threshold",
      state: "running",
      elapsed_s: 120,
      step_index: overrides?.step_index ?? 0,
      total_steps: 2,
      step_label: "Threshold Rep 1",
      step_elapsed_s: 120,
      step_remaining_s: overrides?.step_remaining_s ?? 360,
      mode: overrides?.mode ?? "erg",
      target_watts: 260,
      target_grade_pct: overrides?.target_grade_pct ?? null,
      erg_bias_pct: 100,
      watts: 258,
      watts_3s: 261,
      cadence_rpm: 91,
      hr_bpm: 165,
      speed_kph: 35.1,
      text_cue: cue,
      sensors: { trainer: "connected", hr: "connected", transport: "mock" },
      pending_uploads: 0,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("RidePage HUD & Controls", () => {
  it("renders live telemetry, interval cue, next-step preview, dispatches ERG/extend/rescan/mode commands, and submits PostRideModal", () => {
    const sendCommand = vi.fn().mockReturnValue(true);
    render(<RidePage snapshot={makeSnapshot()} ftpWatts={260} sendCommand={sendCommand} />);

    expect(screen.getByText("4x8m Threshold")).toBeTruthy();
    expect(screen.getByText("Cue: Hold steady 90 RPM")).toBeTruthy();
    expect(screen.getByTestId("next-step-preview").textContent).toContain(
      "Recovery Spin · 3m @ 140W"
    );
    expect(screen.getByText("261")).toBeTruthy();
    expect(screen.getByText("165")).toBeTruthy();

    fireEvent.click(screen.getByText("ERG -5%"));
    expect(sendCommand).toHaveBeenCalledWith({ type: "set_erg_bias", bias_pct: 95 });

    fireEvent.click(screen.getByText("+1m"));
    expect(sendCommand).toHaveBeenCalledWith({ type: "extend_step", seconds: 60 });

    fireEvent.click(screen.getByText("+5m"));
    expect(sendCommand).toHaveBeenCalledWith({ type: "extend_step", seconds: 300 });

    fireEvent.click(screen.getByText("Rescan Sensors"));
    expect(sendCommand).toHaveBeenCalledWith({ type: "scan_sensors" });

    fireEvent.click(screen.getByRole("button", { name: "slope" }));
    expect(sendCommand).toHaveBeenCalledWith({
      type: "set_manual_target",
      mode: "slope",
      grade_pct: 2,
    });

    fireEvent.click(screen.getByText("Finish & Save"));
    fireEvent.click(screen.getByText("Save & Upload FIT"));
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stop_and_save", rpe: 6, feel: 4 })
    );
  });

  it("plays countdown and transition audio tones unless muted", () => {
    const toneSpy = vi.spyOn(audioCues, "playIntervalCueTone").mockImplementation(() => {});
    const sendCommand = vi.fn().mockReturnValue(true);

    const { rerender } = render(
      <RidePage
        snapshot={makeSnapshot({ step_remaining_s: 3 })}
        ftpWatts={260}
        sendCommand={sendCommand}
      />
    );
    expect(toneSpy).toHaveBeenCalledWith("countdown");

    rerender(
      <RidePage
        snapshot={makeSnapshot({ step_index: 1, step_remaining_s: 180 })}
        ftpWatts={260}
        sendCommand={sendCommand}
      />
    );
    expect(toneSpy).toHaveBeenCalledWith("transition");

    toneSpy.mockClear();
    fireEvent.click(screen.getByText("Cues: On"));
    expect(screen.getByText("Cues: Muted")).toBeTruthy();

    rerender(
      <RidePage
        snapshot={makeSnapshot({ step_index: 1, step_remaining_s: 2 })}
        ftpWatts={260}
        sendCommand={sendCommand}
      />
    );
    expect(toneSpy).not.toHaveBeenCalled();
  });

  it("hides synthetic SIM mode cues while preserving workout-authored cues", () => {
    const sendCommand = vi.fn().mockReturnValue(true);
    render(
      <RidePage
        snapshot={makeSnapshot({
          mode: "slope",
          target_grade_pct: -5.3,
          text_cue: "SIM Mode (100% difficulty)",
        })}
        ftpWatts={260}
        sendCommand={sendCommand}
      />
    );

    expect(screen.queryByText(/Cue:/)).toBeNull();
  });
});
