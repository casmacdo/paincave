import {
  estimateCriticalPower,
  type CriticalPowerEstimate,
  type MmpDuration,
  type MmpPoint,
  type PowerZoneSeconds,
} from "@paincave/shared";
import { DEFAULT_OWNER_USER_ID } from "./better-auth.js";
import { todayUtcDay } from "./pmc-store.js";
import { getLatestThresholds } from "../routes/athlete.js";

export interface WeeklyRollup {
  week_start: string;
  rides: number;
  hours: number;
  tss: number;
  work_kj: number;
  distance_km: number;
  running_km: number;
  zone_distribution_pct: PowerZoneSeconds;
}

export interface FitnessOverview {
  current_pmc: {
    day: string | null;
    ctl: number;
    atl: number;
    tsb: number;
    ramp_rate_7d: number;
  };
  daily_pmc: {
    day: string;
    total_tss: number;
    ctl: number;
    atl: number;
    tsb: number;
    ramp_rate_7d: number;
  }[];
  weekly_rollups: WeeklyRollup[];
  mmp_42d: MmpPoint[];
  mmp_90d: MmpPoint[];
  cp_estimate_42d: CriticalPowerEstimate | null;
}

function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function mondayOfWeek(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diff);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function queryRollingMmp(
  db: D1Database,
  userId: string,
  sinceDay: string,
  weightKg: number | null
): Promise<MmpPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT rp.duration_s, MAX(rp.watts) AS watts
       FROM ride_peaks rp
       JOIN rides r ON r.ride_uuid = rp.ride_uuid
       WHERE r.user_id = ? AND r.ride_day >= ?
       GROUP BY rp.duration_s
       ORDER BY rp.duration_s ASC`
    )
    .bind(userId, sinceDay)
    .all<{ duration_s: MmpDuration; watts: number }>();

  return results.map((r) => ({
    duration_s: r.duration_s,
    watts: r.watts,
    w_per_kg: weightKg && weightKg > 0 ? Number((r.watts / weightKg).toFixed(2)) : null,
  }));
}

export async function getFitnessOverview(
  db: D1Database,
  days = 42,
  userId = DEFAULT_OWNER_USER_ID
): Promise<FitnessOverview> {
  const clampedDays = Math.min(365, Math.max(7, days));
  const today = todayUtcDay();
  const startDay = shiftDay(today, -(clampedDays - 1));
  const day42 = shiftDay(today, -41);
  const day90 = shiftDay(today, -89);

  const [pmcRes, latestPmc, ridesRes, latestThresholds] = await Promise.all([
    db
      .prepare(
        "SELECT day, total_tss, ctl, atl, tsb, ramp_rate_7d FROM daily_pmc WHERE user_id = ? AND day >= ? ORDER BY day ASC"
      )
      .bind(userId, startDay)
      .all<{
        day: string;
        total_tss: number;
        ctl: number;
        atl: number;
        tsb: number;
        ramp_rate_7d: number;
      }>(),
    db
      .prepare(
        "SELECT day, ctl, atl, tsb, ramp_rate_7d FROM daily_pmc WHERE user_id = ? ORDER BY day DESC LIMIT 1"
      )
      .bind(userId)
      .first<{
        day: string;
        ctl: number;
        atl: number;
        tsb: number;
        ramp_rate_7d: number;
      }>(),
    db
      .prepare(
        "SELECT ride_day, sport, duration_s, distance_m, tss, work_kj, power_zones_json FROM rides WHERE user_id = ? AND ride_day >= ? ORDER BY ride_day ASC"
      )
      .bind(userId, startDay)
      .all<{
        ride_day: string;
        sport: string;
        duration_s: number;
        distance_m: number | null;
        tss: number;
        work_kj: number;
        power_zones_json: string;
      }>(),
    getLatestThresholds(db, userId),
  ]);

  const weightKg = latestThresholds?.weight_kg ?? null;
  const [mmp42, mmp90] = await Promise.all([
    queryRollingMmp(db, userId, day42, weightKg),
    queryRollingMmp(db, userId, day90, weightKg),
  ]);

  const weeklyMap = new Map<
    string,
    {
      rides: number;
      duration_s: number;
      tss: number;
      work_kj: number;
      distance_m: number;
      running_m: number;
      zones: PowerZoneSeconds;
    }
  >();

  for (const ride of ridesRes.results) {
    const weekStart = mondayOfWeek(ride.ride_day);
    const entry = weeklyMap.get(weekStart) ?? {
      rides: 0,
      duration_s: 0,
      tss: 0,
      work_kj: 0,
      distance_m: 0,
      running_m: 0,
      zones: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, z6: 0, z7: 0 },
    };
    entry.rides++;
    entry.duration_s += ride.duration_s;
    entry.tss += ride.tss;
    entry.work_kj += ride.work_kj;
    entry.distance_m += ride.distance_m ?? 0;
    if (ride.sport === "running") {
      entry.running_m += ride.distance_m ?? 0;
    }

    try {
      const z = JSON.parse(ride.power_zones_json) as Partial<PowerZoneSeconds>;
      entry.zones.z1 += z.z1 ?? 0;
      entry.zones.z2 += z.z2 ?? 0;
      entry.zones.z3 += z.z3 ?? 0;
      entry.zones.z4 += z.z4 ?? 0;
      entry.zones.z5 += z.z5 ?? 0;
      entry.zones.z6 += z.z6 ?? 0;
      entry.zones.z7 += z.z7 ?? 0;
    } catch {
      // Ignore malformed zone JSON
    }
    weeklyMap.set(weekStart, entry);
  }

  const weeklyRollups: WeeklyRollup[] = [...weeklyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, w]) => {
      const zTotal =
        w.zones.z1 + w.zones.z2 + w.zones.z3 + w.zones.z4 + w.zones.z5 + w.zones.z6 + w.zones.z7;
      const pct = (sec: number): number =>
        zTotal > 0 ? Number(((sec / zTotal) * 100).toFixed(1)) : 0;
      return {
        week_start: weekStart,
        rides: w.rides,
        hours: Number((w.duration_s / 3600).toFixed(2)),
        tss: Number(w.tss.toFixed(1)),
        work_kj: Number(w.work_kj.toFixed(1)),
        distance_km: Number((w.distance_m / 1000).toFixed(2)),
        running_km: Number((w.running_m / 1000).toFixed(2)),
        zone_distribution_pct: {
          z1: pct(w.zones.z1),
          z2: pct(w.zones.z2),
          z3: pct(w.zones.z3),
          z4: pct(w.zones.z4),
          z5: pct(w.zones.z5),
          z6: pct(w.zones.z6),
          z7: pct(w.zones.z7),
        },
      };
    });

  return {
    current_pmc: {
      day: latestPmc?.day ?? null,
      ctl: latestPmc?.ctl ?? 0,
      atl: latestPmc?.atl ?? 0,
      tsb: latestPmc?.tsb ?? 0,
      ramp_rate_7d: latestPmc?.ramp_rate_7d ?? 0,
    },
    daily_pmc: pmcRes.results,
    weekly_rollups: weeklyRollups,
    mmp_42d: mmp42,
    mmp_90d: mmp90,
    cp_estimate_42d: estimateCriticalPower(mmp42),
  };
}
