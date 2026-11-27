import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BUILT_IN_ROUTE_PRESETS } from "@paincave/shared";
import { RouteElevationMap } from "../RouteElevationMap.js";

afterEach(() => {
  cleanup();
});

describe("RouteElevationMap", () => {
  it("renders grade-colored elevation profile, GPS map trace, and live rider position", () => {
    const alpine = BUILT_IN_ROUTE_PRESETS.find((p) => p.id === "preset-alpine-climb");
    expect(alpine).toBeDefined();

    render(
      <RouteElevationMap
        name={alpine!.name}
        points={alpine!.points}
        simMode
        trainerDifficultyPct={75}
        currentDistanceM={3500}
        currentGradePct={8.4}
        currentElevationM={710}
        speedKph={12.6}
      />
    );

    expect(screen.getByText("HC Alpine Switchbacks")).toBeTruthy();
    expect(screen.getByText("SIM · 75%")).toBeTruthy();
    expect(screen.getByText("+8.4%")).toBeTruthy();
    expect(screen.getByText("12.6 kph")).toBeTruthy();
    expect(screen.getByLabelText("Elevation profile for HC Alpine Switchbacks")).toBeTruthy();
    expect(screen.getByLabelText("Route map for HC Alpine Switchbacks")).toBeTruthy();
    expect(screen.getByTestId("route-rider-marker")).toBeTruthy();
  });
});
