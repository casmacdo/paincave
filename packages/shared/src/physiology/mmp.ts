export const MMP_DURATIONS = [5, 15, 30, 60, 120, 300, 480, 720, 1200, 1800, 3600] as const;

export type MmpDuration = (typeof MMP_DURATIONS)[number];

export interface MmpPoint {
  duration_s: MmpDuration;
  watts: number;
  w_per_kg: number | null;
}

/**
 * Computes Mean Maximal Power (MMP) across all standard durations using O(N) prefix sums.
 * Handles 14,400+ samples (4+ hour rides) in < 1ms.
 */
export function computeMmpCurve(
  powerSeries: readonly number[],
  weightKg?: number | null
): MmpPoint[] {
  const n = powerSeries.length;
  if (n === 0) return [];

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const w = powerSeries[i] ?? 0;
    prefix[i + 1] = (prefix[i] ?? 0) + (w > 0 ? w : 0);
  }

  const validWeight = weightKg !== undefined && weightKg !== null && weightKg > 0 ? weightKg : null;
  const peaks: MmpPoint[] = [];

  for (const duration of MMP_DURATIONS) {
    if (duration > n) continue;
    let maxSum = 0;
    for (let i = 0; i <= n - duration; i++) {
      const sum = (prefix[i + duration] ?? 0) - (prefix[i] ?? 0);
      if (sum > maxSum) {
        maxSum = sum;
      }
    }
    const watts = Math.round(maxSum / duration);
    peaks.push({
      duration_s: duration,
      watts,
      w_per_kg: validWeight !== null ? Number((watts / validWeight).toFixed(2)) : null,
    });
  }

  return peaks;
}
