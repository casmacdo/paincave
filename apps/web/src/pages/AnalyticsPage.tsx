import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { computeRideMetrics, parseFitRecords } from "@paincave/shared";
import {
  api,
  type AthleteThreshold,
  type FitnessOverviewResponse,
  type RideRecord,
} from "../lib/api.js";
import {
  MmpCurveChart,
  PmcChart,
  RideTimeseriesChart,
  WeeklyLoadChart,
  type RideTimeseriesPoint,
} from "../components/AnalyticsCharts.js";
import { downloadRideSummaryPng } from "../lib/workout-summary-card.js";

interface AnalyticsPageProps {
  thresholds: AthleteThreshold | null;
}

export function AnalyticsPage({ thresholds }: AnalyticsPageProps) {
  const [rangeDays, setRangeDays] = useState<42 | 90>(42);
  const [overview, setOverview] = useState<FitnessOverviewResponse | null>(null);
  const [biometrics, setBiometrics] = useState<Awaited<ReturnType<typeof api.getBiometrics>>>(null);
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<Awaited<
    ReturnType<typeof api.getRideDetail>
  > | null>(null);
  const [timeseries, setTimeseries] = useState<RideTimeseriesPoint[]>([]);
  const [loadingTimeseries, setLoadingTimeseries] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [retryingStravaUuid, setRetryingStravaUuid] = useState<string | null>(null);
  const [deletingRideUuid, setDeletingRideUuid] = useState<string | null>(null);

  const loadData = useCallback(async (days: 42 | 90) => {
    const [ov, rs, bio] = await Promise.all([
      api.getFitnessOverview(days),
      api.getRides(25),
      api.getBiometrics(days),
    ]);
    setOverview(ov);
    setRides(rs.rides);
    setBiometrics(bio);
  }, []);

  useEffect(() => {
    void loadData(rangeDays).catch(() => {});
  }, [loadData, rangeDays]);

  const handleSelectRide = async (rideUuid: string) => {
    setActionStatus(null);
    setLoadingTimeseries(true);
    try {
      const detail = await api.getRideDetail(rideUuid);
      setSelectedDetail(detail);
      const ts = await api.getRideTimeseries(rideUuid, 15).catch(() => null);
      setTimeseries(ts?.points ?? []);
    } catch (err) {
      setActionStatus(err instanceof Error ? err.message : "Failed to load ride details");
    } finally {
      setLoadingTimeseries(false);
    }
  };

  const handleRetryStrava = async (rideUuid: string) => {
    setRetryingStravaUuid(rideUuid);
    setActionStatus(null);
    try {
      const res = await api.retryStravaUpload(rideUuid);
      setActionStatus(
        res.status === "uploaded"
          ? `Uploaded to Strava (upload ${res.upload_id ?? "queued"}).`
          : `Strava status: ${res.status}${res.error ? ` — ${res.error}` : ""}`
      );
      await loadData(rangeDays);
      if (selectedDetail?.ride.ride_uuid === rideUuid) {
        const refreshed = await api.getRideDetail(rideUuid);
        setSelectedDetail(refreshed);
      }
    } catch (err) {
      setActionStatus(err instanceof Error ? err.message : "Strava retry failed");
    } finally {
      setRetryingStravaUuid(null);
    }
  };

  const handleFitUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadStatus("Parsing .fit file...");
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const parsed = parseFitRecords(bytes);
      const ftp = thresholds?.ftp_watts ?? 250;
      const metrics = computeRideMetrics(parsed.samples, {
        ftp_watts: ftp,
        lthr_bpm: thresholds?.lthr_bpm ?? null,
        hrmax_bpm: thresholds?.hrmax_bpm ?? null,
        weight_kg: thresholds?.weight_kg ?? null,
      });
      const startedAt = parsed.startTimeIso ?? new Date().toISOString();
      const rideDay = startedAt.slice(0, 10);
      const rideUuid = crypto.randomUUID();
      await api.uploadRideMultipart(
        {
          ride_uuid: rideUuid,
          name: file.name.replace(/\.fit$/i, "") || "Outdoor Ride",
          source: "manual_fit",
          started_at: startedAt,
          ride_day: rideDay,
          duration_s: metrics.duration_s,
          elapsed_s: metrics.elapsed_s,
          work_kj: metrics.work_kj,
          avg_power: metrics.avg_power,
          np_watts: metrics.np_watts,
          intensity_factor: metrics.intensity_factor,
          tss: metrics.tss,
          variability_index: metrics.variability_index,
          avg_hr: metrics.avg_hr,
          max_hr: metrics.max_hr,
          efficiency_factor: metrics.efficiency_factor,
          pw_hr_decoupling: metrics.pw_hr_decoupling,
          hrr_60s: metrics.hrr_60s,
          time_gt_90_hrmax_s: metrics.time_gt_90_hrmax_s,
          avg_cadence: metrics.avg_cadence,
          compliance_pct: null,
          power_zones: metrics.power_zones,
          hr_zones: metrics.hr_zones,
          quality_flags: metrics.quality_flags,
          ftp_snapshot: ftp,
          lthr_snapshot: thresholds?.lthr_bpm ?? null,
          hrmax_snapshot: thresholds?.hrmax_bpm ?? null,
          weight_kg_snapshot: thresholds?.weight_kg ?? null,
          notes: "Manual outdoor FIT upload",
          intervals: [],
          peaks: metrics.peaks,
        },
        file
      );
      setUploadStatus(`Uploaded ${file.name} (${metrics.duration_s}s, TSS ${metrics.tss}).`);
      await loadData(rangeDays);
    } catch (err) {
      setUploadStatus(err instanceof Error ? err.message : "FIT upload failed");
    }
  };

  const handleDeleteRide = async (ride: RideRecord) => {
    if (
      !window.confirm(
        `Delete "${ride.name}" (${ride.ride_day})?\n\nThis removes the ride, its FIT file, intervals, peaks, and PMC contribution. It does not remove an activity already uploaded to Strava.`
      )
    ) {
      return;
    }

    setDeletingRideUuid(ride.ride_uuid);
    setActionStatus(null);
    try {
      await api.deleteRide(ride.ride_uuid);
      setRides((current) => current.filter((item) => item.ride_uuid !== ride.ride_uuid));
      if (selectedDetail?.ride.ride_uuid === ride.ride_uuid) {
        setSelectedDetail(null);
        setTimeseries([]);
      }
      await loadData(rangeDays);
      setActionStatus("Ride deleted.");
    } catch (err) {
      setActionStatus(err instanceof Error ? err.message : "Failed to delete ride");
    } finally {
      setDeletingRideUuid(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">Fitness & Ride Analytics</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Analytics range"
            className="inline-flex rounded-xl border border-zinc-700 bg-zinc-900 p-0.5 text-xs"
          >
            {([42, 90] as const).map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setRangeDays(days)}
                aria-pressed={rangeDays === days}
                className={`rounded-lg px-3 py-1.5 font-semibold transition ${
                  rangeDays === days
                    ? "bg-orange-500 text-zinc-950"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                {days}d
              </button>
            ))}
          </div>

          <label className="cursor-pointer rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800">
            Upload Outdoor .FIT
            <input
              type="file"
              accept=".fit"
              className="hidden"
              onChange={(e) => void handleFitUpload(e)}
            />
          </label>
        </div>
      </div>

      {uploadStatus && (
        <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 px-4 py-2.5 text-sm text-orange-200">
          {uploadStatus}
        </div>
      )}

      {actionStatus && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-300">
          {actionStatus}
        </div>
      )}

      {/* Daily Readiness & Biometrics (shown automatically when Garmin/biometric data exists) */}
      {biometrics && biometrics.summary.latest && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">HRV (7d Avg)</div>
            <div className="mt-1 text-2xl font-bold text-emerald-400">
              {biometrics.summary.hrv_7d_avg !== null ? `${biometrics.summary.hrv_7d_avg} ms` : "—"}
            </div>
            {biometrics.summary.hrv_delta_pct !== null && (
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {biometrics.summary.hrv_delta_pct >= 0 ? "+" : ""}
                {biometrics.summary.hrv_delta_pct}% vs baseline
              </div>
            )}
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">Resting HR (7d)</div>
            <div className="mt-1 text-2xl font-bold text-sky-400">
              {biometrics.summary.resting_hr_7d_avg !== null
                ? `${biometrics.summary.resting_hr_7d_avg} bpm`
                : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">Sleep (7d Avg)</div>
            <div className="mt-1 text-2xl font-bold text-indigo-300">
              {biometrics.summary.sleep_hours_7d_avg !== null
                ? `${biometrics.summary.sleep_hours_7d_avg} h`
                : "—"}
            </div>
            {biometrics.summary.sleep_score_7d_avg !== null && (
              <div className="mt-0.5 text-[11px] text-zinc-500">
                Score {biometrics.summary.sleep_score_7d_avg}/100
              </div>
            )}
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">Body Battery Peak</div>
            <div className="mt-1 text-2xl font-bold text-orange-400">
              {biometrics.summary.latest.body_battery_high !== null
                ? `${biometrics.summary.latest.body_battery_high}`
                : "—"}
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500">{biometrics.summary.latest.day}</div>
          </div>
        </div>
      )}

      {/* PMC Summary Cards */}
      {overview && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">CTL (Fitness)</div>
            <div className="mt-1 text-2xl font-bold text-sky-400">{overview.current_pmc.ctl}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">ATL (Fatigue)</div>
            <div className="mt-1 text-2xl font-bold text-rose-400">{overview.current_pmc.atl}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">TSB (Form)</div>
            <div className="mt-1 text-2xl font-bold text-emerald-400">{overview.current_pmc.tsb}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">7d Ramp Rate</div>
            <div className="mt-1 text-2xl font-bold text-white">
              {overview.current_pmc.ramp_rate_7d}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-400">Est. CP / W&apos;</div>
            <div className="mt-1 text-lg font-bold text-orange-400">
              {overview.cp_estimate_42d
                ? `${overview.cp_estimate_42d.cp_watts}W / ${Math.round(overview.cp_estimate_42d.w_prime_j / 1000)}kJ`
                : "--"}
            </div>
          </div>
        </div>
      )}

      {/* Visual PMC + Power Curve + Weekly Load Charts */}
      {overview && (
        <div className="space-y-4">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Performance Management Chart ({rangeDays} Days)
            </h2>
            <PmcChart data={overview.daily_pmc} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
                Mean Maximal Power Curve (42d vs 90d)
              </h2>
              <MmpCurveChart mmp42={overview.mmp_42d} mmp90={overview.mmp_90d} />
            </section>

            <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
                Weekly Training Load (TSS &amp; Hours)
              </h2>
              <WeeklyLoadChart weeks={overview.weekly_rollups} />
            </section>
          </div>
        </div>
      )}

      {/* Recent Rides + Detail Inspection */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Recent Rides
          </h2>
          {rides.map((r) => {
            const isSelected = selectedDetail?.ride.ride_uuid === r.ride_uuid;
            return (
              <div
                key={r.ride_uuid}
                className={`flex items-stretch gap-2 rounded-xl border bg-zinc-900 p-2 ${
                  isSelected ? "border-orange-500/70" : "border-zinc-800"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void handleSelectRide(r.ride_uuid)}
                  className="min-w-0 flex-1 rounded-lg p-1.5 text-left hover:bg-zinc-800"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold text-white">{r.name}</span>
                    <span className="shrink-0 text-xs font-mono text-zinc-400">{r.ride_day}</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {Math.round(r.duration_s / 60)}m · NP {r.np_watts ?? "--"}W · IF{" "}
                    {r.intensity_factor ?? "--"} · TSS {Math.round(r.tss)} · Pw:HR{" "}
                    {r.pw_hr_decoupling !== null ? `${r.pw_hr_decoupling}%` : "--"}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteRide(r)}
                  disabled={deletingRideUuid === r.ride_uuid}
                  className="self-center rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingRideUuid === r.ride_uuid ? "Deleting..." : "Delete"}
                </button>
              </div>
            );
          })}
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Ride &amp; Interval Detail
          </h2>
          {!selectedDetail ? (
            <p className="mt-3 text-sm text-zinc-500">
              Select a ride to inspect its Power/HR chart, per-interval compliance, summary PNG card,
              and Strava sync status.
            </p>
          ) : (
            <div className="mt-3 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="text-sm text-zinc-300">
                  <strong>{selectedDetail.ride.name}</strong> · RPE{" "}
                  {selectedDetail.ride.rpe ?? "--"} · Compliance{" "}
                  {selectedDetail.ride.compliance_pct ?? "--"}% · Strava:{" "}
                  <span className="font-mono text-xs">{selectedDetail.ride.strava_upload_status}</span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const ok = downloadRideSummaryPng(selectedDetail.ride, timeseries);
                      setActionStatus(
                        ok
                          ? "Downloaded workout summary PNG."
                          : "Canvas export is unavailable in this browser."
                      );
                    }}
                    className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700"
                  >
                    Download Summary PNG
                  </button>
                  <a
                    href={`/api/rides/${encodeURIComponent(selectedDetail.ride.ride_uuid)}/fit`}
                    className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                  >
                    .FIT
                  </a>
                  {(selectedDetail.ride.strava_upload_status === "failed" ||
                    selectedDetail.ride.strava_upload_status === "pending") && (
                    <button
                      type="button"
                      onClick={() => void handleRetryStrava(selectedDetail.ride.ride_uuid)}
                      disabled={retryingStravaUuid === selectedDetail.ride.ride_uuid}
                      className="rounded-lg bg-orange-500 px-2.5 py-1.5 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-50"
                    >
                      {retryingStravaUuid === selectedDetail.ride.ride_uuid
                        ? "Uploading..."
                        : "Retry Strava"}
                    </button>
                  )}
                </div>
              </div>

              {loadingTimeseries ? (
                <div className="h-36 animate-pulse rounded-xl bg-zinc-950/70" />
              ) : (
                <RideTimeseriesChart points={timeseries} />
              )}

              {selectedDetail.intervals.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-zinc-800 text-zinc-400">
                      <tr>
                        <th className="py-1.5">Step</th>
                        <th>Target</th>
                        <th>Actual</th>
                        <th>%</th>
                        <th>HR</th>
                        <th>Drift</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedDetail.intervals.map((iv) => (
                        <tr key={iv.step_index} className="border-b border-zinc-800/50 text-zinc-200">
                          <td className="py-1.5">{iv.label}</td>
                          <td>{iv.target_watts ?? "--"}W</td>
                          <td>{iv.actual_avg_watts ?? "--"}W</td>
                          <td>{iv.pct_of_target ?? "--"}%</td>
                          <td>{iv.avg_hr ?? "--"}</td>
                          <td>{iv.hr_drift_bpm !== null ? `${iv.hr_drift_bpm} bpm` : "--"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
