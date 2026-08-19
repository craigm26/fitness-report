/**
 * Canonical statistics for the Fitness Report validity gates.
 *
 * Ported from evalgate's `power.py` (wilson, _z, separate, tie_rate) and
 * foil's `stats.py` (percentile). THIS IS THE ONLY COPY. The site renders
 * serialized values out of the report JSON and never recomputes any of these:
 * the price table in the source project drifted twice because two copies of
 * one fact existed, and that is the failure this file exists to prevent.
 *
 * Every function here is pure, synchronous, dependency free and finite valued.
 * Per DESIGN decision 15 a metric is a finite number or it is absent, so the
 * degenerate cases return documented sentinels (`null` from `percentile` on an
 * empty sample) rather than NaN.
 */

import type { WilsonInterval } from '../types.js';

/** 95% two sided normal deviate. evalgate's default; kept for bit-compatibility. */
export const DEFAULT_Z = 1.96;

/**
 * Wilson score interval for a binomial rate.
 *
 * Rendered on the leaderboard AS AN INTERVAL, never as a point estimate:
 * overlapping intervals are indistinguishable and must not be ranked.
 *
 * `n === 0` returns the uninformative [0, 1] rather than throwing, matching
 * evalgate, because "no observations" is a legitimate report state.
 */
export function wilson(k: number, n: number, z: number = DEFAULT_Z): WilsonInterval {
  assertCount(k, 'k');
  assertCount(n, 'n');
  if (k > n) throw new RangeError(`wilson: k (${k}) cannot exceed n (${n})`);
  if (n === 0) return { rate: 0, low: 0, high: 1, k: 0, n: 0 };
  const p = k / n;
  const zz = z * z;
  const d = 1 + zz / n;
  const centre = (p + zz / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + zz / (4 * n * n))) / d;
  return {
    rate: p,
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
    k,
    n,
  };
}

/**
 * Standard normal quantile. Acklam's rational approximation, relative error
 * ~1.15e-9, which is four orders of magnitude tighter than anything a gate
 * decision here is sensitive to.
 */
export function normalQuantile(q: number): number {
  if (!(q > 0 && q < 1)) throw new RangeError('normalQuantile: q must be in (0, 1)');
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (q < pLow) {
    const u = Math.sqrt(-2 * Math.log(q));
    return (
      (((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1)
    );
  }
  if (q > pHigh) {
    const u = Math.sqrt(-2 * Math.log(1 - q));
    return (
      -(((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1)
    );
  }
  const u = q - 0.5;
  const t = u * u;
  return (
    ((((((a[0] * t + a[1]) * t + a[2]) * t + a[3]) * t + a[4]) * t + a[5]) * u) /
    (((((b[0] * t + b[1]) * t + b[2]) * t + b[3]) * t + b[4]) * t + 1)
  );
}

/**
 * Units PER GROUP needed for a two sided two proportion test to separate two
 * rates. The resolution planner that has to run BEFORE two servers are
 * compared, not after: at n = 12 the intervals are ~0.25 wide and every pair
 * of servers is indistinguishable.
 *
 *     separate(0.42, 0.58) -> 153 tasks per server
 */
export function separate(p1: number, p2: number, alpha = 0.05, power = 0.8): number {
  if (!(p1 > 0 && p1 < 1) || !(p2 > 0 && p2 < 1) || p1 === p2) {
    throw new RangeError('separate: need distinct rates strictly inside (0, 1)');
  }
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const pbar = (p1 + p2) / 2;
  const num =
    (za * Math.sqrt(2 * pbar * (1 - pbar)) +
      zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) **
    2;
  return Math.ceil(num / (p1 - p2) ** 2);
}

/**
 * P(two conditions give identical per unit rates) under the null.
 *
 * The cheapest thing to check and the number that killed the source project's
 * TURN-1: with a binary outcome and few replicates most units tie, and any
 * test that discards ties throws that fraction of the sample away.
 */
export function tieRate(base: number, reps: number): number {
  if (!(base >= 0 && base <= 1)) throw new RangeError('tieRate: base must be in [0, 1]');
  assertCount(reps, 'reps');
  let total = 0;
  for (let k = 0; k <= reps; k++) {
    const p = comb(reps, k) * base ** k * (1 - base) ** (reps - k);
    total += p * p;
  }
  return total;
}

/**
 * Exact binomial coefficient by iterative product. Never `n!/(k!(n-k)!)`:
 * the factorials overflow 53 bits long before the coefficient does.
 * Exact while the result stays under 2^53.
 */
export function comb(n: number, k: number): number {
  assertCount(n, 'n');
  if (k < 0 || k > n) return 0;
  const m = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= m; i++) r = (r * (n - m + i)) / i;
  return r;
}

/**
 * Nearest rank percentile over the full array, NaN dropped, `null` when there
 * is nothing to summarise. Ported from foil/stats.py; `null` is load bearing,
 * because the null baseline rule reads it as INDETERMINATE rather than
 * silently treating "no measurement" as zero.
 */
export function percentile(values: readonly number[], p: number): number | null {
  const vs = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (vs.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * vs.length));
  return vs[Math.min(rank, vs.length) - 1];
}

/** Mean of a finite sample, `null` when empty (never NaN, per decision 15). */
export function mean(values: readonly number[]): number | null {
  const vs = values.filter((v) => Number.isFinite(v));
  if (vs.length === 0) return null;
  return vs.reduce((a, b) => a + b, 0) / vs.length;
}

function assertCount(v: number, name: string): void {
  if (!Number.isInteger(v) || v < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
  }
}
