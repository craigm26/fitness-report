/**
 * Gate math and gate wiring.
 *
 * Every golden vector in DESIGN.md is asserted here verbatim. They are the
 * port's proof of correctness against the Python original; if one of them
 * changes, the port has diverged from evalgate somewhere undocumented and the
 * published METHODS copy is wrong.
 *
 * No network, no API key, no clock. Every oracle is a local function.
 */

import { describe, expect, it } from 'vitest';

import {
  binomCdf,
  defaultDetectable,
  plan,
  planCached,
  achievedPower,
  publishedVerdict,
  rate,
  verdict,
} from '../src/gates/gates.js';
import { comb, mean, normalQuantile, percentile, separate, tieRate, wilson } from '../src/gates/stats.js';
import { explainStructural, structural } from '../src/gates/structural.js';
import { construct, mapLimit } from '../src/gates/construct.js';
import { explainVariance, variance } from '../src/gates/variance.js';
import { halts, nullBaselineGate, nullVerdict } from '../src/gates/nulls.js';
import { orderInvariance, orderings, seededRandom } from '../src/gates/order.js';
import {
  answerLeaks,
  audit,
  defaultFullCheck,
  defaultStructuralCheck,
  FIXTURES,
  get,
  names,
  simulatedExperimentalOracle,
  simulatedNullOracle,
  simulatedOracle,
  structurallySound,
  truth,
  type FixtureCase,
} from '../src/gates/fixtures.js';

// ---------------------------------------------------------------------------
// binomCdf
// ---------------------------------------------------------------------------

describe('binomCdf', () => {
  it('GOLDEN: binomCdf(4, 10, 0.5) is 0.376953125 exactly', () => {
    // 386/1024. The iterative-product recursion is exact for dyadic p, so this
    // is a bit-for-bit equality and not an approximation.
    expect(binomCdf(4, 10, 0.5)).toBe(0.376953125);
  });

  it('is exact at the edges', () => {
    expect(binomCdf(-1, 10, 0.5)).toBe(0);
    expect(binomCdf(10, 10, 0.5)).toBe(1);
    expect(binomCdf(11, 10, 0.5)).toBe(1);
  });

  it('is monotone in k', () => {
    const vals = Array.from({ length: 21 }, (_, k) => binomCdf(k, 20, 0.7));
    expect(vals).toEqual([...vals].sort((a, b) => a - b));
  });

  it('handles degenerate p without NaN', () => {
    expect(binomCdf(0, 10, 0)).toBe(1);
    expect(binomCdf(9, 10, 1)).toBe(0);
    expect(binomCdf(10, 10, 1)).toBe(1);
  });

  it('survives 53-bit territory where a naive comb overflows', () => {
    // C(1000, 500) is ~2.7e299: a naive factorial ratio is Infinity/Infinity.
    const v = binomCdf(500, 1000, 0.5);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeLessThan(0.53);
  });

  it('does not collapse to zero when q^n underflows', () => {
    // p = 0.99, n = 2000: 0.01^2000 underflows a double, so the direct
    // recursion would return 0 for everything without the log-space fallback.
    const v = binomCdf(1900, 2000, 0.99);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1e-6);
  });

  it('rejects nonsense inputs rather than returning NaN', () => {
    expect(() => binomCdf(1, -1, 0.5)).toThrow();
    expect(() => binomCdf(1, 10, 1.5)).toThrow();
    expect(() => binomCdf(1.5, 10, 0.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// verdict: the three outcome rule
// ---------------------------------------------------------------------------

describe('verdict', () => {
  it('GOLDEN: 32/36 vs 0.90 is EXTEND with p > 0.4', () => {
    // The case the module exists for. Not evidence of failure, an
    // under-resolved measurement.
    const v = verdict(32, 36, 0.9);
    expect(v.outcome).toBe('EXTEND');
    expect(v.pValue).toBeGreaterThan(0.4);
    expect(v.pValue).toBeCloseTo(0.4914885946337802, 10);
    expect(rate(v)).toBeCloseTo(0.888889, 6);
  });

  it('GOLDEN: 33/36 vs 0.90 is PASS', () => {
    expect(verdict(33, 36, 0.9).outcome).toBe('PASS');
    expect(verdict(36, 36, 0.9).outcome).toBe('PASS');
  });

  it('GOLDEN: 25/36 vs 0.90 is FAIL with p < 0.05', () => {
    const v = verdict(25, 36, 0.9);
    expect(v.outcome).toBe('FAIL');
    expect(v.pValue).toBeLessThan(0.05);
    expect(v.pValue).toBeCloseTo(0.0005560888744209, 12);
  });

  it('GOLDEN: pooling an extension resolves 32/36 -> 68/72 PASS, 60/72 EXTEND, 56/72 FAIL', () => {
    expect(verdict(32, 36, 0.9).outcome).toBe('EXTEND');
    expect(verdict(68, 72, 0.9).outcome).toBe('PASS');
    // 60/72 is p = 0.053: still EXTEND. The rule does not round down.
    expect(verdict(60, 72, 0.9).outcome).toBe('EXTEND');
    expect(verdict(60, 72, 0.9).pValue).toBeCloseTo(0.05298590320381557, 10);
    expect(verdict(56, 72, 0.9).outcome).toBe('FAIL');
  });

  it('has no near-miss band that hard-fails', () => {
    for (let k = 0; k <= 36; k++) {
      const v = verdict(k, 36, 0.9);
      if (rate(v) < 0.9 && v.pValue >= 0.05) expect(v.outcome, `k=${k}`).toBe('EXTEND');
    }
  });

  it('rejects an empty or impossible sample', () => {
    expect(() => verdict(0, 0, 0.9)).toThrow();
    expect(() => verdict(5, 4, 0.9)).toThrow();
    expect(() => verdict(-1, 4, 0.9)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

describe('plan', () => {
  it('GOLDEN: plan(0.90, 0.80).n === 78', () => {
    const d = plan(0.9, 0.8);
    expect(d.n).toBe(78);
    expect(d.failAtOrBelow).toBe(65);
    expect(d.power).toBeGreaterThanOrEqual(0.8);
    expect(d.power).toBeCloseTo(0.81, 2);
  });

  it('is self consistent: the stated critical k FAILs and k+1 does not', () => {
    const d = plan(0.9, 0.8);
    expect(verdict(d.failAtOrBelow, d.n, 0.9).outcome).toBe('FAIL');
    expect(verdict(d.failAtOrBelow + 1, d.n, 0.9).outcome).not.toBe('FAIL');
  });

  it('a smaller gap needs a larger n', () => {
    expect(plan(0.9, 0.85).n).toBe(270);
    expect(plan(0.9, 0.75).n).toBe(40);
    expect(plan(0.9, 0.85).n).toBeGreaterThan(plan(0.9, 0.75).n);
  });

  it('rejects a detectable rate at or above the threshold', () => {
    expect(() => plan(0.8, 0.9)).toThrow();
    expect(() => plan(0.9, 0.9)).toThrow();
  });

  it('memoizes to the same design object', () => {
    expect(planCached(0.9, 0.8)).toBe(planCached(0.9, 0.8));
    expect(planCached(0.9, 0.8).n).toBe(78);
  });

  it('refuses rather than looping forever when maxN cannot resolve the question', () => {
    expect(() => plan(0.9, 0.899, 0.05, 0.8, 200)).toThrow(/no n <= 200/);
  });
});

// ---------------------------------------------------------------------------
// DIVERGENCE 12b: the publication rule
// ---------------------------------------------------------------------------

describe('publishedVerdict (DESIGN divergence 12b)', () => {
  it('downgrades an under-resolved PASS to EXTEND', () => {
    // 33/36 passes evalgate's rule. Its Wilson lower bound is 0.782, well below
    // 0.90, and n = 36 is under the planned 78, so it is not publishable.
    const p = publishedVerdict(33, 36, 0.9);
    expect(p.rawOutcome).toBe('PASS');
    expect(p.outcome).toBe('EXTEND');
    expect(p.downgraded).toBe(true);
    expect(p.reason).toBe('downgraded_underpowered');
    expect(p.wilsonLow).toBeCloseTo(0.7817, 3);
    expect(p.requiredN).toBe(78);
  });

  it('downgrades 68/72 too: a pooled PASS is still not a resolved PASS', () => {
    const p = publishedVerdict(68, 72, 0.9);
    expect(p.rawOutcome).toBe('PASS');
    expect(p.outcome).toBe('EXTEND');
    expect(p.wilsonLow).toBeLessThan(0.9);
  });

  it('publishes a PASS once the run reaches the planned n', () => {
    const p = publishedVerdict(72, 78, 0.9);
    expect(p.rawOutcome).toBe('PASS');
    expect(p.outcome).toBe('PASS');
    expect(p.downgraded).toBe(false);
    expect(p.reason).toBe('ok');
  });

  it('publishes a PASS when the Wilson lower bound clears the threshold on its own', () => {
    const p = publishedVerdict(40, 40, 0.9);
    expect(p.wilsonLow).toBeGreaterThanOrEqual(0.9);
    expect(p.outcome).toBe('PASS');
    expect(p.downgraded).toBe(false);
  });

  it('never upgrades: FAIL and EXTEND pass through unchanged', () => {
    expect(publishedVerdict(25, 36, 0.9).outcome).toBe('FAIL');
    expect(publishedVerdict(25, 36, 0.9).reason).toBe('failed');
    expect(publishedVerdict(32, 36, 0.9).outcome).toBe('EXTEND');
    expect(publishedVerdict(32, 36, 0.9).reason).toBe('under_resolved');
    expect(publishedVerdict(32, 36, 0.9).downgraded).toBe(false);
  });

  it('tests the power THIS n achieves, because power is sawtoothed in n', () => {
    // plan(0.90, 0.80).n = 78 at power 0.808, but power is not monotone in n:
    // an exact-binomial critical value only moves at integer steps, so n = 80
    // detects a true rate of 0.80 three times in four. "n >= plan().n" is not
    // the same claim as "this run was sized to resolve it".
    expect(achievedPower(78, 0.9, 0.8)).toBeCloseTo(0.8082, 4);
    expect(achievedPower(79, 0.9, 0.8)).toBeCloseTo(0.8225, 4);
    expect(achievedPower(80, 0.9, 0.8)).toBeCloseTo(0.753, 4);
    expect(achievedPower(81, 0.9, 0.8)).toBeCloseTo(0.7696, 4);
    expect(achievedPower(82, 0.9, 0.8)).toBeCloseTo(0.7854, 4);
    expect(achievedPower(87, 0.9, 0.8)).toBeCloseTo(0.7783, 4);
    expect(achievedPower(88, 0.9, 0.8)).toBeCloseTo(0.7932, 4);
    // A gate too small to FAIL at any k has no power at all, and never NaN.
    expect(achievedPower(1, 0.9, 0.8)).toBe(0);
    expect(achievedPower(0, 0.9, 0.8)).toBe(0);
    // Small but non-degenerate: real, and nowhere near the requested 0.80.
    expect(achievedPower(4, 0.9, 0.8)).toBeCloseTo(0.0272, 4);
  });

  it('downgrades a PASS at an n past the planned one whose achieved power falls short', () => {
    for (const n of [80, 81, 82, 87]) {
      const p = publishedVerdict(n - 7, n, 0.9);
      expect(p.rawOutcome).toBe('PASS');
      expect(p.wilsonLow).toBeLessThan(0.9); // the PASS rests on sizing alone
      expect(p.outcome).toBe('EXTEND');
      expect(p.downgraded).toBe(true);
      expect(p.achievedPower).toBeLessThan(0.8);
    }
    // n = 79 clears it, and publishes.
    const ok = publishedVerdict(72, 79, 0.9);
    expect(ok.outcome).toBe('PASS');
    expect(ok.achievedPower).toBeGreaterThanOrEqual(0.8);
  });

  it('defaults the detectable rate to threshold - 0.10', () => {
    expect(defaultDetectable(0.9)).toBeCloseTo(0.8, 12);
    expect(publishedVerdict(33, 36, 0.9).detectableRate).toBeCloseTo(0.8, 12);
    expect(defaultDetectable(0.05)).toBeCloseTo(0.025, 12);
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

describe('stats', () => {
  it('GOLDEN: wilson(32, 36) is (0.747, 0.956) to 3dp', () => {
    const w = wilson(32, 36);
    expect(w.low).toBeCloseTo(0.747, 3);
    expect(w.high).toBeCloseTo(0.956, 3);
    expect(w.rate).toBeCloseTo(0.888889, 6);
    expect(w.k).toBe(32);
    expect(w.n).toBe(36);
  });

  it('wilson degenerates safely', () => {
    expect(wilson(0, 0)).toMatchObject({ low: 0, high: 1, rate: 0 });
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBe(1);
    expect(() => wilson(11, 10)).toThrow();
  });

  it('GOLDEN: normalQuantile(0.975) = 1.959964 and (0.80) = 0.841621 to 6dp', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232, 5);
    expect(() => normalQuantile(0)).toThrow();
    expect(() => normalQuantile(1)).toThrow();
  });

  it('GOLDEN: separate(0.42, 0.58) > 100 and is symmetric', () => {
    expect(separate(0.42, 0.58)).toBe(153);
    expect(separate(0.42, 0.58)).toBeGreaterThan(100);
    expect(separate(0.3, 0.6)).toBe(separate(0.6, 0.3));
  });

  it('GOLDEN: separate(0.42, 0.83) < 30', () => {
    expect(separate(0.42, 0.83)).toBe(21);
    expect(separate(0.42, 0.83)).toBeLessThan(30);
  });

  it('separate rejects equal or out-of-range rates', () => {
    expect(() => separate(0.5, 0.5)).toThrow();
    expect(() => separate(0, 0.5)).toThrow();
    expect(() => separate(0.5, 1)).toThrow();
  });

  it('GOLDEN: tieRate(0.854, 3) is within 1e-3 of 0.493', () => {
    expect(Math.abs(tieRate(0.854, 3) - 0.493)).toBeLessThan(1e-3);
    expect(tieRate(0.854, 3)).toBeCloseTo(0.49295879911909, 12);
  });

  it('comb is exact well past where factorials overflow', () => {
    expect(comb(10, 5)).toBe(252);
    expect(comb(52, 5)).toBe(2598960);
    expect(comb(5, 6)).toBe(0);
    expect(comb(30, 15)).toBe(155117520);
  });

  it('percentile is nearest-rank and returns null on an empty sample', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([0.1, 0.2, 0.3, 0.4], 50)).toBe(0.2);
    expect(percentile([0.1, 0.2, 0.3, 0.4], 95)).toBe(0.4);
    expect(percentile([3, 1, 2], 100)).toBe(3);
    expect(percentile([Number.NaN], 50)).toBeNull();
  });

  it('mean is null rather than NaN on an empty sample', () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// structural gate
// ---------------------------------------------------------------------------

describe('structural gate', () => {
  const alwaysGood = (seed: number) => ({ seed });

  it('passes a generator that admits everything and holds everywhere', () => {
    const r = structural(alwaysGood, () => true, { n: 50 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.nGenerated).toBe(50);
    expect(r.holdRate).toBe(1);
    expect(r.admissionRate).toBe(1);
  });

  it('requires a 100% hold rate: one violation is a rejection', () => {
    const r = structural(alwaysGood, (c) => c.seed !== 17, { n: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('property_violated');
    expect(r.failures[0]).toMatchObject({ seed: 17, detail: 'property does not hold' });
  });

  it('guards against vacuous truth: 0 of 200 admitted is not a pass', () => {
    const r = structural(() => null, () => true, { n: 200 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_cases_generated');
    expect(r.holdRate).toBe(0);
  });

  it('NEW vs evalgate: rejects 5 admitted of 200 requested even at a 100% hold rate', () => {
    // evalgate passes this. A generator that admits 2.5% of its own seeds has
    // verified nothing, and 5 cases is below the minimum suite size anyway.
    const r = structural((seed) => (seed < 5 ? { seed } : null), () => true, { n: 200 });
    expect(r.holdRate).toBe(1);
    expect(r.nGenerated).toBe(5);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too_few_generated');
    expect(explainStructural(r)).toContain('too_few_generated');
  });

  it('NEW vs evalgate: rejects a low admission rate even above the absolute minimum', () => {
    const r = structural((seed) => (seed % 10 === 0 ? { seed } : null), () => true, { n: 200 });
    expect(r.nGenerated).toBe(20);
    expect(r.admissionRate).toBeCloseTo(0.1, 12);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('admission_rate_below_minimum');
  });

  it('honours configured minimums', () => {
    const r = structural((seed) => (seed < 5 ? { seed } : null), () => true, {
      n: 200,
      minGenerated: 4,
      minAdmissionRate: 0.01,
    });
    expect(r.ok).toBe(true);
  });

  it('records generator and predicate exceptions instead of crashing', () => {
    const r = structural(
      (seed) => {
        if (seed === 3) throw new Error('boom');
        return { seed };
      },
      (c) => {
        if (c.seed === 4) throw new Error('bad predicate');
        return true;
      },
      { n: 20 },
    );
    expect(r.nGenerated).toBe(19);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.detail).join(' ')).toMatch(/generator raised/);
    expect(r.failures.map((f) => f.detail).join(' ')).toMatch(/predicate raised/);
  });

  it('caps retained failures', () => {
    const r = structural(alwaysGood, () => false, { n: 100, maxFailures: 3 });
    expect(r.failures).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// construct gate
// ---------------------------------------------------------------------------

describe('construct gate', () => {
  const cases = Array.from({ length: 12 }, (_, i) => ({ id: i, answer: `a${i}` }));
  const good = (c: { answer: string }) => c.answer;
  const truthOf = (c: { answer: string }) => c.answer;

  it('passes when the reference oracle reaches the answer key', async () => {
    const r = await construct(good, cases, truthOf, { reps: 3 });
    expect(r.n).toBe(36);
    expect(r.nIntended).toBe(36);
    expect(r.rate).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.verdict?.outcome).toBe('PASS');
    expect(r.runOutcome).toBeNull();
  });

  it('rejects a scorer the oracle does not share', async () => {
    const r = await construct(() => 'always-wrong', cases, truthOf, { reps: 3 });
    expect(r.rate).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('below_min_rate');
    expect(r.verdict?.outcome).toBe('FAIL');
    expect(r.disagreements.length).toBeGreaterThan(0);
  });

  it('reports a near miss as under_resolved, not a failure', async () => {
    // 32/36, the case the three outcome rule exists for.
    let n = 0;
    const r = await construct((c: { answer: string }) => (n++ < 32 ? c.answer : 'wrong'), cases, truthOf, {
      reps: 3,
      maxWorkers: 1,
    });
    expect(r.nIntended).toBe(32);
    expect(r.n).toBe(36);
    expect(r.reason).toBe('under_resolved');
    expect(r.ok).toBe(false);
    expect(r.verdict?.outcome).toBe('EXTEND');
  });

  it('DIVERGENCE 12a: errors count in the denominator and >5% is COMPROMISED', async () => {
    // 34 clean calls and 2 failures: evalgate reports 34/34 = 100% and passes.
    let n = 0;
    const r = await construct(
      (c: { answer: string }) => {
        if (n++ < 2) throw new Error('502 from the server');
        return c.answer;
      },
      cases,
      truthOf,
      { reps: 3, maxWorkers: 1 },
    );
    expect(r.n).toBe(34);
    expect(r.nIntended).toBe(34);
    expect(r.rate).toBe(1); // evalgate would stop here and PASS
    expect(r.errors).toBe(2);
    expect(r.errorRate).toBeCloseTo(2 / 36, 12);
    expect(r.errorRate).toBeGreaterThan(0.05);
    expect(r.compromised).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('compromised');
    expect(r.runOutcome).toBe('COMPROMISED');
    expect(r.errorExamples[0]?.detail).toContain('502');
  });

  it('tolerates an error rate at or below the limit', async () => {
    let n = 0;
    const r = await construct(
      (c: { answer: string }) => {
        if (n++ === 0) throw new Error('one flake');
        return c.answer;
      },
      cases,
      truthOf,
      { reps: 3, maxWorkers: 1 },
    );
    expect(r.errorRate).toBeCloseTo(1 / 36, 12);
    expect(r.compromised).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('refuses rather than dividing by zero when everything fails', async () => {
    const r = await construct(
      () => {
        throw new Error('dead server');
      },
      cases,
      truthOf,
      { reps: 1 },
    );
    expect(r.n).toBe(0);
    expect(r.rate).toBe(0);
    expect(r.verdict).toBeNull();
    expect(r.published).toBeNull();
    expect(r.ok).toBe(false);
    // an entirely dead run is COMPROMISED, not a construct FAIL
    expect(r.reason).toBe('compromised');
  });

  it('respects the concurrency limit', async () => {
    let live = 0;
    let peak = 0;
    const r = await construct(
      async (c: { answer: string }) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((res) => setTimeout(res, 1));
        live -= 1;
        return c.answer;
      },
      cases,
      truthOf,
      { reps: 3, maxWorkers: 4 },
    );
    expect(r.n).toBe(36);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('carries the published verdict alongside the raw one', async () => {
    const r = await construct(good, cases, truthOf, { reps: 3 });
    expect(r.verdict?.outcome).toBe('PASS');
    // 36/36 at n = 36 has Wilson low 0.903, which clears 0.90 on its own
    expect(r.published?.outcome).toBe('PASS');
    const small = await construct(good, cases.slice(0, 4), truthOf, { reps: 1 });
    expect(small.verdict?.outcome).toBe('PASS');
    expect(small.published?.outcome).toBe('EXTEND');
    expect(small.published?.downgraded).toBe(true);
  });

  it('mapLimit preserves input order', async () => {
    const out = await mapLimit([5, 4, 3, 2, 1], 3, async (x) => {
      await new Promise((res) => setTimeout(res, x));
      return x * 10;
    });
    expect(out).toEqual([50, 40, 30, 20, 10]);
  });
});

// ---------------------------------------------------------------------------
// variance gate
// ---------------------------------------------------------------------------

describe('variance gate', () => {
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: i, answer: `a${i}` }));
  const truthOf = (c: { answer: string }) => c.answer;

  it('accepts a suite with real error variance', async () => {
    const r = await variance((c: { id: number; answer: string }) => (c.id % 4 === 0 ? 'wrong' : c.answer), cases, truthOf);
    expect(r.n).toBe(20);
    expect(r.nWrong).toBe(5);
    expect(r.errorRate).toBe(0.25);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.interval.low).toBeGreaterThan(0);
  });

  it('rejects at_ceiling: a 100% suite has nothing to attribute', async () => {
    const r = await variance((c: { answer: string }) => c.answer, cases, truthOf);
    expect(r.atCeiling).toBe(true);
    expect(r.atFloor).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('at_ceiling');
    expect(explainVariance(r)).toContain('at_ceiling');
  });

  it('rejects at_floor: a 0% suite is a broken harness, not a hard task', async () => {
    const r = await variance(() => 'wrong', cases, truthOf);
    expect(r.atFloor).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('at_floor');
    expect(explainVariance(r)).toContain('at_floor');
  });

  it('rejects an error rate below the floor', async () => {
    const r = await variance((c: { id: number; answer: string }) => (c.id === 0 ? 'wrong' : c.answer), cases, truthOf, {
      minErrorRate: 0.2,
    });
    expect(r.errorRate).toBe(0.05);
    expect(r.reason).toBe('below_min_error_rate');
    expect(r.ok).toBe(false);
  });

  it('DIVERGENCE: catches oracle exceptions instead of taking the gate down', async () => {
    // evalgate lets this propagate out of the thread pool.
    const r = await variance(
      (c: { id: number; answer: string }) => {
        if (c.id % 5 === 0) throw new Error('transport reset');
        return c.id % 3 === 0 ? 'wrong' : c.answer;
      },
      cases,
      truthOf,
    );
    expect(r.oracleErrors).toBe(4);
    expect(r.truthErrors).toBe(0);
    expect(r.errors).toBe(4);
    expect(r.n).toBe(16);
    expect(r.errorDetails[0]).toContain('transport reset');
    expect(Number.isFinite(r.errorRate)).toBe(true);
  });

  it('catches truth exceptions too', async () => {
    const r = await variance((c: { answer: string }) => c.answer, cases, (c) => {
      if (c.id === 1) throw new Error('bad key');
      return c.answer;
    });
    expect(r.truthErrors).toBe(1);
    expect(r.n).toBe(19);
  });

  it('reports no_cases rather than NaN when nothing completes', async () => {
    const r = await variance(
      () => {
        throw new Error('dead');
      },
      cases,
      truthOf,
    );
    expect(r.n).toBe(0);
    expect(r.errorRate).toBe(0);
    expect(r.reason).toBe('no_cases');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// null baseline gate
// ---------------------------------------------------------------------------

describe('null baseline gate', () => {
  it('applies the ratio rule verbatim', () => {
    expect(nullVerdict(0.1, 0.5)).toBe('PROCEED');
    expect(nullVerdict(0.24, 0.5)).toBe('PROCEED');
    expect(nullVerdict(0.25, 0.5)).toBe('KILL'); // >= is a KILL, not a PROCEED
    expect(nullVerdict(0.4, 0.5)).toBe('KILL');
  });

  it('relabels the zero-signal case as INDETERMINATE, not KILL', () => {
    // The literal rule returns KILL because T_null >= 0 always holds. "The
    // measurement is degenerate" is a different finding from "noise exceeds
    // signal" and is reported as one.
    expect(nullVerdict(0, 0)).toBe('INDETERMINATE');
    expect(nullVerdict(0.3, 0)).toBe('INDETERMINATE');
  });

  it('treats a missing measurement as INDETERMINATE, never as a zero', () => {
    expect(nullVerdict(null, 0.5)).toBe('INDETERMINATE');
    expect(nullVerdict(0.1, null)).toBe('INDETERMINATE');
    expect(nullVerdict(undefined, undefined)).toBe('INDETERMINATE');
    expect(nullVerdict(Number.NaN, 0.5)).toBe('INDETERMINATE');
  });

  it('INDETERMINATE halts exactly like KILL', () => {
    expect(halts('KILL')).toBe(true);
    expect(halts('INDETERMINATE')).toBe(true);
    expect(halts('PROCEED')).toBe(false);
  });

  it('PROCEEDs when every null model is well under the signal', () => {
    const r = nullBaselineGate({
      signal: { k: 18, n: 20 },
      nulls: [
        { label: 'no-tools', k: 1, n: 20 },
        { label: 'stubbed-empty', k: 0, n: 20 },
        { label: 'random-valid-args', k: 2, n: 20 },
      ],
    });
    expect(r.tNull).toBeCloseTo(0.1, 12);
    expect(r.tAblate).toBeCloseTo(0.9, 12);
    expect(r.killThreshold).toBeCloseTo(0.45, 12);
    expect(r.outcome).toBe('PROCEED');
    expect(r.ok).toBe(true);
    expect(r.halts).toBe(false);
  });

  it('KILLs a suite a no-tools model can pass', () => {
    const r = nullBaselineGate({
      signal: { k: 18, n: 20 },
      nulls: [
        { label: 'no-tools', k: 17, n: 20 },
        { label: 'stubbed-empty', k: 0, n: 20 },
      ],
    });
    expect(r.outcome).toBe('KILL');
    expect(r.reason).toBe('noise_exceeds_signal');
    expect(r.halts).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('is INDETERMINATE when the real agent passed nothing', () => {
    const r = nullBaselineGate({
      signal: { k: 0, n: 20 },
      nulls: [{ label: 'no-tools', k: 0, n: 20 }],
    });
    expect(r.outcome).toBe('INDETERMINATE');
    expect(r.reason).toBe('degenerate_no_signal');
    expect(r.halts).toBe(true);
  });

  it('is INDETERMINATE when a baseline was never measured', () => {
    const r = nullBaselineGate({ signal: { k: 18, n: 20 }, nulls: [] });
    expect(r.tNull).toBeNull();
    expect(r.outcome).toBe('INDETERMINATE');
    expect(r.reason).toBe('no_measurements');
    expect(r.halts).toBe(true);
  });

  it('takes the requested percentile over the null models, nearest rank', () => {
    const r = nullBaselineGate({
      signal: { k: 20, n: 20 },
      nulls: [
        { label: 'a', k: 0, n: 20 },
        { label: 'b', k: 2, n: 20 },
        { label: 'c', k: 12, n: 20 },
      ],
    });
    expect(r.tNull).toBeCloseTo(0.6, 12);
    expect(r.outcome).toBe('KILL');
  });

  it('rejects impossible counts', () => {
    expect(() => nullBaselineGate({ signal: { k: 21, n: 20 }, nulls: [] })).toThrow();
    expect(() => nullBaselineGate({ signal: { k: 1, n: 20 }, nulls: [{ label: 'x', k: -1, n: 5 }] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// order invariance probe
// ---------------------------------------------------------------------------

describe('order invariance probe', () => {
  it('reports NOT_APPLICABLE when fewer than two orderings exist', async () => {
    const r = await orderInvariance(async (xs) => xs.join(''), ['only'], { samples: 2 });
    expect(r.verdict).toBe('not_applicable');
    expect(r.byOrdering).toHaveLength(1);
    expect(r.value).toBe('only');
    expect(r.unstable).toBe(false);

    const empty = await orderInvariance(async () => 'x', [], { samples: 2 });
    expect(empty.verdict).toBe('not_applicable');
  });

  it('caps k at n factorial so no ordering is ever repeated', () => {
    expect(orderings(3, 6, 0)).toHaveLength(6); // 3! = 6, not 6 requested of 3 items
    expect(orderings(2, 6, 0)).toHaveLength(2);
    expect(orderings(1, 6, 0)).toHaveLength(1);
    expect(orderings(4, 6, 0)).toHaveLength(6);
    const three = orderings(3, 6, 0).map((p) => p.join(''));
    expect(new Set(three).size).toBe(three.length);
    expect(three[0]).toBe('012');
  });

  it('samples distinct orderings for inputs too large to enumerate', () => {
    const os = orderings(12, 6, 3);
    expect(os).toHaveLength(6);
    expect(new Set(os.map((p) => p.join(','))).size).toBe(6);
    expect(os[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('calls fn k * samples times', async () => {
    let calls = 0;
    const r = await orderInvariance(
      async () => {
        calls += 1;
        return 'same';
      },
      ['a', 'b', 'c'],
      { k: 4, samples: 3 },
    );
    expect(calls).toBe(12);
    expect(r.calls).toBe(12);
    expect(r.verdict).toBe('stable');
    expect(r.dispersion).toBe(0);
  });

  it('detects an answer that depends on position', async () => {
    const r = await orderInvariance(async (xs) => (xs[0] === 'x' ? 'A' : 'B'), ['x', 'y'], {
      k: 2,
      samples: 1,
    });
    expect(r.verdict).toBe('unstable');
    expect(r.unstable).toBe(true);
    expect(r.dispersion).toBe(1); // two orderings sharing no answer at all
    expect(r.value).toBe('A'); // the answer at the order actually passed in
    expect([...r.answers].sort()).toEqual(['A', 'B']);
  });

  it('computes dispersion as the MAX pairwise total variation', async () => {
    // three orderings: canonical all A, one all B, one all A. Max pair is 1.0
    // even though the mean pairwise TV is lower.
    const seen: string[] = [];
    const r = await orderInvariance(
      async (xs) => {
        const answer = xs[0] === 'b' ? 'B' : 'A';
        seen.push(answer);
        return answer;
      },
      ['a', 'b', 'c'],
      { k: 6, samples: 1 },
    );
    expect(seen.length).toBe(6);
    expect(r.dispersion).toBe(1);
    expect(r.verdict).toBe('unstable');
  });

  it('honours an explicit dispersion threshold', async () => {
    // orderings that lead with 'a' answer B once in four; the rest never do.
    // That is a 0.25 total variation: unstable at 0.1, stable at 0.9.
    const flaky = () => {
      const seen = new Map<string, number>();
      return async (xs: readonly string[]) => {
        const sig = xs.join('');
        const i = seen.get(sig) ?? 0;
        seen.set(sig, i + 1);
        return sig[0] === 'a' && i === 0 ? 'B' : 'A';
      };
    };
    const strict = await orderInvariance(flaky(), ['a', 'b', 'c'], { k: 3, samples: 4, threshold: 0.1 });
    expect(strict.dispersion).toBeCloseTo(0.25, 12);
    expect(strict.verdict).toBe('unstable');
    const loose = await orderInvariance(flaky(), ['a', 'b', 'c'], { k: 3, samples: 4, threshold: 0.9 });
    expect(loose.dispersion).toBeCloseTo(0.25, 12);
    expect(loose.verdict).toBe('stable');
  });

  it('counts throwing calls instead of dropping them silently', async () => {
    const r = await orderInvariance(
      async () => {
        throw new Error('model refused');
      },
      ['a', 'b'],
      { k: 2, samples: 2 },
    );
    expect(r.errors).toBe(4);
    expect(r.calls).toBe(4);
    expect(r.verdict).toBe('not_applicable');
    expect(r.value).toBeNull();
  });

  it('never mutates the caller input', async () => {
    const items = ['a', 'b', 'c'];
    await orderInvariance(async (xs) => xs.join(''), items, { k: 6, samples: 1 });
    expect(items).toEqual(['a', 'b', 'c']);
  });

  it('runs orderings concurrently when asked, with the same verdict', async () => {
    const r = await orderInvariance(async (xs) => (xs[0] === 'x' ? 'A' : 'B'), ['x', 'y', 'z'], {
      k: 6,
      samples: 2,
      maxWorkers: 3,
    });
    expect(r.calls).toBe(12);
    expect(r.verdict).toBe('unstable');
    expect(r.byOrdering[0]?.order).toEqual([0, 1, 2]);
  });

  it('is deterministic for a given seed', () => {
    expect(orderings(5, 4, 7)).toEqual(orderings(5, 4, 7));
    const a = seededRandom(9);
    const b = seededRandom(9);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

// ---------------------------------------------------------------------------
// fixtures and the audit harness
// ---------------------------------------------------------------------------

describe('fixtures', () => {
  it('ships four known-bad suites and two valid controls', () => {
    expect(names()).toEqual([
      'unsolvable_task',
      'answer_in_prompt',
      'null_passable',
      'scorer_disagrees',
      'handle_chain',
      'calibrated_variance',
    ]);
    expect(FIXTURES.filter((f) => !f.valid)).toHaveLength(4);
    expect(FIXTURES.filter((f) => f.valid)).toHaveLength(2);
    expect(() => get('nope')).toThrow();
    expect(get('handle_chain').valid).toBe(true);
  });

  it('is deterministic given a seed', () => {
    for (const f of FIXTURES) {
      expect(f.makeCase(7)).toEqual(f.makeCase(7));
    }
  });

  it('every case is a well formed FitnessTask', () => {
    for (const f of FIXTURES) {
      const c = f.makeCase(3);
      expect(c.task.id).toContain('3');
      expect(c.task.prompt.length).toBeGreaterThan(10);
      expect(c.task.expectedTools.length).toBeGreaterThan(0);
      expect(c.intended.length).toBeGreaterThan(0);
      expect(c.tools.length).toBeGreaterThan(0);
      // no em-dashes anywhere in generated copy (standing style rule)
      expect(c.task.prompt).not.toContain('—');
    }
  });

  it('only the leak fixture leaks its answer key into the prompt', () => {
    for (const f of FIXTURES) {
      for (let s = 0; s < 25; s++) {
        const leaked = answerLeaks(f.makeCase(s).task);
        expect(leaked, `${f.name} seed ${s}`).toBe(f.name === 'answer_in_prompt');
      }
    }
  });

  it('the free check sees exactly what a free check can see', () => {
    // structural failures are visible; the other two are not, by construction
    for (let s = 0; s < 25; s++) {
      expect(structurallySound(get('unsolvable_task').makeCase(s))).toBe(false);
      expect(structurallySound(get('answer_in_prompt').makeCase(s))).toBe(false);
      expect(structurallySound(get('null_passable').makeCase(s))).toBe(true);
      expect(structurallySound(get('scorer_disagrees').makeCase(s))).toBe(true);
      expect(structurallySound(get('handle_chain').makeCase(s))).toBe(true);
      expect(structurallySound(get('calibrated_variance').makeCase(s))).toBe(true);
    }
  });

  it('null_passable is passable with no tools; the valid controls are not', () => {
    const cases = (name: string) => Array.from({ length: 24 }, (_, i) => get(name).makeCase(i));
    const nullRate = (name: string) => {
      const cs = cases(name);
      return cs.filter((c) => simulatedNullOracle(c) === truth(c)).length / cs.length;
    };
    expect(nullRate('null_passable')).toBe(1);
    expect(nullRate('handle_chain')).toBe(0);
    expect(nullRate('calibrated_variance')).toBe(0);
    expect(nullRate('scorer_disagrees')).toBe(0);
  });

  it('the valid controls carry real error variance for the variance gate', async () => {
    for (const name of ['handle_chain', 'calibrated_variance']) {
      const cs = Array.from({ length: 60 }, (_, i) => get(name).makeCase(i));
      const r = await variance(simulatedExperimentalOracle, cs, truth, { minErrorRate: 0.02 });
      expect(r.atCeiling, name).toBe(false);
      expect(r.atFloor, name).toBe(false);
      expect(r.ok, name).toBe(true);
    }
  });

  it('only scorer_disagrees needs the construct gate to be seen', async () => {
    const cs = (name: string) => Array.from({ length: 24 }, (_, i) => get(name).makeCase(i));
    const bad = await construct(simulatedOracle, cs('scorer_disagrees'), truth, { reps: 1 });
    expect(bad.rate).toBe(0);
    expect(bad.ok).toBe(false);
    for (const name of ['handle_chain', 'calibrated_variance', 'null_passable']) {
      const good = await construct(simulatedOracle, cs(name), truth, { reps: 1 });
      expect(good.rate, name).toBe(1);
      expect(good.ok, name).toBe(true);
    }
  });
});

describe('audit', () => {
  it('a FREE check catches every free-reachable known-bad with zero false alarms', async () => {
    const r = await audit((makeCase, n) => defaultStructuralCheck(makeCase, n), { n: 60 });
    expect(r.caught).toEqual(['unsolvable_task', 'answer_in_prompt']);
    expect(r.passedValid).toEqual(['handle_chain', 'calibrated_variance']);
    expect(r.falseAlarms).toEqual([]);
    expect(r.errors).toEqual([]);
    // the two a free check cannot reach are reported separately, not scored
    expect(r.unreachable).toEqual(['null_passable', 'scorer_disagrees']);
    expect(r.missed).toEqual(['null_passable', 'scorer_disagrees']);
    expect(r.reachableMissed).toEqual([]);
    expect(r.nReachableInvalid).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('verdict      OK');
  });

  it('the full gate stack catches EVERY known-bad with zero false alarms', async () => {
    const r = await audit((makeCase, n) => defaultFullCheck(makeCase, n), {
      n: 60,
      reachableBy: ['structural', 'null', 'construct'],
    });
    expect(r.caught).toEqual([
      'unsolvable_task',
      'answer_in_prompt',
      'null_passable',
      'scorer_disagrees',
    ]);
    expect(r.missed).toEqual([]);
    expect(r.reachableMissed).toEqual([]);
    expect(r.falseAlarms).toEqual([]);
    expect(r.passedValid).toEqual(['handle_chain', 'calibrated_variance']);
    expect(r.unreachable).toEqual([]);
    expect(r.nReachableInvalid).toBe(4);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('a check that rejects everything scores zero', async () => {
    const r = await audit(() => false, { n: 20, reachableBy: ['structural', 'null', 'construct'] });
    expect(r.caught).toHaveLength(4);
    expect(r.falseAlarms).toEqual(['handle_chain', 'calibrated_variance']);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('FALSE ALARM');
  });

  it('a check that accepts everything is INCOMPLETE', async () => {
    const r = await audit(() => true, { n: 20 });
    expect(r.caught).toEqual([]);
    expect(r.reachableMissed).toEqual(['unsolvable_task', 'answer_in_prompt']);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('MISSED');
  });

  it('a throwing check is an error, never a silent pass', async () => {
    const r = await audit(
      (makeCase) => {
        const c: FixtureCase = makeCase(0);
        if (c.task.expectedTools.includes('get_weather')) throw new Error('check exploded');
        return true;
      },
      { n: 20 },
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.name).toBe('unsolvable_task');
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('raised');
  });

  it('reports the unreachable set honestly in its summary', async () => {
    const r = await audit((makeCase, n) => defaultStructuralCheck(makeCase, n), { n: 20 });
    expect(r.summary).toContain('not reachable at tiers');
    expect(r.summary).toContain('scorer_disagrees is structurally identical to a valid suite');
  });
});
