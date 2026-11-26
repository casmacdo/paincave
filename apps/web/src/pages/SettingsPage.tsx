import { useEffect, useState, type FormEvent } from "react";
import { api, type AthleteThreshold } from "../lib/api.js";
import type { BridgeClientSnapshot } from "../lib/bridge-client.js";

interface SettingsPageProps {
  bridgeUrl: string;
  onChangeBridgeUrl: (next: string) => void;
  bridgeSnapshot: BridgeClientSnapshot;
  latestThresholds: AthleteThreshold | null;
  onThresholdsUpdated: () => Promise<void>;
}

export function SettingsPage({
  bridgeUrl,
  onChangeBridgeUrl,
  bridgeSnapshot,
  latestThresholds,
  onThresholdsUpdated,
}: SettingsPageProps) {
  const [ftp, setFtp] = useState(String(latestThresholds?.ftp_watts ?? 250));
  const [lthr, setLthr] = useState(String(latestThresholds?.lthr_bpm ?? 170));
  const [hrmax, setHrmax] = useState(String(latestThresholds?.hrmax_bpm ?? 190));
  const [weight, setWeight] = useState(String(latestThresholds?.weight_kg ?? 72));
  const [bridgeInput, setBridgeInput] = useState(bridgeUrl);
  const [strava, setStrava] = useState<{
    configured: boolean;
    connected: boolean;
    athlete_external_id: string | null;
  }>({ configured: false, connected: false, athlete_external_id: null });
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.getStravaStatus().then(setStrava);
  }, []);

  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "https://your-worker.workers.dev/mcp";

  const handleSaveThresholds = async (e: FormEvent) => {
    e.preventDefault();
    await api.createThreshold({
      effective_from: new Date().toISOString().slice(0, 10),
      ftp_watts: Number(ftp),
      lthr_bpm: Number(lthr) || null,
      hrmax_bpm: Number(hrmax) || null,
      weight_kg: Number(weight) || null,
    });
    await onThresholdsUpdated();
    setSavedMsg("Saved new dated threshold snapshot.");
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Settings & Integrations</h1>

      {savedMsg && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
          {savedMsg}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <form
          onSubmit={(e) => void handleSaveThresholds(e)}
          className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
        >
          <h2 className="text-lg font-bold text-white">Athlete Thresholds (Dated Snapshot)</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-zinc-400">
              FTP (Watts)
              <input
                type="number"
                value={ftp}
                onChange={(e) => setFtp(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
              />
            </label>
            <label className="text-xs text-zinc-400">
              LTHR (BPM)
              <input
                type="number"
                value={lthr}
                onChange={(e) => setLthr(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
              />
            </label>
            <label className="text-xs text-zinc-400">
              HRmax (BPM)
              <input
                type="number"
                value={hrmax}
                onChange={(e) => setHrmax(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
              />
            </label>
            <label className="text-xs text-zinc-400">
              Weight (kg)
              <input
                type="number"
                step="0.1"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
              />
            </label>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-orange-400"
          >
            Save Threshold Snapshot
          </button>
        </form>

        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-lg font-bold text-white">Local Linux Trainer Bridge</h2>
          <p className="text-xs text-zinc-400">
            Status:{" "}
            <strong className={bridgeSnapshot.connected ? "text-emerald-400" : "text-amber-400"}>
              {bridgeSnapshot.connected ? "Connected" : "Disconnected"}
            </strong>{" "}
            · Transport: {bridgeSnapshot.telemetry?.sensors.transport ?? "offline"}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={bridgeInput}
              onChange={(e) => setBridgeInput(e.target.value)}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
            />
            <button
              type="button"
              onClick={() => {
                onChangeBridgeUrl(bridgeInput);
                setSavedMsg("Updated bridge WebSocket URL.");
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700"
            >
              Apply
            </button>
          </div>

          <div className="border-t border-zinc-800 pt-4">
            <h3 className="text-sm font-bold text-white">Strava Outbound Upload</h3>
            <p className="mt-1 text-xs text-zinc-400">
              {strava.connected
                ? `Connected (Athlete ${strava.athlete_external_id ?? "linked"}) — indoor .fit rides auto-upload.`
                : strava.configured
                  ? "Strava API configured. Click below to authorize upload access."
                  : "Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET Worker secrets to enable."}
            </p>
            {strava.configured && !strava.connected && (
              <a
                href="/api/strava/connect"
                className="mt-2 inline-block rounded-lg bg-orange-500 px-4 py-2 text-xs font-bold text-zinc-950"
              >
                Connect Strava
              </a>
            )}
          </div>
        </div>
      </div>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-lg font-bold text-white">Remote MCP Coach (Mobile & Desktop)</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Add this URL as a custom Remote MCP connector in Claude Mobile/Web or ChatGPT (uses OAuth
          2.1 + PKCE with your PainCave admin password), or authenticate CLI clients using your{" "}
          <code>MCP_BEARER_TOKEN</code>.
        </p>
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-orange-300">
          {mcpUrl}
        </div>
      </section>
    </div>
  );
}
