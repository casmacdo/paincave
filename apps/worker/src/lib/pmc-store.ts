import { computeDailyPmc, type DailyPmcPoint } from "@paincave/shared";

function addDaysUtc(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function todayUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Incrementally recomputes `daily_pmc` starting from `fromDay` (or immediately after
 * the latest prior `daily_pmc` entry if there is a gap) through `todayUtc`.
 */
export async function recomputePmcFromDay(
  db: D1Database,
  fromDay: string
): Promise<DailyPmcPoint[]> {
  const [priorRes, maxDayRes] = await Promise.all([
    db
      .prepare(
        "SELECT day, ctl, atl FROM daily_pmc WHERE day < ? ORDER BY day DESC LIMIT 8"
      )
      .bind(fromDay)
      .all<{ day: string; ctl: number; atl: number }>(),
    db
      .prepare(
        `SELECT MAX(d) AS max_day FROM (
           SELECT MAX(ride_day) AS d FROM rides
           UNION ALL
           SELECT MAX(day) AS d FROM daily_pmc
         )`
      )
      .first<{ max_day: string | null }>(),
  ]);

  const priorRows = priorRes.results;
  const latestPrior = priorRows[0];
  const effectiveStart = latestPrior ? addDaysUtc(latestPrior.day, 1) : fromDay;
  const startDay = effectiveStart < fromDay ? effectiveStart : fromDay;

  const today = todayUtcDay();
  const existingMax = maxDayRes?.max_day ?? fromDay;
  const endDay = [today, existingMax, fromDay].sort().at(-1) ?? today;

  const tssRes = await db
    .prepare(
      `SELECT ride_day AS day, SUM(tss) AS total_tss
       FROM rides
       WHERE ride_day >= ?
       GROUP BY ride_day
       ORDER BY ride_day ASC`
    )
    .bind(startDay)
    .all<{ day: string; total_tss: number }>();

  const priorCtlWindow = priorRows
    .slice(0, 7)
    .reverse()
    .map((r) => r.ctl);

  const computed = computeDailyPmc(tssRes.results, {
    startDay,
    endDay,
    initialCtl: latestPrior?.ctl ?? 0,
    initialAtl: latestPrior?.atl ?? 0,
    priorCtlWindow,
  });

  if (computed.length === 0) return [];

  const upsertSql = `INSERT INTO daily_pmc (day, total_tss, ctl, atl, tsb, ramp_rate_7d, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(day) DO UPDATE SET
      total_tss = excluded.total_tss,
      ctl = excluded.ctl,
      atl = excluded.atl,
      tsb = excluded.tsb,
      ramp_rate_7d = excluded.ramp_rate_7d,
      updated_at = excluded.updated_at`;

  const statements = computed.map((p) =>
    db.prepare(upsertSql).bind(p.day, p.total_tss, p.ctl, p.atl, p.tsb, p.ramp_rate_7d)
  );

  // Chunk below D1's 1,000-statement batch limit
  for (let i = 0; i < statements.length; i += 500) {
    await db.batch(statements.slice(i, i + 500));
  }

  return computed;
}
