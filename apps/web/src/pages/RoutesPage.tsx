import { useCallback, useEffect, useRef, useState } from "react";
import type { RoutePayload, RoutePoint } from "@paincave/shared";
import { api, type RideRecord, type RouteRecord, type WorkoutRecord } from "../lib/api.js";
import { RouteElevationMap } from "../components/RouteElevationMap.js";

interface RoutesPageProps {
  onLoadRoute: (route: RoutePayload) => void;
  onLoadWorkoutWithRoute: (workoutId: string, route: RoutePayload) => Promise<void>;
}

export function RoutesPage({ onLoadRoute, onLoadWorkoutWithRoute }: RoutesPageProps) {
  const [routes, setRoutes] = useState<RouteRecord[]>([]);
  const [workouts, setWorkouts] = useState<WorkoutRecord[]>([]);
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedPoints, setSelectedPoints] = useState<RoutePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingGeometry, setLoadingGeometry] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [extractRideUuid, setExtractRideUuid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Launch config
  const [rideMode, setRideMode] = useState<"sim" | "erg_workout">("sim");
  const [selectedWorkoutId, setSelectedWorkoutId] = useState<string>("");
  const [difficultyPct, setDifficultyPct] = useState<number>(100);
  const [loopRoute, setLoopRoute] = useState<boolean>(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedRoute = routes.find((r) => r.id === selectedId) ?? null;

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [routesRes, workoutsRes, ridesRes] = await Promise.all([
        api.getRoutes(),
        api.getWorkouts(),
        api.getRides(20),
      ]);
      setRoutes(routesRes.routes);
      setWorkouts(workoutsRes.workouts);
      setRides(ridesRes.rides);
      if (routesRes.routes.length > 0) {
        setSelectedId((cur) => cur || (routesRes.routes[0]?.id ?? ""));
      }
      if (workoutsRes.workouts.length > 0) {
        setSelectedWorkoutId((cur) => cur || (workoutsRes.workouts[0]?.id ?? ""));
      }
      if (ridesRes.rides.length > 0) {
        setExtractRideUuid((cur) => cur || (ridesRes.rides[0]?.ride_uuid ?? ""));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load routes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedPoints([]);
      return;
    }
    let active = true;
    setLoadingGeometry(true);
    api
      .getRoute(selectedId)
      .then((res) => {
        if (!active) return;
        setSelectedPoints(res.points);
        setLoopRoute(res.route.loop_route);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load route geometry");
      })
      .finally(() => {
        if (active) setLoadingGeometry(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const handleUploadGpx = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const xml = await file.text();
      const res = await api.uploadGpxRoute(xml, file.name);
      setRoutes((prev) => [res.route, ...prev]);
      setSelectedId(res.route.id);
      setSelectedPoints(res.points);
      setNotice(`Imported GPX route "${res.route.name}" (${(res.route.distance_m / 1000).toFixed(1)} km).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import GPX file");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleExtractFromRide = async () => {
    if (!extractRideUuid) return;
    setExtracting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.extractRouteFromRide(extractRideUuid);
      setRoutes((prev) => [res.route, ...prev]);
      setSelectedId(res.route.id);
      setSelectedPoints(res.points);
      setNotice(`Extracted route "${res.route.name}" from FIT ride.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not extract GPS track from ride");
    } finally {
      setExtracting(false);
    }
  };

  const handleDeleteRoute = async (route: RouteRecord) => {
    if (!window.confirm(`Delete route "${route.name}"?`)) return;
    setError(null);
    try {
      await api.deleteRoute(route.id);
      setRoutes((prev) => {
        const remaining = prev.filter((item) => item.id !== route.id);
        if (selectedId === route.id) {
          setSelectedId(remaining[0]?.id ?? "");
        }
        return remaining;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete route");
    }
  };

  const handleLaunch = async () => {
    if (!selectedRoute || selectedPoints.length < 2) return;
    const payload: RoutePayload = {
      name: selectedRoute.name,
      points: selectedPoints,
      loop_route: loopRoute,
      sim_mode: rideMode === "sim",
      trainer_difficulty_pct: difficultyPct,
    };
    setError(null);
    if (rideMode === "sim") {
      onLoadRoute(payload);
      return;
    }
    if (!selectedWorkoutId) {
      setError("Select a workout to pair with this virtual route.");
      return;
    }
    setLaunching(true);
    try {
      await onLoadWorkoutWithRoute(selectedWorkoutId, payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workout with route");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Routes &amp; SIM Mode</h1>
          <p className="mt-0.5 text-sm text-zinc-400">
            Import GPX courses, ride real elevation gradients in SIM mode, or pair a virtual route with ERG workouts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".gpx,application/gpx+xml,application/xml,text/xml"
            aria-label="Import GPX route file"
            onChange={(e) => void handleUploadGpx(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg bg-orange-500 px-3.5 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
          >
            {uploading ? "Importing..." : "Import .gpx Route"}
          </button>
        </div>
      </div>

      {rides.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-3 text-xs">
          <span className="font-semibold uppercase tracking-wider text-zinc-400">
            Extract from FIT Ride:
          </span>
          <select
            aria-label="Select ride to extract GPS route"
            value={extractRideUuid}
            onChange={(e) => setExtractRideUuid(e.target.value)}
            className="min-w-[14rem] rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-orange-500 focus:outline-none"
          >
            {rides.map((r) => (
              <option key={r.ride_uuid} value={r.ride_uuid}>
                {r.ride_day} · {r.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={extracting || !extractRideUuid}
            onClick={() => void handleExtractFromRide()}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-semibold text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            {extracting ? "Extracting..." : "Extract GPS Track"}
          </button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200"
        >
          {notice}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-400">Loading routes...</div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
          {/* Route Picker List */}
          <div className="space-y-2.5">
            {routes.map((r) => {
              const active = r.id === selectedId;
              return (
                <div
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId(r.id);
                    }
                  }}
                  className={`cursor-pointer rounded-2xl border p-3.5 transition ${
                    active
                      ? "border-orange-500 bg-zinc-900"
                      : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                            r.is_preset
                              ? "bg-zinc-800 text-zinc-300"
                              : r.source === "fit_extract"
                                ? "bg-sky-500/20 text-sky-300"
                                : "bg-orange-500/20 text-orange-300"
                          }`}
                        >
                          {r.is_preset ? "Preset" : r.source === "fit_extract" ? "FIT" : "GPX"}
                        </span>
                        <span className="truncate text-sm font-bold text-white">{r.name}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{r.description}</p>
                    </div>
                    {!r.is_preset && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteRoute(r);
                        }}
                        className="shrink-0 text-xs text-rose-400/80 hover:text-rose-300"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                  <div className="mt-2.5 flex items-center gap-3 text-xs tabular-nums text-zinc-300">
                    <span>{(r.distance_m / 1000).toFixed(1)} km</span>
                    <span>+{Math.round(r.total_ascent_m)} m</span>
                    <span>Max {r.max_grade_pct.toFixed(1)}%</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Preview & Launch Configuration */}
          <div className="space-y-4">
            {selectedRoute && !loadingGeometry && selectedPoints.length >= 2 ? (
              <RouteElevationMap
                name={selectedRoute.name}
                points={selectedPoints}
                loopRoute={loopRoute}
                simMode={rideMode === "sim"}
                trainerDifficultyPct={difficultyPct}
              />
            ) : (
              <div className="flex h-48 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/50 text-sm text-zinc-500">
                {loadingGeometry ? "Loading route geometry..." : "Select a route to preview"}
              </div>
            )}

            {selectedRoute && (
              <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold text-white">Ride Setup</h2>
                    <p className="text-xs text-zinc-400">
                      Uploads cleanly to Strava as a VirtualRide with map &amp; elevation (no outdoor KOM flags).
                    </p>
                  </div>

                  <div
                    role="group"
                    aria-label="Route ride mode"
                    className="inline-flex rounded-lg border border-zinc-700 bg-zinc-950 p-0.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => setRideMode("sim")}
                      aria-pressed={rideMode === "sim"}
                      className={`rounded-md px-3 py-1.5 font-semibold transition ${
                        rideMode === "sim"
                          ? "bg-orange-500 text-zinc-950"
                          : "text-zinc-400 hover:text-white"
                      }`}
                    >
                      SIM Mode (Free Ride)
                    </button>
                    <button
                      type="button"
                      onClick={() => setRideMode("erg_workout")}
                      aria-pressed={rideMode === "erg_workout"}
                      className={`rounded-md px-3 py-1.5 font-semibold transition ${
                        rideMode === "erg_workout"
                          ? "bg-orange-500 text-zinc-950"
                          : "text-zinc-400 hover:text-white"
                      }`}
                    >
                      ERG Workout + Route
                    </button>
                  </div>
                </div>

                {rideMode === "sim" ? (
                  <div className="space-y-2 rounded-xl bg-zinc-950/70 p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <label htmlFor="trainer-difficulty-slider" className="font-semibold text-zinc-200">
                        Trainer Difficulty
                      </label>
                      <span className="font-bold tabular-nums text-orange-400">{difficultyPct}%</span>
                    </div>
                    <input
                      id="trainer-difficulty-slider"
                      type="range"
                      min={25}
                      max={100}
                      step={5}
                      value={difficultyPct}
                      onChange={(e) => setDifficultyPct(Number(e.target.value))}
                      className="w-full accent-orange-500"
                    />
                    <p className="text-[11px] text-zinc-500">
                      Scales road gradient felt on the trainer (e.g. 50% turns an 8% climb into 4% resistance while keeping full virtual climbing physics).
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5 rounded-xl bg-zinc-950/70 p-3.5">
                    <label
                      htmlFor="route-erg-workout"
                      className="block text-xs font-semibold text-zinc-200"
                    >
                      Structured ERG Workout
                    </label>
                    <select
                      id="route-erg-workout"
                      value={selectedWorkoutId}
                      onChange={(e) => setSelectedWorkoutId(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
                    >
                      {workouts.length === 0 ? (
                        <option value="">No workouts in library</option>
                      ) : (
                        workouts.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name} ({Math.round(w.duration_s / 60)}m · TSS {w.predicted_tss ?? "--"})
                          </option>
                        ))
                      )}
                    </select>
                    <p className="text-[11px] text-zinc-500">
                      Trainer follows ERG power targets while real road physics moves you along this route and saves GPS/elevation to the FIT file.
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={loopRoute}
                      onChange={(e) => setLoopRoute(e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 accent-orange-500"
                    />
                    Loop route continuously
                  </label>

                  <button
                    type="button"
                    disabled={
                      launching ||
                      loadingGeometry ||
                      selectedPoints.length < 2 ||
                      (rideMode === "erg_workout" && !selectedWorkoutId)
                    }
                    onClick={() => void handleLaunch()}
                    className="rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-bold text-zinc-950 hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {launching ? "Loading..." : "Load Route on Trainer"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
