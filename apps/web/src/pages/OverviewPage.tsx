import { useCallback, useEffect, useState } from "react";
import {
  api,
  type FitnessOverviewResponse,
  type PlannedSessionRecord,
  type RideRecord,
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";

interface OverviewPageProps {
  indoorTrainerEnabled: boolean;
  onOpenTrainer: () => void;
  onNavigateTab: (tab: "calendar" | "workouts" | "trends" | "settings") => void;
}

function isoDateOffset(base: Date, deltaDays: number): string {
  const dt = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + deltaDays)
  );
  return dt.toISOString().slice(0, 10);
}

function formatPace(secPerKm: number | null | undefined): string {
  if (!secPerKm || secPerKm <= 0) return "--";
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60);
  return `${mins}:${String(secs).padStart(2, "0")}/km`;
}

export function OverviewPage({
  indoorTrainerEnabled,
  onOpenTrainer,
  onNavigateTab,
}: OverviewPageProps) {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(true);
  const [fitness, setFitness] = useState<FitnessOverviewResponse | null>(null);
  const [biometrics, setBiometrics] = useState<Awaited<ReturnType<typeof api.getBiometrics>>>(null);
  const [upcoming, setUpcoming] = useState<PlannedSessionRecord[]>([]);
  const [recentRides, setRecentRides] = useState<RideRecord[]>([]);
  const [notes, setNotes] = useState<
    { id: string; category: string; sport?: string | null; content: string }[]
  >([]);
  const [garminConnected, setGarminConnected] = useState(false);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [archivingNoteId, setArchivingNoteId] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    const now = new Date();
    const today = isoDateOffset(now, 0);
    const next7 = isoDateOffset(now, 7);
    try {
      const [fitRes, bioRes, calRes, ridesRes, notesRes, garminRes] = await Promise.all([
        api.getFitnessOverview(42).catch(() => null),
        api.getBiometrics(30).catch(() => null),
        api.getCalendar(today, next7).catch(() => ({ planned_sessions: [], completed_rides: [] })),
        api.getRides(8).catch(() => ({ rides: [] })),
        api.getNotes().catch(() => ({ notes: [] })),
        api.getGarminStatus().catch(() => ({ connected: false })),
      ]);
      setFitness(fitRes);
      setBiometrics(bioRes);
      setUpcoming(calRes.planned_sessions);
      setRecentRides(ridesRes.rides);
      setNotes(notesRes.notes);
      setGarminConnected(garminRes.connected);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const sportLabel = (sport?: string | null): string => {
    switch (sport) {
      case "running":
        return t("sport.running");
      case "strength":
        return t("sport.strength");
      case "mobility":
        return t("sport.mobility");
      case "cycling":
        return t("sport.cycling");
      default:
        return t("sport.other");
    }
  };

  const sportBadgeClass = (sport?: string | null): string => {
    switch (sport) {
      case "running":
        return "bg-emerald-500/15 text-emerald-300";
      case "strength":
        return "bg-violet-500/15 text-violet-300";
      case "mobility":
        return "bg-sky-500/15 text-sky-300";
      case "cycling":
      default:
        return "bg-orange-500/15 text-orange-300";
    }
  };

  const handleArchiveNote = async (id: string) => {
    setArchivingNoteId(id);
    try {
      await api.archiveNote(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } finally {
      setArchivingNoteId(null);
    }
  };

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://paincave.workers.dev";
  const mcpUrl = `${origin}/mcp`;

  const handleCopyMcp = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopiedMcp(true);
      window.setTimeout(() => setCopiedMcp(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t("overview.title")}</h1>
          <p className="mt-0.5 text-sm text-zinc-400">{t("overview.subtitle")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {indoorTrainerEnabled && (
            <button
              type="button"
              onClick={onOpenTrainer}
              className="rounded-xl bg-orange-500 px-4 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400"
            >
              {t("overview.open_trainer")}
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigateTab("settings")}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
          >
            {t("overview.go_settings")}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900"
            />
          ))}
        </div>
      ) : (
        <>
          {/* Readiness & Biometrics */}
          <section className="space-y-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {t("overview.readiness_section")}
            </h2>
            {biometrics && biometrics.summary.latest ? (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-xs text-zinc-400">{t("overview.hrv_7d")}</div>
                  <div className="mt-1 text-2xl font-bold text-emerald-400">
                    {biometrics.summary.hrv_7d_avg !== null
                      ? `${biometrics.summary.hrv_7d_avg} ms`
                      : "—"}
                  </div>
                  {biometrics.summary.hrv_delta_pct !== null && (
                    <div className="mt-0.5 text-[11px] text-zinc-500">
                      {biometrics.summary.hrv_delta_pct >= 0 ? "+" : ""}
                      {biometrics.summary.hrv_delta_pct}% {t("overview.vs_baseline")}
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-xs text-zinc-400">{t("overview.rhr_7d")}</div>
                  <div className="mt-1 text-2xl font-bold text-sky-400">
                    {biometrics.summary.resting_hr_7d_avg !== null
                      ? `${biometrics.summary.resting_hr_7d_avg} bpm`
                      : "—"}
                  </div>
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-xs text-zinc-400">{t("overview.sleep_7d")}</div>
                  <div className="mt-1 text-2xl font-bold text-indigo-300">
                    {biometrics.summary.sleep_hours_7d_avg !== null
                      ? `${biometrics.summary.sleep_hours_7d_avg} h`
                      : "—"}
                  </div>
                  {biometrics.summary.sleep_score_7d_avg !== null && (
                    <div className="mt-0.5 text-[11px] text-zinc-500">
                      {t("overview.sleep_score")} {biometrics.summary.sleep_score_7d_avg}/100
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-xs text-zinc-400">{t("overview.body_battery")}</div>
                  <div className="mt-1 text-2xl font-bold text-orange-400">
                    {biometrics.summary.latest.body_battery_high !== null
                      ? `${biometrics.summary.latest.body_battery_high}`
                      : "—"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {biometrics.summary.latest.day}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
                {t("overview.no_biometrics")}
              </div>
            )}
          </section>

          {/* Load & Form */}
          {fitness && (
            <section className="space-y-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {t("overview.load_section")}
              </h2>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-xs text-zinc-400">{t("overview.ctl")}</div>
                  <div className="mt-1 text-2xl font-bold text-sky-400">
                    {fitness.current_pmc.ctl}
                  </div>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-xs text-zinc-400">{t("overview.atl")}</div>
                  <div className="mt-1 text-2xl font-bold text-rose-400">
                    {fitness.current_pmc.atl}
                  </div>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-xs text-zinc-400">{t("overview.tsb")}</div>
                  <div className="mt-1 text-2xl font-bold text-emerald-400">
                    {fitness.current_pmc.tsb}
                  </div>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-xs text-zinc-400">{t("overview.ramp_7d")}</div>
                  <div className="mt-1 text-2xl font-bold text-white">
                    {fitness.current_pmc.ramp_rate_7d}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Upcoming & Recent */}
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white">{t("overview.upcoming_section")}</h2>
                <button
                  type="button"
                  onClick={() => onNavigateTab("calendar")}
                  className="text-xs font-semibold text-orange-400 hover:underline"
                >
                  {t("nav.calendar")} →
                </button>
              </div>
              {upcoming.length === 0 ? (
                <p className="text-xs text-zinc-500">{t("overview.no_upcoming")}</p>
              ) : (
                <div className="space-y-2.5">
                  {upcoming.slice(0, 5).map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-zinc-500">
                            {s.scheduled_date}
                          </span>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${sportBadgeClass(s.workout_sport)}`}
                          >
                            {sportLabel(s.workout_sport)}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-sm font-semibold text-white">
                          {s.workout_name}
                        </div>
                        <div className="text-xs text-zinc-400">
                          {Math.round(s.planned_duration_s / 60)} min
                          {s.predicted_tss !== null ? ` · TSS ${Math.round(s.predicted_tss)}` : ""}
                        </div>
                      </div>
                      <a
                        href={`/api/workouts/${encodeURIComponent(s.workout_id)}/export.fit`}
                        className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-zinc-800"
                      >
                        .FIT
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white">{t("overview.recent_section")}</h2>
                <button
                  type="button"
                  onClick={() => onNavigateTab("trends")}
                  className="text-xs font-semibold text-orange-400 hover:underline"
                >
                  {t("nav.trends")} →
                </button>
              </div>
              {recentRides.length === 0 ? (
                <p className="text-xs text-zinc-500">{t("overview.no_recent")}</p>
              ) : (
                <div className="space-y-2.5">
                  {recentRides.slice(0, 5).map((r) => (
                    <div
                      key={r.ride_uuid}
                      className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-zinc-500">{r.ride_day}</span>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${sportBadgeClass(r.sport)}`}
                          >
                            {sportLabel(r.sport)}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-sm font-semibold text-white">
                          {r.name}
                        </div>
                        <div className="text-xs text-zinc-400">
                          {r.sport === "running"
                            ? `${Math.round(r.duration_s / 60)} min · ${r.distance_m ? `${(r.distance_m / 1000).toFixed(1)} km` : "--"} · ${formatPace(r.avg_pace_s_per_km)} · FC ${r.avg_hr ?? "--"}`
                            : `${Math.round(r.duration_s / 60)} min · NP ${r.np_watts ?? "--"} W · TSS ${Math.round(r.tss)} · FC ${r.avg_hr ?? "--"}`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* AI Memory + Remote MCP Access */}
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
              <div>
                <h2 className="text-sm font-bold text-white">{t("overview.memory_section")}</h2>
                <p className="mt-0.5 text-xs text-zinc-400">{t("overview.memory_hint")}</p>
              </div>
              {notes.length === 0 ? (
                <p className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-500">
                  {t("overview.no_memory")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {notes.map((note) => (
                    <li
                      key={note.id}
                      className="flex items-start justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-xs"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-300">
                            {note.category}
                          </span>
                          {note.sport && (
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${sportBadgeClass(note.sport)}`}
                            >
                              {sportLabel(note.sport)}
                            </span>
                          )}
                        </div>
                        <p className="text-zinc-200">{note.content}</p>
                      </div>
                      <button
                        type="button"
                        disabled={archivingNoteId === note.id}
                        onClick={() => void handleArchiveNote(note.id)}
                        className="shrink-0 text-[11px] font-medium text-zinc-400 hover:text-rose-400 disabled:opacity-50"
                      >
                        {t("overview.archive")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-white">{t("overview.mcp_section")}</h2>
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                  {locale === "fr-CA" ? "Actif" : "Active"}
                </span>
              </div>
              <p className="text-xs text-zinc-400">{t("overview.mcp_hint")}</p>
              <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-orange-400">
                  {mcpUrl}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopyMcp()}
                  className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
                >
                  {copiedMcp ? t("overview.copied") : t("overview.copy_url")}
                </button>
              </div>
              <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
                <span
                  className={`rounded-full px-2.5 py-1 font-medium ${
                    garminConnected
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  Garmin: {garminConnected ? t("settings.connected") : t("settings.not_connected")}
                </span>
                <span className="rounded-full bg-zinc-800 px-2.5 py-1 font-medium text-zinc-300">
                  {recentRides.length} {locale === "fr-CA" ? "activités récentes" : "recent activities"}
                </span>
                <span className="rounded-full bg-zinc-800 px-2.5 py-1 font-medium text-zinc-300">
                  {notes.length} {locale === "fr-CA" ? "notes mémoire" : "memory notes"}
                </span>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
