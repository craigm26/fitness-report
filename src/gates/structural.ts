/**
 * Gate 1, structural. Does the generator produce task instances with the
 * property the run depends on? FREE: no model calls, no server calls.
 *
 * Ported from evalgate's `structural.py` with two additions demanded by
 * DESIGN decision 12: evalgate passes on n_generated = 5 of 200 requested,
 * because its `ok` only asks "did every admitted case hold". A generator that
 * admits 2.5% of what it was asked for has not been verified over anything,
 * so this port adds
 *
 *   * a minimum ADMISSION RATE (default 0.25), and
 *   * a minimum ABSOLUTE nGenerated (default 8, matching DESIGN decision 13's
 *     minimum suite size).
 *
 * IMPORTANT: passing is necessary and NOT sufficient. The source project's
 * TURN-1 passed this gate over 200 seeds and was still invalid, because the
 * property it verified was defined by a scorer nobody had checked against the
 * model. Run the construct gate too.
 */

/** Typed reason codes. Rendered verbatim in a refusal, so they never change wording. */
export type StructuralReason =
  | 'ok'
  | 'no_cases_generated'
  | 'property_violated'
  | 'too_few_generated'
  | 'admission_rate_below_minimum';

export interface StructuralFailure {
  seed: number;
  detail: string;
}

export interface StructuralOptions {
  /** seeds to try. Default 200. */
  n?: number;
  seedBase?: number;
  /** cap on retained failure examples. Default 10. */
  maxFailures?: number;
  /** NEW vs evalgate: minimum nGenerated / nRequested. Default 0.25. */
  minAdmissionRate?: number;
  /** NEW vs evalgate: minimum absolute nGenerated. Default 8 (decision 13). */
  minGenerated?: number;
}

export interface StructuralReport {
  nRequested: number;
  nGenerated: number;
  nHolding: number;
  admissionRate: number;
  holdRate: number;
  minAdmissionRate: number;
  minGenerated: number;
  failures: readonly StructuralFailure[];
  ok: boolean;
  reason: StructuralReason;
}

export const DEFAULT_MIN_ADMISSION_RATE = 0.25;
export const DEFAULT_MIN_GENERATED = 8;

/**
 * Generate `n` cases and check `holds` on each.
 *
 * makeCase -- seed -> case, or null/undefined when that seed yields nothing
 *             admissible. Throwing is recorded as a generator failure, not a
 *             crash.
 * holds    -- case -> boolean. Re-derive the property from the case's RENDERED
 *             content wherever possible, not from fields the generator set. A
 *             generator that records `answer: "B"` and a checker that reads
 *             `case.answer` verify nothing; they agree by construction.
 */
export function structural<C>(
  makeCase: (seed: number) => C | null | undefined,
  holds: (c: C) => boolean,
  opts: StructuralOptions = {},
): StructuralReport {
  const nRequested = opts.n ?? 200;
  const seedBase = opts.seedBase ?? 0;
  const maxFailures = opts.maxFailures ?? 10;
  const minAdmissionRate = opts.minAdmissionRate ?? DEFAULT_MIN_ADMISSION_RATE;
  const minGenerated = opts.minGenerated ?? DEFAULT_MIN_GENERATED;

  let nGenerated = 0;
  let nHolding = 0;
  const failures: StructuralFailure[] = [];
  const note = (seed: number, detail: string): void => {
    if (failures.length < maxFailures) failures.push({ seed, detail });
  };

  for (let i = 0; i < nRequested; i++) {
    const seed = seedBase + i;
    let made: C | null | undefined;
    try {
      made = makeCase(seed);
    } catch (e) {
      note(seed, `generator raised: ${describe(e)}`);
      continue;
    }
    if (made === null || made === undefined) continue;
    nGenerated += 1;
    let good: boolean;
    try {
      good = Boolean(holds(made));
    } catch (e) {
      good = false;
      note(seed, `predicate raised: ${describe(e)}`);
    }
    if (good) nHolding += 1;
    else note(seed, 'property does not hold');
  }

  const admissionRate = nRequested ? nGenerated / nRequested : 0;
  const holdRate = nGenerated ? nHolding / nGenerated : 0;

  let reason: StructuralReason;
  if (nGenerated === 0) reason = 'no_cases_generated';
  else if (nHolding !== nGenerated) reason = 'property_violated';
  else if (nGenerated < minGenerated) reason = 'too_few_generated';
  else if (admissionRate < minAdmissionRate) reason = 'admission_rate_below_minimum';
  else reason = 'ok';

  return {
    nRequested,
    nGenerated,
    nHolding,
    admissionRate,
    holdRate,
    minAdmissionRate,
    minGenerated,
    failures,
    ok: reason === 'ok',
    reason,
  };
}

/** Human readable refusal copy. No em-dashes: this text reaches the site. */
export function explainStructural(r: StructuralReport): string {
  switch (r.reason) {
    case 'no_cases_generated':
      return (
        `REJECT (no_cases_generated): the generator admitted 0 of ${r.nRequested} seeds. ` +
        'A 100% hold rate over an empty sample is vacuously true and verifies nothing.'
      );
    case 'property_violated':
      return (
        `REJECT (property_violated): ${r.nGenerated - r.nHolding} of ${r.nGenerated} admitted ` +
        'cases do not satisfy the property the run depends on.'
      );
    case 'too_few_generated':
      return (
        `REJECT (too_few_generated): ${r.nGenerated} admitted cases is below the minimum ` +
        `${r.minGenerated}. Every case held, over a sample too small to mean anything.`
      );
    case 'admission_rate_below_minimum':
      return (
        `REJECT (admission_rate_below_minimum): the generator admitted ` +
        `${r.nGenerated} of ${r.nRequested} seeds (${(r.admissionRate * 100).toFixed(1)}%), ` +
        `below the required ${(r.minAdmissionRate * 100).toFixed(0)}%. ` +
        'A generator that rejects most of its own seeds is selecting for something unstated.'
      );
    default:
      return (
        `OK: ${r.nHolding}/${r.nGenerated} admitted cases hold, ` +
        `admission rate ${(r.admissionRate * 100).toFixed(1)}%. ` +
        'Necessary, not sufficient: run the construct gate.'
      );
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
