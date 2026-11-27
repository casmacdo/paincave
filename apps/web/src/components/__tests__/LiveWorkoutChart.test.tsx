import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkoutProfileSvg } from "../LiveWorkoutChart.js";

const steps = [
  {
    step_index: 0,
    label: "Threshold Rep 1",
    start_offset_s: 0,
    duration_s: 480,
    mode: "erg" as const,
    watts_start: 260,
    watts_end: 260,
    grade_pct: null,
    resistance_pct: null,
    cadence_rpm: 90,
    text_cue: "Hold steady 90 RPM",
    is_work_interval: true,
  },
];

afterEach(cleanup);

describe("WorkoutProfileSvg hover and focus details", () => {
  it("does not show interval details by default", () => {
    render(<WorkoutProfileSvg steps={steps} ftpWatts={260} />);

    expect(screen.queryByTestId("workout-profile-tooltip")).toBeNull();
  });

  it("shows interval details on hover and keyboard focus", () => {
    render(<WorkoutProfileSvg steps={steps} ftpWatts={260} />);
    const polygon = screen.getByTestId("workout-profile-step-0");

    fireEvent.mouseEnter(polygon);
    const tooltip = screen.getByTestId("workout-profile-tooltip");
    expect(tooltip).toBeTruthy();
    expect(tooltip.textContent).toContain("Threshold Rep 1");
    expect(tooltip.textContent).toContain("0:00–8:00");
    expect(tooltip.textContent).toContain("Duration 8m (480s)");
    expect(tooltip.textContent).toContain("260 W");
    expect(tooltip.textContent).toContain("ERG");
    expect(tooltip.textContent).toContain("100% FTP");
    expect(tooltip.textContent).toContain("Z4");
    expect(tooltip.textContent).toContain("Cadence 90 rpm");
    expect(tooltip.textContent).toContain("Hold steady 90 RPM");

    fireEvent.mouseLeave(polygon);
    expect(screen.queryByTestId("workout-profile-tooltip")).toBeNull();

    fireEvent.focus(polygon);
    expect(screen.getByTestId("workout-profile-tooltip")).toBeTruthy();

    fireEvent.keyDown(polygon, { key: "Escape" });
    expect(screen.queryByTestId("workout-profile-tooltip")).toBeNull();
  });

  it("matches zone colors at boundary thresholds and shows grade for slope steps", () => {
    const mixedSteps = [
      {
        step_index: 0,
        label: "Endurance Boundary",
        start_offset_s: 0,
        duration_s: 300,
        mode: "erg" as const,
        watts_start: 143, // 55% of 260W -> Z2
        watts_end: 143,
        grade_pct: null,
        resistance_pct: null,
        cadence_rpm: null,
        text_cue: null,
        is_work_interval: false,
      },
      {
        step_index: 1,
        label: "Climb Simulation",
        start_offset_s: 300,
        duration_s: 300,
        mode: "slope" as const,
        watts_start: null,
        watts_end: null,
        grade_pct: 4.5,
        resistance_pct: null,
        cadence_rpm: null,
        text_cue: null,
        is_work_interval: true,
      },
    ];

    render(<WorkoutProfileSvg steps={mixedSteps} ftpWatts={260} />);

    const z2Poly = screen.getByTestId("workout-profile-step-0");
    expect(z2Poly.getAttribute("fill")).toBe("#3b82f6");
    fireEvent.mouseEnter(z2Poly);
    expect(screen.getByTestId("workout-profile-tooltip").textContent).toContain("Z2");

    const slopePoly = screen.getByTestId("workout-profile-step-1");
    fireEvent.mouseEnter(slopePoly);
    const slopeTooltip = screen.getByTestId("workout-profile-tooltip");
    expect(slopeTooltip.textContent).toContain("Grade");
    expect(slopeTooltip.textContent).toContain("4.5%");
    expect(slopeTooltip.textContent).not.toContain("% FTP");
  });
});
