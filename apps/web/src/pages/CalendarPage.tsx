import { useEffect, useState } from "react";
import { api, type PlannedSessionRecord, type RideRecord } from "../lib/api.js";

interface CalendarPageProps {
  onLoadWorkout: (workoutId: string, plannedSessionId?: string) => Promise<void>;
}

function isoDateOffset(base: Date, deltaDays: number): string {
  const dt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + deltaDays));
  return dt.toISOString().slice(0, 10);
}

export function CalendarPage({ onLoadWorkout }: CalendarPageProps) {
  const [sessions, setSessions] = useState<PlannedSessionRecord[]>([]);
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const now = new Date();
  const start = isoDateOffset(now, -7);
  const end = isoDateOffset(now, 14);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .getCalendar(start, end)
      .then((res) => {
        if (!active) return;
        setSessions(res.planned_sessions);
        setRides(res.completed_rides);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load calendar");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end]);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Training Calendar</h1>
          <p className="text-sm text-zinc-400">
            Showing {start} through {end}
          </p>
        </div>
      </div>

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
              Planned Workouts
            </h2>
            {sessions.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                No planned sessions in this window. Use Remote MCP to plan and schedule workouts for your week.
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
                      {Math.round(s.planned_duration_s / 60)}m · TSS {s.predicted_tss ?? "--"} · IF{" "}
                      {s.predicted_if ?? "--"}
                    </div>
                    {s.coach_rationale && (
                      <p className="mt-1 text-xs text-zinc-400">{s.coach_rationale}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void onLoadWorkout(s.workout_id, s.id)}
                      className="rounded-lg bg-orange-500 px-3.5 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400"
                    >
                      Load on Trainer
                    </button>
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
              Completed Rides
            </h2>
            {rides.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                No completed rides recorded in this window yet.
              </div>
            ) : (
              rides.map((r) => (
                <div key={r.ride_uuid} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-zinc-400">{r.ride_day}</span>
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
                    {Math.round(r.duration_s / 60)}m · NP {r.np_watts ?? "--"}W · TSS {r.tss} · HR{" "}
                    {r.avg_hr ?? "--"} bpm
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
