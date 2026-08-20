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
  BOARD_ORDER,
  LEDGER_ORDER,
  OUTCOME_NOTES,
  boardOrderLine,
  boardStats,
  cohortPlaceOf,
  costTotalLine,
  decisiveLine,
  exhaustedReading,
  extensionFigures,
  extensionLedgerOf,
  extensionProtocolOf,
  extensionProtocolSentence,
  extensionSentences,
  familyBuckets,
  indexRuns,
  judgeFloorReasons,
  judgeUsageOf,
  methodNotesOf,
  outcomeFamilyOf,
  ownMethodNotes,
  recordIdOf,
  renderBoard,
  renderLedger,
  renderRecord,
  renderStandingNotes,
  rerunSummary,
  routeFromHash,
  runCostOf,
  runIdentityLine,
  runIdentityOf,
  scoredSeparation,
  serverCohorts,
  slugOf,
  spendLine,
  spendNote,
  standingNotes,
  thesisCountLine
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

  it('labels each published run by what its own record supports, floor or total', () => {
    // This used to assert that no published run records judge spend. Records
    // written since then do, so the assertion follows the rule rather than the
    // snapshot: a figure with something known outside it is a floor and says
    // "at least"; a figure with nothing known outside it may be called a total.
    const labelled = RUNS.map((run) => ({ cost: runCostOf(run), line: costTotalLine(runCostOf(run)) })).filter(
      (row) => row.line !== null
    );
    expect(labelled.length).toBeGreaterThan(0);
    let floors = 0;
    for (const { cost, line } of labelled) {
      if (cost.complete) {
        expect(cost.excluded).toEqual([]);
        expect(line.floor).toBe(false);
        expect(line.label).toBe('measured total');
        expect(line.value.startsWith('at least ')).toBe(false);
      } else {
        floors += 1;
        expect(cost.excluded.length).toBeGreaterThan(0);
        expect(line.floor).toBe(true);
        expect(line.label).toBe('measured floor, not a total');
        expect(line.value.startsWith('at least $')).toBe(true);
      }
    }
    // The published data still carries floors, which is what the label exists for.
    expect(floors).toBeGreaterThan(0);
  });

  it('carries the floor up to the board figure whenever any run figure is one', () => {
    const stats = boardStats(RUNS);
    const floors = RUNS.filter((run) => runCostOf(run).floor).length;
    const priced = RUNS.filter((run) => runCostOf(run).totalUsd !== null).length;
    expect(stats.costRuns).toBe(priced);
    expect(stats.floorRuns).toBe(floors);
    // A sum that includes one floor is a floor. It only stops being one when
    // nothing known sits outside any of the figures it is made of.
    expect(stats.costIsFloor).toBe(floors > 0);
    expect(spendNote(stats)).toContain('floors rather than totals');

    const clean = boardStats([pricedRun()]);
    expect(clean.floorRuns).toBe(0);
    expect(clean.costIsFloor).toBe(false);
    expect(spendNote(clean)).not.toContain('floors rather than totals');
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

const hasClass = (node, name) => node.className.split(/\s+/).includes(name);

/** Render the board once and hand back the root plus every node in it. */
function board(doc) {
  const host = doc.createElement('div');
  renderBoard(host, RUNS);
  return { host, nodes: flatten(host) };
}

/** Render every run's record and hand back the roots plus every node in them. */
function everyRecord(doc) {
  const standing = standingNotes(RUNS);
  const cohorts = serverCohorts(RUNS);
  const roots = RUNS.map((run) => {
    const host = doc.createElement('div');
    renderRecord(host, run, { standing, cohort: cohortPlaceOf(cohorts, run) });
    return host;
  });
  const nodes = roots.flatMap((root) => flatten(root));
  return { roots, nodes, text: roots.map((root) => root.textContent).join('\n') };
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
      // The cost block moved out of the board and into the run record, so the
      // assertion follows it and now covers every published run rather than the
      // handful whose panels happened to be built.
      const standing = standingNotes(RUNS);
      let floors = 0;
      let totals = 0;
      for (const run of RUNS) {
        const host = doc.createElement('div');
        renderRecord(host, run, { standing });
        const text = host.textContent;
        const cost = runCostOf(run);
        expect(text).not.toContain('measured, as far as the record goes');
        if (cost.totalUsd === null) {
          expect(text).not.toContain('measured total');
          expect(text).not.toContain('measured floor');
          expect(text).toContain('This record carries no dollars');
          continue;
        }
        if (cost.complete) {
          totals += 1;
          expect(text).toContain('measured total');
          expect(text).not.toContain('at least $');
        } else {
          floors += 1;
          expect(text).toContain('measured floor, not a total');
          expect(text).not.toContain('measured total');
          expect(text).toContain('at least $');
        }
      }
      expect(floors).toBeGreaterThan(0);
      expect(floors + totals).toBe(RUNS.filter((run) => runCostOf(run).totalUsd !== null).length);
    });
  });

  it('explains every floor it prints, either on the label or in the list below it', () => {
    withShimDocument((doc) => {
      const { text } = everyRecord(doc);
      // One reason is carried on the label itself; several are counted there and
      // named in the list below, so neither form leaves the floor unexplained.
      expect(text).toContain('That figure is a floor rather than a total because');
      expect(text).toContain('things known to sit outside it are named below');
      expect(text).toContain('Outside that figure, named rather than estimated');
    });
  });
});

// ---------------------------------------------------------------------------
// FINDING E: the rebuild. A result slot that is never empty, no positions
// anywhere, one addressable record per run, and standing notes published once.
// ---------------------------------------------------------------------------

describe('outcome families, read from the record', () => {
  it('takes the family from the cost tier the record carries, never from a gate name', () => {
    for (const run of RUNS) {
      const family = outcomeFamilyOf(run);
      if (run.outcome === 'SCORED') {
        expect(family.key).toBe('scored');
        continue;
      }
      const records = (run.gates && run.gates.records) || [];
      const record = records.find((r) => r && r.gate === run.gates.refusedAt) || records.find((r) => r && r.ok === false);
      const tier = record && record.costTier;
      expect(family.key).toBe(tier === 'free' || tier === 'cheap' || tier === 'paid' ? tier : 'unclassified');
    }
  });

  it('puts a refusal with no recorded cost tier in its own bucket rather than guessing one', () => {
    const run = { outcome: 'GATE_FAILED', server: { slug: 's' }, gates: { refusedAt: 'construct', records: [{ gate: 'construct', ok: false }] } };
    const family = outcomeFamilyOf(run);
    expect(family.key).toBe('unclassified');
    expect(family.tier).toBeNull();
    expect(family.gateLabel).toBe('construct');
  });

  it('buckets every published run exactly once, in the cost ladder order', () => {
    const buckets = familyBuckets(RUNS, LEDGER_ORDER);
    expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(RUNS.length);
    const keys = buckets.map((bucket) => bucket.key);
    expect(keys).toEqual([...keys].sort((a, b) => LEDGER_ORDER.indexOf(a) - LEDGER_ORDER.indexOf(b)));
    // The board leads with the runs that produced a number, then the same ladder.
    expect(familyBuckets(RUNS, BOARD_ORDER)[0].key).toBe('scored');
    // Every outcome code a bucket reports is one its own runs actually carry.
    for (const bucket of buckets) {
      const counted = bucket.codes.reduce((total, code) => total + code.count, 0);
      expect(counted).toBe(bucket.count);
      for (const code of bucket.codes) {
        expect(bucket.runs.some((run) => run.outcome === code.code)).toBe(true);
      }
    }
  });

  it('counts nothing twice between the ledger and the board', () => {
    const ledger = familyBuckets(RUNS, LEDGER_ORDER).reduce((total, bucket) => total + bucket.count, 0);
    const board = familyBuckets(RUNS, BOARD_ORDER).reduce((total, bucket) => total + bucket.count, 0);
    expect(ledger).toBe(board);
    expect(thesisCountLine(boardStats(RUNS))).toContain(`of ${RUNS.length} published runs`);
  });
});

describe('overlapping intervals are never presented as a ranking', () => {
  it('says nothing separates the scored runs, from the intervals rather than from a chip', () => {
    const separation = scoredSeparation(RUNS);
    expect(separation.rows.length).toBeGreaterThan(1);
    expect(separation.separated).toEqual([]);
    expect(separation.allOverlap).toBe(true);
    expect(separation.line).toContain('Nothing separates');
    expect(separation.line).toContain('overlap');
    // Said above the board, before a reader pays any scrolling for it, and
    // derived from the intervals rather than written into the copy.
    const order = boardOrderLine(RUNS);
    expect(order).toContain('No row on this board takes a position');
    expect(order).toContain('no interval lies entirely above another');
    for (const bucket of familyBuckets(RUNS, BOARD_ORDER)) {
      expect(order).toContain(`${bucket.count} ${bucket.label.toLowerCase()}`);
    }
  });

  it('changes that line, from the data, the moment one interval does separate', () => {
    const scored = RUNS.filter((run) => run.outcome === 'SCORED');
    const low = JSON.parse(JSON.stringify(scored[0]));
    low.server.slug = 'fixture-low';
    low.score.firstTrySuccess = { rate: 0.1, low: 0.02, high: 0.2, k: 1, n: 10 };
    const order = boardOrderLine([scored[0], low]);
    expect(order).toContain('Rows are never ordered by their point estimate');
    expect(order).not.toContain('No row on this board takes a position');
  });

  it('would name the separated pair if one interval ever sat entirely above another', () => {
    const scored = RUNS.filter((run) => run.outcome === 'SCORED');
    const wide = JSON.parse(JSON.stringify(scored[0]));
    wide.server.slug = 'fixture-low';
    wide.score.firstTrySuccess = { rate: 0.1, low: 0.02, high: 0.2, k: 1, n: 10 };
    const separation = scoredSeparation([scored[0], wide]);
    expect(separation.separated).toHaveLength(1);
    expect(separation.allOverlap).toBe(false);
    expect(separation.line).toContain('lies entirely above');
  });

  it('prints no position, rank or medal anywhere on the board', () => {
    withShimDocument((doc) => {
      const { host, nodes } = board(doc);
      const text = host.textContent;
      expect(text).not.toMatch(/\bRank \d/);
      expect(text).not.toMatch(/\bTied at \d/);
      expect(text).not.toContain('Not ranked');
      expect(nodes.some((node) => hasClass(node, 'rank-chip'))).toBe(false);
      // Nor a letter grade, which this page has never published.
      expect(text).not.toMatch(/\bgrade [A-F]\b/i);
    });
  });
});

describe('the result well', () => {
  it('gives every run a result slot, and never an empty one', () => {
    withShimDocument((doc) => {
      const { nodes } = board(doc);
      const wells = nodes.filter((node) => hasClass(node, 'well'));
      expect(wells).toHaveLength(RUNS.length);
      for (const well of wells) {
        expect(hasClass(well, 'is-measured') || hasClass(well, 'is-hold')).toBe(true);
        expect(well.textContent.trim().length).toBeGreaterThan(0);
      }
      const measured = wells.filter((well) => hasClass(well, 'is-measured'));
      expect(measured).toHaveLength(RUNS.filter((run) => run.outcome === 'SCORED').length);
    });
  });

  it('sets the outcome code into the hold, at the same weight a number would have', () => {
    withShimDocument((doc) => {
      const { nodes } = board(doc);
      const codes = nodes.filter((node) => hasClass(node, 'well-code')).map((node) => node.textContent);
      const refused = RUNS.filter((run) => run.outcome !== 'SCORED');
      expect(codes).toHaveLength(refused.length);
      for (const run of refused) expect(codes).toContain(run.outcome);
    });
  });

  it('keeps the point marker inside the track at a rate of 1.0', () => {
    // The marker is placed at rate * (track width minus its own width), so the
    // top row cannot hang outside the axis it is measured against.
    const css = readFileSync(here('../site/style.css'), 'utf8');
    expect(css).toContain('left: calc(var(--rate) * (100% - 3px))');
    expect(css).toContain('overflow: hidden');
  });
});

describe('one addressable record per run', () => {
  it('gives every run a unique, url safe key', () => {
    const index = indexRuns(RUNS);
    expect(index.size).toBe(RUNS.length);
    for (const key of index.byId.keys()) {
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(routeFromHash(`#run/${encodeURIComponent(key)}`)).toBe(key);
    }
    for (const run of RUNS) expect(index.byId.get(index.keyFor(run))).toBe(run);
  });

  it('suffixes rather than collapses when two records would claim one key', () => {
    const twin = { outcome: 'SCORED', server: { slug: 'twin' }, run: { id: 'same-id' } };
    const other = { outcome: 'SCORED', server: { slug: 'twin' }, run: { id: 'same-id' } };
    const index = indexRuns([twin, other]);
    expect(index.size).toBe(2);
    expect(index.keyFor(twin)).not.toBe(index.keyFor(other));
  });

  it('falls back to the server and suite when a record carries no run id', () => {
    expect(recordIdOf({ server: { slug: 'a-server' }, run: { suiteHash: 'abcdef0123456789' } })).toBe('a-server-abcdef012345');
    expect(recordIdOf({ server: { slug: 'a-server' } })).toBe('a-server-no-suite');
  });

  it('reads only its own route', () => {
    expect(routeFromHash('#run/abc')).toBe('abc');
    expect(routeFromHash('#methods-interval')).toBeNull();
    expect(routeFromHash('')).toBeNull();
    expect(routeFromHash(null)).toBeNull();
  });

  it('links every board row to its own record and to its own recording', () => {
    withShimDocument((doc) => {
      const { nodes } = board(doc);
      const index = indexRuns(RUNS);
      const opens = nodes.filter((node) => hasClass(node, 'act-record'));
      expect(opens).toHaveLength(RUNS.length);
      const keys = [...index.byId.keys()];
      for (const open of opens) expect(keys).toContain(open.getAttribute('data-record'));
      // Rows whose run published no tape say so where the link would be.
      const replays = nodes.filter((node) => hasClass(node, 'act-replay'));
      const missing = nodes.filter((node) => node.textContent === 'no tape published');
      expect(replays.length + missing.length).toBe(RUNS.length);
    });
  });
});

describe('the run record', () => {
  it('leads with the comparison that decided the run, then the audit trail', () => {
    withShimDocument((doc) => {
      const standing = standingNotes(RUNS);
      for (const run of RUNS) {
        const host = doc.createElement('div');
        renderRecord(host, run, { standing });
        const nodes = flatten(host);
        const tiers = nodes.filter((node) => hasClass(node, 'tier'));
        expect(hasClass(tiers[0], 'tier-1')).toBe(true);
        expect(tiers[0].textContent).toContain('The comparison that decided this run');
        expect(tiers[0].textContent).toContain(run.outcome);
        // The gate ledger is the audit trail and never the explanation, so it
        // sits below the tier that carries the finding.
        const ledgerIndex = tiers.findIndex((tier) => tier.textContent.includes('Gate ledger'));
        expect(ledgerIndex).toBeGreaterThan(0);
      }
    });
  });

  it('names the gate in place of the number on every refused record', () => {
    withShimDocument((doc) => {
      const standing = standingNotes(RUNS);
      for (const run of RUNS.filter((r) => r.outcome !== 'SCORED')) {
        const host = doc.createElement('div');
        renderRecord(host, run, { standing });
        expect(host.textContent).toContain('Stopped at the');
        expect(host.textContent).toContain(run.outcome);
      }
    });
  });

  it('carries a way out at the end as well as at the top', () => {
    withShimDocument((doc) => {
      const host = doc.createElement('div');
      renderRecord(host, RUNS[0], {});
      const closers = flatten(host).filter((node) => node.getAttribute('data-close-record') === 'true');
      expect(closers.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('gives every evidence link an accessible name that says which run it belongs to', () => {
    withShimDocument((doc) => {
      const { nodes } = everyRecord(doc);
      const links = nodes.filter((node) => hasClass(node, 'evidence') && !hasClass(node, 'is-missing'));
      expect(links.length).toBeGreaterThan(20);
      const names = new Set();
      for (const node of links) {
        const label = node.getAttribute('aria-label');
        expect(label).toBeTruthy();
        expect(label).toContain('Opens the recorded session in a new tab');
        names.add(label);
      }
      // Not one name, repeated. Each says which run, and which finding.
      expect(names.size).toBeGreaterThan(20);
    });
  });

  it('renders nothing at all for a field a record does not carry', () => {
    withShimDocument((doc) => {
      const bare = JSON.parse(JSON.stringify(RUNS.find((run) => run.outcome !== 'SCORED')));
      delete bare.traceLinks;
      delete bare.probes;
      const host = doc.createElement('div');
      renderRecord(host, bare, {});
      const text = host.textContent;
      expect(text).toContain('no recording published');
      expect(text).toContain('no probes recorded for this run');
      // Absent is absent: no zero, no placeholder figure, no invented dash.
      expect(text).not.toContain('$0.0000');
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('NaN');
    });
  });
});

describe('standing method notes, published once', () => {
  it('finds only notes that every run of a generator carries', () => {
    const standing = standingNotes(RUNS);
    expect(standing.size).toBeGreaterThan(0);
    for (const [generator, entry] of standing) {
      const group = RUNS.filter((run) => (run.run && run.run.generatorVersion) || 'unrecorded generator' === generator
        ? ((run.run && run.run.generatorVersion) || 'unrecorded generator') === generator
        : false);
      for (const note of entry.notes) {
        for (const run of group) expect(methodNotesOf(run)).toContain(note);
      }
    }
  });

  it('publishes nothing as standing when a generator has only one run', () => {
    const single = [RUNS.find((run) => run.outcome === 'SCORED')];
    const standing = standingNotes(single);
    expect([...standing.values()][0].notes).toEqual([]);
    expect(ownMethodNotes(single[0], standing).own).toEqual(methodNotesOf(single[0]));
  });

  it('loses no note: own plus standing is always the run’s whole methods block', () => {
    const standing = standingNotes(RUNS);
    let saved = 0;
    for (const run of RUNS) {
      const own = ownMethodNotes(run, standing);
      expect(own.own.length + own.standing).toBe(own.total);
      expect(own.total).toBe(methodNotesOf(run).length);
      saved += own.standing;
    }
    // This is the 80,000 pixel fix: the same paragraphs stop being printed once
    // per run, and every one of them is still published.
    expect(saved).toBeGreaterThan(50);
  });

  it('publishes the standing notes verbatim, once, under Methods', () => {
    withShimDocument((doc) => {
      const host = doc.createElement('div');
      renderStandingNotes(host, RUNS);
      const text = host.textContent;
      for (const entry of standingNotes(RUNS).values()) {
        for (const note of entry.notes) expect(text).toContain(note);
      }
    });
  });

  it('tells a record how many standing notes it also carries, and where they are', () => {
    withShimDocument((doc) => {
      const standing = standingNotes(RUNS);
      const run = RUNS.find((r) => ownMethodNotes(r, standing).standing > 0);
      const host = doc.createElement('div');
      renderRecord(host, run, { standing });
      expect(host.textContent).toContain('records on every one of its runs');
      expect(host.textContent).toContain('Recorded on every run');
    });
  });
});

describe('the ledger and the spend disclosure', () => {
  it('renders one cell per family, with counts that add up to the published runs', () => {
    withShimDocument((doc) => {
      const host = doc.createElement('div');
      renderLedger(host, RUNS);
      const cells = flatten(host).filter((node) => hasClass(node, 'ledger-cell'));
      expect(cells).toHaveLength(familyBuckets(RUNS, LEDGER_ORDER).length);
      const counts = flatten(host)
        .filter((node) => hasClass(node, 'cell-count'))
        .map((node) => Number(node.textContent));
      expect(counts.reduce((total, n) => total + n, 0)).toBe(RUNS.length);
    });
  });

  it('gives every published run a tick that opens its record', () => {
    withShimDocument((doc) => {
      const host = doc.createElement('div');
      renderLedger(host, RUNS);
      const ticks = flatten(host).filter((node) => hasClass(node, 'tick'));
      expect(ticks).toHaveLength(RUNS.length);
      const keys = [...indexRuns(RUNS).byId.keys()];
      for (const tick of ticks) {
        expect(keys).toContain(tick.getAttribute('data-record'));
        expect(tick.getAttribute('aria-label')).toContain('Open the run record');
      }
    });
  });

  it('states the spend as a floor and links to what sits outside it', () => {
    const line = spendLine(boardStats(RUNS));
    expect(line.floor).toBe(true);
    expect(line.figure.startsWith('at least $')).toBe(true);
    expect(line.tail).toContain('not recorded');
    withShimDocument((doc) => {
      const host = doc.createElement('div');
      renderLedger(host, RUNS);
      const floor = flatten(host).find((node) => hasClass(node, 'spend-floor'));
      expect(floor.textContent).toBe('a floor');
      expect(floor.href).toBe('#methods-not-in-numbers');
    });
  });

  it('publishes no figure at all when no record carries dollars', () => {
    const bare = RUNS.map((run) => {
      const copy = JSON.parse(JSON.stringify(run));
      delete copy.trace_stats;
      if (copy.run) delete copy.run.judgeUsage;
      return copy;
    });
    const line = spendLine(boardStats(bare));
    expect(line.figure).toBeNull();
    expect(line.tail).toContain('publishes no spend figure');
  });
});

describe('the board is one row per run, with no expandable panels', () => {
  it('builds no details, no toggles and no hidden panels', () => {
    withShimDocument((doc) => {
      const { nodes } = board(doc);
      expect(nodes.some((node) => node.tagName === 'details')).toBe(false);
      expect(nodes.some((node) => node.tagName === 'button')).toBe(false);
      expect(nodes.some((node) => node.hidden === true)).toBe(false);
      // The whole board, including every row's identity and decisive number, is
      // now a fraction of what one expanded panel used to carry.
      expect(nodes.filter((node) => hasClass(node, 'rec')).length).toBe(RUNS.length);
    });
  });

  it('prints the decisive number on the row, which is what the toggle was for', () => {
    withShimDocument((doc) => {
      const { nodes } = board(doc);
      const rows = nodes.filter((node) => hasClass(node, 'run-row'));
      let withNumber = 0;
      for (const run of RUNS) if (decisiveLine(run) !== null) withNumber += 1;
      expect(withNumber).toBeGreaterThan(RUNS.length / 2);
      for (const run of RUNS) {
        const line = decisiveLine(run);
        if (line === null) continue;
        expect(rows.some((row) => row.textContent.includes(line))).toBe(true);
      }
    });
  });

  it('carries the cohort on every row, so no two generators read as one comparison', () => {
    withShimDocument((doc) => {
      const { nodes } = board(doc);
      const rows = nodes.filter((node) => hasClass(node, 'run-row'));
      for (let i = 0; i < RUNS.length; i++) {
        const run = RUNS[i];
        const version = (run.run && run.run.generatorVersion) || null;
        const row = rows.find((r) => r.dataset.server === slugOf(run) && r.textContent.includes(runIdentityLine(run)));
        expect(row).toBeDefined();
        expect(row.textContent).toContain(version || 'generator not recorded');
        expect(row.textContent).toContain(run.run.runnerModel);
      }
    });
  });
});
