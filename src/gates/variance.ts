/**
 * Gate 3, error variance. Does the suite produce anything to detect?
 *
 * Ported from evalgate's `variance.py`. A scored run needs failures. If the
 * agent is right every time under the condition actually being studied there
 * is no signal, and no amount of replication or statistical care creates one.
 * The source project paid for a full run before noticing 40 out of 40.
 *
 * RUN THIS ON THE REAL DRIVE, NOT THE REFERENCE CONTROL.
 * The construct gate asks whether a reference agent reaches the intended
 * answer given FULL information and a working server; it should score near
 * 1.0. This gate asks the opposite question about the condition being scored:
 * with the real server, the real tool descriptions and the real agent, does it
 * ever get it wrong? A score near 1.0 HERE means there is nothing to measure
 * and the leaderboard row would be a 100% that says nothing about the server.
 *
 * DOCUMENTED DIVERGENCE: evalgate's variance gate does NOT catch oracle
 * exceptions (only `truth` is wrapped), so one flaky remote call takes the
 * whole gate down with an unhandled rejection. This port catches both and
 * counts them, which matters because every server under test is remote.
 */

import type { WilsonInterval } from '../types.js';
import { mapLimit } from './construct.js';
import { wilson } from './stats.js';

/**
 * Typed reason codes, kept from evalgate's `explain()`. `at_ceiling` and
 * `at_floor` are the two that name real, distinct failures and they are
 * rendered verbatim in a refusal.
 */
export type VarianceReason =
  | 'ok'
  | 'no_cases'
  | 'at_ceiling'
  | 'at_floor'
  | 'below_min_error_rate';

export interface VarianceExample<C, A> {
  case: C;
  got: A;
  want: A;
}

export interface VarianceOptions<A> {
  /** floor, not a target. Default 0.05. */
  minErrorRate?: number;
  reps?: number;
  maxWorkers?: number;
  maxExamples?: number;
  equals?: (a: A, b: A) => boolean;
}

export interface VarianceReport<C, A> {
  /** comparisons that completed */
  n: number;
  nWrong: number;
  errorRate: number;
  minErrorRate: number;
  /** oracle rejections plus truth rejections. Excluded from n. */
  errors: number;
  oracleErrors: number;
  truthErrors: number;
  atCeiling: boolean;
  atFloor: boolean;
  /** interval on the ERROR rate, so a wide one is visible as wide */
  interval: WilsonInterval;
  examples: readonly VarianceExample<C, A>[];
  errorDetails: readonly string[];
  ok: boolean;
  reason: VarianceReason;
}

/**
 * Measure the error rate under the condition being scored.
 *
 * oracle -- case -> answer, WITH the real conditions applied. Not the
 *           full-information reference; that is the construct gate.
 */
export async function variance<C, A>(
  oracle: (c: C) => Promise<A> | A,
  cases: readonly C[],
  truth: (c: C) => Promise<A> | A,
  opts: VarianceOptions<A> = {},
): Promise<VarianceReport<C, A>> {
  const minErrorRate = opts.minErrorRate ?? 0.05;
  const reps = opts.reps ?? 1;
  const maxWorkers = opts.maxWorkers ?? 4;
  const maxExamples = opts.maxExamples ?? 10;
  const equals = opts.equals ?? defaultEquals;

  if (!Number.isInteger(reps) || reps < 1) throw new RangeError('variance: reps must be >= 1');

  const jobs: C[] = [];
  for (const c of cases) for (let r = 0; r < reps; r++) jobs.push(c);

  type Outcome = { case: C; got?: A; want?: A; oracleError?: unknown; truthError?: unknown };
  const got = await mapLimit<C, Outcome>(jobs, maxWorkers, async (c) => {
    let answer: A;
    try {
      // DIVERGENCE: evalgate lets this one propagate.
      answer = await oracle(c);
    } catch (e) {
      return { case: c, oracleError: e ?? new Error('oracle threw a falsy value') };
    }
    try {
      return { case: c, got: answer, want: await truth(c) };
    } catch (e) {
      return { case: c, truthError: e ?? new Error('truth threw a falsy value') };
    }
  });

  let n = 0;
  let nWrong = 0;
  let oracleErrors = 0;
  let truthErrors = 0;
  const examples: VarianceExample<C, A>[] = [];
  const errorDetails: string[] = [];

  for (const g of got) {
    if (g.oracleError !== undefined) {
      oracleErrors += 1;
      if (errorDetails.length < maxExamples) errorDetails.push(`oracle: ${describe(g.oracleError)}`);
      continue;
    }
    if (g.truthError !== undefined) {
      truthErrors += 1;
      if (errorDetails.length < maxExamples) errorDetails.push(`truth: ${describe(g.truthError)}`);
      continue;
    }
    n += 1;
    const answer = g.got as A;
    const want = g.want as A;
    if (!equals(answer, want)) {
      nWrong += 1;
      if (examples.length < maxExamples) examples.push({ case: g.case, got: answer, want });
    }
  }

  const errorRate = n ? nWrong / n : 0;
  const atCeiling = n > 0 && nWrong === 0;
  const atFloor = n > 0 && nWrong === n;

  let reason: VarianceReason;
  if (n === 0) reason = 'no_cases';
  else if (atFloor) reason = 'at_floor';
  else if (atCeiling) reason = 'at_ceiling';
  else if (errorRate < minErrorRate) reason = 'below_min_error_rate';
  else reason = 'ok';

  return {
    n,
    nWrong,
    errorRate,
    minErrorRate,
    errors: oracleErrors + truthErrors,
    oracleErrors,
    truthErrors,
    atCeiling,
    atFloor,
    interval: wilson(nWrong, n),
    examples,
    errorDetails,
    ok: reason === 'ok',
    reason,
  };
}

/** Human readable refusal copy, ported from evalgate's `explain()`. No em-dashes. */
export function explainVariance<C, A>(r: VarianceReport<C, A>): string {
  switch (r.reason) {
    case 'no_cases':
      return 'REJECT (no_cases): nothing completed, so there is no error rate to report.';
    case 'at_ceiling':
      return (
        'REJECT (at_ceiling): the agent was correct on every case. There are no failures ' +
        'to attribute, so the run cannot say anything about the server however many tasks ' +
        'you buy. A 100% here is a statement about the task suite, not the server.'
      );
    case 'at_floor':
      return (
        'REJECT (at_floor): the agent was wrong on every case. That is almost always a ' +
        'broken harness, a bad answer key or a dead server rather than a hard task suite. ' +
        'Check construct validity first.'
      );
    case 'below_min_error_rate':
      return (
        `REJECT (below_min_error_rate): error rate ${r.errorRate.toFixed(3)} is below the ` +
        `required ${r.minErrorRate}. There is too little signal to attribute failures to tools.`
      );
    default:
      return (
        `OK: error rate ${r.errorRate.toFixed(3)} on ${r.n} cases ` +
        `[${r.interval.low.toFixed(3)}, ${r.interval.high.toFixed(3)}], ` +
        `${r.errors} calls failed outright. There is variance to attribute.`
      );
  }
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
