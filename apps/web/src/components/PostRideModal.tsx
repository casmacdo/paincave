import { useState } from "react";

interface PostRideModalProps {
  open: boolean;
  workoutName: string;
  elapsedS: number;
  onSubmit: (payload: { rpe: number; feel: number; notes: string }) => void;
  onCancel: () => void;
}

export function PostRideModal({
  open,
  workoutName,
  elapsedS,
  onSubmit,
  onCancel,
}: PostRideModalProps) {
  const [rpe, setRpe] = useState(6);
  const [feel, setFeel] = useState(4);
  const [notes, setNotes] = useState("");

  if (!open) return null;

  const mins = Math.floor(elapsedS / 60);
  const secs = elapsedS % 60;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <h2 className="text-xl font-bold text-white">Save Ride: {workoutName}</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Recorded {mins}m {secs}s — log how the legs felt for post-ride analysis.
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300">
              RPE (1 Easy – 10 Max): <span className="font-bold text-orange-400">{rpe}</span>
            </label>
            <input
              aria-label="RPE"
              type="range"
              min={1}
              max={10}
              value={rpe}
              onChange={(e) => setRpe(Number(e.target.value))}
              className="mt-2 w-full accent-orange-500"
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-zinc-300">Legs / Feel (1–5)</span>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {[1, 2, 3, 4, 5].map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setFeel(val)}
                  className={`rounded-lg py-2 text-sm font-bold transition ${
                    feel === val
                      ? "bg-orange-500 text-zinc-950"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="ride-notes" className="block text-sm font-medium text-zinc-300">
              Ride Notes
            </label>
            <textarea
              id="ride-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Sleep, nutrition, knee feel, cadence notes..."
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-sm text-white placeholder:text-zinc-500"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Back to Ride
          </button>
          <button
            type="button"
            onClick={() => onSubmit({ rpe, feel, notes })}
            className="rounded-lg bg-orange-500 px-5 py-2 text-sm font-bold text-zinc-950 hover:bg-orange-400"
          >
            Save & Upload FIT
          </button>
        </div>
      </div>
    </div>
  );
}
