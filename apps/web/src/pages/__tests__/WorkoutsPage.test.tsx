import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WorkoutCategory } from "@paincave/shared";
import { WorkoutsPage } from "../WorkoutsPage.js";
import { api, type WorkoutRecord } from "../../lib/api.js";

function makeWorkout(overrides: Partial<WorkoutRecord> & { id: string; name: string; category: WorkoutCategory }): WorkoutRecord {
  const durationS = overrides.duration_s ?? 3600;
  const spec = {
    schema_version: 1,
    name: overrides.name,
    description: overrides.description ?? "",
    category: overrides.category,
    steps: [{ type: "steady", duration_s: durationS, target_ftp: 0.85, label: "Main" }],
  };
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? "",
    category: overrides.category,
    spec_json: JSON.stringify(spec),
    duration_s: durationS,
    predicted_np: overrides.predicted_np ?? 220,
    predicted_if: overrides.predicted_if ?? 0.85,
    predicted_tss: overrides.predicted_tss ?? 72,
    created_by: overrides.created_by ?? "llm",
    updated_at: overrides.updated_at ?? "2026-11-26T12:00:00Z",
  };
}

const SAMPLE_WORKOUTS: WorkoutRecord[] = [
  makeWorkout({
    id: "w-vo2",
    name: "5x4m VO2 Repeats",
    description: "High aerobic power intervals",
    category: "vo2max",
    duration_s: 2700, // 45m
    predicted_tss: 68,
    predicted_if: 0.95,
    updated_at: "2026-11-26T15:00:00Z",
  }),
  makeWorkout({
    id: "w-end",
    name: "Aerobic Base 90",
    description: "Steady zone 2 endurance ride",
    category: "endurance",
    duration_s: 5400, // 90m
    predicted_tss: 74,
    predicted_if: 0.7,
    updated_at: "2026-11-26T14:00:00Z",
  }),
  makeWorkout({
    id: "w-ss",
    name: "Sweet Spot 2x20",
    description: "Sustained 90% FTP blocks",
    category: "sweet_spot",
    duration_s: 3600, // 60m
    predicted_tss: 80,
    predicted_if: 0.89,
    updated_at: "2026-11-26T16:00:00Z",
  }),
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkoutsPage organization & categories", () => {
  it("groups workouts in physiological intensity order and filters by category, duration, and search", async () => {
    vi.spyOn(api, "getWorkouts").mockResolvedValue({ workouts: SAMPLE_WORKOUTS });
    const onLoadWorkout = vi.fn().mockResolvedValue(undefined);

    render(<WorkoutsPage ftpWatts={260} onLoadWorkout={onLoadWorkout} />);

    await screen.findByText("Sweet Spot 2x20");

    // Sections appear in physiological order: endurance -> sweet_spot -> vo2max
    const sections = screen.getAllByTestId(/^workout-category-section-/);
    expect(sections.map((el) => el.getAttribute("data-testid"))).toEqual([
      "workout-category-section-endurance",
      "workout-category-section-sweet_spot",
      "workout-category-section-vo2max",
    ]);

    // Filter by category pill
    const categoryBar = screen.getByRole("group", { name: "Filter by category" });
    fireEvent.click(within(categoryBar).getByRole("button", { name: /Sweet Spot/ }));
    expect(screen.getByText("Sweet Spot 2x20")).toBeTruthy();
    expect(screen.queryByText("Aerobic Base 90")).toBeNull();
    expect(screen.queryByText("5x4m VO2 Repeats")).toBeNull();

    // Reset back to All and filter by duration <= 45m
    fireEvent.click(within(categoryBar).getByRole("button", { name: /^All/ }));
    const durationBar = screen.getByRole("group", { name: "Filter by duration" });
    fireEvent.click(within(durationBar).getByRole("button", { name: "≤ 45m" }));
    expect(screen.getByText("5x4m VO2 Repeats")).toBeTruthy();
    expect(screen.queryByText("Aerobic Base 90")).toBeNull();
    expect(screen.queryByText("Sweet Spot 2x20")).toBeNull();

    // Search matches workout description after resetting filters
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    fireEvent.change(screen.getByLabelText("Search workouts"), {
      target: { value: "zone 2" },
    });
    expect(screen.getByText("Aerobic Base 90")).toBeTruthy();
    expect(screen.queryByText("5x4m VO2 Repeats")).toBeNull();
  });

  it("supports collapsing category sections, sorting in flat view, and recategorizing a workout", async () => {
    vi.spyOn(api, "getWorkouts").mockResolvedValue({ workouts: SAMPLE_WORKOUTS });
    const updateSpy = vi.spyOn(api, "updateWorkout").mockImplementation((id, spec) =>
      Promise.resolve({
        workout: makeWorkout({
          id,
          name: spec.name,
          description: spec.description,
          category: spec.category,
          duration_s: 3600,
        }),
      })
    );

    render(<WorkoutsPage ftpWatts={260} onLoadWorkout={vi.fn().mockResolvedValue(undefined)} />);
    await screen.findByText("Sweet Spot 2x20");

    // Collapse Sweet Spot section
    const ssSection = screen.getByTestId("workout-category-section-sweet_spot");
    fireEvent.click(within(ssSection).getByRole("button", { name: /Sweet Spot/ }));
    expect(screen.queryByText("Sweet Spot 2x20")).toBeNull();
    fireEvent.click(within(ssSection).getByRole("button", { name: /Sweet Spot/ }));
    expect(screen.getByText("Sweet Spot 2x20")).toBeTruthy();

    // Recategorize Sweet Spot 2x20 into Threshold
    fireEvent.change(screen.getByLabelText("Category for Sweet Spot 2x20"), {
      target: { value: "threshold" },
    });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        "w-ss",
        expect.objectContaining({ category: "threshold" })
      );
    });
    expect(screen.getByTestId("workout-category-section-threshold")).toBeTruthy();
    expect(screen.queryByTestId("workout-category-section-sweet_spot")).toBeNull();

    // Switch to flat view and sort shortest first
    fireEvent.click(screen.getByRole("button", { name: "All Cards" }));
    fireEvent.change(screen.getByLabelText("Sort workouts"), {
      target: { value: "duration_asc" },
    });
    const cards = screen.getAllByTestId(/^workout-card-/);
    expect(cards.map((el) => el.getAttribute("data-testid"))).toEqual([
      "workout-card-w-vo2",
      "workout-card-w-ss",
      "workout-card-w-end",
    ]);
  });
});
