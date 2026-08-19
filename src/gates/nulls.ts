/**
 * The null baseline gate. CHEAP tier (DESIGN decision 11): the null models run
 * before the paid construct gate and before the full drive.
 *
 * The rule is ported verbatim from foil's `nulls.py` `_verdict` (PREREGISTRATION
 * §5.1 plus post-hoc amendment A6):
 *
 *     let T_null   = the noise floor  (best null model's success rate)
 *     let T_ablate = the signal       (the real agent's success rate)
 *
 *     T_null is None or T_ablate is None  ->  INDETERMINATE
 *     T_ablate == 0                       ->  INDETERMINATE
 *     T_null >= 0.5 * T_ablate            ->  KILL
 *     otherwise                           ->  PROCEED
 *
 * The zero-signal case is relabelled rather than reported as KILL: the literal
 * rule returns KILL there because `T_null >= 0` always holds, but "the
 * measurement is degenerate" is a different finding from "noise exceeds
 * signal", and conflating them misreports the reason a run stopped.
 *
 * INDETERMINATE DOES NOT PERMIT PROCEEDING. It halts exactly as KILL does; it
 * names the cause honestly. This is deliberately not a loosening of the gate:
 * the set of outcomes that allow the paid tier to begin is unchanged.
 *
 * MCP framing of the three null models (DESIGN decision 11):
 *   no-tools           the runner model answers with no MCP tools at all
 *   stubbed-empty      every tool call returns an empty successful result
 *   random-valid-args  tools are called with schema-valid nonsense arguments
 * A task suite any of those can pass is not measuring the server.
 */

import { percentile } from './stats.js';

export type NullOutcome = 'KILL' | 'PROCEED' | 'INDETERMINATE';

export type NullReason =
  | 'ok'
  | 'noise_exceeds_signal'
  | 'degenerate_no_signal'
  | 'no_measurements';

/** The §5.1 kill rule, verbatim. `ratio` defaults to the pre-registered 0.5. */
export function nullVerdict(
  tNull: number | null | undefined,
  tAblate: number | null | undefined,
  ratio = 0.5,
): NullOutcome {
  if (!Number.isFinite(tNull as number) || !Number.isFinite(tAblate as number)) {
    return 'INDETERMINATE';
  }
  if (tAblate === 0) return 'INDETERMINATE';
  return (tNull as number) >= ratio * (tAblate as number) ? 'KILL' : 'PROCEED';
}

/** INDETERMINATE halts exactly like KILL. Only PROCEED continues. */
export function halts(outcome: NullOutcome): boolean {
  return outcome !== 'PROCEED';
}

export interface NullBaseline {
  /** 'no-tools' | 'stubbed-empty' | 'random-valid-args' | any other null model */
  label: string;
  /** tasks the null model passed */
  k: number;
  n: number;
}

export interface NullBaselineRate extends NullBaseline {
  rate: number;
}

export interface NullBaselineInput {
  /** the real agent driving the real server */
  signal: { k: number; n: number };
  nulls: readonly NullBaseline[];
  /** percentile of the null rates taken as the noise floor. nulls.py uses 95. */
  percentile?: number;
  /** kill-rule ratio. nulls.py §5.1 fixes this at 0.5. */
  ratio?: number;
}

export interface NullBaselineReport {
  /** noise floor: the requested percentile over the null model rates */
  tNull: number | null;
  /** signal: the real agent's success rate */
  tAblate: number | null;
  killThreshold: number | null;
  outcome: NullOutcome;
  /** true unless PROCEED. INDETERMINATE halts exactly like KILL. */
  halts: boolean;
  ok: boolean;
  reason: NullReason;
  rates: readonly NullBaselineRate[];
  percentile: number;
  ratio: number;
}

/**
 * Apply the kill rule to measured null baselines. Pure and synchronous: the
 * runner does the measuring, this decides. That keeps the rule testable with
 * no network and no key.
 */
export function nullBaselineGate(input: NullBaselineInput): NullBaselineReport {
  const pct = input.percentile ?? 95;
  const ratio = input.ratio ?? 0.5;

  const rates: NullBaselineRate[] = input.nulls.map((b) => {
    if (!Number.isInteger(b.k) || !Number.isInteger(b.n) || b.k < 0 || b.n < 0 || b.k > b.n) {
      throw new RangeError(`nullBaselineGate: bad counts for ${b.label}: ${b.k}/${b.n}`);
    }
    return { ...b, rate: b.n ? b.k / b.n : Number.NaN };
  });

  const usable = rates.filter((r) => Number.isFinite(r.rate)).map((r) => r.rate);
  const tNull = percentile(usable, pct);
  const { k, n } = input.signal;
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(`nullBaselineGate: bad signal counts ${k}/${n}`);
  }
  const tAblate = n ? k / n : null;
  const outcome = nullVerdict(tNull, tAblate, ratio);

  let reason: NullReason;
  if (outcome === 'PROCEED') reason = 'ok';
  else if (outcome === 'KILL') reason = 'noise_exceeds_signal';
  else if (tNull === null || tAblate === null) reason = 'no_measurements';
  else reason = 'degenerate_no_signal';

  return {
    tNull,
    tAblate,
    killThreshold: tAblate === null ? null : ratio * tAblate,
    outcome,
    halts: halts(outcome),
    ok: outcome === 'PROCEED',
    reason,
    rates,
    percentile: pct,
    ratio,
  };
}

/** Human readable refusal copy. No em-dashes: this text reaches the site. */
export function explainNulls(r: NullBaselineReport): string {
  switch (r.reason) {
    case 'noise_exceeds_signal': {
      const worst = [...r.rates].sort((a, b) => b.rate - a.rate)[0];
      return (
        `KILL (noise_exceeds_signal): a null model passed ${(r.tNull ?? 0).toFixed(3)} of the ` +
        `suite against the real agent's ${(r.tAblate ?? 0).toFixed(3)}, at or above the ` +
        `${r.ratio} kill threshold of ${(r.killThreshold ?? 0).toFixed(3)}` +
        (worst ? ` (worst offender: ${worst.label} at ${worst.rate.toFixed(3)})` : '') +
        '. The suite is measuring the model, not the server.'
      );
    }
    case 'degenerate_no_signal':
      return (
        'INDETERMINATE (degenerate_no_signal): the real agent passed nothing, so there is ' +
        'no signal for the noise floor to be compared against. This halts exactly like ' +
        'KILL. It is a different finding from "noise exceeds signal" and is reported as one.'
      );
    case 'no_measurements':
      return (
        'INDETERMINATE (no_measurements): a required baseline was not measured. This halts ' +
        'exactly like KILL; a missing measurement is never read as a zero.'
      );
    default:
      return (
        `OK: noise floor ${(r.tNull ?? 0).toFixed(3)} is below the ${r.ratio} kill threshold ` +
        `of ${(r.killThreshold ?? 0).toFixed(3)} against signal ${(r.tAblate ?? 0).toFixed(3)}.`
      );
  }
}
