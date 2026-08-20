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
  VIEWER_BASE,
  boardOrderLine,
  boardStats,
  buildViewerUrl,
  cohortPlaceOf,
  corrForTask,
  correlationIdsOf,
  costTotalLine,
  decisiveLine,
  exhaustedReading,
  extensionFigures,
  extensionLedgerOf,
  extensionProtocolOf,
  extensionProtocolSentence,
  extensionSentences,
  familyBuckets,
  focusUrlOf,
  gateFocusCorr,
  hasFrameLinks,
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
  replayUrlOf,
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
  taskIdsNamedIn,
  taskIdsOf,
  thesisCountLine,
  toolTaskAttribution,
  traceParamOf,
  traceUrlsOf,
  viewerBaseOf
} from '../site/app.js';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const RUNS = JSON.parse(readFileSync(here('../site/data/runs.json'), 'utf8'));
const APP_SOURCE = readFileSync(here('../site/app.js'), 'utf8');
const INDEX_SOURCE = readFileSync(here('../site/index.html'), 'utf8');
const METHODS_SOURCE = readFileSync(here('../site/methods.html'), 'utf8');

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

// ---------------------------------------------------------------------------
// FINDING F: a finding opens on its own frames, or it opens the whole run and
// says so. Never on a correlation this page had to invent.
//
// The viewer takes a correlation id and opens the merged tapes on the frames
// stamped with it. Our tapes stamp corr_id on every line: the scored drive
// stamps the bare task id, the construct reference pass and the null baselines
// stamp <taskId>::<phase>. These tests hold the three rules that keep that
// honest: the url is built from the run's own record, the encoding survives a
// round trip, and an id the record does not carry never reaches the DOM.
// ---------------------------------------------------------------------------

const TAPE_HOST = 'https://tapes.fixture.test';

/** A scored run that published two planes, with tasks and tools to link. */
function linkedRun() {
  const run = pricedRun();
  run.traceLinks = {
    mcp: `${TAPE_HOST}/traces/fixture/mcp.jsonl`,
    agent: `${TAPE_HOST}/traces/fixture/agent.jsonl`,
    viewer: 'https://replay.fixture.test/?trace=whatever#view=calls'
  };
  run.score = {
    runnerModel: 'claude-sonnet-5',
    firstTrySuccess: { rate: 0.5, low: 0.2, high: 0.8, k: 1, n: 2 },
    eventualSuccess: { rate: 0.5, low: 0.2, high: 0.8, k: 1, n: 2 },
    meanCallsPerCompletedTask: 2,
    meanTokensPerCompletedTask: 120,
    meanCostPerCompletedTaskUsd: 0.001,
    tools: [
      {
        tool: 'search',
        calls: 3,
        errors: 1,
        failureClasses: { 'execution-error-fatal': 1 },
        p50Ms: 10,
        p95Ms: 20,
        declaredDestructive: false,
        inferredDestructive: null
      },
      {
        tool: 'fetch',
        calls: 2,
        errors: 0,
        failureClasses: {},
        p50Ms: 5,
        p95Ms: 7,
        declaredDestructive: false,
        inferredDestructive: null
      }
    ],
    tasks: [
      {
        taskId: 'alpha-task',
        firstTrySuccess: true,
        success: true,
        toolCalls: 1,
        mrtrRounds: 0,
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.001,
        failure: null,
        destructiveWithoutConfirmation: 0
      },
      {
        taskId: 'beta-task',
        firstTrySuccess: false,
        success: false,
        toolCalls: 3,
        mrtrRounds: 1,
        inputTokens: 300,
        outputTokens: 50,
        costUsd: 0.004,
        failure: 'execution-error-fatal',
        destructiveWithoutConfirmation: 0
      }
    ],
    destructiveWithoutConfirmation: 0,
    ambiguousParameters: [],
    schemaDrift: { checked: true, drifted: false, detail: null },
    toolSurfaceDeltaByCredential: null
  };
  return run;
}

/** Every anchor in a tree that this page focused on one correlation id. */
function focusedLinks(root) {
  return flatten(root).filter((node) => hasClass(node, 'is-focused'));
}

/** The corr parameter of a focused link, decoded. */
function corrOf(href) {
  const hash = String(href).split('#')[1] || '';
  const match = hash.split('&').find((part) => part.startsWith('corr='));
  return match ? decodeURIComponent(match.slice('corr='.length)) : null;
}

/** The trace parameter of a link, split on the viewer's merge separator. */
function tracesOf(href) {
  const query = String(href).split('#')[0].split('?')[1] || '';
  const match = query.split('&').find((part) => part.startsWith('trace='));
  if (!match) return [];
  return match
    .slice('trace='.length)
    .split(';')
    .map((part) => decodeURIComponent(part));
}

describe('the deep link url, built from the run and nothing else', () => {
  it('carries both planes, the events view and the correlation id', () => {
    const run = linkedRun();
    const url = focusUrlOf(run, 'alpha-task');
    expect(url).toBe(
      'https://replay.fixture.test/?trace=' +
        `${encodeURIComponent(`${TAPE_HOST}/traces/fixture/mcp.jsonl`)};` +
        `${encodeURIComponent(`${TAPE_HOST}/traces/fixture/agent.jsonl`)}` +
        '#view=events&corr=alpha-task'
    );
  });

  it('takes the viewer from the record, never from a host written into this page', () => {
    const run = linkedRun();
    // This record was published against a different viewer, and its links stay
    // on that viewer.
    expect(viewerBaseOf(run)).toBe('https://replay.fixture.test/');
    expect(focusUrlOf(run, 'alpha-task').startsWith('https://replay.fixture.test/')).toBe(true);
    // With no recorded viewer the module constant is the fallback, and it is
    // the only place a viewer host appears at all.
    delete run.traceLinks.viewer;
    expect(viewerBaseOf(run)).toBe(VIEWER_BASE);
    expect(focusUrlOf(run, 'alpha-task').startsWith(VIEWER_BASE)).toBe(true);
  });

  it('takes the tapes from the record, so no link is ever assembled from a guessed path', () => {
    const run = linkedRun();
    run.traceLinks.mcp = 'https://elsewhere.test/a/mcp.jsonl';
    run.traceLinks.agent = 'https://elsewhere.test/a/agent.jsonl';
    expect(tracesOf(focusUrlOf(run, 'alpha-task'))).toEqual([
      'https://elsewhere.test/a/mcp.jsonl',
      'https://elsewhere.test/a/agent.jsonl'
    ]);
  });

  it('percent encodes both halves so the viewer reads back exactly what was published', () => {
    const run = linkedRun();
    const url = focusUrlOf(run, 'alpha-task');
    // The tape urls are encoded: their own separators cannot be read as ours.
    expect(url).toContain(encodeURIComponent(`${TAPE_HOST}/traces/fixture/mcp.jsonl`));
    expect(url).not.toContain(`${TAPE_HOST}/traces/fixture/mcp.jsonl`);
    expect(tracesOf(url)).toEqual([
      `${TAPE_HOST}/traces/fixture/mcp.jsonl`,
      `${TAPE_HOST}/traces/fixture/agent.jsonl`
    ]);
    // A phase stamped id survives the round trip with its separator intact.
    run.gates.records = [{ gate: 'construct', ok: true, costTier: 'paid', reason: 'ok', detail: { n: 2 } }];
    const phased = focusUrlOf(run, 'alpha-task::construct');
    expect(phased).toContain('corr=alpha-task%3A%3Aconstruct');
    expect(corrOf(phased)).toBe('alpha-task::construct');
  });

  it('survives the same url parsing the DOM will do to it', () => {
    const run = linkedRun();
    const url = focusUrlOf(run, 'alpha-task');
    // Every link on this page goes through safeUrl, which round trips through
    // URL. A link that normalises to something else would be a different link.
    expect(new URL(url).href).toBe(url);
  });
});

describe('the semicolon is the viewer separator, so a tape url that holds one is refused', () => {
  it('drops the plane that carries it and keeps the plane that does not', () => {
    const run = linkedRun();
    run.traceLinks.mcp = `${TAPE_HOST}/traces/fixture;odd/mcp.jsonl`;
    expect(traceUrlsOf(run)).toEqual([`${TAPE_HOST}/traces/fixture/agent.jsonl`]);
    const url = focusUrlOf(run, 'alpha-task');
    expect(tracesOf(url)).toEqual([`${TAPE_HOST}/traces/fixture/agent.jsonl`]);
    expect(url).not.toContain('fixture;odd');
  });

  it('refuses the link outright when every published plane carries one', () => {
    const run = linkedRun();
    run.traceLinks.mcp = `${TAPE_HOST}/a;b/mcp.jsonl`;
    run.traceLinks.agent = `${TAPE_HOST}/a;b/agent.jsonl`;
    expect(traceUrlsOf(run)).toEqual([]);
    expect(traceParamOf(run)).toBeNull();
    expect(focusUrlOf(run, 'alpha-task')).toBeNull();
    expect(buildViewerUrl(run.traceLinks.mcp, run.traceLinks.agent)).toBeNull();
  });

  it('escapes nothing to get around it, because an escaped separator is a different tape url', () => {
    const run = linkedRun();
    run.traceLinks.mcp = `${TAPE_HOST}/a;b/mcp.jsonl`;
    const url = focusUrlOf(run, 'alpha-task');
    expect(url).not.toContain('%3B');
    expect(url).not.toContain(';b');
  });

  it('renders no link at all rather than a dead one when a run published no tapes', () => {
    withShimDocument((doc) => {
      const run = linkedRun();
      run.traceLinks = null;
      expect(focusUrlOf(run, 'alpha-task')).toBeNull();
      expect(replayUrlOf(run)).toBeNull();
      expect(hasFrameLinks(run)).toBe(false);
      const host = doc.createElement('div');
      renderRecord(host, run, {});
      const anchors = flatten(host).filter((node) => typeof node.href === 'string');
      expect(anchors.some((node) => node.href.includes('view=events'))).toBe(false);
      expect(host.textContent).toContain('no recording published');
      // The legend explains a mark. With no mark to explain it is not printed.
      expect(host.textContent).not.toContain('opens the recording on that finding');
    });
  });
});

describe('a correlation id is emitted only where the record carries it', () => {
  it('refuses an id this record does not name', () => {
    const run = linkedRun();
    expect(taskIdsOf(run)).toEqual(['alpha-task', 'beta-task']);
    expect(focusUrlOf(run, 'ghost-task')).toBeNull();
    expect(focusUrlOf(run, 'alpha-task::construct')).toBeNull();
    expect(focusUrlOf(run, '')).toBeNull();
    expect(focusUrlOf(run, null)).toBeNull();
  });

  it('stamps a phase only where the record shows that pass ran for that task', () => {
    const run = linkedRun();
    // No construct record: nothing on this page knows a reference pass ran.
    expect(correlationIdsOf(run).has('alpha-task::construct')).toBe(false);
    run.gates.records = [{ gate: 'construct', ok: true, costTier: 'paid', reason: 'ok', detail: { n: 2 } }];
    expect(correlationIdsOf(run).has('alpha-task::construct')).toBe(true);
    expect(corrForTask(run, 'alpha-task', 'construct')).toBe('alpha-task::construct');
    // A phase the record does not evidence falls back to the bare drive id.
    expect(corrForTask(run, 'alpha-task', 'null-no-tools')).toBe('alpha-task');
    expect(corrForTask(run, 'ghost-task', 'construct')).toBeNull();
  });

  it('never puts an unknown correlation in the DOM, across every published run', () => {
    withShimDocument((doc) => {
      const { roots } = everyRecord(doc);
      let focused = 0;
      for (let i = 0; i < roots.length; i++) {
        const known = correlationIdsOf(RUNS[i]);
        const published = new Set(traceUrlsOf(RUNS[i]));
        for (const node of focusedLinks(roots[i])) {
          focused += 1;
          const corr = corrOf(node.href);
          expect(corr).toBeTruthy();
          expect(known.has(corr)).toBe(true);
          // And the frames it opens are this run's own tapes, nobody else's.
          for (const trace of tracesOf(node.href)) expect(published.has(trace)).toBe(true);
        }
      }
      expect(focused).toBeGreaterThan(50);
    });
  });
});

describe('per task rows open on their own frames', () => {
  const scored = RUNS.filter((run) => run.outcome === 'SCORED');

  it('finds published runs that carry tasks', () => {
    expect(scored.length).toBeGreaterThan(0);
  });

  it('gives every task of every scored run a row and a link keyed to that task', () => {
    withShimDocument((doc) => {
      for (const run of scored) {
        const host = doc.createElement('div');
        renderRecord(host, run, {});
        const text = host.textContent;
        const corrs = new Set(focusedLinks(host).map((node) => corrOf(node.href)));
        for (const task of run.score.tasks) {
          expect(text).toContain(task.taskId);
          expect(corrs.has(task.taskId)).toBe(true);
        }
      }
    });
  });

  it('says the run was refused before the drive instead of printing an empty table', () => {
    withShimDocument((doc) => {
      const run = RUNS.find((r) => r.outcome !== 'SCORED');
      const host = doc.createElement('div');
      renderRecord(host, run, {});
      expect(host.textContent).toContain('no per task rows exist for a run that was refused before the drive');
    });
  });
});

describe('per tool rows pin a task only where the record forces the pairing', () => {
  it('pins the tool that is the only one to have recorded the class a task failed with', () => {
    const attribution = toolTaskAttribution(linkedRun());
    expect(attribution.get('search').ids).toEqual(['beta-task']);
    expect(attribution.get('search').why).toContain('only tool that recorded execution-error-fatal');
    // The tool with no failures of its own is not pinned to anything.
    expect(attribution.has('fetch')).toBe(false);
  });

  it('pins neither tool when two of them recorded the same class', () => {
    const run = linkedRun();
    run.score.tools[1].failureClasses = { 'execution-error-fatal': 1 };
    run.score.tools[1].errors = 1;
    expect(toolTaskAttribution(run).size).toBe(0);
  });

  it('takes the record at its word when the tool row names its own tasks', () => {
    const run = linkedRun();
    run.score.tools[1].taskIds = ['alpha-task', 'ghost-task'];
    const pinned = toolTaskAttribution(run).get('fetch');
    // The named id that this record does not carry is dropped, not linked.
    expect(pinned.ids).toEqual(['alpha-task']);
  });

  it('leaves an unpinned row on the run and says why, rather than borrowing a correlation', () => {
    withShimDocument((doc) => {
      const host = doc.createElement('div');
      renderRecord(host, linkedRun(), {});
      const text = host.textContent;
      expect(text).toContain('this record does not say which tasks called it');
      expect(text).toContain('a correlation this page had to guess at is not evidence');
    });
  });

  it('holds on the published data: two runs force a pairing, the rest stay on the run', () => {
    const pinned = RUNS.filter((run) => toolTaskAttribution(run).size > 0);
    expect(pinned.length).toBeGreaterThan(0);
    for (const run of pinned) {
      const known = new Set(taskIdsOf(run));
      for (const [, entry] of toolTaskAttribution(run)) {
        expect(entry.ids.length).toBeGreaterThan(0);
        for (const id of entry.ids) expect(known.has(id)).toBe(true);
      }
    }
    // Every tool row that was not forced is still a link, to the whole run.
    for (const run of RUNS.filter((r) => r.outcome === 'SCORED')) {
      const attribution = toolTaskAttribution(run);
      for (const tool of run.score.tools) {
        if (attribution.has(tool.tool)) continue;
        expect(replayUrlOf(run)).toBeTruthy();
      }
    }
  });
});

describe('gate rows link a phase the tape carries, or nothing at all', () => {
  it('opens on the task a gate record names, stamped with that gate own phase', () => {
    const run = linkedRun();
    const construct = { gate: 'construct', ok: false, costTier: 'paid', reason: 'below_threshold', detail: { n: 2, taskId: 'beta-task' } };
    run.gates.records = [construct];
    expect(gateFocusCorr(run, construct)).toBe('beta-task::construct');
  });

  it('falls back to the bare drive id for a gate whose pass stamps no phase', () => {
    const run = linkedRun();
    const leak = { gate: 'answer_leak', ok: false, costTier: 'free', reason: 'leak', detail: { leaks: [{ taskId: 'alpha-task' }] } };
    run.gates.records = [leak];
    expect(gateFocusCorr(run, leak)).toBe('alpha-task');
  });

  it('resolves a null baseline row only when it names both the baseline and the task', () => {
    const run = linkedRun();
    const named = {
      gate: 'null_baseline',
      ok: false,
      costTier: 'cheap',
      reason: 'noise_exceeds_signal',
      detail: { rates: [{ label: 'no-tools', taskId: 'alpha-task', k: 1, n: 2, rate: 0.5 }] }
    };
    run.gates.records = [named];
    expect(gateFocusCorr(run, named)).toBe('alpha-task::null-no-tools');
    // The published shape names the baseline and no task, which is not a
    // correlation, so the row keeps the whole run.
    const unnamed = {
      gate: 'null_baseline',
      ok: false,
      costTier: 'cheap',
      reason: 'noise_exceeds_signal',
      detail: { rates: [{ label: 'no-tools', k: 1, n: 2, rate: 0.5 }] }
    };
    run.gates.records = [unnamed];
    expect(gateFocusCorr(run, unnamed)).toBeNull();
  });

  it('invents nothing for a gate that names a task this record does not carry', () => {
    const run = linkedRun();
    const record = { gate: 'construct', ok: false, costTier: 'paid', reason: 'x', detail: { n: 2, taskId: 'ghost-task' } };
    run.gates.records = [record];
    expect(gateFocusCorr(run, record)).toBeNull();
  });

  it('leaves every published gate row on the run, because none of them names a task', () => {
    for (const run of RUNS) {
      for (const record of (run.gates && run.gates.records) || []) {
        expect(gateFocusCorr(run, record)).toBeNull();
      }
    }
  });
});

describe('extension batches open task by task', () => {
  const extended = RUNS.filter((run) => Array.isArray(run.gates && run.gates.extensions) && run.gates.extensions.length > 0);

  it('finds a published run that bought batches', () => {
    expect(extended.length).toBeGreaterThan(0);
  });

  it('links every pooled task id a batch bought, on the reference pass phase', () => {
    withShimDocument((doc) => {
      for (const run of extended) {
        const host = doc.createElement('div');
        renderRecord(host, run, {});
        const corrs = new Set(focusedLinks(host).map((node) => corrOf(node.href)));
        for (const batch of run.gates.extensions) {
          for (const id of batch.taskIds || []) {
            expect(corrs.has(`${id}::construct`)).toBe(true);
          }
        }
      }
    });
  });

  it('carries the pooled task ids onto the ledger so the fold can link them', () => {
    const ledger = extensionLedgerOf(extendedRun(), 'construct');
    expect(ledger.batches[0].taskIds).toEqual(['e1-a', 'e1-b', 'e1-c', 'e1-d', 'e1-e', 'e1-f']);
  });

  it('prints the task names, not a row of dead markers, when the run published no tape', () => {
    withShimDocument((doc) => {
      const run = extendedRun();
      run.traceLinks = null;
      const host = doc.createElement('div');
      renderRecord(host, run, {});
      expect(focusedLinks(host)).toHaveLength(0);
      // The batch still names what it bought, so the ledger stays readable.
      for (const id of run.gates.extensions[0].taskIds) expect(host.textContent).toContain(id);
    });
  });

  it('links the task a free gate violation names, and prints a named task it cannot place', () => {
    withShimDocument((doc) => {
      const run = extendedRun();
      run.traceLinks = {
        mcp: `${TAPE_HOST}/traces/extended/mcp.jsonl`,
        agent: `${TAPE_HOST}/traces/extended/agent.jsonl`,
        viewer: null
      };
      run.gates.extensions[0].violations = [
        { gate: 'answer_leak', taskId: 'e1-c', reason: 'leak', detail: 'the prompt carried the answer' },
        { gate: 'answer_leak', taskId: 'never-generated', reason: 'leak', detail: 'names a task this record does not carry' }
      ];
      run.gates.records[0].detail.extensions = run.gates.extensions;
      const host = doc.createElement('div');
      renderRecord(host, run, {});
      const corrs = new Set(focusedLinks(host).map((node) => corrOf(node.href)));
      expect(corrs.has('e1-c::construct')).toBe(true);
      expect([...corrs].some((corr) => String(corr).startsWith('never-generated'))).toBe(false);
      // Named and unplaceable is printed, so the violation is not silently lost.
      expect(host.textContent).toContain('never-generated');
    });
  });
});

describe('findings that name their evidence in prose', () => {
  it('opens an ambiguous parameter on the tasks its evidence string names', () => {
    withShimDocument((doc) => {
      const run = linkedRun();
      run.score.ambiguousParameters = [
        { tool: 'search', param: 'user', why: 'user_id is the fix', evidence: 'wrong argument on beta-task' },
        { tool: 'fetch', param: 'id', why: 'ambiguous', evidence: 'seen across the drive' }
      ];
      const host = doc.createElement('div');
      renderRecord(host, run, {});
      const corrs = new Set(focusedLinks(host).map((node) => corrOf(node.href)));
      expect(corrs.has('beta-task')).toBe(true);
      expect(host.textContent).toContain('wrong argument on beta-task');
      // The second names nothing, so it keeps the run level link.
      expect(host.textContent).toContain('seen across the drive');
    });
  });

  it('opens a rewrite on the sessions its causal evidence names', () => {
    withShimDocument((doc) => {
      const run = linkedRun();
      run.rewrites = [
        {
          tool: 'search',
          current: 'search things',
          proposed: 'search the docs index by query',
          causalEvidence: 'caused the wrong tool choice on alpha-task and beta-task'
        }
      ];
      const host = doc.createElement('div');
      renderRecord(host, run, {});
      const corrs = new Set(focusedLinks(host).map((node) => corrOf(node.href)));
      expect(corrs.has('alpha-task')).toBe(true);
      expect(corrs.has('beta-task')).toBe(true);
    });
  });

  it('matches a whole task id and never a fragment of a longer one', () => {
    const run = linkedRun();
    run.score.tasks.push({
      taskId: 'alpha-task-two',
      firstTrySuccess: true,
      success: true,
      toolCalls: 1,
      mrtrRounds: 0,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.0001,
      failure: null,
      destructiveWithoutConfirmation: 0
    });
    expect(taskIdsNamedIn('failed on alpha-task-two', run)).toEqual(['alpha-task-two']);
    expect(taskIdsNamedIn('failed on alpha-task.', run)).toEqual(['alpha-task']);
    expect(taskIdsNamedIn('nothing named here', run)).toEqual([]);
    expect(taskIdsNamedIn('', run)).toEqual([]);
    expect(taskIdsNamedIn(null, run)).toEqual([]);
  });
});

describe('the reader can tell a deep link from a whole recording', () => {
  it('marks every focused link and explains the mark once per record', () => {
    withShimDocument((doc) => {
      const { roots } = everyRecord(doc);
      let marked = 0;
      for (let i = 0; i < roots.length; i++) {
        const focused = focusedLinks(roots[i]);
        for (const node of focused) {
          expect(node.textContent).toContain('its frames');
          expect(node.title).toContain('not the whole session');
          marked += 1;
        }
        // The legend appears exactly where a mark can appear, and nowhere else.
        const explained = roots[i].textContent.includes('opens the recording on that finding');
        expect(explained).toBe(hasFrameLinks(RUNS[i]));
        if (focused.length > 0) expect(explained).toBe(true);
      }
      expect(marked).toBeGreaterThan(50);
    });
  });

  it('keeps the accessible name of a focused link, and adds the frames it opens on', () => {
    withShimDocument((doc) => {
      const { roots } = everyRecord(doc);
      for (const root of roots) {
        for (const node of focusedLinks(root)) {
          const label = node.getAttribute('aria-label');
          expect(label).toContain('Opens the recorded session in a new tab');
          expect(label).toContain(`on the frames stamped ${corrOf(node.href)}`);
        }
      }
    });
  });

  it('opens in a new tab with the same safety as every other link on the page', () => {
    withShimDocument((doc) => {
      const { roots } = everyRecord(doc);
      for (const root of roots) {
        for (const node of focusedLinks(root)) {
          expect(node.target).toBe('_blank');
          expect(node.rel).toBe('noopener noreferrer');
        }
      }
    });
  });

  it('gives the mark and its link a real target in both themes', () => {
    const css = readFileSync(here('../site/style.css'), 'utf8');
    // The focused state is a variation on .evidence, which already carries the
    // 44px target, and it is drawn from tokens rather than from a fixed colour.
    expect(css).toContain('.evidence.is-focused');
    expect(css).toContain('.evidence-mark');
    const evidenceRule = css.slice(css.indexOf('.evidence {'), css.indexOf('.evidence:hover'));
    expect(evidenceRule).toContain('min-height: 44px');
    const focusedRule = css.slice(css.indexOf('.evidence.is-focused {'), css.indexOf('.evidence-mark {'));
    expect(focusedRule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(focusedRule).toContain('var(--measure');
    // Frame links sit in a wrapping set and keep the same target each.
    expect(css).toContain('.frame-links .evidence');
  });
});

/**
 * The methods page publishes the failure record, so it is held to the standard
 * it argues for. Nothing else in the suite reads it, which was itself one of
 * the open entries on the page when it shipped.
 */
describe('methods page', () => {
  it('publishes one article per failure record entry and says how many', () => {
    const articles = METHODS_SOURCE.match(/<article class="fail"/g) || [];
    expect(articles.length).toBeGreaterThan(0);
    // Both surfaces state the count, and a reader who counts the articles must
    // arrive at the same number.
    const stated = METHODS_SOURCE.match(/(\d+)\s+entries/);
    expect(stated).not.toBeNull();
    expect(Number(stated[1])).toBe(articles.length);
    const fromIndex = INDEX_SOURCE.match(/(\d+)\s+entries/);
    if (fromIndex) expect(Number(fromIndex[1])).toBe(articles.length);
  });

  it('gives every entry its own evidence block', () => {
    const articles = (METHODS_SOURCE.match(/<article class="fail"/g) || []).length;
    const evidence = (METHODS_SOURCE.match(/Evidence/g) || []).length;
    expect(evidence).toBeGreaterThanOrEqual(articles);
  });

  it('carries no em-dash on either published HTML surface', () => {
    expect(METHODS_SOURCE).not.toContain('\u2014');
    expect(INDEX_SOURCE).not.toContain('\u2014');
  });

  it('never claims our own work is conformance or compliance testing', () => {
    // The word itself is allowed, and is load bearing: the approved line
    // "Conformance asks whether the server speaks MCP correctly" exists to hand
    // that word to the official suite. What is banned is claiming it for us.
    const banned = [
      'our conformance',
      'we test conformance',
      'conformance testing for your',
      'compliance test',
      'compliance suite',
      'our compliance'
    ];
    for (const source of [METHODS_SOURCE, INDEX_SOURCE]) {
      const lower = source.toLowerCase();
      for (const phrase of banned) expect(lower).not.toContain(phrase);
      // Every mention still has to sit near the disclaimer or the official name.
      if (lower.includes('conformance')) {
        expect(lower).toMatch(/modelcontextprotocol\/conformance|official suite|different project/);
      }
    }
  });

  it('uses no generator version label the published records do not carry', () => {
    // runs.json holds exactly two states: no field, or the recorded version
    // string. A bare v1/v2/v3 label is not checkable from the data.
    const recorded = new Set(RUNS.map((run) => (run && run.run && run.run.generatorVersion) || '(absent)'));
    for (const label of recorded) {
      if (label !== '(absent)') expect(typeof label).toBe('string');
    }
    expect(METHODS_SOURCE).not.toMatch(/\bv[123]\b/);
  });

  it('resolves every in-page anchor it links to', () => {
    const ids = new Set((METHODS_SOURCE.match(/id="([^"]+)"/g) || []).map((m) => m.slice(4, -1)));
    const hrefs = (METHODS_SOURCE.match(/href="#([^"]+)"/g) || []).map((m) => m.slice(7, -1));
    for (const href of hrefs) expect(ids.has(href)).toBe(true);
  });
});
