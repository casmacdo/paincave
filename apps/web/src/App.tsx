import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { BridgeCommand } from "@paincave/shared";
import { api, type AthleteThreshold } from "./lib/api.js";
import {
  BridgeClient,
  DEFAULT_BRIDGE_WS_URL,
  type BridgeClientSnapshot,
} from "./lib/bridge-client.js";
import { VersionAutoReloader } from "./lib/auto-update.js";
import { RidePage } from "./pages/RidePage.js";
import { CalendarPage } from "./pages/CalendarPage.js";
import { WorkoutsPage } from "./pages/WorkoutsPage.js";
import { AnalyticsPage } from "./pages/AnalyticsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

export const APP_NAME = "PainCave";

type TabKey = "ride" | "calendar" | "workouts" | "analytics" | "settings";

export function App() {
  const [tab, setTab] = useState<TabKey>("ride");
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
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

  const refreshProfile = async () => {
    const prof = await api.getProfile();
    setThresholds(prof.latest_thresholds);
  };

  useEffect(() => {
    api
      .getMe()
      .then((res) => {
        setAuthenticated(res.authenticated);
        if (res.authenticated) {
          void refreshProfile();
        }
      })
      .catch(() => {
        setAuthenticated(false);
      })
      .finally(() => setAuthChecked(true));
  }, []);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      await api.login(password);
      setAuthenticated(true);
      setPassword("");
      await refreshProfile();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Login failed");
    }
  };

  const handleLoadWorkoutOnTrainer = async (workoutId: string, plannedSessionId?: string) => {
    const flattened = await api.getFlattenedWorkout(workoutId);
    const cmd: BridgeCommand = {
      type: "load_workout",
      workout_id: flattened.workout_id,
      planned_session_id: plannedSessionId ?? null,
      name: flattened.name,
      ftp_watts: flattened.ftp_watts,
      lthr_bpm: flattened.lthr_bpm,
      hrmax_bpm: flattened.hrmax_bpm,
      weight_kg: flattened.weight_kg,
      steps: flattened.steps,
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

  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4">
        <form
          onSubmit={(e) => void handleLogin(e)}
          className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6"
        >
          <h1 className="text-2xl font-black tracking-tight text-white">
            Pain<span className="text-orange-500">Cave</span>
          </h1>
          <p className="text-sm text-zinc-400">Sign in to manage workouts and trainer rides.</p>
          {loginError && (
            <div className="rounded-lg bg-rose-500/15 p-2.5 text-xs text-rose-300">{loginError}</div>
          )}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin Password"
            required
            className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-sm text-white"
          />
          <button
            type="submit"
            className="w-full rounded-xl bg-orange-500 py-3 text-sm font-bold text-zinc-950 hover:bg-orange-400"
          >
            Sign In
          </button>
        </form>
      </div>
    );
  }

  const ftpWatts = thresholds?.ftp_watts ?? 250;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="text-xl font-black tracking-tight text-white">
              Pain<span className="text-orange-500">Cave</span>
            </span>
            <nav className="flex gap-1">
              {(
                [
                  ["ride", "Ride"],
                  ["calendar", "Calendar"],
                  ["workouts", "Workouts"],
                  ["analytics", "Analytics"],
                  ["settings", "Settings"],
                ] as const
              ).map(([key, label]) => (
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
            <span className="text-zinc-400">FTP {ftpWatts}W</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {tab === "ride" && (
          <RidePage
            snapshot={bridgeSnapshot}
            ftpWatts={ftpWatts}
            sendCommand={(cmd) => bridgeClient.send(cmd)}
          />
        )}
        {tab === "calendar" && <CalendarPage onLoadWorkout={handleLoadWorkoutOnTrainer} />}
        {tab === "workouts" && (
          <WorkoutsPage ftpWatts={ftpWatts} onLoadWorkout={handleLoadWorkoutOnTrainer} />
        )}
        {tab === "analytics" && <AnalyticsPage thresholds={thresholds} />}
        {tab === "settings" && (
          <SettingsPage
            bridgeUrl={bridgeUrl}
            onChangeBridgeUrl={handleChangeBridgeUrl}
            bridgeSnapshot={bridgeSnapshot}
            latestThresholds={thresholds}
            onThresholdsUpdated={refreshProfile}
          />
        )}
      </main>
    </div>
  );
}
