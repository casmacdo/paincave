import { useEffect, useState } from "react";
import { WorkoutSpecSchema, flattenWorkout } from "@paincave/shared";
import { api, type WorkoutRecord } from "../lib/api.js";
import { WorkoutProfileSvg } from "../components/LiveWorkoutChart.js";

interface WorkoutsPageProps {
  ftpWatts: number;
  onLoadWorkout: (workoutId: string) => Promise<void>;
}

export function WorkoutsPage({ ftpWatts, onLoadWorkout }: WorkoutsPageProps) {
  const [workouts, setWorkouts] = useState<WorkoutRecord[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getWorkouts()
      .then((res) => {
        if (active) setWorkouts(res.workouts);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load workouts");
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = workouts.filter(
    (w) =>
      w.name.toLowerCase().includes(search.toLowerCase()) ||
      w.category.toLowerCase().includes(search.toLowerCase())
  );

  const handleDelete = async (workout: WorkoutRecord) => {
    if (
      !window.confirm(
        `Delete "${workout.name}" from your workout library?\n\nCompleted ride history and planned sessions will be preserved.`
      )
    ) {
      return;
    }

    setDeletingId(workout.id);
    setError(null);
    try {
      await api.deleteWorkout(workout.id);
      setWorkouts((current) => current.filter((item) => item.id !== workout.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete workout");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Workout Library</h1>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name or category..."
          className="w-full max-w-xs rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-500"
        />
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {filtered.map((w) => {
          let steps: ReturnType<typeof flattenWorkout> = [];
          try {
            const spec = WorkoutSpecSchema.parse(JSON.parse(w.spec_json));
            steps = flattenWorkout(spec, ftpWatts);
          } catch {
            steps = [];
          }

          return (
            <div key={w.id} className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs uppercase text-orange-400">
                    {w.category}
                  </span>
                  <h2 className="mt-1 text-lg font-bold text-white">{w.name}</h2>
                  <p className="text-xs text-zinc-400">
                    {Math.round(w.duration_s / 60)}m · NP {w.predicted_np ?? "--"}W · IF{" "}
                    {w.predicted_if ?? "--"} · TSS {w.predicted_tss ?? "--"}
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => void onLoadWorkout(w.id)}
                    className="rounded-lg bg-orange-500 px-3 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400"
                  >
                    Load on Trainer
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(w)}
                    disabled={deletingId === w.id}
                    className="rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deletingId === w.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>

              {steps.length > 0 && <WorkoutProfileSvg steps={steps} ftpWatts={ftpWatts} height={64} />}

              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>By {w.created_by}</span>
                <div className="flex gap-3">
                  <a
                    href={`/api/workouts/${w.id}/export.zwo`}
                    className="text-zinc-300 underline hover:text-white"
                  >
                    Download .zwo
                  </a>
                  <a
                    href={`/api/workouts/${w.id}/export.erg`}
                    className="text-zinc-300 underline hover:text-white"
                  >
                    Download .erg
                  </a>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
