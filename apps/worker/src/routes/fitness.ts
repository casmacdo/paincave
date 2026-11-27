import { Hono } from "hono";
import type { HonoAppContext } from "../types.js";
import { requireUiAuth } from "../lib/auth.js";
import { getFitnessOverview } from "../lib/fitness-service.js";
import { todayUtcDay } from "../lib/pmc-store.js";

export interface DailyBiometricsRow {
  user_id: string;
  day: string;
  hrv_rmssd_ms: number | null;
  hrv_status: string | null;
  resting_hr_bpm: number | null;
  sleep_duration_s: number | null;
  sleep_deep_s: number | null;
  sleep_rem_s: number | null;
  sleep_light_s: number | null;
  sleep_awake_s: number | null;
  sleep_score: number | null;
  body_battery_high: number | null;
  body_battery_low: number | null;
  body_battery_charged: number | null;
  stress_avg: number | null;
  steps: number | null;
  spo2_avg: number | null;
  weight_kg: number | null;
  cycle_phase: string | null;
  source: string;
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

export function computeBiometricsBaseline(rows: readonly DailyBiometricsRow[]) {
  const avg = (vals: (number | null)[]): number | null => {
    const valid = vals.filter((v): v is number => v !== null && Number.isFinite(v));
    if (valid.length === 0) return null;
    return Number((valid.reduce((s, v) => s + v, 0) / valid.length).toFixed(1));
  };

  const sortedDesc = [...rows].sort((a, b) => b.day.localeCompare(a.day));
  const recent7 = sortedDesc.slice(0, 7);
  const latest = sortedDesc[0] ?? null;

  const hrv7d = avg(recent7.map((r) => r.hrv_rmssd_ms));
  const hrvBaseline = avg(sortedDesc.map((r) => r.hrv_rmssd_ms));
  const hrvDeltaPct =
    hrv7d !== null && hrvBaseline !== null && hrvBaseline > 0
      ? Number((((hrv7d - hrvBaseline) / hrvBaseline) * 100).toFixed(1))
      : null;

  return {
    latest,
    hrv_7d_avg: hrv7d,
    hrv_baseline_avg: hrvBaseline,
    hrv_delta_pct: hrvDeltaPct,
    resting_hr_7d_avg: avg(recent7.map((r) => r.resting_hr_bpm)),
    resting_hr_baseline_avg: avg(sortedDesc.map((r) => r.resting_hr_bpm)),
    sleep_hours_7d_avg: avg(
      recent7.map((r) => (r.sleep_duration_s !== null ? r.sleep_duration_s / 3600 : null))
    ),
    sleep_score_7d_avg: avg(recent7.map((r) => r.sleep_score)),
  };
}

export function createFitnessRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();
  router.use("*", requireUiAuth);

  router.get("/overview", async (c) => {
    const userId = c.get("userId");
    const daysParam = Number(c.req.query("days") ?? 42);
    const days = Number.isFinite(daysParam) ? daysParam : 42;
    const overview = await getFitnessOverview(c.env.DB, days, userId);
    return c.json(overview);
  });

  router.get("/biometrics", async (c) => {
    const userId = c.get("userId");
    const daysParam = Number(c.req.query("days") ?? 30);
    const clampedDays = Number.isFinite(daysParam) ? Math.min(365, Math.max(7, Math.round(daysParam))) : 30;
    const sinceDay = shiftDay(todayUtcDay(), -(clampedDays - 1));

    const { results } = await c.env.DB.prepare(
      `SELECT user_id, day, hrv_rmssd_ms, hrv_status, resting_hr_bpm,
              sleep_duration_s, sleep_deep_s, sleep_rem_s, sleep_light_s, sleep_awake_s, sleep_score,
              body_battery_high, body_battery_low, body_battery_charged,
              stress_avg, steps, spo2_avg, weight_kg, cycle_phase, source
       FROM daily_biometrics
       WHERE user_id = ? AND day >= ?
       ORDER BY day ASC`
    )
      .bind(userId, sinceDay)
      .all<DailyBiometricsRow>();

    return c.json({
      days: clampedDays,
      summary: computeBiometricsBaseline(results),
      biometrics: results,
    });
  });

  return router;
}
