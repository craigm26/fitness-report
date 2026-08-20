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
  // True of both eras. Where extensions were registered and spent, an unresolved
  // gate resolves to FAIL and the run refuses as GATE_FAILED, so this outcome is
  // reached only where there was no batch left to buy: either the
  // pre-registration bought none, or the run predates the protocol entirely.
  EXTEND_EXHAUSTED: 'the gate resolved neither way and there was no extension batch left to buy',
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

/** The version string a record carries, or null when it carries none. */
export function hasRecordedGenerator(run) {
  return generatorVersionOf(run) !== 'unrecorded generator';
}

/**
 * The generator badge every row carries, so two generator versions are never
 * read off this page as one ranking even where they sit in the same section.
 * A record with no version field is badged as exactly that, never as v1.
 */
export function generatorBadgeOf(run) {
  const version = generatorVersionOf(run);
  const known = hasRecordedGenerator(run);
  return {
    version,
    known,
    label: known ? version : 'generator not recorded',
    note: known
      ? `Task suite generated by ${version}. Rows are compared only with rows from the same generator, because a different generator is a different denominator.`
      : 'This record predates the generator version field. Its admission, drop and screen counts are not comparable with a recorded generator, so it is never ranked against one.'
  };
}

/**
 * Suite lineage, where the record carries it.
 *
 * The pipeline writes these fields; this page only reports them. Absent fields
 * render nothing at all: a lineage row reading "not recorded" on every run would
 * be noise, and inventing a parent hash would be worse. Values are read from the
 * run block, from the synthesis ledger, and from any lineage object the record
 * carries, and only primitives are rendered.
 */
export const LINEAGE_LABELS = {
  suiteVersion: 'suite version',
  suiteGeneration: 'suite generation',
  parentSuiteHash: 'parent suite hash',
  sourceSuiteHash: 'source suite hash',
  previousSuiteHash: 'previous suite hash',
  parentRunId: 'parent run',
  derivedFrom: 'derived from',
  regeneratedFrom: 'regenerated from',
  extendedFrom: 'extended from',
  generatorModel: 'generator model',
  generatorSeed: 'generator seed',
  seed: 'generator seed',
  promptVersion: 'generator prompt version'
};

export function suiteLineageOf(run) {
  const meta = asObject(run && run.run);
  const synthesis = synthesisOf(run);
  const lineageBlocks = [
    asObject(meta.suiteLineage),
    asObject(meta.lineage),
    asObject(run && run.suiteLineage),
    asObject(synthesis.lineage),
    asObject(synthesis.suiteLineage)
  ];
  const rows = [];
  const seen = new Set();
  const take = (key, value) => {
    if (value === null || value === undefined || typeof value === 'object') return;
    if (typeof value === 'string' && value.length === 0) return;
    const label =
      LINEAGE_LABELS[key] || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    // Two spellings of one fact are one row: `seed` and `generatorSeed` carry
    // the same label and the first one found wins.
    if (seen.has(label)) return;
    seen.add(label);
    rows.push({ key, label, value: String(value) });
  };
  // Named fields first, wherever they sit, then anything else a lineage block
  // carries, so a field added later still reaches the page without a code change.
  for (const key of Object.keys(LINEAGE_LABELS)) {
    for (const source of [meta, synthesis, ...lineageBlocks]) take(key, asObject(source)[key]);
  }
  for (const block of lineageBlocks) {
    for (const [key, value] of Object.entries(block)) take(key, value);
  }
  return rows;
}

/**
 * Which run this row is. Not which server: which run.
 *
 * A server can be driven again at any time, and each drive is its own suite
 * under its own hash. Two rows for one server are therefore two measurements,
 * not two views of one, and a reader cannot tell them apart without the suite
 * hash and the start time. Every field here is read from the record.
 */
export function runIdentityOf(run) {
  const meta = asObject(run && run.run);
  const hash = typeof meta.suiteHash === 'string' && meta.suiteHash ? meta.suiteHash : null;
  return {
    slug: slugOf(run),
    runId: typeof meta.id === 'string' && meta.id ? meta.id : null,
    generator: generatorVersionOf(run),
    suiteHash: hash,
    /** Enough hash to tell two suites apart, and short enough to sit in a cell. */
    suitePrefix: hash === null ? null : hash.slice(0, 12),
    startedAt: typeof meta.startedAt === 'string' && meta.startedAt ? meta.startedAt : null,
    outcome: run && typeof run.outcome === 'string' ? run.outcome : 'UNKNOWN_OUTCOME'
  };
}

/** The identity of one run in one line. Missing fields say so, never blank. */
export function runIdentityLine(run) {
  const id = runIdentityOf(run);
  return [
    id.suitePrefix === null ? 'suite hash not recorded' : `suite ${id.suitePrefix}`,
    id.startedAt === null ? 'start time not recorded' : `started ${id.startedAt}`
  ].join(' / ');
}

/**
 * Every published run of a server, oldest first, keyed by slug.
 *
 * A rerun is a separate attempt, never a replacement, so nothing is dropped or
 * folded here: the map holds all of them and the page prints all of them. The
 * pre-registration binds what happens inside one run. It says nothing about how
 * many runs are attempted, which is exactly why every attempt has to stay
 * visible with its own identity.
 */
export function serverCohorts(runs) {
  const usable = Array.isArray(runs) ? runs.filter((run) => run && typeof run === 'object') : [];
  const bySlug = new Map();
  usable.forEach((run, order) => {
    const slug = slugOf(run);
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push({ run, order });
  });
  const cohorts = new Map();
  for (const [slug, rows] of bySlug) {
    const sorted = [...rows].sort((a, b) => {
      const at = runIdentityOf(a.run).startedAt;
      const bt = runIdentityOf(b.run).startedAt;
      // A record with no start time keeps its file order rather than being
      // sorted as though it were the oldest.
      if (at !== null && bt !== null && at !== bt) return at < bt ? -1 : 1;
      return a.order - b.order;
    });
    cohorts.set(slug, { slug, total: sorted.length, runs: sorted.map((row) => row.run) });
  }
  return cohorts;
}

/** Where one row sits among the published runs of its server. */
export function cohortPlaceOf(cohorts, run) {
  const cohort = cohorts instanceof Map ? cohorts.get(slugOf(run)) : null;
  if (!cohort) return null;
  const index = cohort.runs.indexOf(run);
  return {
    slug: cohort.slug,
    total: cohort.total,
    attempt: index >= 0 ? index + 1 : null,
    siblings: cohort.runs.filter((other) => other !== run).map(runIdentityOf)
  };
}

/** Servers with more than one published run, and how many rows they account for. */
export function rerunSummary(runs) {
  const cohorts = serverCohorts(runs);
  let servers = 0;
  let rows = 0;
  for (const cohort of cohorts.values()) {
    if (cohort.total > 1) {
      servers += 1;
      rows += cohort.total;
    }
  }
  return { servers, rows, totalServers: cohorts.size };
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

/** The first of these keys that carries a finite number, or null. */
function firstNumber(source, keys) {
  const o = asObject(source);
  for (const key of keys) {
    const n = finite(o[key]);
    if (n !== null) return n;
  }
  return null;
}

/** The first of these keys that carries a non empty string, or null. */
function firstString(source, keys) {
  const o = asObject(source);
  for (const key of keys) {
    const value = o[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * One usage entry, read by shape rather than by an exact field name.
 *
 * The harness writes judge usage; this page reads it. Spelling one field name
 * into the renderer and rendering nothing when the writer picks another is how
 * a cost figure quietly loses a whole model, so the reader accepts the obvious
 * spellings and returns null when a value carries none of them. Null here means
 * "this record says nothing", which is rendered as silence, never as a zero.
 */
export function normaliseUsage(value) {
  const o = asObject(value);
  const entry = {
    model: firstString(o, ['model', 'judgeModel', 'name']),
    phase: firstString(o, ['phase', 'stage', 'label', 'purpose']),
    calls: firstNumber(o, ['calls', 'requests', 'count', 'n']),
    inputTokens: firstNumber(o, ['inputTokens', 'input_tokens', 'input']),
    outputTokens: firstNumber(o, ['outputTokens', 'output_tokens', 'output']),
    costUsd: firstNumber(o, ['costUsd', 'estCostUsd', 'totalUsd', 'usd', 'cost'])
  };
  const carries =
    entry.model !== null ||
    entry.phase !== null ||
    entry.calls !== null ||
    entry.inputTokens !== null ||
    entry.outputTokens !== null ||
    entry.costUsd !== null;
  return carries ? entry : null;
}

/**
 * What the record says the judge model spent, from wherever the harness put it.
 *
 * The judge does the task synthesis and the destructiveness signal, and none of
 * that is written to either tape: the tapes carry the runner. So a run's tape
 * cost is the runner's cost and nothing else, and until a record carries judge
 * usage this reader returns `present: false` and the page says the judge spend
 * is not recorded rather than assuming a figure for it.
 *
 * `costUsd` is null unless an entry carries dollars. Tokens are never converted
 * to dollars here: unknown pricing fails closed, and a price table on this page
 * would be a second copy of the harness's pricing that can drift from it.
 */
export function judgeUsageOf(run) {
  const root = asObject(run);
  const containers = [
    root.judgeUsage,
    root.judge_usage,
    asObject(root.run).judgeUsage,
    asObject(root.run).judge_usage,
    asObject(scoreOf(run)).judgeUsage,
    asObject(root.trace_stats).judgeUsage
  ];
  const raw = containers.find((value) => value !== undefined && value !== null) ?? null;
  const block = asObject(raw);
  let entries = [];
  if (Array.isArray(raw)) {
    entries = raw.map(normaliseUsage).filter((e) => e !== null);
  } else if (raw !== null) {
    // `byModel` and `byPhase` are breakdowns OF the block's own totals, so they
    // are never summed as entries: that would count this run's judge spend
    // twice. Only a container that carries nothing but a list is read as one.
    const nested = [block.entries, block.perPhase, block.usages].find((value) => Array.isArray(value));
    if (nested) entries = nested.map(normaliseUsage).filter((e) => e !== null);
    else {
      const single = normaliseUsage(raw);
      entries = single ? [single] : [];
    }
  }
  // Summed only over the entries that carry the field: an entry that is silent
  // about tokens must not read as an entry that reported zero of them.
  const add = (key) => {
    let total = null;
    for (const entry of entries) {
      if (entry[key] === null) continue;
      total = (total ?? 0) + entry[key];
    }
    return total;
  };
  const byPhase = Array.isArray(block.byPhase)
    ? block.byPhase.map(normaliseUsage).filter((e) => e !== null)
    : [];
  // Read for NAMES, never for sums. `byModel` breaks the block's own totals down
  // per model id, and a model in there with no dollars is judge spend the price
  // table could not price: the block's total is then a floor and the page has to
  // say which model made it one.
  const byModel = Array.isArray(block.byModel)
    ? block.byModel.map(normaliseUsage).filter((e) => e !== null)
    : [];
  const notes = Array.isArray(block.notes) ? block.notes.filter((n) => typeof n === 'string' && n.length > 0) : [];
  const usage = {
    present: entries.length > 0,
    entries,
    byPhase,
    byModel,
    notes,
    model: entries.map((e) => e.model).find((m) => m !== null) ?? null,
    calls: add('calls'),
    inputTokens: add('inputTokens'),
    outputTokens: add('outputTokens'),
    costUsd: add('costUsd'),
    /** True when some judge usage could not be priced, so the dollars are a floor. */
    partial: block.partial === true,
    /** Calls that returned no usage block: counted as calls, never as tokens. */
    uncountedCalls: finite(block.uncountedCalls),
    /** Calls that threw before reporting usage. Their spend is unknowable. */
    failedCalls: finite(block.failedCalls),
    /** Entries that carry usage but no dollars: a lower bound, said out loud. */
    unpricedEntries: entries.filter((e) => e.costUsd === null).length,
    /** Judge model ids the record carries usage for and no price for. */
    unpricedModels: byModel.filter((e) => e.costUsd === null).map((e) => e.model || 'unnamed model')
  };
  /**
   * True when the record itself says the judge dollars are not all of the judge
   * spend. A floor is never allowed to reach the page as a total.
   */
  usage.floor = judgeFloorReasons(usage).length > 0;
  return usage;
}

/**
 * Why a judge figure is a floor rather than a total, in the record's own terms.
 *
 * Four things make it one, and each is a field the harness writes: `partial`
 * (some usage could not be priced at all), a `byModel` entry with no price on
 * file, calls that returned no usage block, and calls that threw before
 * reporting any. Every one of them means dollars were spent that are not in the
 * figure, so the figure is a lower bound. None of them is ever estimated: the
 * page names the gap and leaves the number alone.
 */
export function judgeFloorReasons(judge) {
  if (!judge || typeof judge !== 'object') return [];
  const reasons = [];
  const unpriced = Array.isArray(judge.unpricedModels) ? judge.unpricedModels : [];
  if (judge.partial === true) {
    reasons.push(
      'the judge usage on this run is recorded as partial, so some of what the judge spent could not be priced and the judge dollars here are a lower bound'
    );
  }
  if (unpriced.length > 0) {
    reasons.push(
      `${unpriced.length} judge ${unpriced.length === 1 ? 'model has' : 'models have'} usage recorded with no price on file (${unpriced.join(
        ', '
      )}), so what ${unpriced.length === 1 ? 'it' : 'they'} spent is outside this figure and is not estimated`
    );
  }
  const uncounted = finite(judge.uncountedCalls) ?? 0;
  if (uncounted > 0) {
    reasons.push(
      `${fmtInt(uncounted)} judge ${uncounted === 1 ? 'call' : 'calls'} returned no usage block, so ${
        uncounted === 1 ? 'its tokens are' : 'their tokens are'
      } outside this figure and are not estimated`
    );
  }
  const failed = finite(judge.failedCalls) ?? 0;
  if (failed > 0) {
    reasons.push(
      `${fmtInt(failed)} judge ${failed === 1 ? 'call' : 'calls'} threw before reporting usage, so that spend is unknowable and is not estimated`
    );
  }
  return reasons;
}

/**
 * How the harness arrived at the dollars on this run's tape. `estimated` and
 * `asOf` come from the record, so the page can say what the figure is made of
 * instead of implying a bank statement.
 */
export function costBasisOf(run) {
  const cost = asObject(asObject(asObject(run && run.trace_stats).models).cost);
  return {
    recorded: Object.keys(cost).length > 0,
    estimated: cost.estimated === true,
    asOf: typeof cost.asOf === 'string' && cost.asOf ? cost.asOf : null,
    source: typeof cost.source === 'string' && cost.source ? cost.source : null,
    partial: cost.partial === true
  };
}

/**
 * The cost of one run, composed from what was actually recorded.
 *
 * Two rules hold here. Every dollar in `totalUsd` was read from the record, so
 * the figure can be labelled measured. And everything known to sit outside it is
 * named in `excluded` WITHOUT a number, because the alternative on this page has
 * always been a guess wearing a dollar sign. A run whose record carries no
 * dollars at all returns `totalUsd: null` and the renderer prints no figure.
 */
export function runCostOf(run) {
  const activity = modelActivityOf(run);
  const judge = judgeUsageOf(run);
  const screen = nullScreenOf(run);
  const runnerUsd = activity.costUsd;
  const judgeUsd = judge.costUsd;
  let totalUsd = null;
  if (runnerUsd !== null) totalUsd = runnerUsd;
  if (judgeUsd !== null) totalUsd = (totalUsd ?? 0) + judgeUsd;

  const excluded = [];
  if (judgeUsd === null) {
    excluded.push(
      judge.present
        ? 'the judge model usage on this run carries counts but no price on file, so no judge dollars are in the figure and none are estimated for it'
        : 'what the judge model spent on this run is not recorded anywhere in the record, so it is outside this figure and this page publishes no estimate for it'
    );
  }
  // A priced judge figure is not the same as a complete one. When the record
  // says its own judge dollars are partial, names a judge model it could not
  // price, or counts calls whose usage never came back, the sum below is a floor
  // and every reason for that goes in the excluded list where the label reads
  // it. Leaving them out is how a floor got printed as a measured total.
  for (const reason of judgeFloorReasons(judge)) excluded.push(reason);
  if (screen.enabled && (screen.screened ?? 0) > 0) {
    excluded.push(
      `the generation time null screen made ${fmtInt(screen.screened)} runner model ${
        screen.screened === 1 ? 'call' : 'calls'
      } before the suite existed, written to neither tape${
        screen.inputTokens !== null && screen.outputTokens !== null
          ? ` (${fmtInt(screen.inputTokens)} input and ${fmtInt(screen.outputTokens)} output tokens)`
          : ''
      }`
    );
  }
  if (activity.unpricedModels.length > 0) {
    excluded.push(
      `${activity.unpricedModels.length} ${
        activity.unpricedModels.length === 1 ? 'model on the tape has' : 'models on the tape have'
      } no price on file (${activity.unpricedModels.join(', ')}), so the tape figure is a lower bound`
    );
  }
  const basis = costBasisOf(run);
  if (basis.partial === true) {
    excluded.push(
      "the tape's own cost block is recorded as partial, so the runner dollars it carries are a lower bound on what the runner spent"
    );
  }
  const complete = totalUsd !== null && excluded.length === 0;
  return {
    runnerUsd,
    judgeUsd,
    totalUsd,
    judge,
    basis,
    excluded,
    /** True only when nothing known is missing from `totalUsd`. */
    complete,
    /** A number that is known to be incomplete. Printed as "at least", never as a total. */
    floor: totalUsd !== null && !complete
  };
}

/**
 * What the composed figure may be called, and what it may be called it for.
 *
 * A total is a total only when nothing known is missing from it. Everything else
 * is a floor, says "at least", and carries the reason it is one, because a floor
 * printed as a measured total is the exact error this block exists to prevent.
 * A run whose record carries no dollars gets no line here at all, so a
 * non-derivable cost still prints nothing numeric.
 */
export function costTotalLine(cost) {
  if (!cost || typeof cost !== 'object' || cost.totalUsd === null) return null;
  if (cost.complete) {
    return { floor: false, label: 'measured total', value: fmtUsd(cost.totalUsd), note: null };
  }
  const reasons = Array.isArray(cost.excluded) ? cost.excluded : [];
  return {
    floor: true,
    label: 'measured floor, not a total',
    value: `at least ${fmtUsd(cost.totalUsd)}`,
    note:
      reasons.length === 1
        ? `That figure is a floor rather than a total because ${reasons[0]}.`
        : reasons.length > 1
          ? `That figure is a floor rather than a total: ${reasons.length} things known to sit outside it are named below, and none of them is estimated in its place.`
          : 'That figure is a floor rather than a total, because this record does not carry enough to call it complete.'
  };
}

/**
 * Model spend recorded for this run: the runner turns on its tapes plus judge
 * usage when the record carries it. Null when the record carries no dollars.
 *
 * Null is ambiguous on purpose: unknown pricing fails closed, so this is null
 * both for a run where no model turn happened and for one whose model has no
 * price on file. A caller that needs to tell those apart reads
 * `modelActivityOf` and `judgeUsageOf` and says which one it saw.
 */
export function measuredCostOf(run) {
  return runCostOf(run).totalUsd;
}

// ---------------------------------------------------------------------------
// extension ledger
//
// The pre-registration fixes the extension size and the maximum number of
// extensions alongside n, before the first call. EXTEND is not a loophole: after
// the last extension an unresolved gate resolves to FAIL, and a regenerated task
// suite is a NEW run rather than another attempt at this one. So when a run did
// consume extensions, the page owes the reader the whole sequence and not only
// the pooled number: what the registered size resolved to, what each batch
// added, what the pool came to, and what that resolved as.
// ---------------------------------------------------------------------------

/** The extension protocol as registered before the first call. */
export function extensionPolicyOf(run) {
  const policy = asObject(asObject(run && run.gates).extensionPolicy);
  return {
    recorded: Object.keys(policy).length > 0,
    extensionSize: finite(policy.extensionSize),
    maxExtensions: finite(policy.maxExtensions)
  };
}

/** A k of n pair, read by shape. Null unless both numbers are really there. */
export function countsOf(value) {
  const k = firstNumber(value, ['k', 'passed', 'successes', 'hits']);
  const n = firstNumber(value, ['n', 'total', 'attempts', 'size', 'tasks']);
  if (k === null || n === null || n <= 0) return null;
  return { k, n };
}

/**
 * What one gate's extension batches did, or null when this record has none.
 *
 * Every number here is read from the record. The one derived value is the
 * initial batch when the record pools without restating it: pooled minus the
 * recorded batches is arithmetic on recorded counts, and it is flagged as
 * derived so the sentence can say where it came from.
 */
export function extensionLedgerOf(run, gate) {
  // A record is not required: an extension the harness logged for a gate whose
  // record never made it into the report is still an extension that was spent,
  // and losing it would understate what the run consumed.
  const record = gateRecordOf(run, gate);
  const detail = asObject(record && record.detail);
  const gates = asObject(run && run.gates);
  // The harness writes one entry per CONSUMED extension on the ledger itself.
  // An entry with no gate field is attributed to construct, the only gate that
  // buys an extension in v0, rather than being dropped on the floor.
  const fromLedger = Array.isArray(gates.extensions)
    ? gates.extensions.filter((entry) => {
        const named = asObject(entry).gate;
        return typeof named === 'string' ? named === gate : gate === 'construct';
      })
    : [];
  const rawBatches = fromLedger.length > 0
    ? fromLedger
    : [detail.extensions, detail.extensionBatches, detail.batches, record && record.extensions].find((value) =>
        Array.isArray(value)
      ) || [];

  const batches = rawBatches
    .map((entry, i) => {
      const o = asObject(entry);
      const before = countsOf(o.pooledBefore);
      const after = countsOf(o.pooledAfter);
      const direct = countsOf(o);
      let counts = direct;
      let derivedFromPool = false;
      // The batch's own k of n is the pool's movement across it. That is
      // subtraction on two recorded counts, and the sentence says so.
      if (!counts && before && after && after.n > before.n && after.k >= before.k) {
        counts = { k: after.k - before.k, n: after.n - before.n };
        derivedFromPool = true;
      }
      const dropped = asObject(o.dropped);
      // `duplicate` joined this record when content level dedupe landed. A
      // reader that lists the rules by name has to list all of them, or the
      // published count of what a batch deleted is smaller than what it deleted.
      const droppedTotal = ['nullScreen', 'answerLeak', 'admission', 'duplicate'].reduce(
        (total, key) => (finite(dropped[key]) === null ? total : total + dropped[key]),
        0
      );
      // A batch voided by a free gate is not a small batch. Its offenders are
      // the reason the whole run is refused, so they are read here and said out
      // loud rather than left to render as an ordinary short batch.
      const violations = (Array.isArray(o.violations) ? o.violations : [])
        .map((v) => asObject(v))
        .map((v) => ({
          gate: firstString(v, ['gate']),
          reason: firstString(v, ['reason']),
          taskId: firstString(v, ['taskId']),
          detail: firstString(v, ['detail'])
        }))
        .filter((v) => v.gate !== null || v.taskId !== null || v.detail !== null);
      return {
        index: finite(o.index) ?? i + 1,
        k: counts ? counts.k : null,
        n: counts ? counts.n : null,
        derivedFromPool,
        before,
        after,
        outcomeBefore: firstString(o, ['verdictBefore']),
        outcome: firstString(o, ['verdictAfter', 'outcome', 'verdict', 'result', 'resolution']),
        seed: finite(o.seed),
        batchSuiteHash: firstString(o, ['batchSuiteHash', 'suiteHash']),
        generated: finite(o.generated),
        admitted: finite(o.admitted),
        droppedTotal,
        violations,
        short: o.short === true,
        failure: firstString(o, ['failure', 'reason'])
      };
    })
    .filter((batch) => batch !== null);

  const explicitConsumed = firstNumber(detail, ['extensionsUsed', 'extensionsConsumed', 'extensionCount']);
  const consumed = batches.length > 0 ? batches.length : explicitConsumed;
  if (!consumed || consumed <= 0) return null;

  const lastAfter = batches.length > 0 ? batches[batches.length - 1].after : null;
  // `record` is optional here by design, so the pooled fallback has to tolerate
  // its absence: an extension logged for a gate whose record never reached the
  // report must still print, not throw.
  const pooled = lastAfter || countsOf(detail.pooled) || countsOf(record && record.verdict);
  const firstBefore = batches.length > 0 ? batches[0].before : null;
  let initial =
    firstBefore ||
    countsOf(detail.initial) ||
    countsOf(detail.initialVerdict) ||
    countsOf(detail.base) ||
    countsOf(detail.baseline);
  let initialDerived = false;
  if (!initial && pooled && batches.every((batch) => batch.k !== null) && batches.length > 0) {
    const batchK = batches.reduce((total, batch) => total + batch.k, 0);
    const batchN = batches.reduce((total, batch) => total + batch.n, 0);
    if (pooled.n > batchN && pooled.k >= batchK) {
      initial = { k: pooled.k - batchK, n: pooled.n - batchN };
      initialDerived = true;
    }
  }
  const policy = extensionPolicyOf(run);
  return {
    gate,
    gateLabel: gateLabel(gate),
    policy,
    consumed,
    batches,
    initial,
    initialDerived,
    initialOutcome: batches.length > 0 ? batches[0].outcomeBefore : null,
    pooled,
    verdict: record && record.verdict && typeof record.verdict === 'object' ? record.verdict : null,
    outcome: typeof run.outcome === 'string' ? run.outcome : null,
    exhausted: policy.maxExtensions !== null && consumed >= policy.maxExtensions
  };
}

/** Every gate on this run that consumed extensions. Usually zero or one. */
export function extensionLedgers(run) {
  const gates = asObject(run && run.gates);
  const names = [];
  const records = Array.isArray(gates.records) ? gates.records : [];
  for (const record of records) {
    if (record && typeof record === 'object' && typeof record.gate === 'string' && !names.includes(record.gate)) {
      names.push(record.gate);
    }
  }
  // Gates named only on the extension ledger count too, so an extension is
  // never lost because its gate record is missing from the report.
  if (Array.isArray(gates.extensions)) {
    for (const entry of gates.extensions) {
      const named = asObject(entry).gate;
      const gate = typeof named === 'string' && named ? named : 'construct';
      if (!names.includes(gate)) names.push(gate);
    }
  }
  return names.map((gate) => extensionLedgerOf(run, gate)).filter((ledger) => ledger !== null);
}

/**
 * What this record says about the extension protocol, and whether it says
 * anything at all.
 *
 * `gates.extensionPolicy` is written on every record, so a policy of zero and
 * zero is ambiguous on its own: it is what a harness that registers no extension
 * batch writes, and it is also what a harness with no extension protocol at all
 * writes. The records separate themselves elsewhere. A harness that runs the
 * protocol states it in the gate record that could buy one (the protocol
 * sentence, the pooled policy, the consumed count) and writes one ledger entry
 * per consumed batch. A record carrying none of that was written before the
 * protocol ran.
 *
 * That distinction is read here from fields, never from a run id, a date or a
 * server name. `stated` is the evidence; `registered` is whether a batch could
 * ever have been bought; `consumed` is how many were.
 */
export function extensionProtocolOf(run) {
  const policy = extensionPolicyOf(run);
  const gates = asObject(run && run.gates);
  const ledgerEntries = Array.isArray(gates.extensions) ? gates.extensions.length : null;
  const records = Array.isArray(gates.records) ? gates.records : [];
  const stated = records.some((record) => {
    const detail = asObject(asObject(record).detail);
    return (
      (typeof detail.extensionProtocol === 'string' && detail.extensionProtocol.length > 0) ||
      finite(detail.extensionsConsumed) !== null ||
      Array.isArray(detail.extensions) ||
      Object.keys(asObject(asObject(detail.pooled).policy)).length > 0
    );
  });
  const consumed = extensionLedgers(run).reduce((total, ledger) => total + ledger.consumed, 0);
  return {
    policy,
    /** The record says something about the protocol beyond the bare policy object. */
    stated: stated || ledgerEntries !== null,
    ledgerEntries: ledgerEntries ?? 0,
    /** A batch could have been bought: a size and a maximum, both above zero. */
    registered: (policy.extensionSize ?? 0) > 0 && (policy.maxExtensions ?? 0) > 0,
    consumed
  };
}

/**
 * The extension protocol line, true of a record from either era.
 *
 * Three readings, each keyed on the record: a protocol that registered batches,
 * a protocol that deliberately registered none, and a record that carries no
 * protocol at all. The third is not described as a choice, because it was not
 * one.
 */
export function extensionProtocolSentence(state) {
  if (!state || !state.policy || !state.policy.recorded) return 'not recorded on this run.';
  const { policy } = state;
  if (state.registered) {
    return `registered before the first call as ${fmtInt(policy.extensionSize)} tasks per extension, at most ${fmtInt(
      policy.maxExtensions
    )}. ${
      state.consumed > 0 ? `This run consumed ${state.consumed} of them.` : 'This run consumed none of them.'
    } After the last extension an unresolved gate resolves to FAIL and the run is refused as GATE_FAILED, and a regenerated suite is a new run rather than a retry.`;
  }
  if (state.stated) {
    return 'registered before the first call as no extension batch at all. A gate the registered sample cannot resolve either way is refused on its first evaluation rather than extended, and that refusal is the one case that still carries EXTEND_EXHAUSTED.';
  }
  return 'this record carries a zero policy and nothing else about the protocol: no batch was registered, none is named in any gate record, and there is no ledger. It was written before the extension protocol ran, so a gate the registered sample could not resolve was refused where it stood. The arithmetic is the same as a pre-registration that buys no extension, and the record does not distinguish the two.';
}

/**
 * EXTEND_EXHAUSTED, read against the record that carries it.
 *
 * The outcome means one thing in both eras: the gate resolved neither way and
 * there was no batch to buy. What differs is why there was none, and the row
 * says which case it is from its own fields. Returns an empty list for any other
 * outcome.
 */
export function exhaustedReading(run) {
  if (!run || run.outcome !== 'EXTEND_EXHAUSTED') return [];
  const state = extensionProtocolOf(run);
  const generator = generatorBadgeOf(run);
  const lines = [
    'EXTEND_EXHAUSTED on this page means the gate resolved neither way and no extension batch was available to buy. It never means a gate was re-run until it resolved.'
  ];
  if (state.registered) {
    lines.push(
      `This record registers ${fmtInt(state.policy.extensionSize)} tasks per extension, at most ${fmtInt(
        state.policy.maxExtensions
      )}, and shows ${state.consumed} consumed. A run recorded under that protocol resolves an unresolved gate to FAIL after its last extension and refuses as GATE_FAILED, so this outcome and this policy do not belong together. Both are printed exactly as recorded. A record that disagrees with itself is a defect in the run, not a finding about the server.`
    );
  } else if (state.stated) {
    lines.push(
      'The pre-registration on this run bought no extension batch, so the gate resolved on its first evaluation and there was never a batch to spend.'
    );
  } else {
    lines.push(
      `This record carries no extension protocol anywhere: no registered batch size, no protocol statement on the gate that could have bought one, and no ledger. That is the shape of a record written before the extension protocol ran, and its suite came from ${generator.label}. The gate was refused where it stood rather than extended, because there was nothing to extend it with.`
    );
    lines.push(
      'A run recorded since then either buys its registered batches and, if the gate is still unresolved after the last one, resolves to FAIL and refuses as GATE_FAILED, or registers no batch at all and refuses here, as this row does. The counts on this row are unaffected either way: they are what the gate measured.'
    );
  }
  lines.push(
    'No threshold, ratio, alpha or floor moved to produce this outcome, and a regenerated task suite would be a new run under a new suite hash rather than another attempt at this one.'
  );
  return lines;
}

/**
 * The consumed extensions, in plain sentences: the registered size, each batch,
 * the pool, then the verdict the pooled counts resolved to.
 */
export function extensionSentences(ledger) {
  if (!ledger) return [];
  const lines = [];
  const size = ledger.policy.extensionSize;
  const max = ledger.policy.maxExtensions;
  const label = ledger.gateLabel;

  lines.push(
    max === null
      ? `The extension protocol was fixed before the first call and this run consumed ${ledger.consumed} of it.`
      : `The extension protocol was fixed before the first call: ${size === null ? 'a registered batch size' : `${size} tasks per extension`}, at most ${max} ${
          max === 1 ? 'extension' : 'extensions'
        }. This run consumed ${ledger.consumed} of ${max}.`
  );

  if (ledger.initial) {
    lines.push(
      `On the registered size the ${label} gate stood at ${ledger.initial.k} of ${ledger.initial.n}${
        ledger.initialOutcome ? `, which resolved as ${ledger.initialOutcome}` : ''
      }${
        ledger.initialDerived
          ? ', a figure this record states as the pooled counts minus the recorded extension batches rather than on its own line'
          : ''
      }, so the registered sample did not settle it either way.`
    );
  } else {
    lines.push(
      `This record does not carry the counts the ${label} gate stood at before the first extension, so they are not printed. The batches and the pool below are what it does carry.`
    );
  }

  for (const batch of ledger.batches) {
    const head = `Extension ${batch.index}${max === null ? '' : ` of ${max}`}`;
    if (batch.failure) {
      lines.push(
        `${head} could not be generated (${batch.failure}). It is still counted as consumed, because the budget is spent when the extension is taken, not when it happens to work.`
      );
      continue;
    }
    const clauses = [];
    // How many TASKS a batch added is a recorded number, `admitted`. The pooled
    // counts move by TRIALS, and construct drives each task at the registered
    // reps, so the pooled delta equals the task count only when reps is one.
    // Printing that delta as "tasks added" misstates every batch driven at more
    // than one rep, so the recorded field wins and the derived one is named as
    // trials when it is all the record has.
    const hasCounts = batch.k !== null && batch.n !== null;
    if (batch.admitted !== null) {
      clauses.push(
        `added ${batch.admitted} ${batch.admitted === 1 ? 'task' : 'tasks'}, the count recorded for the batch`
      );
    } else if (hasCounts) {
      clauses.push(
        `moved the pool by ${batch.n} ${
          batch.n === 1 ? 'trial' : 'trials'
        }, which is what this record carries in place of a task count for the batch`
      );
    } else {
      clauses.push('was consumed, and this record carries no counts for it');
    }
    if (hasCounts) {
      clauses.push(
        `the gate passed ${batch.k} of ${batch.n} ${batch.n === 1 ? 'trial' : 'trials'} from it${
          batch.derivedFromPool ? ', read as the movement in the pooled counts across this batch' : ''
        }`
      );
      if (batch.admitted !== null && batch.admitted !== batch.n) {
        clauses.push(
          `those trials are not those tasks: each task is driven at the registered reps, so ${batch.admitted} ${
            batch.admitted === 1 ? 'task contributes' : 'tasks contribute'
          } ${batch.n} ${batch.n === 1 ? 'trial' : 'trials'} to the pool`
        );
      }
    } else if (batch.admitted !== null) {
      clauses.push('with no per batch pass count in this record');
    }
    if (batch.generated !== null && batch.admitted !== null && batch.generated !== batch.admitted) {
      clauses.push(
        `${batch.generated} ${batch.generated === 1 ? 'candidate was' : 'candidates were'} generated for it and ${batch.admitted} survived the free gates${
          batch.droppedTotal > 0 ? `, which deleted ${batch.droppedTotal}` : ''
        }`
      );
    }
    if (batch.violations.length > 0) {
      for (const v of batch.violations) {
        const where = v.taskId === null ? 'a task in this batch' : `task ${v.taskId}`;
        const why = v.detail ?? v.reason ?? 'a free gate violation';
        clauses.push(
          `${where} broke a free gate${v.gate === null ? '' : ` (${v.gate.replace(/_/g, ' ')})`} and voided the whole batch: ${why}`
        );
      }
      clauses.push('the batch was voided rather than mined for its clean tasks, because keeping them would select the pool on the defect the generator just produced');
    } else if (batch.short) {
      clauses.push('the batch came back smaller than the registered extension size and was consumed at that size rather than topped up');
    }
    if (batch.before && batch.after) {
      clauses.push(`the pool moved from ${batch.before.k} of ${batch.before.n} to ${batch.after.k} of ${batch.after.n}`);
    }
    lines.push(`${head} ${clauses.join('; ')}${batch.outcome ? `, still resolving as ${batch.outcome}` : ''}.`);
  }
  if (ledger.batches.length === 0) {
    lines.push(
      'The per batch counts are not in this record, so only the number of extensions consumed and the pooled result below can be stated.'
    );
  }

  if (ledger.pooled) {
    lines.push(
      `Pooled across the registered size and ${ledger.consumed} ${ledger.consumed === 1 ? 'extension' : 'extensions'}, the ${label} gate stands at ${ledger.pooled.k} of ${ledger.pooled.n}.`
    );
  }

  const verdictText = verdictLine(ledger.verdict);
  const outcome = ledger.verdict && typeof ledger.verdict.outcome === 'string' ? ledger.verdict.outcome : null;
  if (outcome) {
    lines.push(
      `The verdict recorded for the gate is ${outcome}${verdictText ? ` (${verdictText})` : ''}.${
        ledger.exhausted && outcome === 'EXTEND'
          ? ' The extension budget is spent, and a gate still unresolved after the last extension resolves to FAIL rather than being extended again.'
          : ''
      }`
    );
  } else if (verdictText) {
    lines.push(`The pooled counts stand at ${verdictText}.`);
  }
  // Two recorded numbers that should be the same number. When they are not, the
  // page prints both and says they disagree, rather than picking the one that
  // reads better and presenting it as the pooled result.
  const verdictCounts = countsOf(ledger.verdict);
  if (ledger.pooled && verdictCounts && (verdictCounts.k !== ledger.pooled.k || verdictCounts.n !== ledger.pooled.n)) {
    lines.push(
      `Those two counts do not agree: the extension ledger pools to ${ledger.pooled.k} of ${ledger.pooled.n} and the gate's own verdict line reads ${verdictCounts.k} of ${verdictCounts.n}. Both are printed exactly as recorded. A record that disagrees with itself is a defect in the run, not a finding about the server.`
    );
  }
  lines.push(
    'The extension size and the maximum were registered with n before the first call and neither moved during the run. A regenerated task suite would be a new run under a new suite hash, never another extension of this one.'
  );
  return lines;
}

/** Figures for the extension ledger, for a story or a panel block. */
export function extensionFigures(ledger) {
  if (!ledger) return [];
  const figures = [
    {
      label: 'extensions consumed',
      value: ledger.policy.maxExtensions === null ? fmtInt(ledger.consumed) : `${ledger.consumed} of ${ledger.policy.maxExtensions} registered`
    },
    { label: 'extension size', value: ledger.policy.extensionSize === null ? 'not recorded' : `${fmtInt(ledger.policy.extensionSize)} tasks` }
  ];
  if (ledger.initial) {
    figures.push({
      label: ledger.initialDerived ? 'registered size (derived)' : 'registered size',
      value: `${ledger.initial.k} of ${ledger.initial.n}`
    });
  }
  if (ledger.pooled) figures.push({ label: 'pooled', value: `${ledger.pooled.k} of ${ledger.pooled.n}` });
  // A batch is auditable only if you can find the suite it was drawn from, so
  // its hash and its derived seed are printed where the record carries them.
  // Tasks and trials are printed as two figures wherever they differ, because
  // one number labelled both is the arithmetic error this panel used to make.
  for (const batch of ledger.batches) {
    if (batch.admitted !== null) {
      figures.push({
        label: `extension ${batch.index} tasks added`,
        value:
          batch.n !== null && batch.n !== batch.admitted
            ? `${fmtInt(batch.admitted)} tasks, ${fmtInt(batch.n)} pooled trials`
            : `${fmtInt(batch.admitted)} tasks`
      });
    }
    if (!batch.batchSuiteHash && batch.seed === null) continue;
    figures.push({
      label: `extension ${batch.index} suite`,
      value: `${batch.batchSuiteHash || 'hash not recorded'}${batch.seed === null ? '' : ` (seed ${batch.seed})`}`
    });
  }
  return figures;
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
  // When the gate consumed extensions, the pooled k of n on its own hides the
  // sequence that produced it. The whole sequence goes in, in order.
  const ledger = extensionLedgerOf(run, 'construct');
  if (ledger) {
    story.extensionLedger = ledger;
    for (const line of extensionSentences(ledger)) story.sentences.push(line);
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
    { label: 'error results', value: fmtInt(totals.errors) },
    ...extensionFigures(ledger)
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
  // Any story whose gate consumed extensions and did not already tell that
  // sequence gets it here, so no builder can quietly drop it by being the one
  // that handles a gate nobody thought about.
  for (const story of stories) {
    if (story.extensionLedger || !story.gate) continue;
    const ledger = extensionLedgerOf(run, story.gate);
    if (!ledger) continue;
    story.extensionLedger = ledger;
    for (const line of extensionSentences(ledger)) story.sentences.push(line);
    story.figures = [...story.figures, ...extensionFigures(ledger)];
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
  let floorRuns = 0;
  let turnRuns = 0;
  let unpricedRuns = 0;
  let screenRuns = 0;
  let screenInputTokens = 0;
  let screenOutputTokens = 0;
  let screenCalls = 0;
  let judgeRuns = 0;
  let judgePricedRuns = 0;
  let judgeUsd = 0;
  for (const run of usable) {
    const activity = modelActivityOf(run);
    if (activity.assistantTurns > 0) turnRuns += 1;
    if (activity.unpricedModels.length > 0) unpricedRuns += 1;
    const cost = runCostOf(run);
    if (cost.judge.present) judgeRuns += 1;
    if (cost.judgeUsd !== null) {
      judgePricedRuns += 1;
      judgeUsd += cost.judgeUsd;
    }
    if (cost.totalUsd !== null) {
      costUsd += cost.totalUsd;
      costRuns += 1;
      // A sum of floors is a floor. The board figure says so the same way a run
      // figure does, rather than inheriting the word "total" from the label.
      if (cost.floor) floorRuns += 1;
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
    /** Runs whose own figure is a floor, so the board figure is one too. */
    floorRuns,
    costIsFloor: costRuns > 0 && floorRuns > 0,
    /** Runs whose tapes carry at least one non echoed assistant turn. */
    turnRuns,
    /** Runs that carry model turns the price table could not price. */
    unpricedRuns,
    /** Runs whose record carries any judge model usage at all. */
    judgeRuns,
    /** Runs whose judge usage carries dollars, so it is inside the total. */
    judgePricedRuns,
    judgeUsd: judgePricedRuns > 0 ? judgeUsd : null,
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

function serverCell(run, placement, cohort) {
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

  // The generator badge rides on every row, ranked or refused. Two generator
  // versions are two different denominators, and a reader scanning the table has
  // to be able to see which one a row came from without opening it.
  const generator = generatorBadgeOf(run);
  const genChip = el('span', `gen-chip${generator.known ? '' : ' gen-chip-unknown'}`, generator.label);
  genChip.title = generator.note;
  td.appendChild(genChip);

  const server = run.server && typeof run.server === 'object' ? run.server : {};
  const url = el('div', 'server-url');
  url.appendChild(el('code', null, typeof server.url === 'string' ? server.url : 'url not recorded'));
  td.appendChild(url);

  // Which run this row is. A server can be driven again at any time, so a row
  // that names only the server names half of what it shows.
  const identity = el('div', 'run-identity', runIdentityLine(run));
  identity.title = 'The run behind this row: the task suite it drove, and when that drive started.';
  td.appendChild(identity);

  const bits = [];
  if (server.era) bits.push(`${server.era} era`);
  if (server.transportShape) bits.push(server.transportShape === 'sse' ? 'SSE framed' : 'plain JSON');
  if (typeof server.sessionful === 'boolean') bits.push(server.sessionful ? 'session-ful' : 'stateless');
  td.appendChild(el('div', 'server-meta', bits.join(' / ') || 'transport not recorded'));

  // Reruns are separate attempts. They are marked as such on every row they
  // produced, including the older ones, and each row names the others so a
  // reader who lands on one can find the rest wherever they sit in the table.
  if (cohort && cohort.total > 1) {
    const chip = el(
      'span',
      'rerun-chip',
      cohort.attempt === null
        ? `${cohort.total} published runs of this server`
        : `Run ${cohort.attempt} of ${cohort.total} for this server`
    );
    chip.title =
      'Reruns of one server are separate attempts, each with its own task suite and its own outcome. Every one of them stays on this page and none of them is a best of.';
    td.appendChild(chip);
    if (cohort.siblings.length > 0) {
      td.appendChild(
        el(
          'div',
          'rerun-siblings',
          `Other runs of this server, published in full: ${cohort.siblings
            .map(
              (sibling) =>
                `${sibling.suitePrefix || 'suite not recorded'} (${sibling.outcome}${
                  sibling.startedAt ? `, ${sibling.startedAt}` : ''
                })`
            )
            .join('; ')}`
        )
      );
    }
  }
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
    // Both of these are runner figures. They are labelled that way because the
    // judge model's tokens are not in them and a bare "cost per task" reads as
    // the cost of the task, which is a different and larger number.
    definition(dl, 'runner tokens per task', fmtInt(score.meanTokensPerCompletedTask));
    definition(dl, 'runner cost per task', fmtUsd(score.meanCostPerCompletedTaskUsd));
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
  // An outcome whose meaning changed between harness versions is read against
  // the record that carries it, so an older row is explained rather than
  // described in terms that were never true of it.
  const exhausted = exhaustedReading(run);
  if (exhausted.length > 0) {
    const section = el('div', 'story is-secondary outcome-reading');
    const head = el('div', 'story-head');
    head.appendChild(el('span', 'story-gate', 'reading this outcome'));
    head.appendChild(el('span', 'story-role', 'from this record, not from the row it sits on'));
    section.appendChild(head);
    for (const line of exhausted) section.appendChild(el('p', 'story-line', line));
    const evidence = el('p', 'story-evidence');
    evidence.appendChild(el('span', null, 'The counts this outcome was reached on are on the recording: '));
    evidence.appendChild(evidenceLink(run, 'open the recorded session'));
    section.appendChild(evidence);
    wrap.appendChild(section);
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
  const protocol = extensionProtocolOf(run);
  if (protocol.policy.recorded) {
    wrap.appendChild(
      el(
        'p',
        'panel-note',
        `Extension protocol: ${extensionProtocolSentence(protocol)}${
          protocol.consumed > 0 ? ' The consumed batches are printed as a sequence above.' : ''
        }`
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
  const generator = generatorBadgeOf(run);
  definition(
    dl,
    'task generator',
    `${generator.label}${
      screen.enabled
        ? `, null screen on: ${fmtInt(screen.dropped)} of ${fmtInt(screen.screened)} screened candidates deleted before the suite hash`
        : ', no generation time null screen'
    }`
  ).title = generator.note;
  // Suite lineage, only where the record carries it. A row that reads
  // "not recorded" on every run teaches nothing, so absent fields render
  // nothing at all rather than a placeholder.
  for (const row of suiteLineageOf(run)) definition(dl, row.label, row.value);
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
 * What this run cost, where the record can support a number.
 *
 * The rule is one line long: a dollar figure appears only when it was read from
 * this record, and everything known to be outside it is named without a number.
 * That is why there is no "about" and no per run assumption anywhere in this
 * block. A run whose record carries no dollars gets sentences and no figures.
 */
function costBlock(run) {
  const wrap = el('div', 'panel-block panel-cost');
  wrap.appendChild(el('h4', null, 'What this run cost'));
  const cost = runCostOf(run);
  const activity = modelActivityOf(run);
  const judge = cost.judge;

  const dl = el('dl', 'panel-dl');
  if (cost.runnerUsd !== null) {
    definition(
      dl,
      'runner model, measured',
      `${fmtUsd(cost.runnerUsd)} over ${fmtInt(activity.assistantTurns)} recorded ${
        activity.assistantTurns === 1 ? 'turn' : 'turns'
      }`
    );
  } else if (activity.assistantTurns > 0) {
    definition(dl, 'runner model', `${fmtInt(activity.assistantTurns)} recorded turns, no price on file for the model that ran`);
  } else {
    definition(dl, 'runner model', 'no model turn on either tape for this run');
  }

  if (cost.judgeUsd !== null) {
    definition(
      dl,
      judge.floor ? 'judge model, measured floor' : 'judge model, measured',
      `${judge.floor ? 'at least ' : ''}${fmtUsd(cost.judgeUsd)}${judge.model ? ` on ${judge.model}` : ''}${
        judge.calls !== null ? ` over ${fmtInt(judge.calls)} ${judge.calls === 1 ? 'call' : 'calls'}` : ''
      }${
        judge.inputTokens !== null && judge.outputTokens !== null
          ? `, ${fmtInt(judge.inputTokens)} input and ${fmtInt(judge.outputTokens)} output tokens`
          : ''
      }`
    );
    if (judge.byPhase.length > 0) {
      definition(
        dl,
        'judge spend by phase',
        judge.byPhase
          .map(
            (phase) =>
              `${phase.phase || 'unnamed phase'} ${fmtInt(phase.calls)} ${phase.calls === 1 ? 'call' : 'calls'}`
          )
          .join(', ')
      );
    }
  } else if (judge.present) {
    const counts = [
      judge.calls !== null ? `${fmtInt(judge.calls)} ${judge.calls === 1 ? 'call' : 'calls'}` : null,
      judge.inputTokens !== null ? `${fmtInt(judge.inputTokens)} input tokens` : null,
      judge.outputTokens !== null ? `${fmtInt(judge.outputTokens)} output tokens` : null
    ].filter((part) => part !== null);
    definition(
      dl,
      'judge model',
      counts.length > 0 ? `${counts.join(', ')} recorded, with no price on file` : 'recorded, with no counts this page can read'
    );
  } else {
    definition(dl, 'judge model', 'not recorded on this run');
  }
  const total = costTotalLine(cost);
  if (total) definition(dl, total.label, total.value);
  wrap.appendChild(dl);
  if (total && total.note) wrap.appendChild(el('p', 'panel-note', total.note));

  if (cost.totalUsd === null) {
    wrap.appendChild(
      el(
        'p',
        'panel-note',
        'This record carries no dollars, so this page prints none for this run. An unpriced model and a model that never ran produce the same absent figure, and neither is filled in with an assumption.'
      )
    );
  } else {
    const basis = cost.basis;
    wrap.appendChild(
      el(
        'p',
        'panel-note',
        `Measured from the token counts recorded on this run${
          basis.source ? `, converted at the ${basis.source} price table` : ''
        }${basis.asOf ? ` as of ${basis.asOf}` : ''}. The tokens are counted, the rates are published, and nothing here is sampled or averaged from other runs.`
      )
    );
  }
  // The floor label above already carries the reason when there is exactly one,
  // so the list is not printed twice for it. Two or more and the label counts
  // them and the list names them.
  const alreadyNamed = Boolean(total && total.floor) && cost.excluded.length === 1;
  if (cost.excluded.length > 0 && !alreadyNamed) {
    wrap.appendChild(el('p', 'panel-note', 'Outside that figure, named rather than estimated:'));
    const list = el('ul', 'methods-list');
    for (const item of cost.excluded) list.appendChild(el('li', null, item));
    wrap.appendChild(list);
  }
  // The harness's own notes on this block, verbatim. Its degradations are not
  // repeated here: partial pricing, an unpriced judge model and calls with no
  // usage block are all in the excluded list above, where the label that calls
  // the figure a floor reads them from.
  if (judge.notes.length > 0) {
    const list = el('ul', 'methods-list');
    for (const note of judge.notes) list.appendChild(el('li', null, note));
    wrap.appendChild(list);
  }
  // The runner figure is counted off the tape, so the tape is linked here the
  // same way every other claim on this page links to what justifies it.
  const evidence = el('p', 'story-evidence');
  evidence.appendChild(el('span', null, 'Token counts behind the runner figure are on the recording: '));
  evidence.appendChild(evidenceLink(run, 'open the recorded session'));
  wrap.appendChild(evidence);
  return wrap;
}

/**
 * The extension ledger for a gate whose story is not being told elsewhere on
 * this panel, so a scored run that reached its number through extensions still
 * shows the sequence that produced it.
 */
function extensionBlock(run, gates) {
  const wrap = el('div', 'panel-block panel-extensions');
  wrap.appendChild(el('h4', null, 'Extension ledger'));
  for (const ledger of gates) {
    const section = el('div', 'story is-secondary');
    const head = el('div', 'story-head');
    head.appendChild(el('span', 'story-gate', `${ledger.gateLabel} gate`));
    head.appendChild(
      el('span', 'story-role', `${ledger.consumed} ${ledger.consumed === 1 ? 'extension' : 'extensions'} consumed`)
    );
    section.appendChild(head);
    const dl = el('dl', 'story-figures');
    for (const figure of extensionFigures(ledger)) {
      const cell = el('div', 'story-figure');
      cell.appendChild(el('dt', null, figure.label));
      cell.appendChild(el('dd', null, figure.value));
      dl.appendChild(cell);
    }
    section.appendChild(dl);
    for (const line of extensionSentences(ledger)) section.appendChild(el('p', 'story-line', line));
    const evidence = el('p', 'story-evidence');
    evidence.appendChild(el('span', null, 'Every count above is read from this run: '));
    evidence.appendChild(evidenceLink(run, 'open the recorded session'));
    section.appendChild(evidence);
    wrap.appendChild(section);
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
  const notes = Array.isArray(run.methods) ? run.methods.filter((n) => typeof n === 'string' && n.length > 0) : [];
  const screen = nullScreenOf(run);
  const ledgers = extensionLedgers(run);

  // Collapsible, and open. The reader can fold it away, but nothing here is
  // hidden by default: this is the block where the harness states what it
  // diverged on and which way its known biases point, and a disclosure that
  // starts closed inside a panel that already starts closed is a disclosure
  // nobody reads.
  const details = el('details', 'methods-details');
  details.open = true;
  const summary = el('summary', 'methods-summary');
  summary.appendChild(el('span', 'methods-title', 'Method notes and known bias'));
  summary.appendChild(
    el('span', 'methods-count', notes.length === 0 ? 'no notes recorded' : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}, verbatim`)
  );
  details.appendChild(summary);

  // Two facts are stated from the record's own fields rather than left to the
  // prose: whether the generation time null screen ran, and what the extension
  // protocol was. Both are registered before the first call, and both change
  // what every number on the row means.
  const registered = el('dl', 'panel-dl methods-registered');
  let screenLine;
  if (!screen.enabled) {
    screenLine =
      'no generation time null screen ran for this suite, so the run time null baseline measures an unscreened suite.';
  } else if (screen.screened === null) {
    screenLine = `on${screen.model ? ` (${screen.model})` : ''}, and this record does not carry its counts, so how many candidates it saw cannot be stated here.`;
  } else if (screen.screened === 0) {
    screenLine = `on${screen.model ? ` (${screen.model})` : ''}, but no candidate reached it on this run, so nothing was deleted and this suite is unscreened in practice.`;
  } else {
    screenLine = `on${screen.model ? ` (${screen.model})` : ''}: ${fmtInt(screen.dropped)} of ${fmtInt(
      screen.screened
    )} screened candidates were answerable with no server at all and were deleted before the suite was hashed. The run time null baseline on this suite is therefore biased downward by construction.`;
  }
  definition(registered, 'null screen', screenLine);
  // The protocol line is read from the record rather than from the bare policy
  // object: a zero policy on a record that states the protocol is a registered
  // choice, and a zero policy on a record that states nothing is a run written
  // before the protocol existed. Those are different facts and neither may be
  // printed as the other.
  const protocol = extensionProtocolOf(run);
  definition(
    registered,
    'extension protocol',
    protocol.registered && ledgers.length > 0
      ? `${extensionProtocolSentence(protocol)} On this run the consumed batches were ${ledgers
          .map((l) => `${l.consumed} on the ${l.gateLabel} gate`)
          .join(', ')}.`
      : extensionProtocolSentence(protocol)
  );
  details.appendChild(registered);

  if (notes.length === 0) {
    details.appendChild(
      el(
        'p',
        'is-missing',
        'This record carries no methods block, so the two lines above are everything it states about its own method. Newer runs carry the harness notes here verbatim.'
      )
    );
    wrap.appendChild(details);
    return wrap;
  }

  details.appendChild(
    el(
      'p',
      'panel-note',
      'Written by the harness with the run and reproduced verbatim. Divergences from the ported gate math, and the biases this design knows it has, are stated here rather than summarised away.'
    )
  );
  const list = el('ul', 'methods-list');
  for (const note of notes) list.appendChild(el('li', null, note));
  details.appendChild(list);
  wrap.appendChild(details);
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
  // Extensions a refusal story already told are not told twice. What is left is
  // a gate that consumed extensions and still passed, which no other block on
  // this panel would show.
  const told = new Set(refusalStories(run).map((story) => story.gate));
  const untold = extensionLedgers(run).filter((ledger) => !told.has(ledger.gate));
  if (untold.length > 0) inner.appendChild(extensionBlock(run, untold));
  inner.appendChild(gateTable(run));
  inner.appendChild(costBlock(run));
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

function runRow(run, placement, index, cohort) {
  const rows = [];
  const refused = run.outcome !== 'SCORED';
  const tr = el('tr', refused ? 'run-row is-refused-row' : 'run-row is-scored-row');
  const panelId = `detail-${index}`;
  if (placement && placement.tied) {
    tr.classList.add('is-tied');
    tr.dataset.tieGroup = String(placement.groupId);
  }
  // Rows of one server carry the same key wherever they sit in the table, so a
  // rerun is findable across sections rather than reading as an unrelated row.
  tr.dataset.server = slugOf(run);
  if (cohort && cohort.total > 1) tr.classList.add('is-rerun');
  tr.appendChild(serverCell(run, placement, cohort));
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
    parts.push(`runner turns priced on ${stats.costRuns} of ${stats.runs} tapes`);
    if (stats.floorRuns > 0) {
      parts.push(
        `${stats.floorRuns} of those ${stats.floorRuns === 1 ? 'figures is a floor' : 'figures are floors'} rather than totals, so this is a lower bound`
      );
    }
    if (stats.unpricedRuns > 0) {
      parts.push(
        `${stats.unpricedRuns} ${stats.unpricedRuns === 1 ? 'tape carries' : 'tapes carry'} turns with no price on file, so this is a lower bound`
      );
    }
    const silent = stats.runs - Math.max(stats.turnRuns, stats.costRuns);
    if (silent > 0) parts.push(`${silent} recorded no model turn on either plane`);
  }
  // The judge is the second model in every run and it writes to neither plane,
  // so a total that covers only the tapes must say so on the figure itself.
  if (stats.judgePricedRuns > 0) {
    parts.push(
      `judge spend recorded and included on ${stats.judgePricedRuns} of ${stats.runs} ${stats.runs === 1 ? 'run' : 'runs'}`
    );
    const counted = stats.judgeRuns - stats.judgePricedRuns;
    if (counted > 0) {
      parts.push(
        `${counted} ${counted === 1 ? 'more carries' : 'more carry'} judge counts with no price on file, so no judge dollars are added for ${
          counted === 1 ? 'it' : 'them'
        }`
      );
    }
  } else if (stats.judgeRuns > 0) {
    parts.push('judge usage is recorded without dollars, so no judge spend is in this figure');
  } else {
    parts.push('judge spend is recorded on no run, so it is outside this figure and no estimate is published for it');
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
      label: stats.costIsFloor ? 'Measured model spend, a floor' : 'Measured model spend',
      value:
        stats.costUsd === null
          ? 'none recorded'
          : `${stats.costIsFloor ? 'at least ' : ''}${fmtUsd(stats.costUsd, 2)}`,
      note: spendNote(stats)
    }
  ];
  // The label says measured, so the figure has to be made only of numbers that
  // were recorded. Everything the records do not carry is named below, without
  // a number, rather than filled in.
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
  // Cost honesty, stated where the cost figure is, not in a footnote. Every run
  // uses two models: the runner drives the server and is on the agent tape, and
  // the judge synthesises the suite and is on neither. A figure summed from the
  // tapes is therefore the runner's spend, and calling it the cost of the pass
  // would be an inference printed as a measurement.
  if (stats.judgeRuns < stats.runs && stats.runs > 0) {
    const missing = stats.runs - stats.judgeRuns;
    const note = el('p', 'stat-strip-note');
    note.textContent =
      `${missing} of ${stats.runs} ${stats.runs === 1 ? 'run carries' : 'runs carry'} no record of what the judge model spent. ` +
      'The judge generates the task suite and runs the destructiveness signal, and it writes to neither tape, so the figure above covers the runner model where a tape priced it, plus judge usage on the runs that record it. ' +
      'The rest is not estimated here. A per run number on this page is either read from that run or absent, and a flat per run assumption is not a measurement.';
    node.appendChild(note);
  }
  // Reruns, stated where the counts are. "There is no optional stopping here"
  // is a rule about one run: its size and its extension budget are fixed before
  // the first call. Nothing in the harness limits how often a server is driven
  // again, so the honest defence is that every attempt stays published with its
  // own identity and none of them is selected over another.
  const reruns = rerunSummary(runs);
  if (reruns.servers > 0) {
    const note = el('p', 'stat-strip-note');
    note.textContent =
      `${reruns.servers} of ${reruns.totalServers} ${reruns.servers === 1 ? 'server has' : 'servers have'} more than one published run here, ${reruns.rows} rows in total. ` +
      'A rerun is a separate attempt against a newly generated task suite, under its own suite hash, and it is published beside the earlier run rather than replacing it. ' +
      'Every row carries its suite hash and start time so two attempts can be told apart. Nothing on this page keeps the better of two runs: the registered size and the extension budget are fixed inside a run, and across runs the defence is that no attempt is hidden.';
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
  // One pass over every published run, so a row knows about its server's other
  // runs even when they sit in another band. Nothing is dropped here.
  const cohorts = serverCohorts(usable);
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
      for (const node of runRow(row.run, row, index++, cohortPlaceOf(cohorts, row.run))) tbody.appendChild(node);
    }
  }

  const unranked = usable.filter((run) => !isRankable(run));
  if (unranked.length > 0) {
    // Refusals are not ranked, but they are still read against each other, and
    // a v1 admission rate next to a v2 admission rate is two different
    // measurements printed as one column. So the refused rows are grouped by
    // generator too, with recorded generators first and records that predate the
    // field last, and each group says what the grouping means.
    const generators = [];
    for (const run of unranked) {
      const version = generatorVersionOf(run);
      if (!generators.includes(version)) generators.push(version);
    }
    generators.sort((a, b) => {
      const aKnown = a !== 'unrecorded generator';
      const bKnown = b !== 'unrecorded generator';
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.localeCompare(b);
    });
    const split = generators.length > 1;
    for (const version of generators) {
      // Grouped by server, and within a server oldest run first, so two runs of
      // one server are read next to each other instead of as unrelated rows.
      const group = unranked
        .filter((run) => generatorVersionOf(run) === version)
        .sort((a, b) => {
          const byServer = slugOf(a).localeCompare(slugOf(b));
          if (byServer !== 0) return byServer;
          const at = runIdentityOf(a).startedAt;
          const bt = runIdentityOf(b).startedAt;
          if (at !== null && bt !== null && at !== bt) return at < bt ? -1 : 1;
          return 0;
        });
      const known = version !== 'unrecorded generator';
      tbody.appendChild(
        bandRow(
          split
            ? `Refused, task generator ${known ? version : 'not recorded'}`
            : 'Refused, and published as such',
          split
            ? `A gate stopped these runs before a score existed. ${
                known
                  ? 'Their admission, drop and screen counts come from this generator and are not comparable with counts from another one.'
                  : 'These records predate the generator version field, so their counts are not comparable with a recorded generator.'
              } The gate, its counts and its reason stand in place of the number.`
            : 'A gate stopped these runs before a score existed, or the record carries no usable interval. The gate, its counts and its reason stand in place of the number.',
          'band-refused'
        )
      );
      for (const run of group) {
        for (const node of runRow(run, null, index++, cohortPlaceOf(cohorts, run))) tbody.appendChild(node);
      }
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
