import type { MmpPoint } from "./mmp.js";

export interface CriticalPowerEstimate {
  cp_watts: number;
  w_prime_j: number;
  r_squared: number;
  eftp_watts: number;
}

const CP_MIN_DURATION_S = 120;
const CP_MAX_DURATION_S = 1200;

/**
 * 2-parameter Critical Power & W' estimation via linear regression on
 * Total Work W(d) = W' + CP * d over available MMP points in [120s, 1200s].
 */
export function estimateCriticalPower(peaks: readonly MmpPoint[]): CriticalPowerEstimate | null {
  const pts = peaks
    .filter(
      (p) => p.duration_s >= CP_MIN_DURATION_S && p.duration_s <= CP_MAX_DURATION_S && p.watts > 0
    )
    .map((p) => ({ d: p.duration_s, w: p.watts * p.duration_s }));

  if (pts.length < 3) return null;

  const n = pts.length;
  let sumX = 0;
  let sumY = 0;
  for (const p of pts) {
    sumX += p.d;
    sumY += p.w;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let ssXX = 0;
  let ssXY = 0;
  let ssYY = 0;
  for (const p of pts) {
    const dx = p.d - meanX;
    const dy = p.w - meanY;
    ssXX += dx * dx;
    ssXY += dx * dy;
    ssYY += dy * dy;
  }
  if (ssXX <= 0 || ssYY <= 0) return null;

  const cp = ssXY / ssXX;
  const wPrime = meanY - cp * meanX;
  const rSquared = (ssXY * ssXY) / (ssXX * ssYY);

  if (cp <= 50 || wPrime < 2000 || rSquared < 0.95) {
    return null;
  }

  const mmp20 = peaks.find((p) => p.duration_s === 1200);
  const eftp = mmp20 ? Math.round(mmp20.watts * 0.95) : Math.round(cp);

  return {
    cp_watts: Math.round(cp),
    w_prime_j: Math.round(wPrime),
    r_squared: Number(rSquared.toFixed(4)),
    eftp_watts: eftp,
  };
}
