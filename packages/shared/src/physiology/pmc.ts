export interface DailyTssInput {
  day: string; // YYYY-MM-DD
  total_tss: number;
}

export interface DailyPmcPoint {
  day: string;
  total_tss: number;
  ctl: number;
  atl: number;
  tsb: number;
  ramp_rate_7d: number;
}

const CTL_TAU = 42;
const ATL_TAU = 7;

function parseDayUtc(day: string): Date {
  const parts = day.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) {
    throw new Error(`Invalid day format '${day}'; expected YYYY-MM-DD`);
  }
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDayUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function enumerateDays(startDay: string, endDay: string): string[] {
  const start = parseDayUtc(startDay);
  const end = parseDayUtc(endDay);
  if (end < start) return [];

  const days: string[] = [];
  const cur = new Date(start.getTime());
  while (cur <= end) {
    days.push(formatDayUtc(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/**
 * Computes continuous daily PMC (CTL/ATL/TSB/ramp_rate_7d) filling zero-TSS rest days.
 * TSB on day k reflects pre-ride freshness (CTL_{k-1} - ATL_{k-1}).
 */
export function computeDailyPmc(
  inputs: readonly DailyTssInput[],
  options?: {
    startDay?: string;
    endDay?: string;
    initialCtl?: number;
    initialAtl?: number;
    priorCtlWindow?: readonly number[];
  }
): DailyPmcPoint[] {
  const tssByDay = new Map<string, number>();
  for (const row of inputs) {
    tssByDay.set(row.day, (tssByDay.get(row.day) ?? 0) + Math.max(0, row.total_tss));
  }

  const sortedDays = [...tssByDay.keys()].sort();
  const startDay = options?.startDay ?? sortedDays[0];
  const endDay = options?.endDay ?? sortedDays[sortedDays.length - 1];
  if (!startDay || !endDay) return [];

  const allDays = enumerateDays(startDay, endDay);
  let ctl = options?.initialCtl ?? 0;
  let atl = options?.initialAtl ?? 0;
  const ctlHistory: number[] = [...(options?.priorCtlWindow ?? [])];
  const out: DailyPmcPoint[] = [];

  for (const day of allDays) {
    const tss = tssByDay.get(day) ?? 0;
    const tsb = ctl - atl;
    ctl = ctl + (tss - ctl) / CTL_TAU;
    atl = atl + (tss - atl) / ATL_TAU;
    ctlHistory.push(ctl);

    const sevenDaysAgoIdx = ctlHistory.length - 8;
    const prev7Ctl =
      sevenDaysAgoIdx >= 0 ? (ctlHistory[sevenDaysAgoIdx] ?? 0) : (options?.initialCtl ?? 0);
    const rampRate7d = ctl - prev7Ctl;

    out.push({
      day,
      total_tss: Number(tss.toFixed(1)),
      ctl: Number(ctl.toFixed(2)),
      atl: Number(atl.toFixed(2)),
      tsb: Number(tsb.toFixed(2)),
      ramp_rate_7d: Number(rampRate7d.toFixed(2)),
    });
  }

  return out;
}
