/**
 * The three outcome gate rule, its exact binomial, and the sizing planner.
 *
 * Ported verbatim from evalgate's `gates.py`. The rule exists because a
 * threshold compared against a point estimate at small n is a coin flip
 * dressed as a rule: the source project's construct gate failed 32/36 against
 * 0.90, one run from passing, with a Wilson interval straddling the threshold.
 *
 *     PASS    observed rate >= threshold
 *     FAIL    an exact binomial test rejects H0: p >= threshold at alpha
 *     EXTEND  neither. The point estimate is below threshold but the data
 *             cannot rule out being above it. Run the pre-registered extension
 *             batch and re-apply the rule to the POOLED counts.
 *
 * EXTEND is not a loophole. `extensionSize` and `maxExtensions` are persisted
 * in the run record BEFORE the first call (DESIGN decision 11), and after the
 * last extension an unresolved gate resolves to FAIL.
 *
 * DOCUMENTED DIVERGENCE (DESIGN decision 12b): `publishedVerdict` adds one
 * asymmetry evalgate does not have. A leaderboard PASS additionally requires
 * the Wilson 95% lower bound to clear the threshold OR the run to have been
 * sized at the planned n. Otherwise the PASS downgrades to EXTEND. FAIL needs
 * statistical evidence, and once a PASS is publishable as a ranking claim it
 * should need evidence too. We own this divergence publicly in METHODS copy.
 */

import type { GateOutcome, Verdict } from '../types.js';
import { wilson, DEFAULT_Z } from './stats.js';

/**
 * Cumulative binomial P(X <= k) for every k in 0..kMax, in one pass.
 *
 * Terms are built by iterative product, never `comb(n, i) * p**i * q**(n-i)`
 * with a naive `comb`: the factorials in a naive coefficient overflow 53 bits
 * at n = 21 while the coefficient itself is still exact. The recursion
 *
 *     term(0) = q^n,   term(i) = term(i-1) * (n-i+1)/i * p/q
 *
 * is exact for dyadic p (binomCdf(4, 10, 0.5) returns 0.376953125 bit for bit)
 * and cheap. When q^n underflows to zero (large n with p near 1) the pass
 * falls back to log space, which is inexact but is the only path where the
 * direct recursion would silently return 0 for everything.
 */
function binomCdfSeries(n: number, p: number, kMax: number): Float64Array {
  const out = new Float64Array(kMax + 1);
  if (p >= 1) {
    for (let i = 0; i <= kMax; i++) out[i] = i >= n ? 1 : 0;
    return out;
  }
  if (p <= 0) {
    out.fill(1);
    return out;
  }
  const q = 1 - p;
  const logQ = Math.log1p(-p);
  let acc = 0;
  if (n * logQ > -700) {
    let term = powi(q, n);
    const ratio = p / q;
    for (let i = 0; i <= kMax; i++) {
      if (i > 0) term = term * ((n - i + 1) / i) * ratio;
      acc += term;
      out[i] = acc < 1 ? acc : 1;
    }
    return out;
  }
  // Underflow fallback: accumulate each term through its logarithm.
  const logP = Math.log(p);
  let logC = 0; // log C(n, 0)
  for (let i = 0; i <= kMax; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    acc += Math.exp(logC + i * logP + (n - i) * logQ);
    out[i] = acc < 1 ? acc : 1;
  }
  return out;
}

/** Integer power by binary exponentiation. Exact for dyadic bases. */
function powi(base: number, exp: number): number {
  let result = 1;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e & 1) result *= b;
    e >>= 1;
    if (e > 0) b *= b;
  }
  return result;
}

/** P(X <= k) for X ~ Binomial(n, p). Exact, no dependencies. */
export function binomCdf(k: number, n: number, p: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`binomCdf: n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(k)) throw new RangeError(`binomCdf: k must be an integer, got ${k}`);
  if (!(p >= 0 && p <= 1)) throw new RangeError(`binomCdf: p must be in [0, 1], got ${p}`);
  if (k < 0) return 0;
  if (k >= n) return 1;
  return binomCdfSeries(n, p, k)[k];
}

/** Observed rate for a verdict. `0` at n = 0, matching evalgate. */
export function rate(v: Pick<Verdict, 'k' | 'n'>): number {
  return v.n ? v.k / v.n : 0;
}

/**
 * Apply the three outcome rule to observed counts.
 *
 * FAIL requires statistical evidence, not a near miss: the exact binomial test
 * must reject H0: p >= threshold. A point estimate below threshold without
 * that evidence is EXTEND.
 */
export function verdict(k: number, n: number, threshold: number, alpha = 0.05): Verdict {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('verdict: n must be a positive integer');
  if (!Number.isInteger(k) || k < 0 || k > n) throw new RangeError(`verdict: k must be an integer in [0, ${n}], got ${k}`);
  if (!(threshold > 0 && threshold <= 1)) throw new RangeError('verdict: threshold must be in (0, 1]');
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('verdict: alpha must be in (0, 1)');
  const pValue = binomCdf(k, n, threshold);
  let outcome: GateOutcome;
  if (k / n >= threshold) outcome = 'PASS';
  else if (pValue < alpha) outcome = 'FAIL';
  else outcome = 'EXTEND';
  return { outcome, k, n, threshold, alpha, pValue };
}

/** A pre-registered gate size, with the power it actually achieves. */
export interface GateDesign {
  n: number;
  threshold: number;
  alpha: number;
  /** true rate the design is powered to FAIL */
  detectableRate: number;
  /** P(FAIL) when the true rate is `detectableRate` */
  power: number;
  /** largest k that still FAILs at this n */
  failAtOrBelow: number;
}

/**
 * Smallest n at which a true rate of `detectableRate` FAILs with the requested
 * probability. Run this BEFORE pre-registering the gate. If the n it returns
 * is more than the run will pay for, that is a fact about the decision the run
 * is able to make, and the pre-registration should say so.
 *
 *     plan(0.90, 0.80) -> n = 78. The gate this ports ran 36.
 */
export function plan(
  threshold: number,
  detectableRate: number,
  alpha = 0.05,
  power = 0.8,
  maxN = 2000,
): GateDesign {
  if (!(detectableRate > 0 && detectableRate < threshold && threshold <= 1)) {
    throw new RangeError('plan: need 0 < detectableRate < threshold <= 1');
  }
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('plan: alpha must be in (0, 1)');
  if (!(power > 0 && power < 1)) throw new RangeError('plan: power must be in (0, 1)');
  for (let n = 5; n <= maxN; n++) {
    // largest k with binomCdf(k; n, threshold) < alpha. The series is computed
    // in one pass and is bit identical to calling binomCdf per k, because it
    // is the same accumulation in the same order.
    const series = binomCdfSeries(n, threshold, n - 1);
    let crit = -1;
    for (let k = 0; k < n; k++) {
      if (series[k] < alpha) crit = k;
      else break;
    }
    if (crit < 0) continue;
    const achieved = binomCdf(crit, n, detectableRate);
    if (achieved >= power) {
      return { n, threshold, alpha, detectableRate, power: achieved, failAtOrBelow: crit };
    }
  }
  throw new RangeError(`plan: no n <= ${maxN} achieves power ${power}`);
}

/**
 * The power a gate of exactly `n` trials achieves against `detectableRate`.
 *
 * Exact-binomial power is SAWTOOTHED in n, so "n >= plan(...).n" is not the
 * same claim as "this run was sized to resolve it": plan(0.90, 0.80) returns 78
 * (power 0.808) while n = 80 achieves only 0.753 and n = 87 only 0.778. A run
 * at n = 80 that leans on the sizing claim is publishing a PASS from a gate
 * that detects the rate it was supposed to detect three times in four.
 *
 * Returns 0 when no k rejects H0 at this n (the gate cannot FAIL at all).
 */
export function achievedPower(
  n: number,
  threshold: number,
  detectableRate: number,
  alpha = 0.05,
): number {
  if (!Number.isInteger(n) || n <= 0) return 0;
  const series = binomCdfSeries(n, threshold, n - 1);
  let crit = -1;
  for (let k = 0; k < n; k++) {
    if (series[k] < alpha) crit = k;
    else break;
  }
  if (crit < 0) return 0;
  return binomCdf(crit, n, detectableRate);
}

const planCache = new Map<string, GateDesign>();

/** Memoized `plan`. The search is O(maxN^2) and `publishedVerdict` calls it per verdict. */
export function planCached(
  threshold: number,
  detectableRate: number,
  alpha = 0.05,
  power = 0.8,
  maxN = 2000,
): GateDesign {
  const key = `${threshold}|${detectableRate}|${alpha}|${power}|${maxN}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const design = plan(threshold, detectableRate, alpha, power, maxN);
  planCache.set(key, design);
  return design;
}

export type PublishedReason =
  | 'ok'
  | 'downgraded_underpowered'
  | 'failed'
  | 'under_resolved';

/**
 * A verdict plus the DESIGN decision 12b publication rule. `outcome` is what
 * the leaderboard renders; `rawOutcome` is what evalgate's rule alone said.
 */
export interface PublishedVerdict extends Verdict {
  /** the evalgate three outcome verdict, before the publication rule */
  rawOutcome: GateOutcome;
  /** true when a raw PASS was downgraded to EXTEND for lack of resolution */
  downgraded: boolean;
  wilsonLow: number;
  wilsonHigh: number;
  /** n the design would have needed to resolve threshold vs detectableRate */
  requiredN: number;
  /** power this run's ACTUAL n achieves against detectableRate (sawtoothed in n) */
  achievedPower: number;
  detectableRate: number;
  reason: PublishedReason;
}

export interface PublishedVerdictOptions {
  alpha?: number;
  /** the true rate the gate must be able to FAIL. Defaults to threshold - 0.10. */
  detectableRate?: number;
  power?: number;
  maxN?: number;
  z?: number;
}

/**
 * DIVERGENCE FROM evalgate (DESIGN decision 12b).
 *
 * A published PASS is a ranking claim, so it carries the same evidential
 * burden FAIL does. A raw PASS survives only if
 *
 *     Wilson 95% lower bound >= threshold      (this run resolved it), OR
 *     achievedPower(n, ...) >= power           (this run was sized to resolve it)
 *
 * Otherwise it downgrades to EXTEND: buy more information. Under this rule
 * 33/36 at threshold 0.90 is NOT publishable (Wilson low 0.782, n 36 < 78),
 * which is exactly the near miss that motivated the whole module in reverse.
 */
export function publishedVerdict(
  k: number,
  n: number,
  threshold: number,
  opts: PublishedVerdictOptions = {},
): PublishedVerdict {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const maxN = opts.maxN ?? 2000;
  const z = opts.z ?? DEFAULT_Z;
  const detectableRate = opts.detectableRate ?? defaultDetectable(threshold);
  const base = verdict(k, n, threshold, alpha);
  const w = wilson(k, n, z);
  const design = planCached(threshold, detectableRate, alpha, power, maxN);
  const resolved = w.low >= threshold;
  // "Sized to resolve it" is a claim about THIS n, not about the smallest n
  // that qualified. Power is sawtoothed, so n > plan().n can still fall short
  // (n = 80 achieves 0.753 against a requested 0.80).
  const sized = achievedPower(n, threshold, detectableRate, alpha) >= power;

  let outcome: GateOutcome = base.outcome;
  let downgraded = false;
  let reason: PublishedReason;
  if (base.outcome === 'PASS' && !resolved && !sized) {
    outcome = 'EXTEND';
    downgraded = true;
    reason = 'downgraded_underpowered';
  } else if (base.outcome === 'PASS') {
    reason = 'ok';
  } else if (base.outcome === 'FAIL') {
    reason = 'failed';
  } else {
    reason = 'under_resolved';
  }

  return {
    ...base,
    outcome,
    rawOutcome: base.outcome,
    downgraded,
    wilsonLow: w.low,
    wilsonHigh: w.high,
    requiredN: design.n,
    achievedPower: achievedPower(n, threshold, detectableRate, alpha),
    detectableRate,
    reason,
  };
}

/** threshold - 0.10, clamped strictly inside (0, threshold). plan(0.90, 0.80). */
export function defaultDetectable(threshold: number): number {
  const d = threshold - 0.1;
  if (d > 0) return d;
  return threshold / 2;
}
