import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type AthleteThreshold, type AuthState } from "../lib/api.js";
import { authClient } from "../lib/auth-client.js";
import type { BridgeClientSnapshot } from "../lib/bridge-client.js";

interface PasskeyRecord {
  id: string;
  name?: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt?: string | Date | null;
}

interface SettingsPageProps {
  bridgeUrl: string;
  onChangeBridgeUrl: (next: string) => void;
  bridgeSnapshot: BridgeClientSnapshot;
  latestThresholds: AthleteThreshold | null;
  onThresholdsUpdated: () => Promise<void>;
  authState?: AuthState;
  onSignOut?: () => Promise<void>;
}

export function SettingsPage({
  bridgeUrl,
  onChangeBridgeUrl,
  bridgeSnapshot,
  latestThresholds,
  onThresholdsUpdated,
  authState,
  onSignOut,
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
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
  const [passkeyName, setPasskeyName] = useState("");
  const [addingPasskey, setAddingPasskey] = useState(false);

  const isBetterAuth = authState?.auth_mode === "better_auth";
  const providers = authState?.providers;

  const loadPasskeys = useCallback(async () => {
    if (!isBetterAuth) {
      setPasskeys([]);
      return;
    }
    try {
      const res = await authClient.passkey.listUserPasskeys();
      if (Array.isArray(res.data)) {
        setPasskeys(res.data);
      }
    } catch {
      // Ignore passkey list failure in non-WebAuthn contexts
    }
  }, [isBetterAuth]);

  useEffect(() => {
    void api.getStravaStatus().then(setStrava);
  }, []);

  useEffect(() => {
    void loadPasskeys();
  }, [loadPasskeys]);

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-worker.workers.dev";
  const mcpUrl = `${origin}/mcp`;

  const handleAddPasskey = async () => {
    setAddingPasskey(true);
    setAuthErr(null);
    setSavedMsg(null);
    try {
      const res = await authClient.passkey.addPasskey({
        name: passkeyName.trim() || "PainCave Device",
      });
      if (res?.error) {
        setAuthErr(res.error.message ?? "Could not register passkey");
      } else {
        setPasskeyName("");
        setSavedMsg("Registered new passkey.");
        await loadPasskeys();
      }
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : "Passkey registration cancelled");
    } finally {
      setAddingPasskey(false);
    }
  };

  const handleDeletePasskey = async (id: string) => {
    setAuthErr(null);
    try {
      const res = await authClient.passkey.deletePasskey({ id });
      if (res?.error) {
        setAuthErr(res.error.message ?? "Could not delete passkey");
      } else {
        setPasskeys((prev) => prev.filter((p) => p.id !== id));
      }
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : "Failed to delete passkey");
    }
  };

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

      <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">Account &amp; Security (Better Auth)</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              {isBetterAuth && authState?.user
                ? `Signed in as ${authState.user.name} (${authState.user.email}) · Single-owner instance locked.`
                : "Signed in via legacy admin password fallback."}
              {authState?.owner_email_restricted && " Enforcing ALLOWED_OWNER_EMAIL."}
            </p>
          </div>
          {onSignOut && (
            <button
              type="button"
              onClick={() => void onSignOut()}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 hover:text-white"
            >
              Sign Out
            </button>
          )}
        </div>

        {authErr && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-200">
            {authErr}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Passkeys */}
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <h3 className="text-sm font-bold text-white">Passkeys (Touch ID / Face ID / Security Key)</h3>
            {isBetterAuth ? (
              <>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={passkeyName}
                    onChange={(e) => setPasskeyName(e.target.value)}
                    placeholder="Device label (e.g. Linux Laptop)"
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-white placeholder:text-zinc-500"
                  />
                  <button
                    type="button"
                    disabled={addingPasskey}
                    onClick={() => void handleAddPasskey()}
                    className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
                  >
                    {addingPasskey ? "Registering..." : "+ Add Passkey"}
                  </button>
                </div>
                {passkeys.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    No passkeys registered yet. Add one for 1-tap basement &amp; mobile sign-in.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {passkeys.map((pk) => (
                      <li
                        key={pk.id}
                        className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs"
                      >
                        <div>
                          <div className="font-semibold text-zinc-100">{pk.name || "Passkey"}</div>
                          <div className="text-[11px] text-zinc-500">
                            {pk.deviceType} {pk.backedUp ? "· Synced" : "· Device-bound"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleDeletePasskey(pk.id)}
                          className="text-rose-400 hover:text-rose-300"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-xs text-zinc-400">
                Sign out and create or sign in with your Better Auth owner account to register passkeys.
              </p>
            )}
          </div>

          {/* Google OAuth Provider */}
          <div className="space-y-2.5 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <h3 className="text-sm font-bold text-white">Google Sign-In</h3>
            <p className="text-[11px] text-zinc-400">
              Google OAuth is locked to your single owner account via Better Auth.
            </p>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">Google</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                    providers?.google
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {providers?.google ? "Enabled" : "Not configured"}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-zinc-400">
                Callback: {origin}/api/auth/callback/google
              </div>
              {!providers?.google && (
                <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
                  Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-lg font-bold text-white">Remote MCP — Planning &amp; Analysis (Mobile &amp; Desktop)</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Add this URL as a Remote MCP connector for workout planning, ride analysis, and training
          data access in Claude, ChatGPT, or Gemini (uses OAuth 2.1 + PKCE — 1-click approval when
          signed in with Better Auth), or authenticate CLI clients using your <code>MCP_BEARER_TOKEN</code>.
        </p>
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-orange-300">
          {mcpUrl}
        </div>
      </section>
    </div>
  );
}
