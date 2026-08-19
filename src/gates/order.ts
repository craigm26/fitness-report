/**
 * Order invariance probe. Ported from `orderprobe.probe_call`.
 *
 * Permute the inputs, re-run, see whether the answer moves. An answer that
 * changes under reordering is substantially more likely to be wrong: on the
 * source project's pre-registered test (claude-opus-5, 48 episodes),
 * P(wrong | unstable) = 0.714 against P(wrong | stable) = 0.088, likelihood
 * ratio 8.1, Fisher one-sided p = 0.00003.
 *
 * LIMITS, which matter as much as the evidence:
 *   * validated on SYNTHETIC tasks on two models; real agent traffic untested
 *   * NOT CALIBRATED. No production threshold is licensed by those rates.
 *   * STABILITY IS NOT A GUARANTEE. 3 of 34 stable episodes were still wrong,
 *     two of them perfectly stable and confidently wrong.
 *   * costs k * samples calls per decision.
 *
 * For Fitness Report the ordered input is the TOOL LIST: does the agent pick
 * the same tool when tools/list comes back in a different order? A server
 * whose tool selection depends on list order has a description problem, and
 * that is a finding about the server rather than about the agent.
 *
 * NOT_APPLICABLE is reported rather than silently returning "stable", because
 * "we could not check" is not the same claim as "it is fine".
 */

import { mapLimit } from './construct.js';

export type OrderVerdict = 'stable' | 'unstable' | 'not_applicable';

export const ORDER_VERDICT = {
  STABLE: 'stable',
  UNSTABLE: 'unstable',
  /** fewer than two distinct orderings were possible, so the probe could not run */
  NOT_APPLICABLE: 'not_applicable',
} as const;

export interface OrderingRecord {
  /** permutation of input indices. The first entry is always the order passed in. */
  order: readonly number[];
  /** answer key -> count, serialized so the site never recomputes it */
  counts: Readonly<Record<string, number>>;
}

export interface OrderOptions<A> {
  /** orderings to try, capped at n factorial. Default 6. */
  k?: number;
  /** calls per ordering. Default 5. */
  samples?: number;
  seed?: number;
  /** maps a return value to a comparable key. Defaults to a JSON-stable string. */
  key?: (v: A) => string;
  /**
   * when given, `unstable` means dispersion > threshold. When omitted,
   * `unstable` means the modal answers of two orderings differ, which is the
   * definition the published evidence used.
   */
  threshold?: number | null;
  /** >1 runs orderings concurrently. `fn` must then be re-entrant. Default 1. */
  maxWorkers?: number;
}

export interface OrderResult<A> {
  /** the answer at the order actually passed in: the one that would have shipped */
  value: A | null;
  valueKey: string | null;
  verdict: OrderVerdict;
  /**
   * Maximum pairwise total variation between the answer distributions of any
   * two orderings. 0.0 = every ordering agreed exactly; 1.0 = two orderings
   * shared no answer at all.
   */
  dispersion: number;
  byOrdering: readonly OrderingRecord[];
  calls: number;
  /** calls that threw. Their orderings are excluded from the statistics. */
  errors: number;
  unstable: boolean;
  /** every distinct answer key seen, across all orderings */
  answers: readonly string[];
}

/**
 * Run `fn` over `k` orderings of `items`, `samples` times each.
 *
 * `fn` receives a reordered copy; `items` is never mutated.
 */
export async function orderInvariance<T, A>(
  fn: (items: readonly T[]) => Promise<A> | A,
  items: readonly T[],
  opts: OrderOptions<A> = {},
): Promise<OrderResult<A>> {
  const k = opts.k ?? 6;
  const samples = opts.samples ?? 5;
  const seed = opts.seed ?? 0;
  const threshold = opts.threshold ?? null;
  const maxWorkers = opts.maxWorkers ?? 1;
  const key = opts.key ?? defaultKey;

  if (!Number.isInteger(samples) || samples < 1) {
    throw new RangeError('orderInvariance: samples must be >= 1');
  }

  const orders = orderings(items.length, k, seed);

  interface Run {
    order: readonly number[];
    counts: Map<string, number>;
    first: Map<string, A>;
    calls: number;
    errors: number;
  }

  const runOne = async (order: readonly number[]): Promise<Run> => {
    const counts = new Map<string, number>();
    const first = new Map<string, A>();
    let calls = 0;
    let errors = 0;
    const arg = order.map((i) => items[i]);
    for (let s = 0; s < samples; s++) {
      calls += 1;
      try {
        const answer = await fn(arg);
        const kk = key(answer);
        counts.set(kk, (counts.get(kk) ?? 0) + 1);
        if (!first.has(kk)) first.set(kk, answer);
      } catch {
        errors += 1;
      }
    }
    return { order, counts, first, calls, errors };
  };

  const got: Run[] =
    maxWorkers > 1 && orders.length > 1
      ? await mapLimit(orders, maxWorkers, (o) => runOne(o))
      : await sequential(orders, runOne);

  const calls = got.reduce((a, r) => a + r.calls, 0);
  const errors = got.reduce((a, r) => a + r.errors, 0);
  const answered = got.filter((r) => r.counts.size > 0);

  const byOrdering: OrderingRecord[] = answered.map((r) => ({
    order: r.order,
    counts: Object.fromEntries(r.counts),
  }));
  const answers = [...new Set(answered.flatMap((r) => [...r.counts.keys()]))];

  if (answered.length === 0) {
    return {
      value: null,
      valueKey: null,
      verdict: ORDER_VERDICT.NOT_APPLICABLE,
      dispersion: 0,
      byOrdering: [],
      calls,
      errors,
      unstable: false,
      answers: [],
    };
  }

  const canonical = answered[0];
  const modalKey = modal(canonical.counts);
  const value = canonical.first.get(modalKey) ?? null;

  if (answered.length < 2) {
    return {
      value,
      valueKey: modalKey,
      verdict: ORDER_VERDICT.NOT_APPLICABLE,
      dispersion: 0,
      byOrdering,
      calls,
      errors,
      unstable: false,
      answers,
    };
  }

  let dispersion = 0;
  for (let i = 0; i < answered.length; i++) {
    for (let j = i + 1; j < answered.length; j++) {
      const tv = totalVariation(answered[i].counts, answered[j].counts);
      if (tv > dispersion) dispersion = tv;
    }
  }

  const unstable =
    threshold === null
      ? new Set(answered.map((r) => modal(r.counts))).size > 1
      : dispersion > threshold;

  return {
    value,
    valueKey: modalKey,
    verdict: unstable ? ORDER_VERDICT.UNSTABLE : ORDER_VERDICT.STABLE,
    dispersion,
    byOrdering,
    calls,
    errors,
    unstable,
    answers,
  };
}

/**
 * Canonical order first, then distinct pseudo-random permutations.
 *
 * CAPPED AT n FACTORIAL so a small input cannot request more distinct
 * orderings than exist. Asking for 6 orderings of 3 items would otherwise
 * either loop forever or silently repeat an ordering, and a repeated ordering
 * is a fake agreement.
 */
export function orderings(n: number, k: number, seed = 0): readonly number[][] {
  const canonical = Array.from({ length: n }, (_, i) => i);
  const total = factorial(n);
  if (n < 2 || k < 2 || total < 2) return [canonical];
  const want = Math.min(k, total);
  const rand = seededRandom(seed);

  if (total <= 5040) {
    // cheap to enumerate exactly (n <= 7)
    const pool = permutations(n).filter((p) => !isCanonical(p));
    shuffle(pool, rand);
    return [canonical, ...pool.slice(0, want - 1)];
  }
  const seen = new Set<string>([canonical.join(',')]);
  const out: number[][] = [canonical];
  let guard = 0;
  while (out.length < want && guard++ < want * 1000) {
    const p = canonical.slice();
    for (let i = p.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    const sig = p.join(',');
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(p);
    }
  }
  return out;
}

/** Total variation between two answer distributions. 0 = identical, 1 = disjoint. */
export function totalVariation(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  const na = sum(a);
  const nb = sum(b);
  if (!na || !nb) return 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  let acc = 0;
  for (const kk of keys) acc += Math.abs((a.get(kk) ?? 0) / na - (b.get(kk) ?? 0) / nb);
  return 0.5 * acc;
}

/**
 * Deterministic RNG (mulberry32). Seeded so a probe, a fixture and a plan are
 * all reproducible from the run record alone.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function sequential<T, R>(xs: readonly T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const x of xs) out.push(await fn(x));
  return out;
}

function modal(counts: ReadonlyMap<string, number>): string {
  let best = '';
  let bestN = -1;
  for (const [kk, v] of counts) {
    if (v > bestN) {
      best = kk;
      bestN = v;
    }
  }
  return best;
}

function sum(m: ReadonlyMap<string, number>): number {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) {
    f *= i;
    if (!Number.isFinite(f)) return Number.POSITIVE_INFINITY;
  }
  return f;
}

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const walk = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      walk();
      cur.pop();
      used[i] = false;
    }
  };
  walk();
  return out;
}

function isCanonical(p: readonly number[]): boolean {
  for (let i = 0; i < p.length; i++) if (p[i] !== i) return false;
  return true;
}

function shuffle<T>(xs: T[], rand: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
}

function defaultKey(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
