import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RidePage } from "../../pages/RidePage.js";
import type { BridgeClientSnapshot } from "../../lib/bridge-client.js";

describe("RidePage HUD & Controls", () => {
  it("renders live telemetry, interval cue, dispatches ERG bias commands, and submits PostRideModal", () => {
    const sendCommand = vi.fn().mockReturnValue(true);
    const snapshot: BridgeClientSnapshot = {
      connected: true,
      lastSaved: null,
      lastError: null,
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
      ],
      telemetry: {
        type: "telemetry",
        ts_ms: 1764180000000,
        ride_uuid: "550e8400-e29b-41d4-a716-446655440000",
        workout_name: "4x8m Threshold",
        state: "running",
        elapsed_s: 120,
        step_index: 0,
        total_steps: 1,
        step_label: "Threshold Rep 1",
        step_elapsed_s: 120,
        step_remaining_s: 360,
        mode: "erg",
        target_watts: 260,
        target_grade_pct: null,
        erg_bias_pct: 100,
        watts: 258,
        watts_3s: 261,
        cadence_rpm: 91,
        hr_bpm: 165,
        speed_kph: 35.1,
        text_cue: "Hold steady 90 RPM",
        sensors: { trainer: "connected", hr: "connected", transport: "mock" },
        pending_uploads: 0,
      },
    };

    render(<RidePage snapshot={snapshot} ftpWatts={260} sendCommand={sendCommand} />);

    expect(screen.getByText("4x8m Threshold")).toBeTruthy();
    expect(screen.getByText("Cue: Hold steady 90 RPM")).toBeTruthy();
    expect(screen.getByText("261")).toBeTruthy();
    expect(screen.getByText("165")).toBeTruthy();

    fireEvent.click(screen.getByText("ERG -5%"));
    expect(sendCommand).toHaveBeenCalledWith({ type: "set_erg_bias", bias_pct: 95 });

    fireEvent.click(screen.getByText("Finish & Save"));
    fireEvent.click(screen.getByText("Save & Upload FIT"));
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stop_and_save", rpe: 6, feel: 4 })
    );
  });
});
