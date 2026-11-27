import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../lib/i18n.js";
import { ThemeProvider } from "../../lib/theme.js";
import { api } from "../../lib/api.js";
import { OverviewPage } from "../OverviewPage.js";
import { SettingsPage } from "../SettingsPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("OverviewPage, Quebec French i18n, Light Mode, and clean Settings UX", () => {
  it("renders Overview in Quebec French by default, defaults to Light Mode, and avoids internal jargon", async () => {
    vi.spyOn(api, "getFitnessOverview").mockResolvedValue({
      current_pmc: { day: "2026-11-27", ctl: 48, atl: 52, tsb: -4, ramp_rate_7d: 2.1 },
      daily_pmc: [],
      weekly_rollups: [],
      mmp_42d: [],
      mmp_90d: [],
      cp_estimate_42d: null,
    });
    vi.spyOn(api, "getBiometrics").mockResolvedValue({
      days: 30,
      summary: {
        latest: {
          day: "2026-11-27",
          hrv_rmssd_ms: 71,
          hrv_status: "BALANCED",
          resting_hr_bpm: 47,
          sleep_duration_s: 28800,
          sleep_score: 86,
          body_battery_high: 93,
          weight_kg: 62,
        },
        hrv_7d_avg: 70,
        hrv_baseline_avg: 68,
        hrv_delta_pct: 2.9,
        resting_hr_7d_avg: 47,
        sleep_hours_7d_avg: 8,
        sleep_score_7d_avg: 85,
      },
      biometrics: [],
    });
    vi.spyOn(api, "getCalendar").mockResolvedValue({
      planned_sessions: [],
      completed_rides: [],
    });
    vi.spyOn(api, "getRides").mockResolvedValue({ rides: [] });
    vi.spyOn(api, "getNotes").mockResolvedValue({
      notes: [
        {
          id: "n-1",
          category: "injury",
          sport: "running",
          content: "Mollet gauche sensible en côte",
        },
      ],
    });
    vi.spyOn(api, "getGarminStatus").mockResolvedValue({
      connected: true,
      last_sync_at: "2026-11-27T12:00:00Z",
      last_error: null,
      token_expires_at: null,
    });

    const { container } = render(
      <ThemeProvider>
        <I18nProvider defaultLocale="fr-CA">
          <OverviewPage
            indoorTrainerEnabled={true}
            onOpenTrainer={vi.fn()}
            onNavigateTab={vi.fn()}
          />
        </I18nProvider>
      </ThemeProvider>
    );

    expect(await screen.findByText("Aperçu santé et entraînement")).toBeTruthy();
    expect(screen.getByText("Mémoire IA")).toBeTruthy();
    expect(screen.getByText("Mollet gauche sensible en côte")).toBeTruthy();
    expect(screen.getByRole("button", { name: /PainCave : Base d'entraînement/i })).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(container.textContent?.toLowerCase()).not.toContain("hub");
  });

  it("exposes Garmin historical date-range import in Quebec French without leaking internal env vars", async () => {
    vi.spyOn(api, "getGarminStatus").mockResolvedValue({
      connected: true,
      last_sync_at: "2026-11-27T12:00:00Z",
      last_error: null,
      token_expires_at: null,
    });
    vi.spyOn(api, "listDeviceTokens").mockResolvedValue({ tokens: [] });
    const rangeSpy = vi.spyOn(api, "syncGarminRange").mockResolvedValue({
      ok: true,
      rate_limited: false,
      retry_after_s: null,
      start_date: "2026-11-20",
      end_date: "2026-11-27",
      activities_imported: 3,
      activities_skipped: 1,
      biometrics_upserted: 7,
      error: null,
    });
    vi.spyOn(api, "rebuildPmc").mockResolvedValue({ ok: true });

    const { container } = render(
      <ThemeProvider>
        <I18nProvider defaultLocale="fr-CA">
          <SettingsPage
            profile={{
              display_name: "Runner",
              timezone: "America/Toronto",
              units: "metric",
              features: { indoor_trainer: false },
            }}
            latestThresholds={null}
            onThresholdsUpdated={vi.fn().mockResolvedValue(undefined)}
            authState={{
              authenticated: true,
              configured: true,
              auth_mode: "better_auth",
              user: { id: "u1", name: "Runner", email: "runner@example.com", image: null },
            }}
          />
        </I18nProvider>
      </ThemeProvider>
    );

    expect(await screen.findByText("Importer l'historique Garmin (plage de dates)")).toBeTruthy();
    // Ensure zero developer env vars leak into user-facing Settings UI
    const pageText = container.textContent ?? "";
    expect(pageText).not.toContain("STRAVA_CLIENT_ID");
    expect(pageText).not.toContain("ALLOWED_OWNER_EMAIL");
    expect(pageText).not.toContain("GOOGLE_CLIENT_ID");
    expect(pageText).not.toContain("MCP_BEARER_TOKEN");
    expect(pageText).not.toContain("Better Auth");

    // Set a 7-day range and trigger import
    fireEvent.change(screen.getByLabelText("Du"), { target: { value: "2026-11-20" } });
    fireEvent.change(screen.getByLabelText("Au"), { target: { value: "2026-11-26" } });
    fireEvent.click(screen.getByRole("button", { name: "Importer la période" }));

    expect(await screen.findByText(/Importation Garmin terminée/)).toBeTruthy();
    expect(rangeSpy).toHaveBeenCalledWith("2026-11-20", "2026-11-26", true);
  });
});
