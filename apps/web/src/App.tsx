import { useCallback, useEffect, useMemo, useState } from "react";
import type { BridgeCommand, RoutePayload } from "@paincave/shared";
import { api, type AthleteProfile, type AthleteThreshold, type AuthState } from "./lib/api.js";
import {
  BridgeClient,
  DEFAULT_BRIDGE_WS_URL,
  type BridgeClientSnapshot,
} from "./lib/bridge-client.js";
import { VersionAutoReloader } from "./lib/auto-update.js";
import { I18nProvider, useI18n } from "./lib/i18n.js";
import { ThemeProvider } from "./lib/theme.js";
import { AuthScreen } from "./components/AuthScreen.js";
import { TrainerMenu } from "./components/TrainerMenu.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { CalendarPage } from "./pages/CalendarPage.js";
import { WorkoutsPage } from "./pages/WorkoutsPage.js";
import { AnalyticsPage } from "./pages/AnalyticsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { TrainerWorkspace, type TrainerSubTab } from "./pages/TrainerWorkspace.js";

export const APP_NAME = "PainCave";

type CoreTabKey = "overview" | "calendar" | "workouts" | "trends" | "settings" | "trainer";

function parseLocationHash(): { tab: CoreTabKey; trainerSubTab: TrainerSubTab } {
  if (typeof window === "undefined") {
    return { tab: "overview", trainerSubTab: "ride" };
  }
  const raw = window.location.hash.replace(/^#/, "").trim().toLowerCase();
  if (raw === "calendar" || raw === "workouts" || raw === "trends" || raw === "settings") {
    return { tab: raw, trainerSubTab: "ride" };
  }
  if (raw === "trainer" || raw === "trainer/ride") {
    return { tab: "trainer", trainerSubTab: "ride" };
  }
  if (raw === "trainer/routes") {
    return { tab: "trainer", trainerSubTab: "routes" };
  }
  if (raw === "trainer/bridge") {
    return { tab: "trainer", trainerSubTab: "bridge" };
  }
  return { tab: "overview", trainerSubTab: "ride" };
}

function buildLocationHash(tab: CoreTabKey, trainerSubTab: TrainerSubTab): string {
  return tab === "trainer" ? `#trainer/${trainerSubTab}` : `#${tab}`;
}

function AppShell() {
  const { locale, setLocale, t } = useI18n();
  const initialNav = useMemo(() => parseLocationHash(), []);
  const [tab, setTab] = useState<CoreTabKey>(initialNav.tab);
  const [trainerSubTab, setTrainerSubTab] = useState<TrainerSubTab>(initialNav.trainerSubTab);
  const [authChecked, setAuthChecked] = useState(false);
  const [authState, setAuthState] = useState<AuthState>({
    authenticated: false,
    configured: true,
  });
  const [profile, setProfile] = useState<AthleteProfile | null>(null);
  const [thresholds, setThresholds] = useState<AthleteThreshold | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState(() => {
    if (typeof window !== "undefined") {
      return window.localStorage.getItem("paincave_bridge_ws") ?? DEFAULT_BRIDGE_WS_URL;
    }
    return DEFAULT_BRIDGE_WS_URL;
  });

  const bridgeClient = useMemo(() => new BridgeClient(bridgeUrl), [bridgeUrl]);
  const [bridgeSnapshot, setBridgeSnapshot] = useState<BridgeClientSnapshot>(
    bridgeClient.getSnapshot()
  );

  useEffect(() => {
    const unsub = bridgeClient.subscribe(setBridgeSnapshot);
    bridgeClient.connect();
    return () => {
      unsub();
      bridgeClient.disconnect();
    };
  }, [bridgeClient]);

  useEffect(() => {
    const reloader = new VersionAutoReloader({
      fetchVersion: () => api.getVersion(),
      getWorkoutState: () => bridgeClient.getSnapshot().telemetry?.state ?? "idle",
      onUpdateDetected: () => {
        window.location.reload();
      },
    });
    reloader.start();
    return () => reloader.stop();
  }, [bridgeClient]);

  const refreshProfile = useCallback(async () => {
    const prof = await api.getProfile();
    setProfile(prof.profile);
    setThresholds(prof.latest_thresholds);
  }, []);

  const refreshAuthState = useCallback(async () => {
    try {
      const res = await api.getMe();
      setAuthState(res);
      if (res.authenticated) {
        await refreshProfile();
      }
    } catch {
      setAuthState({ authenticated: false, configured: true });
    } finally {
      setAuthChecked(true);
    }
  }, [refreshProfile]);

  useEffect(() => {
    void refreshAuthState();
  }, [refreshAuthState]);

  useEffect(() => {
    if (typeof window === "undefined" || !authState.authenticated) return;
    const nextHash = buildLocationHash(tab, trainerSubTab);
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
    }
  }, [authState.authenticated, tab, trainerSubTab]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHashChange = () => {
      const parsed = parseLocationHash();
      setTab(parsed.tab);
      setTrainerSubTab(parsed.trainerSubTab);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const handleSignOut = async () => {
    await api.logout().catch(() => {});
    setTab("overview");
    await refreshAuthState();
  };

  const handleLoadWorkoutOnTrainer = async (
    workoutId: string,
    plannedSessionId?: string,
    route?: RoutePayload
  ) => {
    const flattened = await api.getFlattenedWorkout(workoutId);
    const cmd: BridgeCommand = {
      type: "load_workout",
      workout_id: flattened.workout_id,
      planned_session_id: plannedSessionId ?? null,
      name: route ? `${flattened.name} · ${route.name}` : flattened.name,
      ftp_watts: flattened.ftp_watts,
      lthr_bpm: flattened.lthr_bpm,
      hrmax_bpm: flattened.hrmax_bpm,
      weight_kg: flattened.weight_kg,
      steps: flattened.steps,
      route: route ?? null,
    };
    bridgeClient.send(cmd);
    setTrainerSubTab("ride");
    setTab("trainer");
  };

  const handleLoadRouteOnTrainer = (route: RoutePayload) => {
    const cmd: BridgeCommand = {
      type: "load_route",
      name: route.sim_mode ? `${route.name} (SIM)` : route.name,
      ftp_watts: thresholds?.ftp_watts ?? 250,
      lthr_bpm: thresholds?.lthr_bpm ?? null,
      hrmax_bpm: thresholds?.hrmax_bpm ?? null,
      weight_kg: thresholds?.weight_kg ?? null,
      route,
    };
    bridgeClient.send(cmd);
    setTrainerSubTab("ride");
    setTab("trainer");
  };

  const handleChangeBridgeUrl = (next: string) => {
    window.localStorage.setItem("paincave_bridge_ws", next);
    setBridgeUrl(next);
  };

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        {t("nav.loading")} {APP_NAME}...
      </div>
    );
  }

  if (!authState.authenticated) {
    return <AuthScreen authState={authState} />;
  }

  const ftpWatts = thresholds?.ftp_watts ?? 250;
  const coreNavItems: readonly [Exclude<CoreTabKey, "trainer">, string][] = [
    ["overview", t("nav.overview")],
    ["calendar", t("nav.calendar")],
    ["workouts", t("nav.workouts")],
    ["trends", t("nav.trends")],
    ["settings", t("nav.settings")],
  ];

  const activeWorkoutName =
    bridgeSnapshot.telemetry?.workout_name ?? bridgeSnapshot.loadedWorkoutName ?? null;
  const hasActiveSession = Boolean(
    (bridgeSnapshot.telemetry && bridgeSnapshot.telemetry.state !== "idle") ||
      bridgeSnapshot.loadedSteps.length > 0 ||
      bridgeSnapshot.loadedRoute ||
      bridgeSnapshot.loadedWorkoutName
  );

  const handleOpenTrainerSubTab = (subTab: TrainerSubTab) => {
    setTrainerSubTab(subTab);
    setTab("trainer");
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-5">
            <button
              type="button"
              aria-label="PainCave"
              onClick={() => setTab("overview")}
              className="cursor-pointer text-xl font-black tracking-tight text-white"
            >
              Pain<span className="text-orange-500">Cave</span>
            </button>
            <nav className="flex flex-wrap gap-1">
              {coreNavItems.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    tab === key
                      ? "bg-orange-500 font-bold text-zinc-950"
                      : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <TrainerMenu
              active={tab === "trainer"}
              activeSubTab={trainerSubTab}
              bridgeConnected={bridgeSnapshot.connected}
              hasActiveSession={hasActiveSession}
              activeWorkoutName={activeWorkoutName}
              onSelect={handleOpenTrainerSubTab}
            />

            <div
              role="group"
              aria-label="Language"
              className="inline-flex rounded-lg border border-zinc-700 bg-zinc-950 p-0.5 text-[11px] font-semibold"
            >
              <button
                type="button"
                onClick={() => setLocale("fr-CA")}
                aria-pressed={locale === "fr-CA"}
                className={`rounded-md px-2 py-0.5 ${
                  locale === "fr-CA"
                    ? "bg-orange-500 text-zinc-950"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                FR
              </button>
              <button
                type="button"
                onClick={() => setLocale("en")}
                aria-pressed={locale === "en"}
                className={`rounded-md px-2 py-0.5 ${
                  locale === "en"
                    ? "bg-orange-500 text-zinc-950"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                EN
              </button>
            </div>

            {authState.user && (
              <span className="hidden rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-zinc-300 sm:inline">
                {authState.user.name}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {tab === "overview" && (
          <OverviewPage onNavigateTab={(next) => setTab(next)} />
        )}

        {tab === "calendar" && (
          <CalendarPage onLoadWorkout={handleLoadWorkoutOnTrainer} />
        )}

        {tab === "workouts" && (
          <WorkoutsPage
            ftpWatts={ftpWatts}
            thresholdPaceSPerKm={thresholds?.threshold_pace_s_per_km ?? null}
            onLoadWorkout={handleLoadWorkoutOnTrainer}
          />
        )}

        {tab === "trends" && <AnalyticsPage thresholds={thresholds} />}

        {tab === "settings" && (
          <SettingsPage
            profile={profile}
            latestThresholds={thresholds}
            onThresholdsUpdated={refreshProfile}
            authState={authState}
            onSignOut={handleSignOut}
          />
        )}

        {tab === "trainer" && (
          <TrainerWorkspace
            subTab={trainerSubTab}
            onChangeSubTab={setTrainerSubTab}
            onExitTrainer={() => setTab("overview")}
            snapshot={bridgeSnapshot}
            ftpWatts={ftpWatts}
            bridgeUrl={bridgeUrl}
            onChangeBridgeUrl={handleChangeBridgeUrl}
            sendCommand={(cmd) => bridgeClient.send(cmd)}
            onLoadRoute={handleLoadRouteOnTrainer}
            onLoadWorkoutWithRoute={(workoutId, route) =>
              handleLoadWorkoutOnTrainer(workoutId, undefined, route)
            }
          />
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <I18nProvider defaultLocale="fr-CA">
        <AppShell />
      </I18nProvider>
    </ThemeProvider>
  );
}
