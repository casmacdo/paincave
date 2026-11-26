import { useEffect, useState, type ChangeEvent } from "react";
import { computeRideMetrics, parseFitRecords } from "@paincave/shared";
import {
  api,
  type AthleteThreshold,
  type FitnessOverviewResponse,
  type RideRecord,
} from "../lib/api.js";

interface AnalyticsPageProps {
  thresholds: AthleteThreshold | null;
}

export function AnalyticsPage({ thresholds }: AnalyticsPageProps) {
  const [overview, setOverview] = useState<FitnessOverviewResponse | null>(null);
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<Awaited<
    ReturnType<typeof api.getRideDetail>
  > | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const loadData = async () => {
    const [ov, rs] = await Promise.all([api.getFitnessOverview(42), api.getRides(25)]);
    setOverview(ov);
    setRides(rs.rides);
  };

  useEffect(() => {
    void loadData().catch(() => {});
  }, []);

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
      await loadData();
    } catch (err) {
      setUploadStatus(err instanceof Error ? err.message : "FIT upload failed");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">Fitness & Ride Analytics</h1>
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

      {uploadStatus && (
        <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 px-4 py-2.5 text-sm text-orange-200">
          {uploadStatus}
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

      {/* 42-Day Peak Power Curve */}
      {overview && overview.mmp_42d.length > 0 && (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            42-Day Mean Maximal Power (MMP)
          </h2>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-11">
            {overview.mmp_42d.map((p) => (
              <div key={p.duration_s} className="rounded-lg bg-zinc-950 p-2.5 text-center">
                <div className="text-xs text-zinc-500">
                  {p.duration_s < 60 ? `${p.duration_s}s` : `${p.duration_s / 60}m`}
                </div>
                <div className="text-base font-bold text-white">{p.watts}W</div>
                {p.w_per_kg !== null && (
                  <div className="text-[11px] text-zinc-400">{p.w_per_kg} W/kg</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Rides + Detail Compliance */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Recent Rides
          </h2>
          {rides.map((r) => (
            <button
              key={r.ride_uuid}
              type="button"
              onClick={() => void api.getRideDetail(r.ride_uuid).then(setSelectedDetail)}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3.5 text-left hover:border-orange-500/60"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">{r.name}</span>
                <span className="text-xs font-mono text-zinc-400">{r.ride_day}</span>
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                {Math.round(r.duration_s / 60)}m · NP {r.np_watts ?? "--"}W · IF{" "}
                {r.intensity_factor ?? "--"} · TSS {r.tss} · Pw:HR{" "}
                {r.pw_hr_decoupling !== null ? `${r.pw_hr_decoupling}%` : "--"}
              </div>
            </button>
          ))}
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Interval Execution Detail
          </h2>
          {!selectedDetail ? (
            <p className="mt-3 text-sm text-zinc-500">
              Select a ride to inspect per-interval compliance, HR drift, and Strava sync status.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              <div className="text-sm text-zinc-300">
                <strong>{selectedDetail.ride.name}</strong> · RPE{" "}
                {selectedDetail.ride.rpe ?? "--"} · Compliance{" "}
                {selectedDetail.ride.compliance_pct ?? "--"}% · Strava:{" "}
                {selectedDetail.ride.strava_upload_status}
              </div>
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
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
