import { useCallback, useEffect, useState } from "react";
import {
  api,
  type PlannedSessionRecord,
  type RideRecord,
  type WorkoutRecord,
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";

interface CalendarPageProps {
  indoorTrainerEnabled?: boolean;
  onLoadWorkout: (workoutId: string, plannedSessionId?: string) => Promise<void>;
}

function sportBadge(sport?: string): { label: string; className: string } {
  switch (sport) {
    case "running":
      return { label: "Run", className: "bg-emerald-500/20 text-emerald-300" };
    case "strength":
      return { label: "Strength", className: "bg-violet-500/20 text-violet-300" };
    case "mobility":
      return { label: "Mobility", className: "bg-sky-500/20 text-sky-300" };
    case "cycling":
    default:
      return { label: "Ride", className: "bg-orange-500/20 text-orange-300" };
  }
}

function formatPace(secPerKm: number | null | undefined): string {
  if (!secPerKm || secPerKm <= 0) return "--";
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60);
  return `${mins}:${String(secs).padStart(2, "0")}/km`;
}

function isoDateOffset(base: Date, deltaDays: number): string {
  const dt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function localTodayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function CalendarPage({
  indoorTrainerEnabled = true,
  onLoadWorkout,
}: CalendarPageProps) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<PlannedSessionRecord[]>([]);
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [workouts, setWorkouts] = useState<WorkoutRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; warnings?: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Schedule drawer state
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [selectedWorkoutId, setSelectedWorkoutId] = useState("");
  const [scheduleDate, setScheduleDate] = useState(localTodayIso);
  const [scheduleNote, setScheduleNote] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);

  const now = new Date();
  const start = isoDateOffset(now, -7);
  const end = isoDateOffset(now, 14);

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    try {
      const [calRes, workoutsRes] = await Promise.all([
        api.getCalendar(start, end),
        api.getWorkouts(),
      ]);
      setSessions(calRes.planned_sessions);
      setRides(calRes.completed_rides);
      setWorkouts(workoutsRes.workouts);
      if (workoutsRes.workouts.length > 0) {
        setSelectedWorkoutId((current) => current || (workoutsRes.workouts[0]?.id ?? ""));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load calendar");
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar]);

  const handleScheduleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWorkoutId || !scheduleDate) return;
    setScheduleSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.scheduleSession({
        scheduled_date: scheduleDate,
        workout_id: selectedWorkoutId,
        coach_rationale: scheduleNote.trim() || undefined,
        replace_existing: replaceExisting,
      });
      const chosen = workouts.find((w) => w.id === selectedWorkoutId);
      setNotice({
        text: `Scheduled "${chosen?.name ?? "workout"}" for ${scheduleDate}.`,
        warnings: res.warnings.length > 0 ? res.warnings : undefined,
      });
      setScheduleNote("");
      setReplaceExisting(false);
      setShowScheduleForm(false);
      await loadCalendar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule workout");
    } finally {
      setScheduleSubmitting(false);
    }
  };

  const handleRescheduleDate = async (session: PlannedSessionRecord, nextDate: string) => {
    if (!nextDate || nextDate === session.scheduled_date) return;
    setUpdatingId(session.id);
    setError(null);
    try {
      await api.updateCalendarSession(session.id, { scheduled_date: nextDate });
      setSessions((current) =>
        current
          .map((item) => (item.id === session.id ? { ...item, scheduled_date: nextDate } : item))
          .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
      );
      setNotice({ text: `Moved "${session.workout_name}" to ${nextDate}.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move planned workout");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleToggleSkip = async (session: PlannedSessionRecord) => {
    const nextStatus = session.status === "skipped" ? "planned" : "skipped";
    setUpdatingId(session.id);
    setError(null);
    try {
      await api.updateCalendarSession(session.id, { status: nextStatus });
      setSessions((current) =>
        current.map((item) => (item.id === session.id ? { ...item, status: nextStatus } : item))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update session status");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDeleteSession = async (session: PlannedSessionRecord) => {
    if (!window.confirm(`Remove "${session.workout_name}" from ${session.scheduled_date}?`)) {
      return;
    }
    setDeletingId(session.id);
    setError(null);
    try {
      await api.deleteCalendarSession(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete planned workout");
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteRide = async (ride: RideRecord) => {
    if (
      !window.confirm(
        `Delete "${ride.name}" (${ride.ride_day})?\n\nThis removes the ride, FIT file, and PMC contribution. It does not remove a Strava activity already uploaded.`
      )
    ) {
      return;
    }
    setDeletingId(ride.ride_uuid);
    setError(null);
    try {
      await api.deleteRide(ride.ride_uuid);
      setRides((current) => current.filter((item) => item.ride_uuid !== ride.ride_uuid));
      setSessions((current) =>
        current.map((session) =>
          session.completed_ride_uuid === ride.ride_uuid
            ? { ...session, status: "planned", completed_ride_uuid: null }
            : session
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete ride");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t("calendar.title")}</h1>
          <p className="text-sm text-zinc-400">
            {t("calendar.showing")} {start} {t("calendar.through")} {end}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowScheduleForm((open) => !open)}
          disabled={workouts.length === 0}
          className="rounded-lg bg-orange-500 px-3.5 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {showScheduleForm ? t("calendar.close_scheduler") : t("calendar.schedule_btn")}
        </button>
      </div>

      {showScheduleForm && (
        <form
          onSubmit={(e) => void handleScheduleSubmit(e)}
          className="grid gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 md:grid-cols-4"
        >
          <div className="md:col-span-2">
            <label
              htmlFor="calendar-schedule-workout"
              className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
            >
              Workout
            </label>
            <select
              id="calendar-schedule-workout"
              value={selectedWorkoutId}
              onChange={(e) => setSelectedWorkoutId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
            >
              {workouts.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({Math.round(w.duration_s / 60)}m · TSS {w.predicted_tss ?? "--"})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="calendar-schedule-date"
              className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
            >
              Date
            </label>
            <input
              id="calendar-schedule-date"
              type="date"
              required
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="calendar-schedule-note"
              className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
            >
              Session Note
            </label>
            <input
              id="calendar-schedule-note"
              type="text"
              value={scheduleNote}
              onChange={(e) => setScheduleNote(e.target.value)}
              placeholder="Optional note..."
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-orange-500 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-4">
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={replaceExisting}
                onChange={(e) => setReplaceExisting(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 accent-orange-500"
              />
              Replace existing planned session on that day
            </label>
            <button
              type="submit"
              disabled={scheduleSubmitting || !selectedWorkoutId || !scheduleDate}
              className="rounded-lg bg-orange-500 px-4 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-50"
            >
              {scheduleSubmitting ? "Scheduling..." : "Add to Calendar"}
            </button>
          </div>
        </form>
      )}

      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200"
        >
          <div className="space-y-1">
            <div>{notice.text}</div>
            {notice.warnings && notice.warnings.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-amber-300">
                {notice.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs text-emerald-300/80 hover:text-emerald-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-400">Loading schedule...</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              {t("calendar.planned")}
            </h2>
            {sessions.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                {t("calendar.no_planned")}
              </div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-zinc-400">{s.scheduled_date}</span>
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase ${sportBadge(s.workout_sport).className}`}
                      >
                        {sportBadge(s.workout_sport).label}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${
                          s.status === "completed"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : s.status === "skipped"
                              ? "bg-zinc-700 text-zinc-400"
                              : "bg-orange-500/20 text-orange-300"
                        }`}
                      >
                        {s.status}
                      </span>
                    </div>
                    <div className="mt-1 font-semibold text-white">{s.workout_name}</div>
                    <div className="text-xs text-zinc-400">
                      {Math.round(s.planned_duration_s / 60)}m · Load {s.predicted_tss ?? "--"}
                      {(s.workout_sport ?? "cycling") === "cycling"
                        ? ` · IF ${s.predicted_if ?? "--"}`
                        : ""}
                    </div>
                    {s.coach_rationale && (
                      <p className="mt-1 text-xs text-zinc-400">{s.coach_rationale}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {s.status !== "completed" && (
                      <>
                        <input
                          type="date"
                          aria-label={`Move ${s.workout_name} date`}
                          value={s.scheduled_date}
                          disabled={updatingId === s.id}
                          onChange={(e) => void handleRescheduleDate(s, e.target.value)}
                          className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-orange-500 focus:outline-none disabled:opacity-50"
                        />
                        <button
                          type="button"
                          onClick={() => void handleToggleSkip(s)}
                          disabled={updatingId === s.id}
                          className="rounded-lg border border-zinc-700 px-2.5 py-2 text-xs font-semibold text-zinc-300 hover:border-zinc-500 hover:text-white disabled:opacity-50"
                        >
                          {s.status === "skipped" ? "Restore" : "Skip"}
                        </button>
                      </>
                    )}
                    {indoorTrainerEnabled && (s.workout_sport ?? "cycling") === "cycling" && (
                      <button
                        type="button"
                        onClick={() => void onLoadWorkout(s.workout_id, s.id)}
                        className="rounded-lg bg-orange-500 px-3.5 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400"
                      >
                        Load on Trainer
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleDeleteSession(s)}
                      disabled={deletingId === s.id}
                      className="rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingId === s.id ? "Removing..." : "Remove"}
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              {t("calendar.completed")}
            </h2>
            {rides.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                {t("calendar.no_completed")}
              </div>
            ) : (
              rides.map((r) => (
                <div key={r.ride_uuid} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-zinc-400">{r.ride_day}</span>
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase ${sportBadge(r.sport).className}`}
                      >
                        {sportBadge(r.sport).label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500">{r.source}</span>
                      <button
                        type="button"
                        onClick={() => void handleDeleteRide(r)}
                        disabled={deletingId === r.ride_uuid}
                        className="rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-xs font-semibold text-rose-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {deletingId === r.ride_uuid ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 font-semibold text-white">{r.name}</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {r.sport === "running"
                      ? `${Math.round(r.duration_s / 60)}m · ${r.distance_m ? `${(r.distance_m / 1000).toFixed(1)} km` : "--"} · ${formatPace(r.avg_pace_s_per_km)} · Load ${r.tss} · HR ${r.avg_hr ?? "--"} bpm`
                      : `${Math.round(r.duration_s / 60)}m · NP ${r.np_watts ?? "--"}W · TSS ${r.tss} · HR ${r.avg_hr ?? "--"} bpm`}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
