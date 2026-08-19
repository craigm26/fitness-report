/**
 * Fitness Report leaderboard renderer.
 *
 * Vanilla ES module, no framework, no build step. It reads an array of
 * `fitness-report/1` records (see src/types.ts, FitnessReportJson) and renders
 * one row per run.
 *
 * Three rules are load bearing here and are enforced in code, not in copy:
 *
 *   1. A refusal is a first class row. When a gate stops a run there is no
 *      score field in the record at all, so every cell that would have held a
 *      number instead holds the named gate, its counts and its reason string.
 *      No cell is ever left blank.
 *   2. First try success is rendered as its Wilson interval. Ordering uses the
 *      point estimate, but rows whose intervals overlap are marked tied and
 *      share one position. Overlapping intervals are not a ranking.
 *   3. Every finding links to the recorded session behind it. A finding with no
 *      published trace says so rather than standing as a bare count.
 *
 * The page never recomputes statistics. Intervals, verdicts and p values are
 * read from the record exactly as the harness wrote them, because a second copy
 * of that math is a second thing that can drift.
 */

export const DATA_URL = 'data/runs.json';
export const VIEWER_BASE = 'https://mcpreplay.dev/';

/** Human labels for the gate ids in src/types.ts (GateId). */
export const GATE_LABELS = {
  structural: 'structural',
  answer_leak: 'answer leak',
  suite_size: 'suite size',
  plan_power: 'plan power',
  null_baseline: 'null baseline',
  construct: 'construct',
  variance: 'variance',
  order_invariance: 'order invariance',
  protocol_hygiene: 'protocol hygiene'
};

/** One line of plain language per RunOutcome. */
export const OUTCOME_NOTES = {
  SCORED: 'gates passed, run scored',
  GATE_FAILED: 'a validity gate failed',
  DEGENERATE: 'a null model reached the answers, so the suite measures nothing',
  INDETERMINATE: 'the baseline could not be resolved either way',
  EXTEND_EXHAUSTED: 'evidence never became decisive within the extension budget',
  COMPROMISED: 'oracle error rate above 0.05, the measurement did not complete',
  INSUFFICIENT_SURFACE: 'task suite below the minimum size of 8'
};

export const CREDENTIAL_NOTES = {
  anonymous: 'collected with no credentials',
  'free-key': 'collected with a free tier key',
  'owner-key': 'collected with a key held by the server owner'
};

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** A finite number, or null. Never NaN, never null read as zero. */
export function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function fmtPct(value, digits = 1) {
  const n = finite(value);
  if (n === null) return 'not reported';
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtNum(value, digits = 1) {
  const n = finite(value);
  if (n === null) return 'not reported';
  return n.toFixed(digits);
}

export function fmtInt(value) {
  const n = finite(value);
  if (n === null) return 'not reported';
  return String(Math.round(n));
}

export function fmtUsd(value, digits = 4) {
  const n = finite(value);
  if (n === null) return 'no price on file';
  return `$${n.toFixed(digits)}`;
}

/** A plain object, or an empty one. Never null, never an array. */
export function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function gateLabel(id) {
  if (typeof id !== 'string' || id.length === 0) return 'unnamed gate';
  return GATE_LABELS[id] || id.replace(/_/g, ' ');
}

/** The score block, only when the record really carries one. */
export function scoreOf(run) {
  return run && typeof run.score === 'object' && run.score !== null ? run.score : null;
}

/** First try Wilson interval, or null when the run carries no usable one. */
export function firstTryInterval(run) {
  const score = scoreOf(run);
  const w = score && typeof score.firstTrySuccess === 'object' ? score.firstTrySuccess : null;
  if (!w) return null;
  const rate = finite(w.rate);
  const low = finite(w.low);
  const high = finite(w.high);
  const n = finite(w.n);
  if (rate === null || low === null || high === null || n === null || n <= 0) return null;
  return { rate, low, high, k: finite(w.k) ?? 0, n };
}

/** A run is rankable only when it is SCORED and carries a usable interval. */
export function isRankable(run) {
  return run && run.outcome === 'SCORED' && firstTryInterval(run) !== null;
}

/** Wilson intervals overlap when neither one sits entirely above the other. */
export function intervalsOverlap(a, b) {
  if (!a || !b) return false;
  return a.low <= b.high && b.low <= a.high;
}

/** a is separated from b only when a's whole interval sits above b's. */
export function separates(a, b) {
  return Boolean(a && b) && a.low > b.high;
}

/**
 * Order the rankable runs and mark everything that is not actually separated.
 *
 * Rows are listed by point estimate, descending, but the POSITION is a
 * dominance rank: one plus the number of rows whose interval lies entirely
 * above this one. A row therefore only drops below another when the evidence
 * separates them, and rows nobody separates share a position.
 *
 * Sorting still puts one overlapping row above another, which on its own would
 * read as a ranking. So each row also carries `overlapsAbove`, and the renderer
 * prints that on the row. Between them, the two marks mean no pair of
 * overlapping intervals is ever presented on this page as a settled ordering.
 */
export function rankRuns(runs) {
  const rows = runs
    .filter(isRankable)
    .map((run) => ({ run, interval: firstTryInterval(run) }))
    .sort((a, b) => b.interval.rate - a.interval.rate || slugOf(a.run).localeCompare(slugOf(b.run)));

  const out = rows.map((row) => ({
    ...row,
    rank: 1 + rows.filter((other) => other !== row && separates(other.interval, row.interval)).length,
    tied: false,
    groupSize: 1,
    overlapsAbove: false
  }));

  for (const row of out) {
    // Sharing a position is only a tie when the intervals really do overlap.
    const peers = out.filter(
      (other) => other !== row && other.rank === row.rank && intervalsOverlap(other.interval, row.interval)
    );
    row.tied = peers.length > 0;
    row.groupSize = peers.length + 1;
    row.groupId = row.rank;
  }
  for (let i = 1; i < out.length; i++) {
    out[i].overlapsAbove = intervalsOverlap(out[i - 1].interval, out[i].interval);
  }
  return out;
}

/** Rankable runs, split by runner model. Rankings hold only within one model. */
/**
 * Ranking bands. A band is one runner model AND one task generator version:
 * both change what the numbers mean, so a row from one never takes a position
 * against a row from the other. The band is the unit of comparison on this
 * page; ordering within it is `rankRuns`.
 */
export function rankGroups(runs) {
  const bands = [];
  for (const run of runs) {
    if (!isRankable(run)) continue;
    const runnerModel = runnerModelOf(run);
    const generatorVersion = generatorVersionOf(run);
    if (!bands.some((b) => b.runnerModel === runnerModel && b.generatorVersion === generatorVersion)) {
      bands.push({ runnerModel, generatorVersion });
    }
  }
  return bands.map((band) => ({
    runnerModel: band.runnerModel,
    generatorVersion: band.generatorVersion,
    rows: rankRuns(
      runs.filter(
        (run) => runnerModelOf(run) === band.runnerModel && generatorVersionOf(run) === band.generatorVersion
      )
    )
  }));
}

export function runnerModelOf(run) {
  const score = scoreOf(run);
  if (score && typeof score.runnerModel === 'string' && score.runnerModel) return score.runnerModel;
  if (run && run.run && typeof run.run.runnerModel === 'string' && run.run.runnerModel) {
    return run.run.runnerModel;
  }
  return 'unrecorded runner model';
}

/**
 * The task generator that produced this run's suite.
 *
 * Two generator versions are two different denominators: v1 counted candidates
 * in a way that double counted the repair pass, and v2 counts candidates and
 * deletes null answerable ones before admission. An admission rate from one is
 * not comparable with an admission rate from the other, so rows are banded by
 * this exactly the way they are banded by runner model. Newer records carry it
 * at `run.generatorVersion`; older ones only have it nested in the structural
 * record, and a record with neither says so rather than being folded in.
 */
export function generatorVersionOf(run) {
  const meta = asObject(run && run.run);
  if (typeof meta.generatorVersion === 'string' && meta.generatorVersion) return meta.generatorVersion;
  const nested = synthesisOf(run).generatorVersion;
  if (typeof nested === 'string' && nested) return nested;
  return 'unrecorded generator';
}

export function slugOf(run) {
  const server = run && run.server ? run.server : null;
  if (server && typeof server.slug === 'string' && server.slug) return server.slug;
  if (server && typeof server.url === 'string' && server.url) return server.url;
  return run && run.run && run.run.id ? String(run.run.id) : 'unnamed server';
}

/**
 * The refusal, described the way the row prints it. Returns null for a scored
 * run. Never returns an empty object: an outcome with no gate record still
 * yields the outcome and its note, because a blank refusal cell is the failure
 * this function exists to prevent.
 */
export function refusalOf(run) {
  if (!run || run.outcome === 'SCORED') return null;
  const gates = run.gates && typeof run.gates === 'object' ? run.gates : {};
  const records = Array.isArray(gates.records) ? gates.records : [];
  const refusedAt = typeof gates.refusedAt === 'string' ? gates.refusedAt : null;
  let record = records.find((r) => r && r.gate === refusedAt) || null;
  if (!record) record = records.find((r) => r && r.ok === false) || null;
  const gate = record ? record.gate : refusedAt;
  return {
    outcome: typeof run.outcome === 'string' ? run.outcome : 'UNKNOWN_OUTCOME',
    note: OUTCOME_NOTES[run.outcome] || 'outcome not recognised by this page',
    gate: gate || null,
    gateLabel: gate ? gateLabel(gate) : 'no gate recorded',
    reason: record && typeof record.reason === 'string' ? record.reason : null,
    costTier: record && typeof record.costTier === 'string' ? record.costTier : null,
    verdict: record && record.verdict && typeof record.verdict === 'object' ? record.verdict : null,
    detail: record ? record.detail : null
  };
}

/** "22 of 30 vs 0.90, p = 0.0078". Returns null when there is no verdict. */
export function verdictLine(verdict) {
  if (!verdict || typeof verdict !== 'object') return null;
  const k = finite(verdict.k);
  const n = finite(verdict.n);
  const threshold = finite(verdict.threshold);
  if (k === null || n === null) return null;
  const parts = [`${k} of ${n}`];
  if (threshold !== null) parts.push(`against a threshold of ${threshold.toFixed(2)}`);
  const p = finite(verdict.pValue);
  if (p !== null) parts.push(`p = ${p < 0.0001 ? p.toExponential(2) : p.toFixed(4)}`);
  const alpha = finite(verdict.alpha);
  if (alpha !== null) parts.push(`alpha = ${alpha}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// refusal story
//
// A refusal names a gate. That is necessary and not sufficient: a reader who
// does not already know what `noise_exceeds_signal` means learns nothing from
// the name. These builders turn the numbers the harness already recorded into
// one plain sentence plus the figures behind it, and they are driven only by
// fields present in the record. There is no per server special casing here and
// there must never be one: a sentence that is true of only one row is a
// sentence this page cannot stand behind.
// ---------------------------------------------------------------------------

/** How each null model is described in prose. Unknown labels degrade politely. */
export const NULL_MODEL_PHRASES = {
  'no-tools': 'A model with no tools',
  'stubbed-empty': 'A model whose tool calls all came back empty',
  'random-valid-args': 'A model calling tools with random valid arguments'
};

export function nullModelPhrase(label) {
  if (typeof label !== 'string' || label.length === 0) return 'A null model';
  return NULL_MODEL_PHRASES[label] || `The ${label.replace(/[-_]+/g, ' ')} null model`;
}

/** Gates that describe the same finding and are told as one story. */
export const SURFACE_GATES = ['structural', 'suite_size'];

export function gateRecordOf(run, gate) {
  const records = Array.isArray(asObject(run && run.gates).records) ? run.gates.records : [];
  return records.find((r) => r && typeof r === 'object' && r.gate === gate) || null;
}

/**
 * The synthesis ledger, as the harness compacted it into the structural gate
 * record. Empty for a v1 run, which is the signal that this page must not
 * pretend to know how the suite was built.
 */
export function synthesisOf(run) {
  return asObject(asObject(asObject(gateRecordOf(run, 'structural')).detail).synthesis);
}

/**
 * What the generation time null screen did, read from whichever record carries
 * it. The screen deletes candidates a model answered with no server at all,
 * BEFORE the suite is hashed and before any gate runs, so its counts are the
 * difference between "this server has a thin surface" and "this server was not
 * needed". `enabled` false with counts of zero is the honest reading of a v1
 * record: no screen ran, nothing was deleted.
 */
export function nullScreenOf(run) {
  const structural = asObject(asObject(gateRecordOf(run, 'structural')).detail);
  const sizing = asObject(asObject(gateRecordOf(run, 'suite_size')).detail);
  const screen = asObject(synthesisOf(run).nullScreen);
  const dropped = finite(sizing.nullScreenDropped) ?? finite(structural.nullScreenDropped) ?? finite(screen.dropped);
  const screened =
    finite(sizing.nullScreenScreened) ?? finite(structural.nullScreenScreened) ?? finite(screen.screened);
  return {
    enabled: screen.enabled === true || asObject(run && run.run).nullScreenEnabled === true,
    model: typeof screen.model === 'string' && screen.model ? screen.model : null,
    dropped,
    screened,
    errors: finite(screen.errors),
    inputTokens: finite(screen.inputTokens),
    outputTokens: finite(screen.outputTokens),
    attribution: typeof sizing.attribution === 'string' && sizing.attribution ? sizing.attribution : null
  };
}

/**
 * What the tapes say about model activity, kept separate from what they say
 * about model COST. `totalUsd` is null both when no model ran and when no model
 * that ran had a price on file, and those are different facts about a run.
 */
export function modelActivityOf(run) {
  const models = asObject(asObject(run && run.trace_stats).models);
  const cost = asObject(models.cost);
  const summary = asObject(models.summary);
  const unpriced = Array.isArray(cost.unpricedModels)
    ? cost.unpricedModels.filter((m) => typeof m === 'string' && m.length > 0)
    : [];
  return {
    assistantTurns: finite(summary.assistantTurns) ?? 0,
    costUsd: finite(cost.totalUsd),
    unpricedModels: unpriced
  };
}

/**
 * Gates that failed, minus protocol hygiene. Hygiene is reported, never a
 * refusal: the record says so itself, and a hygiene failure is a fact about the
 * server rather than evidence that this measurement was invalid.
 */
export function failedGateRecords(run) {
  const records = Array.isArray(asObject(run && run.gates).records) ? run.gates.records : [];
  return records.filter((r) => r && typeof r === 'object' && r.ok === false && r.gate !== 'protocol_hygiene');
}

/** The null model rates the baseline gate measured, as recorded. */
export function nullRates(detail) {
  const rows = Array.isArray(asObject(detail).rates) ? detail.rates : [];
  return rows
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ label: String(r.label || 'unnamed null model'), k: finite(r.k), n: finite(r.n), rate: finite(r.rate) }))
    .filter((r) => r.rate !== null);
}

/** Call, error and unanswered totals across the tape, or zeroes. */
export function traceToolTotals(run) {
  const tools = Array.isArray(asObject(run && run.trace_stats).tools) ? run.trace_stats.tools : [];
  const usable = tools.filter((t) => t && typeof t === 'object');
  let calls = 0;
  let errors = 0;
  let pending = 0;
  for (const tool of usable) {
    calls += finite(tool.calls) ?? 0;
    errors += finite(tool.errors) ?? 0;
    pending += finite(tool.pending) ?? 0;
  }
  return { names: usable.length, calls, errors, pending };
}

/** Tools the server advertised, taken from whichever probe recorded it. */
export function advertisedToolCount(run) {
  for (const finding of probeFindings(run)) {
    const count = finite(asObject(finding.evidence).toolCount);
    if (count !== null) return count;
  }
  return finite(asObject(asObject(gateRecordOf(run, 'suite_size')).detail).toolCount);
}

/**
 * Model spend recorded on this run's own tapes, or null when none was.
 *
 * Null is ambiguous on purpose: unknown pricing fails closed, so this is null
 * both for a run where no model turn happened and for one whose model has no
 * price on file. A caller that needs to tell those apart reads
 * `modelActivityOf` and says which one it saw.
 */
export function measuredCostOf(run) {
  return modelActivityOf(run).costUsd;
}

function storyShell(record, isPrimary) {
  const detail = asObject(record && record.detail);
  return {
    gate: record ? record.gate : null,
    gateLabel: record ? gateLabel(record.gate) : 'no gate recorded',
    isPrimary: Boolean(isPrimary),
    reason: record && typeof record.reason === 'string' ? record.reason : null,
    costTier: record && typeof record.costTier === 'string' ? record.costTier : null,
    verdict: record && typeof record.verdict === 'object' && record.verdict !== null ? record.verdict : null,
    explain: typeof detail.explain === 'string' ? detail.explain : null,
    headline: null,
    sentences: [],
    figures: [],
    meter: null,
    limitation: null
  };
}

/**
 * The null baseline story: what the tasks were worth without the server.
 * The comparison is the whole finding, so it is drawn as well as stated.
 */
export function nullBaselineStory(run, record, isPrimary) {
  const story = storyShell(record, isPrimary);
  const detail = asObject(record.detail);
  const rates = nullRates(detail);
  const worst = rates.reduce((best, row) => (best === null || row.rate > best.rate ? row : best), null);
  const tNull = finite(detail.tNull);
  const tAblate = finite(detail.tAblate);
  const kill = finite(detail.killThreshold);
  const ratio = finite(detail.ratio);
  const signalSource = typeof detail.signalSource === 'string' ? detail.signalSource : null;
  const noSignal = tAblate === 0 || detail.reason === 'degenerate_no_signal';

  if (worst && worst.k !== null && worst.n !== null) {
    story.headline = noSignal
      ? `${nullModelPhrase(worst.label)} passed ${worst.k} of ${worst.n} tasks and the agent driving the real server passed none of them, so there is nothing here for the noise to be measured against.`
      : `${nullModelPhrase(worst.label)} passed ${worst.k} of ${worst.n} tasks, so these tasks never needed the server.`;
  } else if (tNull !== null) {
    story.headline = `A null model passed ${fmtPct(tNull)} of this suite, so these tasks never needed the server.`;
  } else {
    story.headline = 'A null model reached the answers on this suite, so the tasks were not measuring the server.';
  }

  if (tAblate !== null && !noSignal) {
    story.sentences.push(
      `The agent driving the real server passed ${fmtPct(tAblate)} of the same suite${signalSource ? `, measured as ${signalSource}` : ''}. The gap between those two numbers is everything this run could have told you about the server.`
    );
  } else if (noSignal && signalSource) {
    story.sentences.push(`The agent rate here comes from the ${signalSource}, and it was zero.`);
  }
  if (noSignal) {
    const resolved = typeof detail.outcome === 'string' ? detail.outcome.toLowerCase() : 'indeterminate';
    story.sentences.push(
      `With the agent rate at zero there is no threshold left to compare against, so the baseline resolves as ${resolved} rather than as a kill. It halts the run exactly like a kill, because a baseline that cannot be resolved is not a licence to publish a number.`
    );
  } else if (kill !== null && ratio !== null) {
    story.sentences.push(
      `The baseline halts when a null model reaches ${fmtPct(ratio, 0)} of the agent rate, which for this run was ${fmtPct(kill)}. The worst null model sat at ${fmtPct(tNull)}.`
    );
  }
  const minTasks = finite(asObject(asObject(gateRecordOf(run, 'suite_size')).detail).minTasks);
  if (worst && worst.n !== null && minTasks !== null && worst.n < minTasks) {
    story.sentences.push(
      `These rates were measured over ${worst.n} tasks, which is itself below the minimum of ${minTasks}, so this reads as a second symptom of a thin suite rather than as an independent finding.`
    );
  }
  if (!noSignal) {
    story.sentences.push(
      'That threshold is not adjustable and was not adjusted. The repair for a degenerate suite is harder tasks, never a lower bar.'
    );
  }
  if (detail.measuredBeforePaidTier === true) {
    const decided = typeof detail.decidedAfter === 'string' ? detail.decidedAfter : null;
    story.sentences.push(
      `The null models were measured before the paid tier ran${decided ? `, and the baseline was resolved after the ${decided}` : ''}. The evidence for this refusal was cheap and it existed early.`
    );
  }

  // The rates themselves are drawn below, so the figure list carries only what
  // the drawing cannot: where the agent number came from and when it was read.
  story.figures = [
    { label: 'kill threshold', value: noSignal ? 'none, the agent rate was zero' : fmtPct(kill) },
    { label: 'agent rate read from', value: signalSource || 'not recorded' }
  ];
  if (typeof detail.decidedAfter === 'string') {
    story.figures.push({ label: 'decided after', value: detail.decidedAfter });
  }
  if (typeof detail.outcome === 'string') story.figures.push({ label: 'baseline outcome', value: detail.outcome });

  const meterRows = rates.map((row) => ({
    label: row.label,
    rate: row.rate,
    value: row.k !== null && row.n !== null ? `${fmtPct(row.rate)}, ${row.k} of ${row.n}` : fmtPct(row.rate),
    kind: worst && row.label === worst.label ? 'worst' : 'null'
  }));
  if (tAblate !== null) {
    meterRows.push({ label: 'agent with the server', rate: tAblate, value: fmtPct(tAblate), kind: 'agent' });
  }
  if (meterRows.length > 0) {
    story.meter = {
      caption: 'Pass rate on the same task suite, by what the model was given.',
      threshold: kill === null || noSignal ? null : { value: kill, label: `kill threshold ${fmtPct(kill)}` },
      rows: meterRows
    };
  }
  return story;
}

/** The generator's own reason code for a candidate the null screen deleted. */
export const NULL_SCREEN_RULE = 'null_screen';

/** `{'invalid-check': 2, null_screen: 14}` rendered as "14 null screen, 2 invalid check". */
export function dropRuleLines(dropsByRule) {
  return Object.entries(asObject(dropsByRule))
    .map(([rule, count]) => ({ rule: String(rule), label: String(rule).replace(/[-_]+/g, ' '), count: finite(count) }))
    .filter((row) => row.count !== null && row.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The surface story: how many candidate tasks survived, and against what floor.
 * Both surface gates fold into one story because they are one finding.
 *
 * Three numbers are deliberately kept apart here, because subtracting the wrong
 * pair publishes a false claim as a measurement:
 *
 *   dropped  candidates admission REJECTED, with a named rule each.
 *   trimmed  candidates that PASSED admission and were cut as surplus, because
 *            the v2 generator over generates on purpose. Nothing is wrong with
 *            them and calling them failures inflates the failure count.
 *   deleted  candidates a model answered with no server at all, removed by the
 *            null screen before the suite was hashed.
 *
 * `nRequested - nGenerated` is dropped + trimmed together, so it is never
 * printed as a drop count on a record that carries the ledger.
 */
export function surfaceStory(run, record, isPrimary) {
  const story = storyShell(record, isPrimary);
  const structural = asObject((gateRecordOf(run, 'structural') || {}).detail);
  const sizing = asObject((gateRecordOf(run, 'suite_size') || {}).detail);
  const requested = finite(structural.nRequested);
  const admitted = finite(structural.nGenerated);
  const holding = finite(structural.nHolding);
  const admissionRate = finite(structural.admissionRate);
  const minAdmission = finite(structural.minAdmissionRate);
  const minGenerated = finite(structural.minGenerated);
  const nTasks = finite(sizing.nTasks);
  const minTasks = finite(sizing.minTasks);
  const toolCount = finite(sizing.toolCount);
  const failures = Array.isArray(structural.failures) ? structural.failures : [];

  const synthesis = synthesisOf(run);
  const yields = asObject(synthesis.yield);
  const candidates = finite(yields.candidates);
  const admittedInLedger = finite(yields.admitted);
  const trimmed = finite(yields.trimmed);
  const rules = dropRuleLines(synthesis.dropsByRule);
  // The screen's deletions are recorded in the same drop ledger as the checks
  // that rejected a candidate, and they are not the same event: one is a
  // candidate the generator got wrong, the other is a candidate the server was
  // not needed for. They are separated here and never summed into one count.
  const screenRule = rules.find((row) => row.rule === NULL_SCREEN_RULE);
  const admissionRules = rules.filter((row) => row.rule !== NULL_SCREEN_RULE);
  // A ledger is present only on v2 records. Without one this page knows the
  // totals and nothing else, and it says so instead of inventing a breakdown.
  const hasLedger = candidates !== null && admittedInLedger !== null && trimmed !== null;
  const allDropped = hasLedger ? candidates - admittedInLedger - trimmed : null;
  // Clamped at zero: a ledger that does not reconcile is a defect in the record
  // and this page will not print a negative count of rejected candidates over
  // it. The synthesis block carries `reconciles` and `shortfall` for that case.
  const dropped = hasLedger ? Math.max(0, allDropped - (screenRule ? screenRule.count : 0)) : null;
  const screen = nullScreenOf(run);
  const screenLed = screen.attribution !== null || record.reason === 'all_candidates_null_answerable';

  if (screenLed && screen.dropped !== null && screen.screened !== null) {
    story.headline = `A model with no server at all answered ${screen.dropped} of ${screen.screened} screened candidates correctly, so they were deleted before any gate ran and ${fmtInt(nTasks)} tasks were left.`;
  } else if (requested !== null && admitted !== null) {
    story.headline = `The generator was asked for ${requested} candidate tasks and ${admitted} were admitted, an admission rate of ${fmtPct(admissionRate)}.`;
  } else if (nTasks !== null && minTasks !== null) {
    story.headline = `The suite came to ${nTasks} tasks against a minimum of ${minTasks}.`;
  } else {
    story.headline = 'The task suite was too small to measure anything with.';
  }
  // The harness's own attribution, verbatim: it is the sentence that separates
  // a thin server from a server nothing needed.
  if (screen.attribution !== null) story.sentences.push(screen.attribution);
  else if (screen.dropped !== null && screen.dropped > 0 && screen.screened !== null) {
    story.sentences.push(
      `Before admission, the null screen deleted ${screen.dropped} of ${screen.screened} screened candidates that a model answered correctly with no server at all. Those candidates are not counted as generator failures and they never entered a gate denominator.`
    );
  }

  if (minAdmission !== null && minGenerated !== null) {
    const missedRate = admissionRate !== null && admissionRate < minAdmission;
    const missedCount = admitted !== null && admitted < minGenerated;
    const missed = [missedRate ? `the ${fmtPct(minAdmission)} admission floor` : null, missedCount ? `the minimum of ${minGenerated} admitted tasks` : null].filter(
      (part) => part !== null
    );
    story.sentences.push(
      missed.length > 0
        ? `This suite missed ${missed.join(' and ')}${
            screenLed ? ', with everything the screen deleted still counted in that denominator' : ''
          }.`
        : `The floors are ${fmtPct(minAdmission)} admitted and ${minGenerated} tasks in absolute terms.`
    );
  }
  if (nTasks !== null && minTasks !== null && nTasks < minTasks) {
    story.sentences.push(
      `Scoring needs at least ${minTasks} tasks and this suite has ${nTasks}${toolCount !== null ? `, against ${toolCount} advertised ${toolCount === 1 ? 'tool' : 'tools'}` : ''}. The run is refused rather than published as a ${nTasks}-task result that nothing could separate from luck.`
    );
  }
  if (holding !== null && admitted !== null && holding === admitted && admitted > 0) {
    story.sentences.push(`Every one of the ${admitted} admitted tasks held under its own check. Holding is not the problem here; there were too few of them to mean anything.`);
  }
  story.sentences.push(
    screenLed
      ? 'Neither floor moved for this run, and neither will. A suite a null model can answer is fixed by harder tasks, never by keeping the ones the screen deleted.'
      : 'Neither floor moved for this run, and neither will. A thin surface is fixed by generating tasks that survive admission, not by admitting weaker ones.'
  );

  if (hasLedger) {
    if (dropped > 0 && admissionRules.length > 0) {
      story.sentences.push(
        `${dropped} ${dropped === 1 ? 'candidate was' : 'candidates were'} rejected by admission, by rule: ${admissionRules
          .map((row) => `${row.count} ${row.label}`)
          .join(', ')}.`
      );
    } else if (dropped > 0) {
      story.limitation = `${dropped} candidate ${dropped === 1 ? 'task' : 'tasks'} did not survive admission and this record's drop ledger is empty, so it can say how many were lost but not why. That is a gap in the harness, not a finding about the server.`;
    }
    if (trimmed > 0) {
      story.sentences.push(
        `A further ${trimmed} ${trimmed === 1 ? 'candidate' : 'candidates'} passed admission and ${trimmed === 1 ? 'was' : 'were'} trimmed as surplus. The generator over generates on purpose, so a trimmed candidate is spare capacity, not a failure, and it is counted apart from the ${dropped} that were rejected.`
      );
    }
  } else if (requested !== null && admitted !== null && requested > admitted && failures.length === 0) {
    // v1 records only. They carry no synthesis ledger, so the gap is real and
    // is stated as a gap rather than guessed at.
    const missing = requested - admitted;
    story.limitation = `${missing} candidate ${missing === 1 ? 'task' : 'tasks'} did not reach the suite and this record does not say which check dropped ${missing === 1 ? 'it' : 'them'} or how many were surplus. That generator did not serialise its per candidate drop reasons into the report, so this row can tell you how many were lost but not why. That is a gap in the harness, not a finding about the server.`;
  }

  story.figures = [
    { label: 'candidates requested', value: fmtInt(requested) },
    { label: 'admitted', value: fmtInt(admitted) },
    { label: 'still holding', value: fmtInt(holding) },
    { label: 'suite size', value: minTasks === null ? fmtInt(nTasks) : `${fmtInt(nTasks)} against a minimum of ${minTasks}` }
  ];
  if (hasLedger) {
    story.figures.push({ label: 'rejected by admission', value: fmtInt(dropped) });
    story.figures.push({ label: 'trimmed as surplus', value: fmtInt(trimmed) });
  }
  if (screen.dropped !== null && screen.screened !== null && (screen.enabled || screen.dropped > 0)) {
    story.figures.push({
      label: 'deleted by the null screen',
      value: `${fmtInt(screen.dropped)} of ${fmtInt(screen.screened)} screened`
    });
  }
  if (toolCount !== null) story.figures.push({ label: 'tools advertised', value: fmtInt(toolCount) });

  if (admissionRate !== null) {
    story.meter = {
      caption: 'Share of generated candidates that were admitted to the suite.',
      threshold: minAdmission === null ? null : { value: minAdmission, label: `admission floor ${fmtPct(minAdmission)}` },
      rows: [
        {
          label: 'admitted',
          rate: admissionRate,
          value: requested !== null && admitted !== null ? `${fmtPct(admissionRate)}, ${admitted} of ${requested}` : fmtPct(admissionRate),
          kind: 'worst'
        }
      ]
    };
  }
  return story;
}

/**
 * The construct story: the reference agent is handed the answer key, so its
 * failure is a statement about the measurement. When the tape shows requests
 * that never got a response, that is said in the same breath, because the
 * distinction between "the agent could not" and "the server never answered"
 * is the whole point of recording two planes.
 */
export function constructStory(run, record, isPrimary) {
  const story = storyShell(record, isPrimary);
  const detail = asObject(record.detail);
  const verdict = asObject(record.verdict);
  const k = finite(verdict.k);
  const n = finite(verdict.n);
  const threshold = finite(verdict.threshold);
  const errorRate = finite(detail.errorRate);
  const maxErrorRate = finite(detail.maxErrorRate);
  const totals = traceToolTotals(run);
  const advertised = advertisedToolCount(run);

  if (k !== null && n !== null) {
    story.headline = `The reference agent, which is handed the answer key before it starts, passed ${k} of ${n} tasks${threshold === null ? '' : ` against a required ${threshold.toFixed(2)}`}.`;
  } else {
    story.headline = 'The reference agent could not reach the answer key, so the suite was never in a state to score anything.';
  }

  if (totals.calls > 0 && totals.pending === totals.calls) {
    story.sentences.push(
      `${advertised === null ? 'The server advertises tools' : `The server advertises ${advertised} ${advertised === 1 ? 'tool' : 'tools'}`}, and every invocation was rejected before a protocol response existed: the MCP tape carries ${totals.calls} tool ${totals.calls === 1 ? 'request' : 'requests'} across ${totals.names} tool ${totals.names === 1 ? 'name' : 'names'} and not one matching response.`
    );
    story.sentences.push(
      'A request with no response is not a wrong answer from the agent and not an error result from the tool. It is a call that never reached the protocol, and it is reported that way rather than scored.'
    );
  } else if (totals.pending > 0) {
    story.sentences.push(
      `${totals.pending} of ${totals.calls} tool ${totals.calls === 1 ? 'invocation' : 'invocations'} on the tape never received a matching response.`
    );
  }
  if (totals.errors > 0) {
    story.sentences.push(`${totals.errors} of ${totals.calls} recorded ${totals.calls === 1 ? 'invocation' : 'invocations'} came back as an error result.`);
  }
  if (typeof detail.constructOracle === 'string') story.sentences.push(detail.constructOracle);
  if (errorRate !== null && maxErrorRate !== null) {
    story.sentences.push(
      `Reference errors are gated on their own at ${fmtPct(maxErrorRate)}; this run measured ${fmtPct(errorRate)}, so the outcome is a failed construct gate rather than a compromised one.`
    );
  }

  story.figures = [
    { label: 'tools advertised', value: fmtInt(advertised) },
    { label: 'tool calls on the tape', value: fmtInt(totals.calls) },
    { label: 'calls with no response', value: fmtInt(totals.pending) },
    { label: 'error results', value: fmtInt(totals.errors) }
  ];

  if (k !== null && n !== null && n > 0) {
    story.meter = {
      caption: 'Reference agent pass rate against the rate the gate requires.',
      threshold: threshold === null ? null : { value: threshold, label: `required ${threshold.toFixed(2)}` },
      rows: [{ label: 'reference agent', rate: k / n, value: `${fmtPct(k / n)}, ${k} of ${n}`, kind: 'worst' }]
    };
  }
  return story;
}

/** Anything else that failed: the record's own counts, never a blank. */
export function genericStory(run, record, isPrimary) {
  const story = storyShell(record, isPrimary);
  const counts = verdictLine(record.verdict) || detailLine(record.detail);
  story.headline = `The ${story.gateLabel} gate stopped this run${story.reason ? ` with ${story.reason}` : ''}.`;
  if (counts) story.sentences.push(`Recorded counts: ${counts}.`);
  story.sentences.push('No number is published from a run that a gate stopped, because the measurement behind the number did not hold.');
  return story;
}

/**
 * Every failed gate on a refused run, told in order, refusal gate first. The
 * two surface gates are folded together: they are one finding recorded twice.
 */
export function refusalStories(run) {
  if (!run || run.outcome === 'SCORED') return [];
  const refusedAt = typeof asObject(run.gates).refusedAt === 'string' ? run.gates.refusedAt : null;
  const failed = failedGateRecords(run);
  if (failed.length === 0) return [];

  const primary = failed.find((r) => r.gate === refusedAt) || failed[0];
  const ordered = [primary, ...failed.filter((r) => r !== primary)];
  const seenSurface = [];
  const stories = [];
  for (const record of ordered) {
    if (SURFACE_GATES.includes(record.gate)) {
      if (seenSurface.length > 0) continue;
      seenSurface.push(record.gate);
      stories.push(surfaceStory(run, record, record === primary));
      continue;
    }
    if (record.gate === 'null_baseline') stories.push(nullBaselineStory(run, record, record === primary));
    else if (record.gate === 'construct') stories.push(constructStory(run, record, record === primary));
    else stories.push(genericStory(run, record, record === primary));
  }
  return stories;
}

/** A short, numeric teaser for the row itself. Prose lives in the panel. */
export function refusalTeaser(run) {
  const stories = refusalStories(run);
  if (stories.length === 0) return null;
  const story = stories[0];
  if (story.gate === 'null_baseline') {
    const detail = asObject(gateRecordOf(run, 'null_baseline').detail);
    const tNull = finite(detail.tNull);
    const tAblate = finite(detail.tAblate);
    if (tNull === null) return null;
    return `null model ${fmtPct(tNull)} against agent ${tAblate === null ? 'not measured' : fmtPct(tAblate)}`;
  }
  if (SURFACE_GATES.includes(story.gate)) {
    // A suite the screen emptied is a different row from a thin one, so the
    // teaser leads with the screen when the record attributes it there.
    const screen = nullScreenOf(run);
    if (screen.attribution !== null && screen.dropped !== null && screen.screened !== null) {
      return `${screen.dropped} of ${screen.screened} candidates answerable with no server`;
    }
    const detail = asObject(gateRecordOf(run, 'structural').detail);
    const requested = finite(detail.nRequested);
    const admitted = finite(detail.nGenerated);
    if (requested === null || admitted === null) return null;
    return `${admitted} of ${requested} candidate tasks admitted`;
  }
  if (story.gate === 'construct') {
    const verdict = asObject(gateRecordOf(run, 'construct').verdict);
    const k = finite(verdict.k);
    const n = finite(verdict.n);
    if (k === null || n === null) return null;
    const totals = traceToolTotals(run);
    const tail = totals.calls > 0 && totals.pending === totals.calls ? `, ${totals.calls} calls with no response` : '';
    return `reference agent ${k} of ${n}${tail}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// masthead figures
// ---------------------------------------------------------------------------

/**
 * Counts for the stat strip. Cost is summed only where a tape recorded one, and
 * the reasons it can be missing are counted separately rather than collapsed
 * into one sentence. An absent total means one of three different things:
 * nothing ran, something ran whose model has no price on file, or the spend
 * happened somewhere no tape can see it (the generation time null screen calls
 * the runner model and writes to neither plane).
 */
export function boardStats(runs) {
  const usable = Array.isArray(runs) ? runs.filter((run) => run && typeof run === 'object') : [];
  const scored = usable.filter((run) => run.outcome === 'SCORED').length;
  const servers = new Set(usable.map((run) => slugOf(run))).size;
  let costUsd = 0;
  let costRuns = 0;
  let turnRuns = 0;
  let unpricedRuns = 0;
  let screenRuns = 0;
  let screenInputTokens = 0;
  let screenOutputTokens = 0;
  let screenCalls = 0;
  for (const run of usable) {
    const activity = modelActivityOf(run);
    if (activity.assistantTurns > 0) turnRuns += 1;
    if (activity.unpricedModels.length > 0) unpricedRuns += 1;
    if (activity.costUsd !== null) {
      costUsd += activity.costUsd;
      costRuns += 1;
    }
    const screen = nullScreenOf(run);
    const screened = screen.screened ?? 0;
    if (screen.enabled && screened > 0) {
      screenRuns += 1;
      screenCalls += screened;
      screenInputTokens += screen.inputTokens ?? 0;
      screenOutputTokens += screen.outputTokens ?? 0;
    }
  }
  return {
    runs: usable.length,
    servers,
    scored,
    refused: usable.length - scored,
    costUsd: costRuns > 0 ? costUsd : null,
    costRuns,
    /** Runs whose tapes carry at least one non echoed assistant turn. */
    turnRuns,
    /** Runs that carry model turns the price table could not price. */
    unpricedRuns,
    screenRuns,
    screenCalls,
    screenInputTokens,
    screenOutputTokens
  };
}

export function probeFindings(run) {
  const probes = run && typeof run.probes === 'object' && run.probes !== null ? run.probes : {};
  return Array.isArray(probes.findings) ? probes.findings.filter((f) => f && typeof f === 'object') : [];
}

/** Passed, failed and could-not-check counts. Unknown never counts as a pass. */
export function hygieneOf(run) {
  const findings = probeFindings(run);
  const passed = findings.filter((f) => f.pass === true);
  const failed = findings.filter((f) => f.pass === false);
  const unknown = findings.filter((f) => f.pass !== true && f.pass !== false);
  return { findings, passed, failed, unknown, checked: passed.length + failed.length };
}

export function specCurrencyOf(run) {
  const probes = run && typeof run.probes === 'object' && run.probes !== null ? run.probes : {};
  const version = typeof probes.specCurrency === 'string' && probes.specCurrency ? probes.specCurrency : null;
  const server = run && run.server ? run.server : null;
  const era = server && (server.era === 'modern' || server.era === 'legacy') ? server.era : null;
  return { version, era };
}

/** Only https links are ever put in the DOM. Anything else is not a link. */
export function safeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Merged two plane viewer link, per the published trace scheme. The semicolon
 * is the separator, so a trace URL that contains one cannot be linked.
 */
export function buildViewerUrl(mcpUrl, agentUrl) {
  const mcp = safeUrl(mcpUrl);
  const agent = safeUrl(agentUrl);
  const usable = [mcp, agent].filter((u) => u !== null && !u.includes(';'));
  if (usable.length === 0) return null;
  const trace = usable.map((u) => encodeURIComponent(u)).join(';');
  return `${VIEWER_BASE}?trace=${trace}#view=calls`;
}

/** The replay link for a run, preferring the one the harness recorded. */
export function replayUrlOf(run) {
  const links = run && typeof run.traceLinks === 'object' && run.traceLinks !== null ? run.traceLinks : null;
  if (!links) return null;
  const viewer = safeUrl(links.viewer);
  if (viewer) return viewer;
  return buildViewerUrl(links.mcp, links.agent);
}

export function intervalAriaLabel(interval) {
  return [
    `first try success ${fmtPct(interval.rate)}`,
    `Wilson 95 percent interval ${fmtPct(interval.low)} to ${fmtPct(interval.high)}`,
    `${interval.k} of ${interval.n} tasks`
  ].join(', ');
}

// ---------------------------------------------------------------------------
// tiny DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function link(href, text, className) {
  const url = safeUrl(href);
  if (!url) return el('span', className ? `${className} is-missing` : 'is-missing', text);
  const a = el('a', className, text);
  a.href = url;
  a.rel = 'noopener noreferrer';
  a.target = '_blank';
  return a;
}

/**
 * An evidence link for one finding. When no trace was published the caller gets
 * a plain "no recording published" marker instead of a live link, so a finding
 * never stands on this page as a bare count.
 */
function evidenceLink(run, label) {
  const url = replayUrlOf(run);
  if (!url) return el('span', 'evidence is-missing', 'no recording published');
  const a = link(url, label || 'evidence', 'evidence');
  a.title = 'Open the recorded session behind this finding';
  return a;
}

function definition(parent, term, value) {
  const dt = el('dt', null, term);
  const dd = el('dd', null, value);
  parent.appendChild(dt);
  parent.appendChild(dd);
  return dd;
}

// ---------------------------------------------------------------------------
// cells
// ---------------------------------------------------------------------------

function serverCell(run, placement) {
  const td = el('td', 'cell-server');
  const chip = el('span', 'rank-chip');
  if (placement && placement.rank) {
    chip.classList.add(placement.tied ? 'rank-tied' : 'rank-solo');
    chip.textContent = placement.tied ? `Tied at ${placement.rank}` : `Rank ${placement.rank}`;
    if (placement.tied) {
      chip.title = `${placement.groupSize} servers whose 95% intervals overlap. They share this position.`;
    }
  } else {
    chip.classList.add('rank-none');
    chip.textContent = 'Not ranked';
    chip.title = 'This run produced no score, so it takes no position.';
  }
  td.appendChild(chip);

  const name = el('div', 'server-name', slugOf(run));
  td.appendChild(name);

  const server = run.server && typeof run.server === 'object' ? run.server : {};
  const url = el('div', 'server-url');
  url.appendChild(el('code', null, typeof server.url === 'string' ? server.url : 'url not recorded'));
  td.appendChild(url);

  const bits = [];
  if (server.era) bits.push(`${server.era} era`);
  if (server.transportShape) bits.push(server.transportShape === 'sse' ? 'SSE framed' : 'plain JSON');
  if (typeof server.sessionful === 'boolean') bits.push(server.sessionful ? 'session-ful' : 'stateless');
  td.appendChild(el('div', 'server-meta', bits.join(' / ') || 'transport not recorded'));
  return td;
}

function outcomeCell(run) {
  const td = el('td', 'cell-outcome');
  const refusal = refusalOf(run);
  if (!refusal) {
    const pill = el('span', 'pill pill-scored', 'SCORED');
    td.appendChild(pill);
    const score = scoreOf(run) || {};
    const dl = el('dl', 'mini-figures');
    definition(dl, 'calls per task', fmtNum(score.meanCallsPerCompletedTask, 1));
    definition(dl, 'tokens per task', fmtInt(score.meanTokensPerCompletedTask));
    definition(dl, 'cost per task', fmtUsd(score.meanCostPerCompletedTaskUsd));
    td.appendChild(dl);
    td.appendChild(el('div', 'runner-note', `runner ${runnerModelOf(run)}`));
    return td;
  }

  td.classList.add('is-refused');
  const pill = el('span', 'pill pill-refused', 'REFUSED');
  td.appendChild(pill);
  td.appendChild(el('div', 'refusal-outcome', refusal.outcome));
  td.appendChild(el('div', 'refusal-gate', `stopped at the ${refusal.gateLabel} gate`));
  if (refusal.reason) {
    const reason = el('div', 'refusal-reason');
    reason.appendChild(el('code', null, refusal.reason));
    td.appendChild(reason);
  }
  // The row carries the counts. The sentence that explains them is one click
  // away, in the panel, so this cell stays a cell.
  const vline = verdictLine(refusal.verdict);
  const teaser = refusalTeaser(run);
  if (vline) td.appendChild(el('div', 'refusal-counts', vline));
  if (teaser) td.appendChild(el('div', 'refusal-teaser', teaser));
  if (!vline && !teaser) td.appendChild(el('div', 'refusal-counts', compactDetailLine(refusal.detail) || refusal.note));
  return td;
}

/**
 * detailLine, trimmed for a table cell: prose fields belong in the panel, where
 * there is room to read them, not folded into a row as a run on key value list.
 */
function compactDetailLine(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const skip = ['explain', 'note', 'reason', 'ok', 'halts', 'constructOracle', 'signalSource'];
  const parts = [];
  for (const [key, value] of Object.entries(detail)) {
    if (skip.includes(key) || value === null || typeof value === 'object') continue;
    if (typeof value === 'string' && value.length > 24) continue;
    const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    parts.push(`${label} ${typeof value === 'number' ? Number(value.toFixed(4)) : value}`);
    if (parts.length === 5) break;
  }
  return parts.length ? parts.join(', ') : null;
}

/** Flat primitive details render as "min tasks 8". Anything deeper is skipped. */
function detailLine(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const parts = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || typeof value === 'object') continue;
    const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    parts.push(`${label} ${value}`);
  }
  return parts.length ? parts.join(', ') : null;
}

function intervalCell(run, placement) {
  const td = el('td', 'cell-interval');
  const interval = firstTryInterval(run);
  if (!interval) {
    td.classList.add('is-refused');
    const refusal = refusalOf(run);
    td.appendChild(el('div', 'no-score', 'No score'));
    td.appendChild(
      el(
        'div',
        'no-score-why',
        refusal
          ? `${refusal.gateLabel} gate refused this run, so no success rate exists to report`
          : 'this record carries no first try interval'
      )
    );
    return td;
  }

  const figure = el('div', 'interval');
  figure.setAttribute('role', 'img');
  figure.setAttribute('aria-label', intervalAriaLabel(interval));
  const track = el('div', 'interval-track');
  const band = el('div', 'interval-band');
  band.style.setProperty('--low', `${(interval.low * 100).toFixed(2)}%`);
  band.style.setProperty('--high', `${(interval.high * 100).toFixed(2)}%`);
  const point = el('div', 'interval-point');
  point.style.setProperty('--rate', `${(interval.rate * 100).toFixed(2)}%`);
  track.appendChild(band);
  track.appendChild(point);
  figure.appendChild(track);
  td.appendChild(figure);

  const nums = el('div', 'interval-nums');
  nums.appendChild(el('span', 'interval-rate', fmtPct(interval.rate)));
  nums.appendChild(el('span', 'interval-ci', `95% CI ${fmtPct(interval.low)} to ${fmtPct(interval.high)}`));
  td.appendChild(nums);
  td.appendChild(el('div', 'interval-kn', `${interval.k} of ${interval.n} tasks solved on the first try`));
  if (placement && placement.overlapsAbove) {
    td.appendChild(
      el('div', 'interval-overlap', 'Not separated from the row above. The order between them carries no information.')
    );
  }
  return td;
}

function specCell(run) {
  const td = el('td', 'cell-spec');
  const { version, era } = specCurrencyOf(run);
  if (version) {
    td.appendChild(el('div', 'spec-version', version));
  } else {
    td.appendChild(el('div', 'spec-version is-missing', 'not negotiated'));
  }
  td.appendChild(el('div', 'spec-era', era ? `${era} era` : 'era not recorded'));
  return td;
}

function hygieneCell(run) {
  const td = el('td', 'cell-hygiene');
  const { findings, passed, failed, unknown, checked } = hygieneOf(run);
  if (findings.length === 0) {
    td.appendChild(el('div', 'is-missing', 'no probes recorded'));
    return td;
  }
  const head = el('div', 'hygiene-count');
  head.textContent = `${passed.length} of ${checked} checks passed`;
  if (failed.length > 0) head.classList.add('has-failures');
  td.appendChild(head);
  if (unknown.length > 0) {
    td.appendChild(el('div', 'hygiene-unknown', `${unknown.length} could not be checked`));
  }
  if (failed.length > 0) {
    const list = el('ul', 'hygiene-list');
    for (const finding of failed) {
      const li = el('li');
      li.appendChild(el('span', 'finding-id', String(finding.id || 'unnamed check')));
      li.appendChild(evidenceLink(run, 'evidence'));
      list.appendChild(li);
    }
    td.appendChild(list);
  }
  return td;
}

function credentialCell(run) {
  const td = el('td', 'cell-cred');
  const server = run.server && typeof run.server === 'object' ? run.server : {};
  const context = typeof server.credentialContext === 'string' ? server.credentialContext : null;
  if (!context) {
    td.appendChild(el('span', 'badge badge-unknown', 'not stamped'));
    return td;
  }
  const badge = el('span', `badge badge-${context.replace(/[^a-z-]/gi, '')}`, context);
  badge.title = CREDENTIAL_NOTES[context] || 'credential context recorded with this run';
  td.appendChild(badge);
  const score = scoreOf(run);
  const delta = score && Array.isArray(score.toolSurfaceDeltaByCredential) ? score.toolSurfaceDeltaByCredential : null;
  if (delta && delta.length > 0) {
    td.appendChild(el('div', 'cred-delta', `${delta.length} tools differ by credential`));
  }
  return td;
}

function replayCell(run) {
  const td = el('td', 'cell-replay');
  const url = replayUrlOf(run);
  if (!url) {
    td.appendChild(el('span', 'is-missing', 'no tape published'));
    return td;
  }
  const a = link(url, 'Open replay', 'replay-link');
  a.title = 'Opens the merged MCP and agent tapes in the viewer, in a new tab';
  td.appendChild(a);
  td.appendChild(el('div', 'replay-note', 'two planes, opens on click'));
  return td;
}

// ---------------------------------------------------------------------------
// detail panel
// ---------------------------------------------------------------------------

/**
 * One comparison drawn as bars. The bars are decorative: every number they
 * encode is written next to them as text, so the block reads the same with
 * styles off, at any contrast, and to a screen reader.
 */
function meterBlock(meter) {
  const wrap = el('div', 'meter');
  const threshold = meter.threshold && finite(meter.threshold.value) !== null ? meter.threshold : null;
  for (const row of meter.rows) {
    const rate = finite(row.rate);
    const line = el('div', `meter-row meter-${row.kind || 'null'}`);
    line.appendChild(el('div', 'meter-label', row.label));
    const track = el('div', 'meter-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('div', 'meter-fill');
    fill.style.setProperty('--value', `${((rate === null ? 0 : rate) * 100).toFixed(2)}%`);
    track.appendChild(fill);
    if (threshold) {
      const mark = el('div', 'meter-threshold');
      mark.style.setProperty('--at', `${(threshold.value * 100).toFixed(2)}%`);
      track.appendChild(mark);
    }
    line.appendChild(track);
    line.appendChild(el('div', 'meter-value', row.value || fmtPct(rate)));
    wrap.appendChild(line);
  }
  const notes = [meter.caption, threshold ? `Vertical rule: ${threshold.label}.` : null].filter((n) => n);
  if (notes.length > 0) wrap.appendChild(el('p', 'meter-caption', notes.join(' ')));
  return wrap;
}

/**
 * The refusal, told rather than named. This block is the reason the row is
 * expandable at all: the table can name the gate, but only the record's own
 * numbers can say what the gate saw.
 */
function refusalBlock(run) {
  const wrap = el('div', 'panel-block panel-refusal');
  const stories = refusalStories(run);
  wrap.appendChild(el('h4', null, 'Why there is no score'));
  const refusal = refusalOf(run);
  if (refusal) {
    const head = el('p', 'refusal-lede');
    head.appendChild(el('span', 'pill pill-refused', 'REFUSED'));
    head.appendChild(el('span', 'refusal-lede-text', `${refusal.outcome}: ${refusal.note}.`));
    wrap.appendChild(head);
  }
  if (stories.length === 0) {
    wrap.appendChild(
      el(
        'p',
        'is-missing',
        'This run carries no failed gate record, so the outcome above is all the record says. A refusal with no gate behind it is a defect in the run, not a finding about the server.'
      )
    );
    return wrap;
  }

  for (const story of stories) {
    const section = el('div', story.isPrimary ? 'story is-primary' : 'story is-secondary');
    const head = el('div', 'story-head');
    head.appendChild(el('span', 'story-gate', `${story.gateLabel} gate`));
    if (story.costTier) head.appendChild(el('span', 'story-tier', `${story.costTier} tier`));
    if (story.reason) head.appendChild(el('code', 'story-reason', story.reason));
    head.appendChild(
      el('span', 'story-role', story.isPrimary ? 'stopped the run' : 'also failed, recorded for the same run')
    );
    section.appendChild(head);

    if (story.headline) section.appendChild(el('p', 'story-headline', story.headline));
    if (story.meter) section.appendChild(meterBlock(story.meter));

    if (story.figures.length > 0) {
      // Each pair is wrapped so a label can never wrap onto one grid row while
      // its number sits on the next.
      const dl = el('dl', 'story-figures');
      for (const figure of story.figures) {
        const cell = el('div', 'story-figure');
        cell.appendChild(el('dt', null, figure.label));
        cell.appendChild(el('dd', null, figure.value));
        dl.appendChild(cell);
      }
      section.appendChild(dl);
    }
    for (const sentence of story.sentences) section.appendChild(el('p', 'story-line', sentence));
    if (story.limitation) {
      const note = el('p', 'story-limitation');
      note.appendChild(el('span', 'story-limitation-tag', 'Known gap in the harness'));
      note.appendChild(el('span', null, story.limitation));
      section.appendChild(note);
    }
    const vline = verdictLine(story.verdict);
    if (vline) section.appendChild(el('p', 'story-counts', `Gate counts as recorded: ${vline}.`));
    if (story.explain) {
      const quote = el('p', 'story-explain');
      quote.appendChild(el('span', 'story-explain-tag', 'Recorded verbatim'));
      quote.appendChild(el('span', null, story.explain));
      section.appendChild(quote);
    }
    const evidence = el('p', 'story-evidence');
    evidence.appendChild(el('span', null, 'Everything above is read from this run: '));
    evidence.appendChild(evidenceLink(run, 'open the recorded session'));
    section.appendChild(evidence);
    wrap.appendChild(section);
  }

  const notes = Array.isArray(run.scoreNotes) ? run.scoreNotes.filter((n) => typeof n === 'string' && n) : [];
  if (notes.length > 0) {
    const list = el('ul', 'story-notes');
    for (const note of notes) list.appendChild(el('li', null, note));
    wrap.appendChild(el('p', 'panel-note', 'Honesty notes the harness attached to this run:'));
    wrap.appendChild(list);
  }
  return wrap;
}

function gateTable(run) {
  const gates = run.gates && typeof run.gates === 'object' ? run.gates : {};
  const records = Array.isArray(gates.records) ? gates.records : [];
  const wrap = el('div', 'panel-block');
  wrap.appendChild(el('h4', null, 'Gate ledger'));
  if (records.length === 0) {
    wrap.appendChild(el('p', 'is-missing', 'no gate records in this run'));
    return wrap;
  }
  const table = el('table', 'panel-table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const heading of ['Gate', 'Cost', 'Result', 'Reason', 'Counts']) {
    const th = el('th', null, heading);
    th.scope = 'col';
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const tr = el('tr');
    tr.appendChild(el('td', null, gateLabel(record.gate)));
    tr.appendChild(el('td', null, record.costTier || 'not recorded'));
    const result = el('td');
    result.appendChild(el('span', record.ok === false ? 'tag tag-fail' : 'tag tag-ok', record.ok === false ? 'refused' : 'passed'));
    tr.appendChild(result);
    const reason = el('td');
    reason.appendChild(el('code', null, record.reason || 'no reason string'));
    tr.appendChild(reason);
    tr.appendChild(el('td', null, verdictLine(record.verdict) || compactDetailLine(record.detail) || 'no counts'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  const policy = gates.extensionPolicy && typeof gates.extensionPolicy === 'object' ? gates.extensionPolicy : null;
  if (policy) {
    wrap.appendChild(
      el(
        'p',
        'panel-note',
        policy.maxExtensions === 0
          ? 'Extension policy fixed before the first call: no extension batches are run, so a gate the data cannot resolve resolves immediately and the run is refused rather than extended.'
          : `Extension policy fixed before the first call: ${fmtInt(policy.extensionSize)} tasks per extension, at most ${fmtInt(policy.maxExtensions)} extensions.`
      )
    );
  }
  return wrap;
}

function findingsBlock(run) {
  const wrap = el('div', 'panel-block');
  wrap.appendChild(el('h4', null, 'Probe findings'));
  const findings = probeFindings(run);
  if (findings.length === 0) {
    wrap.appendChild(el('p', 'is-missing', 'no probes recorded for this run'));
    return wrap;
  }
  const list = el('ul', 'finding-list');
  for (const finding of findings) {
    const li = el('li', finding.pass === false ? 'finding is-fail' : finding.pass === true ? 'finding is-pass' : 'finding is-unknown');
    const head = el('div', 'finding-head');
    head.appendChild(
      el('span', 'tag', finding.pass === true ? 'pass' : finding.pass === false ? 'fail' : 'could not check')
    );
    head.appendChild(el('span', 'finding-id', String(finding.id || 'unnamed check')));
    head.appendChild(evidenceLink(run, 'evidence'));
    li.appendChild(head);
    li.appendChild(el('p', 'finding-detail', String(finding.detail || 'no detail recorded')));
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function toolsBlock(run) {
  const score = scoreOf(run);
  const tools = score && Array.isArray(score.tools) ? score.tools : [];
  const wrap = el('div', 'panel-block');
  wrap.appendChild(el('h4', null, 'Per tool attribution'));
  if (tools.length === 0) {
    wrap.appendChild(el('p', 'is-missing', 'no tool level numbers exist for a run that was refused before the drive'));
    return wrap;
  }
  const table = el('table', 'panel-table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const heading of ['Tool', 'Calls', 'Errors', 'p50', 'p95', 'Destructive declared', 'Destructive inferred']) {
    const th = el('th', null, heading);
    th.scope = 'col';
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const tr = el('tr');
    tr.appendChild(el('td', null, String(tool.tool || 'unnamed tool')));
    tr.appendChild(el('td', null, fmtInt(tool.calls)));
    const errors = el('td');
    const classes = tool.failureClasses && typeof tool.failureClasses === 'object' ? Object.entries(tool.failureClasses) : [];
    errors.appendChild(el('span', null, fmtInt(tool.errors)));
    if (classes.length > 0) {
      errors.appendChild(el('div', 'failure-classes', classes.map(([k, v]) => `${k} ${v}`).join(', ')));
    }
    tr.appendChild(errors);
    tr.appendChild(el('td', null, tool.p50Ms === null ? 'not timed' : `${fmtInt(tool.p50Ms)} ms`));
    tr.appendChild(el('td', null, tool.p95Ms === null ? 'not timed' : `${fmtInt(tool.p95Ms)} ms`));
    tr.appendChild(el('td', null, tool.declaredDestructive ? 'yes' : 'no'));
    tr.appendChild(
      el('td', null, tool.inferredDestructive === null || tool.inferredDestructive === undefined ? 'not judged' : tool.inferredDestructive ? 'yes' : 'no')
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.appendChild(
    el(
      'p',
      'panel-note',
      'A tool counts as destructive unless it declares readOnlyHint true or destructiveHint false, because those are the spec defaults. Declared and inferred disagreement is itself a finding.'
    )
  );
  return wrap;
}

function scoreBlock(run) {
  const score = scoreOf(run);
  const wrap = el('div', 'panel-block');
  wrap.appendChild(el('h4', null, 'Run record'));
  const dl = el('dl', 'panel-dl');
  const meta = run.run && typeof run.run === 'object' ? run.run : {};
  definition(dl, 'run id', String(meta.id || 'not recorded'));
  definition(dl, 'started', String(meta.startedAt || 'not recorded'));
  definition(dl, 'harness', String(meta.harnessVersion || 'not recorded'));
  definition(dl, 'runner model', runnerModelOf(run));
  definition(dl, 'judge model', String(meta.judgeModel || 'not recorded'));
  definition(dl, 'suite hash', String(meta.suiteHash || 'not recorded'));
  definition(dl, 'task budget', fmtInt(meta.taskBudget));
  const screen = nullScreenOf(run);
  definition(
    dl,
    'task generator',
    `${generatorVersionOf(run)}${
      screen.enabled
        ? `, null screen on: ${fmtInt(screen.dropped)} of ${fmtInt(screen.screened)} screened candidates deleted before the suite hash`
        : ', no generation time null screen'
    }`
  );
  if (score) {
    const eventual = score.eventualSuccess && typeof score.eventualSuccess === 'object' ? score.eventualSuccess : null;
    if (eventual) {
      definition(
        dl,
        'eventual success',
        `${fmtPct(eventual.rate)} (95% CI ${fmtPct(eventual.low)} to ${fmtPct(eventual.high)}), ${fmtInt(eventual.k)} of ${fmtInt(eventual.n)}`
      );
    }
    definition(dl, 'destructive calls without confirmation', fmtInt(score.destructiveWithoutConfirmation));
    const drift = score.schemaDrift && typeof score.schemaDrift === 'object' ? score.schemaDrift : null;
    if (drift) {
      definition(
        dl,
        'output schema drift',
        drift.checked ? (drift.drifted ? String(drift.detail || 'drift observed') : 'checked, none observed') : 'not checked'
      );
    }
  }
  wrap.appendChild(dl);

  const ambiguous = score && Array.isArray(score.ambiguousParameters) ? score.ambiguousParameters : [];
  if (ambiguous.length > 0) {
    wrap.appendChild(el('h4', null, 'Ambiguous parameters'));
    const list = el('ul', 'finding-list');
    for (const item of ambiguous) {
      const li = el('li', 'finding is-fail');
      const head = el('div', 'finding-head');
      head.appendChild(el('span', 'finding-id', `${item.tool}.${item.param}`));
      head.appendChild(evidenceLink(run, 'recorded session'));
      li.appendChild(head);
      li.appendChild(el('p', 'finding-detail', String(item.why || 'no explanation recorded')));
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  const rewrites = Array.isArray(run.rewrites) ? run.rewrites : [];
  if (rewrites.length > 0) {
    wrap.appendChild(el('h4', null, 'Proposed rewrites'));
    const list = el('ul', 'rewrite-list');
    for (const rewrite of rewrites) {
      const li = el('li');
      li.appendChild(el('div', 'rewrite-tool', String(rewrite.tool || 'unnamed tool')));
      li.appendChild(el('p', 'rewrite-current', `current: ${String(rewrite.current || '')}`));
      li.appendChild(el('p', 'rewrite-proposed', `proposed: ${String(rewrite.proposed || '')}`));
      const why = el('p', 'rewrite-why');
      why.appendChild(el('span', null, String(rewrite.causalEvidence || 'no causal evidence recorded')));
      why.appendChild(evidenceLink(run, 'recorded sessions'));
      li.appendChild(why);
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  const links = run.traceLinks && typeof run.traceLinks === 'object' ? run.traceLinks : null;
  wrap.appendChild(el('h4', null, 'Tapes'));
  if (!links) {
    wrap.appendChild(el('p', 'is-missing', 'no tapes were published for this run'));
  } else {
    const list = el('ul', 'trace-list');
    const mcp = el('li');
    mcp.appendChild(el('span', null, 'MCP wire plane: '));
    mcp.appendChild(link(links.mcp, String(links.mcp || 'not published')));
    list.appendChild(mcp);
    const agent = el('li');
    agent.appendChild(el('span', null, 'agent plane: '));
    agent.appendChild(link(links.agent, String(links.agent || 'not published')));
    list.appendChild(agent);
    wrap.appendChild(list);
  }
  return wrap;
}

/**
 * `report.methods`, rendered verbatim.
 *
 * This is where the harness discloses what it diverged on and what it knows is
 * biased, including the one thing this page most needs a reader to know: on a
 * screened suite the null baseline measures a suite the screen already purged
 * of null answerable tasks. The page asserts that no threshold was ever
 * loosened, which is true, and a disclosure the leaderboard drops on the floor
 * would make that assertion read as more than it is.
 */
function methodsBlock(run) {
  const wrap = el('div', 'panel-block panel-methods');
  wrap.appendChild(el('h4', null, 'Method notes and known bias'));
  const notes = Array.isArray(run.methods) ? run.methods.filter((n) => typeof n === 'string' && n.length > 0) : [];
  if (notes.length === 0) {
    wrap.appendChild(el('p', 'is-missing', 'this record carries no methods block'));
    return wrap;
  }
  wrap.appendChild(
    el(
      'p',
      'panel-note',
      'Written by the harness with the run and reproduced verbatim. Divergences from the ported gate math, and the biases this design knows it has, are stated here rather than summarised away.'
    )
  );
  const list = el('ul', 'methods-list');
  for (const note of notes) list.appendChild(el('li', null, note));
  wrap.appendChild(list);
  return wrap;
}

function detailPanel(run, panelId) {
  const tr = el('tr', 'detail-row');
  tr.id = panelId;
  tr.hidden = true;
  const td = el('td', 'detail-cell');
  td.colSpan = 7;
  const inner = el('div', 'detail-inner');
  // A refused run leads with why. The gate ledger below is the audit trail, not
  // the explanation, and putting the ledger first has readers guessing again.
  if (run.outcome !== 'SCORED') inner.appendChild(refusalBlock(run));
  inner.appendChild(scoreBlock(run));
  inner.appendChild(gateTable(run));
  inner.appendChild(findingsBlock(run));
  inner.appendChild(toolsBlock(run));
  inner.appendChild(methodsBlock(run));
  td.appendChild(inner);
  tr.appendChild(td);
  return tr;
}

// ---------------------------------------------------------------------------
// rows and board
// ---------------------------------------------------------------------------

function bandRow(text, note, className) {
  const tr = el('tr', `band-row ${className || ''}`.trim());
  const th = el('th');
  th.colSpan = 7;
  th.scope = 'colgroup';
  th.appendChild(el('span', 'band-title', text));
  if (note) th.appendChild(el('span', 'band-note', note));
  tr.appendChild(th);
  return tr;
}

function runRow(run, placement, index) {
  const rows = [];
  const refused = run.outcome !== 'SCORED';
  const tr = el('tr', refused ? 'run-row is-refused-row' : 'run-row is-scored-row');
  const panelId = `detail-${index}`;
  if (placement && placement.tied) {
    tr.classList.add('is-tied');
    tr.dataset.tieGroup = String(placement.groupId);
  }
  tr.appendChild(serverCell(run, placement));
  tr.appendChild(outcomeCell(run));
  tr.appendChild(intervalCell(run, placement));
  tr.appendChild(specCell(run));
  tr.appendChild(hygieneCell(run));
  tr.appendChild(credentialCell(run));
  const replay = replayCell(run);
  const closedLabel = refused ? 'Why refused' : 'Details';
  const openLabel = refused ? 'Hide the reason' : 'Hide details';
  const toggle = el('button', refused ? 'toggle toggle-refused' : 'toggle', closedLabel);
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);
  toggle.title = refused
    ? 'Open the measured reason this run was refused'
    : 'Open the run record, gate ledger and per tool numbers';
  replay.appendChild(toggle);
  tr.appendChild(replay);

  const panel = detailPanel(run, panelId);
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    toggle.textContent = open ? closedLabel : openLabel;
    panel.hidden = open;
    tr.classList.toggle('is-open', !open);
  });

  rows.push(tr, panel);
  return rows;
}

/**
 * The one sentence under the spend figure, derived from the records rather than
 * assumed. "No cost" used to be printed as "no tape carries model usage" and
 * "the rest stopped at a free gate before any model turn", and both are claims
 * this page cannot make: an unpriced model produces the same absent total as a
 * model that never ran, and a run refused at a free gate has still paid for the
 * generation time null screen.
 */
export function spendNote(stats) {
  const parts = [];
  if (stats.costUsd === null) {
    if (stats.turnRuns === 0 && stats.unpricedRuns === 0) parts.push('no tape in this pass carries a model turn');
    else
      parts.push(
        `model turns appear on ${stats.turnRuns} of ${stats.runs} tapes and no model on them has a price on file`
      );
  } else {
    parts.push(`priced on ${stats.costRuns} of ${stats.runs} tapes`);
    if (stats.unpricedRuns > 0) {
      parts.push(
        `${stats.unpricedRuns} ${stats.unpricedRuns === 1 ? 'tape carries' : 'tapes carry'} turns with no price on file, so this is a lower bound`
      );
    }
    const silent = stats.runs - Math.max(stats.turnRuns, stats.costRuns);
    if (silent > 0) parts.push(`${silent} recorded no model turn on either plane`);
  }
  if (stats.screenRuns > 0) parts.push('generation time screen spend is excluded, see below');
  return parts.join('; ');
}

/**
 * The masthead figures. Cost is the one number here that can be missing, and it
 * is labelled with the count of runs it covers rather than quietly summed over
 * everything, because a total that silently spans nine of sixteen runs is a
 * wrong number dressed as a right one.
 */
export function renderStats(node, runs) {
  if (!node) return;
  node.textContent = '';
  const stats = boardStats(runs);
  const cells = [
    { label: 'Servers tested', value: String(stats.servers), note: `${stats.runs} published ${stats.runs === 1 ? 'run' : 'runs'}` },
    { label: 'Scored', value: String(stats.scored), note: stats.scored === 0 ? 'no run in this pass produced a number' : 'gates passed, numbers published' },
    { label: 'Refused', value: String(stats.refused), note: 'each one names the gate that stopped it' },
    {
      label: 'Measured model spend',
      value: stats.costUsd === null ? 'none recorded' : fmtUsd(stats.costUsd, 2),
      note: spendNote(stats)
    }
  ];
  const grid = el('dl', 'stat-grid');
  for (const cell of cells) {
    const item = el('div', 'stat');
    item.appendChild(el('dt', 'stat-label', cell.label));
    const dd = el('dd', 'stat-value', cell.value);
    dd.appendChild(el('span', 'stat-note', cell.note));
    item.appendChild(dd);
    grid.appendChild(item);
  }
  node.appendChild(grid);
  if (stats.scored === 0 && stats.runs > 0) {
    const note = el('p', 'stat-strip-note');
    note.textContent =
      'Every run in this pass was refused. That is the published result, not a gap in the table: each row below carries the gate, the counts it measured and the recording behind them.';
    node.appendChild(note);
  }
  // The screen is a bias this page introduces and it is disclosed at the top of
  // the board, not only inside a run's own methods block. A PROCEED on a
  // screened suite is not the same evidence as a PROCEED on an unscreened one,
  // and a reader who is not told cannot tell them apart.
  if (stats.screenRuns > 0) {
    const note = el('p', 'stat-strip-note');
    note.textContent =
      `${stats.screenRuns} of ${stats.runs} ${stats.runs === 1 ? 'run' : 'runs'} used a generation time null screen: candidates a model answered correctly with no server at all were deleted before the suite was hashed and before any gate ran. ` +
      `The run time null baseline on those rows therefore measures the noise floor of an already screened suite and is biased downward by construction. The screen made ${stats.screenCalls} runner model ${stats.screenCalls === 1 ? 'call' : 'calls'} (${stats.screenInputTokens} input and ${stats.screenOutputTokens} output tokens) that are written to neither tape, so they are not in the spend above. Each row's method notes carry its own counts.`;
    node.appendChild(note);
  }
}

export function summarise(runs) {
  const scored = runs.filter((run) => run && run.outcome === 'SCORED').length;
  const refused = runs.length - scored;
  const servers = new Set(runs.map((run) => slugOf(run))).size;
  return { total: runs.length, scored, refused, servers };
}

export function summaryText(runs) {
  const { total, scored, refused, servers } = summarise(runs);
  if (total === 0) return 'No runs published yet.';
  const noun = servers === 1 ? 'server' : 'servers';
  return `${total} runs across ${servers} ${noun}. ${scored} scored, ${refused} refused. Refusals are rows, not gaps.`;
}

/** Render the whole table body. Pure in, DOM out. */
export function renderBoard(tbody, runs) {
  tbody.textContent = '';
  const usable = Array.isArray(runs) ? runs.filter((run) => run && typeof run === 'object') : [];
  if (usable.length === 0) {
    const tr = el('tr', 'state-row');
    const td = el('td', null, 'No runs in data/runs.json yet.');
    td.colSpan = 7;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  let index = 0;
  const groups = rankGroups(usable);
  const multiBand = groups.length > 1;
  for (const group of groups) {
    tbody.appendChild(
      bandRow(
        `Ranked under runner model ${group.runnerModel}, task generator ${group.generatorVersion}`,
        multiBand
          ? 'Ranked only within this band. Token accounting is not comparable across runner models, and admission and screen counts are not comparable across task generators.'
          : 'Rankings hold within one runner model and one task generator. Both are pinned into every run record.',
        'band-model'
      )
    );
    for (const row of group.rows) {
      for (const node of runRow(row.run, row, index++)) tbody.appendChild(node);
    }
  }

  const unranked = usable.filter((run) => !isRankable(run));
  if (unranked.length > 0) {
    tbody.appendChild(
      bandRow(
        'Refused, and published as such',
        'A gate stopped these runs before a score existed, or the record carries no usable interval. The gate, its counts and its reason stand in place of the number.',
        'band-refused'
      )
    );
    const sorted = unranked.slice().sort((a, b) => slugOf(a).localeCompare(slugOf(b)));
    for (const run of sorted) {
      for (const node of runRow(run, null, index++)) tbody.appendChild(node);
    }
  }
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

export async function loadRuns(url = DATA_URL, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('no fetch implementation available');
  const response = await doFetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`could not load ${url}: HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`${url} must contain an array of fitness-report/1 records`);
  return data;
}

export async function main(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const tbody = doc.getElementById('board-body');
  const summary = doc.getElementById('summary-line');
  const strip = doc.getElementById('stat-strip');
  if (!tbody) return;
  try {
    const runs = await loadRuns();
    renderBoard(tbody, runs);
    renderStats(strip, runs);
    if (summary) summary.textContent = summaryText(runs);
  } catch (error) {
    tbody.textContent = '';
    const tr = el('tr', 'state-row is-error');
    const td = el('td');
    td.colSpan = 7;
    td.textContent = `Could not render the leaderboard: ${error && error.message ? error.message : String(error)}`;
    tr.appendChild(td);
    tbody.appendChild(tr);
    if (summary) summary.textContent = 'The run data did not load. Nothing below is current.';
    if (strip) {
      strip.textContent = '';
      strip.appendChild(
        el('p', 'stat-strip-note', 'The run data did not load, so there are no counts to show. Nothing on this page is current.')
      );
    }
  }
}

function documentReady() {
  return typeof document !== 'undefined' && document.readyState !== 'loading';
}

// Browser only. Importing this module in Node (tests, checks) runs no DOM code.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (documentReady()) main();
  else document.addEventListener('DOMContentLoaded', () => main());
}
