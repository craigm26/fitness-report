/**
 * Gate 2, construct validity. Does the AGENT share the suite's ground truth?
 * PAID: this is the gate that costs money and the only one that catches the
 * failure that matters most.
 *
 * Ported from evalgate's `construct.py`. Give a reference agent everything it
 * needs to reach the intended answer, with no manipulation and a working
 * server. If it does not reliably get there, the answer keys are not the thing
 * being measured, and no amount of replication fixes that.
 *
 * DOCUMENTED DIVERGENCE (DESIGN decision 12a). evalgate counts oracle
 * exceptions and then silently shrinks the denominator: 3 successes out of 3
 * completed calls reads as 100% even when 40 calls threw. That is wrong for
 * flaky remote MCP servers, which is every remote MCP server. Here errors are
 * gated on their own:
 *
 *     errors / (n + errors) > maxErrorRate  ->  ok: false, reason 'compromised'
 *                                               runOutcome 'COMPROMISED'
 *
 * A compromised gate is not a FAIL of the server under test. It is a refusal
 * to score, because the measurement itself did not complete.
 */

import type { Verdict } from '../types.js';
import { publishedVerdict, verdict, type PublishedVerdict } from './gates.js';

export type ConstructReason =
  | 'ok'
  | 'no_cases'
  | 'compromised'
  | 'under_resolved'
  | 'below_min_rate';

export interface ConstructDisagreement<C, A> {
  case: C;
  want: A;
  got: A;
}

export interface ConstructErrorExample<C> {
  case: C;
  detail: string;
}

export interface ConstructOptions<A> {
  /** required agreement rate. Default 0.90 (DESIGN decision 11). */
  minRate?: number;
  alpha?: number;
  /** repetitions per case. Default 3. */
  reps?: number;
  /** concurrency limit for oracle calls. Default 4. */
  maxWorkers?: number;
  /** cap on retained examples of each kind. Default 10. */
  maxExamples?: number;
  /** DIVERGENCE 12a: error fraction above which the gate is COMPROMISED. Default 0.05. */
  maxErrorRate?: number;
  /** answer comparison. Defaults to identity with a JSON fallback for objects. */
  equals?: (a: A, b: A) => boolean;
  /** detectable rate for the published-PASS rule. Defaults to minRate - 0.10. */
  detectableRate?: number;
}

export interface ConstructReport<C, A> {
  /** oracle calls that COMPLETED. Errors are not folded in here. */
  n: number;
  nIntended: number;
  rate: number;
  minRate: number;
  /** oracle calls that threw */
  errors: number;
  /** errors / (n + errors). The divergence-12a denominator. */
  errorRate: number;
  maxErrorRate: number;
  compromised: boolean;
  disagreements: readonly ConstructDisagreement<C, A>[];
  errorExamples: readonly ConstructErrorExample<C>[];
  /** three outcome rule over the completed calls. null when nothing completed. */
  verdict: Verdict | null;
  /** the same counts under the DESIGN 12b publication rule. */
  published: PublishedVerdict | null;
  ok: boolean;
  reason: ConstructReason;
  /** the run outcome a refusal should carry, per DESIGN decision 12a. */
  runOutcome: 'COMPROMISED' | null;
}

export const DEFAULT_MAX_ERROR_RATE = 0.05;

/**
 * Run `oracle` on each case `reps` times and compare against `truth`.
 *
 * oracle -- case -> answer, with FULL information and NO manipulation. This is
 *           the best case the design can produce. If it cannot reach the
 *           intended answer, nothing downstream can.
 * truth  -- case -> the answer the suite calls correct.
 *
 * Oracle rejections are caught and counted. `truth` is called locally and is
 * expected to be pure; if it throws, the gate refuses rather than guessing.
 */
export async function construct<C, A>(
  oracle: (c: C) => Promise<A> | A,
  cases: readonly C[],
  truth: (c: C) => Promise<A> | A,
  opts: ConstructOptions<A> = {},
): Promise<ConstructReport<C, A>> {
  const minRate = opts.minRate ?? 0.9;
  const alpha = opts.alpha ?? 0.05;
  const reps = opts.reps ?? 3;
  const maxWorkers = opts.maxWorkers ?? 4;
  const maxExamples = opts.maxExamples ?? 10;
  const maxErrorRate = opts.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const equals = opts.equals ?? defaultEquals;

  if (!Number.isInteger(reps) || reps < 1) throw new RangeError('construct: reps must be >= 1');

  // case-major job order, matching evalgate: [(c, r) for c in cases for r in range(reps)]
  const jobs: C[] = [];
  for (const c of cases) for (let r = 0; r < reps; r++) jobs.push(c);

  type Outcome = { case: C; answer?: A; error?: unknown };
  const got = await mapLimit<C, Outcome>(jobs, maxWorkers, async (c) => {
    try {
      return { case: c, answer: await oracle(c) };
    } catch (e) {
      return { case: c, error: e ?? new Error('oracle threw a falsy value') };
    }
  });

  let n = 0;
  let nIntended = 0;
  let errors = 0;
  const disagreements: ConstructDisagreement<C, A>[] = [];
  const errorExamples: ConstructErrorExample<C>[] = [];

  for (const g of got) {
    if (g.error !== undefined) {
      errors += 1;
      if (errorExamples.length < maxExamples) {
        errorExamples.push({ case: g.case, detail: describe(g.error) });
      }
      continue;
    }
    n += 1;
    const want = await truth(g.case);
    const answer = g.answer as A;
    if (equals(answer, want)) nIntended += 1;
    else if (disagreements.length < maxExamples) {
      disagreements.push({ case: g.case, want, got: answer });
    }
  }

  const attempted = n + errors;
  const errorRate = attempted ? errors / attempted : 0;
  const compromised = errorRate > maxErrorRate;
  const rateValue = n ? nIntended / n : 0;
  const v = n > 0 ? verdict(nIntended, n, minRate, alpha) : null;
  const pub =
    n > 0
      ? publishedVerdict(nIntended, n, minRate, {
          alpha,
          detectableRate: opts.detectableRate,
        })
      : null;

  let reason: ConstructReason;
  if (compromised) reason = 'compromised';
  else if (n === 0) reason = 'no_cases';
  else if (v!.outcome === 'PASS') reason = 'ok';
  else if (v!.outcome === 'EXTEND') reason = 'under_resolved';
  else reason = 'below_min_rate';

  return {
    n,
    nIntended,
    rate: rateValue,
    minRate,
    errors,
    errorRate,
    maxErrorRate,
    compromised,
    disagreements,
    errorExamples,
    verdict: v,
    published: pub,
    ok: reason === 'ok',
    reason,
    runOutcome: compromised ? 'COMPROMISED' : null,
  };
}

/** Human readable refusal copy. No em-dashes: this text reaches the site. */
export function explainConstruct<C, A>(r: ConstructReport<C, A>): string {
  switch (r.reason) {
    case 'compromised':
      return (
        `REFUSE (COMPROMISED): ${r.errors} of ${r.n + r.errors} reference calls failed ` +
        `(${(r.errorRate * 100).toFixed(1)}%, limit ${(r.maxErrorRate * 100).toFixed(0)}%). ` +
        'The measurement did not complete, so there is no score to report. This is a ' +
        'statement about the run, not a verdict on the server.'
      );
    case 'no_cases':
      return 'REFUSE (no_cases): every reference call failed or no cases were supplied.';
    case 'below_min_rate':
      return (
        `REJECT (below_min_rate): the reference agent reached the answer key ` +
        `${r.nIntended}/${r.n} = ${r.rate.toFixed(3)} against a required ${r.minRate}, ` +
        'and the exact binomial rejects the threshold. The answer keys are not the ' +
        'thing being measured.'
      );
    case 'under_resolved':
      return (
        `EXTEND (under_resolved): ${r.nIntended}/${r.n} = ${r.rate.toFixed(3)} is below ` +
        `${r.minRate} but the data cannot rule out clearing it ` +
        `(exact binomial p = ${r.verdict ? r.verdict.pValue.toFixed(3) : 'n/a'}). ` +
        'Run the pre-registered extension batch and re-apply the rule to the pooled counts.'
      );
    default:
      return (
        `OK: the reference agent reached the answer key ${r.nIntended}/${r.n} = ` +
        `${r.rate.toFixed(3)} with ${r.errors} failed calls.`
      );
  }
}

/**
 * Bounded-concurrency map that preserves input order and never rejects on
 * behalf of `fn` (wrap your own try/catch inside `fn`). Shared with the order
 * probe, which has the same "run one callable many times, politely" shape.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const total = items.length;
  const out = new Array<R>(total);
  if (total === 0) return out;
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function defaultEquals<A>(a: A, b: A): boolean {
  if (a === b) return true;
  if (Object.is(a, b)) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
