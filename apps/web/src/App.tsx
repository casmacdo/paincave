import { useCallback, useEffect, useMemo, useState } from "react";
import type { BridgeCommand, RoutePayload } from "@paincave/shared";
import { api, type AthleteProfile, type AthleteThreshold, type AuthState } from "./lib/api.js";
import {
  BridgeClient,
  DEFAULT_BRIDGE_WS_URL,
  type BridgeClientSnapshot,
} from "./lib/bridge-client.js";
import { VersionAutoReloader } from "./lib/auto-update.js";
import { AuthScreen } from "./components/AuthScreen.js";
import { RidePage } from "./pages/RidePage.js";
import { CalendarPage } from "./pages/CalendarPage.js";
import { WorkoutsPage } from "./pages/WorkoutsPage.js";
import { RoutesPage } from "./pages/RoutesPage.js";
import { AnalyticsPage } from "./pages/AnalyticsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

export const APP_NAME = "PainCave";

type TabKey = "ride" | "calendar" | "workouts" | "routes" | "analytics" | "settings";

export function App() {
  const [tab, setTab] = useState<TabKey>("ride");
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
    const trainerEnabled = prof.profile?.features?.indoor_trainer ?? true;
    if (!trainerEnabled) {
      setTab((prev) => (prev === "ride" || prev === "routes" ? "analytics" : prev));
    }
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

  const handleSignOut = async () => {
    await api.logout().catch(() => {});
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
    setTab("ride");
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
    setTab("ride");
  };

  const handleChangeBridgeUrl = (next: string) => {
    window.localStorage.setItem("paincave_bridge_ws", next);
    setBridgeUrl(next);
  };

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        Loading {APP_NAME}...
      </div>
    );
  }

  if (!authState.authenticated) {
    return <AuthScreen authState={authState} onAuthenticated={refreshAuthState} />;
  }

  const ftpWatts = thresholds?.ftp_watts ?? 250;
  const indoorTrainerEnabled = profile?.features?.indoor_trainer ?? true;
  const navItems: readonly [TabKey, string][] = indoorTrainerEnabled
    ? [
        ["ride", "Ride"],
        ["calendar", "Calendar"],
        ["workouts", "Workouts"],
        ["routes", "Routes"],
        ["analytics", "Analytics"],
        ["settings", "Settings"],
      ]
    : [
        ["calendar", "Calendar"],
        ["workouts", "Workouts"],
        ["analytics", "Analytics"],
        ["settings", "Settings"],
      ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="text-xl font-black tracking-tight text-white">
              Pain<span className="text-orange-500">Cave</span>
            </span>
            <nav className="flex gap-1">
              {navItems.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    tab === key
                      ? "bg-orange-500 text-zinc-950 font-bold"
                      : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3 text-xs">
            {indoorTrainerEnabled && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                  bridgeSnapshot.connected
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-zinc-800 text-zinc-400"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    bridgeSnapshot.connected ? "bg-emerald-400" : "bg-zinc-500"
                  }`}
                />
                {bridgeSnapshot.connected ? "Bridge Connected" : "Bridge Offline"}
              </span>
            )}
            {thresholds?.ftp_watts && (
              <span className="text-zinc-400">FTP {thresholds.ftp_watts}W</span>
            )}
            {authState.user && (
              <span className="hidden rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-zinc-300 sm:inline">
                {authState.user.name}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {tab === "ride" && indoorTrainerEnabled && (
          <RidePage
            snapshot={bridgeSnapshot}
            ftpWatts={ftpWatts}
            sendCommand={(cmd) => bridgeClient.send(cmd)}
          />
        )}
        {tab === "calendar" && (
          <CalendarPage
            indoorTrainerEnabled={indoorTrainerEnabled}
            onLoadWorkout={handleLoadWorkoutOnTrainer}
          />
        )}
        {tab === "workouts" && (
          <WorkoutsPage
            ftpWatts={ftpWatts}
            thresholdPaceSPerKm={thresholds?.threshold_pace_s_per_km ?? null}
            indoorTrainerEnabled={indoorTrainerEnabled}
            onLoadWorkout={handleLoadWorkoutOnTrainer}
          />
        )}
        {tab === "routes" && indoorTrainerEnabled && (
          <RoutesPage
            onLoadRoute={handleLoadRouteOnTrainer}
            onLoadWorkoutWithRoute={(workoutId, route) =>
              handleLoadWorkoutOnTrainer(workoutId, undefined, route)
            }
          />
        )}
        {tab === "analytics" && <AnalyticsPage thresholds={thresholds} />}
        {tab === "settings" && (
          <SettingsPage
            bridgeUrl={bridgeUrl}
            onChangeBridgeUrl={handleChangeBridgeUrl}
            bridgeSnapshot={bridgeSnapshot}
            profile={profile}
            latestThresholds={thresholds}
            onThresholdsUpdated={refreshProfile}
            authState={authState}
            onSignOut={handleSignOut}
          />
        )}
      </main>
    </div>
  );
}
