import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkoutsPage } from "../WorkoutsPage.js";
import { api, type WorkoutRecord } from "../../lib/api.js";

function makeWorkout(overrides: Partial<WorkoutRecord> & { id: string; name: string; category: string }): WorkoutRecord {
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
    sport: overrides.sport ?? "cycling",
    name: overrides.name,
    description: overrides.description ?? "",
    category: overrides.category,
    spec_json: overrides.spec_json ?? JSON.stringify(spec),
    duration_s: durationS,
    predicted_np: overrides.predicted_np !== undefined ? overrides.predicted_np : 220,
    predicted_if: overrides.predicted_if !== undefined ? overrides.predicted_if : 0.85,
    predicted_tss: overrides.predicted_tss !== undefined ? overrides.predicted_tss : 72,
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

  it("imports a .zwo workout file and adds it to the library", async () => {
    vi.spyOn(api, "getWorkouts").mockResolvedValue({ workouts: SAMPLE_WORKOUTS });
    const createSpy = vi.spyOn(api, "createWorkout").mockImplementation((spec) =>
      Promise.resolve({
        workout: makeWorkout({
          id: "w-imported",
          name: spec.name,
          description: spec.description,
          category: spec.category,
          duration_s: 2400,
          created_by: "import",
        }),
      })
    );

    render(<WorkoutsPage ftpWatts={260} onLoadWorkout={vi.fn().mockResolvedValue(undefined)} />);
    await screen.findByText("Sweet Spot 2x20");

    const zwoXml = `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <name>Threshold Cruise 2x15</name>
  <description>Imported threshold intervals</description>
  <workout>
    <Warmup Duration="300" PowerLow="0.5" PowerHigh="0.75" />
    <IntervalsT Repeat="2" OnDuration="900" OffDuration="150" OnPower="0.98" OffPower="0.55" />
  </workout>
</workout_file>`;
    const file = new File([zwoXml], "threshold_cruise.zwo", { type: "application/xml" });
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(zwoXml),
    });

    const input = screen.getByLabelText("Import workout file");
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Threshold Cruise 2x15",
          category: "threshold",
        }),
        "import"
      );
    });
    expect(await screen.findByText("Threshold Cruise 2x15")).toBeTruthy();
    expect(screen.getByTestId("workout-category-section-threshold")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Imported");
  });

  it("opens the schedule modal, shows conflict errors, and schedules a workout with warnings", async () => {
    vi.spyOn(api, "getWorkouts").mockResolvedValue({ workouts: SAMPLE_WORKOUTS });
    const scheduleSpy = vi
      .spyOn(api, "scheduleSession")
      .mockRejectedValueOnce(new Error("A session is already planned on 2026-12-01"))
      .mockResolvedValueOnce({
        session: {
          id: "sess-1",
          scheduled_date: "2026-12-01",
          workout_id: "w-ss",
          status: "planned",
          coach_rationale: "Fuel 60g/hr",
          completed_ride_uuid: null,
          workout_name: "Sweet Spot 2x20",
          workout_category: "sweet_spot",
          planned_duration_s: 3600,
          predicted_if: 0.89,
          predicted_tss: 80,
        },
        warnings: ["Tuesday max duration is 45 min"],
      });

    render(<WorkoutsPage ftpWatts={260} onLoadWorkout={vi.fn().mockResolvedValue(undefined)} />);
    const ssCard = await screen.findByTestId("workout-card-w-ss");

    fireEvent.click(within(ssCard).getByRole("button", { name: "Schedule" }));
    const dialog = screen.getByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("Date"), {
      target: { value: "2026-12-01" },
    });
    fireEvent.change(within(dialog).getByLabelText("Session Note (optional)"), {
      target: { value: "Fuel 60g/hr" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to Calendar" }));

    // Conflict displayed inside modal
    expect(
      await within(dialog).findByText("A session is already planned on 2026-12-01")
    ).toBeTruthy();

    // Check replace existing and resubmit
    fireEvent.click(within(dialog).getByLabelText(/Replace existing planned session/i));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to Calendar" }));

    await waitFor(() => {
      expect(scheduleSpy).toHaveBeenLastCalledWith({
        scheduled_date: "2026-12-01",
        workout_id: "w-ss",
        coach_rationale: "Fuel 60g/hr",
        replace_existing: true,
      });
    });

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain('Scheduled "Sweet Spot 2x20" for 2026-12-01.');
    expect(notice.textContent).toContain("Tuesday max duration is 45 min");
  });

  it("renders running and strength workouts with sport badges, sport filter pills, and hides trainer load button", async () => {
    const multiSportWorkouts: WorkoutRecord[] = [
      ...SAMPLE_WORKOUTS,
      makeWorkout({
        id: "w-run-1",
        sport: "running",
        name: "5x1k Threshold Cruise",
        category: "threshold",
        duration_s: 3000,
        predicted_np: null,
        predicted_if: 0.94,
        predicted_tss: 68,
        spec_json: JSON.stringify({
          schema_version: 1,
          sport: "running",
          name: "5x1k Threshold Cruise",
          description: "Controlled threshold repeats",
          category: "threshold",
          steps: [
            { type: "warmup", duration_s: 600, pace_zone: "easy", label: "Warmup" },
            {
              type: "repeat",
              count: 5,
              steps: [
                { type: "interval", distance_m: 1000, pace_zone: "threshold", label: "1k T" },
                { type: "recovery", duration_s: 90, pace_zone: "recovery", label: "Jog" },
              ],
            },
            { type: "cooldown", duration_s: 600, pace_zone: "easy", label: "Cooldown" },
          ],
        }),
      }),
      makeWorkout({
        id: "w-str-1",
        sport: "strength",
        name: "Lower Body Force",
        category: "lower_body",
        duration_s: 2700,
        predicted_np: null,
        predicted_if: 0.72,
        predicted_tss: 36,
        spec_json: JSON.stringify({
          schema_version: 1,
          sport: "strength",
          name: "Lower Body Force",
          description: "Heavy hinge & single-leg session",
          category: "lower_body",
          blocks: [
            {
              label: "Main",
              block_type: "main",
              exercises: [
                {
                  name: "Trap Bar Deadlift",
                  movement_pattern: "hinge",
                  sets: 4,
                  reps: 5,
                  target_rpe_or_rir: "2 RIR",
                  rest_s: 180,
                },
              ],
            },
          ],
        }),
      }),
    ];

    vi.spyOn(api, "getWorkouts").mockResolvedValue({ workouts: multiSportWorkouts });
    render(<WorkoutsPage ftpWatts={260} onLoadWorkout={vi.fn().mockResolvedValue(undefined)} />);

    const runCard = await screen.findByTestId("workout-card-w-run-1");
    expect(within(runCard).getByText("Running")).toBeTruthy();
    expect(within(runCard).getByRole("link", { name: ".fit" }).getAttribute("href")).toBe(
      "/api/workouts/w-run-1/export.fit"
    );
    expect(within(runCard).queryByRole("button", { name: "Load on Trainer" })).toBeNull();

    const strCard = screen.getByTestId("workout-card-w-str-1");
    expect(within(strCard).getByText("Strength")).toBeTruthy();
    expect(within(strCard).getByText("Trap Bar Deadlift")).toBeTruthy();
    expect(within(strCard).queryByRole("button", { name: "Load on Trainer" })).toBeNull();

    // Filter by Running sport pill
    const sportBar = screen.getByRole("group", { name: "Filter by sport" });
    fireEvent.click(within(sportBar).getByRole("button", { name: /Running/ }));
    expect(screen.getByText("5x1k Threshold Cruise")).toBeTruthy();
    expect(screen.queryByText("Lower Body Force")).toBeNull();
    expect(screen.queryByText("Sweet Spot 2x20")).toBeNull();
  });
});
