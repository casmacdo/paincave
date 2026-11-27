import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AnalyticsPage } from "../AnalyticsPage.js";
import { api, type FitnessOverviewResponse, type RideRecord } from "../../lib/api.js";

const MOCK_OVERVIEW: FitnessOverviewResponse = {
  current_pmc: { day: "2026-11-26", ctl: 54.2, atl: 61.5, tsb: -7.3, ramp_rate_7d: 4.1 },
  daily_pmc: [
    { day: "2026-11-24", total_tss: 65, ctl: 52.1, atl: 58.0, tsb: -5.9, ramp_rate_7d: 3.2 },
    { day: "2026-11-25", total_tss: 0, ctl: 51.0, atl: 50.0, tsb: 1.0, ramp_rate_7d: 2.5 },
    { day: "2026-11-26", total_tss: 84, ctl: 54.2, atl: 61.5, tsb: -7.3, ramp_rate_7d: 4.1 },
  ],
  weekly_rollups: [
    { week_start: "2026-11-16", rides: 4, hours: 5.5, tss: 320, work_kj: 2400 },
    { week_start: "2026-11-23", rides: 3, hours: 4.2, tss: 265, work_kj: 1950 },
  ],
  mmp_42d: [
    { duration_s: 5, watts: 820, w_per_kg: 11.4 },
    { duration_s: 60, watts: 410, w_per_kg: 5.7 },
    { duration_s: 300, watts: 310, w_per_kg: 4.3 },
    { duration_s: 1200, watts: 265, w_per_kg: 3.68 },
  ],
  mmp_90d: [
    { duration_s: 5, watts: 850, w_per_kg: 11.8 },
    { duration_s: 60, watts: 420, w_per_kg: 5.8 },
    { duration_s: 300, watts: 315, w_per_kg: 4.38 },
    { duration_s: 1200, watts: 270, w_per_kg: 3.75 },
  ],
  cp_estimate_42d: { cp_watts: 258, w_prime_j: 18500, r_squared: 0.99, eftp_watts: 258 },
};

const MOCK_RIDE: RideRecord = {
  ride_uuid: "550e8400-e29b-41d4-a716-446655440010",
  name: "Threshold 3x10",
  source: "indoor_bridge",
  workout_id: "w-1",
  started_at: "2026-11-26T12:00:00Z",
  ride_day: "2026-11-26",
  duration_s: 3600,
  work_kj: 680,
  avg_power: 215,
  np_watts: 238,
  intensity_factor: 0.91,
  tss: 84,
  variability_index: 1.11,
  avg_hr: 158,
  max_hr: 179,
  efficiency_factor: 1.51,
  pw_hr_decoupling: 2.3,
  hrr_60s: 34,
  time_gt_90_hrmax_s: 420,
  avg_cadence: 90,
  compliance_pct: 97,
  rpe: 7,
  feel: 4,
  notes: "Strong finish",
  strava_upload_status: "failed",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AnalyticsPage charts, timeseries, and Strava retry", () => {
  it("renders PMC, MMP, and weekly load charts, switches 42d/90d, loads ride timeseries, and retries Strava", async () => {
    const overviewSpy = vi.spyOn(api, "getFitnessOverview").mockResolvedValue(MOCK_OVERVIEW);
    vi.spyOn(api, "getRides").mockResolvedValue({ rides: [MOCK_RIDE] });
    vi.spyOn(api, "getRideDetail").mockResolvedValue({
      ride: MOCK_RIDE,
      intervals: [
        {
          step_index: 0,
          label: "Rep 1",
          target_watts: 260,
          actual_avg_watts: 259,
          pct_of_target: 99.6,
          avg_hr: 162,
          hr_drift_bpm: 3,
          status: "completed",
        },
      ],
      peaks: [],
    });
    vi.spyOn(api, "getRideTimeseries").mockResolvedValue({
      ride_uuid: MOCK_RIDE.ride_uuid,
      name: MOCK_RIDE.name,
      bucket_seconds: 15,
      raw_samples: 60,
      points: [
        { t_s: 0, watts: 180, hr_bpm: 132, cadence_rpm: 88, speed_kph: 30 },
        { t_s: 15, watts: 260, hr_bpm: 160, cadence_rpm: 91, speed_kph: 36 },
        { t_s: 30, watts: 262, hr_bpm: 165, cadence_rpm: 90, speed_kph: 36 },
      ],
    });
    const retrySpy = vi.spyOn(api, "retryStravaUpload").mockResolvedValue({
      ride_uuid: MOCK_RIDE.ride_uuid,
      status: "uploaded",
      upload_id: "999001",
      error: null,
    });

    render(<AnalyticsPage thresholds={null} />);

    await screen.findByTestId("pmc-chart");
    expect(screen.getByTestId("mmp-chart")).toBeTruthy();
    expect(screen.getByTestId("weekly-load-chart")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "90d" }));
    await waitFor(() => {
      expect(overviewSpy).toHaveBeenCalledWith(90);
    });

    fireEvent.click(screen.getByText("Threshold 3x10"));
    await screen.findByTestId("ride-timeseries-chart");
    expect(screen.getByRole("button", { name: "Download Summary PNG" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry Strava" }));
    await waitFor(() => {
      expect(retrySpy).toHaveBeenCalledWith(MOCK_RIDE.ride_uuid);
    });
    expect(await screen.findByText(/Uploaded to Strava/)).toBeTruthy();
  });
});
