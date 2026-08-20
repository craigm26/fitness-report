/**
 * Leaderboard renderer tests (site/app.js).
 *
 * Written in JavaScript on purpose: `site/app.js` is a framework free ES module
 * that ships as it is, with no build step and no type declarations, so a test
 * that imports it must be JavaScript too. The tsconfig include list is
 * `src`, `canary` and `test/**\/*.ts`, so this file is outside the type check
 * and inside the vitest run, which is exactly where it belongs.
 *
 * Four reviewer findings are covered here, each verified against the published
 * `site/data/runs.json` as well as against fixtures:
 *
 *   A  a cost that is known to be incomplete is labelled a floor, never a total.
 *   B  EXTEND_EXHAUSTED copy is true of both harness eras and is keyed off the
 *      record, never off a list of server names.
 *   C  an extension batch reports the tasks it recorded, not a pooled trial delta.
 *   D  runs of one server carry their own identity and read as separate attempts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  OUTCOME_NOTES,
  boardStats,
  cohortPlaceOf,
  costTotalLine,
  exhaustedReading,
  extensionFigures,
  extensionLedgerOf,
  extensionProtocolOf,
  extensionProtocolSentence,
  extensionSentences,
  judgeFloorReasons,
  judgeUsageOf,
  renderBoard,
  rerunSummary,
  runCostOf,
  runIdentityLine,
  runIdentityOf,
  serverCohorts,
  slugOf,
  spendNote
} from '../site/app.js';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const RUNS = JSON.parse(readFileSync(here('../site/data/runs.json'), 'utf8'));
const APP_SOURCE = readFileSync(here('../site/app.js'), 'utf8');
const INDEX_SOURCE = readFileSync(here('../site/index.html'), 'utf8');

/** A record shaped like one the current harness writes, fully priced. */
function pricedRun(overrides = {}) {
  const judgeUsage = {
    model: 'claude-opus-5',
    calls: 3,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estCostUsd: 0.25,
    partial: false,
    uncountedCalls: 0,
    failedCalls: 0,
    byModel: [
      {
        model: 'claude-opus-5',
        calls: 3,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estCostUsd: 0.25
      }
    ],
    byPhase: [{ phase: 'synthesis', calls: 3, inputTokens: 1000, outputTokens: 200 }],
    notes: [],
    ...(overrides.judgeUsage || {})
  };
  return {
    schema: 'fitness-report/1',
    server: { slug: 'fixture-server', url: 'https://fixture.test/mcp', era: 'modern' },
    run: {
      id: 'fixture-server-2026-08-19T00-00-00-000Z',
      startedAt: '2026-08-19T00:00:00.000Z',
      harnessVersion: '0.3.0',
      runnerModel: 'claude-sonnet-5',
      judgeModel: 'claude-opus-5',
      suiteHash: 'abcdef0123456789abcdef0123456789',
      taskBudget: 20000,
      generatorVersion: 'fitness-report-generator/2',
      judgeUsage
    },
    probes: { specCurrency: '2026-07-28', findings: [] },
    gates: { order: [], records: [], extensionPolicy: { extensionSize: 6, maxExtensions: 2 }, refusedAt: null },
    outcome: 'SCORED',
    trace_stats: {
      models: {
        cost: {
          estimated: true,
          currency: 'USD',
          totalUsd: 0.5,
          partial: false,
          unpricedModels: [],
          asOf: '2026-08-19',
          source: 'bundled'
        },
        summary: { assistantTurns: 10 }
      },
      tools: []
    },
    traceLinks: null
  };
}

// ---------------------------------------------------------------------------
// FINDING A: a cost that is known to be incomplete is a floor, not a total
// ---------------------------------------------------------------------------

describe('cost floor labelling', () => {
  it('calls a fully priced run a measured total', () => {
    const cost = runCostOf(pricedRun());
    expect(cost.excluded).toEqual([]);
    expect(cost.complete).toBe(true);
    expect(cost.floor).toBe(false);
    expect(cost.totalUsd).toBeCloseTo(0.75, 10);
    expect(costTotalLine(cost)).toEqual({
      floor: false,
      label: 'measured total',
      value: '$0.7500',
      note: null
    });
  });

  it('labels a partial judge block as a floor and says why', () => {
    const cost = runCostOf(pricedRun({ judgeUsage: { partial: true } }));
    expect(cost.floor).toBe(true);
    expect(cost.complete).toBe(false);
    expect(cost.excluded.join(' ')).toContain('recorded as partial');
    const line = costTotalLine(cost);
    expect(line.label).toBe('measured floor, not a total');
    expect(line.value).toBe('at least $0.7500');
    expect(line.note).toContain('floor rather than a total');
  });

  it('names an unpriced judge model and treats the figure as a floor', () => {
    const run = pricedRun({
      judgeUsage: {
        byModel: [
          { model: 'claude-opus-5', calls: 2, inputTokens: 900, outputTokens: 150, estCostUsd: 0.25 },
          { model: 'claude-mystery-9', calls: 1, inputTokens: 100, outputTokens: 50, estCostUsd: null }
        ]
      }
    });
    const judge = judgeUsageOf(run);
    expect(judge.unpricedModels).toEqual(['claude-mystery-9']);
    expect(judge.floor).toBe(true);
    const cost = runCostOf(run);
    expect(cost.floor).toBe(true);
    expect(cost.excluded.join(' ')).toContain('claude-mystery-9');
    expect(costTotalLine(cost).value).toBe('at least $0.7500');
  });

  it('treats calls that reported no usage, and calls that threw, as floors', () => {
    const uncounted = runCostOf(pricedRun({ judgeUsage: { uncountedCalls: 2 } }));
    expect(uncounted.floor).toBe(true);
    expect(uncounted.excluded.join(' ')).toContain('returned no usage block');

    const threw = runCostOf(pricedRun({ judgeUsage: { failedCalls: 1 } }));
    expect(threw.floor).toBe(true);
    expect(threw.excluded.join(' ')).toContain('threw before reporting usage');
  });

  it('reports no floor reason for a judge block with nothing missing', () => {
    expect(judgeFloorReasons(judgeUsageOf(pricedRun()))).toEqual([]);
    expect(judgeFloorReasons(null)).toEqual([]);
    expect(judgeFloorReasons({ partial: true })).toHaveLength(1);
  });

  it('prints nothing numeric when the record carries no dollars', () => {
    const run = pricedRun();
    delete run.trace_stats;
    delete run.run.judgeUsage;
    const cost = runCostOf(run);
    expect(cost.totalUsd).toBeNull();
    expect(costTotalLine(cost)).toBeNull();
    expect(costTotalLine(null)).toBeNull();
  });

  it('labels every published run that carries dollars as a floor, since none records judge spend', () => {
    const labelled = RUNS.map((run) => costTotalLine(runCostOf(run))).filter((line) => line !== null);
    expect(labelled.length).toBeGreaterThan(0);
    for (const line of labelled) {
      expect(line.floor).toBe(true);
      expect(line.label).toBe('measured floor, not a total');
      expect(line.value.startsWith('at least $')).toBe(true);
    }
    expect(labelled.some((line) => line.label === 'measured total')).toBe(false);
  });

  it('carries the floor up to the masthead figure', () => {
    const stats = boardStats(RUNS);
    expect(stats.floorRuns).toBe(stats.costRuns);
    expect(stats.costIsFloor).toBe(true);
    expect(spendNote(stats)).toContain('floors rather than totals');

    const clean = boardStats([pricedRun()]);
    expect(clean.floorRuns).toBe(0);
    expect(clean.costIsFloor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FINDING B: EXTEND_EXHAUSTED copy is true of both eras, keyed off the record
// ---------------------------------------------------------------------------

/** A record from the current harness: the protocol is stated on the gate. */
function protocolRun(policy, extras = {}) {
  const run = pricedRun();
  run.outcome = extras.outcome || 'GATE_FAILED';
  run.gates = {
    order: ['construct'],
    records: [
      {
        gate: 'construct',
        ok: false,
        costTier: 'paid',
        reason: extras.reason || 'unresolved_after_max_extensions',
        verdict: { outcome: 'EXTEND', k: 10, n: 12, threshold: 0.9, alpha: 0.05, pValue: 0.34 },
        detail: {
          reps: 3,
          extensionsConsumed: extras.consumed ?? 0,
          pooled: { k: 10, n: 12, policy },
          extensions: extras.extensions || [],
          extensionProtocol: 'Extension policy fixed before the first model call.'
        }
      }
    ],
    extensionPolicy: policy,
    refusedAt: 'construct',
    ...(extras.extensions ? { extensions: extras.extensions } : {})
  };
  return run;
}

describe('EXTEND_EXHAUSTED, read against the record that carries it', () => {
  const exhausted = RUNS.filter((run) => run.outcome === 'EXTEND_EXHAUSTED');

  it('finds the published rows that carry the outcome', () => {
    expect(exhausted.length).toBeGreaterThan(0);
  });

  it('describes the outcome in terms that hold with or without an extension protocol', () => {
    const note = OUTCOME_NOTES.EXTEND_EXHAUSTED;
    expect(note).toContain('no extension batch');
    // The old line claimed evidence ran out inside a budget. No published row
    // ever had a budget, and a row that does resolves to FAIL instead.
    expect(note).not.toMatch(/extension budget/i);
  });

  it('reads a published row as a record with no protocol at all', () => {
    for (const run of exhausted) {
      const state = extensionProtocolOf(run);
      expect(state.policy.recorded).toBe(true);
      expect(state.registered).toBe(false);
      expect(state.stated).toBe(false);
      expect(state.consumed).toBe(0);

      const sentence = extensionProtocolSentence(state);
      expect(sentence).toContain('before the extension protocol ran');
      // It must not describe a zero policy this record never registered as a
      // registered choice.
      expect(sentence).not.toMatch(/registered before the first call/);
    }
  });

  it('reads a zero extension pre-registration as the deliberate choice it is', () => {
    const state = extensionProtocolOf(protocolRun({ extensionSize: 0, maxExtensions: 0 }));
    expect(state.stated).toBe(true);
    expect(state.registered).toBe(false);
    const sentence = extensionProtocolSentence(state);
    expect(sentence).toContain('registered before the first call as no extension batch');
    expect(sentence).toContain('EXTEND_EXHAUSTED');
  });

  it('reads a registered protocol as resolving to FAIL, not to EXTEND_EXHAUSTED', () => {
    const state = extensionProtocolOf(protocolRun({ extensionSize: 6, maxExtensions: 2 }, { consumed: 2 }));
    expect(state.registered).toBe(true);
    const sentence = extensionProtocolSentence(state);
    expect(sentence).toContain('resolves to FAIL');
    expect(sentence).toContain('GATE_FAILED');
  });

  it('explains each published row from its own fields, and names no server', () => {
    const slugs = [...new Set(RUNS.map((run) => slugOf(run)))];
    for (const run of exhausted) {
      const lines = exhaustedReading(run);
      expect(lines.length).toBeGreaterThan(2);
      const text = lines.join(' ');
      expect(text).toContain('no extension batch was available to buy');
      expect(text).toContain('before the extension protocol ran');
      expect(text).toContain('GATE_FAILED');
      // Keyed off the row: the generator version it actually carries.
      expect(text).toContain(run.run.generatorVersion);
      for (const slug of slugs) expect(text).not.toContain(slug);
    }
  });

  it('says nothing about extensions for a run that did not carry the outcome', () => {
    expect(exhaustedReading(pricedRun())).toEqual([]);
    expect(exhaustedReading(null)).toEqual([]);
  });

  it('keeps no server list anywhere in the renderer or the markup', () => {
    for (const slug of new Set(RUNS.map((run) => slugOf(run)))) {
      expect(APP_SOURCE).not.toContain(slug);
      expect(INDEX_SOURCE).not.toContain(slug);
    }
  });

  it('states both eras in the methods copy', () => {
    expect(INDEX_SOURCE).toContain('refuses the run as <code>GATE_FAILED</code>');
    expect(INDEX_SOURCE).toContain('a pre-registration that bought no');
    expect(INDEX_SOURCE).toContain('Rows recorded before the extension protocol ran');
    // The old copy presented EXTEND_EXHAUSTED as the ordinary unresolved case.
    expect(INDEX_SOURCE).not.toContain('where the evidence never became decisive inside that budget');
  });
});

// ---------------------------------------------------------------------------
// FINDING C: a batch reports the tasks it recorded, not a pooled trial delta
// ---------------------------------------------------------------------------

/** Six tasks driven at three reps: 6 tasks admitted, 18 trials pooled. */
function extendedRun() {
  const evidence = {
    index: 1,
    gate: 'construct',
    seed: 1042,
    batchSuiteHash: 'ba5eba11ba5eba11',
    taskIds: ['e1-a', 'e1-b', 'e1-c', 'e1-d', 'e1-e', 'e1-f'],
    generated: 8,
    admitted: 6,
    dropped: { nullScreen: 1, answerLeak: 0, admission: 1 },
    short: false,
    pooledBefore: { k: 10, n: 12 },
    pooledAfter: { k: 25, n: 30 },
    verdictBefore: 'EXTEND',
    verdictAfter: 'PASS'
  };
  const run = protocolRun({ extensionSize: 6, maxExtensions: 2 }, {
    consumed: 1,
    extensions: [evidence],
    reason: 'ok'
  });
  run.gates.records[0].ok = true;
  run.gates.records[0].verdict = { outcome: 'PASS', k: 25, n: 30, threshold: 0.9, alpha: 0.05, pValue: 0.02 };
  run.gates.refusedAt = null;
  run.outcome = 'SCORED';
  return run;
}

describe('extension batch arithmetic', () => {
  it('prints the recorded task count, never the pooled trial delta, as tasks', () => {
    const ledger = extensionLedgerOf(extendedRun(), 'construct');
    expect(ledger.consumed).toBe(1);
    expect(ledger.batches[0].admitted).toBe(6);
    // The pool moved by 18 trials across this batch: 30 minus 12.
    expect(ledger.batches[0].n).toBe(18);

    const text = extensionSentences(ledger).join('\n');
    expect(text).toContain('added 6 tasks');
    expect(text).not.toContain('added 18 tasks');
    expect(text).toContain('the gate passed 15 of 18 trials');
    expect(text).toContain('6 tasks contribute 18 trials to the pool');
  });

  it('prints tasks and trials as two figures when they differ', () => {
    const figures = extensionFigures(extensionLedgerOf(extendedRun(), 'construct'));
    const added = figures.find((figure) => figure.label === 'extension 1 tasks added');
    expect(added).toBeDefined();
    expect(added.value).toBe('6 tasks, 18 pooled trials');
  });

  it('collapses to one number when a batch was driven at one rep', () => {
    const run = extendedRun();
    run.gates.extensions[0].admitted = 18;
    run.gates.records[0].detail.extensions[0].admitted = 18;
    const ledger = extensionLedgerOf(run, 'construct');
    const text = extensionSentences(ledger).join('\n');
    expect(text).toContain('added 18 tasks');
    expect(text).not.toContain('contribute 18 trials to the pool');
  });

  it('falls back to the derived delta only when no task count was recorded, and calls it trials', () => {
    const run = extendedRun();
    delete run.gates.extensions[0].admitted;
    delete run.gates.records[0].detail.extensions[0].admitted;
    const ledger = extensionLedgerOf(run, 'construct');
    expect(ledger.batches[0].admitted).toBeNull();
    const text = extensionSentences(ledger).join('\n');
    expect(text).toContain('moved the pool by 18 trials');
    expect(text).not.toMatch(/added \d+ tasks/);
    expect(extensionFigures(ledger).some((figure) => figure.label.endsWith('tasks added'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FINDING D: run identity, and reruns as separate attempts
// ---------------------------------------------------------------------------

describe('run identity across reruns', () => {
  it('reads the identity of a published run from its own record', () => {
    const run = RUNS.find((r) => r.run && typeof r.run.suiteHash === 'string');
    const identity = runIdentityOf(run);
    expect(identity.suitePrefix).toBe(run.run.suiteHash.slice(0, 12));
    expect(identity.startedAt).toBe(run.run.startedAt);
    expect(identity.outcome).toBe(run.outcome);
    const line = runIdentityLine(run);
    expect(line).toContain(identity.suitePrefix);
    expect(line).toContain(identity.startedAt);
  });

  it('says so rather than blanking when a record carries no identity', () => {
    const line = runIdentityLine({ outcome: 'GATE_FAILED', server: { slug: 's' } });
    expect(line).toBe('suite hash not recorded / start time not recorded');
  });

  it('groups every published run under its server without dropping any', () => {
    const cohorts = serverCohorts(RUNS);
    const counted = [...cohorts.values()].reduce((total, cohort) => total + cohort.total, 0);
    expect(counted).toBe(RUNS.length);
    expect(cohorts.size).toBe(new Set(RUNS.map((run) => slugOf(run))).size);
  });

  it('orders a server’s runs oldest first and numbers the attempts', () => {
    const cohorts = serverCohorts(RUNS);
    const reruns = [...cohorts.values()].filter((cohort) => cohort.total > 1);
    expect(reruns.length).toBeGreaterThan(0);
    for (const cohort of reruns) {
      const times = cohort.runs.map((run) => runIdentityOf(run).startedAt);
      expect([...times].sort()).toEqual(times);
      cohort.runs.forEach((run, i) => {
        const place = cohortPlaceOf(cohorts, run);
        expect(place.attempt).toBe(i + 1);
        expect(place.total).toBe(cohort.total);
        expect(place.siblings).toHaveLength(cohort.total - 1);
        // A row can point at the others by suite hash, wherever they sit.
        for (const sibling of place.siblings) {
          expect(sibling.suitePrefix).not.toBe(runIdentityOf(run).suitePrefix);
        }
      });
    }
  });

  it('summarises the reruns in the published data', () => {
    const summary = rerunSummary(RUNS);
    expect(summary.totalServers).toBe(new Set(RUNS.map((run) => slugOf(run))).size);
    expect(summary.servers).toBeGreaterThan(0);
    expect(summary.rows).toBeGreaterThanOrEqual(summary.servers * 2);
    expect(rerunSummary([]).servers).toBe(0);
  });

  it('states in the methods copy that reruns are separate attempts, not a best of', () => {
    expect(INDEX_SOURCE).toContain('More than one run of the same server');
    expect(INDEX_SOURCE).toContain('Reruns are separate attempts, not a best of');
    expect(INDEX_SOURCE).toContain('Inside a run there is no optional stopping');
    // The unqualified claim covered something the harness cannot enforce.
    expect(INDEX_SOURCE).not.toContain('There is no optional stopping here');
  });
});

// ---------------------------------------------------------------------------
// The whole board, rendered against a minimal element shim
// ---------------------------------------------------------------------------

/** Just enough of an element for the renderer: no layout, no events. */
function shimDocument() {
  const createElement = (tag) => {
    const node = {
      tagName: tag,
      className: '',
      children: [],
      attributes: {},
      dataset: {},
      style: { setProperty() {} },
      _text: '',
      get textContent() {
        return this._text + this.children.map((child) => child.textContent).join('');
      },
      set textContent(value) {
        this._text = value === null || value === undefined ? '' : String(value);
        this.children = [];
      },
      classList: {
        add(...names) {
          node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' ');
        },
        toggle(name, on) {
          if (on) this.add(name);
        },
        contains(name) {
          return node.className.split(/\s+/).includes(name);
        }
      },
      appendChild(child) {
        node.children.push(child);
        return child;
      },
      setAttribute(key, value) {
        node.attributes[key] = String(value);
      },
      getAttribute(key) {
        return Object.prototype.hasOwnProperty.call(node.attributes, key) ? node.attributes[key] : null;
      },
      addEventListener() {}
    };
    return node;
  };
  return { createElement };
}

function withShimDocument(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const previous = globalThis.document;
  globalThis.document = shimDocument();
  try {
    return fn(globalThis.document);
  } finally {
    if (had) globalThis.document = previous;
    else delete globalThis.document;
  }
}

/** Every node in the tree, depth first. */
function flatten(node, out = []) {
  out.push(node);
  for (const child of node.children) flatten(child, out);
  return out;
}

describe('the rendered board', () => {
  it('publishes every run, marks the reruns and prints each row’s identity', () => {
    withShimDocument((doc) => {
      const tbody = doc.createElement('tbody');
      renderBoard(tbody, RUNS);
      const nodes = flatten(tbody);
      const rows = nodes.filter((node) => node.className.split(/\s+/).includes('run-row'));
      expect(rows).toHaveLength(RUNS.length);

      // Nothing is hidden: every published run id reaches the page.
      const text = tbody.textContent;
      for (const run of RUNS) {
        expect(text).toContain(run.run.suiteHash.slice(0, 12));
        expect(text).toContain(run.run.startedAt);
      }

      const summary = rerunSummary(RUNS);
      const rerunRows = rows.filter((row) => row.className.split(/\s+/).includes('is-rerun'));
      expect(rerunRows).toHaveLength(summary.rows);
      for (const row of rerunRows) {
        expect(row.textContent).toMatch(/Run \d+ of \d+ for this server/);
        expect(row.textContent).toContain('Other runs of this server, published in full');
      }
      // A row that is the only run of its server claims no attempt number.
      const solo = rows.filter((row) => !row.className.split(/\s+/).includes('is-rerun'));
      expect(solo).toHaveLength(RUNS.length - summary.rows);
      for (const row of solo) expect(row.textContent).not.toMatch(/for this server/);
    });
  });

  it('never prints a measured total for a run whose record cannot support one', () => {
    withShimDocument((doc) => {
      const tbody = doc.createElement('tbody');
      renderBoard(tbody, RUNS);
      const text = tbody.textContent;
      expect(text).toContain('measured floor, not a total');
      expect(text).not.toContain('measured total');
      expect(text).not.toContain('measured, as far as the record goes');
      expect(text).toContain('at least $');
      // One reason is carried on the label itself; several are counted there and
      // named in the list below, so neither form leaves the floor unexplained.
      expect(text).toContain('That figure is a floor rather than a total because');
      expect(text).toContain('things known to sit outside it are named below');
      expect(text).toContain('Outside that figure, named rather than estimated');
    });
  });
});
