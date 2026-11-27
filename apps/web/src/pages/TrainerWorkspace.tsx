import { useEffect, useState } from "react";
import type { BridgeCommand, RoutePayload } from "@paincave/shared";
import { api } from "../lib/api.js";
import type { BridgeClientSnapshot } from "../lib/bridge-client.js";
import { useI18n } from "../lib/i18n.js";
import { RidePage } from "./RidePage.js";
import { RoutesPage } from "./RoutesPage.js";

export type TrainerSubTab = "ride" | "routes" | "bridge";

interface TrainerWorkspaceProps {
  subTab: TrainerSubTab;
  onChangeSubTab: (next: TrainerSubTab) => void;
  onExitTrainer: () => void;
  snapshot: BridgeClientSnapshot;
  ftpWatts: number;
  bridgeUrl: string;
  onChangeBridgeUrl: (next: string) => void;
  sendCommand: (cmd: BridgeCommand) => boolean;
  onLoadRoute: (route: RoutePayload) => void;
  onLoadWorkoutWithRoute: (workoutId: string, route: RoutePayload) => Promise<void>;
}

export function TrainerWorkspace({
  subTab,
  onChangeSubTab,
  onExitTrainer,
  snapshot,
  ftpWatts,
  bridgeUrl,
  onChangeBridgeUrl,
  sendCommand,
  onLoadRoute,
  onLoadWorkoutWithRoute,
}: TrainerWorkspaceProps) {
  const { t, locale } = useI18n();
  const [bridgeInput, setBridgeInput] = useState(bridgeUrl);
  const [bridgeMsg, setBridgeMsg] = useState<string | null>(null);
  const [strava, setStrava] = useState<{
    configured: boolean;
    connected: boolean;
    athlete_external_id: string | null;
  }>({ configured: false, connected: false, athlete_external_id: null });

  useEffect(() => {
    void api.getStravaStatus().then(setStrava);
  }, []);

  const tabs: readonly [TrainerSubTab, string][] = [
    ["ride", t("nav.live_ride")],
    ["routes", t("nav.routes")],
    ["bridge", t("nav.bridge")],
  ];

  return (
    <div className="space-y-5">
      {/* Dedicated Trainer Sub-App Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onExitTrainer}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
          >
            {t("nav.back_to_overview")}
          </button>
          <div className="flex items-center gap-2">
            <span className="text-sm font-black tracking-tight text-white">
              {t("nav.trainer_app")}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                snapshot.connected
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-zinc-800 text-zinc-400"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  snapshot.connected ? "bg-emerald-400" : "bg-zinc-500"
                }`}
              />
              {snapshot.connected ? t("nav.bridge_connected") : t("nav.bridge_offline")}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onChangeSubTab(key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                subTab === key
                  ? "bg-orange-500 text-zinc-950"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {subTab === "ride" && (
        <RidePage snapshot={snapshot} ftpWatts={ftpWatts} sendCommand={sendCommand} />
      )}

      {subTab === "routes" && (
        <RoutesPage
          onLoadRoute={onLoadRoute}
          onLoadWorkoutWithRoute={onLoadWorkoutWithRoute}
        />
      )}

      {subTab === "bridge" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <h2 className="text-lg font-bold text-white">
              {locale === "fr-CA"
                ? "Passerelle locale de la base d'entraînement"
                : "Local Smart Trainer Bridge"}
            </h2>
            <p className="text-xs text-zinc-400">
              {locale === "fr-CA" ? "État :" : "Status:"}{" "}
              <strong className={snapshot.connected ? "text-emerald-400" : "text-amber-400"}>
                {snapshot.connected ? t("nav.bridge_connected") : t("nav.bridge_offline")}
              </strong>{" "}
              · Transport : {snapshot.telemetry?.sensors.transport ?? "offline"}
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
                  setBridgeMsg(
                    locale === "fr-CA"
                      ? "Adresse WebSocket de la passerelle mise à jour."
                      : "Updated bridge WebSocket URL."
                  );
                }}
                className="rounded-lg bg-orange-500 px-4 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400"
              >
                {locale === "fr-CA" ? "Appliquer" : "Apply"}
              </button>
            </div>
            {bridgeMsg && <p className="text-xs text-emerald-400">{bridgeMsg}</p>}
          </section>

          {strava.configured && (
            <section className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
              <h2 className="text-lg font-bold text-white">
                {locale === "fr-CA" ? "Envoi automatique vers Strava" : "Strava Auto-Upload"}
              </h2>
              <p className="text-xs text-zinc-400">
                {strava.connected
                  ? locale === "fr-CA"
                    ? `Connecté (athlète ${strava.athlete_external_id ?? "lié"}) — vos séances intérieures .fit sont téléversées automatiquement.`
                    : `Connected (Athlete ${strava.athlete_external_id ?? "linked"}) — indoor .fit rides auto-upload.`
                  : locale === "fr-CA"
                    ? "Autorisez Strava pour téléverser automatiquement vos séances sur base d'entraînement."
                    : "Authorize Strava to automatically upload completed indoor rides."}
              </p>
              {!strava.connected && (
                <a
                  href="/api/strava/connect"
                  className="inline-block rounded-lg bg-orange-500 px-4 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400"
                >
                  {locale === "fr-CA" ? "Connecter Strava" : "Connect Strava"}
                </a>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
