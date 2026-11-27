import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../lib/i18n.js";
import { ThemeProvider } from "../../lib/theme.js";
import { api } from "../../lib/api.js";
import { App } from "../../App.js";
import { TrainerMenu } from "../../components/TrainerMenu.js";
import { OverviewPage } from "../OverviewPage.js";
import { SettingsPage } from "../SettingsPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("OverviewPage, persistent Trainer dropdown, Quebec French i18n, Light Mode, and clean Settings UX", () => {
  it("renders Overview in Quebec French by default, defaults to Light Mode, and avoids internal jargon", async () => {
    window.localStorage.setItem("paincave_theme", "dark");
    document.documentElement.classList.add("dark");
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
          <OverviewPage onNavigateTab={vi.fn()} />
        </I18nProvider>
      </ThemeProvider>
    );

    expect(await screen.findByText("Aperçu santé et entraînement")).toBeTruthy();
    expect(screen.getByText("Mémoire IA")).toBeTruthy();
    expect(screen.getByText("Mollet gauche sensible en côte")).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem("paincave_theme")).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain("hub");
  });

  it("opens the persistent Trainer dropdown menu and navigates directly to Live Ride, Routes, or Bridge", () => {
    const onSelect = vi.fn();
    render(
      <ThemeProvider>
        <I18nProvider defaultLocale="fr-CA">
          <TrainerMenu
            active={false}
            activeSubTab="ride"
            bridgeConnected={true}
            onSelect={onSelect}
          />
        </I18nProvider>
      </ThemeProvider>
    );

    const trigger = screen.getByRole("button", { name: /Base d'entraînement/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    // Open dropdown
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: /PainCave : Base d'entraînement/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Séance en direct/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Parcours/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Passerelle/i })).toBeTruthy();

    // Clicking Routes navigates and closes the menu
    fireEvent.click(screen.getByRole("menuitem", { name: /Parcours/i }));
    expect(onSelect).toHaveBeenCalledWith("routes");
    expect(screen.queryByRole("menu")).toBeNull();

    // Reopen and close with Escape
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("exposes Garmin historical date-range import in Quebec French without leaking internal env vars or optional trainer toggle", async () => {
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
    // Ensure zero developer env vars or optional trainer toggle leak into Settings UI
    const pageText = container.textContent ?? "";
    expect(pageText).not.toContain("STRAVA_CLIENT_ID");
    expect(pageText).not.toContain("ALLOWED_OWNER_EMAIL");
    expect(pageText).not.toContain("GOOGLE_CLIENT_ID");
    expect(pageText).not.toContain("MCP_BEARER_TOKEN");
    expect(pageText).not.toContain("Better Auth");
    expect(pageText).not.toContain("Activer PainCave : Base d'entraînement");

    // Set a 7-day range and trigger import
    fireEvent.change(screen.getByLabelText("Du"), { target: { value: "2026-11-20" } });
    fireEvent.change(screen.getByLabelText("Au"), { target: { value: "2026-11-26" } });
    fireEvent.click(screen.getByRole("button", { name: "Importer la période" }));

    expect(await screen.findByText(/Importation Garmin terminée/)).toBeTruthy();
    expect(rangeSpy).toHaveBeenCalledWith("2026-11-20", "2026-11-26", true);
  });

  it("navigates back to Overview when clicking PainCave logo in both French and English", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({
      authenticated: true,
      configured: true,
      auth_mode: "better_auth",
      user: { id: "u1", name: "Athlete", email: "athlete@example.com", image: null },
    });
    vi.spyOn(api, "getProfile").mockResolvedValue({
      profile: {
        display_name: "Athlete",
        timezone: "America/Toronto",
        units: "metric",
        features: { indoor_trainer: true },
      },
      latest_thresholds: null,
    });
    vi.spyOn(api, "getVersion").mockResolvedValue({ build_sha: "test", app_env: "test" });
    vi.spyOn(api, "getFitnessOverview").mockResolvedValue({
      current_pmc: { day: "2026-11-27", ctl: 40, atl: 40, tsb: 0, ramp_rate_7d: 0 },
      daily_pmc: [],
      weekly_rollups: [],
      mmp_42d: [],
      mmp_90d: [],
      cp_estimate_42d: null,
    });
    vi.spyOn(api, "getBiometrics").mockResolvedValue({
      days: 30,
      summary: {
        latest: null,
        hrv_7d_avg: null,
        hrv_baseline_avg: null,
        hrv_delta_pct: null,
        resting_hr_7d_avg: null,
        sleep_hours_7d_avg: null,
        sleep_score_7d_avg: null,
      },
      biometrics: [],
    });
    vi.spyOn(api, "getCalendar").mockResolvedValue({ planned_sessions: [], completed_rides: [] });
    vi.spyOn(api, "getRides").mockResolvedValue({ rides: [] });
    vi.spyOn(api, "getNotes").mockResolvedValue({ notes: [] });
    vi.spyOn(api, "getGarminStatus").mockResolvedValue({
      connected: false,
      last_sync_at: null,
      last_error: null,
      token_expires_at: null,
    });
    vi.spyOn(api, "listDeviceTokens").mockResolvedValue({ tokens: [] });

    render(<App />);
    expect(await screen.findByText("Aperçu santé et entraînement")).toBeTruthy();

    // French: go to Settings, click PainCave -> back to Overview
    fireEvent.click(screen.getByRole("button", { name: "Réglages" }));
    expect(await screen.findByText("Réglages et connexions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "PainCave" }));
    expect(await screen.findByText("Aperçu santé et entraînement")).toBeTruthy();

    // Switch to English: go to Settings, click PainCave -> back to Overview
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(await screen.findByText("Health & Training Overview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Settings & Integrations")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "PainCave" }));
    expect(await screen.findByText("Health & Training Overview")).toBeTruthy();
  });
});
