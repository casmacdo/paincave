import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BUILT_IN_ROUTE_PRESETS } from "@paincave/shared";
import { RoutesPage } from "../RoutesPage.js";
import { api, type RouteRecord } from "../../lib/api.js";

const ALPINE = BUILT_IN_ROUTE_PRESETS.find((p) => p.id === "preset-alpine-climb")!;

const SAMPLE_ROUTES: RouteRecord[] = [
  {
    id: ALPINE.id,
    name: ALPINE.name,
    source: "preset",
    description: ALPINE.description,
    distance_m: ALPINE.distance_m,
    total_ascent_m: ALPINE.total_ascent_m,
    max_grade_pct: ALPINE.max_grade_pct,
    point_count: ALPINE.points.length,
    loop_route: ALPINE.loop_route,
    is_preset: true,
    created_at: null,
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RoutesPage", () => {
  it("previews routes, adjusts SIM trainer difficulty, and dispatches load_route payload", async () => {
    vi.spyOn(api, "getRoutes").mockResolvedValue({ routes: SAMPLE_ROUTES });
    vi.spyOn(api, "getRoute").mockResolvedValue({
      route: SAMPLE_ROUTES[0]!,
      points: ALPINE.points,
    });
    vi.spyOn(api, "getWorkouts").mockResolvedValue({ workouts: [] });
    vi.spyOn(api, "getRides").mockResolvedValue({ rides: [] });

    const onLoadRoute = vi.fn();
    const onLoadWorkoutWithRoute = vi.fn().mockResolvedValue(undefined);

    render(
      <RoutesPage
        onLoadRoute={onLoadRoute}
        onLoadWorkoutWithRoute={onLoadWorkoutWithRoute}
      />
    );

    expect(await screen.findByTestId("route-elevation-map")).toBeTruthy();

    // Lower trainer difficulty to 60% and launch SIM mode
    fireEvent.change(screen.getByLabelText("Trainer Difficulty"), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load Route on Trainer" }));

    expect(onLoadRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "HC Alpine Switchbacks",
        sim_mode: true,
        trainer_difficulty_pct: 60,
        loop_route: false,
      })
    );
  });

  it("uploads a .gpx route and selects it for preview", async () => {
    vi.spyOn(api, "getRoutes").mockResolvedValue({ routes: SAMPLE_ROUTES });
    vi.spyOn(api, "getRoute").mockResolvedValue({
      route: SAMPLE_ROUTES[0]!,
      points: ALPINE.points,
    });
    vi.spyOn(api, "getWorkouts").mockResolvedValue({ workouts: [] });
    vi.spyOn(api, "getRides").mockResolvedValue({ rides: [] });

    const uploadedPoints = [
      { lat_deg: 45.0, lon_deg: 6.0, elevation_m: 500 },
      { lat_deg: 45.002, lon_deg: 6.0, elevation_m: 520 },
    ];
    const uploadSpy = vi.spyOn(api, "uploadGpxRoute").mockResolvedValue({
      route: {
        id: "route-gpx-1",
        name: "My Backyard Climb",
        source: "gpx",
        description: "Imported GPX route",
        distance_m: 222,
        total_ascent_m: 20,
        max_grade_pct: 9.0,
        point_count: 2,
        loop_route: false,
        is_preset: false,
        created_at: "2026-11-26T20:00:00Z",
      },
      points: uploadedPoints,
    });

    render(
      <RoutesPage
        onLoadRoute={vi.fn()}
        onLoadWorkoutWithRoute={vi.fn().mockResolvedValue(undefined)}
      />
    );
    await screen.findByTestId("route-elevation-map");

    const gpxText = `<gpx><trk><name>My Backyard Climb</name><trkseg><trkpt lat="45.0" lon="6.0"><ele>500</ele></trkpt><trkpt lat="45.002" lon="6.0"><ele>520</ele></trkpt></trkseg></trk></gpx>`;
    const file = new File([gpxText], "backyard.gpx", { type: "application/gpx+xml" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(gpxText) });

    fireEvent.change(screen.getByLabelText("Import GPX route file"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith(gpxText, "backyard.gpx");
    });
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("My Backyard Climb");
  });
});
