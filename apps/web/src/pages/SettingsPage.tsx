import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  type AthleteProfile,
  type AthleteThreshold,
  type AuthState,
  type DeviceTokenRecord,
} from "../lib/api.js";
import { authClient } from "../lib/auth-client.js";
import { useI18n } from "../lib/i18n.js";

interface PasskeyRecord {
  id: string;
  name?: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt?: string | Date | null;
}

interface SettingsPageProps {
  profile?: AthleteProfile | null;
  latestThresholds: AthleteThreshold | null;
  onThresholdsUpdated: () => Promise<void>;
  authState?: AuthState;
  onSignOut?: () => Promise<void>;
}

function isoDateShift(base: Date, deltaDays: number): string {
  const dt = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + deltaDays)
  );
  return dt.toISOString().slice(0, 10);
}

function buildSevenDayChunks(startDay: string, endDay: string): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  if (!startDay || !endDay || startDay > endDay) return chunks;
  let cur = startDay;
  while (cur <= endDay) {
    const [y, m, d] = cur.split("-").map(Number);
    if (!y || !m || !d) break;
    const dt = new Date(Date.UTC(y, m - 1, d + 6));
    const cand = dt.toISOString().slice(0, 10);
    const chunkEnd = cand < endDay ? cand : endDay;
    chunks.push({ start: cur, end: chunkEnd });
    const nextDt = new Date(Date.UTC(y, m - 1, d + 7));
    cur = nextDt.toISOString().slice(0, 10);
  }
  return chunks;
}

export function SettingsPage({
  latestThresholds,
  onThresholdsUpdated,
  authState,
  onSignOut,
}: SettingsPageProps) {
  const { t, locale } = useI18n();
  const [ftp, setFtp] = useState(String(latestThresholds?.ftp_watts ?? ""));
  const [thresholdPace, setThresholdPace] = useState(
    latestThresholds?.threshold_pace_s_per_km ? String(latestThresholds.threshold_pace_s_per_km) : ""
  );
  const [lthr, setLthr] = useState(String(latestThresholds?.lthr_bpm ?? 170));
  const [hrmax, setHrmax] = useState(String(latestThresholds?.hrmax_bpm ?? 190));
  const [weight, setWeight] = useState(String(latestThresholds?.weight_kg ?? 72));

  // Garmin state & date-range backfill
  const [garmin, setGarmin] = useState<{
    connected: boolean;
    last_sync_at: string | null;
    last_error: string | null;
  }>({ connected: false, last_sync_at: null, last_error: null });
  const [garminKeyInput, setGarminKeyInput] = useState("");
  const [garminBusy, setGarminBusy] = useState(false);
  const [garminErr, setGarminErr] = useState<string | null>(null);
  const [backfillStart, setBackfillStart] = useState(() => isoDateShift(new Date(), -30));
  const [backfillEnd, setBackfillEnd] = useState(() => isoDateShift(new Date(), 0));
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{
    doneChunks: number;
    totalChunks: number;
    currentRange: string;
    imported: number;
    skipped: number;
    biometrics: number;
  } | null>(null);
  const backfillAbortRef = useRef(false);

  // Personal tokens
  const [tokens, setTokens] = useState<DeviceTokenRecord[]>([]);
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [newTokenScope, setNewTokenScope] = useState<"importer" | "mcp" | "bridge">("importer");
  const [createdTokenValue, setCreatedTokenValue] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);

  // Passkeys (secondary in Settings)
  const [showPasskeys, setShowPasskeys] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
  const [passkeyName, setPasskeyName] = useState("");
  const [addingPasskey, setAddingPasskey] = useState(false);

  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [authErr, setAuthErr] = useState<string | null>(null);

  const isBetterAuth = authState?.auth_mode === "better_auth";

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
      // Ignore in non-WebAuthn contexts
    }
  }, [isBetterAuth]);

  const loadTokens = useCallback(async () => {
    try {
      const res = await api.listDeviceTokens();
      setTokens(res.tokens);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void api.getGarminStatus().then(setGarmin);
    void loadTokens();
  }, [loadTokens]);

  useEffect(() => {
    void loadPasskeys();
  }, [loadPasskeys]);

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://paincave.workers.dev";
  const mcpUrl = `${origin}/mcp`;

  const handleSaveThresholds = async (e: FormEvent) => {
    e.preventDefault();
    await api.createThreshold({
      effective_from: new Date().toISOString().slice(0, 10),
      ftp_watts: Number(ftp) || null,
      threshold_pace_s_per_km: Number(thresholdPace) || null,
      lthr_bpm: Number(lthr) || null,
      hrmax_bpm: Number(hrmax) || null,
      weight_kg: Number(weight) || null,
    });
    await onThresholdsUpdated();
    setSavedMsg(
      locale === "fr-CA" ? "Seuils enregistrés." : "Saved new dated threshold snapshot."
    );
  };

  const handleConnectGarmin = async (e: FormEvent) => {
    e.preventDefault();
    if (!garminKeyInput.trim()) return;
    setGarminBusy(true);
    setGarminErr(null);
    setSavedMsg(null);
    try {
      const res = await api.connectGarmin(garminKeyInput.trim());
      setGarmin(res.status);
      setGarminKeyInput("");
      setSavedMsg(
        locale === "fr-CA"
          ? "Garmin Connect connecté (synchronisation automatique chaque heure)."
          : "Connected Garmin Connect Personal API (hourly sync enabled)."
      );
    } catch (err) {
      setGarminErr(err instanceof Error ? err.message : "Failed to connect Garmin Personal API");
    } finally {
      setGarminBusy(false);
    }
  };

  const handleSyncGarmin = async () => {
    setGarminBusy(true);
    setGarminErr(null);
    setSavedMsg(null);
    try {
      const res = await api.syncGarminNow(7);
      setSavedMsg(
        locale === "fr-CA"
          ? `Synchronisation Garmin terminée : ${res.activities_imported} nouvelles activités, ${res.biometrics_upserted} jours biométriques.`
          : `Garmin sync complete: ${res.activities_imported} new activities, ${res.biometrics_upserted} daily biometric records.`
      );
      setGarmin(await api.getGarminStatus());
    } catch (err) {
      setGarminErr(err instanceof Error ? err.message : "Garmin sync failed");
    } finally {
      setGarminBusy(false);
    }
  };

  const handleBackfillGarmin = async () => {
    const chunks = buildSevenDayChunks(backfillStart, backfillEnd);
    if (chunks.length === 0) {
      setGarminErr(
        locale === "fr-CA"
          ? "Sélectionnez une plage de dates valide (Du ≤ Au)."
          : "Select a valid date range (From ≤ To)."
      );
      return;
    }

    backfillAbortRef.current = false;
    setBackfillRunning(true);
    setGarminErr(null);
    setSavedMsg(null);

    let totalImported = 0;
    let totalSkipped = 0;
    let totalBiometrics = 0;

    try {
      for (let i = 0; i < chunks.length; i++) {
        if (backfillAbortRef.current) break;
        const chunk = chunks[i]!;
        setBackfillProgress({
          doneChunks: i,
          totalChunks: chunks.length,
          currentRange: `${chunk.start} → ${chunk.end}`,
          imported: totalImported,
          skipped: totalSkipped,
          biometrics: totalBiometrics,
        });

        try {
          const res = await api.syncGarminRange(chunk.start, chunk.end, true);
          totalImported += res.activities_imported;
          totalSkipped += res.activities_skipped;
          totalBiometrics += res.biometrics_upserted;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
            setGarminErr(
              locale === "fr-CA"
                ? `Limite Garmin atteinte sur ${chunk.start} → ${chunk.end}. Patientez une minute puis relancez — les données déjà importées ne seront pas dupliquées.`
                : `Garmin rate limit hit on ${chunk.start} → ${chunk.end}. Wait a minute and resume — already imported items are skipped safely.`
            );
            break;
          }
          setGarminErr(msg);
          break;
        }

        setBackfillProgress({
          doneChunks: i + 1,
          totalChunks: chunks.length,
          currentRange: `${chunk.start} → ${chunk.end}`,
          imported: totalImported,
          skipped: totalSkipped,
          biometrics: totalBiometrics,
        });
      }

      if (totalImported > 0) {
        await api.rebuildPmc().catch(() => {});
      }
      setGarmin(await api.getGarminStatus());
      if (!backfillAbortRef.current) {
        setSavedMsg(
          locale === "fr-CA"
            ? `Importation Garmin terminée : ${totalImported} nouvelles activités (${totalSkipped} déjà présentes), ${totalBiometrics} jours biométriques.`
            : `Garmin range import finished: ${totalImported} new activities (${totalSkipped} skipped), ${totalBiometrics} biometric days.`
        );
      }
    } finally {
      setBackfillRunning(false);
    }
  };

  const handleDisconnectGarmin = async () => {
    setGarminBusy(true);
    try {
      await api.disconnectGarmin();
      setGarmin({ connected: false, last_sync_at: null, last_error: null });
      setSavedMsg(
        locale === "fr-CA" ? "Garmin Connect déconnecté." : "Disconnected Garmin Personal API."
      );
    } finally {
      setGarminBusy(false);
    }
  };

  const handleCreateToken = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTokenLabel.trim()) return;
    setTokenBusy(true);
    setCreatedTokenValue(null);
    try {
      const res = await api.createDeviceToken(newTokenLabel.trim(), newTokenScope);
      setCreatedTokenValue(res.token);
      setNewTokenLabel("");
      await loadTokens();
    } finally {
      setTokenBusy(false);
    }
  };

  const handleDeleteToken = async (tokenHash: string) => {
    await api.deleteDeviceToken(tokenHash);
    setTokens((prev) => prev.filter((item) => item.token_hash !== tokenHash));
  };

  const handleAddPasskey = async () => {
    setAddingPasskey(true);
    setAuthErr(null);
    setSavedMsg(null);
    try {
      const res = await authClient.passkey.addPasskey({
        name: passkeyName.trim() || (locale === "fr-CA" ? "Mon appareil" : "My Device"),
      });
      if (res?.error) {
        setAuthErr(res.error.message ?? "Could not register passkey");
      } else {
        setPasskeyName("");
        setSavedMsg(
          locale === "fr-CA" ? "Nouvelle clé d'accès enregistrée." : "Registered new passkey."
        );
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

  const applyPresetDays = (days: number) => {
    const now = new Date();
    setBackfillStart(isoDateShift(now, -days));
    setBackfillEnd(isoDateShift(now, 0));
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">{t("settings.title")}</h1>

      {savedMsg && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
          {savedMsg}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Garmin Connect Personal API + Historical Date-Range Import */}
        <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">{t("settings.garmin_title")}</h2>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ${
                garmin.connected
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {garmin.connected ? t("settings.connected") : t("settings.not_connected")}
            </span>
          </div>
          <p className="text-xs text-zinc-400">{t("settings.garmin_desc")}</p>

          {garmin.last_sync_at && (
            <p className="text-[11px] text-zinc-500">
              {locale === "fr-CA" ? "Dernière synchronisation :" : "Last sync:"}{" "}
              {new Date(garmin.last_sync_at).toLocaleString()}
            </p>
          )}
          {garmin.last_error && (
            <p className="text-[11px] text-amber-300">
              {locale === "fr-CA" ? "Dernière erreur :" : "Last error:"} {garmin.last_error}
            </p>
          )}
          {garminErr && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-200">
              {garminErr}
            </div>
          )}

          {garmin.connected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={garminBusy || backfillRunning}
                  onClick={() => void handleSyncGarmin()}
                  className="rounded-lg bg-orange-500 px-3.5 py-1.5 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
                >
                  {garminBusy ? t("settings.syncing") : t("settings.sync_now")}
                </button>
                <button
                  type="button"
                  disabled={garminBusy || backfillRunning}
                  onClick={() => void handleDisconnectGarmin()}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-700"
                >
                  {t("settings.disconnect")}
                </button>
              </div>

              {/* Historical Date-Range Import */}
              <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3.5">
                <div>
                  <h3 className="text-xs font-bold text-white">
                    {t("settings.garmin_backfill_title")}
                  </h3>
                  <p className="mt-0.5 text-[11px] text-zinc-400">
                    {t("settings.garmin_backfill_desc")}
                  </p>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {(
                    [
                      [30, locale === "fr-CA" ? "30 jours" : "30 days"],
                      [90, locale === "fr-CA" ? "90 jours" : "90 days"],
                      [180, locale === "fr-CA" ? "6 mois" : "6 months"],
                      [365, locale === "fr-CA" ? "1 an" : "1 year"],
                    ] as const
                  ).map(([days, label]) => (
                    <button
                      key={days}
                      type="button"
                      disabled={backfillRunning}
                      onClick={() => applyPresetDays(days)}
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] text-zinc-400">
                    {t("settings.from")}
                    <input
                      type="date"
                      value={backfillStart}
                      disabled={backfillRunning}
                      onChange={(e) => setBackfillStart(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-white"
                    />
                  </label>
                  <label className="text-[11px] text-zinc-400">
                    {t("settings.to")}
                    <input
                      type="date"
                      value={backfillEnd}
                      disabled={backfillRunning}
                      onChange={(e) => setBackfillEnd(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-white"
                    />
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={backfillRunning || garminBusy}
                    onClick={() => void handleBackfillGarmin()}
                    className="rounded-lg bg-orange-500 px-3.5 py-1.5 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
                  >
                    {backfillRunning ? t("settings.syncing") : t("settings.import_range")}
                  </button>
                  {backfillRunning && (
                    <button
                      type="button"
                      onClick={() => {
                        backfillAbortRef.current = true;
                      }}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
                    >
                      {t("settings.cancel_import")}
                    </button>
                  )}
                </div>

                {backfillProgress && (
                  <div className="space-y-1.5 pt-1 text-[11px] text-zinc-400">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-orange-500 transition-all"
                        style={{
                          width: `${Math.round(
                            (backfillProgress.doneChunks / Math.max(1, backfillProgress.totalChunks)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap justify-between gap-2">
                      <span>
                        {backfillProgress.doneChunks}/{backfillProgress.totalChunks} ·{" "}
                        {backfillProgress.currentRange}
                      </span>
                      <span>
                        +{backfillProgress.imported}{" "}
                        {locale === "fr-CA" ? "activités" : "activities"} ·{" "}
                        {backfillProgress.biometrics} {locale === "fr-CA" ? "jours" : "days"}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <form onSubmit={(e) => void handleConnectGarmin(e)} className="flex gap-2">
              <input
                type="password"
                value={garminKeyInput}
                onChange={(e) => setGarminKeyInput(e.target.value)}
                placeholder={
                  locale === "fr-CA"
                    ? "Collez votre clé API personnelle Garmin"
                    : "Paste Garmin Personal API Key"
                }
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-white"
              />
              <button
                type="submit"
                disabled={garminBusy}
                className="rounded-lg bg-orange-500 px-4 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
              >
                {garminBusy ? t("settings.verifying") : t("settings.connect")}
              </button>
            </form>
          )}
        </section>

        {/* Athlete Thresholds */}
        <form
          onSubmit={(e) => void handleSaveThresholds(e)}
          className="space-y-4 self-start rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
        >
          <h2 className="text-lg font-bold text-white">{t("settings.thresholds_title")}</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-zinc-400">
              {locale === "fr-CA" ? "FTP vélo (Watts, optionnel)" : "FTP (Watts, optional)"}
              <input
                type="number"
                value={ftp}
                onChange={(e) => setFtp(e.target.value)}
                placeholder="250"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
              />
            </label>
            <label className="text-xs text-zinc-400">
              {locale === "fr-CA" ? "Allure seuil course (sec/km)" : "Run Threshold Pace (sec/km)"}
              <input
                type="number"
                value={thresholdPace}
                onChange={(e) => setThresholdPace(e.target.value)}
                placeholder="270 (4:30/km)"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
              />
            </label>
            <label className="text-xs text-zinc-400">
              {locale === "fr-CA" ? "FC seuil (BPM)" : "LTHR (BPM)"}
              <input
                type="number"
                value={lthr}
                onChange={(e) => setLthr(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
              />
            </label>
            <label className="text-xs text-zinc-400">
              {locale === "fr-CA" ? "FC max (BPM)" : "HRmax (BPM)"}
              <input
                type="number"
                value={hrmax}
                onChange={(e) => setHrmax(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
              />
            </label>
            <label className="text-xs text-zinc-400">
              {locale === "fr-CA" ? "Poids (kg)" : "Weight (kg)"}
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
            {t("settings.save_thresholds")}
          </button>
        </form>
      </div>

      {/* Remote MCP & Personal Tokens */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-lg font-bold text-white">{t("settings.mcp_title")}</h2>
          <p className="text-xs text-zinc-400">
            {locale === "fr-CA"
              ? "Ajoutez cette adresse dans Claude, ChatGPT ou Gemini comme connecteur MCP distant pour permettre à votre IA de consulter vos données de santé et de planifier vos séances."
              : "Add this URL as a Remote MCP connector in Claude, ChatGPT, or Gemini so your AI can read your health data and plan workouts."}
          </p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-orange-300">
            {mcpUrl}
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-lg font-bold text-white">{t("settings.tokens_title")}</h2>
          <p className="text-xs text-zinc-400">{t("settings.tokens_desc")}</p>
          <form onSubmit={(e) => void handleCreateToken(e)} className="flex flex-wrap gap-2">
            <input
              type="text"
              value={newTokenLabel}
              onChange={(e) => setNewTokenLabel(e.target.value)}
              placeholder={locale === "fr-CA" ? "Nom du jeton (ex. Import Strava)" : "Token label"}
              className="min-w-[10rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-white"
            />
            <select
              value={newTokenScope}
              onChange={(e) => setNewTokenScope(e.target.value as "importer" | "mcp" | "bridge")}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200"
            >
              <option value="importer">importer</option>
              <option value="mcp">mcp</option>
              <option value="bridge">bridge</option>
            </select>
            <button
              type="submit"
              disabled={tokenBusy}
              className="rounded-lg bg-orange-500 px-3.5 py-1.5 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
            >
              {t("settings.create_token")}
            </button>
          </form>

          {createdTokenValue && (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200">
              <div className="font-semibold">
                {locale === "fr-CA"
                  ? "Copiez ce jeton maintenant (il ne sera plus affiché) :"
                  : "Copy this token now (it won't be shown again):"}
              </div>
              <code className="mt-1 block break-all font-mono text-[11px]">
                {createdTokenValue}
              </code>
            </div>
          )}

          {tokens.length > 0 && (
            <ul className="space-y-1.5">
              {tokens.map((tok) => (
                <li
                  key={tok.token_hash}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-semibold text-white">{tok.label}</span>{" "}
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                      {tok.scope}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDeleteToken(tok.token_hash)}
                    className="text-rose-400 hover:underline"
                  >
                    {t("settings.revoke")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Account & Security (clean, zero developer env-var noise; Passkeys tucked neatly) */}
      <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">{t("settings.account_title")}</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              {isBetterAuth && authState?.user
                ? `${authState.user.name} (${authState.user.email})`
                : locale === "fr-CA"
                  ? "Connecté avec mot de passe administrateur."
                  : "Signed in via admin password."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isBetterAuth && (
              <button
                type="button"
                onClick={() => setShowPasskeys((open) => !open)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700"
              >
                {locale === "fr-CA"
                  ? `Clés d'accès (${passkeys.length})`
                  : `Passkeys (${passkeys.length})`}
              </button>
            )}
            {onSignOut && (
              <button
                type="button"
                onClick={() => void onSignOut()}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700"
              >
                {t("settings.sign_out")}
              </button>
            )}
          </div>
        </div>

        {authErr && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-200">
            {authErr}
          </div>
        )}

        {isBetterAuth && showPasskeys && (
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <h3 className="text-sm font-bold text-white">
              {locale === "fr-CA"
                ? "Clés d'accès (Touch ID / Face ID / Clé de sécurité)"
                : "Passkeys (Touch ID / Face ID / Security Key)"}
            </h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={passkeyName}
                onChange={(e) => setPasskeyName(e.target.value)}
                placeholder={
                  locale === "fr-CA"
                    ? "Nom de l'appareil (ex. Téléphone, Portable)"
                    : "Device label (e.g. Phone, Laptop)"
                }
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-white placeholder:text-zinc-500"
              />
              <button
                type="button"
                disabled={addingPasskey}
                onClick={() => void handleAddPasskey()}
                className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
              >
                {addingPasskey
                  ? locale === "fr-CA"
                    ? "Enregistrement..."
                    : "Registering..."
                  : locale === "fr-CA"
                    ? "+ Ajouter"
                    : "+ Add Passkey"}
              </button>
            </div>
            {passkeys.length === 0 ? (
              <p className="text-xs text-zinc-500">
                {locale === "fr-CA"
                  ? "Aucune clé d'accès enregistrée."
                  : "No passkeys registered yet."}
              </p>
            ) : (
              <ul className="space-y-2">
                {passkeys.map((pk) => (
                  <li
                    key={pk.id}
                    className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-zinc-100">
                        {pk.name || (locale === "fr-CA" ? "Clé d'accès" : "Passkey")}
                      </div>
                      <div className="text-[11px] text-zinc-500">
                        {pk.deviceType} {pk.backedUp ? "· Synced" : "· Device-bound"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeletePasskey(pk.id)}
                      className="text-rose-400 hover:underline"
                    >
                      {locale === "fr-CA" ? "Retirer" : "Remove"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
