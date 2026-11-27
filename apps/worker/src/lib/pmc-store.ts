import { computeDailyPmc, type DailyPmcPoint } from "@paincave/shared";
import { DEFAULT_OWNER_USER_ID } from "./better-auth.js";

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
 * Incrementally recomputes `daily_pmc` for a single `userId` starting from `fromDay`
 * (or immediately after the latest prior `daily_pmc` entry if there is a gap) through `todayUtc`.
 */
export async function recomputePmcFromDay(
  db: D1Database,
  fromDay: string,
  userId = DEFAULT_OWNER_USER_ID
): Promise<DailyPmcPoint[]> {
  const [priorRes, maxDayRes] = await Promise.all([
    db
      .prepare(
        "SELECT day, ctl, atl FROM daily_pmc WHERE user_id = ? AND day < ? ORDER BY day DESC LIMIT 8"
      )
      .bind(userId, fromDay)
      .all<{ day: string; ctl: number; atl: number }>(),
    db
      .prepare(
        `SELECT MAX(d) AS max_day FROM (
           SELECT MAX(ride_day) AS d FROM rides WHERE user_id = ?
           UNION ALL
           SELECT MAX(day) AS d FROM daily_pmc WHERE user_id = ?
         )`
      )
      .bind(userId, userId)
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
       WHERE user_id = ? AND ride_day >= ?
       GROUP BY ride_day
       ORDER BY ride_day ASC`
    )
    .bind(userId, startDay)
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

  const upsertSql = `INSERT INTO daily_pmc (user_id, day, total_tss, ctl, atl, tsb, ramp_rate_7d, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(user_id, day) DO UPDATE SET
      total_tss = excluded.total_tss,
      ctl = excluded.ctl,
      atl = excluded.atl,
      tsb = excluded.tsb,
      ramp_rate_7d = excluded.ramp_rate_7d,
      updated_at = excluded.updated_at`;

  const statements = computed.map((p) =>
    db.prepare(upsertSql).bind(userId, p.day, p.total_tss, p.ctl, p.atl, p.tsb, p.ramp_rate_7d)
  );

  // Chunk below D1's 1,000-statement batch limit
  for (let i = 0; i < statements.length; i += 500) {
    await db.batch(statements.slice(i, i + 500));
  }

  return computed;
}

/**
 * Full multi-year PMC rebuild for a single `userId` (used after bulk archive imports).
 */
export async function rebuildAllPmcForUser(
  db: D1Database,
  userId: string
): Promise<{ days_computed: number; earliest_day: string | null }> {
  const earliest = await db
    .prepare("SELECT MIN(ride_day) AS min_day FROM rides WHERE user_id = ?")
    .bind(userId)
    .first<{ min_day: string | null }>();

  await db.prepare("DELETE FROM daily_pmc WHERE user_id = ?").bind(userId).run();
  if (!earliest?.min_day) {
    return { days_computed: 0, earliest_day: null };
  }

  const computed = await recomputePmcFromDay(db, earliest.min_day, userId);
  return { days_computed: computed.length, earliest_day: earliest.min_day };
}
